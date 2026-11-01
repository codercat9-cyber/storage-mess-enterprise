// ─────────────────────────────────────────────────────────────────────
// Модерация: жалобы на содержимое, чистка, хранилище, правила.
//
// Правило владельца: администрация не листает чужую переписку. Жалоба
// открывает ровно одно сообщение — то, на которое пожаловались, — и его
// файлы. Каждый просмотр, скачивание и удаление пишется в admin_audit.
//
// Права:
//   модератор — разбирает жалобы: удаляет пожалованное сообщение и его
//               файлы, блокирует автора. Вне жалоб файлов не касается.
//   админ     — то же, плюс хранилище целиком: карта занятого места,
//               список файлов (вес, тип, владелец, дата), скачать, удалить.
// ─────────────────────────────────────────────────────────────────────
import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import fs from 'fs';
import { authMiddleware } from '../middleware/auth.js';
import { adminMiddleware, adminOnly, audit, AdminUser } from '../middleware/admin.js';
import { dbUtils } from '../database/index.js';
import { chatService } from '../services/chat.service.js';
import { storageService } from '../services/storage.service.js';
import { getIo, emitToUser } from '../socket/index.js';
import { logger } from '../utils/logger.js';

export const REPORT_REASONS = ['illegal', 'violence', 'extremism', 'drugs', 'csam', 'porn', 'fraud', 'spam', 'other'] as const;
const REPORTS_PER_DAY = 30;

const adminOf = (req: Request) => (req as any).admin as AdminUser;

/** Файлы, прикреплённые к сообщению (metadata.file_id). */
function messageFileIds(messageId: string): string[] {
  const row = dbUtils.get<{ metadata: string | null }>('SELECT metadata FROM messages WHERE id = ?', [messageId]);
  if (!row?.metadata) return [];
  try {
    const m = JSON.parse(row.metadata);
    return [m?.file_id, m?.thumbnail_file_id].filter((x): x is string => typeof x === 'string' && x.length > 0);
  } catch {
    return [];
  }
}

/** Файл приложен к сообщению, на которое есть жалоба — модератору можно. */
function fileUnderReport(fileId: string): boolean {
  return !!dbUtils.get(
    `SELECT 1 AS x FROM content_reports r JOIN messages m ON m.id = r.message_id
      WHERE json_extract(m.metadata, '$.file_id') = ? LIMIT 1`,
    [fileId]
  );
}

function deleteMessage(messageId: string): { chat_id: string } | null {
  const m = dbUtils.get<{ id: string; chat_id: string }>('SELECT id, chat_id FROM messages WHERE id = ?', [messageId]);
  if (!m) return null;
  dbUtils.run('UPDATE messages SET deleted_at = ?, content = NULL, encrypted_content = NULL WHERE id = ?',
              [new Date().toISOString(), messageId]);
  const io = getIo();
  if (io) io.to(`chat:${m.chat_id}`).emit('message:deleted' as any, { message_id: messageId, chat_id: m.chat_id });
  return { chat_id: m.chat_id };
}

/** Удаляет файл с дисков и из базы, а сообщения с ним — из чатов. */
async function purgeFile(fileId: string): Promise<boolean> {
  const msgs = dbUtils.all<{ id: string }>(
    `SELECT id FROM messages WHERE deleted_at IS NULL AND json_extract(metadata, '$.file_id') = ?`, [fileId]);
  for (const m of msgs) deleteMessage(m.id);
  return storageService.deleteFile(fileId, '', true);
}

function blockUser(req: Request, userId: string, reason: string) {
  audit(req, 'user.block', { type: 'user', id: userId }, { reason });
  dbUtils.run('UPDATE users SET blocked_at = ?, blocked_reason = ? WHERE id = ?', [new Date().toISOString(), reason, userId]);
  dbUtils.run('DELETE FROM refresh_tokens WHERE user_id = ?', [userId]);
  const io = getIo();
  if (io) emitToUser(io, userId, 'account:blocked', { reason });
}

