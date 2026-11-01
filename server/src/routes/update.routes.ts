// =============================================================================
// Update/Version Routes — /api/updates/*
// Проверка обновлений для всех платформ + скачивание файлов
// =============================================================================

import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';

const router = Router();

// Путь к конфигу версий и файлам обновлений
const UPDATES_DIR = path.join(process.cwd(), 'updates');
const VERSIONS_FILE = path.join(UPDATES_DIR, 'versions.json');

// ZEN NITRO — отдельный продукт, поэтому и место у него отдельное.
// Свой каталог, свой манифест: сборки антицензурного клиента не должны
// путаться со сборками мессенджера, у них разный цикл выпуска и разные
// файлы под каждую архитектуру.
const ZEN_DIR = path.join(UPDATES_DIR, 'zen');
const ZEN_FILE = path.join(ZEN_DIR, 'zen.json');

// ─── Утилиты ───

/** Читаем versions.json (каждый раз с диска — чтобы можно было менять без рестарта) */
function getVersions(): any {
  try {
    if (!fs.existsSync(VERSIONS_FILE)) {
      return null;
    }
    const raw = fs.readFileSync(VERSIONS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    logger.error('Failed to read versions.json:', err);
    return null;
  }
}

/** Сравниваем semver: возвращает 1 если a > b, -1 если a < b, 0 если равны */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

// ─── Роуты ───

/**
 * GET /api/updates/check?platform=web|pwa|apk|desktop&version=1.0.0
 * Проверяет, есть ли обновление для указанной платформы
 */
router.get('/check', (req: Request, res: Response) => {
  const { platform, version } = req.query;

  if (!platform || typeof platform !== 'string') {
    return res.status(400).json({ error: 'Missing platform parameter' });
  }

  const versions = getVersions();
  if (!versions) {
    return res.status(503).json({ error: 'Version info not available' });
  }

  const platformInfo = versions[platform];
  if (!platformInfo) {
    return res.status(404).json({ error: `Unknown platform: ${platform}` });
  }

  const currentVersion = typeof version === 'string' ? version : '0.0.0';
  const latestVersion = platformInfo.version;
  const hasUpdate = compareSemver(latestVersion, currentVersion) > 0;

  const result: any = {
    platform,
    currentVersion,
    latestVersion,
    hasUpdate,
    changelog: platformInfo.changelog || platformInfo.releaseNotes || '',
  };

  // Добавляем URL для скачивания
  if (hasUpdate) {
    if (platform === 'apk' && platformInfo.filename) {
      result.downloadUrl = `/api/updates/download/apk`;
      result.filename = platformInfo.filename;
    } else if (platform === 'desktop' && platformInfo.files) {
      result.downloads = {
        windows: platformInfo.files.windows ? `/api/updates/download/desktop/windows` : null,
        linux: platformInfo.files.linux ? `/api/updates/download/desktop/linux` : null,
        mac: platformInfo.files.mac ? `/api/updates/download/desktop/mac` : null,
      };
    }
  }

  res.json(result);
});

/**
 * GET /api/updates/versions
 * Возвращает все версии для всех платформ (для панели настроек)
 */
router.get('/versions', (_req: Request, res: Response) => {
  const versions = getVersions();
  if (!versions) {
    return res.status(503).json({ error: 'Version info not available' });
  }
  res.json(versions);
});

/**
 * GET /api/updates/download/apk
 * Скачать APK файл
 */
router.get('/download/apk', (req: Request, res: Response) => {
  const versions = getVersions();
  if (!versions?.apk?.filename) {
    return res.status(404).json({ error: 'APK not available' });
  }

  const filePath = path.join(UPDATES_DIR, versions.apk.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'APK file not found on server' });
  }

  const stat = fs.statSync(filePath);
  logger.info(`APK download: ${versions.apk.filename} (${(stat.size / 1024 / 1024).toFixed(1)} MB) from ${req.ip}`);

  res.download(filePath, versions.apk.filename);
});

/**
 * GET /api/updates/download/desktop/:os
 * Скачать desktop-приложение (windows/linux/mac)
 */
router.get('/download/desktop/:os', (req: Request, res: Response) => {
  const { os } = req.params;
  const validOS = ['windows', 'linux', 'mac'];

  if (!validOS.includes(os)) {
    return res.status(400).json({ error: `Invalid OS: ${os}. Must be one of: ${validOS.join(', ')}` });
  }

  const versions = getVersions();
  if (!versions?.desktop?.files?.[os]) {
    return res.status(404).json({ error: `Desktop build for ${os} not available` });
  }

  const filename = versions.desktop.files[os];
  const filePath = path.join(UPDATES_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: `File ${filename} not found on server` });
  }

  const stat = fs.statSync(filePath);
  logger.info(`Desktop download [${os}]: ${filename} (${(stat.size / 1024 / 1024).toFixed(1)} MB) from ${req.ip}`);

  res.download(filePath, filename);
});

/**
 * GET /api/updates/download/browser/:os
 * Лёгкий браузер — отдельное приложение, не часть мессенджера.
 *
 * Он нужен там, где обычный браузер бессилен: страница не может
 * приказать браузеру доверять конкретному ключу, поэтому запасной путь
 * по голому адресу в нём всегда упирается в предупреждение. Наш браузер
 * проверяет ключ сам и потому доходит туда, куда обычный не доходит.
 */
