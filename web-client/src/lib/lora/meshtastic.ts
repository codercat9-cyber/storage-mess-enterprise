// =============================================================
// Протокол Meshtastic: минимальный protobuf + Serial API (кадры 0x94 0xC3).
//
// Порт core/pb.c и core/mt.c из smess-lora (клиент для STM32): телефон,
// десктоп и шлюз на сервере говорят ровно на том же языке, что и плата.
// Номера полей — mesh.proto; совместимость проверяется против эталонной
// библиотеки Meshtastic и против C-клиента (scripts/lora-test.cjs).
//
// По BLE кадров 0x94C3 нет — там голый protobuf в характеристиках
// toRadio/fromRadio; функции encode*/decode* годятся для обоих путей.
// =============================================================

export const MT_START1 = 0x94;
export const MT_START2 = 0xc3;
export const MT_MAX_PAYLOAD = 512;
export const MT_DATA_PAYLOAD_LEN = 233;
export const MT_BROADCAST = 0xffffffff;
export const MT_PORT_TEXT = 1;
export const MT_PORT_PRIVATE = 256;

// UUID сервиса и характеристик Meshtastic по BLE
export const MT_BLE_SERVICE = '6ba1b218-15a8-461f-9fa8-5dcae273eafd';
export const MT_BLE_TORADIO = 'f75c76d2-129e-4dad-a1dd-7866124401e7';
export const MT_BLE_FROMRADIO = '2c55e69e-4993-11ed-b878-0242ac120002';
export const MT_BLE_FROMNUM = 'ed9da18c-a800-4f66-a670-aa7547e34453';

// ── protobuf ──────────────────────────────────────────────────

class Writer {
  private buf: number[] = [];
  varint(v: number | bigint) {
    let x = BigInt.asUintN(64, BigInt(v));
    do {
      let b = Number(x & 0x7fn);
      x >>= 7n;
      if (x) b |= 0x80;
      this.buf.push(b);
    } while (x);
  }
  tag(field: number, wt: number) { this.varint((field << 3) | wt); }
  uint(field: number, v: number) { if (v) { this.tag(field, 0); this.varint(v); } }
  fixed32(field: number, v: number) {
    if (!v) return;
    this.tag(field, 5);
    for (let i = 0; i < 4; i++) this.buf.push((v >>> (8 * i)) & 0xff);
  }
  bytes(field: number, d: Uint8Array) { this.tag(field, 2); this.varint(d.length); for (const b of d) this.buf.push(b); }
  done(): Uint8Array { return Uint8Array.from(this.buf); }
}

class Reader {
  p = 0;
  err = false;
  constructor(private d: Uint8Array) {}
  get more() { return !this.err && this.p < this.d.length; }
  varint(): bigint {
    let v = 0n;
    for (let shift = 0n; shift < 64n; shift += 7n) {
      if (this.p >= this.d.length) { this.err = true; return 0n; }
      const b = this.d[this.p++];
      v |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return v;
    }
    this.err = true;
    return 0n;
  }
  u32(): number { return Number(BigInt.asUintN(32, this.varint())); }
  i32(): number { return Number(BigInt.asIntN(32, this.varint())); }
  fixed32(): number {
    if (this.d.length - this.p < 4) { this.err = true; this.p = this.d.length; return 0; }
    const v = (this.d[this.p] | (this.d[this.p + 1] << 8) | (this.d[this.p + 2] << 16) | (this.d[this.p + 3] << 24)) >>> 0;
    this.p += 4;
    return v;
  }
  bytes(): Uint8Array {
    const n = Number(this.varint());
    if (this.err || n > this.d.length - this.p) { this.err = true; this.p = this.d.length; return new Uint8Array(); }
    const out = this.d.subarray(this.p, this.p + n);
    this.p += n;
    return out;
  }
  next(): [number, number] | null {
    if (!this.more) return null;
    const t = this.u32();
    if (this.err) return null;
    const field = t >>> 3;
    if (!field) { this.err = true; return null; }
    return [field, t & 7];
  }
  skip(wt: number) {
    if (wt === 0) this.varint();
    else if (wt === 5) this.fixed32();
    else if (wt === 2) this.bytes();
    else if (wt === 1) { if (this.d.length - this.p < 8) this.err = true; this.p = Math.min(this.p + 8, this.d.length); }
    else { this.err = true; this.p = this.d.length; }
  }
}

const f32 = (v: number) => new Float32Array(new Uint32Array([v]).buffer)[0];
const utf8 = new TextDecoder();

