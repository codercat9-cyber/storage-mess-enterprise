import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { dbUtils } from '../database/index.js';
import { File } from '../types/index.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { fileEncryption } from './file-encryption.service.js';
import sharp from 'sharp';

export interface UploadedFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

export class StorageService {
  private storagePath: string;
  private fallbackPath: string;
  private raidPaths: string[];
  private raidEnabled: boolean;
  private usingFallback: boolean = false;

  constructor() {
    const primaryPath = path.resolve(config.storage.path);
    this.fallbackPath = path.resolve('./storage');
    this.raidPaths = config.storage.raidPaths.map(p => path.resolve(p));
    this.raidEnabled = config.storage.raidEnabled && this.raidPaths.length > 0;

    // Проверяем доступность основного хранилища
    if (this.isPathAccessible(primaryPath)) {
      this.storagePath = primaryPath;
      logger.info(`📁 Хранилище: ${primaryPath}`);
    } else {
      this.storagePath = this.fallbackPath;
      this.usingFallback = true;
      logger.warn(`⚠️ Основное хранилище недоступно: ${primaryPath}`);
      logger.warn(`⚠️ FALLBACK на локальное хранилище: ${this.fallbackPath}`);
    }

    this.ensureDirectories();
  }

  /** Проверка доступности пути (можно ли создать/писать) */
  private isPathAccessible(targetPath: string): boolean {
    try {
      // Проверяем что родительская директория существует и доступна
      const parentDir = path.dirname(targetPath);
      if (!fs.existsSync(parentDir)) {
        return false;
      }
      // Проверяем запись если директория уже есть
      if (fs.existsSync(targetPath)) {
        fs.accessSync(targetPath, fs.constants.W_OK | fs.constants.R_OK);
        return true;
      }
      // Пробуем создать — если получится, путь доступен
      fs.mkdirSync(targetPath, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  /** Попытка вернуться на основное хранилище (вызывается периодически) */
  tryRecoverPrimaryStorage(): boolean {
    if (!this.usingFallback) return true;
    const primaryPath = path.resolve(config.storage.path);
    if (this.isPathAccessible(primaryPath)) {
      this.storagePath = primaryPath;
      this.usingFallback = false;
      this.ensureDirectories();
      logger.info(`✅ Основное хранилище восстановлено: ${primaryPath}`);
      return true;
    }
    return false;
  }

  isOnFallback(): boolean { return this.usingFallback; }

  private ensureDirectories(): void {
    // Основная директория хранилища
    const dirs = [
      this.storagePath,
      path.join(this.storagePath, 'files'),
      path.join(this.storagePath, 'files', 'photos'),
      path.join(this.storagePath, 'files', 'videos'),
      path.join(this.storagePath, 'files', 'music'),
      path.join(this.storagePath, 'files', 'documents'),
      path.join(this.storagePath, 'files', 'other'),
      path.join(this.storagePath, 'thumbnails'),
      path.join(this.storagePath, 'temp'),
      path.join(this.storagePath, 'voice'),
    ];

    // RAID директории
    for (const raidPath of this.raidPaths) {
      dirs.push(raidPath);
      dirs.push(path.join(raidPath, 'files'));
      dirs.push(path.join(raidPath, 'files', 'photos'));
      dirs.push(path.join(raidPath, 'files', 'videos'));
      dirs.push(path.join(raidPath, 'files', 'music'));
      dirs.push(path.join(raidPath, 'files', 'documents'));
      dirs.push(path.join(raidPath, 'files', 'other'));
      dirs.push(path.join(raidPath, 'voice'));
    }

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        logger.info(`Created storage directory: ${dir}`);
      }
    }
  }

  /** Определяет подпапку по mime типу */
  getCategoryDir(mimeType: string): string {
    if (!mimeType) return 'other';
    if (mimeType.startsWith('image/')) return 'photos';
    if (mimeType.startsWith('video/')) return 'videos';
    if (mimeType.startsWith('audio/')) return 'music';
    if (mimeType.startsWith('application/pdf') || mimeType.startsWith('application/msword') ||
        mimeType.startsWith('application/vnd.openxmlformats') || mimeType.startsWith('text/')) return 'documents';
    return 'other';
  }

  /** Генерирует thumbnail для изображения или видео. Возвращает путь к thumbnail или null */
  async generateThumbnail(fileId: string, sourcePath: string, mimeType: string): Promise<string | null> {
    try {
      const isImage = mimeType.startsWith('image/') && mimeType !== 'image/svg+xml';
      const isVideo = mimeType.startsWith('video/');
      if (!isImage && !isVideo) return null;
      
      const thumbName = `${fileId}_thumb.webp`;
      const thumbPath = path.join(this.storagePath, 'thumbnails', thumbName);

      if (isVideo) {
        // Видео: извлекаем кадр через ffmpeg → конвертим в webp через sharp
        const tempFrame = path.join(this.storagePath, 'temp', `${fileId}_frame.jpg`);
        // Убеждаемся что temp dir существует
        const tempDir = path.dirname(tempFrame);
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

        await new Promise<void>((resolve, reject) => {
          execFile('ffmpeg', [
            '-i', sourcePath,
            '-ss', '1',
            '-vframes', '1',
            '-vf', 'scale=400:-1',
            '-y',
            tempFrame
          ], { timeout: 15000 }, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });

        await sharp(tempFrame)
          .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 75 })
          .toFile(thumbPath);

        fs.promises.unlink(tempFrame).catch(() => {});
      } else {
        // Изображение: существующая логика
        let inputBuffer: Buffer;
        if (fileEncryption.isEnabled() && fileEncryption.isFileEncrypted(sourcePath)) {
          inputBuffer = fileEncryption.decryptBuffer(fs.readFileSync(sourcePath));
        } else {
          inputBuffer = fs.readFileSync(sourcePath);
        }

        const isGif = mimeType === 'image/gif';
        await sharp(inputBuffer, { animated: false, pages: isGif ? 1 : undefined })
          .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 75 })
          .toFile(thumbPath);
      }
      
