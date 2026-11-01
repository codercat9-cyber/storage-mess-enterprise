// ═══════════════════════════════════════════════════════════════════
//  Протокол LoRa на TypeScript (src/lib/lora): сверка и живой узел.
//
//  1. Кадры TS побайтно равны кадрам C-клиента smess-lora (а тот сверен
//     с эталонной библиотекой Meshtastic) — значит, формат верный.
//  2. Конверт smesh: раскладка заголовка, нарезка/сборка, тип CHAT.
//  3. Живой узел (если подключён): TS-код читает Heltec по USB.
//
//  node scripts/lora-test.cjs [/dev/ttyUSB0]
// ═══════════════════════════════════════════════════════════════════
const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const LORA_C = path.join(ROOT, '..', '..', '..', 'smess-lora');
const out = path.join(os.tmpdir(), 'smess-lora-ts-' + process.pid + '.cjs');
const entry = path.join(os.tmpdir(), 'smess-lora-entry-' + process.pid + '.ts');
const LIB = path.join(ROOT, 'src/lib/lora');
fs.writeFileSync(entry, `export * from '${LIB}/meshtastic'; export * as smesh from '${LIB}/smesh'; export { LoraLink } from '${LIB}/link'; export { Sealer } from '${LIB}/seal';`);
execFileSync(path.join(ROOT, 'node_modules/.bin/esbuild'),
  [entry, '--bundle', '--platform=node', '--format=cjs', '--outfile=' + out, '--log-level=warning']);
fs.unlinkSync(entry);
const L = require(out);
fs.unlinkSync(out);

let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  — ' + extra : ''}`); };
const hex = u => Buffer.from(u).toString('hex');

// ── 1. побайтно как C ──
console.log('1. кадры TS против C-клиента');
const cBin = path.join(LORA_C, 'build', 'interop');
if (fs.existsSync(cBin)) {
  const c = execFileSync(cBin, ['enc']).toString().trim().split('\n');
  const text = Buffer.from('привет, mesh');
  const big = Uint8Array.from({ length: 233 }, (_, i) => i);
  const ts = [
    L.frame(L.encodeWantConfig(0x1234567)),
    L.frame(L.encodeHeartbeat(777)),
    L.frame(L.encodeSend({ to: 0x12345678, channel: 1, portnum: L.MT_PORT_PRIVATE, payload: text, id: 0xabcdef01, hopLimit: 3, wantAck: true })),
    L.frame(L.encodeSend({ to: L.MT_BROADCAST, portnum: L.MT_PORT_TEXT, payload: big, id: 1 })),
  ].map(hex);
  ['want_config', 'heartbeat', 'пакет PRIVATE_APP', 'полный кадр 233 байта'].forEach((n, i) => check(n + ' = C', ts[i] === c[i]));
} else {
  console.log('  (нет', cBin, '— соберите smess-lora: make)');
}
// Разбор FromRadio через поток с мусором вокруг
const fr = [];
const p = new L.FrameParser(f => fr.push(L.decodeFromRadio(f)));
p.push(Buffer.from('INFO | boot log\n'));
p.push(L.frame(L.encodeWantConfig(5))); // ToRadio как поток — проверка только разбора кадра
p.push(Uint8Array.from([0x94, 0x41, 0x94, 0xc3, 0x7f, 0xff]));
check('разбор потока: кадр найден среди журнала и мусора', fr.length === 1);

// ── 2. конверт ──
console.log('2. конверт smesh');
const S = L.smesh;
const me = S.addrFromNode(0xdb51cf24);
const f0 = S.encodeFrame({ type: S.SMESH_T_TEXT, msgId: 0x01020304, from: me, to: S.SMESH_ALL, idx: 2, total: 3, body: Buffer.from('hi') });
check('заголовок как в C (магия, версия|тип, id LE, адреса, куски)',
  hex(f0.subarray(0, 19)) === '53' + '11' + '04030201' + '0000db51cf24' + 'ffffffffffff' + '22');
const body = Uint8Array.from({ length: 600 }, (_, i) => i & 0xff);
const parts = S.split(S.SMESH_T_TEXT, 77, me, S.SMESH_ALL, body);
const R = new S.Reassembler();
let got = null;
for (const i of [2, 0, 0, 1]) { const r = R.push(S.decodeFrame(parts[i])); if (r) got = r; }
check('нарезка 600 байт на 3 кадра и сборка вразнобой с повтором', parts.length === 3 && got && Buffer.compare(Buffer.from(got.body), Buffer.from(body)) === 0);
check('повтор собранного отсеивается', R.push(S.decodeFrame(parts[0])) === undefined);
const chat = { chatId: '9db6c3ba-70ba-4aa8-9618-a42fd7765067', senderId: 'bb26bc06-c731-4e76-b2b0-c9e23f590a8e',
               clientId: 'pending-1793475247061-0sbxi2p73wxq', text: 'Связь судного дня 📡' };
