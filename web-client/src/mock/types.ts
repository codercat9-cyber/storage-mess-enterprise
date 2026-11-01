/** Type definitions for the Telegram UI clone mock data */

export interface MockUser {
  id: string;
  name: string;
  avatar: string | null;
  online: boolean;
}

export interface MockLastMessage {
  text: string;
  timestamp: string;
  isOwn: boolean;
  isRead: boolean;
}

export interface MockChat {
  id: string;
  user: MockUser;
  lastMessage: MockLastMessage;
  unreadCount: number;
  isPinned: boolean;
}

export interface MockMessage {
  id: string;
  chatId: string;
  senderId: string;
  text: string;
  timestamp: string;
  isOwn: boolean;
  isRead: boolean;
}
