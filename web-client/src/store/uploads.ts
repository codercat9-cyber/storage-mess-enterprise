import { create } from 'zustand';

/**
 * Общий журнал загрузок.
 *
 * Зачем отдельное хранилище: раньше прогресс жил внутри того экрана, откуда
 * начали отправлять файл. Ушёл из чата в чат — полоска пропала; свернул
 * приложение — вместе с размонтированным компонентом уходила и сама загрузка,
 * и человек не понимал, ушёл файл или нет. Теперь состояние живёт над
 * экранами, а незавершённые загрузки записываются в localStorage, чтобы после
 * перезапуска предложить докачать.
 */

export type UploadStatus = 'uploading' | 'paused' | 'done' | 'error' | 'canceled';

export interface UploadItem {
  id: string;
  fileName: string;
  fileSize: number;
  /** Байт отправлено — считаем по факту, а не «номер куска × размер куска». */
  loaded: number;
  status: UploadStatus;
  error?: string;
  /** Куда: 'chat' или 'storage' — чтобы показывать, откуда родом. */
  source: string;
  chatId?: string;
  startedAt: number;
  /** Обновляется на каждом тике, нужно для оценки скорости и остатка. */
  updatedAt: number;
  /** Байт/с, сглажено — мгновенное значение скачет и мигает в интерфейсе. */
  speed: number;
  /** Сессия чанковой загрузки на сервере, если она есть. */
  sessionId?: string;
  /** Отмена: живёт только в памяти, в localStorage не уезжает. */
  abort?: () => void;
  /**
   * Чем занят сервер сейчас: принимает куски, собирает из них файл или
   * шифрует. Раньше этого не показывали, и последние два этапа выглядели
   * как зависшие сто процентов.
   */
  stage?: 'sending' | 'assembling' | 'encrypting' | 'done';
  /** Общий ход, 0–100. Сто означает «готово к отправке», а не «куски ушли». */
  percent?: number;
}

interface UploadsState {
  items: UploadItem[];
  start: (item: Omit<UploadItem, 'loaded' | 'status' | 'startedAt' | 'updatedAt' | 'speed'>) => void;
  progress: (id: string, loaded: number, stage?: UploadItem['stage'], percent?: number) => void;
  setSession: (id: string, sessionId: string) => void;
  finish: (id: string, status: UploadStatus, error?: string) => void;
  cancel: (id: string) => void;
  remove: (id: string) => void;
  clearFinished: () => void;
}

const PENDING_KEY = 'sm_pending_uploads';

/** Что осталось недокачанным — переживает перезапуск приложения. */
export interface PendingUpload {
  fileName: string;
  fileSize: number;
  sessionId?: string;
  source: string;
  chatId?: string;
  loaded: number;
  savedAt: number;
}

export function readPendingUploads(): PendingUpload[] {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return [];
    const list: PendingUpload[] = JSON.parse(raw);
    // Сутки — столько же живёт сессия на сервере. Старше смысла не имеет.
    const fresh = list.filter(p => Date.now() - p.savedAt < 24 * 60 * 60 * 1000);
    if (fresh.length !== list.length) writePending(fresh);
    return fresh;
  } catch { return []; }
}

function writePending(list: PendingUpload[]): void {
  try {
    if (list.length === 0) localStorage.removeItem(PENDING_KEY);
    else localStorage.setItem(PENDING_KEY, JSON.stringify(list));
  } catch { /* приватный режим или переполнено — не повод падать */ }
}

export function forgetPendingUpload(fileName: string, fileSize: number): void {
  writePending(readPendingUploads().filter(p => !(p.fileName === fileName && p.fileSize === fileSize)));
}

function rememberPending(item: UploadItem): void {
  const list = readPendingUploads().filter(
    p => !(p.fileName === item.fileName && p.fileSize === item.fileSize),
  );
  list.push({
    fileName: item.fileName, fileSize: item.fileSize, sessionId: item.sessionId,
    source: item.source, chatId: item.chatId, loaded: item.loaded, savedAt: Date.now(),
  });
  writePending(list);
}

