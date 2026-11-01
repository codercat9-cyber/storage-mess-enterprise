import { v4 as uuidv4 } from 'uuid';
import { dbUtils } from '../database/index.js';
import { Chat, ChatMember, Message, MessageWithSender, UserPublic } from '../types/index.js';
import { userService } from './user.service.js';
import { logger } from '../utils/logger.js';

export class ChatService {
  // Создание приватного чата
  createPrivateChat(userId1: string, userId2: string): Chat {
    // Проверяем, существует ли уже чат между этими пользователями
    const existingChat = this.findPrivateChat(userId1, userId2);
    if (existingChat) {
      return existingChat;
    }

    const chatId = uuidv4();
    const now = new Date().toISOString();

    dbUtils.transaction(() => {
      // Создаём чат
      dbUtils.run(
        `INSERT INTO chats (id, type, created_at, updated_at) VALUES (?, 'private', ?, ?)`,
        [chatId, now, now]
      );

      // Добавляем участников
      dbUtils.run(
        `INSERT INTO chat_members (id, chat_id, user_id, role, joined_at) VALUES (?, ?, ?, 'member', ?)`,
        [uuidv4(), chatId, userId1, now]
      );
      dbUtils.run(
        `INSERT INTO chat_members (id, chat_id, user_id, role, joined_at) VALUES (?, ?, ?, 'member', ?)`,
        [uuidv4(), chatId, userId2, now]
      );
    });

    return this.findById(chatId)!;
  }

  // Создание группового чата
  createGroupChat(creatorId: string, name: string, memberIds: string[]): Chat {
    const chatId = uuidv4();
    const now = new Date().toISOString();

    dbUtils.transaction(() => {
      // Создаём чат
      dbUtils.run(
        `INSERT INTO chats (id, type, name, created_by, created_at, updated_at) VALUES (?, 'group', ?, ?, ?, ?)`,
        [chatId, name, creatorId, now, now]
      );

      // Добавляем создателя как админа
      dbUtils.run(
        `INSERT INTO chat_members (id, chat_id, user_id, role, joined_at) VALUES (?, ?, ?, 'admin', ?)`,
        [uuidv4(), chatId, creatorId, now]
      );

      // Добавляем остальных участников
      for (const memberId of memberIds) {
        if (memberId !== creatorId) {
          dbUtils.run(
            `INSERT INTO chat_members (id, chat_id, user_id, role, joined_at) VALUES (?, ?, ?, 'member', ?)`,
            [uuidv4(), chatId, memberId, now]
          );
        }
      }
    });

    logger.info(`Group chat created: ${name} by ${creatorId}`);
    return this.findById(chatId)!;
  }

  // Создание канала
  createChannel(creatorId: string, name: string, memberIds: string[]): Chat {
    const chatId = uuidv4();
    const now = new Date().toISOString();

    dbUtils.transaction(() => {
      dbUtils.run(
        `INSERT INTO chats (id, type, name, created_by, created_at, updated_at) VALUES (?, 'channel', ?, ?, ?, ?)`,
        [chatId, name, creatorId, now, now]
      );

      dbUtils.run(
        `INSERT INTO chat_members (id, chat_id, user_id, role, joined_at) VALUES (?, ?, ?, 'admin', ?)`,
        [uuidv4(), chatId, creatorId, now]
      );

      for (const memberId of memberIds) {
        if (memberId !== creatorId) {
          dbUtils.run(
            `INSERT INTO chat_members (id, chat_id, user_id, role, joined_at) VALUES (?, ?, ?, 'member', ?)`,
            [uuidv4(), chatId, memberId, now]
          );
        }
      }
    });

    logger.info(`Channel created: ${name} by ${creatorId}`);
    return this.findById(chatId)!;
  }

  // Получить или создать чат "Избранное" для пользователя (private chat с самим собой)
  getOrCreateFavorites(userId: string): Chat {
    // Ищем существующий чат-избранное (private чат где оба участника — один и тот же юзер)
    const existing = dbUtils.get<Chat>(
      `SELECT c.* FROM chats c
       JOIN chat_members cm ON c.id = cm.chat_id
       WHERE c.type = 'favorites' AND cm.user_id = ?`,
      [userId]
    );
    if (existing) return existing;

    const chatId = uuidv4();
    const now = new Date().toISOString();

    dbUtils.transaction(() => {
      dbUtils.run(
        `INSERT INTO chats (id, type, name, created_by, created_at, updated_at) VALUES (?, 'favorites', 'Избранное', ?, ?, ?)`,
        [chatId, userId, now, now]
      );
      dbUtils.run(
        `INSERT INTO chat_members (id, chat_id, user_id, role, joined_at) VALUES (?, ?, ?, 'admin', ?)`,
        [uuidv4(), chatId, userId, now]
      );
    });

    logger.info(`Favorites chat created for user ${userId}`);
    return this.findById(chatId)!;
  }

