import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';
import { getClientIp } from '../utils/client-ip.js';
import fs from 'fs';
import path from 'path';

// Лог-файл для Fail2Ban
const SECURITY_LOG_PATH = path.join(process.cwd(), 'logs', 'security.log');

// Убедимся, что директория существует
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Запись в журнал безопасности. Его читает fail2ban, поэтому формат строки
// — часть внешнего договора, а не украшение.
//
// Дата тут вычислялась и не подставлялась в строку: `timestamp` просто
// висел неиспользованной переменной. Строку без распознаваемой даты
// fail2ban пропускает, так что джейл не сработал бы, даже если бы смотрел
// в правильный файл (а он смотрел в пустой — см. РАБОТЫ-2026-08).
//
// Побочная польза: две тысячи старых строк остались без даты, и при
// включении джейла они будут пропущены — никого не забанит задним числом.
function logSecurityEvent(ip: string, reason: string, req: Request) {
  const timestamp = new Date().toISOString();
  const logLine = `${timestamp} [SECURITY] [BLOCKED] IP: ${ip} Reason: ${reason} URL: ${req.method} ${req.originalUrl} UA: ${req.get('User-Agent') || 'None'}\n`;
  
  // Пишем в файл (синхронно для простоты, т.к. блокируем запрос)
  try {
    fs.appendFileSync(SECURITY_LOG_PATH, logLine);
  } catch (err) {
    logger.error('Failed to write to security log:', err);
  }
  
  // Дублируем в основной логгер
  logger.warn(`Security Block - IP: ${ip}, Reason: ${reason}`);
}

export function securityWAF(req: Request, res: Response, next: NextFunction) {
  // Адрес берём у сокета, а не из заголовка. Эта строка идёт в security.log,
  // а его читает fail2ban и режет адрес через ufw на сутки. Пока сюда
  // попадал `X-Forwarded-For`, любой мог тремя запросами с чужим адресом в
  // заголовке отрезать от сервера постороннего человека.
  const realIp = getClientIp(req);

  const userAgent = (req.get('User-Agent') || '').toLowerCase();
  const url = req.originalUrl.toLowerCase();

  // 1. Проверка Telegram Bot API (добавляем в Whitelist)
  // В идеале мы должны проверять IP подсетей Telegram, но пока просто пропускаем легитимный хук, если он есть
  if (userAgent.includes('telegrambot') || userAgent.includes('twitterbot')) {
    return next();
  }

  // 2. Блокировка пустых или известных вредоносных User-Agent
  const badAgents = ['masscan', 'zgrab', 'nmap', 'sqlmap', 'curl', 'wget', 'python-requests'];
  if (!userAgent || badAgents.some(agent => userAgent.includes(agent))) {
    logSecurityEvent(realIp, 'Suspicious User-Agent', req);
    return res.status(403).json({ error: 'Access denied' });
  }

  // 3. Блокировка попыток сканирования известных уязвимостей
  const badPatterns = [
    '/.env', '/wp-admin', '/phpmyadmin', '/.git', '/config.php', 
    '/admin.php', '/xmlrpc.php', 'cgi-bin', 'select%20', 'union%20select'
  ];
  if (badPatterns.some(pattern => url.includes(pattern))) {
    logSecurityEvent(realIp, 'Path Traversal / Scanner Pattern', req);
    return res.status(403).json({ error: 'Access denied' });
  }

  // 4. Проверка энтропии (например, слишком длинные query параметры, которые часто используют для DDoS)
  if (req.url.length > 512) {
    logSecurityEvent(realIp, 'High Entropy / URI Too Long', req);
    return res.status(414).json({ error: 'URI Too Long' });
  }

  // Если всё ок — пропускаем
  next();
}
