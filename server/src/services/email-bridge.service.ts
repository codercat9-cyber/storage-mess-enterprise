/**
 * Email Bridge Service — децентрализованный транспорт сообщений через email.
 * 
 * Вдохновлён Delta Chat: email-серверы (Gmail, Yandex, Mail.ru) как relay.
 * Если DPI блокирует messenger.example.org — сообщения доставляются через личную почту пользователя.
 * 
 * Архитектура:
 * 1. Сервер отправляет сообщения оффлайн-юзеру на его email через ЕГО SMTP (от себя к себе).
 * 2. Сервер поллит IMAP-ящики активных юзеров.
 * 3. Юзер отвечает на email → сервер подбирает ответ → создаёт сообщение в чате.
 */

import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { dbUtils } from '../database/index.js';
import { logger } from '../utils/logger.js';
import { messageService } from './message.service.js';
import { chatService } from './chat.service.js';
import { simpleParser } from 'mailparser';

interface QueuedMessage {
  senderName: string;
  content: string;
  chatId: string;
  chatName: string;
  messageId: string;
  timestamp: Date;
}

interface EmailRateTracker {
  count: number;
  resetAt: number; // timestamp
}

const BATCH_INTERVAL_MS = 30_000;       // 30 секунд — окно батчинга
const IMAP_POLL_INTERVAL_MS = 60_000;   // 60 секунд — проверка входящих
const MAX_EMAILS_PER_HOUR = 10;         // Макс писем на юзера в час
const EMAIL_DOMAIN = 'messenger.example.org';

class EmailBridgeService {
  private messageQueue: Map<string, QueuedMessage[]> = new Map(); // userId → messages
  private rateTracker: Map<string, EmailRateTracker> = new Map();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private imapTimer: ReturnType<typeof setInterval> | null = null;
  private initialized = false;

  init(): void {
    if (this.initialized) return;

    this.flushTimer = setInterval(() => {
      this.flushQueue().catch(err => logger.error('[EMAIL-BRIDGE] Unhandled flush error:', err));
    }, BATCH_INTERVAL_MS);
    
    this.imapTimer = setInterval(() => {
      this.pollAllUsersImap().catch(err => logger.error('[EMAIL-BRIDGE] Unhandled IMAP poll error:', err));
    }, IMAP_POLL_INTERVAL_MS);
    
    setTimeout(() => {
      this.pollAllUsersImap().catch(err => logger.error('[EMAIL-BRIDGE] Unhandled initial IMAP poll error:', err));
    }, 10_000);

    this.ensureDbTable();
    this.initialized = true;
    logger.info('[EMAIL-BRIDGE] ✉️  Децентрализованный Email Bridge инициализирован');
  }

