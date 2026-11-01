import { Router, Request, Response } from 'express';
import multer from 'multer';
import { storageService, UploadedFile } from '../services/storage.service.js';
import { fileEncryption } from '../services/file-encryption.service.js';
import { transcriptionService } from '../services/transcription.service.js';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth.js';
import { config } from '../config/index.js';
import { dbUtils } from '../database/index.js';
import { logger } from '../utils/logger.js';
import { getIo } from '../socket/index.js';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import sharp from 'sharp';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Каким куском читать файлы с диска при раздаче.
//
// Значение по умолчанию у Node — 64 КБ, и оно рассчитано на мелкие ответы.
// На видео и архивах это превращается в десятки тысяч мелких обращений к
// диску, и отдача упирается в них, а не в ширину канала. Мегабайт — размер,
// после которого прирост уже незаметен, а память на каждое соединение ещё
// не жалко.
const STREAM_CHUNK = 1024 * 1024;

// Разбор музыки для вибрации: с какой частотой и как долго слушать.
// Обоснование частоты — в комментарии у вызова ffmpeg ниже.
const HAPTIC_SAMPLE_RATE = 8000;
// Верхняя граница на случай, если подсунут не песню, а многочасовую запись:
// без неё один такой файл занимает сервер надолго.
const HAPTIC_MAX_SECONDS = 15 * 60;

/**
 * Есть ли внутри звукового файла видеодорожка.
 *
 * Такое встречается чаще, чем кажется: в .ogg кладут обложку или клип
 * отдельным потоком (обычно theora). Файл при этом остаётся «музыкой» по
 * названию и по типу, но проигрыватель на телефоне такой контейнер в
 * звуковом элементе не принимает вовсе — отвечает «нет поддерживаемых
 * источников» и молчит. Со стороны выглядит так, будто отдельные записи
 * просто не играют без всякой причины.
 */
async function hasVideoStream(filePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v',
      '-show_entries', 'stream=codec_type',
      '-of', 'csv=p=0',
      filePath,
    ]);
    return stdout.trim().length > 0;
  } catch {
    // Не смогли заглянуть внутрь — не мешаем загрузке.
    return false;
  }
}

async function convertAudioToOgg(tempPath: string, originalName: string, mimeType: string, fileSize: number) {
  // Звук в контейнере с видеодорожкой пересобираем в чистый звук.
  if (mimeType.startsWith('audio/') && await hasVideoStream(tempPath)) {
    try {
      const outPath = tempPath + '.clean.ogg';
      await execFileAsync('ffmpeg', [
        '-i', tempPath,
        '-vn',                 // выбрасываем видеодорожку
        '-c:a', 'libopus',
        '-b:a', '128k',
        '-vbr', 'on',
        '-y',
        outPath,
      ]);
      if (fs.existsSync(outPath)) {
        try { fs.unlinkSync(tempPath); } catch {}
        logger.info(`Из «${originalName}» убрана видеодорожка — иначе запись не играет на телефонах`);
        return {
          tempPath: outPath,
          originalName: path.parse(originalName).name + '.ogg',
          mimeType: 'audio/ogg',
          fileSize: fs.statSync(outPath).size,
        };
      }
    } catch (err) {
      logger.warn(`Не вышло убрать видеодорожку из «${originalName}»:`, err);
    }
  }

  if (mimeType.startsWith('audio/') && mimeType !== 'audio/ogg' && mimeType !== 'audio/webm' && mimeType !== 'audio/opus') {
    try {
      const outPath = tempPath + '.ogg';
      await execFileAsync('ffmpeg', [
        '-i', tempPath,
        '-c:a', 'libopus',
        '-b:a', '64k',
        '-vbr', 'on',
        '-compression_level', '10',
        '-y',
        outPath
      ]);
      if (fs.existsSync(outPath)) {
        try { fs.unlinkSync(tempPath); } catch {}
        const parsedName = path.parse(originalName).name + '.ogg';
        return {
          tempPath: outPath,
          originalName: parsedName,
          mimeType: 'audio/ogg',
          fileSize: fs.statSync(outPath).size
        };
      }
    } catch (err) {
      logger.error('Audio conversion to ogg failed:', err);
    }
  }
  return { tempPath, originalName, mimeType, fileSize };
}

const router = Router();

// ═══════════════════════════════════════════════════════════════════════
// Chunked Upload Sessions — для файлов любого размера (10 ГБ, 50 ГБ...)
// ═══════════════════════════════════════════════════════════════════════
const CHUNK_SIZE = 10 * 1024 * 1024; // 10 MB default chunk
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 часа
const CHUNK_DIR = path.join(config.storage.path, 'temp', 'chunks');
if (!fs.existsSync(CHUNK_DIR)) fs.mkdirSync(CHUNK_DIR, { recursive: true });

interface UploadSession {
  id: string;
  userId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  totalChunks: number;
  receivedChunks: Set<number>;
  source: string;
  createdAt: number;
  dir: string;
}

const uploadSessions = new Map<string, UploadSession>();

// ─── Сессии переживают перезапуск сервера ──────────────────────────────
//
// Раньше сессии жили только в этой Map. Перезапуск сервера — и все
// недокачанные файлы становились мусором на диске: клиент приходил с
// sessionId, получал 404 и начинал заново с нуля. Теперь рядом с чанками
// лежит session.json, а на старте каталог перечитывается.
const SESSION_META = 'session.json';

function persistSession(s: UploadSession): void {
  try {
    fs.writeFileSync(path.join(s.dir, SESSION_META), JSON.stringify({
      id: s.id, userId: s.userId, fileName: s.fileName, fileSize: s.fileSize,
      mimeType: s.mimeType, totalChunks: s.totalChunks, source: s.source,
      createdAt: s.createdAt,
    }));
  } catch (err) {
    logger.warn(`Could not persist upload session ${s.id}:`, err);
  }
}

function restoreSessions(): void {
  let restored = 0;
  let dirs: string[];
  try { dirs = fs.readdirSync(CHUNK_DIR); } catch { return; }
  for (const id of dirs) {
    const dir = path.join(CHUNK_DIR, id);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      const metaPath = path.join(dir, SESSION_META);
      if (!fs.existsSync(metaPath)) continue;
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      // Какие куски реально долежали до перезапуска — считаем по файлам,
      // а не по тому, что помнил прошлый процесс.
      const received = new Set<number>();
      for (const f of fs.readdirSync(dir)) {
        const m = /^chunk_(\d+)$/.exec(f);
        if (m) received.add(parseInt(m[1], 10));
      }
      uploadSessions.set(meta.id, { ...meta, receivedChunks: received, dir });
      restored++;
    } catch (err) {
      logger.warn(`Skipping unreadable upload session dir ${id}:`, err);
    }
  }
  if (restored > 0) logger.info(`Restored ${restored} unfinished upload session(s)`);
}
restoreSessions();

