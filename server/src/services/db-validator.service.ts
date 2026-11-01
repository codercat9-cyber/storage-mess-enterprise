import { dbUtils, getDatabase } from '../database/index.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';
import path from 'path';
import fs from 'fs';

interface ValidationResult {
  check: string;
  status: 'ok' | 'warn' | 'error' | 'fixed';
  details?: string;
  count?: number;
}

/**
 * Валидатор целостности базы данных мессенджера.
 * Запускается автоматически при старте сервера.
 * Проверяет: структуру таблиц, внешние ключи, осиротевшие записи,
 * файлы на диске, просроченные токены, битые метаданные и т.д.
 */
export function validateDatabase(): ValidationResult[] {
  const results: ValidationResult[] = [];
  const start = Date.now();

  logger.info('🔍 Запуск валидации базы данных...');

  // 1. Проверка целостности SQLite (PRAGMA integrity_check)
  try {
    const db = getDatabase();
    const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    const isOk = integrity.length === 1 && integrity[0].integrity_check === 'ok';
    results.push({
      check: 'SQLite integrity_check',
      status: isOk ? 'ok' : 'error',
      details: isOk ? 'База данных не повреждена' : integrity.map(r => r.integrity_check).join('; '),
    });
  } catch (e: any) {
    results.push({ check: 'SQLite integrity_check', status: 'error', details: e.message });
  }

  // 2. Проверка foreign_key violations
  try {
    const db = getDatabase();
    const fkErrors = db.pragma('foreign_key_check') as Array<{ table: string; rowid: number; parent: string; fkid: number }>;
    if (fkErrors.length === 0) {
      results.push({ check: 'Foreign key integrity', status: 'ok', details: 'Нарушений внешних ключей нет' });
    } else {
      results.push({
        check: 'Foreign key integrity',
        status: 'warn',
        details: `Найдено ${fkErrors.length} нарушений FK: ${fkErrors.slice(0, 5).map(e => `${e.table}[${e.rowid}]->${e.parent}`).join(', ')}`,
        count: fkErrors.length,
      });
    }
  } catch (e: any) {
    results.push({ check: 'Foreign key integrity', status: 'error', details: e.message });
  }

  // 3. Проверка наличия всех таблиц
  const requiredTables = [
    'users', 'contacts', 'chats', 'chat_members', 'messages', 'message_reads',
    'files', 'calls', 'call_participants', 'refresh_tokens', 'user_settings',
    'message_reactions', 'message_deletions', 'user_public_keys', 'password_reset_tokens',
  ];
  try {
    const existing = dbUtils.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).map(r => r.name);
    const missing = requiredTables.filter(t => !existing.includes(t));
    results.push({
      check: 'Таблицы БД',
      status: missing.length === 0 ? 'ok' : 'error',
      details: missing.length === 0 ? `Все ${requiredTables.length} таблиц на месте` : `Отсутствуют: ${missing.join(', ')}`,
      count: existing.length,
    });
  } catch (e: any) {
    results.push({ check: 'Таблицы БД', status: 'error', details: e.message });
  }

  // 4. Проверка индексов
  try {
    const indexes = dbUtils.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
    );
    results.push({
      check: 'Индексы',
      status: indexes.length >= 10 ? 'ok' : 'warn',
      details: `${indexes.length} пользовательских индексов`,
      count: indexes.length,
    });
  } catch (e: any) {
    results.push({ check: 'Индексы', status: 'error', details: e.message });
  }

  // 5. Осиротевшие участники чатов (chat_members без чата)
  try {
    const orphanMembers = dbUtils.get<{ count: number }>(
      'SELECT COUNT(*) as count FROM chat_members WHERE chat_id NOT IN (SELECT id FROM chats)'
    );
    const cnt = orphanMembers?.count || 0;
    if (cnt > 0) {
      dbUtils.run('DELETE FROM chat_members WHERE chat_id NOT IN (SELECT id FROM chats)');
      results.push({ check: 'Осиротевшие chat_members', status: 'fixed', details: `Удалено ${cnt} записей`, count: cnt });
    } else {
      results.push({ check: 'Осиротевшие chat_members', status: 'ok', details: 'Нет осиротевших записей' });
    }
  } catch (e: any) {
    results.push({ check: 'Осиротевшие chat_members', status: 'error', details: e.message });
  }

  // 6. Осиротевшие сообщения (messages без чата)
  try {
    const orphanMsgs = dbUtils.get<{ count: number }>(
      'SELECT COUNT(*) as count FROM messages WHERE chat_id NOT IN (SELECT id FROM chats)'
    );
    const cnt = orphanMsgs?.count || 0;
    if (cnt > 0) {
      dbUtils.run('DELETE FROM messages WHERE chat_id NOT IN (SELECT id FROM chats)');
      results.push({ check: 'Осиротевшие messages', status: 'fixed', details: `Удалено ${cnt} сообщений без чата`, count: cnt });
    } else {
      results.push({ check: 'Осиротевшие messages', status: 'ok', details: 'Все сообщения привязаны к чатам' });
    }
  } catch (e: any) {
    results.push({ check: 'Осиротевшие messages', status: 'error', details: e.message });
  }

  // 7. Осиротевшие реакции (message_reactions на удалённые сообщения)
  try {
    const orphanReactions = dbUtils.get<{ count: number }>(
      'SELECT COUNT(*) as count FROM message_reactions WHERE message_id NOT IN (SELECT id FROM messages)'
    );
    const cnt = orphanReactions?.count || 0;
    if (cnt > 0) {
      dbUtils.run('DELETE FROM message_reactions WHERE message_id NOT IN (SELECT id FROM messages)');
      results.push({ check: 'Осиротевшие реакции', status: 'fixed', details: `Удалено ${cnt} реакций`, count: cnt });
    } else {
      results.push({ check: 'Осиротевшие реакции', status: 'ok', details: 'Нет осиротевших реакций' });
    }
  } catch (e: any) {
    results.push({ check: 'Осиротевшие реакции', status: 'error', details: e.message });
  }

  // 8. Осиротевшие message_reads
  try {
    const orphanReads = dbUtils.get<{ count: number }>(
      'SELECT COUNT(*) as count FROM message_reads WHERE message_id NOT IN (SELECT id FROM messages)'
    );
    const cnt = orphanReads?.count || 0;
    if (cnt > 0) {
      dbUtils.run('DELETE FROM message_reads WHERE message_id NOT IN (SELECT id FROM messages)');
      results.push({ check: 'Осиротевшие message_reads', status: 'fixed', details: `Удалено ${cnt}`, count: cnt });
    } else {
      results.push({ check: 'Осиротевшие message_reads', status: 'ok' });
    }
  } catch (e: any) {
    results.push({ check: 'Осиротевшие message_reads', status: 'error', details: e.message });
  }

  // 9. Осиротевшие message_deletions
  try {
    const orphanDel = dbUtils.get<{ count: number }>(
      'SELECT COUNT(*) as count FROM message_deletions WHERE message_id NOT IN (SELECT id FROM messages)'
    );
    const cnt = orphanDel?.count || 0;
    if (cnt > 0) {
      dbUtils.run('DELETE FROM message_deletions WHERE message_id NOT IN (SELECT id FROM messages)');
      results.push({ check: 'Осиротевшие message_deletions', status: 'fixed', details: `Удалено ${cnt}`, count: cnt });
    } else {
      results.push({ check: 'Осиротевшие message_deletions', status: 'ok' });
    }
  } catch (e: any) {
    results.push({ check: 'Осиротевшие message_deletions', status: 'error', details: e.message });
  }

  // 10. Просроченные refresh токены — очистка
  try {
    const now = new Date().toISOString();
    const expired = dbUtils.get<{ count: number }>(
      'SELECT COUNT(*) as count FROM refresh_tokens WHERE expires_at < ?', [now]
    );
    const cnt = expired?.count || 0;
    if (cnt > 0) {
      dbUtils.run('DELETE FROM refresh_tokens WHERE expires_at < ?', [now]);
      results.push({ check: 'Просроченные refresh_tokens', status: 'fixed', details: `Очищено ${cnt} истёкших токенов`, count: cnt });
    } else {
      results.push({ check: 'Просроченные refresh_tokens', status: 'ok', details: 'Нет просроченных токенов' });
    }
  } catch (e: any) {
    results.push({ check: 'Просроченные refresh_tokens', status: 'error', details: e.message });
  }

  // 11. Использованные/просроченные password_reset_tokens — очистка
  try {
    const now = new Date().toISOString();
    const stale = dbUtils.get<{ count: number }>(
      'SELECT COUNT(*) as count FROM password_reset_tokens WHERE used = 1 OR expires_at < ?', [now]
    );
    const cnt = stale?.count || 0;
    if (cnt > 0) {
      dbUtils.run('DELETE FROM password_reset_tokens WHERE used = 1 OR expires_at < ?', [now]);
      results.push({ check: 'Просроченные reset_tokens', status: 'fixed', details: `Очищено ${cnt}`, count: cnt });
    } else {
      results.push({ check: 'Просроченные reset_tokens', status: 'ok' });
    }
  } catch (e: any) {
    results.push({ check: 'Просроченные reset_tokens', status: 'error', details: e.message });
  }

  // 12. Проверка файлов на диске — есть ли записи в files без файла на диске
  try {
    const files = dbUtils.all<{ id: string; storage_path: string; original_name: string }>(
      'SELECT id, storage_path, original_name FROM files'
    );
    let missingCount = 0;
    const storagePath = path.resolve(config.storage.path);
    for (const file of files) {
      const fullPath = path.resolve(storagePath, file.storage_path);
      // Защита от path traversal
      if (!fullPath.startsWith(storagePath)) continue;
      if (!fs.existsSync(fullPath)) missingCount++;
    }
    results.push({
      check: 'Файлы на диске',
      status: missingCount === 0 ? 'ok' : 'warn',
      details: missingCount === 0 ? `Все ${files.length} файлов на месте` : `${missingCount} из ${files.length} файлов отсутствуют на диске`,
      count: missingCount,
    });
  } catch (e: any) {
    results.push({ check: 'Файлы на диске', status: 'error', details: e.message });
  }

  // 13. Голосовые — проверка что файлы voice существуют
  try {
    const voiceDir = path.resolve(config.storage.path, 'voice');
    const voiceMsgs = dbUtils.all<{ id: string; metadata: string }>(
      "SELECT id, metadata FROM messages WHERE type = 'voice' AND deleted_at IS NULL AND metadata IS NOT NULL"
    );
    let missingVoice = 0;
    let checkedVoice = 0;
    for (const msg of voiceMsgs) {
      try {
        const meta = typeof msg.metadata === 'string' ? JSON.parse(msg.metadata) : msg.metadata;
        // Пропускаем voice с пометкой file_lost (файл безвозвратно утерян)
        if (meta?.file_lost) continue;
        if (meta?.filename) {
          checkedVoice++;
          const fullPath = path.resolve(voiceDir, meta.filename);
          if (!fullPath.startsWith(voiceDir)) continue;
          if (!fs.existsSync(fullPath)) missingVoice++;
        }
      } catch { /* битый JSON — пропускаем */ }
    }
    results.push({
      check: 'Голосовые файлы',
      status: missingVoice === 0 ? 'ok' : 'warn',
      details: missingVoice === 0 ? `Все ${checkedVoice} голосовых на месте` : `${missingVoice} из ${checkedVoice} голосовых отсутствуют`,
      count: missingVoice,
    });
  } catch (e: any) {
    results.push({ check: 'Голосовые файлы', status: 'error', details: e.message });
  }

  // 14. Пустые чаты без участников
  try {
    const emptyCh = dbUtils.get<{ count: number }>(
      'SELECT COUNT(*) as count FROM chats WHERE id NOT IN (SELECT DISTINCT chat_id FROM chat_members)'
    );
    const cnt = emptyCh?.count || 0;
    results.push({
      check: 'Пустые чаты',
      status: cnt === 0 ? 'ok' : 'warn',
      details: cnt === 0 ? 'Все чаты имеют участников' : `${cnt} чатов без участников`,
      count: cnt,
    });
  } catch (e: any) {
    results.push({ check: 'Пустые чаты', status: 'error', details: e.message });
  }

  // 15. Дубли участников в чатах
  try {
    const dupes = dbUtils.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM (
        SELECT chat_id, user_id, COUNT(*) as c FROM chat_members GROUP BY chat_id, user_id HAVING c > 1
      )`
    );
    const cnt = dupes?.count || 0;
    results.push({
      check: 'Дубли chat_members',
      status: cnt === 0 ? 'ok' : 'warn',
      details: cnt === 0 ? 'Дублей нет' : `${cnt} пар с дублями`,
      count: cnt,
    });
  } catch (e: any) {
    results.push({ check: 'Дубли chat_members', status: 'error', details: e.message });
  }

  // 16. Битые метаданные сообщений (невалидный JSON)
  try {
    const allMeta = dbUtils.all<{ id: string; metadata: string }>(
      "SELECT id, metadata FROM messages WHERE metadata IS NOT NULL AND metadata != '' AND deleted_at IS NULL"
    );
    let broken = 0;
    for (const m of allMeta) {
      try {
        if (typeof m.metadata === 'string') JSON.parse(m.metadata);
      } catch { broken++; }
    }
    results.push({
      check: 'Метаданные сообщений (JSON)',
      status: broken === 0 ? 'ok' : 'warn',
      details: broken === 0 ? `Все ${allMeta.length} метаданных валидны` : `${broken} из ${allMeta.length} с битым JSON`,
      count: broken,
    });
  } catch (e: any) {
    results.push({ check: 'Метаданные сообщений (JSON)', status: 'error', details: e.message });
  }

  // 17. Статистика БД
  try {
    const stats = {
      users: dbUtils.get<{ c: number }>('SELECT COUNT(*) as c FROM users')?.c || 0,
      chats: dbUtils.get<{ c: number }>('SELECT COUNT(*) as c FROM chats')?.c || 0,
      messages: dbUtils.get<{ c: number }>('SELECT COUNT(*) as c FROM messages WHERE deleted_at IS NULL')?.c || 0,
      files: dbUtils.get<{ c: number }>('SELECT COUNT(*) as c FROM files')?.c || 0,
      contacts: dbUtils.get<{ c: number }>('SELECT COUNT(*) as c FROM contacts')?.c || 0,
    };
    results.push({
      check: 'Статистика',
      status: 'ok',
      details: `Пользователей: ${stats.users}, чатов: ${stats.chats}, сообщений: ${stats.messages}, файлов: ${stats.files}, контактов: ${stats.contacts}`,
    });
  } catch (e: any) {
    results.push({ check: 'Статистика', status: 'error', details: e.message });
  }

  // 18. WAL checkpoint — сбрасываем WAL в основной файл
  try {
    const db = getDatabase();
    db.pragma('wal_checkpoint(TRUNCATE)');
    results.push({ check: 'WAL checkpoint', status: 'ok', details: 'WAL сброшен в основной файл' });
  } catch (e: any) {
    results.push({ check: 'WAL checkpoint', status: 'warn', details: e.message });
  }

  const elapsed = Date.now() - start;
  const errors = results.filter(r => r.status === 'error').length;
  const warnings = results.filter(r => r.status === 'warn').length;
  const fixed = results.filter(r => r.status === 'fixed').length;

  // Лог результатов
  const icon = errors > 0 ? '❌' : warnings > 0 ? '⚠️' : '✅';
  logger.info(`${icon} Валидация БД завершена за ${elapsed}мс: ${results.length} проверок, ${errors} ошибок, ${warnings} предупреждений, ${fixed} исправлений`);

  for (const r of results) {
    const sym = r.status === 'ok' ? '✅' : r.status === 'fixed' ? '🔧' : r.status === 'warn' ? '⚠️' : '❌';
    logger.info(`  ${sym} ${r.check}: ${r.details || r.status}`);
  }

  return results;
}

export default { validateDatabase };
