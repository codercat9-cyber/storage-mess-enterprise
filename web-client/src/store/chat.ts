import { create } from 'zustand';
import { Chat, Message, User } from '@/types';

interface ChatState {
  chats: Chat[];
  currentChat: Chat | null;
  messages: Record<string, Message[]>;
  hasMoreMessages: Record<string, boolean>; // chatId -> has older messages
  typingUsers: Record<string, string[]>; // chatId -> userIds
  onlineUsers: Set<string>;
  
  setChats: (chats: Chat[]) => void;
  addChat: (chat: Chat) => void;
  updateChat: (chatId: string, updates: Partial<Chat>) => void;
  removeChat: (chatId: string) => void;
  
  setCurrentChat: (chat: Chat | null) => void;
  
  setMessages: (chatId: string, messages: Message[]) => void;
  prependMessages: (chatId: string, olderMessages: Message[]) => void;
  setHasMoreMessages: (chatId: string, hasMore: boolean) => void;
  addMessage: (message: Message) => void;
  updateMessage: (messageId: string, updates: Partial<Message>) => void;
  replacePendingMessage: (pendingId: string, realMessage: Message) => void;
  removeMessage: (chatId: string, messageId: string) => void;
  
  setTyping: (chatId: string, userId: string, isTyping: boolean) => void;
  
  setUserOnline: (userId: string) => void;
  setUserOffline: (userId: string, lastSeen?: string | null) => void;
  setOnlineUsers: (userIds: string[]) => void;
  
  incrementUnread: (chatId: string) => void;
  clearUnread: (chatId: string) => void;
  markMessagesRead: (chatId: string, readerId: string) => void;
  updateMemberProfile: (userId: string, profile: { display_name?: string; avatar_url?: string }) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  chats: [],
  currentChat: null,
  messages: {},
  hasMoreMessages: {},
  typingUsers: {},
  onlineUsers: new Set(),

  setChats: (chats) => set({ chats }),
  
  addChat: (chat) => set((state) => ({
    chats: [chat, ...state.chats.filter(c => c.id !== chat.id)],
  })),
  
  updateChat: (chatId, updates) => set((state) => ({
    chats: state.chats.map(c => c.id === chatId ? { ...c, ...updates } : c),
    currentChat: state.currentChat?.id === chatId 
      ? { ...state.currentChat, ...updates } 
      : state.currentChat,
  })),
  
  removeChat: (chatId) => set((state) => ({
    chats: state.chats.filter(c => c.id !== chatId),
    currentChat: state.currentChat?.id === chatId ? null : state.currentChat,
  })),

  setCurrentChat: (chat) => set({ currentChat: chat }),

  setMessages: (chatId, messages) => set((state) => {
    // Перезагрузка истории с сервера/кэша не должна стирать то, чего на
    // сервере ещё нет: черновики из очереди (pending-) и копии, пришедшие
    // по mesh/LoRa (mesh-). Раньше mesh-копии пропадали при каждом
    // перезапросе истории — сообщение из аварийной сети исчезало с экрана.
    const existing = state.messages[chatId] || [];
    const isLocal = (m: Message) => m.id.startsWith('pending-') || m.id.startsWith('mesh-');
    const serverCids = new Set(messages.map(m => m.client_id).filter(Boolean) as string[]);
    const unresolved = existing.filter(l => {
      if (!isLocal(l)) return false;
      const cid = l.client_id || (l.id.startsWith('pending-') ? l.id : undefined);
      if (cid && serverCids.has(cid)) return false;
      // Старые сборки сервера client_id не отдают — прежняя сверка по тексту
      return !messages.some(m => !isLocal(m) && m.sender_id === l.sender_id && m.content === l.content
                                 && (!m.client_id || !cid));
    });
    const merged = unresolved.length
      ? [...messages, ...unresolved].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      : messages;
    return {
      messages: { ...state.messages, [chatId]: merged },
    };
  }),

