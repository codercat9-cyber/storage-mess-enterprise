// =============================================================================
// Корпоративный контур — каталог (Active Directory и совместимые) по LDAP.
//
// Что отсюда нужно остальному коду:
//   • listPeople()  — все люди под ENT_LDAP_BASE_DN (постранично);
//   • findPerson()  — один сотрудник по логину (служебной учёткой);
//   • checkPassword() — bind DN сотрудника его паролем;
//   • stateOf()     — во что превращаются флаги AD: active | disabled | …
//
// Каждое обращение — своё соединение: открыли, сделали, закрыли. Держать
// постоянное соединение с контроллером ради запроса раз в минуту незачем,
// а «залипшее» соединение после перезагрузки DC — частая беда.
// =============================================================================

import fs from 'fs';
import type tls from 'tls';
import { Client, InvalidCredentialsError, type Entry } from 'ldapts';
import { entConfig } from './config.js';
import { logger } from '../utils/logger.js';

export type DirectoryState = 'active' | 'disabled' | 'locked' | 'expired' | 'not_in_group' | 'removed';

export interface DirectoryPerson {
  guid: string;          // objectGUID в виде xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx, нижний регистр
  dn: string;
  sam: string;           // sAMAccountName как есть
  upn: string;
  displayName: string;
  mail: string;
  department: string;
  title: string;
  uac: number;           // userAccountControl
  uacComputed: number | null; // msDS-User-Account-Control-Computed (есть только у настоящего AD)
  lockoutTime: string;   // FILETIME строкой
  accountExpires: string;// FILETIME строкой
  memberOf: string[];
  whenChanged: string;
}

const ATTRIBUTES = [
  'objectGUID', 'sAMAccountName', 'userPrincipalName', 'displayName', 'cn', 'mail',
  'department', 'title', 'userAccountControl', 'lockoutTime', 'accountExpires',
  'memberOf', 'whenChanged', 'msDS-User-Account-Control-Computed',
];

/** Каталог недоступен (сеть, TLS, служебная учётка) — в отличие от «нет такого». */
export class DirectoryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectoryUnavailableError';
  }
}

