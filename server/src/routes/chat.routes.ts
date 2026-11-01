import { Router, Request, Response } from 'express';
import { chatService } from '../services/chat.service.js';
import { messageService } from '../services/message.service.js';
import { authMiddleware } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';
import { getIo, isUserOnline, emitToUser } from '../socket/index.js';
import { hasSSEClient, sseNotifyMessage } from '../services/sse-notify.service.js';
import { pushNewMessage } from '../services/push.service.js';
import { emailBridgeService } from '../services/email-bridge.service.js';
import { fileEncryption } from '../services/file-encryption.service.js';
import { transcriptionService } from '../services/transcription.service.js';
import { config } from '../config/index.js';
import { userService } from '../services/user.service.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import sharp from 'sharp';

const router = Router();

// === Аватары групп/каналов ===
const GROUP_AVATARS_DIR = path.join(process.cwd(), 'avatars', 'groups');
if (!fs.existsSync(GROUP_AVATARS_DIR)) {
  fs.mkdirSync(GROUP_AVATARS_DIR, { recursive: true });
}

const groupAvatarStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, GROUP_AVATARS_DIR),
  filename: (req, _file, cb) => {
    const chatId = req.params.chatId || 'unknown';
    cb(null, `${chatId}.tmp`);
  },
});

const groupAvatarUpload = multer({
  storage: groupAvatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      cb(new Error('Only images allowed'));
      return;
    }
    cb(null, true);
  },
});

// Настройка multer для голосовых сообщений
const voiceStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const voiceDir = path.join(config.storage.path, 'voice');
    if (!fs.existsSync(voiceDir)) {
      fs.mkdirSync(voiceDir, { recursive: true });
    }
    cb(null, voiceDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.webm';
    cb(null, `${randomUUID()}${ext}`);
  },
});

const voiceUpload = multer({
  storage: voiceStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only audio files are allowed.'));
    }
  },
});

// Все роуты требуют аутентификации
router.use(authMiddleware);

// Получить все чаты пользователя
router.get('/', (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const chats = chatService.getUserChats(userId, isUserOnline);

    // Добавляем количество непрочитанных для каждого чата
    const chatsWithUnread = chats.map(chat => ({
      ...chat,
      unreadCount: messageService.getUnreadCount(chat.id, userId),
    }));

    res.json({ chats: chatsWithUnread });
  } catch (error) {
    logger.error('Get chats error:', error);
    res.status(500).json({ error: 'Failed to get chats' });
  }
});

// Получить/создать чат "Избранное"
router.post('/favorites', (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const chat = chatService.getOrCreateFavorites(userId);
    const members = chatService.getChatMembers(chat.id);
    const unreadCount = messageService.getUnreadCount(chat.id, userId);
    res.json({ chat: { ...chat, members, unreadCount } });
  } catch (error) {
    logger.error('Get favorites error:', error);
    res.status(500).json({ error: 'Failed to get favorites chat' });
  }
});

// Создать приватный чат
router.post('/private', (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { user_id: otherUserId } = req.body;

    if (!otherUserId) {
      res.status(400).json({ error: 'user_id is required' });
      return;
    }

    if (userId === otherUserId) {
      res.status(400).json({ error: 'Cannot create chat with yourself' });
      return;
    }

    const chat = chatService.createPrivateChat(userId, otherUserId);
    const members = chatService.getChatMembers(chat.id);
    const chatWithMembers = { ...chat, members };

    // Уведомляем ТОЛЬКО участников нового чата (не всех подключённых!)
    const io = getIo();
    if (io) {
      for (const member of members) {
        emitToUser(io, member.id, 'chat:new', chatWithMembers);
      }
    }

    res.status(201).json({ chat: chatWithMembers });
  } catch (error) {
    logger.error('Create private chat error:', error);
    res.status(500).json({ error: 'Failed to create chat' });
  }
});

