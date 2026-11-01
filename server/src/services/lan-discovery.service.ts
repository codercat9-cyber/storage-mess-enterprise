// ─────────────────────────────────────────────────────────────────────
// Поиск сервера в локальной сети — для самохоста и аварийной связи.
//
// Свой сервер в квартире, подвале или штабе работает и без интернета, но
// телефон должен его найти: адреса в такой сети заранее никто не знает.
// Клиент (APK, десктоп) шлёт широковещательный UDP «SMESS?» на порт
// 47620, сервер отвечает JSON со своими адресами в сети.
//
// Отключить: LAN_DISCOVERY=0. Порт: LAN_DISCOVERY_PORT.
// ─────────────────────────────────────────────────────────────────────
import dgram from 'dgram';
import os from 'os';
import { logger } from '../utils/logger.js';

const PROBE = 'SMESS?';

export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

export function startLanDiscovery(opts: { https: boolean; port: number; name?: string; version?: string }): dgram.Socket | null {
  if (process.env.LAN_DISCOVERY === '0') return null;
  const port = parseInt(process.env.LAN_DISCOVERY_PORT || '47620', 10);
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('message', (msg, rinfo) => {
    if (msg.toString('utf8').trim() !== PROBE) return;
    const scheme = opts.https ? 'https' : 'http';
    const reply = JSON.stringify({
      app: 'STORAGE&MESS',
      name: opts.name || os.hostname(),
      version: opts.version || '',
      urls: lanAddresses().map(ip => `${scheme}://${ip}${(opts.https && opts.port === 443) || (!opts.https && opts.port === 80) ? '' : ':' + opts.port}`),
    });
    sock.send(reply, rinfo.port, rinfo.address);
  });
  sock.on('error', err => logger.warn(`   ⚠ Поиск в локальной сети (UDP ${port}) не запущен: ${err.message}`));
  sock.bind(port, '0.0.0.0', () => logger.info(`   📡 Поиск в локальной сети: UDP ${port} (${lanAddresses().join(', ') || 'нет адресов'})`));
  return sock;
}
