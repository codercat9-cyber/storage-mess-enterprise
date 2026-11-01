import { socketEmit } from '@/lib/socket';
import { getApiUrl } from '@/lib/connection';
import { registerAudioContext, unregisterAudioContext } from '@/lib/audioOutput';
import callCrypto, { 
  generateCallKeys, deriveSessionKey, hasSessionKey,
  getPublicKeyBase64, generateRelayBroadcastKey,
  encryptAudio, encryptVideo, decryptAudio, decryptVideo, obfuscateSDP,
  startChaffTraffic, stopChaffTraffic, cleanupCallCrypto,
  withJitter, type EncryptedPacket 
} from '@/lib/call-crypto';
import useThemeStore from '@/store/theme';
import { useAuthStore } from '@/store/auth';

/**
 * Кто из двоих пересобирает связь, когда она развалилась.
 *
 * Здесь была ещё одна причина «постоянно подключается и падает».
 * Обрыв видят ОБА собеседника, и раньше оба одновременно кидались
 * пересоздавать соединение и слать новое предложение. Два встречных
 * предложения — это столкновение: каждая сторона получает чужое, будучи
 * уже занятой своим, и связь не собирается ни у кого. Дальше снова
 * «сбой», снова оба кидаются, и так по кругу.
 *
 * Договариваемся заранее и без переговоров: пересобирает тот, чей
 * идентификатор меньше. Сравнение строк даёт у обоих один и тот же
 * ответ, никакой связи для этого не нужно. Второй просто ждёт
 * предложения и отвечает на него.
 */
function shouldIRestart(remoteUserId: string): boolean {
  const me = useAuthStore.getState().user?.id;
  if (!me || !remoteUserId) return true; // не с кем сравнивать — действуем сами
  return me < remoteUserId;
}

// =====================================================================
// WebRTC модуль — поддержка групповых звонков (Mesh topology)
// аждый участник имеет свой RTCPeerConnection.
// Сигналы маршрутизируются по user_id.
// =====================================================================

// === Типы ===
interface PeerState {
  connection: RTCPeerConnection;
  pendingIceCandidates: RTCIceCandidateInit[];
  remoteStream: MediaStream | null;
  isRelayMode: boolean;
  gainNode: GainNode | null;
  audioContext: AudioContext | null;
  volume: number; // Текущая громкость (от 0 до 2)
  relayImage: string | null; // Последний кадр через Relay
}

// === лобальные переменные ===
let localStream: MediaStream | null = null;
let currentCallId: string | null = null;
let currentCallType: 'audio' | 'video' = 'audio';

// Mesh: userId → PeerState
const peers = new Map<string, PeerState>();

// ICE серверы (Хардкод надежных серверов как fallback)
let iceServers: RTCIceServer[] = [
  { urls: 'stun:stun.services.mozilla.com:3478' }, // Mozilla (Firefox)
  { urls: 'stun:stun.apple.com:3478' },            // Apple
  { urls: 'stun:stun.3cx.com:3478' },              // 3CX
  { urls: 'stun:stun.twilio.com:3478' },           // Twilio
  { urls: 'stun:stun.stunprotocol.org:3478' },
  { urls: 'stun:stun.cloudflare.com:3478' },       // Cloudflare
  // Public TURN серверы (fallback для VPN/symmetric NAT)
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:80?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
];
let localIceServers: RTCIceServer[] = [];
let googleStunHealthy = true;
let lastStunCheck = 0;
const STUN_CHECK_INTERVAL_MS = 60000;

// Callbacks
let onRemoteStreamCallback: ((userId: string, stream: MediaStream | null) => void) | null = null;
let onConnectionStateCallback: ((state: string, userId?: string) => void) | null = null;
let onRelayModeCallback: ((active: boolean) => void) | null = null;
let onParticipantLeftCallback: ((userId: string) => void) | null = null;
// Legacy single-stream callback
let onRemoteStreamLegacyCallback: ((stream: MediaStream) => void) | null = null;

// Relay mode
//
// ДВА РАЗНЫХ ФЛАГА, и путать их нельзя — на этом сломался весь режим
// «Анти-ТСПУ (TCP)».
//
//   relayRequested    — человек ВЫБРАЛ звонить через сервер. Намерение.
//   isRelayModeGlobal — режим УЖЕ РАБОТАЕТ: захват звука настроен,
//                       сервер знает, собеседник переключён. Состояние.
//
// Раньше флаг был один. Выбор пункта меню ставил его в true ещё до
// начала звонка, а первым делом в activateRelayMode стоит
// `if (isRelayModeGlobal) return;` — защита от повторного включения.
// То есть выбор режима сам себе перекрывал дорогу: включение выходило
// на первой строчке, захват звука не настраивался, `requestRelay` на
// сервер не уходил, собеседник ничего не узнавал.
//
// Снаружи это выглядело ровно так, как в жалобе: «по UDP всё летает, а
// по TCP даже созвониться не могут». UDP работал, потому что шёл другой
// дорогой и этого флага не касался.
let relayRequested = false;
let isRelayModeGlobal = false;
let relayAudioSeq = 0;
let relayProcessor: ScriptProcessorNode | null = null;
let relayAudioContext: AudioContext | null = null;
let relayPlaybackContext: AudioContext | null = null;
let relayVideoInterval: any = null;
let relayCanvas: HTMLCanvasElement | null = null;
let relayVideoElement: HTMLVideoElement | null = null;
let lastRelayLog = 0;

// Relay audio — PCM 16kHz/16-bit (телефонное качество, минимум трафика и задержки)
const RELAY_AUDIO_SAMPLE_RATE = 16000; // 16kHz — достаточно для голоса, 3x меньше данных чем 48kHz

// Relay качество — БАЛАНС между качеством и стабильностью
let relayVideoWidth = 480;     // 480px — приемлемое качество
let relayVideoHeight = 360;    // 360p — читаемое видео
let relayVideoQuality = 0.45;  // 45% JPEG — сбалансировано
let relayVideoFPS = 12;        // 12 FPS — плавное видео

// Jitter buffer — оптимизированный для стабильности
let relayNextPlayTime = 0;     // Когда следующий чанк должен воспроизвестись
const RELAY_AUDIO_BUFFER_SIZE = 1024; // 1024 samples при 16kHz = 64ms (стабильность без треска)
const RELAY_AUDIO_JITTER_MS = 60;     // 60ms jitter — смягчаем рывки сети

// Heartbeat для поддержания соединения
let heartbeatInterval: any = null;
const HEARTBEAT_INTERVAL_MS = 3000;   // 3 сек — быстрее обнаруживаем обрыв

let p2pConnectionTimer: ReturnType<typeof setTimeout> | null = null;
const P2P_TIMEOUT_MS = 60000; // 60 секунд — максимальный приоритет P2P, даём все шансы

// =====================================================================
// Public API — callbacks
// =====================================================================
export function setOnRemoteStream(callback: (stream: MediaStream) => void): void {
  onRemoteStreamLegacyCallback = callback;
}

export function setOnRemoteStreamMulti(callback: (userId: string, stream: MediaStream | null) => void): void {
  onRemoteStreamCallback = callback;
}

export function setOnConnectionState(callback: (state: string, userId?: string) => void): void {
  onConnectionStateCallback = callback;
}

export function setOnRelayMode(callback: (active: boolean) => void): void {
  onRelayModeCallback = callback;
}

export function setOnParticipantLeft(callback: (userId: string) => void): void {
  onParticipantLeftCallback = callback;
}

export function isInRelayMode(): boolean {
  return isRelayModeGlobal;
}

// =====================================================================
// ICE server management
// =====================================================================
export async function fetchIceServers(): Promise<void> {
  try {
    const apiUrl = getApiUrl();
    const response = await fetch(`${apiUrl}/ice-servers`);
    if (response.ok) {
      const data = await response.json();
      // Используем полный список (Google STUN + public TURN + local STUN/TURN + Yggdrasil)
      if (data.allIceServers && Array.isArray(data.allIceServers) && data.allIceServers.length > 0) {
        iceServers = data.allIceServers;
      } else if (data.iceServers && Array.isArray(data.iceServers) && data.iceServers.length > 0) {
        iceServers = data.iceServers;
      }
      if (data.localIceServers && Array.isArray(data.localIceServers)) {
        localIceServers = data.localIceServers;
      }
      console.log('[ICE] Servers loaded:', {
        total: iceServers.length,
        local: localIceServers.length,
        hasTURN: iceServers.some(s => {
          const u = typeof (s as any).urls === 'string' ? (s as any).urls : '';
          return u.startsWith('turn:') || u.startsWith('turns:');
        }),
        servers: iceServers.map(s => (s as any).urls || s),
      });
    }
  } catch (error) {
    console.warn('[ICE] Cannot reach /api/ice-servers, using default STUN:', error);
  }
}

async function probeStunServer(stunUrl: string, timeoutMs: number = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (result: boolean) => {
      if (resolved) return;
      resolved = true;
      try { pc.close(); } catch {}
      clearTimeout(timer);
      resolve(result);
    };
    const pc = new RTCPeerConnection({ iceServers: [{ urls: stunUrl }] });
    const timer = setTimeout(() => done(false), timeoutMs);
    pc.onicecandidate = (ev) => {
      if (ev.candidate && ev.candidate.candidate) done(true);
    };
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete' && !resolved) done(false);
    };
    pc.createDataChannel('probe');
    pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => done(false));
  });
}

export async function checkAndSelectIceServers(): Promise<RTCIceServer[]> {
  const now = Date.now();
  if (now - lastStunCheck < STUN_CHECK_INTERVAL_MS && lastStunCheck > 0) {
    return getActiveIceServers();
  }
  lastStunCheck = now;
  
  // Проверяем локальный STUN первым делом
  const localStun = localIceServers.find(s => {
    const url = typeof (s as any).urls === 'string' ? (s as any).urls : '';
    return url.startsWith('stun:');
  });
  
  if (localStun) {
    const stunUrl = typeof (localStun as any).urls === 'string' ? (localStun as any).urls : '';
    const ok = await probeStunServer(stunUrl, 3000);
    console.log(ok ? '[ICE] Local STUN OK' : '[ICE] Local STUN unreachable/slow, using all available');
  }

  return getActiveIceServers();
}