// Очистка просроченных сессий каждые 30 минут
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of uploadSessions) {
    if (now - session.createdAt > SESSION_TTL) {
      try { fs.rmSync(session.dir, { recursive: true, force: true }); } catch {}
      uploadSessions.delete(id);
      logger.info(`Cleaned up expired upload session: ${id}`);
    }
  }
}, 30 * 60 * 1000);

// Multer для чанков — пишет на диск
const chunkStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const sessionId = (_req as any).params?.sessionId;
    const session = uploadSessions.get(sessionId);
    if (session) {
      cb(null, session.dir);
    } else {
      cb(new Error('Invalid session'), '');
    }
  },
  filename: (req, _file, cb) => {
    const chunkIndex = parseInt((req as any).params?.chunkIndex, 10);
    cb(null, `chunk_${chunkIndex}`);
  },
});
const chunkUpload = multer({ storage: chunkStorage });

// POST /api/files/upload/init — создать сессию загрузки
router.post('/upload/init', authMiddleware, (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { fileName, fileSize, mimeType, source } = req.body;

    if (!fileName || !fileSize) {
      res.status(400).json({ error: 'fileName and fileSize required' });
      return;
    }

    // Тот же файл от того же человека — продолжаем старую сессию, а не
    // заводим новую.
    //
    // Это и была причина «свернул приложение — загрузка началась заново».
    // Клиент честно спрашивал `/upload/status/:id`, чтобы узнать, какие куски
    // уже долетели, но спрашивал он про сессию, созданную секунду назад — то
    // есть всегда про пустую. Докачка была написана и никогда не работала, а
    // на диске копились каталоги брошенных чанков.
    const resumable = [...uploadSessions.values()].find(s =>
      s.userId === userId &&
      s.fileName === fileName &&
      s.fileSize === Number(fileSize) &&
      Date.now() - s.createdAt < SESSION_TTL,
    );
    if (resumable) {
      logger.info(
        `Chunked upload resume: ${fileName} — ${resumable.receivedChunks.size}/${resumable.totalChunks} chunks already on disk (user ${userId})`,
      );
      res.json({
        sessionId: resumable.id,
        chunkSize: CHUNK_SIZE,
        totalChunks: resumable.totalChunks,
        resumed: true,
        receivedChunks: Array.from(resumable.receivedChunks),
      });
      return;
    }

    const sessionId = crypto.randomUUID();
    const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
    const sessionDir = path.join(CHUNK_DIR, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const session: UploadSession = {
      id: sessionId,
      userId,
      fileName,
      fileSize,
      mimeType: mimeType || 'application/octet-stream',
      totalChunks,
      receivedChunks: new Set(),
      source: source || 'storage',
      createdAt: Date.now(),
      dir: sessionDir,
    };

    uploadSessions.set(sessionId, session);
    persistSession(session);

    logger.info(`Chunked upload init: ${fileName} (${(fileSize / 1024 / 1024).toFixed(1)} MB, ${totalChunks} chunks) by user ${userId}`);
    res.json({
      sessionId,
      chunkSize: CHUNK_SIZE,
      totalChunks,
      resumed: false,
      receivedChunks: [],
    });
  } catch (error) {
    logger.error('Upload init error:', error);
    res.status(500).json({ error: 'Failed to init upload' });
  }
});

