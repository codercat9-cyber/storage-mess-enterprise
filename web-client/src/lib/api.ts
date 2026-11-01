import axios, { AxiosError, AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import { useAuthStore } from '@/store/auth';
import { refreshAccessToken } from '@/lib/auth-refresh';
import { getApiUrl, resolveServerUrl, resetConnection } from '@/lib/connection';
import { слушатьЭтапыЗагрузки } from '@/lib/socket';

// При старте используем /api (relative), потом обновим на resolved URL
let API_URL = import.meta.env.VITE_API_URL || '/api';

/**
 * Пока адрес сервера не выяснен, запросы ждут здесь.
 *
 * Относительный «/api/…» — разумная заготовка для сайта: там это и есть
 * сервер. Но в настольном приложении интерфейс раздаётся с 127.0.0.1, и
 * тот же путь означает саму раздачу. Первые запросы после запуска —
 * профиль, свои подписи и аватарки контактов, настройки — успевали уйти
 * ДО того, как адрес сервера выяснен, и все три получали 404 от
 * собственной раздачи.
 *
 * Наружу это выглядело как «на компьютере не синхронизируются аватарки и
 * слетают настройки»: запросы-то уходили, только не туда. В журнале
 * сервера при этом пусто — он о них не знал.
 *
 * Поэтому: если адрес ещё не выяснен, запрос не отправляется, а ждёт.
 * Ожидание не бесконечное — если выяснение почему-то не завершится,
 * через несколько секунд отпускаем как есть, чтобы не подвесить всё.
 */
let baseUrlReady = false;
let waiters: Array<() => void> = [];

function markBaseUrlReady(): void {
  baseUrlReady = true;
  const list = waiters;
  waiters = [];
  for (const done of list) done();
}

function waitForBaseUrl(): Promise<void> | null {
  if (baseUrlReady) return null;
  return new Promise<void>(resolve => {
    waiters.push(resolve);
    // Отпускаем НАСОВСЕМ, а не только этот запрос: если выяснение адреса
    // сорвалось, ждать по семь секунд на каждом запросе — хуже, чем
    // работать по относительному пути, как было раньше.
    setTimeout(() => { markBaseUrlReady(); resolve(); }, 7000);
  });
}

export const api: AxiosInstance = axios.create({
  baseURL: API_URL,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
    // КРИТИЧЕСКИЙ ФИКС ДЛЯ APK: Android WebView агрессивно кэширует GET-запросы (например, getMessages),
    // из-за чего после реконнекта сокета подтягивался старый список сообщений и новые пропадали из UI.
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  },
});

/**
 * Инициализировать API с правильным URL (вызывается после resolveServerUrl)
 */
export function updateApiBaseUrl(): void {
  API_URL = getApiUrl();
  api.defaults.baseURL = API_URL;
  markBaseUrlReady();
  console.log('🌐 API baseURL updated to:', API_URL);
}

// Request interceptor - добавляем токен
api.interceptors.request.use(
  async (config: InternalAxiosRequestConfig) => {
    // Не выпускаем запрос, пока не известно, куда его слать. Иначе он
    // уйдёт по относительному пути — в настольном приложении это
    // собственная раздача интерфейса, а не сервер.
    const wait = waitForBaseUrl();
    if (wait) {
      await wait;
      if (config.baseURL !== api.defaults.baseURL) config.baseURL = api.defaults.baseURL;
    }

    const token = useAuthStore.getState().accessToken;
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Response interceptor - обновляем токен при 401
api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean };
    
    if (error.response?.status === 401 && !originalRequest._retry && useAuthStore.getState().refreshToken) {
      originalRequest._retry = true;

      // Выход — только если сервер прямо ответил, что сессии нет (см. auth-refresh).
      const result = await refreshAccessToken(API_URL);
      if (result === 'ok') {
        originalRequest.headers.Authorization = `Bearer ${useAuthStore.getState().accessToken}`;
        return api(originalRequest);
      }
      if (result === 'rejected') {
        useAuthStore.getState().logout();
        window.location.href = '/login';
      } else {
        console.warn('🔐 Token refresh failed (network/server), keeping session');
      }
    }
    
    return Promise.reject(error);
  }
);

