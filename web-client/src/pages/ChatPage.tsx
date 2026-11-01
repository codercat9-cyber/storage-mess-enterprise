import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { useAuthStore } from '@/store/auth';
import { useChatStore } from '@/store/chat';
import { decryptMessages } from '@/lib/e2ee';
import { useContactOverrides } from '@/store/contactOverrides';
import { chatApi } from '@/lib/api';
import { cacheChats, getCachedChats, cacheMessages, getCachedMessages, cacheSingleMessage } from '@/lib/offline-cache';
import { initSocket, setOnIncomingCall, setOnCallAnswered, setOnCallEnded, setOnCallRejected, setOnSocketReconnect, socketEmit, ensureSocketConnected, isSocketConnected } from '@/lib/socket';
import { stopRingtone, dismissCallNotification } from '@/lib/notifications';
import { registerAudioElement, unregisterAudioElement, resetAudioOutput } from '@/lib/audioOutput';
import { getApiUrl } from '@/lib/connection';
import {
  fetchIceServers,
  initLocalStream,
  setOnRemoteStream,
  setOnRemoteStreamMulti,
  setOnConnectionState,
  setOnRelayMode,
  setOnParticipantLeft,
  isInRelayMode,
  setGlobalRelayMode,
  startCall,
  answerCall,
  handleOffer,
  handleAnswer,
  handleIceCandidate,
  endCall as endWebRTCCall,
  getCurrentCallId,
  getLocalStream,
  startP2PConnectionTimer,
  setupCallStability,
  startCallKeepalive,
  onHeartbeatAck,
  setCurrentCallId,
  removePeer,
  resumeAllAudioContexts,
  getPeers,
  deactivateRelayMode,
  forceActivateRelayMode,
  toggleVideoTrack,
} from '@/lib/webrtc';
import Sidebar from '@/components/Sidebar';
import ChatArea from '@/components/ChatArea';
import GroupCallPanel from '@/components/GroupCallPanel';
import GroupCallSetup from '@/components/GroupCallSetup';
import StoragePanel from '@/components/StoragePanel';
import { Loader2, Phone, PhoneOff } from 'lucide-react';
import { Call, Message } from '@/types';
import { prefetchRecentMessages } from '@/lib/prefetch';

// =====================================================================
// ChatPage — главная страница чата с поддержкой голосовой/видеосвязи
//
// Правильный flow звонков (согласно Readme.md):
//
// CALLER:
//   1. initiateCall → сервер возвращает call_id
//   2. Сервер шлёт call:incoming callee
//   3. Caller ЖДЁТ (isCalling=true, offer ещё НЕ создан)
//   4. Получает call:answered → ТЕПЕРЬ создаёт offer → отправляет
//   5. Получает answer → setRemoteDescription → P2P установлен
//
// CALLEE:
//   1. Получает call:incoming → показывает UI
//   2. Нажимает Accept → шлёт call:answer серверу, готовит микрофон
//   3. Получает offer от caller → handleOffer → создаёт answer → отправляет
//   4. P2P установлен
// =====================================================================

