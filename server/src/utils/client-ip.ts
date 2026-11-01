import type { Request } from 'express';

/**
 * Определение адреса клиента.
 *
 * Сервер слушает 443/80 САМ, никакого nginx перед ним нет. Значит
 * `X-Forwarded-For` в запросе к нам никто не ставил, кроме самого клиента,
 * и верить ему нельзя ни в одной точке, где по адресу принимается решение.
 *
 * Чем это грозило раньше (заголовок брался всюду вслепую):
 *  - ограничитель частоты обходился одной строчкой — свой ключ клиент
 *    выбирал сам и мог менять его на каждом запросе;
 *  - WAF писал подделанный адрес в security.log, который читает fail2ban с
 *    `bantime 86400` и правилом ufw «резать всё». Три запроса с чужим
 *    адресом в заголовке — и человек на сутки отрезан от сервера;
 *  - в admin_audit и в таблицу сессий попадал адрес, назначенный самим
 *    клиентом, то есть след в журнале указывал куда угодно, кроме автора;
 *  - выдача ICE-адресов решала по адресу, из своей ли ты сети.
 *
 * Поэтому: базой всегда служит адрес сокета. Заголовок учитывается
 * ТОЛЬКО когда соединение пришло с петли — там может стоять свой
 * локальный посредник, и никто снаружи туда не дотянется.
 */

/** Убирает обёртку IPv4-в-IPv6 (`::ffff:1.2.3.4`) и приводит к нижнему регистру. */
export function normalizeIp(ip: string | undefined | null): string {
  if (!ip) return '';
  return String(ip).replace(/^::ffff:/i, '').trim().toLowerCase();
}

/** Адрес, с которого реально открыто соединение. Подделать нельзя. */
export function socketIp(req: Request): string {
  return normalizeIp(req.socket?.remoteAddress);
}

/** Петля — единственное место, откуда `X-Forwarded-For` имеет смысл. */
function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.');
}

/**
 * Адрес клиента для журналов, ограничителя, аудита и выдачи ICE.
 * Всегда возвращает непустую строку.
 */
export function getClientIp(req: Request): string {
  const direct = socketIp(req);

  if (isLoopback(direct)) {
    const forwarded = req.headers['x-forwarded-for'];
    const chain = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (typeof chain === 'string' && chain.length > 0) {
      const first = normalizeIp(chain.split(',')[0]);
      if (first) return first;
    }
  }

  return direct || 'unknown';
}

/** Адрес в частной сети (или петля) — «свой» для выдачи LAN-адресов ICE. */
export function isPrivateIp(ip: string): boolean {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|::1$|fc|fd)/i.test(ip);
}
