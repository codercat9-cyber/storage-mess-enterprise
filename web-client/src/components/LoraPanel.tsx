import { useEffect, useState } from 'react';
import {
  onLoraStatus, onAir, LoraStatus, AirMessage, hasBle, hasSerial, scanBle, connectBle, connectSerial,
  disconnectLora, loraSendAir, loraSendSmess, loraSelfId, loraPeers, loraTrust, loraProtected,
} from '@/lib/lora';
import { useEnterprise, toMs, trustNewCa } from '@/lib/enterprise';

const MARK: Record<string, string> = { signed: '✔', private: '🔒' };
const markTitle = (m: AirMessage) =>
  m.revoked ? 'ключ отправителя отозван корпоративным УЦ — автору не доверять' :
  m.trust === 'private' ? 'лично, зашифровано' : m.trust === 'signed' ? 'подпись верна' :
  m.kind === 'mesh' ? 'обычное сообщение Meshtastic, без подписи' : 'без подписи — автора подделать может кто угодно';

/** Настройки → LoRa: свой узел Meshtastic, эфир, аварийная связь без интернета. */
export default function LoraPanel() {
  const [st, setSt] = useState<LoraStatus | null>(null);
  const [air, setAir] = useState<AirMessage[]>([]);
  const [found, setFound] = useState<{ address: string; name: string; rssi: number }[]>([]);
  const [scanning, setScanning] = useState(false);
  const [note, setNote] = useState('');
  const [say, setSay] = useState('');
  const [to, setTo] = useState('smess'); // smess — всем с подписью, mesh — как Meshtastic, иначе номер узла
  const [, setTick] = useState(0);
  const ent = useEnterprise();
  const corp = !!ent.info?.enabled;
  const domain = ent.info?.domain || '';
  const certTill = ent.cert ? toMs(ent.cert.expires_at) : NaN;

  useEffect(() => {
    const u1 = onLoraStatus(setSt);
    const u2 = onAir(a => { setAir(a); setTick(t => t + 1); });
    const onScan = (e: Event) => {
      const d = (e as CustomEvent).detail;
      setFound(list => (list.some(x => x.address === d.address) ? list : [...list, d]));
    };
    const onState = (e: Event) => {
      const s = (e as CustomEvent).detail?.state;
      if (s === 'need-permission') setNote('Разрешите Bluetooth и нажмите «Найти» ещё раз');
      if (s === 'bluetooth-off') setNote('Включите Bluetooth');
      if (s === 'no-service') setNote('Это не узел Meshtastic');
      if (s !== 'scanning') setScanning(false);
    };
    window.addEventListener('mt-scan', onScan);
    window.addEventListener('mt-state', onState);
    return () => { u1(); u2(); window.removeEventListener('mt-scan', onScan); window.removeEventListener('mt-state', onState); };
  }, []);

  const state = st?.state || 'off';
  const label = state === 'ready'
    ? `на связи · узел !${(st?.myNum || 0).toString(16)} · в сети ${st?.nodes} узл.`
    : state === 'connecting' ? 'подключаюсь… (при первом подключении узел попросит PIN с экрана)'
    : state === 'closed' ? 'отключён' : 'не подключён';

  return (
    <div className="px-5 py-4 space-y-3">
      <div className="text-[16px] font-medium text-messenger-text">📡 LoRa (Meshtastic)</div>
      <div className="text-[13px] text-messenger-muted leading-snug">
        Связь без интернета и сотовой сети на километры: подключите свой узел Meshtastic. Когда сервер недоступен,
        сообщения чатов уходят в эфир, а пришедшее по эфиру появляется в чатах.
      </div>
      {loraProtected() ? (
        <div className="text-[12px] rounded-lg bg-emerald-500/10 text-emerald-300 px-3 py-2 leading-snug">
          Сообщения всем подписаны — автора не подделать, но слышат их все узлы в радиусе. Личные — узлу, чей ключ известен, —
          зашифрованы: прочтёт только он. Ваш ключ: <b>{loraSelfId() || 'появится при подключении'}</b>
        </div>
      ) : (
        <div className="text-[12px] rounded-lg bg-orange-500/10 text-orange-300 px-3 py-2 leading-snug">
          Канал общий: без шифрования сообщения в эфире слышат все узлы в радиусе. Это аварийная связь — личное лучше не писать.
        </div>
      )}
      {/* Корпоративный УЦ: подписал ли он ключ этого устройства и не отозвал ли */}
      {corp && ent.selfRevoked && (
        <div className="text-[12px] rounded-lg bg-red-500/10 text-red-300 px-3 py-2 leading-snug">
          ⛔ Ключ этого устройства отозван УЦ{domain ? ` ${domain}` : ''}: остальные увидят ваши сообщения в эфире
          с пометкой «ключ отозван». Новый ключ выдаётся после входа.
        </div>
      )}
      {corp && ent.cert && !ent.selfRevoked && (
        <div className="text-[12px] text-emerald-300" title={`ключ ${ent.cert.ed_pub.slice(0, 16)}…, учётка ${ent.cert.username}`}>
          🏢 Устройство подтверждено УЦ{domain ? ` ${domain}` : ''}
          {isFinite(certTill) && <span className="text-messenger-muted"> · до {new Date(certTill).toLocaleDateString('ru-RU')}</span>}
        </div>
      )}
      {corp && ent.caMismatch && (
        <div className="text-[12px] text-orange-300 space-y-1">
          <div>⚠ Сервер назвал другой ключ УЦ, чем при первом знакомстве — список отзыва и сертификаты не принимаются.</div>
          <button onClick={() => {
            if (window.confirm('Принимать новый ключ УЦ, только если ИТ-служба предупредила о его смене. Иначе это может быть подмена сервера. Принять?')) {
              trustNewCa().catch(() => {});
            }
          }} className="px-2 py-1 rounded-lg bg-orange-500/20 text-orange-300 text-[12px]">новый ключ УЦ — принять?</button>
        </div>
      )}
      {corp && ent.error && !ent.caMismatch && <div className="text-[12px] text-orange-300">⚠ {ent.error}</div>}
      {corp && ent.crlSeq !== null && (
        <div className="text-[11px] text-messenger-muted">
          Список отзыва УЦ №{ent.crlSeq}: ключей отозвано {ent.revokedCount}
          {ent.crlAt ? `, получен ${new Date(ent.crlAt).toLocaleTimeString('ru-RU')}` : ''}
        </div>
      )}
      <div className="text-[14px]">Узел: <b>{label}</b></div>

      <div className="flex flex-wrap gap-2">
        {hasBle() && state !== 'ready' && (
          <button onClick={() => { setFound([]); setNote(''); setScanning(true); scanBle(); }}
                  className="px-3 py-2 rounded-xl bg-primary-500 text-white text-sm">{scanning ? 'Ищу…' : 'Найти узел по Bluetooth'}</button>
        )}
        {hasSerial() && state !== 'ready' && (
          <button onClick={() => connectSerial().catch(e => setNote(String(e?.message || e)))}
                  className="px-3 py-2 rounded-xl bg-primary-500 text-white text-sm">Подключить по USB</button>
        )}
        {state !== 'off' && (
          <button onClick={disconnectLora} className="px-3 py-2 rounded-xl bg-messenger-hover text-sm">Отключить</button>
        )}
        {!hasBle() && !hasSerial() && <div className="text-[13px] text-messenger-muted">Здесь подключить узел нельзя: нужен телефон с нашим приложением, Chrome или десктоп.</div>}
      </div>
      {note && <div className="text-[13px] text-orange-300">{note}</div>}

      {found.length > 0 && state !== 'ready' && (
        <div className="space-y-1">
          {found.map(d => (
            <button key={d.address} onClick={() => { connectBle(d.address, d.name); setFound([]); }}
                    className="w-full text-left px-3 py-2 rounded-lg bg-messenger-hover/60 text-sm flex justify-between">
              <span>{d.name}</span><span className="text-messenger-muted">{d.rssi} dBm</span>
            </button>
          ))}
        </div>
      )}

      {state === 'ready' && (
        <div className="space-y-2">
          <div className="text-[13px] text-messenger-muted">Эфир (общий канал Meshtastic):</div>
          <div className="max-h-48 overflow-y-auto space-y-1 text-[13px]">
            {air.length === 0 && <div className="text-messenger-muted">пока тихо</div>}
            {air.slice(-30).map((m, i) => m.kind === 'note' ? (
              <div key={i} className="text-orange-300"><span className="text-messenger-muted">{new Date(m.at).toLocaleTimeString('ru-RU')} </span>⚠ {m.text}</div>
            ) : (
              <div key={i}><span className="text-messenger-muted">{new Date(m.at).toLocaleTimeString('ru-RU')} </span>
                {m.revoked ? (
                  <span title={markTitle(m)} className="text-red-400 text-[12px]">⛔ ключ отозван УЦ</span>
                ) : (
                  <span title={markTitle(m)} className={m.trust === 'none' && m.kind !== 'mesh' ? 'text-orange-300' : 'text-emerald-300'}>
                    {MARK[m.trust || ''] || (m.kind === 'mesh' ? '' : '⚠')}
                  </span>
                )}{' '}<b className={m.revoked ? 'line-through decoration-red-400/60' : ''}>{m.name}{m.direct ? ' (лично)' : ''}:</b> {m.text}</div>
            ))}
          </div>
          <div className="flex gap-2">
            <select value={to} onChange={e => setTo(e.target.value)} className="rounded-lg bg-messenger-hover/60 px-2 py-2 text-sm outline-none max-w-[40%]">
              {loraProtected() && <option value="smess">Всем, с подписью</option>}
              <option value="mesh">Всем (Meshtastic)</option>
              {loraPeers().filter(p => !p.changed && !p.revoked).map(p => (
                <option key={p.node} value={String(p.node)}>🔒 !{p.node.toString(16).padStart(8, '0')}</option>
              ))}
            </select>
            <input value={say} onChange={e => setSay(e.target.value)} maxLength={to === 'mesh' ? 200 : 600} placeholder="Сказать в эфир"
                   className="flex-1 min-w-0 rounded-lg bg-messenger-hover/60 px-3 py-2 text-sm outline-none" />
            <button disabled={!say.trim()} onClick={async () => {
              const t = say.trim();
              if (to === 'mesh') { if (await loraSendAir(t)) setSay(''); return; }
              const err = await loraSendSmess(t, to === 'smess' ? undefined : Number(to));
              if (err) setNote(err); else { setSay(''); setNote(''); }
            }} className="px-3 py-2 rounded-xl bg-primary-500 text-white text-sm disabled:opacity-40">Отправить</button>
          </div>
          {loraPeers().length > 0 && (
            <div className="space-y-1 text-[13px]">
              <div className="text-messenger-muted">Ключи собеседников (запоминаются при первой встрече):</div>
              {loraPeers().map(p => (
                <div key={p.node} className="flex items-center justify-between gap-2">
                  <span>!{p.node.toString(16).padStart(8, '0')} · <span className="text-messenger-muted">{p.id}</span>
                    {p.revoked && <span className="text-red-400"> · ⛔ ключ отозван УЦ</span>}</span>
                  {p.changed && (
                    <button onClick={() => {
                      if (window.confirm(`Узел назвал другой ключ (${p.changed}). Принимать, только если собеседник сменил устройство. Принять?`)) { loraTrust(p.node); setTick(t => t + 1); }
                    }} className="px-2 py-1 rounded-lg bg-orange-500/20 text-orange-300 text-[12px]">новый ключ — принять?</button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
