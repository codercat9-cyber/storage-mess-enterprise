import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export const config = {
  // Сервер — :: это dual-stack (IPv4 + IPv6 одновременно, включая Yggdrasil fallback)
  port: parseInt(process.env.PORT || '3001', 10),
  host: process.env.HOST || '::',
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: process.env.NODE_ENV !== 'production',
  serverUrl: process.env.SERVER_URL || `http://localhost:${process.env.PORT || '3001'}`,  
  domain: process.env.DOMAIN || 'localhost',

  // JWT
  jwt: {
    secret: process.env.JWT_SECRET || 'default-secret-change-me',
    // Прежние секреты: ими проверяются только токены обновления, лежащие в
    // базе (см. auth.routes /refresh). До 31.10.2026 боевым секретом стояла
    // заглушка из .env.example — подделать вход мог кто угодно.
    legacySecrets: (process.env.JWT_SECRET_OLD || '').split(',').map(s => s.trim()).filter(Boolean),
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  // Админ
  adminSecret: process.env.ADMIN_SECRET || '',

  // SMTP для email-сброса пароля и email-bridge
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || process.env.SMTP_USER || '',
  },

  // IMAP для email-bridge (приём ответов на email)
  imap: {
    host: process.env.IMAP_HOST || '',
    port: parseInt(process.env.IMAP_PORT || '993', 10),
    secure: process.env.IMAP_SECURE !== 'false', // default true
    user: process.env.IMAP_USER || process.env.SMTP_USER || '',
    pass: process.env.IMAP_PASS || process.env.SMTP_PASS || '',
  },

  // База данных
  database: {
    url: process.env.DATABASE_URL || './data/kotex.db',
  },

  // Хранилище — без ограничений размера файла (0 = без лимита)
  storage: {
    path: process.env.STORAGE_PATH || process.env.STORAGE_DISK_PATH || './storage',
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '0', 10) || Infinity,
    raidEnabled: process.env.RAID_ENABLED === 'true',
    raidPaths: process.env.RAID_PATHS?.split(',').filter(Boolean) || [],
  },

  // Mediasoup
  mediasoup: {
    listenIp: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
    announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || process.env.SERVER_URL?.replace(/http(s)?:\/\//, '') || '127.0.0.1',
    minPort: parseInt(process.env.MEDIASOUP_MIN_PORT || '40000', 10),
    maxPort: parseInt(process.env.MEDIASOUP_MAX_PORT || '49999', 10),
    
    worker: {
      rtcMinPort: parseInt(process.env.MEDIASOUP_MIN_PORT || '40000', 10),
      rtcMaxPort: parseInt(process.env.MEDIASOUP_MAX_PORT || '49999', 10),
      logLevel: 'warn' as const,
      logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'] as const,
    },

    router: {
      mediaCodecs: [
        {
          kind: 'audio' as const,
          mimeType: 'audio/opus',
          clockRate: 48000,
          channels: 2,
        },
        {
          kind: 'video' as const,
          mimeType: 'video/VP8',
          clockRate: 90000,
          parameters: {
            'x-google-start-bitrate': 1000,
          },
        },
        {
          kind: 'video' as const,
          mimeType: 'video/VP9',
          clockRate: 90000,
          parameters: {
            'profile-id': 2,
            'x-google-start-bitrate': 1000,
          },
        },
        {
          kind: 'video' as const,
          mimeType: 'video/H264',
          clockRate: 90000,
          parameters: {
            'packetization-mode': 1,
            'profile-level-id': '4d0032',
            'level-asymmetry-allowed': 1,
            'x-google-start-bitrate': 1000,
          },
        },
      ],
    },

    webRtcTransport: {
      listenIps: [
        {
          ip: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
          announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || null,
        },
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      maxIncomingBitrate: 1500000,
      initialAvailableOutgoingBitrate: 1000000,
    },
  },

  // STUN/TURN — расширенный набор для работы через VPN/NAT
  iceServers: [
    ...(process.env.STUN_SERVERS?.split(',').map(url => ({ urls: url.trim() })) || []),
    // Google STUN — только как fallback, если свои не указаны или недоступны
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    // TURN серверы — критически важны для VPN/symmetric NAT
    ...(process.env.TURN_SERVER ? [{
      urls: process.env.TURN_SERVER,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    }] : []),
    // Дополнительные TURN (свободные / резервные)
    ...(process.env.TURN_SERVERS_EXTRA?.split(';').filter(Boolean).map(entry => {
      // Формат: urls|username|credential
      const [urls, username, credential] = entry.split('|');
      return { urls: urls.trim(), username: username?.trim(), credential: credential?.trim() };
    }) || []),
  ],

  cors: {
    origin: true,
    credentials: true,
    exposedHeaders: ['X-Request-Id'],
    // Заголовки, которые клиент имеет право прислать.
    //
    // Cache-Control / Pragma / Expires добавлены не для красоты: наш же
    // клиент шлёт их на каждом запросе (костыль против кэша в Android
    // WebView, из-за которого после переподключения подтягивался старый
    // список сообщений). Пока страница и сервер жили на одном адресе,
    // это никого не касалось — проверок между источниками нет. Но у
    // настольного приложения интерфейс раздаётся с 127.0.0.1, и запрос
    // стал межсайтовым: браузер сначала спрашивает разрешение на эти
    // заголовки, не находит их в списке и блокирует запрос ДО отправки.
    // Сервер о таком запросе даже не узнаёт — в журнале пусто, а человек
    // видит «Network Error» и думает, что не тот пароль.
    allowedHeaders: [
      'Content-Type', 'Authorization',
      'X-Forwarded-For', 'X-Forwarded-Proto',
      'Cache-Control', 'Pragma', 'Expires',
    ],
  },

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
  },

  // Логирование
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    file: process.env.LOG_FILE || './logs/server.log',
  },
};

export default config;