function getActiveIceServers(): RTCIceServer[] {
  // Локальные (из /api/ice-servers) ВСЕГДА первыми, внешние — как fallback
  const all = [...localIceServers, ...iceServers.filter(s => {
    // Убираем дубликаты из iceServers если они уже есть в localIceServers
    const url = typeof (s as any).urls === 'string' ? (s as any).urls : '';
    return !localIceServers.some(ls => (ls as any).urls === url);
  })];

  // АНТИ-ТСПУ: Вырезаем все UDP TURN серверы, КРОМЕ маскированных под DNS (53) и QUIC (443).
  // Стандартные UDP TURN серверы дропаются DPI, а WebRTC тратит на них 15-20 секунд, из-за чего звонок зависает.
  return all.filter(s => {
    const url = typeof (s as any).urls === 'string' ? (s as any).urls : '';
    // Если это TURN по UDP, выкидываем его, КРОМЕ доверенных портов 53 и 443 (которые маскируются)
    if (url.startsWith('turn:') && url.includes('transport=udp')) {
      if (url.includes(':53?') || url.includes(':443?')) {
        return true; // Разрешаем маскированные порты
      }
      return false; 
    }
    return true; 
  });
}

// === 3-уровневая ICE стратегия ===
// Tier 1: Только свои STUN/TURN (быстро, без зависимости от Google)
function getLocalOnlyIceServers(): RTCIceServer[] {
  if (localIceServers.length > 0) return [...localIceServers];
  // Если локальных нет — вернуть все
  return getActiveIceServers();
}

// Tier 2: Свои + Google + public TURN (полный набор)
function getAllIceServers(): RTCIceServer[] {
  return getActiveIceServers();
}

// Tier 3: Только TURN серверы с relay policy (форсируем relay через TURN)
function getRelayOnlyIceServers(): RTCIceServer[] {
  const all = getActiveIceServers();
  return all.filter(s => {
    const url = typeof (s as any).urls === 'string' ? (s as any).urls : '';
    return url.startsWith('turn:') || url.startsWith('turns:');
  });
}

export function getIceServers(): RTCIceServer[] {
  return getActiveIceServers();
}

export function getStunHealthStatus() {
  return { googleStunHealthy, lastCheck: lastStunCheck };
}

// === ОГРАНИЧЕНИЕ БИТРЕЙТА ДЛЯ TCP ===
export async function applyTcpBandwidthLimits(pc: RTCPeerConnection) {
  const forceTcp = useThemeStore.getState().forceTcpRelay;
  if (!forceTcp) return;

  try {
    const senders = pc.getSenders();
    for (const sender of senders) {
      if (!sender.track) continue;
      
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      
      let changed = false;
      for (const encoding of params.encodings) {
        if (sender.track.kind === 'video') {
          // Экстремальное ограничение видео для TCP: 150 kbps, 20 fps, разрешение делим на 3
          // Это "нарежет" видео на крошечные пакеты, чтобы они не забили TCP-буфер и не мешали голосу
          sender.track.contentHint = 'motion';
          if (encoding.maxBitrate !== 150000) {
            encoding.maxBitrate = 150000;
            encoding.scaleResolutionDownBy = Math.max(encoding.scaleResolutionDownBy || 1, 3);
            encoding.maxFramerate = 20;
            // Понижаем приоритет видео
            (encoding as any).priority = 'very-low';
            (encoding as any).networkPriority = 'very-low';
            changed = true;
          }
        } else if (sender.track.kind === 'audio') {
          // Аудио получает максимальный приоритет и фиксированный битрейт (Opus хорошо жмет голос)
          sender.track.contentHint = 'speech';
          if (encoding.maxBitrate !== 24000) {
            encoding.maxBitrate = 24000; // 24 kbps более чем достаточно для четкой речи
            // Повышаем приоритет аудио
            (encoding as any).priority = 'high';
            (encoding as any).networkPriority = 'high';
            changed = true;
          }
        }
      }
      
      if (changed) {
        await sender.setParameters(params);
        console.log(`[PEER] Applied aggressive TCP limits for ${sender.track.kind} track (prioritizing audio)`);
      }
    }
  } catch (e) {
    console.error('[PEER] Failed to apply TCP bandwidth limits', e);
  }
}

// =====================================================================
// окальный поток (микрофон / камера)
// =====================================================================
export async function initLocalStream(video: boolean = false): Promise<MediaStream | null> {
  // Если поток уже есть и он соответствует требованиям (наличие видео если нужно)
  if (localStream && localStream.getTracks().some(t => t.readyState === 'live')) {
    const hasVideo = localStream.getVideoTracks().length > 0;
    if (!video || hasVideo) {
      return localStream;
    }
    // Если нужно видео, но его нет — продолжаем выполнение для получения видео-трека
  }
  
  try {
    const constraints = {
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: video ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    };
    
    const newStream = await navigator.mediaDevices.getUserMedia(constraints);
    
    if (!localStream) {
      localStream = newStream;
    } else {
      // Обновляем существующий поток новыми треками
      newStream.getTracks().forEach(track => {
        const oldTrack = localStream!.getTracks().find(t => t.kind === track.kind);
        if (oldTrack) {
          oldTrack.stop();
          localStream!.removeTrack(oldTrack);
        }
        localStream!.addTrack(track);
      });
    }
    console.log('[LOCAL] Got stream:', localStream.id);
    // Track ended handler — стабильность
    localStream.getTracks().forEach(track => {
      track.onended = () => {
        console.warn('[LOCAL] Track ended:', track.kind, '- recovering...');
        recoverLocalTrack(track.kind as 'audio' | 'video', video);
      };
    });
    return localStream;
  } catch (error: any) {
    const errorName = error?.name || 'Unknown';
    console.error('[LOCAL] Media error (' + errorName + '):', error?.message);
    if ((errorName === 'NotFoundError' || errorName === 'DevicesNotFoundError') && video) {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        });
        return localStream;
      } catch { return null; }
    }
    return null;
  }
}

async function recoverLocalTrack(kind: 'audio' | 'video', withVideo: boolean): Promise<void> {
  if (!localStream || !currentCallId) return;
  try {
    const constraints = kind === 'audio'
      ? { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }
      : { audio: false, video: withVideo ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false };
    const newStream = await navigator.mediaDevices.getUserMedia(constraints);
    const newTrack = newStream.getTracks()[0];
    if (!newTrack) return;
    const oldTrack = localStream.getTracks().find(t => t.kind === kind);
    if (oldTrack) localStream.removeTrack(oldTrack);
    localStream.addTrack(newTrack);
    for (const [userId, peer] of peers) {
      const sender = peer.connection.getSenders().find(s => s.track?.kind === kind || (!s.track && kind === 'audio'));
      if (sender) {
        await sender.replaceTrack(newTrack);
        console.log('[LOCAL] Replaced', kind, 'track for peer', userId);
      }
    }
    newTrack.onended = () => recoverLocalTrack(kind, withVideo);
  } catch (err) {
    console.error('[LOCAL] Failed to recover', kind, 'track:', err);
  }
}

export function getLocalStream(): MediaStream | null {
  return localStream;
}

/**
 * Включить/выключить видео во время звонка.
 * Если видео включается — запрашиваем поток и добавляем трек.
 * Если выключается — останавливаем трек.
 */
export async function toggleVideoTrack(enabled: boolean): Promise<boolean> {
  if (!localStream) {
    if (enabled) {
      localStream = await initLocalStream(true);
      return !!localStream;
    }
    return false;
  }

  const videoTrack = localStream.getVideoTracks()[0];

  if (enabled) {
    if (videoTrack && videoTrack.readyState === 'live') {
      videoTrack.enabled = true;
    } else {
      // Видео-трека нет или он мёртв — запрашиваем новый
      try {
        // Убираем старый мёртвый трек если есть
        if (videoTrack) {
          localStream.removeTrack(videoTrack);
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 } }
        });
        const newTrack = stream.getVideoTracks()[0];
        if (newTrack) {
          localStream.addTrack(newTrack);
          newTrack.onended = () => recoverLocalTrack('video', true);
          
          // Добавляем трек во все активные соединения
          for (const [userId, peer] of peers) {
            if (peer.connection.signalingState === 'closed') continue;
            try {
              // Пробуем replaceTrack на существующем sender
              const existingSender = peer.connection.getSenders()
                .find(s => s.track === null || s.track?.kind === 'video');
              if (existingSender) {
                await existingSender.replaceTrack(newTrack);
              } else {
                peer.connection.addTrack(newTrack, localStream);
              }
              applyTcpBandwidthLimits(peer.connection);
              // Renegotiate
              const offer = await peer.connection.createOffer();
              await peer.connection.setLocalDescription(offer);
              socketEmit.sendSignal(currentCallId!, {
                type: 'offer',
                sdp: offer.sdp,
                target_user_id: userId,
              });
            } catch (peerErr) {
              console.warn('[VIDEO] Failed to add video to peer', userId, peerErr);
            }
          }
        }
      } catch (err) {
        console.error('[VIDEO] Failed to enable video track:', err);
        return false;
      }
    }
    currentCallType = 'video';
  } else {
    if (videoTrack) {
      // Сначала находим senders ПОКА трек ещё жив, потом stop
      const videoSenders: Array<{ peer: any; sender: RTCRtpSender; userId: string }> = [];
      for (const [userId, peer] of peers) {
        const sender = peer.connection.getSenders()
          .find(s => s.track === videoTrack || s.track?.kind === 'video');
        if (sender) {
          videoSenders.push({ peer, sender, userId });
        }
      }

      // Теперь останавливаем трек
      videoTrack.enabled = false;
      videoTrack.stop();
      localStream.removeTrack(videoTrack);
      
      // Убираем видео из соединений через replaceTrack(null) вместо removeTrack
      for (const { peer, sender, userId } of videoSenders) {
        try {
          await sender.replaceTrack(null);
          // Renegotiate
          const offer = await peer.connection.createOffer();
          await peer.connection.setLocalDescription(offer);
          socketEmit.sendSignal(currentCallId!, {
            type: 'offer',
            sdp: offer.sdp,
            target_user_id: userId,
          });
        } catch (err) {
          console.warn('[VIDEO] Failed to remove video from peer', userId, err);
        }
      }
    }
  }
  return true;
}

// Screen share state
let screenShareStream: MediaStream | null = null;
let screenShareActive = false;

/**
 * Начать/остановить демонстрацию экрана.
 * Заменяет видео-трек на экран (или обратно на камеру).
 */
