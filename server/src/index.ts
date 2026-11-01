import express, { Express, Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import https from 'https';
import fs from 'fs';
import crypto from 'crypto';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import path from 'path';

import { config } from './config/index.js';
import { initDatabase, runMigrations, closeDatabase } from './database/index.js';
import { validateDatabase } from './services/db-validator.service.js';
import { initializeSocket, getIo } from './socket/index.js';
import { startStunTurnServer, stopStunTurnServer, getStunTurnStats, addStunTurnPort, handleTurnTcpSocket } from './services/stun-turn.service.js';
import { storageService } from './services/storage.service.js';
import { initHealthChecker, trackTlsHandshake, trackConnectionReset } from './services/health-checker.service.js';
import { initDPIProtection, hardenTlsSocket, cleanupDPIProtection } from './services/dpi-protection.service.js';
import { emailBridgeService } from './services/email-bridge.service.js';
import { dpiAnalyzer } from './services/dpi-analyzer.service.js';
import { securityWAF } from './middleware/security.js';
import { logger } from './utils/logger.js';
import { getLocalIPs, getPrimaryIP, formatIPsForDisplay, getYggdrasilAddress, getYggdrasilInfo } from './utils/ip.js';
import tls from 'tls';

// Импорт роутов
import authRoutes from './routes/auth.routes.js';
import userRoutes from './routes/user.routes.js';
import chatRoutes from './routes/chat.routes.js';
import fileRoutes from './routes/file.routes.js';
import e2eeRoutes from './routes/e2ee.routes.js';
import pushRoutes from './routes/push.routes.js';
import updateRoutes from './routes/update.routes.js';
import callRoutes from './routes/call.routes.js';
import adminRoutes from './routes/admin.routes.js';
import enterpriseRoutes from './routes/enterprise.routes.js';
import { startEnterprise, stopEnterprise } from './enterprise/index.js';
import { startLanDiscovery } from './services/lan-discovery.service.js';
import { reportRouter, legalRouter, moderationRouter } from './routes/moderation.routes.js';
import { initPushService } from './services/push.service.js';
import { transcriptionService } from './services/transcription.service.js';
import { registerSSEClient } from './services/sse-notify.service.js';
import { filterAliveIceServers, getIceHealthSnapshot } from './services/ice-health.service.js';
import { authMiddleware } from './middleware/auth.js';
import { getClientIp, isPrivateIp } from './utils/client-ip.js';

const app: Express = express();

// Перед нами НЕТ прокси: сервер сам слушает 443/80. Значит `X-Forwarded-For`
// ставит сам клиент, и доверять ему нельзя — иначе `req.ip` становится
// значением, которое клиент назначает себе сам. Подробности и последствия
// расписаны в utils/client-ip.ts; там же единая функция определения адреса.
app.set('trust proxy', false);

// Обёртка над Express: фильтрует malformed URL ДО того, как Express начнёт роутинг.
// Express внутри Layer.match вызывает decodeURIComponent и бросает URIError
// на двойно-закодированных URL (сканеры CVE-2021-41773 и т.п.), поэтому
// нужно перехватить запрос до Express.

// Автобан: IP которые шлют подозрительные запросы
const _attackerHits = new Map<string, { count: number; first: number }>();
const _bannedIPs = new Set<string>();
const ATTACK_BAN_THRESHOLD = 5;    // 5 подозрительных запросов
const ATTACK_WINDOW_MS = 60_000;   // в течение 1 минуты
const BAN_DURATION_MS = 600_000;   // бан на 10 минут

function trackAttacker(ip: string): void {
  if (_bannedIPs.has(ip)) return;
  const now = Date.now();
  const entry = _attackerHits.get(ip);
  if (entry && now - entry.first < ATTACK_WINDOW_MS) {
    entry.count++;
    if (entry.count >= ATTACK_BAN_THRESHOLD) {
      _bannedIPs.add(ip);
      _attackerHits.delete(ip);
      logger.warn(`🚫 Auto-banned attacker IP: ${ip} (${entry.count} suspicious requests)`);
      setTimeout(() => _bannedIPs.delete(ip), BAN_DURATION_MS);
    }
  } else {
    _attackerHits.set(ip, { count: 1, first: now });
  }
}

// Периодическая очистка старых записей
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of _attackerHits) {
    if (now - entry.first > ATTACK_WINDOW_MS) _attackerHits.delete(ip);
  }
}, 30_000);

// Список забаненных нужен админке: без него автобан — чёрный ящик,
// и «человека не пускает» приходится выяснять по журналу.
export function getBannedIPs(): string[] { return Array.from(_bannedIPs); }
export function unbanIP(ip: string): boolean { return _bannedIPs.delete(ip); }

const safeRequestHandler = (req: any, res: any) => {
  const clientIP = req.socket?.remoteAddress || '';

  // Проверяем бан
  if (_bannedIPs.has(clientIP)) {
    res.writeHead(403);
    res.end();
    return;
  }

  try {
    // Первый проход: декодируем URL
    const decoded = decodeURIComponent(req.url);
    // Второй проход: Express может повторно декодировать результат (params)
    // Если повторное декодирование ломается — URL двойно-закодирован
    decodeURIComponent(decoded);
  } catch (e) {
    trackAttacker(clientIP);
    logger.debug(`Blocked malformed URL from ${clientIP}: ${req.url.substring(0, 100)}`);
    res.writeHead(400);
    res.end();
    return;
  }
  // === User-Agent фильтрация: блокировка известных сканеров ТСПУ/DPI ===
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  if (ua.includes('censys') || ua.includes('zgrab') || ua.includes('zmap') ||
      ua.includes('masscan') || ua.includes('nmap') || ua.includes('shodan') ||
      ua.includes('nuclei') || ua.includes('httpx') || ua.includes('dirbuster') ||
      ua.includes('gobuster') || ua.includes('nikto') || ua.includes('sqlmap') ||
      ua.includes('wpscan') || ua.includes('whatweb')) {
    trackAttacker(clientIP);
    // Silent drop — как nginx при отсутствии виртуального хоста
    res.destroy();
    return;
  }

  // Блокируем path traversal паттерны (../  ..\  /etc/  /bin/)
  const urlLower = req.url.toLowerCase();
  if (urlLower.includes('..') || urlLower.includes('/etc/') || urlLower.includes('/bin/') || urlLower.includes('cgi-bin') ||
      urlLower.includes('.env') || urlLower.includes('wp-login') || urlLower.includes('wp-admin') ||
      urlLower.includes('phpmy') || urlLower.includes('.php') || urlLower.includes('shell') ||
      // Пути чужих CMS: у нас их нет и быть не может, значит это
      // сканер. Раньше ловились только wp-login и wp-admin, а боты
      // ходят и по wp-includes с wlwmanifest — они доходили до
      // роутера и сорили в журнал.
      urlLower.includes('wp-includes') || urlLower.includes('wp-content') ||
      urlLower.includes('wlwmanifest') || urlLower.includes('xmlrpc') ||
      urlLower.includes('/media/system/') || urlLower.includes('/administrator/') ||
      urlLower.includes('autodiscover') || urlLower.includes('/vendor/') ||
      urlLower.includes('eval(') || urlLower.includes('exec(')) {
    trackAttacker(clientIP);
    logger.debug(`Blocked suspicious URL from ${clientIP}: ${req.url.substring(0, 100)}`);
    res.writeHead(403);
    res.end();
    return;
  }
  app(req, res);
};

