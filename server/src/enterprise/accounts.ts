// =============================================================================
// Корпоративный контур — учётки мессенджера по данным каталога.
//
// «Схлопывание» — то, что происходит с учёткой, когда сотрудник в каталоге
// перестал быть active (отключён, заблокирован, истёк срок, исключён из
// группы, удалён):
//   • users.blocked_at + blocked_reason, blocked_by_directory = 1;
//   • удаляются все токены обновления — ни одно устройство не продлит вход;
//   • снимаются регистрации push — уведомления на телефон больше не идут;
//   • сокетам уходит account:blocked, затем они разрываются; потоки SSE
//     закрываются;
//   • все ключи устройств отзываются и попадают в CRL.
//
// Обратно (снова active) снимается только блокировка, поставленная
// каталогом. Ручную блокировку администратора каталог не трогает никогда.
// Отозванные ключи остаются отозванными — устройство получит новый
// сертификат при следующем входе.
// =============================================================================

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { dbUtils } from '../database/index.js';
import { logger } from '../utils/logger.js';
import { getIo, emitToUser, disconnectUser } from '../socket/index.js';
import { closeSSEClients } from '../services/sse-notify.service.js';
import { entConfig } from './config.js';
import { addEvent } from './store.js';
import { revokeUserDevices } from './ca.js';
import { DirectoryPerson, DirectoryState, isMemberOf, stateOf, stateReason } from './directory.js';

export interface DirUserRow {
  id: string;
  username: string;
  email: string | null;
  display_name: string | null;
  role: string | null;
  status: string | null;
  blocked_at: string | null;
  blocked_reason: string | null;
  auth_source: string;
  directory_guid: string | null;
  directory_dn: string | null;
  directory_state: string | null;
  blocked_by_directory: number;
  directory_admin: number;
  department: string | null;
  title: string | null;
}

const COLS = `id, username, email, display_name, role, status, blocked_at, blocked_reason, auth_source,
  directory_guid, directory_dn, directory_state, blocked_by_directory, directory_admin, department, title`;

export function userByGuid(guid: string): DirUserRow | undefined {
  return dbUtils.get<DirUserRow>(`SELECT ${COLS} FROM users WHERE directory_guid = ?`, [guid]);
}

export function userById(id: string): DirUserRow | undefined {
  return dbUtils.get<DirUserRow>(`SELECT ${COLS} FROM users WHERE id = ?`, [id]);
}

export function directoryUsers(): DirUserRow[] {
  return dbUtils.all<DirUserRow>(`SELECT ${COLS} FROM users WHERE auth_source = 'directory'`);
}

/**
 * Пароль в базе у сотрудника каталога — случайный хеш правильного формата
 * bcrypt. Ему не соответствует ни один пароль: вход идёт только через
 * домен/RADIUS, а «сменить пароль» по старому паролю невозможно.
 * Генерировать настоящий bcrypt незачем — это 0,1 с на человека, а при
 * первой синхронизации их тысячи.
 */
function unusableHash(): string {
  const alphabet = './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(53);
  let s = '';
  for (const b of bytes) s += alphabet[b % 64];
  return '$2a$12$' + s;
}

// Конфликты имён сообщаем в журнал один раз, а не каждые 10 секунд
const reportedConflicts = new Set<string>();

function reportConflict(key: string, username: string, detail: string): void {
  if (reportedConflicts.has(key)) return;
  reportedConflicts.add(key);
  logger.warn(`Корпоративный контур: ${username} — ${detail}`);
  addEvent('sync_error', username, detail);
}

function emailFree(email: string, exceptId: string | null): boolean {
  const row = dbUtils.get<{ id: string }>('SELECT id FROM users WHERE email = ?', [email]);
  return !row || row.id === exceptId;
}

function wantedRole(p: DirectoryPerson, current: DirUserRow | null): { role: string; directoryAdmin: number } | null {
  if (!entConfig.ldap.adminGroupDn) return null; // ролями каталог не управляет
  if (isMemberOf(p, entConfig.ldap.adminGroupDn)) return { role: 'admin', directoryAdmin: 1 };
  if (current && current.directory_admin === 1) return { role: 'user', directoryAdmin: 0 };
  return null; // роль выдана вручную — не трогаем
}

// ─────────────────────────────────────────────────────────────────────
// Схлопывание и восстановление
// ─────────────────────────────────────────────────────────────────────

/** Отрезать все сессии и каналы доставки. Безопасно вызывать повторно. */
function cutSessions(userId: string): void {
  dbUtils.run('DELETE FROM refresh_tokens WHERE user_id = ?', [userId]);
  try { dbUtils.run('DELETE FROM push_tokens WHERE user_id = ?', [userId]); } catch { /* таблицы может не быть */ }
  try { dbUtils.run('DELETE FROM push_subscriptions WHERE user_id = ?', [userId]); } catch { /* таблицы может не быть */ }
  dbUtils.run(`UPDATE users SET push_token = NULL, status = 'offline' WHERE id = ?`, [userId]);
}