// ── сообщения ─────────────────────────────────────────────────

export interface MtPacket {
  from: number; to: number; id: number; rxTime: number;
  channel: number; hopLimit: number; hopStart: number;
  wantAck: boolean; encrypted: boolean; hasDecoded: boolean;
  rxSnr: number; rxRssi: number;
  portnum: number; requestId: number;
  payload: Uint8Array;
}

export interface MtNode {
  num: number; id: string; longName: string; shortName: string;
  snr: number; lastHeard: number; hopsAway: number;
}

export type MtFromRadio =
  | { kind: 'packet'; id: number; packet: MtPacket }
  | { kind: 'myInfo'; id: number; myNodeNum: number }
  | { kind: 'nodeInfo'; id: number; node: MtNode }
  | { kind: 'configComplete'; id: number; configId: number }
  | { kind: 'rebooted'; id: number }
  | { kind: 'queueStatus'; id: number; res: number; free: number; maxlen: number; meshPacketId: number }
  | { kind: 'other'; id: number };

function decData(d: Uint8Array, p: MtPacket): boolean {
  const r = new Reader(d);
  let f;
  while ((f = r.next())) {
    const [n, wt] = f;
    if (n === 1 && wt === 0) p.portnum = r.u32();
    else if (n === 2 && wt === 2) p.payload = r.bytes();
    else if (n === 6 && wt === 5) p.requestId = r.fixed32();
    else r.skip(wt);
  }
  return !r.err;
}

function decPacket(d: Uint8Array): MtPacket | null {
  const p: MtPacket = { from: 0, to: 0, id: 0, rxTime: 0, channel: 0, hopLimit: 0, hopStart: 0, wantAck: false,
                        encrypted: false, hasDecoded: false, rxSnr: 0, rxRssi: 0, portnum: 0, requestId: 0, payload: new Uint8Array() };
  const r = new Reader(d);
  let f;
  while ((f = r.next())) {
    const [n, wt] = f;
    const want = (t: number) => { if (wt !== t) { r.skip(wt); return false; } return true; };
    switch (n) {
      case 1: if (want(5)) p.from = r.fixed32(); break;
      case 2: if (want(5)) p.to = r.fixed32(); break;
      case 3: if (want(0)) p.channel = r.u32(); break;
      case 4: if (want(2)) p.hasDecoded = decData(r.bytes(), p); break;
      case 5: if (want(2)) { p.encrypted = true; r.bytes(); } break;
      case 6: if (want(5)) p.id = r.fixed32(); break;
      case 7: if (want(5)) p.rxTime = r.fixed32(); break;
      case 8: if (want(5)) p.rxSnr = f32(r.fixed32()); break;
      case 9: if (want(0)) p.hopLimit = r.u32(); break;
      case 10: if (want(0)) p.wantAck = r.varint() !== 0n; break;
      case 12: if (want(0)) p.rxRssi = r.i32(); break;
      case 15: if (want(0)) p.hopStart = r.u32(); break;
      default: r.skip(wt);
    }
  }
  return r.err ? null : p;
}

function decNode(d: Uint8Array): MtNode | null {
  const nd: MtNode = { num: 0, id: '', longName: '', shortName: '', snr: 0, lastHeard: 0, hopsAway: 0 };
  const r = new Reader(d);
  let f;
  while ((f = r.next())) {
    const [n, wt] = f;
    if (n === 1 && wt === 0) nd.num = r.u32();
    else if (n === 2 && wt === 2) {
      const u = new Reader(r.bytes());
      let g;
      while ((g = u.next())) {
        const [un, uwt] = g;
        if (uwt === 2 && un >= 1 && un <= 3) {
          const s = utf8.decode(u.bytes());
          if (un === 1) nd.id = s; else if (un === 2) nd.longName = s; else nd.shortName = s;
        } else u.skip(uwt);
      }
    } else if (n === 4 && wt === 5) nd.snr = f32(r.fixed32());
    else if (n === 5 && wt === 5) nd.lastHeard = r.fixed32();
    else if (n === 9 && wt === 0) nd.hopsAway = r.u32();
    else r.skip(wt);
  }
  return r.err ? null : nd;
}

