// =============================================================================
// Корпоративный контур STORAGE&MESS: учётки из Active Directory, вход по
// паролю домена и/или RADIUS, корпоративный УЦ для ключей устройств.
//
//   config.ts        — настройки из server/.env (ENT_*)
//   directory.ts     — LDAP: поиск, bind, флаги AD → directory_state
//   radius-client.ts — Access-Request PAP с Message-Authenticator
//   accounts.ts      — создание учёток, «схлопывание», восстановление
//   sync.ts          — периодическая синхронизация с защитой от массовой ошибки
//   login.ts         — вход сотрудника
//   ca.ts            — Ed25519 УЦ: сертификаты устройств и список отзыва
//   routes/enterprise.routes.ts — /api/enterprise/*
// =============================================================================

import { v4 as uuidv4 } from 'uuid';
import { dbUtils } from '../database/index.js';
import { logger } from '../utils/logger.js';
import { entConfig } from './config.js';
import { initCa } from './ca.js';
import { startSyncLoop, stopSyncLoop } from './sync.js';

export { entConfig } from './config.js';

/**
 * Аварийный локальный администратор. Когда домен лежит, войти больше
 * некому — поэтому одна локальная учётка остаётся всегда. В .env лежит
 * только bcrypt-хеш (ENT_BREAKGLASS_HASH); при смене хеша меняется и пароль.
 */
function ensureBreakglass(): void {
  const { username, hash } = entConfig.breakglass;
  if (!username || !hash) return;
  if (!/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(hash)) {
    logger.warn('⚠ ENT_BREAKGLASS_HASH не похож на bcrypt-хеш — аварийный администратор не создан');
    return;
  }
  const row = dbUtils.get<{ id: string; auth_source: string; password_hash: string; role: string | null }>(
    'SELECT id, auth_source, password_hash, role FROM users WHERE username = ?', [username]
  );
  const now = new Date().toISOString();
  if (!row) {
    const id = uuidv4();
    dbUtils.transaction(() => {
      dbUtils.run(
        `INSERT INTO users (id, username, password_hash, display_name, status, created_at, updated_at, role, auth_source)
         VALUES (?, ?, ?, ?, 'offline', ?, ?, 'admin', 'local')`,
        [id, username, hash, 'Аварийный администратор', now, now]
      );
      dbUtils.run('INSERT INTO user_settings (id, user_id) VALUES (?, ?)', [uuidv4(), id]);
    });
    logger.info(`🛟 Аварийный локальный администратор «${username}» создан`);
    return;
  }
  if (row.auth_source === 'directory') {
    logger.warn(`⚠ ENT_BREAKGLASS_ADMIN=${username} — это учётка из каталога; аварийной её не делаю`);
    return;
  }
  if (row.password_hash !== hash || row.role !== 'admin') {
    dbUtils.run(
      `UPDATE users SET password_hash = ?, role = 'admin', updated_at = ?, password_changed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [hash, now, row.id]
    );
    if (row.password_hash !== hash) dbUtils.run('DELETE FROM refresh_tokens WHERE user_id = ?', [row.id]);
    logger.info(`🛟 Аварийный администратор «${username}»: пароль/роль приведены к .env`);
  }
}

export function startEnterprise(): void {
  if (!entConfig.enabled) return;
  try {
    initCa();
  } catch (e) {
    logger.error('Корпоративный УЦ не запущен:', e);
  }
  try {
    ensureBreakglass();
  } catch (e) {
    logger.error('Аварийный администратор:', e);
  }
  startSyncLoop();
}

export function stopEnterprise(): void {
  stopSyncLoop();
}
