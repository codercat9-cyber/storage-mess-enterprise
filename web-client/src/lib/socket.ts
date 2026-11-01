import { io, Socket } from 'socket.io-client';
import axios from 'axios';
import { useAuthStore } from '@/store/auth';
import { refreshAccessToken, RefreshResult } from '@/lib/auth-refresh';
import { useChatStore } from '@/store/chat';
import { useThemeStore, applyRemoteSettings } from '@/store/theme';
import { Message, Call } from '@/types';
import { getBaseUrl, getApiUrl } from '@/lib/connection';
import { decryptMessage, decryptMessages, isE2EEEnabled, EncryptedMessage, E2EEEnvelope } from '@/lib/e2ee';
import { notifyNewMessage, notifyIncomingCall } from '@/lib/notifications';
import { subscribeToPush } from '@/lib/pwa';
import { flushQueue, getPendingCount } from '@/lib/offline-queue';
import { cacheSingleMessage, updateCachedMessage, deleteCachedMessage } from '@/lib/offline-cache';
import { userApi } from '@/lib/api';

let socket: Socket | null = null;
let onIncomingCall: ((call: Call) => void) | null = null;
let onCallAnswered: ((data: { call_id: string; user_id: string }) => void) | null = null;
let onCallEnded: ((data: { call_id: string }) => void) | null = null;
let onCallRejected: ((data: { call_id: string; user_id: string }) => void) | null = null;
let onParticipantLeft: ((data: { call_id: string; user_id: string }) => void) | null = null;
let onSocketReconnect: (() => void) | null = null;

// Защита от дубликатов call:incoming (если у пользователя несколько сокетов / вкладок)
let _lastIncomingCallId: string | null = null;
let _lastIncomingCallTime = 0;

// Повторное подключение при возврате на вкладку / восстановлении сети
let _visibilityListenerAdded = false;
function _setupVisibilityReconnect() {
  if (_visibilityListenerAdded) return;
  _visibilityListenerAdded = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && socket && !socket.connected) {
      console.log('🔌 Tab visible — reconnecting socket...');
      socket.connect();
    }
  });
  // Реконнект при восстановлении интернета (wifi↔mobile, VPN вкл/выкл)
  window.addEventListener('online', () => {
    if (socket && !socket.connected) {
      console.log('🌐 Network online — reconnecting socket...');
      setTimeout(() => { socket?.connect(); }, 500);
    }
  });
}

// Обновление токена — общее с REST, см. auth-refresh.ts
async function _tryRefreshToken(): Promise<RefreshResult> {
  return refreshAccessToken(getApiUrl());
}

export function isSocketConnected(): boolean {
  return !!socket?.connected;
}

