// =============================================================================
// Корпоративный УЦ: Ed25519-ключ сервера подписывает ключи устройств и
// список отзыва (CRL).
//
// Подпись — над UTF-8 строкой JSON.stringify(объекта) с ключами ровно в том
// порядке, что в договоре; клиент проверяет её так же, без канонизации.
// Поэтому объекты здесь собираются литералами в фиксированном порядке и
// никогда не «дополняются» потом.
//
// Ключ: server/data/enterprise-ca.key (PKCS#8 PEM, права 600), создаётся
// при первом запуске. Потеря ключа = все выданные сертификаты устройств
// перестают проверяться; его нужно бэкапить вместе с базой.
// =============================================================================

import fs from 'fs';
import path from 'path';
import crypto, { KeyObject } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { ed25519 } from '@noble/curves/ed25519';
import { dbUtils } from '../database/index.js';
import { logger } from '../utils/logger.js';
import { entConfig } from './config.js';
import { addEvent, getState, setState } from './store.js';

let privateKey: KeyObject | null = null;
let publicHex = '';

export function initCa(): void {
  if (privateKey) return;
  const file = path.resolve(entConfig.caKeyFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  if (!fs.existsSync(file)) {
    const { privateKey: k } = crypto.generateKeyPairSync('ed25519');
    const pem = k.export({ type: 'pkcs8', format: 'pem' }) as string;
    try {
      // wx — не затираем ключ, если его успел создать соседний процесс
      fs.writeFileSync(file, pem, { mode: 0o600, flag: 'wx' });
      logger.info(`🔐 Корпоративный УЦ: создан новый ключ ${file}`);
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
    }
  }

  try {
    const st = fs.statSync(file);
    if ((st.mode & 0o077) !== 0) {
      fs.chmodSync(file, 0o600);
      logger.warn(`⚠ Корпоративный УЦ: права на ${file} были шире 600 — исправлено`);
    }
  } catch { /* chmod не везде возможен; ключ всё равно читаем */ }

  privateKey = crypto.createPrivateKey(fs.readFileSync(file));
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    privateKey = null;
    throw new Error(`${file}: это не ключ Ed25519`);
  }
  const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' }) as { x?: string };
  publicHex = Buffer.from(jwk.x || '', 'base64url').toString('hex');
  if (publicHex.length !== 64) throw new Error('Корпоративный УЦ: не удалось получить открытый ключ');
  logger.info(`🔐 Корпоративный УЦ: Ed25519, открытый ключ ${publicHex.slice(0, 16)}…`);
}

export function caPublicHex(): string {
  initCa();
  return publicHex;
}

function signObject(obj: unknown): string {
  initCa();
  return crypto.sign(null, Buffer.from(JSON.stringify(obj), 'utf8'), privateKey!).toString('hex');
}

/**
 * Корректная ли это точка Ed25519, а не просто 64 hex-символа. node:crypto
 * такой проверки не делает — принимает любые 32 байта. Точки малого порядка
 * (в т. ч. «единицу») тоже отвергаем: под ними «верна» чужая подпись.
 */
function isValidEdPub(hex: string): boolean {
  try {
    return !ed25519.ExtendedPoint.fromHex(hex).isSmallOrder();
  } catch {
    return false;
  }
}

export interface DeviceCert {
  v: 1;
  user_id: string;
  username: string;
  ed_pub: string;
  issued_at: string;
  expires_at: string;
}

export type IssueResult =
  | { ok: true; cert: DeviceCert; sig: string; ca_pub: string }
  | { ok: false; status: number; error: string };