// Создать групповой чат
router.post('/group', (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { name, member_ids } = req.body;

    if (!name) {
      res.status(400).json({ error: 'Group name is required' });
      return;
    }

    if (!member_ids || !Array.isArray(member_ids) || member_ids.length === 0) {
      res.status(400).json({ error: 'At least one member is required' });
      return;
    }

    const chat = chatService.createGroupChat(userId, name, member_ids);
    const members = chatService.getChatMembers(chat.id);
    const chatWithMembers = { ...chat, members };

    // Уведомляем ТОЛЬКО участников нового чата
    const io = getIo();
    if (io) {
      for (const member of members) {
        emitToUser(io, member.id, 'chat:new', chatWithMembers);
      }
    }

    res.status(201).json({ chat: chatWithMembers });
  } catch (error) {
    logger.error('Create group chat error:', error);
    res.status(500).json({ error: 'Failed to create group chat' });
  }
});

// Создать канал
router.post('/channel', (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { name, member_ids } = req.body;

    if (!name) {
      res.status(400).json({ error: 'Channel name is required' });
      return;
    }

    const ids = Array.isArray(member_ids) ? member_ids : [];
    const chat = chatService.createChannel(userId, name, ids);
    const members = chatService.getChatMembers(chat.id);
    const chatWithMembers = { ...chat, members };

    // Уведомляем ТОЛЬКО участников нового канала
    const io = getIo();
    if (io) {
      for (const member of members) {
        emitToUser(io, member.id, 'chat:new', chatWithMembers);
      }
    }

    res.status(201).json({ chat: chatWithMembers });
  } catch (error) {
    logger.error('Create channel error:', error);
    res.status(500).json({ error: 'Failed to create channel' });
  }
});

// Получить информацию о чате
router.get('/:chatId', (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { chatId } = req.params;

    if (!chatService.isChatMember(chatId, userId)) {
      res.status(403).json({ error: 'Not a member of this chat' });
      return;
    }

    const chat = chatService.findById(chatId);
    if (!chat) {
      res.status(404).json({ error: 'Chat not found' });
      return;
    }

    const members = chatService.getChatMembers(chatId);
    const unreadCount = messageService.getUnreadCount(chatId, userId);

    res.json({ chat: { ...chat, members, unreadCount } });
  } catch (error) {
    logger.error('Get chat error:', error);
    res.status(500).json({ error: 'Failed to get chat' });
  }
});

// Получить медиафайлы чата (по типу)
router.get('/:chatId/media', (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { chatId } = req.params;
    const { type, limit, offset } = req.query;

    if (!chatService.isChatMember(chatId, userId)) {
      res.status(403).json({ error: 'Not a member of this chat' });
      return;
    }

    const typeMap: Record<string, string[]> = {
      media: ['image', 'video'],
      files: ['file'],
      music: ['audio'],
      voice: ['voice'],
      links: [],
    };

    const filterType = (type as string) || 'media';
    const lim = limit ? parseInt(limit as string, 10) : 50;
    const off = offset ? parseInt(offset as string, 10) : 0;

    if (filterType === 'links') {
      const messages = messageService.getChatLinks(chatId, userId, lim, off);
      res.json({ messages });
      return;
    }

    const types = typeMap[filterType] || [filterType];
    const messages = messageService.getChatMedia(chatId, userId, types, lim, off);
    res.json({ messages });
  } catch (error) {
    logger.error('Get chat media error:', error);
    res.status(500).json({ error: 'Failed to get chat media' });
  }
});

// Поиск сообщений внутри конкретного чата
router.get('/:chatId/messages/search', (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { chatId } = req.params;
    const { q, limit } = req.query;

    if (!chatService.isChatMember(chatId, userId)) {
      res.status(403).json({ error: 'Not a member of this chat' });
      return;
    }
    if (!q) {
      res.status(400).json({ error: 'Search query is required' });
      return;
    }

    const messages = messageService.searchChatMessages(
      chatId,
      userId,
      q as string,
      limit ? parseInt(limit as string, 10) : 50
    );
    res.json({ messages });
  } catch (error) {
    logger.error('Search chat messages error:', error);
    res.status(500).json({ error: 'Failed to search chat messages' });
  }
});

