import { Router, Request, Response } from 'express';
import { userService } from '../services/user.service.js';
import { setMuted, listMuted } from '../services/mute.service.js';
import { authMiddleware } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';
import { dbUtils } from '../database/index.js';
import { v4 as uuidv4 } from 'uuid';
import { Contact } from '../types/index.js';
import { getIo, emitToUser } from '../socket/index.js';
import { chatService } from '../services/chat.service.js';

const router = Router();

// Все роуты требуют аутентификации
router.use(authMiddleware);

// Поиск пользователей
router.get('/search', (req: Request, res: Response) => {
  try {
    const { q, limit } = req.query;

    if (!q || typeof q !== 'string') {
      res.status(400).json({ error: 'Search query is required' });
      return;
    }

    const users = userService.searchUsers(q, limit ? parseInt(limit as string, 10) : 20);
    res.json({ users });
  } catch (error) {
    logger.error('Search users error:', error);
    res.status(500).json({ error: 'Failed to search users' });
  }
});

// Обновление Push-токена устройства (FCM)
router.post('/push-token', (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { token } = req.body;
    
    if (!token || typeof token !== 'string') {
      res.status(400).json({ error: 'Token is required' });
      return;
    }

    // Регистрируем токен КАК УСТРОЙСТВО, а не как свойство человека.
    //
    // Было `UPDATE users SET push_token = ?` — вход со второго устройства
    // затирал токен первого, и первое переставало получать уведомления
    // совсем. Теперь у человека может быть сколько угодно устройств.
    //
    // Ключ — сам токен: если то же устройство перерегистрируется, строка
    // обновится. Если тем же токеном пришёл ДРУГОЙ пользователь (телефон
    // передали, вошли под другой учёткой) — токен переезжает к нему, иначе
    // прошлый владелец продолжал бы получать чужие уведомления.
    const platform = String(req.body?.platform || '').slice(0, 32) || null;
    const label = String(req.body?.device_label || '').slice(0, 120) || null;
    dbUtils.run(
      `INSERT INTO push_tokens (token, user_id, platform, device_label, last_seen_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(token) DO UPDATE SET
         user_id = excluded.user_id,
         platform = COALESCE(excluded.platform, push_tokens.platform),
         device_label = COALESCE(excluded.device_label, push_tokens.device_label),
         last_seen_at = CURRENT_TIMESTAMP`,
      [token, userId, platform, label]
    );

    // Старую колонку продолжаем заполнять: на неё смотрит диагностика в
    // админ-панели и старые сборки сервера при откате.
    dbUtils.run('UPDATE users SET push_token = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [token, userId]);

    const n = dbUtils.get<{ n: number }>(
      'SELECT COUNT(*) n FROM push_tokens WHERE user_id = ?', [userId])?.n ?? 1;
    res.json({ success: true, devices: n });
  } catch (error) {
    logger.error('Update push token error:', error);
    res.status(500).json({ error: 'Failed to update push token' });
  }
});

// Свой профиль.
//
// Объявлен ДО '/:userId' намеренно: иначе Express примет «me» за
// идентификатор, уйдёт искать пользователя с таким id и ответит 404.
// Раньше этого маршрута не было совсем — клиент умел его звать, но в
// ответ получал «пользователь не найден», поэтому профиль после входа
// никогда не обновлялся. Из-за этого назначенный модератор не видел
// свою панель: роль приезжает вместе с профилем, а профиль был из
// прошлого входа.
router.get('/me', (req: Request, res: Response) => {
  try {
    const user = userService.findById(req.user!.userId);
    if (!user) { res.status(404).json({ error: 'Пользователь не найден' }); return; }
    res.json({ user: userService.getPublicProfile(user) });
  } catch (error) {
    logger.error('Get me error:', error);
    res.status(500).json({ error: 'Не удалось получить профиль' });
  }
});

// Получить профиль пользователя по ID
router.get('/:userId', (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const user = userService.findById(userId);

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({ user: userService.getPublicProfile(user) });
  } catch (error) {
    logger.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// Перегенерация ключа восстановления
router.post('/me/regenerate-recovery', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const recoveryKey = await userService.regenerateRecoveryKey(userId);
    if (!recoveryKey) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({ recoveryKey });
  } catch (error) {
    logger.error('Regenerate recovery key error:', error);
    res.status(500).json({ error: 'Failed to regenerate recovery key' });
  }
});

