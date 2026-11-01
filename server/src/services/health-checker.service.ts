/**
 * ═══════════════════════════════════════════════════════════════
 *  Health Checker — Мониторинг здоровья сервера каждые 35 сек
 * ═══════════════════════════════════════════════════════════════
 *
 *  Отображает в консоли:
 *  - Состояние сети (подключения, latency)
 *  - Здоровье сервера (CPU, RAM, uptime)
 *  - Задержки TLS handshake
 *  - Задержки доставки сообщений
 *  - Обнаружение DPI-атак (ТСПУ / подозрительные паттерны)
 */

import os from 'os';
import fs from 'fs';
import { logger } from '../utils/logger.js';
import { onDPIAlert, getDPIProtectionStatus } from './dpi-protection.service.js';

const CHECK_INTERVAL = 35_000; // 35 секунд
const DPI_WINDOW = 60_000; // окно для анализа DPI — 1 минута

interface HealthMetrics {
  // Сеть
  activeConnections: number;
  socketClients: number;
  // Bandwidth
  rxBytesPerSec: number;
  txBytesPerSec: number;
  // Сервер
  cpuUsage: number;
  memUsed: number;
  memTotal: number;
  memPercent: number;
  uptime: number;
  // TLS
  tlsHandshakeAvg: number;
  tlsHandshakeMax: number;
  tlsHandshakeCount: number;
  // Сообщения
  msgLatencyAvg: number;
  msgLatencyMax: number;
  msgCount: number;
  // DPI
  dpiSuspicious: boolean;
  dpiReasons: string[];
}

// Трекеры
const tlsHandshakes: number[] = []; // ms
const msgLatencies: number[] = []; // ms
const connectionResets: { ts: number }[] = [];
// Сбросы ДО того, как рукопожатие состоялось, — и успешные рукопожатия.
//
// Разделять их обязательно: обрыв установленного соединения и обрыв на
// подступах к нему означают совершенно разное. См. detectDPI ниже.
const earlyResets: { ts: number }[] = [];
const handshakeOks: { ts: number }[] = [];
const tlsErrors: { ts: number; code: string }[] = [];
const suspiciousPatterns: { ts: number; reason: string }[] = [];

let ioInstance: any = null;
let httpServerInstance: any = null;
let lastCpuUsage = process.cpuUsage();
let lastCpuTime = Date.now();

// ── Network bandwidth tracking (via /proc/net/dev on Linux) ──
interface NetSnapshot { rx: number; tx: number; ts: number; }
let lastNetSnapshot: NetSnapshot | null = null;

function readNetBytes(): { rx: number; tx: number } | null {
  try {
    const data = fs.readFileSync('/proc/net/dev', 'utf-8');
    let totalRx = 0, totalTx = 0;
    for (const line of data.split('\n').slice(2)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 10) continue;
      const iface = parts[0].replace(':', '');
      if (iface === 'lo') continue; // skip loopback
      totalRx += parseInt(parts[1], 10) || 0;
      totalTx += parseInt(parts[9], 10) || 0;
    }
    return { rx: totalRx, tx: totalTx };
  } catch {
    return null;
  }
}

function getNetSpeed(): { rxPerSec: number; txPerSec: number } {
  const now = Date.now();
  const current = readNetBytes();
  if (!current) return { rxPerSec: 0, txPerSec: 0 };
  if (!lastNetSnapshot) {
    lastNetSnapshot = { ...current, ts: now };
    return { rxPerSec: 0, txPerSec: 0 };
  }
  const elapsed = (now - lastNetSnapshot.ts) / 1000;
  if (elapsed < 1) return { rxPerSec: 0, txPerSec: 0 };
  const rxPerSec = Math.max(0, (current.rx - lastNetSnapshot.rx) / elapsed);
  const txPerSec = Math.max(0, (current.tx - lastNetSnapshot.tx) / elapsed);
  lastNetSnapshot = { ...current, ts: now };
  return { rxPerSec, txPerSec };
}

/**
 * Трекинг TLS handshake latency
 */
