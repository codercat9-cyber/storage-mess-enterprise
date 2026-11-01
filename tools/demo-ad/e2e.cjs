#!/usr/bin/env node
// =============================================================
// Сквозная проверка корпоративного контура на запущенном демо
// (tools/demo-ad/start-demo.sh): учётки из AD, вход паролем домена,
// схлопывание, сертификаты устройств и список отзыва, атаки.
//
//   node tools/demo-ad/e2e.cjs
// =============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const radius = require('radius');
const dgram = require('dgram');

const ROOT = path.join(__dirname, '..', '..');
const { io } = require(path.join(ROOT, 'web-client/node_modules/socket.io-client'));
const ST = path.join(__dirname, 'state');
const API = 'http://127.0.0.1:9400/api';
const PANEL = 'http://127.0.0.1:9480';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) SmessDemoE2E/1.0';
const INTERVAL = 10;

const pw = {};
for (const l of fs.readFileSync(path.join(ST, 'passwords.txt'), 'utf8').split('\n')) {
  const m = /^([a-z][\w.-]*)\s+(\S+)/.exec(l);
  if (m) pw[m[1]] = m[2];
}

let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  — ' + extra : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(method, p, body, token) {
  const r = await fetch(API + p, {
    method, headers: { 'content-type': 'application/json', 'user-agent': UA, ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null;
  try { j = await r.json(); } catch { /* пусто */ }
  return [r.status, j];
}
const login = (u, p) => api('POST', '/auth/login', { username: u, password: p });
async function panel(sam, a) {
  const r = await fetch(PANEL + '/api/act', { method: 'POST', body: new URLSearchParams({ sam, a }) });
  return r.status;
}
async function waitFor(fn, s = INTERVAL + 8) {
  for (let i = 0; i < s * 4; i++) { if (await fn()) return true; await sleep(250); }
  return false;
}
const userState = async (adm, name) => ((await api('GET', '/enterprise/users', null, adm))[1] || []).find(u => u.username === name);

function rawEdPub() {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  return publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
}
function verifyEd(pubHex, obj, sigHex) {
  const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pubHex, 'hex')]), format: 'der', type: 'spki' });
  return crypto.verify(null, Buffer.from(JSON.stringify(obj)), key, Buffer.from(sigHex, 'hex'));
}

function radiusAsk(user, password, secret) {
  return new Promise(resolve => {
    const s = dgram.createSocket('udp4');
    const pkt = radius.encode({ code: 'Access-Request', secret, identifier: crypto.randomInt(256),
      attributes: [['User-Name', user], ['User-Password', password], ['NAS-Identifier', 'e2e']], add_message_authenticator: true });
    const t = setTimeout(() => { s.close(); resolve('нет ответа'); }, 3000);
    s.on('message', m => { clearTimeout(t); s.close(); resolve(radius.decode({ packet: m, secret }).code); });
    s.send(pkt, 1812, '127.0.0.1');
  });
}

