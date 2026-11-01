// Типы для базы данных и API

export interface User {
  id: string;
  username: string;
  email?: string;
  password_hash: string;
  recovery_hash?: string;
  display_name?: string;
  avatar_url?: string;
  public_key?: string;
  status: 'online' | 'offline' | 'away' | 'busy';
  last_seen?: string;
  created_at: string;
  updated_at: string;
}

export interface UserPublic {
  id: string;
  username: string;
  display_name?: string;
  avatar_url?: string;
  status: string;
  last_seen?: string;
}

export interface Contact {
  id: string;
  user_id: string;
  contact_id: string;
  status: 'pending' | 'accepted' | 'blocked';
  created_at: string;
}

export interface Chat {
  id: string;
  type: 'private' | 'group' | 'channel';
  name?: string;
  avatar_url?: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
  members?: UserPublic[];
  lastMessage?: Message;
}

export interface ChatWithMembers extends Chat {
  members: UserPublic[];
}

export interface ChatMember {
  id: string;
  chat_id: string;
  user_id: string;
  role: 'admin' | 'moderator' | 'member';
  joined_at: string;
  last_read_at?: string;
  notifications_enabled: boolean;
}

export interface Message {
  id: string;
  chat_id: string;
  sender_id: string;
  reply_to_id?: string;
  content?: string;
  encrypted_content?: string;
  type: 'text' | 'image' | 'video' | 'audio' | 'file' | 'voice' | 'system';
  metadata?: string;
  edited_at?: string;
  deleted_at?: string;
  created_at: string;
}

export interface MessageWithSender extends Message {
  sender: UserPublic;
}

export interface MessageRead {
  id: string;
  message_id: string;
  user_id: string;
  read_at: string;
}

export interface MessageReaction {
  id: string;
  message_id: string;
  user_id: string;
  emoji: string;
  created_at: string;
}

export interface ReactionSummary {
  emoji: string;
  count: number;
  users: { id: string; username: string; display_name?: string; avatar_url?: string }[];
}

export interface File {
  id: string;
  uploader_id: string;
  original_name: string;
  stored_name: string;
  mime_type?: string;
  size: number;
  storage_path: string;
  thumbnail_path?: string;
  checksum?: string;
  is_public: boolean;
  download_count: number;
  source?: string;
  created_at: string;
}

export interface Call {
  id: string;
  chat_id?: string;
  caller_id: string;
  type: 'audio' | 'video';
  status: 'pending' | 'active' | 'ended' | 'missed';
  started_at?: string;
  ended_at?: string;
  duration?: number;
  created_at: string;
  participants?: CallParticipant[];
}

export interface CallParticipant {
  id: string;
  call_id: string;
  user_id: string;
  status: 'invited' | 'ringing' | 'connected' | 'left';
  joined_at?: string;
  left_at?: string;
}

export interface RefreshToken {
  id: string;
  user_id: string;
  token: string;
  device_info?: string;
  ip_address?: string;
  expires_at: string;
  created_at: string;
}

export interface UserSettings {
  id: string;
  user_id: string;
  theme: 'light' | 'dark' | 'system';
  language: string;
  notifications_enabled: boolean;
  sound_enabled: boolean;
  two_factor_enabled: boolean;
  two_factor_secret?: string;
  settings_json?: string;
}

// JWT Payload
export interface JWTPayload {
  userId: string;
  username: string;
  iat?: number;
  exp?: number;
}

