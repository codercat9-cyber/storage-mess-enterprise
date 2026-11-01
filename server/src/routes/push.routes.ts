// =============================================================================
// Push Notification Routes — /api/push/*
// =============================================================================

import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { getVapidPublicKey, addSubscription, removeSubscription, replaceSubscription } from '../services/push.service.js';
import { logger } from '../utils/logger.js';

const router = Router();

// GET /api/push/vapid-key — Получить публичный VAPID ключ
router.get('/vapid-key', authMiddleware, (_req: Request, res: Response) => {
  const publicKey = getVapidPublicKey();
  if (!publicKey) {
    return res.status(503).json({ error: 'Push notifications not configured' });
  }
  res.json({ publicKey });
});

// POST /api/push/subscribe — Подписаться на push-уведомления
router.post('/subscribe', authMiddleware, (req: Request, res: Response) => {
  const userId = (req as any).user?.userId;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { endpoint, keys } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'Invalid push subscription data' });
  }

  addSubscription(userId, { endpoint, keys });
  res.json({ success: true });
});

// POST /api/push/unsubscribe — Отписаться
// Сервис-воркер сообщает, что браузер сменил адрес подписки.
//
// Без входа в учётку: у воркера нет токена, он работает в фоне при закрытом
// приложении. Опознаём по старому адресу — см. replaceSubscription.
router.post('/resubscribe', (req: Request, res: Response) => {
  try {
    const { oldEndpoint, subscription } = req.body || {};
    if (!oldEndpoint || !subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      res.status(400).json({ error: 'Нужны старый адрес и новая подписка' });
      return;
    }

    const userId = replaceSubscription(oldEndpoint, subscription);
    if (!userId) {
      // Старого адреса у нас нет — значит подтвердить владение нечем.
      res.status(404).json({ error: 'Прежняя подписка не найдена' });
      return;
    }

    res.json({ ok: true });
  } catch (error) {
    logger.error('Ошибка обновления подписки:', error);
    res.status(500).json({ error: 'Не удалось обновить подписку' });
  }
});

router.post('/unsubscribe', authMiddleware, (req: Request, res: Response) => {
  const userId = (req as any).user?.userId;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { endpoint } = req.body;
  if (!endpoint) {
    return res.status(400).json({ error: 'Missing endpoint' });
  }

  removeSubscription(userId, endpoint);
  res.json({ success: true });
});

export default router;
