// =============================================================
// Шлюз LoRa ↔ STORAGE&MESS.
//
// Узел Meshtastic по USB на машине сервера + учётка-бот в мессенджере.
// Всё, что слышно в эфире (обычные сообщения Meshtastic и сообщения
// клиентов STORAGE&MESS LoRa на STM32), попадает в группу «📡 LoRa-эфир».
// Подписи сообщений «всем» проверяются (seal.ts): в группе видно, что
// подтверждено, а что пришло без подписи. Личные сообщения в группу не
// идут — они не для неё.
// Написанное в этой группе людьми уходит в эфир — только если включено
// (tx: true): канал общий, его слышат все узлы в радиусе.
//
// Настройки: ~/.config/smess-lora-gateway.json (создаётся сам, права 600).
// Сборка и запуск: tools/lora-gateway/run.sh
// =============================================================
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import crypto from 'crypto';
import {
  FrameParser, decodeFromRadio, encodeWantConfig, encodeHeartbeat, encodeSend, frame, WAKE,
  MT_BROADCAST, MT_PORT_TEXT, MT_PORT_PRIVATE, MtPacket,
} from '../../web-client/src/lib/lora/meshtastic';
import { decodeFrame, Reassembler, SMESH_T_TEXT, SMESH_ALL, addrEq } from '../../web-client/src/lib/lora/smesh';
import { Sealer, SealStore, SMESH_T_CTRL } from '../../web-client/src/lib/lora/seal';

const CFG_PATH = path.join(os.homedir(), '.config', 'smess-lora-gateway.json');
const KEY_PATH = path.join(os.homedir(), '.config', 'smess-lora-gateway.key');
const PEERS_PATH = path.join(os.homedir(), '.config', 'smess-lora-gateway.peers.json');

// Ключ шлюза и книга чужих ключей — файлы с правами 600
const fileStore: SealStore = {
  load: () => { try { const b = fs.readFileSync(KEY_PATH); return b.length === 32 ? new Uint8Array(b) : null; } catch { return null; } },
  save: s => fs.writeFileSync(KEY_PATH, s, { mode: 0o600 }),
  loadBook: () => { try { return fs.readFileSync(PEERS_PATH, 'utf8'); } catch { return null; } },
  saveBook: j => fs.writeFileSync(PEERS_PATH, j, { mode: 0o600 }),
};
const TERMS = '2026-11-01';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) StorageMessLoraGateway/1.0';

interface Cfg {
  server: string; username: string; password: string; chatId?: string;
  members: string[]; port: string; tx: boolean; channel: number; txGapMs: number;
}