// Создаём HTTP или HTTPS сервер в зависимости от наличия сертификатов
let httpServer: any;
let tlsOptions: https.ServerOptions | null = null;
const fullchainPath = path.join(process.cwd(), 'certs', 'fullchain.pem');
const certPath = path.join(process.cwd(), 'certs', 'cert.pem');
const chainPath = path.join(process.cwd(), 'certs', 'chain.pem');
const keyPath = path.join(process.cwd(), 'certs', 'key.pem');
const pfxPath = path.join(process.cwd(), 'certs', 'server.pfx');
const hasPem = fs.existsSync(certPath) && fs.existsSync(keyPath);
const hasPfx = fs.existsSync(pfxPath);
const useHttps = hasPem || hasPfx;

if (hasPem) {
  const certFile = fs.existsSync(fullchainPath) ? fullchainPath : certPath;
  const leCert = fs.readFileSync(certFile);
  const leKey = fs.readFileSync(keyPath);
  const leCA = (certFile === certPath && fs.existsSync(chainPath)) ? fs.readFileSync(chainPath) : undefined;

  tlsOptions = {
    cert: leCert,
    key: leKey,
    ...(leCA ? { ca: leCA } : {}),
    minVersion: 'TLSv1.2' as any,
    maxVersion: 'TLSv1.3' as any,
    // ALPN: только http/1.1 (Express/https.createServer не поддерживает HTTP/2)
    ALPNProtocols: ['http/1.1'],
    // === Маскировка TLS fingerprint под nginx 1.24+ ===
    // JA3/JA4 fingerprint совпадает с nginx с дефолтным ssl_ciphers
    ciphers: [
      'TLS_AES_256_GCM_SHA384',
      'TLS_CHACHA20_POLY1305_SHA256',
      'TLS_AES_128_GCM_SHA256',
      'ECDHE-ECDSA-AES256-GCM-SHA384',
      'ECDHE-RSA-AES256-GCM-SHA384',
      'ECDHE-ECDSA-CHACHA20-POLY1305',
      'ECDHE-RSA-CHACHA20-POLY1305',
      'ECDHE-ECDSA-AES128-GCM-SHA256',
      'ECDHE-RSA-AES128-GCM-SHA256',
      'DHE-RSA-AES256-GCM-SHA384',
      'DHE-RSA-AES128-GCM-SHA256',
    ].join(':'),
    honorCipherOrder: true,
    // ECDHE кривые как у nginx — чтобы JA3 не отличался
    ecdhCurve: 'X25519:P-256:P-384',
    // Session tickets как у nginx — позволяет TLS resumption
    // DPI/ТСПУ не может прочитать SNI при resumption (нет ClientHello SNI)
    sessionTimeout: 28800, // 8ч как у nginx
  } as any;

  // === SNI routing: чистый сертификат по умолчанию, LE — только по имени ===
  //
  // Node вызывает SNICallback ТОЛЬКО когда клиент прислал SNI. Тот, кто
  // идёт на голый адрес, SNI не шлёт вовсе — колбэк не срабатывает, и
  // уходит сертификат по умолчанию. Раньше там стоял LE, в котором
  // написано имя домена: обход по адресу светил ровно ту строку, по
  // которой нас и режут. В журнале это видно как RST через ~100 мс
  // после того, как мы отдали сертификат.
  //
  // Поэтому умолчание теперь чистое — в нём имени нет. Сертификат с
  // именем получает только тот, кто это имя сам назвал в SNI, то есть
  // обычный браузер, пришедший по домену. Для него ничего не меняется.
  const directCertPath = path.join(process.cwd(), 'certs', 'direct-cert.pem');
  const directKeyPath  = path.join(process.cwd(), 'certs', 'direct-key.pem');
  const legacyCertPath = path.join(process.cwd(), 'certs', 'ip-cert.pem');
  const legacyKeyPath  = path.join(process.cwd(), 'certs', 'ip-key.pem');
  const hasDirect = fs.existsSync(directCertPath) && fs.existsSync(directKeyPath);
  const cleanCertPath = hasDirect ? directCertPath : legacyCertPath;
  const cleanKeyPath  = hasDirect ? directKeyPath  : legacyKeyPath;

  if (fs.existsSync(cleanCertPath) && fs.existsSync(cleanKeyPath)) {
    const cleanCert = fs.readFileSync(cleanCertPath);
    const cleanKey  = fs.readFileSync(cleanKeyPath);

    const domainCtx = tls.createSecureContext({
      cert: leCert,
      key: leKey,
      ...(leCA ? { ca: leCA } : {}),
    });
    const directCtx = tls.createSecureContext({
      cert: cleanCert,
      key: cleanKey,
    });

    // Запасное имя с настоящей подписью — для браузеров.
    //
    // Браузеру нельзя приказать доверять ключу: страница такого права не
    // имеет. На запасном пути по голому адресу он упрётся в красный
    // экран, и человек либо уйдёт, либо приучится жать «всё равно
    // продолжить» — а это как раз та привычка, которой пользуется
    // подмена. Поэтому для браузеров нужен запасной путь ПО ИМЕНИ, с
    // обычной подписью: backup.example.org. Имя живёт у другого
    // поставщика и в другой зоне, и это не та строка, по которой режут.
    //
    // Пока файла нет — ничего не меняется, duckdns получает чистый
    // сертификат, как и голый адрес.
    const duckChainPath = path.join(process.cwd(), 'certs', 'duckdns-fullchain.pem');
    const duckKeyPath   = path.join(process.cwd(), 'certs', 'duckdns-key.pem');
    let duckCtx: tls.SecureContext | null = null;
    if (fs.existsSync(duckChainPath) && fs.existsSync(duckKeyPath)) {
      try {
        duckCtx = tls.createSecureContext({
          cert: fs.readFileSync(duckChainPath),
          key: fs.readFileSync(duckKeyPath),
        });
        logger.info('🔒 Запасное имя duckdns: отдаём подписанный сертификат');
      } catch (e) {
        // Битый файл не должен ронять запуск: без него просто уйдёт
        // чистый сертификат, связь от этого не прервётся.
        logger.warn(`duckdns: сертификат не читается (${(e as Error)?.message}) — отдаю чистый`);
        duckCtx = null;
      }
    }

    // Умолчание — чистый сертификат: это случай «SNI не прислали вовсе».
    (tlsOptions as any).cert = cleanCert;
    (tlsOptions as any).key  = cleanKey;
    delete (tlsOptions as any).ca;

    // === SNI Silent Drop: дропаем сканеры с подозрительным SNI ===
    const _sniDropCount = new Map<string, number>();
    (tlsOptions as any).SNICallback = (hostname: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void) => {
      // Колбэк обязан ответить ВСЕГДА.
      //
      // Если здесь вылетит исключение, cb не будет вызван никогда — и
      // рукопожатие повиснет насмерть, без обрыва и без ошибки. Снаружи
      // это выглядит как «сервер принял соединение и замолчал»: именно
      // так вела себя связь по наложенной сети, где клиент приходит без
      // SNI, а `hostname.endsWith(...)` на пустом значении бросает
      // TypeError. Поэтому сначала проверка на пустоту, а весь разбор —
      // под try, и на любой неожиданности отдаём чистый сертификат.
      try {
        const name = typeof hostname === 'string' ? hostname : '';

        if (name === 'backup.example.org') {
          // Запасное имя: подписанный сертификат, если он есть.
          cb(null, duckCtx || directCtx);
          return;
        }
        if (!name || /^[\d.:[\]]+$/.test(name)) {
          // Имени не назвали или назвали адрес — чистый.
          cb(null, directCtx);
          return;
        }
        if (name === config.domain || name === 'messenger.example.org' || name.endsWith('.online')) {
          cb(null, domainCtx);
          return;
        }
        // Чужой домен в SNI — сканер или active probe.
        const cnt = (_sniDropCount.get(name) || 0) + 1;
        _sniDropCount.set(name, cnt);
        if (cnt <= 3) {
          logger.debug(`🚫 SNI probe blocked: "${name}" (drop #${cnt})`);
        }
        cb(new Error('SNI mismatch'));
      } catch (e) {
        logger.warn(`SNI: разбор имени сорвался (${(e as Error)?.message}) — отдаю чистый сертификат`);
        try { cb(null, directCtx); } catch { /* сокет уже закрыт */ }
      }
    };
    setInterval(() => _sniDropCount.clear(), 300_000);
    logger.info(`🔒 SNI: умолчание — чистый сертификат (${hasDirect ? 'direct' : 'legacy ip'}), имя домена только по SNI, чужой SNI — обрыв`);
  } else {
    logger.warn('⚠️ Чистого сертификата нет — по адресу уходит сертификат с именем домена, DPI его видит');
  }

  httpServer = https.createServer(tlsOptions as https.ServerOptions, safeRequestHandler);
  logger.info('🛡️ DPI masking active: nginx ciphers + Server header + decoy endpoints');
} else if (hasPfx) {
  tlsOptions = {
    pfx: fs.readFileSync(pfxPath),
    passphrase: process.env.PFX_PASSPHRASE || '',
    ALPNProtocols: ['http/1.1'],
  } as any;
  httpServer = https.createServer(tlsOptions as https.ServerOptions, safeRequestHandler);
} else {
  httpServer = createServer(safeRequestHandler);
}