// ─────────────────────────────────────────────────────────────────────
// RFC 4515: экранирование значения в фильтре. Без этого логин вида
// «*)(sAMAccountName=*» превращал бы поиск одного человека в поиск всех.
//
// Экранируем ровно спецсимволы фильтра. Байты UTF-8 оставляем как есть —
// RFC это разрешает, а ldapts собирает \XX-последовательности по одному
// байту и портит многобайтные символы.
// ─────────────────────────────────────────────────────────────────────
export function escapeFilterValue(value: string): string {
  let out = '';
  for (const ch of value) {
    switch (ch) {
      case '\\': out += '\\5c'; break;
      case '*': out += '\\2a'; break;
      case '(': out += '\\28'; break;
      case ')': out += '\\29'; break;
      case '\u0000': out += '\\00'; break;
      default: out += ch;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// objectGUID: у настоящего AD это 16 байт, причём первые три поля
// записаны little-endian (так их показывает и сам Windows). У учебного
// каталога и у части LDAP-шлюзов — уже готовая строка. Принимаем оба.
// ─────────────────────────────────────────────────────────────────────
const GUID_RE = /^\{?([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})\}?$/i;

export function guidToString(raw: Buffer | string | undefined | null): string {
  if (raw === undefined || raw === null) return '';
  if (Buffer.isBuffer(raw)) {
    if (raw.length === 16) {
      const h = raw.toString('hex');
      const le = (s: string) => s.match(/../g)!.reverse().join('');
      return [le(h.slice(0, 8)), le(h.slice(8, 12)), le(h.slice(12, 16)), h.slice(16, 20), h.slice(20)].join('-');
    }
    raw = raw.toString('utf8');
  }
  const s = String(raw).trim();
  const m = GUID_RE.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}-${m[4]}-${m[5]}`.toLowerCase();
  // Не похоже на GUID вовсе — берём как есть, лишь бы было постоянным
  return s.toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────
// Время в AD — FILETIME: сотни наносекунд от 1601-01-01. accountExpires
// 0 и 9223372036854775807 означают «бессрочно».
// ─────────────────────────────────────────────────────────────────────
const FILETIME_EPOCH_MS = 11644473600000n;
const NEVER = '9223372036854775807';

export function filetimeToMs(v: string): number | null {
  const s = (v || '').trim();
  if (!s || !/^-?\d+$/.test(s) || s === '0' || s === NEVER) return null;
  try {
    const n = BigInt(s);
    if (n <= 0n) return null;
    return Number(n / 10000n - FILETIME_EPOCH_MS);
  } catch {
    return null;
  }
}

const UF_ACCOUNTDISABLE = 0x2;
const UF_LOCKOUT = 0x10;

function sameDn(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\s*,\s*/g, ',').replace(/\s*=\s*/g, '=').trim().toLowerCase();
  return norm(a) === norm(b);
}

export function isMemberOf(p: DirectoryPerson, groupDn: string): boolean {
  if (!groupDn) return false;
  return p.memberOf.some(g => sameDn(g, groupDn));
}

/** Состояние сотрудника по флагам каталога. Порядок важен: сначала самое «сильное». */
export function stateOf(p: DirectoryPerson, now = Date.now()): Exclude<DirectoryState, 'removed'> {
  if (p.uac & UF_ACCOUNTDISABLE) return 'disabled';
  // У настоящего AD lockoutTime не обнуляется сам по истечении блокировки —
  // только при следующем входе. Истинное состояние — вычисляемый атрибут.
  if (p.uacComputed !== null) {
    if (p.uacComputed & UF_LOCKOUT) return 'locked';
  } else {
    const lt = (p.lockoutTime || '0').trim();
    if (/^\d+$/.test(lt) && lt !== '0') return 'locked';
  }
  const exp = filetimeToMs(p.accountExpires);
  if (exp !== null && exp <= now) return 'expired';
  if (!isMemberOf(p, entConfig.ldap.groupDn)) return 'not_in_group';
  return 'active';
}

export function stateReason(state: DirectoryState): string {
  switch (state) {
    case 'disabled': return 'AD: отключена';
    case 'locked': return 'AD: заблокирована (неверные пароли)';
    case 'expired': return 'AD: срок действия истёк';
    case 'not_in_group': return 'AD: нет в группе доступа к мессенджеру';
    case 'removed': return 'AD: удалена из каталога';
    default: return '';
  }
}

// ─────────────────────────────────────────────────────────────────────
// Соединение
// ─────────────────────────────────────────────────────────────────────

let caCache: { file: string; data: Buffer } | null = null;

function tlsOptions(url: string): tls.ConnectionOptions {
  const opts: tls.ConnectionOptions = {
    rejectUnauthorized: !entConfig.ldap.tlsInsecure,
    minVersion: 'TLSv1.2',
  };
  if (entConfig.ldap.caFile) {
    if (!caCache || caCache.file !== entConfig.ldap.caFile) {
      caCache = { file: entConfig.ldap.caFile, data: fs.readFileSync(entConfig.ldap.caFile) };
    }
    opts.ca = [caCache.data];
  }
  try {
    const host = new URL(url).hostname;
    if (host && !/^[\d.]+$/.test(host) && !host.includes(':')) opts.servername = host;
  } catch { /* адрес проверит сам клиент */ }
  return opts;
}

let warnedPlain = false;

async function connect(url: string): Promise<Client> {
  const client = new Client({
    url,
    timeout: entConfig.ldap.timeoutMs,
    connectTimeout: entConfig.ldap.timeoutMs,
    tlsOptions: url.startsWith('ldaps:') ? tlsOptions(url) : undefined,
    strictDN: false,
  });
  if (entConfig.ldap.startTls && url.startsWith('ldap:')) {
    await client.startTLS(tlsOptions(url));
  } else if (url.startsWith('ldap:') && !warnedPlain) {
    const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
    if (host && host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      warnedPlain = true;
      logger.warn(`⚠ Каталог ${host} подключён без шифрования (ldap://): пароли сотрудников идут по сети открыто. Нужен ldaps:// или ENT_LDAP_STARTTLS=1`);
    }
  }
  return client;
}

function isConnectionProblem(e: unknown): boolean {
  if (e instanceof InvalidCredentialsError) return false;
  const code = (e as any)?.code;
  if (typeof code === 'number') {
    // 51 busy, 52 unavailable, 80 other — проблемы сервера, а не данных
    return code === 51 || code === 52 || code === 80;
  }
  return true; // ECONNREFUSED, таймауты, ошибки TLS
}

/**
 * Выполнить fn на соединении, привязанном служебной учёткой. Перебирает
 * адреса из ENT_LDAP_URL, пока один не ответит.
 */
async function withService<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const { bindDn, bindPassword } = entConfig.ldap;
  if (!bindDn || !bindPassword) {
    throw new DirectoryUnavailableError('не задана служебная учётка (ENT_LDAP_BIND_DN / ENT_LDAP_BIND_PASSWORD)');
  }
  let lastErr: unknown = null;
  for (const url of entConfig.ldap.urls) {
    let client: Client | null = null;
    try {
      client = await connect(url);
      await client.bind(bindDn, bindPassword);
    } catch (e) {
      try { await client?.unbind(); } catch { /* уже закрыт */ }
      if (e instanceof InvalidCredentialsError) {
        // Неверный пароль служебной учётки — другой контроллер не поможет
        throw new DirectoryUnavailableError('служебная учётка не принята каталогом (неверный DN или пароль)');
      }
      lastErr = e;
      continue;
    }
    try {
      return await fn(client);
    } catch (e) {
      if (isConnectionProblem(e)) { lastErr = e; continue; }
      throw e;
    } finally {
      try { await client.unbind(); } catch { /* уже закрыт */ }
    }
  }
  throw new DirectoryUnavailableError(describe(lastErr));
}