export default function ChatPage() {
  const { chatId } = useParams();
  const user = useAuthStore((state) => state.user);
  const { chats, setChats, setCurrentChat, currentChat, setMessages, setHasMoreMessages } = useChatStore();
  const [loading, setLoading] = useState(true);

  // Состояние звонка
  const [incomingCall, setIncomingCall] = useState<Call | null>(null);
  const [inCall, setInCall] = useState(false);
  const [callType, setCallType] = useState<'audio' | 'video'>('audio');
  const [isCalling, setIsCalling] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [connectionState, setConnectionState] = useState<string>('');
  const [isRelay, setIsRelay] = useState(false);
  // Групповой звонок: remote streams по userId
  const [remoteParticipants, setRemoteParticipants] = useState<Map<string, { stream: MediaStream | null; displayName?: string; relayImage?: string | null }>>(new Map());
  // Legacy single remote stream (for audio element)
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  // Ref для отслеживания: callee нажал Accept и ждёт offer
  const isWaitingForOfferRef = useRef(false);
  const [isWaitingForOffer, setIsWaitingForOffer] = useState(false);

  // Ref для хранения call_id при исходящем звонке (caller ждёт call:answered)
  const pendingCallIdRef = useRef<string | null>(null);
  const callTypeRef = useRef<'audio' | 'video'>('audio');

  /**
   * Чьё имя показать в панели звонка в шторке Android.
   *
   * Берём ту же подпись, что человек видит в списке чатов: если он
   * переименовал контакт у себя, в шторке должно быть его имя, а не
   * системный логин. Функция, а не значение: вызывается в момент
   * начала разговора, когда чат уже точно выбран.
   */
  const callPeerName = useCallback((): string => {
    const chat = useChatStore.getState().currentChat;
    if (!chat) return 'Собеседник';
    if (chat.type === 'group' || chat.type === 'channel') return chat.name || 'Группа';
    const other = chat.members?.find(m => m.id !== useAuthStore.getState().user?.id);
    if (!other) return 'Собеседник';
    return useContactOverrides.getState().map[other.id]?.nick
      || other.display_name || other.username || 'Собеседник';
  }, []);

  // Ref-based guard: предотвращает повторные вызовы initiateCall до обновления React state
  const isCallingRef = useRef(false);
  // Ref-based guard: уже в звонке или обрабатываем входящий
  const inCallRef = useRef(false);
  // Ref для хранения call_id входящего звонка (для проверки call:ended)
  const incomingCallIdRef = useRef<string | null>(null);
  // Ref для pending native accept — когда нажали "Ответить" в push-уведомлении,
  // но incomingCall state ещё не пришёл из Socket.IO
  const pendingNativeAcceptRef = useRef<string | null>(null);

  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const [showGroupCallSetup, setShowGroupCallSetup] = useState(false);
  const [showStorage, setShowStorage] = useState(false);

  // Инициализация позиции окна звонка (unused — GroupCallPanel manages its own position)
  useEffect(() => {
    if (!inCall) {
      // cleanup
    }
  }, [inCall]);

  // =============================================================
  // Инициализация: socket, ICE серверы, обработчики
  // =============================================================
  useEffect(() => {
    initSocket();
    fetchIceServers();
    setupCallStability();

    // Callback: получен удалённый поток (LEGACY — для audio fallback)
    setOnRemoteStream((stream) => {
      console.log('🔊 Remote stream (legacy):', stream.id);
      setRemoteStream(stream);
    });

    // Callback: multi-stream для групповых звонков
    setOnRemoteStreamMulti((userId, stream: MediaStream | null) => {
      // Пытаемся взять актуальный relayImage из webrtc модуля
      const peers = getPeers() as any;
      const peerData = peers.get(userId);
      const relayImage = peerData?.relayImage;

      if (relayImage || stream) {
        setRemoteParticipants(prev => {
          const next = new Map(prev);
          const existing = next.get(userId);
          // Всегда обновляем — stream может быть новый объект с изменённым набором треков
          next.set(userId, { stream, relayImage, displayName: existing?.displayName });
          return next;
        });
      }
    });

    // Callback: состояние P2P соединения
    setOnConnectionState((state, userId) => {
      setConnectionState(state);
    });

    // Callback: relay mode
    setOnRelayMode((active) => {
      setIsRelay(active);
    });

    // Callback: участник покинул звонок
    setOnParticipantLeft((userId) => {
      console.log('📞 Participant left (webrtc):', userId);
      setRemoteParticipants(prev => {
        const next = new Map(prev);
        next.delete(userId);
        return next;
      });
      removePeer(userId);
    });

    // === Входящий звонок (callee) ===
    setOnIncomingCall((call) => {
      console.log('📞 [CHATPAGE] onIncomingCall fired! call_id:', call.id, 'type:', call.type, 'caller:', call.caller_id);

      // Игнорируем входящий звонок если мы уже в звонке, звоним сами или ожидаем offer
      if (isCallingRef.current || inCallRef.current || isWaitingForOfferRef.current) {
        console.log('⚠ [CHATPAGE] Ignoring incoming call — already busy.');
        return;
      }

      setIncomingCall(call);
      incomingCallIdRef.current = call.id;
      setCallType(call.type);
      callTypeRef.current = call.type;
      
      // Инициализируем состояние видео: если звонок аудио — видео выключено
      setIsVideoOff(call.type === 'audio');
    });

    // === Callee принял звонок (для caller) ===
    setOnCallAnswered(async (data) => {
      const callId = data.call_id;
      const answeredUserId = data.user_id;
      console.log('✅ Call answered by:', answeredUserId, 'call_id:', callId);

      if (pendingCallIdRef.current !== callId) return;

      const isVideo = callTypeRef.current === 'video';
      const offer = await startCall(callId, isVideo, answeredUserId);

      // Если вернулся offer или мы принудительно ушли в Relay Mode
      if (offer || isInRelayMode()) {
        setInCall(true);
        inCallRef.current = true;
        setIsCalling(false);
        isCallingRef.current = false;
        // Синхронизируем состояние видео
        setIsVideoOff(!isVideo);
        startP2PConnectionTimer(callId);
        startCallKeepalive({ callId, chatId: currentChat?.id, peerName: callPeerName(), callType });
      }
    });

    // === Реконнект сокета во время звонка — ICE restart для несвязанных peer ===
    setOnSocketReconnect(() => {
      const callId = getCurrentCallId();
      if (!callId || !inCallRef.current) return;
      console.log('[RECONNECT] Socket reconnected during call, checking peers...');
      // Небольшая задержка — дать серверу зарегистрировать reconnect
      setTimeout(() => {
        for (const [userId, peer] of getPeers()) {
          const state = (peer as any).connection?.connectionState;
          if (state && state !== 'connected' && state !== 'connecting') {
            console.log(`[RECONNECT] Peer ${userId} state=${state} — ICE restart`);
            (async () => {
              try {
                const offer = await (peer as any).connection.createOffer({ iceRestart: true });
                await (peer as any).connection.setLocalDescription(offer);
                socketEmit.sendSignal(callId, {
                  type: 'offer',
                  sdp: offer,
                  target_user_id: userId,
                });
              } catch (err) {
                console.error('[RECONNECT] ICE restart failed for', userId, err);
              }
            })();
          }
        }
      }, 1000);
    });

    // === Звонок завершён ===
    // ВАЖНО: проверяем call_id перед сбросом, иначе call:ended для
    // старых/зависших звонков убьёт текущий активный звонок.
    setOnCallEnded((data) => {
      const endedCallId = data.call_id;
      const currentCallId = pendingCallIdRef.current || getCurrentCallId();
      const incomingId = incomingCallIdRef.current;

      // Гарантированно останавливаем рингтон и убираем уведомления при ЛЮБОМ call:ended,
      // чтобы избежать "зависшего" звука если call_id не совпал из-за race condition.
      stopRingtone();
      dismissCallNotification(endedCallId || incomingId || undefined);

      // Race condition: мы инициируем звонок (isCallingRef=true) но ещё не получили
      // call_id (pendingCallIdRef=null). Все call:ended в этот момент — для старых звонков,
      // которые сервер принудительно завершает в forceEndAllActiveCalls().
      if (isCallingRef.current && !pendingCallIdRef.current && !inCallRef.current) {
        console.log('📴 Ignoring call:ended during call initiation (race). Stale call:', endedCallId);
        return;
      }

      // Определяем «наш» call_id — это может быть pending, active или incoming
      const ourCallId = currentCallId || incomingId;

      // Если есть активный/incoming звонок и ended — другой → stale, игнорируем
      if (endedCallId && ourCallId && endedCallId !== ourCallId) {
        console.log('📴 Ignoring call:ended for stale call:', endedCallId, '(ours:', ourCallId, ')');
        return;
      }

      // Нет никакого активного состояния → stale, игнорируем
      if (!ourCallId && !inCallRef.current && !isCallingRef.current) {
        console.log('📴 Ignoring call:ended — no active call state. Stale call:', endedCallId);
        return;
      }

      console.log('📴 Call ended:', endedCallId);
      resetCallState();
    });

    // === Звонок отклонён ===
    setOnCallRejected((data) => {
      const rejectedCallId = data.call_id;
      const currentCallId = pendingCallIdRef.current || getCurrentCallId();

      // Гарантированно стопаем звук
      stopRingtone();
      dismissCallNotification(rejectedCallId || incomingCallIdRef.current || undefined);

      if (rejectedCallId && currentCallId && rejectedCallId !== currentCallId) {
        console.log('📴 Ignoring call:rejected for stale call:', rejectedCallId);
        return;
      }

      console.log('📴 Call rejected:', rejectedCallId);
      resetCallState();
    });

    // === Обработка WebRTC сигналов от сервера (с маршрутизацией по user_id) ===
    const handleServerSignal = async (event: Event) => {
      try {
        const customEvent = event as CustomEvent;
        const data = customEvent.detail;
        const callId = data.call_id;
        const signal = data.signal;
        const fromUserId = data.user_id; // mesh: кто отправил сигнал

        if (!callId || !signal) return;

        console.log('📡 Server signal:', { callId, type: signal?.type, from: fromUserId });

        // ICE кандидат — маршрутизируем по user_id
        if (signal.type === 'ice' && signal.candidate) {
          await handleIceCandidate(signal.candidate, fromUserId).catch(err => 
            console.warn('[ICE] Error handling candidate:', err));
          return;
        }
        if (signal.iceCandidate) {
          await handleIceCandidate(signal.iceCandidate, fromUserId).catch(err =>
            console.warn('[ICE] Error handling candidate:', err));
          return;
        }

        // OFFER (callee получает от caller или другого peer)
        if (signal.type === 'offer' && signal.sdp) {
          console.log('📥 OFFER from', fromUserId, 'for call:', callId);
          try {
            const success = await handleOffer(signal, callId, fromUserId); // Передаём весь signal для E2E ключа
            if (!success) return;

            const answer = await answerCall(callId, callTypeRef.current === 'video', fromUserId);
            if (answer) {
              startP2PConnectionTimer(callId);
              if (isWaitingForOfferRef.current) {
                setInCall(true);
                inCallRef.current = true;
                setIncomingCall(null);
                setIsWaitingForOffer(false);
                isWaitingForOfferRef.current = false;
                startCallKeepalive({ callId, chatId: currentChat?.id, peerName: callPeerName(), callType: callTypeRef.current });
              }
            }
          } catch (err) {
            console.error('Error handling offer:', err);
          }
          return;
        }

        // ANSWER (caller получает от callee)
        if (signal.type === 'answer' && signal.sdp) {
          console.log('📥 ANSWER from', fromUserId);
          await handleAnswer(signal, fromUserId).catch(err => // Передаём весь signal для E2E ключа
            console.error('[ANSWER] Error handling answer:', err));
          return;
        }
      } catch (err) {
        // Защита от падения всего обработчика сигналов
        console.error('[SIGNAL] Critical error in signal handler:', err);
      }
    };

    // Участник покинул звонок (сервер event)
    const handleParticipantLeft = (event: Event) => {
      const data = (event as CustomEvent).detail;
      console.log('📞 Participant left (server):', data.user_id);
      setRemoteParticipants(prev => {
        const next = new Map(prev);
        next.delete(data.user_id);
        return next;
      });
      removePeer(data.user_id);
    };

    // Обработка переключения P2P ↔ Relay от другого участника
    // Обработка переключения P2P ↔ Relay от другого участника
    const handleModeSwitched = (event: Event) => {
      try {
        const data = (event as CustomEvent).detail;
        // Игнорируем эхо своих собственных переключений
        if (data.switched_by === user?.id) return;
        console.log('🔄 Mode switched to', data.mode, 'by', data.switched_by);
        if (data.mode === 'relay') {
          forceActivateRelayMode();
        } else if (data.mode === 'p2p') {
          // НЕ инициатор: просто выходим из relay и ждём P2P offers
          deactivateRelayMode(false);
        }
      } catch (err) {
        console.error('Error handling mode switch:', err);
      }
    };

    // Обработка relay-active — когда другой участник запросил relay
    // КРИТИЧНО: без этого второй клиент не переключается на relay
    const handleRelayActive = (event: Event) => {
      try {
        const data = (event as CustomEvent).detail;
        
        // ВАЖНО: Если мы ждали offer, а прилетел relay, мы всё равно входим в звонок (для Callee)
        if (isWaitingForOfferRef.current) {
           setInCall(true);
           inCallRef.current = true;
           setIncomingCall(null);
           setIsWaitingForOffer(false);
           isWaitingForOfferRef.current = false;
           startCallKeepalive({ callId: data.call_id, chatId: currentChat?.id, peerName: callPeerName(), callType: callTypeRef.current });
        }

        // Игнорируем эхо своего собственного запроса
        if (data.relay_by === user?.id) return;
        console.log('📡 Relay active requested by', data.relay_by);
        forceActivateRelayMode();
      } catch (err) {
        console.error('Error handling relay active:', err);
      }
    };

    // Heartbeat-ack от сервера — обновляем таймстамп
    const handleHeartbeatAck = () => { onHeartbeatAck(); };

    window.addEventListener('webrtc-server-signal', handleServerSignal);
    window.addEventListener('webrtc-participant-left', handleParticipantLeft);
    window.addEventListener('webrtc-mode-switched', handleModeSwitched);
    window.addEventListener('webrtc-relay-active', handleRelayActive);
    window.addEventListener('webrtc-heartbeat-ack', handleHeartbeatAck);

    // Обработчики уведомлений — тап по уведомлению → переход к чату
    // Слушаем ОБА события: 'navigate-to-chat' (из notifications.ts/capacitor-bridge.ts)
    // и 'native-open-chat' (legacy, из AndroidBridge Java)
    const handleOpenChatFromNotification = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const targetChatId = detail?.chatId;
      const messageId = detail?.messageId;
      if (!targetChatId) return;

      // Если уже в нужном чате — просто скроллим к сообщению
      if (window.location.pathname === `/chat/${targetChatId}`) {
        if (messageId) {
          const el = document.getElementById(`msg-${messageId}`);
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.classList.add('animate-highlight');
            setTimeout(() => el.classList.remove('animate-highlight'), 1500);
          }
        }
        return;
      }

      // SPA навигация — pushState + перезагрузка роутера
      window.history.pushState(null, '', `/chat/${targetChatId}`);
      window.dispatchEvent(new PopStateEvent('popstate'));

      // Fallback: если роутер не подхватил — hard navigate
      setTimeout(() => {
        if (window.location.pathname !== `/chat/${targetChatId}`) {
          window.location.href = `/chat/${targetChatId}`;
        }
        // Прокрутка к сообщению
        if (messageId) {
          setTimeout(() => {
            const el = document.getElementById(`msg-${messageId}`);
            if (el) {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              el.classList.add('animate-highlight');
              setTimeout(() => el.classList.remove('animate-highlight'), 1500);
            }
          }, 600);
        }
      }, 100);
    };
    const handleNativeAcceptCall = (e: Event) => {
      const callId = (e as CustomEvent).detail?.callId;
      if (callId) {
        console.log('📞 [NATIVE] Accept call from notification:', callId);
        pendingNativeAcceptRef.current = callId;
        window.dispatchEvent(new CustomEvent('native-auto-accept-call', { detail: { callId } }));
      }
    };
    // native-answer-call: единое событие от Android с полной инфой (callId + chatId + callType)
    const handleNativeAnswerCall = (e: Event) => {
      const { callId, chatId, callType: nativeCallType } = (e as CustomEvent).detail || {};
      console.log('📞 [NATIVE] Answer call from push:', callId, 'chat:', chatId, 'type:', nativeCallType);
      if (!callId) return;
      // Сохраняем pending accept — если incomingCall ещё не пришёл, auto-accept сработает когда придёт
      pendingNativeAcceptRef.current = callId;
      // Навигируем к чату если chatId есть
      if (chatId) {
        window.dispatchEvent(new CustomEvent('native-open-chat', { detail: { chatId } }));
      }
      // Пробуем auto-accept сразу + с задержками (retry)
      const tryAccept = () => {
        window.dispatchEvent(new CustomEvent('native-auto-accept-call', { detail: { callId } }));
      };
      tryAccept();
      setTimeout(tryAccept, 800);
      setTimeout(tryAccept, 2000);
      setTimeout(tryAccept, 4000);
    };
    window.addEventListener('navigate-to-chat', handleOpenChatFromNotification);
    window.addEventListener('native-open-chat', handleOpenChatFromNotification);
    window.addEventListener('native-accept-call', handleNativeAcceptCall);
    window.addEventListener('native-answer-call', handleNativeAnswerCall);

    // Mesh-сообщения (BLE) — добавляем в чат как реальные сообщения
    const handleMeshMessage = (e: Event) => {
      const data = (e as CustomEvent).detail;
      if (data?.text && data?.name) {
        console.log('📡 [MESH] Received:', data.name, ':', data.text, 'chatId:', data.chatId, 'userId:', data.userId);
        
        // Если есть chatId и userId — добавляем как полноценное сообщение в чат
        // Только в свои чаты: mesh вещает всем вокруг, чужое не показываем
        const knownChat = data.chatId && useChatStore.getState().chats.some(c => String(c.id) === String(data.chatId));
        if (data.chatId && data.userId && knownChat) {
          // Сквозной номер: новые сборки шлют client_id номером mesh-сообщения
          const cid = data.cid || (typeof data.id === 'string' && data.id.startsWith('pending-') ? data.id : undefined);
          const meshMsg = {
            id: `mesh-${cid || data.id || Date.now()}`,
            client_id: cid,
            chat_id: String(data.chatId),
            sender_id: String(data.userId),
            sender: {
              id: String(data.userId),
              username: data.name || 'mesh-user',
              display_name: data.name || 'Mesh User',
              status: 'online' as const,
            },
            content: data.text,
            type: 'text' as const,
            status: 'delivered' as const,
            metadata: { viaMesh: true, hops: data.hops || 0 },
            created_at: new Date(data.ts || Date.now()).toISOString(),
          };
          useChatStore.getState().addMessage(meshMsg);
          cacheSingleMessage(meshMsg).catch(() => {});
        }
        
        // Toast для видимости
        try { (window as any).AndroidBridge?.showToast?.(`📡 ${data.name}: ${data.text}`); } catch (e) {}
      }
    };
    window.addEventListener('mesh-message', handleMeshMessage);
    // Свой узел Meshtastic: переподключиться к последнему (APK, Bluetooth)
    setTimeout(() => { import('@/lib/lora').then(m => m.autoReconnect()).catch(() => {}); }, 2000);

    return () => {
      window.removeEventListener('webrtc-server-signal', handleServerSignal);
      window.removeEventListener('webrtc-participant-left', handleParticipantLeft);
      window.removeEventListener('webrtc-mode-switched', handleModeSwitched);
      window.removeEventListener('webrtc-relay-active', handleRelayActive);
      window.removeEventListener('webrtc-heartbeat-ack', handleHeartbeatAck);
      window.removeEventListener('navigate-to-chat', handleOpenChatFromNotification);
      window.removeEventListener('native-open-chat', handleOpenChatFromNotification);
      window.removeEventListener('native-accept-call', handleNativeAcceptCall);
      window.removeEventListener('native-answer-call', handleNativeAnswerCall);
      window.removeEventListener('mesh-message', handleMeshMessage);
    };
  }, []); // Пустой массив зависимостей — инициализация один раз

  // Обновляем callTypeRef при изменении callType
  useEffect(() => {
    callTypeRef.current = callType;
  }, [callType]);

  // Авто-принятие звонка из нативного уведомления (Android)
  // Используем ref чтобы handleAutoAccept всегда видел актуальный incomingCall
  const incomingCallRef = useRef<Call | null>(null);
  useEffect(() => {
    incomingCallRef.current = incomingCall;
    // Если есть pending native accept и incomingCall только что появился — принимаем
    if (incomingCall && pendingNativeAcceptRef.current) {
      console.log('📞 [NATIVE] Pending accept resolved! incomingCall arrived:', incomingCall.id);
      pendingNativeAcceptRef.current = null;
      handleAcceptCall();
    }
  }, [incomingCall]);

  useEffect(() => {
    const handleAutoAccept = () => {
      const call = incomingCallRef.current;
      if (call) {
        console.log('📞 [NATIVE] Auto-accepting call:', call.id);
        pendingNativeAcceptRef.current = null;
        handleAcceptCall();
      } else {
        console.log('📞 [NATIVE] Auto-accept: incomingCall not yet available, waiting...');
        // pendingNativeAcceptRef уже установлен — сработает когда incomingCall появится
      }
    };
    window.addEventListener('native-auto-accept-call', handleAutoAccept);
    return () => window.removeEventListener('native-auto-accept-call', handleAutoAccept);
  }, []);

  useEffect(() => {
    if (inCall) {
      const handleUserInteraction = () => {
        resumeAllAudioContexts();
      };
      document.addEventListener('click', handleUserInteraction);
      return () => document.removeEventListener('click', handleUserInteraction);
    }
  }, [inCall]);

  // Привязка audio элемента к legacy Stream (для обратной совместимости 1-to-1)
  useEffect(() => {
    if (remoteStream && remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = remoteStream;
      remoteAudioRef.current.play().catch(() => {});
      // Регистрируем для управления динамиком (earpiece/speaker)
      registerAudioElement(remoteAudioRef.current);
    }
    return () => {
      if (remoteAudioRef.current) unregisterAudioElement(remoteAudioRef.current);
    };
  }, [remoteStream, inCall]);

  // =============================================================
  // Сброс состояния звонка
  // =============================================================
  /**
   * Что нажали в шторке, пока интерфейса не было на экране.
   *
   * Кнопки «Отклонить» и «Отбой» обрабатывает отдельный процесс: он уже
   * сказал серверу и оставил отметку. Когда интерфейс оживает, он должен
   * забрать её и убрать свой экран звонка — иначе показывал бы разговор,
   * которого давно нет.
   */
  const applyPendingNativeCallAction = useCallback(() => {
    try {
      const raw = (window as any).AndroidBridge?.takePendingCallAction?.();
      if (!raw) return;
      const info = JSON.parse(raw);
      if (!info?.callId) return;
      const mine = pendingCallIdRef.current || incomingCallIdRef.current || getCurrentCallId();
      if (mine && mine !== info.callId) return;
      console.log('📞 В шторке нажали:', info.action, info.callId);
      resetCallState();
    } catch { /* не Android либо нечего забирать */ }
  }, []);

  useEffect(() => {
    applyPendingNativeCallAction();
    const onVisible = () => { if (document.visibilityState === 'visible') applyPendingNativeCallAction(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [applyPendingNativeCallAction]);

  const resetCallState = () => {
    endWebRTCCall();
    stopRingtone(); // Останавливаем рингтон Skype
    dismissCallNotification(pendingCallIdRef.current || incomingCallIdRef.current || undefined);
    setIncomingCall(null);
    incomingCallIdRef.current = null;
    pendingNativeAcceptRef.current = null; // Очищаем pending native accept
    setInCall(false);
    inCallRef.current = false;
    setIsCalling(false);
    isCallingRef.current = false;
    setIsWaitingForOffer(false);
    isWaitingForOfferRef.current = false;
    pendingCallIdRef.current = null;
    setRemoteStream(null);
    setRemoteParticipants(new Map());
    setIsMuted(false);
    setIsVideoOff(false);
    setConnectionState('');
    setIsRelay(false);
    resetAudioOutput(); // Сброс аудиовыхода (вернуть на earpiece по умолчанию)
    
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }
  };

  // =============================================================
  // CALLEE: Принять входящий звонок
  // =============================================================
  const handleAcceptCall = async () => {
    if (!incomingCall) return;

    stopRingtone(); // Останавливаем рингтон при принятии звонка
    dismissCallNotification(incomingCall.id);

    const callId = incomingCall.id;
    const isVideo = incomingCall.type === 'video';
    setCallType(incomingCall.type);
    callTypeRef.current = incomingCall.type;

    console.log('📞 [ACCEPT] Accepting call:', callId, 'type:', incomingCall.type);

    try {
      // 1. Получаем доступ к микрофону/камере
      const stream = await initLocalStream(isVideo);
      if (!stream) {
        console.error('❌ Cannot access media devices — rejecting call');
        // Уведомляем caller что мы не можем ответить
        socketEmit.rejectCall(callId);
        setIncomingCall(null);
        incomingCallIdRef.current = null;
        alert('Не удалось получить доступ к микрофону. Проверьте разрешения браузера и HTTPS.');
        return;
      }

      console.log('📞 [ACCEPT] Media stream obtained, sending call:answer');

      // 2. Говорим серверу что приняли звонок (с подтверждением)
      const result = await socketEmit.answerCall(callId);
      console.log('📞 [ACCEPT] Server answer result:', result);
      if (!result?.success) {
        console.error('❌ Server rejected call:answer — call may have already ended');
        socketEmit.rejectCall(callId);
        resetCallState();
        return;
      }

      // 3. Ожидаем offer от caller с таймаутом
      isWaitingForOfferRef.current = true;
      setIsWaitingForOffer(true);
      setIncomingCall(null); // Убираем диалог входящего, показываем "Подключение..."

      console.log('✅ Call accepted, waiting for offer from caller. callId:', callId);

      // 4. Таймаут: если offer не пришёл за 60 секунд — сбрасываем
      setTimeout(() => {
        if (isWaitingForOfferRef.current) {
          console.error('⏰ Timeout: no offer received in 60s, resetting call');
          socketEmit.endCall(callId);
          resetCallState();
        }
      }, 60000);
    } catch (err) {
      console.error('Error accepting call:', err);
      socketEmit.rejectCall(callId);
      resetCallState();
    }
  };

  // =============================================================
  // CALLEE: Отклонить звонок
  // =============================================================
  const handleRejectCall = () => {
    if (incomingCall) {
      console.log('📞 [REJECT] Rejecting call:', incomingCall.id);
      stopRingtone(); // Останавливаем рингтон при отклонении
      dismissCallNotification(incomingCall.id);
      socketEmit.rejectCall(incomingCall.id);
      setIncomingCall(null);
      incomingCallIdRef.current = null;
      setIsWaitingForOffer(false);
      isWaitingForOfferRef.current = false;
    }
  };

  // =============================================================
  // CALLER: Начать звонок
  // ВАЖНО: offer НЕ создаётся сразу — только после call:answered
  // =============================================================
  const initiateCall = useCallback(async (type: 'audio' | 'video', forceRelay = false) => {
    if (!currentChat) return;

    // Сначала останавливаем любой старый рингтон (например от входящего)
    stopRingtone();

    // === GUARD: предотвращаем повторные вызовы (ref работает СИНХРОННО) ===
    if (isCallingRef.current || inCallRef.current) {
      console.log('⚠ initiateCall blocked — already calling or in call');
      return;
    }

    // Устанавливаем принудительный релей, если юзер выбрал Анти-ТСПУ режим
    setGlobalRelayMode(forceRelay);

    // Проверяем подключение сокета ПЕРЕД началом звонка
    if (!isSocketConnected()) {
      console.warn('⚠ Socket not connected! Attempting to reconnect...');
      const connected = await ensureSocketConnected();
      if (!connected) {
        console.error('❌ Cannot connect to server. Call aborted.');
        alert('Нет соединения с сервером. Попробуйте обновить страницу.');
        return;
      }
      console.log('✅ Socket reconnected, proceeding with call');
    }

    isCallingRef.current = true;

    setIsCalling(true);
    setCallType(type);
    callTypeRef.current = type;
    setIsVideoOff(type === 'audio');

    try {
      // 1. Получаем доступ к микрофону/камере ЗАРАНЕЕ
      const stream = await initLocalStream(type === 'video');
      if (!stream) {
        console.error('❌ Cannot get local stream');
        setIsCalling(false);
        isCallingRef.current = false;
        return;
      }

      // 2. Инициируем звонок на сервере → получаем call_id
      //    Сервер сам завершит все зависшие звонки перед созданием нового
      const callResult = await socketEmit.initiateCall(currentChat.id, type);

      if (!callResult?.call_id) {
        console.error('Failed to initiate call on server:', callResult);
        setIsCalling(false);
        isCallingRef.current = false;
        return;
      }

      const callId = callResult.call_id;
      console.log('📞 Call initiated on server, call_id:', callId);

      // Держим звонок с первого гудка, а не с момента ответа.
      //
      // Раньше фоновая служба поднималась только когда собеседник взял
      // трубку. То есть пока идут гудки, приложение — обычное свёрнутое
      // приложение: система вправе его придержать, и исходящий звонок
      // отваливался ровно за то время, пока человек ждёт ответа.
      startCallKeepalive({
        callId,
        chatId: currentChat.id,
        peerName: callPeerName(),
        callType: type,
      });

      // 3. Сохраняем call_id и ЖДЁМ call:answered от callee
      //    Offer будет создан в обработчике setOnCallAnswered
      pendingCallIdRef.current = callId;

      // НЕ создаём offer здесь! Ждём пока callee примет звонок.

      // 4. Таймаут: если callee не ответил за 45 сек — сбрасываем
      setTimeout(() => {
        if (isCallingRef.current && pendingCallIdRef.current === callId && !inCallRef.current) {
          console.error('⏰ Timeout: no answer received in 45s, ending call');
          socketEmit.endCall(callId);
          resetCallState();
        }
      }, 45000);
    } catch (err) {
      console.error('Error starting call:', err);
      setIsCalling(false);
      isCallingRef.current = false;
    }
  }, [currentChat]);

  // =============================================================
  // Завершить звонок
  // =============================================================
  const handleEndCall = () => {
    const callId = incomingCall?.id || pendingCallIdRef.current || getCurrentCallId();
    if (callId) {
      // Групповой чат или несколько участников — leaveCall (завершить только для себя)
      if (currentChat?.type === 'group' || remoteParticipants.size > 1) {
        socketEmit.leaveCall(callId);
      } else {
        socketEmit.endCall(callId);
      }
    }
    resetCallState();
  };

  // =============================================================
  // Групповой звонок: из панели выбора участников
  // =============================================================
  const initiateGroupCall = useCallback(async (userIds: string[], type: 'audio' | 'video') => {
    if (userIds.length === 0) return;
    if (isCallingRef.current || inCallRef.current) return;

    // Стопаем рингтон если был
    stopRingtone();

    // Проверяем подключение сокета
    if (!isSocketConnected()) {
      const connected = await ensureSocketConnected();
      if (!connected) {
        alert('Нет соединения с сервером.');
        return;
      }
    }

    isCallingRef.current = true;
    setIsCalling(true);
    setCallType(type);
    callTypeRef.current = type;
    setIsVideoOff(type === 'audio');
    setShowGroupCallSetup(false);

    try {
      const stream = await initLocalStream(type === 'video');
      if (!stream) {
        console.error('❌ Cannot get local stream');
        setIsCalling(false);
        isCallingRef.current = false;
        return;
      }

      // Инициируем звонок с конкретными user_ids (без chat_id)
      const callResult = await socketEmit.initiateCall(null, type, userIds);

      if (!callResult?.call_id) {
        console.error('Failed to initiate group call:', callResult);
        setIsCalling(false);
        isCallingRef.current = false;
        return;
      }

      pendingCallIdRef.current = callResult.call_id;
      console.log('📞 Group call initiated, call_id:', callResult.call_id, 'participants:', userIds);
    } catch (err) {
      console.error('Error starting group call:', err);
      setIsCalling(false);
      isCallingRef.current = false;
    }
  }, []);

  // Переключить микрофон
  const toggleMute = () => {
    const stream = getLocalStream();
    if (stream) {
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsMuted(!audioTrack.enabled);
      }
    }
  };

  // Переключить видео
  const toggleVideo = async () => {
    // isVideoOff=true → видео ВЫКЛЮЧЕНО → хотим ВКЛЮЧИТЬ (enabled=true)
    // isVideoOff=false → видео ВКЛЮЧЕНО → хотим ВЫКЛЮЧИТЬ (enabled=false)
    const wantEnabled = isVideoOff;
    const success = await toggleVideoTrack(wantEnabled);
    if (success) {
      setIsVideoOff(!wantEnabled);
      if (wantEnabled) {
        setCallType('video');
      }
    }
  };

  // =============================================================
  // Загрузка чатов (IndexedDB → API с кэшированием)
  // =============================================================
  // Экран рисуется из локального кэша и НЕ ждёт сеть.
  //
  // Так было раньше: кэш читался, чаты попадали в стор — но `loading`
  // снимался только в `finally` сетевого запроса. Пока сеть не ответит
  // или не отвалится по таймауту, весь экран занимала крутилка. То есть
  // данные уже лежали в кармане, а приложение всё равно висело: в метро,
  // в самолёте, при отрезанном интернете — всегда. Отсюда и «APK не
  // может прогрузить даже собственный интерфейс офлайн».
  //
  // Теперь порядок обратный: что есть локально — показываем сразу, сеть
  // только ДОПОЛНЯЕТ. Неудачный запрос не гасит уже показанное.
  useEffect(() => {
    let cancelled = false;

    getCachedChats().then(cached => {
      if (cancelled || cached.length === 0) return;
      setChats(cached);
      setLoading(false);          // ← экран живой, не дожидаясь сети
    }).catch(() => {});

    async function loadChats() {
      try {
        const response = await chatApi.getChats();
        if (cancelled) return;
        let allChats = response.data.chats;
        // Автосоздание чата "Избранное" если его нет
        if (!allChats.some((c: any) => c.type === 'favorites')) {
          try {
            const favRes = await chatApi.getOrCreateFavorites();
            allChats = [favRes.data.chat, ...allChats];
          } catch {}
        }
        if (cancelled) return;
        setChats(allChats);
        // Единственный кэш — IndexedDB. Дубль в localStorage убран:
        // он существовал только чтобы прикрыть моргание первого кадра,
        // а моргание лечится порядком, а не второй копией данных.
        cacheChats(allChats).catch(() => {});
        // Хвосты верхних чатов — в локальную базу, чтобы без сервера
        // открывался любой чат, а не только уже открытые
        setTimeout(() => { prefetchRecentMessages(allChats).catch(() => {}); }, 3000);
      } catch (error) {
        // Сети нет — на экране остаётся то, что уже показано из кэша.
        console.warn('Список чатов из сети не получен, показан локальный:', error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadChats();

    return () => { cancelled = true; };
  }, [setChats]);

  // Установка текущего чата + загрузка сообщений (с IndexedDB fallback)
  useEffect(() => {
    if (chatId && chats.length > 0) {
      const chat = chats.find(c => c.id === chatId);
      if (chat) {
        setCurrentChat(chat);
        // Сначала показываем кэш, потом загружаем свежие
        getCachedMessages(chatId).then(cached => {
          if (cached.length > 0) setMessages(chatId, cached);
        }).catch(() => {});
        const MSG_LIMIT = 50;
        chatApi.getMessages(chatId, undefined, MSG_LIMIT).then(async response => {
          // История приходит шифром — расшифровываем до показа, иначе вместо
          // текста в чате висит замок.
          const token = useAuthStore.getState().accessToken || '';
          const myId = useAuthStore.getState().user?.id;
          const msgs = await decryptMessages<Message>(response.data.messages || [], token, myId);
          setMessages(chatId, msgs);
          setHasMoreMessages(chatId, msgs.length >= MSG_LIMIT);
          // Обновляем кэш сообщений
          cacheMessages(chatId, msgs).catch(() => {});
        }).catch(() => {
          // Если API недоступен — кэш уже показан выше
          console.warn('Messages API unavailable, using cache');
        });
      }
    } else {
      setCurrentChat(null);
    }
  }, [chatId, chats, setCurrentChat, setMessages, setHasMoreMessages]);

  if (loading) {
    return (
      <div className="messenger-container items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary-500" />
      </div>
    );
  }

  return (
    <div className="messenger-container">
      {/* Сайдбар */}
      <div className={`messenger-sidebar ${currentChat ? 'has-chat' : ''}`}>
        <Sidebar onOpenGroupCall={() => setShowGroupCallSetup(true)} onOpenStorage={() => setShowStorage(true)} />
      </div>

      {/* 
        AUDIO элемент ВСЕГДА в DOM — не зависит от inCall.
        Это критично: ontrack может сработать ДО того как inCall=true,
        и если <audio> внутри условного рендера, srcObject не привяжется.
      */}
      {/* data-call-audio: пометка «это голос собеседника».
          При уходе в фон останавливается вся медиа на странице, и без этой
          метки замолкал сам разговор. */}
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" data-call-audio />

      {/* Область чата */}
      <div className="messenger-chat-area flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
        {currentChat ? (
          <ChatArea chat={currentChat} onInitiateCall={initiateCall} isCallActive={isCalling || inCall || isWaitingForOffer} />
        ) : (
          <div className="flex-1 flex items-center justify-center text-messenger-muted">
            <div className="text-center">
              <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-messenger-sidebar flex items-center justify-center">
                <svg className="w-10 h-10 text-messenger-muted/50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
              </div>
              <p className="text-xl mb-2 font-medium">Выберите чат</p>
              <p className="text-sm">или начните новый разговор</p>
            </div>
          </div>
        )}
      </div>

      {/* Исходящий звонок (ожидание ответа) */}
      {isCalling && !inCall && (() => {
        // Определяем кому звоним
        const callee = currentChat?.type !== 'group'
          ? currentChat?.members?.find(m => m.id !== user?.id)
          : null;
        const calleeName = callee?.display_name || callee?.username || currentChat?.name || 'Абонент';
        const calleeAvatar = callee?.avatar_url || null;
        return (
          <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
            <div className="bg-gray-900/95 backdrop-blur-md rounded-2xl p-8 shadow-2xl text-center border border-gray-700/50 min-w-[280px]">
              {/* Аватар вызываемого */}
              <div className="w-20 h-20 mx-auto mb-4 rounded-full overflow-hidden bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center text-white text-2xl font-bold shadow-lg ring-4 ring-blue-500/30 animate-pulse">
                {calleeAvatar ? (
                  <img src={calleeAvatar.startsWith('http') ? calleeAvatar : `${getApiUrl()}${calleeAvatar.startsWith('/') ? '' : '/'}${calleeAvatar}`} alt="" className="w-full h-full object-cover" />
                ) : (
                  calleeName[0]?.toUpperCase() || '?'
                )}
              </div>
              <h3 className="text-lg font-semibold text-white mb-1">{calleeName}</h3>
              <p className="text-gray-400 text-sm mb-6">
                {callType === 'video' ? '📹 Видеозвонок...' : '📞 Аудиозвонок...'}
              </p>
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={handleEndCall}
                  className="p-4 bg-red-500 text-white rounded-full hover:bg-red-600 transition-colors shadow-lg shadow-red-500/30"
                  title="Отменить"
                >
                  <PhoneOff size={24} />
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Входящий звонок / ожидание offer */}
      {(incomingCall || isWaitingForOffer) && !inCall && (() => {
        // Определяем кто звонит
        const callerName = (incomingCall as any)?.caller_name
          || (incomingCall as any)?.caller?.display_name
          || currentChat?.members?.find(m => m.id === incomingCall?.caller_id)?.display_name
          || currentChat?.members?.find(m => m.id === incomingCall?.caller_id)?.username
          || 'Абонент';
        const callerAvatar = (incomingCall as any)?.caller_avatar_url
          || (incomingCall as any)?.caller?.avatar_url
          || currentChat?.members?.find(m => m.id === incomingCall?.caller_id)?.avatar_url
          || null;
        return (
          <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
            <div className="bg-gray-900/95 backdrop-blur-md rounded-2xl p-8 shadow-2xl text-center border border-gray-700/50 min-w-[280px]">
              {/* Аватар звонящего */}
              <div className={`w-20 h-20 mx-auto mb-4 rounded-full overflow-hidden bg-gradient-to-br from-green-500 to-green-700 flex items-center justify-center text-white text-2xl font-bold shadow-lg ${isWaitingForOffer ? 'ring-4 ring-blue-500/30' : 'ring-4 ring-green-500/30 animate-pulse'}`}>
                {callerAvatar ? (
                  <img src={callerAvatar.startsWith('http') ? callerAvatar : `${getApiUrl()}${callerAvatar.startsWith('/') ? '' : '/'}${callerAvatar}`} alt="" className="w-full h-full object-cover" />
                ) : (
                  callerName[0]?.toUpperCase() || '?'
                )}
              </div>
              <h3 className="text-lg font-semibold text-white mb-1">{callerName}</h3>
              <p className="text-gray-400 text-sm mb-6">
                {isWaitingForOffer
                  ? '🔄 Подключение...'
                  : incomingCall?.type === 'video' ? '📹 Видеозвонок' : '📞 Аудиозвонок'
                }
              </p>
              <div className="flex justify-center gap-4">
                {!isWaitingForOffer && incomingCall && (
                  <button
                    type="button"
                    onClick={handleRejectCall}
                    className="p-4 bg-red-500 text-white rounded-full hover:bg-red-600 transition-colors shadow-lg shadow-red-500/30"
                    title="Отклонить"
                  >
                    <PhoneOff size={24} />
                  </button>
                )}
                {!isWaitingForOffer && incomingCall && (
                  <button
                    type="button"
                    onClick={handleAcceptCall}
                    className="p-4 bg-green-500 text-white rounded-full hover:bg-green-600 transition-colors shadow-lg shadow-green-500/30"
                    title="Принять"
                  >
                    <Phone size={24} />
                  </button>
                )}
                {isWaitingForOffer && (
                  <button
                    type="button"
                    onClick={handleEndCall}
                    className="p-4 bg-red-500 text-white rounded-full hover:bg-red-600 transition-colors shadow-lg shadow-red-500/30"
                    title="Сбросить"
                  >
                    <PhoneOff size={24} />
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Активный звонок — GroupCallPanel с тайлами участников */}
      {inCall && (
        <GroupCallPanel
          callType={callType}
          connectionState={connectionState}
          isRelay={isRelay}
          isMuted={isMuted}
          isVideoOff={isVideoOff}
          localAvatarUrl={user?.avatar_url}
          localDisplayName={user?.display_name || user?.username || 'Вы'}
          participants={Array.from(remoteParticipants.entries()).map(([userId, data]) => {
            const peers = getPeers() as any;
            const peerData = peers.get(userId);
            const member = currentChat?.members?.find(m => m.id === userId);
            return {
              userId,
              displayName: data.displayName || member?.display_name || member?.username,
              stream: data.stream,
              relayImage: data.relayImage || peerData?.relayImage,
              avatarUrl: member?.avatar_url || null,
            };
          })}
          onToggleMute={toggleMute}
          onToggleVideo={toggleVideo}
          onEndCall={handleEndCall}
        />
      )}

      {/* Панель создания группового звонка */}
      {showGroupCallSetup && (
        <GroupCallSetup
          onStartCall={initiateGroupCall}
          onClose={() => setShowGroupCallSetup(false)}
        />
      )}

      {/* Панель хранилища */}
      {showStorage && (
        <StoragePanel onClose={() => setShowStorage(false)} />
      )}
    </div>
  );
}