// API методы
export const authApi = {
  register: (data: { username: string; email?: string; password: string; display_name?: string; terms_version?: string }) =>
    api.post('/auth/register', data),
  
  login: (data: { username: string; password: string }) =>
    api.post('/auth/login', data),
  
  logout: (refreshToken: string) =>
    api.post('/auth/logout', { refreshToken }),
  
  me: () => api.get('/auth/me'),
  
  refresh: (refreshToken: string) =>
    api.post('/auth/refresh', { refreshToken }),
  
  recover: (data: { username: string; recovery_key: string; new_password: string }) =>
    api.post('/auth/recover', data),

  requestReset: (username: string) =>
    api.post('/auth/request-reset', { username }),

  validateResetToken: (token: string) =>
    api.get(`/auth/reset-token/${token}`),

  resetByToken: (data: { token: string; new_password: string }) =>
    api.post('/auth/reset-by-token', data),

  changePassword: (data: { old_password: string; new_password: string }) =>
    api.post('/auth/change-password', data),

  emailResetAvailable: () =>
    api.get('/auth/email-reset-available'),

  getEmailBridgeSettings: () =>
    api.get('/auth/email-bridge-settings'),

  updateEmailBridgeSettings: (data: { email?: string; enabled?: boolean; password?: string }) =>
    api.put('/auth/email-bridge-settings', data),

  testPersonalEmail: (data: { email: string; password: string }) =>
    api.post('/auth/test-personal-email', data),
};

export const userApi = {
  search: (query: string, limit?: number) =>
    api.get('/users/search', { params: { q: query, limit } }),
  
  getMe: () =>
    api.get('/users/me'),

  getProfile: (userId: string) =>
    api.get(`/users/${userId}`),
  
  updateProfile: (data: { display_name?: string; avatar_url?: string }) =>
    api.patch('/users/me/profile', data),
  
  regenerateRecoveryKey: () =>
    api.post('/users/me/regenerate-recovery'),
  
  deleteAccount: () =>
    api.delete('/users/me'),

  // «Позвать администратора» — обращение с явным согласием на то, что
  // разрешено смотреть при разборе.
  supportRequest: (body: {
    subject: string;
    details?: string;
    chat_id?: string | null;
    consent_scope: 'none' | 'diagnostics' | 'messages';
    app_version?: string;
    device_label?: string;
  }) => api.post('/users/support-request', body),

  mySupportRequests: () => api.get('/users/support-request/mine'),
  
  getSettings: () =>
    api.get('/users/me/settings'),
  
  updateSettings: (data: { theme?: string; language?: string; notifications_enabled?: boolean; sound_enabled?: boolean }) =>
    api.patch('/users/me/settings', data),
  
  getContacts: () =>
    api.get('/users/me/contacts'),
  
  addContact: (userId: string) =>
    api.post('/users/me/contacts', { user_id: userId }),
  
  getContactRequests: () =>
    api.get('/users/me/contacts/requests'),
  
  handleContactRequest: (requestId: string, action: 'accept' | 'reject') =>
    api.patch(`/users/me/contacts/requests/${requestId}`, { action }),
  
  deleteContact: (contactId: string) =>
    api.delete(`/users/me/contacts/${contactId}`),
  
  blockUser: (userId: string) =>
    api.post(`/users/me/contacts/${userId}/block`),
  
  unblockUser: (userId: string) =>
    api.delete(`/users/me/contacts/${userId}/block`),

  // Contact overrides (локальные ники и аватары, синхронизируемые на сервер)
  getContactOverrides: () =>
    api.get('/users/me/contact-overrides'),

  setContactOverride: (contactId: string, data: { local_nickname?: string | null; local_avatar_url?: string | null }) =>
    api.put(`/users/me/contact-overrides/${contactId}`, data),
};