const cb = S.decodeChatBody(S.encodeChatBody(chat));
check('тип CHAT: чат, отправитель, client_id и текст туда-обратно', JSON.stringify(cb) === JSON.stringify(chat), cb && cb.clientId);
const tailLen = chat.clientId.split('-')[2].length;
check(`тип CHAT: служебного ${39 + tailLen} байт, на текст в первом кадре ${214 - 39 - tailLen}`,
      S.encodeChatBody(chat).length === 39 + tailLen + Buffer.byteLength(chat.text));

// ── 2б. свой ключ для сертификата УЦ (без узла LoRa) ──
{
  const probe = new L.Sealer({ load: () => null, save: () => {} });
  if (typeof probe.ensureIdentity === 'function') {
    console.log('2б. ключ устройства для корпоративного УЦ');
    const mem = { seed: null };
    const S1 = new L.Sealer({ load: () => mem.seed, save: x => { mem.seed = x; } });
    S1.ensureIdentity();
    const k1 = S1.publicKeyHex();
    check('ensureIdentity: ключ есть и без номера узла', S1.active && /^[0-9a-f]{64}$/.test(k1), k1.slice(0, 16));
    S1.init(0x12345678);
    check('init после ensureIdentity: ключ тот же', S1.publicKeyHex() === k1);
    const S2 = new L.Sealer({ load: () => mem.seed, save: x => { mem.seed = x; } });
    S2.ensureIdentity();
    check('ключ хранится: второй запуск — тот же', S2.publicKeyHex() === k1);
    S2.setRevoked([k1, 'мусор', '00']);
    check('setRevoked: свой ключ в списке, мусор отброшен', S2.selfRevoked && S2.revokedCount === 1);
    S2.rotateIdentity();
    check('rotateIdentity: новый ключ, уже не отозван', S2.publicKeyHex() !== k1 && !S2.selfRevoked && Buffer.from(mem.seed).length === 32);
  }
}