function describe(e: unknown): string {
  const code = (e as any)?.code;
  const msg = (e as any)?.message || String(e || 'нет ответа');
  if (code === 'ECONNREFUSED') return 'каталог не отвечает (соединение отклонено)';
  if (code === 'ETIMEDOUT' || /timeout|timed out/i.test(msg)) return 'каталог не ответил вовремя';
  if (code === 'ENOTFOUND') return 'адрес каталога не найден в DNS';
  if (/certificate|self.signed|CERT_|unable to verify/i.test(msg)) return `сертификат каталога не прошёл проверку: ${msg}`;
  return msg.slice(0, 200);
}

// ─────────────────────────────────────────────────────────────────────
// Разбор записи
// ─────────────────────────────────────────────────────────────────────

function attr(e: Entry, name: string): Buffer | Buffer[] | string[] | string | undefined {
  if (name in e) return e[name];
  const low = name.toLowerCase();
  for (const k of Object.keys(e)) if (k.toLowerCase() === low) return e[k];
  return undefined;
}

function str(e: Entry, name: string): string {
  const v = attr(e, name);
  if (v === undefined) return '';
  const first = Array.isArray(v) ? v[0] : v;
  if (first === undefined) return '';
  return Buffer.isBuffer(first) ? first.toString('utf8') : String(first);
}

function list(e: Entry, name: string): string[] {
  const v = attr(e, name);
  if (v === undefined) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.map(x => (Buffer.isBuffer(x) ? x.toString('utf8') : String(x))).filter(Boolean);
}

function toPerson(e: Entry): DirectoryPerson | null {
  const rawGuid = attr(e, 'objectGUID');
  const guid = guidToString(Array.isArray(rawGuid) ? (rawGuid[0] as Buffer | string) : (rawGuid as Buffer | string | undefined));
  const sam = str(e, 'sAMAccountName');
  if (!guid || !sam) return null;
  const computed = str(e, 'msDS-User-Account-Control-Computed');
  return {
    guid,
    dn: e.dn,
    sam,
    upn: str(e, 'userPrincipalName'),
    displayName: str(e, 'displayName') || str(e, 'cn') || sam,
    mail: str(e, 'mail'),
    department: str(e, 'department'),
    title: str(e, 'title'),
    uac: parseInt(str(e, 'userAccountControl') || '0', 10) || 0,
    uacComputed: computed !== '' && /^\d+$/.test(computed) ? parseInt(computed, 10) : null,
    lockoutTime: str(e, 'lockoutTime') || '0',
    accountExpires: str(e, 'accountExpires') || '0',
    memberOf: list(e, 'memberOf'),
    whenChanged: str(e, 'whenChanged'),
  };
}

async function search(c: Client, filter: string): Promise<DirectoryPerson[]> {
  const { searchEntries } = await c.search(entConfig.ldap.baseDn, {
    scope: 'sub',
    filter,
    attributes: ATTRIBUTES,
    explicitBufferAttributes: ['objectGUID'],
    paged: { pageSize: entConfig.ldap.pageSize },
  });
  const out: DirectoryPerson[] = [];
  for (const e of searchEntries) {
    const p = toPerson(e);
    if (p) out.push(p);
  }
  return out;
}

/** Все люди под базовым DN. Бросает DirectoryUnavailableError, если каталог не ответил. */
export async function listPeople(): Promise<DirectoryPerson[]> {
  if (!entConfig.ldap.baseDn) throw new DirectoryUnavailableError('не задан ENT_LDAP_BASE_DN');
  try {
    return await withService(c => search(c, entConfig.ldap.userFilter));
  } catch (e) {
    if (e instanceof DirectoryUnavailableError) throw e;
    throw new DirectoryUnavailableError(describe(e));
  }
}

