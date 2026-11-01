// =============================================================
// LoRa в приложении: подключение своего узла Meshtastic и обмен.
//   • APK — по Bluetooth (AndroidBridge.mt*, Java только GATT);
//   • браузер/десктоп — по USB через Web Serial.
// Сообщения чатов уходят кадрами CHAT; принятое отдаётся событием
// 'mesh-message' (как BLE-mesh) — приложение склеит по client_id.
// Защита (подписи, личные, ключи) — seal.ts; свой ключ и книга чужих
// ключей лежат на устройстве (localStorage).
// =============================================================

import { LoraLink, LoraTransport, LinkState } from './link';
import { Sealer, localSealStore, Trust, PeerInfo } from './seal';
import { useChatStore } from '@/store/chat';

export interface LoraStatus { state: LinkState | 'off'; via: 'ble' | 'serial' | null; myNum: number; nodes: number; name?: string }
/** kind: mesh — обычный Meshtastic, smess — наш формат, note — служебная заметка;
 *  revoked — подписано ключом из списка отзыва корпоративного УЦ */
export interface AirMessage { at: number; name: string; text: string; trust?: Trust; direct?: boolean; kind?: 'mesh' | 'smess' | 'note'; revoked?: boolean }

let link: LoraLink | null = null;
let via: LoraStatus['via'] = null;
let status: LoraStatus = { state: 'off', via: null, myNum: 0, nodes: 0 };
const air: AirMessage[] = [];
const listeners = new Set<(s: LoraStatus) => void>();
const airListeners = new Set<(a: AirMessage[]) => void>();

const pushAir = (m: AirMessage) => {
  air.push(m);
  if (air.length > 100) air.shift();
  airListeners.forEach(l => l([...air]));
};
const note = (text: string) => pushAir({ at: Date.now(), name: 'LoRa', text, kind: 'note' });

export const sealer = new Sealer(localSealStore, note);

// Чей ключ подписывал сообщения чатов от имени участника: новый ключ у
// знакомого автора — заметка в эфире (сменил телефон или подделка)
function checkSenderKey(senderId: string, key?: string, name?: string) {
  if (!key) return;
  try {
    const pins = JSON.parse(localStorage.getItem('smess_lora_senders') || '{}');
    const known: string[] = pins[senderId] || [];
    if (known.includes(key)) return;
    if (known.length) note(`У ${name || 'участника'} новое устройство LoRa (ключ ${key}). Если не ждали — сообщение может быть подделкой`);
    pins[senderId] = [...known, key].slice(-4);
    localStorage.setItem('smess_lora_senders', JSON.stringify(pins));
  } catch { /* */ }
}

const setStatus = (s: Partial<LoraStatus>) => {
  status = { ...status, ...s };
  listeners.forEach(l => l(status));
};
export const getLoraStatus = () => status;
export const getAir = () => [...air];
export function onLoraStatus(l: (s: LoraStatus) => void) { listeners.add(l); l(status); return () => listeners.delete(l); }
export function onAir(l: (a: AirMessage[]) => void) { airListeners.add(l); l([...air]); return () => airListeners.delete(l); }

const bridge = () => (window as any).AndroidBridge;
export const hasBle = () => !!bridge()?.mtConnect;
export const hasSerial = () => typeof navigator !== 'undefined' && 'serial' in navigator;

function senderName(chatId: string, userId: string): string {
  const chat = useChatStore.getState().chats.find(c => c.id === chatId) as any;
  const m = chat?.members?.find((x: any) => (x.id || x.user_id) === userId);
  return m?.display_name || m?.username || 'LoRa';
}

function attach(t: LoraTransport, how: 'ble' | 'serial') {
  link?.close();
  via = how;
  link = new LoraLink(t, {
    state: (s, info) => setStatus({ state: s, via, myNum: info.myNum, nodes: info.nodes }),
    chat: m => {
      // Только в свои чаты — эфир общий
      if (!useChatStore.getState().chats.some(c => c.id === m.chatId)) return;
      const name = senderName(m.chatId, m.senderId);
      // Ключ отозван УЦ (уволен, потерял телефон): в чат как настоящее не кладём,
      // показываем в эфире с пометкой
      if (m.revoked) {
        pushAir({ at: Date.now(), name, text: m.text, trust: m.trust, kind: 'smess', revoked: true });
        return;
      }
      checkSenderKey(m.senderId, m.key, name);
      window.dispatchEvent(new CustomEvent('mesh-message', { detail: {
        id: m.clientId, cid: m.clientId, chatId: m.chatId, userId: m.senderId,
        name, text: m.text, ts: Date.now(), hops: 0, via: 'lora', trust: m.trust,
      } }));
    },
    text: m => pushAir({ at: Date.now(), name: m.name, text: m.text, trust: m.trust, direct: m.direct, kind: m.mesh ? 'mesh' : 'smess',
                         ...(m.revoked ? { revoked: true } : {}) }),
    sealedFail: m => note(m.direct
      ? `Личное от ${m.name} не открылось — его ключ ещё не известен, попросил представиться`
      : `Сообщение от ${m.name} не прошло проверку подписи — отброшено`),
  }, sealer);
  setStatus({ state: 'connecting', via, myNum: 0, nodes: 0 });
  link.start();
}

