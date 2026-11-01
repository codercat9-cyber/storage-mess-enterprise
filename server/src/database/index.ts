import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from '../config/index.js';
import schema, { migrations } from './schema.js';
import { logger } from '../utils/logger.js';

let db: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase first.');
  }
  return db;
}

export function initDatabase(): Database.Database {
  const dbPath = path.resolve(config.database.url);
  const dbDir = path.dirname(dbPath);

  // Создаём директорию если не существует
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
    logger.info(`Created database directory: ${dbDir}`);
  }

  // Инициализируем базу данных
  db = new Database(dbPath);
  
  // Включаем foreign keys
  db.pragma('foreign_keys = ON');
  
  // WAL mode для лучшей производительности
  db.pragma('journal_mode = WAL');
  
  logger.info(`Database initialized at: ${dbPath}`);
  
  return db;
}

export function runMigrations(): void {
  const database = getDatabase();
  
  try {
    // Выполняем схему
    database.exec(schema);

    // Выполняем миграции (ALTER TABLE и т.д.)
    for (const migration of migrations) {
      try {
        database.exec(migration);
      } catch {
        // Колонка уже существует — игнорируем
      }
    }

    logger.info('Database migrations completed successfully');
  } catch (error) {
    logger.error('Migration error:', error);
    throw error;
  }
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('Database connection closed');
  }
}

// Утилиты для работы с базой данных
export const dbUtils = {
  // Получить одну запись
  get<T>(sql: string, params: unknown[] = []): T | undefined {
    return getDatabase().prepare(sql).get(...params) as T | undefined;
  },

  // Получить все записи
  all<T>(sql: string, params: unknown[] = []): T[] {
    return getDatabase().prepare(sql).all(...params) as T[];
  },

  // Выполнить запрос (INSERT, UPDATE, DELETE)
  run(sql: string, params: unknown[] = []): Database.RunResult {
    return getDatabase().prepare(sql).run(...params);
  },

  // Выполнить несколько запросов в транзакции
  transaction<T>(fn: () => T): T {
    return getDatabase().transaction(fn)();
  },
};

export default {
  getDatabase,
  initDatabase,
  runMigrations,
  closeDatabase,
  dbUtils,
};