router.get('/download/browser/:os', (req: Request, res: Response) => {
  const { os } = req.params;
  const validOS = ['windows', 'linux'];

  if (!validOS.includes(os)) {
    return res.status(400).json({ error: `Invalid OS: ${os}. Must be one of: ${validOS.join(', ')}` });
  }

  const versions = getVersions();
  const filename = versions?.browser?.files?.[os];
  if (!filename) {
    return res.status(404).json({ error: `Browser build for ${os} not available` });
  }

  const filePath = path.join(UPDATES_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: `File ${filename} not found on server` });
  }

  const stat = fs.statSync(filePath);
  logger.info(`Browser download [${os}]: ${filename} (${(stat.size / 1024 / 1024).toFixed(1)} MB) from ${req.ip}`);
  res.download(filePath, filename);
});

// ═══════════════════════════════════════════════════════════════════════════
//  ZEN NITRO — канал обновлений антицензурного клиента
// ═══════════════════════════════════════════════════════════════════════════
//
//  Клиент ходит сюда раз в сутки, читает манифест и, если снаружи версия
//  новее, показывает кнопку «Доступно обновление». Сам он ничего не ставит —
//  качает по нажатию и отдаёт файл установщику системы.
//
//  Раскладка на диске:
//      server/updates/zen/zen.json          — что считать текущим выпуском
//      server/updates/zen/ZenNitro-*.apk    — сборки под каждую архитектуру
//      server/updates/zen/geo/*.srs         — гео-правила (списки доменов)
//
//  Файлы кладёт сюда tools/publish-zen.sh — руками zen.json править не надо.

/** Читаем zen.json с диска на каждый запрос: выпуск не должен требовать рестарта. */
function getZen(): any {
  try {
    if (!fs.existsSync(ZEN_FILE)) return null;
    return JSON.parse(fs.readFileSync(ZEN_FILE, 'utf-8'));
  } catch (err) {
    logger.error('Failed to read zen.json:', err);
    return null;
  }
}

/**
 * Абсолютный адрес НА ТОТ ЖЕ ХОСТ, по которому нас нашли.
 *
 * Телефон добирается до сервера по-разному: домен, внешний адрес, локальная
 * сеть — смотря где человек находится. Зашей мы домен в манифест намертво,
 * и обновление, найденное по домашней сети, качалось бы через интернет
 * (а за городом — вообще никак, если домен режут).
 */
function base(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

/** Отдаём файл из каталога ZEN, не пуская запрос выше по дереву. */
function sendZenFile(res: Response, rel: string, label: string, ip?: string) {
  // Имя пришло из запроса — обрезаем всё, кроме последнего сегмента,
  // иначе ../../ увёл бы отдачу в любой файл на сервере.
  const safe = rel.split('/').map((p) => path.basename(p)).join(path.sep);
  const file = path.join(ZEN_DIR, safe);
  if (!file.startsWith(ZEN_DIR + path.sep) || !fs.existsSync(file)) {
    return res.status(404).json({ error: `${label} not found` });
  }
  const stat = fs.statSync(file);
  logger.info(`ZEN NITRO ${label}: ${safe} (${(stat.size / 1024 / 1024).toFixed(1)} MB) from ${ip}`);
  res.download(file, path.basename(safe));
}

/**
 * GET /api/updates/zen
 * Манифест в том виде, в каком его читает Android-клиент ZEN NITRO.
 */
router.get('/zen', (req: Request, res: Response) => {
  const zen = getZen();
  if (!zen) return res.status(404).json({ error: 'ZEN NITRO update channel is not set up' });

  const root = base(req);
  const apk: Record<string, string> = {};
  const sizes: Record<string, number> = {};
  for (const [abi, filename] of Object.entries(zen.apk || {})) {
    if (typeof filename !== 'string' || !fs.existsSync(path.join(ZEN_DIR, filename))) continue;
    apk[abi] = `${root}/api/updates/zen/apk/${encodeURIComponent(abi)}`;
    sizes[abi] = fs.statSync(path.join(ZEN_DIR, filename)).size;
  }
  if (Object.keys(apk).length === 0) {
    return res.status(404).json({ error: 'ZEN NITRO builds are not published yet' });
  }

  const geoFiles: Record<string, string> = {};
  for (const name of zen.geo?.files || []) {
    if (typeof name !== 'string') continue;
    if (fs.existsSync(path.join(ZEN_DIR, 'geo', name)))
      geoFiles[name] = `${root}/api/updates/zen/geo/${encodeURIComponent(name)}`;
  }

  // size намеренно НЕ отдаём одним числом: у arm64, arm32 и x86_64 сборки
  // разного веса, а клиент берёт длину из заголовка ответа. Общий размер
  // врал бы в прогрессе закачки. sizes — справочно, для панели и человека.
  res.json({
    versionCode: zen.versionCode,
    versionName: zen.versionName,
    releaseDate: zen.releaseDate || '',
    notes: zen.notes || '',
    apk,
    sizes,
    ...(Object.keys(geoFiles).length
      ? { geo: { version: zen.geo?.version || 0, files: geoFiles } }
      : {}),
  });
});

/**
 * GET /api/updates/zen/apk/:abi
 * Сборка под конкретную архитектуру телефона.
 */
router.get('/zen/apk/:abi', (req: Request, res: Response) => {
  const zen = getZen();
  const filename = zen?.apk?.[req.params.abi];
  if (typeof filename !== 'string') {
    return res.status(404).json({ error: `No ZEN NITRO build for ABI ${req.params.abi}` });
  }
  sendZenFile(res, filename, 'APK', req.ip);
});

/**
 * GET /api/updates/zen/geo/:name
 * Гео-правила. Это списки доменов, а не код, — их клиент обновляет молча.
 */
router.get('/zen/geo/:name', (req: Request, res: Response) => {
  const zen = getZen();
  const known: string[] = zen?.geo?.files || [];
  if (!known.includes(req.params.name)) {
    return res.status(404).json({ error: `Unknown geo file: ${req.params.name}` });
  }
  sendZenFile(res, path.join('geo', req.params.name), 'geo', req.ip);
});

export default router;