// Обновить свой профиль
router.patch('/me/profile', (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { display_name, avatar_url } = req.body;

    const user = userService.updateProfile(userId, { display_name, avatar_url });
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const publicProfile = userService.getPublicProfile(user);

    // Оповещаем всех участников чатов об изменении профиля, ВКЛЮЧАЯ самого автора на других устройствах
    const ioInstance = getIo();
    if (ioInstance) {
      // Отправляем самому автору (синхронизация PWA/APK)
      emitToUser(ioInstance, userId, 'user:profile_updated', { user: publicProfile });
      
      const chats = chatService.getUserChats(userId);
      const notifiedUsers = new Set<string>();
      for (const chat of chats) {
        const members = chatService.getChatMembers(chat.id);
        for (const member of members) {
          if (member.id !== userId && !notifiedUsers.has(member.id)) {
            notifiedUsers.add(member.id);
            emitToUser(ioInstance, member.id, 'user:profile_updated', { user: publicProfile });
          }
        }
      }
    }

    res.json({ user: publicProfile });
  } catch (error) {
    logger.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Удалить свой аккаунт
router.delete('/me', (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    
    const success = userService.deleteUser(userId);
    if (!success) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({ success: true, message: 'Account deleted' });
  } catch (error) {
    logger.error('Delete account error:', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// Получить настройки пользователя
router.get('/me/settings', (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const settings = userService.getSettings(userId);
    
    if (!settings) {
      res.status(404).json({ error: 'Settings not found' });
      return;
    }

    res.json({ settings });
  } catch (error) {
    logger.error('Get settings error:', error);
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

// Обновить настройки пользователя
router.patch('/me/settings', (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    
    userService.updateSettings(userId, {
      theme: req.body.theme,
      language: req.body.language,
      notifications_enabled: req.body.notifications_enabled,
      sound_enabled: req.body.sound_enabled,
      settings_json: req.body.settings_json
    });

    const settings = userService.getSettings(userId);
    
    // Синхронизируем настройки на все клиенты пользователя (PWA/APK)
    const ioInstance = getIo();
    if (ioInstance && settings) {
      emitToUser(ioInstance, userId, 'user:settings_updated', { settings });
    }

    res.json({ settings });
  } catch (error) {
    logger.error('Update settings error:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// === Контакты ===

// Получить список контактов
router.get('/me/contacts', (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    
    const contacts = dbUtils.all<Contact & { contact_username: string; contact_display_name: string; contact_avatar_url: string; contact_status: string }>(
      `SELECT c.*, u.username as contact_username, u.display_name as contact_display_name, 
              u.avatar_url as contact_avatar_url, u.status as contact_status
       FROM contacts c
       JOIN users u ON c.contact_id = u.id
       WHERE c.user_id = ? AND c.status = 'accepted'`,
      [userId]
    );

    res.json({
      contacts: contacts.map(c => ({
        id: c.id,
        user: {
          id: c.contact_id,
          username: c.contact_username,
          display_name: c.contact_display_name,
          avatar_url: c.contact_avatar_url,
          status: c.contact_status,
        },
        created_at: c.created_at,
      })),
    });
  } catch (error) {
    logger.error('Get contacts error:', error);
    res.status(500).json({ error: 'Failed to get contacts' });
  }
});

// Добавить контакт (отправить запрос)
router.post('/me/contacts', (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { user_id: contactId } = req.body;

    if (!contactId) {
      res.status(400).json({ error: 'user_id is required' });
      return;
    }

    if (userId === contactId) {
      res.status(400).json({ error: 'Cannot add yourself as contact' });
      return;
    }

    // Проверяем существование пользователя
    const contactUser = userService.findById(contactId);
    if (!contactUser) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Проверяем, нет ли уже контакта
    const existing = dbUtils.get<Contact>(
      'SELECT * FROM contacts WHERE user_id = ? AND contact_id = ?',
      [userId, contactId]
    );

    if (existing) {
      if (existing.status === 'blocked') {
        res.status(400).json({ error: 'User is blocked' });
        return;
      }
      res.status(400).json({ error: 'Contact already exists' });
      return;
    }

    // Проверяем, есть ли входящий запрос от этого пользователя
    const incomingRequest = dbUtils.get<Contact>(
      `SELECT * FROM contacts WHERE user_id = ? AND contact_id = ? AND status = 'pending'`,
      [contactId, userId]
    );

    const now = new Date().toISOString();

    if (incomingRequest) {
      // Автоматически принимаем, если есть входящий запрос
      dbUtils.transaction(() => {
        dbUtils.run(
          'UPDATE contacts SET status = ? WHERE id = ?',
          ['accepted', incomingRequest.id]
        );
        dbUtils.run(
          `INSERT INTO contacts (id, user_id, contact_id, status, created_at) VALUES (?, ?, ?, 'accepted', ?)`,
          [uuidv4(), userId, contactId, now]
        );
      });
      res.status(201).json({ status: 'accepted' });
    } else {
      // Создаём новый запрос
      dbUtils.run(
        `INSERT INTO contacts (id, user_id, contact_id, status, created_at) VALUES (?, ?, ?, 'pending', ?)`,
        [uuidv4(), userId, contactId, now]
      );
      res.status(201).json({ status: 'pending' });
    }
  } catch (error) {
    logger.error('Add contact error:', error);
    res.status(500).json({ error: 'Failed to add contact' });
  }
});

// Получить входящие запросы на добавление
router.get('/me/contacts/requests', (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;

    const requests = dbUtils.all<Contact & { requester_username: string; requester_display_name: string; requester_avatar_url: string }>(
      `SELECT c.*, u.username as requester_username, u.display_name as requester_display_name, 
              u.avatar_url as requester_avatar_url
       FROM contacts c
       JOIN users u ON c.user_id = u.id
       WHERE c.contact_id = ? AND c.status = 'pending'`,
      [userId]
    );

    res.json({
      requests: requests.map(r => ({
        id: r.id,
        user: {
          id: r.user_id,
          username: r.requester_username,
          display_name: r.requester_display_name,
          avatar_url: r.requester_avatar_url,
        },
        created_at: r.created_at,
      })),
    });
  } catch (error) {
    logger.error('Get contact requests error:', error);
    res.status(500).json({ error: 'Failed to get requests' });
  }
});

// Принять/отклонить запрос
router.patch('/me/contacts/requests/:requestId', (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { requestId } = req.params;
    const { action } = req.body; // accept or reject

    if (!['accept', 'reject'].includes(action)) {
      res.status(400).json({ error: 'Invalid action. Use "accept" or "reject"' });
      return;
    }

    const request = dbUtils.get<Contact>(
      'SELECT * FROM contacts WHERE id = ? AND contact_id = ? AND status = ?',
      [requestId, userId, 'pending']
    );

    if (!request) {
      res.status(404).json({ error: 'Request not found' });
      return;
    }

    if (action === 'accept') {
      const now = new Date().toISOString();
      dbUtils.transaction(() => {
        dbUtils.run('UPDATE contacts SET status = ? WHERE id = ?', ['accepted', requestId]);
        // Создаём обратный контакт
        dbUtils.run(
          `INSERT INTO contacts (id, user_id, contact_id, status, created_at) VALUES (?, ?, ?, 'accepted', ?)`,
          [uuidv4(), userId, request.user_id, now]
        );
      });
    } else {
      dbUtils.run('DELETE FROM contacts WHERE id = ?', [requestId]);
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Handle contact request error:', error);
    res.status(500).json({ error: 'Failed to handle request' });
  }
});

// Удалить контакт
router.delete('/me/contacts/:contactId', (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { contactId } = req.params;

    dbUtils.transaction(() => {
      // Удаляем оба направления контакта
      dbUtils.run(
        'DELETE FROM contacts WHERE user_id = ? AND contact_id = ?',
        [userId, contactId]
      );
      dbUtils.run(
        'DELETE FROM contacts WHERE user_id = ? AND contact_id = ?',
        [contactId, userId]
      );
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Delete contact error:', error);
    res.status(500).json({ error: 'Failed to delete contact' });
  }
});

// Заблокировать пользователя
router.post('/me/contacts/:contactId/block', (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { contactId } = req.params;

    const existing = dbUtils.get<Contact>(
      'SELECT * FROM contacts WHERE user_id = ? AND contact_id = ?',
      [userId, contactId]
    );

    if (existing) {
      dbUtils.run('UPDATE contacts SET status = ? WHERE id = ?', ['blocked', existing.id]);
    } else {
      dbUtils.run(
        `INSERT INTO contacts (id, user_id, contact_id, status, created_at) VALUES (?, ?, ?, 'blocked', ?)`,
        [uuidv4(), userId, contactId, new Date().toISOString()]
      );
    }

    // Удаляем обратный контакт
    dbUtils.run(
      'DELETE FROM contacts WHERE user_id = ? AND contact_id = ?',
      [contactId, userId]
    );

    res.json({ success: true });
  } catch (error) {
    logger.error('Block user error:', error);
    res.status(500).json({ error: 'Failed to block user' });
  }
});

// Разблокировать пользователя
router.delete('/me/contacts/:contactId/block', (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { contactId } = req.params;

    dbUtils.run(
      `DELETE FROM contacts WHERE user_id = ? AND contact_id = ? AND status = 'blocked'`,
      [userId, contactId]
    );

    res.json({ success: true });
  } catch (error) {
    logger.error('Unblock user error:', error);
    res.status(500).json({ error: 'Failed to unblock user' });
  }
});

// === Contact Overrides (локальные ники и аватары, синхронизируемые на сервер) ===

// Получить все перезаписи контактов
router.get('/me/contact-overrides', (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const overrides = dbUtils.all<{ contact_id: string; local_nickname: string | null; local_avatar_url: string | null }>(
      'SELECT contact_id, local_nickname, local_avatar_url FROM user_contact_overrides WHERE user_id = ?',
      [userId]
    );
    res.json({ overrides });
  } catch (error) {
    logger.error('Get contact overrides error:', error);
    res.status(500).json({ error: 'Failed to get contact overrides' });
  }
});

// Установить перезапись для конкретного контакта
router.put('/me/contact-overrides/:contactId', (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { contactId } = req.params;
    const { local_nickname, local_avatar_url } = req.body;

    if (userId === contactId) {
      res.status(400).json({ error: 'Cannot override yourself' });
      return;
    }

    // Меняем ТОЛЬКО те поля, которые прислали.
    //
    // Здесь была причина «аватарки послетали». Клиент сохраняет ник и
    // картинку двумя отдельными запросами: {local_nickname} и
    // {local_avatar_url}. А запись обновлялась целиком — недостающее поле
    // приезжало как null и затирало соседнее. То есть переименовал
    // человека в списке — стёр ему аватарку, поставил аватарку — стёр
    // подпись. На своём устройстве этого не видно: там в памяти браузера
    // старое значение ещё лежит. Пропажа вылезает на втором устройстве и
    // после переустановки, когда всё берётся с сервера — и выглядит как
    // «нет синхронизации», хотя синхронизация как раз отработала, только
    // разносила уже пустоту.
    //
    // Явный null в теле запроса по-прежнему стирает поле: так работает
    // «убрать аватарку». Отличаем «прислали null» от «не прислали вовсе».
    const hasNick = Object.prototype.hasOwnProperty.call(req.body || {}, 'local_nickname');
    const hasAvatar = Object.prototype.hasOwnProperty.call(req.body || {}, 'local_avatar_url');

    if (!hasNick && !hasAvatar) {
      res.status(400).json({ error: 'Nothing to update' });
      return;
    }

    // Такого человека может уже не быть. У таблицы внешний ключ на users,
    // и вставка ссылки в пустоту роняла весь запрос с 500 — в журнале
    // сервера «FOREIGN KEY constraint failed» без единого намёка, о ком
    // речь. Приходит это не от злого умысла: устройство доливает на сервер
    // всё, что скопилось у него локально, включая подписи к удалённым
    // учёткам. Отвечаем понятно, чтобы клиент вычистил у себя запись.
    const contactExists = dbUtils.get<{ id: string }>('SELECT id FROM users WHERE id = ?', [contactId]);
    if (!contactExists) {
      res.status(404).json({ error: 'Contact not found', contact_id: contactId });
      return;
    }

    const now = new Date().toISOString();
    dbUtils.run(
      `INSERT INTO user_contact_overrides (user_id, contact_id, local_nickname, local_avatar_url, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, contact_id) DO UPDATE SET
         local_nickname   = CASE WHEN ? THEN excluded.local_nickname   ELSE user_contact_overrides.local_nickname   END,
         local_avatar_url = CASE WHEN ? THEN excluded.local_avatar_url ELSE user_contact_overrides.local_avatar_url END,
         updated_at = excluded.updated_at`,
      [
        userId, contactId,
        hasNick ? (local_nickname || null) : null,
        hasAvatar ? (local_avatar_url || null) : null,
        now,
        hasNick ? 1 : 0,
        hasAvatar ? 1 : 0,
      ]
    );

    // Строка, где не осталось ни ника, ни картинки, — мусор. Убираем,
    // иначе список перезаписей растёт пустыми записями и синхронизация
    // на других устройствах гоняет их впустую.
    dbUtils.run(
      `DELETE FROM user_contact_overrides
        WHERE user_id = ? AND contact_id = ?
          AND COALESCE(local_nickname, '') = '' AND COALESCE(local_avatar_url, '') = ''`,
      [userId, contactId]
    );

    res.json({ success: true });
  } catch (error) {
    logger.error('Set contact override error:', error);
    res.status(500).json({ error: 'Failed to set contact override' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// «Позвать администратора» — обращение от обычного пользователя.
//
// Вторая половина правила владельца. Раньше в системе было только
// «администратор смотрит переписку, когда его позвали», но позвать было
// нечем: жаловались в личку, и формального разрешения не существовало.
// Теперь у обращения есть номер, а главное — человек сам выбирает, что
// разрешает смотреть, и это разрешение хранится рядом с обращением.
// ─────────────────────────────────────────────────────────────────────
router.post('/support-request', (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;

    const subject = String(req.body?.subject || '').trim().slice(0, 200);
    const details = String(req.body?.details || '').trim().slice(0, 4000);
    const chatId = req.body?.chat_id ? String(req.body.chat_id) : null;
    const scope = ['none', 'diagnostics', 'messages'].includes(String(req.body?.consent_scope))
      ? String(req.body.consent_scope) : 'none';

    if (!subject) { res.status(400).json({ error: 'Опишите, что случилось' }); return; }

    // Разрешение смотреть переписку имеет смысл только для конкретного чата.
    if (scope === 'messages' && !chatId) {
      res.status(400).json({ error: 'Для разбора переписки укажите чат' });
      return;
    }
    // И только если человек в этом чате действительно состоит — иначе через
    // обращение можно было бы выписать себе доступ к чужому.
    if (chatId && !chatService.isChatMember(chatId, userId)) {
      res.status(403).json({ error: 'Это не ваш чат' });
      return;
    }

    // Защита от заваливания: не больше пяти открытых обращений на человека.
    const open = dbUtils.get<{ n: number }>(
      "SELECT COUNT(*) n FROM support_requests WHERE user_id = ? AND status = 'open'", [userId])?.n ?? 0;
    if (open >= 5) {
      res.status(429).json({ error: 'У вас уже пять открытых обращений — дождитесь ответа' });
      return;
    }

    const id = uuidv4();
    dbUtils.run(
      `INSERT INTO support_requests
         (id, user_id, subject, details, chat_id, consent_scope, app_version, device_label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, userId, subject, details || null, chatId, scope,
       String(req.body?.app_version || '').slice(0, 32) || null,
       String(req.body?.device_label || '').slice(0, 120) || null]
    );

    logger.info(`🆘 Обращение ${id.slice(0, 8)} от ${userId}: «${subject}» (доступ: ${scope})`);

    // Дёргаем персонал в реальном времени — обращения обычно срочные.
    const io = getIo();
    if (io) {
      const staff = dbUtils.all<{ id: string }>(
        "SELECT id FROM users WHERE role IN ('admin','moderator')");
      for (const s of staff) {
        emitToUser(io, s.id, 'support:new' as any, { id, subject, user_id: userId });
      }
    }

    res.status(201).json({ success: true, id, number: id.slice(0, 8) });
  } catch (error) {
    logger.error('Support request error:', error);
    res.status(500).json({ error: 'Не удалось отправить обращение' });
  }
});

/** Свои обращения — чтобы человек видел, что с ними стало. */
router.get('/support-request/mine', (req: Request, res: Response) => {
  try {
    const rows = dbUtils.all<any>(
      `SELECT id, subject, status, resolution, consent_scope, created_at, closed_at
       FROM support_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`,
      [req.user!.userId]
    );
    res.json({ requests: rows });
  } catch (error) {
    logger.error('Support list error:', error);
    res.status(500).json({ error: 'Не удалось получить обращения' });
  }
});

// ─── Уведомления от конкретного человека ──────────────────────────────
//
// Настройка личная и односторонняя: тихо становится только у того, кто её
// включил. Второй ничего не замечает. Сообщения доходят и ложатся в
// переписку как обычно — молчит только уведомление.

/** Кого я заглушил. */
router.get('/me/muted', (req: Request, res: Response) => {
  try {
    res.json({ muted: listMuted(req.user!.userId) });
  } catch (error) {
    logger.error('Не удалось получить список беззвучных контактов:', error);
    res.status(500).json({ error: 'Не удалось получить список' });
  }
});

/** Включить или выключить уведомления от человека. */
router.put('/me/muted/:contactId', (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { contactId } = req.params;
    if (contactId === userId) {
      res.status(400).json({ error: 'Себя заглушить нельзя' });
      return;
    }
    if (!userService.findById(contactId)) {
      res.status(404).json({ error: 'Пользователь не найден' });
      return;
    }

    const muted = Boolean(req.body?.muted);
    setMuted(userId, contactId, muted);
    res.json({ contactId, muted });
  } catch (error) {
    logger.error('Не удалось изменить беззвучный режим контакта:', error);
    res.status(500).json({ error: 'Не удалось сохранить настройку' });
  }
});

export default router;
