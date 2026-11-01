import { getBaseUrl } from '@/lib/connection';

/**
 * Что предлагать скачать на этой системе.
 *
 * Раньше и в шторке «Установить», и в настройках была одна прибитая гвоздями
 * кнопка «Скачать APK». Человек заходит с компьютера — ему предлагают APK.
 * С Windows — APK. С Mac — APK. Сервер при этом прекрасно понимает, откуда
 * зашли, но на выбор загрузки это никак не влияло.
 *
 * Раньше это и нельзя было починить: настольные сборки лежали битые (белый
 * экран), и предлагать их значило бы сделать хуже. Теперь они собраны,
 * проверены и лежат в магазине, так что выбор наконец имеет смысл.
 */

export type Platform = 'android' | 'windows' | 'linux' | 'mac' | 'ios' | 'unknown';

export interface DownloadOption {
  id: string;
  title: string;
  hint: string;
  url: string;
  /** Под каким именем сохранять. Без него файл ляжет как «download». */
  filename: string;
  /** Основной вариант для этой системы — показываем первым и выделяем. */
  primary: boolean;
}

/** Определяем систему по строке браузера. Врёт редко, но выбор всё равно оставляем. */
export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent;
  const p = (navigator as any).userAgentData?.platform || navigator.platform || '';

  if (/Android/i.test(ua)) return 'android';
  // iPad на свежих iOS представляется Mac с сенсорным экраном.
  if (/iPhone|iPad|iPod/i.test(ua) || (/Mac/i.test(p) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Win/i.test(p) || /Windows/i.test(ua)) return 'windows';
  if (/Mac/i.test(p) || /Macintosh/i.test(ua)) return 'mac';
  if (/Linux|X11|Ubuntu/i.test(p) || /Linux/i.test(ua)) return 'linux';
  return 'unknown';
}

export function platformName(p: Platform): string {
  return {
    android: 'Android', windows: 'Windows', linux: 'Linux',
    mac: 'macOS', ios: 'iPhone или iPad', unknown: 'вашей системы',
  }[p];
}

/**
 * Список загрузок, отсортированный: сначала то, что подходит этой системе.
 *
 * Остальные варианты не прячем — человек может качать для другой машины,
 * да и определение по строке браузера иногда ошибается.
 */
export function getDownloads(platform = detectPlatform()): DownloadOption[] {
  const base = getBaseUrl();

  const apk: DownloadOption = {
    id: 'apk',
    title: 'Приложение для Android',
    hint: 'Полный набор: уведомления, звонки, работа без сети',
    url: `${base}/api/updates/download/apk`,
    filename: 'storagemess.apk',
    primary: platform === 'android',
  };
  const windows: DownloadOption = {
    id: 'windows',
    title: 'Приложение для Windows',
    hint: 'Установщик, около 77 МБ',
    url: `${base}/api/updates/download/desktop/windows`,
    filename: 'STORAGE-MESS-Setup.exe',
    primary: platform === 'windows',
  };
  const linux: DownloadOption = {
    id: 'linux',
    title: 'Приложение для Linux',
    hint: 'AppImage — скачать, разрешить запуск, открыть',
    url: `${base}/api/updates/download/desktop/linux`,
    filename: 'STORAGE-MESS.AppImage',
    primary: platform === 'linux',
  };

  const all = [apk, windows, linux];

  // Под macOS сборки нет: собрать её можно только на самом маке, а его нет.
  // Честно не показываем несуществующее — там остаётся веб-версия.
  if (platform === 'mac' || platform === 'ios') {
    return all.map(o => ({ ...o, primary: false }));
  }

  return [...all.filter(o => o.primary), ...all.filter(o => !o.primary)];
}

/**
 * Соседние приложения — не мессенджер, но наши и лежат в том же магазине.
 *
 * Отдельно от getDownloads намеренно: там варианты ОДНОЙ программы под
 * разные системы, и смешивать их с другими программами значит путать
 * человека — он решит, что без этого мессенджер не заработает.
 */
export interface CompanionApp {
  id: string;
  title: string;
  /** Одной строкой: что это и зачем. */
  hint: string;
  /** Честно: нужно ли это для работы мессенджера. */
  note: string;
  url: string;
  filename: string;
  /** Подходит ли этой системе. */
  fits: boolean;
}

export function getCompanionApps(platform = detectPlatform()): CompanionApp[] {
  const base = getBaseUrl();

  const zen: CompanionApp = {
    id: 'zen-nitro',
    // Сборка universal: под все наборы инструкций сразу. Она тяжелее
    // отдельных, зато не нужно гадать про архитектуру телефона —
    // браузер об этом всё равно не знает.
    title: 'ZEN NITRO',
    hint: 'Обход блокировок для всего телефона',
    note: 'Отдельная программа. Мессенджеру не требуется — он работает и без неё.',
    url: `${base}/api/updates/zen/apk/universal`,
    filename: 'ZenNitro.apk',
    fits: platform === 'android',
  };

  const browser: CompanionApp = {
    id: 'storage-browser',
    title: 'STORAGE Browser',
    hint: 'Лёгкий браузер, который узнаёт наш сервер по ключу',
    note: 'Отдельная программа. Пригодится, когда обычный браузер до сайта не доходит.',
    url: `${base}/api/updates/download/browser/${platform === 'windows' ? 'windows' : 'linux'}`,
    filename: platform === 'windows' ? 'STORAGE-Browser-Setup.exe' : 'STORAGE-Browser.AppImage',
    fits: platform === 'windows' || platform === 'linux',
  };

  return [zen, browser].filter(a => a.fits);
}

/** Есть ли вообще сборка под эту систему. */
export function hasNativeBuild(platform = detectPlatform()): boolean {
  return platform === 'android' || platform === 'windows' || platform === 'linux';
}

/**
 * Версии сборок с сервера — чтобы на кнопке было видно, что скачиваешь.
 *
 * Без этого получалось так: приложение для телефона и настольное собираются
 * отдельно и нумеруются независимо. Человек нажимал загрузку и получал файл
 * с номером, который не совпадал с только что объявленным, — и справедливо
 * не понимал, то ли это вообще скачалось.
 */
export async function fetchVersions(): Promise<Record<string, string>> {
  try {
    const r = await fetch(`${getBaseUrl()}/api/updates/versions`);
    if (!r.ok) return {};
    const d = await r.json();
    return {
      apk: d?.apk?.version || '',
      windows: d?.windows?.version || d?.desktop?.version || '',
      linux: d?.linux?.version || d?.desktop?.version || '',
    };
  } catch {
    return {};
  }
}
