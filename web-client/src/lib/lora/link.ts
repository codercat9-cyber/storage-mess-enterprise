// =============================================================
// Звено «приложение ↔ свой узел Meshtastic» — поверх любого канала.
//
// Каналы:  BLE в APK (голый protobuf в характеристиках, Java делает
//          только GATT — см. MeshtasticBle.java) · USB/Web Serial в
//          браузере и на десктопе (кадры 0x94C3).
// Звено держит подключение (want_config, сердцебиение), список узлов,
// шлёт сообщения чата кадрами CHAT и принимает их. Принятое уходит
// приложению тем же событием, что и BLE-mesh ('mesh-message') — с
// client_id, так что копии из LoRa склеиваются с серверными.
//
// Защита содержимого — модуль seal.ts: подпись сообщений «всем»,
// шифрование личных, обмен ключами служебными кадрами. В открытой сборке
// на его месте заглушка — тогда всё идёт как есть, под общим ключом
// канала Meshtastic, и интерфейс об этом предупреждает.
// =============================================================

import {
  FrameParser, decodeFromRadio, encodeWantConfig, encodeHeartbeat, encodeSend, frame, WAKE,
  MT_BROADCAST, MT_PORT_TEXT, MT_PORT_PRIVATE, MtPacket,
} from './meshtastic';
import {
  split, decodeFrame, encodeFrame, Reassembler, SMESH_ALL, SMESH_T_CHAT, SMESH_T_TEXT, addrEq, addrFromNode,
  encodeChatBody, decodeChatBody, ChatBody,
} from './smesh';
import { Sealer, SMESH_T_CTRL, SMESH_T_SEALED, Trust } from './seal';

export interface LoraTransport {
  /** true — канал сам режет на сообщения (BLE), false — поток байт (UART) */
  readonly framed: boolean;
  write(data: Uint8Array): Promise<void> | void;
  onData(cb: (data: Uint8Array) => void): void;
  close(): void;
}

export type LinkState = 'connecting' | 'ready' | 'closed';

export interface LinkEvents {
  state?: (s: LinkState, info: { myNum: number; nodes: number }) => void;
  /** revoked — ключ отправителя в списке отзыва корпоративного УЦ */
  chat?: (m: ChatBody & { fromNode: number; via: 'lora'; trust: Trust; key?: string; revoked?: boolean }) => void;
  /** direct — пришло лично нам (а не всем); mesh — обычный текст Meshtastic */
  text?: (m: { fromNode: number; name: string; text: string; trust: Trust; key?: string; direct?: boolean; mesh?: boolean; revoked?: boolean }) => void;
  /** защищённое не открылось (чужой ключ, порча) */
  sealedFail?: (m: { fromNode: number; name: string; direct: boolean }) => void;
}

const rand32 = () => (crypto.getRandomValues(new Uint32Array(1))[0] || 1) >>> 0;
const FRAME_GAP_MS = 1500; // кадр LongFast в эфире ~1 с; без паузы куски копятся в очереди узла

export class LoraLink {
  myNum = 0;
  nodes = new Map<number, { name: string; lastHeard: number }>();
  state: LinkState = 'connecting';
  channel = 0;
  private cfgId = 0;
  private parser: FrameParser;
  private rx = new Reassembler();
  private hb: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setInterval> | null = null;
  private lastFrame = 0;
  private sendChain: Promise<void> = Promise.resolve();
  private ctrl: ReturnType<typeof setInterval> | null = null;

  constructor(private t: LoraTransport, private ev: LinkEvents = {}, readonly sealer: Sealer) {
    this.parser = new FrameParser(f => this.onFromRadio(f));
    t.onData(d => (t.framed ? this.onFromRadio(d) : this.parser.push(d)));
  }

  start() {
    this.ask();
    // Пока узел льёт настройки — не перезапрашиваем (см. smess-lora, app.c)
    this.retry = setInterval(() => { if (this.state !== 'ready' && Date.now() - this.lastFrame > 8000) this.ask(); }, 2000);
    this.hb = setInterval(() => { if (this.state === 'ready') this.out(encodeHeartbeat(rand32())); }, 60000);
    // Служебные кадры модуля защиты: представиться, ответить, попросить ключ
    this.ctrl = setInterval(() => { if (this.state === 'ready') this.pumpCtrl(); }, 3000);
  }

  private pumpCtrl() {
    const o = this.sealer.ctrlOut(Date.now());
    if (!o) return;
    const f = encodeFrame({ type: SMESH_T_CTRL, msgId: rand32(), from: this.sealer.self(), to: o.to, idx: 0, total: 1, body: o.body });
    this.queue([encodeSend({ to: o.toNode, channel: this.channel, portnum: MT_PORT_PRIVATE, payload: f, id: rand32() })]).catch(() => {});
  }

  close() {
    if (this.hb) clearInterval(this.hb);
    if (this.retry) clearInterval(this.retry);
    if (this.ctrl) clearInterval(this.ctrl);
    this.state = 'closed';
    this.t.close();
    this.emitState();
  }

  /** Сообщение чата мессенджера — в эфир. Возвращает число кадров. */
  sendChat(m: ChatBody): Promise<number> {
    return this.sendSmesh(SMESH_T_CHAT, MT_BROADCAST, SMESH_ALL, encodeChatBody(m));
  }