// Получить сообщения чата
router.get('/:chatId/messages', (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { chatId } = req.params;
    const { before, limit, around } = req.query;

    if (!chatService.isChatMember(chatId, userId)) {
      res.status(403).json({ error: 'Not a member of this chat' });
      return;
    }

    // Jump-to-message: загрузить сообщения вокруг конкретного ID
    if (around) {
      const messages = messageService.getMessagesAround(
        chatId,
        around as string,
        limit ? parseInt(limit as string, 10) : 25,
        userId
      );
      const messageIds = messages.map(m => m.id);
      const reactionsBatch = messageService.getReactionsBatch(messageIds);
      const readStatusMap = messageService.getReadStatusMap(chatId, userId, isUserOnline);
      const messagesWithStatus = messages.map(msg => ({
        ...msg,
        status: msg.sender_id === userId ? (readStatusMap[msg.id] || 'sent') : undefined,
        reactions: reactionsBatch[msg.id] || [],
      }));
      res.json({ messages: messagesWithStatus });
      return;
    }

    const messages = messageService.getChatMessages(
      chatId,
      limit ? parseInt(limit as string, 10) : 50,
      before as string | undefined,
      userId
    );

    // Добавляем статусы прочтения для собственных сообщений
    const readStatusMap = messageService.getReadStatusMap(chatId, userId, isUserOnline);

    // Добавляем реакции (batch)
    const messageIds = messages.map(m => m.id);
    const reactionsBatch = messageService.getReactionsBatch(messageIds);

    const messagesWithStatus = messages.map(msg => ({
      ...msg,
      status: msg.sender_id === userId ? (readStatusMap[msg.id] || 'sent') : undefined,
      reactions: reactionsBatch[msg.id] || [],
    }));

    res.json({ messages: messagesWithStatus });
  } catch (error) {
    logger.error('Get messages error:', error);
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

// Повтор из очереди клиента. Таймаут на телефоне не значит, что сервер
// запрос не получил: ответ мог потеряться на обратном пути. Клиент
// присылает свой client_id; второй приход возвращает уже сохранённое.
// Номер хранится в базе (messages.client_id) — переживает перезапуск и
// заодно склеивает копии, пришедшие получателю по mesh или LoRa.
// Отправить сообщение
router.post('/:chatId/messages', (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { chatId } = req.params;
    const { content, type, reply_to_id, metadata, client_id } = req.body;

    if (!content && type === 'text') {
      res.status(400).json({ error: 'Message content is required' });
      return;
    }

    if (!chatService.isChatMember(chatId, userId)) {
      res.status(403).json({ error: 'Not a member of this chat' });
      return;
    }

    const clientId = typeof client_id === 'string' && client_id.length > 0 && client_id.length <= 100 ? client_id : undefined;
    if (clientId) {
      const existing = messageService.findByClientId(chatId, userId, clientId);
      if (existing) {
        res.status(200).json({ message: existing, duplicate: true });
        return;
      }
    }

    const message = messageService.sendMessage(chatId, userId, {
      content,
      type: type || 'text',
      reply_to_id,
      metadata,
      client_id: clientId,
    });

    if (!message) {
      res.status(500).json({ error: 'Failed to send message' });
      return;
    }

    // Отправляем событие всем участникам чата
    const io = getIo();
    if (io) {
      io.to(`chat:${chatId}`).emit('message:new', message);
    }

    // SSE + Push для фоновых уведомлений (Android APK)
    try {
      const chatMembers = chatService.getChatMembers(chatId);
      const sender = userService.findById(userId);
      const senderName = sender?.username || 'Кто-то';
      for (const member of chatMembers) {
        if (member.id === userId) continue;
        if (!isUserOnline(member.id)) {
          pushNewMessage(member.id, senderName, content || '', chatId, userId).catch(() => {});
          // SSE только для офлайн-юзеров (онлайн получают через socket)
          if (hasSSEClient(member.id)) {
            const text = content || '';
            const avatarUrl = sender?.avatar_url || '';
            sseNotifyMessage(member.id, senderName, text, chatId, avatarUrl, (message as any).id, userId);
          }
          // Email Bridge для офлайн-юзеров
          if (emailBridgeService.isEnabledForUser(member.id)) {
            const chat = chatService.findById(chatId);
            const chatName = chat?.name || 'Чат';
            emailBridgeService.queueMessage(member.id, senderName, content || '', chatId, chatName, (message as any).id);
          }
        }
      }
    } catch (e) {
      logger.error('[REST MSG-NOTIFY] Error:', e);
    }

    res.status(201).json({ message });
  } catch (error) {
    logger.error('Send message error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Удалить сообщение
router.delete('/:chatId/messages/:messageId', (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { chatId, messageId } = req.params;
    const { mode } = req.query; // 'for_me' | 'for_all'

    if (!chatService.isChatMember(chatId, userId)) {
      res.status(403).json({ error: 'Not a member of this chat' });
      return;
    }

    if (mode === 'for_all') {
      // Удалить для всех — только отправитель может
      const success = messageService.deleteMessage(messageId, userId);
      if (!success) {
        res.status(403).json({ error: 'Cannot delete this message for everyone' });
        return;
      }

      // Уведомляем всех участников чата
      const io = getIo();
      if (io) {
        io.to(`chat:${chatId}`).emit('message:deleted', { message_id: messageId, chat_id: chatId });
      }
    } else {
      // Удалить только для себя
      const success = messageService.deleteMessageForMe(messageId, userId);
      if (!success) {
        res.status(400).json({ error: 'Cannot delete this message' });
        return;
      }
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Delete message error:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// Пометить сообщения как прочитанные
router.post('/:chatId/read', (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { chatId } = req.params;
    const { message_id } = req.body;

    if (!message_id) {
      res.status(400).json({ error: 'message_id is required' });
      return;
    }

    messageService.markAsRead(chatId, userId, message_id);

    // Уведомляем отправителя что сообщения прочитаны
    const io = getIo();
    if (io) {
      io.to(`chat:${chatId}`).emit('message:read_ack' as any, {
        chat_id: chatId,
        reader_id: userId,
        read_at: new Date().toISOString(),
      });
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Mark as read error:', error);
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

// Добавить участника в группу
router.post('/:chatId/members', (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { chatId } = req.params;
    const { user_id: newMemberId } = req.body;

    if (!newMemberId) {
      res.status(400).json({ error: 'user_id is required' });
      return;
    }

    const success = chatService.addMember(chatId, newMemberId, userId);
    if (!success) {
      res.status(403).json({ error: 'Cannot add member (not authorized or already a member)' });
      return;
    }

    const members = chatService.getChatMembers(chatId);
    res.json({ members });
  } catch (error) {
    logger.error('Add member error:', error);
    res.status(500).json({ error: 'Failed to add member' });
  }
});

// Удалить участника из группы
router.delete('/:chatId/members/:memberId', (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { chatId, memberId } = req.params;

    const success = chatService.removeMember(chatId, memberId, userId);
    if (!success) {
      res.status(403).json({ error: 'Cannot remove member (not authorized)' });
      return;
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Remove member error:', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

// Отправить голосовое сообщение
router.post('/:chatId/voice', voiceUpload.single('audio'), async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { chatId } = req.params;
    const { duration } = req.body;

    if (!chatService.isChatMember(chatId, userId)) {
      res.status(403).json({ error: 'Not a member of this chat' });
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: 'Audio file is required' });
      return;
    }

    // Шифруем голосовой файл после записи multer'ом
    const voicePath = req.file.path;
    await fileEncryption.encryptFile(voicePath);

    // Также реплицируем на RAID если включён
    if (config.storage.raidEnabled && config.storage.raidPaths.length > 0) {
      for (const raidPath of config.storage.raidPaths) {
        const raidVoiceDir = path.join(raidPath, 'voice');
        if (!fs.existsSync(raidVoiceDir)) {
          fs.mkdirSync(raidVoiceDir, { recursive: true });
        }
        const raidDest = path.join(raidVoiceDir, req.file.filename);
        try {
          // Копируем уже зашифрованный файл
          await fs.promises.copyFile(voicePath, raidDest);
        } catch (err) {
          logger.warn(`RAID voice replication failed for ${raidPath}:`, err);
        }
      }
    }

    // Создаём сообщение с типом voice
    const metadata = {
      filename: req.file.filename,
      originalName: req.file.originalname,
      duration: duration ? parseInt(duration, 10) : 0,
      mimetype: req.file.mimetype,
      size: req.file.size,
    };

    const message = messageService.sendMessage(chatId, userId, {
      content: '',
      type: 'voice',
      metadata,
    });

    if (!message) {
      res.status(500).json({ error: 'Failed to send voice message' });
      return;
    }

    // Отправляем событие всем участникам чата
    const io = getIo();
    if (io) {
      io.to(`chat:${chatId}`).emit('message:new', message);
    }

    // SSE + Push для фоновых уведомлений голосовых (Android APK)
    try {
      const chatMembers = chatService.getChatMembers(chatId);
      const sender = userService.findById(userId);
      const senderName = sender?.username || 'Кто-то';
      for (const member of chatMembers) {
        if (member.id === userId) continue;
        if (!isUserOnline(member.id)) {
          pushNewMessage(member.id, senderName, '🎙 Голосовое сообщение', chatId, userId).catch(() => {});
          if (hasSSEClient(member.id)) {
            const avatarUrl = sender?.avatar_url || '';
            sseNotifyMessage(member.id, senderName, '🎙 Голосовое сообщение', chatId, avatarUrl, (message as any).id, userId);
          }
          // Email Bridge для голосовых
          if (emailBridgeService.isEnabledForUser(member.id)) {
            const chat = chatService.findById(chatId);
            const chatName = chat?.name || 'Чат';
            emailBridgeService.queueMessage(member.id, senderName, '🎙 Голосовое сообщение', chatId, chatName, (message as any).id);
          }
        }
      }
    } catch (e) {
      logger.error('[REST VOICE-NOTIFY] Error:', e);
    }

    // === Фоновая транскрипция голосового сообщения (Vosk ru-0.42) ===
    // Не блокируем ответ — расшифровываем асинхронно
    (async () => {
      try {
        let transcribeFilePath = voicePath;
        let tempPath: string | null = null;

        // Если файл зашифрован, расшифровываем во временный
        if (fileEncryption.isEnabled()) {
          const tempDir = path.join(config.storage.path, 'temp');
          if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
          tempPath = path.join(tempDir, `transcribe_${req.file!.filename}`);
          const encrypted = await fs.promises.readFile(voicePath);
          const decrypted = fileEncryption.decryptBuffer(encrypted);
          await fs.promises.writeFile(tempPath, decrypted);
          transcribeFilePath = tempPath;
        }

        const result = await transcriptionService.transcribe(transcribeFilePath, 'ru');

        // Удаляем временный файл
        if (tempPath && fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }

        if (result.text && result.text.trim()) {
          // Обновляем metadata сообщения с транскриптом
          const updatedMetadata = { ...metadata, transcript: result.text.trim() };
          messageService.updateMessageMetadata(message.id, updatedMetadata);

          // Уведомляем клиентов об обновлении
          if (io) {
            const updatedMessage: any = { ...message, metadata: updatedMetadata };
            io.to(`chat:${chatId}`).emit('message:updated', updatedMessage);
          }
          logger.info(`Voice transcribed: ${message.id} (${result.text.trim().length} chars)`);
        }
      } catch (err) {
        logger.warn('Background voice transcription failed:', err);
      }
    })();

    res.status(201).json({ message });
  } catch (error) {
    logger.error('Send voice message error:', error);
    res.status(500).json({ error: 'Failed to send voice message' });
  }
});

// Покинуть чат
router.post('/:chatId/leave', (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { chatId } = req.params;

    const success = chatService.leaveChat(chatId, userId);
    if (!success) {
      res.status(400).json({ error: 'Cannot leave chat' });
      return;
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Leave chat error:', error);
    res.status(500).json({ error: 'Failed to leave chat' });
  }
});

// Удалить чат
router.delete('/:chatId', (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { chatId } = req.params;

    const success = chatService.deleteChat(chatId, userId);
    if (!success) {
      res.status(403).json({ error: 'Cannot delete chat (not authorized)' });
      return;
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Delete chat error:', error);
    res.status(500).json({ error: 'Failed to delete chat' });
  }
});

// Поиск сообщений
router.get('/search/messages', (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { q, limit } = req.query;

    if (!q) {
      res.status(400).json({ error: 'Search query is required' });
      return;
    }

    const messages = messageService.searchMessages(
      userId,
      q as string,
      limit ? parseInt(limit as string, 10) : 50
    );

    res.json({ messages });
  } catch (error) {
    logger.error('Search messages error:', error);
    res.status(500).json({ error: 'Failed to search messages' });
  }
});

// === Аватар группы/канала ===
router.post('/:chatId/avatar', authMiddleware, groupAvatarUpload.single('file'), async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { chatId } = req.params;

    const chat = chatService.findById(chatId);
    if (!chat || chat.type === 'private') {
      res.status(400).json({ error: 'Can only set avatar for groups/channels' });
      return;
    }

    if (!chatService.isChatMember(chatId, userId)) {
      res.status(403).json({ error: 'Not a member of this chat' });
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: 'No image uploaded' });
      return;
    }

    const tmpPath = req.file.path;
    const finalName = `${chatId}.webp`;
    const finalPath = path.join(GROUP_AVATARS_DIR, finalName);

    try {
      await sharp(tmpPath)
        .resize(256, 256, { fit: 'cover', position: 'center' })
        .webp({ quality: 85 })
        .toFile(finalPath);
    } catch {
      logger.warn('sharp not available for group avatar, saving as-is');
      fs.copyFileSync(tmpPath, path.join(GROUP_AVATARS_DIR, `${chatId}.jpg`));
    }

    try { fs.unlinkSync(tmpPath); } catch {}

    const avatarUrl = `/api/avatars/groups/${finalName}`;
    chatService.updateChatAvatar(chatId, avatarUrl);

    const io = getIo();
    if (io) {
      io.to(`chat:${chatId}`).emit('chat:updated' as any, { id: chatId, avatar_url: avatarUrl });
    }

    logger.info(`Group avatar uploaded for chat ${chatId}`);
    res.status(201).json({ avatarUrl });
  } catch (error) {
    logger.error('Group avatar upload error:', error);
    if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: 'Failed to upload group avatar' });
  }
});

// === Реакция на сообщение (toggle) ===
router.post('/:chatId/messages/:messageId/reactions', (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { chatId, messageId } = req.params;
    const { emoji } = req.body;

    if (!emoji || typeof emoji !== 'string') {
      res.status(400).json({ error: 'emoji is required' });
      return;
    }

    if (!chatService.isChatMember(chatId, userId)) {
      res.status(403).json({ error: 'Not a member of this chat' });
      return;
    }

    messageService.toggleReaction(messageId, userId, emoji);
    const reactions = messageService.getReactions(messageId);

    // Рассылаем обновлённые реакции всем в чате
    const io = getIo();
    if (io) {
      io.to(`chat:${chatId}`).emit('message:reaction' as any, {
        message_id: messageId,
        chat_id: chatId,
        reactions,
      });
    }

    res.json({ reactions });
  } catch (error) {
    logger.error('Toggle reaction error:', error);
    res.status(500).json({ error: 'Failed to toggle reaction' });
  }
});

export default router;
