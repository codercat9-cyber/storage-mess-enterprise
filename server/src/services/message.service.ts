import { v4 as uuidv4 } from 'uuid';
import { dbUtils } from '../database/index.js';
import { Message, MessageWithSender, UserPublic, SendMessageRequest } from '../types/index.js';
import { chatService } from './chat.service.js';
import { userService } from './user.service.js';
import { logger } from '../utils/logger.js';

export class MessageService {
  // Помощник для парсинга metadata
  private parseMetadata(metadata: string | null): any {
    if (!metadata) return null;
    if (typeof metadata === 'object') return metadata; // уже распарсено
    const trimmed = metadata.trim();
    if (trimmed === '' || trimmed === 'undefined' || trimmed === 'null') return null;
    try {
      return JSON.parse(trimmed);
    } catch (e) {
      // Не спамим warn — это некритичная ошибка (битые старые записи)
      logger.debug(`Non-parseable message metadata: ${trimmed.substring(0, 100)}`);
      return null;
    }
  }

  // Получить статусы прочтения для сообщений текущего юзера в чате
  // isRecipientOnline — callback, чтобы не создавать circular dependency с socket
  getReadStatusMap(chatId: string, senderUserId: string, isRecipientOnlineFn?: (userId: string) => boolean): Record<string, 'sent' | 'delivered' | 'read'> {
    // Получаем last_read_at всех ДРУГИХ участников чата
    const otherMembers = dbUtils.all<{ user_id: string; last_read_at: string | null }>(
      'SELECT user_id, last_read_at FROM chat_members WHERE chat_id = ? AND user_id != ?',
      [chatId, senderUserId]
    );

    // Для каждого чужого участника берём max last_read_at
    let maxReadAt: string | null = null;
    for (const m of otherMembers) {
      if (m.last_read_at && (!maxReadAt || m.last_read_at > maxReadAt)) {
        maxReadAt = m.last_read_at;
      }
    }

    // Получаем все сообщения текущего юзера в чате
    const ownMessages = dbUtils.all<{ id: string; created_at: string }>(
      'SELECT id, created_at FROM messages WHERE chat_id = ? AND sender_id = ? AND deleted_at IS NULL',
      [chatId, senderUserId]
    );

    // Проверяем, кто из получателей сейчас онлайн
    const anyRecipientOnline = isRecipientOnlineFn
      ? otherMembers.some(m => isRecipientOnlineFn(m.user_id))
      : false;

    const result: Record<string, 'sent' | 'delivered' | 'read'> = {};
    for (const msg of ownMessages) {
      if (maxReadAt && msg.created_at <= maxReadAt) {
        result[msg.id] = 'read';
      } else if (anyRecipientOnline) {
        result[msg.id] = 'delivered';
      } else {
        result[msg.id] = 'sent';
      }
    }
    return result;
  }
  // Отправка сообщения
  sendMessage(chatId: string, senderId: string, data: SendMessageRequest): MessageWithSender | null {
    // Проверяем принадлежность к чату
    if (!chatService.isChatMember(chatId, senderId)) {
      return null;
    }

    const messageId = uuidv4();
    const now = new Date().toISOString();
    const metadata = data.metadata ? JSON.stringify(data.metadata) : null;
    const clientId = typeof data.client_id === 'string' && data.client_id.length <= 100 ? data.client_id : null;

    dbUtils.run(
      `INSERT INTO messages (id, chat_id, sender_id, reply_to_id, content, type, metadata, created_at, client_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [messageId, chatId, senderId, data.reply_to_id || null, data.content, data.type || 'text', metadata, now, clientId]
    );

    // Обновляем время чата
    chatService.updateChatTimestamp(chatId);

    const message = this.findById(messageId);
    if (!message) return null;

    const sender = userService.findById(senderId);
    if (!sender) return null;

    logger.info(`Message sent in chat ${chatId} by ${senderId}`);

    return {
      ...message,
      metadata: this.parseMetadata(message.metadata as any),
      sender: userService.getPublicProfile(sender),
    };
  }

  /** Уже сохранённое сообщение с этим client_id (повтор из очереди или копия из mesh). */
  findByClientId(chatId: string, senderId: string, clientId: string): MessageWithSender | null {
    const row = dbUtils.get<{ id: string }>(
      'SELECT id FROM messages WHERE sender_id = ? AND client_id = ? AND chat_id = ? AND deleted_at IS NULL',
      [senderId, clientId, chatId]);
    if (!row) return null;
    const message = this.findById(row.id);
    const sender = userService.findById(senderId);
    if (!message || !sender) return null;
    return { ...message, sender: userService.getPublicProfile(sender) } as MessageWithSender;
  }

  // Поиск сообщения по ID
  findById(messageId: string): Message | undefined {
    const message = dbUtils.get<Message>(
      'SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL',
      [messageId]
    );
    if (message) {
      message.metadata = this.parseMetadata(message.metadata as any);
    }
    return message;
  }

  // Получить сообщения чата с пагинацией
  getChatMessages(
    chatId: string,
    limit: number = 50,
    before?: string,
    userId?: string
  ): MessageWithSender[] {
    let sql = `
      SELECT m.*, 
             u.id as sender_user_id, u.username, u.display_name, u.avatar_url, u.status
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.chat_id = ? AND m.deleted_at IS NULL
    `;
    const params: unknown[] = [chatId];

    // Исключаем сообщения удалённые "для себя"
    if (userId) {
      sql += ' AND m.id NOT IN (SELECT md.message_id FROM message_deletions md WHERE md.user_id = ?)';
      params.push(userId);
    }

    if (before) {
      sql += ' AND m.created_at < ?';
      params.push(before);
    }

    sql += ' ORDER BY m.created_at DESC LIMIT ?';
    params.push(limit);

    const rows = dbUtils.all<Message & {
      sender_user_id: string;
      username: string;
      display_name: string;
      avatar_url: string;
      status: string;
    }>(sql, params);

    return rows.map(row => ({
      id: row.id,
      chat_id: row.chat_id,
      sender_id: row.sender_id,
      reply_to_id: row.reply_to_id,
      content: row.content,
      encrypted_content: row.encrypted_content,
      type: row.type,
      metadata: this.parseMetadata(row.metadata as any),
      edited_at: row.edited_at,
      deleted_at: row.deleted_at,
      created_at: row.created_at,
      sender: {
        id: row.sender_user_id,
        username: row.username,
        display_name: row.display_name,
        avatar_url: row.avatar_url,
        status: row.status,
      },
    })).reverse();
  }

  // Загрузка сообщений вокруг конкретного message_id (для jump-to-message)
  getMessagesAround(chatId: string, messageId: string, count: number = 25, userId?: string): MessageWithSender[] {
    // Находим created_at целевого сообщения
    const target = dbUtils.get<{ created_at: string }>(
      'SELECT created_at FROM messages WHERE id = ? AND chat_id = ? AND deleted_at IS NULL',
      [messageId, chatId]
    );
    if (!target) return [];

    let excludeSql = '';
    const baseParams: unknown[] = [chatId];
    if (userId) {
      excludeSql = ' AND m.id NOT IN (SELECT md.message_id FROM message_deletions md WHERE md.user_id = ?)';
      baseParams.push(userId);
    }

    const baseSql = `
      SELECT m.*, 
             u.id as sender_user_id, u.username, u.display_name, u.avatar_url, u.status
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.chat_id = ? ${excludeSql} AND m.deleted_at IS NULL
    `;

    // Before (включая само целевое сообщение)
    const beforeRows = dbUtils.all<Message & {
      sender_user_id: string; username: string; display_name: string; avatar_url: string; status: string;
    }>(baseSql + ' AND m.created_at <= ? ORDER BY m.created_at DESC LIMIT ?', [...baseParams, target.created_at, count + 1]);

    // After
    const afterRows = dbUtils.all<Message & {
      sender_user_id: string; username: string; display_name: string; avatar_url: string; status: string;
    }>(baseSql + ' AND m.created_at > ? ORDER BY m.created_at ASC LIMIT ?', [...baseParams, target.created_at, count]);

    const allRows = [...beforeRows.reverse(), ...afterRows];
    // Дедупликация по id
    const seen = new Set<string>();
    const unique = allRows.filter(r => { if (seen.has(r.id)) return false; seen.add(r.id); return true; });

    return unique.map(row => ({
      id: row.id,
      chat_id: row.chat_id,
      sender_id: row.sender_id,
      reply_to_id: row.reply_to_id,
      content: row.content,
      encrypted_content: row.encrypted_content,
      type: row.type,
      metadata: this.parseMetadata(row.metadata as any),
      edited_at: row.edited_at,
      deleted_at: row.deleted_at,
      created_at: row.created_at,
      sender: {
        id: row.sender_user_id,
        username: row.username,
        display_name: row.display_name,
        avatar_url: row.avatar_url,
        status: row.status,
      },
    }));
  }

  // Редактирование сообщения
  editMessage(messageId: string, userId: string, newContent: string): Message | null {
    const message = this.findById(messageId);
    if (!message || message.sender_id !== userId) {
      return null;
    }

    const now = new Date().toISOString();
    dbUtils.run(
      'UPDATE messages SET content = ?, edited_at = ? WHERE id = ?',
      [newContent, now, messageId]
    );

    return this.findById(messageId) || null;
  }

  // Удаление сообщения для всех (только отправитель может)
  deleteMessage(messageId: string, userId: string): boolean {
    const message = this.findById(messageId);
    if (!message || message.sender_id !== userId) {
      return false;
    }

    const result = dbUtils.run(
      'UPDATE messages SET deleted_at = ?, content = NULL WHERE id = ?',
      [new Date().toISOString(), messageId]
    );

    // Удаляем файл голосового сообщения если есть
    if (message.type === 'voice' && message.metadata) {
      try {
        const meta = typeof message.metadata === 'string' ? JSON.parse(message.metadata) : message.metadata;
        if (meta?.filename) {
          const filePath = require('path').join(process.cwd(), 'storage', 'voice', meta.filename);
          if (require('fs').existsSync(filePath)) {
            require('fs').unlinkSync(filePath);
            logger.info(`Deleted voice file: ${meta.filename}`);
          }
        }
      } catch (e) {
        logger.warn('Failed to delete voice file for message:', messageId);
      }
    }

    return result.changes > 0;
  }

  // Удаление сообщения "для себя" (любой участник чата)
  deleteMessageForMe(messageId: string, userId: string): boolean {
    const message = dbUtils.get<Message>(
      'SELECT * FROM messages WHERE id = ?',
      [messageId]
    );
    if (!message) return false;

    // Проверяем что пользователь состоит в чате
    if (!chatService.isChatMember(message.chat_id, userId)) {
      return false;
    }

    // Проверяем, не удалено ли уже
    const existing = dbUtils.get(
      'SELECT id FROM message_deletions WHERE message_id = ? AND user_id = ?',
      [messageId, userId]
    );
    if (existing) return true; // уже удалено

    dbUtils.run(
      'INSERT INTO message_deletions (id, message_id, user_id, deleted_at) VALUES (?, ?, ?, ?)',
      [require('crypto').randomUUID(), messageId, userId, new Date().toISOString()]
    );

    return true;
  }

  // Пометить как прочитанное
  markAsRead(chatId: string, userId: string, messageId: string): void {
    try {
      // Проверяем принадлежность к чату
      if (!chatService.isChatMember(chatId, userId)) {
        return;
      }

      // Обновляем last_read_at для участника
      dbUtils.run(
        'UPDATE chat_members SET last_read_at = ? WHERE chat_id = ? AND user_id = ?',
        [new Date().toISOString(), chatId, userId]
      );

      // Добавляем запись о прочтении
      const existingRead = dbUtils.get(
        'SELECT id FROM message_reads WHERE message_id = ? AND user_id = ?',
        [messageId, userId]
      );

      if (!existingRead) {
        dbUtils.run(
          'INSERT INTO message_reads (id, message_id, user_id, read_at) VALUES (?, ?, ?, ?)',
          [uuidv4(), messageId, userId, new Date().toISOString()]
        );
      }
    } catch (error) {
      // Игнорируем ошибки базы (например, если сообщение или чат уже удалены, FOREIGN KEY и т.д.)
    }
  }

  // Получить количество непрочитанных
  getUnreadCount(chatId: string, userId: string): number {
    const member = dbUtils.get<{ last_read_at: string | null }>(
      'SELECT last_read_at FROM chat_members WHERE chat_id = ? AND user_id = ?',
      [chatId, userId]
    );

    if (!member) return 0;

    const result = dbUtils.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM messages 
       WHERE chat_id = ? AND sender_id != ? AND deleted_at IS NULL
       AND (? IS NULL OR created_at > ?)`,
      [chatId, userId, member.last_read_at, member.last_read_at]
    );

    return result?.count || 0;
  }