// POST /api/files/upload/chunk/:sessionId/:chunkIndex — загрузить чанк
router.post('/upload/chunk/:sessionId/:chunkIndex', authMiddleware, chunkUpload.single('chunk'), (req: Request, res: Response) => {
  try {
    const { sessionId, chunkIndex: chunkIndexStr } = req.params;
    const chunkIndex = parseInt(chunkIndexStr, 10);
    const session = uploadSessions.get(sessionId);

    if (!session) {
      res.status(404).json({ error: 'Upload session not found or expired' });
      return;
    }

    if (session.userId !== req.user!.userId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    if (chunkIndex < 0 || chunkIndex >= session.totalChunks) {
      res.status(400).json({ error: `Invalid chunk index: ${chunkIndex}` });
      return;
    }

    // Отмечаем кусок принятым, только если он действительно лёг на диск.
    // Иначе при сбое записи сессия считала бы себя полной, а сборка выдала
    // бы битый файл.
    if (!req.file || !fs.existsSync(path.join(session.dir, `chunk_${chunkIndex}`))) {
      res.status(400).json({ error: `Chunk ${chunkIndex} was not written` });
      return;
    }
    session.receivedChunks.add(chunkIndex);

    res.json({
      received: chunkIndex,
      totalReceived: session.receivedChunks.size,
      totalChunks: session.totalChunks,
    });
  } catch (error) {
    logger.error('Chunk upload error:', error);
    res.status(500).json({ error: 'Failed to upload chunk' });
  }
});

// GET /api/files/upload/status/:sessionId — статус загрузки (для resume)
router.get('/upload/status/:sessionId', authMiddleware, (req: Request, res: Response) => {
  try {
    const session = uploadSessions.get(req.params.sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (session.userId !== req.user!.userId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    res.json({
      sessionId: session.id,
      fileName: session.fileName,
      fileSize: session.fileSize,
      totalChunks: session.totalChunks,
      receivedChunks: Array.from(session.receivedChunks),
      complete: session.receivedChunks.size === session.totalChunks,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get status' });
  }
});

// POST /api/files/upload/complete/:sessionId — собрать файл из чанков
router.post('/upload/complete/:sessionId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const session = uploadSessions.get(req.params.sessionId);
    if (!session) {
      res.status(404).json({ error: 'Upload session not found' });
      return;
    }
    if (session.userId !== req.user!.userId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    // Проверяем что все чанки получены
    const missing: number[] = [];
    for (let i = 0; i < session.totalChunks; i++) {
      if (!session.receivedChunks.has(i)) missing.push(i);
    }
    if (missing.length > 0) {
      res.status(400).json({ error: 'Missing chunks', missingChunks: missing });
      return;
    }

    // Дальше идёт долгая часть, невидимая для человека.
    //
    // Куски уже долетели — интерфейс показывает «100%». А файл ещё только
    // предстоит склеить и зашифровать: на четырёх гигабайтах это минуты
    // тишины. Люди решали, что загрузка повисла, и начинали заново — один
    // архив приехал на сервер трижды подряд. Поэтому теперь о каждом этапе
    // сообщаем в личную комнату отправителя.
    const шаг = (stage: 'assembling' | 'encrypting' | 'done' | 'failed',
                 percent: number, doneBytes?: number, totalBytes?: number,
                 error?: string) => {
      try {
        getIo()?.to(`user:${session.userId}`).emit('upload:stage', {
          sessionId: session.id, stage, percent: Math.round(percent),
          doneBytes, totalBytes, error,
        });
      } catch { /* сокета нет — не беда, файл всё равно соберётся */ }
    };

    // Собираем файл из чанков (потоково, без чтения в RAM)
    const tempDir = path.join(config.storage.path, 'temp');
    const assembledPath = path.join(tempDir, `assembled_${session.id}_${session.fileName}`);
    const writeStream = fs.createWriteStream(assembledPath);

    // Шкала общая: передача кусков — до 70, сборка — до 88, шифрование —
    // до 99. Ровно сто человек видит только когда файл готов уходить в чат.
    шаг('assembling', 70, 0, session.fileSize);
    let последнийОтчёт = Date.now();

    for (let i = 0; i < session.totalChunks; i++) {
      const chunkPath = path.join(session.dir, `chunk_${i}`);
      await new Promise<void>((resolve, reject) => {
        const readStream = fs.createReadStream(chunkPath, { highWaterMark: 1024 * 1024 });
        readStream.pipe(writeStream, { end: false });
        readStream.on('end', resolve);
        readStream.on('error', reject);
      });

      // Отчитываемся не чаще раза в секунду: на четырёхстах кусках иначе
      // получилось бы четыреста сообщений подряд.
      if (Date.now() - последнийОтчёт > 900 || i === session.totalChunks - 1) {
        последнийОтчёт = Date.now();
        const доля = (i + 1) / session.totalChunks;
        шаг('assembling', 70 + доля * 18,
            Math.round(доля * session.fileSize), session.fileSize);
      }
    }
    writeStream.end();
    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    // Получаем реальный размер собранного файла
    const stat = fs.statSync(assembledPath);

    const converted = await convertAudioToOgg(assembledPath, session.fileName, session.mimeType, stat.size);

    // Используем стандартный uploadFileFromDisk
    let отчётШифрования = Date.now();
    const file = await storageService.uploadFileFromDisk(
      session.userId, converted.tempPath, converted.originalName, converted.mimeType, converted.fileSize, session.source,
      (done, total) => {
        if (Date.now() - отчётШифрования < 900) return;
        отчётШифрования = Date.now();
        const доля = total > 0 ? done / total : 0;
        шаг('encrypting', 88 + доля * 11, done, total);
      },
    );

    шаг('done', 100, converted.fileSize, converted.fileSize);

    // Чистим чанки и сессию
    try { fs.rmSync(session.dir, { recursive: true, force: true }); } catch {}
    try { if (fs.existsSync(converted.tempPath)) fs.unlinkSync(converted.tempPath); } catch {}
    uploadSessions.delete(session.id);

    logger.info(`Chunked upload complete: ${session.fileName} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
    res.status(201).json({
      file: {
        id: file.id,
        original_name: file.original_name,
        mime_type: file.mime_type,
        size: file.size,
        created_at: file.created_at,
      },
    });
  } catch (error) {
    logger.error('Upload complete error:', error);
    res.status(500).json({ error: 'Failed to assemble file' });
  }
});

// DELETE /api/files/upload/cancel/:sessionId — отмена загрузки
router.delete('/upload/cancel/:sessionId', authMiddleware, (req: Request, res: Response) => {
  try {
    const session = uploadSessions.get(req.params.sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (session.userId !== req.user!.userId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    try { fs.rmSync(session.dir, { recursive: true, force: true }); } catch {}
    uploadSessions.delete(session.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to cancel upload' });
  }
});

// ═══ Аватары — папка avatars/users (без шифрования, персистентные) ═══
const AVATARS_DIR = path.join(process.cwd(), 'avatars', 'users');
if (!fs.existsSync(AVATARS_DIR)) {
  fs.mkdirSync(AVATARS_DIR, { recursive: true });
  logger.info(`Created avatars directory: ${AVATARS_DIR}`);
}

// Multer для аватаров — сохраняем прямо в avatars/users
const avatarStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, AVATARS_DIR),
  filename: (req, _file, cb) => {
    // Имя файла = ID юзера (перезаписывает старый)
    const userId = (req as any).user?.userId || 'unknown';
    cb(null, `${userId}.tmp`);
  },
});

const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB макс
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      cb(new Error('Only images allowed'));
      return;
    }
    cb(null, true);
  },
});

// POST /api/files/avatar — загрузить аватар (без шифрования!)
router.post('/avatar', authMiddleware, avatarUpload.single('file'), async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    if (!req.file) {
      res.status(400).json({ error: 'No image uploaded' });
      return;
    }

    const tmpPath = req.file.path;
    const finalName = `${userId}.webp`;
    const finalPath = path.join(AVATARS_DIR, finalName);

    // Конвертируем в WebP, ресайзим до 256x256, оптимизируем
    try {
      await sharp(tmpPath)
        .resize(256, 256, { fit: 'cover', position: 'center' })
        .webp({ quality: 85 })
        .toFile(finalPath);
    } catch (sharpErr) {
      // Если sharp не установлен — просто копируем
      logger.warn('sharp not available, saving avatar as-is');
      fs.copyFileSync(tmpPath, path.join(AVATARS_DIR, `${userId}.jpg`));
    }

    // Удаляем tmp
    try { fs.unlinkSync(tmpPath); } catch {}

    // Также удаляем старые форматы (если были)
    for (const ext of ['.jpg', '.png', '.jpeg', '.gif']) {
      const old = path.join(AVATARS_DIR, `${userId}${ext}`);
      if (fs.existsSync(old) && ext !== '.webp') try { fs.unlinkSync(old); } catch {}
    }

    // URL аватара — статический, не зависит от fileId и шифрования
    const avatarUrl = `/api/avatars/${finalName}`;

    logger.info(`Avatar uploaded for user ${userId}: ${finalName}`);
    res.status(201).json({ avatarUrl });
  } catch (error) {
    logger.error('Avatar upload error:', error);
    if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: 'Failed to upload avatar' });
  }
});

// Для больших файлов используем disk storage вместо memory
const tempDir = path.join(config.storage.path, 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, tempDir),
  filename: (_req, file, cb) => {
    const uniqueName = `${Date.now()}-${Math.random().toString(36).slice(2)}-${file.originalname}`;
    cb(null, uniqueName);
  },
});

// Настройка multer — disk storage для поддержки файлов любого размера
const upload = multer({
  storage: diskStorage,
  fileFilter: (_req, file, cb) => {
    // Разрешаем все типы файлов
    cb(null, true);
  },
});

// Загрузка файла (требует авторизации)
router.post('/upload', authMiddleware, upload.single('file'), async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;

    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    const tempPath = req.file.path;

    // Multer декодирует originalname как latin1, восстанавливаем UTF-8
    const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf-8');

    const converted = await convertAudioToOgg(tempPath, originalName, req.file.mimetype, req.file.size);

    // Используем disk-based upload — файл НЕ читается в RAM целиком
    const source = req.body?.source === 'chat' ? 'chat' : 'storage';
    const file = await storageService.uploadFileFromDisk(
      userId, converted.tempPath, converted.originalName, converted.mimeType, converted.fileSize, source
    );

    // Удаляем временный файл (если не был перемещён rename)
    try { if (fs.existsSync(converted.tempPath)) fs.unlinkSync(converted.tempPath); } catch {}

    res.status(201).json({
      file: {
        id: file.id,
        original_name: file.original_name,
        mime_type: file.mime_type,
        size: file.size,
        created_at: file.created_at,
      },
    });
  } catch (error) {
    logger.error('File upload error:', error);
    if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

// Загрузка нескольких файлов
router.post('/upload/multiple', authMiddleware, upload.array('files', 10), async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const files = req.files as Express.Multer.File[];

    if (!files || files.length === 0) {
      res.status(400).json({ error: 'No files uploaded' });
      return;
    }

    const uploadedFiles = await Promise.all(
      files.map(async (file) => {
        const originalName = Buffer.from(file.originalname, 'latin1').toString('utf-8');
        const converted = await convertAudioToOgg(file.path, originalName, file.mimetype, file.size);
        const source = req.body?.source === 'chat' ? 'chat' : 'storage';
        const result = await storageService.uploadFileFromDisk(
          userId, converted.tempPath, converted.originalName, converted.mimeType, converted.fileSize, source
        );
        try { if (fs.existsSync(converted.tempPath)) fs.unlinkSync(converted.tempPath); } catch {}
        return result;
      })
    );

    res.status(201).json({
      files: uploadedFiles.map(f => ({
        id: f.id,
        original_name: f.original_name,
        mime_type: f.mime_type,
        size: f.size,
        created_at: f.created_at,
      })),
    });
  } catch (error) {
    logger.error('Multiple file upload error:', error);
    // Очистка временных файлов
    const files = req.files as Express.Multer.File[];
    if (files) files.forEach(f => { try { fs.unlinkSync(f.path); } catch {} });
    res.status(500).json({ error: 'Failed to upload files' });
  }
});

// Вспомогательная функция: аутентификация по query-токену
function authenticateFromQuery(req: Request) {
  if (!req.user && req.query.token) {
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(req.query.token as string, config.jwt.secret);
      req.user = decoded;
    } catch {}
  }
}

// Вспомогательная: проверка доступа к файлу
// Типы, которые браузер показывает, не исполняя кода. SVG сюда не входит:
// это документ со скриптами.
const SAFE_INLINE = /^(image\/(png|jpe?g|gif|webp|bmp|avif|heic|heif|x-icon)|video\/[\w.+-]+|audio\/[\w.+-]+|application\/pdf|text\/plain)$/i;
function isSafeInlineType(mime: string | null | undefined): boolean {
  return !!mime && SAFE_INLINE.test(mime.split(';')[0].trim());
}
// Отдаваемый файл — не страница нашего сайта: без скриптов, форм и чужих загрузок
const FILE_CSP = "sandbox; default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'unsafe-inline'";

// Кому можно файл. Раньше — любому вошедшему, знающему номер файла, а
// номера расходятся: пересылки, ушедшие из чата. Теперь: публичный — всем;
// иначе загрузившему, участникам чата, где файл отправлен, и администрации.
// Ответ кэшируется: файл качают кусками, и проверка на каждый кусок лишняя.
const fileAccessCache = new Map<string, number>();
const FILE_ACCESS_TTL_MS = 10 * 60_000;

function canAccessFile(file: any, userId: string | undefined): boolean {
  if (file.is_public) return true;
  if (!userId) return false;
  if (file.uploader_id === userId) return true;
  const key = `${userId}:${file.id}`;
  const exp = fileAccessCache.get(key);
  if (exp && exp > Date.now()) return true;
  const ok =
    !!dbUtils.get(
      `SELECT 1 AS x FROM messages m JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ?
        WHERE json_extract(m.metadata, '$.file_id') = ? LIMIT 1`, [userId, file.id]) ||
    !!dbUtils.get(`SELECT 1 AS x FROM users WHERE id = ? AND role IN ('admin', 'moderator')`, [userId]);
  if (ok) {
    if (fileAccessCache.size > 50000) fileAccessCache.clear();
    fileAccessCache.set(key, Date.now() + FILE_ACCESS_TTL_MS);
  }
  return ok;
}

function checkFileAccess(file: any, req: Request, res: Response): boolean {
  if (!canAccessFile(file, req.user?.userId)) {
    res.status(403).json({ error: 'Access denied' });
    return false;
  }
  return true;
}

// Скачивание файла (с поддержкой HTTP Range для докачки/стриминга)
router.get('/download/:fileId', optionalAuthMiddleware, async (req: Request, res: Response) => {
  try {
    authenticateFromQuery(req);

    const { fileId } = req.params;
    const file = storageService.findById(fileId);
    if (!file) { res.status(404).json({ error: 'File not found' }); return; }
    if (!checkFileAccess(file, req, res)) return;

    const filePath = storageService.getFilePath(fileId);
    if (!filePath) { res.status(404).json({ error: 'File not found on storage' }); return; }

    // Считаем скачивание один раз, а не на каждый кусок. Клиенты берут файл
    // диапазонами (докачка, несколько соединений сразу), и раньше файл на
    // гигабайт добавлял к счётчику сотни «скачиваний».
    const rangeHeader = req.headers.range;
    const isFirstChunk = !rangeHeader || /^bytes=0-/.test(rangeHeader);
    if (isFirstChunk) storageService.incrementDownloadCount(fileId);

    const disposition = `attachment; filename="${encodeURIComponent(file.original_name)}"; filename*=UTF-8''${encodeURIComponent(file.original_name)}`;
    const contentType = file.mime_type || 'application/octet-stream';
    // Вложение браузер не показывает, но песочница — на случай, если покажет
    res.setHeader('Content-Security-Policy', FILE_CSP);

    const isEncrypted = fileEncryption.isEnabled() && fileEncryption.isFileEncrypted(filePath, file.size);
    const range = req.headers.range;

    // Запрет кеширования скачанных файлов (SW / browser / proxy)
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    if (!isEncrypted && range) {
      // Range-запрос для незашифрованных файлов — настоящий partial content
      const stat = fs.statSync(filePath);
      const totalSize = stat.size;
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${totalSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
        'Content-Disposition': disposition,
      });
      // Читаем крупными кусками. По умолчанию поток берёт с диска по 64 КБ:
      // на файле в гигабайт это шестнадцать тысяч обращений вместо тысячи,
      // и скорость упирается не в канал, а в эту толчею.
      fs.createReadStream(filePath, { start, end, highWaterMark: STREAM_CHUNK }).pipe(res);
    } else if (isEncrypted && range) {
      // Range для зашифрованных — расшифровываем и отдаём диапазон
      const stat = fs.statSync(filePath);
      const totalSize = Math.max(0, stat.size - 60);
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
      const chunkSize = end - start + 1;

      const { stream } = await fileEncryption.createDecryptRangeStream(filePath, start, end);
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${totalSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
        'Content-Disposition': disposition,
      });
      (stream as any).pipe(res);
    } else {
      // Обычная скачка целиком
      const result = storageService.getFileStream(fileId);
      if (!result) { res.status(404).json({ error: 'File not found on storage' }); return; }

      const totalSize = result.decryptedSize !== undefined ? result.decryptedSize : file.size;
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', disposition);
      res.setHeader('Content-Length', totalSize.toString());
      (result.stream as any).pipe(res);
    }
  } catch (error) {
    logger.error('File download error:', error);
    res.status(500).json({ error: 'Failed to download file' });
  }
});

// Генерация signed download URL (per-user dynamic key)
router.get('/signed-url/:fileId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { fileId } = req.params;
    const file = storageService.findById(fileId);
    if (!file) { res.status(404).json({ error: 'File not found' }); return; }
    if (!checkFileAccess(file, req, res)) return;
    
    // Генерируем per-user download token (действует 1 час)
    const token = fileEncryption.generateDownloadToken(userId, fileId, 3600);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    
    res.json({
      download_url: `${baseUrl}/api/files/download/${fileId}?dtoken=${token}`,
      view_url: `${baseUrl}/api/files/view/${fileId}?dtoken=${token}`,
      expires_in: 3600,
      token,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate signed URL' });
  }
});

// Thumbnail для изображений и видео (быстрая загрузка в чатах)
router.get('/thumbnail/:fileId', optionalAuthMiddleware, async (req: Request, res: Response) => {
  try {
    authenticateFromQuery(req);
    const { fileId } = req.params;
    // Миниатюра — тоже содержимое файла: раньше отдавалась без проверки, кому угодно
    const thumbOf = storageService.findById(fileId);
    if (!thumbOf) { res.status(404).json({ error: 'File not found' }); return; }
    if (!checkFileAccess(thumbOf, req, res)) return;
    let thumbPath = storageService.getThumbnailPath(fileId);

    // Если thumbnail нет — пробуем сгенерировать on-demand (для видео без превью)
    if (!thumbPath) {
      const file = storageService.findById(fileId);
      if (file && file.mime_type?.startsWith('video/')) {
        const filePath = storageService.getFilePath(fileId);
        if (filePath) {
          // Для зашифрованного видео — дешифруем во temp
          let videoSrc = filePath;
          let tempDecrypted: string | null = null;
          if (fileEncryption.isEnabled() && fileEncryption.isFileEncrypted(filePath, file.size)) {
            const tempDir = path.join(storageService.getStoragePath(), 'temp');
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
            tempDecrypted = path.join(tempDir, `${fileId}_dec_tmp${path.extname(file.original_name)}`);
            const decStream = fileEncryption.createDecryptStream(filePath);
            const ws = fs.createWriteStream(tempDecrypted);
            await new Promise<void>((resolve, reject) => {
              decStream.pipe(ws);
              ws.on('finish', resolve);
              ws.on('error', reject);
            });
            videoSrc = tempDecrypted;
          }
          thumbPath = await storageService.generateThumbnail(fileId, videoSrc, file.mime_type);
          if (tempDecrypted) fs.promises.unlink(tempDecrypted).catch(() => {});
        }
      }
    }

    if (!thumbPath) {
      // Нет thumbnail — редирект на полный файл
      res.redirect(`/api/files/view/${fileId}${req.query.token ? '?token=' + req.query.token : ''}`);
      return;
    }
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    const fsModule = require('fs');
    fsModule.createReadStream(thumbPath).pipe(res);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to serve thumbnail' });
  }
});

// Просмотр файла (для изображений и видео, с Range)
router.get('/view/:fileId', optionalAuthMiddleware, async (req: Request, res: Response) => {
  try {
    authenticateFromQuery(req);

    const { fileId } = req.params;
    const file = storageService.findById(fileId);
    if (!file) { res.status(404).json({ error: 'File not found' }); return; }
    if (!checkFileAccess(file, req, res)) return;

    const filePath = storageService.getFilePath(fileId);
    if (!filePath) { res.status(404).json({ error: 'File not found on storage' }); return; }

    // Показываем в браузере только то, что не может выполнить код. Тип файла
    // заявляет загрузивший: раньше HTML или SVG со скриптом открывался прямо
    // на нашем домене и забирал токены входа из хранилища браузера. Всё
    // прочее — только скачиванием и в песочнице без скриптов.
    const safeInline = isSafeInlineType(file.mime_type);
    const disposition = `${safeInline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(file.original_name)}"; filename*=UTF-8''${encodeURIComponent(file.original_name)}`;
    const contentType = safeInline ? (file.mime_type as string) : 'application/octet-stream';
    if (!/^application\/pdf/i.test(contentType)) res.setHeader('Content-Security-Policy', FILE_CSP);
    const isEncrypted = fileEncryption.isEnabled() && fileEncryption.isFileEncrypted(filePath, file.size);
    const range = req.headers.range;

    // Запрет кеширования расшифрованных файлов (SW / browser / proxy)
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    if (!isEncrypted && range) {
      const stat = fs.statSync(filePath);
      const totalSize = stat.size;
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${totalSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': contentType,
        'Content-Disposition': disposition,
      });
      fs.createReadStream(filePath, { start, end, highWaterMark: STREAM_CHUNK }).pipe(res);
    } else if (isEncrypted && range) {
      const stat = fs.statSync(filePath);
      const totalSize = Math.max(0, stat.size - 60);
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;

      const { stream } = await fileEncryption.createDecryptRangeStream(filePath, start, end);
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${totalSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': contentType,
        'Content-Disposition': disposition,
      });
      (stream as any).pipe(res);
    } else {
      const result = storageService.getFileStream(fileId);
      if (!result) { res.status(404).json({ error: 'File not found on storage' }); return; }

      const totalSize = result.decryptedSize !== undefined ? result.decryptedSize : file.size;
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', disposition);
      res.setHeader('Content-Length', totalSize.toString());
      (result.stream as any).pipe(res);
    }
  } catch (error) {
    logger.error('File view error:', error);
    res.status(500).json({ error: 'Failed to view file' });
  }
});

// Информация о файле
router.get('/info/:fileId', optionalAuthMiddleware, (req: Request, res: Response) => {
  try {
    const { fileId } = req.params;
    const file = storageService.findById(fileId);

    if (!file) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    // Проверяем доступ
    if (!file.is_public && (!req.user || file.uploader_id !== req.user.userId)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    res.json({
      file: {
        id: file.id,
        original_name: file.original_name,
        mime_type: file.mime_type,
        size: file.size,
        is_public: file.is_public,
        download_count: file.download_count,
        created_at: file.created_at,
      },
    });
  } catch (error) {
    logger.error('File info error:', error);
    res.status(500).json({ error: 'Failed to get file info' });
  }
});

// Список файлов пользователя
router.get('/my', authMiddleware, (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { limit, offset } = req.query;

    const files = storageService.getUserFiles(
      userId,
      limit ? parseInt(limit as string, 10) : 50,
      offset ? parseInt(offset as string, 10) : 0
    );

    res.json({
      files: files.map(f => ({
        id: f.id,
        original_name: f.original_name,
        mime_type: f.mime_type,
        size: f.size,
        is_public: f.is_public,
        download_count: f.download_count,
        created_at: f.created_at,
      })),
    });
  } catch (error) {
    logger.error('Get user files error:', error);
    res.status(500).json({ error: 'Failed to get files' });
  }
});

// Удаление файла
router.delete('/:fileId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { fileId } = req.params;

    const success = await storageService.deleteFile(fileId, userId);
    if (!success) {
      res.status(403).json({ error: 'Cannot delete file (not found or not owner)' });
      return;
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('File delete error:', error);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// Сделать файл публичным/приватным
router.patch('/:fileId/public', authMiddleware, (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { fileId } = req.params;
    const { is_public } = req.body;

    if (typeof is_public !== 'boolean') {
      res.status(400).json({ error: 'is_public must be a boolean' });
      return;
    }

    const success = storageService.setPublic(fileId, userId, is_public);
    if (!success) {
      res.status(403).json({ error: 'Cannot update file (not found or not owner)' });
      return;
    }

    res.json({ success: true, is_public });
  } catch (error) {
    logger.error('Update file visibility error:', error);
    res.status(500).json({ error: 'Failed to update file' });
  }
});

// Проверка целостности файла
router.get('/:fileId/verify', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { fileId } = req.params;

    const file = storageService.findById(fileId);
    if (!file || file.uploader_id !== userId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const isValid = await storageService.verifyIntegrity(fileId);
    res.json({ valid: isValid });
  } catch (error) {
    logger.error('File verification error:', error);
    res.status(500).json({ error: 'Failed to verify file' });
  }
});

// Публичные файлы
router.get('/public', authMiddleware, (req: Request, res: Response) => {
  try {
    const { limit, offset } = req.query;
    const files = storageService.getPublicFiles(
      limit ? parseInt(limit as string, 10) : 50,
      offset ? parseInt(offset as string, 10) : 0
    );
    res.json({
      files: files.map(f => ({
        id: f.id,
        original_name: f.original_name,
        mime_type: f.mime_type,
        size: f.size,
        is_public: f.is_public,
        download_count: f.download_count,
        created_at: f.created_at,
      })),
    });
  } catch (error) {
    logger.error('Get public files error:', error);
    res.status(500).json({ error: 'Failed to get public files' });
  }
});

// Статистика хранилища
router.get('/stats', authMiddleware, (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const stats = storageService.getStorageStats();
    const userStats = storageService.getUserStats(userId);
    res.json({ ...stats, ...userStats });
  } catch (error) {
    logger.error('Storage stats error:', error);
    res.status(500).json({ error: 'Failed to get storage stats' });
  }
});

// Определить реальный MIME-тип по magic bytes файла
function detectAudioMime(filePath: string, extFallback: string): string {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(32);
    fs.readSync(fd, buf, 0, 32, 0);
    fs.closeSync(fd);
    
    // WebM/Matroska: starts with 0x1A45DFA3 (EBML header)
    if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) {
      return 'audio/webm';
    }
    // Повреждённый WebM - потеряли первый байт (0x45DFA3 без 0x1A)
    if (buf[0] === 0x45 && buf[1] === 0xDF && buf[2] === 0xA3) {
      return 'audio/webm';
    }
    // Повреждённый WebM - начинается с Matroska Cluster (1F43B675) или его части
    if ((buf[0] === 0x1F && buf[1] === 0x43 && buf[2] === 0xB6 && buf[3] === 0x75) ||
        (buf[0] === 0x43 && buf[1] === 0xB6 && buf[2] === 0x75)) {
      return 'audio/webm';
    }
    // Ещё один паттерн WebM — содержит 'webm' в первых 32 байтах
    if (buf.includes(Buffer.from('webm'))) {
      return 'audio/webm';
    }
    // OGG: starts with 'OggS'
    if (buf[0] === 0x4F && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) {
      return 'audio/ogg';
    }
    // MP3: starts with 0xFFEx or 0xFFFx (sync word) or ID3 tag
    if ((buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) || 
        (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33)) {
      return 'audio/mpeg';
    }
    // MP4/M4A: 'ftyp' at offset 4
    if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
      return 'audio/mp4';
    }
    // WAV: 'RIFF'
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) {
      return 'audio/wav';
    }
  } catch {}
  
  // Fallback на расширение
  const mimeTypeMap: { [key: string]: string } = {
    '.ogg': 'audio/ogg',
    '.webm': 'audio/webm',
    '.mp4': 'audio/mp4',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
  };
  return mimeTypeMap[extFallback] || 'audio/ogg';
}

