// =============================================================================
// Корпоративный контур — синхронизация с каталогом.
//
// Раз в ENT_SYNC_INTERVAL_S: прочитать всех людей под базовым DN, создать
// учётки новым сотрудникам, обновить поля, схлопнуть ушедших, вернуть
// вернувшихся.
//
// ЗАЩИТА ОТ МАССОВОЙ ОШИБКИ. Самое опасное, что может сделать такая
// синхронизация, — разом заблокировать всю компанию, потому что каталог
// моргнул: перезагрузка контроллера, истёкший пароль служебной учётки,
// кто-то сузил права на OU или очистил группу. Поэтому ничего НЕ
// применяется, если:
//   • каталог не ответил или ответил ошибкой;
//   • вернул 0 записей;
//   • вернул меньше ENT_SYNC_MIN_RATIO (половины) от прошлого раза;
//   • за один проход пришлось бы заблокировать больше половины действующих
//     учёток (и больше трёх человек).
// Ошибка видна в /api/enterprise/status и журнале событий. Если сокращение
// настоящее — администратор подтверждает его принудительной синхронизацией.
// =============================================================================

import { logger } from '../utils/logger.js';
import { entConfig, publicDirectoryUrl } from './config.js';
import { addEvent, getState, setState } from './store.js';
import { listPeople, DirectoryPerson, stateOf } from './directory.js';
import { applyPerson, applyRemoved, directoryUsers } from './accounts.js';

export interface SyncResult {
  created: number;
  updated: number;
  blocked: number;
  unblocked: number;
  unchanged: number;
  took_ms: number;
  ok: boolean;
  error?: string;
}

let running: Promise<SyncResult> | null = null;
let timer: NodeJS.Timeout | null = null;
let nextSyncAt: string | null = null;
let stopped = false;

export function getNextSyncAt(): string | null {
  return nextSyncAt;
}

function emptyResult(t0: number): SyncResult {
  return { created: 0, updated: 0, blocked: 0, unblocked: 0, unchanged: 0, took_ms: Date.now() - t0, ok: true };
}

function fail(t0: number, message: string, announce: boolean): SyncResult {
  const prevOk = getState('last_sync_ok');
  const prevErr = getState('last_error');
  setState('last_sync_at', new Date().toISOString());
  setState('last_sync_ok', 0);
  setState('last_error', message);
  // В журнал — при первой ошибке и при смене текста, а не каждые 10 секунд
  if (announce || prevOk !== '0' || prevErr !== message) {
    addEvent('sync_error', null, message);
    logger.warn(`⚠ Синхронизация с каталогом не применена: ${message}`);
  }
  return { ...emptyResult(t0), ok: false, error: message };
}

