// =============================================================================
// Web Push Notification Service
// Отправка push-уведомлений через Web Push API (VAPID)
// Работает даже когда приложение закрыто
// =============================================================================

import webpush from 'web-push';
import admin from 'firebase-admin';
import path from 'path';
import fs from 'fs';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { dbUtils } from '../database/index.js';
import { isMuted } from './mute.service.js';

// ─── Тип подписки ───
interface PushSubscriptionData {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

interface StoredSubscription {
  userId: string;
  subscription: PushSubscriptionData;
  createdAt: number;
}

// ─── Хранилище подписок ───
//
// Раньше это была Map в памяти процесса с пометкой «в проде можно вынести
// в SQLite». В прод так и уехало: любой перезапуск сервера стирал подписки
// у всех разом. Клиент переподписывается при следующем подключении сокета,
// поэтому у того, кто держит приложение открытым, всё выглядело нормально —
// а спящий телефон оставался без уведомлений до тех пор, пока его не
// откроют руками. Теперь подписки лежат в базе и переживают перезапуск.

// ─── Инициализация VAPID ───
let initialized = false;

export function initPushService(): boolean {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@localhost';

  if (!publicKey || !privateKey) {
    logger.warn('⚠ Web Push disabled: VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY not set in .env');
    return false;
  }

  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    initialized = true;
    logger.info('🔔 Web Push initialized (VAPID)');
  } catch (err) {
    logger.error('Web Push init error:', err);
  }

  // Инициализация Firebase Admin
  try {
    const serviceAccountPath = path.resolve(process.cwd(), 'google-services.json');
    if (fs.existsSync(serviceAccountPath)) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccountPath),
      });
      logger.info('🔔 Firebase Cloud Messaging initialized');
    } else {
      logger.warn('⚠ FCM disabled: google-services.json not found in server root');
    }
  } catch (err) {
    logger.error('FCM init error:', err);
  }

  return initialized;
}

export function getVapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY || null;
}

// ─── Управление подписками ───

export function addSubscription(userId: string, subscription: PushSubscriptionData): void {
  try {
    // Ключ — endpoint: он уникален для связки браузер+устройство. Если то
    // же устройство переподписалось, строка обновится; если этим endpoint
    // пришёл другой человек (вошли под другой учёткой) — подписка
    // переезжает к нему, иначе прошлый владелец получал бы чужое.
    dbUtils.run(
      `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, last_seen_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(endpoint) DO UPDATE SET
         user_id = excluded.user_id,
         p256dh  = excluded.p256dh,
         auth    = excluded.auth,
         last_seen_at = CURRENT_TIMESTAMP`,
      [subscription.endpoint, userId, subscription.keys.p256dh, subscription.keys.auth]
    );
    const n = dbUtils.get<{ n: number }>(
      'SELECT COUNT(*) n FROM push_subscriptions WHERE user_id = ?', [userId])?.n ?? 1;
    logger.info(`🔔 Push subscription saved for user ${userId} (устройств: ${n})`);
  } catch (err) {
    logger.error('Push subscription save error:', err);
  }
}

/**
 * Заменить подписку, адрес которой сменил браузер.
 *
 * Вызывается самим сервис-воркером без входа в учётку — и это намеренно.
 * Токена у него нет: страница может быть закрыта неделями, а подписка
 * меняется в фоне. Опознаём по СТАРОМУ адресу: он уже привязан к человеку,
 * и знать его может только тот, кому подписка принадлежит. Если такого
 * адреса у нас нет — ничего не создаём, чтобы никто не мог записать себе
 * чужую подписку.
 *
 * Возвращает владельца, если замена удалась.
 */
