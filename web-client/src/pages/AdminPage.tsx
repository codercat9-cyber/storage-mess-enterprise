// =============================================================================
// Админ-панель.
//
// Правило, заданное владельцем и отражённое здесь: администратор
// управляет людьми и сервером, но НЕ листает чужую переписку. Поэтому в
// интерфейсе нет ни списка чатов, ни поиска по сообщениям — только
// открытие конкретного сообщения по идентификатору из жалобы. Каждый
// такой просмотр попадает в журнал, который виден на отдельной вкладке.
// =============================================================================

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Users, Activity, ScrollText, Megaphone, Search,
  ShieldOff, ShieldCheck, KeyRound, LogOut, Trash2, RefreshCw, Loader2, Server, Ban,
  X, Copy, FileSearch, AlertTriangle, AtSign, Pencil, LifeBuoy, MessageSquare, Flag, HardDrive, Building2,
} from 'lucide-react';
import { ReportsTab, StorageTab } from '@/components/admin/ModerationTabs';
import { EnterpriseTab } from '@/components/admin/EnterpriseTab';
import { adminApi } from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { useEnterprise, refreshEnterpriseInfo } from '@/lib/enterprise';

type Tab = 'stats' | 'users' | 'enterprise' | 'reports' | 'support' | 'server' | 'audit' | 'broadcast' | 'chats' | 'storage';

// ─────────────────────────────────────────────────────────────────────────
// Диалог вместо window.prompt/confirm.
//
// Раньше блокировка спрашивала причину через window.prompt, а сброс пароля —
// через него же. В Android WebView это системное окошко: крошечное поле без
// подсказок, без проверки ввода, без возможности отменить осмысленно, и на
// части прошивок оно просто не появляется. Отсюда «все поля неудобные».
// Здесь обычная форма: видно, кого меняем, что произойдёт и почему кнопка
// недоступна.
// ─────────────────────────────────────────────────────────────────────────
interface AskField {
  label: string;
  placeholder?: string;
  type?: 'text' | 'password' | 'textarea';
  required?: boolean;
  minLength?: number;
  hint?: string;
}

interface AskSpec {
  title: string;
  description?: string;
  field?: AskField;
  confirmLabel: string;
  danger?: boolean;
  /** Чтобы снести аккаунт, надо вписать имя — от промаха пальцем. */
  typeToConfirm?: string;
  onConfirm: (value: string) => void | Promise<void>;
}