  /** Текст STORAGE&MESS всем (подписан) или лично узлу (зашифрован). */
  sendSmeshText(text: string, toNode = MT_BROADCAST): Promise<number> {
    let to: Uint8Array = SMESH_ALL;
    if (toNode !== MT_BROADCAST) {
      if (this.sealer.peers().some(x => x.node === toNode && x.revoked)) {
        return Promise.reject(new Error('Ключ узла отозван корпоративным УЦ — лично ему не пишем'));
      }
      const p = this.sealer.peer(toNode);
      if (!p) return Promise.reject(new Error('Ключ узла ещё не известен — попросил его представиться, повторите через минуту'));
      to = p;
    }
    return this.sendSmesh(SMESH_T_TEXT, toNode, to, new TextEncoder().encode(text));
  }

  private sendSmesh(type: number, toNode: number, to: Uint8Array, body: Uint8Array): Promise<number> {
    const msgId = rand32();
    const s = this.sealer.seal({ type, msgId, from: this.sealer.self(), to }, body);
    if (!s) return Promise.reject(new Error('Не удалось защитить сообщение'));
    const frames = split(s.type, msgId, s.from, to, s.body);
    return this.queue(frames.map(f => encodeSend({ to: toNode, channel: this.channel, portnum: MT_PORT_PRIVATE, payload: f, id: rand32() })))
      .then(() => frames.length);
  }

  /** Обычный текст Meshtastic — виден в их приложениях. */
  sendText(text: string): Promise<number> {
    const payload = new TextEncoder().encode(text).slice(0, 200);
    return this.queue([encodeSend({ to: MT_BROADCAST, channel: this.channel, portnum: MT_PORT_TEXT, payload, id: rand32() })]).then(() => 1);
  }

  private queue(bodies: Uint8Array[]): Promise<void> {
    const run = this.sendChain.then(async () => {
      for (let i = 0; i < bodies.length; i++) {
        if (i) await new Promise(r => setTimeout(r, FRAME_GAP_MS));
        await this.out(bodies[i]);
      }
    });
    this.sendChain = run.catch(() => {});
    return run;
  }

  private async out(body: Uint8Array) {
    await this.t.write(this.t.framed ? body : frame(body));
  }

  private ask() {
    this.cfgId = rand32();
    if (!this.t.framed) this.t.write(WAKE);
    setTimeout(() => this.out(encodeWantConfig(this.cfgId)), this.t.framed ? 0 : 150);
    this.lastFrame = Date.now();
  }

  private emitState() {
    this.ev.state?.(this.state, { myNum: this.myNum, nodes: this.nodes.size });
  }

  private onFromRadio(f: Uint8Array) {
    const m = decodeFromRadio(f);
    if (!m) return;
    this.lastFrame = Date.now();
    switch (m.kind) {
      case 'myInfo': this.myNum = m.myNodeNum; this.sealer.init(this.myNum); break;
      case 'nodeInfo': this.nodes.set(m.node.num, { name: m.node.shortName || m.node.longName, lastHeard: m.node.lastHeard }); break;
      case 'configComplete':
        if (this.state !== 'ready') { this.state = 'ready'; this.emitState(); }
        break;
      case 'rebooted': this.state = 'connecting'; this.emitState(); break;
      case 'packet': this.onPacket(m.packet); break;
      default: break;
    }
  }

  private onPacket(p: MtPacket) {
    if (!p.hasDecoded || p.from === this.myNum) return;
    const name = this.nodes.get(p.from)?.name || '!' + p.from.toString(16).padStart(8, '0');
    if (p.portnum === MT_PORT_TEXT) {
      this.ev.text?.({ fromNode: p.from, name, text: new TextDecoder().decode(p.payload), trust: 'none', mesh: true });
      return;
    }
    if (p.portnum !== MT_PORT_PRIVATE) return;
    const f = decodeFrame(p.payload);
    if (!f) return;
    const toAll = addrEq(f.to, SMESH_ALL);
    // лично, но не нам (открытые сборки адресуют номером узла, полные — ключом)
    if (!toAll && !addrEq(f.to, this.sealer.self()) && !addrEq(f.to, addrFromNode(this.myNum))) return;
    const done = this.rx.push(f);
    if (!done) return;
    const hdr = { type: done.type, msgId: f.msgId, from: f.from, to: f.to };
    if (done.type === SMESH_T_CTRL) { this.sealer.onCtrl(p.from, hdr, done.body); return; }
    const o = this.sealer.open(p.from, hdr, done.body);
    if (!o) {
      if (done.type & SMESH_T_SEALED) this.ev.sealedFail?.({ fromNode: p.from, name, direct: !toAll });
      return;
    }
    if (o.type === SMESH_T_CHAT) {
      const c = decodeChatBody(o.body);
      if (c) this.ev.chat?.({ ...c, fromNode: p.from, via: 'lora', trust: o.trust, key: o.key, ...(o.revoked ? { revoked: true } : {}) });
    } else if (o.type === SMESH_T_TEXT) {
      this.ev.text?.({ fromNode: p.from, name, text: new TextDecoder().decode(o.body), trust: o.trust, key: o.key, direct: !toAll,
                       ...(o.revoked ? { revoked: true } : {}) });
    }
  }
}
