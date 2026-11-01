import nodemailer from 'nodemailer';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config/index.js';
import { dbUtils } from '../database/index.js';
import { logger } from '../utils/logger.js';

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (transporter) return transporter;
  if (!config.smtp.host || !config.smtp.user) return null;

  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: {
      user: config.smtp.user,
      pass: config.smtp.pass,
    },
  });

  return transporter;
}

export const emailService = {
  isConfigured(): boolean {
    return !!(config.smtp.host && config.smtp.user);
  },

  // Создать токен сброса и отправить email
  async sendResetEmail(username: string): Promise<{ sent: boolean; hasEmail: boolean }> {
    const user = dbUtils.get<{ id: string; username: string; email: string | null }>(
      'SELECT id, username, email FROM users WHERE username = ?',
      [username.toLowerCase()]
    );

    if (!user) {
      // Не раскрываем существование пользователя
      return { sent: false, hasEmail: false };
    }

    if (!user.email) {
      return { sent: false, hasEmail: false };
    }

    const mailer = getTransporter();
    if (!mailer) {
      logger.warn('SMTP not configured, cannot send reset email');
      return { sent: false, hasEmail: true };
    }

    // Удаляем старые неиспользованные токены этого пользователя
    dbUtils.run('DELETE FROM password_reset_tokens WHERE user_id = ? AND used = 0', [user.id]);

    // Генерируем токен: 32 байта → URL-safe base64
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 минут

    dbUtils.run(
      'INSERT INTO password_reset_tokens (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)',
      [uuidv4(), user.id, token, expiresAt.toISOString()]
    );

    const resetUrl = `${config.serverUrl}/reset-password?token=${token}`;

    try {
      await mailer.sendMail({
        from: config.smtp.from,
        to: user.email,
        subject: 'Сброс пароля — STORAGE&MESS',
        html: `
          <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; background: #f8f9fa; border-radius: 16px;">
            <h2 style="text-align: center; color: #1a1a1a; margin-bottom: 8px;">Сброс пароля</h2>
            <p style="text-align: center; color: #666; font-size: 15px;">Кто-то запросил сброс пароля для аккаунта <b>@${user.username}</b></p>
            <div style="text-align: center; margin: 24px 0;">
              <a href="${resetUrl}" style="display: inline-block; background: #3390ec; color: white; text-decoration: none; padding: 14px 32px; border-radius: 12px; font-weight: 600; font-size: 16px;">
                Сбросить пароль
              </a>
            </div>
            <p style="text-align: center; color: #999; font-size: 13px;">Ссылка действительна 30 минут.<br/>Если вы не запрашивали сброс — проигнорируйте это письмо.</p>
          </div>
        `,
        text: `Сброс пароля для @${user.username}\n\nПерейдите по ссылке: ${resetUrl}\n\nСсылка действительна 30 минут.`,
      });

      logger.info(`Reset email sent to ${user.email} for user ${user.username}`);
      return { sent: true, hasEmail: true };
    } catch (error) {
      logger.error('Failed to send reset email:', error);
      return { sent: false, hasEmail: true };
    }
  },

  // Проверить токен и сбросить пароль
  async resetByToken(token: string, newPassword: string): Promise<boolean> {
    const record = dbUtils.get<{ id: string; user_id: string; expires_at: string; used: number }>(
      'SELECT id, user_id, expires_at, used FROM password_reset_tokens WHERE token = ?',
      [token]
    );

    if (!record || record.used) return false;
    if (new Date(record.expires_at) < new Date()) {
      // Помечаем как использованный, чтобы не висел
      dbUtils.run('UPDATE password_reset_tokens SET used = 1 WHERE id = ?', [record.id]);
      return false;
    }

    // Импортируем bcrypt для хеширования
    const bcrypt = await import('bcryptjs');
    const newHash = await bcrypt.hash(newPassword, 12);

    dbUtils.run(
      'UPDATE users SET password_hash = ?, updated_at = ?, password_changed_at = CURRENT_TIMESTAMP WHERE id = ?',
      [newHash, new Date().toISOString(), record.user_id]
    );

    // Помечаем токен как использованный
    dbUtils.run('UPDATE password_reset_tokens SET used = 1 WHERE id = ?', [record.id]);

    // Удаляем все refresh-токены (разлогиниваем)
    dbUtils.run('DELETE FROM refresh_tokens WHERE user_id = ?', [record.user_id]);

    const user = dbUtils.get<{ username: string }>('SELECT username FROM users WHERE id = ?', [record.user_id]);
    logger.info(`Password reset via email token for: ${user?.username}`);
    return true;
  },

  // Проверить валидность токена (без сброса)
  validateToken(token: string): boolean {
    const record = dbUtils.get<{ expires_at: string; used: number }>(
      'SELECT expires_at, used FROM password_reset_tokens WHERE token = ?',
      [token]
    );

    if (!record || record.used) return false;
    return new Date(record.expires_at) >= new Date();
  },
};
