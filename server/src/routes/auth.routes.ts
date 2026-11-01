import { Router, Request, Response } from 'express';
import { userService } from '../services/user.service.js';
import { emailService } from '../services/email.service.js';
import { generateAccessToken, generateRefreshToken, verifyRefreshToken, authMiddleware } from '../middleware/auth.js';
import { JWTPayload } from '../types/index.js';
import { RegisterRequest, LoginRequest } from '../types/index.js';
import { randomBytes, createCipheriv, createDecipheriv, pbkdf2Sync, timingSafeEqual } from 'crypto';
import nodemailer from 'nodemailer';
import { logger } from '../utils/logger.js';
import { getClientIp } from '../utils/client-ip.js';
import { dbUtils } from '../database/index.js';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config/index.js';
import { entConfig } from '../enterprise/config.js';
import { enterpriseLogin, noteEmptyPassword } from '../enterprise/login.js';
import fs from 'fs';
import path from 'path';

const router = Router();

// Хранилище сессий для входа по QR коду
const qrSessions = new Map<string, { status: 'pending' | 'approved', userId?: string, accessToken?: string, refreshToken?: string, expiresAt: number }>();

// Вошёл — и не выкидывает никогда (правило владельца, 31.10.2026). Раньше
// срок был жёсткий — 30 дней с ввода пароля, — и ровно через месяц человека
// выкидывало, сколько бы он ни пользовался; пароль многие не помнят.
// Сессия кончается только по воле человека или администрации: выход, смена
// пароля, блокировка, «выкинуть со всех устройств», удаление учётки.
// Срок в базе формальный, на сто лет, и продлевается при каждом обновлении.
const REFRESH_TTL_DAYS = 36500;

function refreshExpiry(): string {
  return new Date(Date.now() + REFRESH_TTL_DAYS * 86400_000).toISOString();
}

// Разовая амнистия токенов, выданных до этой выкладки. Из-за жёсткого срока
// записи о них из базы уже вычищены (на 51 человека в базе было 20 живых),
// а вход по QR не записывал токен вовсе. Их всех выкинуло бы при ближайшем
// истечении токена доступа. Подлинность доказывает подпись; принимаем, только
// если после выдачи сессии никто не отзывал: не менялся пароль, нет
// блокировки, сброса и «выкинуть со всех устройств». Журнал сервера со
// всеми сменами пароля непрерывен с 19.08.2026; более ранние токены тоже
// принимаем — «не выкидывать никогда» важнее, а отзывы через админку
// (сброс, блокировка, выкинуть всех) проверяются по журналу за всё время.
// Новые токены живут строго по базе.
const AMNESTY_FROM = 0;
const AMNESTY_UNTIL = Date.parse('2026-11-01T00:00:00Z');

function amnestyAllowed(p: JWTPayload): boolean {
  const issued = (p.iat ?? 0) * 1000;
  if (!issued || issued < AMNESTY_FROM || issued >= AMNESTY_UNTIL) return false;
  const iso = new Date(issued).toISOString();
  const alive = dbUtils.get<{ ok: number }>(
    `SELECT 1 AS ok FROM users WHERE id = ? AND blocked_at IS NULL
       AND (password_changed_at IS NULL OR julianday(password_changed_at) <= julianday(?))`,
    [p.userId, iso]
  );
  if (!alive) return false;
  const revoked = dbUtils.get<{ x: number }>(
    `SELECT 1 AS x FROM admin_audit WHERE target_id = ?
       AND action IN ('user.logout_all', 'user.block', 'user.reset_password', 'user.delete')
       AND julianday(created_at) > julianday(?)`,
    [p.userId, iso]
  );
  return !revoked;
}

// Очистка просроченных QR токенов (раз в минуту)
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of qrSessions.entries()) {
    if (now > session.expiresAt) {
      qrSessions.delete(token);
    }
  }
}, 60000);

// --- QR Авторизация ---

// 1. Web: Инициализация сессии
router.post('/qr/init', (req: Request, res: Response) => {
  const token = uuidv4();
  qrSessions.set(token, {
    status: 'pending',
    expiresAt: Date.now() + 5 * 60000 // 5 минут
  });
  res.json({ token, expiresAt: Date.now() + 5 * 60000 });
});

