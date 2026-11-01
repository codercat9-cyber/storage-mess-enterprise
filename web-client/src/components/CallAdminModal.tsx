import { useState } from 'react';
import { LifeBuoy, X, Check, Loader2 } from 'lucide-react';
import { userApi } from '@/lib/api';

/**
 * «Позвать администратора» — обращение от обычного пользователя.
 *
 * Это вторая половина правила владельца. Первая («администратор не листает
 * чужую переписку, а смотрит только когда его позвали чинить») была вшита в
 * админ-панель ещё в 2.12.60: списка чужих чатов там нет, открыть можно лишь
 * конкретное сообщение, и каждый такой просмотр пишется в журнал.
 *
 * Но позвать было НЕЧЕМ. Человек жаловался в личку, и никакого формального
 * «я разрешаю посмотреть» не существовало — правило держалось на честном
 * слове обеих сторон. Здесь человек сам выбирает, что открывает: только
 * факт проблемы, технические счётчики без содержимого, или переписку в
 * конкретном чате. Выбор хранится рядом с обращением, и когда админ
 * открывает сообщение, в журнале отмечается, было ли на это разрешение.
 */

type Scope = 'none' | 'diagnostics' | 'messages';

interface Props {
  /** Чат, из которого позвали, — если звали из конкретного чата. */
  chatId?: string | null;
  chatName?: string;
  onClose: () => void;
}

const SCOPES: { id: Scope; title: string; hint: string }[] = [
  {
    id: 'none',
    title: 'Только моё описание',
    hint: 'Администратор увидит текст этого обращения и больше ничего.',
  },
  {
    id: 'diagnostics',
    title: 'Разрешаю посмотреть техническое',
    hint: 'Сколько у меня чатов и сообщений, когда заходил, есть ли ключи шифрования. Без текста переписки.',
  },
  {
    id: 'messages',
    title: 'Разрешаю посмотреть переписку в этом чате',
    hint: 'Нужно, если чинить приходится именно сообщения. Каждый просмотр попадёт в журнал, и вы сможете его увидеть.',
  },
];

export default function CallAdminModal({ chatId, chatName, onClose }: Props) {
  const [subject, setSubject] = useState('');
  const [details, setDetails] = useState('');
  const [scope, setScope] = useState<Scope>('none');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const canSend = subject.trim().length >= 5 && !busy;

  const send = async () => {
    if (!canSend) return;
    setBusy(true);
    setErr(null);
    try {
      const appVersion =
        (navigator.userAgent.match(/StorageMess\/([\d.]+)/) || [])[1] || undefined;
      const r = await userApi.supportRequest({
        subject: subject.trim(),
        details: details.trim() || undefined,
        // Разрешение на переписку имеет смысл только вместе с чатом.
        chat_id: scope === 'messages' ? chatId ?? null : null,
        consent_scope: scope,
        app_version: appVersion,
        device_label: navigator.userAgent.slice(0, 120),
      });
      setDone(r.data?.number || r.data?.id?.slice(0, 8) || '');
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Не удалось отправить обращение');
    } finally {
      setBusy(false);
    }
  };

  if (done !== null) {
    return (
      <Shell onClose={onClose}>
        <div className="flex flex-col items-center text-center py-4 gap-3">
          <div className="w-12 h-12 rounded-full bg-green-500/15 flex items-center justify-center">
            <Check className="w-6 h-6 text-green-400" />
          </div>
          <h3 className="font-semibold">Администратор позван</h3>
          <p className="text-sm text-messenger-muted">
            Номер обращения <b className="text-messenger-text">{done}</b>. Назовите его,
            если будете о нём спрашивать.
          </p>
          <button
            onClick={onClose}
            className="mt-2 w-full py-2.5 rounded-lg bg-primary-500 text-white text-sm"
          >
            Понятно
          </button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell onClose={onClose}>
      <div className="flex items-start gap-2 mb-3">
        <LifeBuoy className="w-5 h-5 text-primary-400 shrink-0 mt-0.5" />
        <div className="flex-1">
          <h3 className="font-semibold">Позвать администратора</h3>
          <p className="text-xs text-messenger-muted mt-0.5">
            Без вашего обращения администратор в вашу переписку не заходит.
          </p>
        </div>
        <button onClick={onClose} className="p-1 rounded-lg hover:bg-messenger-hover shrink-0">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="space-y-3">
        <div className="space-y-1">
          <label className="text-xs text-messenger-muted">Что случилось</label>
          <input
            value={subject}
            onChange={e => setSubject(e.target.value)}
            placeholder="Коротко: не отправляются фото"
            className="w-full p-2.5 rounded-lg bg-messenger-input outline-none text-sm
                       border border-transparent focus:border-primary-500"
          />
          {subject.length > 0 && subject.trim().length < 5 && (
            <p className="text-[11px] text-amber-400">Опишите чуть подробнее.</p>
          )}
        </div>

        <div className="space-y-1">
          <label className="text-xs text-messenger-muted">Подробности (не обязательно)</label>
          <textarea
            value={details}
            onChange={e => setDetails(e.target.value)}
            rows={3}
            placeholder="Когда началось, что делали перед этим"
            className="w-full p-2.5 rounded-lg bg-messenger-input outline-none text-sm resize-y
                       border border-transparent focus:border-primary-500"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs text-messenger-muted">Что разрешаете посмотреть</label>
          {SCOPES.map(s => {
            // Без чата разрешать «переписку» не на что.
            const disabled = s.id === 'messages' && !chatId;
            return (
              <button
                key={s.id}
                disabled={disabled}
                onClick={() => setScope(s.id)}
                className={`w-full text-left p-2.5 rounded-lg border transition-colors
                  ${scope === s.id
                    ? 'border-primary-500 bg-primary-500/10'
                    : 'border-messenger-border hover:bg-messenger-hover'}
                  ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                <div className="text-sm font-medium">
                  {s.title}
                  {s.id === 'messages' && chatName && (
                    <span className="text-messenger-muted font-normal"> — «{chatName}»</span>
                  )}
                </div>
                <div className="text-[11px] text-messenger-muted mt-0.5 leading-relaxed">
                  {disabled ? 'Доступно, если звать из чата.' : s.hint}
                </div>
              </button>
            );
          })}
        </div>

        {err && <div className="text-sm text-red-400">{err}</div>}

        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-lg bg-messenger-hover text-sm">
            Отмена
          </button>
          <button
            onClick={send}
            disabled={!canSend}
            className="flex-1 py-2.5 rounded-lg bg-primary-500 text-white text-sm
                       disabled:opacity-40 flex items-center justify-center gap-2"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            Отправить
          </button>
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center bg-black/60 p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-md bg-messenger-sidebar border-t sm:border border-messenger-border
                   rounded-t-2xl sm:rounded-2xl p-4 max-h-[90vh] overflow-y-auto
                   pb-[calc(env(safe-area-inset-bottom,0px)+16px)]"
        onClick={e => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