// Получить голосовое сообщение (с дешифрованием)
router.get('/voice/:filename', optionalAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const { filename } = req.params;
    const voiceDir = path.join(config.storage.path, 'voice');
    const filePath = path.join(voiceDir, filename);

    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'Voice message not found' });
      return;
    }

    const ext = path.extname(filename).toLowerCase();
    // Определяем MIME по содержимому файла, а не по расширению
    const mimeType = detectAudioMime(filePath, ext);

    // CORS заголовки для доступа к аудиофайлам
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');

    // Поддержка Range-запросов для корректного воспроизведения в браузерах
    const range = req.headers.range;
    
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);

      // Сначала получаем размер расшифрованного файла
      const totalSize = await fileEncryption.getDecryptedSize(filePath);
      const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;

      if (isNaN(start) || start < 0 || start >= totalSize) {
        res.status(416).setHeader('Content-Range', `bytes */${totalSize}`);
        res.end();
        return;
      }

      const decryptResult = await fileEncryption.createDecryptRangeStream(filePath, start, end);

      const chunkSize = (end - start) + 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', String(chunkSize));
      res.setHeader('Content-Type', mimeType);

      (decryptResult.stream as any).pipe(res);
    } else {
      const decryptedSize = await fileEncryption.getDecryptedSize(filePath);
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Length', decryptedSize.toString());
      res.setHeader('Accept-Ranges', 'bytes');

      const stream = fileEncryption.createDecryptStream(filePath);
      (stream as any).pipe(res);
    }
  } catch (error) {
    logger.error('Voice message error:', error);
    res.status(500).json({ error: 'Failed to get voice message' });
  }
});