// 2. Web: Опрос статуса
router.get('/qr/status', (req: Request, res: Response) => {
  const { token } = req.query;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'Token is required' });
  }
  const session = qrSessions.get(token);
  if (!session) {
    return res.status(404).json({ error: 'Token expired or not found' });
  }
  if (session.status === 'approved') {
    const data = {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      userId: session.userId
    };
    qrSessions.delete(token);
    return res.json({ status: 'approved', data });
  }
  res.json({ status: 'pending' });
});

// 3. Mobile: Подтверждение (сканирование)
router.post('/qr/confirm', authMiddleware, (req: Request, res: Response) => {
  const { token } = req.body;
  // @ts-ignore - userId set by authMiddleware
  const userId = req.user?.userId;
  
  if (!token || !userId) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  
  const session = qrSessions.get(token);
  if (!session) {
    return res.status(404).json({ error: 'Token expired or invalid' });
  }
  if (session.status !== 'pending') {
    return res.status(400).json({ error: 'Session already processed' });
  }
  
  const user = userService.findById(userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  const accessToken = generateAccessToken({ userId: user.id, username: user.username });
  const refreshToken = generateRefreshToken({ userId: user.id, username: user.username });
  // Без записи в базе вошедший по QR вылетал при первом же обновлении
  // токена доступа — через 7 дней.
  dbUtils.run(
    `INSERT INTO refresh_tokens (id, user_id, token, ip_address, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [uuidv4(), user.id, refreshToken, getClientIp(req), refreshExpiry(), new Date().toISOString()]
  );
  
  qrSessions.set(token, {
    ...session,
    status: 'approved',
    userId,
    accessToken,
    refreshToken
  });
  
  res.json({ success: true });
});

// Регистрация
router.post('/register', async (req: Request, res: Response) => {
  // В корпоративном контуре учётки создаёт каталог. Открытая регистрация
  // была бы обходом: «ivanov» мог бы занять кто угодно до синхронизации.
  if (entConfig.enabled && !entConfig.allowRegistration) {
    res.status(403).json({ error: 'Регистрация закрыта: учётные записи сотрудников создаются из каталога организации' });
    return;
  }
  try {
    const rawData: RegisterRequest = req.body;
    const data: RegisterRequest = {
      ...rawData,
      username: (rawData.username || '').trim(),
      email: rawData.email?.trim(),
      display_name: rawData.display_name?.trim(),
    };

    // Валидация
    if (!data.username || !data.password) {
      res.status(400).json({ error: 'Username and password are required' });
      return;
    }

    if (data.username.length < 3 || data.username.length > 30) {
      res.status(400).json({ error: 'Username must be between 3 and 30 characters' });
      return;
    }

    if (data.password.length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters' });
      return;
    }

    // Проверяем уникальность
    if (userService.findByUsername(data.username)) {
      res.status(409).json({ error: 'Username already exists' });
      return;
    }

    if (data.email && userService.findByEmail(data.email)) {
      res.status(409).json({ error: 'Email already exists' });
      return;
    }

    // Создаём пользователя
    const { user, recoveryKey } = await userService.createUser(data);
    const publicProfile = userService.getPublicProfile(user);

    // Генерируем токены
    const accessToken = generateAccessToken({ userId: user.id, username: user.username });
    const refreshToken = generateRefreshToken({ userId: user.id, username: user.username });

    // Сохраняем refresh token
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + REFRESH_TTL_DAYS);
    
    dbUtils.run(
      `INSERT INTO refresh_tokens (id, user_id, token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`,
      [uuidv4(), user.id, refreshToken, expiresAt.toISOString(), new Date().toISOString()]
    );

    // Галочки правил на экране регистрации: какую редакцию принял и когда
    if (typeof (req.body as any)?.terms_version === 'string' && (req.body as any).terms_version.length <= 32) {
      dbUtils.run('UPDATE users SET terms_version = ?, terms_accepted_at = ? WHERE id = ?',
                  [(req.body as any).terms_version, new Date().toISOString(), user.id]);
    }

    logger.info(`User registered: ${user.username}`);
    
    res.status(201).json({
      user: publicProfile,
      accessToken,
      refreshToken,
      recoveryKey,
    });
  } catch (error) {
    logger.error('Registration error:', error);
    const err = error as { code?: string; message?: string };
    if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE' || err?.code === 'SQLITE_CONSTRAINT') {
      const msg = (err.message || '').toLowerCase();
      if (msg.includes('users.username')) {
        res.status(409).json({ error: 'Username already exists' });
        return;
      }
      if (msg.includes('users.email')) {
        res.status(409).json({ error: 'Email already exists' });
        return;
      }
      res.status(409).json({ error: 'User data conflict' });
      return;
    }
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Вход
// Перебор паролей. Минимальный пароль — 6 символов, и без ограничения его
// подбирали бы со скоростью сервера. Окно 15 минут: на имя — 10 неудач, с
// адреса — 30 (за одним адресом бывает целый оператор связи).
const LOGIN_WINDOW_MS = 15 * 60_000;
const loginFails = new Map<string, { n: number; since: number }>();
function loginBlocked(key: string, limit: number): boolean {
  const r = loginFails.get(key);
  return !!r && r.n >= limit && Date.now() - r.since < LOGIN_WINDOW_MS;
}
function loginFailed(...keys: string[]) {
  const now = Date.now();
  for (const k of keys) {
    const r = loginFails.get(k);
    if (!r || now - r.since > LOGIN_WINDOW_MS) loginFails.set(k, { n: 1, since: now });
    else r.n++;
  }
  if (loginFails.size > 20000) loginFails.clear();
}

router.post('/login', async (req: Request, res: Response) => {
  try {
    const data: LoginRequest = req.body;
    const ipKey = 'ip:' + (getClientIp(req) || '');
    const userKey = 'u:' + String(data?.username || '').trim().toLowerCase();
    // У сотрудников каталога неверные пароли считает и домен: после его
    // порога (обычно 5–10) учётка блокируется уже во всей компании. Наш
    // порог ниже, чтобы перебором через мессенджер нельзя было запереть
    // человеку доменную учётку.
    if (loginBlocked(ipKey, 30) || loginBlocked(userKey, entConfig.enabled ? 5 : 10)) {
      res.status(429).json({ error: 'Слишком много неудачных попыток. Подождите 15 минут.' });
      return;
    }

    if (!data.username || !data.password) {
      // Пустой пароль не уходит в каталог: bind с пустым паролем AD считает успешным
      noteEmptyPassword(String(data?.username || ''));
      res.status(400).json({ error: 'Username and password are required' });
      return;
    }
    if (typeof data.username !== 'string' || typeof data.password !== 'string') {
      res.status(400).json({ error: 'Username and password are required' });
      return;
    }

    // Корпоративный контур: сотрудник каталога — пароль проверяет домен
    // и/или RADIUS. Локальные учётки (аварийный админ) идут ниже как раньше.
    let user: ReturnType<typeof userService.findByUsername>;
    const ent = await enterpriseLogin(data.username, data.password, (req.body as any)?.otp);
    if (ent.kind === 'fail') {
      if (ent.countAsFailure) loginFailed(ipKey, userKey);
      res.status(ent.status).json(ent.body);
      return;
    }
    if (ent.kind === 'ok') {
      user = userService.findById(ent.userId);
      if (!user) {
        res.status(500).json({ error: 'Login failed' });
        return;
      }
    } else {
      // Наружу отвечаем одинаково — какой именно из двух случаев, посторонним
      // знать незачем, иначе по ответам можно перебирать существующие имена.
      // А вот в журнал пишем РАЗНОЕ: без этого «не могу войти» неотличимо от
      // «опечатался в имени», и разбираться приходится вслепую. Пароль в
      // журнал не попадает ни в каком виде.
      const typed = data.username.trim();
      user = userService.findByUsername(typed);
      if (!user) {
        // Подсказываем, есть ли похожее имя: почти всегда это раскладка
        // (латиница вместо кириллицы) или регистр.
        const similar = dbUtils.all<{ username: string }>(
          `SELECT username FROM users
           WHERE LOWER(username) = LOWER(?) OR username LIKE ? LIMIT 3`,
          [typed, `%${typed}%`]
        ).map(r => r.username);
        logger.warn(
          `Вход не удался: пользователя «${typed}» нет` +
          (similar.length ? `. Похожие в базе: ${similar.join(', ')}` : '')
        );
        loginFailed(ipKey, userKey);
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }

      const isValid = await userService.verifyPassword(data.password, user.password_hash);
      if (!isValid) {
        logger.warn(`Вход не удался: неверный пароль у «${user.username}»`);
        loginFailed(ipKey, userKey);
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }
    }
    loginFails.delete(userKey);
    logger.info(`Вход выполнен: ${user.username}`);

    // Обновляем статус
    userService.updateStatus(user.id, 'online');

    const publicProfile = userService.getPublicProfile({ ...user, status: 'online' });
    const accessToken = generateAccessToken({ userId: user.id, username: user.username });
    const refreshToken = generateRefreshToken({ userId: user.id, username: user.username });

    // Сохраняем refresh token
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + REFRESH_TTL_DAYS);
    
    dbUtils.run(
      `INSERT INTO refresh_tokens (id, user_id, token, ip_address, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [uuidv4(), user.id, refreshToken, getClientIp(req), expiresAt.toISOString(), new Date().toISOString()]
    );

    logger.info(`User logged in: ${user.username}`);

    res.json({
      user: publicProfile,
      accessToken,
      refreshToken,
    });
  } catch (error) {
    logger.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Обновление токена
// Перебор токенов обновления: ограничиваем неудачные попытки с адреса.
const refreshFails = new Map<string, { n: number; since: number }>();
const REFRESH_FAIL_LIMIT = 60; // в час

function refreshFailed(ip: string) {
  const now = Date.now();
  const r = refreshFails.get(ip);
  if (!r || now - r.since > 3600_000) refreshFails.set(ip, { n: 1, since: now });
  else r.n++;
  if (refreshFails.size > 10000) refreshFails.clear();
}

router.post('/refresh', (req: Request, res: Response) => {
  try {
    const ip = getClientIp(req) || '';
    const fails = refreshFails.get(ip);
    if (fails && fails.n >= REFRESH_FAIL_LIMIT && Date.now() - fails.since < 3600_000) {
      res.status(429).json({ error: 'Too many attempts' });
      return;
    }
    // Любой ответ 401 ниже считается неудачной попыткой
    res.on('finish', () => { if (res.statusCode === 401) refreshFailed(ip); });

    const { refreshToken } = req.body;

    if (!refreshToken) {
      res.status(400).json({ error: 'Refresh token required' });
      return;
    }

    const payload = verifyRefreshToken(refreshToken);
    if (!payload?.userId) {
      res.status(401).json({ error: 'Invalid refresh token' });
      return;
    }

    const storedToken = dbUtils.get<{ user_id: string; expires_at: string }>(
      'SELECT user_id, expires_at FROM refresh_tokens WHERE token = ?',
      [refreshToken]
    );

    if (storedToken) {
      if (storedToken.user_id !== payload.userId) {
        res.status(401).json({ error: 'Invalid refresh token' });
        return;
      }
      if (new Date(storedToken.expires_at) < new Date()) {
        dbUtils.run('DELETE FROM refresh_tokens WHERE token = ?', [refreshToken]);
        res.status(401).json({ error: 'Refresh token expired' });
        return;
      }
      // Скользящий срок: пользуется — сессия продлевается
      dbUtils.run('UPDATE refresh_tokens SET expires_at = ? WHERE token = ?', [refreshExpiry(), refreshToken]);
    } else if (!payload.legacy && amnestyAllowed(payload)) {
      dbUtils.run(
        `INSERT INTO refresh_tokens (id, user_id, token, device_info, ip_address, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), payload.userId, refreshToken, 'amnesty', getClientIp(req), refreshExpiry(), new Date().toISOString()]
      );
      logger.info(`Refresh: старый токен принят по амнистии — ${payload.username}`);
    } else {
      res.status(401).json({ error: 'Invalid refresh token' });
      return;
    }

    const user = userService.findById(payload.userId);
    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }
    // Заблокированному не продлеваем. При блокировке токены и так удаляются
    // из базы, но проверка здесь не зависит от того, успели ли их удалить.
    if ((user as any).blocked_at) {
      res.status(403).json({ error: 'Аккаунт заблокирован', reason: (user as any).blocked_reason || undefined });
      return;
    }

    // Генерируем новый access token
    const accessToken = generateAccessToken({ userId: user.id, username: user.username });

    // Токен, подписанный прежним секретом, меняем на новый. Старый остаётся
    // в базе — необновлённые приложения нового не сохранят и ходят со старым.
    if (payload.legacy) {
      const fresh = generateRefreshToken({ userId: user.id, username: user.username });
      dbUtils.run(
        `INSERT INTO refresh_tokens (id, user_id, token, device_info, ip_address, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), user.id, fresh, 'rotated', getClientIp(req), refreshExpiry(), new Date().toISOString()]
      );
      res.json({ accessToken, refreshToken: fresh });
      return;
    }

    res.json({ accessToken });
  } catch (error) {
    logger.error('Token refresh error:', error);
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

// Восстановление пароля по ключу восстановления
router.post('/recover', async (req: Request, res: Response) => {
  try {
    const { username, recovery_key, new_password } = req.body;

    if (!username || !recovery_key || !new_password) {
      res.status(400).json({ error: 'Username, recovery key and new password are required' });
      return;
    }

    if (new_password.length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters' });
      return;
    }

    const success = await userService.resetPassword(username, recovery_key, new_password);
    if (!success) {
      res.status(401).json({ error: 'Invalid username or recovery key' });
      return;
    }

    logger.info(`Password recovered for user: ${username}`);
    res.json({ message: 'Password reset successfully' });
  } catch (error) {
    logger.error('Recovery error:', error);
    res.status(500).json({ error: 'Recovery failed' });
  }
});

// Выход
router.post('/logout', authMiddleware, (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;
    const userId = req.user!.userId;

    // Удаляем refresh token
    if (refreshToken) {
      dbUtils.run('DELETE FROM refresh_tokens WHERE token = ? AND user_id = ?', [refreshToken, userId]);
    }

    // Обновляем статус
    userService.updateStatus(userId, 'offline');

    logger.info(`User logged out: ${req.user!.username}`);
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    logger.error('Logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// Получить текущего пользователя
router.get('/me', authMiddleware, (req: Request, res: Response) => {
  try {
    const user = userService.findById(req.user!.userId);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({ user: userService.getPublicProfile(user) });
  } catch (error) {
    logger.error('Get current user error:', error);
    res.status(500).json({ error: 'Failed to get user data' });
  }
});

// Смена пароля (авторизованный пользователь)
router.post('/change-password', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { old_password, new_password } = req.body;

    if (!old_password || !new_password) {
      res.status(400).json({ error: 'Old password and new password are required' });
      return;
    }

    if (new_password.length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters' });
      return;
    }

    // У сотрудника каталога пароль один — доменный, и меняется он в домене.
    const src = dbUtils.get<{ auth_source: string }>('SELECT auth_source FROM users WHERE id = ?', [req.user!.userId]);
    if (src?.auth_source === 'directory') {
      res.status(400).json({ error: 'Пароль сотрудника меняется в домене (Ctrl+Alt+Del → «Изменить пароль»), а не в мессенджере' });
      return;
    }

    const success = await userService.changePassword(req.user!.userId, old_password, new_password);
    if (!success) {
      res.status(401).json({ error: 'Invalid current password' });
      return;
    }

    logger.info(`Password changed by user: ${req.user!.username}`);
    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    logger.error('Change password error:', error);
    res.status(500).json({ error: 'Password change failed' });
  }
});

// Запрос сброса пароля через email
router.post('/request-reset', async (req: Request, res: Response) => {
  try {
    const { username } = req.body;
    if (!username) {
      res.status(400).json({ error: 'Username is required' });
      return;
    }

    if (!emailService.isConfigured()) {
      res.status(503).json({ error: 'Email service not configured' });
      return;
    }

    // Сотруднику каталога письмо со сбросом не шлём: пароль у него доменный.
    // Ответ тот же, что и всем, — чтобы не раскрывать, чья это учётка.
    const src = dbUtils.get<{ auth_source: string }>(
      'SELECT auth_source FROM users WHERE username = ?', [String(username).trim().toLowerCase()]
    );
    if (src?.auth_source !== 'directory') {
      await emailService.sendResetEmail(username);
    }

    // Всегда отвечаем одинаково, чтобы не раскрывать существование аккаунта
    res.json({
      message: 'If the account exists and has an email, a reset link has been sent',
      emailConfigured: true,
    });
  } catch (error) {
    logger.error('Request reset error:', error);
    res.status(500).json({ error: 'Request reset failed' });
  }
});

// Проверка токена сброса
router.get('/reset-token/:token', (req: Request, res: Response) => {
  try {
    const valid = emailService.validateToken(req.params.token);
    res.json({ valid });
  } catch (error) {
    res.json({ valid: false });
  }
});

// Сброс пароля по email-токену
router.post('/reset-by-token', async (req: Request, res: Response) => {
  try {
    const { token, new_password } = req.body;
    if (!token || !new_password) {
      res.status(400).json({ error: 'Token and new_password are required' });
      return;
    }

    if (new_password.length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters' });
      return;
    }

    const success = await emailService.resetByToken(token, new_password);
    if (!success) {
      res.status(400).json({ error: 'Invalid or expired token' });
      return;
    }

    res.json({ message: 'Password reset successfully' });
  } catch (error) {
    logger.error('Reset by token error:', error);
    res.status(500).json({ error: 'Reset failed' });
  }
});

// Проверка: настроен ли email-сброс
router.get('/email-reset-available', (_req: Request, res: Response) => {
  res.json({ available: emailService.isConfigured() });
});

// Сброс пароля администратором
router.post('/admin-reset', async (req: Request, res: Response) => {
  try {
    // Сброс по заголовку — только с самой машины сервера (ярлык «Сброс
    // пароля» ходит на https://localhost). Снаружи этот путь подбирали бы:
    // он меняет пароль ЛЮБОМУ, включая админа. Из админки сброс идёт по ролям.
    const ip = getClientIp(req) || '';
    const local = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    const secret = String(req.headers['x-admin-secret'] || '');
    const want = String(config.adminSecret || '');
    const same = want.length > 0 && secret.length === want.length &&
                 timingSafeEqual(Buffer.from(secret), Buffer.from(want));
    if (!local || !same) {
      if (!local) logger.warn(`admin-reset снаружи отклонён: ${ip}`);
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const { username, new_password } = req.body;
    if (!username || !new_password) {
      res.status(400).json({ error: 'Username and new_password are required' });
      return;
    }

    if (new_password.length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters' });
      return;
    }

    const success = await userService.adminResetPassword(username, new_password);
    if (!success) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    logger.info(`Admin reset password for user: ${username}`);
    res.json({ message: 'Password reset successfully' });
  } catch (error) {
    logger.error('Admin reset error:', error);
    res.status(500).json({ error: 'Admin reset failed' });
  }
});

// ─── Email Bridge Settings ───

// GET /api/auth/email-bridge-settings — получить текущие настройки email bridge
router.get('/email-bridge-settings', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const user = dbUtils.get<{ email: string | null }>('SELECT email FROM users WHERE id = ?', [userId]);
    const settings = dbUtils.get<{ settings_json: string | null }>(
      'SELECT settings_json FROM user_settings WHERE user_id = ?', [userId]
    );

    let emailFallbackEnabled = false;
    let hasPassword = false;

    if (settings?.settings_json) {
      try {
        const json = JSON.parse(settings.settings_json);
        emailFallbackEnabled = json.email_fallback_enabled === true;
        hasPassword = !!json.email_password;
      } catch {}
    }

    res.json({
      email: user?.email || '',
      enabled: emailFallbackEnabled,
      hasPassword,
    });
  } catch (error) {
    logger.error('Get email bridge settings error:', error);
    res.status(500).json({ error: 'Failed to get email bridge settings' });
  }
});

// PUT /api/auth/email-bridge-settings — обновить настройки email bridge
router.put('/email-bridge-settings', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { email, enabled } = req.body;

    // Валидация email
    if (email !== undefined && email !== '') {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
      }
      // Проверка что email не занят другим юзером
      const existing = dbUtils.get<{ id: string }>(
        'SELECT id FROM users WHERE email = ? AND id != ?', [email.toLowerCase(), userId]
      );
      if (existing) {
        return res.status(400).json({ error: 'Email already used by another user' });
      }
    }

    // Обновляем email в users
    if (email !== undefined) {
      dbUtils.run(
        'UPDATE users SET email = ? WHERE id = ?',
        [email === '' ? null : email.toLowerCase(), userId]
      );
    }

    // Обновляем settings_json (enabled и/или password)
    if (enabled !== undefined || req.body.password !== undefined) {
      const settings = dbUtils.get<{ settings_json: string | null }>(
        'SELECT settings_json FROM user_settings WHERE user_id = ?', [userId]
      );

      let json: Record<string, unknown> = {};
      if (settings?.settings_json) {
        try { json = JSON.parse(settings.settings_json); } catch {}
      }
      
      if (enabled !== undefined) {
        json.email_fallback_enabled = !!enabled;
      }
      if (req.body.password !== undefined) {
        json.email_password = req.body.password;
      }

      if (settings) {
        dbUtils.run(
          'UPDATE user_settings SET settings_json = ? WHERE user_id = ?',
          [JSON.stringify(json), userId]
        );
      } else {
        dbUtils.run(
          'INSERT INTO user_settings (id, user_id, settings_json) VALUES (?, ?, ?)',
          [uuidv4(), userId, JSON.stringify(json)]
        );
      }
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Update email bridge settings error:', error);
    res.status(500).json({ error: 'Failed to update email bridge settings' });
  }
});

// POST /api/auth/test-personal-email — проверить и привязать личный Email пользователя
router.post('/test-personal-email', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Нужен email и пароль приложения' });
    }

    const domain = email.split('@')[1]?.toLowerCase() || '';
    
    // Пытаемся найти пресет для SMTP/IMAP
    // Простейшая эвристика, так как PRESETS определён ниже, дублировать не будем,
    // просто сделаем fetch к своему же эндпоинту или вызовем логику.
    // Проще задать базовые настройки для популярных сервисов здесь:
    let smtpHost = '';
    let smtpPort = 465;
    let imapHost = '';
    let imapPort = 993;

    if (domain.includes('yandex') || domain === 'ya.ru') {
      smtpHost = 'smtp.yandex.ru'; imapHost = 'imap.yandex.ru';
    } else if (domain.includes('gmail') || domain.includes('google')) {
      smtpHost = 'smtp.gmail.com'; smtpPort = 587; imapHost = 'imap.gmail.com';
    } else if (domain.includes('mail.ru') || domain === 'bk.ru' || domain === 'list.ru' || domain === 'inbox.ru') {
      smtpHost = 'smtp.mail.ru'; imapHost = 'imap.mail.ru';
    } else {
      return res.status(400).json({ error: `Автонастройка для домена ${domain} не поддерживается` });
    }

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: email, pass: password }
    });

    // 1. Проверяем SMTP
    await transporter.verify();

    // 2. Проверяем IMAP
    const { ImapFlow } = await import('imapflow');
    const client = new ImapFlow({
      host: imapHost,
      port: imapPort,
      secure: true,
      auth: { user: email, pass: password },
      logger: false
    });
    await client.connect();
    await client.logout();

    // 3. Отправляем тестовое письмо самому себе
    await transporter.sendMail({
      from: email,
      to: email,
      subject: '[STORAGE&MESS] Проверка личного почтового моста',
      text: 'Ваша почта успешно привязана к мессенджеру!\nТеперь сервер будет отправлять оффлайн-уведомления через ваш личный ящик.'
    });

    res.json({ success: true, message: 'Успешно! Тестовое письмо отправлено.' });
  } catch (error: any) {
    logger.error('Personal email test error:', error);
    let errorMsg = error.message || 'Неверный логин или пароль';
    if (errorMsg.includes('Invalid token')) {
      errorMsg = 'Неверный пароль приложения (убедитесь, что ввели 16 символов без пробелов)';
    }
    res.status(500).json({ error: 'Ошибка проверки: ' + errorMsg });
  }
});