  prependMessages: (chatId, olderMessages) => set((state) => {
    const existing = state.messages[chatId] || [];
    const existingIds = new Set(existing.map(m => m.id));
    const unique = olderMessages.filter(m => !existingIds.has(m.id));
    return {
      messages: { ...state.messages, [chatId]: [...unique, ...existing] },
    };
  }),

  setHasMoreMessages: (chatId, hasMore) => set((state) => ({
    hasMoreMessages: { ...state.hasMoreMessages, [chatId]: hasMore },
  })),
  
  addMessage: (message) => set((state) => {
    const chatMessages = state.messages[message.chat_id] || [];
    // Проверяем, нет ли уже такого сообщения (по id)
    if (chatMessages.some(m => m.id === message.id)) {
      return state;
    }

    // Склейка по сквозному номеру: черновик (его id и есть client_id), копия
    // из mesh/LoRa и копия с сервера — одно сообщение. Серверная главнее:
    // она заменяет черновик и mesh-копию, а не наоборот.
    if (message.client_id) {
      const cid = message.client_id;
      const idx = chatMessages.findIndex(m => m.id === cid || m.client_id === cid);
      if (idx >= 0) {
        const cur = chatMessages[idx];
        const curIsServer = !cur.id.startsWith('pending-') && !cur.id.startsWith('mesh-');
        const newIsServer = !message.id.startsWith('pending-') && !message.id.startsWith('mesh-');
        if (curIsServer || !newIsServer) return state;
        const updated = [...chatMessages];
        updated[idx] = message;
        return { messages: { ...state.messages, [message.chat_id]: updated } };
      }
    }

    // Если это реальное сообщение от сервера — заменяем pending от того же отправителя
    // (socket message:new может прийти раньше REST-ответа)
    let replaced = false;
    let updatedMessages = chatMessages;
    if (!message.id.startsWith('pending-') && message.sender_id) {
      const pendingIdx = chatMessages.findIndex(m => 
        m.id.startsWith('pending-') && 
        m.sender_id === message.sender_id &&
        m.content === message.content
      );
      if (pendingIdx >= 0) {
        updatedMessages = [...chatMessages];
        updatedMessages[pendingIdx] = message;
        replaced = true;
      }
    }

    if (!replaced) {
      updatedMessages = [...chatMessages, message];
    }
    
    return {
      messages: {
        ...state.messages,
        [message.chat_id]: updatedMessages,
      },
      chats: state.chats.map(c => 
        c.id === message.chat_id 
          ? { ...c, lastMessage: message, updated_at: message.created_at }
          : c
      ).sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()),
    };
  }),
  
  updateMessage: (messageId, updates) => set((state) => {
    const newMessages: Record<string, Message[]> = {};
    for (const [chatId, msgs] of Object.entries(state.messages)) {
      newMessages[chatId] = msgs.map(m => 
        m.id === messageId ? { ...m, ...updates } : m
      );
    }
    return { messages: newMessages };
  }),

  // Заменяет оптимистичное (pending) сообщение на реальное от сервера
  replacePendingMessage: (pendingId, realMessage) => set((state) => {
    const chatId = realMessage.chat_id;
    const chatMessages = state.messages[chatId] || [];
    // Проверяем что реальное не дубликат
    if (chatMessages.some(m => m.id === realMessage.id)) {
      // Уже есть — просто удаляем pending
      return {
        messages: {
          ...state.messages,
          [chatId]: chatMessages.filter(m => m.id !== pendingId),
        },
      };
    }
    return {
      messages: {
        ...state.messages,
        [chatId]: chatMessages.map(m => m.id === pendingId ? realMessage : m),
      },
      chats: state.chats.map(c =>
        c.id === chatId
          ? { ...c, lastMessage: realMessage, updated_at: realMessage.created_at }
          : c
      ).sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()),
    };
  }),
  
  removeMessage: (chatId, messageId) => set((state) => ({
    messages: {
      ...state.messages,
      [chatId]: (state.messages[chatId] || []).filter(m => m.id !== messageId),
    },
  })),

  setTyping: (chatId, userId, isTyping) => set((state) => {
    const current = state.typingUsers[chatId] || [];
    let updated: string[];
    
    if (isTyping) {
      updated = current.includes(userId) ? current : [...current, userId];
    } else {
      updated = current.filter(id => id !== userId);
    }
    
    return {
      typingUsers: { ...state.typingUsers, [chatId]: updated },
    };
  }),

  setUserOnline: (userId) => set((state) => {
    const newSet = new Set(state.onlineUsers);
    newSet.add(userId);
    return { onlineUsers: newSet };
  }),
  
  setUserOffline: (userId, lastSeen) => set((state) => {
    const newSet = new Set(state.onlineUsers);
    newSet.delete(userId);
    if (!lastSeen) return { onlineUsers: newSet };

    // Заодно обновляем отметку «был(а) в сети».
    //
    // Без неё показывалось время, загруженное при открытии переписки: в
    // списке человек значился вышедшим час или три назад, хотя закрыл
    // приложение только что. Сервер теперь присылает отметку вместе с
    // событием — остаётся положить её на место.
    const chats = state.chats.map(chat => {
      const other: any = (chat as any).other_user;
      if (other && other.id === userId) {
        return { ...chat, other_user: { ...other, last_seen: lastSeen, status: 'offline' } } as typeof chat;
      }
      const members = (chat as any).members;
      if (Array.isArray(members) && members.some((m: any) => m.user_id === userId || m.id === userId)) {
        return {
          ...chat,
          members: members.map((m: any) =>
            (m.user_id === userId || m.id === userId)
              ? { ...m, last_seen: lastSeen, status: 'offline' }
              : m),
        } as typeof chat;
      }
      return chat;
    });

    const cur: any = state.currentChat;
    let currentChat = state.currentChat;
    if (cur?.other_user?.id === userId) {
      currentChat = { ...cur, other_user: { ...cur.other_user, last_seen: lastSeen, status: 'offline' } };
    }

    return { onlineUsers: newSet, chats, currentChat };
  }),
  
  setOnlineUsers: (userIds) => set({
    onlineUsers: new Set(userIds),
  }),

  incrementUnread: (chatId) => set((state) => ({
    chats: state.chats.map(c => 
      c.id === chatId ? { ...c, unreadCount: (c.unreadCount || 0) + 1 } : c
    ),
  })),
  
  clearUnread: (chatId) => set((state) => ({
    chats: state.chats.map(c => 
      c.id === chatId ? { ...c, unreadCount: 0 } : c
    ),
  })),

  markMessagesRead: (chatId, readerId) => set((state) => ({
    messages: {
      ...state.messages,
      [chatId]: (state.messages[chatId] || []).map(m =>
        m.sender_id !== readerId && m.status !== 'read'
          ? { ...m, status: 'read' as const }
          : m
      ),
    },
    // Обновляем lastMessage.status в списке чатов (для галочек ✓✓ в sidebar)
    chats: state.chats.map(c =>
      c.id === chatId && c.lastMessage && (c.lastMessage as any).sender_id !== readerId
        ? { ...c, lastMessage: { ...c.lastMessage, status: 'read' } }
        : c
    ),
  })),

  updateMemberProfile: (userId, profile) => set((state) => {
    const updateMembers = (members?: any[]) =>
      members?.map((m: any) =>
        m.id === userId ? { ...m, ...profile } : m
      );
    return {
      chats: state.chats.map(c => ({
        ...c,
        members: updateMembers(c.members),
      })),
      currentChat: state.currentChat
        ? { ...state.currentChat, members: updateMembers(state.currentChat.members) }
        : null,
    };
  }),
}));

export default useChatStore;

// Для автотестов аварийного режима (scripts/offline-suite.cjs): хранилище
// видно снаружи только с флагом smess_test — у обычных пользователей его нет.
try {
  if (typeof window !== 'undefined' && localStorage.getItem('smess_test') === '1') {
    (window as any).__chatStore = useChatStore;
  }
} catch { /* приватный режим */ }