/**
 * Схлопнуть учётку. Возвращает true, если блокировка поставлена сейчас
 * (а не стояла уже).
 */
export function collapseUser(row: DirUserRow, reason: string): boolean {
  const now = new Date().toISOString();
  let newlyBlocked = false;
  if (!row.blocked_at) {
    dbUtils.run(
      'UPDATE users SET blocked_at = ?, blocked_reason = ?, blocked_by_directory = 1 WHERE id = ?',
      [now, reason, row.id]
    );
    newlyBlocked = true;
  } else if (row.blocked_by_directory === 1 && row.blocked_reason !== reason) {
    // Причина сменилась (отключили → удалили) — обновляем, блокировка та же
    dbUtils.run('UPDATE users SET blocked_reason = ? WHERE id = ?', [reason, row.id]);
    addEvent('updated', row.username, `причина блокировки: ${reason}`, row.id);
  }
  // Ручная блокировка остаётся ручной, но сессии и ключи режем в любом случае
  cutSessions(row.id);
  revokeUserDevices(row.id, reason);

  if (newlyBlocked) {
    addEvent('blocked', row.username, reason, row.id);
    logger.warn(`🔻 Корпоративный контур: учётка ${row.username} схлопнута — ${reason}`);
    const io = getIo();
    if (io) emitToUser(io as any, row.id, 'account:blocked', { reason });
    disconnectUser(row.id, 500);
    closeSSEClients(row.id);
  }
  return newlyBlocked;
}

/** Снять блокировку каталога. Ручную не трогает. */
export function restoreUser(row: DirUserRow): boolean {
  if (!row.blocked_at || row.blocked_by_directory !== 1) return false;
  dbUtils.run(
    'UPDATE users SET blocked_at = NULL, blocked_reason = NULL, blocked_by_directory = 0 WHERE id = ?',
    [row.id]
  );
  addEvent('unblocked', row.username, 'AD: снова активна', row.id);
  logger.info(`🔺 Корпоративный контур: учётка ${row.username} снова активна`);
  return true;
}

// ─────────────────────────────────────────────────────────────────────
// Применить запись каталога к базе
// ─────────────────────────────────────────────────────────────────────

export type ApplyOutcome = 'created' | 'updated' | 'blocked' | 'unblocked' | 'unchanged' | 'skipped';

export interface ApplyResult {
  outcome: ApplyOutcome;
  userId: string | null;
  state: Exclude<DirectoryState, 'removed'>;
}

/** Найти учётку для записи каталога; null + причина, если имя занято. */
function matchUser(p: DirectoryPerson): { row: DirUserRow | null; conflict: string | null } {
  const byGuid = userByGuid(p.guid);
  if (byGuid) return { row: byGuid, conflict: null };
  const name = p.sam.toLowerCase();
  const byName = dbUtils.get<DirUserRow>(`SELECT ${COLS} FROM users WHERE username = ?`, [name]);
  if (!byName) return { row: null, conflict: null };
  if (byName.auth_source !== 'directory') {
    // Локальную учётку каталогу не отдаём: иначе любой, кто заранее
    // зарегистрировал «ivanov», получил бы доменного Иванова (или наоборот).
    return { row: null, conflict: 'имя занято локальной учёткой мессенджера — учётка из каталога не создана' };
  }
  if (byName.directory_guid && byName.directory_guid !== p.guid) {
    // Тот же логин, но другой объект каталога: учётку пересоздали в AD или
    // логин отдали другому человеку. Чужую переписку не наследуем.
    return { row: null, conflict: 'логин принадлежал другой (прежней) учётке каталога — новая не создана, нужен администратор' };
  }
  return { row: byName, conflict: null };
}

