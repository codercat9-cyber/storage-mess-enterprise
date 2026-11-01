// =============================================================================
// Корпоративный контур — состояние и журнал событий в базе.
//
// Журнал (enterprise_events) — это то, что видит администратор: кто создан,
// кто схлопнут и почему, кто не смог войти. Паролей и секретов в нём нет и
// быть не может: сюда передаются только имена и причины.
// =============================================================================

import { dbUtils } from '../database/index.js';
import { logger } from '../utils/logger.js';

export type EntEventKind =
  | 'created' | 'updated' | 'blocked' | 'unblocked'
  | 'login' | 'login_failed'
  | 'device_issued' | 'device_revoked'
  | 'sync_ok' | 'sync_error';

export function getState(key: string): string | null {
  try {
    const row = dbUtils.get<{ value: string | null }>('SELECT value FROM enterprise_state WHERE key = ?', [key]);
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export function setState(key: string, value: string | number | boolean | null): void {
  dbUtils.run(
    `INSERT INTO enterprise_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value === null ? null : String(value), new Date().toISOString()]
  );
}

// Сколько событий держать. Журнал не должен расти бесконечно: синхронизация
// раз в 10 секунд с ошибкой — это 8640 строк в сутки.
const EVENTS_KEEP = 20000;
let eventsSinceTrim = 0;

export function addEvent(kind: EntEventKind, username: string | null, detail = '', userId: string | null = null): void {
  try {
    dbUtils.run(
      `INSERT INTO enterprise_events (at, kind, user_id, username, detail) VALUES (?, ?, ?, ?, ?)`,
      [new Date().toISOString(), kind, userId, username, String(detail || '').slice(0, 500)]
    );
    if (++eventsSinceTrim >= 500) {
      eventsSinceTrim = 0;
      dbUtils.run(
        `DELETE FROM enterprise_events WHERE id <= (SELECT MAX(id) FROM enterprise_events) - ?`,
        [EVENTS_KEEP]
      );
    }
  } catch (e) {
    logger.error('Корпоративный контур: не удалось записать событие', e);
  }
}

export function listEvents(limit: number): Array<{ at: string; kind: string; username: string | null; detail: string }> {
  const n = Math.min(1000, Math.max(1, Math.floor(limit) || 100));
  return dbUtils.all(
    `SELECT at, kind, username, detail FROM enterprise_events ORDER BY id DESC LIMIT ?`, [n]
  );
}
