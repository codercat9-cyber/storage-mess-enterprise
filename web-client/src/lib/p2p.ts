// =============================================================================
// P2P Data Channel модуль — вдохновлён Mimir
//
// В Mimir все соединения P2P через Yggdrasil/QUIC (MimirServer.kt, ConnectionHandler.kt).
// Мы адаптируем эту идею для браузера через WebRTC Data Channels:
//
//   1. Когда оба пользователя онлайн — устанавливается прямой WebRTC DataChannel
//   2. Сообщения идут P2P (минуя сервер) — быстрее + приватнее
//   3. Файлы передаются напрямую между браузерами (P2P file transfer)
//   4. Если P2P недоступен — автоматический fallback на сервер (Socket.IO)
//
// Аналоги из Mimir:
//   - MimirServer.kt → P2P listener (наш WebRTC)
//   - ConnectionHandler.kt → обработка соединения
//   - PeerManager.kt → управление пирами
//   - Resolver.kt → нахождение адресов (наш — через Socket.IO сигнализацию)
// =============================================================================

import { socketEmit, getSocket } from './socket';

// ---- Типы ----

export interface P2PConnection {
  peerId: string;              // userId собеседника
  pc: RTCPeerConnection;       // WebRTC соединение
  dc: RTCDataChannel | null;   // Data channel
  state: P2PState;
  createdAt: number;
  lastActivity: number;
}

export type P2PState = 'connecting' | 'connected' | 'disconnected' | 'failed';

// Типы P2P сообщений (аналог MSG_TYPE_* в Mimir Messages.kt)
export const P2P_MSG_TYPE = {
  TEXT: 'text',                // Текстовое сообщение
  FILE_META: 'file_meta',     // Метаданные файла
  FILE_CHUNK: 'file_chunk',   // Чанк файла
  FILE_COMPLETE: 'file_complete', // Файл передан полностью
  TYPING: 'typing',           // Индикатор набора
  ACK: 'ack',                 // Подтверждение
  PING: 'ping',               // Пинг (как MSG_TYPE_PING в Mimir)
  PONG: 'pong',               // Понг (как MSG_TYPE_PONG в Mimir)
  INFO_REQUEST: 'info_req',   // Запрос информации (как MSG_TYPE_INFO_REQUEST)
  INFO_RESPONSE: 'info_res',  // Ответ с информацией (как MSG_TYPE_INFO_RESPONSE)
} as const;

export interface P2PMessage {
  type: string;
  id: string;                  // Уникальный ID сообщения
  timestamp: number;
  payload: any;
}

export interface P2PFileTransfer {
  fileId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  totalChunks: number;
  receivedChunks: number;
  chunks: ArrayBuffer[];
  onProgress?: (progress: number) => void;
  onComplete?: (blob: Blob) => void;
}

// ---- Callback типы ----

type OnP2PMessageCallback = (peerId: string, message: P2PMessage) => void;
type OnP2PStateCallback = (peerId: string, state: P2PState) => void;
type OnP2PFileCallback = (peerId: string, transfer: P2PFileTransfer) => void;

// ---- Глобальное состояние ----

const connections: Map<string, P2PConnection> = new Map();
const fileTransfers: Map<string, P2PFileTransfer> = new Map();

let onMessageCallback: OnP2PMessageCallback | null = null;
let onStateCallback: OnP2PStateCallback | null = null;
let onFileProgressCallback: OnP2PFileCallback | null = null;
let onFileCompleteCallback: OnP2PFileCallback | null = null;

// ICE серверы (используем те же что для звонков + TURN для надёжности)
let iceServers: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:80?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];

// Размер чанка для передачи файлов (16KB — оптимально для DataChannel)
const FILE_CHUNK_SIZE = 16384;

// Тайм-аут P2P соединения
const CONNECTION_TIMEOUT = 15000;
const PING_INTERVAL = 30000;