(async () => {
  console.log('1. каталог → учётки');
  const [, info] = await api('GET', '/enterprise/info');
  check('корпоративный контур включён, вход доменом', info?.enabled === true && info?.domain === 'CORP', JSON.stringify(info));
  const [sa, adm0] = await login('avaria', pw.avaria);
  check('аварийный локальный админ входит', sa === 200 && adm0?.accessToken);
  const adm = adm0.accessToken;
  const [ss, sync] = await api('POST', '/enterprise/sync', null, adm);
  check('синхронизация по кнопке', ss === 200 && typeof sync?.took_ms === 'number', JSON.stringify(sync));
  const users = (await api('GET', '/enterprise/users', null, adm))[1] || [];
  check('сотрудники из группы получили учётки сами', users.length >= 7 && users.some(u => u.username === 'ivanov' && u.department === 'Отдел продаж'), `${users.length} учёток`);
  check('кого нет в группе — учётки нет', !users.some(u => u.username === 'lebedeva'));
  const [sn] = await api('GET', '/enterprise/status');
  check('состояние каталога — только админу', sn === 401 || sn === 403, String(sn));

  console.log('2. вход паролем домена и атаки');
  const [s1, iv] = await login('ivanov', pw.ivanov);
  check('ivanov входит паролем домена', s1 === 200 && iv?.accessToken && iv?.refreshToken, String(s1));
  const [s1b] = await login('CORP\\ivanov', pw.ivanov);
  const [s1c] = await login('ivanov@corp.example', pw.ivanov);
  check('и как CORP\\ivanov, и как ivanov@corp.example', s1b === 200 && s1c === 200, `${s1b} ${s1c}`);
  const [s2] = await login('ivanov', 'неверный');
  check('неверный пароль — отказ', s2 === 401 || s2 === 403, String(s2));
  const [s3, j3] = await login('ivanov', '');
  check('ПУСТОЙ пароль — отказ (AD такой вход «пускает» — клиент обязан отсечь)', s3 >= 400 && !j3?.accessToken, String(s3));
  for (const evil of ['*', '*)(sAMAccountName=*', 'iv*', 'ivanov)(|(cn=*', '\\2a']) {
    const [se, je] = await login(evil, pw.ivanov);
    check(`LDAP-инъекция «${evil}» не входит`, se >= 400 && !je?.accessToken, String(se));
  }
  const [s4, me] = await api('GET', '/auth/me', null, iv.accessToken);
  check('профиль: ФИО из AD', s4 === 200 && /Иванов/.test(JSON.stringify(me)), String(s4));

  console.log('3. устройство и УЦ');
  const [, ca] = await api('GET', '/enterprise/ca');
  check('ключ УЦ опубликован', /^[0-9a-f]{64}$/.test(ca?.ca_pub || ''));
  const edPub = rawEdPub();
  const [sd, dev] = await api('POST', '/enterprise/devices', { ed_pub: edPub, label: 'e2e' }, iv.accessToken);
  check('устройство получило сертификат', sd === 200 && dev?.cert?.ed_pub === edPub, String(sd));
  check('подпись сертификата верна ключом УЦ', dev && verifyEd(ca.ca_pub, dev.cert, dev.sig));
  const forged = { ...dev.cert, username: 'sidorov' };
  check('подменённый сертификат не проходит', !verifyEd(ca.ca_pub, forged, dev.sig));

  console.log('4. отключили в AD → схлопывание');
  const sock = io('http://127.0.0.1:9400', { path: '/api/sync/', auth: { token: iv.accessToken }, extraHeaders: { 'user-agent': UA }, transports: ['websocket'], reconnection: false });
  let blockedEvt = null, disc = false;
  sock.on('account:blocked', d => { blockedEvt = d || {}; });
  sock.on('disconnect', () => { disc = true; });
  const connected = await waitFor(() => sock.connected, 5);
  check('ivanov на связи по сокету', connected);
  const t0 = Date.now();
  check('консоль AD: «Отключить» ivanov', (await panel('ivanov', 'disable')) === 200);
  const collapsed = await waitFor(async () => (await userState(adm, 'ivanov'))?.blocked_at);
  check(`учётка схлопнулась за ${Math.round((Date.now() - t0) / 1000)} с (опрос каталога раз в ${INTERVAL} с)`, collapsed);
  await waitFor(() => blockedEvt && disc, 3);
  check('сокет получил account:blocked и разорван', !!blockedEvt && disc, JSON.stringify(blockedEvt));
  const [sr] = await api('POST', '/auth/refresh', { refreshToken: iv.refreshToken });
  check('старый токен обновления больше не работает', sr >= 400, String(sr));
  const [sm] = await api('GET', '/auth/me', null, iv.accessToken);
  check('старый токен доступа — отказ', sm === 401 || sm === 403, String(sm));
  const [sl, jl] = await login('ivanov', pw.ivanov);
  check('вход отключённого — отказ с причиной', sl === 403 && /отключ/i.test(JSON.stringify(jl)), `${sl} ${JSON.stringify(jl)}`);
  const re = io('http://127.0.0.1:9400', { path: '/api/sync/', auth: { token: iv.accessToken }, extraHeaders: { 'user-agent': UA }, transports: ['websocket'], reconnection: false });
  const reErr = await new Promise(r => { re.on('connect_error', e => r(e.message)); re.on('connect', () => r('connected')); setTimeout(() => r('тишина'), 4000); });
  re.close();
  check('переподключиться сокетом не пускает', reErr === 'Account blocked', reErr);
  const [, crl] = await api('GET', '/enterprise/crl');
  check('ключ устройства в списке отзыва', crl?.crl?.revoked?.some(x => x.ed_pub === edPub));
  check('список отзыва подписан УЦ', crl && verifyEd(ca.ca_pub, crl.crl, crl.sig));
  const tampered = { ...crl.crl, revoked: [] };
  check('подделанный (пустой) список отзыва не проходит', !verifyEd(ca.ca_pub, tampered, crl.sig));
  sock.close();

  console.log('5. включили обратно');
  await panel('ivanov', 'enable');
  check('учётка вернулась', await waitFor(async () => !(await userState(adm, 'ivanov'))?.blocked_at));
  check('вход снова работает', (await login('ivanov', pw.ivanov))[0] === 200);

  console.log('6. «заблокирована» (неверные пароли) — вход закрыт, сессии живы');
  const [, kz] = await login('kuznetsova', pw.kuznetsova);
  await panel('kuznetsova', 'lock');
  await api('POST', '/enterprise/sync', null, adm);
  const kst = await userState(adm, 'kuznetsova');
  check('состояние «заблокирована», но не схлопнута', kst?.directory_state === 'locked' && !kst?.blocked_at, JSON.stringify(kst && { s: kst.directory_state, b: kst.blocked_at }));
  const [kr, kj] = await api('POST', '/auth/refresh', { refreshToken: kz.refreshToken });
  check('открытая сессия продолжается (перебором пароля коллегу не выкинуть)', kr === 200, String(kr));
  const [kl] = await login('kuznetsova', pw.kuznetsova);
  check('новый вход — отказ, пока заблокирована', kl === 403, String(kl));
  await panel('kuznetsova', 'unlock');
  void kj;

  console.log('7. уволили (убрали из группы)');
  await panel('smirnov', 'fire');
  check('схлопнулась', await waitFor(async () => (await userState(adm, 'smirnov'))?.blocked_at));
  await panel('smirnov', 'hire');
  check('вернули в группу — вернулась', await waitFor(async () => !(await userState(adm, 'smirnov'))?.blocked_at));

  console.log('8. ручная блокировка админа каталог не снимает');
  const pet = await userState(adm, 'petrova');
  const [sb] = await api('POST', `/admin/users/${pet.id}/block`, { reason: 'проверка e2e' }, adm);
  check('админ заблокировал petrova', sb === 200, String(sb));
  await api('POST', '/enterprise/sync', null, adm);
  await api('POST', '/enterprise/sync', null, adm);
  check('после синхронизаций всё ещё заблокирована', !!(await userState(adm, 'petrova'))?.blocked_at);
  await api('POST', `/admin/users/${pet.id}/unblock`, {}, adm);

  console.log('9. каталог недоступен — никого не блокировать');
  const dirPid = Number(fs.readFileSync(path.join(ST, 'directory.pid'), 'utf8'));
  process.kill(dirPid);
  await sleep(500);
  const [, s9] = await api('POST', '/enterprise/sync', null, adm);
  const after = (await api('GET', '/enterprise/users', null, adm))[1] || [];
  const st9 = (await api('GET', '/enterprise/status', null, adm))[1];
  check('синхронизация честно сообщает об ошибке', st9?.last_sync_ok === false && !!st9?.last_error, st9?.last_error || JSON.stringify(s9));
  check('никто не заблокирован из-за недоступного каталога', !after.some(u => u.blocked_at && /AD:/.test(u.blocked_reason || '')));
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [path.join(__dirname, 'directory-server.cjs')], { detached: true, stdio: ['ignore', fs.openSync(path.join(ST, 'directory.log'), 'a'), fs.openSync(path.join(ST, 'directory.log'), 'a')] });
  child.unref();
  fs.writeFileSync(path.join(ST, 'directory.pid'), String(child.pid));
  await sleep(1000);
  const [, s9b] = await api('POST', '/enterprise/sync', null, adm);
  check('каталог вернулся — синхронизация снова в порядке', ((await api('GET', '/enterprise/status', null, adm))[1] || {}).last_sync_ok === true, JSON.stringify(s9b));

  console.log('10. RADIUS (вход через NPS/FreeRADIUS)');
  const secret = fs.readFileSync(path.join(ST, 'radius-secret'), 'utf8').trim();
  check('верный пароль — Access-Accept', (await radiusAsk('ivanov', pw.ivanov, secret)) === 'Access-Accept');
  check('неверный — Access-Reject', (await radiusAsk('ivanov', 'x', secret)) === 'Access-Reject');
  check('чужой общий секрет — сервер молчит', (await radiusAsk('ivanov', pw.ivanov, 'не-тот-секрет')) === 'нет ответа');

  const [, ev] = await api('GET', '/enterprise/events?limit=200', null, adm);
  check('всё видно в журнале событий', Array.isArray(ev) && ['created', 'blocked', 'unblocked', 'login', 'login_failed', 'device_issued', 'device_revoked'].every(k => ev.some(e => e.kind === k)),
    Array.isArray(ev) ? [...new Set(ev.map(e => e.kind))].join(',') : '');
  const log = fs.readFileSync(path.join(ST, 'server.log'), 'utf8');
  check('ни одного пароля в журнале сервера', !Object.values(pw).some(p => log.includes(p)));

  console.log(fails ? `\nПРОВАЛЕНО: ${fails}` : '\n✓ корпоративный контур: всё сходится');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
