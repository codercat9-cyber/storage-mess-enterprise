// =============================================================================
// Корпоративный контур — настройки из окружения (server/.env).
//
// ENT_DIRECTORY пустой — контура нет вовсе, мессенджер работает как обычно:
// никаких запросов в каталог, вход только по локальным паролям.
//
// Секреты (пароль служебной учётки, секрет RADIUS) живут только здесь, в
// памяти процесса. В журналы, ответы API и события они не попадают ни в
// каком виде — даже «звёздочками» с длиной.
// =============================================================================

import path from 'path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

export type EntAuth = 'ldap' | 'radius' | 'ldap+radius';

function num(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    logger.warn(`Корпоративный контур: ${name}=«${raw}» не число, беру ${def}`);
    return def;
  }
  return Math.min(max, Math.max(min, v));
}

function parseAuth(raw: string | undefined): EntAuth {
  const v = (raw || 'ldap').trim().toLowerCase();
  if (v === 'ldap' || v === 'radius' || v === 'ldap+radius') return v;
  logger.warn(`Корпоративный контур: ENT_AUTH=«${raw}» не понят, вход по паролю домена (ldap)`);
  return 'ldap';
}

const dataDir = path.dirname(path.resolve(config.database.url));

export const entConfig = {
  enabled: (process.env.ENT_DIRECTORY || '').trim().toLowerCase() === 'ldap',

  ldap: {
    // Можно несколько адресов через запятую — второй контроллер домена
    // берётся, если первый не отвечает.
    urls: (process.env.ENT_LDAP_URL || 'ldap://127.0.0.1:389')
      .split(/[\s,]+/).map(s => s.trim()).filter(Boolean),
    caFile: process.env.ENT_LDAP_CA_FILE || '',
    // Проверка сертификата контроллера включена по умолчанию. Отключать
    // можно только осознанно и только на стенде.
    tlsInsecure: process.env.ENT_LDAP_TLS_INSECURE === '1',
    startTls: process.env.ENT_LDAP_STARTTLS === '1',
    bindDn: process.env.ENT_LDAP_BIND_DN || '',
    bindPassword: process.env.ENT_LDAP_BIND_PASSWORD || '',
    baseDn: process.env.ENT_LDAP_BASE_DN || '',
    groupDn: process.env.ENT_LDAP_GROUP_DN || '',
    adminGroupDn: process.env.ENT_LDAP_ADMIN_GROUP_DN || '',
    // Люди, а не компьютеры: у AD компьютер — тоже objectClass=user.
    userFilter: process.env.ENT_LDAP_USER_FILTER
      || '(&(|(objectCategory=person)(objectClass=user))(!(objectClass=computer)))',
    pageSize: num('ENT_LDAP_PAGE_SIZE', 500, 1, 1000),
    timeoutMs: num('ENT_LDAP_TIMEOUT_MS', 5000, 500, 60000),
  },

  domain: process.env.ENT_DOMAIN || '',
  syncIntervalS: num('ENT_SYNC_INTERVAL_S', 60, 5, 86400),

  auth: parseAuth(process.env.ENT_AUTH),
  radius: {
    host: process.env.ENT_RADIUS_HOST || '127.0.0.1',
    port: num('ENT_RADIUS_PORT', 1812, 1, 65535),
    secret: process.env.ENT_RADIUS_SECRET || '',
    timeoutMs: num('ENT_RADIUS_TIMEOUT_MS', 3000, 200, 30000),
    nasIdentifier: process.env.ENT_RADIUS_NAS_ID || 'storage-mess',
  },

  // Защита от массовой ошибки: если каталог вдруг вернул меньше этой доли
  // от прошлого раза — ничего не применяем.
  minRatio: num('ENT_SYNC_MIN_RATIO', 0.5, 0, 1),
  // И если за один проход пришлось бы заблокировать больше этой доли
  // действующих учёток (и больше трёх человек) — тоже стоп.
  maxBlockRatio: num('ENT_SYNC_MAX_BLOCK_RATIO', 0.5, 0, 1),

  // Сертификаты устройств
  caKeyFile: process.env.ENT_CA_KEY_FILE || path.join(dataDir, 'enterprise-ca.key'),
  certTtlDays: num('ENT_CERT_TTL_DAYS', 90, 1, 3650),
  maxDevicesPerUser: num('ENT_MAX_DEVICES', 20, 1, 1000),

  // Аварийный локальный администратор — на случай, когда домен лежит.
  // В .env только bcrypt-хеш, сам пароль хранится у людей.
  breakglass: {
    username: (process.env.ENT_BREAKGLASS_ADMIN || '').trim().toLowerCase(),
    hash: (process.env.ENT_BREAKGLASS_HASH || '').trim(),
  },

  // Самостоятельная регистрация в корпоративном контуре закрыта: учётки
  // создаёт каталог. Открыть можно явно.
  allowRegistration: process.env.ENT_ALLOW_REGISTRATION === '1',
};

/** Короткое имя группы для сообщений: «Messenger Users» из CN=Messenger Users,OU=… */
export function groupLabel(dn: string): string {
  const m = /^\s*CN=((?:\\.|[^,])+)/i.exec(dn);
  return m ? m[1].replace(/\\(.)/g, '$1') : dn;
}

/** Адрес каталога для показа админу: без логина и пароля, если их вписали в URL. */
export function publicDirectoryUrl(): string {
  return entConfig.ldap.urls.map(u => u.replace(/\/\/[^@/]*@/, '//')).join(', ');
}

export function loginHint(): string {
  const d = entConfig.domain;
  const how = entConfig.auth === 'radius'
    ? 'паролем или одноразовым кодом RADIUS'
    : entConfig.auth === 'ldap+radius'
      ? 'паролем домена (вход подтверждает и RADIUS)'
      : 'паролем домена';
  return d
    ? `Войдите учётной записью домена ${d}: имя (ivanov, ${d}\\ivanov или ivanov@…) и ${how}.`
    : `Войдите учётной записью домена и ${how}.`;
}