export async function toggleScreenShare(wantActive: boolean): Promise<boolean> {
  if (!localStream || !currentCallId) return false;

  if (wantActive && !screenShareActive) {
    try {
      screenShareStream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 15 } },
        audio: false,
      });
      const screenTrack = screenShareStream.getVideoTracks()[0];
      if (!screenTrack) return false;

      // Когда юзер нажмёт "Прекратить показ" в системном UI
      screenTrack.onended = () => {
        toggleScreenShare(false);
      };

      // Убираем старый видео-трек из localStream
      const oldVideoTrack = localStream!.getVideoTracks()[0];
      if (oldVideoTrack) {
        oldVideoTrack.stop();
        localStream!.removeTrack(oldVideoTrack);
      }
      localStream!.addTrack(screenTrack);

      // Заменяем трек во всех peer connections
      for (const [userId, peer] of peers) {
        if (peer.connection.signalingState === 'closed') continue;
        try {
          const sender = peer.connection.getSenders().find(s => s.track?.kind === 'video' || s.track === null);
          if (sender) {
            await sender.replaceTrack(screenTrack);
          } else {
            peer.connection.addTrack(screenTrack, localStream!);
          }
          applyTcpBandwidthLimits(peer.connection);
          // Renegotiate
          const offer = await peer.connection.createOffer();
          await peer.connection.setLocalDescription(offer);
          socketEmit.sendSignal(currentCallId!, {
            type: 'offer',
            sdp: offer.sdp,
            target_user_id: userId,
          });
        } catch (err) {
          console.warn('[SCREEN] Failed to replace track for peer', userId, err);
        }
      }

      screenShareActive = true;
      currentCallType = 'video';
      console.log('[SCREEN] Screen sharing started');
      return true;
    } catch (err: any) {
      // Юзер отменил диалог выбора экрана
      if (err.name === 'NotAllowedError' || err.name === 'AbortError') {
        console.log('[SCREEN] User cancelled screen share');
        return false;
      }
      console.error('[SCREEN] Failed to start screen share:', err);
      return false;
    }
  } else if (!wantActive && screenShareActive) {
    // Остановить Screen Share → вернуть камеру (или пустой трек)
    if (screenShareStream) {
      screenShareStream.getTracks().forEach(t => t.stop());
      screenShareStream = null;
    }

    const screenTrack = localStream!.getVideoTracks()[0];
    if (screenTrack) {
      localStream!.removeTrack(screenTrack);
    }

    // Возвращаем камеру
    try {
      const camStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      const newVideoTrack = camStream.getVideoTracks()[0];
      if (newVideoTrack) {
        localStream!.addTrack(newVideoTrack);
        for (const [userId, peer] of peers) {
          if (peer.connection.signalingState === 'closed') continue;
          const sender = peer.connection.getSenders().find(s => s.track?.kind === 'video' || s.track === null);
          if (sender) {
            await sender.replaceTrack(newVideoTrack);
          }
        }
      }
    } catch {
      // Камера недоступна — просто убираем видео
      for (const [userId, peer] of peers) {
        if (peer.connection.signalingState === 'closed') continue;
        const sender = peer.connection.getSenders().find(s => s.track?.kind === 'video');
        if (sender) {
          await sender.replaceTrack(null);
        }
      }
    }

    screenShareActive = false;
    console.log('[SCREEN] Screen sharing stopped');
    return true;
  }
  return false;
}

export function isScreenSharing(): boolean {
  return screenShareActive;
}

/**
 * Сменить микрофон mid-call по deviceId
 */
export async function switchMicrophone(deviceId: string): Promise<boolean> {
  if (!localStream || !currentCallId) return false;
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    const newAudioTrack = newStream.getAudioTracks()[0];
    if (!newAudioTrack) return false;

    const oldAudioTrack = localStream.getAudioTracks()[0];
    if (oldAudioTrack) {
      oldAudioTrack.stop();
      localStream.removeTrack(oldAudioTrack);
    }
    localStream.addTrack(newAudioTrack);

    // Заменяем в peer connections
    for (const [userId, peer] of peers) {
      if (peer.connection.signalingState === 'closed') continue;
      const sender = peer.connection.getSenders().find(s => s.track?.kind === 'audio');
      if (sender) {
        await sender.replaceTrack(newAudioTrack);
      }
    }
    console.log('[MIC] Switched microphone to:', deviceId);
    return true;
  } catch (err) {
    console.error('[MIC] Failed to switch microphone:', err);
    return false;
  }
}

// Текущее направление камеры
let currentFacingMode: 'user' | 'environment' = 'user';

/**
 * Переключить камеру (фронтальная ↔ задняя).
 * Работает на мобильных устройствах с несколькими камерами.
 */
export async function switchCamera(): Promise<boolean> {
  if (!localStream || !currentCallId) return false;
  const oldVideoTrack = localStream.getVideoTracks()[0];
  if (!oldVideoTrack) return false;
  
  const newFacing = currentFacingMode === 'user' ? 'environment' : 'user';
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { exact: newFacing }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    const newVideoTrack = newStream.getVideoTracks()[0];
    if (!newVideoTrack) return false;

    oldVideoTrack.stop();
    localStream.removeTrack(oldVideoTrack);
    localStream.addTrack(newVideoTrack);
    newVideoTrack.onended = () => recoverLocalTrack('video', true);

    // Заменяем в peer connections
    for (const [userId, peer] of peers) {
      if (peer.connection.signalingState === 'closed') continue;
      const sender = peer.connection.getSenders().find(s => s.track?.kind === 'video' || s.track === null);
      if (sender) {
        await sender.replaceTrack(newVideoTrack);
      }
    }
    currentFacingMode = newFacing;
    console.log('[CAM] Switched camera to:', newFacing);
    return true;
  } catch (err) {
    console.error('[CAM] Failed to switch camera:', err);
    // Fallback: exact может не поддерживаться — пробуем ideal
    try {
      const fallback = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: newFacing, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      const fallbackTrack = fallback.getVideoTracks()[0];
      if (!fallbackTrack) return false;
      oldVideoTrack.stop();
      localStream.removeTrack(oldVideoTrack);
      localStream.addTrack(fallbackTrack);
      for (const [userId, peer] of peers) {
        if (peer.connection.signalingState === 'closed') continue;
        const sender = peer.connection.getSenders().find(s => s.track?.kind === 'video' || s.track === null);
        if (sender) await sender.replaceTrack(fallbackTrack);
      }
      currentFacingMode = newFacing;
      console.log('[CAM] Switched camera (fallback) to:', newFacing);
      return true;
    } catch (e2) {
      console.error('[CAM] Fallback also failed:', e2);
      return false;
    }
  }
}

export function getCurrentFacingMode(): 'user' | 'environment' {
  return currentFacingMode;
}

// =====================================================================
// тилиты SDP
// =====================================================================
/**
 * Усиливает кодек Opus, делая его "сухим и бронебойным"
 * Включает FEC (Forward Error Correction), DTX (Discontinuous Transmission),
 * отключает стерео и форсирует жесткий битрейт для голоса.
 */
function hardenOpus(sdp: string): string {
  if (!sdp.includes('opus/48000')) return sdp;
  
  const lines = sdp.split('\r\n');
  const modifiedLines: string[] = [];
  
  let opusPayload: string | null = null;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (line.includes('a=rtpmap:') && line.includes('opus/48000')) {
      const match = line.match(/a=rtpmap:(\d+) opus\/48000/);
      if (match) {
        opusPayload = match[1];
      }
    }
    
    if (opusPayload && line.startsWith(`a=fmtp:${opusPayload}`)) {
      // Заменяем параметры на максимально "сухие" и устойчивые
      modifiedLines.push(`a=fmtp:${opusPayload} minptime=10;useinbandfec=1;usedtx=1;stereo=0;cbr=1;maxaveragebitrate=16000`);
    } else {
      modifiedLines.push(line);
    }
  }
  
  return modifiedLines.join('\r\n');
}

/**
 * Принудительно ставит VP8 первым в списке кодеков (самый стабильный для Android)
 */
function preferVP8(sdp: string): string {
  if (!sdp.includes('VP8')) return sdp;
  
  const lines = sdp.split('\r\n');
  const mVideoLineIndex = lines.findIndex(line => line.startsWith('m=video'));
  if (mVideoLineIndex === -1) return sdp;

  const mVideoLine = lines[mVideoLineIndex];
  const parts = mVideoLine.split(' ');
  // m=video <port> <proto> <payload_type1> <payload_type2> ...
  // Ищем payload type для VP8
  let vp8Payload: string | null = null;
  for (let i = mVideoLineIndex + 1; i < lines.length; i++) {
    if (lines[i].startsWith('m=')) break;
    if (lines[i].includes('VP8/90000')) {
      const match = lines[i].match(/a=rtpmap:(\d+) VP8\/90000/);
      if (match) {
        vp8Payload = match[1];
        break;
      }
    }
  }

  if (vp8Payload) {
    const payloads = parts.slice(3);
    const otherPayloads = payloads.filter(p => p !== vp8Payload);
    const newMVideoLine = parts.slice(0, 3).concat([vp8Payload]).concat(otherPayloads).join(' ');
    lines[mVideoLineIndex] = newMVideoLine;
  }

  return lines.join('\r\n');
}

// =====================================================================
// Mesh PeerConnection management
// =====================================================================
// Типы ICE стратегий
type IceTier = 'local' | 'all' | 'relay-only';

// Счётчик ICE restart попыток для каждого пира
const iceRestartTier = new Map<string, IceTier>();

