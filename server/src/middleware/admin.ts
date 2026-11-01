// =============================================================================
// Админ-доступ и блокировка учёток.
//
// Раньше «админом» был общий секрет в заголовке x-admin-secret. У такого
// секрета три беды: он один на всех и его нельзя отозвать у одного
// человека; он не отвечает на вопрос КТО сделал действие; и он утекает
// целиком вместе с ярлыком на рабочем столе. Теперь роль лежит в самой
// учётке, а каждое действие пишется в журнал с именем администратора.
// =============================================================================

import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { getClientIp } from '../utils/client-ip.js';
import { dbUtils } from '../database/index.js';
import { logger } from '../utils/logger.js';

export interface AdminUser {
  id: string;
  username: string;
  role: string;
}

/**
 * Пропускает только администратора. Ставится ПОСЛЕ authMiddleware.
 *
 * Роль читается из базы, а не из токена: иначе снятие прав вступало бы
 * в силу только после того, как у человека протухнет токен.
 */
export function adminMiddleware(req: Request, res: Response, next: NextFunction): void {
  const userId = (req as any).user?.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const row = dbUtils.get<{ id: string; username: string; role: string | null }>(
    'SELECT id, username, role FROM users WHERE id = ?', [userId]
  );

  // Модератор допускается в раздел, но урезан: тяжёлые операции
  // закрыты отдельной проверкой adminOnly ниже.
  if (!row || (row.role !== 'admin' && row.role !== 'moderator')) {
    // Отвечаем 404, а не 403: постороннему незачем знать, что такой
    // раздел вообще существует.
    logger.warn(`Попытка входа в админку без прав: ${userId}`);
    res.status(404).json({ error: 'Not found' });
    return;
  }

  (req as any).admin = { id: row.id, username: row.username, role: row.role } as AdminUser;
  next();
}

/**
 * Только полный администратор. Ставится на операции, которые модератору
 * не положены: удаление аккаунтов, смена ролей, сброс паролей и
 * рассылка объявлений. Модерация сообщений и блокировка ему доступны —
 * ради этого роль и заводилась.
 */
export function adminOnly(req: Request, res: Response, next: NextFunction): void {
  const admin = (req as any).admin as AdminUser | undefined;
  if (admin?.role !== 'admin') {
    res.status(403).json({ error: 'Нужны права администратора' });
    return;
  }
  next();
}

/**
 * Отказ заблокированным. Ставится в общий конвейер API.
 *
 * Проверка ходит в базу на каждый запрос — это одна выборка по
 * первичному ключу в локальном SQLite, доли миллисекунды. Иначе
 * блокировка не действовала бы до истечения токена, то есть буянящий
 * пользователь оставался бы в системе ещё сутки.
 */
export function blockedGuard(req: Request, res: Response, next: NextFunction): void {
  const userId = (req as any).user?.userId;
  if (!userId) { next(); return; }

  try {
    const row = dbUtils.get<{ blocked_at: string | null; blocked_reason: string | null }>(
      'SELECT blocked_at, blocked_reason FROM users WHERE id = ?', [userId]
    );
    if (row?.blocked_at) {
      res.status(403).json({
        error: 'Аккаунт заблокирован',
        reason: row.blocked_reason || undefined,
        blocked_at: row.blocked_at,
      });
      return;
    }
  } catch (e) {
    // База икнула — пропускаем. Ронять всем доступ из-за сбоя проверки
    // блокировки хуже, чем на минуту пропустить заблокированного.
    logger.warn('Проверка блокировки не удалась, пропускаю запрос:', e);
  }
  next();
}

/** Запись в журнал администратора. Вызывать ДО выполнения действия. */
export function audit(
  req: Request,
  action: string,
  target: { type?: string; id?: string } = {},
  details?: unknown
): void {
  const admin = (req as any).admin as AdminUser | undefined;
  try {
    dbUtils.run(
      `INSERT INTO admin_audit (id, admin_id, admin_name, action, target_type, target_id, details, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        admin?.id || 'unknown',
        admin?.username || null,
        action,
        target.type || null,
        target.id || null,
        details === undefined ? null : JSON.stringify(details),
        // Адрес сокета, а не заголовок: след в журнале аудита должен
        // указывать на автора действия, а не на то, что автор себе вписал.
        getClientIp(req) || null,
        new Date().toISOString(),
      ]
    );
  } catch (e) {
    // Журнал не должен ронять операцию, но и молчать о сбое нельзя:
    // непишущийся аудит — это потерянная подотчётность.
    logger.error('НЕ УДАЛОСЬ ЗАПИСАТЬ В ЖУРНАЛ АДМИНА:', e);
  }
}