export function trackTlsHandshake(durationMs: number): void {
  tlsHandshakes.push(durationMs);
  // Держим последние 100
  if (tlsHandshakes.length > 100) tlsHandshakes.shift();

  // Отмечаем сам факт: рукопожатие состоялось. Нужно, чтобы судить о
  // сбросах не по их числу, а по доле от всех соединений.
  const now = Date.now();
  handshakeOks.push({ ts: now });
  const cutoff = now - 300_000;
  while (handshakeOks.length > 0 && handshakeOks[0].ts < cutoff) handshakeOks.shift();
}

/**
 * Трекинг latency доставки сообщения
 */
export function trackMessageLatency(durationMs: number): void {
  msgLatencies.push(durationMs);
  if (msgLatencies.length > 200) msgLatencies.shift();
}

/**
 * Трекинг сброса соединения (RST) — признак DPI
 */
export function trackConnectionReset(code?: string, established = false): void {
  const now = Date.now();
  connectionResets.push({ ts: now });
  if (code) tlsErrors.push({ ts: now, code });

  // Сброс на УЖЕ РАБОТАВШЕМ соединении — это обычная жизнь, а не нападение:
  // телефон ушёл в фон, плеер переключил трек и бросил недокачанное, вкладку
  // закрыли. Такие обрывы копим отдельно и на тревогу ими не влияем.
  if (!established) earlyResets.push({ ts: now });

  // Чистим старше 5 минут
  const cutoff = now - 300_000;
  while (connectionResets.length > 0 && connectionResets[0].ts < cutoff) connectionResets.shift();
  while (earlyResets.length > 0 && earlyResets[0].ts < cutoff) earlyResets.shift();
  while (tlsErrors.length > 0 && tlsErrors[0].ts < cutoff) tlsErrors.shift();
}

/**
 * Трекинг подозрительных паттернов (SNI probing, certificate replay, etc)
 */
export function trackSuspiciousPattern(reason: string): void {
  const now = Date.now();
  suspiciousPatterns.push({ ts: now, reason });
  while (suspiciousPatterns.length > 0 && suspiciousPatterns[0].ts < now - 300_000) suspiciousPatterns.shift();
}

/**
 * Анализ DPI/ТСПУ атак
 */
function detectDPI(): { suspicious: boolean; reasons: string[] } {
  const now = Date.now();
  const windowStart = now - DPI_WINDOW;
  const reasons: string[] = [];

  // 1. Обрывы НА ПОДСТУПАХ к соединению.
  //
  // Раньше здесь считались все сбросы подряд, и сотня за минуту объявлялась
  // нападением. Набиралась она сама собой: телефон уходит в фон, плеер
  // бросает недокачанный трек, человек листает ленту с картинками. Каждый
  // разбор музыки для вибрации исправно доводил счётчик до порога — и
  // сервер объявлял атаку ТСПУ, поднимал защиту до предела, правил iptables
  // и двенадцать параметров сетевого стека. То есть в ответ на собственных
  // же пользователей менял всем условия связи, отчего рвались следующие
  // соединения — и тревога подтверждала сама себя.
  //
  // Нападение выглядит иначе: посредник бьёт по соединению ДО того, как оно
  // встанет, — рукопожатие не доходит до конца. Установившиеся и
  // отработавшие соединения он рвать уже не может, не выдав себя. Поэтому
  // считаем только ранние обрывы.
  const recentEarly = earlyResets.filter(r => r.ts > windowStart).length;
  const recentOk = handshakeOks.filter(h => h.ts > windowStart).length;

  // Смотрим не на голое число, а на долю: сотня обрывов при тысяче удачных
  // соединений — обычный шум большого дома, сотня при десяти удачных —
  // настоящая беда. Нижняя граница нужна, чтобы ночная тишина, где всего
  // пара соединений, не давала тревогу на ровном месте.
  const total = recentEarly + recentOk;
  const earlyShare = total > 0 ? recentEarly / total : 0;
  if (recentEarly >= 40 && earlyShare > 0.5) {
    reasons.push(`обрывы до установки связи: ${recentEarly} из ${total} попыток за минуту`);
  }

  // 2. TLS ошибки, характерные именно для посредника: он подсовывает свой
  // сертификат или обрывает рукопожатие. ECONNRESET и EPIPE отсюда убраны —
  // это обычное «клиент ушёл», и на них держалась вторая половина ложных
  // тревог: числа 112 и 112, 244 и 244 в журнале совпадали не случайно,
  // один и тот же обрыв считался дважды.
  const recentTlsErrors = tlsErrors.filter(e => e.ts > windowStart);
  const errorCodes = recentTlsErrors.map(e => e.code);
  const dpiCodes = [
    'ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN',
    'ERR_SSL_HANDSHAKE_FAILURE',
    'ERR_SSL_WRONG_VERSION_NUMBER',
    'ERR_SSL_UNKNOWN_PROTOCOL',
    'ERR_SSL_DECRYPT_ERROR',
    'TLS_CLIENT_ERROR',
  ];
  const dpiErrorCount = errorCodes.filter(c => dpiCodes.some(dc => c.includes(dc))).length;
  if (dpiErrorCount > 60) {
    reasons.push(`ТСПУ по TLS: ${dpiErrorCount} испорченных рукопожатий за минуту`);
  }

  // 3. Подозрительные паттерны
  const recentPatterns = suspiciousPatterns.filter(p => p.ts > windowStart);
  if (recentPatterns.length > 0) {
    const unique = [...new Set(recentPatterns.map(p => p.reason))];
    reasons.push(...unique.map(r => `Pattern: ${r}`));
  }

  // 4. Аномальная latency TLS (ТСПУ вставляет задержки)
  if (tlsHandshakes.length >= 5) {
    const avg = tlsHandshakes.reduce((a, b) => a + b, 0) / tlsHandshakes.length;
    if (avg > 2000) {
      reasons.push(`TLS latency аномалия: avg ${avg.toFixed(0)}ms (ТСПУ injection?)`);
    }
  }

  return { suspicious: reasons.length > 0, reasons };
}