function createPeerConnection(callId: string, remoteUserId: string, tier: IceTier = 'local'): RTCPeerConnection {
  const existing = peers.get(remoteUserId);
  if (existing) {
    existing.connection.close();
    if (existing.audioContext) {
      unregisterAudioContext(existing.audioContext);
      existing.audioContext.close().catch(() => {});
    }
    if ((existing as any)._audioElement) {
      try { (existing as any)._audioElement.pause(); (existing as any)._audioElement.srcObject = null; } catch {}
    }
    peers.delete(remoteUserId);
  }

  iceRestartTier.set(remoteUserId, tier);

  let activeServers: RTCIceServer[];
  let transportPolicy: RTCIceTransportPolicy = 'all';
  
  switch (tier) {
    case 'local':
      activeServers = getLocalOnlyIceServers();
      break;
    case 'relay-only':
      activeServers = getRelayOnlyIceServers();
      transportPolicy = 'relay';
      break;
    default:
      activeServers = getAllIceServers();
      break;
  }

  // Обход ТСПУ: если пользователь включил Форсировать TCP
  const forceTcp = useThemeStore.getState().forceTcpRelay;
  if (forceTcp) {
    activeServers = getRelayOnlyIceServers().filter(s => {
       const u = typeof (s as any).urls === 'string' ? (s as any).urls : '';
       return u.includes('transport=tcp') || u.startsWith('turns:');
    });
    transportPolicy = 'relay';
  }

  console.log(`[PEER] Creating connection [${tier}] for user`, remoteUserId, 'call', callId, 
    'ICE servers:', activeServers.length, 
    'TURN:', activeServers.filter(s => {
      const u = typeof (s as any).urls === 'string' ? (s as any).urls : '';
      return u.startsWith('turn:') || u.startsWith('turns:');
    }).length,
    'policy:', transportPolicy);
  
  const RTCPeerConnectionClass = window.RTCPeerConnection || (window as any).webkitRTCPeerConnection;
  if (!RTCPeerConnectionClass) {
    console.error('[PEER] RTCPeerConnection not supported — switching to relay');
    activateRelayMode(callId);
    return null as any;
  }

  const pc = new RTCPeerConnectionClass({ 
    iceServers: activeServers,
    iceTransportPolicy: transportPolicy,
    bundlePolicy: 'max-bundle',
  });
  currentCallId = callId;

  const peerState: PeerState = {
    connection: pc,
    pendingIceCandidates: [],
    remoteStream: null,
    isRelayMode: false,
    gainNode: null,
    audioContext: null,
    volume: 1.0, // Default volume
    relayImage: null,
  };
  peers.set(remoteUserId, peerState);

  if (localStream) {
    localStream.getTracks().forEach(track => {
      pc.addTrack(track, localStream!);
    });
    applyTcpBandwidthLimits(pc);
  }

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      // Логируем тип ICE кандидата
      const candType = event.candidate.type || 'unknown';
      const protocol = event.candidate.protocol || 'unknown';
      console.log(`[ICE] Candidate: ${candType} ${protocol} ${event.candidate.address || ''}:${event.candidate.port || ''}`);
      
      socketEmit.sendSignal(callId, {
        type: 'ice',
        candidate: event.candidate,
        target_user_id: remoteUserId,
      });
    } else {
      console.log('[ICE] Gathering complete for', remoteUserId);
    }
  };

  pc.onicegatheringstatechange = () => {
    console.log('[ICE] Gathering state [' + remoteUserId + ']:', pc.iceGatheringState);
  };

  pc.ontrack = (event) => {
    console.log('[PEER] Remote track from', remoteUserId, ':', event.track.kind);
    
    // Собираем все актуальные треки: берём существующие + новый
    const existingTracks = peerState.remoteStream ? peerState.remoteStream.getTracks() : [];
    const allTracks = [...existingTracks];
    if (!allTracks.includes(event.track)) {
      allTracks.push(event.track);
    }
    
    // Создаём НОВЫЙ MediaStream каждый раз, чтобы React перерисовал UI
    const remoteStream = new MediaStream(allTracks);
    peerState.remoteStream = remoteStream;
    
    // Слушаем mute/unmute/ended для обновления UI при renegotiation
    const notifyStreamChange = () => {
      // Пересоздаём stream с актуальными треками для реактивности
      const currentTracks = peerState.remoteStream?.getTracks() || [];
      const freshStream = new MediaStream(currentTracks);
      peerState.remoteStream = freshStream;
      if (onRemoteStreamCallback) onRemoteStreamCallback(remoteUserId, freshStream);
    };
    event.track.onmute = notifyStreamChange;
    event.track.onunmute = notifyStreamChange;
    event.track.onended = notifyStreamChange;

    // Создаём GainNode для регулировки громкости этого участника
    // + <audio> fallback для старых браузеров (Samsung S8 / Chrome 64)
    try {
      if (event.track.kind === 'audio') {
        let gainCreated = false;
        try {
          if (!peerState.audioContext) {
            peerState.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
            registerAudioContext(peerState.audioContext);
          }
          const ctx = peerState.audioContext;
          
          if (peerState.gainNode) {
            try { peerState.gainNode.disconnect(); } catch {}
          }
          
          const source = ctx.createMediaStreamSource(new MediaStream([event.track]));
          const gain = ctx.createGain();
          gain.gain.value = peerState.volume;
          source.connect(gain);
          gain.connect(ctx.destination);
          peerState.gainNode = gain;
          gainCreated = true;
          
          console.log('[PEER] Audio GainNode created for', remoteUserId, 'vol:', peerState.volume);
          
          if (ctx.state === 'suspended') {
            ctx.resume().catch(e => console.warn('[PEER] AudioContext resume failed:', e));
          }
        } catch (gainErr) {
          console.warn('[PEER] GainNode failed, using <audio> fallback:', gainErr);
        }
        
        // Fallback: создаём <audio> элемент (работает на всех браузерах включая Chrome 64)
        if (!gainCreated) {
          const audioEl = document.createElement('audio');
          audioEl.autoplay = true;
          audioEl.setAttribute('playsinline', '');
          audioEl.srcObject = new MediaStream([event.track]);
          audioEl.volume = Math.min(peerState.volume, 1.0);
          audioEl.play().catch(e => console.warn('[PEER] Audio play failed:', e));
          // Сохраняем ссылку для cleanup
          (peerState as any)._audioElement = audioEl;
          console.log('[PEER] Audio <audio> fallback for', remoteUserId);
        }
      }
    } catch (err) {
      console.warn('[PEER] Audio setup failed entirely:', err);
    }

    if (onRemoteStreamCallback) onRemoteStreamCallback(remoteUserId, remoteStream);
    if (onRemoteStreamLegacyCallback) onRemoteStreamLegacyCallback(remoteStream);
  };

  pc.onconnectionstatechange = () => {
    try {
      const state = pc.connectionState || 'unknown';
      console.log('[PEER] Connection state [' + remoteUserId + ']:', state);
      if (onConnectionStateCallback) onConnectionStateCallback(state, remoteUserId);
      if (state === 'failed' || state === 'closed') {
        // В relay-режиме закрытие P2P соединения — норма, не удаляем участника
        if (!isRelayModeGlobal && onParticipantLeftCallback) {
          onParticipantLeftCallback(remoteUserId);
        }
      }
      // =========================================================
      // 3-УРОВНЕВАЯ ICE СТРАТЕГИЯ
      // Tier 1 (0s):   Только свои STUN/TURN — без Google
      // Tier 2 (8s):   Свои + Google + public TURN
      // Tier 3 (20s):  Только TURN relay (iceTransportPolicy: relay)
      // Tier 4 (40s):  Software relay через сервер
      // =========================================================
      if (state === 'disconnected' && currentCallId && !isRelayModeGlobal && shouldIRestart(remoteUserId)) {
        const currentTier = iceRestartTier.get(remoteUserId) || 'local';
        console.warn(`[PEER] Связь с ${remoteUserId} провисла (ярус ${currentTier}) — пересоберу через 10 с`);
        setTimeout(async () => {
          try {
            const peer = peers.get(remoteUserId);
            if (peer && peer.connection.connectionState === 'disconnected' && currentCallId && !isRelayModeGlobal) {
              console.log('[PEER] ICE restart (disconnected) for', remoteUserId);
              const offer = await peer.connection.createOffer({ iceRestart: true });
              await peer.connection.setLocalDescription(offer);
              socketEmit.sendSignal(currentCallId, {
                type: 'offer',
                sdp: offer.sdp,
                target_user_id: remoteUserId,
              });
            }
          } catch (err) {
            console.error('[PEER] ICE restart failed:', err);
          }
        }, 10000);
      }
      
      if (state === 'failed' && currentCallId && !isRelayModeGlobal) {
        const currentTier = iceRestartTier.get(remoteUserId) || 'local';
        console.warn(`[PEER] Connection FAILED for ${remoteUserId} (tier: ${currentTier})`);
        
        // Определяем следующий tier
        const nextTier: IceTier | 'software-relay' = 
          currentTier === 'local' ? 'all' :
          currentTier === 'all' ? 'relay-only' : 'software-relay';
        
        if (nextTier === 'software-relay') {
          // Все уровни ICE исчерпаны — переходим на software relay.
          // Это делают ОБА: переход на сервер симметричен, столкнуться
          // тут нечем, а ждать инициативы второго — терять секунды.
          console.warn('[PEER] Прямые пути исчерпаны, ухожу через сервер');
          iceRestartTier.delete(remoteUserId);
          activateRelayMode(currentCallId!);
        } else if (!shouldIRestart(remoteUserId)) {
          // Пересобирает второй. Мы ждём его предложения — иначе
          // столкнёмся встречными и не соберёмся оба.
          console.log(`[PEER] Пересобирает ${remoteUserId}, жду предложения`);
        } else {
          // Переключаемся на следующий уровень
          const delay = nextTier === 'all' ? 2000 : 3000;
          console.log(`[PEER] Upgrading to tier [${nextTier}] in ${delay/1000}s for ${remoteUserId}`);
          
          setTimeout(async () => {
            try {
              if (!currentCallId || isRelayModeGlobal) return;
              const peer = peers.get(remoteUserId);
              if (peer && peer.connection.connectionState === 'connected') return;
              
              console.log(`[PEER] Creating new connection [${nextTier}] for ${remoteUserId}`);
              
              // Пересоздаём PeerConnection с новым набором ICE серверов
              // createPeerConnection уже добавляет треки из localStream
              createPeerConnection(currentCallId!, remoteUserId, nextTier);
              
              // Создаём новый offer
              const newPeer = peers.get(remoteUserId);
              if (!newPeer) return;
              
              // Создаём новый offer
              const offer = await newPeer.connection.createOffer();
              await newPeer.connection.setLocalDescription(offer);
              socketEmit.sendSignal(currentCallId!, {
                type: 'offer',
                sdp: offer.sdp,
                target_user_id: remoteUserId,
              });
              console.log(`[PEER] Tier [${nextTier}] offer sent to ${remoteUserId}`);
            } catch (err) {
              console.error(`[PEER] Tier [${nextTier}] failed:`, err);
              // Крайний случай — relay
              if (currentCallId && !isRelayModeGlobal) {
                activateRelayMode(currentCallId!);
              }
            }
          }, delay);
        }
      }
    } catch (err) {
      console.error('[PEER] Error in connectionstatechange handler:', err);
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log('[PEER] ICE state [' + remoteUserId + ']:', pc.iceConnectionState);
  };

  return pc;
}

