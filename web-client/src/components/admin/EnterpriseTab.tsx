// Вкладка админки «Корпоративный контур» (только админ, только если
// контур включён на сервере). Сотрудники приходят из каталога (Active
// Directory) сами: кто в группе — тому учётка, отключили, заблокировали,
// истёк срок или убрали из группы в AD — учётка «схлопывается»
// (блокировка, выход со всех устройств, отзыв ключей). Здесь видно, в
// каком состоянии каталог и каждый сотрудник и что происходило — без
// похода на сервер по ssh.
import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Building2, Loader2, Search, X, Smartphone, AlertTriangle, FolderSync } from 'lucide-react';
import { enterpriseApi } from '@/lib/api';
import { toMs } from '@/lib/enterprise';

type P = { setBusy: (b: boolean) => void; setErr: (e: string | null) => void };

interface Status {
  enabled: boolean; auth?: string;
  directory?: { url?: string; base_dn?: string; group_dn?: string };
  last_sync_at?: string | number | null; last_sync_ok?: boolean | null; last_error?: string | null;
  next_sync_at?: string | number | null; interval_s?: number;
  counts?: { total: number; active: number; blocked: number };
}
interface Employee {
  id: string; username: string; display_name?: string; email?: string; department?: string; title?: string;
  directory_state?: string | null; blocked_at?: string | null; blocked_reason?: string | null;
  directory_synced_at?: string | number | null; devices?: number | unknown[];
}
interface Ev { at: string | number; kind: string; username?: string | null; detail?: string | null }
interface SyncResult { created: number; updated: number; blocked: number; unblocked: number; unchanged: number; took_ms: number }

// Состояние учётки в каталоге — цветной меткой
const STATE: Record<string, [string, string]> = {
  active: ['активна', 'bg-green-500/20 text-green-400'],
  disabled: ['отключена в AD', 'bg-red-500/20 text-red-400'],
  locked: ['заблокирована в AD', 'bg-orange-500/20 text-orange-300'],
  expired: ['срок истёк', 'bg-amber-500/20 text-amber-400'],
  not_in_group: ['нет в группе', 'bg-slate-500/25 text-slate-300'],
  removed: ['удалена из AD', 'bg-rose-900/50 text-rose-300'],
};
const AUTH: Record<string, string> = {
  ldap: 'пароль домена (LDAP)',
  radius: 'RADIUS',
  'ldap+radius': 'пароль домена + RADIUS',
};
const EVENT: Record<string, [string, string]> = {
  created: ['создана учётка', 'text-green-400'],
  updated: ['обновлены данные', 'text-messenger-text'],
  blocked: ['заблокирована', 'text-red-400'],
  unblocked: ['разблокирована', 'text-green-400'],
  login: ['вход', 'text-messenger-text'],
  login_failed: ['неудачный вход', 'text-amber-400'],
  device_issued: ['выдан сертификат устройства', 'text-primary-400'],
  device_revoked: ['отозван ключ устройства', 'text-red-400'],
  sync_ok: ['синхронизация', 'text-messenger-muted'],
  sync_error: ['ошибка синхронизации', 'text-red-400'],
};
// После этих событий таблица сотрудников уже не та — перечитываем
const CHANGES_USERS = new Set(['created', 'updated', 'blocked', 'unblocked', 'device_issued', 'device_revoked']);

const when = (x?: string | number | null) => {
  const t = toMs(x ?? null);
  return isFinite(t) ? new Date(t).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'medium' }) : '—';
};
const timeOnly = (x?: string | number | null) => {
  const t = toMs(x ?? null);
  return isFinite(t) ? new Date(t).toLocaleTimeString('ru-RU') : '—';
};
const list = <T,>(d: any, key: string): T[] => (Array.isArray(d) ? d : Array.isArray(d?.[key]) ? d[key] : []);
const evKey = (e: Ev) => `${e.at}|${e.kind}|${e.username || ''}|${e.detail || ''}`;
const devCount = (d: Employee['devices']) => (Array.isArray(d) ? d.length : Number(d) || 0);