export function replaceSubscription(
  oldEndpoint: string,
  subscription: PushSubscriptionData,
): string | null {
  try {
    const row = dbUtils.get<{ user_id: string }>(
      'SELECT user_id FROM push_subscriptions WHERE endpoint = ?', [oldEndpoint]);
    if (!row) return null;

    dbUtils.run('DELETE FROM push_subscriptions WHERE endpoint = ?', [oldEndpoint]);
    addSubscription(row.user_id, subscription);
    logger.info(`🔔 Подписка на уведомления обновлена для ${row.user_id} (адрес сменился)`);
    return row.user_id;
  } catch (err) {
    logger.error('Не удалось обновить подписку на уведомления:', err);
    return null;
  }
}

export function removeSubscription(userId: string, endpoint: string): void {
  try {
    dbUtils.run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?',
                [endpoint, userId]);
  } catch (err) {
    logger.error('Push subscription remove error:', err);
  }
}

export function getUserSubscriptions(userId: string): StoredSubscription[] {
  try {
    const rows = dbUtils.all<{ endpoint: string; p256dh: string; auth: string; created_at: string }>(
      'SELECT endpoint, p256dh, auth, created_at FROM push_subscriptions WHERE user_id = ?',
      [userId]
    );
    return rows.map(r => ({
      userId,
      subscription: { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } },
      createdAt: new Date(r.created_at).getTime() || Date.now(),
    }));
  } catch (err) {
    logger.error('Push subscription read error:', err);
    return [];
  }
}

// ─── Отправка push-уведомлений ───

interface PushPayload {
  type: 'message' | 'call';
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  tag?: string;
  data?: any;
  requireInteraction?: boolean;
}

async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  if (!initialized) return;

  const userSubs = getUserSubscriptions(userId);
  if (userSubs.length === 0) return;

  const payloadStr = JSON.stringify(payload);
  const expiredEndpoints: string[] = [];

  for (const sub of userSubs) {
    try {
      await webpush.sendNotification(sub.subscription as any, payloadStr, {
        TTL: payload.type === 'call' ? 30 : 3600, // Звонок — 30с, сообщение — 1ч
        urgency: payload.type === 'call' ? 'high' : 'normal',
      });
    } catch (err: any) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        // Подписка протухла — удалить
        expiredEndpoints.push(sub.subscription.endpoint);
        logger.info(`🔔 Push subscription expired for user ${userId}, removing`);
      } else {
        logger.warn(`🔔 Push send error to user ${userId}:`, err.message || err);
      }
    }
  }

  // Удаляем протухшие подписки
  for (const endpoint of expiredEndpoints) {
    removeSubscription(userId, endpoint);
  }

  // ─── FCM (Blind Push) ───
  //
  // Шлём на ВСЕ устройства человека, а не на одно. Раньше здесь читалась
  // колонка users.push_token — единственная на человека, — и уведомление
  // уходило только на то устройство, что регистрировалось последним.
  try {
    if (admin.apps.length === 0) return;

    const rows = dbUtils.all<{ token: string; device_label: string | null }>(
      'SELECT token, device_label FROM push_tokens WHERE user_id = ?', [userId]
    );
    if (rows.length === 0) return;

    const dead: string[] = [];
    const results = await Promise.allSettled(rows.map(r =>
      admin.messaging().send({
        token: r.token,
        android: { priority: 'high', ttl: 86400 * 1000 },
        // Отправляем строго "слепой" пуш: только data-блок
        data: { action: 'wakeup', chat_id: payload.data?.chatId || '' },
      })
    ));

    results.forEach((res, i) => {
      if (res.status === 'fulfilled') return;
      const code = (res.reason as any)?.errorInfo?.code || (res.reason as any)?.code || '';
      // Приложение удалили или токен перевыпустили — такую строку надо
      // убрать, иначе она будет копиться и каждый раз давать ошибку.
      if (String(code).includes('registration-token-not-registered')
          || String(code).includes('invalid-registration-token')
          || String(code).includes('invalid-argument')) {
        dead.push(rows[i].token);
      } else {
        logger.warn(`⚠ FCM push failed (${rows[i].device_label || 'устройство'}): ${code || res.reason}`);
      }
    });

    for (const t of dead) {
      dbUtils.run('DELETE FROM push_tokens WHERE token = ?', [t]);
    }

    const ok = results.filter(r => r.status === 'fulfilled').length;
    logger.info(`🔔 FCM Blind Push: ${ok}/${rows.length} устройств у ${userId}` +
                (dead.length ? `, убрано протухших: ${dead.length}` : ''));
  } catch (err: any) {
    logger.warn(`⚠ FCM Blind Push failed for user ${userId}:`, err.message || err);
  }
}