// === Middleware ===

// Дополнительная защита на уровне Express middleware (для частично-валидных URL)
app.use((req: Request, res: Response, next: NextFunction) => {
  try {
    decodeURIComponent(req.path);
    next();
  } catch (e) {
    logger.debug(`Blocked malformed URL: ${req.originalUrl} from ${req.ip}`);
    res.status(400).end();
  }
});

// === DPI Masking: полная маскировка под nginx за CDN ===
// Все заголовки совпадают с дефолтным nginx 1.24+ за Cloudflare-like CDN
// ТСПУ сравнивает TLS fingerprint + HTTP headers с белым списком
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Server', 'nginx/1.24.0');
  // HSTS как у обычного сайта — DPI видит стандартную конфигурацию
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  // Удаляем X-Powered-By (helmet уже делает, но перестраховка)
  res.removeHeader('X-Powered-By');

  // === CDN-like headers — выглядит как сервер за CDN ===
  const reqId = crypto.randomBytes(16).toString('hex');
  res.setHeader('X-Request-Id', reqId);
  res.setHeader('Vary', 'Accept-Encoding');
  // CF-like cache header — обычный выбор для сайтов за CDN
  res.setHeader('X-Cache-Status', 'HIT');

  // === Response Padding — затрудняет статистический анализ размеров пакетов DPI ===
  // Рандомный padding 0-256 байт в виде hex — ломает корреляцию размеров
  const padLen = Math.floor(Math.random() * 128);
  if (padLen > 0) {
    res.setHeader('X-Pad', crypto.randomBytes(padLen).toString('base64'));
  }

  next();
});

// Безопасность (helmet удаляет x-powered-by)
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false,
}));

// CORS
app.use(cors(config.cors));

// Пути, по которым идут сами файлы: скачивание, просмотр, потоковая отдача.
// Для них действуют особые правила — см. сжатие и ограничитель ниже.
const STREAMING_PATHS = /^\/api\/files\/(download|view|stream|preview)\//;

/**
 * Потоковый ли это путь — с учётом того, где стоит проверка.
 *
 * Express внутри смонтированного обработчика обрезает у req.path начало,
 * совпавшее с точкой монтирования: для app.use('/api/', …) путь приходит
 * уже как «/files/download/…», без «/api». Сравнение с полным шаблоном
 * молча не срабатывало — ограничитель продолжал считать куски файлов,
 * хотя по коду выглядело, что не должен. Поэтому смотрим на исходный
 * адрес запроса, который остаётся целым всегда.
 */
function isStreamingRequest(req: Request): boolean {
  const full = (req.originalUrl || req.url || '').split('?')[0];
  return STREAMING_PATHS.test(full);
}

// Сжатие — пропускаем SSE endpoint (иначе compression буферизует события)
app.use(compression({
  filter: (req, res) => {
    if (req.path === '/api/notifications/stream') return false;

    // Файлы не сжимаем. Видео, музыка, картинки и архивы уже сжаты — второй
    // проход не убавляет ни байта, зато занимает процессор на всё время
    // раздачи и ломает Content-Length: браузер теряет размер и не может
    // показать, сколько осталось качать. На больших файлах это и есть
    // «качается медленно» при живом канале.
    if (isStreamingRequest(req as Request)) return false;

    return compression.filter(req, res);
  }
}));

// Парсинг JSON
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// WAF (Web Application Firewall)
app.use(securityWAF);

// Ограничитель частоты. Ключ — адрес сокета: раньше сюда шёл заголовок от
// клиента, то есть каждый сам выбирал себе ключ и мог менять его на каждом
// запросе — ограничение не действовало вовсе.
const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
  keyGenerator: (req: Request) => getClientIp(req),

  // Куски файлов не считаем.
  //
  // Скачивание идёт диапазонами: файл на гигабайт — это сотни запросов к
  // одному и тому же маршруту. Раньше каждый кусок расходовал общий лимит,
  // и человек, качающий большой файл, выбивал сам себя из ограничителя —
  // после чего переставал работать уже весь мессенджер: сообщения, вход,
  // обновление. Со стороны это выглядит как «отвалился от сети», хотя сеть
  // у человека есть и сервер здоров.
  //
  // Отдача файлов и без того закрыта: маршруты проверяют вход и доступ к
  // конкретному файлу, так что открытой дырой это не становится.
  skip: (req: Request) => isStreamingRequest(req),
});
app.use('/api/', limiter);

