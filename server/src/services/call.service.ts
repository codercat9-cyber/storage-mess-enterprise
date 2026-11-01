import { v4 as uuidv4 } from 'uuid';
import { dbUtils } from '../database/index.js';
import { Call, CallParticipant } from '../types/index.js';
import { logger } from '../utils/logger.js';

export class CallService {
  // Инициация звонка
  initiateCall(callerId: string, chatId: string | null, type: 'audio' | 'video', participantIds: string[]): Call {
    const callId = uuidv4();
    const now = new Date().toISOString();

    dbUtils.transaction(() => {
      // Создаём звонок
      dbUtils.run(
        `INSERT INTO calls (id, chat_id, caller_id, type, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`,
        [callId, chatId, callerId, type, now]
      );

      // Добавляем инициатора как подключенного
      dbUtils.run(
        `INSERT INTO call_participants (id, call_id, user_id, status, joined_at) VALUES (?, ?, ?, 'connected', ?)`,
        [uuidv4(), callId, callerId, now]
      );

      // Добавляем остальных участников как приглашённых
      for (const participantId of participantIds) {
        if (participantId !== callerId) {
          dbUtils.run(
            `INSERT INTO call_participants (id, call_id, user_id, status) VALUES (?, ?, ?, 'invited')`,
            [uuidv4(), callId, participantId]
          );
        }
      }
    });

    logger.info(`Call initiated: ${callId} by ${callerId}`);
    return this.findById(callId)!;
  }

  // Поиск звонка по ID
  findById(callId: string): Call | undefined {
    return dbUtils.get<Call>('SELECT * FROM calls WHERE id = ?', [callId]);
  }

  // Получить активный звонок пользователя
  getActiveCall(userId: string): Call | undefined {
    return dbUtils.get<Call>(
      `SELECT c.* FROM calls c
       JOIN call_participants cp ON c.id = cp.call_id
       WHERE cp.user_id = ? AND c.status IN ('pending', 'active')
       AND cp.status IN ('connected', 'ringing', 'invited')`,
      [userId]
    );
  }

  // Автоочистка зависших pending-звонков старше указанного времени
  cleanupStaleCalls(userId: string, maxAgeMs: number = 120_000): void {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const staleCalls = dbUtils.all<Call>(
      `SELECT DISTINCT c.* FROM calls c
       JOIN call_participants cp ON c.id = cp.call_id
       WHERE cp.user_id = ? AND c.status = 'pending' AND c.created_at < ?`,
      [userId, cutoff]
    );

    for (const call of staleCalls) {
      logger.info(`Auto-cleaning stale pending call: ${call.id} (created ${call.created_at})`);
      this.endCall(call.id, userId);
    }
  }

  // Получить активные звонки пользователя (для cleanup при disconnect)
  getActiveCallsForUser(userId: string): Call[] {
    return dbUtils.all<Call>(
      `SELECT DISTINCT c.* FROM calls c
       JOIN call_participants cp ON c.id = cp.call_id
       WHERE cp.user_id = ? AND c.status IN ('pending', 'active')
       AND cp.status IN ('connected', 'ringing', 'invited')`,
      [userId]
    );
  }

  // Принудительно завершить ВСЕ активные/pending звонки пользователя
  // Возвращает массив завершённых call_id для уведомления участников
  forceEndAllActiveCalls(userId: string): string[] {
    const activeCalls = dbUtils.all<Call>(
      `SELECT DISTINCT c.* FROM calls c
       JOIN call_participants cp ON c.id = cp.call_id
       WHERE cp.user_id = ? AND c.status IN ('pending', 'active')
       AND cp.status IN ('connected', 'ringing', 'invited')`,
      [userId]
    );

    const endedCallIds: string[] = [];
    for (const call of activeCalls) {
      logger.info(`Force-ending call ${call.id} (status: ${call.status}) for user ${userId} before new call`);
      this.endCall(call.id, userId);
      endedCallIds.push(call.id);
    }
    return endedCallIds;
  }

  // Получить участников звонка
  getParticipants(callId: string): CallParticipant[] {
    return dbUtils.all<CallParticipant>(
      'SELECT * FROM call_participants WHERE call_id = ?',
      [callId]
    );
  }