function AskDialog({ spec, onClose }: { spec: AskSpec; onClose: () => void }) {
  const [value, setValue] = useState('');
  const [typed, setTyped] = useState('');
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 50); }, []);

  const tooShort = !!spec.field?.minLength && value.trim().length < spec.field.minLength;
  const missing = !!spec.field?.required && value.trim().length === 0;
  const notTyped = !!spec.typeToConfirm && typed.trim() !== spec.typeToConfirm;
  const blocked = tooShort || missing || notTyped;

  const submit = async () => {
    if (blocked) return;
    await spec.onConfirm(value.trim());
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center bg-black/60 p-0 sm:p-4"
         onClick={onClose}>
      <div className="w-full sm:max-w-md bg-messenger-sidebar border-t sm:border border-messenger-border rounded-t-2xl sm:rounded-2xl p-4 space-y-3"
           onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-2">
          {spec.danger && <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />}
          <div className="flex-1">
            <h3 className="font-semibold">{spec.title}</h3>
            {spec.description && (
              <p className="text-xs text-messenger-muted mt-1 leading-relaxed">{spec.description}</p>
            )}
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-messenger-hover shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        {spec.field && (
          <div className="space-y-1">
            <label className="text-xs text-messenger-muted">{spec.field.label}</label>
            {spec.field.type === 'textarea' ? (
              <textarea ref={inputRef as any} value={value} onChange={e => setValue(e.target.value)}
                        rows={3} placeholder={spec.field.placeholder}
                        className="w-full p-2.5 rounded-lg bg-messenger-input outline-none text-sm resize-y
                                   border border-transparent focus:border-primary-500" />
            ) : (
              <input ref={inputRef as any} type={spec.field.type === 'password' ? 'text' : 'text'}
                     value={value} onChange={e => setValue(e.target.value)}
                     placeholder={spec.field.placeholder}
                     onKeyDown={e => { if (e.key === 'Enter' && !blocked) submit(); }}
                     className="w-full p-2.5 rounded-lg bg-messenger-input outline-none text-sm
                                border border-transparent focus:border-primary-500" />
            )}
            {spec.field.hint && <p className="text-[11px] text-messenger-muted">{spec.field.hint}</p>}
            {tooShort && value.length > 0 && (
              <p className="text-[11px] text-amber-400">
                Нужно минимум {spec.field.minLength} символов, сейчас {value.trim().length}.
              </p>
            )}
          </div>
        )}

        {spec.typeToConfirm && (
          <div className="space-y-1">
            <label className="text-xs text-messenger-muted">
              Впишите <b className="text-messenger-text">{spec.typeToConfirm}</b>, чтобы подтвердить
            </label>
            <input value={typed} onChange={e => setTyped(e.target.value)}
                   className="w-full p-2.5 rounded-lg bg-messenger-input outline-none text-sm
                              border border-transparent focus:border-red-500" />
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <button onClick={onClose}
                  className="flex-1 py-2.5 rounded-lg bg-messenger-hover text-sm">Отмена</button>
          <button onClick={submit} disabled={blocked}
                  className={`flex-1 py-2.5 rounded-lg text-sm text-white disabled:opacity-40
                              ${spec.danger ? 'bg-red-600' : 'bg-primary-500'}`}>
            {spec.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

const human = (n: number) => {
  if (!n) return '0 Б';
  const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / Math.pow(1024, i)).toFixed(1)} ${u[i]}`;
};

const when = (s?: string | null) => {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
};

export default function AdminPage() {
  const navigate = useNavigate();
  const user = useAuthStore(s => s.user);
  const [tab, setTab] = useState<Tab>('stats');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Доступ проверяет сервер; здесь только чтобы не показывать пустой
  // экран тому, кто зашёл по прямой ссылке.
  const myRole = (user as any)?.role;
  const isAdmin = myRole === 'admin';

  useEffect(() => {
    if (user && myRole !== 'admin' && myRole !== 'moderator') navigate('/', { replace: true });
  }, [user, myRole, navigate]);

  // Вкладка корпоративного контура — только если он включён на сервере
  const corp = !!useEnterprise().info?.enabled;
  useEffect(() => { refreshEnterpriseInfo().catch(() => {}); }, []);

  return (
    // h-full + overflow-y-auto, а НЕ min-h-screen.
    //
    // Оболочка приложения — это `flex flex-col h-full overflow-hidden`, и
    // body тоже с overflow: hidden (так сделано, чтобы список чатов и лента
    // сообщений прокручивались сами по себе, а страница целиком — нет).
    // Админка же объявляла min-h-screen и вырастала выше экрана: контент
    // 1055 пикселей при экране 798, и ни один родитель прокрутку не давал —
    // последние 257 пикселей были физически недостижимы. Отсюда «панель
    // вниз не крутится». Теперь страница сама себе контейнер прокрутки.
    <div className="h-full overflow-y-auto overscroll-contain bg-messenger-bg text-messenger-text">
      <div className="sticky top-0 z-10 bg-messenger-bg/95 backdrop-blur border-b border-messenger-border">
        <div className="flex items-center gap-3 px-4 py-3">
          <button onClick={() => navigate(-1)} className="p-2 rounded-lg hover:bg-messenger-hover">
            <ArrowLeft className="w-5 h-5" />
          </button>
          {/* Панель называется по роли: модератор должен понимать, что он
              не администратор, ещё до того как упрётся в отказ. */}
          <h1 className="text-lg font-bold">{isAdmin ? 'Админ-панель' : 'Панель модератора'}</h1>
          {busy && <Loader2 className="w-4 h-4 animate-spin text-primary-500" />}
        </div>
        <div className="flex gap-1 px-2 pb-2 overflow-x-auto">
          {([
            ['stats', 'Сводка', Activity],
            ['users', 'Люди', Users],
            ...(isAdmin && corp ? [['enterprise', 'Корпоративный контур', Building2] as [Tab, string, any]] : []),
            ['reports', 'Жалобы', Flag],
            ['support', 'Обращения', LifeBuoy],
            ['server', 'Сервер', Server],
            ['audit', 'Журнал', ScrollText],
            ...(isAdmin ? [
              ['storage', 'Хранилище', HardDrive] as [Tab, string, any],
              ['chats', 'Чаты', MessageSquare] as [Tab, string, any],
              ['broadcast', 'Объявление', Megaphone] as [Tab, string, any],
            ] : []),
          ] as [Tab, string, any][]).map(([id, label, Icon]) => (
            <button
              key={id}
              onClick={() => { setTab(id); setErr(null); }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm whitespace-nowrap ${
                tab === id ? 'bg-primary-500 text-white' : 'hover:bg-messenger-hover'
              }`}
            >
              <Icon className="w-4 h-4" /> {label}
            </button>
          ))}
        </div>
      </div>

      {/* Модератору сразу говорим, что ему открыто и что закрыто.
          Без этого он натыкается на отказы и не понимает, поломка это
          или так задумано. */}
      {!isAdmin && (
        <div className="mx-4 mt-3 p-3 rounded-lg bg-messenger-panel text-xs text-messenger-muted leading-relaxed">
          <b className="text-messenger-text">Права модератора.</b> Видно всё
          состояние: сводка, люди, сервер, журнал, обращения. Можно
          блокировать и разблокировать, сбрасывать чужие сессии, закрывать
          обращения.
          <br />
          <b className="text-messenger-text">Закрыто:</b> чужая переписка —
          открыть сообщение нельзя даже по номеру. А также удаление
          аккаунтов, сброс паролей, смена ролей и имён, рассылка объявлений и
          обслуживание сервера. Это к администратору.
        </div>
      )}

      {err && (
        <div className="mx-4 mt-3 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="flex-1 break-words">{err}</span>
          <button onClick={() => setErr(null)} className="p-0.5 shrink-0 hover:text-red-300">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Запас снизу — под панель навигации телефона и жестовую полоску,
          иначе последняя карточка упирается в край и её не дочитать. */}
      <div className="p-4 pb-[calc(env(safe-area-inset-bottom,0px)+32px)]">
        {tab === 'stats' && <StatsTab setBusy={setBusy} setErr={setErr} />}
        {tab === 'users' && <UsersTab setBusy={setBusy} setErr={setErr} isAdmin={isAdmin} />}
        {tab === 'enterprise' && isAdmin && corp && <EnterpriseTab setBusy={setBusy} setErr={setErr} />}
        {tab === 'reports' && <ReportsTab setBusy={setBusy} setErr={setErr} />}
        {tab === 'support' && <SupportTab setBusy={setBusy} setErr={setErr} />}
        {tab === 'storage' && isAdmin && <StorageTab setBusy={setBusy} setErr={setErr} />}
        {tab === 'server' && <ServerTab setBusy={setBusy} setErr={setErr} isAdmin={isAdmin} />}
        {tab === 'audit' && <AuditTab setBusy={setBusy} setErr={setErr} isAdmin={isAdmin} />}
        {tab === 'chats' && isAdmin && <ChatsTab setBusy={setBusy} setErr={setErr} />}
        {tab === 'broadcast' && isAdmin && <BroadcastTab setBusy={setBusy} setErr={setErr} />}
      </div>
    </div>
  );
}

type P = { setBusy: (b: boolean) => void; setErr: (e: string | null) => void };