// ═══ Расшифровка голосового сообщения в текст ═══
router.post('/transcribe', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { filename, language } = req.body;

    if (!filename || typeof filename !== 'string') {
      res.status(400).json({ error: 'filename is required' });
      return;
    }

    // Защита от path traversal
    const safe = path.basename(filename);
    const voiceDir = path.join(config.storage.path, 'voice');
    const filePath = path.join(voiceDir, safe);

    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'Voice file not found' });
      return;
    }

    // Если шифрование включено, расшифровываем во временный файл для vosk
    let transcribeFilePath = filePath;
    let tempPath: string | null = null;

    if (fileEncryption.isEnabled()) {
      const tempDir = path.join(config.storage.path, 'temp');
      tempPath = path.join(tempDir, `transcribe_${safe}`);
      const encrypted = await fs.promises.readFile(filePath);
      const decrypted = fileEncryption.decryptBuffer(encrypted);
      await fs.promises.writeFile(tempPath, decrypted);
      transcribeFilePath = tempPath;
    }

    try {
      const result = await transcriptionService.transcribe(transcribeFilePath, language || 'ru');
      res.json({ text: result.text, language: result.language });
    } finally {
      // Удаляем временный расшифрованный файл
      if (tempPath && fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    }
  } catch (error: any) {
    logger.error('Transcription error:', error);
    res.status(500).json({ error: error.message || 'Transcription failed' });
  }
});