  // Ответить на звонок
  answerCall(callId: string, userId: string): boolean {
    const call = this.findById(callId);
    if (!call || call.status === 'ended') return false;

    const participant = dbUtils.get<CallParticipant>(
      'SELECT * FROM call_participants WHERE call_id = ? AND user_id = ?',
      [callId, userId]
    );

    if (!participant) return false;
    // Если уже connected (повторный вызов) — всё ок
    if (participant.status === 'connected') return true;

    const now = new Date().toISOString();

    dbUtils.transaction(() => {
      // Обновляем статус участника
      dbUtils.run(
        'UPDATE call_participants SET status = ?, joined_at = ? WHERE call_id = ? AND user_id = ?',
        ['connected', now, callId, userId]
      );

      // Если звонок был pending, делаем его active
      if (call.status === 'pending') {
        dbUtils.run(
          'UPDATE calls SET status = ?, started_at = ? WHERE id = ?',
          ['active', now, callId]
        );
      }
    });

    logger.info(`Call answered: ${callId} by ${userId}`);
    return true;
  }

  // Отклонить звонок
  rejectCall(callId: string, userId: string): boolean {
    const call = this.findById(callId);
    if (!call || call.status === 'ended') return false;

    const participant = dbUtils.get<CallParticipant>(
      'SELECT * FROM call_participants WHERE call_id = ? AND user_id = ?',
      [callId, userId]
    );

    if (!participant) return false;

    dbUtils.run(
      'UPDATE call_participants SET status = ?, left_at = ? WHERE call_id = ? AND user_id = ?',
      ['left', new Date().toISOString(), callId, userId]
    );

    // Проверяем, остались ли участники
    const activeParticipants = dbUtils.all<CallParticipant>(
      `SELECT * FROM call_participants WHERE call_id = ? AND status IN ('connected', 'ringing', 'invited')`,
      [callId]
    );

    // Если звонок был только между двумя людьми и один отклонил
    if (activeParticipants.length <= 1) {
      this.endCall(callId, call.caller_id);
    }

    logger.info(`Call rejected: ${callId} by ${userId}`);
    return true;
  }

  // Завершить звонок
  endCall(callId: string, userId: string): boolean {
    const call = this.findById(callId);
    if (!call) return false;

    const now = new Date().toISOString();
    let duration = 0;

    if (call.started_at) {
      duration = Math.floor((new Date(now).getTime() - new Date(call.started_at).getTime()) / 1000);
    }

    // Определяем статус - если никто не ответил, это missed
    const status = call.status === 'pending' ? 'missed' : 'ended';

    dbUtils.transaction(() => {
      // Обновляем звонок
      dbUtils.run(
        'UPDATE calls SET status = ?, ended_at = ?, duration = ? WHERE id = ?',
        [status, now, duration, callId]
      );

      // Обновляем всех участников
      dbUtils.run(
        `UPDATE call_participants SET status = 'left', left_at = ? WHERE call_id = ? AND status != 'left'`,
        [now, callId]
      );
    });

    logger.info(`Call ended: ${callId}, duration: ${duration}s, status: ${status}`);
    return true;
  }

  // Покинуть звонок (для групповых)
  leaveCall(callId: string, userId: string): boolean {
    const call = this.findById(callId);
    if (!call || call.status === 'ended') return false;

    dbUtils.run(
      'UPDATE call_participants SET status = ?, left_at = ? WHERE call_id = ? AND user_id = ?',
      ['left', new Date().toISOString(), callId, userId]
    );

    // Проверяем, остались ли активные участники
    const activeParticipants = dbUtils.all<CallParticipant>(
      `SELECT * FROM call_participants WHERE call_id = ? AND status = 'connected'`,
      [callId]
    );

    // Если меньше 2 участников осталось, завершаем звонок
    if (activeParticipants.length < 2) {
      this.endCall(callId, userId);
    }

    return true;
  }

  // Обновить статус участника (например, ringing)
  updateParticipantStatus(callId: string, userId: string, status: CallParticipant['status']): void {
    dbUtils.run(
      'UPDATE call_participants SET status = ? WHERE call_id = ? AND user_id = ?',
      [status, callId, userId]
    );
  }

  // Получить историю звонков пользователя
  getCallHistory(userId: string, limit: number = 50): Array<Call & { participants: CallParticipant[] }> {
    const calls = dbUtils.all<Call>(
      `SELECT DISTINCT c.* FROM calls c
       JOIN call_participants cp ON c.id = cp.call_id
       WHERE cp.user_id = ?
       ORDER BY c.created_at DESC
       LIMIT ?`,
      [userId, limit]
    );

    return calls.map(call => ({
      ...call,
      participants: this.getParticipants(call.id),
    }));
  }

  // Получить пропущенные звонки
  getMissedCalls(userId: string): Call[] {
    return dbUtils.all<Call>(
      `SELECT c.* FROM calls c
       JOIN call_participants cp ON c.id = cp.call_id
       WHERE cp.user_id = ? AND c.status = 'missed' AND cp.status = 'invited'
       ORDER BY c.created_at DESC`,
      [userId]
    );
  }
}

export const callService = new CallService();
export default callService;