  // Поиск приватного чата между двумя пользователями
  findPrivateChat(userId1: string, userId2: string): Chat | undefined {
    return dbUtils.get<Chat>(
      `SELECT c.* FROM chats c
       JOIN chat_members cm1 ON c.id = cm1.chat_id AND cm1.user_id = ?
       JOIN chat_members cm2 ON c.id = cm2.chat_id AND cm2.user_id = ?
       WHERE c.type = 'private'`,
      [userId1, userId2]
    );
  }

  // Поиск чата по ID
  findById(chatId: string): Chat | undefined {
    return dbUtils.get<Chat>('SELECT * FROM chats WHERE id = ?', [chatId]);
  }

  // Получить чаты пользователя
  getUserChats(userId: string, isUserOnlineFn?: (id: string) => boolean): Array<Chat & { members: UserPublic[]; lastMessage?: Message }> {
    // 1. Получаем все чаты юзера (1 запрос)
    const chats = dbUtils.all<Chat>(
      `SELECT c.* FROM chats c
       JOIN chat_members cm ON c.id = cm.chat_id
       WHERE cm.user_id = ?
       ORDER BY c.updated_at DESC`,
      [userId]
    );

    if (chats.length === 0) return [];

    const chatIds = chats.map(c => c.id);
    const placeholders = chatIds.map(() => '?').join(',');

    // 2. Батч: все участники всех чатов (1 запрос вместо N)
    interface MemberRow {
      chat_id: string;
      member_user_id: string;
      username: string;
      display_name: string | null;
      avatar_url: string | null;
      status: string;
      last_seen: string | null;
    }
    const allMembers = dbUtils.all<MemberRow>(
      `SELECT cm.chat_id, cm.user_id as member_user_id, u.username, u.display_name, u.avatar_url, u.status, u.last_seen
       FROM chat_members cm
       JOIN users u ON cm.user_id = u.id
       WHERE cm.chat_id IN (${placeholders})`,
      chatIds
    );
    const membersByChatId = new Map<string, UserPublic[]>();
    for (const m of allMembers) {
      let arr = membersByChatId.get(m.chat_id);
      if (!arr) { arr = []; membersByChatId.set(m.chat_id, arr); }
      arr.push({
        id: m.member_user_id,
        username: m.username,
        display_name: m.display_name ?? undefined,
        avatar_url: m.avatar_url ?? undefined,
        status: m.status as 'online' | 'offline' | 'away' | 'busy',
        last_seen: m.last_seen ?? undefined,
      });
    }

    // 3. Батч: последние сообщения всех чатов (1 запрос вместо N, window function)
    const allLastMsgRows = dbUtils.all<Message & {
      rn: number;
      sender_user_id: string;
      username: string;
      display_name: string | null;
      avatar_url: string | null;
      sender_status: string;
    }>(
      `SELECT lm.*, u.id as sender_user_id, u.username, u.display_name, u.avatar_url, u.status as sender_status
       FROM (
         SELECT m.*, ROW_NUMBER() OVER (PARTITION BY m.chat_id ORDER BY m.created_at DESC) as rn
         FROM messages m
         WHERE m.chat_id IN (${placeholders}) AND m.deleted_at IS NULL
       ) lm
       JOIN users u ON lm.sender_id = u.id
       WHERE lm.rn = 1`,
      chatIds
    );
    const lastMsgByChatId = new Map<string, any>();
    for (const row of allLastMsgRows) {
      lastMsgByChatId.set(row.chat_id, {
        id: row.id, chat_id: row.chat_id, sender_id: row.sender_id,
        reply_to_id: row.reply_to_id, content: row.content,
        encrypted_content: row.encrypted_content, type: row.type,
        metadata: row.metadata, edited_at: row.edited_at,
        deleted_at: row.deleted_at, created_at: row.created_at,
        sender: {
          id: row.sender_user_id, username: row.username,
          display_name: row.display_name ?? undefined,
          avatar_url: row.avatar_url ?? undefined,
          status: row.sender_status,
        },
      });
    }

    // 4. Батч: read status для чатов где последнее сообщение наше (1 запрос вместо N*2)
    const ownLastMsgChatIds = chats
      .filter(c => lastMsgByChatId.get(c.id)?.sender_id === userId)
      .map(c => c.id);
    const readAtByChatId = new Map<string, string | null>();
    if (ownLastMsgChatIds.length > 0) {
      const readPlaceholders = ownLastMsgChatIds.map(() => '?').join(',');
      const readRows = dbUtils.all<{ chat_id: string; max_read_at: string | null }>(
        `SELECT chat_id, MAX(last_read_at) as max_read_at
         FROM chat_members
         WHERE chat_id IN (${readPlaceholders}) AND user_id != ?
         GROUP BY chat_id`,
        [...ownLastMsgChatIds, userId]
      );
      for (const r of readRows) {
        readAtByChatId.set(r.chat_id, r.max_read_at);
      }
    }

    // Собираем результат (0 запросов — всё уже в памяти)
    return chats.map(chat => {
      const members = membersByChatId.get(chat.id) || [];
      const lastMessage = lastMsgByChatId.get(chat.id);

      if (lastMessage && lastMessage.sender_id === userId) {
        const maxReadAt = readAtByChatId.get(chat.id) || null;
        const otherMembers = members.filter(m => m.id !== userId);
        const anyOnline = isUserOnlineFn ? otherMembers.some(m => isUserOnlineFn(m.id)) : false;
        if (maxReadAt && lastMessage.created_at <= maxReadAt) {
          lastMessage.status = 'read';
        } else if (anyOnline) {
          lastMessage.status = 'delivered';
        } else {
          lastMessage.status = 'sent';
        }
      }

      return { ...chat, members, lastMessage };
    });
  }