  // Поиск сообщений
  searchMessages(userId: string, query: string, limit: number = 50): MessageWithSender[] {
    const sql = `
      SELECT m.*, 
             u.id as sender_user_id, u.username, u.display_name, u.avatar_url, u.status
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      JOIN chat_members cm ON m.chat_id = cm.chat_id AND cm.user_id = ?
      WHERE m.content LIKE ? AND m.deleted_at IS NULL
      ORDER BY m.created_at DESC
      LIMIT ?
    `;

    const rows = dbUtils.all<Message & {
      sender_user_id: string;
      username: string;
      display_name: string;
      avatar_url: string;
      status: string;
    }>(sql, [userId, `%${query}%`, limit]);

    return rows.map(row => ({
      id: row.id,
      chat_id: row.chat_id,
      sender_id: row.sender_id,
      reply_to_id: row.reply_to_id,
      content: row.content,
      encrypted_content: row.encrypted_content,
      type: row.type,
      metadata: this.parseMetadata(row.metadata as any),
      edited_at: row.edited_at,
      deleted_at: row.deleted_at,
      created_at: row.created_at,
      sender: {
        id: row.sender_user_id,
        username: row.username,
        display_name: row.display_name,
        avatar_url: row.avatar_url,
        status: row.status,
      },
    }));
  }