/**
 * Получить CPU usage в процентах
 */
function getCpuPercent(): number {
  const now = Date.now();
  const elapsed = now - lastCpuTime;
  if (elapsed < 100) return 0;

  const currentUsage = process.cpuUsage(lastCpuUsage);
  lastCpuUsage = process.cpuUsage();
  lastCpuTime = now;

  const totalMicros = (currentUsage.user + currentUsage.system);
  const elapsedMicros = elapsed * 1000;
  return Math.min(100, (totalMicros / elapsedMicros) * 100);
}

/**
 * Собрать все метрики
 */
function collectMetrics(): HealthMetrics {
  const mem = process.memoryUsage();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  const activeConnections = httpServerInstance?._connections || 0;
  const socketClients = ioInstance?.engine?.clientsCount || 0;

  // TLS stats
  const tlsAvg = tlsHandshakes.length > 0
    ? tlsHandshakes.reduce((a, b) => a + b, 0) / tlsHandshakes.length
    : 0;
  const tlsMax = tlsHandshakes.length > 0
    ? Math.max(...tlsHandshakes)
    : 0;

  // Message latency
  const msgAvg = msgLatencies.length > 0
    ? msgLatencies.reduce((a, b) => a + b, 0) / msgLatencies.length
    : 0;
  const msgMax = msgLatencies.length > 0
    ? Math.max(...msgLatencies)
    : 0;

  // Network bandwidth
  const net = getNetSpeed();

  // DPI
  const dpi = detectDPI();

  return {
    activeConnections,
    socketClients,
    rxBytesPerSec: net.rxPerSec,
    txBytesPerSec: net.txPerSec,
    cpuUsage: getCpuPercent(),
    memUsed: mem.rss,
    memTotal: totalMem,
    memPercent: (mem.rss / totalMem) * 100,
    uptime: process.uptime(),
    tlsHandshakeAvg: tlsAvg,
    tlsHandshakeMax: tlsMax,
    tlsHandshakeCount: tlsHandshakes.length,
    msgLatencyAvg: msgAvg,
    msgLatencyMax: msgMax,
    msgCount: msgLatencies.length,
    dpiSuspicious: dpi.suspicious,
    dpiReasons: dpi.reasons,
  };
}

