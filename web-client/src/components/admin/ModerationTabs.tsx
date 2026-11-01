// Вкладки админки: «Жалобы» (модератор и админ) и «Хранилище» (админ).
// Правило владельца: чужую переписку не листаем — жалоба открывает ровно
// одно сообщение, хранилище показывает сведения о файлах, а не содержимое.
// Каждый просмотр, скачивание и удаление сервер пишет в журнал.
import { useEffect, useState } from 'react';
import { RefreshCw, Trash2, Ban, Download, Check, Flag, HardDrive } from 'lucide-react';
import { moderationApi } from '@/lib/api';
import { getBaseUrl } from '@/lib/connection';
import { useAuthStore } from '@/store/auth';
import { formatBytes } from '@/lib/format';

type P = { setBusy: (b: boolean) => void; setErr: (e: string | null) => void };

const REASON: Record<string, string> = {
  illegal: 'Противозаконное', violence: 'Насилие, угрозы', extremism: 'Экстремизм', drugs: 'Наркотики',
  csam: 'Вред детям', porn: 'Порнография', fraud: 'Мошенничество', spam: 'Спам', other: 'Другое',
};
const GROUP: Record<string, string> = {
  image: 'Фото', video: 'Видео', audio: 'Аудио', document: 'Документы', archive: 'Архивы', app: 'Программы', other: 'Прочее',
};
const fmtDate = (s?: string) => (s ? new Date(s).toLocaleString('ru-RU') : '');