const mimeGroup = (mime: string | null) => {
  const m = (mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (/pdf|msword|officedocument|text\/|rtf|opendocument/.test(m)) return 'document';
  if (/zip|rar|7z|tar|gzip|x-bzip/.test(m)) return 'archive';
  if (/android\.package|x-msdownload|x-executable|appimage/.test(m)) return 'app';
  return 'other';
};

// ── Для всех: жалоба и правила ───────────────────────────────────────
export const reportRouter = Router();
reportRouter.use(authMiddleware);

reportRouter.post('/', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { message_id, reason, comment } = req.body || {};
  if (typeof message_id !== 'string' || !REPORT_REASONS.includes(reason)) {
    res.status(400).json({ error: 'Укажите сообщение и причину' });
    return;
  }
  const m = dbUtils.get<{ id: string; chat_id: string; sender_id: string }>(
    'SELECT id, chat_id, sender_id FROM messages WHERE id = ? AND deleted_at IS NULL', [message_id]);
  // Пожаловаться можно только на то, что видишь сам
  if (!m || !chatService.isChatMember(m.chat_id, userId)) {
    res.status(404).json({ error: 'Сообщение не найдено' });
    return;
  }
  if (m.sender_id === userId) {
    res.status(400).json({ error: 'Это ваше сообщение — его можно просто удалить' });
    return;
  }
  const dup = dbUtils.get('SELECT 1 AS x FROM content_reports WHERE reporter_id = ? AND message_id = ? AND status = ?',
                          [userId, message_id, 'open']);
  if (dup) { res.json({ success: true, duplicate: true }); return; }
  const today = dbUtils.get<{ n: number }>(
    `SELECT count(*) AS n FROM content_reports WHERE reporter_id = ? AND julianday(created_at) > julianday('now', '-1 day')`,
    [userId]);
  if ((today?.n || 0) >= REPORTS_PER_DAY) {
    res.status(429).json({ error: 'Слишком много жалоб за сутки' });
    return;
  }

  const id = randomUUID();
  dbUtils.run(
    `INSERT INTO content_reports (id, reporter_id, message_id, chat_id, reported_user_id, reason, comment, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    [id, userId, m.id, m.chat_id, m.sender_id, reason,
     typeof comment === 'string' ? comment.slice(0, 1000) : null, new Date().toISOString()]);
  logger.info(`Жалоба ${id}: причина ${reason}`);

  // Сразу видна всем, кто разбирает
  const io = getIo();
  if (io) {
    const staff = dbUtils.all<{ id: string }>("SELECT id FROM users WHERE role IN ('admin', 'moderator') AND blocked_at IS NULL");
    for (const s of staff) emitToUser(io, s.id, 'admin:report', { id, reason });
  }
  res.status(201).json({ success: true, id });
});

export const legalRouter = Router();
legalRouter.use(authMiddleware);

legalRouter.get('/status', (req: Request, res: Response) => {
  const row = dbUtils.get<{ terms_version: string | null; terms_accepted_at: string | null }>(
    'SELECT terms_version, terms_accepted_at FROM users WHERE id = ?', [req.user!.userId]);
  res.json({ version: row?.terms_version || null, accepted_at: row?.terms_accepted_at || null });
});

legalRouter.post('/accept', (req: Request, res: Response) => {
  const { version } = req.body || {};
  if (typeof version !== 'string' || !version || version.length > 32) {
    res.status(400).json({ error: 'Нет редакции правил' });
    return;
  }
  dbUtils.run('UPDATE users SET terms_version = ?, terms_accepted_at = ? WHERE id = ?',
              [version, new Date().toISOString(), req.user!.userId]);
  res.json({ success: true });
});

// ── Администрация ────────────────────────────────────────────────────
export const moderationRouter = Router();
moderationRouter.use(authMiddleware, adminMiddleware);

moderationRouter.get('/reports', (req: Request, res: Response) => {
  const status = req.query.status === 'closed' ? 'closed' : 'open';
  const rows = dbUtils.all<any>(
    `SELECT r.id, r.message_id, r.chat_id, r.reason, r.comment, r.status, r.resolution, r.created_at, r.closed_at,
            r.reported_user_id, ru.username AS reported_username, ru.blocked_at AS reported_blocked_at,
            rp.username AS reporter_username, h.username AS handled_by_name,
            (SELECT count(*) FROM content_reports x WHERE x.message_id = r.message_id) AS reports_on_message
       FROM content_reports r
       LEFT JOIN users ru ON ru.id = r.reported_user_id
       LEFT JOIN users rp ON rp.id = r.reporter_id
       LEFT JOIN users h ON h.id = r.handled_by
      WHERE ${status === 'open' ? "r.status = 'open'" : "r.status <> 'open'"}
      ORDER BY r.created_at DESC LIMIT 200`);
  res.json({ reports: rows });
});

// Открыть жалобу = посмотреть ровно одно сообщение. Пишется в журнал.
moderationRouter.get('/reports/:id', (req: Request, res: Response) => {
  const r = dbUtils.get<any>('SELECT * FROM content_reports WHERE id = ?', [req.params.id]);
  if (!r) { res.status(404).json({ error: 'Жалоба не найдена' }); return; }
  audit(req, 'report.view', { type: 'message', id: r.message_id }, { report_id: r.id });
  const m = dbUtils.get<any>(
    `SELECT m.id, m.type, m.content, m.metadata, m.created_at, m.deleted_at, u.username AS sender_username
       FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.id = ?`, [r.message_id]);
  let metadata: any = null;
  try { metadata = m?.metadata ? JSON.parse(m.metadata) : null; } catch { /* битые метаданные */ }
  const files = messageFileIds(r.message_id).map(fid => {
    const f = storageService.findById(fid);
    return f ? { id: f.id, name: f.original_name, mime: f.mime_type, size: f.size } : { id: fid, missing: true };
  });
  res.json({
    report: r,
    message: m ? { ...m, metadata, encrypted: !!metadata?.e2ee } : null,
    files,
  });
});

/**
 * Решение по жалобе. action:
 *   dismiss       — нарушения нет
 *   delete        — удалить сообщение и его файлы (чистка)
 *   block         — заблокировать автора
 *   delete_block  — и то, и другое
 */
moderationRouter.post('/reports/:id/resolve', async (req: Request, res: Response) => {
  const { action, note } = req.body || {};
  if (!['dismiss', 'delete', 'block', 'delete_block'].includes(action)) {
    res.status(400).json({ error: 'Неизвестное действие' });
    return;
  }
  const r = dbUtils.get<any>('SELECT * FROM content_reports WHERE id = ?', [req.params.id]);
  if (!r) { res.status(404).json({ error: 'Жалоба не найдена' }); return; }
  const admin = adminOf(req);
  const reason = typeof note === 'string' && note.trim() ? note.trim().slice(0, 300) : `жалоба: ${r.reason}`;

  // Себя и админа модератор не блокирует
  if (action === 'block' || action === 'delete_block') {
    const target = dbUtils.get<{ role: string | null }>('SELECT role FROM users WHERE id = ?', [r.reported_user_id]);
    if (target?.role === 'admin' || (target?.role === 'moderator' && admin.role !== 'admin') || r.reported_user_id === admin.id) {
      res.status(403).json({ error: 'Этого пользователя заблокировать нельзя' });
      return;
    }
  }

  audit(req, `report.${action}`, { type: 'message', id: r.message_id }, { report_id: r.id, reason: r.reason, note: reason });
  let filesRemoved = 0;
  if (action === 'delete' || action === 'delete_block') {
    for (const fid of messageFileIds(r.message_id)) {
      audit(req, 'file.delete', { type: 'file', id: fid }, { report_id: r.id });
      if (await purgeFile(fid)) filesRemoved++;
    }
    deleteMessage(r.message_id);
  }
  if ((action === 'block' || action === 'delete_block') && r.reported_user_id) {
    blockUser(req, r.reported_user_id, reason);
  }

  // Закрываются все открытые жалобы на это сообщение — решение одно
  dbUtils.run(
    `UPDATE content_reports SET status = ?, handled_by = ?, resolution = ?, closed_at = ? WHERE message_id = ? AND status = 'open'`,
    [action === 'dismiss' ? 'dismissed' : 'actioned', admin.id, `${action}: ${reason}`, new Date().toISOString(), r.message_id]);
  res.json({ success: true, files_removed: filesRemoved });
});

// ── Хранилище (только админ) ─────────────────────────────────────────
moderationRouter.get('/storage/summary', adminOnly, (_req: Request, res: Response) => {
  const files = dbUtils.all<{ mime_type: string | null; size: number }>('SELECT mime_type, size FROM files');
  const byType: Record<string, { count: number; bytes: number }> = {};
  let total = 0;
  for (const f of files) {
    const g = mimeGroup(f.mime_type);
    byType[g] = byType[g] || { count: 0, bytes: 0 };
    byType[g].count++;
    byType[g].bytes += f.size || 0;
    total += f.size || 0;
  }
  const byUser = dbUtils.all<any>(
    `SELECT f.uploader_id AS user_id, u.username, count(*) AS count, sum(f.size) AS bytes
       FROM files f LEFT JOIN users u ON u.id = f.uploader_id
      GROUP BY f.uploader_id ORDER BY bytes DESC LIMIT 25`);
  let disk: { total: number; free: number } | null = null;
  try {
    const st = (fs as any).statfsSync(storageService.getStoragePath());
    disk = { total: st.blocks * st.bsize, free: st.bavail * st.bsize };
  } catch { /* старый node или нет пути */ }
  res.json({ files: files.length, bytes: total, by_type: byType, by_user: byUser, disk,
             on_fallback: storageService.isOnFallback() });
});

moderationRouter.get('/storage/files', adminOnly, (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const sort = req.query.sort === 'date' ? 'f.created_at DESC' : 'f.size DESC';
  const where: string[] = [];
  const params: unknown[] = [];
  if (typeof req.query.user === 'string' && req.query.user) { where.push('f.uploader_id = ?'); params.push(req.query.user); }
  if (typeof req.query.q === 'string' && req.query.q.trim()) { where.push('f.original_name LIKE ?'); params.push(`%${req.query.q.trim()}%`); }
  const rows = dbUtils.all<any>(
    `SELECT f.id, f.original_name AS name, f.mime_type AS mime, f.size, f.created_at, f.download_count,
            f.uploader_id, u.username AS uploader, f.source
       FROM files f LEFT JOIN users u ON u.id = f.uploader_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${sort} LIMIT ? OFFSET ?`,
    [...params, limit, offset]);
  const type = typeof req.query.type === 'string' ? req.query.type : '';
  const list = rows.map(r => ({ ...r, group: mimeGroup(r.mime) })).filter(r => !type || r.group === type);
  res.json({ files: list, limit, offset });
});

// Скачать: админ — любой файл, модератор — только из жалобы. В журнал.
moderationRouter.post('/storage/files/:id/download', (req: Request, res: Response) => {
  const admin = adminOf(req);
  const f = storageService.findById(req.params.id);
  if (!f) { res.status(404).json({ error: 'Файл не найден' }); return; }
  if (admin.role !== 'admin' && !fileUnderReport(f.id)) {
    res.status(403).json({ error: 'Модератор скачивает только файлы из жалоб' });
    return;
  }
  audit(req, 'file.download', { type: 'file', id: f.id }, { name: f.original_name, size: f.size });
  res.json({ url: `/api/files/download/${f.id}`, name: f.original_name });
});

// Удалить: админ — любой файл, модератор — только из жалобы. В журнал.
moderationRouter.delete('/storage/files/:id', async (req: Request, res: Response) => {
  const admin = adminOf(req);
  const f = storageService.findById(req.params.id);
  if (!f) { res.status(404).json({ error: 'Файл не найден' }); return; }
  if (admin.role !== 'admin' && !fileUnderReport(f.id)) {
    res.status(403).json({ error: 'Модератор удаляет только файлы из жалоб' });
    return;
  }
  audit(req, 'file.delete', { type: 'file', id: f.id }, { name: f.original_name, size: f.size, uploader: f.uploader_id });
  const ok = await purgeFile(f.id);
  res.json({ success: ok });
});
