import dgram from 'dgram';
import dns from 'dns/promises';
import net from 'net';
import tls from 'tls';
import crypto from 'crypto';
import { logger } from '../utils/logger';

/**
 * Проверка живости STUN/TURN перед тем, как называть их клиенту.
 *
 * ═══ Зачем ═══
 *
 * Клиенту выдавался список из 21 адреса. Живыми из них оказались ТРИ.
 * Замер:
 *
 *   203.0.113.10:443 udp      — отвечает за 1 мс
 *   messenger.example.org:443  — отвечает (turns/tls)
 *   203.0.113.10:3479 udp+tcp — молчит: наружу этот порт не проброшен
 *   messenger.example.org:53   — молчит: на публичном стыке там никого нет
 *   openrelay.metered.ca     — домена больше не существует, четыре записи
 *   [ygg]:3479               — только для тех, у кого поднят Yggdrasil
 *
 * Мёртвый адрес в списке не бесплатный. WebRTC добросовестно пробует
 * каждый и ждёт своего таймаута, а пока он ждёт — звонок висит на
 * «Подключение…». Сверху ещё автоматика переключения ярусов со своими
 * сроками (8 с, 20 с, 40 с), и она успевает всё переиграть, пока живые
 * адреса ещё не дошли до дела. Снаружи это ровно то, на что жалуются:
 * «постоянно нестабильный коннект, подключается и падает».
 *
 * ═══ Как ═══
 *
 * Обычный STUN Binding Request — тот же, что шлёт браузер. Ответил
 * значит живой. Проверяем не чаще раза в несколько минут, результат
 * держим в памяти: список спрашивают на каждый звонок.
 *
 * Если вдруг не ответило НИЧЕГО (например, проверка сама сломалась) —
 * отдаём список как есть. Пустой список хуже плохого: без него звонки
 * не соберутся вообще.
 */

const MAGIC_COOKIE = 0x2112a442;
const PROBE_TIMEOUT_MS = 2500;
const CACHE_TTL_MS = 5 * 60 * 1000;

interface IceEntry {
  urls: string;
  username?: string;
  credential?: string;
}

interface Probed {
  alive: boolean;
  checkedAt: number;
  rttMs?: number;
  /** Имя не разрешилось — адреса просто не существует. */
  unresolvable?: boolean;
}

const cache = new Map<string, Probed>();

function bindingRequest(): { packet: Buffer; tid: Buffer } {
  const tid = crypto.randomBytes(12);
  const packet = Buffer.alloc(20);
  packet.writeUInt16BE(0x0001, 0); // Binding Request
  packet.writeUInt16BE(0, 2);      // длина тела
  packet.writeUInt32BE(MAGIC_COOKIE, 4);
  tid.copy(packet, 8);
  return { packet, tid };
}

function looksLikeStunResponse(data: Buffer, tid: Buffer): boolean {
  if (data.length < 20) return false;
  if (data.readUInt32BE(4) !== MAGIC_COOKIE) return false;
  return data.subarray(8, 20).equals(tid);
}

/** Разбираем «turn:host:port?transport=tcp» на части. */
function parseIceUrl(url: string): { scheme: string; host: string; port: number; transport: string } | null {
  const m = /^(stun|stuns|turn|turns):\[?([^\]]+?)\]?:(\d+)(\?transport=(udp|tcp))?$/i.exec(url.trim());
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const explicit = (m[5] || '').toLowerCase();
  // turns/stuns всегда поверх TLS, то есть TCP.
  const transport = explicit || (scheme === 'turns' || scheme === 'stuns' ? 'tcp' : 'udp');
  return { scheme, host: m[2], port: parseInt(m[3], 10), transport };
}

function probeUdp(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const { packet, tid } = bindingRequest();
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch { /* уже закрыт */ }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    sock.on('message', msg => finish(looksLikeStunResponse(msg, tid)));
    sock.on('error', () => finish(false));
    try {
      sock.send(packet, port, host, err => { if (err) finish(false); });
    } catch {
      finish(false);
    }
  });
}

