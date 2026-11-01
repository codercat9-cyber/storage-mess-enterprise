import { isMuted } from './mute.service.js';
// =============================================================================
// SSE Notification Service
// Server-Sent Events для Android APK — уведомления даже когда приложение закрыто
// Лёгкий HTTP long-lived connection, без дополнительных библиотек
// =============================================================================

import { Response } from 'express';
import { logger } from '../utils/logger.js';

// userId -> множество SSE response-ов (может быть несколько устройств)
const sseClients = new Map<string, Set<Response>>();

/**
 * Зарегистрировать SSE-клиент (Android service подключается сюда)
 */
export function registerSSEClient(userId: string, res: Response): void {
  if (!sseClients.has(userId)) {
    sseClients.set(userId, new Set());
  }
  sseClients.get(userId)!.add(res);

  // Когда соединение закрывается — убираем
  res.on('close', () => {
    const clients = sseClients.get(userId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) sseClients.delete(userId);
    }
    logger.debug(`SSE client disconnected: ${userId} (${sseClients.get(userId)?.size || 0} remaining)`);
  });

  logger.info(`SSE client connected: ${userId} (${sseClients.get(userId)!.size} total)`);
}

/**
 * Закрыть все потоки уведомлений пользователя. Нужно при блокировке:
 * поток авторизуется один раз при открытии, и без этого заблокированный
 * продолжал бы получать уведомления о новых сообщениях.
 */
export function closeSSEClients(userId: string): number {
  const clients = sseClients.get(userId);
  if (!clients) return 0;
  const n = clients.size;
  for (const res of Array.from(clients)) {
    try { res.end(); } catch { /* уже закрыт */ }
  }
  sseClients.delete(userId);
  return n;
}

/**
 * Отправить SSE-событие конкретному пользователю
 */
export function sendSSEEvent(userId: string, event: string, data: Record<string, any>): void {
  const clients = sseClients.get(userId);
  if (!clients || clients.size === 0) {
    logger.debug(`SSE send ${event} to ${userId} — no clients`);
    return;
  }

  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  logger.info(`SSE send ${event} to ${userId} (${clients.size} clients)`);

  for (const res of clients) {
    try {
      const ok = res.write(payload);
      if (typeof (res as any).flush === 'function') (res as any).flush();
      logger.debug(`SSE write to ${userId}: ok=${ok}`);
    } catch (err) {
      logger.warn(`SSE write failed for ${userId}: ${err}`);
      clients.delete(res);
    }
  }
}

/**
 * Уведомить о новом сообщении (вызывать из socket handler и chat routes)
 */
export function sseNotifyMessage(
  recipientId: string,
  senderName: string,
  messageText: string,
  chatId: string,
  senderAvatarUrl?: string,
  messageId?: string,
  senderId?: string,
): void {
  // Отключённые уведомления от этого человека: сообщение уже сохранено и
  // придёт в переписку обычным путём, а телефон о нём молчит.
  if (isMuted(recipientId, senderId)) return;

  sendSSEEvent(recipientId, 'new_message', {
    senderName,
    messageText: messageText?.substring(0, 200) || '',
    chatId,
    avatarUrl: senderAvatarUrl || '',
    messageId: messageId || '',
  });
}

/**
 * Уведомить о входящем звонке
 */
export function sseNotifyCall(
  recipientId: string,
  callerName: string,
  callType: string,
  callId: string,
  callerAvatarUrl?: string,
  chatId?: string
): void {
  sendSSEEvent(recipientId, 'incoming_call', {
    callerName,
    callType,
    callId,
    chatId: chatId || '',
    avatarUrl: callerAvatarUrl || '',
  });
}

/**
 * Уведомить о завершении звонка (чтобы убрать уведомление)
 */
export function sseNotifyCallEnd(recipientId: string, callId: string): void {
  sendSSEEvent(recipientId, 'call_ended', { callId });
}

/**
 * Проверить есть ли SSE-клиент для пользователя
 */
export function hasSSEClient(userId: string): boolean {
  const clients = sseClients.get(userId);
  return !!clients && clients.size > 0;
}