// ===========================================================================
// Настройка callbacks
// ===========================================================================

export function setOnP2PMessage(callback: OnP2PMessageCallback): void {
  onMessageCallback = callback;
}

export function setOnP2PState(callback: OnP2PStateCallback): void {
  onStateCallback = callback;
}

export function setOnP2PFileProgress(callback: OnP2PFileCallback): void {
  onFileProgressCallback = callback;
}

export function setOnP2PFileComplete(callback: OnP2PFileCallback): void {
  onFileCompleteCallback = callback;
}

export function setP2PIceServers(servers: RTCIceServer[]): void {
  iceServers = servers;
}

// ===========================================================================
// Соединение с пиром (аналог MimirServer → accept connection)
// ===========================================================================

/**
 * Инициировать P2P соединение с пользователем.
 * Caller создаёт offer → отправляет через Socket.IO → Callee отвечает answer.
 */
export async function connectToPeer(peerId: string): Promise<boolean> {
  // Если уже есть активное соединение
  if (connections.has(peerId)) {
    const existing = connections.get(peerId)!;
    if (existing.state === 'connected' && existing.dc?.readyState === 'open') {
      return true;
    }
    // Закрываем старое
    disconnectPeer(peerId);
  }

  console.log(`📡 P2P: Initiating connection to peer ${peerId}`);

  const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'all' });

  const conn: P2PConnection = {
    peerId,
    pc,
    dc: null,
    state: 'connecting',
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };

  connections.set(peerId, conn);
  updateState(peerId, 'connecting');

  // Создаём Data Channel (аналог установки потока в ConnectionHandler)
  const dc = pc.createDataChannel('p2p-messenger', {
    ordered: true,  // Гарантированный порядок (как TCP в Mimir)
  });

  setupDataChannel(dc, peerId);
  conn.dc = dc;

  // ICE candidates → отправляем через сигнальный сервер
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      emitP2PSignal(peerId, { type: 'ice', candidate: event.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    handleConnectionStateChange(peerId, pc.connectionState);
  };

  pc.oniceconnectionstatechange = () => {
    console.log(`📡 P2P ICE state [${peerId}]:`, pc.iceConnectionState);
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Отправляем offer через Socket.IO
    emitP2PSignal(peerId, { type: 'offer', sdp: offer });

    // Применяем буферизованные сигналы (race condition)
    await flushPendingP2PSignals(peerId);

    // Тайм-аут на соединение
    setTimeout(() => {
      if (conn.state === 'connecting') {
        console.warn(`📡 P2P connection timeout for peer ${peerId}`);
        updateState(peerId, 'failed');
      }
    }, CONNECTION_TIMEOUT);

    return true;
  } catch (error) {
    console.error(`P2P connection error [${peerId}]:`, error);
    updateState(peerId, 'failed');
    return false;
  }
}

// ===========================================================================
// Обработка входящего P2P соединения (аналог accept в MimirServer)
// ===========================================================================

export async function handleP2PSignal(peerId: string, signal: any): Promise<void> {
  if (!signal || !signal.type) return;

  console.log(`📡 P2P signal from ${peerId}:`, signal.type);

  if (signal.type === 'offer') {
    await handleP2POffer(peerId, signal.sdp);
  } else if (signal.type === 'answer') {
    await handleP2PAnswer(peerId, signal.sdp);
  } else if (signal.type === 'ice' && signal.candidate) {
    await handleP2PIceCandidate(peerId, signal.candidate);
  }
}

