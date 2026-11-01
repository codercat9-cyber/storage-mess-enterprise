import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { verifyToken } from '../middleware/auth.js';
import { userService } from '../services/user.service.js';
import { messageService } from '../services/message.service.js';
import { chatService } from '../services/chat.service.js';
import { callService } from '../services/call.service.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { JWTPayload, ClientToServerEvents, ServerToClientEvents } from '../types/index.js';
import { pushNewMessage, pushIncomingCall } from '../services/push.service.js';
import { sseNotifyMessage, sseNotifyCall, sseNotifyCallEnd, hasSSEClient } from '../services/sse-notify.service.js';
import { emailBridgeService } from '../services/email-bridge.service.js';
import { trackMessageLatency } from '../services/health-checker.service.js';

interface SocketData {
  user: JWTPayload;
}

type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents, {}, SocketData>;

// Хранилище подключённых пользователей
const connectedUsers = new Map<string, Set<string>>(); // userId -> Set<socketId>
const socketToUser = new Map<string, string>(); // socketId -> userId
let io: Server<ClientToServerEvents, ServerToClientEvents, {}, SocketData> | null = null;

export function initializeSocket(httpServer: HttpServer): Server {
  io = new Server<ClientToServerEvents, ServerToClientEvents, {}, SocketData>(httpServer, {
    cors: {
      origin: config.cors.origin,
      credentials: true,
    },
    // === Мобильная сеть: толерантность к нестабильному соединению ===
    pingTimeout: 60000,       // 60с — мобильные сети могут молчать при смене базовой станции
    pingInterval: 25000,      // 25с — не слишком часто (экономим трафик), но держим NAT-маппинг живым
    maxHttpBufferSize: 2e6,   // 2MB — relay данные компактные
    // === АНТИ-ТСПУ: POLLING-ONLY ===
    // ТСПУ/DPI детектит WebSocket по "Upgrade: websocket" заголовку и шлёт RST.
    // HTTP long-polling на 443 неотличим от обычного HTTPS — ТСПУ не блокирует.
    // Отключаем WebSocket полностью чтобы ТСПУ не видел Upgrade-запросы.
    transports: ['websocket', 'polling'],
    allowUpgrades: true,
    perMessageDeflate: false, // Не сжимаем — экономим CPU
    httpCompression: false,
    // === Маскировка под обычный HTTPS-трафик ===
    path: '/api/sync/',              // Короткий путь, похож на обычный API эндпоинт
    cookie: false,
    allowEIO3: true,          // Совместимость со старыми клиентами
  });

  // Middleware для аутентификации
  io.use((socket, next) => {
    const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.split(' ')[1];

    if (!token) {
      logger.warn(`🔒 Socket auth REJECTED — no token provided (socket: ${socket.id})`);
      return next(new Error('Authentication required'));
    }

    try {
      const payload = verifyToken(token);
      if (!payload) {
        logger.warn(`🔒 Socket auth REJECTED — invalid/expired token (socket: ${socket.id}, token: ${token.substring(0, 20)}...)`);
        return next(new Error('Invalid token'));
      }

      const userId = payload.userId || (payload as any).user_id;
      if (!userId) {
        logger.warn(`🔒 Socket auth REJECTED — missing userId in token (socket: ${socket.id})`);
        return next(new Error('Invalid token format'));
      }

      const fullUser = userService.findById(userId);
      // Заблокированного не пускаем и в сокет. Токен доступа живёт 7 дней,
      // и без этой проверки заблокированный (в т. ч. «схлопнутый» каталогом)
      // переподключался бы и получал сообщения в реальном времени.
      if ((fullUser as any)?.blocked_at) {
        logger.warn(`🔒 Socket auth REJECTED — account blocked: ${payload.username}`);
        return next(new Error('Account blocked'));
      }

      logger.info(`🔒 Socket auth OK — user: ${payload.username} (${userId}), socket: ${socket.id}`);
      socket.data.user = {
        ...payload,
        userId,
        display_name: fullUser?.display_name || payload.username,
        avatar_url: fullUser?.avatar_url || '',
      } as any;
      next();
    } catch (err: any) {
      require('fs').writeFileSync(__dirname + '/../../../socket-error.txt', String(err.stack || err.message) + '\n\nToken: ' + token);
      logger.error(`Socket auth exception: ${err.message}`, err);
      next(new Error('mythos auth error'));
    }
  });

  io.on('connection', (socket: TypedSocket) => {
    const userId = socket.data.user.userId;
    const footprint = socket.handshake.auth.footprint;
    
    // Lazy load the device utils
    const { getDeviceLogString } = require('../utils/device');
    const deviceStr = getDeviceLogString(footprint);

    logger.info(`User connected: ${socket.data.user.username} (${socket.id}) - Device: ${deviceStr}`);

    // Регистрируем пользователя
    if (!connectedUsers.has(userId)) {
      connectedUsers.set(userId, new Set());
      // Пользователь только что появился онлайн
      userService.updateStatus(userId, 'online');
      socket.broadcast.emit('user:online', { user_id: userId });
    }
    connectedUsers.get(userId)!.add(socket.id);
    socketToUser.set(socket.id, userId);

    // Отправляем новому клиенту список всех онлайн-пользователей
    const onlineUserIds = Array.from(connectedUsers.keys());
    socket.emit('users:online', { user_ids: onlineUserIds });

    // Своя комната на человека — чтобы можно было адресно слать ему то,
    // что не относится ни к одному чату: например, ход обработки файла,
    // который он загружает.
    socket.join(`user:${userId}`);

    // Подключаем к комнатам чатов
    const userChats = chatService.getUserChats(userId);
    for (const chat of userChats) {
      socket.join(`chat:${chat.id}`);
    }

    // ─────────────────────────────────────────────────────────────
    //  Досылаем звонок, который уже звонит.
    //
    //  `call:incoming` отправлялся РОВНО ОДИН РАЗ — в момент, когда
    //  звонок начали. Кто в эту секунду не был подключён, не узнавал о
    //  нём никогда.
    //
    //  Ломало это ровно тот случай, ради которого кнопка в шторке и
    //  существует. Приложение закрыто, приходит push, человек жмёт
    //  «Ответить» — приложение запускается, подключается… и тишина.
    //  Сервер уже отзвонился в пустоту, а заново не скажет. Интерфейс
    //  честно ждёт входящий звонок, чтобы его принять, и не дожидается;
    //  звонящий тем временем слушает гудки до самого таймаута.
    //
    //  Теперь при подключении сразу говорим, что его ждут.
    // ─────────────────────────────────────────────────────────────
    try {
      for (const call of callService.getActiveCallsForUser(userId)) {
        if (call.caller_id === userId) continue; // сам звонит — уведомлять не о чем
        const participants = callService.getParticipants(call.id);
        const me = participants.find(p => p.user_id === userId);
        if (!me || (me.status !== 'ringing' && me.status !== 'invited')) continue;

        logger.info(`📞 [CALL:RESEND] досылаю ${userId} входящий звонок ${call.id}`);
        socket.emit('call:incoming', { ...call, participants });
      }
    } catch (error) {
      logger.error('Не смог дослать входящие звонки при подключении:', error);
    }

    // === Обработчики событий ===

    // Отправка сообщения
    socket.on('message:send', (data) => {
      const msgStart = Date.now();
      try {
        // Повтор с тем же client_id — не дубль: отдаём сохранённое только отправителю
        const cid = (data as { client_id?: unknown })?.client_id;
        if (typeof cid === 'string' && cid) {
          const existing = messageService.findByClientId(data.chat_id, userId, cid);
          if (existing) { socket.emit('message:new', existing); return; }
        }
        const message = messageService.sendMessage(data.chat_id, userId, {
          content: data.content,
          type: data.type as any || 'text',
          metadata: data.metadata,
          client_id: typeof cid === 'string' && cid ? cid : undefined,
        });

        if (message) {
          io?.to(`chat:${data.chat_id}`).emit('message:new', message);
          trackMessageLatency(Date.now() - msgStart);

          // Web Push + SSE для оффлайн-пользователей
          try {
            const chatMembers = chatService.getChatMembers(data.chat_id);
            const senderName = socket.data.user.username || 'Кто-то';
            const msgText = (message as any).content || data.content || '';

            // Парсим @mentions из текста
            const mentionMatches = msgText.match(/@([a-zA-Z0-9_]+)/g) || [];
            const mentionedUsernames = new Set(mentionMatches.map((m: string) => m.slice(1).toLowerCase()));

            logger.info(`[MSG-NOTIFY] chat=${data.chat_id} sender=${userId} members=${chatMembers.map(m => m.id).join(',')}`);
            for (const member of chatMembers) {
              if (member.id === userId) continue; // Не отправляем себе
              const memberSockets = connectedUsers.get(member.id);
              const hasSSE = hasSSEClient(member.id);
              logger.info(`[MSG-NOTIFY] member=${member.id} sockets=${memberSockets?.size || 0} sse=${hasSSE}`);

              // Push для @упомянутых — даже если онлайн
              const isMentioned = mentionedUsernames.has((member as any).username?.toLowerCase());
              if (isMentioned && (memberSockets?.size || 0) > 0) {
                const mentionText = `${senderName} упомянул(а) вас: ${msgText}`;
                pushNewMessage(member.id, senderName, mentionText, data.chat_id, userId).catch(() => {});
                if (hasSSE) {
                  const avatarUrl = (socket.data.user as any).avatar_url || '';
                  sseNotifyMessage(member.id, senderName, mentionText, data.chat_id, avatarUrl, (message as any).id, userId);
                }
              }

              if (!memberSockets || memberSockets.size === 0) {
                // Пользователь оффлайн — отправляем push + SSE
                const text = isMentioned ? `${senderName} упомянул(а) вас: ${msgText}` : msgText;
                pushNewMessage(member.id, senderName, text, data.chat_id, userId).catch(() => {});
                // SSE уведомление для Android APK (только когда нет активных сокетов,
                // иначе — дубль: юзер получит и socket event, и SSE event)
                if (hasSSE) {
                  const avatarUrl = (socket.data.user as any).avatar_url || '';
                  sseNotifyMessage(member.id, senderName, text, data.chat_id, avatarUrl, (message as any).id, userId);
                }
                // Email Bridge — email fallback для DPI-устойчивой доставки
                if (emailBridgeService.isEnabledForUser(member.id)) {
                  const chat = chatService.findById(data.chat_id);
                  const chatName = chat?.name || 'Чат';
                  emailBridgeService.queueMessage(member.id, senderName, text, data.chat_id, chatName, (message as any).id);
                }
              }
            }
          } catch (pushErr) {
            logger.error('[MSG-NOTIFY] Error:', pushErr);
          }
        }
      } catch (error) {
        logger.error('Socket message:send error:', error);
      }
    });

    // Индикатор набора
    socket.on('message:typing', (data) => {
      // Только в свои чаты: иначе посторонний «печатал» бы в чужих
      if (!data?.chat_id || !chatService.isChatMember(data.chat_id, userId)) return;
      socket.to(`chat:${data.chat_id}`).emit('message:typing_status', {
        chat_id: data.chat_id,
        user_id: userId,
        typing: data.typing,
      });
    });

    // Пометить как прочитанное
    socket.on('message:read', (data) => {
      try {
        if (!data?.chat_id || !chatService.isChatMember(data.chat_id, userId)) return;
        messageService.markAsRead(data.chat_id, userId, data.message_id);
        // Уведомляем отправителя что сообщения прочитаны
        io?.to(`chat:${data.chat_id}`).emit('message:read_ack', {
          chat_id: data.chat_id,
          reader_id: userId,
          read_at: new Date().toISOString(),
        });
      } catch (error) {
        logger.error('Socket message:read error:', error);
      }
    });

    // Удаление сообщения
    socket.on('message:delete', (data, callback) => {
      try {
        const { chat_id, message_id, mode } = data;
        
        if (mode === 'for_all') {
          const success = messageService.deleteMessage(message_id, userId);
          if (!success) {
            if (typeof callback === 'function') callback({ error: 'Cannot delete for everyone' });
            return;
          }
          // Уведомляем всех участников чата
          io?.to(`chat:${chat_id}`).emit('message:deleted', { message_id, chat_id });
        } else {
          const success = messageService.deleteMessageForMe(message_id, userId);
          if (!success) {
            if (typeof callback === 'function') callback({ error: 'Cannot delete message' });
            return;
          }
        }
        
        if (typeof callback === 'function') callback({ success: true });
      } catch (error) {
        logger.error('Socket message:delete error:', error);
        if (typeof callback === 'function') callback({ error: 'Failed to delete message' });
      }
    });

    // Редактирование сообщения
    socket.on('message:edit', (data, callback) => {
      try {
        const { chat_id, message_id, content } = data;
        const edited = messageService.editMessage(message_id, userId, content);
        if (!edited) {
          if (typeof callback === 'function') callback({ error: 'Cannot edit message' });
          return;
        }
        io?.to(`chat:${chat_id}`).emit('message:updated', edited);
        if (typeof callback === 'function') callback({ success: true });
      } catch (error) {
        logger.error('Socket message:edit error:', error);
        if (typeof callback === 'function') callback({ error: 'Failed to edit message' });
      }
    });

    // === Звонки ===

    // Инициировать звонок
    socket.on('call:initiate', (data, callback) => {
      try {
        logger.info(`📞 [CALL:INITIATE] caller=${userId}, chat_id=${data.chat_id}, type=${data.type}`);

        // Принудительно завершаем ВСЕ зависшие звонки пользователя перед новым
        // и уведомляем всех участников этих звонков
        const endedCallIds = callService.forceEndAllActiveCalls(userId);
        logger.info(`📞 [CALL:INITIATE] force-ended ${endedCallIds.length} stale calls: ${endedCallIds.join(', ')}`);
        for (const endedCallId of endedCallIds) {
          const endedParticipants = callService.getParticipants(endedCallId);
          for (const p of endedParticipants) {
            const pSockets = connectedUsers.get(p.user_id);
            if (pSockets) {
              for (const sid of pSockets) {
                logger.info(`📞 [CALL:ENDED] → user=${p.user_id} socket=${sid} call_id=${endedCallId}`);
                io?.to(sid).emit('call:ended', { call_id: endedCallId });
              }
            } else {
              logger.warn(`📞 [CALL:ENDED] user=${p.user_id} has NO connected sockets (cannot notify)`);
            }
          }
        }

        const participantIds = data.user_ids || [];
        if (data.chat_id) {
          const members = chatService.getChatMembers(data.chat_id);
          logger.info(`📞 [CALL:INITIATE] chat members: ${members.map(m => m.id).join(', ')}`);
          participantIds.push(...members.map(m => m.id).filter(id => id !== userId));
        }
        logger.info(`📞 [CALL:INITIATE] participantIds (callees): ${participantIds.join(', ')}`);

        const call = callService.initiateCall(userId, data.chat_id || null, data.type, participantIds);
        const participants = callService.getParticipants(call.id);
        const callWithParticipants = { ...call, participants };
        logger.info(`📞 [CALL:INITIATE] new call created: ${call.id}`);

        // Возвращаем call ID каллеру через acknowledgment
        if (typeof callback === 'function') {
          callback({ call_id: call.id });
        }

        // Уведомляем всех участников
        for (const participantId of participantIds) {
          const participantSockets = connectedUsers.get(participantId);
          if (participantSockets && participantSockets.size > 0) {
            for (const socketId of participantSockets) {
              logger.info(`📞 [CALL:INCOMING] → user=${participantId} socket=${socketId} call_id=${call.id}`);
              io?.to(socketId).emit('call:incoming', callWithParticipants);
            }
          } else {
            logger.warn(`📞 [CALL:INCOMING] user=${participantId} has NO connected sockets! Sending push...`);
            // Web Push для оффлайн-участника
            const callerName = socket.data.user.username || 'Кто-то';
            pushIncomingCall(participantId, callerName, data.type || 'audio', call.id).catch(() => {});
            // SSE уведомление для Android APK (только когда нет активных сокетов —
            // иначе дубль: юзер получит и socket call:incoming, и SSE incoming_call)
            if (hasSSEClient(participantId)) {
              const avatarUrl = (socket.data.user as any).avatar_url || '';
              sseNotifyCall(participantId, callerName, data.type || 'audio', call.id, avatarUrl, call.chat_id || '');
            }
          }
        }
      } catch (error) {
        logger.error('Socket call:initiate error:', error);
        if (typeof callback === 'function') {
          callback({ error: 'Failed to initiate call' });
        }
      }
    });

    // Ответить на звонок
    socket.on('call:answer', (data, callback) => {
      try {
        const success = callService.answerCall(data.call_id, userId);

        // Уведомляем callee об успехе/неуспехе через ack
        if (typeof callback === 'function') {
          callback({ success });
        }

        if (success) {
          const call = callService.findById(data.call_id);
          if (call) {
            const participants = callService.getParticipants(data.call_id);
            for (const participant of participants) {
              if (participant.user_id !== userId) {
                const sockets = connectedUsers.get(participant.user_id);
                if (sockets) {
                  for (const socketId of sockets) {
                    io?.to(socketId).emit('call:answered', { call_id: data.call_id, user_id: userId });
                  }
                }
              }
            }
          }
        } else {
          logger.warn(`call:answer failed for call ${data.call_id} by user ${userId} (call may have ended)`);
        }
      } catch (error) {
        logger.error('Socket call:answer error:', error);
        if (typeof callback === 'function') {
          callback({ success: false });
        }
      }
    });

    // Отклонить звонок
    socket.on('call:reject', (data) => {
      try {
        callService.rejectCall(data.call_id, userId);
        const call = callService.findById(data.call_id);
        if (call) {
          const participants = callService.getParticipants(data.call_id);
          for (const participant of participants) {
            if (participant.user_id !== userId) {
              const sockets = connectedUsers.get(participant.user_id);
              if (sockets) {
                for (const socketId of sockets) {
                  io?.to(socketId).emit('call:rejected', { call_id: data.call_id, user_id: userId });
                }
              }
            }
          }
        }
      } catch (error) {
        logger.error('Socket call:reject error:', error);
      }
    });

    // Завершить звонок (кнопка "отбой")
    socket.on('call:end', (data) => {
      try {
        const call = callService.findById(data.call_id);
        if (call) {
          const participants = callService.getParticipants(data.call_id);
          const activeParticipants = participants.filter(p => p.status !== 'left');
          
          // Если это групповой звонок (> 2 человек) или в звонке ещё кто-то есть
          if (participants.length > 2 || activeParticipants.length > 1) {
            // Просто выходим из звонка, не завершая его для остальных
            callService.leaveCall(data.call_id, userId);
            
            // Уведомляем остальных, что мы ушли
            for (const participant of participants) {
              if (participant.user_id !== userId && participant.status !== 'left') {
                const sockets = connectedUsers.get(participant.user_id);
                if (sockets) {
                  for (const socketId of sockets) {
                    io?.to(socketId).emit('call:participant-left' as any, {
                      call_id: data.call_id,
                      user_id: userId,
                    });
                  }
                }
              }
            }
          } else {
            // Если это звонок 1-на-1 или мы последние - завершаем полностью
            callService.endCall(data.call_id, userId);
            for (const participant of participants) {
              const sockets = connectedUsers.get(participant.user_id);
              if (sockets) {
                for (const socketId of sockets) {
                  io?.to(socketId).emit('call:ended', { call_id: data.call_id });
                }
              }
              if (hasSSEClient(participant.user_id)) {
                sseNotifyCallEnd(participant.user_id, data.call_id);
              }
            }
          }
        }
      } catch (error) {
        logger.error('Socket call:end error:', error);
      }
    });

    // WebRTC сигнализация — с именами и аватарками
    socket.on('call:signal', (data: { call_id: string; signal: any }) => {
      try {
        if (!data || !data.call_id || !data.signal) return;
        const targetUserId = data.signal?.target_user_id;
        const call = callService.findById(data.call_id);
        
        if (call) {
          const signalPayload = {
            call_id: data.call_id,
            user_id: userId,
            username: socket.data.user.username,
            avatar_url: (socket.data.user as any).avatar_url || '',
            signal: data.signal,
          };

          if (targetUserId) {
            const sockets = connectedUsers.get(targetUserId);
            if (sockets) {
              for (const socketId of sockets) {
                io?.to(socketId).emit('call:signal', signalPayload);
              }
            }
          } else {
            const participants = callService.getParticipants(data.call_id);
            for (const participant of participants) {
              if (participant.user_id !== userId && participant.status !== 'left') {
                const sockets = connectedUsers.get(participant.user_id);
                if (sockets) {
                  for (const socketId of sockets) {
                    io?.to(socketId).emit('call:signal', signalPayload);
                  }
                }
              }
            }
          }
        }
      } catch (error) {
        logger.error('Socket call:signal error:', error);
      }
    });

    // Покинуть групповой звонок (без завершения для остальных)
    socket.on('call:leave', (data: { call_id: string }) => {
      try {
        const call = callService.findById(data.call_id);
        if (call) {
          callService.leaveCall(data.call_id, userId);
          const participants = callService.getParticipants(data.call_id);
          // Уведомляем остальных
          for (const participant of participants) {
            if (participant.user_id !== userId && participant.status !== 'left') {
              const sockets = connectedUsers.get(participant.user_id);
              if (sockets) {
                for (const socketId of sockets) {
                  io?.to(socketId).emit('call:participant-left', {
                    call_id: data.call_id,
                    user_id: userId,
                  });
                }
              }
            }
          }
          // Если остался только 1 участник — завершаем звонок
          const active = participants.filter(p => p.status !== 'left');
          if (active.length <= 1) {
            callService.endCall(data.call_id, userId);
            for (const p of active) {
              const sockets = connectedUsers.get(p.user_id);
              if (sockets) {
                for (const sid of sockets) {
                  io?.to(sid).emit('call:ended', { call_id: data.call_id });
                }
              }
            }
          }
        }
      } catch (error) {
        logger.error('Socket call:leave error:', error);
      }
    });

    // Обновление статуса присутствия
    socket.on('presence:update', (data) => {
      try {
        const status = data.status as 'online' | 'away' | 'busy';
        userService.updateStatus(userId, status);
        socket.broadcast.emit('presence:changed', { user_id: userId, status });
      } catch (error) {
        logger.error('Socket presence:update error:', error);
      }
    });

    // === P2P Data Channel сигнализация (вдохновлено Mimir) ===
    // Пересылаем P2P сигналы между пирами для установки WebRTC DataChannel.
    // Аналог Mimir Resolver — помогает пирам найти друг друга.
    socket.on('p2p:signal', (data: { peer_id: string; signal: any }) => {
      try {
        const peerId = data.peer_id;
        if (!peerId || !data.signal) return;

        const peerSockets = connectedUsers.get(peerId);
        if (peerSockets) {
          for (const socketId of peerSockets) {
            io?.to(socketId).emit('p2p:signal', {
              peer_id: userId,
              signal: data.signal,
            });
          }
        }
      } catch (error) {
        logger.error('Socket p2p:signal error:', error);
      }
    });

    // === Audio/Video Relay — серверный ретранслятор для VPN/NAT ===
    // Когда WebRTC P2P не удаётся (VPN, symmetric NAT, firewall),
    // клиенты переходят в relay-режим: медиаданные идут через сервер.
    //
    // Клиент отправляет: { call_id, audio: base64, seq: number }
    // Сервер пересылает всем участникам звонка (кроме отправителя).

    // Запрос на relay-режим (когда WebRTC P2P не удался)
    socket.on('call:relay-request', (data: { call_id: string }) => {
      try {
        const call = callService.findById(data.call_id);
        if (!call) return;

        logger.info(`📡 [RELAY] User ${userId} requesting relay mode for call ${data.call_id}`);

        // Уведомляем всех участников (кроме отправителя) что звонок переходит в relay-режим
        const participants = callService.getParticipants(data.call_id);
        for (const participant of participants) {
          const sockets = connectedUsers.get(participant.user_id);
          if (sockets) {
            for (const sid of sockets) {
              if (sid === socket.id) continue; // Не отправляем эхо назад отправителю
              io?.to(sid).emit('call:relay-active', {
                call_id: data.call_id,
                relay_by: userId,
              });
            }
          }
        }
      } catch (error) {
        logger.error('Socket call:relay-request error:', error);
      }
    });

    // Переключение P2P ↔ Relay по запросу пользователя
    socket.on('call:switch-mode', (data: { call_id: string; mode: 'p2p' | 'relay' }) => {
      try {
        const call = callService.findById(data.call_id);
        if (!call) return;

        logger.info(`🔄 [SWITCH] User ${userId} switching to ${data.mode} for call ${data.call_id}`);

        const participants = callService.getParticipants(data.call_id);
        for (const participant of participants) {
          const sockets = connectedUsers.get(participant.user_id);
          if (sockets) {
            for (const sid of sockets) {
              if (sid === socket.id) continue; // Не отправляем эхо назад отправителю
              io?.to(sid).emit('call:mode-switched', {
                call_id: data.call_id,
                mode: data.mode,
                switched_by: userId,
              });
            }
          }
        }
      } catch (error) {
        logger.error('Socket call:switch-mode error:', error);
      }
    });

    // Аудио-данные через relay — с метаданными
    socket.on('call:relay-audio', (data: { call_id: string; audio: string; seq: number }) => {
      try {
        const call = callService.findById(data.call_id);
        if (!call || call.status === 'ended') return;

        const payload = {
          call_id: data.call_id,
          user_id: userId,
          username: socket.data.user.username,
          avatar_url: (socket.data.user as any).avatar_url || '',
          audio: data.audio,
          seq: data.seq,
        };

        const participants = callService.getParticipants(data.call_id);
        for (const participant of participants) {
          if (participant.user_id !== userId && participant.status !== 'left') {
            const sockets = connectedUsers.get(participant.user_id);
            if (sockets) {
              for (const sid of sockets) {
                // АУДИО: Убираем volatile! Голос весит мало, но если пакеты теряются, 
                // возникают "роботизированные" помехи и заикания.
                // compress(false): аудио уже сжато (Opus/WebM/base64), не тратим CPU сервера
                io?.to(sid).compress(false).emit('call:relay-audio', payload);
              }
            }
          }
        }
      } catch (error) {}
    });

    // Видео-данные через relay — с метаданными
    socket.on('call:relay-video', (data: { call_id: string; image: string; width?: number; height?: number; quality?: number; timestamp?: number }) => {
      try {
        const call = callService.findById(data.call_id);
        if (!call || call.status === 'ended') return;

        const payload = {
          call_id: data.call_id,
          user_id: userId,
          username: socket.data.user.username,
          avatar_url: (socket.data.user as any).avatar_url || '',
          image: data.image,
          width: data.width,
          height: data.height,
          quality: data.quality,
          timestamp: data.timestamp || Date.now(),
        };

        const participants = callService.getParticipants(data.call_id);
        for (const participant of participants) {
          if (participant.user_id !== userId && participant.status !== 'left') {
            const sockets = connectedUsers.get(participant.user_id);
            if (sockets) {
              for (const sid of sockets) {
                // ВИДЕО: Оставляем volatile! Кадры тяжелые. Если инет плохой, 
                // лучше пропустить кадр, чем забить буфер сети и вызвать дисконнект.
                io?.to(sid).volatile.compress(false).emit('call:relay-video', payload);
              }
            }
          }
        }
      } catch (error) {}
    });

    // Heartbeat для поддержания relay-соединения
    socket.on('call:heartbeat', (data: { call_id: string }) => {
      try {
        const call = callService.findById(data.call_id);
        if (!call) return;
        // Просто подтверждаем что пользователь ещё в звонке
        socket.emit('call:heartbeat-ack', { call_id: data.call_id, timestamp: Date.now() });
      } catch (error) {
        // Heartbeat ошибки не критичны
      }
    });

    // Отключение — с защитой от падения
    // Grace period: если пользователь вернётся в течение 90с — звонок сохраняется
    socket.on('disconnect', () => {
      try {
        logger.info(`User disconnected: ${socket.data.user.username} (${socket.id})`);

        socketToUser.delete(socket.id);
        const userSockets = connectedUsers.get(userId);
        
        if (userSockets) {
          userSockets.delete(socket.id);
          
          // Если больше нет подключений, пользователь оффлайн
          if (userSockets.size === 0) {
            connectedUsers.delete(userId);
            // Время ухода рассылаем вместе с событием.
            //
            // Раньше здесь уходил один лишь идентификатор. Собеседник
            // помечал человека вышедшим, а «был(а) N назад» показывал
            // старое время — то, что пришло при открытии переписки. Со
            // стороны это выглядело так, будто человек вышел несколько
            // часов назад, хотя он закрыл приложение только что.
            const lastSeen = userService.updateStatus(userId, 'offline');
            socket.broadcast.emit('user:offline', { user_id: userId, last_seen: lastSeen });
            
            // Сколько ждать возвращения, прежде чем считать человека
            // выпавшим из звонка.
            //
            // Было 90 секунд, и это оказалось мало. Сокет — это только
            // сигнализация: по нему договариваются о звонке, а сам голос
            // после этого идёт напрямую между людьми и через сокет не
            // проходит. То есть связь между собеседниками могла быть
            // прекрасной, а сервер всё равно объявлял звонок законченным
            // — просто потому, что у одного из них на полторы минуты
            // моргнула сигнализация: свернул приложение, ушёл в игру,
            // телефон приглушил фоновую работу, сменилась сеть.
            //
            // Правило теперь простое: звонок заканчивается тогда, когда
            // его КЛАДУТ. Ждём десять минут вместо полутора.
            const CALL_GRACE_PERIOD_MS = 10 * 60 * 1000;
            setTimeout(() => {
              // Проверяем: пользователь не вернулся?
              if (!connectedUsers.has(userId)) {
                // Всё ещё оффлайн — уведомляем участников и завершаем звонки
                try {
                  const activeCalls = callService.getActiveCallsForUser(userId);
                  for (const call of activeCalls) {
                    logger.info(`📞 [DISCONNECT] Grace period expired for ${userId}, notifying participants of call ${call.id}`);
                    // Уведомляем участников что пользователь покинул звонок
                    const participants = callService.getParticipants(call.id);
                    for (const p of participants) {
                      if (p.user_id !== userId && p.status !== 'left') {
                        const sockets = connectedUsers.get(p.user_id);
                        if (sockets) {
                          for (const sid of sockets) {
                            io?.to(sid).emit('call:participant-left' as any, {
                              call_id: call.id,
                              user_id: userId,
                            });
                          }
                        }
                      }
                    }
                    // Помечаем участника как покинувшего
                    callService.leaveCall(call.id, userId);

                    // Звонок закрываем, только если закрывать больше не
                    // для кого.
                    //
                    // Раньше здесь стояло «остался один — завершаем», и
                    // это забирало у второго человека его же разговор.
                    // Он никуда не уходил, трубку не клал, у него всё
                    // работало — а звонок ему обрывали за компанию.
                    // Теперь решает он сам: захочет — положит трубку,
                    // захочет — подождёт, пока первый вернётся.
                    const remaining = participants.filter(p => p.user_id !== userId && p.status !== 'left');
                    const stillOnline = remaining.filter(p => connectedUsers.has(p.user_id));

                    if (stillOnline.length === 0) {
                      callService.endCall(call.id, userId);
                      for (const p of remaining) {
                        const sockets = connectedUsers.get(p.user_id);
                        if (sockets) {
                          for (const sid of sockets) {
                            io?.to(sid).emit('call:ended', { call_id: call.id });
                          }
                        }
                      }
                    } else {
                      logger.info(`📞 [DISCONNECT] ${userId} пропал, но в звонке ${call.id} `
                        + `остаётся ${stillOnline.length} — звонок не трогаю`);
                    }
                  }
                } catch (cleanupErr) {
                  logger.error('Call cleanup after disconnect failed:', cleanupErr);
                }
              } else {
                logger.info(`📞 [DISCONNECT] ${userId} reconnected within grace period — keeping calls`);
              }
            }, CALL_GRACE_PERIOD_MS);
          }
        }
      } catch (error) {
        logger.error('Socket disconnect handler error:', error);
      }
    });
  });

  logger.info('Socket.io initialized');
  return io;
}

