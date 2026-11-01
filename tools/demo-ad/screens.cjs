#!/usr/bin/env node
// Скриншоты демо для README и презентации (на запущенном start-demo.sh).
//   node tools/demo-ad/screens.cjs  → docs/screens/*.png
const fs = require('fs');
const os = require('os');
const path = require('path');

const puppeteer = (() => {
  try { return require('puppeteer'); } catch { return require(os.homedir() + '/.local/share/smess-testkit/node_modules/puppeteer-core'); }
})();
const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'docs', 'screens');
const APP = 'http://127.0.0.1:9400';
const PANEL = 'http://127.0.0.1:9480';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const pw = {};
for (const l of fs.readFileSync(path.join(__dirname, 'state', 'passwords.txt'), 'utf8').split('\n')) {
  const m = /^([a-z][\w.-]*)\s+(\S+)/.exec(l);
  if (m) pw[m[1]] = m[2];
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function clickText(page, text, sel = 'button') {
  const ok = await page.evaluate((t, s) => {
    const el = [...document.querySelectorAll(s)].find(b => b.textContent.trim().includes(t));
    if (el) { el.click(); return true; }
    return false;
  }, text, sel);
  if (!ok) {
    await page.screenshot({ path: path.join(OUT, '_debug.png') });
    const txt = await page.evaluate(() => document.body.innerText.slice(0, 600));
    throw new Error('нет кнопки «' + text + '» на ' + page.url() + '\n' + txt);
  }
}

// Убрать с экрана окно правил (принять) и предложение установить приложение
async function tidy(page) {
  for (let i = 0; i < 2; i++) {
    const boxes = await page.$$('input[type="checkbox"]');
    if (boxes.length) {
      for (const b of boxes) { const on = await b.evaluate(x => x.checked); if (!on) await b.click(); }
      await page.evaluate(() => [...document.querySelectorAll('button')].find(x => /Принимаю/.test(x.textContent))?.click());
      await sleep(1200);
    }
    await page.evaluate(() => [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Позже')?.click());
    await sleep(400);
  }
}

async function login(page, user, pass) {
  await page.goto(APP + '/login', { waitUntil: 'networkidle2' });
  const inputs = await page.$$('form input');
  await inputs[0].click({ clickCount: 3 }); await inputs[0].type(user);
  await inputs[1].click({ clickCount: 3 }); await inputs[1].type(pass);
  await page.click('form button[type="submit"]');
  await sleep(2500);
  // Условия использования (первый вход): отметить и принять
  const boxes = await page.$$('input[type="checkbox"]');
  if (boxes.length) {
    for (const b of boxes) await b.click();
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /Принять|Продолжить|Согласен/i.test(x.textContent)); b?.click(); });
    await sleep(1500);
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: '/snap/bin/chromium', headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1400,900', '--lang=ru'] });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
    const shot = async name => { await page.screenshot({ path: path.join(OUT, name + '.png') }); console.log('  ✓', name); };

    await page.goto(APP + '/login', { waitUntil: 'networkidle2' });
    await sleep(800);
    await shot('01-vhod-domenom');

    await page.goto(PANEL, { waitUntil: 'networkidle2' });
    await shot('02-konsol-ad');

    await login(page, 'avaria', pw.avaria);
    await page.goto(APP + '/admin', { waitUntil: 'networkidle2' });
    await sleep(1500);
    await tidy(page);
    await clickText(page, 'Корпоративный контур');
    await sleep(2500);
    await tidy(page);
    await shot('03-korporativnyi-kontur');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(500);

    // Отключаем сотрудника в «консоли AD» и ждём, пока мессенджер это увидит
    await fetch(PANEL + '/api/act', { method: 'POST', body: new URLSearchParams({ sam: 'volkova', a: 'disable' }) });
    await sleep(15000);
    await page.reload({ waitUntil: 'networkidle2' });
    await sleep(1000);
    await tidy(page);
    await clickText(page, 'Корпоративный контур');
    await sleep(3000);
    await tidy(page);
    await shot('04-otklyuchena-v-ad');

    const ctx = await browser.createBrowserContext(); // отдельная сессия, как другой компьютер
    const emp = await ctx.newPage();
    await emp.setUserAgent(UA);
    await emp.setViewport({ width: 1400, height: 900 });
    await emp.goto(APP + '/login', { waitUntil: 'networkidle2' });
    const inputs = await emp.$$('form input');
    await inputs[0].type('volkova'); await inputs[1].type(pw.volkova);
    await emp.click('form button[type="submit"]');
    await sleep(2500);
    await emp.screenshot({ path: path.join(OUT, '05-vhod-otklyuchennoi.png') });
    console.log('  ✓ 05-vhod-otklyuchennoi');
    await fetch(PANEL + '/api/act', { method: 'POST', body: new URLSearchParams({ sam: 'volkova', a: 'enable' }) });
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
