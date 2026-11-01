#!/usr/bin/env node
// =============================================================
// Учебный RADIUS (как NPS или FreeRADIUS у заказчика) — udp 127.0.0.1:1812.
// Проверяет пароль по тому же учебному каталогу (state/directory.json):
// отключённым, заблокированным и с истёкшим сроком — отказ.
// Общий секрет — state/radius-secret (создаётся сам, права 600).
//
// RADIUS умеет только «да/нет» на вход: перечислить сотрудников и узнать
// об увольнении через него нельзя — это делает синхронизация по LDAP.
// =============================================================
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const crypto = require('crypto');
const radius = require('radius');

// В контейнере состояние — на томе, слушаем все адреса (см. docker-compose.yml)
const STATE_DIR = process.env.DEMO_STATE_DIR || path.join(__dirname, 'state');
const SECRET_FILE = path.join(STATE_DIR, 'radius-secret');
const PORT = Number(process.env.DEMO_RADIUS_PORT || 1812);
const HOST = process.env.DEMO_HOST || '127.0.0.1';
const NEVER = '9223372036854775807';
const FILETIME_EPOCH_MS = 11644473600000n;
const fromFiletime = s => (!s || s === '0' || s === NEVER ? null : Number(BigInt(s) / 10000n - FILETIME_EPOCH_MS));

fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
// Секрет можно задать снаружи (контейнер: тот же, что ENT_RADIUS_SECRET у мессенджера)
if (process.env.DEMO_RADIUS_SECRET) { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(SECRET_FILE, process.env.DEMO_RADIUS_SECRET, { mode: 0o600 }); }
if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(24).toString('base64url'), { mode: 0o600 });
const secret = fs.readFileSync(SECRET_FILE, 'utf8').trim();
if (process.argv.includes('--init')) process.exit(0);

function check(user, password) {
  const st = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'directory.json'), 'utf8'));
  const sam = String(user || '').replace(/^.*\\/, '').replace(/@.*$/, '').toLowerCase();
  const p = st.people.find(x => x.sam === sam);
  if (!p || !password || password !== p.password) return [false, 'Неверный логин или пароль'];
  if (p.uac & 2) return [false, 'Учётная запись отключена'];
  const lt = fromFiletime(p.lockoutTime);
  if (lt !== null && Date.now() - lt < 30 * 60000) return [false, 'Учётная запись заблокирована'];
  const exp = fromFiletime(p.accountExpires);
  if (exp !== null && exp <= Date.now()) return [false, 'Срок учётной записи истёк'];
  return [true, 'Добро пожаловать'];
}

const sock = dgram.createSocket('udp4');
sock.on('message', (msg, rinfo) => {
  let req;
  try {
    req = radius.decode({ packet: msg, secret }); // неверный секрет — Message-Authenticator не сойдётся
  } catch (e) {
    console.log(`RADIUS: отброшен пакет от ${rinfo.address}: ${e.message}`);
    return;
  }
  if (req.code !== 'Access-Request') return;
  const user = req.attributes['User-Name'];
  const [ok, text] = check(user, req.attributes['User-Password']);
  console.log(`RADIUS: ${user} — ${ok ? 'принят' : 'отказ: ' + text}`);
  const resp = radius.encode_response({
    packet: req, code: ok ? 'Access-Accept' : 'Access-Reject', secret, attributes: [['Reply-Message', text]],
  });
  sock.send(resp, rinfo.port, rinfo.address);
});
sock.bind(PORT, HOST, () => console.log(`учебный RADIUS: udp ${HOST}:${PORT}`));
