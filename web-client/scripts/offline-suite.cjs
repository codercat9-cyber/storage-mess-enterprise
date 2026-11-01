// ═══════════════════════════════════════════════════════════════════
//  Аварийный режим: приложение без сервера. Набор проверок этапа 1.
//
//  Эмулирует APK: оболочка отдаётся из локального dist с origin домена,
//  как перехватчик MainActivity. Сеть ломается двумя способами:
//    down       — запросы падают сразу (нет интернета);
//    blackhole  — запросы висят без ответа (DPI глотает пакеты) — худший
//                 случай: интерфейс, ждущий сеть, тут висит вечно.
//
//  Проверяется: старт без сервера, открытие чата из кэша, отправка без
//  сервера (часики), доставка после возврата сети.
//
//  Учётка одна и та же (smess_offline_test) — тест не плодит мусор.
//  Запуск из web-client (dist собран):  node scripts/offline-suite.cjs
// ═══════════════════════════════════════════════════════════════════
// puppeteer-core живёт вне проекта (~/.local/share/smess-testkit), чтобы npm install его не вычищал
const puppeteer = (() => { try { return require('puppeteer'); } catch { return require(require('os').homedir() + '/.local/share/smess-testkit/node_modules/puppeteer-core'); } })();
const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist');
const SERVER = process.env.SMESS_SERVER || 'https://messenger.example.org';
const U = 'smess_offline_test';
const PASS = process.env.SMESS_TEST_PASS || 'Офлайн-Проверка-2026-Длинный';
const UA = 'Mozilla/5.0 (Linux; Android 13; RMX5120) AppleWebKit/537.36 (KHTML, like Gecko) ' +
           'Chrome/126.0 Mobile Safari/537.36 StorageMessApp/test';
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json',
               '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
               '.webmanifest': 'application/manifest+json', '.txt': 'text/plain', '.webp': 'image/webp' };
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  — ' + extra : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(method, p, token, body) {
  const r = await fetch(SERVER + '/api' + p, {
    method, headers: { 'Content-Type': 'application/json', 'User-Agent': UA, ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = {}; try { j = await r.json(); } catch { /* */ }
  return [r.status, j];
}

(async () => {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) { console.error('Нет dist — соберите веб'); process.exit(1); }

  // ── учётка ──
  let [st, j] = await api('POST', '/auth/login', null, { username: U, password: PASS });
  if (st !== 200) {
    [st, j] = await api('POST', '/auth/register', null, { username: U, password: PASS, display_name: 'Офлайн-тест', terms_version: '2026-11-01' });
    if (st !== 201 && st !== 200) { console.error('учётка не создана:', st, j); process.exit(1); }
  }
  const token = j.accessToken;
  await api('POST', '/chats/favorites', token);   // «Избранное» создаётся по первому запросу
  const [, chats] = await api('GET', '/chats', token);
  const fav = (chats.chats || []).find(c => c.type === 'favorites') || (chats.chats || [])[0];
  if (!fav) { console.error('нет ни одного чата у тестовой учётки'); process.exit(1); }
  const marker = 'офлайн-метка ' + Date.now();
  await api('POST', `/chats/${fav.id}/messages`, token, { content: marker });
  await api('POST', '/legal/accept', token, { version: '2026-11-01' });
  console.log(`учётка ${U}, чат «${fav.name || 'Избранное'}», метка «${marker}»`);

  const browser = await puppeteer.launch({ executablePath: '/snap/bin/chromium', headless: 'new',
    args: ['--no-sandbox', '--ignore-certificate-errors', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setViewport({ width: 400, height: 800 });
  const cdp = await page.target().createCDPSession();
  const logs = [];
  let step5 = false;
  page.on('console', m => { const t = m.text(); if (step5 || /queue|Flush|flush|📦|📤|❌|MESH/i.test(t)) logs.push(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${t.slice(0, 160)}`); });
  const T0 = Date.now();
  // Веб-сокет перехватом и блок-листом не глушится — подменяем его в странице:
  // при аварии соединение идёт в никуда (down — сразу отказ, blackhole — висит)
  await page.evaluateOnNewDocument(() => {
    const WS = window.WebSocket;
    window.WebSocket = function (url, proto) {
      const net = localStorage.getItem('__net') || 'online';
      if (net === 'down') return new WS('ws://127.0.0.1:9/', proto);
      if (net === 'blackhole') return new WS('ws://10.255.255.1:9/', proto);
      return new WS(url, proto);
    };
    window.WebSocket.prototype = WS.prototype;
    Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  });
  await page.setRequestInterception(true);
  let mode = 'online';
  const held = [];
  page.on('request', req => {
    const url = req.url();
    // Все адреса сервера — домен, запасные имена, прямые IP: авария глушит всё
    const isServer = /^https?:\/\/(storage-mess\.online|smess\.duckdns\.org|94\.19\.2\.193|192\.168\.0\.118|\[?201:f3be)/.test(url);
    if (isServer && !url.startsWith(SERVER) && mode !== 'online') {
      const p2 = new URL(url).pathname;
      if (p2.startsWith('/api/') || p2.startsWith('/socket.io')) {
        if (mode === 'down') return req.abort('internetdisconnected');
        held.push(req); return;
      }
    }
    if (!url.startsWith(SERVER)) {
      if (mode !== 'online' && /^https?:/.test(url)) logs.push(`[${((Date.now() - T0) / 1000).toFixed(1)}s] мимо перехвата: ${url.slice(0, 90)}`);
      return req.continue();
    }
    const p = new URL(url).pathname;
    if (req.method() === 'POST' && /\/messages$/.test(p)) logs.push(`[${((Date.now() - T0) / 1000).toFixed(1)}s] >>> POST ${p} режим=${mode}`);
    if (p.startsWith('/api/') || p.startsWith('/socket.io')) {
      if (mode === 'down') return req.abort('internetdisconnected');
      if (mode === 'blackhole') { held.push(req); return; }       // висит без ответа
      return req.continue();
    }
    let f = path.join(DIST, decodeURIComponent(p));
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
    try { return req.respond({ status: 200, contentType: MIME[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) }); }
    catch { return req.abort(); }
  });
  const setNet = async m => {
    mode = m;
    await page.evaluate(v => localStorage.setItem('__net', v), m).catch(() => {});
    // Веб-сокеты перехватом не ловятся — режем их правилом блокировки
    await cdp.send('Network.setBlockedURLs', { urls: m === 'online' ? [] : ['*/api/sync/*', '*socket.io*'] });
    if (m === 'online') while (held.length) { try { held.shift().continue(); } catch { /* */ } }
  };
  const ui = () => page.evaluate(() => ({
    fav: !!Array.from(document.querySelectorAll('div,span')).find(e => e.childElementCount === 0 && /Избранное/.test(e.textContent || '')),
    spinner: !!document.querySelector('.animate-spin'),
  })).catch(() => ({}));
  async function coldStart(label) {
    const t0 = Date.now();
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    for (let i = 0; i < 100; i++) {
      const s = await ui();
      if (s.fav) return Date.now() - t0;
      await sleep(100);
    }
    return null;
  }

  // ── 1. вход при живой сети: наполняем локальную базу ──
  console.log('1. вход, сеть есть');
  await page.goto(`${SERVER}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate((t, rt, user) => {
    localStorage.setItem('kotex-auth', JSON.stringify({ state: { accessToken: t, refreshToken: rt, user, isAuthenticated: true }, version: 0 }));
    localStorage.setItem('terms_accepted_version', '2026-11-01');
    localStorage.setItem('smess_test', '1');
  }, token, j.refreshToken, j.user);
  const online = await coldStart('online');
  check('интерфейс с сетью', online !== null, online + ' мс');
  await sleep(6000); // дать кэшу наполниться
  if (process.env.OPEN_ONLINE) {
    await page.evaluate(() => { const el = Array.from(document.querySelectorAll('div,span')).find(e => e.childElementCount === 0 && /Избранное/.test(e.textContent || '')); el && el.click(); });
    await sleep(4000);
    console.log('   (чат открыт при сети — сообщения закэшированы)');
  }

  // ── 2. сети нет ──
  console.log('2. интернета нет (запросы падают)');
  await setNet('down');
  let t = await coldStart('down');
  check('старт без сети', t !== null && t < 3000, t === null ? 'не дождался 10 с' : t + ' мс');

  // ── 3. чёрная дыра ──
  console.log('3. чёрная дыра (запросы висят — как под DPI)');
  await setNet('blackhole');
  t = await coldStart('blackhole');
  check('старт при зависшей сети', t !== null && t < 3000, t === null ? 'не дождался 10 с' : t + ' мс');

  // ── 4. открыть чат из кэша ──
  console.log('4. открываю «Избранное» без сервера');
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('div,span')).find(e => e.childElementCount === 0 && /Избранное/.test(e.textContent || ''));
    el && el.click();
  });
  let seen = false;
  const t4 = Date.now();
  for (let i = 0; i < 40 && !seen; i++) { seen = await page.evaluate(m => document.body.innerText.includes(m), marker); if (!seen) await sleep(100); }
  check('сообщения чата из кэша', seen, seen ? (Date.now() - t4) + ' мс' : 'метки нет на экране за 4 с');

  // ── 5. отправка без сервера ──
  console.log('5. пишу без сервера'); step5 = true; logs.push('--- шаг 5 ---');
  const draft = 'из офлайна ' + Date.now();
  const typed = await page.evaluate(() => { const e = document.querySelector('[contenteditable="true"]'); if (!e) return false; e.focus(); return true; });
  // На Android Enter — перевод строки, отправка — кнопкой
  if (typed) {
    await page.keyboard.type(draft);
    await sleep(300);
    await page.evaluate(() => { const b = document.querySelector('button svg.lucide-send')?.closest('button'); b && b.click(); });
  }
  // Держим аварию дольше таймаута отправки (10 с): сообщение обязано лечь в очередь
  await sleep(25000);
  const st5 = await page.evaluate(d => ({
    shown: document.body.innerText.includes(d),
    inputEmpty: !(document.querySelector('[contenteditable="true"]')?.textContent || '').includes(d),
  }), draft);
  check('сообщение сразу на экране (отправлено, не черновик)', typed && st5.shown && st5.inputEmpty, typed ? JSON.stringify(st5) : 'нет поля ввода');

  // ── 6. сеть вернулась ──
  console.log('6. сеть вернулась');
  await setNet('online');
  let delivered = false;
  for (let i = 0; i < 90 && !delivered; i++) {
    await sleep(1000);
    const [, ms] = await api('GET', `/chats/${fav.id}/messages?limit=20`, token);
    delivered = (ms.messages || []).some(m => m.content === draft);
  }
  check('дошло до сервера после возврата сети', delivered);
  await sleep(2000);
  const copies = await page.evaluate(d => document.body.innerText.split(d).length - 1, draft);
  check('на экране одна копия, без дублей', copies === 1, `копий: ${copies}`);

  // ── 7. склейка mesh + сервер по client_id ──
  console.log('7. копия из mesh, потом та же с сервера');
  const meshText = 'mesh-склейка ' + Date.now();
  const cid = 'pending-' + Date.now() + '-meshtest';
  const immediate = await page.evaluate((chatId, userId, text, cid) => {
    window.dispatchEvent(new CustomEvent('mesh-message', { detail: { id: cid, cid, chatId, userId, name: 'Офлайн-тест', text, ts: Date.now(), hops: 1 } }));
    const st = window.__chatStore.getState();
    return (st.messages[chatId] || []).filter(m => m.content === text).map(m => m.id);
  }, fav.id, j.user.id, meshText, cid);
  console.log('   сразу после события:', JSON.stringify(immediate));
  await sleep(800);
  const inStore = (t, chatId) => page.evaluate((t, chatId) => {
    const st = window.__chatStore?.getState();
    return (st?.messages?.[chatId] || []).filter(m => m.content === t).map(m => m.id);
  }, t, chatId);
  console.log('   хранилище:', JSON.stringify(await page.evaluate(chatId => {
    const st = window.__chatStore?.getState();
    return { есть: !!st, флаг: localStorage.getItem('smess_test'), чатов: st?.chats?.length, idЧатов: (st?.chats || []).slice(0, 3).map(c => c.id), сообщений: (st?.messages?.[chatId] || []).length, ключи: Object.keys(st?.messages || {}).slice(0, 3) };
  }, fav.id)));
  const meshIds = await inStore(meshText, fav.id);
  const meshShown = meshIds.length === 1 && meshIds[0].startsWith('mesh-');
  if (!meshShown) console.log('   журнал:', logs.filter(l => /MESH|mesh|Socket|socket/.test(l)).slice(-8).join('\n   '), '\n   адрес:', page.url());
  await api('POST', `/chats/${fav.id}/messages`, token, { content: meshText, client_id: cid });
  await sleep(3000);
  const after = await inStore(meshText, fav.id);
  check('mesh-копия сразу в чате', meshShown, JSON.stringify(meshIds));
  check('серверная копия заменила mesh-копию (одна, с номером сервера)', after.length === 1 && !after[0].startsWith('mesh-'), JSON.stringify(after));
  const [, again] = await api('POST', `/chats/${fav.id}/messages`, token, { content: meshText, client_id: cid });
  check('повтор с тем же client_id сервер не дублирует', again.duplicate === true);
  if (!delivered || process.env.LOGS) console.log('--- журнал приложения:\n' + logs.slice(-40).join('\n'));

  await browser.close();
  const ok = results.every(Boolean);
  console.log(ok ? '\n✓ аварийный режим: всё прошло' : `\n✗ провалено: ${results.filter(x => !x).length} из ${results.length}`);
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('ОШИБКА ТЕСТА:', e.stack || e.message); process.exit(1); });