// API Request/Response типы
export interface RegisterRequest {
  username: string;
  email?: string;
  password: string;
  display_name?: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface AuthResponse {
  user: UserPublic;
  accessToken: string;
  refreshToken: string;
}

export interface CreateChatRequest {
  type: 'private' | 'group';
  name?: string;
  member_ids: string[];
}

export interface SendMessageRequest {
  content: string;
  type?: Message['type'];
  reply_to_id?: string;
  metadata?: Record<string, unknown>;
  // Сквозной номер сообщения от клиента: один и тот же на всех путях
  // доставки (сервер, BLE-mesh, LoRa) — по нему склеиваются копии.
  client_id?: string;
}

export interface InitiateCallRequest {
  chat_id?: string;
  user_ids?: string[];
  type: 'audio' | 'video';
}

// Socket события - клиент -> сервер
export interface ClientToServerEvents {
  'message:send': (data: { chat_id: string; content: string; type?: string; metadata?: Record<string, unknown> }) => void;
  'message:typing': (data: { chat_id: string; typing: boolean }) => void;
  'message:read': (data: { chat_id: string; message_id: string }) => void;
  'message:delete': (data: { chat_id: string; message_id: string; mode: 'for_me' | 'for_all' }, callback?: (response: { success?: boolean; error?: string }) => void) => void;
  'message:edit': (data: { chat_id: string; message_id: string; content: string }, callback?: (response: { success?: boolean; error?: string }) => void) => void;
  'call:initiate': (data: InitiateCallRequest, callback?: (response: { call_id?: string; error?: string }) => void) => void;
  'call:answer': (data: { call_id: string }, callback?: (response: { success: boolean }) => void) => void;
  'call:reject': (data: { call_id: string }) => void;
  'call:end': (data: { call_id: string }) => void;
  'call:leave': (data: { call_id: string }) => void;
  'call:signal': (data: { call_id: string; signal: unknown }) => void;
  'call:relay-request': (data: { call_id: string }) => void;
  'call:relay-audio': (data: { call_id: string; audio: string; seq: number }) => void;
  'call:relay-video': (data: { call_id: string; image: string; width?: number; height?: number; quality?: number; timestamp?: number }) => void;
  'call:switch-mode': (data: { call_id: string; mode: 'p2p' | 'relay' }) => void;
  'call:heartbeat': (data: { call_id: string }) => void;
  'presence:update': (data: { status: string }) => void;
  'p2p:signal': (data: { peer_id: string; signal: unknown }) => void;
}

// Socket события - сервер -> клиент
export interface ServerToClientEvents {
  'message:new': (message: MessageWithSender) => void;
  'message:updated': (message: Message) => void;
  'message:deleted': (data: { message_id: string; chat_id: string }) => void;
  'message:reaction': (data: { message_id: string; chat_id: string; reactions: ReactionSummary[] }) => void;
  'message:typing_status': (data: { chat_id: string; user_id: string; typing: boolean }) => void;
  'chat:new': (chat: Chat) => void;
  'chat:updated': (chat: Partial<Chat> & { id: string }) => void;
  'chat:deleted': (data: { chat_id: string }) => void;
  'call:incoming': (call: Call) => void;
  'call:answered': (data: { call_id: string; user_id: string }) => void;
  'call:rejected': (data: { call_id: string; user_id: string }) => void;
  'call:ended': (data: { call_id: string }) => void;
  'call:participant-left': (data: { call_id: string; user_id: string }) => void;
  'call:signal': (data: { call_id: string; user_id: string; signal: unknown }) => void;
  'call:relay-active': (data: { call_id: string; relay_by: string }) => void;
  'call:relay-audio': (data: { call_id: string; user_id: string; audio: string; seq: number }) => void;
  'call:relay-video': (data: { call_id: string; user_id: string; image: string; width?: number; height?: number; quality?: number; timestamp?: number }) => void;
  'call:mode-switched': (data: { call_id: string; user_id?: string; mode: 'p2p' | 'relay'; switched_by?: string }) => void;
  'call:heartbeat-ack': (data: { call_id: string; timestamp: number }) => void;
  'message:read_ack': (data: { chat_id: string; reader_id: string; read_at: string }) => void;
  'presence:changed': (data: { user_id: string; status: string }) => void;
  'user:online': (data: { user_id: string }) => void;
  // last_seen — когда человек ушёл. Без него собеседник видит время,
  // загруженное при открытии переписки, то есть заведомо устаревшее.
  'user:offline': (data: { user_id: string; last_seen: string | null }) => void;

  // Ход обработки загруженного файла ПОСЛЕ того, как долетели все куски.
  //
  // Раньше на этом месте была тишина: полоса показывала 100%, а файл ещё
  // несколько минут собирался и шифровался. Человек считал, что всё
  // повисло, и начинал загрузку заново — так один архив на четыре гигабайта
  // приехал на сервер трижды подряд.
  'upload:stage': (data: {
    sessionId: string;
    stage: 'assembling' | 'encrypting' | 'done' | 'failed';
    percent: number;          // общий ход, 0–100
    doneBytes?: number;
    totalBytes?: number;
    error?: string;
  }) => void;
  'users:online': (data: { user_ids: string[] }) => void;
  'p2p:signal': (data: { peer_id: string; signal: unknown }) => void;
}

// Mediasoup типы
export interface WebRtcTransportParams {
  id: string;
  iceParameters: unknown;
  iceCandidates: unknown[];
  dtlsParameters: unknown;
}

export interface ProducerParams {
  id: string;
  kind: 'audio' | 'video';
  rtpParameters: unknown;
}

export interface ConsumerParams {
  id: string;
  producerId: string;
  kind: 'audio' | 'video';
  rtpParameters: unknown;
}