async function handleP2POffer(peerId: string, sdp: RTCSessionDescriptionInit): Promise<void> {
  // Закрываем существующее соединение если есть
  if (connections.has(peerId)) {
    disconnectPeer(peerId);
  }

  const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'all' });

  const conn: P2PConnection = {
    peerId,
    pc,
    dc: null,
    state: 'connecting',
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };

  connections.set(peerId, conn);
  updateState(peerId, 'connecting');

  // Принимаем DataChannel от caller
  pc.ondatachannel = (event) => {
    console.log(`📡 P2P: Received data channel from ${peerId}`);
    conn.dc = event.channel;
    setupDataChannel(event.channel, peerId);
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      emitP2PSignal(peerId, { type: 'ice', candidate: event.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    handleConnectionStateChange(peerId, pc.connectionState);
  };

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    emitP2PSignal(peerId, { type: 'answer', sdp: answer });
    
    // Применяем буферизованные ICE кандидаты (race condition)
    await flushPendingP2PSignals(peerId);
  } catch (error) {
    console.error(`P2P offer handling error [${peerId}]:`, error);
    updateState(peerId, 'failed');
  }
}

// Буфер сигналов для пиров которые ещё не созданы (race condition)
const pendingP2PSignals = new Map<string, Array<{ type: string; sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }>>();

async function handleP2PAnswer(peerId: string, sdp: RTCSessionDescriptionInit): Promise<void> {
  const conn = connections.get(peerId);
  if (!conn) {
    // Буферизуем — пир может ещё создаваться (race condition)
    console.log('P2P answer buffered for peer:', peerId);
    if (!pendingP2PSignals.has(peerId)) pendingP2PSignals.set(peerId, []);
    pendingP2PSignals.get(peerId)!.push({ type: 'answer', sdp });
    return;
  }

  try {
    // Проверяем что PeerConnection в правильном состоянии для приёма answer
    if (conn.pc.signalingState !== 'have-local-offer') {
      console.warn(`P2P answer ignored for [${peerId}]: state is ${conn.pc.signalingState}, expected have-local-offer`);
      return;
    }
    await conn.pc.setRemoteDescription(new RTCSessionDescription(sdp));
  } catch (error: any) {
    console.error(`P2P answer handling error [${peerId}]:`, error?.message || error);
  }
}

async function handleP2PIceCandidate(peerId: string, candidate: RTCIceCandidateInit): Promise<void> {
  const conn = connections.get(peerId);
  if (!conn) {
    // Буферизуем ICE кандидаты для ещё не созданного пира
    if (!pendingP2PSignals.has(peerId)) pendingP2PSignals.set(peerId, []);
    pendingP2PSignals.get(peerId)!.push({ type: 'ice', candidate });
    return;
  }

  try {
    if (conn.pc.remoteDescription) {
      await conn.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } else {
      // Буферизуем до setRemoteDescription
      if (!pendingP2PSignals.has(peerId)) pendingP2PSignals.set(peerId, []);
      pendingP2PSignals.get(peerId)!.push({ type: 'ice', candidate });
    }
  } catch (error: any) {
    console.error(`P2P ICE error [${peerId}]:`, error?.message || error);
  }
}

/**
 * Применить буферизованные сигналы после создания пира
 */
async function flushPendingP2PSignals(peerId: string): Promise<void> {
  const pending = pendingP2PSignals.get(peerId);
  if (!pending || pending.length === 0) return;
  pendingP2PSignals.delete(peerId);
  
  for (const sig of pending) {
    if (sig.type === 'answer' && sig.sdp) {
      await handleP2PAnswer(peerId, sig.sdp);
    } else if (sig.type === 'ice' && sig.candidate) {
      await handleP2PIceCandidate(peerId, sig.candidate);
    }
  }
}

// ===========================================================================
// Data Channel management
// ===========================================================================

function setupDataChannel(dc: RTCDataChannel, peerId: string): void {
  dc.binaryType = 'arraybuffer';

  dc.onopen = () => {
    console.log(`📡 P2P DataChannel OPEN with ${peerId}`);
    updateState(peerId, 'connected');

    // Запускаем ping (как MSG_TYPE_PING в Mimir)
    startPingLoop(peerId);
  };

  dc.onclose = () => {
    console.log(`📡 P2P DataChannel CLOSED with ${peerId}`);
    updateState(peerId, 'disconnected');
  };

  dc.onerror = (event) => {
    console.error(`📡 P2P DataChannel ERROR with ${peerId}:`, event);
  };

  dc.onmessage = (event) => {
    handleDataChannelMessage(peerId, event.data);
  };
}