export function decodeFromRadio(buf: Uint8Array): MtFromRadio | null {
  const r = new Reader(buf);
  let id = 0;
  let out: MtFromRadio = { kind: 'other', id: 0 };
  let f;
  while ((f = r.next())) {
    const [n, wt] = f;
    if (n === 1 && wt === 0) id = r.u32();
    else if (n === 2 && wt === 2) { const p = decPacket(r.bytes()); if (p) out = { kind: 'packet', id, packet: p }; }
    else if (n === 3 && wt === 2) {
      const m = new Reader(r.bytes()); let num = 0; let g;
      while ((g = m.next())) { if (g[0] === 1 && g[1] === 0) num = m.u32(); else m.skip(g[1]); }
      if (!m.err) out = { kind: 'myInfo', id, myNodeNum: num };
    } else if (n === 4 && wt === 2) { const nd = decNode(r.bytes()); if (nd) out = { kind: 'nodeInfo', id, node: nd }; }
    else if (n === 7 && wt === 0) out = { kind: 'configComplete', id, configId: r.u32() };
    else if (n === 8 && wt === 0) { r.varint(); out = { kind: 'rebooted', id }; }
    else if (n === 11 && wt === 2) {
      const q = new Reader(r.bytes()); const v = { res: 0, free: 0, maxlen: 0, meshPacketId: 0 }; let g;
      while ((g = q.next())) {
        if (g[1] !== 0) { q.skip(g[1]); continue; }
        if (g[0] === 1) v.res = q.i32(); else if (g[0] === 2) v.free = q.u32();
        else if (g[0] === 3) v.maxlen = q.u32(); else if (g[0] === 4) v.meshPacketId = q.u32(); else q.varint();
      }
      if (!q.err) out = { kind: 'queueStatus', id, ...v };
    } else r.skip(wt);
  }
  if (r.err) return null;
  out.id = id;
  return out;
}

// ToRadio — голый protobuf (для BLE); frame() — то же в кадре 0x94C3 (для UART/USB)
export function encodeWantConfig(configId: number): Uint8Array {
  const w = new Writer(); w.uint(3, configId >>> 0); return w.done();
}

export function encodeHeartbeat(nonce: number): Uint8Array {
  const h = new Writer(); h.uint(1, nonce >>> 0);
  const w = new Writer(); w.bytes(7, h.done()); return w.done();
}

export interface MtSend {
  to: number; channel?: number; portnum: number; payload: Uint8Array;
  id: number; hopLimit?: number; wantAck?: boolean;
}

export function encodeSend(s: MtSend): Uint8Array {
  if (s.payload.length > MT_DATA_PAYLOAD_LEN) throw new Error('payload > 233');
  if (!s.id) throw new Error('id must be non-zero');
  const d = new Writer(); d.uint(1, s.portnum); if (s.payload.length) d.bytes(2, s.payload);
  const p = new Writer();
  p.fixed32(2, s.to >>> 0); p.uint(3, s.channel || 0); p.bytes(4, d.done()); p.fixed32(6, s.id >>> 0);
  p.uint(9, s.hopLimit || 0); p.uint(10, s.wantAck ? 1 : 0);
  const w = new Writer(); w.bytes(1, p.done()); return w.done();
}

export function frame(body: Uint8Array): Uint8Array {
  if (body.length > MT_MAX_PAYLOAD) throw new Error('frame > 512');
  const out = new Uint8Array(body.length + 4);
  out[0] = MT_START1; out[1] = MT_START2; out[2] = body.length >> 8; out[3] = body.length & 0xff;
  out.set(body, 4);
  return out;
}

export const WAKE = new Uint8Array(32).fill(MT_START2);

/** Разбор потока UART по байту; байты вне кадров — журнал прошивки. */
export class FrameParser {
  private state = 0; private need = 0; private got = 0;
  private buf = new Uint8Array(MT_MAX_PAYLOAD);
  constructor(private onFrame: (f: Uint8Array) => void, private onLog?: (b: number) => void) {}
  push(data: Uint8Array) { for (const b of data) this.feed(b); }
  private feed(b: number): void {
    switch (this.state) {
      case 0: if (b === MT_START1) this.state = 1; else this.onLog?.(b); return;
      case 1:
        if (b === MT_START2) { this.state = 2; return; }
        this.state = 0; this.onLog?.(MT_START1); this.feed(b); return;
      case 2: this.need = b << 8; this.state = 3; return;
      case 3:
        this.need |= b; this.got = 0;
        this.state = this.need === 0 || this.need > MT_MAX_PAYLOAD ? 0 : 4; return;
      default:
        this.buf[this.got++] = b;
        if (this.got < this.need) return;
        this.state = 0;
        this.onFrame(this.buf.slice(0, this.need));
    }
  }
}
