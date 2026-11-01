import { dbUtils } from '../database/index.js';

/**
 * Отключение уведомлений от конкретного человека.
 *
 * Настройка личная и односторонняя: если Аня заглушила Борю, то тихо
 * становится только у Ани, а Боря об этом не знает и ничего не замечает.
 * Сообщения при этом доходят и ложатся в переписку как обычно — молчит
 * только уведомление.
 *
 * Хранится там же, где прозвище и своя аватарка контакта: это такая же
 * пометка одного человека про другого.
 */

/** Заглушил ли получатель этого отправителя. */
export function isMuted(recipientId: string, senderId?: string): boolean {
  if (!recipientId || !senderId || recipientId === senderId) return false;
  try {
    const row = dbUtils.get<{ muted: number }>(
      'SELECT muted FROM user_contact_overrides WHERE user_id = ? AND contact_id = ?',
      [recipientId, senderId],
    );
    return Boolean(row && row.muted);
  } catch {
    // Нет таблицы или колонки — значит никто никого не глушил.
    return false;
  }
}

/** Включить или выключить уведомления от человека. Возвращает новое состояние. */
export function setMuted(userId: string, contactId: string, muted: boolean): boolean {
  dbUtils.run(
    `INSERT INTO user_contact_overrides (user_id, contact_id, muted, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id, contact_id) DO UPDATE SET muted = excluded.muted, updated_at = CURRENT_TIMESTAMP`,
    [userId, contactId, muted ? 1 : 0],
  );
  return muted;
}

/** Кого этот человек заглушил — чтобы показать состояние в интерфейсе. */
export function listMuted(userId: string): string[] {
  try {
    const rows = dbUtils.all<{ contact_id: string }>(
      'SELECT contact_id FROM user_contact_overrides WHERE user_id = ? AND muted = 1',
      [userId],
    );
    return rows.map(r => r.contact_id);
  } catch {
    return [];
  }
}