      // Обновляем БД
      dbUtils.run('UPDATE files SET thumbnail_path = ? WHERE id = ?', [thumbPath, fileId]);
      logger.debug(`Thumbnail generated: ${thumbName}`);
      return thumbPath;
    } catch (error) {
      logger.warn(`Failed to generate thumbnail for ${fileId}:`, error);
      return null;
    }
  }

  /** Получает путь к thumbnail */
  getThumbnailPath(fileId: string): string | null {
    const file = this.findById(fileId);
    if (!file || !file.thumbnail_path) return null;
    if (fs.existsSync(file.thumbnail_path)) return file.thumbnail_path;
    return null;
  }

  // Загрузка файла
  async uploadFile(uploaderId: string, file: UploadedFile): Promise<File> {
    const fileId = uuidv4();
    const ext = path.extname(file.originalname);
    const storedName = `${fileId}${ext}`;
    const checksum = this.calculateChecksum(file.buffer);

    // Определяем путь сохранения с категорией
    const storagePath = this.getStoragePathForFile(fileId);
    const category = this.getCategoryDir(file.mimetype);
    const filePath = path.join(storagePath, 'files', category, storedName);

    // Сохраняем файл (с шифрованием если включено)
    const dataToWrite = fileEncryption.isEnabled() 
      ? fileEncryption.encryptBuffer(file.buffer) 
      : file.buffer;
    await this.writeFile(filePath, dataToWrite);

    // Если RAID включен, реплицируем на все диски (уже зашифрованный)
    if (this.raidEnabled) {
      await this.replicateToRaid(storedName, dataToWrite, category);
    }

    // Сохраняем метаданные в БД
    const fileRecord: File = {
      id: fileId,
      uploader_id: uploaderId,
      original_name: file.originalname,
      stored_name: storedName,
      mime_type: file.mimetype,
      size: file.size,
      storage_path: filePath,
      checksum,
      is_public: false,
      download_count: 0,
      created_at: new Date().toISOString(),
    };

    dbUtils.run(
      `INSERT INTO files (id, uploader_id, original_name, stored_name, mime_type, size, storage_path, checksum, is_public, download_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [fileRecord.id, fileRecord.uploader_id, fileRecord.original_name, fileRecord.stored_name, 
       fileRecord.mime_type, fileRecord.size, fileRecord.storage_path, fileRecord.checksum,
       fileRecord.is_public ? 1 : 0, fileRecord.download_count, fileRecord.created_at]
    );

    logger.info(`File uploaded: ${file.originalname} (${fileId})`);
    
    // Генерируем thumbnail для изображений и видео (async, не блокируем ответ)
    if (file.mimetype.startsWith('image/')) {
      this.generateThumbnail(fileId, filePath, file.mimetype).catch(() => {});
    } else if (file.mimetype.startsWith('video/')) {
      // Для видео нужен незашифрованный файл → пишем buffer в temp
      const tempVideo = path.join(this.storagePath, 'temp', `${fileId}_thumb_src${path.extname(file.originalname)}`);
      const tempDir = path.dirname(tempVideo);
      if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
      fs.writeFileSync(tempVideo, file.buffer);
      this.generateThumbnail(fileId, tempVideo, file.mimetype)
        .finally(() => fs.promises.unlink(tempVideo).catch(() => {}));
    }
    
    return fileRecord;
  }

  // Загрузка файла с диска (без чтения в RAM — для больших файлов)
  async uploadFileFromDisk(uploaderId: string, tempPath: string, originalname: string, mimetype: string, size: number, source: string = 'storage', onEncryptProgress?: (doneBytes: number, totalBytes: number) => void): Promise<File> {
    const fileId = uuidv4();
    const ext = path.extname(originalname);
    const storedName = `${fileId}${ext}`;

    // Checksum потоково
    const checksum = await this.calculateChecksumStream(tempPath);

    const storagePath = this.getStoragePathForFile(fileId);
    const category = this.getCategoryDir(mimetype);
    const filePath = path.join(storagePath, 'files', category, storedName);

    // Убеждаемся что директория существует
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Генерируем thumbnail ДО шифрования (из незашифрованного tempPath)
    if (mimetype.startsWith('image/') || mimetype.startsWith('video/')) {
      await this.generateThumbnail(fileId, tempPath, mimetype);
    }

    if (fileEncryption.isEnabled()) {
      // Шифруем файл: читаем → шифруем → пишем в финальное место
      await fileEncryption.encryptFile(tempPath, filePath, onEncryptProgress);
    } else {
      // Просто перемещаем (rename — мгновенно если на одном диске)
      try {
        await fs.promises.rename(tempPath, filePath);
      } catch {
        // rename может не сработать между разными FS — тогда копируем
        await fs.promises.copyFile(tempPath, filePath);
        await fs.promises.unlink(tempPath).catch(() => {});
      }
    }

    // RAID-репликация (потоковая — не читаем весь файл в RAM)
    if (this.raidEnabled) {
      await this.replicateToRaidStream(storedName, filePath, category);
    }

    const fileRecord: File = {
      id: fileId,
      uploader_id: uploaderId,
      original_name: originalname,
      stored_name: storedName,
      mime_type: mimetype,
      size,
      storage_path: filePath,
      checksum,
      is_public: false,
      download_count: 0,
      source,
      created_at: new Date().toISOString(),
    };

    dbUtils.run(
      `INSERT INTO files (id, uploader_id, original_name, stored_name, mime_type, size, storage_path, checksum, is_public, download_count, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [fileRecord.id, fileRecord.uploader_id, fileRecord.original_name, fileRecord.stored_name,
       fileRecord.mime_type, fileRecord.size, fileRecord.storage_path, fileRecord.checksum,
       fileRecord.is_public ? 1 : 0, fileRecord.download_count, fileRecord.source || 'storage', fileRecord.created_at]
    );

    logger.info(`File uploaded from disk: ${originalname} (${fileId}, ${(size / 1024 / 1024).toFixed(1)} MB, source=${source})`);
    
    return fileRecord;
  }

  // Получить файл по ID
  findById(fileId: string): File | undefined {
    return dbUtils.get<File>('SELECT * FROM files WHERE id = ?', [fileId]);
  }

  // Получить содержимое файла (расшифрованное)
  async getFileContent(fileId: string): Promise<Buffer | null> {
    const file = this.findById(fileId);
    if (!file) return null;

    // Пытаемся прочитать из основного хранилища
    if (fs.existsSync(file.storage_path)) {
      const raw = await fs.promises.readFile(file.storage_path);
      return fileEncryption.isEnabled() ? fileEncryption.decryptBuffer(raw) : raw;
    }

    // Если RAID включен, ищем на других дисках
    if (this.raidEnabled) {
      for (const raidPath of this.raidPaths) {
        const alternatePath = path.join(raidPath, 'files', file.stored_name);
        if (fs.existsSync(alternatePath)) {
          logger.warn(`File ${fileId} recovered from RAID path: ${raidPath}`);
          const raw = await fs.promises.readFile(alternatePath);
          // Восстанавливаем в основное хранилище (зашифрованный)
          await this.writeFile(file.storage_path, raw);
          return fileEncryption.isEnabled() ? fileEncryption.decryptBuffer(raw) : raw;
        }
      }
    }

    logger.error(`File not found: ${fileId}`);
    return null;
  }

  // Получить реальный путь файла на диске (для Range-запросов)
  getFilePath(fileId: string): string | null {
    const file = this.findById(fileId);
    if (!file) return null;

    if (fs.existsSync(file.storage_path)) return file.storage_path;

    if (this.raidEnabled) {
      for (const raidPath of this.raidPaths) {
        const alt = path.join(raidPath, 'files', file.stored_name);
        if (fs.existsSync(alt)) return alt;
      }
    }
    return null;
  }

  // Инкрементировать счётчик скачиваний
  incrementDownloadCount(fileId: string): void {
    dbUtils.run('UPDATE files SET download_count = download_count + 1 WHERE id = ?', [fileId]);
  }

  // Получить поток файла для скачивания (расшифрованного)
  getFileStream(fileId: string): { stream: NodeJS.ReadableStream; decryptedSize?: number } | null {
    const file = this.findById(fileId);
    if (!file) return null;

    // Инкрементируем счётчик скачиваний
    dbUtils.run(
      'UPDATE files SET download_count = download_count + 1 WHERE id = ?',
      [fileId]
    );

    // Проверяем основное хранилище
    let filePath: string | null = null;
    if (fs.existsSync(file.storage_path)) {
      filePath = file.storage_path;
    } else if (this.raidEnabled) {
      for (const raidPath of this.raidPaths) {
        const alternatePath = path.join(raidPath, 'files', file.stored_name);
        if (fs.existsSync(alternatePath)) {
          filePath = alternatePath;
          break;
        }
      }
    }

    if (!filePath) return null;

    // Если шифрование включено И файл реально зашифрован — дешифруем при отдаче
    if (fileEncryption.isEnabled() && fileEncryption.isFileEncrypted(filePath, file.size)) {
      const stream = fileEncryption.createDecryptStream(filePath);
      const stat = fs.statSync(filePath);
      const decryptedSize = Math.max(0, stat.size - 60); // HEADER_SIZE = 60
      return { stream, decryptedSize };
    }

    return { stream: fs.createReadStream(filePath) };
  }

  // Удаление файла
  /** force — удаление администрацией (чистка по жалобе, обслуживание хранилища). */
  async deleteFile(fileId: string, userId: string, force = false): Promise<boolean> {
    const file = this.findById(fileId);
    if (!file || (!force && file.uploader_id !== userId)) {
      return false;
    }

    // Удаляем из основного хранилища
    if (fs.existsSync(file.storage_path)) {
      await fs.promises.unlink(file.storage_path);
    }

    // Удаляем миниатюру если есть
    if (file.thumbnail_path && fs.existsSync(file.thumbnail_path)) {
      await fs.promises.unlink(file.thumbnail_path);
    }

    // Удаляем с RAID дисков
    if (this.raidEnabled) {
      for (const raidPath of this.raidPaths) {
        const filePath = path.join(raidPath, 'files', file.stored_name);
        if (fs.existsSync(filePath)) {
          await fs.promises.unlink(filePath);
        }
      }
    }

    // Удаляем запись из БД
    const result = dbUtils.run('DELETE FROM files WHERE id = ?', [fileId]);
    logger.info(`File deleted: ${fileId}`);
    return result.changes > 0;
  }

  // Получить файлы пользователя (только из хранилища, без чатовых)
  getUserFiles(userId: string, limit: number = 50, offset: number = 0): File[] {
    return dbUtils.all<File>(
      `SELECT * FROM files WHERE uploader_id = ? AND (source IS NULL OR source = 'storage') ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    );
  }

  getPublicFiles(limit: number = 50, offset: number = 0): File[] {
    return dbUtils.all<File>(
      `SELECT * FROM files WHERE is_public = 1 AND (source IS NULL OR source = 'storage') ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [limit, offset]
    );
  }

  // Сделать файл публичным/приватным
  setPublic(fileId: string, userId: string, isPublic: boolean): boolean {
    const file = this.findById(fileId);
    if (!file || file.uploader_id !== userId) {
      return false;
    }

    const result = dbUtils.run(
      'UPDATE files SET is_public = ? WHERE id = ?',
      [isPublic ? 1 : 0, fileId]
    );
    return result.changes > 0;
  }

  // Проверить целостность файла
  async verifyIntegrity(fileId: string): Promise<boolean> {
    const file = this.findById(fileId);
    if (!file || !file.checksum) return false;

    const content = await this.getFileContent(fileId);
    if (!content) return false;

    const currentChecksum = this.calculateChecksum(content);
    return currentChecksum === file.checksum;
  }

  // Статистика хранилища
  getStorageStats(): {
    totalFiles: number;
    totalSize: number;
    diskTotal: number;
    diskFree: number;
    diskUsed: number;
    raidStatus: { path: string; available: boolean; freeSpace: number }[];
  } {
    const stats = dbUtils.get<{ count: number; total_size: number }>(
      'SELECT COUNT(*) as count, COALESCE(SUM(size), 0) as total_size FROM files'
    );

    // Реальное дисковое пространство
    let diskTotal = 0, diskFree = 0, diskUsed = 0;
    try {
      const diskStats = fs.statfsSync(this.storagePath);
      diskTotal = diskStats.bsize * diskStats.blocks;
      diskFree = diskStats.bsize * diskStats.bavail;
      diskUsed = diskTotal - diskFree;
    } catch (e) {
      logger.warn('Failed to get disk stats:', e);
    }

    const raidStatus = this.raidPaths.map(raidPath => {
      try {
        const available = fs.existsSync(raidPath);
        return { path: raidPath, available, freeSpace: 0 };
      } catch {
        return { path: raidPath, available: false, freeSpace: 0 };
      }
    });

    return {
      totalFiles: stats?.count || 0,
      totalSize: stats?.total_size || 0,
      diskTotal,
      diskFree,
      diskUsed,
      raidStatus,
    };
  }

  // Статистика файлов конкретного пользователя
  getUserStats(userId: string): { userFiles: number; userTotalSize: number } {
    const row = dbUtils.get<{ count: number; total_size: number }>(
      `SELECT COUNT(*) as count, COALESCE(SUM(size), 0) as total_size FROM files WHERE uploader_id = ? AND (source IS NULL OR source = 'storage')`,
      [userId]
    );
    return {
      userFiles: row?.count || 0,
      userTotalSize: row?.total_size || 0,
    };
  }

  // Вспомогательные методы
  private calculateChecksum(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  // Потоковый checksum для больших файлов
  private calculateChecksumStream(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  /** Получить базовый путь хранилища */
  getStoragePath(): string {
    return this.storagePath;
  }

  private getStoragePathForFile(_fileId: string): string {
    // Можно использовать хэширование для распределения по директориям
    return this.storagePath;
  }

  private async writeFile(filePath: string, content: Buffer): Promise<void> {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      await fs.promises.mkdir(dir, { recursive: true });
    }
    await fs.promises.writeFile(filePath, content);
  }

  private async replicateToRaid(storedName: string, content: Buffer, category?: string): Promise<void> {
    for (const raidPath of this.raidPaths) {
      try {
        const subDir = category ? path.join('files', category) : 'files';
        const filePath = path.join(raidPath, subDir, storedName);
        await this.writeFile(filePath, content);
        logger.debug(`File replicated to RAID: ${raidPath}`);
      } catch (error) {
        logger.error(`Failed to replicate to RAID path ${raidPath}:`, error);
      }
    }
  }

  // Потоковая RAID-репликация (для больших файлов — не читает в RAM)
  private async replicateToRaidStream(storedName: string, sourcePath: string, category?: string): Promise<void> {
    for (const raidPath of this.raidPaths) {
      try {
        const subDir = category ? path.join('files', category) : 'files';
        const destPath = path.join(raidPath, subDir, storedName);
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) await fs.promises.mkdir(destDir, { recursive: true });
        await fs.promises.copyFile(sourcePath, destPath);
        logger.debug(`File replicated to RAID (stream): ${raidPath}`);
      } catch (error) {
        logger.error(`Failed to replicate to RAID path ${raidPath}:`, error);
      }
    }
  }
}

export const storageService = new StorageService();
export default storageService;