// =====================================================================
// CALLER: Создать offer для конкретного пользователя
// =====================================================================
export async function startCall(callId: string, video: boolean = false, targetUserId?: string, tier: IceTier = 'local'): Promise<RTCSessionDescriptionInit | null> {
  console.log('[CALL] startCall', callId, 'video:', video, 'target:', targetUserId, 'tier:', tier);
  currentCallType = video ? 'video' : 'audio';
  await checkAndSelectIceServers();

  if (!localStream || !localStream.getTracks().some(t => t.readyState === 'live')) {
    const stream = await initLocalStream(video);
    if (!stream) return null;
  }

  // E2E ключ для звонка
  let callPublicKey: string | null = null;
  try {
    callPublicKey = await generateCallKeys();
    console.log('[CALL-CRYPTO] 🔑 Keys generated for call');
  } catch (err) {
    console.warn('[CALL-CRYPTO] Key generation failed, proceeding without E2E:', err);
  }

  const userId = targetUserId || '__default__';
  
  // Человек выбрал «Анти-ТСПУ (TCP)» — идём через сервер сразу, не тратя
  // время на попытки пробиться напрямую.
  //
  // Проверяем НАМЕРЕНИЕ (relayRequested), а не рабочее состояние: режим
  // ещё не включён, включить его — как раз задача следующей строчки.
  if (relayRequested || isRelayModeGlobal) {
    console.log('[CALL] Выбран путь через сервер — обычный звонок не создаём.');

    // setTimeout, чтобы не переплетать это с обновлением состояния выше.
    setTimeout(() => activateRelayMode(callId), 10);
    return null;
  }

  createPeerConnection(callId, userId, tier);
  const peer = peers.get(userId);
  if (!peer) return null;

  try {
    const offer = await peer.connection.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: video,
    });
    
    // Принудительно VP8 для Android и "бронебойный" Opus
    let modifiedSDP = preferVP8(offer.sdp || '');
    modifiedSDP = hardenOpus(modifiedSDP);

    // SDP obfuscation — убираем приватные IP и fingerprints
    const { sdp: obfuscatedSDP } = obfuscateSDP(modifiedSDP);
    modifiedSDP = obfuscatedSDP;

    const modifiedOffer = { ...offer, sdp: modifiedSDP };
    
    await peer.connection.setLocalDescription(modifiedOffer);
    socketEmit.sendSignal(callId, {
      type: 'offer',
      sdp: modifiedOffer.sdp,
      target_user_id: targetUserId,
      e2e_public_key: callPublicKey, // Публичный ключ для E2E
    });
    return modifiedOffer;
  } catch (error) {
    console.error('[CALL] Error creating offer:', error);
    return null;
  }
}

// =====================================================================
// CALLEE: бработать offer и создать answer
// =====================================================================
export async function answerCall(callId: string, video: boolean = false, fromUserId?: string): Promise<RTCSessionDescriptionInit | null> {
  console.log('[CALL] answerCall', callId, 'video:', video, 'from:', fromUserId);
  currentCallType = video ? 'video' : 'audio';
  await checkAndSelectIceServers();

  if (!localStream || !localStream.getTracks().some(t => t.readyState === 'live')) {
    const stream = await initLocalStream(video);
    if (!stream) return null;
  }

  const userId = fromUserId || '__default__';
  const peer = peers.get(userId);
  if (!peer) {
    console.error('[CALL] No peer for', userId);
    return null;
  }
  if (!peer.connection.remoteDescription) {
    console.error('[CALL] No remote description for', userId);
    return null;
  }

  try {
    const answer = await peer.connection.createAnswer();
    
    // Принудительно VP8 для Android и "бронебойный" Opus
    let modifiedSDP = preferVP8(answer.sdp || '');
    modifiedSDP = hardenOpus(modifiedSDP);

    // SDP obfuscation
    const { sdp: obfuscatedSDP } = obfuscateSDP(modifiedSDP);
    modifiedSDP = obfuscatedSDP;

    const modifiedAnswer = { ...answer, sdp: modifiedSDP };
    
    // E2E ключ для звонка (если ещё не сгенерирован)
    let callPublicKey: string | null = getPublicKeyBase64();
    if (!callPublicKey) {
      try {
        callPublicKey = await generateCallKeys();
      } catch {}
    }

    await peer.connection.setLocalDescription(modifiedAnswer);
    socketEmit.sendSignal(callId, {
      type: 'answer',
      sdp: modifiedAnswer.sdp,
      target_user_id: fromUserId,
      e2e_public_key: callPublicKey, // Публичный ключ для E2E
    });
    await flushPendingIceCandidates(userId);
    return modifiedAnswer;
  } catch (error) {
    console.error('[CALL] Error creating answer:', error);
    return null;
  }
}

// =====================================================================
// бработка входящего offer
// =====================================================================
export async function handleOffer(offer: RTCSessionDescriptionInit | any, callId?: string, fromUserId?: string): Promise<boolean> {
  console.log('[SIGNAL] handleOffer from', fromUserId, 'call', callId);
  const userId = fromUserId || '__default__';
  
  // Извлекаем E2E ключ если есть
  if (offer.e2e_public_key && !hasSessionKey(userId)) {
    try {
      await deriveSessionKey(userId, offer.e2e_public_key);
      console.log('[CALL-CRYPTO] 🔐 Session key derived from offer');
    } catch (err: any) {
      console.warn('[CALL-CRYPTO] Key derivation failed:', err?.message || err?.name || String(err));
    }
  }

  // Если в relay-режиме и пришёл P2P offer — автоматически выходим из relay
  if (isRelayModeGlobal) {
    console.log('[SIGNAL] Received P2P offer while in relay mode — auto-switching to P2P');
    stopRelayMode();
    for (const [, peer] of peers) {
      try { peer.connection.close(); } catch {}
      if (peer.audioContext) { unregisterAudioContext(peer.audioContext); peer.audioContext.close().catch(() => {}); }
    }
    peers.clear();
    if (onConnectionStateCallback) onConnectionStateCallback('connecting');
  }
  
  // Пересоздаём PeerConnection если его нет или он закрыт (после relay или failure)
  const existingPeer = peers.get(userId);
  if (!existingPeer || existingPeer.connection.connectionState === 'closed' || existingPeer.connection.signalingState === 'closed') {
    createPeerConnection(callId || 'incoming', userId, 'all');
  }
  const peer = peers.get(userId);
  if (!peer) return false;
  try {
    // Нормализуем SDP: может прийти как строка или как вложенный объект {type, sdp}
    const rawSdp = typeof offer.sdp === 'string' ? offer.sdp : (offer.sdp?.sdp || '');
    const offerType = offer.type || offer.sdp?.type || 'offer';
    
    // Принудительно VP8 для Android и "бронебойный" Opus
    const modifiedSDP = hardenOpus(preferVP8(rawSdp));
    const modifiedOffer = { type: offerType, sdp: modifiedSDP };
    
    // Rollback перед приёмом нового offer если мы уже в промежуточном состоянии
    const sigState = peer.connection.signalingState;
    if (sigState === 'have-local-offer') {
      // Glare: оба пира одновременно шлют offer
      console.warn('[SIGNAL] Glare detected for', userId, '— rolling back local offer');
      await peer.connection.setLocalDescription({ type: 'rollback' });
    } else if (sigState === 'have-remote-offer') {
      // Re-offer: получили новый offer до того как создали answer (ICE restart, relay→P2P switch)
      console.warn('[SIGNAL] Re-offer in have-remote-offer for', userId, '— rolling back');
      await peer.connection.setLocalDescription({ type: 'rollback' });
    }
    
    await peer.connection.setRemoteDescription(new RTCSessionDescription(modifiedOffer));
    await flushPendingIceCandidates(userId);
    return true;
  } catch (error: any) {
    console.error('[SIGNAL] Error setting offer for', userId,
      ':', error?.message || error?.name || String(error),
      '| signalingState:', peer?.connection?.signalingState);
    return false;
  }
}

// =====================================================================
// бработка входящего answer
// =====================================================================
export async function handleAnswer(answer: RTCSessionDescriptionInit | any, fromUserId?: string): Promise<boolean> {
  console.log('[SIGNAL] handleAnswer from', fromUserId);
  const userId = fromUserId || '__default__';

  // Извлекаем E2E ключ если есть
  if (answer.e2e_public_key && !hasSessionKey(userId)) {
    try {
      await deriveSessionKey(userId, answer.e2e_public_key);
      console.log('[CALL-CRYPTO] 🔐 Session key derived from answer');
    } catch (err: any) {
      console.warn('[CALL-CRYPTO] Key derivation failed:', err?.message || err?.name || String(err));
    }
  }

  const peer = peers.get(userId);
  if (!peer) {
    console.error('[SIGNAL] No peer for answer from', userId);
    return false;
  }
  try {
    // Нормализуем SDP: может прийти как строка или как вложенный объект {type, sdp}
    const rawSdp = typeof answer.sdp === 'string' ? answer.sdp : (answer.sdp?.sdp || '');
    const answerType = answer.type || answer.sdp?.type || 'answer';
    
    // Принудительно VP8 для Android и "бронебойный" Opus
    const modifiedSDP = hardenOpus(preferVP8(rawSdp));
    const modifiedAnswer = { type: answerType, sdp: modifiedSDP };
    
    // Проверяем состояние соединения
    if (peer.connection.signalingState !== 'have-local-offer') {
      console.warn('[SIGNAL] Ignoring answer in wrong state:', peer.connection.signalingState, 'for', userId);
      return false;
    }
    await peer.connection.setRemoteDescription(new RTCSessionDescription(modifiedAnswer));
    await flushPendingIceCandidates(userId);
    return true;
  } catch (error: any) {
    console.error('[SIGNAL] Error setting answer for', userId, ':', error?.message || error?.name || JSON.stringify(error));
    return false;
  }
}

// =====================================================================
// ICE candidates (с буферизацией)
// =====================================================================
export async function handleIceCandidate(candidate: RTCIceCandidateInit, fromUserId?: string): Promise<boolean> {
  const userId = fromUserId || '__default__';
  const peer = peers.get(userId);
  if (!peer) {
    console.log('[ICE] No peer for', userId, '- skipping');
    return true;
  }
  if (!peer.connection.remoteDescription) {
    peer.pendingIceCandidates.push(candidate);
    return true;
  }
  // Не добавляем кандидаты если соединение уже closed/failed
  const state = peer.connection.connectionState || peer.connection.iceConnectionState;
  if (state === 'closed' || state === 'failed') {
    return false;
  }
  try {
    await peer.connection.addIceCandidate(new RTCIceCandidate(candidate));
    return true;
  } catch (error: any) {
    // Не спамим если просто поздние кандидаты
    const msg = error?.message || error?.name || String(error);
    if (!msg.includes('location not found') && !msg.includes('location information')) {
      console.warn('[ICE] Error adding candidate for', userId, ':', msg);
    }
    return false;
  }
}

