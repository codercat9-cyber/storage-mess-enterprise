// =============================================================
// Offline Message Queue — IndexedDB очередь исходящих сообщений
//
// При отсутствии сети сообщения складываются в IndexedDB и
// автоматически отправляются при восстановлении подключения.
// =============================================================

import { chatApi } from '@/lib/api';
import { useChatStore } from '@/store/chat';
import { useAuthStore } from '@/store/auth';

const DB_NAME = 'storage-mess-offline';
const DB_VERSION = 1;
const STORE_MESSAGES = 'pending-messages';

export interface PendingMessage {
  id: string;          // temporary client-side UUID
  chatId: string;
  content: string;
  type: string;
  replyToId?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  retries: number;
  status: 'pending' | 'sending' | 'failed';
}

// Слушатели для UI обновлений
type QueueListener = (queue: PendingMessage[]) => void;
const listeners = new Set<QueueListener>();
let cachedQueue: PendingMessage[] = [];

function notifyListeners() {
  listeners.forEach(fn => fn([...cachedQueue]));
}

export function onQueueChange(listener: QueueListener): () => void {
  listeners.add(listener);
  listener([...cachedQueue]);
  return () => listeners.delete(listener);
}

export function getPendingQueue(): PendingMessage[] {
  return [...cachedQueue];
}

// === IndexedDB ===

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
        db.createObjectStore(STORE_MESSAGES, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAllPending(): Promise<PendingMessage[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_MESSAGES, 'readonly');
    const store = tx.objectStore(STORE_MESSAGES);
    const req = store.getAll();
    req.onsuccess = () => {
      const items = (req.result as PendingMessage[]).sort((a, b) => a.createdAt - b.createdAt);
      resolve(items);
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

async function putMessage(msg: PendingMessage): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_MESSAGES, 'readwrite');
    tx.objectStore(STORE_MESSAGES).put(msg);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function deleteMessage(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_MESSAGES, 'readwrite');
    tx.objectStore(STORE_MESSAGES).delete(id);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

// === Порядок отправки ===
//
// Сервер ставит сообщению время по приходу, значит порядок прихода и есть
// порядок в чате у собеседника. Раньше каждое сообщение уходило своим
// запросом, не дожидаясь предыдущего: на плохой сети первое висело до
// таймаута и уезжало в очередь, следующие успевали раньше, а очередь при
// сбое одного слала те, что за ним. Собеседник получал фразы вперемешку
// (16.10.2026: «а всё вопросов нет мой мессенджер…» — набрано было иначе).
//
// Теперь всё исходящее текстовое идёт одной цепочкой: следующее не уходит,
// пока предыдущее не доставлено или не легло в очередь, а пока очередь не
// пуста — новое встаёт за ней.

let chain: Promise<unknown> = Promise.resolve();

/** Выполнить отправку строго после всех ранее начатых. */
export function sendInOrder<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.catch(() => {});
  return run;
}

/**
 * До сервера не дошло — главный признак ОТСУТСТВИЕ ответа. Если ответ есть
 * (4xx/5xx), сервер запрос получил: повторять 4xx бессмысленно.
 * Таймаут axios даёт ECONNABORTED, его тоже считаем недоставкой.
 */
export function isNetworkFailure(error: unknown): boolean {
  const err = error as any;
  return (
    !err?.response ||
    !navigator.onLine ||
    err?.code === 'ERR_NETWORK' ||
    err?.code === 'ECONNABORTED' ||
    err?.code === 'ETIMEDOUT' ||
    (typeof err?.message === 'string' && err.message.toLowerCase().includes('timeout'))
  );
}

// Время постановки строго растёт: по нему очередь сортируется при чтении
// из IndexedDB, и два сообщения в одну миллисекунду не должны меняться
// местами.
let lastCreatedAt = 0;

// === API ===

/** Добавить сообщение в офлайн-очередь */
export async function enqueueMessage(msg: Omit<PendingMessage, 'retries' | 'status' | 'createdAt'>): Promise<PendingMessage> {
  lastCreatedAt = Math.max(Date.now(), lastCreatedAt + 1);
  const pending: PendingMessage = {
    ...msg,
    createdAt: lastCreatedAt,
    retries: 0,
    status: 'pending',
  };
  await putMessage(pending);
  cachedQueue.push(pending);
  notifyListeners();
  console.log('📦 Message queued offline:', pending.id);
  scheduleFlush();
  return pending;
}

const replaceInStore = (pendingId: string, sentMsg: any) =>
  useChatStore.getState().replacePendingMessage(pendingId, sentMsg);

// Повтор по таймеру. Раньше очередь разбиралась только при переподключении
// сокета: если сокет жил, а REST отваливался по таймауту, сообщения лежали
// до перезапуска приложения.
const RETRY_DELAYS = [3000, 8000, 20000, 60000];
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryStep = 0;

function scheduleFlush() {
  if (retryTimer || cachedQueue.length === 0) return;
  const delay = RETRY_DELAYS[Math.min(retryStep, RETRY_DELAYS.length - 1)];
  retryTimer = setTimeout(() => {
    retryTimer = null;
    flushQueue().catch(() => {});
  }, delay);
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    retryStep = 0;
    flushQueue().catch(() => {});
  });
}