  // Получить участников чата
  getChatMembers(chatId: string): UserPublic[] {
    interface MemberRow {
      member_user_id: string;
      username: string;
      display_name: string | null;
      avatar_url: string | null;
      status: string;
      last_seen: string | null;
    }
    
    const members = dbUtils.all<MemberRow>(
      `SELECT cm.user_id as member_user_id, u.username, u.display_name, u.avatar_url, u.status, u.last_seen
       FROM chat_members cm
       JOIN users u ON cm.user_id = u.id
       WHERE cm.chat_id = ?`,
      [chatId]
    );

    return members.map(m => ({
      id: m.member_user_id,
      username: m.username,
      display_name: m.display_name ?? undefined,
      avatar_url: m.avatar_url ?? undefined,
      status: m.status as 'online' | 'offline' | 'away' | 'busy',
      last_seen: m.last_seen ?? undefined,
    }));
  }

  // Проверка принадлежности к чату
  isChatMember(chatId: string, userId: string): boolean {
    const member = dbUtils.get<ChatMember>(
      'SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ?',
      [chatId, userId]
    );
    return !!member;
  }

  // Добавить участника в групповой чат
  addMember(chatId: string, userId: string, addedBy: string): boolean {
    const chat = this.findById(chatId);
    if (!chat || chat.type === 'private') return false;

    // Проверяем права добавляющего
    const adder = dbUtils.get<ChatMember>(
      'SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ?',
      [chatId, addedBy]
    );
    if (!adder || (adder.role !== 'admin' && adder.role !== 'moderator')) {
      return false;
    }

    // Проверяем, не является ли уже участником
    if (this.isChatMember(chatId, userId)) {
      return false;
    }

    dbUtils.run(
      `INSERT INTO chat_members (id, chat_id, user_id, role, joined_at) VALUES (?, ?, ?, 'member', ?)`,
      [uuidv4(), chatId, userId, new Date().toISOString()]
    );

    return true;
  }

  // Удалить участника из чата
  removeMember(chatId: string, userId: string, removedBy: string): boolean {
    const chat = this.findById(chatId);
    if (!chat || chat.type === 'private') return false;

    // Проверяем права удаляющего
    const remover = dbUtils.get<ChatMember>(
      'SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ?',
      [chatId, removedBy]
    );
    if (!remover || remover.role !== 'admin') {
      return false;
    }

    // Нельзя удалить создателя
    if (chat.created_by === userId) {
      return false;
    }

    const result = dbUtils.run(
      'DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?',
      [chatId, userId]
    );

    return result.changes > 0;
  }

  // Покинуть чат
  leaveChat(chatId: string, userId: string): boolean {
    const chat = this.findById(chatId);
    if (!chat) return false;

    // Создатель группы не может покинуть её (только удалить)
    if (chat.type === 'group' && chat.created_by === userId) {
      return false;
    }

    const result = dbUtils.run(
      'DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?',
      [chatId, userId]
    );

    // Если в приватном чате не осталось участников, удаляем его
    if (chat.type === 'private') {
      const remainingMembers = dbUtils.get<{ count: number }>(
        'SELECT COUNT(*) as count FROM chat_members WHERE chat_id = ?',
        [chatId]
      );
      if (!remainingMembers || remainingMembers.count === 0) {
        dbUtils.run('DELETE FROM chats WHERE id = ?', [chatId]);
      }
    }

    return result.changes > 0;
  }

