// ═══════════════════════════════════════════════════════════════════
//  Проверка: приложение открывается БЕЗ СЕТИ и не ждёт сервер.
//
//  Эмулирует APK точно: запросы к messenger.example.org перехватываются и
//  оболочка отдаётся из локального dist — ровно так делает
//  MainActivity.shouldInterceptRequest из assets/www, сохраняя origin
//  домена. API при этом либо ходит в сеть, либо режется, когда
//  изображаем «интернета нет».
//
//  Зачем нужен. Список чатов лежал в IndexedDB, но экран занимала
//  крутилка до ответа сети: `loading` снимался только в finally
//  сетевого запроса. В метро приложение висело при полном кармане
//  данных. Тест ловит возврат этого поведения.
//
//  Запуск (из каталога web-client, dist должен быть собран):
//      node scripts/offline-test.cjs
// ═══════════════════════════════════════════════════════════════════

// puppeteer-core живёт вне проекта (~/.local/share/smess-testkit), чтобы npm install его не вычищал
const puppeteer = (() => { try { return require('puppeteer'); } catch { return require(require('os').homedir() + '/.local/share/smess-testkit/node_modules/puppeteer-core'); } })();
const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist');
const SERVER = 'https://messenger.example.org';
const U = 'offline_' + Date.now();
const PASS = 'Пароль-Длинный-2026';
const UA = 'Mozilla/5.0 (Linux; Android 13; RMX5120) AppleWebKit/537.36 (KHTML, like Gecko) ' +
           'Chrome/126.0 Mobile Safari/537.36 StorageMessApp/test';
const MIME = { '.js':'text/javascript', '.css':'text/css', '.html':'text/html',
               '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml',
               '.ico':'image/x-icon', '.webmanifest':'application/manifest+json', '.txt':'text/plain' };

let offline = false;

(async () => {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.error('Нет dist — сначала соберите веб: npm run build');
    process.exit(1);
  }

  // Своя учётка на каждый прогон: тест не зависит от чужих данных и не
  // портит настоящие.
  const reg = await fetch(`${SERVER}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: U, password: PASS, email: `${U}@example.com`,
                           display_name: 'Offline Test' }),
  });
  if (!reg.ok) { console.error('не удалось создать тестовую учётку:', reg.status); process.exit(1); }
  console.log('0. тестовая учётка', U, 'создана');

  const browser = await puppeteer.launch({
    executablePath: '/snap/bin/chromium', headless: 'new',
    args: ['--no-sandbox', '--ignore-certificate-errors', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setRequestInterception(true);

  page.on('request', req => {
    const url = req.url();
    if (!url.startsWith(SERVER)) return req.continue();

    const p = new URL(url).pathname;
    if (p.startsWith('/api/')) {
      return offline ? req.abort('internetdisconnected') : req.continue();
    }
    // Оболочка — из локальных файлов, как перехватчик в APK.
    let f = path.join(DIST, p);
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
    try {
      return req.respond({ status: 200,
        contentType: MIME[path.extname(f)] || 'application/octet-stream',
        body: fs.readFileSync(f) });
    } catch { return req.abort(); }
  });

  console.log('1. вход (сеть есть)…');
  await page.goto(`${SERVER}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('input', { timeout: 25000 });
  const inputs = await page.$$('input');
  await inputs[0].type(U);
  await inputs[1].type(PASS);
  await page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 12000));

  const cached = await page.evaluate(() => new Promise(res => {
    const rq = indexedDB.open('storage-mess-cache');
    rq.onsuccess = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains('chats')) return res(-1);
      const t = db.transaction('chats', 'readonly').objectStore('chats').getAll();
      t.onsuccess = () => res(t.result.length);
      t.onerror = () => res(-2);
    };
    rq.onerror = () => res(-3);
  }));
  console.log('   вошли, чатов в локальной базе:', cached);
  if (cached <= 0) { console.error('ПРОВАЛ: локальный кэш пуст, проверять нечего'); await browser.close(); process.exit(1); }

  console.log('2. интернета нет, перезапуск приложения…');
  offline = true;
  const t0 = Date.now();
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

  let seen = null, painted = null;
  for (let i = 0; i < 100; i++) {
    seen = await page.evaluate(() => ({
      spinner: !!document.querySelector('.animate-spin'),
      sidebar: !!document.querySelector('.messenger-sidebar'),
      nodes: document.querySelectorAll('.messenger-sidebar *').length,
    })).catch(() => null);
    if (seen && seen.sidebar && !seen.spinner) { painted = Date.now() - t0; break; }
    await new Promise(r => setTimeout(r, 100));
  }

  console.log('3. РЕЗУЛЬТАТ офлайн-старта');
  console.log('   интерфейс отрисован :', seen && seen.sidebar ? 'ДА' : 'НЕТ');
  console.log('   висит крутилка      :', seen && seen.spinner ? 'ДА' : 'нет');
  console.log('   узлов в сайдбаре    :', seen && seen.nodes);
  console.log('   время до интерфейса :', painted !== null ? painted + ' мс' : 'не дождался (10 с)');

  await browser.close();
  const ok = painted !== null && seen && seen.sidebar && !seen.spinner;
  console.log(ok ? '\n✓ приложение открывается без сети' : '\n✗ приложение без сети не открылось');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('ОШИБКА ТЕСТА:', e.message); process.exit(1); });