// ─── SMTP/IMAP Пресеты по домену email ───────────────────────────────────────
// GET /api/auth/email-smtp-preset?email=user@gmail.com
// Возвращает готовые SMTP/IMAP настройки по домену email — без авторизации
router.get('/email-smtp-preset', (_req: Request, res: Response) => {
  const email = ((_req.query.email as string) || '').toLowerCase().trim();
  const domain = email.split('@')[1] || '';

  // Таблица известных провайдеров
  const PRESETS: Record<string, { smtp: any; imap: any; note?: string }> = {
    'gmail.com': {
      smtp: { host: 'smtp.gmail.com', port: 587, secure: false, user: email, from: email },
      imap: { host: 'imap.gmail.com', port: 993, secure: true, user: email },
      note: 'Для Gmail включите «Пароли приложений» в настройках безопасности аккаунта Google.',
    },
    'googlemail.com': {
      smtp: { host: 'smtp.gmail.com', port: 587, secure: false, user: email, from: email },
      imap: { host: 'imap.gmail.com', port: 993, secure: true, user: email },
      note: 'Для Gmail включите «Пароли приложений» в настройках безопасности аккаунта Google.',
    },
    'yandex.ru': {
      smtp: { host: 'smtp.yandex.ru', port: 465, secure: true, user: email, from: email },
      imap: { host: 'imap.yandex.ru', port: 993, secure: true, user: email },
      note: 'Разрешите IMAP/SMTP в настройках Яндекс.Почты → Почтовые программы.',
    },
    'ya.ru': {
      smtp: { host: 'smtp.yandex.ru', port: 465, secure: true, user: email, from: email },
      imap: { host: 'imap.yandex.ru', port: 993, secure: true, user: email },
      note: 'Разрешите IMAP/SMTP в настройках Яндекс.Почты → Почтовые программы.',
    },
    'yandex.com': {
      smtp: { host: 'smtp.yandex.com', port: 465, secure: true, user: email, from: email },
      imap: { host: 'imap.yandex.com', port: 993, secure: true, user: email },
      note: 'Разрешите IMAP/SMTP в настройках Яндекс.Почты → Почтовые программы.',
    },
    'mail.ru': {
      smtp: { host: 'smtp.mail.ru', port: 465, secure: true, user: email, from: email },
      imap: { host: 'imap.mail.ru', port: 993, secure: true, user: email },
      note: 'Разрешите доступ через IMAP в настройках Mail.ru.',
    },
    'bk.ru': {
      smtp: { host: 'smtp.mail.ru', port: 465, secure: true, user: email, from: email },
      imap: { host: 'imap.mail.ru', port: 993, secure: true, user: email },
      note: 'Разрешите доступ через IMAP в настройках Mail.ru.',
    },
    'list.ru': {
      smtp: { host: 'smtp.mail.ru', port: 465, secure: true, user: email, from: email },
      imap: { host: 'imap.mail.ru', port: 993, secure: true, user: email },
    },
    'inbox.ru': {
      smtp: { host: 'smtp.mail.ru', port: 465, secure: true, user: email, from: email },
      imap: { host: 'imap.mail.ru', port: 993, secure: true, user: email },
    },
    'rambler.ru': {
      smtp: { host: 'smtp.rambler.ru', port: 465, secure: true, user: email, from: email },
      imap: { host: 'imap.rambler.ru', port: 993, secure: true, user: email },
    },
    'hotmail.com': {
      smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false, user: email, from: email },
      imap: { host: 'outlook.office365.com', port: 993, secure: true, user: email },
    },
    'outlook.com': {
      smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false, user: email, from: email },
      imap: { host: 'outlook.office365.com', port: 993, secure: true, user: email },
    },
    'live.com': {
      smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false, user: email, from: email },
      imap: { host: 'outlook.office365.com', port: 993, secure: true, user: email },
    },
    'icloud.com': {
      smtp: { host: 'smtp.mail.me.com', port: 587, secure: false, user: email, from: email },
      imap: { host: 'imap.mail.me.com', port: 993, secure: true, user: email },
      note: 'Для iCloud используйте пароль приложения из настроек Apple ID.',
    },
  };

  const preset = PRESETS[domain];
  if (!preset) {
    return res.status(404).json({
      error: `Автонастройка для домена «${domain}» не поддерживается. Введите SMTP/IMAP вручную.`,
      domain,
    });
  }

  res.json({ ...preset, domain, email });
});

export default router;
