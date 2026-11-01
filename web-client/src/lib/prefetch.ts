// =============================================================
// Фоновая подкачка: последние сообщения верхних чатов — в локальную базу.
//
// Без неё чат, ни разу не открытый при живой сети, в аварии пустой:
// сообщения кэшировались только при открытии чата. Теперь, пока сеть
// есть, приложение тихо забирает хвосты верхних чатов — как Telegram, —
// и без сервера открывается любой из них.
//
// Бережно: по одному запросу с паузой, только изменившиеся с прошлого
// раза чаты; при первом же сбое сети — стоп до следующего запуска.
// =============================================================

import { chatApi } from '@/lib/api';
import { cacheMessages, getMeta, setMeta } from '@/lib/offline-cache';
import { decryptMessages } from '@/lib/e2ee';
import { useAuthStore } from '@/store/auth';

const PREFETCH_CHATS = 30;
const PREFETCH_MSGS = 50;
const GAP_MS = 400;
const META_KEY = 'prefetch_seen';

let running = false;

const stamp = (c: any): string =>
  String(c.last_message?.id || c.last_message?.created_at || c.updated_at || '');

export async function prefetchRecentMessages(chats: any[]): Promise<void> {
  if (running || !chats?.length) return;
  running = true;
  try {
    const seen: Record<string, string> = (await getMeta(META_KEY)) || {};
    const top = [...chats]
      .sort((a, b) => String(b.last_message?.created_at || b.updated_at || '')
        .localeCompare(String(a.last_message?.created_at || a.updated_at || '')))
      .slice(0, PREFETCH_CHATS);
    let fetched = 0;
    for (const c of top) {
      if (!c?.id || (seen[c.id] && seen[c.id] === stamp(c))) continue;
      if (typeof navigator !== 'undefined' && !navigator.onLine) break;
      try {
        const r = await chatApi.getMessages(c.id, undefined, PREFETCH_MSGS);
        const token = useAuthStore.getState().accessToken || '';
        const myId = useAuthStore.getState().user?.id;
        const msgs = await decryptMessages(r.data?.messages || [], token, myId);
        await cacheMessages(c.id, msgs);
        seen[c.id] = stamp(c);
        await setMeta(META_KEY, seen);
        fetched++;
      } catch {
        break; // сеть пропала — остальное в следующий раз
      }
      await new Promise(res => setTimeout(res, GAP_MS));
    }
    if (fetched) console.log(`📥 Подкачано в локальную базу: ${fetched} чат(ов)`);
  } finally {
    running = false;
  }
}