// Логирование запросов
app.use((req: Request, _res: Response, next: NextFunction) => {
  logger.debug(`${req.method} ${req.path} [${getClientIp(req)}]`);
  next();
});

// === API Роуты ===
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/chats', chatRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/e2ee', e2eeRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/updates', updateRoutes);
app.use('/api/admin/moderation', moderationRouter);
app.use('/api/admin', adminRoutes);
app.use('/api/reports', reportRouter);
app.use('/api/legal', legalRouter);
// Звонки по HTTP — только для кнопок в шторке уведомлений, см. call.routes.ts
app.use('/api/calls', callRoutes);
// Корпоративный контур: каталог (AD), вход по паролю домена/RADIUS, УЦ устройств
app.use('/api/enterprise', enterpriseRoutes);

// === SSE Notification Stream (для Android APK — уведомления даже при закрытом приложении) ===
app.get('/api/notifications/stream', authMiddleware as any, (req: Request, res: Response) => {
  const userId = (req as any).user?.userId;
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Подтверждение подключения
  res.write('event: connected\ndata: {"status":"ok"}\n\n');
  if (typeof (res as any).flush === 'function') (res as any).flush();

  // Heartbeat каждые 25 секунд
  const heartbeat = setInterval(() => {
    try {
      res.write(':heartbeat\n\n');
      if (typeof (res as any).flush === 'function') (res as any).flush();
    } catch { clearInterval(heartbeat); }
  }, 25000);

  registerSSEClient(userId, res);

  req.on('close', () => clearInterval(heartbeat));
});

// === Аватары — статическая раздача без шифрования, с aggressive cache ===
const userAvatarsDir = path.join(process.cwd(), 'avatars', 'users');
if (!fs.existsSync(userAvatarsDir)) {
  fs.mkdirSync(userAvatarsDir, { recursive: true });
}
const groupAvatarsDir = path.join(process.cwd(), 'avatars', 'groups');
if (!fs.existsSync(groupAvatarsDir)) {
  fs.mkdirSync(groupAvatarsDir, { recursive: true });
}
// /api/avatars/groups/* → avatars/groups/
app.use('/api/avatars/groups', express.static(groupAvatarsDir, {
  maxAge: '7d',
  etag: true,
  lastModified: true,
  immutable: false,
  fallthrough: true,
}));
// /api/avatars/* → avatars/users/ (обратная совместимость)
app.use('/api/avatars', express.static(userAvatarsDir, {
  maxAge: '7d',        // Кэш 7 дней
  etag: true,
  lastModified: true,
  immutable: false,    // false чтобы при обновлении аватара клиент получил новый
  fallthrough: true,
}));

// === Кастомные эмодзи — статическая раздача PNG (без immutable для обновления) ===
const emojiDir = path.join(process.cwd(), 'emoji');
if (fs.existsSync(emojiDir)) {
  app.use('/emoji', express.static(emojiDir, {
    maxAge: '1d',
    etag: true,
    lastModified: true,
    immutable: false,
    fallthrough: true,
  }));
}

// === Обновления (APK) — статическая раздача ===
const updatesDir = path.join(process.cwd(), 'updates');
if (fs.existsSync(updatesDir)) {
  app.use('/updates', express.static(updatesDir, {
    maxAge: '0', // Нет кэширования для обновлений
    etag: false,
    lastModified: false,
    fallthrough: true,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.apk')) {
        res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      }
    }
  }));
}

// === API: каталог эмодзи ===
app.get('/api/emoji/catalog', (_req: Request, res: Response) => {
  const emojiPath = path.join(process.cwd(), 'emoji');
  if (!fs.existsSync(emojiPath)) {
    return res.json({ categories: [] });
  }
  const files = fs.readdirSync(emojiPath).filter(f => /^\d+_\d+\.png$/.test(f));
  const catMap: Record<number, number[]> = {};
  for (const f of files) {
    const m = f.match(/^(\d+)_(\d+)\.png$/);
    if (m) {
      const cat = parseInt(m[1]);
      const idx = parseInt(m[2]);
      if (!catMap[cat]) catMap[cat] = [];
      catMap[cat].push(idx);
    }
  }
  const categoryNames = ['Смайлики', 'Животные', 'Еда', 'Спорт', 'Путешествия', 'Объекты', 'Сердца', 'Флаги'];
  const categories = Object.keys(catMap).sort((a, b) => +a - +b).map(k => {
    const cat = parseInt(k);
    const indices = catMap[cat].sort((a, b) => a - b);
    return { id: cat, name: categoryNames[cat] || `Категория ${cat}`, count: indices.length, indices };
  });
  res.json({ categories });
});

// === DPI/ТСПУ Masking: сервер выглядит как обычный сайт ===
// Роботы ТСПУ, РКН-краулеры и DPI анализаторы видят обычный сайт с файловым хранилищем.
// Никаких признаков мессенджера в открытых метаданных.
app.get('/robots.txt', (_req: Request, res: Response) => {
  res.type('text/plain').send(
    'User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /s/\n\nSitemap: https://messenger.example.org/sitemap.xml'
  );
});
app.get('/sitemap.xml', (_req: Request, res: Response) => {
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    `  <url><loc>https://messenger.example.org/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>\n` +
    `  <url><loc>https://messenger.example.org/about</loc><changefreq>monthly</changefreq></url>\n` +
    `  <url><loc>https://messenger.example.org/privacy</loc><changefreq>yearly</changefreq></url>\n` +
    `  <url><loc>https://messenger.example.org/terms</loc><changefreq>yearly</changefreq></url>\n` +
    `</urlset>`
  );
});
app.get('/.well-known/security.txt', (_req: Request, res: Response) => {
  res.type('text/plain').send(
    'Contact: mailto:admin@messenger.example.org\nExpires: 2027-01-01T00:00:00.000Z\nPreferred-Languages: ru, en'
  );
});
// favicon.ico — обязательно для краулеров, без favicon сайт выглядит подозрительно
app.get('/favicon.ico', (_req: Request, res: Response) => {
  // 1x1 transparent PNG as ico
  const buf = Buffer.from('AAABAAEAAQEAAAEAIAAwAAAAFgAAACgAAAABAAAAAgAAAAEAIAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAA=', 'base64');
  res.type('image/x-icon').send(buf);
});