function handleDataChannelMessage(peerId: string, data: any): void {
  const conn = connections.get(peerId);
  if (conn) conn.lastActivity = Date.now();

  // Бинарные данные — это чанк файла
  if (data instanceof ArrayBuffer) {
    handleFileChunk(peerId, data);
    return;
  }

  // JSON сообщение
  try {
    const message: P2PMessage = JSON.parse(data);

    switch (message.type) {
      case P2P_MSG_TYPE.PING:
        sendP2PMessage(peerId, {
          type: P2P_MSG_TYPE.PONG,
          id: message.id,
          timestamp: Date.now(),
          payload: null,
        });
        break;

      case P2P_MSG_TYPE.PONG:
        // RTT можно посчитать если нужно
        break;

      case P2P_MSG_TYPE.ACK:
        // Подтверждение получения сообщения
        break;

      case P2P_MSG_TYPE.FILE_META:
        handleFileMeta(peerId, message);
        break;

      case P2P_MSG_TYPE.FILE_COMPLETE:
        handleFileComplete(peerId, message.payload.fileId);
        break;

      default:
        // Текст, typing, и др. — отправляем в callback
        if (onMessageCallback) {
          onMessageCallback(peerId, message);
        }
        break;
    }
  } catch (e) {
    console.error('P2P invalid message:', e);
  }
}

// ===========================================================================
// Отправка P2P сообщений
// ===========================================================================

export function sendP2PMessage(peerId: string, message: P2PMessage): boolean {
  const conn = connections.get(peerId);
  if (!conn || !conn.dc || conn.dc.readyState !== 'open') {
    return false;
  }

  try {
    conn.dc.send(JSON.stringify(message));
    conn.lastActivity = Date.now();
    return true;
  } catch (error) {
    console.error(`P2P send error [${peerId}]:`, error);
    return false;
  }
}

/**
 * Отправить текстовое сообщение P2P (с fallback на сервер).
 * Возвращает true если отправлено P2P, false если через сервер.
 */
export function sendTextP2P(peerId: string, messageId: string, content: string): boolean {
  const message: P2PMessage = {
    type: P2P_MSG_TYPE.TEXT,
    id: messageId,
    timestamp: Date.now(),
    payload: { content },
  };

  return sendP2PMessage(peerId, message);
}

/**
 * Отправить typing indicator P2P.
 */
export function sendTypingP2P(peerId: string, isTyping: boolean): boolean {
  const message: P2PMessage = {
    type: P2P_MSG_TYPE.TYPING,
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    payload: { typing: isTyping },
  };

  return sendP2PMessage(peerId, message);
}

// ===========================================================================
// P2P File Transfer (аналог MSG_TYPE_MESSAGE_FILE в Mimir)
// В Mimir файлы передаются напрямую P2P без ограничений размера.
// Мы делаем то же самое через WebRTC DataChannel.
// ===========================================================================

/**
 * Отправить файл P2P.
 * Разбивает файл на чанки и передаёт через DataChannel.
 */
