// =============================================================================
// Корпоративный контур — проверка входа через RADIUS (NPS, FreeRADIUS, OTP).
//
// Access-Request с PAP. В запрос всегда кладём Message-Authenticator и
// ТРЕБУЕМ его в ответе: без этого ответ можно подделать (Blast-RADIUS,
// CVE-2024-3596) — MD5 в классическом Response Authenticator подделывается.
// Ответ без него, с чужим идентификатором или не сходящийся по подписи
// считаем подделкой и молча ждём настоящий до конца таймаута.
// =============================================================================

import dgram from 'dgram';
import crypto from 'crypto';
// @ts-ignore — у пакета radius нет описаний типов
import radius from 'radius';
import { entConfig } from './config.js';
import { logger } from '../utils/logger.js';

export type RadiusResult =
  | { ok: true }
  | { ok: false; unavailable: false; message: string | null }
  | { ok: false; unavailable: true; message: string };

let nextId = crypto.randomInt(0, 256);

export function radiusAuthenticate(username: string, password: string): Promise<RadiusResult> {
  const { host, port, secret, timeoutMs, nasIdentifier } = entConfig.radius;
  if (!secret) return Promise.resolve({ ok: false, unavailable: true, message: 'не задан ENT_RADIUS_SECRET' });
  // PAP: пароль не длиннее 128 байт (RFC 2865, 5.2)
  if (!password || Buffer.byteLength(password, 'utf8') > 128) {
    return Promise.resolve({ ok: false, unavailable: false, message: null });
  }

  const identifier = nextId;
  nextId = (nextId + 1) % 256;

  let packet: Buffer;
  try {
    packet = radius.encode({
      code: 'Access-Request',
      secret,
      identifier,
      add_message_authenticator: true,
      attributes: [
        ['User-Name', username],
        ['User-Password', password],
        ['NAS-Identifier', nasIdentifier],
        ['Service-Type', 'Login-User'],
      ],
    });
  } catch (e) {
    logger.error('RADIUS: не удалось собрать запрос', (e as Error).message);
    return Promise.resolve({ ok: false, unavailable: true, message: 'ошибка сборки запроса RADIUS' });
  }

  return new Promise(resolve => {
    const family = host.includes(':') ? 'udp6' : 'udp4';
    const sock = dgram.createSocket(family);
    let done = false;
    const timers: NodeJS.Timeout[] = [];
    const finish = (r: RadiusResult) => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      try { sock.close(); } catch { /* уже закрыт */ }
      resolve(r);
    };

    sock.on('error', err => finish({ ok: false, unavailable: true, message: `RADIUS: ${err.message}` }));
    sock.on('message', (msg: Buffer) => {
      // Ответ обязан прийти именно на наш запрос
      if (msg.length < 20 || msg[1] !== identifier) return;
      let valid = false;
      try {
        valid = radius.verify_response({ request: packet, response: Buffer.from(msg), secret }) === true;
      } catch {
        valid = false;
      }
      if (!valid) {
        logger.warn('RADIUS: ответ с неверной подписью или без Message-Authenticator — отброшен');
        return;
      }
      let decoded: any;
      try {
        decoded = radius.decode({ packet: msg, secret });
      } catch {
        return;
      }
      const reply = decoded?.attributes?.['Reply-Message'];
      const text = reply === undefined ? null : String(Array.isArray(reply) ? reply[0] : reply).slice(0, 200);
      if (decoded.code === 'Access-Accept') finish({ ok: true });
      else if (decoded.code === 'Access-Reject') finish({ ok: false, unavailable: false, message: text });
      else if (decoded.code === 'Access-Challenge') {
        // Двухшаговый OTP (challenge) этот клиент не ведёт — честно отказываем
        finish({ ok: false, unavailable: false, message: 'RADIUS запросил дополнительный код — такой режим не поддержан' });
      }
    });

    const send = () => {
      if (done) return;
      sock.send(packet, port, host, err => {
        if (err) finish({ ok: false, unavailable: true, message: `RADIUS: ${err.message}` });
      });
    };
    // Один повтор на половине срока: UDP теряется
    send();
    timers.push(setTimeout(send, Math.floor(timeoutMs / 2)));
    timers.push(setTimeout(() => finish({ ok: false, unavailable: true, message: 'RADIUS не ответил вовремя' }), timeoutMs));
  });
}