// ── 3. звено: два «телефона» через поддельный эфир ──
async function linkTest() {
  console.log('3. звено LoraLink: два телефона через поддельный эфир (BLE и USB)');
  // мини-кодер FromRadio для поддельного узла
  const vint = v => { const o = []; v = BigInt(v); do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; o.push(b); } while (v); return o; };
  const fld = (n, wt) => vint((n << 3) | wt);
  const lenf = (n, b) => [...fld(n, 2), ...vint(b.length), ...b];
  const fx = (n, v) => [...fld(n, 5), v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  const u = (n, v) => [...fld(n, 0), ...vint(v)];
  const myInfo = num => Uint8Array.from([...u(1, 1), ...lenf(3, u(1, num))]);
  const nodeInfo = (num, name) => Uint8Array.from(lenf(4, [...u(1, num), ...lenf(2, lenf(3, [...Buffer.from(name)]))]));
  const complete = id => Uint8Array.from(u(7, id));
  const packetFR = (from, portnum, payload) => Uint8Array.from(lenf(2, [...fx(1, from), ...fx(2, 0xffffffff), ...lenf(4, [...u(1, portnum), ...lenf(2, [...payload])]), ...fx(6, 7)]));
  // разбор ToRadio от телефона: want_config или пакет
  const parseTo = b => {
    const r = { cfg: 0, port: 0, payload: null };
    let i = 0; const rd = () => { let v = 0n, s = 0n; for (;;) { const x = b[i++]; v |= BigInt(x & 0x7f) << s; if (!(x & 0x80)) return v; s += 7n; } };
    while (i < b.length) { const t = Number(rd()); const n = t >> 3, wt = t & 7;
      if (n === 3 && wt === 0) r.cfg = Number(rd());
      else if (n === 1 && wt === 2) { const L = Number(rd()); const pk = b.subarray(i, i + L); i += L;
        let j = 0; const rd2 = () => { let v = 0n, s = 0n; for (;;) { const x = pk[j++]; v |= BigInt(x & 0x7f) << s; if (!(x & 0x80)) return v; s += 7n; } };
        while (j < pk.length) { const t2 = Number(rd2()); const n2 = t2 >> 3, w2 = t2 & 7;
          if (w2 === 5) j += 4; else if (w2 === 0) rd2();
          else { const L2 = Number(rd2()); const sub = pk.subarray(j, j + L2); j += L2;
            if (n2 === 4) { let k = 0; const rd3 = () => { let v = 0n, s = 0n; for (;;) { const x = sub[k++]; v |= BigInt(x & 0x7f) << s; if (!(x & 0x80)) return v; s += 7n; } };
              while (k < sub.length) { const t3 = Number(rd3()); if ((t3 >> 3) === 1) r.port = Number(rd3()); else { const L3 = Number(rd3()); r.payload = sub.slice(k, k + L3); k += L3; } } } } } }
      else if (wt === 2) { const L = Number(rd()); i += L; } else rd(); }
    return r;
  };
  const phones = [];
  function makePhone(num, name, framed) {
    let deliver = null;
    const parser = new L.FrameParser(f => onTo(f));
    const toPhone = b => deliver && deliver(framed ? b : L.frame(b));
    function onTo(b) {
      const r = parseTo(b);
      if (r.cfg) { toPhone(myInfo(num)); toPhone(nodeInfo(num, name)); phones.forEach(p => p.num !== num && toPhone(nodeInfo(p.num, p.name))); toPhone(complete(r.cfg)); }
      if (r.payload) phones.filter(p => p.num !== num).forEach(p => p.hear(packetFR(num, r.port, r.payload)));
    }
    const t = { framed, write: d => { if (framed) onTo(d); else { const raw = d.length === 32 && d.every(x => x === 0xc3); if (!raw) parser.push(d); } }, onData: cb => { deliver = cb; }, close() {} };
    const got = { chat: [], text: [], state: '', notes: [], fail: [] };
    const mem = { seed: null, book: null };
    const sealer = new L.Sealer({ load: () => mem.seed, save: x => { mem.seed = x; }, loadBook: () => mem.book, saveBook: j => { mem.book = j; } },
      n => got.notes.push(n));
    const link = new L.LoraLink(t, { chat: m => got.chat.push(m), text: m => got.text.push(m), state: s => { got.state = s; },
      sealedFail: m => got.fail.push(m) }, sealer);
    const ph = { num, name, link, got, hear: fr => toPhone(fr) };
    phones.push(ph);
    return ph;
  }
  const A = makePhone(0xa1a1a1a1, 'Аня', true);    // как по Bluetooth
  const B = makePhone(0xb2b2b2b2, 'Боря', false);  // как по USB
  const C = makePhone(0xc3c3c3c3, 'Вика', true);   // третья — слышит эфир
  A.link.start(); B.link.start(); C.link.start();
  await new Promise(r => setTimeout(r, 400));
  check('оба подключились к узлам', A.got.state === 'ready' && B.got.state === 'ready', `A:${A.got.state} B:${B.got.state}, B знает узлов: ${B.link.nodes.size}`);
  const prot = A.link.sealer.active;
  if (prot) {
    await new Promise(r => setTimeout(r, 3300)); // служебные кадры идут раз в 3 с
    check('представились: Аня и Боря знают ключи друг друга', !!A.link.sealer.peer(B.num) && !!B.link.sealer.peer(A.num),
      `A знает ${A.link.sealer.peers().length}, B знает ${B.link.sealer.peers().length}`);
  }
  const long = 'Связь есть. '.repeat(30) + 'Конец.';
  const msgIn = { chatId: '9db6c3ba-70ba-4aa8-9618-a42fd7765067', senderId: 'bb26bc06-c731-4e76-b2b0-c9e23f590a8e', clientId: 'pending-1793475247061-abcdefghij', text: long };
  const t0 = Date.now();
  const frames = await A.link.sendChat(msgIn);
  await new Promise(r => setTimeout(r, 200));
  const gotB = B.got.chat[0];
  check(`длинное сообщение чата: ${Buffer.byteLength(long)} байт, ${frames} кадра, пауза между кадрами`, frames >= 2 && Date.now() - t0 >= 1400 * (frames - 1));
  check('Боря получил: тот же чат, отправитель, client_id и текст', gotB && gotB.chatId === msgIn.chatId && gotB.senderId === msgIn.senderId && gotB.clientId === msgIn.clientId && gotB.text === long);
  if (prot) {
    check('сообщение чата подписано и подпись верна', gotB && gotB.trust === 'signed', gotB && gotB.trust);
    const nf = await A.link.sendSmeshText('встреча у водокачки в 18:00', B.num);
    await new Promise(r => setTimeout(r, 150));
    const dm = B.got.text.find(m => m.direct);
    check(`личное Ане → Боре (${nf} кадр): открыл, зашифровано`, dm && dm.text === 'встреча у водокачки в 18:00' && dm.trust === 'private', JSON.stringify(dm));
    check('третья в эфире личное не видит и не пытается открыть', !C.got.text.some(m => m.direct) && !C.got.fail.length);
    let err = '';
    await A.link.sendSmeshText('?', 0x12345678).catch(e => { err = e.message; });
    check('лично неизвестному узлу — отказ с объяснением', /не известен/.test(err), err);

    // корпоративный УЦ: Боря получил список отзыва, в нём ключ Ани
    if (typeof B.link.sealer.setRevoked === 'function') {
      const wait = () => new Promise(r => setTimeout(r, 150));
      const aPub = A.link.sealer.publicKeyHex();
      B.link.sealer.setRevoked([aPub.toUpperCase()]);
      const n0 = B.got.text.length;
      await A.link.sendSmeshText('я ещё в штате');
      await wait();
      const rv = B.got.text.slice(n0).find(m => !m.direct);
      check('ключ отозван УЦ: сообщение всем — trust none и revoked', rv && rv.text === 'я ещё в штате' && rv.trust === 'none' && rv.revoked === true, JSON.stringify(rv));
      await A.link.sendSmeshText('лично, ключ отозван', B.num);
      await wait();
      const rd = B.got.text.slice(n0).find(m => m.direct);
      check('ключ отозван УЦ: личное — trust none и revoked', rd && rd.text === 'лично, ключ отозван' && rd.trust === 'none' && rd.revoked === true, JSON.stringify(rd));
      const c0 = B.got.chat.length;
      await A.link.sendChat({ ...msgIn, clientId: 'pending-1793475247061-revoked001', text: 'из чата' });
      await wait();
      const rc = B.got.chat[c0];
      check('ключ отозван УЦ: сообщение чата помечено', rc && rc.revoked === true && rc.trust === 'none', rc && rc.trust);
      check('ключ отозван УЦ: в книге помечен', B.link.sealer.peers().some(p => p.node === A.num && p.revoked));
      let e2 = '';
      await B.link.sendSmeshText('?', A.num).catch(e => { e2 = e.message; });
      check('отозванному лично не пишем', /отозван/.test(e2), e2);
      B.link.sealer.setRevoked([]);
      const n1 = B.got.text.length;
      await A.link.sendSmeshText('снова в штате');
      await wait();
      const ok = B.got.text.slice(n1).find(m => !m.direct);
      check('список отзыва пуст — снова «подпись верна»', ok && ok.trust === 'signed' && !ok.revoked, JSON.stringify(ok));
    }
  }
  await B.link.sendText('Боря в эфире');
  await new Promise(r => setTimeout(r, 100));
  check('обычный эфир: Аня слышит Борю по имени узла', A.got.text[0] && A.got.text[0].text === 'Боря в эфире' && A.got.text[0].name === 'Боря', JSON.stringify(A.got.text[0]));
  A.link.close(); B.link.close(); C.link.close();
}