export async function sendFileP2P(
  peerId: string,
  file: File,
  onProgress?: (progress: number) => void
): Promise<boolean> {
  const conn = connections.get(peerId);
  if (!conn || !conn.dc || conn.dc.readyState !== 'open') {
    console.warn('P2P not available for file transfer');
    return false;
  }

  const fileId = crypto.randomUUID();
  const totalChunks = Math.ceil(file.size / FILE_CHUNK_SIZE);

  // 1. Отправляем метаданные файла
  const metaMessage: P2PMessage = {
    type: P2P_MSG_TYPE.FILE_META,
    id: fileId,
    timestamp: Date.now(),
    payload: {
      fileId,
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type || 'application/octet-stream',
      totalChunks,
    },
  };

  if (!sendP2PMessage(peerId, metaMessage)) return false;

  // 2. Отправляем чанки (бинарные)
  const reader = new FileReader();
  let offset = 0;
  let chunksSent = 0;

  const sendNextChunk = (): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (offset >= file.size) {
        resolve();
        return;
      }

      const chunk = file.slice(offset, offset + FILE_CHUNK_SIZE);
      reader.onload = () => {
        try {
          // Проверяем bufferedAmount чтобы не перегружать канал
          if (conn.dc!.bufferedAmount > FILE_CHUNK_SIZE * 10) {
            // Ждём пока буфер разгрузится
            conn.dc!.bufferedAmountLowThreshold = FILE_CHUNK_SIZE;
            conn.dc!.onbufferedamountlow = () => {
              conn.dc!.onbufferedamountlow = null;
              conn.dc!.send(reader.result as ArrayBuffer);
              offset += FILE_CHUNK_SIZE;
              chunksSent++;
              onProgress?.(chunksSent / totalChunks);
              resolve();
            };
          } else {
            conn.dc!.send(reader.result as ArrayBuffer);
            offset += FILE_CHUNK_SIZE;
            chunksSent++;
            onProgress?.(chunksSent / totalChunks);
            resolve();
          }
        } catch (error) {
          reject(error);
        }
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(chunk);
    });
  };

  try {
    while (offset < file.size) {
      await sendNextChunk();
    }

    // 3. Отправляем complete
    sendP2PMessage(peerId, {
      type: P2P_MSG_TYPE.FILE_COMPLETE,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      payload: { fileId },
    });

    console.log(`✅ P2P file sent: ${file.name} (${totalChunks} chunks)`);
    return true;
  } catch (error) {
    console.error('P2P file transfer error:', error);
    return false;
  }
}

// ===========================================================================
// Приём файлов P2P
// ===========================================================================

function handleFileMeta(peerId: string, message: P2PMessage): void {
  const { fileId, fileName, fileSize, mimeType, totalChunks } = message.payload;

  const transfer: P2PFileTransfer = {
    fileId,
    fileName,
    fileSize,
    mimeType,
    totalChunks,
    receivedChunks: 0,
    chunks: [],
  };

  fileTransfers.set(fileId, transfer);
  console.log(`📁 P2P file incoming: ${fileName} (${fileSize} bytes, ${totalChunks} chunks)`);

  if (onFileProgressCallback) {
    onFileProgressCallback(peerId, transfer);
  }
}

function handleFileChunk(peerId: string, data: ArrayBuffer): void {
  // Находим активный трансфер для этого пира
  // (если несколько трансферов одновременно, нужно добавить маршрутизацию)
  let activeTransfer: P2PFileTransfer | null = null;

  for (const transfer of fileTransfers.values()) {
    if (transfer.receivedChunks < transfer.totalChunks) {
      activeTransfer = transfer;
      break;
    }
  }

  if (!activeTransfer) {
    console.warn('P2P: received file chunk but no active transfer');
    return;
  }

  activeTransfer.chunks.push(data);
  activeTransfer.receivedChunks++;

  if (onFileProgressCallback) {
    onFileProgressCallback(peerId, activeTransfer);
  }
}

function handleFileComplete(peerId: string, fileId: string): void {
  const transfer = fileTransfers.get(fileId);
  if (!transfer) return;

  // Собираем файл из чанков
  const blob = new Blob(transfer.chunks, { type: transfer.mimeType });
  console.log(`✅ P2P file received: ${transfer.fileName} (${blob.size} bytes)`);

  transfer.onComplete?.(blob);

  if (onFileCompleteCallback) {
    onFileCompleteCallback(peerId, { ...transfer, chunks: [] });
  }

  // Очищаем
  fileTransfers.delete(fileId);
}