  // Поиск сообщений внутри конкретного чата
  searchChatMessages(chatId: string, userId: string, query: string, limit: number = 50): MessageWithSender[] {
    if (!chatService.isChatMember(chatId, userId)) return [];

    const sql = `
      SELECT m.*, 
             u.id as sender_user_id, u.username, u.display_name, u.avatar_url, u.status
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.chat_id = ? AND m.content LIKE ? AND m.deleted_at IS NULL
      AND m.id NOT IN (SELECT md.message_id FROM message_deletions md WHERE md.user_id = ?)
      ORDER BY m.created_at DESC
      LIMIT ?
    `;

    const rows = dbUtils.all<Message & {
      sender_user_id: string; username: string; display_name: string; avatar_url: string; status: string;
    }>(sql, [chatId, `%${query}%`, userId, limit]);

    return rows.map(row => ({
      id: row.id, chat_id: row.chat_id, sender_id: row.sender_id,
      reply_to_id: row.reply_to_id, content: row.content, encrypted_content: row.encrypted_content,
      type: row.type, metadata: this.parseMetadata(row.metadata as any),
      edited_at: row.edited_at, deleted_at: row.deleted_at, created_at: row.created_at,
      sender: { id: row.sender_user_id, username: row.username, display_name: row.display_name, avatar_url: row.avatar_url, status: row.status },
    }));
  }

