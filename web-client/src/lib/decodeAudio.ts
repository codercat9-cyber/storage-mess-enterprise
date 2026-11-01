/**
 * Разбор звукового файла в отсчёты — и защита от того, что этот разбор
 * убивает настольное приложение.
 *
 * ═══ Что было ═══
 *
 * Жалоба звучала так: «нажимаешь плеер — приложуха падает с белым
 * экраном». Ни ошибки, ни следа в консоли: консоль умирает вместе с
 * процессом страницы.
 *
 * Поймано запуском сборки с отладчиком и разбором по шагам. Играть звук
 * приложение умеет: сам <audio>, десять фильтров, эхо, полоски спектра —
 * всё работает. Убивает одна строчка:
 *
 *     await ctx.decodeAudioData(buffer);
 *
 * Её звали дважды: для картинки формы волны под плеером и для разбора
 * ритма под вибрацию. Процесс страницы падает по нулевому указателю:
 *
 *     segfault at 0 ip … in storage-mess-desktop
 *     wine: Unhandled page fault on read access to 0000000000000000
 *
 * И на Windows, и на Linux — сборка для Linux болела ровно тем же, её
 * просто никто не проверял.
 *
 * ═══ Чей это дефект ═══
 *
 * Не наш. Собрано минимальное приложение на голом Electron 28.3.3: окно,
 * одна страница, синтетический WAV, сделанный тут же в памяти — ни
 * сети, ни кодеков, ни нашего кода. Падает так же и по тому же адресу.
 * Это дефект самого движка; в браузере и в приложении для телефона
 * (там Chromium новее) та же строчка отрабатывает нормально.
 *
 * ═══ Что делаем ═══
 *
 * Проверяем движок перед разбором. Слишком старый — разбора не будет:
 * плеер покажет обычную полоску вместо картинки волны, вибро-разбор
 * скажет, что недоступен. Потеря украшения против падения всего окна —
 * обмен очевидный.
 *
 * Проверка по версии, а не по «это Electron»: как только оболочка
 * переедет на свежий движок, разбор включится сам. Порог поднят до 130
 * с запасом: на 120 падение доказано, точную версию починки в Chromium
 * никто не публиковал, а проверять на живых людях нечего.
 */

/** Версия движка Chromium под нами. 0 — не смогли определить. */
function chromiumMajor(): number {
  try {
    const m = /Chrom(?:e|ium)\/(\d+)/.exec(navigator.userAgent);
    return m ? parseInt(m[1], 10) : 0;
  } catch {
    return 0;
  }
}

function isElectronShell(): boolean {
  return Boolean((window as any).electronAPI?.isElectron) || /Electron\//i.test(navigator.userAgent);
}

const SAFE_CHROMIUM = 130;

/**
 * Можно ли здесь разбирать звук, не рискуя уронить окно.
 *
 * Ограничение касается только настольной оболочки: в браузере на старом
 * Chromium этой беды нет — там страница живёт в общем процессе браузера
 * с его собственными заплатками, и жалоб оттуда не приходило.
 */
export function canDecodeAudio(): boolean {
  if (typeof window === 'undefined') return false;
  if (!isElectronShell()) return true;
  const major = chromiumMajor();
  return major >= SAFE_CHROMIUM;
}

/** Почему нельзя — короткой строкой для интерфейса. */
export function decodeUnavailableReason(): string {
  return 'В этой версии настольного приложения разбор звука отключён — '
    + 'он ронял окно. Обновите приложение, когда выйдет сборка на новом движке.';
}

let shared: AudioContext | null = null;

function getDecodeContext(): AudioContext {
  if (shared && shared.state !== 'closed') return shared;
  const Ctor: typeof AudioContext =
    (window as any).AudioContext || (window as any).webkitAudioContext;
  shared = new Ctor();
  // Держать контекст запущенным незачем: разбору это не нужно, а на
  // телефоне лишний расход батареи.
  if (shared.state === 'running') shared.suspend().catch(() => {});
  return shared;
}

/**
 * Разобрать звук в AudioBuffer.
 *
 * Возвращает null, если на этом движке разбор запрещён. Именно null, а
 * не исключение: отсутствие картинки волны — не ошибка, показывать
 * человеку тут нечего.
 */
export async function decodeAudioBuffer(data: ArrayBuffer): Promise<AudioBuffer | null> {
  if (!canDecodeAudio()) {
    console.warn('[Звук] разбор пропущен: движок ' + chromiumMajor() + ' роняет окно на decodeAudioData');
    return null;
  }
  const ctx = getDecodeContext();
  // decodeAudioData забирает буфер себе, повторно им не воспользоваться.
  // Отдаём копию — вызывающий про это знать не обязан.
  return await ctx.decodeAudioData(data.slice(0));
}

/** Скачать и разобрать за один заход. null — разбор недоступен. */
export async function fetchAndDecodeAudio(url: string): Promise<AudioBuffer | null> {
  if (!canDecodeAudio()) return null;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Не удалось скачать звук: ${resp.status}`);
  return decodeAudioBuffer(await resp.arrayBuffer());
}