// Гарантируем подключение (для вызовов и других критичных операций)
export function ensureSocketConnected(): Promise<boolean> {
  if (socket?.connected) return Promise.resolve(true);
  
  // Если сокет существует но не подключён — пробуем переподключиться
  if (socket) {
    socket.connect();
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 5000);
      socket!.once('connect', () => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
  }
  
  // Сокета нет вообще — создаём заново
  const newSocket = initSocket();
  if (newSocket.connected) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), 5000);
    newSocket.once('connect', () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

export function initSocket(): Socket {
  if (socket?.connected) return socket;
  
  // Если сокет уже есть но disconnected, очистим его
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }

  const token = useAuthStore.getState().accessToken;
  const serverUrl = getBaseUrl();
  // Если это IP-адрес (любой), мы считаем его fallback и отключаем secure
  const isIpFallback = /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/.test(serverUrl.replace('https://', '').replace('http://', ''));
  console.log('🔌 Connecting socket to:', serverUrl, 'isIpFallback:', isIpFallback);

  // Read cached footprint (set by main.tsx)
  let footprintStr = localStorage.getItem('device_footprint');
  let footprint = footprintStr ? JSON.parse(footprintStr) : undefined;
  
  socket = io(serverUrl, {
    auth: { token, footprint },
    path: '/api/sync/',
    transports: ['websocket', 'polling'], // WEBSOCKET FIRST! Теперь работает даже по IP (через HTTP 8080)
    secure: !isIpFallback, // HTTP fallback не использует WSS
    rejectUnauthorized: false,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,   // Начальная задержка 1с
    reconnectionDelayMax: 15000, // Макс 15с между попытками
    randomizationFactor: 0.3,  // Разброс для избежания thundering herd
    forceNew: false,
    // Polling-specific: частые запросы для low-latency
    // Socket.IO polling использует HTTP long-polling, каждый ответ сразу шлёт новый запрос
  });

  // Подключение
  socket.on('connect', () => {
    console.log('🔌 Socket connected:', socket?.id);

    // Перечитываем свой профиль при каждом подключении.
    //
    // В нём приезжает роль, а она могла смениться, пока приложение было
    // закрыто: событие о смене до нас тогда не дошло. Без этого
    // назначенный модератор не увидел бы свою панель до перезахода в
    // учётную запись.
    userApi.getMe()
      .then(r => {
        const fresh = r.data?.user;
        if (fresh) useAuthStore.getState().updateUser(fresh);
      })
      .catch(() => { /* нет сети — обновимся при следующем подключении */ });

    // Уведомляем о реконнекте (для retry звонков)
    if (onSocketReconnect) {
      // Небольшая задержка чтобы сокет успел зарегистрироваться на сервере
      setTimeout(() => { try { onSocketReconnect?.(); } catch {} }, 500);
    }

    // Подписываемся на Web Push (для уведомлений когда приложение закрыто)
    const pushToken = useAuthStore.getState().accessToken;
    if (pushToken) {
      subscribeToPush(serverUrl, pushToken).catch(() => {});
    }

    // Отправляем офлайн-очередь сообщений при восстановлении подключения
    if (getPendingCount() > 0) {
      console.log('📤 Flushing offline message queue...');
      flushQueue((pendingId, sentMsg) => {
        // Заменяем оптимистичное сообщение на реальное от сервера
        useChatStore.getState().replacePendingMessage(pendingId, sentMsg);
      }).then(({ sent, failed }) => {
        if (sent > 0) console.log(`✅ Sent ${sent} queued messages`);
        if (failed > 0) console.warn(`❌ ${failed} queued messages failed`);
      }).catch(() => {});
    }
  });

  socket.on('disconnect', (reason) => {
    console.warn('🔌 Socket disconnected:', reason, '— will auto-reconnect');
    // Транспорт потерян (смена сети, VPN переключение) — форсируем быстрый реконнект
    if (reason === 'transport close' || reason === 'transport error') {
      console.log('🔌 Transport lost — forcing immediate reconnect');
      setTimeout(() => { socket?.connect(); }, 300);
    }
  });

  socket.on('connect_error', async (error: any) => {
    console.error('🔌 Socket connection error:', error.message, 'Full:', JSON.stringify({ name: error.name, message: error.message, desc: error.description, context: error.context }));
    
    // Если токен невалиден/протух — пробуем обновить через refresh token
    if (error.message === 'Invalid token' || error.message === 'Authentication required') {
      console.log('🔐 Token rejected, attempting refresh...');
      const result = await _tryRefreshToken();
      if (result === 'ok' && socket) {
        // Свежий токен в auth (footprint сохраняем) и переподключаемся
        socket.auth = { ...(socket.auth as Record<string, unknown>), token: useAuthStore.getState().accessToken };
        console.log('🔐 Token refreshed, reconnecting socket...');
        socket.connect();
      } else if (result === 'rejected') {
        // Сервер прямо ответил: сессии больше нет. Только тогда — выход.
        console.error('🔐 Session rejected by server. Logging out.');
        useAuthStore.getState().logout();
        window.location.href = '/login';
      } else {
        // Не достучались или сбой на сервере — сессию не трогаем.
        // После отказа в авторизации socket.io сам не переподключается.
        console.warn('🔐 Token refresh failed (network/server), retrying in 15s');
        setTimeout(() => { if (socket && !socket.connected) socket.connect(); }, 15000);
      }
    }
  });

  socket.on('reconnect', (attempt) => {
    console.log('🔌 Socket reconnected after', attempt, 'attempts');
    // Ре-синхронизируем профиль после реконнекта (на случай изменений на сервере)
    import('@/lib/api').then(({ authApi, chatApi }) => {
      authApi.me().then(res => {
        const serverUser = res.data?.user || res.data;
        if (serverUser && serverUser.id) {
          useAuthStore.getState().updateUser(serverUser);
        }
      }).catch(() => {});
      // Ре-синхронизируем сообщения текущего чата (догружаем пропущенные за время disconnect)
      const currentChat = useChatStore.getState().currentChat;
      if (currentChat) {
        const currentMsgs = useChatStore.getState().messages[currentChat.id] || [];
        const lastMsg = currentMsgs[currentMsgs.length - 1];
        // Загружаем свежие сообщения и МЕРЖИМ с существующими (не заменяем!)
        chatApi.getMessages(currentChat.id, undefined, 200).then(async response => {
          const token = useAuthStore.getState().accessToken || '';
          const myId = useAuthStore.getState().user?.id;
          const freshMsgs: Message[] = await decryptMessages(response.data.messages || [], token, myId);
          if (freshMsgs.length > 0) {
            const existingIds = new Set(currentMsgs.map(m => m.id));
            const newMsgs = freshMsgs.filter(m => !existingIds.has(m.id));
            if (newMsgs.length > 0) {
              // Добавляем недостающие сообщения
              for (const msg of newMsgs) {
                useChatStore.getState().addMessage(msg);
              }
              console.log(`📨 Synced ${newMsgs.length} missed messages after reconnect`);
            }
          }
        }).catch(() => {});
      }
    });
    // Очищаем стухшие P2P соединения — после реконнекта старые RTCPeerConnection невалидны
    try {
      const { disconnectAll, initP2PSignaling } = require('./p2p');
      disconnectAll();
      initP2PSignaling();
      console.log('🔌 P2P connections reset after socket reconnect');
    } catch (e) {
      console.warn('P2P cleanup on reconnect failed:', e);
    }
  });

  // Автореконнект при возврате на вкладку
  _setupVisibilityReconnect();

  // Сообщения
  socket.on('message:new', async (message: Message) => {
    // Автодешифровка E2EE (если сообщение зашифровано)
    if (message.metadata && (message.metadata as any).e2ee) {
      const token = useAuthStore.getState().accessToken;
      const currentUserId = useAuthStore.getState().user?.id;
      // Свои сообщения тоже расшифровываем: копия кладётся и для остальных
      // своих устройств, иначе отправленное с компьютера не прочитаешь на
      // телефоне. Для устройства-отправителя копии нет, но там и текст свой.
      if (token && currentUserId) {
        try {
          const encrypted = (message.metadata as any).e2ee as E2EEEnvelope | EncryptedMessage;
          const isOwn = message.sender_id === currentUserId;
          const plaintext = await decryptMessage(encrypted, message.sender_id, token, isOwn);
          if (plaintext) {
            message = { ...message, content: plaintext, metadata: { ...message.metadata as any, e2ee_decrypted: true } };
          }
        } catch (err) {
          console.warn('Не расшифровать сообщение', message.id, err);
        }
      }
    }

    useChatStore.getState().addMessage(message);
    // Кэшируем в IndexedDB для офлайн-доступа
    cacheSingleMessage(message).catch(() => {});
    
    const currentChat = useChatStore.getState().currentChat;
    const currentUserId = useAuthStore.getState().user?.id;
    
    // Если сообщение наше — ставим статус 'sent'
    if (message.sender_id === currentUserId && !message.status) {
      useChatStore.getState().updateMessage(message.id, { status: 'sent' });
    }
    
    // Если сообщение от другого пользователя в текущем открытом чате — сразу помечаем как прочитанное
    if (message.chat_id === currentChat?.id && message.sender_id !== currentUserId) {
      socketEmit.markAsRead(message.chat_id, message.id);
    }
    
    // Если сообщение не в текущем чате, увеличиваем счётчик непрочитанных
    if (message.chat_id !== currentChat?.id && message.sender_id !== currentUserId) {
      useChatStore.getState().incrementUnread(message.chat_id);
    }

    // PWA уведомление + звук ICQ для чужих сообщений
    if (message.sender_id !== currentUserId) {
      const senderName = (message as any).sender_name || (message as any).sender?.display_name || 'Новое сообщение';
      const text = message.type === 'text' ? (message.content || '') : `[${message.type}]`;
      // Проверяем @mention текущего юзера
      const currentUser = useAuthStore.getState().user;
      const isMentioned = currentUser?.username && text.toLowerCase().includes(`@${currentUser.username.toLowerCase()}`);
      notifyNewMessage(senderName, text, message.chat_id, undefined, message.id, !!isMentioned);
    }
  });

  socket.on('message:updated', (message: Message) => {
    useChatStore.getState().updateMessage(message.id, message);
    updateCachedMessage(message);
  });

  socket.on('message:deleted', (data: { message_id: string; chat_id: string }) => {
    useChatStore.getState().removeMessage(data.chat_id, data.message_id);
    deleteCachedMessage(data.message_id);
  });

  // Реакции
  socket.on('message:reaction' as any, (data: { message_id: string; chat_id: string; reactions: any[] }) => {
    useChatStore.getState().updateMessage(data.message_id, { reactions: data.reactions } as any);
    // Обновляем реакции в кэше тоже
    const msgs = useChatStore.getState().messages[data.chat_id];
    const msg = msgs?.find(m => m.id === data.message_id);
    if (msg) updateCachedMessage({ ...msg, reactions: data.reactions });
  });

  socket.on('message:typing_status', (data: { chat_id: string; user_id: string; typing: boolean }) => {
    useChatStore.getState().setTyping(data.chat_id, data.user_id, data.typing);
  });

  // Подтверждение прочтения — обновляем галочки на синие
  socket.on('message:read_ack' as any, (data: { chat_id: string; reader_id: string; read_at: string }) => {
    useChatStore.getState().markMessagesRead(data.chat_id, data.reader_id);
  });

  // Чаты - новый чат
  socket.on('chat:new', (chat: any) => {
    useChatStore.getState().addChat({
      ...chat,
      unreadCount: 0,
    });
  });

  // Чаты - обновление чата
  socket.on('chat:updated', (data: { id: string; [key: string]: any }) => {
    useChatStore.getState().updateChat(data.id, data);
  });

  // Чаты - удаление чата
  socket.on('chat:deleted', (data: { chat_id: string }) => {
    useChatStore.getState().removeChat(data.chat_id);
  });

  // Присутствие
  // Полный список онлайн-пользователей (при подключении)
  socket.on('users:online', (data: { user_ids: string[] }) => {
    useChatStore.getState().setOnlineUsers(data.user_ids);
  });

  socket.on('user:online', (data: { user_id: string }) => {
    useChatStore.getState().setUserOnline(data.user_id);
  });

  // Ход обработки файла ПОСЛЕ того, как долетели все куски: сборка и
  // шифрование. Без этих событий человек видел «100%» и тишину на минуты.
  socket.on('upload:stage' as any, (data: any) => {
    if (!data?.sessionId) return;
    const cb = обработчикиЭтапов.get(data.sessionId);
    if (cb) cb(data);
  });

  socket.on('user:offline', (data: { user_id: string; last_seen?: string | null }) => {
    useChatStore.getState().setUserOffline(data.user_id, data.last_seen ?? null);
  });

  socket.on('presence:changed', (data: { user_id: string; status: string }) => {
    // Можно обновить статус пользователя в чатах
  });

  // Администратор сменил нам роль.
  //
  // Роль приезжала в приложение только вместе с профилем при входе, а
  // профиль потом никто не перезапрашивал. Назначенный модератор не видел
  // свою панель, пока не выйдет и не войдёт заново — выглядело как «кнопки
  // просто нет». Теперь роль применяется на месте.
  socket.on('user:role' as any, (data: { role: string }) => {
    if (!data?.role) return;
    console.log('🛡️ Роль изменена на:', data.role);
    useAuthStore.getState().updateUser({ role: data.role } as any);
  });

  // Учётку заблокировали (админ или каталог AD — «схлопывание»): сессии на
  // сервере уже отозваны. Выходим сразу, а не когда истечёт токен доступа;
  // причину покажет экран входа.
  socket.on('account:blocked' as any, (data: { reason?: string }) => {
    console.warn('⛔ Учётка заблокирована:', data?.reason || '');
    try { sessionStorage.setItem('smess_blocked_reason', data?.reason || ''); } catch { /* */ }
    useAuthStore.getState().logout();
    window.location.href = '/login';
  });

  // Обновление профиля другого пользователя (аватар, имя) ИЛИ самого себя на другом устройстве
  socket.on('user:profile_updated' as any, (data: { user: { id: string; display_name?: string; avatar_url?: string } }) => {
    if (data.user?.id) {
      useChatStore.getState().updateMemberProfile(data.user.id, data.user);
      if (data.user.id === useAuthStore.getState().user?.id) {
        useAuthStore.getState().updateUser(data.user);
      }
    }
  });

  // Глобальная синхронизация настроек (GLOBAL SYNC).
  // Вся логика — в applyRemoteSettings: она сама отбросит эхо, которое
  // старее локального выбора. Прежняя копия здесь вызывала
  // setChatWallpaper, которого в сторе нет, и падала на середине.
  socket.on('user:settings_updated' as any, (data: { settings: any }) => {
    applyRemoteSettings(data?.settings?.settings_json);
  });

  // === Звонки ===
  socket.on('call:incoming', (call: Call) => {
    console.log('📞 [SOCKET] call:incoming RAW event received:', JSON.stringify({ id: call.id, type: call.type, caller_id: call.caller_id }));

    // Дедупликация: игнорируем повторные события для того же call_id в пределах 2 сек
    const now = Date.now();
    if (call.id === _lastIncomingCallId && (now - _lastIncomingCallTime) < 2000) {
      console.log('📞 [SOCKET] Incoming call DEDUPLICATED, skipping:', call.id);
      return;
    }
    _lastIncomingCallId = call.id;
    _lastIncomingCallTime = now;
    
    console.log('📞 [SOCKET] Incoming call passed dedup. onIncomingCall callback set:', !!onIncomingCall);

    // PWA уведомление + рингтон Skype
    const callerName = (call as any).caller_name || (call as any).caller?.display_name || 'Входящий звонок';
    notifyIncomingCall(callerName, call.type || 'audio', call.id);

    if (onIncomingCall) {
      onIncomingCall(call);
    } else {
      console.error('📞 [SOCKET] onIncomingCall is NULL! Call will be lost!');
    }
  });

  socket.on('call:answered', (data: { call_id: string; user_id: string }) => {
    console.log('Call answered by remote user:', data);
    if (onCallAnswered) {
      onCallAnswered(data);
    }
  });

  socket.on('call:rejected', (data: { call_id: string; user_id: string }) => {
    console.log('Call rejected:', data);
    if (onCallRejected) {
      onCallRejected(data);
    } else if (onCallEnded) {
      onCallEnded(data);
    }
  });

  socket.on('call:ended', (data: { call_id: string }) => {
    console.log('Call ended:', data);
    if (onCallEnded) {
      onCallEnded(data);
    }
  });

  socket.on('call:signal', (data: { call_id: string; user_id: string; signal: unknown }) => {
    console.log('Received call:signal:', data);
    window.dispatchEvent(new CustomEvent('webrtc-server-signal', { detail: data }));
  });

  socket.on('call:participant-left' as any, (data: { call_id: string; user_id: string }) => {
    console.log('📞 Participant left call:', data);
    if (onParticipantLeft) onParticipantLeft(data);
    window.dispatchEvent(new CustomEvent('webrtc-participant-left', { detail: data }));
  });

  // === Relay events — для VPN/NAT когда WebRTC P2P не удаётся ===
  socket.on('call:relay-active' as any, (data: { call_id: string; relay_by: string }) => {
    console.log('📡 [RELAY] Relay mode activated for call:', data.call_id, 'by:', data.relay_by);
    window.dispatchEvent(new CustomEvent('webrtc-relay-active', { detail: data }));
  });

  socket.on('call:relay-audio' as any, (data: { call_id: string; user_id: string; audio: string; seq: number }) => {
    // Пересылаем аудиоданные в WebRTC модуль для воспроизведения
    window.dispatchEvent(new CustomEvent('webrtc-relay-audio', { detail: data }));
  });

  socket.on('call:relay-video' as any, (data: { call_id: string; user_id: string; image: string; width?: number; height?: number; quality?: number; timestamp?: number }) => {
    // Пересылаем видеоданные в WebRTC модуль для воспроизведения
    window.dispatchEvent(new CustomEvent('webrtc-relay-video', { detail: data }));
  });

  // Переключение режима P2P/Relay
  socket.on('call:mode-switched' as any, (data: { call_id: string; mode: 'p2p' | 'relay'; switched_by: string }) => {
    console.log(`🔄 [MODE] Call ${data.call_id} switched to ${data.mode} by ${data.switched_by}`);
    window.dispatchEvent(new CustomEvent('webrtc-mode-switched', { detail: data }));
  });

  // Heartbeat ACK
  socket.on('call:heartbeat-ack' as any, (_data: { call_id: string; timestamp: number }) => {
    // Обновляем таймстамп последнего ack для детекции мёртвого соединения
    window.dispatchEvent(new CustomEvent('webrtc-heartbeat-ack'));
  });

  return socket;
}