  // Получить медиафайлы чата по типу
  getChatMedia(chatId: string, userId: string, types: string[], limit: number = 50, offset: number = 0): MessageWithSender[] {
    if (!chatService.isChatMember(chatId, userId)) return [];
    
    const placeholders = types.map(() => '?').join(',');
    const sql = `
      SELECT m.*, 
             u.id as sender_user_id, u.username, u.display_name, u.avatar_url, u.status
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.chat_id = ? AND m.type IN (${placeholders}) AND m.deleted_at IS NULL
      AND m.id NOT IN (SELECT md.message_id FROM message_deletions md WHERE md.user_id = ?)
      ORDER BY m.created_at DESC
      LIMIT ? OFFSET ?
    `;
    const params: unknown[] = [chatId, ...types, userId, limit, offset];
    
    const rows = dbUtils.all<Message & {
      sender_user_id: string; username: string; display_name: string; avatar_url: string; status: string;
    }>(sql, params);

    return rows.map(row => ({
      id: row.id, chat_id: row.chat_id, sender_id: row.sender_id,
      reply_to_id: row.reply_to_id, content: row.content, encrypted_content: row.encrypted_content,
      type: row.type, metadata: this.parseMetadata(row.metadata as any),
      edited_at: row.edited_at, deleted_at: row.deleted_at, created_at: row.created_at,
      sender: { id: row.sender_user_id, username: row.username, display_name: row.display_name, avatar_url: row.avatar_url, status: row.status },
    }));
  }

  // Получить ссылки из текстовых сообщений чата
  getChatLinks(chatId: string, userId: string, limit: number = 50, offset: number = 0): MessageWithSender[] {
    if (!chatService.isChatMember(chatId, userId)) return [];
    
    const sql = `
      SELECT m.*, 
             u.id as sender_user_id, u.username, u.display_name, u.avatar_url, u.status
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.chat_id = ? AND m.type = 'text' AND m.content LIKE '%http%' AND m.deleted_at IS NULL
      AND m.id NOT IN (SELECT md.message_id FROM message_deletions md WHERE md.user_id = ?)
      ORDER BY m.created_at DESC
      LIMIT ? OFFSET ?
    `;
    const rows = dbUtils.all<Message & {
      sender_user_id: string; username: string; display_name: string; avatar_url: string; status: string;
    }>(sql, [chatId, userId, limit, offset]);

    return rows.map(row => ({
      id: row.id, chat_id: row.chat_id, sender_id: row.sender_id,
      reply_to_id: row.reply_to_id, content: row.content, encrypted_content: row.encrypted_content,
      type: row.type, metadata: this.parseMetadata(row.metadata as any),
      edited_at: row.edited_at, deleted_at: row.deleted_at, created_at: row.created_at,
      sender: { id: row.sender_user_id, username: row.username, display_name: row.display_name, avatar_url: row.avatar_url, status: row.status },
    }));
  }

