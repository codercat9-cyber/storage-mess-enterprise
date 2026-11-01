// =============================================================================
// Корпоративный контур — вход сотрудника.
//
// Прежний POST /api/auth/login { username, password }. Кто чем входит:
//   • локальная учётка (аварийный админ, учётки до включения контура) —
//     как раньше, по паролю в базе;
//   • сотрудник каталога — найти служебной учёткой, затем по ENT_AUTH:
//       ldap        — bind его DN его паролем;
//       radius      — Access-Request (PAP) на ENT_RADIUS_HOST;
//       ldap+radius — нужны оба (для RADIUS можно прислать отдельное поле
//                     otp — одноразовый код; без него уйдёт тот же пароль).
//
// Пустой пароль не уходит в каталог никогда: «неаутентифицированный» bind
// (DN + пустой пароль) AD считает успешным.
//
// Причину отказа («отключена в домене») человек узнаёт, только если пароль
// подтвердился или каталог сам сообщает её без пароля (блокировка после
// неверных паролей) — иначе по ответам можно было бы опрашивать, кто в
// компании уволен.
// =============================================================================

import { dbUtils } from '../database/index.js';
import { logger } from '../utils/logger.js';
import { entConfig, groupLabel } from './config.js';
import { addEvent } from './store.js';
import {
  findPerson, checkPassword, stateOf, parseLogin, adCodeReason,
  DirectoryUnavailableError, DirectoryPerson,
} from './directory.js';
import { radiusAuthenticate } from './radius-client.js';
import { applyPerson, userByGuid } from './accounts.js';

export type EntLoginResult =
  | { kind: 'local' }
  | { kind: 'ok'; userId: string }
  | { kind: 'fail'; status: number; body: Record<string, unknown>; countAsFailure: boolean };

const GENERIC = { error: 'Invalid credentials' };

function stateText(state: string): string {
  switch (state) {
    case 'disabled': return 'Учётная запись отключена в домене';
    case 'locked': return 'Учётная запись заблокирована в домене после неверных паролей. Обратитесь в ИТ-отдел или подождите';
    case 'expired': return 'Срок действия учётной записи в домене истёк';
    case 'not_in_group': return `Нет доступа к мессенджеру: вас нет в группе «${groupLabel(entConfig.ldap.groupDn)}»`;
    default: return 'Вход запрещён';
  }
}

/** Имя для журнала: что ввели, без управляющих символов и не длиннее разумного. */
function safeName(typed: string): string {
  return typed.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 64);
}

function fail(status: number, body: Record<string, unknown>, countAsFailure: boolean): EntLoginResult {
  return { kind: 'fail', status, body, countAsFailure };
}

/** Пароль пустой — в корпоративном режиме это тоже событие для журнала. */
export function noteEmptyPassword(typed: string): void {
  if (!entConfig.enabled) return;
  addEvent('login_failed', safeName(typed || ''), 'пустой пароль — отказ без обращения к каталогу');
}