  // Получить последнее сообщение чата (с отправителем)
  getLastMessage(chatId: string): MessageWithSender | undefined {
    const row = dbUtils.get<Message & { sender_user_id: string; username: string; display_name: string | null; avatar_url: string | null; status: string }>(
      `SELECT m.*, u.id as sender_user_id, u.username, u.display_name, u.avatar_url, u.status
       FROM messages m
       JOIN users u ON m.sender_id = u.id
       WHERE m.chat_id = ? AND m.deleted_at IS NULL
       ORDER BY m.created_at DESC LIMIT 1`,
      [chatId]
    );
    if (!row) return undefined;
    return {
      ...row,
      sender: {
        id: row.sender_user_id,
        username: row.username,
        display_name: row.display_name ?? undefined,
        avatar_url: row.avatar_url ?? undefined,
        status: row.status,
      },
    };
  }

  // Обновить аватар группы/канала
  updateChatAvatar(chatId: string, avatarUrl: string): boolean {
    const result = dbUtils.run(
      'UPDATE chats SET avatar_url = ?, updated_at = ? WHERE id = ?',
      [avatarUrl, new Date().toISOString(), chatId]
    );
    return result.changes > 0;
  }

  // Обновить время чата
  updateChatTimestamp(chatId: string): void {
    dbUtils.run(
      'UPDATE chats SET updated_at = ? WHERE id = ?',
      [new Date().toISOString(), chatId]
    );
  }

  // Удалить чат
  // Для private-чатов: любой участник может удалить
  // Для group-чатов: только создатель (админ)
  deleteChat(chatId: string, userId: string): boolean {
    const chat = this.findById(chatId);
    if (!chat) return false;

    // Проверяем что пользователь — участник чата
    const member = dbUtils.get(
      'SELECT id FROM chat_members WHERE chat_id = ? AND user_id = ?',
      [chatId, userId]
    );
    if (!member) return false;

    // Для групп — только создатель может удалить
    if (chat.type === 'group' && chat.created_by !== userId) {
      return false;
    }

    // Удаляем зависимые данные без ON DELETE CASCADE
    // 1. Участники звонков в этом чате
    dbUtils.run('DELETE FROM call_participants WHERE call_id IN (SELECT id FROM calls WHERE chat_id = ?)', [chatId]);
    // 2. Звонки в этом чате
    dbUtils.run('DELETE FROM calls WHERE chat_id = ?', [chatId]);
    // 3. Остальное (messages, chat_members, message_reads, message_deletions) удалится каскадно

    const result = dbUtils.run('DELETE FROM chats WHERE id = ?', [chatId]);
    return result.changes > 0;
  }

  /**
   * Снести чат целиком — право главного администратора.
   *
   * Отличается от deleteChat тем, что не требует ни членства, ни владения:
   * администратор в чужую группу не входит, а сносить её по жалобе должен
   * уметь. Обычный путь удаления при этом остаётся прежним.
   *
   * Что НЕ удаляется намеренно:
   *
   *  - **Файлы.** Они привязаны к тому, кто их загрузил, а не к чату, и
   *    живут в личном хранилище человека. Снести чат — не то же самое, что
   *    вычистить чужое хранилище.
   *  - **Обращения** (support_requests). Это след подотчётности: по какому
   *    поводу администратора позвали и что он смотрел. Чат исчезает,
   *    запись о разборе остаётся.
   */
  deleteChatAsAdmin(chatId: string): { deleted: boolean; messages: number; members: number } {
    const chat = this.findById(chatId);
    if (!chat) return { deleted: false, messages: 0, members: 0 };

    const messages = dbUtils.get<{ c: number }>(
      'SELECT COUNT(*) AS c FROM messages WHERE chat_id = ?', [chatId])?.c || 0;
    const members = dbUtils.get<{ c: number }>(
      'SELECT COUNT(*) AS c FROM chat_members WHERE chat_id = ?', [chatId])?.c || 0;

    // У звонков каскада нет — иначе останутся висеть на удалённом чате.
    dbUtils.run('DELETE FROM call_participants WHERE call_id IN (SELECT id FROM calls WHERE chat_id = ?)', [chatId]);
    dbUtils.run('DELETE FROM calls WHERE chat_id = ?', [chatId]);

    const result = dbUtils.run('DELETE FROM chats WHERE id = ?', [chatId]);
    return { deleted: result.changes > 0, messages, members };
  }

  /** Кто состоит в чате — нужно, чтобы разослать им весть об удалении. */
  getMemberIds(chatId: string): string[] {
    return dbUtils.all<{ user_id: string }>(
      'SELECT user_id FROM chat_members WHERE chat_id = ?', [chatId]
    ).map(r => r.user_id);
  }
}

export const chatService = new ChatService();
export default chatService;