async function flushPendingIceCandidates(userId: string): Promise<void> {
  const peer = peers.get(userId);
  if (!peer || peer.pendingIceCandidates.length === 0) return;
  if (!peer.connection.remoteDescription) return;
  const candidates = [...peer.pendingIceCandidates];
  peer.pendingIceCandidates = [];
  for (const candidate of candidates) {
    try {
      await peer.connection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch {}
  }
}

// =====================================================================
// Volume control per participant
// =====================================================================
export function setParticipantVolume(userId: string, volume: number): void {
  const peer = peers.get(userId);
  if (peer) {
    const vol = Math.max(0, Math.min(2, volume));
    peer.volume = vol;
    if (peer.gainNode) {
      peer.gainNode.gain.value = vol;
    }
    // Fallback <audio> element
    if ((peer as any)._audioElement) {
      (peer as any)._audioElement.volume = Math.min(vol, 1.0);
    }
  }
}

export function getParticipantVolume(userId: string): number {
  const peer = peers.get(userId);
  return peer?.volume ?? 1.0;
}

// =====================================================================
// RELAY MODE
// =====================================================================
export function startP2PConnectionTimer(callId: string): void {
  clearP2PConnectionTimer();
  p2pConnectionTimer = setTimeout(() => {
    let anyConnected = false;
    for (const [, peer] of peers) {
      if (peer.connection.connectionState === 'connected') anyConnected = true;
    }
    if (!anyConnected && peers.size > 0) {
      console.warn('[RELAY] No P2P connections. Switching to relay.');
      activateRelayMode(callId);
    }
  }, P2P_TIMEOUT_MS);
}

function clearP2PConnectionTimer(): void {
  if (p2pConnectionTimer) { clearTimeout(p2pConnectionTimer); p2pConnectionTimer = null; }
}

async function activateRelayMode(callId: string, explicit = false): Promise<void> {
  if (isRelayModeGlobal) return;

  // Пауза между переключениями — защита от качелей «то туда, то сюда»,
  // когда связь рвётся и автоматика мечется.
  //
  // Но если путь через сервер выбран НАМЕРЕННО — человеком у себя или
  // собеседником, о чём нам сообщил сервер, — ждать нечего: это не
  // метание автоматики, это решение. Иначе звонок, начатый сразу после
  // предыдущего, молча не включал выбранный режим: люди перезванивали
  // друг другу подряд и попадали ровно в эту паузу.
  const now = Date.now();
  if (!relayRequested && !explicit && now - lastModeSwitchTime < MODE_SWITCH_COOLDOWN_MS) {
    console.warn('[RELAY] Слишком частое переключение — пропускаю');
    return;
  }
  lastModeSwitchTime = now;
  
  isRelayModeGlobal = true;
  relayAudioSeq = 0;
  socketEmit.requestRelay(callId);
  if (onRelayModeCallback) onRelayModeCallback(true);
  if (onConnectionStateCallback) onConnectionStateCallback('relay');
  
  // Закрываем все P2P соединения
  for (const [, peer] of peers) { 
    try { peer.connection.close(); } catch {} 
    peer.isRelayMode = true;
  }
  
  if (!localStream) {
    localStream = await initLocalStream(currentCallType === 'video');
    if (!localStream) return;
  }
  
  // 1. Настройка Аудио-реле — PCM 16kHz/16-bit (оптимизация: минимум задержки)
  try {
    if (!relayAudioContext) relayAudioContext = new AudioContext({ sampleRate: RELAY_AUDIO_SAMPLE_RATE });
    const source = relayAudioContext.createMediaStreamSource(localStream);
    relayProcessor = relayAudioContext.createScriptProcessor(RELAY_AUDIO_BUFFER_SIZE, 1, 1);
    relayProcessor.onaudioprocess = async (e) => {
      if (!isRelayModeGlobal || !currentCallId) return;
      try {
        const inputData = e.inputBuffer.getChannelData(0);

        // Мягкий VAD — порог ниже чтобы не обрезать тихую речь
        let rms = 0;
        for (let i = 0; i < inputData.length; i++) rms += inputData[i] * inputData[i];
        rms = Math.sqrt(rms / inputData.length);
        if (rms < 0.002) return; // Порог тишины снижен — меньше обрезки речи

        const pcm16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        const bytes = new Uint8Array(pcm16.buffer);
        const CHUNK = 8192;
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += CHUNK) {
          const slice = bytes.subarray(offset, Math.min(offset + CHUNK, bytes.length));
          binary += String.fromCharCode.apply(null, slice as any);
        }
        
        // Relay аудио — отправляем raw PCM base64
        // E2E relay шифрование отключено: broadcast ключ не обменивается между клиентами,
        // каждый генерирует свой → decrypt на приёмнике всегда падает.
        // Relay уже защищён TLS (wss://), E2E для relay будет реализован позже через key exchange.
        const audioBase64 = btoa(binary);
        socketEmit.sendRelayAudio(currentCallId, audioBase64, relayAudioSeq++);
      } catch (err) {
        console.warn('[RELAY] Audio processing error:', err);
      }
    };
    source.connect(relayProcessor);

    // Обработчик надо к чему-то подключить, иначе браузер не вызывает
    // onaudioprocess и звук не отправляется вовсе. Но подключать его ПРЯМО в
    // динамик нельзя: тогда человек слышит собственный микрофон.
    //
    // Отсюда и жалобы: «слышу свой голос» у себя и эхо у собеседника —
    // динамик проигрывал наш же голос, микрофон его снова ловил и отправлял
    // дальше. Эхоподавление тут не спасает: оно гасит звук ЧУЖОГО голоса из
    // динамика, а не свой собственный, пущенный по кругу внутри вкладки.
    //
    // Ставим между ними глушитель: обработчик работает, в динамик не идёт
    // ничего.
    const relaySilencer = relayAudioContext.createGain();
    relaySilencer.gain.value = 0;
    relayProcessor.connect(relaySilencer);
    relaySilencer.connect(relayAudioContext.destination);
  } catch (err) {
    console.error('[RELAY] Error starting audio capture:', err);
  }

  // 2. Настройка Видео-реле — УЛУЧШЕННОЕ КАЧЕСТВО
  console.log(`[RELAY] Starting video relay: ${relayVideoWidth}x${relayVideoHeight} @${relayVideoFPS}FPS quality:${relayVideoQuality}`);
  if (!relayCanvas) relayCanvas = document.createElement('canvas');
  
  const frameIntervalMs = Math.round(1000 / relayVideoFPS);
  relayVideoInterval = setInterval(async () => {
    if (!isRelayModeGlobal || !currentCallId || !relayCanvas || !localStream) return;
    
    try {
      const videoTrack = localStream.getVideoTracks()[0];
      if (!videoTrack || !videoTrack.enabled || videoTrack.readyState !== 'live') {
        return;
      }

      if (!relayVideoElement) {
        relayVideoElement = document.createElement('video');
        relayVideoElement.setAttribute('style', 'position:fixed; top:-1000px; left:-1000px; width:1px; height:1px; opacity:0; pointer-events:none;');
        relayVideoElement.muted = true;
        relayVideoElement.playsInline = true;
        document.body.appendChild(relayVideoElement);
        relayVideoElement.srcObject = localStream;
        relayVideoElement.play().catch(() => {});
      } else if (relayVideoElement.srcObject !== localStream) {
        relayVideoElement.srcObject = localStream;
        relayVideoElement.play().catch(() => {});
      }

      if (!relayVideoElement.videoWidth) return;
      
      const ctx = relayCanvas.getContext('2d');
      if (!ctx) return;
      
      // Адаптивное качество: сохраняем пропорции видео
      const srcAspect = relayVideoElement.videoWidth / relayVideoElement.videoHeight;
      let targetW = relayVideoWidth;
      let targetH = Math.round(targetW / srcAspect);
      if (targetH > relayVideoHeight) {
        targetH = relayVideoHeight;
        targetW = Math.round(targetH * srcAspect);
      }
      
      relayCanvas.width = targetW;
      relayCanvas.height = targetH;
      ctx.drawImage(relayVideoElement, 0, 0, targetW, targetH);
      
      const jpeg = relayCanvas.toDataURL('image/jpeg', relayVideoQuality);
      
      // Relay видео — отправляем raw JPEG (E2E relay отключено, см. комментарий выше)
      socketEmit.sendRelayVideo(currentCallId, jpeg, targetW, targetH, relayVideoQuality);

      // Логируем раз в 5 секунд
      const now = Date.now();
      if (now - lastRelayLog > 5000) {
        lastRelayLog = now;
        console.log(`[RELAY] Video frame: ${targetW}x${targetH} q=${relayVideoQuality} size=${jpeg.length}`);
      }
    } catch (err) {
      // Защита от падения в обработке видео
      console.warn('[RELAY] Video frame error:', err);
    }
  }, frameIntervalMs);

  _setupRelayPlayback();
  _startHeartbeat(callId);
  
  // Chaff traffic отключён: без рабочего E2E relay он шлёт зашифрованный мусор,
  // который на приёмнике вызывает Decrypt failed и забивает логи.
  // TODO: включить когда будет обмен broadcast ключом.
}

/**
 * Принудительная активация реле (для теста)
 */
/**
 * Собеседник выбрал путь через сервер — переключаемся следом.
 *
 * Это указание, а не догадка автоматики, поэтому паузу между
 * переключениями не соблюдаем: иначе повторный звонок сразу после
 * предыдущего молча оставался бы на прямом пути, и голоса бы не было.
 */
export function forceActivateRelayMode(): void {
  if (currentCallId) {
    console.log('[RELAY] Переключаюсь через сервер по указанию');
    activateRelayMode(currentCallId, true);
  }
}

/**
 * Человек выбрал, каким путём звонить. Это НАМЕРЕНИЕ, а не включение.
 *
 * Раньше здесь стояло `isRelayModeGlobal = enabled` — и включение
 * режима потом отказывалось работать, считая, что всё уже включено.
 * Подробности у объявления флагов.
 */
export function setGlobalRelayMode(enabled: boolean): void {
  relayRequested = enabled;
  console.log(`[RELAY] Пользователь выбрал режим: ${enabled ? 'через сервер (TCP)' : 'напрямую (UDP)'}`);
}

/** Выбирал ли человек путь через сервер для этого звонка. */
export function isRelayRequested(): boolean {
  return relayRequested;
}