// === Камуфляжные HTML-страницы для краулеров ТСПУ ===
// Полноценный контент — краулеры видят реальный сайт "файлового хранилища"
const DECOY_HEADER = `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><link rel="icon" href="/favicon.ico"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,-apple-system,sans-serif;background:#f8fafc;color:#334155;line-height:1.6}header{background:#1e293b;color:#f1f5f9;padding:1rem 2rem}header h1{font-size:1.2rem;font-weight:600}nav{display:flex;gap:1.5rem;margin-top:.5rem}nav a{color:#94a3b8;text-decoration:none;font-size:.9rem}nav a:hover{color:#e2e8f0}main{max-width:800px;margin:2rem auto;padding:0 1rem}h2{color:#1e293b;margin-bottom:1rem}p{margin-bottom:1rem;color:#475569}footer{text-align:center;padding:2rem;color:#94a3b8;font-size:.8rem;border-top:1px solid #e2e8f0;margin-top:3rem}</style>`;
const DECOY_NAV = `<header><h1>Storage Service</h1><nav><a href="/">Главная</a><a href="/about">О сервисе</a><a href="/privacy">Конфиденциальность</a><a href="/terms">Условия</a></nav></header>`;
const DECOY_FOOTER = `<footer>&copy; 2024-2026 Storage Service. Все права защищены.</footer></body></html>`;

app.get('/about', (_req: Request, res: Response) => {
  res.type('text/html').send(
    `${DECOY_HEADER}<title>О сервисе — Storage Service</title><meta name="description" content="Облачное хранилище файлов для личного и корпоративного использования"></head><body>${DECOY_NAV}<main>` +
    `<h2>О сервисе</h2>` +
    `<p>Storage Service — это безопасное облачное хранилище файлов. Мы обеспечиваем надёжное хранение ваших документов, фотографий и медиафайлов с шифрованием на стороне сервера.</p>` +
    `<p>Сервис предоставляет удобный доступ к файлам с любого устройства через веб-интерфейс. Поддерживается загрузка файлов до 2 ГБ, автоматическое создание миниатюр для изображений и предпросмотр документов.</p>` +
    `<p>Для бизнес-клиентов доступны расширенные функции: управление доступом, журнал действий, интеграция с Active Directory и API для автоматизации.</p>` +
    `<h2>Технологии</h2>` +
    `<p>Платформа построена на современном стеке: серверная часть на Node.js, хранение данных с использованием AES-256 шифрования, резервное копирование в реальном времени.</p>` +
    `</main>${DECOY_FOOTER}`
  );
});

app.get('/privacy', (_req: Request, res: Response) => {
  res.type('text/html').send(
    `${DECOY_HEADER}<title>Политика конфиденциальности — Storage Service</title></head><body>${DECOY_NAV}<main>` +
    `<h2>Политика конфиденциальности</h2>` +
    `<p>Последнее обновление: 1 января 2026 г.</p>` +
    `<p>Мы серьёзно относимся к защите ваших персональных данных. Настоящая политика описывает, какие данные мы собираем и как их используем.</p>` +
    `<p><strong>Собираемые данные:</strong> При регистрации мы запрашиваем адрес электронной почты. При использовании сервиса хранения мы обрабатываем загруженные вами файлы и метаданные (размер, тип, дата загрузки).</p>` +
    `<p><strong>Хранение данных:</strong> Все файлы хранятся в зашифрованном виде на серверах, расположенных на территории Российской Федерации, в соответствии с требованиями 152-ФЗ.</p>` +
    `<p><strong>Передача данных:</strong> Мы не передаём ваши данные третьим лицам, за исключением случаев, предусмотренных законодательством РФ.</p>` +
    `<p><strong>Cookies:</strong> Мы используем файлы cookie для поддержания сессии авторизации. Вы можете отключить cookie в настройках браузера.</p>` +
    `<p>По вопросам обработки персональных данных: <a href="mailto:admin@messenger.example.org">admin@messenger.example.org</a></p>` +
    `</main>${DECOY_FOOTER}`
  );
});

app.get('/terms', (_req: Request, res: Response) => {
  res.type('text/html').send(
    `${DECOY_HEADER}<title>Условия использования — Storage Service</title></head><body>${DECOY_NAV}<main>` +
    `<h2>Условия использования</h2>` +
    `<p>Последнее обновление: 1 января 2026 г.</p>` +
    `<p>Используя сервис Storage Service, вы соглашаетесь с настоящими условиями.</p>` +
    `<p><strong>Допустимое использование:</strong> Сервис предназначен для хранения легального контента. Запрещено загружать материалы, нарушающие законодательство РФ, авторские права третьих лиц или содержащие вредоносное ПО.</p>` +
    `<p><strong>Ограничения:</strong> Бесплатный аккаунт ограничен 5 ГБ хранилища. Максимальный размер одного файла — 2 ГБ. Файлы, не запрашиваемые в течение 365 дней, могут быть удалены.</p>` +
    `<p><strong>Ответственность:</strong> Сервис предоставляется «как есть». Мы не несём ответственности за потерю данных в результате технических сбоев. Рекомендуется сохранять резервные копии важных файлов.</p>` +
    `<p><strong>Прекращение доступа:</strong> Мы оставляем за собой право заблокировать аккаунт при нарушении условий использования.</p>` +
    `</main>${DECOY_FOOTER}`
  );
});

// Health check — минимальный ответ, не светит детали (ТСПУ краулер не должен узнать что это мессенджер)
app.get('/api/health', (req: Request, res: Response) => {
  // Если есть Authorization — отдаём полный ответ; иначе минимальный
  const hasAuth = req.headers['authorization'];
  if (!hasAuth) {
    // Краулер/ТСПУ/сканер — ответ как от обычного веб-сервера
    return res.json({ status: 'ok' });
  }
  const stunStats = getStunTurnStats();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    stunTurn: stunStats,
    storage: {
      fallback: storageService.isOnFallback(),
      note: storageService.isOnFallback() ? 'Внешний диск недоступен, работаем на системном' : undefined,
    },
  });
});

// Периодическая проверка восстановления основного хранилища (каждые 60 сек)
setInterval(() => {
  if (storageService.isOnFallback()) {
    storageService.tryRecoverPrimaryStorage();
  }
}, 60_000);

// Валидация БД (ручной запуск)
app.get('/api/health/db', (_req: Request, res: Response) => {
  try {
    const results = validateDatabase();
    const errors = results.filter(r => r.status === 'error').length;
    res.json({
      status: errors > 0 ? 'error' : 'ok',
      timestamp: new Date().toISOString(),
      checks: results,
    });
  } catch (e: any) {
    res.status(500).json({ status: 'error', error: e.message });
  }
});

// Информация о сервере
app.get('/api/info', (_req: Request, res: Response) => {
  const localIPs = getLocalIPs();
  const primaryIP = getPrimaryIP();
  const yggInfo = getYggdrasilInfo();
  
  res.json({
    name: 'STORAGE&MESS',
    version: '1.0.0',
    iceServers: config.iceServers,
    serverIP: primaryIP,
    serverIPs: localIPs,
    yggdrasil: {
      enabled: yggInfo.running,
      address: yggInfo.address,
      subnet: yggInfo.subnet,
      publicKey: yggInfo.publicKey,
      peers: yggInfo.peers,
    },
  });
});

