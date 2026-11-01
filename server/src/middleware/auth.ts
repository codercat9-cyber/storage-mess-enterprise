import { Request, Response, NextFunction } from 'express';
import jwt, { SignOptions, Secret } from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { config } from '../config/index.js';
import { JWTPayload } from '../types/index.js';
import { dbUtils } from '../database/index.js';

// Расширяем Express Request
declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload;
    }
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    res.status(401).json({ error: 'Authorization header missing' });
    return;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    res.status(401).json({ error: 'Invalid authorization format. Use: Bearer <token>' });
    return;
  }

  const token = parts[1];

  try {
    const decoded = jwt.verify(token, config.jwt.secret) as JWTPayload;

    // Заблокированного не пускаем. Проверка ходит в базу на каждый
    // запрос — это выборка по первичному ключу в локальном SQLite,
    // доли миллисекунды. Иначе блокировка не действует до протухания
    // токена, то есть буянящий остаётся в системе ещё сутки.
    try {
      const st = dbUtils.get<{ blocked_at: string | null; blocked_reason: string | null }>(
        'SELECT blocked_at, blocked_reason FROM users WHERE id = ?', [(decoded as any).userId]
      );
      if (st?.blocked_at) {
        res.status(403).json({
          error: 'Аккаунт заблокирован',
          reason: st.blocked_reason || undefined,
        });
        return;
      }
    } catch {
      // Сбой проверки не должен закрывать доступ всем сразу.
    }

    req.user = decoded;
    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: 'Token expired' });
      return;
    }
    if (error instanceof jwt.JsonWebTokenError) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }
    res.status(500).json({ error: 'Authentication error' });
  }
}

export function optionalAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    next();
    return;
  }

  const parts = authHeader.split(' ');
  if (parts.length === 2 && parts[0] === 'Bearer') {
    try {
      const decoded = jwt.verify(parts[1], config.jwt.secret) as JWTPayload;
      // Поддержка старых токенов, где был user_id
      const userId = decoded.userId || (decoded as any).user_id;
      req.user = { ...decoded, userId };
    } catch {
      // Игнорируем невалидный токен
    }
  }
  
  next();
}

// Генерация токенов
export function generateAccessToken(payload: Omit<JWTPayload, 'iat' | 'exp'>): string {
  const secret: Secret = config.jwt.secret;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const options: SignOptions = { expiresIn: config.jwt.expiresIn as any };
  return jwt.sign(payload as object, secret, options);
}

export function generateRefreshToken(payload: Omit<JWTPayload, 'iat' | 'exp'>): string {
  const secret: Secret = config.jwt.secret;
  // Срок внутри токена — лишь верхняя граница. Действующий срок хранит база
  // (refresh_tokens.expires_at) и продлевает при каждом обновлении.
  // jwtid — случайный: без него два входа одного человека в одну секунду
  // давали одинаковый токен, и запись в refresh_tokens падала (UNIQUE)
  const options: SignOptions = { expiresIn: '3650d', jwtid: randomUUID() };
  return jwt.sign(payload as object, secret, options);
}

/**
 * Токен обновления: подлинность — по подписи, срок — по базе, а не по JWT.
 * Иначе скользящий срок невозможен: продлить срок, зашитый в токен, нельзя.
 */
export function verifyRefreshToken(token: string): (JWTPayload & { legacy?: boolean }) | null {
  try {
    return jwt.verify(token, config.jwt.secret, { ignoreExpiration: true }) as JWTPayload;
  } catch { /* может быть подписан прежним секретом */ }
  // Подпись прежним секретом НЕ доказывает подлинность (секрет был
  // угадываемым) — такой токен принимается, только если он лежит в базе.
  for (const old of config.jwt.legacySecrets) {
    try {
      return { ...(jwt.verify(token, old, { ignoreExpiration: true }) as JWTPayload), legacy: true };
    } catch { /* следующий */ }
  }
  return null;
}

export function verifyToken(token: string): JWTPayload | null {
  try {
    return jwt.verify(token, config.jwt.secret) as JWTPayload;
  } catch {
    return null;
  }
}

export default {
  authMiddleware,
  optionalAuthMiddleware,
  generateAccessToken,
  generateRefreshToken,
  verifyToken,
};
