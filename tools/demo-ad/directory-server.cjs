#!/usr/bin/env node
// =============================================================
// Учебный каталог в формате Active Directory — для показа
// корпоративного контура без настоящего домена.
//
//   LDAP   ldap://127.0.0.1:1389   DC=corp,DC=example
//   Панель http://127.0.0.1:9480   «как будто консоль AD»: отключить,
//          заблокировать, уволить, принять сотрудника
//
// Ведёт себя как AD там, где это важно для мессенджера:
//   • атрибуты и их форма: objectGUID (16 байт), sAMAccountName,
//     userPrincipalName, userAccountControl (0x2 — отключена),
//     lockoutTime и accountExpires (FILETIME), memberOf,
//     msDS-User-Account-Control-Computed (0x10 — заблокирована сейчас);
//   • вход по DN: неверный пароль — ошибка 49 с «data 52e», отключена —
//     «data 533», заблокирована — «data 775», срок истёк — «data 701»;
//     5 неверных паролей подряд — блокировка на 30 минут;
//   • пустой пароль — «вход без проверки» УСПЕШЕН, как у настоящего AD:
//     клиент обязан отсекать его сам (проверяется в e2e);
//   • искать может только вошедшая служебная учётка.
//
// Состояние — state/directory.json, пароли для показа — state/passwords.txt.
//   node directory-server.cjs           запустить
//   node directory-server.cjs --init    только создать состояние (если нет)
// =============================================================
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const ldap = require('ldapjs');

// В контейнере состояние — на томе, слушаем все адреса (см. docker-compose.yml)
const STATE_DIR = process.env.DEMO_STATE_DIR || path.join(__dirname, 'state');
const STATE = path.join(STATE_DIR, 'directory.json');
const PASSWORDS = path.join(STATE_DIR, 'passwords.txt');
const LDAP_PORT = Number(process.env.DEMO_LDAP_PORT || 1389);
const PANEL_PORT = Number(process.env.DEMO_PANEL_PORT || 9480);
const HOST = process.env.DEMO_HOST || '127.0.0.1';

const BASE = 'DC=corp,DC=example';
const UPN = 'corp.example';
const STAFF = `OU=Staff,${BASE}`;
const GROUPS = `OU=Groups,${BASE}`;
const G_USERS = `CN=Messenger Users,${GROUPS}`;
const G_ADMINS = `CN=Messenger Admins,${GROUPS}`;
const SVC_DN = `CN=svc-messenger,OU=Service Accounts,${BASE}`;
const LOCKOUT_MIN = 30;
const LOCKOUT_THRESHOLD = 5;
const NEVER = '9223372036854775807';

// ── время в форматах AD ───────────────────────────────────────
const FILETIME_EPOCH_MS = 11644473600000n;
const toFiletime = ms => ((BigInt(Math.round(ms)) + FILETIME_EPOCH_MS) * 10000n).toString();
const fromFiletime = s => (!s || s === '0' || s === NEVER ? null : Number(BigInt(s) / 10000n - FILETIME_EPOCH_MS));
const genTime = ms => new Date(ms).toISOString().replace(/[-:T]/g, '').replace(/\.\d+Z$/, '.0Z');

// ── состояние ─────────────────────────────────────────────────
const pw = () => 'Zima-' + crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x') + '7';
const guid = () => crypto.randomBytes(16).toString('hex');

const PEOPLE = [
  ['ivanov', 'Иван Иванов', 'Отдел продаж', 'Менеджер по продажам', true],
  ['petrova', 'Анна Петрова', 'Бухгалтерия', 'Главный бухгалтер', true],
  ['sidorov', 'Сергей Сидоров', 'ИТ-отдел', 'Системный администратор', true, true],
  ['kuznetsova', 'Мария Кузнецова', 'Отдел кадров', 'Специалист по кадрам', true],
  ['smirnov', 'Алексей Смирнов', 'Склад', 'Кладовщик', true],
  ['volkova', 'Елена Волкова', 'Юридический отдел', 'Юрист', true],
  ['morozov', 'Дмитрий Морозов', 'Служба безопасности', 'Начальник смены', true],
  ['lebedeva', 'Ольга Лебедева', 'Отдел продаж', 'Стажёр', false], // ещё не в группе мессенджера
];

function newPerson(sam, name, dept, title, inGroup, admin) {
  const now = Date.now();
  return {
    sam, name, dept, title, guid: guid(), password: pw(), uac: 512, lockoutTime: '0', badPwd: 0,
    accountExpires: NEVER, groups: [...(inGroup ? [G_USERS] : []), ...(admin ? [G_ADMINS] : [])],
    created: now, changed: now,
  };
}