function loadCfg(): Cfg {
  const def: Cfg = { server: 'https://messenger.example.org', username: 'lora_gateway',
    password: crypto.randomBytes(18).toString('base64url'), members: ['кошара'], port: '/dev/ttyUSB0',
    tx: false, channel: 0, txGapMs: 15000 };
  let cfg = def;
  try { cfg = { ...def, ...JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')) }; } catch { /* первый запуск */ }
  saveCfg(cfg);
  return cfg;
}
function saveCfg(c: Cfg) {
  fs.mkdirSync(path.dirname(CFG_PATH), { recursive: true });
  fs.writeFileSync(CFG_PATH, JSON.stringify(c, null, 2), { mode: 0o600 });
}

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ── мессенджер ─────────────────────────────────────────────────
class Messenger {
  token = ''; refresh = ''; me = '';
  constructor(private cfg: Cfg) {}
  async call(method: string, p: string, body?: unknown, retry = true): Promise<any> {
    const r = await fetch(this.cfg.server + '/api' + p, {
      method, headers: { 'Content-Type': 'application/json', 'User-Agent': UA, ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000),
    });
    if (r.status === 401 && retry && this.refresh) {
      const rr = await fetch(this.cfg.server + '/api/auth/refresh', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify({ refreshToken: this.refresh }) });
      if (rr.ok) {
        const j = await rr.json();
        this.token = j.accessToken;
        if (j.refreshToken) this.refresh = j.refreshToken;
        return this.call(method, p, body, false);
      }
      await this.login();
      return this.call(method, p, body, false);
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${j.error || ''}`);
    return j;
  }
  async login() {
    this.token = '';
    let r = await fetch(this.cfg.server + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ username: this.cfg.username, password: this.cfg.password }) });
    if (r.status === 401) {
      r = await fetch(this.cfg.server + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ username: this.cfg.username, password: this.cfg.password, display_name: '📡 LoRa-шлюз', terms_version: TERMS }) });
      log('учётка шлюза создана:', this.cfg.username);
    }
    const j = await r.json();
    if (!j.accessToken) throw new Error('вход шлюза не удался: ' + (j.error || r.status));
    this.token = j.accessToken; this.refresh = j.refreshToken; this.me = j.user.id;
  }
  async ensureChat(): Promise<string> {
    if (this.cfg.chatId) {
      const chats = await this.call('GET', '/chats');
      if ((chats.chats || []).some((c: any) => c.id === this.cfg.chatId)) return this.cfg.chatId;
    }
    const ids: string[] = [];
    for (const u of this.cfg.members) {
      const s = await this.call('GET', '/users/search?q=' + encodeURIComponent(u));
      const hit = (s.users || []).find((x: any) => x.username === u);
      if (hit) ids.push(hit.id); else log('нет пользователя для группы:', u);
    }
    if (!ids.length) throw new Error('некого добавить в группу — укажите members в ' + CFG_PATH);
    const c = await this.call('POST', '/chats/group', { name: '📡 LoRa-эфир', member_ids: ids });
    this.cfg.chatId = c.chat.id;
    saveCfg(this.cfg);
    await this.post('Шлюз LoRa подключён. Здесь — всё, что слышно в эфире Meshtastic рядом с сервером. '
      + (this.cfg.tx ? 'Написанное здесь уходит в эфир — его слышат все узлы в радиусе.' : 'Передача в эфир выключена.'), 'gw-hello-' + Date.now());
    return this.cfg.chatId!;
  }
  async post(text: string, clientId: string) {
    return this.call('POST', `/chats/${this.cfg.chatId}/messages`, { content: text, client_id: clientId });
  }
  async latest(): Promise<any[]> {
    const r = await this.call('GET', `/chats/${this.cfg.chatId}/messages?limit=20`);
    return r.messages || [];
  }
}

// ── узел ──────────────────────────────────────────────────────
class Node {
  fd = -1; myNum = 0; names = new Map<number, string>(); ready = false;
  private parser: FrameParser; private cfgId = 0; private askedAt = 0;
  constructor(private port: string, private onPacket: (p: MtPacket) => void, private onMyNum: (n: number) => void = () => {}) {
    this.parser = new FrameParser(f => this.onFrame(f));
  }
  open() {
    execSync(`stty -F ${this.port} 115200 raw -echo -hupcl`);
    this.fd = fs.openSync(this.port, fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK);
    this.askedAt = Date.now() + 30000; // открытие порта перезагружает плату
    log('узел: порт открыт, жду загрузку платы');
  }
  write(b: Uint8Array) { fs.writeSync(this.fd, b); }
  private ask() {
    this.cfgId = (crypto.randomBytes(4).readUInt32LE(0) || 1) >>> 0;
    this.write(WAKE);
    setTimeout(() => this.write(frame(encodeWantConfig(this.cfgId))), 150);
    this.askedAt = Date.now();
  }
  private onFrame(f: Uint8Array) {
    const m = decodeFromRadio(f);
    if (!m) return;
    if (!this.ready) this.askedAt = Date.now(); // идут настройки — перезапрос подождёт
    if (m.kind === 'myInfo') { this.myNum = m.myNodeNum; this.onMyNum(this.myNum); }
    else if (m.kind === 'nodeInfo') this.names.set(m.node.num, m.node.shortName || m.node.longName || '');
    else if (m.kind === 'configComplete' && !this.ready) { this.ready = true; log(`узел готов: !${this.myNum.toString(16)}, знает ${this.names.size} узлов`); }
    else if (m.kind === 'rebooted') { this.ready = false; log('узел перезагрузился'); this.askedAt = Date.now() + 5000; }
    else if (m.kind === 'packet') this.onPacket(m.packet);
  }
  tick() {
    const buf = Buffer.alloc(4096);
    try { const n = fs.readSync(this.fd, buf, 0, buf.length, null); if (n > 0) this.parser.push(buf.subarray(0, n)); } catch { /* EAGAIN */ }
    if (!this.ready && Date.now() - this.askedAt > 8000) this.ask();
  }
  heartbeat() { if (this.ready) this.write(frame(encodeHeartbeat(crypto.randomBytes(4).readUInt32LE(0) || 1))); }
  sendText(text: string, channel: number) {
    const payload = Buffer.from(text).subarray(0, 200);
    this.write(frame(encodeSend({ to: MT_BROADCAST, channel, portnum: MT_PORT_TEXT, payload, id: crypto.randomBytes(4).readUInt32LE(0) || 1 })));
  }
  name(num: number) { return this.names.get(num) || '!' + num.toString(16).padStart(8, '0'); }
}

// ── шлюз ──────────────────────────────────────────────────────
async function main() {
  const cfg = loadCfg();
  const msg = new Messenger(cfg);
  await msg.login();
  const chatId = await msg.ensureChat();
  log(`мессенджер: ${cfg.username}, группа ${chatId}, передача в эфир: ${cfg.tx ? 'ВКЛ' : 'выкл'}`);

  const rx = new Reassembler();
  const sealer = new Sealer(fileStore, n => log('защита:', n));
  const toChat: { text: string; cid: string }[] = [];
  const node = new Node(cfg.port, p => {
    if (!p.hasDecoded || p.from === node.myNum) return;
    const who = node.name(p.from);
    if (p.portnum === MT_PORT_TEXT) {
      const text = new TextDecoder().decode(p.payload);
      log(`эфир ← ${who}: ${text}`);
      toChat.push({ text: `📡 ${who}: ${text}`, cid: `lora-${p.from.toString(16)}-${p.id.toString(16)}` });
    } else if (p.portnum === MT_PORT_PRIVATE) {
      const f = decodeFrame(p.payload);
      if (!f || !addrEq(f.to, SMESH_ALL)) return; // личное — не для группы
      const done = rx.push(f);
      if (!done) return;
      const hdr = { type: done.type, msgId: f.msgId, from: f.from, to: f.to };
      if (done.type === SMESH_T_CTRL) { sealer.onCtrl(p.from, hdr, done.body); return; }
      const o = sealer.open(p.from, hdr, done.body);
      if (!o) { log(`эфир ← ${who}: подпись не сошлась — отброшено`); return; }
      if (o.type === SMESH_T_TEXT) {
        const text = new TextDecoder().decode(o.body);
        const mark = o.trust === 'signed' ? `✔ ключ ${o.key}` : '⚠ без подписи';
        log(`эфир ← ${who} (STORAGE&MESS LoRa, ${mark}): ${text}`);
        toChat.push({ text: `📡 ${who} [${mark}]: ${text}`, cid: `lora-${p.from.toString(16)}-${f.msgId.toString(16)}` });
      }
    }
  }, n => sealer.init(n));
  node.open();
  setInterval(() => node.tick(), 20);
  setInterval(() => node.heartbeat(), 60000);

  // эфир → чат
  setInterval(async () => {
    while (toChat.length) {
      const m = toChat[0];
      try { await msg.post(m.text, m.cid); toChat.shift(); } catch (e) { log('в чат не ушло:', (e as Error).message); break; }
    }
  }, 1000);

  // чат → эфир (если включено)
  const sent = new Set<string>();
  let lastTx = 0;
  const outQ: string[] = [];
  const seed = await msg.latest().catch(() => []);
  seed.forEach((m: any) => sent.add(m.id)); // старое не шлём
  setInterval(async () => {
    try {
      for (const m of await msg.latest()) {
        if (sent.has(m.id)) continue;
        sent.add(m.id);
        if (m.sender_id === msg.me || !m.content || m.type !== 'text') continue;
        const name = m.sender?.display_name || m.sender?.username || 'кто-то';
        if (cfg.tx) outQ.push(`${name}: ${m.content}`);
        else log(`(передача выключена) не отправлено в эфир: ${name}: ${m.content}`);
      }
    } catch (e) { log('чтение группы:', (e as Error).message); }
    if (outQ.length && node.ready && Date.now() - lastTx > cfg.txGapMs) {
      const t = outQ.shift()!;
      node.sendText(t, cfg.channel);
      lastTx = Date.now();
      log(`эфир → ${t}`);
    }
  }, 4000);
}

main().catch(e => { console.error('шлюз остановлен:', e); process.exit(1); });