export function applyPerson(p: DirectoryPerson): ApplyResult {
  const state = stateOf(p);
  const now = new Date().toISOString();
  const { row, conflict } = matchUser(p);

  if (conflict) {
    reportConflict(`${p.guid}:${p.sam.toLowerCase()}`, p.sam.toLowerCase(), conflict);
    return { outcome: 'skipped', userId: null, state };
  }

  const mail = p.mail.trim().toLowerCase();

  if (!row) {
    // Учётку получают только те, кому положено: active и в группе
    if (state !== 'active') return { outcome: 'skipped', userId: null, state };
    const id = uuidv4();
    const username = p.sam.toLowerCase();
    const role = wantedRole(p, null);
    dbUtils.transaction(() => {
      dbUtils.run(
        `INSERT INTO users (id, username, email, password_hash, recovery_hash, display_name, status,
            created_at, updated_at, auth_source, directory_guid, directory_dn, directory_state,
            directory_synced_at, department, title, role, directory_admin)
         VALUES (?, ?, ?, ?, NULL, ?, 'offline', ?, ?, 'directory', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, username, mail && emailFree(mail, null) ? mail : null, unusableHash(), p.displayName,
         now, now, p.guid, p.dn, state, now, p.department || null, p.title || null,
         role?.role || 'user', role?.directoryAdmin || 0]
      );
      dbUtils.run('INSERT INTO user_settings (id, user_id) VALUES (?, ?)', [uuidv4(), id]);
    });
    addEvent('created', username, [p.displayName, p.department, p.title].filter(Boolean).join(' · '), id);
    logger.info(`👤 Корпоративный контур: создана учётка ${username} (${p.displayName})`);
    return { outcome: 'created', userId: id, state };
  }

  // ── Учётка есть: обновляем поля ──
  const changes: string[] = [];
  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, val: unknown, label: string | null) => {
    sets.push(`${col} = ?`);
    vals.push(val);
    if (label) changes.push(label);
  };

  const wantName = p.sam.toLowerCase();
  if (row.username !== wantName) {
    const taken = dbUtils.get<{ id: string }>('SELECT id FROM users WHERE username = ? AND id != ?', [wantName, row.id]);
    if (!taken) set('username', wantName, `логин ${row.username} → ${wantName}`);
    else reportConflict(`rename:${row.id}:${wantName}`, row.username, `в каталоге логин сменился на ${wantName}, но это имя занято`);
  }
  if ((row.display_name || '') !== p.displayName) set('display_name', p.displayName, 'имя');
  if ((row.department || '') !== p.department) set('department', p.department || null, 'отдел');
  if ((row.title || '') !== p.title) set('title', p.title || null, 'должность');
  if ((row.directory_dn || '') !== p.dn) set('directory_dn', p.dn, 'DN');
  if (!row.directory_guid) set('directory_guid', p.guid, null);
  if ((row.email || '') !== mail) {
    if (!mail) set('email', null, 'почта');
    else if (emailFree(mail, row.id)) set('email', mail, 'почта');
  }
  const role = wantedRole(p, row);
  if (role && (row.role !== role.role || row.directory_admin !== role.directoryAdmin)) {
    set('role', role.role, `роль ${row.role || 'user'} → ${role.role}`);
    set('directory_admin', role.directoryAdmin, null);
  }
  // Смена состояния сама по себе не «обновление»: о ней скажут события
  // blocked / unblocked ниже
  set('directory_state', state, null);
  set('directory_synced_at', now, null);
  if (changes.length) set('updated_at', now, null);

  dbUtils.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...vals, row.id]);
  if (changes.length) addEvent('updated', wantName, changes.join(', '), row.id);

  let outcome: ApplyOutcome = changes.length ? 'updated' : 'unchanged';
  // «Заблокирована» (lockout после неверных паролей) — не увольнение: она
  // снимается сама через несколько минут, а вызвать её может кто угодно,
  // перебирая пароль от чужого имени. Новый вход она запрещает (login.ts),
  // но открытые сессии сотрудника не схлопывает — иначе любой мог бы
  // выкинуть коллегу из мессенджера. Схлопываем: отключена, срок истёк,
  // нет в группе, удалена.
  if (state === 'locked') {
    // ни схлопывать, ни снимать блокировку каталога не нужно
  } else if (state !== 'active') {
    if (collapseUser({ ...row, username: wantName }, stateReason(state))) outcome = 'blocked';
  } else if (restoreUser({ ...row, username: wantName })) {
    outcome = 'unblocked';
  }
  return { outcome, userId: row.id, state };
}

/** Сотрудника больше нет в каталоге. */
export function applyRemoved(row: DirUserRow): ApplyOutcome {
  const now = new Date().toISOString();
  const was = row.directory_state;
  dbUtils.run('UPDATE users SET directory_state = ?, directory_synced_at = ? WHERE id = ?', ['removed', now, row.id]);
  if (collapseUser(row, stateReason('removed'))) return 'blocked';
  return was === 'removed' ? 'unchanged' : 'updated';
}

/**
 * Ручная блокировка администратором: та же отрезка сессий и ключей, но
 * блокировка помечается как ручная — каталог её не снимет.
 */
export function onManualBlock(userId: string, reason: string): void {
  dbUtils.run('UPDATE users SET blocked_by_directory = 0 WHERE id = ?', [userId]);
  if (!entConfig.enabled) return;
  const row = userById(userId);
  if (!row) return;
  revokeUserDevices(userId, reason ? `администратор: ${reason}` : 'заблокирован администратором');
  addEvent('blocked', row.username, reason ? `администратор: ${reason}` : 'заблокирован администратором', userId);
}

export function onManualUnblock(userId: string): void {
  dbUtils.run('UPDATE users SET blocked_by_directory = 0 WHERE id = ?', [userId]);
  if (!entConfig.enabled) return;
  const row = userById(userId);
  if (row) addEvent('unblocked', row.username, 'снято администратором', userId);
}
