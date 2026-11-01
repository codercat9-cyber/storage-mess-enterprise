// Типы для клиента

export interface User {
  id: string;
  username: string;
  display_name?: string;
  avatar_url?: string;
  status: 'online' | 'offline' | 'away' | 'busy';
  last_seen?: string;
}

export interface Chat {
  id: string;
  type: 'private' | 'group' | 'channel' | 'favorites';
  name?: string;
  avatar_url?: string;
  created_by?: string;
  members: User[];
  lastMessage?: Message;
  unreadCount: number;
  created_at: string;
  updated_at: string;
}

export interface ReactionSummary {
  emoji: string;
  count: number;
  users: { id: string; username: string; display_name?: string; avatar_url?: string }[];
}

export interface Message {
  id: string;
  // Сквозной номер от отправителя: один и тот же на сервере, в BLE-mesh и LoRa
  client_id?: string | null;
  chat_id: string;
  sender_id: string;
  sender: User;
  reply_to_id?: string;
  content?: string;
  type: 'text' | 'image' | 'video' | 'audio' | 'file' | 'voice' | 'gif' | 'system';
  metadata?: Record<string, unknown>;
  status?: 'pending' | 'sent' | 'delivered' | 'read';
  reactions?: ReactionSummary[];
  edited_at?: string;
  deleted_at?: string;
  created_at: string;
}

export interface FileInfo {
  id: string;
  original_name: string;
  mime_type?: string;
  size: number;
  is_public: boolean;
  download_count: number;
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
  participants: CallParticipant[];
}

export interface CallParticipant {
  user_id: string;
  status: 'invited' | 'ringing' | 'connected' | 'left';
}

export interface Contact {
  id: string;
  user: User;
  created_at: string;
}

export interface ContactRequest {
  id: string;
  user: User;
  created_at: string;
}

export interface UserSettings {
  theme: 'light' | 'dark' | 'system';
  language: string;
  notifications_enabled: boolean;
  sound_enabled: boolean;
}

// API Response типы
export interface AuthResponse {
  user: User;
  accessToken: string;
  refreshToken: string;
}

export interface ApiError {
  error: string;
}
