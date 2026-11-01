// =============================================================================
// Админка — /api/admin/*
//
// Правило доступа задано владельцем и вшито сюда: администратор
// управляет людьми и сервером, но НЕ листает чужую переписку. Открыть
// конкретное сообщение можно только по его идентификатору — то есть
// когда на него пожаловались или позвали чинить, — и каждый такой
// просмотр пишется в журнал вместе с именем администратора.
//
// Списка чатов и поиска по чужим сообщениям здесь нет намеренно. Это не
// техническое ограничение (сервер видит текст открытым), а правило,
// и журнал существует ровно для того, чтобы правило было проверяемым.
// =============================================================================

import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { authMiddleware } from '../middleware/auth.js';
import { adminMiddleware, adminOnly, audit, AdminUser } from '../middleware/admin.js';
import { dbUtils } from '../database/index.js';
import { userService } from '../services/user.service.js';
import { chatService } from '../services/chat.service.js';
import { messageService } from '../services/message.service.js';
import { getIo, emitToUser, isUserOnline, getConnectedSessions } from '../socket/index.js';
import { getBannedIPs, unbanIP } from '../index.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { onManualBlock, onManualUnblock } from '../enterprise/accounts.js';
import { revokeUserDevices } from '../enterprise/ca.js';
import { entConfig } from '../enterprise/config.js';

const router = Router();

// Всё под админом. adminMiddleware отвечает 404 посторонним, поэтому
// сам факт существования раздела наружу не виден.
router.use(authMiddleware, adminMiddleware);

const me = (req: Request) => (req as any).admin as AdminUser;