export function issueDeviceCert(user: { id: string; username: string }, edPubRaw: unknown, labelRaw: unknown): IssueResult {
  const edPub = typeof edPubRaw === 'string' ? edPubRaw.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(edPub)) {
    return { ok: false, status: 400, error: 'ed_pub: нужен открытый ключ Ed25519 — 64 шестнадцатеричных символа' };
  }
  if (!isValidEdPub(edPub)) {
    return { ok: false, status: 400, error: 'ed_pub: это не открытый ключ Ed25519' };
  }
  const label = (typeof labelRaw === 'string' ? labelRaw : '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 64);

  const existing = dbUtils.get<{ id: string; user_id: string; revoked_at: string | null }>(
    'SELECT id, user_id, revoked_at FROM device_certs WHERE ed_pub = ?', [edPub]
  );
  if (existing && existing.user_id !== user.id) {
    return { ok: false, status: 409, error: 'Этот ключ уже закреплён за другим сотрудником' };
  }
  if (existing?.revoked_at) {
    return { ok: false, status: 403, error: 'Этот ключ отозван. Создайте на устройстве новый ключ' };
  }
  if (!existing) {
    const active = dbUtils.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM device_certs WHERE user_id = ? AND revoked_at IS NULL', [user.id]
    )?.n ?? 0;
    if (active >= entConfig.maxDevicesPerUser) {
      return { ok: false, status: 409, error: `Слишком много устройств (${active}). Отзовите старые` };
    }
  }

  const now = new Date();
  const cert: DeviceCert = {
    v: 1,
    user_id: user.id,
    username: user.username,
    ed_pub: edPub,
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + entConfig.certTtlDays * 86400_000).toISOString(),
  };
  const sig = signObject(cert);

  if (existing) {
    // Повторная выдача тому же устройству — продлеваем срок
    dbUtils.run(
      'UPDATE device_certs SET label = ?, issued_at = ?, expires_at = ?, username = ? WHERE id = ?',
      [label || null, cert.issued_at, cert.expires_at, user.username, existing.id]
    );
  } else {
    dbUtils.run(
      `INSERT INTO device_certs (id, user_id, username, ed_pub, label, issued_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), user.id, user.username, edPub, label || null, cert.issued_at, cert.expires_at]
    );
  }
  addEvent('device_issued', user.username, `${label || 'устройство'} · ключ ${edPub.slice(0, 16)}…`, user.id);
  return { ok: true, cert, sig, ca_pub: caPublicHex() };
}

// ─────────────────────────────────────────────────────────────────────
// Список отзыва. seq растёт при каждом изменении; подписанный список
// кэшируется до следующего изменения, issued_at — время этого изменения.
// ─────────────────────────────────────────────────────────────────────

function crlSeq(): { seq: number; issuedAt: string } {
  let seq = parseInt(getState('crl_seq') || '0', 10) || 0;
  let issuedAt = getState('crl_issued_at') || '';
  if (seq < 1 || !issuedAt) {
    seq = Math.max(1, seq);
    issuedAt = new Date().toISOString();
    setState('crl_seq', seq);
    setState('crl_issued_at', issuedAt);
  }
  return { seq, issuedAt };
}

function bumpCrl(): void {
  const { seq } = crlSeq();
  setState('crl_seq', seq + 1);
  setState('crl_issued_at', new Date().toISOString());
}

/** Отозвать все действующие ключи сотрудника. Возвращает, сколько отозвано. */
export function revokeUserDevices(userId: string, reason: string): number {
  const rows = dbUtils.all<{ id: string; username: string; ed_pub: string; label: string | null }>(
    'SELECT id, username, ed_pub, label FROM device_certs WHERE user_id = ? AND revoked_at IS NULL', [userId]
  );
  if (rows.length === 0) return 0;
  const at = new Date().toISOString();
  dbUtils.transaction(() => {
    for (const r of rows) {
      dbUtils.run('UPDATE device_certs SET revoked_at = ?, revoke_reason = ? WHERE id = ?', [at, reason.slice(0, 200), r.id]);
    }
    bumpCrl();
  });
  for (const r of rows) {
    addEvent('device_revoked', r.username, `${r.label || 'устройство'} · ключ ${r.ed_pub.slice(0, 16)}… · ${reason}`, userId);
  }
  return rows.length;
}

export interface Crl {
  v: 1;
  seq: number;
  issued_at: string;
  revoked: Array<{ ed_pub: string; at: string; reason: string }>;
}

let crlCache: { seq: number; body: { crl: Crl; sig: string } } | null = null;

export function signedCrl(): { crl: Crl; sig: string } {
  const { seq, issuedAt } = crlSeq();
  if (crlCache && crlCache.seq === seq) return crlCache.body;
  const rows = dbUtils.all<{ ed_pub: string; revoked_at: string; revoke_reason: string | null }>(
    'SELECT ed_pub, revoked_at, revoke_reason FROM device_certs WHERE revoked_at IS NOT NULL ORDER BY revoked_at, ed_pub'
  );
  const crl: Crl = {
    v: 1,
    seq,
    issued_at: issuedAt,
    revoked: rows.map(r => ({ ed_pub: r.ed_pub, at: r.revoked_at, reason: r.revoke_reason || '' })),
  };
  const body = { crl, sig: signObject(crl) };
  crlCache = { seq, body };
  return body;
}

export function activeDeviceCounts(): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of dbUtils.all<{ user_id: string; n: number }>(
    `SELECT user_id, COUNT(*) AS n FROM device_certs
      WHERE revoked_at IS NULL AND expires_at > ? GROUP BY user_id`, [new Date().toISOString()]
  )) m.set(r.user_id, r.n);
  return m;
}