// ── APK: Bluetooth ─────────────────────────────────────────────
const b64 = {
  enc: (u: Uint8Array) => btoa(String.fromCharCode(...u)),
  dec: (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0)),
};

export function scanBle(): void { bridge()?.mtScan?.(); }

export function connectBle(address: string, name?: string): void {
  const br = bridge();
  if (!br?.mtConnect) throw new Error('В этой сборке нет Bluetooth-моста к Meshtastic');
  const handlers: ((d: Uint8Array) => void)[] = [];
  const onData = (e: Event) => { const d = b64.dec((e as CustomEvent).detail?.b64 || ''); handlers.forEach(h => h(d)); };
  const onState = (e: Event) => { if ((e as CustomEvent).detail?.state === 'disconnected') setStatus({ state: 'closed' }); };
  window.addEventListener('mt-fromradio', onData);
  window.addEventListener('mt-state', onState);
  attach({
    framed: true,
    write: d => { br.mtWrite(b64.enc(d)); },
    onData: cb => { handlers.push(cb); },
    close: () => { window.removeEventListener('mt-fromradio', onData); window.removeEventListener('mt-state', onState); br.mtDisconnect?.(); },
  }, 'ble');
  setStatus({ name });
  br.mtConnect(address);
  try { localStorage.setItem('lora_ble_addr', address); localStorage.setItem('lora_ble_name', name || ''); } catch { /* */ }
}

// ── браузер/десктоп: USB (Web Serial) ──────────────────────────
export async function connectSerial(): Promise<void> {
  const serial = (navigator as any).serial;
  if (!serial) throw new Error('Браузер не умеет Web Serial (нужен Chrome/Edge или наш десктоп)');
  const port = await serial.requestPort();
  await port.open({ baudRate: 115200 });
  const writer = port.writable.getWriter();
  const handlers: ((d: Uint8Array) => void)[] = [];
  let reading = true;
  (async () => {
    const reader = port.readable.getReader();
    try {
      while (reading) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) handlers.forEach(h => h(value));
      }
    } catch { /* порт отключили */ } finally { reader.releaseLock(); setStatus({ state: 'closed' }); }
  })();
  attach({
    framed: false,
    write: d => writer.write(d),
    onData: cb => { handlers.push(cb); },
    close: () => { reading = false; writer.releaseLock(); port.close().catch(() => {}); },
  }, 'serial');
}

export function disconnectLora() { link?.close(); link = null; setStatus({ state: 'off', via: null }); }

/** Отправка сообщения чата в LoRa, если узел подключён. true — ушло. */
export async function loraSendChat(chatId: string, senderId: string, clientId: string, text: string): Promise<boolean> {
  if (!link || link.state !== 'ready') return false;
  try { await link.sendChat({ chatId, senderId, clientId, text }); return true; } catch { return false; }
}

export async function loraSendAir(text: string): Promise<boolean> {
  if (!link || link.state !== 'ready') return false;
  try { await link.sendText(text); return true; } catch { return false; }
}

/** Наш формат: всем — с подписью, узлу — лично и зашифровано. Ошибка — текстом. */
export async function loraSendSmess(text: string, toNode?: number): Promise<string | null> {
  if (!link || link.state !== 'ready') return 'Узел не подключён';
  try { await link.sendSmeshText(text, toNode); return null; } catch (e) { return (e as Error).message; }
}

export const loraSelfId = () => sealer.id();
export const loraPeers = (): PeerInfo[] => sealer.peers();
export const loraTrust = (node: number) => sealer.trust(node);
export const loraProtected = () => sealer.active;
/** Свой ключ в списке отзыва корпоративного УЦ. */
export const loraSelfRevoked = () => sealer.selfRevoked;

/** APK: переподключиться к последнему узлу при старте. */
export function autoReconnect() {
  try {
    const a = localStorage.getItem('lora_ble_addr');
    if (a && hasBle() && !link) connectBle(a, localStorage.getItem('lora_ble_name') || undefined);
  } catch { /* */ }
}
