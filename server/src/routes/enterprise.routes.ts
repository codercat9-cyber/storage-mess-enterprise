// =============================================================================
// Корпоративный контур — /api/enterprise/*
//
//   GET  /info     (без входа) — включён ли контур и как входить
//   GET  /ca       (без входа) — открытый ключ корпоративного УЦ
//   GET  /crl      (без входа) — подписанный список отзыва ключей устройств
//   POST /devices  (вошедший)  — подписать ключ своего устройства
//   GET  /status   (админ)     — состояние синхронизации с каталогом
//   POST /sync     (админ)     — синхронизировать сейчас
//   GET  /users    (админ)     — сотрудники из каталога
//   GET  /events   (админ)     — журнал событий контура
//
// Ни один ответ не содержит паролей и секретов: ни служебной учётки, ни
// RADIUS. Адрес каталога показывается без вписанных в URL данных входа.
// =============================================================================

import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { adminMiddleware, adminOnly, audit } from '../middleware/admin.js';
import { dbUtils } from '../database/index.js';
import { logger } from '../utils/logger.js';
import { entConfig, loginHint, publicDirectoryUrl } from '../enterprise/config.js';
import { getState, listEvents } from '../enterprise/store.js';
import { runSync, getNextSyncAt } from '../enterprise/sync.js';
import { caPublicHex, issueDeviceCert, signedCrl, activeDeviceCounts } from '../enterprise/ca.js';

const router = Router();

function disabled(res: Response): void {
  res.status(404).json({ error: 'Корпоративный контур выключен' });
}

// Состояние контура и УЦ не кэшируем нигде по пути: CRL обязан быть свежим
router.use((_req: Request, res: Response, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// ─────────────────────────────────────────────────────────────────────
// Открытые
// ─────────────────────────────────────────────────────────────────────

router.get('/info', (_req: Request, res: Response) => {
  if (!entConfig.enabled) {
    res.json({ enabled: false, auth: null, domain: null, login_hint: null });
    return;
  }
  res.json({
    enabled: true,
    auth: entConfig.auth,
    domain: entConfig.domain || null,
    login_hint: loginHint(),
  });
});

router.get('/ca', (_req: Request, res: Response) => {
  if (!entConfig.enabled) { disabled(res); return; }
  try {
    res.json({ alg: 'Ed25519', ca_pub: caPublicHex() });
  } catch (e) {
    logger.error('enterprise/ca:', e);
    res.status(500).json({ error: 'УЦ недоступен' });
  }
});

router.get('/crl', (_req: Request, res: Response) => {
  if (!entConfig.enabled) { disabled(res); return; }
  try {
    res.json(signedCrl());
  } catch (e) {
    logger.error('enterprise/crl:', e);
    res.status(500).json({ error: 'Список отзыва недоступен' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// Вошедший пользователь: сертификат ключа устройства
// ─────────────────────────────────────────────────────────────────────

router.post('/devices', authMiddleware, (req: Request, res: Response) => {
  if (!entConfig.enabled) { disabled(res); return; }
  const userId = req.user!.userId;
  const user = dbUtils.get<{ id: string; username: string; blocked_at: string | null }>(
    'SELECT id, username, blocked_at FROM users WHERE id = ?', [userId]
  );
  if (!user) { res.status(401).json({ error: 'User not found' }); return; }
  if (user.blocked_at) { res.status(403).json({ error: 'Аккаунт заблокирован' }); return; }
  try {
    const r = issueDeviceCert(user, req.body?.ed_pub, req.body?.label);
    if (!r.ok) { res.status(r.status).json({ error: r.error }); return; }
    res.json({ cert: r.cert, sig: r.sig, ca_pub: r.ca_pub });
  } catch (e) {
    logger.error('enterprise/devices:', e);
    res.status(500).json({ error: 'Не удалось выдать сертификат' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// Администратор
// ─────────────────────────────────────────────────────────────────────

const admin = [authMiddleware, adminMiddleware, adminOnly];

router.get('/status', ...admin, (_req: Request, res: Response) => {
  const lastOk = getState('last_sync_ok');
  const counts = dbUtils.get<{ total: number; blocked: number }>(
    `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN blocked_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS blocked
       FROM users WHERE auth_source = 'directory'`
  ) || { total: 0, blocked: 0 };
  res.json({
    enabled: entConfig.enabled,
    auth: entConfig.enabled ? entConfig.auth : null,
    directory: entConfig.enabled
      ? { url: publicDirectoryUrl(), base_dn: entConfig.ldap.baseDn, group_dn: entConfig.ldap.groupDn }
      : null,
    last_sync_at: getState('last_sync_at'),
    last_sync_ok: lastOk === null ? null : lastOk === '1',
    last_error: getState('last_error'),
    next_sync_at: entConfig.enabled ? getNextSyncAt() : null,
    interval_s: entConfig.syncIntervalS,
    counts: { total: counts.total, active: counts.total - counts.blocked, blocked: counts.blocked },
  });
});

router.post('/sync', ...admin, async (req: Request, res: Response) => {
  if (!entConfig.enabled) { disabled(res); return; }
  const force = req.body?.force === true;
  audit(req, 'enterprise.sync', {}, force ? { force } : undefined);
  const r = await runSync({ manual: true, force });
  const body = {
    created: r.created, updated: r.updated, blocked: r.blocked,
    unblocked: r.unblocked, unchanged: r.unchanged, took_ms: r.took_ms,
  };
  if (!r.ok) {
    res.status(502).json({ ...body, error: r.error });
    return;
  }
  res.json(body);
});

router.get('/users', ...admin, (_req: Request, res: Response) => {
  const devices = activeDeviceCounts();
  const rows = dbUtils.all<{
    id: string; username: string; display_name: string | null; email: string | null;
    department: string | null; title: string | null; directory_state: string | null;
    blocked_at: string | null; blocked_reason: string | null; directory_synced_at: string | null;
  }>(
    `SELECT id, username, display_name, email, department, title, directory_state,
            blocked_at, blocked_reason, directory_synced_at
       FROM users WHERE auth_source = 'directory'
      ORDER BY display_name COLLATE NOCASE, username`
  );
  res.json(rows.map(r => ({
    id: r.id,
    username: r.username,
    display_name: r.display_name,
    email: r.email,
    department: r.department,
    title: r.title,
    directory_state: r.directory_state,
    blocked_at: r.blocked_at,
    blocked_reason: r.blocked_reason,
    directory_synced_at: r.directory_synced_at,
    devices: devices.get(r.id) || 0,
  })));
});

router.get('/events', ...admin, (req: Request, res: Response) => {
  const limit = parseInt(String(req.query.limit ?? '100'), 10);
  res.json(listEvents(Number.isFinite(limit) ? limit : 100));
});

export default router;