// ── 4. живой узел ──
const port = process.argv[2] || '/dev/ttyUSB0';
linkTest().then(live);
function live() {
if (process.env.NO_LIVE || !fs.existsSync(port)) { console.log('3. узла нет —', port); finish(); }
else {
  console.log('3. живой узел', port, '(открытие порта перезагружает плату — ждём ~35 с)');
  execSync(`stty -F ${port} 115200 raw -echo -hupcl`);
  const fd = fs.openSync(port, fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK);
  const st = { my: 0, nodes: 0, complete: false, names: [] };
  const cfg = 0x5eed0000 + (process.pid & 0xffff);
  const parser = new L.FrameParser(f => {
    const m = L.decodeFromRadio(f);
    if (!m) return;
    if (m.kind === 'myInfo') st.my = m.myNodeNum;
    if (m.kind === 'nodeInfo') { st.nodes++; if (st.names.length < 4 && m.node.longName) st.names.push(m.node.longName); }
    if (m.kind === 'configComplete' && (m.configId === cfg || m.configId === cfg + 1)) st.complete = true;
  });
  const t0 = Date.now();
  let asked = 0;
  const tick = setInterval(() => {
    const buf = Buffer.alloc(4096);
    try { const n = fs.readSync(fd, buf, 0, buf.length, null); if (n > 0) parser.push(buf.subarray(0, n)); } catch { /* EAGAIN */ }
    const s = (Date.now() - t0) / 1000;
    if ((asked === 0 && s > 30) || (asked === 1 && s > 45 && !st.complete)) {
      fs.writeSync(fd, L.WAKE); fs.writeSync(fd, L.frame(L.encodeWantConfig(cfg + asked))); asked++;
    }
    if (st.complete || s > 75) {
      clearInterval(tick);
      fs.closeSync(fd);
      check('узел ответил: свой номер', st.my === 0xdb51cf24, '!' + st.my.toString(16));
      check('список сети', st.nodes >= 30, `${st.nodes} узлов, например: ${st.names.join(', ')}`);
      check('настройки получены целиком (config_complete)', st.complete);
      finish();
    }
  }, 20);
}
}

function finish() {
  console.log(fails ? `\n✗ провалено: ${fails}` : '\n✓ протокол LoRa на TS: всё сходится');
  process.exit(fails ? 1 : 0);
}