function _setupRelayPlayback(): void {
  // Сброс jitter buffer
  relayNextPlayTime = 0;

  // Обработка Аудио — чистый PCM 48kHz/16-bit
  const audioHandler = async (event: Event) => {
    const data = (event as CustomEvent).detail;
    if (!data || !isRelayModeGlobal) return;
    
    try {
      let audioBase64: string;
      
      // Проверяем: зашифрованный пакет или raw base64
      if (typeof data.audio === 'string' && data.audio.startsWith('{')) {
        // Зашифрованный пакет от старого клиента (E2E relay отключён — ключи не обмениваются)
        // Тихо пропускаем — расшифровать невозможно без shared key
        return;
      } else {
        // Raw base64 (fallback для backward compatibility)
        audioBase64 = data.audio;
      }

      const binaryStr = atob(audioBase64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      const pcm16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(pcm16.length);
      for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / (pcm16[i] < 0 ? 0x8000 : 0x7FFF);

      if (!relayPlaybackContext) {
        relayPlaybackContext = new AudioContext({ sampleRate: RELAY_AUDIO_SAMPLE_RATE });
        registerAudioContext(relayPlaybackContext);
      }
      const ctx = relayPlaybackContext;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});

      const buffer = ctx.createBuffer(1, float32.length, RELAY_AUDIO_SAMPLE_RATE);
      buffer.copyToChannel(float32, 0);
      const bufferSource = ctx.createBufferSource();
      bufferSource.buffer = buffer;
      bufferSource.connect(ctx.destination);

      const chunkDuration = float32.length / RELAY_AUDIO_SAMPLE_RATE;
      const now = ctx.currentTime;
      if (relayNextPlayTime <= now) relayNextPlayTime = now + RELAY_AUDIO_JITTER_MS / 1000;
      if (relayNextPlayTime > now + 0.3) relayNextPlayTime = now + RELAY_AUDIO_JITTER_MS / 1000; // 300ms макс. буфер — сброс при отставании
      bufferSource.start(relayNextPlayTime);
      relayNextPlayTime += chunkDuration;
    } catch {}
  };

  // Обработка Видео
  const videoHandler = async (event: Event) => {
    const data = (event as CustomEvent).detail;
    if (!data || !isRelayModeGlobal) return;
    
    let imageData: string;
    
    // Проверяем: зашифрованный пакет или raw JPEG
    if (typeof data.image === 'string' && data.image.startsWith('{')) {
      // Зашифрованный пакет от старого клиента — пропускаем (E2E relay отключён)
      return;
    } else {
      // Raw JPEG data URL
      imageData = data.image;
    }

    const peer = peers.get(data.user_id);
    if (peer) {
      peer.relayImage = imageData;
      // Триггерим ререндер через существующий callback (даже если потока нет)
      if (onRemoteStreamCallback) {
        onRemoteStreamCallback(data.user_id, peer.remoteStream);
      }
    }
  };

  window.addEventListener('webrtc-relay-audio', audioHandler);
  window.addEventListener('webrtc-relay-video', videoHandler);
  (window as any).__relayAudioHandler = audioHandler;
  (window as any).__relayVideoHandler = videoHandler;
}

function stopRelayMode(): void {
  if (!isRelayModeGlobal) return;
  isRelayModeGlobal = false;
  relayAudioSeq = 0;
  relayNextPlayTime = 0;
  _stopHeartbeat();
  stopChaffTraffic(); // Останавливаем chaff traffic
  
  if (relayVideoInterval) {
    clearInterval(relayVideoInterval);
    relayVideoInterval = null;
  }
  relayCanvas = null;
  if (relayVideoElement) {
    relayVideoElement.srcObject = null;
    if (relayVideoElement.parentNode) {
      relayVideoElement.parentNode.removeChild(relayVideoElement);
    }
    relayVideoElement = null;
  }

  if (relayProcessor) { try { relayProcessor.disconnect(); } catch {} relayProcessor = null; }
  if (relayAudioContext) { unregisterAudioContext(relayAudioContext); relayAudioContext.close().catch(() => {}); relayAudioContext = null; }
  if (relayPlaybackContext) { unregisterAudioContext(relayPlaybackContext); relayPlaybackContext.close().catch(() => {}); relayPlaybackContext = null; }
  
  const aHandler = (window as any).__relayAudioHandler;
  const vHandler = (window as any).__relayVideoHandler;
  if (aHandler) window.removeEventListener('webrtc-relay-audio', aHandler);
  if (vHandler) window.removeEventListener('webrtc-relay-video', vHandler);
  
  (window as any).__relayAudioHandler = null;
  (window as any).__relayVideoHandler = null;
  
  if (onRelayModeCallback) onRelayModeCallback(false);
}

// =====================================================================
// Heartbeat — защита от зависания соединения
// Используем Web Worker для обхода троттлинга таймеров в фоновых вкладках
// =====================================================================
let _heartbeatWorker: Worker | null = null;
let _lastHeartbeatAck = 0;
const HEARTBEAT_ACK_TIMEOUT_MS = 30000; // 30с без ack → сокет мёртв

