// =============================================================
// Конверт STORAGE&MESS поверх Meshtastic (порт PRIVATE_APP = 256).
// Порт core/smesh.c из smess-lora — байт в байт, чтобы телефон, шлюз и
// плата STM32 понимали друг друга.
//
//   0 магия 'S' · 1 версия|тип · 2..5 id (LE) · 6..11 от · 12..17 кому ·
//   18 номер куска|всего−1 · 19.. тело (до 214 байт)
//
// Типы: 1 TEXT — просто текст (так шлёт плата STM32);
//       2 CHAT — сообщение конкретного чата мессенджера (см. encodeChatBody).
// =============================================================

export const SMESH_MAGIC = 0x53;
export const SMESH_VERSION = 1;
export const SMESH_HDR = 19;
export const SMESH_FRAG_BODY = 233 - SMESH_HDR; // 214
export const SMESH_MAX_FRAGS = 8;
export const SMESH_T_TEXT = 1;
export const SMESH_T_CHAT = 2;
export const SMESH_ALL = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

export interface SmeshFrame {
  type: number; msgId: number; from: Uint8Array; to: Uint8Array;
  idx: number; total: number; body: Uint8Array;
}

export function addrFromNode(n: number): Uint8Array {
  return new Uint8Array([0, 0, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}
export function nodeFromAddr(a: Uint8Array): number {
  return ((a[2] << 24) | (a[3] << 16) | (a[4] << 8) | a[5]) >>> 0;
}
export const addrEq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
export const addrHex = (a: Uint8Array) => Array.from(a, x => x.toString(16).padStart(2, '0')).join('');

export function fragCount(len: number): number {
  const n = len ? Math.ceil(len / SMESH_FRAG_BODY) : 1;
  return n <= SMESH_MAX_FRAGS ? n : 0;
}

export function encodeFrame(f: SmeshFrame): Uint8Array {
  if (f.total < 1 || f.total > 16 || f.idx >= f.total || f.body.length > SMESH_FRAG_BODY) throw new Error('bad smesh frame');
  const out = new Uint8Array(SMESH_HDR + f.body.length);
  out[0] = SMESH_MAGIC;
  out[1] = (SMESH_VERSION << 4) | (f.type & 0x0f);
  for (let i = 0; i < 4; i++) out[2 + i] = (f.msgId >>> (8 * i)) & 0xff;
  out.set(f.from, 6);
  out.set(f.to, 12);
  out[18] = (f.idx << 4) | (f.total - 1);
  out.set(f.body, SMESH_HDR);
  return out;
}

export function decodeFrame(d: Uint8Array): SmeshFrame | null {
  if (d.length < SMESH_HDR || d[0] !== SMESH_MAGIC || d[1] >> 4 !== SMESH_VERSION) return null;
  const f: SmeshFrame = {
    type: d[1] & 0x0f,
    msgId: (d[2] | (d[3] << 8) | (d[4] << 16) | (d[5] << 24)) >>> 0,
    from: d.slice(6, 12), to: d.slice(12, 18),
    idx: d[18] >> 4, total: (d[18] & 0x0f) + 1,
    body: d.slice(SMESH_HDR),
  };
  return f.idx < f.total && f.body.length <= SMESH_FRAG_BODY ? f : null;
}

/** Нарезка тела на кадры. */
export function split(type: number, msgId: number, from: Uint8Array, to: Uint8Array, body: Uint8Array): Uint8Array[] {
  const total = fragCount(body.length);
  if (!total) throw new Error(`сообщение длиннее ${SMESH_MAX_FRAGS * SMESH_FRAG_BODY} байт`);
  const out: Uint8Array[] = [];
  for (let i = 0; i < total; i++) {
    out.push(encodeFrame({ type, msgId, from, to, idx: i, total,
                           body: body.subarray(i * SMESH_FRAG_BODY, Math.min(body.length, (i + 1) * SMESH_FRAG_BODY)) }));
  }
  return out;
}

/** Сборка кусков и отсев повторов (как smesh_rx в C). */
export class Reassembler {
  private slots = new Map<string, { started: number; total: number; type: number; parts: (Uint8Array | null)[] }>();
  private seen: string[] = [];
  constructor(private timeoutMs = 120_000, private seenMax = 64) {}

  /** Собранное тело, null — ждём ещё, undefined — повтор/порча. */
  push(f: SmeshFrame, now = Date.now()): { type: number; body: Uint8Array } | null | undefined {
    const key = addrHex(f.from) + ':' + f.msgId;
    if (this.seen.includes(key) || f.total > SMESH_MAX_FRAGS) return undefined;
    const last = f.idx === f.total - 1;
    if (!last && f.body.length !== SMESH_FRAG_BODY) return undefined;
    for (const [k, s] of this.slots) if (now - s.started > this.timeoutMs) this.slots.delete(k);
    let slot = this.slots.get(key);
    if (!slot) { slot = { started: now, total: f.total, type: f.type, parts: Array(f.total).fill(null) }; this.slots.set(key, slot); }
    if (slot.total !== f.total) return undefined;
    slot.parts[f.idx] = f.body;
    if (slot.parts.some(p => !p)) return null;
    this.slots.delete(key);
    this.seen.push(key);
    if (this.seen.length > this.seenMax) this.seen.shift();
    const len = slot.parts.reduce((n, p) => n + p!.length, 0);
    const body = new Uint8Array(len);
    let off = 0;
    for (const p of slot.parts) { body.set(p!, off); off += p!.length; }
    return { type: slot.type, body };
  }
}

// ── тип CHAT: сообщение конкретного чата мессенджера ──────────────
//   0..15 id чата (UUID) · 16..31 id отправителя (UUID) ·
//   32..37 время client_id (мс, 48 бит) · 38 длина хвоста · хвост client_id (ASCII) · текст UTF-8
// client_id восстанавливается целиком — сервер и получатели склеят копии.

const uuidToBytes = (u: string) => {
  const h = u.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(h)) throw new Error('не UUID: ' + u);
  return Uint8Array.from(h.match(/../g)!.map(x => parseInt(x, 16)));
};
const bytesToUuid = (b: Uint8Array) => {
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

export interface ChatBody { chatId: string; senderId: string; clientId: string; text: string }

export function encodeChatBody(m: ChatBody): Uint8Array {
  const cm = /^pending-(\d+)-([0-9a-z]{1,32})$/i.exec(m.clientId);
  const ts = cm ? Number(cm[1]) : Date.now();
  const tail = new TextEncoder().encode(cm ? cm[2] : m.clientId.slice(0, 32));
  const text = new TextEncoder().encode(m.text);
  const out = new Uint8Array(39 + tail.length + text.length);
  out.set(uuidToBytes(m.chatId), 0);
  out.set(uuidToBytes(m.senderId), 16);
  for (let i = 0; i < 6; i++) out[32 + i] = Math.floor(ts / 2 ** (8 * (5 - i))) & 0xff;
  out[38] = tail.length;
  out.set(tail, 39);
  out.set(text, 39 + tail.length);
  return out;
}

export function decodeChatBody(b: Uint8Array): ChatBody | null {
  if (b.length < 39 || b.length < 39 + b[38]) return null;
  let ts = 0;
  for (let i = 0; i < 6; i++) ts = ts * 256 + b[32 + i];
  const tail = new TextDecoder().decode(b.subarray(39, 39 + b[38]));
  return {
    chatId: bytesToUuid(b.subarray(0, 16)),
    senderId: bytesToUuid(b.subarray(16, 32)),
    clientId: `pending-${ts}-${tail}`,
    text: new TextDecoder().decode(b.subarray(39 + b[38])),
  };
}