/**
 * Разбор того, что человек ввёл в поле «имя»: ivanov, CORP\ivanov,
 * ivanov@corp.example. Возвращает null для явного мусора — такой логин
 * в каталог даже не отправляем.
 */
export function parseLogin(typed: string): { sam: string; upn: string | null } | null {
  let s = (typed || '').trim();
  if (!s || s.length > 256) return null;
  const bs = s.indexOf('\\');
  if (bs >= 0) s = s.slice(bs + 1); // CORP\ivanov → ivanov
  if (!s) return null;
  // Управляющие символы в логине не бывают — это либо ошибка, либо атака
  if (/[\u0000-\u001f\u007f]/.test(s)) return null;
  if (s.includes('@')) {
    return { sam: s.split('@')[0], upn: s };
  }
  return { sam: s, upn: null };
}

/** Найти сотрудника по логину служебной учёткой. null — такого нет. */
export async function findPerson(typed: string): Promise<DirectoryPerson | null> {
  const login = parseLogin(typed);
  if (!login || !entConfig.ldap.baseDn) return null;
  const terms = [`(sAMAccountName=${escapeFilterValue(login.sam)})`];
  if (login.upn) terms.push(`(userPrincipalName=${escapeFilterValue(login.upn)})`);
  const who = terms.length > 1 ? `(|${terms.join('')})` : terms[0];
  const filter = `(&${entConfig.ldap.userFilter}${who})`;
  let found: DirectoryPerson[];
  try {
    found = await withService(c => search(c, filter));
  } catch (e) {
    if (e instanceof DirectoryUnavailableError) throw e;
    throw new DirectoryUnavailableError(describe(e));
  }
  if (found.length === 0) return null;
  if (login.upn) {
    const byUpn = found.find(p => p.upn.toLowerCase() === login.upn!.toLowerCase());
    if (byUpn) return byUpn;
  }
  // Ровно один по sAMAccountName — иначе не угадываем
  const bySam = found.filter(p => p.sam.toLowerCase() === login.sam.toLowerCase());
  return bySam.length === 1 ? bySam[0] : null;
}

export type PasswordCheck =
  | { ok: true }
  | { ok: false; unavailable: false; adCode: string | null }
  | { ok: false; unavailable: true; message: string };

/**
 * Проверка пароля сотрудника: bind его DN его паролем.
 *
 * Пустой пароль отсекается ДО каталога: по RFC 4513 bind с DN и пустым
 * паролем — «неаутентифицированный», и AD (как и многие другие серверы)
 * отвечает на него УСПЕХОМ. Пропустить такой пароль — значит пустить
 * любого, кто знает чужой логин.
 */
export async function checkPassword(dn: string, password: string): Promise<PasswordCheck> {
  if (typeof password !== 'string' || password.length === 0 || !dn) {
    return { ok: false, unavailable: false, adCode: null };
  }
  let lastErr: unknown = null;
  for (const url of entConfig.ldap.urls) {
    let client: Client | null = null;
    try {
      client = await connect(url);
      await client.bind(dn, password);
      return { ok: true };
    } catch (e) {
      if (e instanceof InvalidCredentialsError) {
        // AD поясняет причину в тексте: «…AcceptSecurityContext error, data 52e…»
        const m = /\bdata\s+([0-9a-f]{3,4})\b/i.exec(e.message || '');
        return { ok: false, unavailable: false, adCode: m ? m[1].toLowerCase() : null };
      }
      lastErr = e;
    } finally {
      try { await client?.unbind(); } catch { /* уже закрыт */ }
    }
  }
  return { ok: false, unavailable: true, message: describe(lastErr) };
}

/** Что означает код AD из ответа на bind — когда его можно сказать человеку. */
export function adCodeReason(code: string | null): string | null {
  switch (code) {
    case '533': return 'Учётная запись отключена в домене';
    case '775': return 'Учётная запись заблокирована в домене после неверных паролей';
    case '701': return 'Срок действия учётной записи истёк';
    case '532': return 'Срок действия пароля истёк — смените пароль в домене';
    case '773': return 'Нужно сменить пароль в домене';
    case '530': return 'Вход в это время запрещён политикой домена';
    case '531': return 'Вход с этого компьютера запрещён политикой домена';
    default: return null;
  }
}
