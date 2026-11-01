// =============================================================
// Offline Data Cache — IndexedDB кэш чатов и сообщений
//
// Кэширует список чатов, последние сообщения каждого чата
// и профиль пользователя для офлайн-просмотра.
// =============================================================

const DB_NAME = 'storage-mess-cache';
const DB_VERSION = 2;
const STORE_CHATS = 'chats';
const STORE_MESSAGES = 'messages';
const STORE_META = 'meta';
const STORE_CONTACTS = 'contacts';
const STORE_GEO = 'geolocation';

// Максимум сообщений на чат для кэша
const MAX_MESSAGES_PER_CHAT = 200;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_CHATS)) {
        db.createObjectStore(STORE_CHATS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
        const store = db.createObjectStore(STORE_MESSAGES, { keyPath: 'id' });
        store.createIndex('by_chat', 'chat_id', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
      // v2: контакты и геолокация
      if ((event.oldVersion || 0) < 2) {
        if (!db.objectStoreNames.contains(STORE_CONTACTS)) {
          db.createObjectStore(STORE_CONTACTS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_GEO)) {
          const geoStore = db.createObjectStore(STORE_GEO, { keyPath: 'id', autoIncrement: true });
          geoStore.createIndex('timestamp', 'timestamp', { unique: false });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// === Чаты ===

export async function cacheChats(chats: any[]): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_CHATS, 'readwrite');
    const store = tx.objectStore(STORE_CHATS);
    // Очищаем и перезаписываем
    store.clear();
    for (const chat of chats) {
      store.put(chat);
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  } catch (err) {
    console.warn('Cache chats error:', err);
  }
}

export async function getCachedChats(): Promise<any[]> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CHATS, 'readonly');
      const req = tx.objectStore(STORE_CHATS).getAll();
      req.onsuccess = () => {
        db.close();
        const chats = req.result || [];
        // Сортируем по updated_at DESC
        chats.sort((a: any, b: any) => 
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
        );
        resolve(chats);
      };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  } catch {
    return [];
  }
}

// === Сообщения ===

export async function cacheMessages(chatId: string, messages: any[]): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_MESSAGES, 'readwrite');
    const store = tx.objectStore(STORE_MESSAGES);
    const index = store.index('by_chat');

    // Удаляем старые сообщения этого чата
    const existing = await new Promise<IDBValidKey[]>((resolve) => {
      const keys: IDBValidKey[] = [];
      const cursor = index.openKeyCursor(IDBKeyRange.only(chatId));
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (c) { keys.push(c.primaryKey); c.continue(); }
        else resolve(keys);
      };
      cursor.onerror = () => resolve([]);
    });
    for (const key of existing) store.delete(key);

    // Сохраняем последние N сообщений
    const toCache = messages.slice(-MAX_MESSAGES_PER_CHAT);
    for (const msg of toCache) store.put(msg);

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  } catch (err) {
    console.warn('Cache messages error:', err);
  }
}

export async function getCachedMessages(chatId: string): Promise<any[]> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_MESSAGES, 'readonly');
      const index = tx.objectStore(STORE_MESSAGES).index('by_chat');
      const req = index.getAll(IDBKeyRange.only(chatId));
      req.onsuccess = () => {
        db.close();
        const msgs = req.result || [];
        msgs.sort((a: any, b: any) => 
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        );
        resolve(msgs);
      };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  } catch {
    return [];
  }
}

/** Добавить одно сообщение в кэш (при получении нового) */
export async function cacheSingleMessage(message: any): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_MESSAGES, 'readwrite');
    tx.objectStore(STORE_MESSAGES).put(message);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  } catch (e) {
    console.warn('[OfflineCache] cacheSingleMessage failed:', e);
  }
}

/** Обновить сообщение в кэше (при редактировании) */
export async function updateCachedMessage(message: any): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_MESSAGES, 'readwrite');
    tx.objectStore(STORE_MESSAGES).put(message);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  } catch (e) {
    console.warn('[OfflineCache] updateCachedMessage failed:', e);
  }
}