function initState() {
  if (fs.existsSync(STATE)) return false;
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const st = { svcPassword: process.env.DEMO_SVC_PASSWORD || pw(), people: PEOPLE.map(p => newPerson(...p)), computers: ['WS-001', 'WS-002'] };
  save(st);
  return true;
}

function load() {
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  // В контейнере пароль служебной учётки задаёт .env (тот же, что ENT_LDAP_BIND_PASSWORD у мессенджера)
  if (process.env.DEMO_SVC_PASSWORD) st.svcPassword = process.env.DEMO_SVC_PASSWORD;
  return st;
}

function save(st) {
  fs.writeFileSync(STATE + '.tmp', JSON.stringify(st, null, 1), { mode: 0o600 });
  fs.renameSync(STATE + '.tmp', STATE);
  const lines = [
    '# Учебный каталог STORAGE&MESS — пароли для показа (не настоящие).',
    `# Служебная учётка мессенджера: ${SVC_DN}`,
    `svc-messenger  ${st.svcPassword}`,
    '# Сотрудники (логин  пароль  ФИО):',
    ...st.people.map(p => `${p.sam.padEnd(12)} ${p.password}  ${p.name}`),
  ];
  // Пароль аварийного админа мессенджера хранит start-demo.sh отдельно — дописываем
  try {
    const bg = fs.readFileSync(path.join(STATE_DIR, 'breakglass-password'), 'utf8').trim();
    if (bg) lines.push('# Аварийный локальный администратор мессенджера (когда домен лежит):', `avaria       ${bg}`);
  } catch { /* ещё нет */ }
  fs.writeFileSync(PASSWORDS, lines.join('\n') + '\n', { mode: 0o600 });
}

const personDn = p => `CN=${p.name},${STAFF}`;
const lockedNow = p => {
  const t = fromFiletime(p.lockoutTime);
  return t !== null && Date.now() - t < LOCKOUT_MIN * 60000;
};

function personEntry(p) {
  return {
    dn: personDn(p),
    attributes: {
      objectClass: ['top', 'person', 'organizationalPerson', 'user'],
      objectCategory: 'person',
      cn: p.name,
      displayName: p.name,
      sAMAccountName: p.sam,
      userPrincipalName: `${p.sam}@${UPN}`,
      mail: `${p.sam}@${UPN}`,
      department: p.dept,
      title: p.title,
      objectGUID: Buffer.from(p.guid, 'hex'),
      userAccountControl: String(p.uac),
      'msDS-User-Account-Control-Computed': String(lockedNow(p) ? 0x10 : 0),
      lockoutTime: p.lockoutTime,
      accountExpires: p.accountExpires,
      memberOf: p.groups,
      whenCreated: genTime(p.created),
      whenChanged: genTime(p.changed),
    },
  };
}

function allEntries(st) {
  const out = st.people.map(personEntry);
  for (const c of st.computers) {
    out.push({ dn: `CN=${c},OU=Computers,${BASE}`, attributes: {
      objectClass: ['top', 'person', 'organizationalPerson', 'user', 'computer'], objectCategory: 'computer',
      cn: c, sAMAccountName: c + '$', userAccountControl: '4096', objectGUID: Buffer.from(guid(), 'hex'),
    } });
  }
  for (const g of [G_USERS, G_ADMINS]) {
    out.push({ dn: g, attributes: {
      objectClass: ['top', 'group'], objectCategory: 'group', cn: g.slice(3, g.indexOf(',')),
      member: st.people.filter(p => p.groups.includes(g)).map(personDn),
    } });
  }
  return out;
}

