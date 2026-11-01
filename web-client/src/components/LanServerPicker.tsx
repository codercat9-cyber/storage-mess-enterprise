import { useState } from 'react';
import { setCustomServerUrl, getCustomServerUrlValue, resetConnection } from '@/lib/connection';
import { useAuthStore } from '@/store/auth';

interface LanServer { app?: string; name?: string; version?: string; urls?: string[]; from?: string }

/**
 * Свой сервер рядом — самохост и аварийная связь без интернета.
 * Телефон (APK) и десктоп рассылают по локальной сети «кто здесь?»,
 * сервер отвечает адресами. Выбранный становится сервером приложения.
 */
export async function discoverLanServers(): Promise<LanServer[]> {
  const desk = (window as any).electronAPI;
  if (desk?.discoverLan) return (await desk.discoverLan()) || [];
  const br = (window as any).AndroidBridge;
  if (br?.discoverLan) {
    return new Promise(resolve => {
      const on = (e: Event) => { window.removeEventListener('lan-servers', on); resolve((e as CustomEvent).detail || []); };
      window.addEventListener('lan-servers', on);
      br.discoverLan();
      setTimeout(() => { window.removeEventListener('lan-servers', on); resolve([]); }, 4000);
    });
  }
  return [];
}

export const canDiscoverLan = () => !!((window as any).electronAPI?.discoverLan || (window as any).AndroidBridge?.discoverLan);

export default function LanServerPicker({ compact = false }: { compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [list, setList] = useState<LanServer[] | null>(null);
  const [manual, setManual] = useState(getCustomServerUrlValue());
  const current = getCustomServerUrlValue();

  // Другой сервер — другие учётки: старый вход там не действует, выходим
  const use = (url: string) => {
    if (useAuthStore.getState().isAuthenticated &&
        !window.confirm('На другом сервере свои учётные записи — из текущей придётся выйти. Переключить?')) return;
    useAuthStore.getState().logout();
    setCustomServerUrl(url.replace(/\/+$/, ''));
    resetConnection();
    window.location.reload();
  };

  return (
    <div className={compact ? 'space-y-2 text-[13px]' : 'px-5 py-4 space-y-3'}>
      {!compact && <div className="text-[16px] font-medium text-messenger-text">🏠 Свой сервер (самохост)</div>}
      <div className="text-[12px] text-messenger-muted leading-snug">
        Сервер: <b>{current || 'основной'}</b>. Свой сервер в локальной сети работает и без интернета — найдите его или укажите адрес.
      </div>
      <div className="flex flex-wrap gap-2">
        {canDiscoverLan() && (
          <button type="button" disabled={busy}
                  onClick={async () => { setBusy(true); setList(await discoverLanServers()); setBusy(false); }}
                  className="px-3 py-1.5 rounded-lg bg-messenger-hover text-messenger-text text-[13px]">
            {busy ? 'Ищу…' : 'Найти сервер рядом'}
          </button>
        )}
        {current && (
          <button type="button" onClick={() => use('')} className="px-3 py-1.5 rounded-lg bg-messenger-hover text-[13px]">Вернуть основной</button>
        )}
      </div>
      {list && (list.length === 0
        ? <div className="text-[12px] text-messenger-muted">В этой сети серверов не нашлось.</div>
        : list.flatMap(s => (s.urls || []).map(u => (
            <button key={u} type="button" onClick={() => use(u)}
                    className="w-full text-left px-3 py-2 rounded-lg bg-messenger-hover/60 text-[13px]">
              <b>{s.name || 'STORAGE&MESS'}</b> {s.version && <span className="text-messenger-muted">v{s.version}</span>}<br />
              <span className="text-messenger-muted">{u}</span>
            </button>
          ))))}
      <div className="flex gap-2">
        <input value={manual} onChange={e => setManual(e.target.value)} placeholder="https://192.168.1.10"
               className="flex-1 rounded-lg bg-messenger-hover/60 px-3 py-1.5 text-[13px] outline-none" />
        <button type="button" disabled={!/^https?:\/\/\S+$/.test(manual.trim())} onClick={() => use(manual.trim())}
                className="px-3 py-1.5 rounded-lg bg-primary-500 text-white text-[13px] disabled:opacity-40">Подключить</button>
      </div>
    </div>
  );
}
