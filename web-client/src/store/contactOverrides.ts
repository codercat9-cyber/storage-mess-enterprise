import { create } from 'zustand';
import { userApi } from '@/lib/api';

/**
 * Свои подписи и аватарки для контактов.
 *
 * Человек может поставить собеседнику своё имя и свою картинку — их видит
 * только он. Хранились они в памяти браузера, а на сервер уезжали «в один
 * конец»: отправили и забыли. Отсюда две беды.
 *
 * Первая: обратно их никто не показывал. Загрузка с сервера писала прямо в
 * localStorage, а список чатов читает localStorage во время отрисовки —
 * то есть до того, как ответ пришёл. Значения появлялись только со
 * следующей перерисовки, а на новом устройстве выглядело так, будто
 * синхронизации нет вовсе.
 *
 * Вторая: если на сервере записи не оказалось (а её сносил старый разрыв
 * в обновлении — см. user.routes.ts), то ничего и не приезжало.
 *
 * Теперь это обычное состояние приложения: localStorage остаётся кэшем на
 * случай запуска без сети, но источник правды — стор, и любое изменение
 * перерисовывает тех, кто его читает. Плюс сверка при запуске в обе
 * стороны: чего нет на сервере — доливаем со своего устройства.
 */

interface Override {
  nick?: string | null;
  avatar?: string | null;
}

interface ContactOverridesState {
  map: Record<string, Override>;
  loaded: boolean;
  getNick: (contactId: string) => string | null;
  getAvatar: (contactId: string) => string | null;
  setNick: (contactId: string, nick: string | null) => void;
  setAvatar: (contactId: string, dataUrl: string | null) => void;
  sync: () => Promise<void>;
  reset: () => void;
}

const NICK_KEY = (id: string) => `local_nick_${id}`;
const AVATAR_KEY = (id: string) => `local_avatar_${id}`;

/** Читаем то, что уже лежит в браузере, чтобы список не мигал при запуске. */
function readFromStorage(): Record<string, Override> {
  const map: Record<string, Override> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (key.startsWith('local_nick_')) {
        const id = key.slice('local_nick_'.length);
        map[id] = { ...map[id], nick: localStorage.getItem(key) };
      } else if (key.startsWith('local_avatar_')) {
        const id = key.slice('local_avatar_'.length);
        map[id] = { ...map[id], avatar: localStorage.getItem(key) };
      }
    }
  } catch { /* приватный режим — обойдёмся памятью */ }
  return map;
}

function writeToStorage(id: string, ov: Override) {
  try {
    if (ov.nick) localStorage.setItem(NICK_KEY(id), ov.nick);
    else localStorage.removeItem(NICK_KEY(id));

    if (ov.avatar) localStorage.setItem(AVATAR_KEY(id), ov.avatar);
    else localStorage.removeItem(AVATAR_KEY(id));
  } catch {
    // Картинки лежат тут же строкой в base64, и место может кончиться.
    // Тогда остаёмся с копией в памяти и на сервере — при следующем
    // запуске подтянется оттуда.
  }
}

/** Забыть подпись к контакту, которого больше нет на сервере. */
function removeFromStorage(id: string) {
  try {
    localStorage.removeItem(NICK_KEY(id));
    localStorage.removeItem(AVATAR_KEY(id));
  } catch { /* приватный режим */ }
}

export const useContactOverrides = create<ContactOverridesState>((set, get) => ({
  map: readFromStorage(),
  loaded: false,

  getNick: (contactId) => get().map[contactId]?.nick || null,
  getAvatar: (contactId) => get().map[contactId]?.avatar || null,

  setNick: (contactId, nick) => {
    const value = nick && nick.trim() ? nick.trim() : null;
    const next = { ...get().map[contactId], nick: value };
    set(state => ({ map: { ...state.map, [contactId]: next } }));
    writeToStorage(contactId, next);
    userApi.setContactOverride(contactId, { local_nickname: value }).catch(() => {});
  },

  setAvatar: (contactId, dataUrl) => {
    const next = { ...get().map[contactId], avatar: dataUrl || null };
    set(state => ({ map: { ...state.map, [contactId]: next } }));
    writeToStorage(contactId, next);
    userApi.setContactOverride(contactId, { local_avatar_url: dataUrl || null }).catch(() => {});
  },

  sync: async () => {
    let serverList: Array<{ contact_id: string; local_nickname: string | null; local_avatar_url: string | null }>;
    try {
      const res = await userApi.getContactOverrides();
      serverList = res.data?.overrides;
      if (!Array.isArray(serverList)) return;
    } catch {
      return; // нет сети — работаем с тем, что в браузере
    }

    const local = get().map;
    const merged: Record<string, Override> = { ...local };
    const toUpload: Array<{ id: string; body: Record<string, string | null> }> = [];

    for (const row of serverList) {
      const id = row.contact_id;
      const fromServer: Override = {
        nick: row.local_nickname || null,
        avatar: row.local_avatar_url || null,
      };
      const mine = local[id] || {};

      // Что есть на сервере — то и показываем: это общая для всех
      // устройств картина. Чего на сервере нет, а у нас есть — доливаем
      // туда: так возвращаются аватарки, которые снёс старый разрыв в
      // обновлении записи.
      merged[id] = {
        nick: fromServer.nick || mine.nick || null,
        avatar: fromServer.avatar || mine.avatar || null,
      };

      const body: Record<string, string | null> = {};
      if (!fromServer.nick && mine.nick) body.local_nickname = mine.nick;
      if (!fromServer.avatar && mine.avatar) body.local_avatar_url = mine.avatar;
      if (Object.keys(body).length) toUpload.push({ id, body });
    }

    // Контакты, о которых сервер вообще не знает.
    const known = new Set(serverList.map(r => r.contact_id));
    for (const [id, ov] of Object.entries(local)) {
      if (known.has(id)) continue;
      const body: Record<string, string | null> = {};
      if (ov.nick) body.local_nickname = ov.nick;
      if (ov.avatar) body.local_avatar_url = ov.avatar;
      if (Object.keys(body).length) toUpload.push({ id, body });
    }

    for (const [id, ov] of Object.entries(merged)) writeToStorage(id, ov);
    set({ map: merged, loaded: true });

    // Доливка идёт после показа: картинки тяжёлые, и ждать её незачем.
    //
    // 404 означает, что такой учётки больше нет. Держать подпись к
    // удалённому человеку незачем: она не приживётся на сервере никогда, а
    // при каждом входе будет уходить туда заново. Убираем у себя.
    for (const item of toUpload) {
      userApi.setContactOverride(item.id, item.body).catch(err => {
        if (err?.response?.status !== 404) return;
        removeFromStorage(item.id);
        set(state => {
          const next = { ...state.map };
          delete next[item.id];
          return { map: next };
        });
      });
    }
  },

  reset: () => {
    try {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.startsWith('local_nick_') || key.startsWith('local_avatar_'))) keys.push(key);
      }
      for (const key of keys) localStorage.removeItem(key);
    } catch { /* нечего чистить */ }
    set({ map: {}, loaded: false });
  },
}));

/**
 * Подписки для отрисовки. Именно они дают перерисовку, когда сверка с
 * сервером закончилась, — раньше значение читалось из localStorage и
 * React о его появлении не узнавал.
 */
export const useLocalNick = (contactId?: string | null) =>
  useContactOverrides(s => (contactId ? s.map[contactId]?.nick || null : null));

export const useLocalAvatar = (contactId?: string | null) =>
  useContactOverrides(s => (contactId ? s.map[contactId]?.avatar || null : null));