/** Удалить сообщение из кэша */
export async function deleteCachedMessage(messageId: string): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_MESSAGES, 'readwrite');
    tx.objectStore(STORE_MESSAGES).delete(messageId);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  } catch (e) {
    console.warn('[OfflineCache] deleteCachedMessage failed:', e);
  }
}

// === Мета-данные ===

export async function setMeta(key: string, value: any): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_META, 'readwrite');
    tx.objectStore(STORE_META).put({ key, value, updatedAt: Date.now() });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  } catch {}
}

export async function getMeta(key: string): Promise<any> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_META, 'readonly');
      const req = tx.objectStore(STORE_META).get(key);
      req.onsuccess = () => { db.close(); resolve(req.result?.value ?? null); };
      req.onerror = () => { db.close(); resolve(null); };
    });
  } catch {
    return null;
  }
}

// === Контакты / пользователи ===

export async function cacheContacts(contacts: any[]): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_CONTACTS, 'readwrite');
    const store = tx.objectStore(STORE_CONTACTS);
    store.clear();
    for (const c of contacts) store.put(c);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  } catch (err) {
    console.warn('Cache contacts error:', err);
  }
}

export async function getCachedContacts(): Promise<any[]> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CONTACTS, 'readonly');
      const req = tx.objectStore(STORE_CONTACTS).getAll();
      req.onsuccess = () => { db.close(); resolve(req.result || []); };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  } catch {
    return [];
  }
}

// === Геолокация — сохранение GPS-данных на устройстве ===

export interface GeoPoint {
  id?: number;
  latitude: number;
  longitude: number;
  accuracy?: number;
  altitude?: number;
  speed?: number;
  heading?: number;
  timestamp: number;
  synced: boolean;
}

export async function saveGeoPoint(point: Omit<GeoPoint, 'id'>): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_GEO, 'readwrite');
      tx.objectStore(STORE_GEO).add(point);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  } catch (e) {
    console.warn('Save geo point error:', e);
  }
}

export async function getGeoHistory(limit = 100): Promise<GeoPoint[]> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_GEO, 'readonly');
      const req = tx.objectStore(STORE_GEO).getAll();
      req.onsuccess = () => {
        db.close();
        const points = (req.result as GeoPoint[] || [])
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, limit);
        resolve(points);
      };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  } catch {
    return [];
  }
}

export async function getUnsyncedGeoPoints(): Promise<GeoPoint[]> {
  try {
    const all = await getGeoHistory(1000);
    return all.filter(p => !p.synced);
  } catch {
    return [];
  }
}

export async function markGeoPointsSynced(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_GEO, 'readwrite');
      const store = tx.objectStore(STORE_GEO);
      for (const id of ids) {
        const req = store.get(id);
        req.onsuccess = () => {
          const item = req.result;
          if (item) {
            item.synced = true;
            store.put(item);
          }
        };
      }
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  } catch (e) {
    console.warn('Mark geo synced error:', e);
  }
}

// === Полная очистка кэша (при logout) ===

export async function clearAllOfflineData(): Promise<void> {
  try {
    const db = await openDB();
    const storeNames = [STORE_CHATS, STORE_MESSAGES, STORE_META, STORE_CONTACTS];
    // Не удаляем STORE_GEO т.к. это пользовательские данные
    const tx = db.transaction(storeNames, 'readwrite');
    for (const name of storeNames) {
      tx.objectStore(name).clear();
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
    console.log('[OfflineCache] All data cleared');
  } catch (e) {
    console.warn('Clear offline data error:', e);
  }
}

// === Статистика ===

export async function getOfflineStats(): Promise<{
  chats: number;
  messages: number;
  contacts: number;
  geoPoints: number;
}> {
  try {
    const db = await openDB();
    const storeNames = [STORE_CHATS, STORE_MESSAGES, STORE_CONTACTS, STORE_GEO];
    const tx = db.transaction(storeNames, 'readonly');
    const counts = await Promise.all(storeNames.map(name =>
      new Promise<number>((resolve) => {
        const req = tx.objectStore(name).count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(0);
      })
    ));
    db.close();
    return {
      chats: counts[0],
      messages: counts[1],
      contacts: counts[2],
      geoPoints: counts[3],
    };
  } catch {
    return { chats: 0, messages: 0, contacts: 0, geoPoints: 0 };
  }
}