function _startHeartbeat(callId: string): void {
  _stopHeartbeat();
  _lastHeartbeatAck = Date.now();

  // Пробуем Web Worker — обходит троттлинг setInterval в фоновых вкладках
  try {
    const workerCode = `
      let interval = null;
      self.onmessage = function(e) {
        if (e.data === 'start') {
          if (interval) clearInterval(interval);
          interval = setInterval(function() { self.postMessage('tick'); }, ${HEARTBEAT_INTERVAL_MS});
        } else if (e.data === 'stop') {
          if (interval) { clearInterval(interval); interval = null; }
        }
      };
    `;
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    _heartbeatWorker = new Worker(URL.createObjectURL(blob));
    _heartbeatWorker.onmessage = () => {
      if (currentCallId === callId) {
        socketEmit.sendHeartbeat(callId);
        // Проверяем ack таймаут
        if (_lastHeartbeatAck > 0 && Date.now() - _lastHeartbeatAck > HEARTBEAT_ACK_TIMEOUT_MS) {
          console.warn('[HEARTBEAT] No ACK for', Math.round((Date.now() - _lastHeartbeatAck) / 1000), 's — connection may be dead');
        }
      } else {
        _stopHeartbeat();
      }
    };
    _heartbeatWorker.postMessage('start');
    console.log('[HEARTBEAT] Started via Web Worker (background-safe)');
  } catch {
    // Fallback на обычный setInterval (в фоне будет троттлиться)
    console.warn('[HEARTBEAT] Web Worker failed, using setInterval fallback');
    heartbeatInterval = setInterval(() => {
      if (currentCallId === callId) {
        socketEmit.sendHeartbeat(callId);
      } else {
        _stopHeartbeat();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }
}

function _stopHeartbeat(): void {
  if (_heartbeatWorker) {
    _heartbeatWorker.postMessage('stop');
    _heartbeatWorker.terminate();
    _heartbeatWorker = null;
  }
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

/** Вызывается при получении heartbeat-ack от сервера */
export function onHeartbeatAck(): void {
  _lastHeartbeatAck = Date.now();
}

// =====================================================================
// Переключение P2P ↔ Relay
// =====================================================================

/**
 * Переключиться с relay обратно на P2P.
 * Попытка создать новые P2P соединения с текущими участниками.
 */
let lastModeSwitchTime = 0;
const MODE_SWITCH_COOLDOWN_MS = 5000; // Минимум 5 секунд между переключениями

export async function deactivateRelayMode(isInitiator: boolean = true): Promise<void> {
  if (!isRelayModeGlobal || !currentCallId) return;
  
  // Защита от бесконечного цикла: cooldown между переключениями
  const now = Date.now();
  if (now - lastModeSwitchTime < MODE_SWITCH_COOLDOWN_MS) {
    console.warn('[RELAY->P2P] Cooldown active, skipping switch');
    return;
  }
  lastModeSwitchTime = now;
  
  const isVideo = currentCallType === 'video';
  const callId = currentCallId;
  const peerIds = Array.from(peers.keys());
  
  // Останавливаем relay
  stopRelayMode();
  
  // Очищаем старые пиры (все закрыты в relay)
  for (const [, peer] of peers) {
    try { peer.connection.close(); } catch {}
    if (peer.audioContext) { unregisterAudioContext(peer.audioContext); peer.audioContext.close().catch(() => {}); }
  }
  peers.clear();
  
  if (onConnectionStateCallback) onConnectionStateCallback('connecting');
  
  if (isInitiator) {
    // Инициатор: уведомляем удалённых участников и создаём P2P offers
    console.log('[RELAY->P2P] Initiator: creating P2P connections...');
    socketEmit.switchCallMode(callId, 'p2p');
    
    // Проверяем стрим
    if (!localStream) {
      localStream = await initLocalStream(isVideo);
      if (!localStream) {
        console.error('[RELAY->P2P] Cannot get local stream, reverting to relay');
        activateRelayMode(callId);
        return;
      }
    }
    
    // Создаём новые offer с tier 'all' (tier 'local' уже не сработал ранее)
    for (const peerId of peerIds) {
      try {
        await startCall(callId, isVideo, peerId, 'all');
        console.log('[RELAY->P2P] New offer sent to', peerId);
      } catch (err) {
        console.error('[RELAY->P2P] Failed to create offer for', peerId, err);
      }
    }
    
    // Запускаем таймер P2P подключения
    startP2PConnectionTimer(callId);
    
    // Fallback: если P2P не установится за 45сек — возврат в relay
    setTimeout(() => {
      if (!isRelayModeGlobal) {
        let anyConnected = false;
        for (const [, peer] of peers) {
          if (peer.connection.connectionState === 'connected') anyConnected = true;
        }
        if (!anyConnected && peers.size > 0 && currentCallId) {
          console.warn('[P2P] No connections after 45s, reverting to relay');
          activateRelayMode(currentCallId);
        }
      }
    }, 45000);
  } else {
    // Не инициатор: просто выходим из relay и ждём входящих P2P offers
    console.log('[RELAY->P2P] Responder: waiting for incoming P2P offers...');
    // Проверяем стрим чтобы быть готовым отвечать на offers
    if (!localStream) {
      localStream = await initLocalStream(isVideo);
    }
  }
}

/**
 * Настройки качества relay-видео
 */
export function setRelayVideoQuality(opts: { width?: number; height?: number; quality?: number; fps?: number }): void {
  if (opts.width) relayVideoWidth = Math.min(1280, Math.max(160, opts.width));
  if (opts.height) relayVideoHeight = Math.min(720, Math.max(120, opts.height));
  if (opts.quality) relayVideoQuality = Math.min(1, Math.max(0.1, opts.quality));
  if (opts.fps) relayVideoFPS = Math.min(30, Math.max(1, opts.fps));
  console.log(`[RELAY] Quality updated: ${relayVideoWidth}x${relayVideoHeight} @${relayVideoFPS}FPS q=${relayVideoQuality}`);
}

// =====================================================================
// Завершить звонок — с защитой от падений
// =====================================================================
export function endCall(): void {
  console.log('[CALL] endCall');
  // Выбор пути живёт ровно один звонок. Без сброса следующий ВХОДЯЩИЙ
  // звонок унаследовал бы «через сервер» от прошлого исходящего — там
  // никто не переспрашивает, каким путём звонить.
  relayRequested = false;
  try { stopRelayMode(); } catch (e) { console.warn('[CALL] Error stopping relay:', e); }
  try { _stopHeartbeat(); } catch {}
  clearP2PConnectionTimer();
  stopCallKeepalive();
  cleanupCallCrypto(); // Очистка E2E ключей + chaff traffic
  for (const [, peer] of peers) {
    try { peer.connection.close(); } catch {}
    if (peer.audioContext) try { unregisterAudioContext(peer.audioContext); peer.audioContext.close().catch(() => {}); } catch {}
    if ((peer as any)._audioElement) try { (peer as any)._audioElement.pause(); (peer as any)._audioElement.srcObject = null; } catch {}
  }
  peers.clear();
  if (localStream) {
    try {
      localStream.getTracks().forEach(track => { try { track.stop(); } catch {} });
    } catch {}
    localStream = null;
  }
  currentCallId = null;
}

// =====================================================================
// тилиты 
// =====================================================================
export function getCurrentCallId(): string | null { return currentCallId; }
export function setCurrentCallId(callId: string): void { currentCallId = callId; }

export function getPeerConnection(): RTCPeerConnection | null {
  for (const [, peer] of peers) return peer.connection;
  return null;
}

export function getPeers(): Map<string, { connection: RTCPeerConnection; remoteStream: MediaStream | null }> {
  return peers;
}

export function getConnectedPeerCount(): number {
  let count = 0;
  for (const [, peer] of peers) {
    if (peer.connection.connectionState === 'connected') count++;
  }
  return count;
}

/**
 * КРИТИЧНО ДЛЯ МОБИЛЬНЫХ БРАУЗЕРОВ: 
 * Резюмирует все AudioContext участников после клика пользователя.
 */
export function resumeAllAudioContexts(): void {
  for (const [, peer] of peers) {
    if (peer.audioContext && peer.audioContext.state === 'suspended') {
      console.log('[PEER] Resuming AudioContext for peer...');
      peer.audioContext.resume().catch(() => {});
    }
  }
  if (relayPlaybackContext && relayPlaybackContext.state === 'suspended') {
    relayPlaybackContext.resume().catch(() => {});
  }
}

export function removePeer(userId: string): void {
  const peer = peers.get(userId);
  if (peer) {
    peer.connection.close();
    if (peer.audioContext) { unregisterAudioContext(peer.audioContext); peer.audioContext.close().catch(() => {}); }
    peers.delete(userId);
  }
}

// =====================================================================
// Стабильность: visibility change, beforeunload, Wake Lock, keepalive
// =====================================================================
let _stabilitySetup = false;
let _wakeLock: any = null;
let _keepaliveAudioCtx: AudioContext | null = null;
let _keepaliveInterval: any = null;

/** Запросить Wake Lock (не даёт экрану гаснуть во время звонка) */
async function _requestWakeLock(): Promise<void> {
  try {
    if ('wakeLock' in navigator && !_wakeLock) {
      _wakeLock = await (navigator as any).wakeLock.request('screen');
      _wakeLock.addEventListener('release', () => {
        console.log('[STABILITY] Wake Lock released');
        _wakeLock = null;
      });
      console.log('[STABILITY] Wake Lock acquired');
    }
  } catch (err) {
    console.warn('[STABILITY] Wake Lock failed:', err);
  }
}

function _releaseWakeLock(): void {
  if (_wakeLock) {
    _wakeLock.release().catch(() => {});
    _wakeLock = null;
  }
}

/**
 * Silent audio oscillator — не даёт браузеру заморозить вкладку.
 * Браузеры (Chrome/Android) обнаруживают воспроизведение аудио
 * и не троттлят/замораживают вкладку.
 */
function _startKeepaliveAudio(): void {
  _stopKeepaliveAudio();
  try {
    _keepaliveAudioCtx = new AudioContext();
    const oscillator = _keepaliveAudioCtx.createOscillator();
    const gain = _keepaliveAudioCtx.createGain();
    gain.gain.value = 0; // Полностью беззвучно
    oscillator.connect(gain);
    gain.connect(_keepaliveAudioCtx.destination);
    oscillator.start();
    console.log('[STABILITY] Silent audio keepalive started');
  } catch {
    console.warn('[STABILITY] Silent audio keepalive failed');
  }
}

function _stopKeepaliveAudio(): void {
  if (_keepaliveAudioCtx) {
    _keepaliveAudioCtx.close().catch(() => {});
    _keepaliveAudioCtx = null;
  }
}

/**
 * Всё, что держит разговор живым, пока приложение свёрнуто.
 *
 * Подробности звонка передаём в оболочку не для красоты: из них
 * собирается панель в шторке Android. Без имени и номера звонка она
 * писала безликое «Идёт звонок...» и не давала положить трубку — за
 * одной кнопкой приходилось разворачивать всё приложение.
 */
/**
 * Разговор на стороне Android, вне страницы.
 *
 * Пока разговор ведёт WebRTC внутри WebView, он не переживает смахивания
 * приложения из недавних: Android уничтожает активность вместе со
 * страницей, и трубка кладётся на полуслове. Нативная служба этим не
 * связана — соединение и микрофон принадлежат ей.
 *
 * Здесь пока только доступ к службе. Переключение основного потока
 * звонков на неё — следующий шаг, и до него флаг `native_calls_enabled`
 * выключен, а всё работает по-старому.
 */
export const nativeCallEngine = {
  /** Есть ли нативный движок и включён ли он на этом устройстве. */
  available(): boolean {
    try {
      return (window as any).AndroidBridge?.isNativeCallsEnabled?.() === true;
    } catch {
      return false;
    }
  },

  /** Идёт ли разговор в службе прямо сейчас. */
  running(): boolean {
    try {
      return (window as any).AndroidBridge?.isNativeCallRunning?.() === true;
    } catch {
      return false;
    }
  },

  setEnabled(enabled: boolean): void {
    try { (window as any).AndroidBridge?.setNativeCallsEnabled?.(enabled); } catch { /* не Android */ }
  },

  start(callId: string, peerId: string, peerName = '', chatId = ''): void {
    try { (window as any).AndroidBridge?.nativeCallStart?.(callId, peerId, peerName, chatId); } catch { /* не Android */ }
  },

  accept(callId: string, peerId: string, peerName = '', chatId = ''): void {
    try { (window as any).AndroidBridge?.nativeCallAccept?.(callId, peerId, peerName, chatId); } catch { /* не Android */ }
  },

  hangup(): void {
    try { (window as any).AndroidBridge?.nativeCallHangup?.(); } catch { /* не Android */ }
  },

  setMuted(muted: boolean): void {
    try { (window as any).AndroidBridge?.nativeCallMute?.(muted); } catch { /* не Android */ }
  },

  setSpeaker(on: boolean): void {
    try { (window as any).AndroidBridge?.nativeCallSpeaker?.(on); } catch { /* не Android */ }
  },
};

export function startCallKeepalive(info?: {
  callId?: string;
  chatId?: string;
  peerName?: string;
  callType?: 'audio' | 'video';
}): void {
  _requestWakeLock();
  _startKeepaliveAudio();
  try {
    const bridge = (window as any).AndroidBridge;
    if (bridge?.startCallServiceWith) {
      bridge.startCallServiceWith(
        info?.callId || currentCallId || '',
        info?.chatId || '',
        info?.peerName || '',
        info?.callType || currentCallType || 'audio',
      );
    } else {
      // Старая оболочка без подробностей — работает как раньше.
      bridge?.startCallService?.();
    }
  } catch (e) { /* не Android — панели в шторке просто нет */ }
}

/** Остановка keepalive при завершении звонка */
export function stopCallKeepalive(): void {
  _releaseWakeLock();
  _stopKeepaliveAudio();
  // Android APK: останавливаем foreground service
  try { (window as any).AndroidBridge?.stopCallService?.(); } catch (e) {}
}

export function setupCallStability(): void {
  if (_stabilitySetup) return;
  _stabilitySetup = true;

  document.addEventListener('visibilitychange', () => {
    if (!currentCallId) return;

    if (document.visibilityState === 'visible') {
      console.log('[STABILITY] Tab visible — checking call health...');

      // 1. Перезапросить Wake Lock (сбрасывается при уходе в фон)
      _requestWakeLock();

      // 2. Резюмировать все AudioContext (браузер suspend-ит в фоне)
      resumeAllAudioContexts();
      if (_keepaliveAudioCtx && _keepaliveAudioCtx.state === 'suspended') {
        _keepaliveAudioCtx.resume().catch(() => {});
      }

      // 3. Проверить и восстановить ICE соединения
      for (const [userId, peer] of peers) {
        const state = peer.connection.connectionState;
        if (state === 'failed') {
          console.warn('[STABILITY] Peer', userId, 'FAILED after background — attempting ICE restart');
          (async () => {
            try {
              if (!currentCallId || isRelayModeGlobal) return;
              const offer = await peer.connection.createOffer({ iceRestart: true });
              await peer.connection.setLocalDescription(offer);
              socketEmit.sendSignal(currentCallId!, {
                type: 'offer',
                sdp: offer.sdp,
                target_user_id: userId,
              });
            } catch (err) {
              console.error('[STABILITY] ICE restart failed for', userId, err);
            }
          })();
        } else if (state === 'disconnected') {
          console.warn('[STABILITY] Peer', userId, 'disconnected — ICE restart in 3s');
          setTimeout(async () => {
            try {
              const p = peers.get(userId);
              if (!p || p.connection.connectionState === 'connected' || !currentCallId || isRelayModeGlobal) return;
              const offer = await p.connection.createOffer({ iceRestart: true });
              await p.connection.setLocalDescription(offer);
              socketEmit.sendSignal(currentCallId!, {
                type: 'offer',
                sdp: offer.sdp,
                target_user_id: userId,
              });
            } catch {}
          }, 3000);
        }

        // Резюмировать AudioContext пира
        if (peer.audioContext && peer.audioContext.state === 'suspended') {
          peer.audioContext.resume().catch(() => {});
        }
      }

      // 4. Relay playback AudioContext
      if (relayPlaybackContext && relayPlaybackContext.state === 'suspended') {
        relayPlaybackContext.resume().catch(() => {});
      }
    }
  });

  // Wake Lock может сброситься при минимизации — перезапрашиваем
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && currentCallId && !_wakeLock) {
      _requestWakeLock();
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (currentCallId) {
      e.preventDefault();
      e.returnValue = 'У вас активный звонок. Вы уверены?';
    }
  });
}

export default {
  fetchIceServers,
  getIceServers,
  getStunHealthStatus,
  checkAndSelectIceServers,
  initLocalStream,
  getLocalStream,
  setOnRemoteStream,
  setOnRemoteStreamMulti,
  setOnConnectionState,
  setOnRelayMode,
  setOnParticipantLeft,
  isInRelayMode,
  startCall,
  answerCall,
  handleOffer,
  handleAnswer,
  handleIceCandidate,
  startP2PConnectionTimer,
  endCall,
  getCurrentCallId,
  setCurrentCallId,
  getPeerConnection,
  getPeers,
  getConnectedPeerCount,
  removePeer,
  setParticipantVolume,
  getParticipantVolume,
  setupCallStability,
  startCallKeepalive,
  stopCallKeepalive,
  onHeartbeatAck,
  forceActivateRelayMode,
  deactivateRelayMode,
  setRelayVideoQuality,
  switchCamera,
  getCurrentFacingMode,
};