/**
 * Форматирование размера
 */
function fmtMB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1) + 'MB';
}

function fmtSpeed(bytesPerSec: number): string {
  if (bytesPerSec >= 1024 * 1024) return (bytesPerSec / 1024 / 1024).toFixed(1) + ' MB/s';
  if (bytesPerSec >= 1024) return (bytesPerSec / 1024).toFixed(1) + ' KB/s';
  return Math.round(bytesPerSec) + ' B/s';
}

function fmtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

/**
 * Вывод в консоль
 */
function printHealthReport(): void {
  const m = collectMetrics();
  const line = '─'.repeat(58);
  const now = new Date().toLocaleTimeString('ru-RU');

  const statusIcon = m.dpiSuspicious ? '🔴' : '🟢';
  const memIcon = m.memPercent > 80 ? '🟡' : '🟢';
  const tlsIcon = m.tlsHandshakeAvg > 1000 ? '🟡' : m.tlsHandshakeAvg > 2000 ? '🔴' : '🟢';
  const msgIcon = m.msgLatencyAvg > 500 ? '🟡' : m.msgLatencyAvg > 2000 ? '🔴' : '🟢';

  console.log(`\n${line}`);
  console.log(`${statusIcon} HEALTH CHECK  ${now}  uptime: ${fmtTime(m.uptime)}`);
  console.log(`${line}`);
  console.log(`  🌐 Сеть:     connections: ${m.activeConnections}  ws-clients: ${m.socketClients}`);
  console.log(`  📥 Вход:     ${fmtSpeed(m.rxBytesPerSec)}`);
  console.log(`  📤 Исход:    ${fmtSpeed(m.txBytesPerSec)}`);
  console.log(`  ${memIcon} Память:   RSS: ${fmtMB(m.memUsed)}  system: ${fmtMB(m.memTotal)}  (${m.memPercent.toFixed(1)}%)`);
  console.log(`  💻 CPU:      ${m.cpuUsage.toFixed(1)}%`);
  console.log(`  ${tlsIcon} TLS:      avg: ${m.tlsHandshakeAvg.toFixed(0)}ms  max: ${m.tlsHandshakeMax.toFixed(0)}ms  (${m.tlsHandshakeCount} handshakes)`);
  console.log(`  ${msgIcon} Сообщ:   avg: ${m.msgLatencyAvg.toFixed(0)}ms  max: ${m.msgLatencyMax.toFixed(0)}ms  (${m.msgCount} msgs)`);

  if (m.dpiSuspicious) {
    console.log(`  🔴 DPI/ТСПУ ОБНАРУЖЕН:`);
    for (const reason of m.dpiReasons) {
      console.log(`     ⚠ ${reason}`);
    }
    // Автоматическая эскалация DPI защиты
    onDPIAlert(m.dpiReasons);
    console.log(`  🛡️  Защита:   ${getDPIProtectionStatus()}`);
  } else {
    console.log(`  🛡️  DPI:      чисто | защита: ${getDPIProtectionStatus()}`);
  }

  // Предупреждения
  if (m.tlsHandshakeAvg > 1000) {
    logger.warn(`[HealthCheck] Высокая TLS latency: avg ${m.tlsHandshakeAvg.toFixed(0)}ms`);
  }
  if (m.msgLatencyAvg > 1000) {
    logger.warn(`[HealthCheck] Высокая задержка сообщений: avg ${m.msgLatencyAvg.toFixed(0)}ms`);
  }
  if (m.dpiSuspicious) {
    logger.warn(`[HealthCheck] DPI/ТСПУ alert: ${m.dpiReasons.join('; ')}`);
  }

  console.log(line);
}

/**
 * Инициализация Health Checker
 */
export function initHealthChecker(io: any, httpServer: any): void {
  ioInstance = io;
  httpServerInstance = httpServer;

  // Запускаем периодический отчёт
  setInterval(printHealthReport, CHECK_INTERVAL);

  logger.info('📊 Health Checker запущен (интервал: 35 сек)');
  
  // Первый отчёт через 5 секунд после старта
  setTimeout(printHealthReport, 5000);
}