// Получить экземпляр io для использования в роутах
export function getIo(): Server<ClientToServerEvents, ServerToClientEvents, {}, SocketData> | null {
  return io;
}

// Утилиты для отправки событий извне
export function emitToUser(io: Server, userId: string, event: string, data: unknown): void {
  const sockets = connectedUsers.get(userId);
  if (sockets) {
    for (const socketId of sockets) {
      io.to(socketId).emit(event as any, data);
    }
  }
}

/**
 * Разорвать все сокеты пользователя — с задержкой, чтобы успело уйти
 * событие, отправленное перед этим (например, account:blocked).
 */
export function disconnectUser(userId: string, delayMs = 500): void {
  const sockets = connectedUsers.get(userId);
  if (!io || !sockets || sockets.size === 0) return;
  const ids = Array.from(sockets);
  const server = io;
  setTimeout(() => {
    for (const socketId of ids) {
      try { server.in(socketId).disconnectSockets(true); } catch { /* уже отключён */ }
    }
  }, delayMs);
}

export function emitToChat(io: Server, chatId: string, event: string, data: unknown): void {
  io.to(`chat:${chatId}`).emit(event as any, data);
}

/** Кто сейчас подключён: пользователь и сколько у него сокетов. */
export function getConnectedSessions(): Array<{ userId: string; sockets: number }> {
  return Array.from(connectedUsers.entries())
    .map(([userId, set]) => ({ userId, sockets: set.size }));
}

/**
 * Разослать событие всем участникам звонка, кроме одного.
 *
 * Нужно там, где события приходят НЕ по сокету: кнопки «Ответить» и
 * «Отклонить» в шторке Android обрабатывает отдельный процесс, у него
 * сокета нет. Раньше отказ из шторки до звонящего не доходил вовсе, и
 * тот слушал гудки до самого таймаута.
 */
export function notifyCallParticipants(
  callId: string,
  exceptUserId: string,
  event: string,
  data: unknown,
): void {
  if (!io) return;
  try {
    for (const participant of callService.getParticipants(callId)) {
      if (participant.user_id === exceptUserId) continue;
      const sockets = connectedUsers.get(participant.user_id);
      if (!sockets) continue;
      for (const socketId of sockets) {
        io.to(socketId).emit(event as any, data);
      }
    }
  } catch (error) {
    logger.error('Не смог разослать событие звонка:', error);
  }
}

export function isUserOnline(userId: string): boolean {
  return connectedUsers.has(userId);
}

export function getOnlineUsers(): string[] {
  return Array.from(connectedUsers.keys());
}

export default initializeSocket;