/** Скачивание через сервер: он пишет в журнал и отдаёт ссылку. */
async function downloadFile(id: string, setErr: P['setErr']) {
  try {
    const { url, name } = (await moderationApi.fileDownload(id)).data;
    const token = useAuthStore.getState().accessToken;
    const a = document.createElement('a');
    a.href = `${getBaseUrl()}${url}?token=${encodeURIComponent(token || '')}`;
    a.download = name || 'file';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (e: any) {
    setErr(`Скачать: ${e?.response?.data?.error || 'не вышло'}`);
  }
}

export function ReportsTab({ setBusy, setErr }: P) {
  const [status, setStatus] = useState<'open' | 'closed'>('open');
  const [rows, setRows] = useState<any[]>([]);
  const [open, setOpen] = useState<any | null>(null);
  const [note, setNote] = useState('');

  const load = async (st = status) => {
    setBusy(true);
    try { setRows((await moderationApi.reports(st)).data.reports || []); setErr(null); }
    catch (e: any) { setErr(`Жалобы: ${e?.response?.data?.error || 'не загрузились'}`); }
    finally { setBusy(false); }
  };
  useEffect(() => { load(); }, []);

  const view = async (id: string) => {
    setBusy(true);
    try { setOpen((await moderationApi.report(id)).data); setNote(''); }
    catch (e: any) { setErr(`Жалоба: ${e?.response?.data?.error || 'не открылась'}`); }
    finally { setBusy(false); }
  };

  const act = async (action: 'dismiss' | 'delete' | 'block' | 'delete_block') => {
    if (!open) return;
    const ask: Record<string, string> = {
      delete: 'Удалить сообщение и все его файлы?',
      block: 'Заблокировать автора? Все его сессии будут сброшены.',
      delete_block: 'Удалить сообщение с файлами И заблокировать автора?',
      dismiss: 'Отклонить жалобу — нарушения нет?',
    };
    if (!window.confirm(ask[action])) return;
    setBusy(true);
    try {
      await moderationApi.resolve(open.report.id, action, note || undefined);
      setOpen(null);
      await load();
    } catch (e: any) {
      setErr(`Решение: ${e?.response?.data?.error || 'не применилось'}`);
    } finally { setBusy(false); }
  };

  if (open) {
    const m = open.message;
    return (
      <div className="space-y-3">
        <button onClick={() => setOpen(null)} className="text-sm text-primary-400">← К списку</button>
        <div className="p-3 rounded-xl bg-messenger-panel space-y-1.5 text-sm">
          <div><b>{REASON[open.report.reason] || open.report.reason}</b> · {fmtDate(open.report.created_at)}</div>
          {open.report.comment && <div className="text-messenger-muted">«{open.report.comment}»</div>}
        </div>
        <div className="p-3 rounded-xl bg-messenger-panel space-y-2">
          <div className="text-xs text-messenger-muted">Сообщение от <b>{m?.sender_username || '?'}</b> · {fmtDate(m?.created_at)} {m?.deleted_at && '· уже удалено'}</div>
          {m?.encrypted
            ? <div className="text-sm text-messenger-muted">Сообщение зашифровано сквозным шифрованием — текст серверу не виден.</div>
            : <div className="text-[15px] whitespace-pre-wrap break-words">{m?.content || <span className="text-messenger-muted">(без текста)</span>}</div>}
          {open.files?.map((f: any) => (
            <div key={f.id} className="flex items-center gap-2 text-sm bg-messenger-hover/50 rounded-lg px-2 py-1.5">
              <span className="flex-1 truncate">{f.missing ? 'файл уже удалён' : `${f.name} · ${f.mime || '?'} · ${formatBytes(f.size)}`}</span>
              {!f.missing && (
                <button onClick={() => downloadFile(f.id, setErr)} className="text-primary-400" title="Скачать"><Download size={16} /></button>
              )}
            </div>
          ))}
        </div>
        {open.report.status === 'open' && (
          <>
            <input value={note} onChange={e => setNote(e.target.value)} placeholder="Причина решения (в журнал и автору при блокировке)"
                   className="w-full rounded-lg bg-messenger-hover/60 px-3 py-2 text-sm outline-none" />
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => act('delete')} className="py-2 rounded-xl bg-red-500/80 text-white text-sm flex items-center justify-center gap-1.5"><Trash2 size={15} /> Удалить</button>
              <button onClick={() => act('delete_block')} className="py-2 rounded-xl bg-red-600 text-white text-sm flex items-center justify-center gap-1.5"><Ban size={15} /> Удалить + бан</button>
              <button onClick={() => act('block')} className="py-2 rounded-xl bg-orange-500 text-white text-sm flex items-center justify-center gap-1.5"><Ban size={15} /> Только бан</button>
              <button onClick={() => act('dismiss')} className="py-2 rounded-xl bg-messenger-hover text-sm flex items-center justify-center gap-1.5"><Check size={15} /> Нарушения нет</button>
            </div>
          </>
        )}
        {open.report.status !== 'open' && <div className="text-sm text-messenger-muted">Решено: {open.report.resolution}</div>}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {([['open', 'Открытые'], ['closed', 'Решённые']] as const).map(([id, label]) => (
          <button key={id} onClick={() => { setStatus(id); load(id); }}
                  className={`px-2.5 py-1 rounded-full text-xs ${status === id ? 'bg-primary-500 text-white' : 'bg-messenger-hover'}`}>{label}</button>
        ))}
        <button onClick={() => load()} className="ml-auto flex items-center gap-1.5 text-sm text-primary-400"><RefreshCw className="w-4 h-4" /> Обновить</button>
      </div>
      {rows.length === 0 && <div className="text-sm text-messenger-muted py-6 text-center">Жалоб нет.</div>}
      {rows.map(r => (
        <button key={r.id} onClick={() => view(r.id)} className="w-full text-left p-3 rounded-xl bg-messenger-panel space-y-1 hover:bg-messenger-hover">
          <div className="flex items-center gap-2">
            <Flag size={14} className="text-orange-400" />
            <span className="font-semibold">{REASON[r.reason] || r.reason}</span>
            {r.reports_on_message > 1 && <span className="text-xs px-1.5 rounded bg-orange-500/20 text-orange-300">×{r.reports_on_message}</span>}
            <span className="ml-auto text-xs text-messenger-muted">{fmtDate(r.created_at)}</span>
          </div>
          <div className="text-xs text-messenger-muted">
            на <b>{r.reported_username || '?'}</b>{r.reported_blocked_at ? ' (заблокирован)' : ''} · от {r.reporter_username || '?'}
            {r.handled_by_name && ` · решил ${r.handled_by_name}`}
          </div>
          {r.comment && <div className="text-xs truncate">«{r.comment}»</div>}
        </button>
      ))}
    </div>
  );
}

export function StorageTab({ setBusy, setErr }: P) {
  const [sum, setSum] = useState<any | null>(null);
  const [files, setFiles] = useState<any[]>([]);
  const [sort, setSort] = useState<'size' | 'date'>('size');
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const [user, setUser] = useState<{ id: string; name: string } | null>(null);

  const loadFiles = async (o: { sort?: 'size' | 'date'; type?: string; q?: string; user?: string } = {}) => {
    setBusy(true);
    try {
      const r = await moderationApi.storageFiles({ sort: o.sort ?? sort, type: o.type ?? type, q: (o.q ?? q) || undefined,
                                                   user: o.user ?? user?.id, limit: 200 });
      setFiles(r.data.files || []);
      setErr(null);
    } catch (e: any) { setErr(`Файлы: ${e?.response?.data?.error || 'не загрузились'}`); }
    finally { setBusy(false); }
  };
  const load = async () => {
    try { setSum((await moderationApi.storageSummary()).data); } catch (e: any) { setErr(`Хранилище: ${e?.response?.data?.error || 'не загрузилось'}`); }
    await loadFiles();
  };
  useEffect(() => { load(); }, []);

  const del = async (f: any) => {
    if (!window.confirm(`Удалить «${f.name}» (${formatBytes(f.size)})? Сообщения с ним исчезнут из чатов. Это необратимо.`)) return;
    setBusy(true);
    try { await moderationApi.fileDelete(f.id); setFiles(list => list.filter(x => x.id !== f.id)); }
    catch (e: any) { setErr(`Удалить: ${e?.response?.data?.error || 'не вышло'}`); }
    finally { setBusy(false); }
  };

  const total = sum?.bytes || 0;
  return (
    <div className="space-y-3">
      {sum && (
        <div className="p-3 rounded-xl bg-messenger-panel space-y-2">
          <div className="flex items-center gap-2">
            <HardDrive size={16} className="text-primary-400" />
            <b>{formatBytes(total)}</b> в {sum.files} файлах
            {sum.disk && <span className="ml-auto text-xs text-messenger-muted">диск: свободно {formatBytes(sum.disk.free)} из {formatBytes(sum.disk.total)}</span>}
          </div>
          {sum.disk && (
            <div className="h-2 rounded bg-messenger-hover overflow-hidden">
              <div className="h-full bg-primary-500" style={{ width: `${Math.min(100, 100 * (1 - sum.disk.free / sum.disk.total))}%` }} />
            </div>
          )}
          {sum.on_fallback && <div className="text-xs text-red-400">Основной диск недоступен — запись идёт в запасной каталог</div>}
          <div className="grid grid-cols-2 gap-1 text-xs">
            {Object.entries(sum.by_type as Record<string, { count: number; bytes: number }>)
              .sort((a, b) => b[1].bytes - a[1].bytes)
              .map(([g, v]) => (
                <button key={g} onClick={() => { const t = type === g ? '' : g; setType(t); loadFiles({ type: t }); }}
                        className={`flex justify-between px-2 py-1 rounded ${type === g ? 'bg-primary-500/30' : 'bg-messenger-hover/50'}`}>
                  <span>{GROUP[g] || g} · {v.count}</span><span>{formatBytes(v.bytes)} ({total ? Math.round(100 * v.bytes / total) : 0}%)</span>
                </button>
              ))}
          </div>
          <div className="text-xs text-messenger-muted pt-1">Больше всех занимают:</div>
          <div className="flex flex-wrap gap-1">
            {(sum.by_user as any[]).slice(0, 12).map(u => (
              <button key={u.user_id} onClick={() => { const nu = user?.id === u.user_id ? null : { id: u.user_id, name: u.username }; setUser(nu); loadFiles({ user: nu?.id || '' }); }}
                      className={`text-xs px-2 py-0.5 rounded-full ${user?.id === u.user_id ? 'bg-primary-500 text-white' : 'bg-messenger-hover'}`}>
                {u.username || '?'} · {formatBytes(u.bytes)}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        {([['size', 'По весу'], ['date', 'По дате']] as const).map(([id, label]) => (
          <button key={id} onClick={() => { setSort(id); loadFiles({ sort: id }); }}
                  className={`px-2.5 py-1 rounded-full text-xs ${sort === id ? 'bg-primary-500 text-white' : 'bg-messenger-hover'}`}>{label}</button>
        ))}
        <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && loadFiles()}
               placeholder="Имя файла…" className="flex-1 min-w-[120px] rounded-lg bg-messenger-hover/60 px-2 py-1 text-sm outline-none" />
        <button onClick={load} className="flex items-center gap-1 text-sm text-primary-400"><RefreshCw className="w-4 h-4" /></button>
      </div>
      {(type || user) && (
        <div className="text-xs text-messenger-muted">Фильтр: {type && (GROUP[type] || type)} {user && `· ${user.name}`}</div>
      )}

      {files.length === 0 && <div className="text-sm text-messenger-muted py-6 text-center">Файлов нет.</div>}
      {files.map(f => (
        <div key={f.id} className="flex items-center gap-2 p-2 rounded-xl bg-messenger-panel text-sm">
          <div className="flex-1 min-w-0">
            <div className="truncate">{f.name}</div>
            <div className="text-xs text-messenger-muted truncate">
              {formatBytes(f.size)} · {GROUP[f.group] || f.group} ({f.mime || '?'}) · {f.uploader || '?'} · {fmtDate(f.created_at)}
            </div>
          </div>
          <button onClick={() => downloadFile(f.id, setErr)} className="p-1.5 text-primary-400" title="Скачать (в журнал)"><Download size={16} /></button>
          <button onClick={() => del(f)} className="p-1.5 text-red-400" title="Удалить"><Trash2 size={16} /></button>
        </div>
      ))}
    </div>
  );
}
