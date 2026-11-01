import { create } from 'zustand';

/**
 * Скачивание файлов настольным приложением.
 *
 * В браузере скачиванием занимается сам браузер: своя полоска, своя папка,
 * своя история. В настольном приложении такого хозяина нет, и раньше
 * нажатие «скачать» просто открывало системный браузер — файл уходил мимо
 * приложения, и человек не понимал, скачалось вообще или нет.
 *
 * Теперь файл тянет оболочка (см. desktop/main.js), а сюда прилетает ход
 * загрузки. Отсюда его рисует панель: сколько осталось, куда положили,
 * открыть или показать в папке.
 */

export type DownloadState = 'started' | 'progressing' | 'paused' | 'completed' | 'cancelled' | 'interrupted';

export interface DownloadItem {
  id: string;
  filename: string;
  path?: string;
  received: number;
  total: number;
  state: DownloadState;
  startedAt: number;
  updatedAt: number;
  /** Байт/с, сглажено — мгновенное значение мигает и не читается. */
  speed: number;
}

interface DownloadsState {
  items: DownloadItem[];
  apply: (info: Partial<DownloadItem> & { id: string; state: DownloadState }) => void;
  remove: (id: string) => void;
  clearFinished: () => void;
}

export const useDownloadStore = create<DownloadsState>((set) => ({
  items: [],

  apply: (info) => set(state => {
    const now = Date.now();
    const existing = state.items.find(i => i.id === info.id);

    if (!existing) {
      return {
        items: [...state.items, {
          id: info.id,
          filename: info.filename || 'Файл',
          path: info.path,
          received: info.received || 0,
          total: info.total || 0,
          state: info.state,
          startedAt: now,
          updatedAt: now,
          speed: 0,
        }],
      };
    }

    const received = info.received ?? existing.received;
    const dt = (now - existing.updatedAt) / 1000;
    const inst = dt > 0.15 ? (received - existing.received) / dt : existing.speed;
    const speed = existing.speed === 0 ? inst : existing.speed * 0.7 + inst * 0.3;

    return {
      items: state.items.map(i => (i.id === info.id ? {
        ...i,
        ...info,
        filename: info.filename || i.filename,
        path: info.path || i.path,
        received,
        total: info.total ?? i.total,
        speed: Math.max(0, speed),
        updatedAt: now,
      } : i)),
    };
  }),

  remove: (id) => set(state => ({ items: state.items.filter(i => i.id !== id) })),

  clearFinished: () => set(state => ({
    items: state.items.filter(i => i.state === 'started' || i.state === 'progressing' || i.state === 'paused'),
  })),
}));

/** Осталось секунд — null, если считать пока не из чего. */
export function downloadEta(item: DownloadItem): number | null {
  if (item.state !== 'progressing' && item.state !== 'started') return null;
  if (item.speed <= 0 || !item.total) return null;
  const left = item.total - item.received;
  if (left <= 0) return 0;
  return Math.round(left / item.speed);
}

/** Подписка на события оболочки. Вызывается один раз при запуске. */
export function initDesktopDownloads(): void {
  const api = (window as any).electronAPI;
  if (!api) return;

  if (api.onDownloadProgress) {
    api.onDownloadProgress((info: any) => {
      if (info?.id) useDownloadStore.getState().apply(info);
    });
  }

  // Оболочка ищет живой сервер своими средствами — теми, что странице
  // недоступны, — и сообщает сюда найденное. Забираем и передаём в
  // определение адреса, чтобы страница не искала заново то, что уже нашли.
  if (api.onServerUrlChanged) {
    api.onServerUrlChanged((info: any) => {
      if (!info?.url) return;
      console.log(`[оболочка] сервер найден: ${info.note} (${info.ms} мс)`);
      void applyShellUrls([info.url]);
    });
  }

  // При запуске забираем то, что оболочка нашла до открытия окна.
  if (api.serverStatus) {
    void api.serverStatus().then((status: any) => {
      const urls = (status?.alive || []).map((a: any) => a.url).filter(Boolean);
      if (urls.length) void applyShellUrls(urls);
    }).catch(() => { /* оболочка старая — обойдёмся своим поиском */ });
  }
}

/** Подгружаем определение адреса лениво: в браузере оно не нужно. */
async function applyShellUrls(urls: string[]): Promise<void> {
  try {
    const { setShellDiscoveredUrls } = await import('@/lib/connection');
    setShellDiscoveredUrls(urls);
  } catch { /* модуль не загрузился — поиск на странице продолжит сам */ }
}