export const chatApi = {
  getChats: () =>
    api.get('/chats'),
  
  createPrivateChat: (userId: string) =>
    api.post('/chats/private', { user_id: userId }),
  
  createGroupChat: (name: string, memberIds: string[]) =>
    api.post('/chats/group', { name, member_ids: memberIds }),
  
  createChannel: (name: string, memberIds: string[]) =>
    api.post('/chats/channel', { name, member_ids: memberIds }),
  
  getOrCreateFavorites: () =>
    api.post('/chats/favorites'),
  
  getChat: (chatId: string) =>
    api.get(`/chats/${chatId}`),
  
  getMessages: (chatId: string, before?: string, limit?: number) =>
    api.get(`/chats/${chatId}/messages`, { params: { before, limit } }),
  
  getMessagesAround: (chatId: string, messageId: string, limit?: number) =>
    api.get(`/chats/${chatId}/messages`, { params: { around: messageId, limit } }),
  
  // client_id — свой идентификатор сообщения: при повторе сервер узнаёт уже
  // сохранённое и не создаёт дубль. Старый сервер поле просто игнорирует.
  sendMessage: (chatId: string, data: { content: string; type?: string; reply_to_id?: string; metadata?: Record<string, unknown>; client_id?: string }) =>
    api.post(`/chats/${chatId}/messages`, data),
  
  // Голосовые сообщения
  sendVoiceMessage: (chatId: string, audioBlob: Blob, duration: number) => {
    const formData = new FormData();
    // Определяем расширение по реальному MIME-типу blob
    const mimeType = audioBlob.type || 'audio/webm';
    let ext = '.webm';
    if (mimeType.includes('ogg')) ext = '.ogg';
    else if (mimeType.includes('mp4')) ext = '.mp4';
    else if (mimeType.includes('mpeg')) ext = '.mp3';
    else if (mimeType.includes('wav')) ext = '.wav';
    formData.append('audio', audioBlob, `voice${ext}`);
    formData.append('duration', String(duration));
    return api.post(`/chats/${chatId}/voice`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },
  
  markAsRead: (chatId: string, messageId: string) =>
    api.post(`/chats/${chatId}/read`, { message_id: messageId }),
  
  deleteMessage: (chatId: string, messageId: string, mode: 'for_me' | 'for_all') =>
    api.delete(`/chats/${chatId}/messages/${messageId}`, { params: { mode } }),
  
  addMember: (chatId: string, userId: string) =>
    api.post(`/chats/${chatId}/members`, { user_id: userId }),
  
  removeMember: (chatId: string, memberId: string) =>
    api.delete(`/chats/${chatId}/members/${memberId}`),
  
  leaveChat: (chatId: string) =>
    api.post(`/chats/${chatId}/leave`),
  
  deleteChat: (chatId: string) =>
    api.delete(`/chats/${chatId}`),
  
  searchMessages: (query: string, limit?: number) =>
    api.get('/chats/search/messages', { params: { q: query, limit } }),

  searchChatMessages: (chatId: string, query: string, limit?: number) =>
    api.get(`/chats/${chatId}/messages/search`, { params: { q: query, limit } }),

  // Аватар группы/канала
  uploadGroupAvatar: (chatId: string, file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    return api.post(`/chats/${chatId}/avatar`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },

  // Реакции
  toggleReaction: (chatId: string, messageId: string, emoji: string) =>
    api.post(`/chats/${chatId}/messages/${messageId}/reactions`, { emoji }),

  // Медиафайлы чата
  getChatMedia: (chatId: string, type: string, limit?: number, offset?: number) =>
    api.get(`/chats/${chatId}/media`, { params: { type, limit, offset } }),
};

// Подробности хода загрузки. Раньше наружу отдавались только проценты, и
// показать «сколько мегабайт из скольких», скорость и остаток было нечем.
export interface UploadTick {
  loaded: number;
  total: number;
  percent: number;
  /** Номер куска и всего кусков — для чанковой загрузки, иначе undefined. */
  chunk?: number;
  chunks?: number;
  /** Загрузка подхватила уже отправленные ранее куски. */
  resumed?: boolean;
  /**
   * Чем сервер занят прямо сейчас.
   *
   * Передача кусков — только часть пути: дальше файл собирается из них и
   * шифруется, и на нескольких гигабайтах это минуты. Раньше об этом никто
   * не сообщал, полоса замирала на ста процентах, и люди начинали загрузку
   * заново.
   */
  stage?: 'sending' | 'assembling' | 'encrypting' | 'done';
}

export interface UploadOptions {
  source?: string;
  signal?: AbortSignal;
  onTick?: (t: UploadTick) => void;
  /** Сообщить наружу идентификатор сессии, чтобы его можно было сохранить. */
  onSession?: (sessionId: string) => void;
}

// Уведомления от конкретного человека.
//
// Настройка личная и односторонняя: тихо становится только у того, кто её
// включил. Собеседник об этом не узнает, а его сообщения приходят и лежат
// в переписке как обычно.
export const muteApi = {
  /** Кого я заглушил. */
  list: () => api.get<{ muted: string[] }>('/users/me/muted'),
  /** Включить или выключить уведомления от человека. */
  set: (contactId: string, muted: boolean) =>
    api.put<{ contactId: string; muted: boolean }>(`/users/me/muted/${contactId}`, { muted }),
};

export const fileApi = {
  // Обычная загрузка (для небольших файлов — одним запросом)
  upload: (file: File, onProgress?: (percent: number) => void, source?: string, opts?: UploadOptions) => {
    const formData = new FormData();
    formData.append('file', file);
    if (source) formData.append('source', source);
    return api.post('/files/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 0,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      signal: opts?.signal,
      onUploadProgress: (e: any) => {
        const total = e.total || file.size;
        const loaded = Math.min(e.loaded || 0, total);
        onProgress?.(Math.round((loaded / total) * 100));
        opts?.onTick?.({ loaded, total, percent: Math.round((loaded / total) * 100) });
      },
    });
  },

  // Chunked загрузка — для больших файлов, с настоящей докачкой.
  //
  // Докачка тут была и раньше, но не работала: клиент создавал новую сессию
  // на каждый заход и тут же спрашивал у неё, что уже загружено, — ответ,
  // разумеется, всегда был «ничего». Сервер теперь возвращает существующую
  // сессию для того же файла и вместе с ней список принятых кусков.
  uploadLargeFile: async (
    file: File,
    onProgress?: (percent: number) => void,
    source?: string,
    opts?: UploadOptions,
  ): Promise<any> => {
    const CHUNK_SIZE = 10 * 1024 * 1024; // 10 MB — совпадает с сервером

    const initRes = await api.post('/files/upload/init', {
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type || 'application/octet-stream',
      source: source || 'storage',
    }, { signal: opts?.signal });

    const { sessionId, totalChunks } = initRes.data;
    opts?.onSession?.(sessionId);

    // Список принятых кусков приходит прямо из init. Отдельный запрос
    // статуса остаётся запасным путём — на случай старого сервера.
    let receivedSet = new Set<number>(initRes.data.receivedChunks || []);
    if (!initRes.data.receivedChunks) {
      try {
        const statusRes = await api.get(`/files/upload/status/${sessionId}`, { signal: opts?.signal });
        receivedSet = new Set(statusRes.data.receivedChunks || []);
      } catch { /* сессия новая — докачивать нечего */ }
    }
    const resumed = receivedSet.size > 0;

    const chunkStart = (i: number) => i * CHUNK_SIZE;
    const chunkEnd = (i: number) => Math.min(chunkStart(i) + CHUNK_SIZE, file.size);
    // Байты, уже лежащие на сервере с прошлого раза.
    let baseLoaded = 0;
    for (const i of receivedSet) baseLoaded += chunkEnd(i) - chunkStart(i);

    // Передача кусков — это 70 процентов пути, а не все сто.
    //
    // Оставшееся время уходит на сборку файла из кусков и шифрование, и на
    // многогигабайтном архиве это минуты. Раньше шкала доходила до ста ещё
    // до начала этой работы — и человек, глядя на замерший индикатор, решал,
    // что всё повисло, и отправлял файл заново.
    const ДОЛЯ_ПЕРЕДАЧИ = 0.70;

    const tick = (loaded: number, chunk: number) => {
      const clamped = Math.min(loaded, file.size);
      const percent = Math.round((clamped / file.size) * 100 * ДОЛЯ_ПЕРЕДАЧИ);
      onProgress?.(percent);
      opts?.onTick?.({
        loaded: clamped, total: file.size, percent,
        chunk: chunk + 1, chunks: totalChunks, resumed,
        stage: 'sending',
      });
    };
    tick(baseLoaded, Math.max(0, receivedSet.size - 1));

    for (let i = 0; i < totalChunks; i++) {
      if (opts?.signal?.aborted) throw new DOMException('Upload canceled', 'AbortError');
      if (receivedSet.has(i)) continue;

      const chunk = file.slice(chunkStart(i), chunkEnd(i));
      const formData = new FormData();
      formData.append('chunk', chunk);

      let attempts = 0;
      while (attempts < 3) {
        try {
          await api.post(`/files/upload/chunk/${sessionId}/${i}`, formData, {
            headers: { 'Content-Type': 'multipart/form-data' },
            timeout: 120000, // 2 мин на чанк
            maxBodyLength: Infinity,
            signal: opts?.signal,
            // Прогресс внутри куска: без него на 10-мегабайтном куске
            // полоска стоит колом, и кажется, что всё зависло.
            onUploadProgress: (e: any) => tick(baseLoaded + Math.min(e.loaded || 0, chunk.size), i),
          });
          break;
        } catch (err: any) {
          if (err?.name === 'AbortError' || err?.code === 'ERR_CANCELED') throw err;
          attempts++;
          if (attempts >= 3) throw err;
          await new Promise(r => setTimeout(r, 2000 * attempts)); // Backoff
        }
      }

      baseLoaded += chunk.size;
      tick(baseLoaded, i);
    }

    // Пока сервер собирает и шифрует файл, он рассказывает об этом
    // событиями — показываем их вместо застывших ста процентов.
    const отписаться = слушатьЭтапыЗагрузки(sessionId, (e) => {
      if (e.stage === 'failed') return;
      onProgress?.(e.percent);
      opts?.onTick?.({
        loaded: e.doneBytes ?? file.size,
        total: e.totalBytes ?? file.size,
        percent: e.percent,
        chunks: totalChunks,
        stage: e.stage === 'done' ? 'done' : e.stage,
      });
    });

    try {
      return await api.post(`/files/upload/complete/${sessionId}`, {}, { timeout: 0, signal: opts?.signal });
    } finally {
      отписаться();
    }
  },

  // Умная загрузка: автоматически выбирает метод (обычный или chunked).
  //
  // Порог опущен со 100 МБ до 20: всё, что крупнее, теперь идёт кусками и
  // переживает обрыв связи и сворачивание приложения. Со 100 МБ практически
  // ни одна реальная отправка не была докачиваемой — а теряются как раз
  // большие файлы, которые дольше всего грузятся.
  smartUpload: async (
    file: File,
    onProgress?: (percent: number) => void,
    source?: string,
    opts?: UploadOptions,
  ): Promise<any> => {
    const THRESHOLD = 20 * 1024 * 1024; // 20 МБ
    if (file.size > THRESHOLD) {
      return fileApi.uploadLargeFile(file, onProgress, source, opts);
    }
    return fileApi.upload(file, onProgress, source, opts);
  },

  // Отмена chunked загрузки
  cancelUpload: (sessionId: string) =>
    api.delete(`/files/upload/cancel/${sessionId}`),
  
  uploadMultiple: (files: File[]) => {
    const formData = new FormData();
    files.forEach(file => formData.append('files', file));
    return api.post('/files/upload/multiple', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 0,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
  },
  
  getInfo: (fileId: string) =>
    api.get(`/files/info/${fileId}`),
  
  getMyFiles: (limit?: number, offset?: number) =>
    api.get('/files/my', { params: { limit, offset } }),

  getPublicFiles: (limit?: number, offset?: number) =>
    api.get('/files/public', { params: { limit, offset } }),
  
  deleteFile: (fileId: string) =>
    api.delete(`/files/${fileId}`),
  
  setPublic: (fileId: string, isPublic: boolean) =>
    api.patch(`/files/${fileId}/public`, { is_public: isPublic }),
  
  getDownloadUrl: (fileId: string) => {
    const token = useAuthStore.getState().accessToken;
    return `${getApiUrl()}/files/download/${fileId}${token ? `?token=${token}` : ''}`;
  },
  
  getViewUrl: (fileId: string) => {
    const token = useAuthStore.getState().accessToken;
    return `${getApiUrl()}/files/view/${fileId}${token ? `?token=${token}` : ''}`;
  },

  getThumbnailUrl: (fileId: string) => {
    const token = useAuthStore.getState().accessToken;
    return `${getApiUrl()}/files/thumbnail/${fileId}${token ? `?token=${token}` : ''}`;
  },

  getStats: () =>
    api.get('/files/stats'),

  getShareUrl: (fileId: string) => {
    return `${window.location.origin}/api/files/download/${fileId}`;
  },
};

export default api;

// ─── Админка ───
// Доступ проверяет сервер: постороннему все эти адреса отвечают 404,
// чтобы сам факт существования раздела наружу не торчал.
export const adminApi = {
  stats: () => api.get('/admin/stats'),
  users: (q = '', limit = 50, offset = 0, filter = 'all', sort = 'new') =>
    api.get('/admin/users', { params: { q, limit, offset, filter, sort } }),
  block: (id: string, reason: string) => api.post(`/admin/users/${id}/block`, { reason }),
  unblock: (id: string) => api.post(`/admin/users/${id}/unblock`),
  resetPassword: (id: string, new_password: string) =>
    api.post(`/admin/users/${id}/reset-password`, { new_password }),
  logoutAll: (id: string) => api.post(`/admin/users/${id}/logout-all`),
  setRole: (id: string, role: 'admin' | 'moderator' | 'user') => api.post(`/admin/users/${id}/role`, { role }),
  rename: (id: string, body: { username?: string; display_name?: string }) =>
    api.post(`/admin/users/${id}/username`, body),
  support: (status = 'open') => api.get('/admin/support', { params: { status } }),
  closeSupport: (id: string, resolution: string) =>
    api.post(`/admin/support/${id}/close`, { resolution }),
  deleteUser: (id: string) => api.delete(`/admin/users/${id}`),
  message: (id: string) => api.get(`/admin/messages/${id}`),
  deleteMessage: (id: string) => api.delete(`/admin/messages/${id}`),
  // Чат по идентификатору из обращения: тип, счётчики, участники — без
  // единого сообщения. Списка чатов нет намеренно, см. AdminPage.
  getChat: (id: string) => api.get(`/admin/chats/${id}`),
  deleteChat: (id: string) => api.delete(`/admin/chats/${id}`),
  broadcast: (text: string) => api.post('/admin/broadcast', { text }),
  audit: (limit = 200) => api.get('/admin/audit', { params: { limit } }),
  logs: (level = 'all', lines = 300) => api.get('/admin/logs', { params: { level, lines } }),
  healthFull: () => api.get('/admin/health-full'),
  sessions: () => api.get('/admin/sessions'),
  banned: () => api.get('/admin/banned'),
  unban: (ip: string) => api.post('/admin/banned/unban', { ip }),
  diagnostics: (id: string) => api.get(`/admin/users/${id}/diagnostics`),
  checkpoint: () => api.post('/admin/maintenance/checkpoint'),
};


// Правила использования: какую редакцию принял пользователь
export const legalApi = {
  status: () => api.get('/legal/status'),
  accept: (version: string) => api.post('/legal/accept', { version }),
};

// Жалоба на сообщение
export const reportApi = {
  create: (body: { message_id: string; reason: string; comment?: string }) => api.post('/reports', body),
};

// Модерация: жалобы, чистка, хранилище
export const moderationApi = {
  reports: (status: 'open' | 'closed' = 'open') => api.get('/admin/moderation/reports', { params: { status } }),
  report: (id: string) => api.get(`/admin/moderation/reports/${id}`),
  resolve: (id: string, action: 'dismiss' | 'delete' | 'block' | 'delete_block', note?: string) =>
    api.post(`/admin/moderation/reports/${id}/resolve`, { action, note }),
  storageSummary: () => api.get('/admin/moderation/storage/summary'),
  storageFiles: (params: { sort?: 'size' | 'date'; type?: string; q?: string; user?: string; limit?: number; offset?: number }) =>
    api.get('/admin/moderation/storage/files', { params }),
  fileDownload: (id: string) => api.post(`/admin/moderation/storage/files/${id}/download`),
  fileDelete: (id: string) => api.delete(`/admin/moderation/storage/files/${id}`),
};

// Корпоративный контур: каталог (AD), вход доменом, УЦ устройств.
// info, ca и crl — без входа; status, sync, users, events — админу.
export const enterpriseApi = {
  info: () => api.get('/enterprise/info', { timeout: 6000 }),
  status: () => api.get('/enterprise/status'),
  // Каталог на тысячи учёток отвечает не за секунды — ждём дольше обычного
  sync: () => api.post('/enterprise/sync', undefined, { timeout: 120000 }),
  users: () => api.get('/enterprise/users'),
  events: (limit = 100) => api.get('/enterprise/events', { params: { limit } }),
  enrollDevice: (ed_pub: string, label: string) => api.post('/enterprise/devices', { ed_pub, label }),
  ca: () => api.get('/enterprise/ca', { timeout: 8000 }),
  crl: () => api.get('/enterprise/crl', { timeout: 8000 }),
};