// ICE-серверы для WebRTC (клиент получает конфигурацию STUN/TURN)
// Включает локальные STUN/TURN (primary) + Google STUN (fallback) + публичные TURN
app.get('/api/ice-servers', (_req: Request, res: Response) => {
  const announcedIp = process.env.MEDIASOUP_ANNOUNCED_IP || config.domain || 'localhost';
  const stunPort = process.env.LOCAL_STUN_PORT || '3478';
  const externalPort = process.env.EXTERNAL_PORT || '443';
  const localTurnUser = process.env.LOCAL_TURN_USERNAME || 'smess';
  const localTurnPass = process.env.LOCAL_TURN_PASSWORD || 'change-me-turn-password';

  // Yggdrasil IPv6 как fallback
  const yggAddr = getYggdrasilAddress();

  // === Порт 443 (проходит через любой firewall/NAT — САМЫЙ ПРИОРИТЕТНЫЙ) ===
  const port443Stun = { urls: `stun:${announcedIp}:${externalPort}` };
  const port443TurnUdp = {
    urls: `turn:${announcedIp}:${externalPort}?transport=udp`,
    username: localTurnUser,
    credential: localTurnPass,
  };
  // TURNS (TURN over TLS) — используем доменное имя для валидации TLS сертификата
  // Учитываем X-Forwarded-Host чтобы релей-прокси отдавал свой домен!
  const requestHost = (_req.headers['x-forwarded-host'] || _req.headers.host || config.domain) as string;
  const turnsHost = requestHost.split(':')[0] !== 'localhost' ? requestHost.split(':')[0] : announcedIp;
  const port443TurnTcp = {
    urls: `turns:${turnsHost}:${externalPort}?transport=tcp`,
    username: localTurnUser,
    credential: localTurnPass,
  };

  // === Порт 3478 (стандартный локальный STUN/TURN) ===
  const localStun = { urls: `stun:${announcedIp}:${stunPort}` };
  const localTurnUdp = {
    urls: `turn:${announcedIp}:${stunPort}?transport=udp`,
    username: localTurnUser,
    credential: localTurnPass,
  };
  const localTurnTcp = {
    urls: `turn:${announcedIp}:${stunPort}?transport=tcp`,
    username: localTurnUser,
    credential: localTurnPass,
  };

  // Yggdrasil STUN/TURN (если доступен)
  const yggServers: Array<{ urls: string; username?: string; credential?: string }> = [];
  if (yggAddr) {
    yggServers.push({ urls: `stun:[${yggAddr}]:${stunPort}` });
    yggServers.push({
      urls: `turn:[${yggAddr}]:${stunPort}?transport=udp`,
      username: localTurnUser,
      credential: localTurnPass,
    });
  }

  // Порядок: local 443 TURN (firewall-friendly) → local 3478 → Google STUN → public TURN → Yggdrasil
  const localAll = [
    port443Stun, port443TurnUdp, port443TurnTcp,
    localStun, localTurnUdp, localTurnTcp,
    ...yggServers,
  ];

  // Ярусы 3478/3479 и Yggdrasil — для своей сети и для тех, у кого поднят
  // оверлей. Обычному человеку снаружи они недоступны и только съедают
  // время: WebRTC честно ждёт таймаута по каждому.
  const clientIp = getClientIp(_req);
  const isLanRequest = isPrivateIp(clientIp);
  // Адреса Yggdrasil лежат в 200::/7. Оверлейные STUN/TURN имеют смысл
  // только для тех, кто сам пришёл через оверлей: остальным до них нет
  // маршрута, и это просто ещё два адреса, на которых WebRTC подождёт.
  const isYggRequest = /^[23][0-9a-f]{2}:/i.test(clientIp);

  // Свой основной путь — через 443 на наш адрес — не выбрасываем никогда:
  // если проверка ошибётся, пусть лучше клиент попробует сам, чем
  // останется вообще без relay.
  //
  // Важно, что это именно НАШ 443, а не любой. Первая версия проверяла
  // просто «:443 в адресе» — и под защиту попали чужие мёртвые серверы,
  // у которых тот же порт.
  const ourHosts = [announcedIp, turnsHost, config.domain].filter(Boolean).map(String);
  const isOurs = (url: string) => ourHosts.some(h => url.includes(h));
  const keepAlways = (url: string) => isOurs(url) && url.includes(`:${externalPort}`);

  Promise.all([
    filterAliveIceServers(localAll, keepAlways, isOurs),
    filterAliveIceServers(config.iceServers as Array<{ urls: string }>, keepAlways, isOurs),
  ])
    .then(([liveLocal, livePublic]) => {
      const local = liveLocal.filter(s => {
        const isYgg = s.urls.includes('[');
        if (isYgg) return isYggRequest || isLanRequest;
        // Ярус 3478/3479 наружу не проброшен — только для своей сети.
        if (s.urls.includes(`:${stunPort}`)) return isLanRequest;
        return true;
      });

      // Убираем повторы: один и тот же STUN нередко приезжает и из
      // переменных окружения, и из зашитого запаса.
      const seen = new Set<string>();
      const dedupe = <T extends { urls: string }>(list: T[]) =>
        list.filter(s => (seen.has(s.urls) ? false : (seen.add(s.urls), true)));

      const finalLocal = dedupe(local);
      const finalPublic = dedupe(livePublic as any[]);

      res.json({
        iceServers: finalPublic,
        localIceServers: finalLocal,
        allIceServers: [...finalLocal, ...finalPublic],
        yggdrasil: yggAddr ? { address: yggAddr, port: config.port } : null,
      });
    })
    .catch(err => {
      logger.warn('[ICE] проверка живости сорвалась, отдаю список без неё:', err);
      res.json({
        iceServers: config.iceServers,
        localIceServers: localAll,
        allIceServers: [...localAll, ...config.iceServers],
        yggdrasil: yggAddr ? { address: yggAddr, port: config.port } : null,
      });
    });
});

// Что сейчас известно про живость STUN/TURN — для вкладки «Сервер».
app.get('/api/ice-health', (_req: Request, res: Response) => {
  res.json({ servers: getIceHealthSnapshot() });
});

// === Статические файлы (для production и development) ===
// Ищем web-client/dist - если есть, раздаём статику
const webClientPath = path.join(process.cwd(), '..', 'web-client', 'dist');