// ===========================================================================
// Управление соединениями (аналог PeerManager.kt в Mimir)
// ===========================================================================

function handleConnectionStateChange(peerId: string, state: string): void {
  console.log(`📡 P2P connection state [${peerId}]:`, state);

  switch (state) {
    case 'connected':
      updateState(peerId, 'connected');
      break;
    case 'disconnected':
      updateState(peerId, 'disconnected');
      // Попробуем переподключиться через 3 секунды
      setTimeout(() => {
        const conn = connections.get(peerId);
        if (conn && conn.state === 'disconnected') {
          console.log(`📡 P2P: Attempting reconnection to ${peerId}`);
          connectToPeer(peerId);
        }
      }, 3000);
      break;
    case 'failed':
      updateState(peerId, 'failed');
      break;
    case 'closed':
      updateState(peerId, 'disconnected');
      break;
  }
}

function updateState(peerId: string, state: P2PState): void {
  const conn = connections.get(peerId);
  if (conn) conn.state = state;

  if (onStateCallback) {
    onStateCallback(peerId, state);
  }
}

function startPingLoop(peerId: string): void {
  const interval = setInterval(() => {
    const conn = connections.get(peerId);
    if (!conn || conn.state !== 'connected' || !conn.dc || conn.dc.readyState !== 'open') {
      clearInterval(interval);
      return;
    }

    sendP2PMessage(peerId, {
      type: P2P_MSG_TYPE.PING,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      payload: null,
    });
  }, PING_INTERVAL);
}

// ===========================================================================
// Сигнализация P2P через Socket.IO
// ===========================================================================

function emitP2PSignal(peerId: string, signal: any): void {
  const socket = getSocket();
  if (socket) {
    socket.emit('p2p:signal' as any, { peer_id: peerId, signal });
  }
}

/**
 * Регистрирует обработчик входящих P2P сигналов.
 * Вызывается из ChatPage при инициализации сокета.
 */
export function initP2PSignaling(): void {
  const socket = getSocket();
  if (!socket) return;

  socket.on('p2p:signal' as any, (data: { peer_id: string; signal: any }) => {
    handleP2PSignal(data.peer_id, data.signal);
  });

  console.log('📡 P2P signaling initialized');
}

// ===========================================================================
// Публичный API
// ===========================================================================

export function isPeerConnected(peerId: string): boolean {
  const conn = connections.get(peerId);
  return conn?.state === 'connected' && conn.dc?.readyState === 'open';
}

export function getPeerState(peerId: string): P2PState | null {
  return connections.get(peerId)?.state || null;
}

export function getConnectedPeers(): string[] {
  const peers: string[] = [];
  connections.forEach((conn, peerId) => {
    if (conn.state === 'connected') {
      peers.push(peerId);
    }
  });
  return peers;
}

export function disconnectPeer(peerId: string): void {
  const conn = connections.get(peerId);
  if (conn) {
    conn.dc?.close();
    conn.pc.close();
    connections.delete(peerId);
    pendingP2PSignals.delete(peerId);
    updateState(peerId, 'disconnected');
  }
}

export function disconnectAll(): void {
  connections.forEach((_, peerId) => disconnectPeer(peerId));
}

export function getP2PStats(peerId: string): Promise<RTCStatsReport | null> {
  const conn = connections.get(peerId);
  if (!conn) return Promise.resolve(null);
  return conn.pc.getStats();
}

export default {
  connectToPeer,
  handleP2PSignal,
  sendTextP2P,
  sendTypingP2P,
  sendFileP2P,
  isPeerConnected,
  getPeerState,
  getConnectedPeers,
  disconnectPeer,
  disconnectAll,
  initP2PSignaling,
  setOnP2PMessage,
  setOnP2PState,
  setOnP2PFileProgress,
  setOnP2PFileComplete,
  setP2PIceServers,
  getP2PStats,
  P2P_MSG_TYPE,
};