async function doSync(force: boolean, manual: boolean): Promise<SyncResult> {
  const t0 = Date.now();

  let people: DirectoryPerson[];
  try {
    people = await listPeople();
  } catch (e) {
    return fail(t0, `каталог недоступен: ${(e as Error).message}`, manual);
  }

  // Один объект — одна запись (дубли бывают при кривых ссылках в выдаче)
  const byGuid = new Map<string, DirectoryPerson>();
  for (const p of people) if (!byGuid.has(p.guid)) byGuid.set(p.guid, p);
  const found = byGuid.size;

  const known = directoryUsers();
  const knownAlive = known.filter(u => u.directory_state !== 'removed').length;
  const prevCount = parseInt(getState('last_ok_count') || '0', 10) || knownAlive;

  if (!force) {
    if (found === 0) {
      return fail(t0, 'каталог вернул 0 сотрудников — похоже на ошибку каталога или прав служебной учётки; никто не заблокирован', manual);
    }
    if (prevCount > 0 && found < prevCount * entConfig.minRatio) {
      return fail(t0, `каталог вернул ${found} записей против ${prevCount} в прошлый раз — похоже на ошибку каталога; никто не заблокирован`, manual);
    }
    // Сколько действующих учёток этот проход заблокировал бы
    const activeNow = known.filter(u => !u.blocked_at);
    let wouldBlock = 0;
    for (const u of activeNow) {
      const p = u.directory_guid ? byGuid.get(u.directory_guid) : undefined;
      if (!p || stateOf(p) !== 'active') wouldBlock++;
    }
    if (wouldBlock > 3 && wouldBlock > activeNow.length * entConfig.maxBlockRatio) {
      return fail(t0, `проход заблокировал бы ${wouldBlock} из ${activeNow.length} действующих учёток — похоже на ошибку (очищена группа, сужены права?); ничего не применено. Если сокращение настоящее — запустите синхронизацию принудительно`, manual);
    }
  }

  const r = emptyResult(t0);
  for (const p of byGuid.values()) {
    try {
      const { outcome } = applyPerson(p);
      if (outcome !== 'skipped') r[outcome]++;
    } catch (e) {
      logger.error(`Синхронизация: не удалось применить ${p.sam}`, e);
    }
  }
  for (const u of known) {
    if (!u.directory_guid || byGuid.has(u.directory_guid)) continue;
    try {
      const outcome = applyRemoved(u);
      if (outcome !== 'skipped') r[outcome]++;
    } catch (e) {
      logger.error(`Синхронизация: не удалось схлопнуть ${u.username}`, e);
    }
  }

  r.took_ms = Date.now() - t0;
  const prevOk = getState('last_sync_ok');
  setState('last_sync_at', new Date().toISOString());
  setState('last_sync_ok', 1);
  setState('last_error', null);
  setState('last_ok_count', found);

  const changed = r.created + r.updated + r.blocked + r.unblocked;
  if (changed || manual || force || prevOk !== '1') {
    const parts = [
      `записей в каталоге ${found}`,
      r.created && `создано ${r.created}`,
      r.updated && `обновлено ${r.updated}`,
      r.blocked && `схлопнуто ${r.blocked}`,
      r.unblocked && `восстановлено ${r.unblocked}`,
      force && 'принудительно',
    ].filter(Boolean);
    addEvent('sync_ok', null, `${parts.join(', ')} · ${r.took_ms} мс`);
  }
  if (changed) {
    logger.info(`🔄 Каталог: +${r.created} ~${r.updated} ↓${r.blocked} ↑${r.unblocked} =${r.unchanged} за ${r.took_ms} мс`);
  }
  return r;
}

/**
 * Синхронизация. Параллельно не идут: ручной запуск во время плановой
 * дожидается её и делает свою — иначе вернул бы результат, снятый до
 * изменения, ради которого администратор нажал кнопку.
 */
export async function runSync(opts: { force?: boolean; manual?: boolean } = {}): Promise<SyncResult> {
  if (!entConfig.enabled) {
    return { created: 0, updated: 0, blocked: 0, unblocked: 0, unchanged: 0, took_ms: 0, ok: false, error: 'корпоративный контур выключен' };
  }
  while (running) {
    if (!opts.manual) return running;
    try { await running; } catch { /* своя попытка ниже */ }
  }
  const p = doSync(!!opts.force, !!opts.manual);
  running = p;
  try {
    return await p;
  } catch (e) {
    const t0 = Date.now();
    logger.error('Синхронизация с каталогом упала', e);
    return fail(t0, `внутренняя ошибка: ${(e as Error).message}`, true);
  } finally {
    running = null;
  }
}

function schedule(delayMs: number): void {
  if (stopped) return;
  if (timer) clearTimeout(timer);
  nextSyncAt = new Date(Date.now() + delayMs).toISOString();
  timer = setTimeout(async () => {
    timer = null;
    try {
      await runSync();
    } catch (e) {
      logger.error('Плановая синхронизация с каталогом', e);
    }
    schedule(entConfig.syncIntervalS * 1000);
  }, delayMs);
  timer.unref?.();
}

export function startSyncLoop(): void {
  if (!entConfig.enabled) return;
  stopped = false;
  logger.info(`🏢 Корпоративный контур: каталог ${publicDirectoryUrl()}, база ${entConfig.ldap.baseDn || '—'}, ` +
    `группа ${entConfig.ldap.groupDn || '—'}, вход: ${entConfig.auth}, синхронизация раз в ${entConfig.syncIntervalS} с`);
  if (!entConfig.ldap.groupDn) {
    logger.warn('⚠ Не задан ENT_LDAP_GROUP_DN — учётки не получит никто (все будут not_in_group)');
  }
  schedule(1500);
}

export function stopSyncLoop(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
  nextSyncAt = null;
}