export async function enterpriseLogin(typedRaw: string, password: string, otp?: unknown): Promise<EntLoginResult> {
  if (!entConfig.enabled) return { kind: 'local' };

  const typed = (typedRaw || '').trim();
  const login = parseLogin(typed);
  if (!login) {
    addEvent('login_failed', safeName(typed), 'недопустимое имя');
    return fail(401, GENERIC, true);
  }

  // Локальные учётки (аварийный админ) входят как раньше. Доменная форма
  // имени (CORP\…, …@…) — всегда каталог.
  const domainForm = typed.includes('\\') || typed.includes('@');
  if (!domainForm) {
    const local = dbUtils.get<{ auth_source: string }>(
      'SELECT auth_source FROM users WHERE username = ?', [typed.toLowerCase()]
    );
    if (local && local.auth_source !== 'directory') return { kind: 'local' };
  }

  if (typeof password !== 'string' || password.length === 0) {
    addEvent('login_failed', safeName(typed), 'пустой пароль — отказ без обращения к каталогу');
    return fail(401, GENERIC, true);
  }

  let person: DirectoryPerson | null;
  try {
    person = await findPerson(typed);
  } catch (e) {
    const msg = e instanceof DirectoryUnavailableError ? e.message : (e as Error).message;
    addEvent('login_failed', safeName(typed), `каталог недоступен: ${msg}`);
    logger.warn(`Вход сотрудника «${safeName(typed)}» невозможен: каталог недоступен — ${msg}`);
    return fail(503, { error: 'Домен сейчас недоступен — вход сотрудников временно невозможен. Попробуйте позже' }, false);
  }
  if (!person) {
    addEvent('login_failed', safeName(typed), 'нет в каталоге');
    logger.warn(`Вход не удался: «${safeName(typed)}» нет в каталоге`);
    return fail(401, GENERIC, true);
  }

  const username = person.sam.toLowerCase();
  const state = stateOf(person);

  // ── Проверка пароля ──
  let passed = false;
  let adCode: string | null = null;
  let how = '';
  if (entConfig.auth === 'ldap' || entConfig.auth === 'ldap+radius') {
    const r = await checkPassword(person.dn, password);
    if (r.ok) {
      passed = true;
    } else if (r.unavailable) {
      addEvent('login_failed', username, `каталог недоступен при проверке пароля: ${r.message}`);
      return fail(503, { error: 'Домен сейчас недоступен — вход сотрудников временно невозможен. Попробуйте позже' }, false);
    } else {
      adCode = r.adCode;
      how = 'пароль домена не принят';
    }
  }
  if (entConfig.auth === 'radius' || (entConfig.auth === 'ldap+radius' && passed)) {
    const second = typeof otp === 'string' && otp.length > 0 && entConfig.auth === 'ldap+radius' ? otp : password;
    const r = await radiusAuthenticate(person.sam, second);
    if (r.ok) {
      passed = true;
    } else if (r.unavailable) {
      addEvent('login_failed', username, `RADIUS недоступен: ${r.message}`);
      return fail(503, { error: 'Сервер проверки входа (RADIUS) недоступен. Попробуйте позже' }, false);
    } else {
      passed = false;
      how = r.message ? `RADIUS отказал: ${r.message}` : 'RADIUS отказал';
    }
  }

  // Каталог подтвердил состояние — применяем сразу, не дожидаясь синхронизации
  if (state !== 'active') {
    try { applyPerson(person); } catch (e) { logger.error('Вход: не удалось применить состояние каталога', e); }
  }

  if (!passed) {
    const adText = adCodeReason(adCode);
    if (state === 'locked' || adCode === '775') {
      addEvent('login_failed', username, `${how || 'отказ'} · учётка заблокирована в домене`);
      return fail(403, { error: stateText('locked'), code: 'locked' }, true);
    }
    if (adText) {
      // AD сообщает эти причины только при верном пароле
      addEvent('login_failed', username, `${how} · ${adText}`);
      return fail(403, { error: adText, code: `ad_${adCode}` }, true);
    }
    addEvent('login_failed', username, how || 'неверный пароль');
    logger.warn(`Вход не удался: неверный пароль у сотрудника «${username}»`);
    return fail(401, GENERIC, true);
  }

  if (state !== 'active') {
    addEvent('login_failed', username, `пароль верный, но ${stateText(state).toLowerCase()}`);
    return fail(403, { error: stateText(state), code: state }, false);
  }

  // ── Пароль подтверждён, сотрудник active: учётка (создаётся на лету) ──
  let applied;
  try {
    applied = applyPerson(person);
  } catch (e) {
    logger.error('Вход: не удалось создать/обновить учётку сотрудника', e);
    return fail(500, { error: 'Login failed' }, false);
  }
  const row = userByGuid(person.guid);
  if (!row) {
    addEvent('login_failed', username, 'имя занято другой учёткой мессенджера');
    return fail(409, { error: 'Имя занято другой учёткой мессенджера — обратитесь к администратору' }, false);
  }
  if (row.blocked_at) {
    addEvent('login_failed', username, `заблокирован администратором${row.blocked_reason ? ': ' + row.blocked_reason : ''}`);
    return fail(403, { error: 'Аккаунт заблокирован', reason: row.blocked_reason || 'заблокирован администратором', code: 'blocked' }, false);
  }

  const method = entConfig.auth === 'ldap+radius' ? 'пароль домена + RADIUS' : entConfig.auth === 'radius' ? 'RADIUS' : 'пароль домена';
  addEvent('login', username, `${method}${applied.outcome === 'created' ? ' · учётка создана при входе' : ''}`, row.id);
  return { kind: 'ok', userId: row.id };
}