export function getSocket(): Socket | null {
  return socket;
}

export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

// Функции для регистрации обработчиков звонков
export function setOnIncomingCall(callback: (call: Call) => void): void {
  onIncomingCall = callback;
}

export function setOnCallAnswered(callback: (data: { call_id: string; user_id: string }) => void): void {
  onCallAnswered = callback;
}

export function setOnCallEnded(callback: (data: { call_id: string }) => void): void {
  onCallEnded = callback;
}

export function setOnCallRejected(callback: (data: { call_id: string; user_id: string }) => void): void {
  onCallRejected = callback;
}

export function setOnParticipantLeft(callback: (data: { call_id: string; user_id: string }) => void): void {
  onParticipantLeft = callback;
}

export function setOnSocketReconnect(callback: () => void): void {
  onSocketReconnect = callback;
}

// Хелперы для отправки событий
export const socketEmit = {
  sendMessage: (chatId: string, content: string, type = 'text', encryptedPayload?: E2EEEnvelope | EncryptedMessage | null) => {
    if (encryptedPayload) {
      // Настоящий текст на сервер не уходит вовсе: в content идёт заглушка,
      // а в metadata.e2ee — конверт с копиями по устройствам получателя.
      socket?.emit('message:send', {
        chat_id: chatId,
        content: content,
        type,
        metadata: { e2ee: encryptedPayload },
      });
    } else {
      socket?.emit('message:send', { chat_id: chatId, content, type });
    }
  },

  startTyping: (chatId: string) => {
    socket?.emit('message:typing', { chat_id: chatId, typing: true });
  },

  stopTyping: (chatId: string) => {
    socket?.emit('message:typing', { chat_id: chatId, typing: false });
  },

  markAsRead: (chatId: string, messageId: string) => {
    socket?.emit('message:read', { chat_id: chatId, message_id: messageId });
    // REST backup — если сокет не подключён, прочтение всё равно сохранится
    import('@/lib/api').then(({ chatApi }) => {
      chatApi.markAsRead(chatId, messageId).catch(() => {});
    }).catch(() => {});
  },

  deleteMessage: (chatId: string, messageId: string, mode: 'for_me' | 'for_all'): Promise<{ success?: boolean; error?: string }> => {
    return new Promise((resolve) => {
      if (!socket) { resolve({ error: 'No socket' }); return; }
      socket.emit('message:delete', { chat_id: chatId, message_id: messageId, mode }, (response: any) => {
        resolve(response || { success: true });
      });
    });
  },

  editMessage: (chatId: string, messageId: string, content: string): Promise<{ success?: boolean; error?: string }> => {
    return new Promise((resolve) => {
      if (!socket) { resolve({ error: 'No socket' }); return; }
      socket.emit('message:edit', { chat_id: chatId, message_id: messageId, content }, (response: any) => {
        resolve(response || { success: true });
      });
    });
  },

  initiateCall: (chatId: string | null, type: 'audio' | 'video', userIds?: string[]): Promise<{ call_id?: string; error?: string; existing_call_id?: string } | null> => {
    return new Promise((resolve) => {
      if (!socket) { resolve(null); return; }
      socket.emit('call:initiate', { chat_id: chatId, type, user_ids: userIds }, (response: any) => {
        if (response?.call_id) {
          console.log('Call initiated, server returned call_id:', response.call_id);
          resolve(response);
        } else if (response?.error && response?.existing_call_id) {
          console.warn('Call initiation blocked — stale call exists:', response);
          resolve(response);
        } else {
          console.error('Call initiation failed:', response);
          resolve(null);
        }
      });
    });
  },

  answerCall: (callId: string): Promise<{ success: boolean }> => {
    return new Promise((resolve) => {
      if (!socket) { resolve({ success: false }); return; }
      socket.emit('call:answer', { call_id: callId }, (response: any) => {
        resolve(response || { success: false });
      });
    });
  },

  rejectCall: (callId: string) => {
    socket?.emit('call:reject', { call_id: callId });
  },

  endCall: (callId: string) => {
    socket?.emit('call:end', { call_id: callId });
  },

  leaveCall: (callId: string) => {
    socket?.emit('call:leave' as any, { call_id: callId });
  },

  sendSignal: (callId: string, signal: any) => {
    console.log('Sending signal:', { callId, signalType: signal?.type, hasSdp: !!signal?.sdp });
    socket?.emit('call:signal', { call_id: callId, signal });
  },

  // === Relay mode — для VPN/NAT когда P2P не удаётся ===
  requestRelay: (callId: string) => {
    console.log('📡 Requesting relay mode for call:', callId);
    socket?.emit('call:relay-request' as any, { call_id: callId });
  },

  sendRelayAudio: (callId: string, audioBase64: string, seq: number) => {
    socket?.volatile.emit('call:relay-audio' as any, { call_id: callId, audio: audioBase64, seq });
  },

  sendRelayVideo: (callId: string, imageBase64: string, width?: number, height?: number, quality?: number) => {
    socket?.volatile.emit('call:relay-video' as any, { call_id: callId, image: imageBase64, width, height, quality, timestamp: Date.now() });
  },

  switchCallMode: (callId: string, mode: 'p2p' | 'relay') => {
    console.log(`🔄 Switching call ${callId} to ${mode} mode`);
    socket?.emit('call:switch-mode' as any, { call_id: callId, mode });
  },

  sendHeartbeat: (callId: string) => {
    socket?.volatile.emit('call:heartbeat' as any, { call_id: callId });
  },

  updatePresence: (status: 'online' | 'away' | 'busy') => {
    socket?.emit('presence:update', { status });
  },
};

export default {
  initSocket,
  getSocket,
  disconnectSocket,
  isSocketConnected,
  ensureSocketConnected,
  setOnIncomingCall,
  setOnCallAnswered,
  setOnCallEnded,
  setOnCallRejected,
  setOnParticipantLeft,
  socketEmit,
};

// ─── Кто ждёт вестей об обработке своего файла ────────────────────────
export interface UploadStageEvent {
  sessionId: string;
  stage: 'assembling' | 'encrypting' | 'done' | 'failed';
  percent: number;
  doneBytes?: number;
  totalBytes?: number;
  error?: string;
}

const обработчикиЭтапов = new Map<string, (e: UploadStageEvent) => void>();

export function слушатьЭтапыЗагрузки(sessionId: string, cb: (e: UploadStageEvent) => void): () => void {
  обработчикиЭтапов.set(sessionId, cb);
  return () => обработчикиЭтапов.delete(sessionId);
}