if (fs.existsSync(webClientPath)) {
  app.use(express.static(webClientPath, {
    // index.html НЕ кэшировать — чтобы новые inline-скрипты и ссылки на бандлы всегда доставлялись
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else if (filePath.match(/\.(js|css)$/)) {
        // JS/CSS с хэшем в имени — агрессивное кэширование
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (filePath.match(/\.(woff2?|ttf|otf|eot)$/)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (filePath.match(/\.(png|jpg|jpeg|gif|webp|svg|ico)$/)) {
        res.setHeader('Cache-Control', 'public, max-age=86400');
      }
    }
  }));
  
  // SPA fallback — только для маршрутов приложения (/login, /chat/…).
  //
  // Раньше сюда проваливалось ВСЁ, включая несуществующие файлы. Из-за
  // этого запрос за /updates/storage-store.apk, которого на диске не
  // было, получал index.html с кодом 200 и типом text/html — браузер
  // честно сохранял страницу под именем .apk, и пользователь получал
  // «скачался какой-то мусор» вместо магазина обновлений.
  //
  // Тот же класс однажды уже ломал вход: код 200 не доказывает, что
  // ответили тем, что просили. Поэтому теперь запрос, похожий на файл
  // (есть расширение) или адресованный в каталоги раздачи, при
  // отсутствии файла честно получает 404.
  app.get('*', (req: Request, res: Response) => {
    if (req.path.startsWith('/api/')) return;

    const looksLikeFile = /\.[A-Za-z0-9]{1,8}$/.test(req.path);
    const isDownloadDir = /^\/(updates|emoji|assets)\//.test(req.path);

    if (looksLikeFile || isDownloadDir) {
      logger.warn(`404: файл не найден — ${req.path}`);
      res.status(404).type('text/plain').send('Not found');
      return;
    }

    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(webClientPath, 'index.html'));
  });
} else if (!config.isDev) {
  // Только для production без dist - ошибка
  app.use(express.static(webClientPath));
  
  app.get('*', (req: Request, res: Response) => {
    if (!req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.sendFile(path.join(webClientPath, 'index.html'));
    } else {
      res.status(404).json({ error: 'Not found' });
    }
  });
}

// === Обработка ошибок ===
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  // Malformed URI — сканеры/боты с двойной кодировкой (CVE-2021-41773 и подобные)
  if (err instanceof URIError) {
    logger.debug(`Blocked malformed URL: ${req.originalUrl} from ${req.ip}`);
    res.status(400).end();
    return;
  }
  logger.error('Unhandled error:', err);
  res.status(500).json({
    error: config.isDev ? err.message : 'Internal server error',
  });
});