// ─── Высокоуровневые функции ───

/**
 * Отправить push о новом сообщении
 */
/**
 * Свои эмодзи в тексте для шторки уведомлений.
 *
 * В сообщениях они хранятся токеном `[e:категория_номер]` и в приложении
 * подменяются картинкой. Но в системную шторку картинку не подсунешь, и
 * человек видел там голый `[e:0_2]`.
 *
 * Точной карты «наш номер → символ юникода» в проекте нет: спрайты
 * нарезаны без манифеста, а порядок в наборе НЕ совпадает со стандартным
 * юникодным (проверено по картинкам: после 😋 идёт 😛 😝 😜 🤪, а не
 * 😛 😜 🤪 😝). Подставлять по номеру наугад — значит показывать не те
 * лица, это хуже токена. Поэтому берём эмодзи по КАТЕГОРИИ: символ всегда
 * настоящий, системный, и по смыслу в ту же сторону.
 *
 * Чтобы подставлять точь-в-точь, нужен манифест рядом со спрайтами —
 * это отдельная задача на пересборку набора.
 */
const EMOJI_BY_CATEGORY: Record<string, string> = {
  '0': '🙂', // смайлики
  '1': '🐾', // животные
  '2': '🍔', // еда
  '3': '⚽', // спорт
  '4': '✈️', // путешествия
  '5': '📦', // объекты
  '6': '❤️', // сердца
  '7': '🏳️', // флаги
};

export function customEmojiToSystem(text: string): string {
  if (!text) return text;
  return text.replace(/\[e:(\d+)_\d+\]/g, (_m, cat: string) => EMOJI_BY_CATEGORY[cat] || '🙂');
}

export async function pushNewMessage(
  recipientUserId: string,
  senderName: string,
  messageText: string,
  chatId?: string,
  senderId?: string,
): Promise<void> {
  // Человек мог отключить уведомления именно от этого собеседника.
  // Само сообщение при этом доставляется как обычно — молчит только
  // уведомление.
  if (isMuted(recipientUserId, senderId)) return;

  const clean = customEmojiToSystem(messageText);
  const text = clean.length > 100 ? clean.slice(0, 97) + '...' : clean;

  await sendPushToUser(recipientUserId, {
    type: 'message',
    title: `💬 ${senderName}`,
    body: text,
    icon: '/pwa-192x192.png',
    badge: '/pwa-64x64.png',
    tag: `msg-${chatId || 'default'}`,
    data: { type: 'message', chatId, senderName },
  });
}

/**
 * Отправить push о входящем звонке
 */
export async function pushIncomingCall(
  recipientUserId: string,
  callerName: string,
  callType: 'audio' | 'video',
  callId?: string,
): Promise<void> {
  const callTypeText = callType === 'video' ? '📹 Видеозвонок' : '📞 Аудиозвонок';

  await sendPushToUser(recipientUserId, {
    type: 'call',
    title: `${callTypeText} от ${callerName}`,
    body: 'Нажмите чтобы ответить',
    icon: '/pwa-192x192.png',
    badge: '/pwa-64x64.png',
    tag: `call-${callId || 'incoming'}`,
    requireInteraction: true,
    data: { type: 'call', callId, callType, callerName },
  });
}

export const pushService = {
  initPushService,
  getVapidPublicKey,
  addSubscription,
  removeSubscription,
  getUserSubscriptions,
  pushNewMessage,
  pushIncomingCall,
};