// ─────────────────────────────────────────────────────────────────────
// Сводка
// ─────────────────────────────────────────────────────────────────────
router.get('/stats', (req: Request, res: Response) => {
  try {
    const one = <T>(sql: string, p: unknown[] = []) => dbUtils.get<T>(sql, p);

    const users = one<{ n: number }>('SELECT COUNT(*) n FROM users')?.n ?? 0;
    const blocked = one<{ n: number }>('SELECT COUNT(*) n FROM users WHERE blocked_at IS NOT NULL')?.n ?? 0;
    const admins = one<{ n: number }>("SELECT COUNT(*) n FROM users WHERE role = 'admin'")?.n ?? 0;
    const chats = one<{ n: number }>('SELECT COUNT(*) n FROM chats')?.n ?? 0;
    const messages = one<{ n: number }>('SELECT COUNT(*) n FROM messages WHERE deleted_at IS NULL')?.n ?? 0;
    const files = one<{ n: number; s: number }>('SELECT COUNT(*) n, COALESCE(SUM(size),0) s FROM files');
    const calls = one<{ n: number }>('SELECT COUNT(*) n FROM calls')?.n ?? 0;
    const newToday = one<{ n: number }>(
      "SELECT COUNT(*) n FROM users WHERE created_at >= date('now')")?.n ?? 0;
    const msgToday = one<{ n: number }>(
      "SELECT COUNT(*) n FROM messages WHERE created_at >= date('now')")?.n ?? 0;

    // Онлайн считаем по сокетам, а не по колонке status: она остаётся
    // «online» после обрыва связи и врёт.
    const allIds = dbUtils.all<{ id: string }>('SELECT id FROM users');
    const online = allIds.filter(u => isUserOnline(u.id)).length;

    let disk: Record<string, number> | null = null;
    try {
      const s = fs.statfsSync(config.storage.path);
      disk = {
        total: s.bsize * s.blocks,
        free: s.bsize * s.bavail,
        used: s.bsize * (s.blocks - s.bavail),
      };
    } catch { /* том мог отвалиться — не повод ронять сводку */ }

    res.json({
      users, online, blocked, admins, chats, messages, calls,
      files: files?.n ?? 0, filesSize: files?.s ?? 0,
      newUsersToday: newToday, messagesToday: msgToday,
      disk,
      uptimeSec: Math.round(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    });
  } catch (e) {
    logger.error('admin/stats:', e);
    res.status(500).json({ error: 'Не удалось собрать сводку' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// Люди
// ─────────────────────────────────────────────────────────────────────
router.get('/users', (req: Request, res: Response) => {
  try {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(parseInt(String(req.query.limit || '100'), 10) || 100, 500);
    const offset = Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0);

    // LIKE-шаблон экранируем: «%» в поиске иначе означает «все».
    const esc = (s: string) => s.replace(/[\\%_]/g, c => '\\' + c);
    const conds: string[] = [];
    const params: unknown[] = [];
    if (q) {
      conds.push(`(username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\' OR id = ?)`);
      params.push(`%${esc(q)}%`, `%${esc(q)}%`, q);
    }
    // Фильтры: без них список из полусотни учёток приходилось глазами
    // перебирать, чтобы найти заблокированных или персонал.
    const filter = String(req.query.filter || 'all');
    if (filter === 'blocked') conds.push('blocked_at IS NOT NULL');
    if (filter === 'staff') conds.push(`role IN ('admin','moderator')`);
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    // Сортировка — из белого списка, иначе это дыра для инъекции.
    const sortMap: Record<string, string> = {
      new: 'created_at DESC',
      old: 'created_at ASC',
      seen: 'last_seen DESC',
      name: 'LOWER(COALESCE(display_name, username)) ASC',
    };
    const orderBy = sortMap[String(req.query.sort || 'new')] || sortMap.new;

    const rows = dbUtils.all<any>(
      `SELECT id, username, display_name, avatar_url, status, role, blocked_at, blocked_reason,
              last_seen, created_at
       FROM users ${where}
       ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const total = dbUtils.get<{ n: number }>(
      `SELECT COUNT(*) n FROM users ${where}`, params)?.n ?? 0;

    // «Онлайн» в базе не хранится — считается по живым сокетам, поэтому
    // отфильтровать в SQL нельзя, отсеиваем уже здесь.
    const filtered = filter === 'online' ? rows.filter(u => isUserOnline(u.id)) : rows;

    res.json({
      total,
      offset,
      returned: filtered.length,
      hasMore: offset + rows.length < total,
      users: filtered.map(u => ({
        ...u,
        role: u.role || 'user',
        online: isUserOnline(u.id),
        // Счётчики полезны для «кто спамит» и для чистки мёртвых учёток.
        messages: dbUtils.get<{ n: number }>(
          'SELECT COUNT(*) n FROM messages WHERE sender_id = ?', [u.id])?.n ?? 0,
        chats: dbUtils.get<{ n: number }>(
          'SELECT COUNT(*) n FROM chat_members WHERE user_id = ?', [u.id])?.n ?? 0,
      })),
    });
  } catch (e) {
    logger.error('admin/users:', e);
    res.status(500).json({ error: 'Не удалось получить список' });
  }
});

router.post('/users/:id/block', (req: Request, res: Response) => {
  const { id } = req.params;
  const reason = String(req.body?.reason || '').slice(0, 500);

  const target = userService.findById(id);
  if (!target) { res.status(404).json({ error: 'Пользователь не найден' }); return; }
  if (target.id === me(req).id) {
    res.status(400).json({ error: 'Себя заблокировать нельзя' }); return;
  }
  if ((target as any).role === 'admin') {
    res.status(400).json({ error: 'Нельзя заблокировать администратора — сначала снимите роль' });
    return;
  }

  audit(req, 'user.block', { type: 'user', id }, { username: target.username, reason });
  dbUtils.run('UPDATE users SET blocked_at = ?, blocked_reason = ? WHERE id = ?',
              [new Date().toISOString(), reason || null, id]);
  // Рвём сессии: без этого человек остаётся в системе до протухания токена.
  dbUtils.run('DELETE FROM refresh_tokens WHERE user_id = ?', [id]);
  // Блокировка ручная: каталог (корпоративный контур) её не снимет.
  // В корпоративном режиме заодно отзываются ключи устройств.
  try { onManualBlock(id, reason); } catch (e) { logger.error('Ручная блокировка: корпоративная часть', e); }
  const io = getIo();
  if (io) emitToUser(io, id, 'account:blocked', { reason });

  res.json({ success: true });
});

router.post('/users/:id/unblock', (req: Request, res: Response) => {
  const { id } = req.params;
  const target = userService.findById(id);
  if (!target) { res.status(404).json({ error: 'Пользователь не найден' }); return; }

  audit(req, 'user.unblock', { type: 'user', id }, { username: target.username });
  dbUtils.run('UPDATE users SET blocked_at = NULL, blocked_reason = NULL WHERE id = ?', [id]);
  try { onManualUnblock(id); } catch (e) { logger.error('Разблокировка: корпоративная часть', e); }
  res.json({ success: true });
});

router.post('/users/:id/reset-password', adminOnly, async (req: Request, res: Response) => {
  const { id } = req.params;
  const pwd = String(req.body?.new_password || '');
  if (pwd.length < 8) {
    res.status(400).json({ error: 'Пароль короче 8 символов' }); return;
  }
  const target = userService.findById(id);
  if (!target) { res.status(404).json({ error: 'Пользователь не найден' }); return; }

  // В журнал пишем ФАКТ сброса, но не сам пароль.
  audit(req, 'user.reset_password', { type: 'user', id }, { username: target.username });
  const ok = await userService.adminResetPassword(target.username, pwd);
  if (!ok) { res.status(500).json({ error: 'Не удалось сбросить' }); return; }
  res.json({ success: true });
});

router.post('/users/:id/logout-all', (req: Request, res: Response) => {
  const { id } = req.params;
  const target = userService.findById(id);
  if (!target) { res.status(404).json({ error: 'Пользователь не найден' }); return; }

  audit(req, 'user.logout_all', { type: 'user', id }, { username: target.username });
  dbUtils.run('DELETE FROM refresh_tokens WHERE user_id = ?', [id]);
  // Вместе с сессиями снимаем и регистрации устройств: иначе «выкинуть со
  // всех устройств» оставляло бы их получать уведомления о новых сообщениях.
  dbUtils.run('DELETE FROM push_tokens WHERE user_id = ?', [id]);
  dbUtils.run('UPDATE users SET push_token = NULL WHERE id = ?', [id]);
  const io = getIo();
  if (io) emitToUser(io, id, 'session:revoked', {});
  res.json({ success: true });
});

/**
 * Сменить имя пользователя (@username) и/или отображаемое имя.
 *
 * Нужно для разбора жалоб: человек регистрировался с опечаткой, попросил
 * поправить, или имя откровенно оскорбительное. Раньше это делалось руками
 * прямо в базе — то есть мимо журнала, а значит без следа, кто и когда.
 *
 * @username — это то, по чему человека ищут и упоминают, поэтому меняем
 * осторожно: проверяем занятость, длину и набор символов, и обязательно
 * записываем в журнал старое значение — иначе откатить будет нечем.
 */
router.post('/users/:id/username', adminOnly, (req: Request, res: Response) => {
  const { id } = req.params;
  const target = userService.findById(id);
  if (!target) { res.status(404).json({ error: 'Пользователь не найден' }); return; }

  const raw = req.body?.username;
  const newDisplay = req.body?.display_name;

  // Разрешаем менять что-то одно: пришло только отображаемое имя — @ не трогаем.
  let username: string | null = null;
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    username = String(raw).trim().toLowerCase();
    if (username.length < 3 || username.length > 32) {
      res.status(400).json({ error: 'Имя пользователя: от 3 до 32 символов' });
      return;
    }
    // Пробелы и служебные символы ломают упоминания через @ и поиск.
    if (!/^[a-zа-яё0-9_.-]+$/i.test(username)) {
      res.status(400).json({ error: 'Допустимы буквы, цифры, точка, дефис и подчёркивание' });
      return;
    }
    if (username !== target.username) {
      const busy = userService.findByUsername(username);
      if (busy) { res.status(409).json({ error: `Имя @${username} уже занято` }); return; }
    }
  }

  let display: string | null = null;
  if (newDisplay !== undefined && newDisplay !== null) {
    display = String(newDisplay).trim().slice(0, 64);
  }

  if (username === null && display === null) {
    res.status(400).json({ error: 'Нечего менять' });
    return;
  }

  audit(req, 'user.rename', { type: 'user', id }, {
    было_username: target.username,
    стало_username: username ?? target.username,
    было_display: (target as any).display_name || null,
    стало_display: display ?? ((target as any).display_name || null),
  });

  try {
    if (username !== null && display !== null) {
      dbUtils.run('UPDATE users SET username = ?, display_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                  [username, display, id]);
    } else if (username !== null) {
      dbUtils.run('UPDATE users SET username = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [username, id]);
    } else {
      dbUtils.run('UPDATE users SET display_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [display, id]);
    }
  } catch (e: any) {
    // Гонка: имя заняли между проверкой и записью.
    if (String(e?.message || '').includes('UNIQUE')) {
      res.status(409).json({ error: 'Имя уже занято' });
      return;
    }
    throw e;
  }

  res.json({ success: true, username: username ?? target.username, display_name: display ?? (target as any).display_name });
});

router.post('/users/:id/role', adminOnly, (req: Request, res: Response) => {
  const { id } = req.params;
  const role = String(req.body?.role || '');
  if (role !== 'admin' && role !== 'moderator' && role !== 'user') {
    res.status(400).json({ error: "role должен быть 'admin', 'moderator' или 'user'" }); return;
  }
  const target = userService.findById(id);
  if (!target) { res.status(404).json({ error: 'Пользователь не найден' }); return; }

  // Последнего администратора разжаловать нельзя — иначе в админку не
  // войдёт уже никто, и чинить придётся руками в базе.
  if (role !== 'admin') {
    const admins = dbUtils.get<{ n: number }>(
      "SELECT COUNT(*) n FROM users WHERE role = 'admin'")?.n ?? 0;
    if (admins <= 1 && (target as any).role === 'admin') {
      res.status(400).json({ error: 'Это последний администратор — роль снять нельзя' });
      return;
    }
  }

  audit(req, 'user.role', { type: 'user', id }, { username: target.username, role });
  dbUtils.run('UPDATE users SET role = ? WHERE id = ?', [role, id]);

  // Говорим человеку о новой роли сразу.
  //
  // Роль приезжает в приложение только вместе с профилем при входе, а
  // профиль клиент потом не перезапрашивал. Поэтому назначенный модератор
  // не видел свою панель до тех пор, пока не выйдет и не войдёт заново —
  // и выглядело это как «кнопки просто нет».
  const io = getIo();
  if (io) emitToUser(io, id, 'user:role' as any, { role });

  res.json({ success: true, role });
});

router.delete('/users/:id', adminOnly, (req: Request, res: Response) => {
  const { id } = req.params;
  const target = userService.findById(id);
  if (!target) { res.status(404).json({ error: 'Пользователь не найден' }); return; }
  if (target.id === me(req).id) {
    res.status(400).json({ error: 'Себя удалить нельзя' }); return;
  }

  audit(req, 'user.delete', { type: 'user', id },
        { username: target.username, display_name: target.display_name });
  // Ключи удалённого остаются в списке отзыва — иначе его устройства
  // продолжали бы предъявлять действующие сертификаты в радиосети.
  if (entConfig.enabled) {
    try { revokeUserDevices(id, 'учётка удалена администратором'); } catch (e) { logger.error('Удаление: отзыв ключей', e); }
  }
  const ok = userService.deleteUser(id);
  res.json({ success: ok });
});

// ─────────────────────────────────────────────────────────────────────
// Модерация — только по идентификатору, каждый шаг в журнал
// ─────────────────────────────────────────────────────────────────────
// Переписка закрыта для модератора — только администратор.
//
// Правило владельца: «смотрю только когда позвали». Модератору для его
// работы (жалобы, блокировки, состояние сервера) содержимое сообщений не
// нужно, а раз не нужно — доступа быть не должно. Меньше людей с доступом
// к переписке, меньше поводов для беспокойства у остальных пятидесяти.
router.get('/messages/:id', adminOnly, (req: Request, res: Response) => {
  const { id } = req.params;
  const m = dbUtils.get<any>(
    `SELECT m.id, m.chat_id, m.sender_id, m.content, m.type, m.created_at, m.deleted_at,
            u.username AS sender_username, c.type AS chat_type, c.name AS chat_name
     FROM messages m
     LEFT JOIN users u ON u.id = m.sender_id
     LEFT JOIN chats c ON c.id = m.chat_id
     WHERE m.id = ?`, [id]);
  if (!m) { res.status(404).json({ error: 'Сообщение не найдено' }); return; }

  // Просмотр чужого сообщения — тоже действие, и оно в журнале.
  //
  // Дополнительно отмечаем, есть ли на этот чат живое разрешение от самого
  // человека. Правило владельца — «смотрю, только когда позвали»; раньше
  // проверить это было нечем, теперь у обращения есть номер и область
  // доступа. Просмотр без обращения не запрещаем (бывает срочное), но он
  // помечается в журнале отдельно — чтобы было видно.
  const consent = dbUtils.get<{ id: string }>(
    `SELECT id FROM support_requests
     WHERE chat_id = ? AND status = 'open' AND consent_scope = 'messages'
     ORDER BY created_at DESC LIMIT 1`, [m.chat_id]);

  audit(req, 'message.view', { type: 'message', id },
        {
          chat_id: m.chat_id,
          sender: m.sender_username,
          по_обращению: consent ? consent.id.slice(0, 8) : 'НЕТ — просмотр без обращения',
        });
  res.json({ message: m, consentRequestId: consent?.id || null });
});

router.delete('/messages/:id', adminOnly, (req: Request, res: Response) => {
  const { id } = req.params;
  const m = dbUtils.get<any>('SELECT id, chat_id, sender_id FROM messages WHERE id = ?', [id]);
  if (!m) { res.status(404).json({ error: 'Сообщение не найдено' }); return; }

  audit(req, 'message.delete', { type: 'message', id },
        { chat_id: m.chat_id, sender_id: m.sender_id });
  dbUtils.run("UPDATE messages SET deleted_at = ?, content = NULL WHERE id = ?",
              [new Date().toISOString(), id]);
  const io = getIo();
  if (io) io.to(`chat:${m.chat_id}`).emit('message:deleted' as any,
                                          { message_id: id, chat_id: m.chat_id });
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────
// Объявление всем
// ─────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────
// Чаты, группы и каналы: карточка и снос.
//
// Право только у главного администратора (adminOnly) — модератор сюда не
// проходит. Удаление чата необратимо и задевает сразу всех участников,
// так что это не та кнопка, которую раздают вместе с блокировкой.
//
// Правило владельца соблюдается и здесь: **списка чатов нет**. Открыть
// можно только конкретный чат по идентификатору из жалобы, и в карточке
// нет ни одного сообщения — только тип, название, счётчики и участники.
// Чтобы решить «сносить или нет», содержимое читать не требуется; а если
// требуется, для этого есть отдельный просмотр сообщения по номеру, и он
// пишется в журнал как просмотр.
// ─────────────────────────────────────────────────────────────────────

router.get('/chats/:id', adminOnly, (req: Request, res: Response) => {
  const { id } = req.params;
  const chat = dbUtils.get<any>(
    `SELECT c.id, c.type, c.name, c.created_by, c.created_at,
            u.username AS creator_username
       FROM chats c
       LEFT JOIN users u ON u.id = c.created_by
      WHERE c.id = ?`, [id]);
  if (!chat) { res.status(404).json({ error: 'Чат не найден' }); return; }

  const stats = dbUtils.get<any>(
    `SELECT (SELECT COUNT(*) FROM messages     WHERE chat_id = ?) AS messages,
            (SELECT COUNT(*) FROM chat_members WHERE chat_id = ?) AS members,
            (SELECT MAX(created_at) FROM messages WHERE chat_id = ?) AS last_message_at`,
    [id, id, id]);

  const members = dbUtils.all<any>(
    `SELECT u.id, u.username, u.display_name
       FROM chat_members m JOIN users u ON u.id = m.user_id
      WHERE m.chat_id = ? LIMIT 200`, [id]);

  audit(req, 'chat.view', { type: 'chat', id },
        { тип: chat.type, название: chat.name, участников: stats?.members });
  res.json({ chat: { ...chat, ...stats }, members });
});

router.delete('/chats/:id', adminOnly, (req: Request, res: Response) => {
  const { id } = req.params;
  const chat = dbUtils.get<any>('SELECT id, type, name, created_by FROM chats WHERE id = ?', [id]);
  if (!chat) { res.status(404).json({ error: 'Чат не найден' }); return; }

  // «Избранное» — личные заметки человека, их видит только он сам. Пожаловаться
  // на них нельзя, значит и повода сносить по жалобе не бывает, а вот снести по
  // ошибке (перепутав идентификатор) — уничтожить чужое насовсем. Если человека
  // убирают целиком, для этого есть удаление учётки, и оно заберёт их каскадом.
  if (chat.type === 'favorites') {
    res.status(400).json({
      error: 'Это «Избранное» — личные заметки владельца, а не переписка. ' +
             'Снести их можно только вместе с учёткой.',
    });
    return;
  }

  const memberIds = chatService.getMemberIds(id);

  // Пишем в журнал ДО удаления: после него не останется ни названия, ни
  // числа участников, а в записи должно быть видно, что именно снесли.
  audit(req, 'chat.delete', { type: 'chat', id },
        { тип: chat.type, название: chat.name, создатель: chat.created_by, участников: memberIds.length });

  const result = chatService.deleteChatAsAdmin(id);
  if (!result.deleted) { res.status(500).json({ error: 'Не удалось удалить чат' }); return; }

  // Рассылаем ПО ЛЮДЯМ, а не в комнату чата: в комнате сидят только те, у
  // кого он сейчас открыт, а убрать его из списка нужно у всех. Комнаты
  // `user:<id>` в проекте нет — адресная отправка идёт через emitToUser,
  // который знает все сокеты человека (у него их несколько, по устройствам).
  const io = getIo();
  if (io) {
    for (const userId of memberIds) {
      emitToUser(io, userId, 'chat:deleted', { chat_id: id });
    }
  }

  res.json({ success: true, ...result });
});

router.post('/broadcast', adminOnly, (req: Request, res: Response) => {
  const text = String(req.body?.text || '').trim();
  if (!text) { res.status(400).json({ error: 'Пустое объявление' }); return; }
  if (text.length > 4000) { res.status(400).json({ error: 'Слишком длинно' }); return; }

  try {
    const admin = me(req);
    audit(req, 'broadcast', {}, { length: text.length });

    // Отдельный канал вместо рассылки в личные чаты: так объявление
    // доходит и до тех, кто сейчас офлайн (обычная история чата), и не
    // засоряет переписку. Канал заводится один раз.
    let chat = dbUtils.get<any>(
      "SELECT * FROM chats WHERE type = 'channel' AND name = '📢 Объявления' LIMIT 1");

    const everyone = dbUtils.all<{ id: string }>('SELECT id FROM users').map(u => u.id);

    if (!chat) {
      chat = chatService.createChannel(admin.id, '📢 Объявления',
                                       everyone.filter(id => id !== admin.id));
    } else {
      // Добить тех, кто зарегистрировался после создания канала.
      for (const uid of everyone) {
        const inChat = dbUtils.get('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?',
                                   [chat.id, uid]);
        if (!inChat) {
          dbUtils.run(
            `INSERT INTO chat_members (id, chat_id, user_id, role, joined_at)
             VALUES (?, ?, ?, 'member', ?)`,
            [randomUUID(), chat.id, uid, new Date().toISOString()]);
        }
      }
    }

    const message = messageService.sendMessage(chat.id, admin.id, { content: text, type: 'text' });
    const io = getIo();
    if (io && message) io.to(`chat:${chat.id}`).emit('message:new', message);

    res.json({ success: true, chat_id: chat.id, recipients: everyone.length });
  } catch (e) {
    logger.error('admin/broadcast:', e);
    res.status(500).json({ error: 'Не удалось разослать' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// Журнал действий
// ─────────────────────────────────────────────────────────────────────
router.get('/audit', (req: Request, res: Response) => {
  const limit = Math.min(parseInt(String(req.query.limit || '200'), 10) || 200, 1000);
  const rows = dbUtils.all<any>(
    `SELECT id, admin_id, admin_name, action, target_type, target_id, details, ip, created_at
     FROM admin_audit ORDER BY created_at DESC LIMIT ?`, [limit]);
  res.json({
    entries: rows.map(r => ({ ...r, details: r.details ? JSON.parse(r.details) : null })),
  });
});


// ─────────────────────────────────────────────────────────────────────
// Отладка сервера. Ради этого блока админка и нужна оператору: без него
// любая жалоба «у меня не работает» превращается в поход по ssh.
// Содержимого переписки здесь нет нигде.
// ─────────────────────────────────────────────────────────────────────

/** Хвост журнала сервера. Уровень: all | error | warn. */
router.get('/logs', (req: Request, res: Response) => {
  try {
    const lines = Math.min(parseInt(String(req.query.lines || '200'), 10) || 200, 2000);
    const level = String(req.query.level || 'all');
    const file = level === 'error'
      ? path.join(path.dirname(config.logging.file), 'error.log')
      : config.logging.file;

    if (!fs.existsSync(file)) { res.json({ file, lines: [] }); return; }

    // Читаем только хвост: журнал бывает в сотни мегабайт, целиком его
    // тянуть в память ради двухсот строк незачем.
    const size = fs.statSync(file).size;
    const want = Math.min(size, 512 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(want);
    fs.readSync(fd, buf, 0, want, size - want);
    fs.closeSync(fd);

    let out = buf.toString('utf8').split('\n').filter(Boolean);
    if (level === 'warn') out = out.filter(l => /WARN|ERROR/i.test(l));
    res.json({ file, lines: out.slice(-lines) });
  } catch (e) {
    logger.error('admin/logs:', e);
    res.status(500).json({ error: 'Не удалось прочитать журнал' });
  }
});

/** Здоровье: целостность базы, тома, срок сертификата. */
router.get('/health-full', (req: Request, res: Response) => {
  const out: any = {};
  try {
    out.db = {
      // Колонка называется integrity_check, а читали её как `v` — из-за
      // этого в панели всегда горело красное «целостность: unknown», хотя
      // база была в порядке. Проверять базу и не уметь прочитать ответ —
      // хуже, чем не проверять: пугает на ровном месте.
      integrity: dbUtils.get<{ integrity_check: string }>('PRAGMA integrity_check')?.integrity_check ?? 'unknown',
      sizeBytes: (() => { try { return fs.statSync(config.database.url).size; } catch { return null; } })(),
      walBytes: (() => { try { return fs.statSync(config.database.url + '-wal').size; } catch { return null; } })(),
    };
  } catch (e: any) { out.db = { error: String(e?.message || e) }; }

  try {
    const certPath = path.join(process.cwd(), 'certs', 'fullchain.pem');
    if (fs.existsSync(certPath)) {
      const raw = fs.readFileSync(certPath, 'utf8');
      const cert = new (require('crypto').X509Certificate)(raw);
      const days = Math.round((new Date(cert.validTo).getTime() - Date.now()) / 86400000);
      out.tls = { subject: cert.subject, validTo: cert.validTo, daysLeft: days };
    }
  } catch (e: any) { out.tls = { error: String(e?.message || e) }; }

  out.storage = { path: config.storage.path };
  try {
    const st = fs.statfsSync(config.storage.path);
    out.storage.freeBytes = st.bsize * st.bavail;
    out.storage.totalBytes = st.bsize * st.blocks;
  } catch (e: any) { out.storage.error = String(e?.message || e); }

  out.process = {
    uptimeSec: Math.round(process.uptime()),
    rssMb: Math.round(process.memoryUsage().rss / 1048576),
    node: process.version,
    pid: process.pid,
  };
  res.json(out);
});

// ─────────────────────────────────────────────────────────────────────
// Обращения «позвать админа»
// ─────────────────────────────────────────────────────────────────────

/** Список обращений. По умолчанию — только открытые. */
router.get('/support', (req: Request, res: Response) => {
  const status = String(req.query.status || 'open');
  const where = status === 'all' ? '' : 'WHERE s.status = ?';
  const params = status === 'all' ? [] : [status];
  const rows = dbUtils.all<any>(
    `SELECT s.*, u.username, u.display_name
     FROM support_requests s
     LEFT JOIN users u ON u.id = s.user_id
     ${where}
     ORDER BY s.created_at DESC LIMIT 200`, params);
  const open = dbUtils.get<{ n: number }>(
    "SELECT COUNT(*) n FROM support_requests WHERE status = 'open'")?.n ?? 0;
  res.json({ open, requests: rows });
});

/** Закрыть обращение с пометкой, что сделали. */
router.post('/support/:id/close', (req: Request, res: Response) => {
  const { id } = req.params;
  const row = dbUtils.get<any>('SELECT id, user_id, subject FROM support_requests WHERE id = ?', [id]);
  if (!row) { res.status(404).json({ error: 'Обращение не найдено' }); return; }

  const resolution = String(req.body?.resolution || '').trim().slice(0, 2000);
  audit(req, 'support.close', { type: 'support', id }, { subject: row.subject });
  dbUtils.run(
    `UPDATE support_requests SET status = 'closed', handled_by = ?, resolution = ?,
            closed_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [me(req)?.id || null, resolution || null, id]);

  // Человек должен узнать, чем кончилось.
  const io = getIo();
  if (io) emitToUser(io, row.user_id, 'support:closed' as any, { id, resolution });

  res.json({ success: true });
});

/** Кто сейчас подключён и с какого адреса. */
router.get('/sessions', (req: Request, res: Response) => {
  const sessions = getConnectedSessions().map(s => {
    const u = dbUtils.get<{ username: string; display_name: string | null }>(
      'SELECT username, display_name FROM users WHERE id = ?', [s.userId]);
    // Сокет без учётки в базе — это не «—», а сигнал: висит соединение
    // удалённого пользователя. Говорим прямо, а не рисуем прочерк.
    return {
      ...s,
      username: u?.username || null,
      display_name: u?.display_name || null,
      orphan: !u,
    };
  });
  res.json({ total: sessions.length, sessions });
});

/** Кого забанил автобан и разбан вручную. */
router.get('/banned', (req: Request, res: Response) => {
  res.json({ ips: getBannedIPs() });
});

router.post('/banned/unban', adminOnly, (req: Request, res: Response) => {
  const ip = String(req.body?.ip || '');
  if (!ip) { res.status(400).json({ error: 'Нужен ip' }); return; }
  audit(req, 'waf.unban', { type: 'ip', id: ip });
  res.json({ success: unbanIP(ip) });
});

/**
 * Диагностика по человеку — для случая «позвали чинить».
 * Содержимого сообщений тут нет: только счётчики и состояние.
 */
router.get('/users/:id/diagnostics', (req: Request, res: Response) => {
  const { id } = req.params;
  const u = dbUtils.get<any>(
    `SELECT id, username, display_name, status, role, blocked_at, blocked_reason,
            last_seen, created_at, push_token IS NOT NULL AS has_push
     FROM users WHERE id = ?`, [id]);
  if (!u) { res.status(404).json({ error: 'Пользователь не найден' }); return; }

  audit(req, 'user.diagnostics', { type: 'user', id }, { username: u.username });

  const n = (sql: string) => dbUtils.get<{ n: number }>(sql, [id])?.n ?? 0;
  res.json({
    user: u,
    online: isUserOnline(id),
    sockets: getConnectedSessions().find(s => s.userId === id)?.sockets ?? 0,
    chats: n('SELECT COUNT(*) n FROM chat_members WHERE user_id = ?'),
    messages: n('SELECT COUNT(*) n FROM messages WHERE sender_id = ?'),
    files: n('SELECT COUNT(*) n FROM files WHERE uploader_id = ?'),
    filesBytes: dbUtils.get<{ s: number }>(
      'SELECT COALESCE(SUM(size),0) s FROM files WHERE uploader_id = ?', [id])?.s ?? 0,
    refreshSessions: n('SELECT COUNT(*) n FROM refresh_tokens WHERE user_id = ?'),
    hasE2eeKeys: !!dbUtils.get('SELECT 1 FROM user_public_keys WHERE user_id = ?', [id]),
    lastMessageAt: dbUtils.get<{ t: string }>(
      'SELECT MAX(created_at) t FROM messages WHERE sender_id = ?', [id])?.t ?? null,
  });
});

/** Сброс WAL в основной файл — безопасная гигиена на живой базе. */
router.post('/maintenance/checkpoint', adminOnly, (req: Request, res: Response) => {
  try {
    audit(req, 'maintenance.checkpoint');
    dbUtils.run('PRAGMA wal_checkpoint(TRUNCATE)');
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

export default router;