  private ensureDbTable(): void {
    dbUtils.run(`
      CREATE TABLE IF NOT EXISTS email_bridge_processed (
        message_id TEXT PRIMARY KEY,
        processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    dbUtils.run(`
      DELETE FROM email_bridge_processed 
      WHERE processed_at < datetime('now', '-7 days')
    `);
  }

  private getUserSettings(userId: string) {
    const user = dbUtils.get<{ email: string | null }>('SELECT email FROM users WHERE id = ?', [userId]);
    if (!user?.email) return null;
    const settings = dbUtils.get<{ settings_json: string | null }>('SELECT settings_json FROM user_settings WHERE user_id = ?', [userId]);
    if (!settings?.settings_json) return null;
    try {
      const json = JSON.parse(settings.settings_json);
      return {
        email: user.email,
        password: json.email_password as string,
        enabled: json.email_fallback_enabled === true
      };
    } catch {
      return null;
    }
  }

  private getProviderConfig(email: string) {
    const domain = email.split('@')[1]?.toLowerCase() || '';
    if (domain.includes('yandex') || domain === 'ya.ru') return { smtpHost: 'smtp.yandex.ru', smtpPort: 465, imapHost: 'imap.yandex.ru', imapPort: 993 };
    if (domain.includes('gmail') || domain.includes('google')) return { smtpHost: 'smtp.gmail.com', smtpPort: 587, imapHost: 'imap.gmail.com', imapPort: 993 };
    if (domain.includes('mail.ru') || domain === 'bk.ru' || domain === 'list.ru' || domain === 'inbox.ru') return { smtpHost: 'smtp.mail.ru', smtpPort: 465, imapHost: 'imap.mail.ru', imapPort: 993 };
    return null;
  }

  isEnabledForUser(userId: string): boolean {
    if (!this.initialized) return false;
    const settings = this.getUserSettings(userId);
    return !!(settings?.enabled && settings?.email && settings?.password);
  }

  queueMessage(recipientUserId: string, senderName: string, content: string, chatId: string, chatName: string, messageId: string): void {
    if (!this.initialized) return;
    const queue = this.messageQueue.get(recipientUserId) || [];
    queue.push({ senderName, content, chatId, chatName, messageId, timestamp: new Date() });
    this.messageQueue.set(recipientUserId, queue);
  }

  private async flushQueue(): Promise<void> {
    if (this.messageQueue.size === 0) return;
    const entries = Array.from(this.messageQueue.entries());
    this.messageQueue.clear();

    for (const [userId, messages] of entries) {
      try {
        if (!this.checkRateLimit(userId)) {
          logger.warn(`[EMAIL-BRIDGE] Rate limit для ${userId} — пропускаем ${messages.length} сообщений`);
          continue;
        }
        await this.sendBatchEmail(userId, messages);
      } catch (err) {
        logger.error(`[EMAIL-BRIDGE] Ошибка отправки email для ${userId}:`, err);
      }
    }
  }

  private checkRateLimit(userId: string): boolean {
    const now = Date.now();
    const tracker = this.rateTracker.get(userId);
    if (!tracker || now > tracker.resetAt) {
      this.rateTracker.set(userId, { count: 1, resetAt: now + 3600_000 });
      return true;
    }
    if (tracker.count >= MAX_EMAILS_PER_HOUR) return false;
    tracker.count++;
    return true;
  }

  private async sendBatchEmail(userId: string, messages: QueuedMessage[]): Promise<void> {
    const settings = this.getUserSettings(userId);
    if (!settings || !settings.enabled || !settings.email || !settings.password) return;

    const config = this.getProviderConfig(settings.email);
    if (!config) {
      logger.warn(`[EMAIL-BRIDGE] Нет автонастроек для домена ${settings.email}`);
      return;
    }

    const user = dbUtils.get<{ username: string }>('SELECT username FROM users WHERE id = ?', [userId]);
    if (!user) return;

    const transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpPort === 465,
      auth: { user: settings.email, pass: settings.password }
    });

    const byChat = new Map<string, QueuedMessage[]>();
    for (const msg of messages) {
      const list = byChat.get(msg.chatId) || [];
      list.push(msg);
      byChat.set(msg.chatId, list);
    }

    const chatNames = Array.from(byChat.values()).map(msgs => msgs[0].chatName);
    const subject = messages.length === 1
      ? `[S&M] Новое сообщение от ${messages[0].senderName}`
      : `[S&M] ${messages.length} новых сообщений`;

    const primaryChatId = messages[0].chatId;
    const messageId = `<sm-${primaryChatId}-${Date.now()}@${EMAIL_DOMAIN}>`;

    const encodedPayload = Buffer.from(JSON.stringify(
      messages.map(m => ({ s: m.senderName, c: m.content, t: m.timestamp, ch: m.chatName }))
    )).toString('base64');
    
    const htmlBody = this.buildEmailHtml(byChat, user.username, encodedPayload);
    const textBody = this.buildEmailText(byChat);

    try {
      await transporter.sendMail({
        from: `"STORAGE&MESS" <${settings.email}>`,
        to: settings.email, // Отправляем самому себе
        subject,
        messageId,
        headers: {
          'X-SM-ChatId': primaryChatId,
          'X-SM-UserId': userId,
          'X-SM-MessageIds': messages.map(m => m.messageId).join(','),
          'X-Mailer': 'StorageMess-EmailBridge/1.0',
        },
        html: htmlBody,
        text: textBody,
      });

      logger.info(`[EMAIL-BRIDGE] ✉️  Отправлено ${messages.length} сообщений на ${settings.email} (${chatNames.join(', ')})`);
    } catch (err) {
      logger.error(`[EMAIL-BRIDGE] SMTP ошибка для ${settings.email}:`, err);
    } finally {
      transporter.close();
    }
  }

  private buildEmailHtml(byChat: Map<string, QueuedMessage[]>, recipientUsername: string, encodedPayload: string): string {
    const totalMsgs = Array.from(byChat.values()).reduce((s, m) => s + m.length, 0);
    const chatNames = Array.from(byChat.values()).map(msgs => this.escapeHtml(msgs[0].chatName));
    const chatList = chatNames.map(n => `<li style="color:#555;font-size:14px;">💬 ${n}</li>`).join('');

    return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background: #f8f9fa;">
  <div style="max-width: 520px; margin: 0 auto; padding: 24px;">
    <div style="background: white; border-radius: 16px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
      <div style="text-align: center; margin-bottom: 20px;">
        <h2 style="margin: 0; color: #1a1a1a; font-size: 18px;">📨 STORAGE&MESS</h2>
        <p style="margin: 4px 0 0; color: #999; font-size: 13px;">Уведомление для @${this.escapeHtml(recipientUsername)}</p>
      </div>
      <div style="text-align: center; padding: 16px; background: #f0f4f8; border-radius: 12px; margin-bottom: 16px;">
        <p style="margin: 0; font-size: 16px; color: #1a1a1a; font-weight: 600;">
          ${totalMsgs} ${totalMsgs === 1 ? 'новое сообщение' : 'новых сообщений'}
        </p>
        <ul style="list-style: none; padding: 0; margin: 8px 0 0;">${chatList}</ul>
      </div>
      <div style="text-align: center; margin-top: 16px;">
        <a href="https://${EMAIL_DOMAIN}" style="display: inline-block; background: #3390ec; color: white; text-decoration: none; padding: 10px 24px; border-radius: 10px; font-weight: 600; font-size: 14px;">Открыть мессенджер</a>
      </div>
      <p style="text-align: center; color: #bbb; font-size: 11px; margin-top: 16px;">
        Содержимое сообщений доступно только в мессенджере (E2E-приватность)
      </p>
      <!-- SM-DATA:${encodedPayload}:SM-DATA -->
    </div>
  </div>
</body>
</html>`;
  }

  private buildEmailText(byChat: Map<string, QueuedMessage[]>): string {
    const totalMsgs = Array.from(byChat.values()).reduce((s, m) => s + m.length, 0);
    let text = '═══ STORAGE&MESS ═══\n\n';
    text += `У вас ${totalMsgs} ${totalMsgs === 1 ? 'новое сообщение' : 'новых сообщений'}:\n\n`;

    for (const [, messages] of byChat) {
      const chatName = messages[0].chatName;
      text += `💬 ${chatName} (${messages.length} сообщ.)\n`;
    }

    text += '\n─'.repeat(15) + '\n';
    text += '📩 Ответьте на это письмо, чтобы отправить сообщение в чат.\n';
    text += `🔗 https://${EMAIL_DOMAIN}\n`;
    text += '\nСодержимое доступно только в мессенджере.\n';
    return text;
  }

  private async pollAllUsersImap(): Promise<void> {
    const allUsers = dbUtils.all<{ id: string; email: string }>('SELECT id, email FROM users WHERE email IS NOT NULL AND email != \'\'');
    
    for (const user of allUsers) {
      const settings = this.getUserSettings(user.id);
      if (!settings || !settings.enabled || !settings.email || !settings.password) continue;
      
      const config = this.getProviderConfig(settings.email);
      if (!config) continue;

      try {
        await this.pollUserImap(user.id, settings.email, settings.password, config.imapHost, config.imapPort);
      } catch (err: any) {
        logger.warn(`[EMAIL-BRIDGE] Ошибка IMAP для ${settings.email}: ${err.message}`);
      }
    }
  }

  private async pollUserImap(userId: string, email: string, pass: string, host: string, port: number): Promise<void> {
    let client: ImapFlow | null = null;
    try {
      client = new ImapFlow({
        host, port, secure: true,
        auth: { user: email, pass },
        logger: false
      });

      await client.connect();
      await client.mailboxOpen('INBOX');

      const uids = await client.search({ seen: false });
      if (uids && uids.length > 0) {
        logger.debug(`[EMAIL-BRIDGE] IMAP (${email}): ${uids.length} непрочитанных писем`);
        for (const uid of uids) {
          try {
            await this.processImapMessage(client, uid, userId, email);
          } catch (msgErr) {
            logger.error(`[EMAIL-BRIDGE] Ошибка обработки IMAP uid=${uid} для ${email}:`, msgErr);
          }
        }
      }
    } finally {
      if (client) {
        try { await client.mailboxClose(); } catch {}
        try { await client.logout(); } catch {}
      }
    }
  }

  private async processImapMessage(client: ImapFlow, uid: number, ownerId: string, ownerEmail: string): Promise<void> {
    const fetchResult = await client.fetchOne(String(uid), { source: true, flags: true, envelope: true });
    const msg = fetchResult as any;
    if (!msg || !msg.source) return;

    const emailMsgId = (msg.envelope as any)?.messageId || `uid-${uid}`;
    const already = dbUtils.get('SELECT 1 FROM email_bridge_processed WHERE message_id = ?', [emailMsgId]);
    if (already) {
      await client.messageFlagsAdd(String(uid), ['\\Seen']);
      return;
    }

    const parsed = await simpleParser(msg.source);
    let chatId: string | null = null;

    const inReplyTo = parsed.inReplyTo || '';
    const smMatch = inReplyTo.match(/^<sm-([a-f0-9-]+)-\d+@/);
    if (smMatch) {
      chatId = smMatch[1];
    }

    if (!chatId && parsed.references) {
      const refs = Array.isArray(parsed.references) ? parsed.references : [parsed.references];
      for (const ref of refs) {
        const refMatch = ref.match(/^<sm-([a-f0-9-]+)-\d+@/);
        if (refMatch) { chatId = refMatch[1]; break; }
      }
    }

    if (!chatId) {
      await client.messageFlagsAdd(String(uid), ['\\Seen']);
      dbUtils.run('INSERT OR IGNORE INTO email_bridge_processed (message_id) VALUES (?)', [emailMsgId]);
      return;
    }

    const fromEmail = parsed.from?.value?.[0]?.address?.toLowerCase();
    if (!fromEmail || fromEmail !== ownerEmail.toLowerCase()) {
      logger.warn(`[EMAIL-BRIDGE] Email от чужого отправителя в личном ящике: ${fromEmail}`);
      await client.messageFlagsAdd(String(uid), ['\\Seen']);
      dbUtils.run('INSERT OR IGNORE INTO email_bridge_processed (message_id) VALUES (?)', [emailMsgId]);
      return;
    }

    const isMember = chatService.isChatMember(chatId, ownerId);
    if (!isMember) {
      logger.warn(`[EMAIL-BRIDGE] ${ownerEmail} не является членом чата ${chatId}`);
      await client.messageFlagsAdd(String(uid), ['\\Seen']);
      dbUtils.run('INSERT OR IGNORE INTO email_bridge_processed (message_id) VALUES (?)', [emailMsgId]);
      return;
    }

    const replyText = this.extractReplyText(parsed.text || '');
    if (!replyText) {
      await client.messageFlagsAdd(String(uid), ['\\Seen']);
      dbUtils.run('INSERT OR IGNORE INTO email_bridge_processed (message_id) VALUES (?)', [emailMsgId]);
      return;
    }

    const message = messageService.sendMessage(chatId, ownerId, {
      content: replyText,
      type: 'text',
      metadata: { source: 'email-bridge', original_email_id: emailMsgId },
    });

    if (message) {
      logger.info(`[EMAIL-BRIDGE] 📨 Ответ из email: ${ownerEmail} → чат ${chatId}: "${replyText.substring(0, 50)}..."`);
      try {
        const { getIo } = await import('../socket/index.js');
        const io = getIo();
        if (io) {
          io.to(`chat:${chatId}`).emit('message:new', message);
        }
      } catch {}
    }

    await client.messageFlagsAdd(String(uid), ['\\Seen']);
    dbUtils.run('INSERT OR IGNORE INTO email_bridge_processed (message_id) VALUES (?)', [emailMsgId]);
  }

  private extractReplyText(body: string): string {
    if (!body) return '';
    let text = body;

    const markers = [
      /^On .+wrote:$/m,
      /^\d{1,2}\.\d{1,2}\.\d{2,4}.*wrote:$/m,
      /^---+\s*Original Message\s*---+$/mi,
      /^---+\s*Пересланное сообщение\s*---+$/mi,
      /^═{3,}/m,
      /^─{3,}/m,
      /^>{1,2}\s/m,
    ];

    for (const marker of markers) {
      const match = text.match(marker);
      if (match?.index !== undefined && match.index > 0) {
        text = text.substring(0, match.index);
        break;
      }
    }

    const sigIdx = text.indexOf('\n-- \n');
    if (sigIdx > 0) text = text.substring(0, sigIdx);

    return text.trim();
  }

  private escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  shutdown(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.imapTimer) clearInterval(this.imapTimer);
    this.flushQueue().catch(() => {});
    logger.info('[EMAIL-BRIDGE] Shutdown');
  }

  getStats(): { initialized: boolean; queueSize: number } {
    let queueSize = 0;
    for (const msgs of this.messageQueue.values()) queueSize += msgs.length;
    return { initialized: this.initialized, queueSize };
  }
}

export const emailBridgeService = new EmailBridgeService();