// 404
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// === Запуск сервера ===
async function start(): Promise<void> {
  try {
    // Инициализация базы данных
    logger.info('Initializing database...');
    initDatabase();
    runMigrations();

    // Валидация целостности БД
    validateDatabase();

    // Инициализация Socket.io с rate-limiter
    const io = initializeSocket(httpServer);

    // === RAW HTTP LOGGER ===
    httpServer.on('request', (req: any, _res: any) => {
      if (req.url?.includes('/s/')) {
        logger.info(`[RAW HTTP] ${req.method} ${req.url} | Origin: ${req.headers.origin || 'none'} | UA: ${req.headers['user-agent'] || 'none'} | IP: ${req.socket.remoteAddress}`);
      }
    });

    // Инициализация Web Push (VAPID)
    initPushService();

    // Запуск локального STUN/TURN сервера (fallback если Google STUN недоступен)
    // LOCAL_STUN=0 — не поднимать вовсе (стенды и демо: он слушает 0.0.0.0).
    const stunTurnPort = parseInt(process.env.LOCAL_STUN_PORT || '3478', 10);
    const announcedIp = process.env.MEDIASOUP_ANNOUNCED_IP || getPrimaryIP() || '127.0.0.1';
    if (process.env.LOCAL_STUN === '0') {
      logger.info('📡 Свой STUN/TURN выключен (LOCAL_STUN=0)');
    } else try {
      startStunTurnServer({
        port: stunTurnPort,
        host: '0.0.0.0',
        announcedIp,
        username: process.env.LOCAL_TURN_USERNAME || 'smess',
        password: process.env.LOCAL_TURN_PASSWORD || 'change-me-turn-password',
        realm: 'smess',
        relayPortMin: parseInt(process.env.LOCAL_RELAY_PORT_MIN || '50000', 10),
        relayPortMax: parseInt(process.env.LOCAL_RELAY_PORT_MAX || '50345', 10),
      });

      // Дополнительно: STUN/TURN на порту сервера (UDP) — для NAT/firewall
      // Внешний порт 443 пробрасывается на 3001, UDP не конфликтует с HTTPS (TCP)
      const serverPort = config.port; // обычно 3001
      const externalPort = parseInt(process.env.EXTERNAL_PORT || '443', 10);
      if (serverPort !== stunTurnPort) {
        // udpOnly=true — TCP порт 3001 занят HTTPS, используем только UDP
        addStunTurnPort(serverPort, announcedIp, { externalPort, udpOnly: true });
        logger.info(`📡 STUN/TURN multi-port: :${stunTurnPort} (UDP+TCP) + :${serverPort} UDP (ext :${externalPort})`);
      }
    } catch (e) {
      logger.warn(`⚠ Could not start local STUN/TURN server: ${e}`);
    }

    // Определение IP-адресов сервера
    const localIPs = getLocalIPs();
    const primaryIP = getPrimaryIP();
    const serverIP = primaryIP || 'localhost';
    const yggAddr = getYggdrasilAddress();

    // Запуск сервера (HTTP или HTTPS)
    const protocol = useHttps ? 'HTTPS' : 'HTTP';
    
    // === TURNS: TURN over TLS на том же HTTPS порту ===
    if (useHttps) {
      const origSecureHandlers = httpServer.listeners('secureConnection').slice();
      httpServer.removeAllListeners('secureConnection');
      
      httpServer.on('secureConnection', (tlsSocket: any) => {
        // Health checker: трекаем TLS handshake время
        const handshakeStart = tlsSocket._parent?._startTime || Date.now();
        trackTlsHandshake(Date.now() - handshakeStart);

        // DPI Protection: закаляем сокет (NODELAY, keepalive, TLS fragmentation)
        hardenTlsSocket(tlsSocket);

        tlsSocket.on('error', (err: any) => {
          // Сюда попадают уже УСТАНОВЛЕННЫЕ соединения: событие
          // secureConnection означает, что рукопожатие прошло целиком.
          // Значит посредник его не рвал, и обрыв — дело клиента.
          trackConnectionReset(err?.code || 'TLS_SOCKET_ERROR', true);
        });

        tlsSocket.once('data', (data: Buffer) => {
          const isSTUN = data.length >= 8 &&
            data[4] === 0x21 && data[5] === 0x12 &&
            data[6] === 0xA4 && data[7] === 0x42;
          
          if (isSTUN) {
            handleTurnTcpSocket(tlsSocket as any, data, announcedIp);
          } else {
            tlsSocket.unshift(data);
            for (const handler of origSecureHandlers) {
              (handler as Function).call(httpServer, tlsSocket);
            }
          }
        });
      });
    }

    // Вот это — настоящий признак: рукопожатие не состоялось вовсе.
    httpServer.on('tlsClientError', (err: any) => {
      trackConnectionReset(err?.code || 'TLS_CLIENT_ERROR', false);
    });
    httpServer.on('clientError', (err: any) => {
      if (err?.code === 'ECONNRESET' || err?.code === 'EPIPE' || err?.code === 'ECONNABORTED') {
        // Ошибка на уровне HTTP — соединение уже работало и что-то успело
        // передать. Обычное «клиент закрыл вкладку» или «плеер бросил
        // недокачанный трек», а не нападение.
        trackConnectionReset(err.code, true);
      }
    });

    httpServer.headersTimeout = 0;
    httpServer.requestTimeout = 0;
    httpServer.keepAliveTimeout = 120_000;
    httpServer.timeout = 0;

    httpServer.listen(config.port, config.host, () => {
      logger.info(`🚀 STORAGE&MESS Server started`);
      // Свой сервер должен находиться и без интернета — см. lan-discovery
      startLanDiscovery({ https: useHttps, port: config.port, name: process.env.SERVER_NAME });
      initHealthChecker(getIo(), httpServer);
      if (useHttps) {
        initDPIProtection({ port: config.port });
      }
      emailBridgeService.init();
      // Корпоративный контур (ENT_DIRECTORY=ldap): УЦ, аварийный админ, синхронизация
      startEnterprise();
      logger.info(`   IP Address: ${serverIP}`);
      if (localIPs.length > 1) {
        logger.info(`   All IPs: ${formatIPsForDisplay()}`);
      }
      logger.info(`   ${protocol}: ${useHttps ? 'https' : 'http'}://${serverIP}:${config.port}`);
      logger.info(`   Mode: ${config.nodeEnv}`);
      logger.info(`   API:  ${useHttps ? 'https' : 'http'}://${serverIP}:${config.port}/api`);
      if (useHttps) {
        logger.info(`   🔒 SSL Certificate found and enabled`);
        logger.info(`   📡 TURNS on port ${config.port} (TURN over TLS — mobile-friendly)`);
      }
      
      try {
        dpiAnalyzer.init();
      } catch (err) {
        logger.error('Failed to init DPI Analyzer', err);
      }

      if (yggAddr) {
        logger.info(`   🌐 Yggdrasil IPv6 (fallback): [${yggAddr}]:${config.port}`);
        const yggInfo = getYggdrasilInfo();
        if (yggInfo.publicKey) {
          logger.info(`   🔑 Yggdrasil Public Key: ${yggInfo.publicKey}`);
        }
        if (yggInfo.peers > 0) {
          logger.info(`   🔗 Yggdrasil Peers: ${yggInfo.peers} connected`);
        } else {
          logger.warn(`   ⚠ Yggdrasil: no peers connected (network isolated)`);
        }
      }
    });

    if (useHttps && config.port === 443) {
      const redirectApp = express();
      redirectApp.get('*', (req: any, res: any) => {
        res.redirect(301, `https://${req.headers.host}${req.url}`);
      });
      const httpRedirectServer = createServer(redirectApp);
      httpRedirectServer.listen(80, config.host, () => {
        logger.info(`   🔀 HTTP redirect server on port 80 -> HTTPS`);
      });
      httpRedirectServer.on('error', (err: any) => {
        if (err.code === 'EACCES') {
          logger.warn('   ⚠ Cannot start HTTP redirect on port 80 (need admin rights)');
        } else if (err.code === 'EADDRINUSE') {
          logger.warn('   ⚠ Port 80 is already in use, HTTP redirect disabled');
        }
      });
    }

    // === Плейнтекст HTTP-сервер для IP-фоллбэка (без SSL) ===
    // PLAINTEXT_FALLBACK=0 — не поднимать (стенды и демо: порт 8080 занят боевым).
    if (process.env.PLAINTEXT_FALLBACK === '0') {
      logger.info('   🔓 Запасной HTTP на 8080 выключен (PLAINTEXT_FALLBACK=0)');
    } else try {
      const plaintextServer = createServer(safeRequestHandler);
      const ioInstance = getIo();
      if (ioInstance) {
        ioInstance.attach(plaintextServer, { 
          path: '/api/sync/', 
          transports: ['websocket', 'polling'],
          allowEIO3: true,
          cors: { origin: '*', methods: ['GET', 'POST'] }
        });
      }
      plaintextServer.listen(8080, config.host, () => {
        logger.info(`   🔓 Plaintext HTTP API server (Fallback) on port 8080`);
      });
      plaintextServer.on('error', (err: any) => {
        logger.warn(`   ⚠ Cannot start plaintext fallback on 8080: ${err.message}`);
      });
    } catch (e: any) {
      logger.error(`   ⚠ Plaintext server crash: ${e.message}`);
    }

  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

// === Graceful shutdown ===
let shuttingDown = false;

/**
 * Уборка при остановке. Вызывается ровно один раз, и — важно — НЕ из
 * колбэка `httpServer.close()`.
 *
 * Раньше всё это лежало внутри того колбэка, а он не приходил: у нас
 * всегда висят Socket.IO и SSE-потоки, и сервер честно ждал, пока они
 * закроются сами. Каждая остановка доходила до аварийной отсечки на 10
 * секунд и выходила с кодом 1 («не закрылся штатно — снят принудительно» в
 * ярлыке). То есть база ни разу не закрывалась штатно, служба распознавания
 * не останавливалась, защита от DPI не снималась — всё это просто убивали
 * вместе с процессом.
 */
let cleanedUp = false;
function cleanupAndExit(code: number): void {
  if (cleanedUp) return;
  cleanedUp = true;

  try { stopEnterprise(); } catch (e) { /* не запускался */ }
  try { cleanupDPIProtection(); } catch (e) { /* уже снята */ }
  try { dpiAnalyzer.stop(); } catch (e) { /* не запускался */ }
  try { transcriptionService.shutdown(); logger.info('Vosk daemon stopped'); } catch (e) { /* не поднят */ }
  try { stopStunTurnServer(); logger.info('STUN/TURN server stopped'); } catch (e) { /* не поднят */ }
  try { closeDatabase(); logger.info('Database connection closed'); } catch (e) { /* уже закрыта */ }

  process.exit(code);
}

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal}. Shutting down gracefully...`);

  // Рвём висящие соединения сами: ждать, пока разговоры и потоки уведомлений
  // разойдутся по-хорошему, можно бесконечно.
  try { getIo()?.close(); } catch (e) { /* ещё не поднят или уже закрыт */ }
  try { httpServer.closeAllConnections(); } catch (e) { /* Node < 18.2 */ }

  httpServer.close(() => {
    logger.info(`${useHttps ? 'HTTPS' : 'HTTP'} server closed`);
    cleanupAndExit(0);
  });

  // Подстраховка на случай, если колбэк выше так и не придёт. Уборку делаем
  // всё равно и выходим нулём: порты уже отпущены, висят только чужие
  // недозакрытые сокеты, и это не повод считать остановку неудачной.
  setTimeout(() => {
    logger.warn('Соединения не разошлись сами — закрываемся принудительно');
    cleanupAndExit(0);
  }, 3000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (error: Error) => {
  logger.error('💥 UNCAUGHT EXCEPTION (server kept alive):', error.message, error.stack);
});
process.on('unhandledRejection', (reason: any) => {
  logger.error('💥 UNHANDLED REJECTION (server kept alive):', reason);
});

start();