// ── сравнение DN и фильтры (значения в AD сравниваются без учёта регистра) ──
// ldapjs отдаёт DN с экранированными байтами UTF-8 (CN=\d0\98…) — раскрываем
function unescapeDn(s) {
  const bytes = [];
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\' && /^[0-9a-fA-F]{2}$/.test(str.slice(i + 1, i + 3))) { bytes.push(parseInt(str.slice(i + 1, i + 3), 16)); i += 2; }
    else if (str[i] === '\\' && i + 1 < str.length) { bytes.push(...Buffer.from(str[i + 1])); i += 1; }
    else bytes.push(...Buffer.from(str[i]));
  }
  return Buffer.from(bytes).toString('utf8');
}
const normDn = s => unescapeDn(s).replace(/\s*,\s*/g, ',').replace(/\s*=\s*/g, '=').trim().toLowerCase();
const inScope = (dn, base, scope) => {
  const d = normDn(dn), b = normDn(base);
  if (scope === 'base') return d === b;
  if (!d.endsWith(b)) return false;
  if (scope === 'one') return d !== b && d.slice(0, d.length - b.length - 1).indexOf(',') < 0;
  return true;
};
function valuesOf(attrs, name) {
  const key = Object.keys(attrs).find(k => k.toLowerCase() === String(name).toLowerCase());
  if (!key) return [];
  const v = attrs[key];
  return (Array.isArray(v) ? v : [v]).map(x => (Buffer.isBuffer(x) ? x.toString('hex') : String(x).toLowerCase()));
}
function matches(f, attrs) {
  const t = f.type || f.constructor?.name || '';
  const val = x => (Buffer.isBuffer(x) ? x.toString('hex') : String(x ?? '').toLowerCase());
  switch (t) {
    case 'AndFilter': return f.filters.every(x => matches(x, attrs));
    case 'OrFilter': return f.filters.some(x => matches(x, attrs));
    case 'NotFilter': return !matches(f.filter, attrs);
    case 'PresenceFilter': return valuesOf(attrs, f.attribute).length > 0;
    case 'EqualityFilter': return valuesOf(attrs, f.attribute).includes(val(f.raw ?? f.value));
    case 'SubstringFilter': {
      const parts = [f.subInitial, ...(f.subAny || []), f.subFinal].map(x => (x ? val(x) : ''));
      const rx = new RegExp('^' + parts.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
      return valuesOf(attrs, f.attribute).some(v => rx.test(v));
    }
    default: try { return f.matches(attrs, false); } catch { return false; }
  }
}

// ── LDAP ─────────────────────────────────────────────────────
// Отказ как у AD: код 49 и пояснение «…data 52e…». В ldapjs 3 текст отказа
// живёт в diagnosticMessage — через ошибку в next() он теряется.
function adFail(res, code, text) {
  res.status = 49;
  res.diagnosticMessage = `80090308: LdapErr: DSID-0C09044E, comment: AcceptSecurityContext error, data ${code}, v4563 (${text})`;
  return res.end();
}

function startLdap() {
  const server = ldap.createServer();
  server.bind(BASE, (req, res, next) => {
    const dn = normDn(req.dn.toString());
    const password = String(req.credentials ?? '');
    // Как у AD: пустой пароль — «вход без проверки», он «удаётся»
    if (password === '') { res.end(); return next(); }
    const st = load();
    if (dn === normDn(SVC_DN)) {
      if (password === st.svcPassword) { res.end(); return next(); }
      return adFail(res, '52e', 'неверный пароль служебной учётки');
    }
    const p = st.people.find(x => normDn(personDn(x)) === dn);
    if (!p) return adFail(res, '52e', 'нет такой учётки');
    // Как у AD: «заблокирована» — при любом пароле; «отключена» и «срок
    // истёк» — только при верном (иначе по ответу можно угадывать пароль)
    if (lockedNow(p)) return adFail(res, '775', 'учётка заблокирована');
    if (password !== p.password) {
      p.badPwd = (p.badPwd || 0) + 1;
      if (p.badPwd >= LOCKOUT_THRESHOLD) { p.lockoutTime = toFiletime(Date.now()); p.changed = Date.now(); p.badPwd = 0; }
      save(st);
      return adFail(res, '52e', 'неверный пароль');
    }
    if (p.uac & 2) return adFail(res, '533', 'учётка отключена');
    const exp = fromFiletime(p.accountExpires);
    if (exp !== null && exp <= Date.now()) return adFail(res, '701', 'срок учётки истёк');
    if (p.badPwd || p.lockoutTime !== '0') { p.badPwd = 0; p.lockoutTime = '0'; save(st); }
    res.end();
    return next();
  });
  server.search(BASE, (req, res, next) => {
    const who = req.connection?.ldap?.bindDN ? normDn(req.connection.ldap.bindDN.toString()) : '';
    if (who !== normDn(SVC_DN)) return next(new ldap.InsufficientAccessRightsError('искать может только служебная учётка'));
    const base = req.dn.toString() || BASE;
    const scope = req.scope || 'sub';
    // Отбор атрибутов сами: ldapjs сравнивает их имена с учётом регистра
    const want = new Set((req.attributes || []).map(a => String(a).toLowerCase()));
    if (Array.isArray(res.attributes)) res.attributes = res.attributes.map(a => String(a).toLowerCase());
    const all = want.size === 0 || want.has('*');
    for (const e of allEntries(load())) {
      if (!inScope(e.dn, base, scope) || !matches(req.filter, e.attributes)) continue;
      const attributes = {};
      for (const [k, v] of Object.entries(e.attributes)) if (all || want.has(k.toLowerCase())) attributes[k] = v;
      res.send({ dn: e.dn, attributes }, true);
    }
    res.end();
    return next();
  });
  server.listen(LDAP_PORT, HOST, () => console.log(`учебный AD: ldap://${HOST}:${LDAP_PORT}  ${BASE}`));
}

// ── панель «консоль AD» ──────────────────────────────────────
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function stateLabel(p) {
  if (p.uac & 2) return ['отключена', 'off'];
  if (lockedNow(p)) return ['заблокирована', 'lock'];
  const exp = fromFiletime(p.accountExpires);
  if (exp !== null && exp <= Date.now()) return ['срок истёк', 'exp'];
  if (!p.groups.includes(G_USERS)) return ['нет в группе мессенджера', 'out'];
  return ['активна', 'ok'];
}

function act(st, sam, a) {
  const p = st.people.find(x => x.sam === sam);
  if (!p) return 'нет такого сотрудника';
  const now = Date.now();
  const ops = {
    disable: () => { p.uac |= 2; },
    enable: () => { p.uac &= ~2; },
    lock: () => { p.lockoutTime = toFiletime(now); },
    unlock: () => { p.lockoutTime = '0'; p.badPwd = 0; },
    fire: () => { p.groups = p.groups.filter(g => g !== G_USERS && g !== G_ADMINS); },
    hire: () => { if (!p.groups.includes(G_USERS)) p.groups.push(G_USERS); },
    expire: () => { p.accountExpires = toFiletime(now - 60000); },
    extend: () => { p.accountExpires = NEVER; },
    admin: () => { if (!p.groups.includes(G_ADMINS)) p.groups.push(G_ADMINS); },
    unadmin: () => { p.groups = p.groups.filter(g => g !== G_ADMINS); },
    delete: () => { st.people = st.people.filter(x => x !== p); },
  };
  if (!ops[a]) return 'нет такого действия';
  ops[a]();
  p.changed = now;
  save(st);
  return null;
}

function page(st, note) {
  const rows = st.people.map(p => {
    const [label, cls] = stateLabel(p);
    const b = (a, t, warn) => `<button name="a" value="${a}" class="${warn ? 'warn' : ''}">${t}</button>`;
    return `<tr><td><b>${esc(p.name)}</b><br><span class="m">${esc(p.sam)}@${UPN}</span></td>
      <td>${esc(p.dept)}<br><span class="m">${esc(p.title)}</span></td>
      <td><span class="st ${cls}">${label}</span>${p.groups.includes(G_ADMINS) ? ' <span class="st adm">админ</span>' : ''}</td>
      <td><form method="post" action="/act"><input type="hidden" name="sam" value="${esc(p.sam)}">
        ${p.uac & 2 ? b('enable', 'Включить') : b('disable', 'Отключить', 1)}
        ${lockedNow(p) ? b('unlock', 'Снять блокировку') : b('lock', 'Заблокировать')}
        ${p.groups.includes(G_USERS) ? b('fire', 'Уволить (из группы)', 1) : b('hire', 'В группу')}
        ${fromFiletime(p.accountExpires) !== null ? b('extend', 'Продлить') : b('expire', 'Срок истёк')}
        ${p.groups.includes(G_ADMINS) ? b('unadmin', 'Снять админа') : b('admin', 'Сделать админом')}
        ${b('delete', 'Удалить', 1)}
      </form></td></tr>`;
  }).join('');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Учебный AD — CORP</title><style>
body{font:14px/1.4 system-ui,sans-serif;margin:0;background:#f3f4f6;color:#111}
header{background:#1e3a8a;color:#fff;padding:14px 20px}header b{font-size:18px}
main{padding:16px 20px;max-width:1200px}table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden}
td,th{padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:left;vertical-align:top}th{background:#eef2ff;font-weight:600}
.m{color:#6b7280;font-size:12px}button{margin:2px;padding:4px 8px;border:1px solid #cbd5e1;background:#fff;border-radius:6px;cursor:pointer}
button.warn{border-color:#fca5a5;color:#b91c1c}.st{padding:2px 8px;border-radius:10px;font-size:12px;white-space:nowrap}
.ok{background:#dcfce7;color:#166534}.off{background:#fee2e2;color:#991b1b}.lock{background:#fef3c7;color:#92400e}
.exp{background:#e5e7eb;color:#374151}.out{background:#e0e7ff;color:#3730a3}.adm{background:#ede9fe;color:#5b21b6}
.note{background:#fff7ed;border:1px solid #fed7aa;padding:8px 12px;border-radius:8px;margin-bottom:12px}
form.new{background:#fff;padding:12px;border-radius:8px;margin-top:14px}form.new input{padding:5px;margin:3px;border:1px solid #cbd5e1;border-radius:6px}
</style></head><body><header><b>Active Directory — домен CORP</b> · учебный каталог для показа STORAGE&amp;MESS · ${esc(BASE)}</header><main>
${note ? `<div class="note">${esc(note)}</div>` : ''}
<p class="m">Доступ к мессенджеру даёт группа <b>Messenger Users</b>, админку — <b>Messenger Admins</b>. Мессенджер сверяется с каталогом раз в несколько секунд.
«Заблокировать» — как 5 неверных паролей: новый вход закрыт, но открытые сессии не рвутся. «Отключить», «Уволить», «Срок истёк», «Удалить» — учётка мессенджера схлопывается.</p>
<table><tr><th>Сотрудник</th><th>Отдел, должность</th><th>Состояние в AD</th><th>Действия</th></tr>${rows}</table>
<form class="new" method="post" action="/new"><b>Новый сотрудник</b><br>
<input name="name" placeholder="Фамилия Имя" required> <input name="sam" placeholder="логин (латиницей)" pattern="[a-z][a-z0-9._-]{1,30}" required>
<input name="dept" placeholder="Отдел"> <input name="title" placeholder="Должность"> <label><input type="checkbox" name="group" checked> в группу мессенджера</label>
<button>Создать</button></form>
<p class="m">Пароли для показа — tools/demo-ad/state/passwords.txt</p></main></body></html>`;
}

function readBody(req) {
  return new Promise(r => { let b = ''; req.on('data', d => { b += d; if (b.length > 1e5) req.destroy(); }); req.on('end', () => r(new URLSearchParams(b))); });
}

function startPanel() {
  http.createServer(async (req, res) => {
    const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };
    const back = note => { res.writeHead(303, { location: '/' + (note ? '?note=' + encodeURIComponent(note) : '') }); res.end(); };
    try {
      const u = new URL(req.url, 'http://x');
      if (req.method === 'GET' && u.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(page(load(), u.searchParams.get('note')));
      }
      if (req.method === 'GET' && u.pathname === '/api/people') {
        return json(200, load().people.map(p => ({ sam: p.sam, name: p.name, state: stateLabel(p)[1], groups: p.groups })));
      }
      if (req.method === 'POST' && (u.pathname === '/act' || u.pathname === '/api/act')) {
        const f = await readBody(req);
        const st = load();
        const err = act(st, f.get('sam'), f.get('a'));
        if (u.pathname === '/api/act') return json(err ? 400 : 200, err ? { error: err } : { ok: true });
        const p = st.people.find(x => x.sam === f.get('sam'));
        return back(err || `${p ? p.name : f.get('sam')}: ${p ? stateLabel(p)[0] : 'удалена из каталога'}`);
      }
      if (req.method === 'POST' && (u.pathname === '/new' || u.pathname === '/api/new')) {
        const f = await readBody(req);
        const sam = String(f.get('sam') || '').toLowerCase();
        const name = String(f.get('name') || '').trim();
        const st = load();
        if (!/^[a-z][a-z0-9._-]{1,30}$/.test(sam) || !name || st.people.some(p => p.sam === sam)) {
          return u.pathname === '/api/new' ? json(400, { error: 'логин занят или неверен' }) : back('Логин занят или неверен');
        }
        const p = newPerson(sam, name, String(f.get('dept') || ''), String(f.get('title') || ''), f.get('group') !== null && f.get('group') !== '0');
        st.people.push(p);
        save(st);
        return u.pathname === '/api/new' ? json(200, { ok: true, password: p.password }) : back(`${name} создан(а), пароль — в passwords.txt`);
      }
      res.writeHead(404); res.end();
    } catch (e) {
      json(500, { error: String(e.message || e) });
    }
  }).listen(PANEL_PORT, HOST, () => console.log(`консоль учебного AD: http://${HOST}:${PANEL_PORT}`));
}

const created = initState();
if (process.argv.includes('--passwords')) save(load()); // обновить passwords.txt
if (created) console.log('учебный каталог создан, пароли — ' + PASSWORDS);
if (!process.argv.includes('--init')) { startLdap(); startPanel(); }