  // Обновить metadata сообщения (для транскрипции голосовых и т.д.)
  updateMessageMetadata(messageId: string, metadata: any): void {
    const json = metadata ? JSON.stringify(metadata) : null;
    dbUtils.run('UPDATE messages SET metadata = ? WHERE id = ?', [json, messageId]);
  }

  // === Реакции ===

  // Добавить/убрать реакцию (toggle)
  toggleReaction(messageId: string, userId: string, emoji: string): boolean {
    const existing = dbUtils.get<{ id: string }>(
      'SELECT id FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?',
      [messageId, userId, emoji]
    );

    if (existing) {
      dbUtils.run('DELETE FROM message_reactions WHERE id = ?', [existing.id]);
      return false; // removed
    } else {
      dbUtils.run(
        'INSERT INTO message_reactions (id, message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?, ?)',
        [uuidv4(), messageId, userId, emoji, new Date().toISOString()]
      );
      return true; // added
    }
  }

  // Получить реакции для сообщения (сгруппированные)
  getReactions(messageId: string): Array<{ emoji: string; count: number; users: { id: string; username: string; display_name?: string; avatar_url?: string }[] }> {
    const rows = dbUtils.all<{ emoji: string; user_id: string; username: string; display_name: string | null; avatar_url: string | null }>(
      `SELECT r.emoji, r.user_id, u.username, u.display_name, u.avatar_url
       FROM message_reactions r
       JOIN users u ON r.user_id = u.id
       WHERE r.message_id = ?
       ORDER BY r.created_at ASC`,
      [messageId]
    );

    const grouped = new Map<string, { emoji: string; count: number; users: { id: string; username: string; display_name?: string; avatar_url?: string }[] }>();
    for (const row of rows) {
      if (!grouped.has(row.emoji)) {
        grouped.set(row.emoji, { emoji: row.emoji, count: 0, users: [] });
      }
      const entry = grouped.get(row.emoji)!;
      entry.count++;
      entry.users.push({ id: row.user_id, username: row.username, display_name: row.display_name ?? undefined, avatar_url: row.avatar_url ?? undefined });
    }
    return Array.from(grouped.values());
  }

  // Получить реакции для нескольких сообщений (batch)
  getReactionsBatch(messageIds: string[]): Record<string, Array<{ emoji: string; count: number; users: { id: string; username: string; display_name?: string; avatar_url?: string }[] }>> {
    if (messageIds.length === 0) return {};
    
    const placeholders = messageIds.map(() => '?').join(',');
    const rows = dbUtils.all<{ message_id: string; emoji: string; user_id: string; username: string; display_name: string | null; avatar_url: string | null }>(
      `SELECT r.message_id, r.emoji, r.user_id, u.username, u.display_name, u.avatar_url
       FROM message_reactions r
       JOIN users u ON r.user_id = u.id
       WHERE r.message_id IN (${placeholders})
       ORDER BY r.created_at ASC`,
      messageIds
    );

    const result: Record<string, Map<string, { emoji: string; count: number; users: { id: string; username: string; display_name?: string; avatar_url?: string }[] }>> = {};
    for (const row of rows) {
      if (!result[row.message_id]) result[row.message_id] = new Map();
      const map = result[row.message_id];
      if (!map.has(row.emoji)) {
        map.set(row.emoji, { emoji: row.emoji, count: 0, users: [] });
      }
      const entry = map.get(row.emoji)!;
      entry.count++;
      entry.users.push({ id: row.user_id, username: row.username, display_name: row.display_name ?? undefined, avatar_url: row.avatar_url ?? undefined });
    }

    const final: Record<string, Array<{ emoji: string; count: number; users: { id: string; username: string; display_name?: string; avatar_url?: string }[] }>> = {};
    for (const [msgId, map] of Object.entries(result)) {
      final[msgId] = Array.from(map.values());
    }
    return final;
  }
}

export const messageService = new MessageService();
export default messageService;
