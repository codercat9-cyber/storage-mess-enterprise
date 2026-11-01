import { create } from 'zustand';

export interface MediaItem {
  type: 'audio' | 'video';
  url: string;
  fileName: string;
  fileSize?: number;
  downloadUrl?: string;
  id?: string; // Optional unique ID
}

export interface MediaState {
  currentMedia: MediaItem | null;
  queue: MediaItem[];
  queueIndex: number;
  setMedia: (media: MediaItem | null) => void;
  closeMedia: () => void;
  addToQueue: (media: MediaItem) => void;
  playNext: () => void;
  playPrev: () => void;
  removeFromQueue: (index: number) => void;
  setQueueIndex: (index: number) => void;
  /** Поставить сразу всю очередь и указать, с какой записи начать. */
  playQueue: (items: MediaItem[], index: number) => void;
  /** Играет ли звук нативный проигрыватель телефона (режим вибрации). */
  nativeHapticMode: boolean;
  setNativeHapticMode: (on: boolean) => void;
  /**
   * Какую запись СЕЙЧАС ведёт проигрыватель телефона.
   *
   * Именно ведёт, а не «человек включил режим». Это разные вещи, и
   * путаница между ними ломала всё сразу: перемотка уходила телефону,
   * когда звучала страница, а вибрация читала время у страницы, когда
   * звучал телефон.
   */
  nativeOwnedUrl: string | null;
  setNativeOwnedUrl: (url: string | null) => void;
  /**
   * Продолжать ли играть на следующей записи.
   *
   * Живёт здесь, а не внутри проигрывателя: при смене записи тот
   * пересоздаётся и всё, что помнил, теряет — а нам нужно знать уже ПОСЛЕ
   * переключения, играло ли до него.
   */
  autoPlayNext: boolean;
  setAutoPlayNext: (on: boolean) => void;
}

export const useMediaStore = create<MediaState>((set, get) => ({
  currentMedia: null,
  queue: [],
  queueIndex: -1,

  // Режим нативного проигрывателя общий на всё приложение, а не свой у
  // каждой записи в переписке.
  //
  // Раньше он жил внутри самого проигрывателя, а тот отрисовывается для
  // КАЖДОГО сообщения с музыкой отдельно. Стоило перейти к следующей
  // записи — и она открывалась уже с выключенным режимом, тогда как звук
  // вёл нативный проигрыватель. Получалось: подпись сменилась, полоса
  // поехала, а играть нечему.
  nativeHapticMode: false,
  setNativeHapticMode: (on) => set(
    // Выключили режим — телефон больше ничего не ведёт.
    on ? { nativeHapticMode: true } : { nativeHapticMode: false, nativeOwnedUrl: null },
  ),

  nativeOwnedUrl: null,
  setNativeOwnedUrl: (url) => set({ nativeOwnedUrl: url }),

  autoPlayNext: false,
  setAutoPlayNext: (on) => set({ autoPlayNext: on }),

  playQueue: (items, index) => {
    if (items.length === 0) return;
    const safe = Math.max(0, Math.min(index, items.length - 1));
    // Очередь кладём ЦЕЛИКОМ, вместе с играющей записью.
    //
    // Прежде текущая запись из очереди выбрасывалась, а указатель
    // оставался на нуле — то есть показывал уже на следующую. Отсюда
    // «следующий» через одну и промах нативного проигрывателя: он искал
    // играющую запись в очереди, не находил и начинал с чужого места.
    set({ queue: items, queueIndex: safe, currentMedia: items[safe] });
  },
  setMedia: (media) => set(
    // null означает «закрыть»: класть его в очередь нельзя — получилась бы
    // запись без адреса, на которой переключение спотыкается.
    media
      ? { currentMedia: media, queue: [media], queueIndex: 0 }
      : { currentMedia: null, queue: [], queueIndex: -1 },
  ),
  closeMedia: () => set({ currentMedia: null, queue: [], queueIndex: -1 }),
  addToQueue: (media) => {
    const { currentMedia, queue } = get();
    if (!currentMedia) {
      set({ currentMedia: media, queue: [media], queueIndex: 0 });
    } else {
      if (!queue.find(item => item.url === media.url)) {
        set({ queue: [...queue, media] });
      }
    }
  },
  playNext: () => {
    const { queue, queueIndex } = get();
    if (queue.length > 0 && queueIndex < queue.length - 1) {
      // Следующая запись должна зазвучать сама.
      //
      // Ни в одном музыкальном приложении человек не жмёт «пуск» после
      // каждого перехода: очередь на то и очередь. Флаг читает сам
      // проигрыватель, когда получает новый адрес.
      set({ currentMedia: queue[queueIndex + 1], queueIndex: queueIndex + 1, autoPlayNext: true });
    }
  },
  playPrev: () => {
    const { queue, queueIndex } = get();
    if (queue.length > 0 && queueIndex > 0) {
      set({ currentMedia: queue[queueIndex - 1], queueIndex: queueIndex - 1, autoPlayNext: true });
    }
  },
  removeFromQueue: (index) => {
    const { queue, queueIndex } = get();
    const newQueue = queue.filter((_, i) => i !== index);
    let newIndex = queueIndex;
    if (index < queueIndex) newIndex--;
    else if (index === queueIndex) newIndex = Math.max(0, newIndex - 1);
    
    if (newQueue.length === 0) {
      set({ currentMedia: null, queue: [], queueIndex: -1 });
    } else {
      set({ queue: newQueue, queueIndex: newIndex, currentMedia: newQueue[newIndex] });
    }
  },
  setQueueIndex: (index) => {
    const { queue, queueIndex } = get();
    if (index >= 0 && index < queue.length) {
      // Выбор записи из списка — тоже «играй эту», а не «покажи и жди».
      set({ queueIndex: index, currentMedia: queue[index], autoPlayNext: index !== queueIndex });
    }
  }
}));
