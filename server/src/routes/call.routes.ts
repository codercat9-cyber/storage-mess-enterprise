import { Router, Request, Response } from 'express';
import { callService } from '../services/call.service.js';
import { authMiddleware } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';
import { notifyCallParticipants } from '../socket/index.js';

/**
 * Звонки по обычному HTTP — для кнопок в шторке уведомлений.
 *
 * Всё остальное про звонки живёт в сокете, и это правильно: там сигналинг
 * и там же присутствие. Но у кнопок «Ответить» и «Отклонить» в шторке
 * Android сокета нет и быть не может — приложение в этот момент свёрнуто
 * или вовсе закрыто, а нажатие обрабатывает BroadcastReceiver в отдельном
 * процессе.
 *
 * Раньше «Отклонить» просто записывало номер звонка в настройки телефона
 * в надежде, что интерфейс когда-нибудь его прочитает. Для звонящего это
 * выглядело так, будто трубку никто не берёт: гудки шли до таймаута.
 * Теперь отказ доходит сразу.
 */
const router = Router();

router.use(authMiddleware);

/** Отклонить входящий звонок. */
router.post('/:callId/reject', (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { callId } = req.params;

    const call = callService.findById(callId);
    if (!call) {
      // Звонок уже мог закончиться сам — это не ошибка, отказываться не от чего.
      res.json({ success: true, alreadyGone: true });
      return;
    }

    callService.rejectCall(callId, userId);
    notifyCallParticipants(callId, userId, 'call:rejected', { call_id: callId, user_id: userId });
    logger.info(`Звонок ${callId} отклонён из шторки пользователем ${userId}`);
    res.json({ success: true });
  } catch (error) {
    logger.error('Ошибка отклонения звонка по HTTP:', error);
    res.status(500).json({ error: 'Failed to reject call' });
  }
});

/** Завершить идущий звонок (кнопка «Отбой» в панели звонка). */
router.post('/:callId/end', (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { callId } = req.params;

    const call = callService.findById(callId);
    if (!call) {
      res.json({ success: true, alreadyGone: true });
      return;
    }

    callService.endCall(callId, userId);
    notifyCallParticipants(callId, userId, 'call:ended', { call_id: callId, ended_by: userId });
    logger.info(`Звонок ${callId} завершён из шторки пользователем ${userId}`);
    res.json({ success: true });
  } catch (error) {
    logger.error('Ошибка завершения звонка по HTTP:', error);
    res.status(500).json({ error: 'Failed to end call' });
  }
});

export default router;