function StateBadge({ s, synced }: { s?: string | null; synced?: string | number | null }) {
  const [label, cls] = s ? (STATE[s] || [s, 'bg-messenger-hover text-messenger-muted']) : ['локальная', 'bg-messenger-hover text-messenger-muted'];
  return (
    <span title={s ? `сверено с каталогом: ${when(synced)}` : 'учётка не из каталога (например, аварийный администратор)'}
          className={`text-[11px] px-1.5 py-0.5 rounded whitespace-nowrap ${cls}`}>{label}</span>
  );
}

export function EnterpriseTab({ setBusy, setErr }: P) {
  const [st, setSt] = useState<Status | null>(null);
  const [users, setUsers] = useState<Employee[] | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [pollErr, setPollErr] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [res, setRes] = useState<SyncResult | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'blocked'>('all');
  const [now, setNow] = useState(Date.now());
  const lastTop = useRef('');
  const lastCounts = useRef('');

  const loadUsers = async () => {
    try { setUsers(list<Employee>((await enterpriseApi.users()).data, 'users')); }
    catch (e: any) { setErr(`Сотрудники: ${e?.response?.data?.error || 'не загрузились'}`); }
  };

  // Состояние и лента — раз в 5 с, пока вкладка открыта. Таблицу
  // сотрудников перечитываем, только когда в ленте есть что-то, что её
  // меняет, или сдвинулись счётчики: на тысячах учёток — не каждые 5 с.
  const poll = async (first = false) => {
    if (!first && document.hidden) return;
    try {
      const [a, b] = await Promise.all([enterpriseApi.status(), enterpriseApi.events(100)]);
      const s: Status = a.data;
      const evs = list<Ev>(b.data, 'events').slice().sort((x, y) => (toMs(y.at) || 0) - (toMs(x.at) || 0));
      setSt(s);
      setEvents(evs);
      setPollErr(null);
      const counts = JSON.stringify(s?.counts || {});
      let changed = first || counts !== lastCounts.current;
      if (!changed && evs.length && evKey(evs[0]) !== lastTop.current) {
        const i = evs.findIndex(e => evKey(e) === lastTop.current);
        changed = (i < 0 ? evs : evs.slice(0, i)).some(e => CHANGES_USERS.has(e.kind));
      }
      lastTop.current = evs.length ? evKey(evs[0]) : '';
      lastCounts.current = counts;
      if (changed) await loadUsers();
      if (first) setErr(null);
    } catch (e: any) {
      const text = e?.response?.data?.error || (e?.response ? `ошибка ${e.response.status}` : 'нет связи с сервером');
      if (first) setErr(`Корпоративный контур: ${text}`);
      else setPollErr(text);
    }
  };
  const pollRef = useRef(poll);
  pollRef.current = poll;

  useEffect(() => {
    setBusy(true);
    pollRef.current(true).finally(() => setBusy(false));
    const t = setInterval(() => { pollRef.current(); }, 5000);
    const c = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(t); clearInterval(c); };
  }, []);

  const sync = async () => {
    setSyncing(true); setRes(null);
    try {
      setRes((await enterpriseApi.sync()).data);
      setErr(null);
      await poll();
      await loadUsers();
    } catch (e: any) {
      setErr(`Синхронизация: ${e?.response?.data?.error || e?.message || 'не получилось'}`);
      await poll();
    } finally { setSyncing(false); }
  };

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (users || []).filter(u => {
      if (filter === 'active' && (u.blocked_at || (u.directory_state && u.directory_state !== 'active'))) return false;
      if (filter === 'blocked' && !u.blocked_at) return false;
      if (!needle) return true;
      return [u.display_name, u.username, u.email, u.department, u.title]
        .some(v => String(v || '').toLowerCase().includes(needle));
    });
  }, [users, q, filter]);

  if (!st) return <div className="text-messenger-muted">Загрузка…</div>;

  if (!st.enabled) {
    return (
      <div className="p-3 rounded-xl bg-messenger-panel text-sm text-messenger-muted leading-relaxed">
        Корпоративный контур на сервере выключен: каталог не подключён (ENT_DIRECTORY пусто),
        мессенджер работает как обычно.
      </div>
    );
  }

  const nextMs = toMs(st.next_sync_at ?? null);
  const left = isFinite(nextMs) ? Math.max(0, Math.round((nextMs - now) / 1000)) : null;
  const never = !st.last_sync_at;
  const counts = st.counts || { total: 0, active: 0, blocked: 0 };

  return (
    <div className="space-y-4">
      {/* ── каталог ── */}
      <div className="p-3 rounded-xl bg-messenger-panel space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Building2 className="w-4 h-4 text-primary-400" />
          <span className="font-semibold">Каталог Active Directory</span>
          {never ? (
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-messenger-hover text-messenger-muted">ещё не сверялся</span>
          ) : st.last_sync_ok ? (
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400">на связи</span>
          ) : (
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400">ошибка</span>
          )}
          <button onClick={sync} disabled={syncing}
                  className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary-500 text-white text-sm disabled:opacity-50">
            {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <FolderSync className="w-4 h-4" />}
            Синхронизировать сейчас
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
          <div className="text-messenger-muted">Каталог: <span className="text-messenger-text font-mono break-all">{st.directory?.url || '—'}</span></div>
          <div className="text-messenger-muted">Способ входа: <span className="text-messenger-text">{AUTH[st.auth || ''] || st.auth || '—'}</span></div>
          <div className="text-messenger-muted sm:col-span-2">База поиска: <span className="text-messenger-text font-mono break-all">{st.directory?.base_dn || '—'}</span></div>
          <div className="text-messenger-muted sm:col-span-2">Группа доступа: <span className="text-messenger-text font-mono break-all">{st.directory?.group_dn || '—'}</span></div>
          <div className="text-messenger-muted">
            Последняя синхронизация: <span className="text-messenger-text">{when(st.last_sync_at)}</span>
            {!never && (st.last_sync_ok
              ? <span className="text-green-400"> · успешно</span>
              : <span className="text-red-400"> · не удалась</span>)}
          </div>
          <div className="text-messenger-muted">
            Следующая: <span className="text-messenger-text">
              {left === null ? '—' : left === 0 ? 'сейчас' : `через ${left} с`}
            </span>
            {st.interval_s ? <span> · каждые {st.interval_s} с</span> : null}
          </div>
        </div>

        {st.last_error && (
          <div className="p-2.5 rounded-lg bg-red-500/10 text-red-400 text-xs flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span className="break-words">{st.last_error}</span>
          </div>
        )}

        <div className="grid grid-cols-3 gap-2">
          {([['Сотрудников', counts.total, ''], ['Активных', counts.active, 'text-green-400'], ['Заблокировано', counts.blocked, counts.blocked ? 'text-red-400' : '']] as const)
            .map(([k, v, cls]) => (
              <div key={k} className="p-2.5 rounded-lg bg-messenger-bg">
                <div className="text-[11px] text-messenger-muted">{k}</div>
                <div className={`text-xl font-semibold ${cls}`}>{v ?? 0}</div>
              </div>
            ))}
        </div>

        {res && (
          <div className="text-xs text-green-400">
            Сверено за {res.took_ms} мс: создано {res.created} · обновлено {res.updated} · заблокировано {res.blocked}
            {' '}· разблокировано {res.unblocked} · без изменений {res.unchanged}
          </div>
        )}
      </div>

      {/* ── сотрудники ── */}
      <div className="space-y-2">
        <div className="flex gap-2 items-center flex-wrap">
          <div className="flex-1 min-w-[180px] flex items-center gap-2 px-3 py-2 rounded-lg bg-messenger-panel">
            <Search className="w-4 h-4 text-messenger-muted" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Имя, логин, отдел, должность"
                   className="flex-1 bg-transparent outline-none text-sm" />
            {q && <button onClick={() => setQ('')} className="p-0.5 text-messenger-muted"><X className="w-4 h-4" /></button>}
          </div>
          {([['all', 'Все'], ['active', 'Активные'], ['blocked', 'Заблокированные']] as const).map(([id, label]) => (
            <button key={id} onClick={() => setFilter(id)}
                    className={`px-2.5 py-1 rounded-full text-xs whitespace-nowrap ${filter === id ? 'bg-primary-500 text-white' : 'bg-messenger-hover'}`}>
              {label}
            </button>
          ))}
          <button onClick={loadUsers} className="flex items-center gap-1 text-sm text-primary-400" title="Перечитать список">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
        <div className="text-xs text-messenger-muted">показано {shown.length} из {users?.length ?? 0}</div>

        <div className="overflow-x-auto rounded-xl bg-messenger-panel">
          <table className="w-full text-sm min-w-[820px]">
            <thead>
              <tr className="text-left text-xs text-messenger-muted">
                <th className="px-3 py-2 font-normal">Сотрудник</th>
                <th className="px-3 py-2 font-normal">Логин</th>
                <th className="px-3 py-2 font-normal">Отдел</th>
                <th className="px-3 py-2 font-normal">Должность</th>
                <th className="px-3 py-2 font-normal">В каталоге</th>
                <th className="px-3 py-2 font-normal">Блокировка</th>
                <th className="px-3 py-2 font-normal text-right" title="Устройства с сертификатом УЦ">
                  <Smartphone className="w-3.5 h-3.5 inline" />
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map(u => (
                <tr key={u.id} className={`border-t border-messenger-border align-top ${u.blocked_at ? 'bg-red-500/[0.04]' : ''}`}>
                  <td className="px-3 py-2">
                    <div className="font-medium">{u.display_name || u.username}</div>
                    {u.email && <div className="text-[11px] text-messenger-muted break-all">{u.email}</div>}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{u.username}</td>
                  <td className="px-3 py-2 text-xs">{u.department || '—'}</td>
                  <td className="px-3 py-2 text-xs">{u.title || '—'}</td>
                  <td className="px-3 py-2"><StateBadge s={u.directory_state} synced={u.directory_synced_at} /></td>
                  <td className="px-3 py-2 text-xs">
                    {u.blocked_at ? (
                      <>
                        <div className="text-red-400">с {when(u.blocked_at)}</div>
                        {u.blocked_reason && <div className="text-messenger-muted break-words">{u.blocked_reason}</div>}
                      </>
                    ) : <span className="text-messenger-muted">—</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{devCount(u.devices)}</td>
                </tr>
              ))}
              {users && shown.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-6 text-center text-messenger-muted">
                  {users.length ? 'Никого не нашлось.' : 'Из каталога пока никого — проверьте группу доступа и синхронизируйте.'}
                </td></tr>
              )}
              {!users && (
                <tr><td colSpan={7} className="px-3 py-6 text-center text-messenger-muted">Загрузка…</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── лента событий ── */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">События</span>
          <span className={`w-1.5 h-1.5 rounded-full ${pollErr ? 'bg-red-400' : 'bg-green-400 animate-pulse'}`} />
          <span className="text-xs text-messenger-muted">
            {pollErr ? `не обновляется: ${pollErr}` : 'обновляется каждые 5 с'}
          </span>
          <span className="ml-auto text-xs text-messenger-muted">записей: {events.length}</span>
        </div>
        {events.length === 0 && <div className="text-sm text-messenger-muted">Пока пусто.</div>}
        <div className="space-y-1">
          {events.map((e, i) => {
            const [label, cls] = EVENT[e.kind] || [e.kind, 'text-messenger-text'];
            return (
              <div key={`${evKey(e)}#${i}`} className="px-2.5 py-1.5 rounded-lg bg-messenger-panel text-sm flex flex-wrap gap-x-2 items-baseline">
                <span className="text-xs text-messenger-muted tabular-nums" title={when(e.at)}>{timeOnly(e.at)}</span>
                <span className={cls}>{label}</span>
                {e.username && <span className="text-messenger-muted">@{e.username}</span>}
                {e.detail && <span className="text-[12px] text-messenger-muted break-words min-w-0">{e.detail}</span>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
