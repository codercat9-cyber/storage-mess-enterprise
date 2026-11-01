import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { dbUtils } from '../database/index.js';
import { User, UserPublic, UserSettings, RegisterRequest } from '../types/index.js';
import { logger } from '../utils/logger.js';

const SALT_ROUNDS = 12;

function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeEmail(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized || undefined;
}

function normalizeDisplayName(displayName: string | undefined, fallbackUsername: string): string {
  const trimmed = (displayName ?? '').trim();
  return trimmed || fallbackUsername;
}

function generateRecoveryKey(): string {
  const bytes = crypto.randomBytes(16);
  const hex = bytes.toString('hex').toUpperCase();
  // Формат: XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
  return hex.match(/.{4}/g)!.join('-');
}

export class UserService {
  // Создание пользователя (возвращает user + recoveryKey)
  async createUser(data: RegisterRequest): Promise<{ user: User; recoveryKey: string }> {
    const id = uuidv4();
    const username = normalizeUsername(data.username);
    const email = normalizeEmail(data.email);
    const passwordHash = await bcrypt.hash(data.password, SALT_ROUNDS);
    const recoveryKey = generateRecoveryKey();
    const recoveryHash = await bcrypt.hash(recoveryKey.replace(/-/g, ''), SALT_ROUNDS);
    
    const user: User = {
      id,
      username,
      email,
      password_hash: passwordHash,
      recovery_hash: recoveryHash,
      display_name: normalizeDisplayName(data.display_name, username),
      status: 'offline',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    // Важно: user и user_settings создаются атомарно.
    // Иначе можно получить "полубитого" пользователя без настроек при падении второго INSERT.
    dbUtils.transaction(() => {
      dbUtils.run(
        `INSERT INTO users (id, username, email, password_hash, recovery_hash, display_name, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [user.id, user.username, user.email, user.password_hash, user.recovery_hash, user.display_name, user.status, user.created_at, user.updated_at]
      );

      dbUtils.run(
        `INSERT INTO user_settings (id, user_id) VALUES (?, ?)`,
        [uuidv4(), id]
      );
    });

    logger.info(`User created: ${user.username}`);
    return { user, recoveryKey };
  }

  // Поиск по username
  findByUsername(username: string): User | undefined {
    return dbUtils.get<User>(
      'SELECT * FROM users WHERE username = ?',
      [normalizeUsername(username)]
    );
  }

  // Поиск по email
  findByEmail(email: string): User | undefined {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) return undefined;
    return dbUtils.get<User>(
      'SELECT * FROM users WHERE email = ?',
      [normalizedEmail]
    );
  }

  // Поиск по ID
  findById(id: string): User | undefined {
    return dbUtils.get<User>('SELECT * FROM users WHERE id = ?', [id]);
  }

  // Получить публичный профиль
  getPublicProfile(user: User): UserPublic {
    return {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      avatar_url: user.avatar_url,
      status: user.status,
      last_seen: user.last_seen,
      // Роль нужна интерфейсу: пункт «Админ-панель» показывается только
      // администратору. Это удобство, а не защита — доступ всё равно
      // проверяется на сервере в adminMiddleware.
      role: (user as any).role || 'user',
    } as any;
  }

  // Проверка пароля
  async verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  // Обновление статуса
  /**
   * Обновить состояние присутствия. Возвращает отметку времени ухода —
   * её нужно разослать вместе с событием, иначе собеседники останутся с
   * тем значением, что загрузили при открытии переписки.
   */
  updateStatus(userId: string, status: User['status']): string | null {
    const lastSeen = status === 'offline' ? new Date().toISOString() : null;

    dbUtils.run(
      `UPDATE users SET status = ?, last_seen = COALESCE(?, last_seen), updated_at = ? WHERE id = ?`,
      [status, lastSeen, new Date().toISOString(), userId]
    );

    return lastSeen;
  }

  // Обновление профиля
  updateProfile(userId: string, data: Partial<Pick<User, 'display_name' | 'avatar_url' | 'public_key'>>): User | undefined {
    const updates: string[] = [];
    const values: (string | undefined)[] = [];

    if (data.display_name !== undefined) {
      updates.push('display_name = ?');
      values.push(data.display_name);
    }
    if (data.avatar_url !== undefined) {
      updates.push('avatar_url = ?');
      values.push(data.avatar_url);
    }
    if (data.public_key !== undefined) {
      updates.push('public_key = ?');
      values.push(data.public_key);
    }

    if (updates.length === 0) {
      return this.findById(userId);
    }

    updates.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(userId);

    dbUtils.run(
      `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
      values
    );

    return this.findById(userId);
  }

  // Поиск пользователей
  searchUsers(query: string, limit: number = 20): UserPublic[] {
    const users = dbUtils.all<User>(
      `SELECT * FROM users 
       WHERE username LIKE ? OR display_name LIKE ?
       LIMIT ?`,
      [`%${query}%`, `%${query}%`, limit]
    );

    return users.map(u => this.getPublicProfile(u));
  }

  // Получить настройки пользователя
  getSettings(userId: string): UserSettings | undefined {
    return dbUtils.get<UserSettings>(
      'SELECT * FROM user_settings WHERE user_id = ?',
      [userId]
    );
  }

  // Обновить настройки
  updateSettings(userId: string, settings: Partial<UserSettings>): void {
    const updates: string[] = [];
    const values: unknown[] = [];

    const allowedFields = ['theme', 'language', 'notifications_enabled', 'sound_enabled', 'settings_json'];
    
    for (const [key, value] of Object.entries(settings)) {
      if (allowedFields.includes(key) && value !== undefined) {
        updates.push(`${key} = ?`);
        // SQLite не принимает boolean — конвертируем в 0/1
        values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
      }
    }

    if (updates.length > 0) {
      // Раньше здесь был только UPDATE. Если строки в user_settings нет
      // (аккаунт создан не через обычную регистрацию, либо строка была
      // удалена), UPDATE молча не делает ничего и не сообщает об ошибке —
      // настройки просто не сохранялись. Гарантируем наличие строки.
      dbUtils.run(
        `INSERT OR IGNORE INTO user_settings (id, user_id) VALUES (?, ?)`,
        [uuidv4(), userId]
      );

      values.push(userId);
      const result = dbUtils.run(
        `UPDATE user_settings SET ${updates.join(', ')} WHERE user_id = ?`,
        values
      );
      if (result.changes === 0) {
        logger.warn(`updateSettings: настройки пользователя ${userId} не записались`);
      }
    }
  }

  // Сброс пароля по ключу восстановления
  async resetPassword(username: string, recoveryKey: string, newPassword: string): Promise<boolean> {
    const user = this.findByUsername(username);
    if (!user || !user.recovery_hash) return false;

    const keyNormalized = recoveryKey.replace(/-/g, '').toUpperCase();
    const isValid = await bcrypt.compare(keyNormalized, user.recovery_hash);
    if (!isValid) return false;

    const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    dbUtils.run(
      `UPDATE users SET password_hash = ?, updated_at = ?, password_changed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [newHash, new Date().toISOString(), user.id]
    );

    // Удаляем все refresh-токены пользователя (разлогиниваем все сессии)
    dbUtils.run('DELETE FROM refresh_tokens WHERE user_id = ?', [user.id]);

    logger.info(`Password reset via recovery key for: ${user.username}`);
    return true;
  }

  // Перегенерация ключа восстановления (из авторизованной сессии)
  async regenerateRecoveryKey(userId: string): Promise<string | null> {
    const user = this.findById(userId);
    if (!user) return null;

    const recoveryKey = generateRecoveryKey();
    const recoveryHash = await bcrypt.hash(recoveryKey.replace(/-/g, ''), SALT_ROUNDS);

    dbUtils.run(
      `UPDATE users SET recovery_hash = ?, updated_at = ? WHERE id = ?`,
      [recoveryHash, new Date().toISOString(), userId]
    );

    logger.info(`Recovery key regenerated for: ${user.username}`);
    return recoveryKey;
  }

  // Смена пароля авторизованным пользователем (старый → новый)
  async changePassword(userId: string, oldPassword: string, newPassword: string): Promise<boolean> {
    const user = this.findById(userId);
    if (!user) return false;

    const isValid = await bcrypt.compare(oldPassword, user.password_hash);
    if (!isValid) return false;

    const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    dbUtils.run(
      `UPDATE users SET password_hash = ?, updated_at = ?, password_changed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [newHash, new Date().toISOString(), userId]
    );

    logger.info(`Password changed by user: ${user.username}`);
    return true;
  }

  // Сброс пароля администратором (без ключа восстановления)
  async adminResetPassword(username: string, newPassword: string): Promise<boolean> {
    const user = this.findByUsername(username);
    if (!user) return false;

    const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    dbUtils.run(
      `UPDATE users SET password_hash = ?, updated_at = ?, password_changed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [newHash, new Date().toISOString(), user.id]
    );

    // Удаляем все refresh-токены (разлогиниваем все сессии)
    dbUtils.run('DELETE FROM refresh_tokens WHERE user_id = ?', [user.id]);

    logger.info(`Password admin-reset for: ${user.username}`);
    return true;
  }

  // Удалить пользователя и все связанные данные
  deleteUser(userId: string): boolean {
    const user = this.findById(userId);
    if (!user) return false;

    // Удаляем в правильном порядке (от зависимых к корневым)
    // 1. Участия в звонках
    dbUtils.run('DELETE FROM call_participants WHERE user_id = ?', [userId]);
    // 2. Звонки, инициированные пользователем
    dbUtils.run('DELETE FROM call_participants WHERE call_id IN (SELECT id FROM calls WHERE caller_id = ?)', [userId]);
    dbUtils.run('DELETE FROM calls WHERE caller_id = ?', [userId]);
    // 3. Файлы пользователя
    dbUtils.run('DELETE FROM files WHERE uploader_id = ?', [userId]);
    // 4. Сообщения пользователя (reply_to_id ссылки — обнуляем)
    dbUtils.run('UPDATE messages SET reply_to_id = NULL WHERE reply_to_id IN (SELECT id FROM messages WHERE sender_id = ?)', [userId]);
    dbUtils.run('DELETE FROM messages WHERE sender_id = ?', [userId]);
    // 5. Чаты, созданные пользователем (обнуляем created_by)
    dbUtils.run('UPDATE chats SET created_by = NULL WHERE created_by = ?', [userId]);
    // 6. Токены сброса пароля
    dbUtils.run('DELETE FROM password_reset_tokens WHERE user_id = ?', [userId]);
    // 7. Остальное удалится каскадно (contacts, chat_members, message_reads, message_deletions, refresh_tokens, user_settings, user_public_keys)

    const result = dbUtils.run('DELETE FROM users WHERE id = ?', [userId]);
    logger.info(`User deleted: ${user.username} (${userId})`);
    return result.changes > 0;
  }
}

export const userService = new UserService();
export default userService;