let flushing: Promise<{ sent: number; failed: number }> | null = null;

/**
 * Отправить ожидающие строго по порядку. На первой недоставке — стоп:
 * отправить следующее значило бы поставить его раньше застрявшего.
 * Два одновременных вызова (переподключение + кнопка в настройках) не
 * разбирают очередь дважды — второй ждёт первый.
 */
export function flushQueue(onSent: (pendingId: string, sentMsg: any) => void = replaceInStore): Promise<{ sent: number; failed: number }> {
  if (flushing) return flushing;
  flushing = sendInOrder(() => flushInOrder(onSent)).finally(() => { flushing = null; });
  return flushing;
}

async function flushInOrder(onSent: (pendingId: string, sentMsg: any) => void): Promise<{ sent: number; failed: number }> {
  const pending = await getAllPending();
  if (pending.length === 0) return { sent: 0, failed: 0 };

  console.log(`📤 Flushing offline queue: ${pending.length} messages`);
  let sent = 0;
  let failed = 0;

  for (const msg of pending) {
    try {
      msg.status = 'sending';
      await putMessage(msg);
      updateCachedMessage(msg);

      // client_id — тот же, что при первой попытке: если тогда сервер
      // сообщение получил, а ответ потерялся, он вернёт сохранённое, а не
      // создаст второе.
      const response = await chatApi.sendMessage(msg.chatId, {
        content: msg.content,
        type: msg.type,
        reply_to_id: msg.replyToId,
        metadata: msg.metadata,
        client_id: msg.id,
      });

      await deleteMessage(msg.id);
      removeCachedMessage(msg.id);
      const sentMsg = response.data?.message;
      if (sentMsg) onSent(msg.id, sentMsg);
      sent++;
      console.log('✅ Queued message sent:', msg.id);
    } catch (err) {
      failed++;
      if (!isNetworkFailure(err) && (err as any)?.response?.status < 500) {
        // Сервер отказал (не участник чата, пустое сообщение) — повтор не
        // поможет, а держать его во главе очереди значит не отправить
        // ничего из того, что за ним.
        await deleteMessage(msg.id);
        removeCachedMessage(msg.id);
        useChatStore.getState().updateMessage(msg.id, { status: 'failed' as any });
        console.warn('❌ Queued message rejected by server:', msg.id, err);
        continue;
      }

      // Счёт попыток — только ответам 5xx. Недоставку по сети не считаем:
      // повтор идёт по таймеру, и за несколько минут без связи сообщение
      // иначе «протухло» бы и пропало.
      if (!isNetworkFailure(err)) msg.retries++;
      msg.status = 'failed';
      await putMessage(msg);
      updateCachedMessage(msg);
      console.warn('❌ Failed to send queued message:', msg.id, err);

      if (msg.retries >= 10) {
        await deleteMessage(msg.id);
        removeCachedMessage(msg.id);
        useChatStore.getState().updateMessage(msg.id, { status: 'failed' as any });
        console.warn('🗑️ Dropped message after 10 retries:', msg.id);
        continue;
      }
      break;
    }
  }

  notifyListeners();
  if (cachedQueue.length > 0) {
    retryStep++;
    scheduleFlush();
  } else {
    retryStep = 0;
  }
  return { sent, failed };
}

/** Удалить конкретное сообщение из очереди (отмена) */
export async function cancelPendingMessage(id: string): Promise<void> {
  await deleteMessage(id);
  removeCachedMessage(id);
  notifyListeners();
}

/** Загрузить кэш при старте и восстановить pending-сообщения в UI */
export async function loadQueue(): Promise<PendingMessage[]> {
  try {
    cachedQueue = await getAllPending();
    for (const p of cachedQueue) lastCreatedAt = Math.max(lastCreatedAt, p.createdAt);
    notifyListeners();
    scheduleFlush();

    // Восстанавливаем pending-сообщения в store чата чтобы они
    // были видны после перезагрузки приложения (с часиками)
    if (cachedQueue.length > 0) {
      const currentUser = useAuthStore.getState().user;
      const store = useChatStore.getState();
      for (const pending of cachedQueue) {
        const restoredMsg = {
          id: pending.id,
          chat_id: pending.chatId,
          sender_id: currentUser?.id || '',
          sender: currentUser as any,
          content: pending.content,
          type: pending.type || 'text',
          status: 'pending' as const,
          reply_to_id: pending.replyToId,
          created_at: new Date(pending.createdAt).toISOString(),
        };
        // addMessage проверит дубликаты сам — не вставит если уже есть
        store.addMessage(restoredMsg);
      }
    }

    return cachedQueue;
  } catch {
    return [];
  }
}

/** Получить количество ожидающих */
export function getPendingCount(): number {
  return cachedQueue.length;
}

// === Helpers ===
function updateCachedMessage(msg: PendingMessage) {
  const idx = cachedQueue.findIndex(m => m.id === msg.id);
  if (idx >= 0) cachedQueue[idx] = { ...msg };
}

function removeCachedMessage(id: string) {
  cachedQueue = cachedQueue.filter(m => m.id !== id);
}