// Отправить коррекцию транскрипции (обучение Vosk)
router.post('/transcribe/learn', authMiddleware, (req: Request, res: Response) => {
  try {
    const { original, corrected } = req.body;
    if (!original || !corrected || typeof original !== 'string' || typeof corrected !== 'string') {
      res.status(400).json({ error: 'original and corrected fields are required' });
      return;
    }
    transcriptionService.learnCorrection(original, corrected);
    res.json({ success: true });
  } catch (error: any) {
    logger.error('Learn correction error:', error);
    res.status(500).json({ error: 'Failed to save correction' });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// GET /api/files/haptic-pattern?url=<audioUrl>&intensity=0.6
// Серверный Haptic DSP: ffmpeg декодирует аудио → Node.js анализирует PCM
// Телефон больше НЕ выполняет тяжёлую работу — только отображает результат
// ═══════════════════════════════════════════════════════════════════════

function butterworthLPF(samples: Float32Array, cutoffHz: number, sampleRate: number): Float32Array {
  const omega = 2 * Math.PI * cutoffHz / sampleRate;
  const sinO = Math.sin(omega), cosO = Math.cos(omega);
  const alpha = sinO / (2 * 0.7071);
  const a0inv = 1 / (1 + alpha);
  const b0 = ((1 - cosO) / 2) * a0inv, b1 = (1 - cosO) * a0inv, b2 = b0;
  const a1 = (-2 * cosO) * a0inv, a2 = (1 - alpha) * a0inv;
  const out = new Float32Array(samples.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x0 = samples[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    out[i] = y0;
  }
  return out;
}

function computeRmsServer(samples: Float32Array, windowSize: number, hopSize: number): Float32Array {
  const count = Math.max(0, Math.floor((samples.length - windowSize) / hopSize) + 1);
  const rms = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let sum = 0;
    const start = i * hopSize;
    for (let j = start; j < start + windowSize && j < samples.length; j++) sum += samples[j] * samples[j];
    rms[i] = Math.sqrt(sum / windowSize);
  }
  return rms;
}

function detectOnsetsServer(rms: Float32Array, hopSamples: number, sampleRate: number, threshold: number, minIntervalMs: number): Array<{ timeMs: number; strength: number }> {
  if (rms.length < 2) return [];
  const minHops = Math.round((minIntervalMs / 1000) * sampleRate / hopSamples);
  const delta = new Float64Array(rms.length);
  for (let i = 1; i < rms.length; i++) delta[i] = Math.max(0, rms[i] - rms[i - 1]);
  const mean = delta.reduce((s, v) => s + v, 0) / delta.length;
  const std = Math.sqrt(delta.reduce((s, v) => s + (v - mean) ** 2, 0) / delta.length);
  const adaptiveThreshold = mean + std * threshold;
  const onsets: Array<{ timeMs: number; strength: number }> = [];
  let lastOnset = -minHops;
  for (let i = 1; i < delta.length; i++) {
    if (delta[i] > adaptiveThreshold && i - lastOnset >= minHops) {
      onsets.push({ timeMs: Math.round((i * hopSamples / sampleRate) * 1000), strength: delta[i] });
      lastOnset = i;
    }
  }
  return onsets;
}

function detectBpmServer(rms: Float32Array, hopSamples: number, sampleRate: number): number | null {
  if (rms.length < 10) return null;
  const onsets = detectOnsetsServer(rms, hopSamples, sampleRate, 0.06, 60);
  if (onsets.length < 4) return null;
  const intervals: number[] = [];
  for (let i = 1; i < onsets.length; i++) intervals.push(onsets[i].timeMs - onsets[i - 1].timeMs);
  intervals.sort((a, b) => a - b);
  const median = intervals[Math.floor(intervals.length / 2)];
  if (median < 200 || median > 2000) return null;
  return Math.round(60000 / median);
}

router.get('/haptic-pattern', optionalAuthMiddleware, async (req: Request, res: Response) => {
  const { url, intensity } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing url parameter' });
  }
  const intensityScale = Math.min(2, Math.max(0.1, parseFloat(String(intensity || '1.0')) || 1.0));

  const tmpPcm = path.join(config.storage.path, 'temp', `haptic_${Date.now()}_${Math.random().toString(36).slice(2)}.pcm`);

  try {
    // Свои файлы читаем С ДИСКА, а не ходим по сети сами к себе.
    //
    // Раньше относительный путь превращался в `http://127.0.0.1:443/...` —
    // обычный HTTP на порт, где слушает HTTPS. ffmpeg такое скачать не мог,
    // и разбор падал ВСЕГДА. Со стороны это выглядело так: человек включает
    // вибрацию, приложение уходит «считать на сервере», ждёт сорок пять
    // секунд и возвращается ни с чем.
    //
    // Ходить к себе по сети незачем и в исправном виде: файл лежит на этой
    // же машине, а лишний круг через TLS только добавляет задержку и
    // требует, чтобы запрос прошёл авторизацию.
    let audioUrl = url;
    if (audioUrl.startsWith('/')) {
      const name = decodeURIComponent(audioUrl.split('/').pop() || '');
      const row = name
        ? dbUtils.get<{ storage_path: string }>(
            'SELECT storage_path FROM files WHERE stored_name = ?', [name])
        : undefined;

      if (row?.storage_path && fs.existsSync(row.storage_path)) {
        audioUrl = row.storage_path;
      } else {
        // Не нашли в учёте — пробуем по имени в хранилище.
        const guess = path.join(config.storage.path, 'files', name);
        const guessMusic = path.join(config.storage.path, 'files', 'music', name);
        if (fs.existsSync(guess)) audioUrl = guess;
        else if (fs.existsSync(guessMusic)) audioUrl = guessMusic;
        else return res.status(404).json({ error: 'Файл не найден' });
      }
    }

    // 1. Раскладываем звук на образцы.
    //
    // Файлы в хранилище лежат ЗАШИФРОВАННЫМИ, и ffmpeg, получив путь к
    // такому файлу, видит мешанину байтов вместо музыки. Разбор падал на
    // каждом треке, а человек в это время смотрел на «считаю на сервере» и
    // не получал ничего.
    //
    // Поэтому подаём ffmpeg расшифрованный ПОТОК на вход, а не путь. Заодно
    // не создаём на диске вторую, открытую копию чужой музыки — она бы
    // пережила запрос и осталась лежать.
    const isLocalFile = !/^https?:/i.test(audioUrl);

    await new Promise<void>((resolve, reject) => {
      // Частота нарочно низкая, и это не потеря качества.
      //
      // Вибрацию ведёт бас: сигнал всё равно тут же режется фильтром на
      // 200 Гц, и всё, что выше, выбрасывается. Держать ради этого сорок
      // четыре тысячи отсчётов в секунду незачем — по теореме отсчётов
      // хватает вчетверо меньшего запаса.
      //
      // А цена была велика: четырёхминутный трек разворачивался в памяти в
      // 200 МБ на ОДИН запрос — сам поток, копия после фильтра и исходный
      // буфер. Два-три человека, включивших вибрацию одновременно, съедали
      // память сервера, и разбор обрывался на середине. Отсюда жалоба, что
      // «некоторые треки обрываются на анализе»: обрывались длинные.
      //
      // Сверено на четырёхминутной записи: 3064 импульса против 3070, метки
      // совпадают. Работы при этом втрое меньше, памяти — впятеро.
      const rate = String(HAPTIC_SAMPLE_RATE);
      const limit = String(HAPTIC_MAX_SECONDS);
      const args = isLocalFile
        ? ['-i', 'pipe:0', '-t', limit, '-ac', '1', '-ar', rate, '-f', 'f32le', '-y', tmpPcm]
        : ['-i', audioUrl, '-t', limit, '-ac', '1', '-ar', rate, '-f', 'f32le', '-y', tmpPcm];

      const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderrTail = '';
      proc.stderr?.on('data', d => { stderrTail = (stderrTail + d.toString()).slice(-500); });

      const killTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 30000);

      proc.on('error', err => { clearTimeout(killTimer); reject(err); });
      proc.on('close', code => {
        clearTimeout(killTimer);
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg завершился с кодом ${code}: ${stderrTail.slice(-200)}`));
      });

      if (isLocalFile) {
        const src = fileEncryption.isEnabled() && fileEncryption.isFileEncrypted(audioUrl)
          ? fileEncryption.createDecryptStream(audioUrl)
          : fs.createReadStream(audioUrl);
        src.on('error', (err: Error) => { try { proc.kill('SIGKILL'); } catch {} reject(err); });
        // ffmpeg закрывает вход, когда ему хватит данных, — это не ошибка.
        proc.stdin?.on('error', () => { /* EPIPE */ });
        src.pipe(proc.stdin!);
      }
    });

    if (!fs.existsSync(tmpPcm)) {
      return res.status(500).json({ error: 'FFmpeg failed to decode audio' });
    }

    // 2. Читаем PCM как Float32Array
    const raw = fs.readFileSync(tmpPcm);
    fs.unlinkSync(tmpPcm);

    const sampleCount = raw.byteLength / 4;
    // Отсчёты пришли одинарной точностью — в двойной их держать незачем,
    // это ровно вдвое больше памяти без единого лишнего знака.
    const samples = new Float32Array(sampleCount);
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    for (let i = 0; i < sampleCount; i++) {
      samples[i] = view.getFloat32(i * 4, true);
    }

    const sampleRate = HAPTIC_SAMPLE_RATE;

    // 3. Butterworth LPF 200Hz — бас/бочка
    const filtered = butterworthLPF(samples, 200, sampleRate);

    // 4. RMS по окнам 20ms с 50% overlap
    const windowSamples = Math.round(sampleRate * 0.02);
    const hopSamples = Math.floor(windowSamples / 2);
    const rms = computeRmsServer(filtered, windowSamples, hopSamples);

    // 5. BPM и онсеты
    const bpm = detectBpmServer(rms, hopSamples, sampleRate);
    const onsets = detectOnsetsServer(rms, hopSamples, sampleRate, 0.06, 60);

    // 6. PostProcess → VibrationPulse[]
    // Максимум ищем циклом, а не раскрытием массива в аргументы.
    //
    // Math.max(...onsets) кладёт КАЖДЫЙ импульс отдельным аргументом на стек
    // вызова. На плотной музыке импульсов десятки тысяч, стек переполняется,
    // и разбор падает с ошибкой — не на всех треках, а именно на насыщенных.
    // Вторая половина жалобы «некоторые треки обрываются».
    let maxStrength = 0.001;
    for (const o of onsets) if (o.strength > maxStrength) maxStrength = o.strength;
    const pulses = onsets.map(onset => {
      const normalizedStrength = onset.strength / maxStrength;
      const amplitude = Math.min(255, Math.round(normalizedStrength * intensityScale * 220 + 35));
      const durationMs = bpm ? Math.round((60000 / bpm) * 0.25) : Math.round(80 + normalizedStrength * 120);
      return { timeMs: onset.timeMs, amplitude, durationMs };
    });

    const durationMs = Math.round(sampleCount / sampleRate * 1000);

    logger.info(`[HAPTIC-DSP] Analyzed ${durationMs}ms audio: ${pulses.length} pulses, BPM=${bpm}`);

    res.json({ pulses, durationMs, bpm });

  } catch (err: any) {
    // Cleanup on error
    try { if (fs.existsSync(tmpPcm)) fs.unlinkSync(tmpPcm); } catch {}
    // Текст ошибки склеиваем в само сообщение: вторым доводом он уходит в
    // приложенные данные и в журнал не попадает — там оставались пустые
    // строки «Error:» без единого намёка на причину.
    logger.error(`[HAPTIC-DSP] разбор не удался: ${err?.message || err}`);
    res.status(500).json({ error: 'Haptic analysis failed: ' + (err?.message || 'unknown error') });
  }
});

export default router;