function probeTcp(host: string, port: number, useTls: boolean): Promise<boolean> {
  return new Promise(resolve => {
    const { packet, tid } = bindingRequest();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* уже закрыт */ }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);

    // Сертификат не проверяем: нас интересует «служба на месте», а не
    // доверие к ней. Свой же сервер, и проверка идёт по кругу через NAT.
    const sock: net.Socket = useTls
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: false })
      : net.connect({ host, port });

    const onReady = () => { try { sock.write(packet); } catch { finish(false); } };
    sock.once(useTls ? 'secureConnect' : 'connect', onReady);
    sock.on('data', (d: Buffer) => finish(looksLikeStunResponse(d, tid)));
    sock.on('error', () => finish(false));
    sock.on('close', () => finish(false));
  });
}

/** Существует ли вообще такое имя. */
async function resolves(host: string): Promise<boolean> {
  if (net.isIP(host)) return true;
  try {
    await dns.lookup(host);
    return true;
  } catch {
    return false;
  }
}

async function probeOne(url: string): Promise<boolean> {
  const parsed = parseIceUrl(url);
  if (!parsed) {
    logger.debug(`[ICE] адрес не разобран, оставляю как есть: ${url}`);
    return true; // не наше дело — пусть решает клиент
  }
  const { scheme, host, port, transport } = parsed;
  const started = Date.now();

  if (!(await resolves(host))) {
    cache.set(url, { alive: false, checkedAt: Date.now(), unresolvable: true });
    return false;
  }

  const alive = transport === 'tcp'
    ? await probeTcp(host, port, scheme === 'turns' || scheme === 'stuns')
    : await probeUdp(host, port);
  cache.set(url, { alive, checkedAt: Date.now(), rttMs: Date.now() - started });
  return alive;
}

/**
 * Отфильтровать список, оставив живых.
 *
 * `keepAlways` — адреса, которые не выбрасываем ни при каких раскладах
 * (наш основной путь на 443). Если проверка ошибётся, лучше пусть
 * клиент попробует сам, чем останется вообще без relay.
 */
export async function filterAliveIceServers<T extends IceEntry>(
  servers: T[],
  keepAlways: (url: string) => boolean = () => false,
  isOurs: (url: string) => boolean = () => true,
): Promise<T[]> {
  const now = Date.now();
  const needProbe: string[] = [];

  for (const s of servers) {
    const url = typeof s.urls === 'string' ? s.urls : '';
    if (!url) continue;
    const known = cache.get(url);
    if (!known || now - known.checkedAt > CACHE_TTL_MS) needProbe.push(url);
  }

  if (needProbe.length) {
    await Promise.all([...new Set(needProbe)].map(u => probeOne(u).catch(() => false)));
  }

  const alive = servers.filter(s => {
    const url = typeof s.urls === 'string' ? s.urls : '';
    if (!url) return false;
    if (keepAlways(url)) return true;

    const known = cache.get(url);
    if (!known || known.alive) return true;

    // Несуществующее имя — приговор окончательный, чей бы адрес ни был.
    if (known.unresolvable) return false;

    // Молчание ЧУЖОГО сервера — ещё не доказательство. Мы могли не
    // достучаться из-за собственных ограничений (у нас, например, наружу
    // режется UDP, и публичные STUN отсюда не отвечают, хотя у людей
    // работают). Свои адреса — другое дело: если до своего же TURN не
    // дозвонились мы, то клиент и подавно.
    return !isOurs(url);
  });

  // Ничего не выжило — значит сломалась проверка, а не весь интернет.
  if (alive.length === 0) {
    logger.warn('[ICE] ни один адрес не ответил — отдаю список без фильтра');
    return servers;
  }

  const dropped = servers.length - alive.length;
  if (dropped > 0) {
    const deadList = servers
      .filter(s => !alive.includes(s))
      .map(s => s.urls)
      .join(', ');
    logger.debug(`[ICE] отброшено молчащих: ${dropped} (${deadList})`);
  }
  return alive;
}

/** Что известно о проверенных адресах — для админской вкладки «Сервер». */
export function getIceHealthSnapshot(): Array<{ url: string; alive: boolean; checkedAt: string; rttMs?: number }> {
  return [...cache.entries()].map(([url, v]) => ({
    url,
    alive: v.alive,
    checkedAt: new Date(v.checkedAt).toISOString(),
    rttMs: v.rttMs,
  }));
}