export const useUploadStore = create<UploadsState>((set, get) => ({
  items: [],

  start: (item) => set(state => ({
    items: [
      ...state.items.filter(i => i.id !== item.id),
      { ...item, loaded: 0, status: 'uploading', startedAt: Date.now(), updatedAt: Date.now(), speed: 0 },
    ],
  })),

  progress: (id, loaded, stage, percent) => set(state => ({
    items: state.items.map(i => {
      if (i.id !== id) return i;
      const now = Date.now();
      const dt = (now - i.updatedAt) / 1000;
      const inst = dt > 0.15 ? (loaded - i.loaded) / dt : i.speed;
      // Экспоненциальное сглаживание: без него цифра скорости пляшет
      // так, что прочитать её невозможно.
      const speed = i.speed === 0 ? inst : i.speed * 0.7 + inst * 0.3;
      return { ...i, loaded, speed: Math.max(0, speed), updatedAt: now, stage: stage ?? i.stage, percent: percent ?? i.percent };
    }),
  })),

  setSession: (id, sessionId) => {
    set(state => ({ items: state.items.map(i => (i.id === id ? { ...i, sessionId } : i)) }));
    const it = get().items.find(i => i.id === id);
    if (it) rememberPending(it);
  },

  finish: (id, status, error) => {
    const it = get().items.find(i => i.id === id);
    if (it) {
      if (status === 'done' || status === 'canceled') forgetPendingUpload(it.fileName, it.fileSize);
      else rememberPending({ ...it, status });
    }
    set(state => ({
      items: state.items.map(i => (i.id === id
        ? { ...i, status, error, abort: undefined, loaded: status === 'done' ? i.fileSize : i.loaded }
        : i)),
    }));
  },

  cancel: (id) => {
    const it = get().items.find(i => i.id === id);
    try { it?.abort?.(); } catch { /* уже завершилась */ }
    if (it) forgetPendingUpload(it.fileName, it.fileSize);
    set(state => ({ items: state.items.map(i => (i.id === id ? { ...i, status: 'canceled', abort: undefined } : i)) }));
  },

  remove: (id) => set(state => ({ items: state.items.filter(i => i.id !== id) })),

  clearFinished: () => set(state => ({
    items: state.items.filter(i => i.status === 'uploading' || i.status === 'paused'),
  })),
}));

/** Осталось секунд — null, если считать пока не из чего. */
export function etaSeconds(item: UploadItem): number | null {
  if (item.status !== 'uploading' || item.speed <= 0) return null;
  const left = item.fileSize - item.loaded;
  if (left <= 0) return 0;
  return Math.round(left / item.speed);
}

/**
 * Чем занята загрузка прямо сейчас — словами для человека.
 *
 * Пока шли только проценты, последние два этапа выглядели одинаково:
 * «100%» и тишина. На архиве в четыре гигабайта сборка с шифрованием
 * занимают минуты, и человек успевал решить, что всё повисло, и начать
 * заново — один файл так приехал на сервер трижды.
 */
export function stageLabel(item: UploadItem): string | null {
  if (item.status === 'done') return null;
  if (item.status === 'error') return null;
  switch (item.stage) {
    case 'assembling':  return 'собираю файл на сервере';
    case 'encrypting':  return 'шифрую';
    case 'done':        return 'готово к отправке';
    default:            return null;   // обычная передача — и так видно по скорости
  }
}

/** Общий ход в процентах: с учётом обработки на сервере, а не только передачи. */
export function overallPercent(item: UploadItem): number {
  if (item.status === 'done') return 100;
  if (typeof item.percent === 'number') return Math.min(100, Math.max(0, item.percent));
  return item.fileSize > 0 ? Math.min(100, Math.round((item.loaded / item.fileSize) * 100)) : 0;
}