function StatsTab({ setBusy, setErr }: P) {
  const [s, setS] = useState<any>(null);

  const load = async () => {
    setBusy(true);
    try { setS((await adminApi.stats()).data); setErr(null); }
    catch (e: any) { setErr(e?.response?.data?.error || 'Не удалось получить сводку'); }
    finally { setBusy(false); }
  };
  useEffect(() => { load(); }, []);

  if (!s) return <div className="text-messenger-muted">Загрузка…</div>;

  const cards: [string, string][] = [
    ['Пользователей', String(s.users)],
    ['Сейчас онлайн', String(s.online)],
    ['Заблокировано', String(s.blocked)],
    ['Администраторов', String(s.admins)],
    ['Чатов', String(s.chats)],
    ['Сообщений', String(s.messages)],
    ['Файлов', `${s.files} · ${human(s.filesSize)}`],
    ['Звонков', String(s.calls)],
    ['Новых за сутки', String(s.newUsersToday)],
    ['Сообщений за сутки', String(s.messagesToday)],
    ['Аптайм', `${Math.floor(s.uptimeSec / 3600)} ч ${Math.floor((s.uptimeSec % 3600) / 60)} м`],
    ['Память сервера', `${s.memoryMb} МБ`],
  ];

  return (
    <div className="space-y-4">
      <button onClick={load} className="flex items-center gap-1.5 text-sm text-primary-400">
        <RefreshCw className="w-4 h-4" /> Обновить
      </button>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {cards.map(([k, v]) => (
          <div key={k} className="p-3 rounded-xl bg-messenger-panel">
            <div className="text-xs text-messenger-muted">{k}</div>
            <div className="text-xl font-semibold mt-0.5">{v}</div>
          </div>
        ))}
      </div>
      {s.disk && (
        <div className="p-3 rounded-xl bg-messenger-panel">
          <div className="text-xs text-messenger-muted mb-1">Диск хранилища</div>
          <div className="text-sm">
            занято {human(s.disk.used)} из {human(s.disk.total)}, свободно {human(s.disk.free)}
          </div>
          <div className="h-2 mt-2 rounded-full bg-messenger-border overflow-hidden">
            <div className="h-full bg-primary-500"
                 style={{ width: `${Math.min(100, (s.disk.used / s.disk.total) * 100)}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}

const PAGE = 50;

function UsersTab({ setBusy, setErr, isAdmin }: P & { isAdmin: boolean }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  // По умолчанию — по последнему входу, а не по дате регистрации.
  // «Сначала новые» выносит наверх свежесозданные учётки, а свежие у нас
  // обычно тестовые (emu_…, offline_…), и панель открывалась списком
  // непонятного мусора вместо живых людей.
  const [sort, setSort] = useState('seen');
  const [data, setData] = useState<any>(null);
  const [rows, setRows] = useState<any[]>([]);
  const [ask, setAsk] = useState<AskSpec | null>(null);

  const load = async (opts: { query?: string; f?: string; s?: string; append?: boolean } = {}) => {
    const query = opts.query ?? q;
    const f = opts.f ?? filter;
    const s = opts.s ?? sort;
    const offset = opts.append ? rows.length : 0;
    setBusy(true);
    try {
      const r = (await adminApi.users(query, PAGE, offset, f, s)).data;
      setData(r);
      setRows(prev => (opts.append ? [...prev, ...(r.users || [])] : (r.users || [])));
      setErr(null);
    } catch (e: any) { setErr(e?.response?.data?.error || 'Не удалось получить список'); }
    finally { setBusy(false); }
  };
  useEffect(() => { load({ query: '' }); }, []);

  // Действие + перезагрузка списка. Текст ошибки теперь называет действие —
  // раньше в красной полосе было безликое «Не получилось».
  const act = async (what: string, fn: () => Promise<any>) => {
    setBusy(true);
    try { await fn(); await load(); setErr(null); }
    catch (e: any) { setErr(`${what}: ${e?.response?.data?.error || e?.message || 'не получилось'}`); }
    finally { setBusy(false); }
  };

  const FILTERS: [string, string][] = [
    ['all', 'Все'], ['online', 'Онлайн'], ['blocked', 'Заблокированные'], ['staff', 'Персонал'],
  ];
  const SORTS: [string, string][] = [
    ['new', 'сначала новые'], ['seen', 'по последнему входу'],
    ['name', 'по имени'], ['old', 'сначала старые'],
  ];

  return (
    <div className="space-y-3">
      {ask && <AskDialog spec={ask} onClose={() => setAsk(null)} />}

      <form onSubmit={e => { e.preventDefault(); load(); }} className="flex gap-2">
        <div className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg bg-messenger-panel">
          <Search className="w-4 h-4 text-messenger-muted" />
          <input value={q} onChange={e => setQ(e.target.value)}
                 placeholder="Имя, отображаемое имя или идентификатор"
                 className="flex-1 bg-transparent outline-none text-sm" />
          {q && <button type="button" onClick={() => { setQ(''); load({ query: '' }); }}
                        className="p-0.5 text-messenger-muted"><X className="w-4 h-4" /></button>}
        </div>
        <button className="px-3 py-2 rounded-lg bg-primary-500 text-white text-sm">Найти</button>
      </form>

      {/* Фильтры и порядок — без них полсотни учёток приходилось
          перебирать глазами. */}
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {FILTERS.map(([id, label]) => (
          <button key={id} onClick={() => { setFilter(id); load({ f: id }); }}
                  className={`px-2.5 py-1 rounded-full text-xs whitespace-nowrap ${
                    filter === id ? 'bg-primary-500 text-white' : 'bg-messenger-hover'}`}>
            {label}
          </button>
        ))}
        <select value={sort} onChange={e => { setSort(e.target.value); load({ s: e.target.value }); }}
                className="ml-auto px-2 py-1 rounded-full text-xs bg-messenger-hover outline-none shrink-0">
          {SORTS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </div>

      {data && (
        <div className="text-xs text-messenger-muted">
          показано {rows.length} из {data.total}
        </div>
      )}

      <div className="space-y-2">
        {rows.map((u: any) => (
          <div key={u.id} className="p-3 rounded-xl bg-messenger-panel">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold">{u.display_name || u.username}</span>
              <span className="text-xs text-messenger-muted">@{u.username}</span>
              {u.role === 'admin' && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary-500/20 text-primary-400">админ</span>
              )}
              {u.role === 'moderator' && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400">модератор</span>
              )}
              {u.online && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400">онлайн</span>
              )}
              {u.blocked_at && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400">заблокирован</span>
              )}
            </div>
            <div className="text-xs text-messenger-muted mt-1">
              чатов {u.chats} · сообщений {u.messages} · был {when(u.last_seen)} · с {when(u.created_at)}
            </div>
            {u.blocked_reason && (
              <div className="text-xs text-red-400 mt-1">причина: {u.blocked_reason}</div>
            )}
            <div className="flex flex-wrap gap-2 mt-2">
              {u.blocked_at ? (
                <button onClick={() => setAsk({
                          title: `Разблокировать ${u.display_name || u.username}?`,
                          description: 'Человек снова сможет войти. Действие попадёт в журнал.',
                          confirmLabel: 'Разблокировать',
                          onConfirm: () => act('Разблокировка', () => adminApi.unblock(u.id)),
                        })}
                        className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-green-500/15 text-green-400">
                  <ShieldCheck className="w-3.5 h-3.5" /> Разблокировать
                </button>
              ) : (
                <button onClick={() => setAsk({
                          title: `Заблокировать ${u.display_name || u.username}?`,
                          description: 'Вход закроется сразу, текущие сессии оборвутся. Причину увидит и человек, и журнал.',
                          field: { label: 'Причина', placeholder: 'например: спам в общих чатах', required: true },
                          confirmLabel: 'Заблокировать',
                          danger: true,
                          onConfirm: (reason) => act('Блокировка', () => adminApi.block(u.id, reason)),
                        })}
                        className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-red-500/15 text-red-400">
                  <ShieldOff className="w-3.5 h-3.5" /> Заблокировать
                </button>
              )}
              {isAdmin && <button onClick={() => setAsk({
                        title: `Переименовать ${u.username}`,
                        description: 'Меняем @имя — то, по которому человека ищут и упоминают. Старое значение сохранится в журнале, так что откатить будет чем. Чтобы поменять только отображаемое имя, оставьте поле пустым и воспользуйтесь кнопкой ниже.',
                        field: {
                          label: 'Новое @имя',
                          placeholder: u.username,
                          required: true,
                          minLength: 3,
                          hint: 'Буквы, цифры, точка, дефис, подчёркивание. От 3 до 32 символов.',
                        },
                        confirmLabel: 'Переименовать',
                        onConfirm: (v) => act('Смена имени', () => adminApi.rename(u.id, { username: v })),
                      })}
                      className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-messenger-hover">
                <AtSign className="w-3.5 h-3.5" /> Сменить @имя
              </button>}
              {isAdmin && <button onClick={() => setAsk({
                        title: `Отображаемое имя ${u.username}`,
                        description: 'Это имя видят собеседники. На поиск и упоминания не влияет.',
                        field: {
                          label: 'Отображаемое имя',
                          placeholder: u.display_name || '(пусто)',
                          hint: 'Можно оставить пустым — тогда будет показываться @имя.',
                        },
                        confirmLabel: 'Сохранить',
                        onConfirm: (v) => act('Смена отображаемого имени',
                                              () => adminApi.rename(u.id, { display_name: v })),
                      })}
                      className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-messenger-hover">
                <Pencil className="w-3.5 h-3.5" /> Отображаемое имя
              </button>}
              {isAdmin && <button onClick={() => setAsk({
                        title: `Новый пароль для ${u.username}`,
                        description: 'Старый перестанет работать сразу. Передайте новый пароль человеку сами — на экране он больше не появится.',
                        field: { label: 'Пароль', placeholder: 'минимум 8 символов', required: true, minLength: 8 },
                        confirmLabel: 'Сбросить пароль',
                        danger: true,
                        onConfirm: (p) => act('Сброс пароля', () => adminApi.resetPassword(u.id, p)),
                      })}
                      className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-messenger-hover">
                <KeyRound className="w-3.5 h-3.5" /> Сбросить пароль
              </button>}
              <button onClick={() => setAsk({
                        title: `Сбросить сессии ${u.username}?`,
                        description: 'Человека выкинет из приложения на всех устройствах. Пароль останется прежним.',
                        confirmLabel: 'Сбросить сессии',
                        onConfirm: () => act('Сброс сессий', () => adminApi.logoutAll(u.id)),
                      })}
                      className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-messenger-hover">
                <LogOut className="w-3.5 h-3.5" /> Сбросить сессии
              </button>
              {isAdmin && (
                <select value={u.role} onChange={e => {
                          const r = e.target.value as 'admin' | 'moderator' | 'user';
                          if (r === u.role) return;
                          const names: Record<string, string> = {
                            user: 'обычный пользователь', moderator: 'модератор', admin: 'администратор',
                          };
                          setAsk({
                            title: `Сменить роль ${u.username}`,
                            description: `Было: ${names[u.role] || u.role}. Станет: ${names[r]}.` +
                              (r === 'admin' ? ' Администратор получает полный доступ к серверу и людям.' : ''),
                            confirmLabel: 'Сменить роль',
                            danger: r === 'admin',
                            onConfirm: () => act('Смена роли', () => adminApi.setRole(u.id, r)),
                          });
                          // Возвращаем select на место: роль поменяется, только
                          // когда действие подтвердят и список перезагрузится.
                          e.target.value = u.role;
                        }}
                        className="text-xs px-2 py-1 rounded bg-messenger-hover outline-none">
                  <option value="user">обычный</option>
                  <option value="moderator">модератор</option>
                  <option value="admin">админ</option>
                </select>
              )}
              {isAdmin && <button onClick={() => setAsk({
                        title: `Удалить аккаунт ${u.username}`,
                        description: `Вместе с ним исчезнет вся переписка: ${u.messages} сообщений в ${u.chats} чатах. Восстановить можно будет только из ночного бэкапа.`,
                        typeToConfirm: u.username,
                        confirmLabel: 'Удалить навсегда',
                        danger: true,
                        onConfirm: () => act('Удаление аккаунта', () => adminApi.deleteUser(u.id)),
                      })}
                      className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-red-500/15 text-red-400">
                <Trash2 className="w-3.5 h-3.5" /> Удалить
              </button>}
            </div>
          </div>
        ))}
      </div>

      {data?.hasMore && (
        <button onClick={() => load({ append: true })}
                className="w-full py-2.5 rounded-lg bg-messenger-hover text-sm">
          Показать ещё {Math.min(PAGE, data.total - rows.length)}
        </button>
      )}
      {rows.length === 0 && data && (
        <div className="text-sm text-messenger-muted py-6 text-center">Никого не нашлось.</div>
      )}
    </div>
  );
}

// Обращения «позвать администратора».
//
// Именно отсюда должен начинаться разбор: человек сам позвал и сам указал,
// что разрешает смотреть. Открывая сообщение, панель отмечает в журнале,
// было ли на этот чат живое разрешение.
function SupportTab({ setBusy, setErr }: P) {
  const [rows, setRows] = useState<any[]>([]);
  const [status, setStatus] = useState('open');
  const [ask, setAsk] = useState<AskSpec | null>(null);

  const load = async (st = status) => {
    setBusy(true);
    try { setRows((await adminApi.support(st)).data.requests || []); setErr(null); }
    catch (e: any) { setErr(`Обращения: ${e?.response?.data?.error || 'не загрузились'}`); }
    finally { setBusy(false); }
  };
  useEffect(() => { load(); }, []);

  const SCOPE_LABEL: Record<string, string> = {
    none: 'только описание',
    diagnostics: 'разрешена диагностика',
    messages: 'РАЗРЕШЕНА ПЕРЕПИСКА в чате',
  };

  return (
    <div className="space-y-3">
      {ask && <AskDialog spec={ask} onClose={() => setAsk(null)} />}
      <div className="flex items-center gap-2">
        {[['open', 'Открытые'], ['closed', 'Закрытые'], ['all', 'Все']].map(([id, label]) => (
          <button key={id} onClick={() => { setStatus(id); load(id); }}
                  className={`px-2.5 py-1 rounded-full text-xs ${status === id ? 'bg-primary-500 text-white' : 'bg-messenger-hover'}`}>
            {label}
          </button>
        ))}
        <button onClick={() => load()} className="ml-auto flex items-center gap-1.5 text-sm text-primary-400">
          <RefreshCw className="w-4 h-4" /> Обновить
        </button>
      </div>

      {rows.length === 0 && <div className="text-sm text-messenger-muted py-6 text-center">Обращений нет.</div>}

      {rows.map(r => (
        <div key={r.id} className="p-3 rounded-xl bg-messenger-panel space-y-1.5">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="font-mono text-xs text-messenger-muted">{String(r.id).slice(0, 8)}</span>
            <span className="font-semibold flex-1 min-w-0">{r.subject}</span>
            {r.status === 'open'
              ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400">открыто</span>
              : <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400">закрыто</span>}
          </div>
          <div className="text-xs text-messenger-muted">
            от {r.display_name || r.username || r.user_id} · {when(r.created_at)}
          </div>
          {r.details && <div className="text-sm whitespace-pre-wrap break-words">{r.details}</div>}
          <div className={`text-[11px] ${r.consent_scope === 'messages' ? 'text-amber-400' : 'text-messenger-muted'}`}>
            Доступ: {SCOPE_LABEL[r.consent_scope] || r.consent_scope}
            {r.chat_id && <span className="text-messenger-muted"> · чат {String(r.chat_id).slice(0, 8)}…</span>}
          </div>
          {r.device_label && <div className="text-[11px] text-messenger-muted break-all">{r.device_label}</div>}
          {r.resolution && <div className="text-[11px] text-green-400">Итог: {r.resolution}</div>}
          {r.status === 'open' && (
            <button onClick={() => setAsk({
                      title: 'Закрыть обращение',
                      description: `«${r.subject}». Человек увидит, чем кончилось.`,
                      field: { label: 'Что сделали', placeholder: 'например: пересобрал кэш, отправка починилась', required: true },
                      confirmLabel: 'Закрыть',
                      onConfirm: async (v) => {
                        setBusy(true);
                        try { await adminApi.closeSupport(r.id, v); await load(); setErr(null); }
                        catch (e: any) { setErr(`Закрытие: ${e?.response?.data?.error || 'не получилось'}`); }
                        finally { setBusy(false); }
                      },
                    })}
                    className="text-xs px-2 py-1 rounded bg-messenger-hover">Закрыть с пометкой</button>
          )}
        </div>
      ))}
    </div>
  );
}

// Разбор жалобы: открыть ОДНО сообщение по идентификатору.
//
// Возможность на сервере была с самого начала, а в панели — нет: маршруты
// /admin/messages/:id висели без единой кнопки. Получалось, что правило
// «смотрю только когда позвали» соблюдать было нечем, и разбирать жалобы
// приходилось руками в базе — то есть мимо журнала, что как раз хуже всего.
function ComplaintTool({ setBusy, setErr, isAdmin }: P & { isAdmin: boolean }) {
  const [id, setId] = useState('');
  const [msg, setMsg] = useState<any>(null);
  const [ask, setAsk] = useState<AskSpec | null>(null);

  const open = async () => {
    const clean = id.trim();
    if (!clean) return;
    setBusy(true);
    try {
      setMsg((await adminApi.message(clean)).data.message);
      setErr(null);
    } catch (e: any) {
      setMsg(null);
      setErr(`Сообщение: ${e?.response?.data?.error || 'не найдено'}`);
    } finally { setBusy(false); }
  };

  return (
    <div className="p-3 rounded-xl bg-messenger-panel space-y-2">
      {ask && <AskDialog spec={ask} onClose={() => setAsk(null)} />}
      <div className="flex items-center gap-2 text-xs text-messenger-muted">
        <FileSearch className="w-3.5 h-3.5" /> Разбор жалобы
      </div>
      <p className="text-[11px] text-messenger-muted leading-relaxed">
        Открывает одно сообщение по идентификатору из жалобы. Списка чужих чатов
        и поиска по переписке здесь нет и не будет. Каждый такой просмотр
        отдельной строкой попадает в журнал ниже.
      </p>
      <div className="flex gap-2">
        <input value={id} onChange={e => setId(e.target.value)}
               onKeyDown={e => { if (e.key === 'Enter') open(); }}
               placeholder="Идентификатор сообщения"
               className="flex-1 px-3 py-2 rounded-lg bg-messenger-input outline-none text-sm font-mono
                          border border-transparent focus:border-primary-500" />
        <button onClick={open} disabled={!id.trim()}
                className="px-3 py-2 rounded-lg bg-primary-500 text-white text-sm disabled:opacity-40">
          Открыть
        </button>
      </div>

      {msg && (
        <div className="mt-2 p-3 rounded-lg bg-messenger-bg space-y-1.5">
          <div className="text-xs text-messenger-muted">
            от @{msg.sender_username || '—'} · {when(msg.created_at)} · тип {msg.type}
            {msg.deleted_at && <span className="text-red-400"> · удалено</span>}
          </div>
          <div className="text-sm whitespace-pre-wrap break-words">
            {msg.content || <span className="text-messenger-muted">(без текста — вложение)</span>}
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button onClick={() => navigator.clipboard?.writeText(msg.chat_id)}
                    className="flex items-center gap-1 text-[11px] text-messenger-muted hover:text-messenger-text">
              <Copy className="w-3 h-3" /> чат {String(msg.chat_id).slice(0, 8)}…
            </button>
            {isAdmin && !msg.deleted_at && (
              <button onClick={() => setAsk({
                        title: 'Удалить это сообщение?',
                        description: 'Оно исчезнет у всех участников чата. Действие попадёт в журнал.',
                        confirmLabel: 'Удалить',
                        danger: true,
                        onConfirm: async () => {
                          try { await adminApi.deleteMessage(msg.id); setMsg({ ...msg, deleted_at: new Date().toISOString() }); }
                          catch (e: any) { setErr(`Удаление сообщения: ${e?.response?.data?.error || 'не получилось'}`); }
                        },
                      })}
                      className="ml-auto flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-red-500/15 text-red-400">
                <Trash2 className="w-3 h-3" /> Удалить у всех
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function AuditTab({ setBusy, setErr, isAdmin }: P & { isAdmin: boolean }) {
  const [rows, setRows] = useState<any[]>([]);

  const load = async () => {
    setBusy(true);
    try { setRows((await adminApi.audit()).data.entries || []); setErr(null); }
    catch (e: any) { setErr(e?.response?.data?.error || 'Не удалось получить журнал'); }
    finally { setBusy(false); }
  };
  useEffect(() => { load(); }, []);

  const label: Record<string, string> = {
    'user.block': 'заблокировал',
    'user.unblock': 'разблокировал',
    'user.reset_password': 'сбросил пароль',
    'user.logout_all': 'сбросил сессии',
    'user.role': 'изменил роль',
    'user.delete': 'удалил аккаунт',
    'message.view': 'ПОСМОТРЕЛ СООБЩЕНИЕ',
    'message.delete': 'удалил сообщение',
    'broadcast': 'разослал объявление',
  };

  return (
    <div className="space-y-2">
      {/* Разбор жалобы открывает чужое сообщение — это только админу.
          Сервер откажет модератору в любом случае, но показывать ему
          заведомо нерабочее поле — обманывать. */}
      {isAdmin
        ? <ComplaintTool setBusy={setBusy} setErr={setErr} isAdmin={isAdmin} />
        : (
          <div className="p-3 rounded-xl bg-messenger-panel text-xs text-messenger-muted leading-relaxed">
            Разбор жалобы с открытием сообщения доступен только администратору.
            Ваши действия — ниже в журнале, как и все остальные.
          </div>
        )}

      <div className="flex items-center gap-3 pt-2">
        <button onClick={load} className="flex items-center gap-1.5 text-sm text-primary-400">
          <RefreshCw className="w-4 h-4" /> Обновить
        </button>
        <span className="text-xs text-messenger-muted">записей: {rows.length}</span>
      </div>
      <p className="text-xs text-messenger-muted">
        Здесь видно каждое действие администратора, включая просмотр чужого сообщения.
      </p>
      {rows.length === 0 && <div className="text-messenger-muted text-sm">Пока пусто.</div>}
      {rows.map(r => (
        <div key={r.id} className="p-2.5 rounded-lg bg-messenger-panel text-sm">
          <div className="flex flex-wrap gap-x-2 items-baseline">
            <span className="text-xs text-messenger-muted">{when(r.created_at)}</span>
            <span className="font-medium">{r.admin_name || r.admin_id}</span>
            <span className={r.action === 'message.view' ? 'text-amber-400' : ''}>
              {label[r.action] || r.action}
            </span>
            {r.details?.username && <span className="text-messenger-muted">@{r.details.username}</span>}
          </div>
          {/* Подробности читаемой строкой вместо голого JSON.stringify:
              раньше в журнале висела техническая каша, по которой понять,
              что произошло, было можно только прищурившись. */}
          {r.details && Object.keys(r.details).length > 0 && (
            <div className="text-[11px] text-messenger-muted mt-0.5 break-all">
              {Object.entries(r.details)
                .filter(([, v]) => v !== null && v !== undefined && v !== '')
                .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
                .join(' · ')}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function BroadcastTab({ setBusy, setErr }: P) {
  const [text, setText] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [ask, setAsk] = useState<AskSpec | null>(null);

  const send = async () => {
    setBusy(true);
    try {
      const r = await adminApi.broadcast(text.trim());
      setDone(`Отправлено. Получателей: ${r.data.recipients}`);
      setText(''); setErr(null);
    } catch (e: any) { setErr(`Рассылка: ${e?.response?.data?.error || 'не получилось'}`); }
    finally { setBusy(false); }
  };

  const LIMIT = 4000;
  const over = text.length > LIMIT;

  return (
    <div className="space-y-3">
      {ask && <AskDialog spec={ask} onClose={() => setAsk(null)} />}
      <p className="text-sm text-messenger-muted">
        Объявление уходит в канал «📢 Объявления», куда включены все пользователи.
        Те, кто сейчас офлайн, увидят его при следующем входе. Отозвать разосланное нельзя.
      </p>
      <textarea value={text} onChange={e => setText(e.target.value)} rows={6}
                placeholder="Текст объявления…"
                className={`w-full p-3 rounded-xl bg-messenger-panel outline-none text-sm resize-y
                            border ${over ? 'border-red-500' : 'border-transparent focus:border-primary-500'}`} />
      {/* Счётчик — раньше про предел в 4000 знал только сервер, и человек
          узнавал о нём красной ошибкой уже после нажатия. */}
      <div className={`text-xs ${over ? 'text-red-400' : 'text-messenger-muted'}`}>
        {text.length} / {LIMIT}{over && ' — слишком длинно, сервер не примет'}
      </div>
      <button onClick={() => setAsk({
                title: 'Разослать объявление всем?',
                description: `Уйдёт всем пользователям сразу, отозвать нельзя. Первая строка: «${text.trim().split('\n')[0].slice(0, 80)}»`,
                confirmLabel: 'Разослать',
                danger: true,
                onConfirm: send,
              })}
              disabled={!text.trim() || over}
              className="px-4 py-2 rounded-lg bg-primary-500 text-white text-sm disabled:opacity-40">
        Разослать всем
      </button>
      {done && <div className="text-sm text-green-400">{done}</div>}
    </div>
  );
}

// Вкладка «Чаты» — снос группы, канала или переписки. Право только у
// главного администратора.
//
// Списка чатов здесь нет намеренно, и это то же правило, что и с
// сообщениями: администратор не листает чужое. Открыть можно только
// конкретный чат по идентификатору из жалобы, и в карточке нет ни одного
// сообщения — тип, название, счётчики, участники. Этого хватает, чтобы
// решить «сносить или нет»; читать переписку для этого не требуется.
function ChatsTab({ setBusy, setErr }: P) {
  const [id, setId] = useState('');
  const [data, setData] = useState<any>(null);
  const [done, setDone] = useState<string | null>(null);
  const [ask, setAsk] = useState<AskSpec | null>(null);

  const load = async () => {
    const chatId = id.trim();
    if (!chatId) return;
    setBusy(true); setDone(null);
    try {
      const r = await adminApi.getChat(chatId);
      setData(r.data); setErr(null);
    } catch (e: any) {
      setData(null);
      setErr(`Чат: ${e?.response?.data?.error || 'не найден'}`);
    } finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true);
    try {
      const r = await adminApi.deleteChat(data.chat.id);
      setDone(`Удалён. Сообщений: ${r.data.messages}, участников: ${r.data.members}.`);
      setData(null); setId(''); setErr(null);
    } catch (e: any) { setErr(`Удаление: ${e?.response?.data?.error || 'не получилось'}`); }
    finally { setBusy(false); }
  };

  const c = data?.chat;
  // «Избранное» подписываем честно: назвать его «личной перепиской» —
  // верный способ однажды снести человеку личные заметки, перепутав
  // идентификатор. Сервер такое и не даст, но знать это надо до нажатия.
  const kind = c?.type === 'group' ? 'Группа'
             : c?.type === 'channel' ? 'Канал'
             : c?.type === 'favorites' ? 'Избранное (личные заметки)'
             : 'Личная переписка';
  const protectedChat = c?.type === 'favorites';

  return (
    <div className="space-y-3">
      {ask && <AskDialog spec={ask} onClose={() => setAsk(null)} />}
      <p className="text-sm text-messenger-muted">
        Снос чата, группы или канала по идентификатору из обращения. Списка
        чатов здесь нет: администратор не листает чужое. Содержимое не
        показывается — только с кем и сколько.
      </p>

      <div className="flex gap-2">
        <input value={id} onChange={e => setId(e.target.value)}
               onKeyDown={e => e.key === 'Enter' && load()}
               placeholder="Идентификатор чата"
               className="flex-1 px-3 py-2 rounded-lg bg-messenger-panel outline-none text-sm
                          border border-transparent focus:border-primary-500" />
        <button onClick={load} disabled={!id.trim()}
                className="px-4 py-2 rounded-lg bg-primary-500 text-white text-sm disabled:opacity-40">
          Найти
        </button>
      </div>

      {done && <div className="text-sm text-green-400">{done}</div>}

      {c && (
        <div className="p-3 rounded-xl bg-messenger-panel space-y-2">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-primary-500" />
            <span className="font-medium">{c.name || kind}</span>
            <span className="text-xs text-messenger-muted">{kind}</span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs text-messenger-muted">
            <div>Сообщений: <b className="text-messenger-text">{c.messages}</b></div>
            <div>Участников: <b className="text-messenger-text">{c.members}</b></div>
            <div>Создан: {c.created_at?.slice(0, 10)}</div>
            <div>Кем: {c.creator_username || '—'}</div>
            {c.last_message_at && <div className="col-span-2">Последнее сообщение: {c.last_message_at.slice(0, 16).replace('T', ' ')}</div>}
          </div>

          {!!data.members?.length && (
            <div className="text-xs text-messenger-muted">
              Кто состоит: {data.members.map((m: any) => m.display_name || m.username).join(', ')}
            </div>
          )}

          {/* Что именно исчезнет, а что останется — до нажатия, а не после.
              Файлы живут в личном хранилище людей и к чату не привязаны. */}
          <div className="text-xs text-messenger-muted leading-relaxed pt-1 border-t border-messenger-hover">
            Исчезнет у всех участников сразу и безвозвратно: сообщения,
            состав, звонки этого чата. Останутся: файлы в личных хранилищах
            и запись об этом действии в журнале.
          </div>

          {protectedChat ? (
            <div className="text-xs text-amber-400">
              Это личные заметки владельца — сносить их отдельно нельзя.
              Они уйдут вместе с учёткой, если её удалять.
            </div>
          ) : (
            <button onClick={() => setAsk({
                      title: 'Снести чат?',
                      description: `${kind}${c.name ? ` «${c.name}»` : ''}: ${c.messages} сообщений у ${c.members} участников. Вернуть нельзя.`,
                      confirmLabel: 'Снести',
                      danger: true,
                      onConfirm: remove,
                    })}
                    className="px-4 py-2 rounded-lg bg-red-500/90 hover:bg-red-500 text-white text-sm">
              <Trash2 className="w-4 h-4 inline mr-1.5" />Снести чат
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Вкладка «Сервер» — то, ради чего оператору не придётся лезть по ssh:
// здоровье, кто подключён, кого забанил автобан и хвост журнала.
function ServerTab({ setBusy, setErr, isAdmin }: P & { isAdmin: boolean }) {
  const [h, setH] = useState<any>(null);
  const [sess, setSess] = useState<any>(null);
  const [banned, setBanned] = useState<string[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [level, setLevel] = useState('all');
  const [logFilter, setLogFilter] = useState('');
  const logRef = useRef<HTMLPreElement>(null);

  const shownLogs = logFilter.trim()
    ? logs.filter(l => l.toLowerCase().includes(logFilter.trim().toLowerCase())).slice(-300)
    : logs.slice(-300);

  // Свежие строки внизу — прокручиваем туда сами, иначе журнал открывается
  // на самом старом, и до нужного надо долистывать вручную.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs, logFilter]);

  const load = async (lv = level) => {
    setBusy(true);
    try {
      const [a, b, c, d] = await Promise.all([
        adminApi.healthFull(), adminApi.sessions(), adminApi.banned(), adminApi.logs(lv),
      ]);
      setH(a.data); setSess(b.data); setBanned(c.data.ips || []); setLogs(d.data.lines || []);
      setErr(null);
    } catch (e: any) { setErr(e?.response?.data?.error || 'Не удалось получить состояние'); }
    finally { setBusy(false); }
  };
  useEffect(() => { load(); }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button onClick={() => load()} className="flex items-center gap-1.5 text-sm text-primary-400">
          <RefreshCw className="w-4 h-4" /> Обновить
        </button>
        {isAdmin && (
          <button onClick={async () => {
                    setBusy(true);
                    try { await adminApi.checkpoint(); await load(); } finally { setBusy(false); }
                  }}
                  className="text-sm text-messenger-muted hover:text-messenger-text">
            Сбросить WAL
          </button>
        )}
      </div>

      {h && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="p-3 rounded-xl bg-messenger-panel">
            <div className="text-xs text-messenger-muted mb-1">База</div>
            <div className="text-sm">целостность: <b className={h.db?.integrity === 'ok' ? 'text-green-400' : 'text-red-400'}>{h.db?.integrity}</b></div>
            <div className="text-xs text-messenger-muted mt-0.5">
              размер {human(h.db?.sizeBytes || 0)} · WAL {human(h.db?.walBytes || 0)}
            </div>
          </div>
          <div className="p-3 rounded-xl bg-messenger-panel">
            <div className="text-xs text-messenger-muted mb-1">Сертификат</div>
            {h.tls?.daysLeft !== undefined ? (
              <>
                <div className="text-sm">осталось <b className={h.tls.daysLeft < 14 ? 'text-red-400' : 'text-green-400'}>{h.tls.daysLeft} дн.</b></div>
                <div className="text-xs text-messenger-muted mt-0.5 break-all">до {h.tls.validTo}</div>
              </>
            ) : <div className="text-sm text-messenger-muted">{h.tls?.error || 'нет данных'}</div>}
          </div>
          <div className="p-3 rounded-xl bg-messenger-panel">
            <div className="text-xs text-messenger-muted mb-1">Процесс</div>
            <div className="text-sm">
              аптайм {Math.floor((h.process?.uptimeSec || 0) / 3600)} ч · память {h.process?.rssMb} МБ
            </div>
            <div className="text-xs text-messenger-muted mt-0.5">node {h.process?.node}, pid {h.process?.pid}</div>
          </div>
          <div className="p-3 rounded-xl bg-messenger-panel">
            <div className="text-xs text-messenger-muted mb-1">Хранилище</div>
            <div className="text-sm">свободно {human(h.storage?.freeBytes || 0)} из {human(h.storage?.totalBytes || 0)}</div>
            <div className="text-xs text-messenger-muted mt-0.5 break-all">{h.storage?.path}</div>
          </div>
        </div>
      )}

      <div className="p-3 rounded-xl bg-messenger-panel">
        <div className="text-xs text-messenger-muted mb-2">Подключены сейчас: {sess?.total ?? 0}</div>
        <div className="flex flex-wrap gap-1.5">
          {sess?.sessions?.map((s: any) => (
            <span key={s.userId}
                  title={s.userId}
                  className={`text-xs px-2 py-0.5 rounded ${s.orphan ? 'bg-amber-500/20 text-amber-400' : 'bg-messenger-hover'}`}>
              {/* Сокет без учётки — не прочерк, а повод присмотреться:
                  висит соединение удалённого пользователя. */}
              {s.orphan
                ? `удалённый аккаунт ${String(s.userId).slice(0, 8)}…`
                : (s.display_name || s.username)}
              {s.sockets > 1 ? ` ×${s.sockets}` : ''}
            </span>
          ))}
          {!sess?.total && <span className="text-xs text-messenger-muted">никого</span>}
        </div>
      </div>

      <div className="p-3 rounded-xl bg-messenger-panel">
        <div className="flex items-center gap-2 text-xs text-messenger-muted mb-2">
          <Ban className="w-3.5 h-3.5" /> Забанено автоматикой: {banned.length}
        </div>
        <div className="space-y-1">
          {banned.map(ip => (
            <div key={ip} className="flex items-center gap-2 text-sm">
              <span className="font-mono text-xs">{ip}</span>
              {isAdmin && (
                <button onClick={async () => { await adminApi.unban(ip); load(); }}
                        className="text-xs text-primary-400">разбанить</button>
              )}
            </div>
          ))}
          {banned.length === 0 && <span className="text-xs text-messenger-muted">пусто</span>}
        </div>
      </div>

      <div>
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <span className="text-xs text-messenger-muted">Журнал сервера</span>
          {['all', 'warn', 'error'].map(l => (
            <button key={l} onClick={() => { setLevel(l); load(l); }}
                    className={`text-xs px-2 py-0.5 rounded ${level === l ? 'bg-primary-500 text-white' : 'bg-messenger-hover'}`}>
              {l === 'all' ? 'всё' : l === 'warn' ? 'предупреждения' : 'ошибки'}
            </button>
          ))}
          <button onClick={() => navigator.clipboard?.writeText(shownLogs.join('\n'))}
                  className="flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-messenger-hover ml-auto">
            <Copy className="w-3 h-3" /> Скопировать
          </button>
        </div>
        {/* Поиск по журналу: без него нужную строку среди трёхсот
            приходилось искать глазами на телефоне. */}
        <div className="flex items-center gap-2 px-2.5 py-1.5 mb-2 rounded-lg bg-messenger-panel">
          <Search className="w-3.5 h-3.5 text-messenger-muted shrink-0" />
          <input value={logFilter} onChange={e => setLogFilter(e.target.value)}
                 placeholder="Отфильтровать строки…"
                 className="flex-1 bg-transparent outline-none text-xs" />
          {logFilter && (
            <button onClick={() => setLogFilter('')} className="text-messenger-muted">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          <span className="text-[10px] text-messenger-muted shrink-0">{shownLogs.length}</span>
        </div>
        <pre ref={logRef}
             className="p-3 rounded-xl bg-black/40 text-[11px] leading-relaxed overflow-auto max-h-96 whitespace-pre-wrap break-all">
{shownLogs.join('\n') || 'пусто'}
        </pre>
      </div>
    </div>
  );
}
