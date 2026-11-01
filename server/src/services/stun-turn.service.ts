/**
 * ============================================================
 *  Локальный STUN + TURN сервер (RFC 5389 / RFC 5766)
 * ============================================================
 * 
 * Встроенный в storage-messenger сервер, написан на чистом
 * Node.js (dgram) — без внешних зависимостей.
 * 
 * STUN: обрабатывает Binding Request → Binding Response
 *       (сообщает клиенту его внешний IP:port)
 * 
 * TURN: обрабатывает Allocate, CreatePermission, Send/Data,
 *       ChannelBind — ретранслирует UDP-трафик через сервер.
 *       Нужен для VPN/symmetric NAT где P2P невозможен.
 * 
 * Используется как fallback если Google STUN серверы недоступны.
 */

import dgram from 'dgram';
import net from 'net';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';

// ============================================================
// Константы STUN (RFC 5389)
// ============================================================
const STUN_MAGIC_COOKIE = 0x2112A442;
const STUN_HEADER_SIZE = 20;

// Message types
const STUN_BINDING_REQUEST              = 0x0001;
const STUN_BINDING_RESPONSE             = 0x0101;
const STUN_BINDING_ERROR_RESPONSE       = 0x0111;

// TURN message types (RFC 5766)
const TURN_ALLOCATE_REQUEST             = 0x0003;
const TURN_ALLOCATE_RESPONSE            = 0x0103;
const TURN_ALLOCATE_ERROR_RESPONSE      = 0x0113;
const TURN_REFRESH_REQUEST              = 0x0004;
const TURN_REFRESH_RESPONSE             = 0x0104;
const TURN_CREATE_PERMISSION_REQUEST    = 0x0008;
const TURN_CREATE_PERMISSION_RESPONSE   = 0x0108;
const TURN_CHANNEL_BIND_REQUEST         = 0x0009;
const TURN_CHANNEL_BIND_RESPONSE        = 0x0109;
const TURN_SEND_INDICATION              = 0x0016;
const TURN_DATA_INDICATION              = 0x0017;

// Attribute types
const ATTR_MAPPED_ADDRESS               = 0x0001;
const ATTR_USERNAME                     = 0x0006;
const ATTR_MESSAGE_INTEGRITY            = 0x0008;
const ATTR_ERROR_CODE                   = 0x0009;
const ATTR_UNKNOWN_ATTRIBUTES           = 0x000A;
const ATTR_REALM                        = 0x0014;
const ATTR_NONCE                        = 0x0015;
const ATTR_XOR_MAPPED_ADDRESS           = 0x0020;
const ATTR_SOFTWARE                     = 0x8022;
const ATTR_FINGERPRINT                  = 0x8028;

// TURN attributes
const ATTR_CHANNEL_NUMBER               = 0x000C;
const ATTR_LIFETIME                     = 0x000D;
const ATTR_XOR_PEER_ADDRESS             = 0x0012;
const ATTR_DATA                         = 0x0013;
const ATTR_XOR_RELAYED_ADDRESS          = 0x0016;
const ATTR_REQUESTED_TRANSPORT          = 0x0019;

const SOFTWARE_NAME = 'StorageMess/1.0';
const DEFAULT_LIFETIME = 600; // 10 минут
const MAX_LIFETIME = 3600; // 1 час

// ============================================================
// TURN Allocation state
// ============================================================
interface TurnAllocation {
  clientAddr: string;
  clientPort: number;
  relaySocket: dgram.Socket;
  serverSocket: dgram.Socket; // UDP сокет через который клиент подключён
  relayPort: number;
  username: string;
  authKey: Buffer | null; // HMAC key for MESSAGE-INTEGRITY
  lifetime: number;
  createdAt: number;
  expiresAt: number;
  permissions: Map<string, number>; // peerIP -> expiresAt
  channels: Map<number, { peerAddr: string; peerPort: number; expiresAt: number }>;
  reverseChannels: Map<string, number>; // "ip:port" -> channelNumber
}

// Allocations indexed by "clientIP:clientPort"
const allocations = new Map<string, TurnAllocation>();

// Anti-Spam state (Rate Limiting)
const stunRateLimits = new Map<string, { count: number, resetAt: number, bannedUntil: number }>();

// TURN credentials
let turnUsername = '';
let turnPassword = '';
let turnRealm = 'smess';

// Порты для relay (диапазоны 50000-50100 и 50101-50345 проброшены на роутере)
let relayPortMin = 50000;
let relayPortMax = 50345;
let nextRelayPort = 50000;

// ============================================================
// Утилиты
// ============================================================

function allocationKey(addr: string, port: number): string {
  return `${addr}:${port}`;
}

function padTo4(len: number): number {
  return (4 - (len % 4)) % 4;
}

// ============================================================
// MESSAGE-INTEGRITY (RFC 5389 §15.4) — REQUIRED для TURN auth
// Без этого Chrome/Firefox отклоняют TURN Allocate Response!
// ============================================================

/**
 * Ключ для long-term credentials: MD5(username:realm:password)
 */
function computeTurnKey(username: string, realm: string, password: string): Buffer {
  return crypto.createHash('md5').update(`${username}:${realm}:${password}`).digest();
}

/**
 * Найти смещение атрибута в STUN-сообщении
 */
function findAttrOffset(msg: Buffer, attrType: number): number {
  if (msg.length < STUN_HEADER_SIZE) return -1;
  const msgLen = msg.readUInt16BE(2);
  const end = Math.min(STUN_HEADER_SIZE + msgLen, msg.length);
  let offset = STUN_HEADER_SIZE;
  while (offset + 4 <= end) {
    const type = msg.readUInt16BE(offset);
    const len = msg.readUInt16BE(offset + 2);
    if (type === attrType) return offset;
    offset += 4 + len + padTo4(len);
  }
  return -1;
}

/**
 * Проверка MESSAGE-INTEGRITY входящего сообщения
 */
function validateMessageIntegrity(msg: Buffer, key: Buffer): boolean {
  const miOffset = findAttrOffset(msg, ATTR_MESSAGE_INTEGRITY);
  if (miOffset < 0 || miOffset + 24 > msg.length) return false;

  const miValue = msg.subarray(miOffset + 4, miOffset + 4 + 20);

  // Для HMAC: берём всё до MI, но длину в заголовке ставим как будто сообщение
  // заканчивается на MI (header value = miOffset - 20 + 24 = miOffset + 4)
  const adjusted = Buffer.from(msg.subarray(0, miOffset));
  adjusted.writeUInt16BE(miOffset + 4, 2);

  const expected = crypto.createHmac('sha1', key).update(adjusted).digest();
  return crypto.timingSafeEqual(expected, miValue);
}

/**
 * Добавить MESSAGE-INTEGRITY к исходящему STUN-ответу
 */
function addMessageIntegrity(response: Buffer, key: Buffer): Buffer {
  const MI_ATTR_TOTAL = 24; // 4 byte header + 20 byte HMAC-SHA1

  // Для вычисления HMAC: временно увеличиваем length на размер MI-атрибута
  const tempMsg = Buffer.from(response);
  const origLen = tempMsg.readUInt16BE(2);
  tempMsg.writeUInt16BE(origLen + MI_ATTR_TOTAL, 2);

  const hmac = crypto.createHmac('sha1', key).update(tempMsg).digest();

  // Собираем MI-атрибут
  const miAttr = Buffer.alloc(MI_ATTR_TOTAL);
  miAttr.writeUInt16BE(ATTR_MESSAGE_INTEGRITY, 0);
  miAttr.writeUInt16BE(20, 2);
  hmac.copy(miAttr, 4);

  // Итоговое сообщение с обновлённой длиной
  const final = Buffer.concat([response, miAttr]);
  final.writeUInt16BE(origLen + MI_ATTR_TOTAL, 2);
  return final;
}

/**
 * Аутентификация TURN-запроса (long-term credentials)
 * Возвращает null если отправлен 401 (caller должен return)
 */
function authenticateTurnRequest(
  msg: Buffer,
  attrs: Map<number, Buffer>,
  txnId: Buffer,
  rinfo: dgram.RemoteInfo,
  server: dgram.Socket,
  errorResponseType: number,
): { key: Buffer; username: string } | null {
  if (!turnUsername || !turnPassword) {
    // Нет настроенных credentials — пропускаем auth
    return { key: Buffer.alloc(0), username: '' };
  }

  const usernameAttr = attrs.get(ATTR_USERNAME);
  if (!usernameAttr) {
    // Первый запрос без credentials → 401 + REALM + NONCE
    const nonce = crypto.randomBytes(16).toString('hex');
    const errAttrs: Buffer[] = [
      encodeAttribute(ATTR_ERROR_CODE, encodeErrorCode(401, 'Unauthorized')),
      encodeAttribute(ATTR_REALM, Buffer.from(turnRealm)),
      encodeAttribute(ATTR_NONCE, Buffer.from(nonce)),
    ];
    server.send(buildStunMessage(errorResponseType, txnId, errAttrs), rinfo.port, rinfo.address);
    return null;
  }

  const username = usernameAttr.toString('utf-8');
  const key = computeTurnKey(username, turnRealm, turnPassword);

  // Валидация MESSAGE-INTEGRITY
  if (attrs.has(ATTR_MESSAGE_INTEGRITY)) {
    if (!validateMessageIntegrity(msg, key)) {
      logger.warn(`TURN: Bad MESSAGE-INTEGRITY from ${rinfo.address}:${rinfo.port} user=${username}`);
      const errAttrs: Buffer[] = [
        encodeAttribute(ATTR_ERROR_CODE, encodeErrorCode(401, 'Unauthorized')),
        encodeAttribute(ATTR_REALM, Buffer.from(turnRealm)),
        encodeAttribute(ATTR_NONCE, Buffer.from(crypto.randomBytes(16).toString('hex'))),
      ];
      server.send(buildStunMessage(errorResponseType, txnId, errAttrs), rinfo.port, rinfo.address);
      return null;
    }
  }

  return { key, username };
}

function encodeAttribute(type: number, value: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(value.length, 2);
  const padding = Buffer.alloc(padTo4(value.length));
  return Buffer.concat([header, value, padding]);
}

function parseAttributes(buf: Buffer, offset: number, end: number): Map<number, Buffer> {
  const attrs = new Map<number, Buffer>();
  while (offset + 4 <= end) {
    const type = buf.readUInt16BE(offset);
    const len = buf.readUInt16BE(offset + 2);
    offset += 4;
    if (offset + len > end) break;
    attrs.set(type, buf.subarray(offset, offset + len));
    offset += len + padTo4(len);
  }
  return attrs;
}

function encodeXorMappedAddress(ip: string, port: number, txnId: Buffer): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeUInt8(0, 0); // reserved
  buf.writeUInt8(0x01, 1); // family: IPv4
  buf.writeUInt16BE(port ^ (STUN_MAGIC_COOKIE >>> 16), 2);
  const ipParts = ip.split('.').map(Number);
  const ipInt = ((ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3]) >>> 0;
  buf.writeUInt32BE((ipInt ^ STUN_MAGIC_COOKIE) >>> 0, 4);
  return buf;
}

function decodeXorPeerAddress(buf: Buffer, txnId: Buffer): { ip: string; port: number } | null {
  if (buf.length < 8) return null;
  const family = buf.readUInt8(1);
  if (family !== 0x01) return null; // only IPv4
  const port = buf.readUInt16BE(2) ^ (STUN_MAGIC_COOKIE >>> 16);
  const ipXor = buf.readUInt32BE(4);
  const ipInt = ipXor ^ STUN_MAGIC_COOKIE;
  const ip = `${(ipInt >>> 24) & 0xFF}.${(ipInt >>> 16) & 0xFF}.${(ipInt >>> 8) & 0xFF}.${ipInt & 0xFF}`;
  return { ip, port };
}

function encodeMappedAddress(ip: string, port: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeUInt8(0, 0);
  buf.writeUInt8(0x01, 1); // IPv4
  buf.writeUInt16BE(port, 2);
  const parts = ip.split('.').map(Number);
  buf.writeUInt32BE(((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0, 4);
  return buf;
}

function encodeErrorCode(code: number, reason: string): Buffer {
  const reasonBuf = Buffer.from(reason, 'utf-8');
  const buf = Buffer.alloc(4 + reasonBuf.length);
  buf.writeUInt16BE(0, 0); // reserved
  buf.writeUInt8(Math.floor(code / 100), 2); // class
  buf.writeUInt8(code % 100, 3); // number
  reasonBuf.copy(buf, 4);
  return buf;
}

function buildStunMessage(type: number, txnId: Buffer, attributes: Buffer[]): Buffer {
  const payload = Buffer.concat(attributes);
  const header = Buffer.alloc(STUN_HEADER_SIZE);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(payload.length, 2);
  header.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  txnId.copy(header, 8);
  return Buffer.concat([header, payload]);
}

function getNextRelayPort(): number {
  const port = nextRelayPort;
  nextRelayPort++;
  if (nextRelayPort > relayPortMax) nextRelayPort = relayPortMin;
  return port;
}

// ============================================================
// STUN Binding Request handler
// ============================================================
function handleBindingRequest(
  msg: Buffer,
  txnId: Buffer,
  rinfo: dgram.RemoteInfo,
  server: dgram.Socket,
): void {
  const attrs: Buffer[] = [];

  // XOR-MAPPED-ADDRESS
  attrs.push(encodeAttribute(ATTR_XOR_MAPPED_ADDRESS, encodeXorMappedAddress(rinfo.address, rinfo.port, txnId)));

  // MAPPED-ADDRESS (legacy)
  attrs.push(encodeAttribute(ATTR_MAPPED_ADDRESS, encodeMappedAddress(rinfo.address, rinfo.port)));

  // SOFTWARE
  attrs.push(encodeAttribute(ATTR_SOFTWARE, Buffer.from(SOFTWARE_NAME)));

  const response = buildStunMessage(STUN_BINDING_RESPONSE, txnId, attrs);
  server.send(response, rinfo.port, rinfo.address);
  // Log at debug level to avoid spamming the console
  logger.debug(`📡 STUN Binding: ${rinfo.address}:${rinfo.port} → mapped OK`);
}

// ============================================================
// TURN Allocate Request handler
// ============================================================
function handleAllocateRequest(
  msg: Buffer,
  txnId: Buffer,
  attrs: Map<number, Buffer>,
  rinfo: dgram.RemoteInfo,
  server: dgram.Socket,
  announcedIp: string,
): void {
  const key = allocationKey(rinfo.address, rinfo.port);

  // Check if allocation already exists
  if (allocations.has(key)) {
    const existing = allocations.get(key)!;
    if (existing.expiresAt > Date.now()) {
      // Return existing allocation
      sendAllocateResponse(existing, txnId, rinfo, server, announcedIp);
      return;
    }
    // Expired — clean up
    cleanupAllocation(key);
  }

  // Long-term credentials auth (RFC 5389 §10.2)
  const authResult = authenticateTurnRequest(msg, attrs, txnId, rinfo, server, TURN_ALLOCATE_ERROR_RESPONSE);
  if (!authResult) return; // 401 уже отправлен
  const authKey = authResult.key;

  // Create relay socket
  const relaySocket = dgram.createSocket('udp4');
  const relayPort = getNextRelayPort();

  try {
    relaySocket.bind(relayPort, '0.0.0.0');
  } catch (e) {
    logger.warn(`TURN: Cannot bind relay port ${relayPort}: ${e}`);
    const errAttrs: Buffer[] = [];
    errAttrs.push(encodeAttribute(ATTR_ERROR_CODE, encodeErrorCode(508, 'Insufficient Capacity')));
    const resp = buildStunMessage(TURN_ALLOCATE_ERROR_RESPONSE, txnId, errAttrs);
    server.send(resp, rinfo.port, rinfo.address);
    return;
  }

  const lifetime = DEFAULT_LIFETIME;
  const alloc: TurnAllocation = {
    clientAddr: rinfo.address,
    clientPort: rinfo.port,
    relaySocket,
    serverSocket: server,
    relayPort,
    username: authResult.username || attrs.get(ATTR_USERNAME)?.toString('utf-8') || '',
    authKey: authKey.length > 0 ? authKey : null,
    lifetime,
    createdAt: Date.now(),
    expiresAt: Date.now() + lifetime * 1000,
    permissions: new Map(),
    channels: new Map(),
    reverseChannels: new Map(),
  };

  // Handle incoming data on relay socket (from peers)
  relaySocket.on('message', (data, peerInfo) => {
    const peerKey = `${peerInfo.address}:${peerInfo.port}`;

    // Check if peer has permission
    if (!alloc.permissions.has(peerInfo.address)) {
      logger.info(`📡 TURN: Relay :${alloc.relayPort} DROPPED data from ${peerKey} (no permission, have: [${Array.from(alloc.permissions.keys()).join(', ')}])`);
      return;
    }

    // Check if there's a channel binding
    const channelNum = alloc.reverseChannels.get(peerKey);
    if (channelNum !== undefined) {
      // Send as ChannelData
      const channelData = Buffer.alloc(4 + data.length + padTo4(data.length));
      channelData.writeUInt16BE(channelNum, 0);
      channelData.writeUInt16BE(data.length, 2);
      data.copy(channelData, 4);
      server.send(channelData, alloc.clientPort, alloc.clientAddr);
    } else {
      // Send as Data Indication
      const peerAddrAttr = encodeAttribute(ATTR_XOR_PEER_ADDRESS, 
        encodeXorMappedAddress(peerInfo.address, peerInfo.port, Buffer.alloc(12)));
      const dataAttr = encodeAttribute(ATTR_DATA, data);
      const indication = buildStunMessage(TURN_DATA_INDICATION, crypto.randomBytes(12), [peerAddrAttr, dataAttr]);
      server.send(indication, alloc.clientPort, alloc.clientAddr);
    }
  });

  allocations.set(key, alloc);
  logger.info(`📡 TURN: Allocation created for ${key}, relay port ${relayPort}`);

  sendAllocateResponse(alloc, txnId, rinfo, server, announcedIp);
}

function sendAllocateResponse(
  alloc: TurnAllocation,
  txnId: Buffer,
  rinfo: dgram.RemoteInfo,
  server: dgram.Socket,
  announcedIp: string,
): void {
  const respAttrs: Buffer[] = [];

  // XOR-RELAYED-ADDRESS (relay address that peers will send to)
  respAttrs.push(encodeAttribute(ATTR_XOR_RELAYED_ADDRESS,
    encodeXorMappedAddress(announcedIp, alloc.relayPort, txnId)));

  // XOR-MAPPED-ADDRESS (client's reflexive address)
  respAttrs.push(encodeAttribute(ATTR_XOR_MAPPED_ADDRESS,
    encodeXorMappedAddress(rinfo.address, rinfo.port, txnId)));

  // LIFETIME
  const lifetimeBuf = Buffer.alloc(4);
  lifetimeBuf.writeUInt32BE(alloc.lifetime, 0);
  respAttrs.push(encodeAttribute(ATTR_LIFETIME, lifetimeBuf));

  // SOFTWARE
  respAttrs.push(encodeAttribute(ATTR_SOFTWARE, Buffer.from(SOFTWARE_NAME)));

  let resp = buildStunMessage(TURN_ALLOCATE_RESPONSE, txnId, respAttrs);
  if (alloc.authKey) resp = addMessageIntegrity(resp, alloc.authKey);
  server.send(resp, rinfo.port, rinfo.address);
}

// ============================================================
// TURN Refresh handler
// ============================================================
function handleRefreshRequest(
  msg: Buffer,
  txnId: Buffer,
  attrs: Map<number, Buffer>,
  rinfo: dgram.RemoteInfo,
  server: dgram.Socket,
): void {
  const key = allocationKey(rinfo.address, rinfo.port);
  const alloc = allocations.get(key);
  if (!alloc) {
    const errAttrs = [encodeAttribute(ATTR_ERROR_CODE, encodeErrorCode(437, 'Allocation Mismatch'))];
    server.send(buildStunMessage(0x0114, txnId, errAttrs), rinfo.port, rinfo.address);
    return;
  }

  // Check requested lifetime
  let lifetime = DEFAULT_LIFETIME;
  const lifetimeAttr = attrs.get(ATTR_LIFETIME);
  if (lifetimeAttr && lifetimeAttr.length >= 4) {
    lifetime = lifetimeAttr.readUInt32BE(0);
    if (lifetime === 0) {
      // Delete allocation
      cleanupAllocation(key);
      const respAttrs = [encodeAttribute(ATTR_LIFETIME, Buffer.alloc(4))]; // lifetime=0
      let resp = buildStunMessage(TURN_REFRESH_RESPONSE, txnId, respAttrs);
      if (alloc.authKey) resp = addMessageIntegrity(resp, alloc.authKey);
      server.send(resp, rinfo.port, rinfo.address);
      return;
    }
    lifetime = Math.min(lifetime, MAX_LIFETIME);
  }

  alloc.lifetime = lifetime;
  alloc.expiresAt = Date.now() + lifetime * 1000;

  const lifetimeBuf = Buffer.alloc(4);
  lifetimeBuf.writeUInt32BE(lifetime, 0);
  const respAttrs = [encodeAttribute(ATTR_LIFETIME, lifetimeBuf)];
  let resp = buildStunMessage(TURN_REFRESH_RESPONSE, txnId, respAttrs);
  if (alloc.authKey) resp = addMessageIntegrity(resp, alloc.authKey);
  server.send(resp, rinfo.port, rinfo.address);
}

// ============================================================
// TURN CreatePermission handler
// ============================================================
function handleCreatePermission(
  msg: Buffer,
  txnId: Buffer,
  attrs: Map<number, Buffer>,
  rinfo: dgram.RemoteInfo,
  server: dgram.Socket,
): void {
  const key = allocationKey(rinfo.address, rinfo.port);
  const alloc = allocations.get(key);
  if (!alloc) {
    logger.warn(`📡 TURN CreatePermission: NO ALLOC for key=${key}, known keys: [${Array.from(allocations.keys()).join(', ')}]`);
    const errAttrs = [encodeAttribute(ATTR_ERROR_CODE, encodeErrorCode(437, 'Allocation Mismatch'))];
    server.send(buildStunMessage(0x0118, txnId, errAttrs), rinfo.port, rinfo.address);
    return;
  }

  // Get peer address
  const peerAddrBuf = attrs.get(ATTR_XOR_PEER_ADDRESS);
  if (peerAddrBuf) {
    const peer = decodeXorPeerAddress(peerAddrBuf, txnId);
    if (peer) {
      alloc.permissions.set(peer.ip, Date.now() + 300000); // 5 min
      logger.info(`📡 TURN: CreatePermission for ${peer.ip} on relay :${alloc.relayPort} (from ${key})`);
    }
  }

  let resp = buildStunMessage(TURN_CREATE_PERMISSION_RESPONSE, txnId, []);
  if (alloc.authKey) resp = addMessageIntegrity(resp, alloc.authKey);
  server.send(resp, rinfo.port, rinfo.address);
}

// ============================================================
// TURN ChannelBind handler
// ============================================================
function handleChannelBind(
  msg: Buffer,
  txnId: Buffer,
  attrs: Map<number, Buffer>,
  rinfo: dgram.RemoteInfo,
  server: dgram.Socket,
): void {
  const key = allocationKey(rinfo.address, rinfo.port);
  const alloc = allocations.get(key);
  if (!alloc) {
    const errAttrs = [encodeAttribute(ATTR_ERROR_CODE, encodeErrorCode(437, 'Allocation Mismatch'))];
    server.send(buildStunMessage(0x0119, txnId, errAttrs), rinfo.port, rinfo.address);
    return;
  }

  const channelBuf = attrs.get(ATTR_CHANNEL_NUMBER);
  const peerAddrBuf = attrs.get(ATTR_XOR_PEER_ADDRESS);

  if (!channelBuf || channelBuf.length < 4 || !peerAddrBuf) {
    const errAttrs = [encodeAttribute(ATTR_ERROR_CODE, encodeErrorCode(400, 'Bad Request'))];
    server.send(buildStunMessage(0x0119, txnId, errAttrs), rinfo.port, rinfo.address);
    return;
  }

  const channelNum = channelBuf.readUInt16BE(0);
  if (channelNum < 0x4000 || channelNum > 0x7FFF) {
    const errAttrs = [encodeAttribute(ATTR_ERROR_CODE, encodeErrorCode(400, 'Bad Channel'))];
    server.send(buildStunMessage(0x0119, txnId, errAttrs), rinfo.port, rinfo.address);
    return;
  }

  const peer = decodeXorPeerAddress(peerAddrBuf, txnId);
  if (!peer) {
    const errAttrs = [encodeAttribute(ATTR_ERROR_CODE, encodeErrorCode(400, 'Bad Peer'))];
    server.send(buildStunMessage(0x0119, txnId, errAttrs), rinfo.port, rinfo.address);
    return;
  }

  alloc.channels.set(channelNum, {
    peerAddr: peer.ip,
    peerPort: peer.port,
    expiresAt: Date.now() + 600000, // 10 min
  });
  alloc.reverseChannels.set(`${peer.ip}:${peer.port}`, channelNum);
  
  // Also create permission
  alloc.permissions.set(peer.ip, Date.now() + 300000);

  let resp = buildStunMessage(TURN_CHANNEL_BIND_RESPONSE, txnId, []);
  if (alloc.authKey) resp = addMessageIntegrity(resp, alloc.authKey);
  server.send(resp, rinfo.port, rinfo.address);
}

// ============================================================
// Hairpin relay: когда оба клиента используют relay на одном сервере,
// данные между relay портами не идут через сеть (роутер может не поддерживать hairpin NAT).
// Вместо этого доставляем данные напрямую через внутреннюю маршрутизацию.
// ============================================================
function _isLocalRelayTarget(
  peerIp: string,
  peerPort: number,
  sourceAlloc: TurnAllocation,
  data: Buffer,
): boolean {
  // Проверяем: если цель — наш announced IP и порт совпадает с relay портом другой аллокации
  if (peerIp !== _mainAnnouncedIp) return false;
  
  for (const [, targetAlloc] of allocations) {
    if (targetAlloc === sourceAlloc) continue;
    if (targetAlloc.relayPort === peerPort) {
      // Нашли целевую аллокацию — имитируем приход данных от relay порта источника
      const fakeRinfo = { address: _mainAnnouncedIp, port: sourceAlloc.relayPort };
      
      // Проверяем permission на целевой аллокации
      if (!targetAlloc.permissions.has(fakeRinfo.address)) {
        logger.info(`📡 TURN: Hairpin DENIED — :${sourceAlloc.relayPort}→:${peerPort} (no permission for ${fakeRinfo.address})`);
        return true; // consumed, but denied
      }
      
      // Доставляем как Data Indication целевому клиенту
      const peerAddrAttr = encodeAttribute(ATTR_XOR_PEER_ADDRESS, 
        encodeXorMappedAddress(fakeRinfo.address, fakeRinfo.port, Buffer.alloc(12)));
      const dataAttr = encodeAttribute(ATTR_DATA, data);
      const indication = buildStunMessage(TURN_DATA_INDICATION, crypto.randomBytes(12), [peerAddrAttr, dataAttr]);
      
      // Отправляем через тот же UDP сервер что и обычные сообщения
      const serverSocket = _getServerForAllocation(targetAlloc);
      if (serverSocket) {
        serverSocket.send(indication, targetAlloc.clientPort, targetAlloc.clientAddr);
        return true;
      }
      return false;
    }
  }
  return false;
}

// Получить серверный UDP сокет для аллокации (через который клиент подключен)
function _getServerForAllocation(alloc: TurnAllocation): dgram.Socket | null {
  return alloc.serverSocket || stunServer;
}

// ============================================================
// TURN Send Indication handler
// ============================================================
function handleSendIndication(
  attrs: Map<number, Buffer>,
  rinfo: dgram.RemoteInfo,
): void {
  const key = allocationKey(rinfo.address, rinfo.port);
  const alloc = allocations.get(key);
  if (!alloc) return;

  const peerAddrBuf = attrs.get(ATTR_XOR_PEER_ADDRESS);
  const dataBuf = attrs.get(ATTR_DATA);
  if (!peerAddrBuf || !dataBuf) return;

  const peer = decodeXorPeerAddress(peerAddrBuf, Buffer.alloc(12));
  if (!peer) return;

  // Check permission
  if (!alloc.permissions.has(peer.ip)) {
    logger.info(`📡 TURN: SendIndication DENIED (no permission for ${peer.ip}) from relay :${alloc.relayPort}`);
    return;
  }

  // Hairpin: если цель — relay порт на этом же сервере, доставляем напрямую
  if (_isLocalRelayTarget(peer.ip, peer.port, alloc, dataBuf)) return;

  alloc.relaySocket.send(dataBuf, peer.port, peer.ip);
}

// ============================================================
// ChannelData handler (0x4000-0x7FFF in first 2 bytes)
// ============================================================
function handleChannelData(
  msg: Buffer,
  rinfo: dgram.RemoteInfo,
): void {
  const key = allocationKey(rinfo.address, rinfo.port);
  const alloc = allocations.get(key);
  if (!alloc) return;

  const channelNum = msg.readUInt16BE(0);
  const dataLen = msg.readUInt16BE(2);
  const data = msg.subarray(4, 4 + dataLen);

  const channel = alloc.channels.get(channelNum);
  if (!channel || channel.expiresAt < Date.now()) return;

  // Hairpin: если цель — relay порт на этом же сервере
  if (_isLocalRelayTarget(channel.peerAddr, channel.peerPort, alloc, data)) return;

  alloc.relaySocket.send(data, channel.peerPort, channel.peerAddr);
}

// ============================================================
// Cleanup
// ============================================================
function cleanupAllocation(key: string): void {
  const alloc = allocations.get(key);
  if (!alloc) return;

  try {
    alloc.relaySocket.close();
  } catch {}
  allocations.delete(key);
  logger.info(`📡 TURN: Allocation removed for ${key}`);
}

// Периодическая очистка expired allocations
function startCleanupTimer(): void {
  setInterval(() => {
    const now = Date.now();
    for (const [key, alloc] of allocations) {
      if (alloc.expiresAt < now) {
        cleanupAllocation(key);
      }
      // Clean expired permissions
      for (const [ip, expiry] of alloc.permissions) {
        if (expiry < now) alloc.permissions.delete(ip);
      }
      // Clean expired channels
      for (const [num, ch] of alloc.channels) {
        if (ch.expiresAt < now) {
          alloc.reverseChannels.delete(`${ch.peerAddr}:${ch.peerPort}`);
          alloc.channels.delete(num);
        }
      }
    }
    // Очистка старых IP из анти-спам фильтра
    for (const [ip, rl] of stunRateLimits) {
      if (now > rl.resetAt && now > rl.bannedUntil) {
        stunRateLimits.delete(ip);
      }
    }
  }, 30000); // каждые 30 сек
}

// ============================================================
// Основной STUN/TURN сервер
// ============================================================
export interface StunTurnConfig {
  port: number;          // UDP порт (default 3478)
  host: string;          // bind address (default 0.0.0.0)
  announcedIp: string;   // public IP/domain для TURN relay
  username?: string;      // TURN credentials
  password?: string;
  realm?: string;
  relayPortMin?: number;
  relayPortMax?: number;
}

let stunServer: dgram.Socket | null = null;
let stunTcpServer: net.Server | null = null;
let stunServer6: dgram.Socket | null = null;
// Дополнительные сокеты для multi-port (443 UDP и пр.)
const extraUdpSockets: dgram.Socket[] = [];
const extraTcpServers: net.Server[] = [];

export function startStunTurnServer(cfg: StunTurnConfig): dgram.Socket {
  if (stunServer) return stunServer;

  const port = cfg.port || 3478;
  const host = cfg.host || '0.0.0.0';
  const announcedIp = cfg.announcedIp || '127.0.0.1';
  _mainAnnouncedIp = announcedIp;

  if (cfg.username) turnUsername = cfg.username;
  if (cfg.password) turnPassword = cfg.password;
  if (cfg.realm) turnRealm = cfg.realm;
  if (cfg.relayPortMin) relayPortMin = cfg.relayPortMin;
  if (cfg.relayPortMax) relayPortMax = cfg.relayPortMax;
  nextRelayPort = relayPortMin;

  // === UDP4 STUN/TURN ===
  stunServer = dgram.createSocket('udp4');

  stunServer.on('message', (msg, rinfo) => {
    handleStunTurnMessage(msg, rinfo, stunServer!, announcedIp);
  });

  stunServer.on('error', (err) => {
    logger.error(`STUN/TURN server error: ${err.message}`);
  });

  stunServer.bind(port, host === '::' ? '0.0.0.0' : host, () => {
    logger.info(`📡 STUN/TURN server started on ${host}:${port} (UDP)`);
    logger.info(`   STUN: stun:${announcedIp}:${port}`);
    logger.info(`   TURN: turn:${announcedIp}:${port} (UDP)`);
    if (turnUsername) {
      logger.info(`   TURN credentials: ${turnUsername} / ${'*'.repeat(8)}`);
    }
    logger.info(`   Relay ports: ${relayPortMin}-${relayPortMax}`);
  });

  // === TCP STUN/TURN (для VPN/NAT где UDP заблокирован) ===
  try {
    stunTcpServer = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      
      socket.on('data', (data) => {
        buffer = Buffer.concat([buffer, data]);
        
        // STUN over TCP: каждое сообщение имеет 2-byte length prefix (RFC 6062)
        // Или просто STUN сообщения подряд (определяем по STUN header)
        while (buffer.length >= STUN_HEADER_SIZE) {
          // Проверяем ChannelData (first two bits = 01)
          const firstByte = buffer.readUInt8(0);
          if ((firstByte & 0xC0) === 0x40 && buffer.length >= 4) {
            const chanDataLen = buffer.readUInt16BE(2);
            const totalLen = 4 + chanDataLen + padTo4(chanDataLen);
            if (buffer.length < totalLen) break;
            const chanMsg = buffer.subarray(0, totalLen);
            buffer = buffer.subarray(totalLen);
            // Process channel data via TCP
            const fakeRinfo: dgram.RemoteInfo = {
              address: socket.remoteAddress?.replace(/^::ffff:/, '') || '0.0.0.0',
              port: socket.remotePort || 0,
              family: 'IPv4',
              size: chanMsg.length,
            };
            handleChannelData(chanMsg, fakeRinfo);
            continue;
          }
          
          // STUN/TURN message
          if (buffer.length < STUN_HEADER_SIZE) break;
          const msgLen = buffer.readUInt16BE(2);
          const totalLen = STUN_HEADER_SIZE + msgLen;
          if (buffer.length < totalLen) break;
          
          const msg = buffer.subarray(0, totalLen);
          buffer = buffer.subarray(totalLen);
          
          const fakeRinfo: dgram.RemoteInfo = {
            address: socket.remoteAddress?.replace(/^::ffff:/, '') || '0.0.0.0',
            port: socket.remotePort || 0,
            family: 'IPv4',
            size: msg.length,
          };
          
          // Create a fake dgram socket that sends via TCP
          const fakeSender = {
            send: (data: Buffer, port: number, address: string) => {
              try { socket.write(data); } catch {}
            },
          } as any;
          
          handleStunTurnMessage(msg, fakeRinfo, fakeSender, announcedIp);
        }
      });
      
      socket.on('error', () => {});
      socket.setTimeout(120000, () => socket.destroy());
    });
    
    stunTcpServer.listen(port, host === '::' ? '0.0.0.0' : host, () => {
      logger.info(`📡 STUN/TURN TCP server started on port ${port}`);
      logger.info(`   TURN: turn:${announcedIp}:${port}?transport=tcp`);
    });
    
    stunTcpServer.on('error', (err) => {
      logger.warn(`STUN/TURN TCP server error: ${err.message}`);
    });
  } catch (e) {
    logger.warn(`⚠ Could not start STUN/TURN TCP server: ${e}`);
  }

  // === UDP6 STUN (для Yggdrasil IPv6) ===
  try {
    stunServer6 = dgram.createSocket({ type: 'udp6', ipv6Only: true });
    stunServer6.on('message', (msg, rinfo) => {
      handleStunTurnMessage(msg, rinfo, stunServer6!, announcedIp);
    });
    stunServer6.on('error', (err) => {
      logger.warn(`STUN/TURN IPv6 error: ${err.message}`);
    });
    stunServer6.bind(port, '::', () => {
      logger.info(`📡 STUN/TURN IPv6 server started on [::]:${port} (UDP)`);
    });
  } catch (e) {
    logger.warn(`⚠ Could not start STUN/TURN IPv6 server: ${e}`);
  }

  startCleanupTimer();
  return stunServer;
}

/**
 * Общий обработчик STUN/TURN сообщений (используется UDP и TCP)
 */
function handleStunTurnMessage(
  msg: Buffer,
  rinfo: dgram.RemoteInfo,
  server: dgram.Socket,
  announcedIp: string,
): void {
  try {
    // --- ANTI-SPAM (Rate Limiter) ---
    const ip = rinfo.address;
    const now = Date.now();
    let rl = stunRateLimits.get(ip);
    
    if (!rl) {
      rl = { count: 1, resetAt: now + 10000, bannedUntil: 0 };
      stunRateLimits.set(ip, rl);
    } else {
      if (now < rl.bannedUntil) return; // Сброс пакета (в бане)
      
      if (now > rl.resetAt) {
        rl.count = 1;
        rl.resetAt = now + 10000;
      } else {
        rl.count++;
        // Если больше 50 STUN пакетов за 10 секунд с одного IP
        if (rl.count > 50) { 
          rl.bannedUntil = now + 600000; // Бан на 10 минут (600 000 мс)
          logger.warn(`🛡️ ANTI-SPAM: IP ${ip} отправлен в бан на 10 минут за флуд STUN-запросами!`);
          return; // Drop
        }
      }
    }
    // --------------------------------

    if (msg.length < 4) return;

    // ChannelData? (first two bits = 01)
    const firstByte = msg.readUInt8(0);
    if ((firstByte & 0xC0) === 0x40) {
      handleChannelData(msg, rinfo);
      return;
    }

    // STUN/TURN message — must have magic cookie
    if (msg.length < STUN_HEADER_SIZE) return;
    const msgType = msg.readUInt16BE(0) & 0x3FFF;
    const msgLen = msg.readUInt16BE(2);
    const cookie = msg.readUInt32BE(4);
    if (cookie !== STUN_MAGIC_COOKIE) return;

    const txnId = msg.subarray(8, 20);
    const attrs = parseAttributes(msg, STUN_HEADER_SIZE, STUN_HEADER_SIZE + msgLen);

    // DEBUG: log all TURN methods (not STUN Binding — too noisy)
    if (msgType !== STUN_BINDING_REQUEST) {
      const methodNames: Record<number, string> = {
        0x0003: 'Allocate', 0x0004: 'Refresh', 0x0006: 'SendIndication',
        0x0007: 'DataIndication', 0x0008: 'CreatePermission', 0x0009: 'ChannelBind',
      };
      logger.info(`📡 TURN msg type=0x${msgType.toString(16).padStart(4,'0')} (${methodNames[msgType] || 'unknown'}) from ${rinfo.address}:${rinfo.port}`);
    }

    switch (msgType) {
      case STUN_BINDING_REQUEST:
        handleBindingRequest(msg, txnId, rinfo, server);
        break;
      case TURN_ALLOCATE_REQUEST:
        handleAllocateRequest(msg, txnId, attrs, rinfo, server, announcedIp);
        break;
      case TURN_REFRESH_REQUEST:
        handleRefreshRequest(msg, txnId, attrs, rinfo, server);
        break;
      case TURN_CREATE_PERMISSION_REQUEST:
        handleCreatePermission(msg, txnId, attrs, rinfo, server);
        break;
      case TURN_CHANNEL_BIND_REQUEST:
        handleChannelBind(msg, txnId, attrs, rinfo, server);
        break;
      case TURN_SEND_INDICATION:
        handleSendIndication(attrs, rinfo);
        break;
      default:
        logger.info(`📡 TURN unknown method 0x${msgType.toString(16)} from ${rinfo.address}:${rinfo.port}`);
        break;
    }
  } catch (e) {
    logger.error(`📡 TURN handleStunTurnMessage ERROR: ${e}`);
  }
}

export function stopStunTurnServer(): void {
  if (stunServer) {
    stunServer.close();
    stunServer = null;
  }
  if (stunTcpServer) {
    stunTcpServer.close();
    stunTcpServer = null;
  }
  if (stunServer6) {
    stunServer6.close();
    stunServer6 = null;
  }
  // Закрываем дополнительные порты
  for (const s of extraUdpSockets) { try { s.close(); } catch {} }
  extraUdpSockets.length = 0;
  for (const s of extraTcpServers) { try { s.close(); } catch {} }
  extraTcpServers.length = 0;
  // Cleanup all allocations
  for (const key of allocations.keys()) {
    cleanupAllocation(key);
  }
}

/**
 * Добавить STUN/TURN на дополнительный порт (UDP + TCP).
 * Используется для привязки к порту 443 / server port — для прохода через NAT/firewall.
 * Вызывается ПОСЛЕ startStunTurnServer().
 */
export function addStunTurnPort(port: number, announcedIp: string, opts?: { externalPort?: number; udpOnly?: boolean }): void {
  const displayPort = opts?.externalPort || port;
  const udpOnly = opts?.udpOnly ?? false;

  // UDP на дополнительном порту (не конфликтует с TCP HTTPS на том же порту)
  try {
    const udpSock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    udpSock.on('message', (msg, rinfo) => {
      handleStunTurnMessage(msg, rinfo, udpSock, announcedIp);
    });
    udpSock.on('error', (err) => {
      logger.warn(`STUN/TURN UDP port ${port} error: ${err.message}`);
    });
    udpSock.bind(port, '0.0.0.0', () => {
      logger.info(`📡 STUN/TURN also listening on UDP :${port} (external :${displayPort})`);
      logger.info(`   STUN: stun:${announcedIp}:${displayPort}`);
      logger.info(`   TURN: turn:${announcedIp}:${displayPort} (UDP)`);
    });
    extraUdpSockets.push(udpSock);
  } catch (e) {
    logger.warn(`⚠ Could not bind STUN/TURN UDP on port ${port}: ${e}`);
  }

  // TCP (пропускаем если udpOnly — порт занят HTTPS)
  if (!udpOnly) {
    try {
      const tcpSrv = net.createServer((socket) => {
        let buffer = Buffer.alloc(0);
        socket.on('data', (data) => {
          buffer = Buffer.concat([buffer, data]);
          while (buffer.length >= STUN_HEADER_SIZE) {
            const firstByte = buffer.readUInt8(0);
            if ((firstByte & 0xC0) === 0x40 && buffer.length >= 4) {
              const chanDataLen = buffer.readUInt16BE(2);
              const totalLen = 4 + chanDataLen + padTo4(chanDataLen);
              if (buffer.length < totalLen) break;
              const chanMsg = buffer.subarray(0, totalLen);
              buffer = buffer.subarray(totalLen);
              const fakeRinfo: dgram.RemoteInfo = {
                address: socket.remoteAddress?.replace(/^::ffff:/, '') || '0.0.0.0',
                port: socket.remotePort || 0, family: 'IPv4', size: chanMsg.length,
              };
              handleChannelData(chanMsg, fakeRinfo);
              continue;
            }
            if (buffer.length < STUN_HEADER_SIZE) break;
            const msgLen = buffer.readUInt16BE(2);
            const totalLen = STUN_HEADER_SIZE + msgLen;
            if (buffer.length < totalLen) break;
            const msg = buffer.subarray(0, totalLen);
            buffer = buffer.subarray(totalLen);
            const fakeRinfo: dgram.RemoteInfo = {
              address: socket.remoteAddress?.replace(/^::ffff:/, '') || '0.0.0.0',
              port: socket.remotePort || 0, family: 'IPv4', size: msg.length,
            };
            const fakeSender = { send: (data: Buffer) => { try { socket.write(data); } catch {} } } as any;
            handleStunTurnMessage(msg, fakeRinfo, fakeSender, announcedIp);
          }
        });
        socket.on('error', () => {});
        socket.setTimeout(120000, () => socket.destroy());
      });
      tcpSrv.on('error', (err) => {
        logger.warn(`⚠ STUN/TURN TCP port ${port} busy: ${err.message}`);
      });
      tcpSrv.listen(port, '0.0.0.0', () => {
        logger.info(`📡 STUN/TURN TCP also on port ${port} (external :${displayPort})`);
      });
      extraTcpServers.push(tcpSrv);
    } catch (e) {
      logger.warn(`⚠ Could not bind STUN/TURN TCP on port ${port}: ${e}`);
    }
  } else {
    logger.info(`   ℹ TCP skipped for port ${port} (shared with HTTPS)`);
  }
}

export function getStunTurnStats(): {
  allocations: number;
  totalPermissions: number;
  totalChannels: number;
} {
  let totalPermissions = 0;
  let totalChannels = 0;
  for (const alloc of allocations.values()) {
    totalPermissions += alloc.permissions.size;
    totalChannels += alloc.channels.size;
  }
  return {
    allocations: allocations.size,
    totalPermissions,
    totalChannels,
  };
}

/**
 * Обработка TCP сокета как TURN over TCP.
 * Используется для мультиплексирования TURN/TLS на порту 443 (проходит через любой мобильный NAT/firewall).
 * Первый байт уже прочитан мультиплексором и передан в initialData.
 */
export function handleTurnTcpSocket(socket: net.Socket, initialData: Buffer, announcedIpOverride?: string): void {
  const ip = announcedIpOverride || (stunServer ? 'announce' : '127.0.0.1');
  // Используем announcedIp из первого запуска
  const effectiveIp = ip === 'announce' ? _mainAnnouncedIp : ip;
  
  let buffer = Buffer.from(initialData);

  const processBuffer = () => {
    while (buffer.length >= STUN_HEADER_SIZE) {
      const firstByte = buffer.readUInt8(0);
      // ChannelData (first two bits = 01)
      if ((firstByte & 0xC0) === 0x40 && buffer.length >= 4) {
        const chanDataLen = buffer.readUInt16BE(2);
        const totalLen = 4 + chanDataLen + padTo4(chanDataLen);
        if (buffer.length < totalLen) break;
        const chanMsg = buffer.subarray(0, totalLen);
        buffer = buffer.subarray(totalLen);
        const fakeRinfo: dgram.RemoteInfo = {
          address: socket.remoteAddress?.replace(/^::ffff:/, '') || '0.0.0.0',
          port: socket.remotePort || 0, family: 'IPv4', size: chanMsg.length,
        };
        handleChannelData(chanMsg, fakeRinfo);
        continue;
      }
      // STUN/TURN message
      if (buffer.length < STUN_HEADER_SIZE) break;
      const msgLen = buffer.readUInt16BE(2);
      const totalLen = STUN_HEADER_SIZE + msgLen;
      if (buffer.length < totalLen) break;
      const msg = buffer.subarray(0, totalLen);
      buffer = buffer.subarray(totalLen);
      const fakeRinfo: dgram.RemoteInfo = {
        address: socket.remoteAddress?.replace(/^::ffff:/, '') || '0.0.0.0',
        port: socket.remotePort || 0, family: 'IPv4', size: msg.length,
      };
      const fakeSender = { send: (data: Buffer) => { try { socket.write(data); } catch {} } } as any;
      handleStunTurnMessage(msg, fakeRinfo, fakeSender, effectiveIp);
    }
  };

  // Обрабатываем начальные данные
  processBuffer();

  socket.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);
    processBuffer();
  });
  socket.on('error', (err) => { logger.warn(`📡 TURNS TCP error from ${socket.remoteAddress}:${socket.remotePort}: ${err.message}`); });
  socket.on('close', () => { logger.info(`📡 TURNS TCP closed: ${socket.remoteAddress}:${socket.remotePort}`); });
  socket.setTimeout(120000, () => socket.destroy());
}

// Запоминаем announcedIp из первого запуска
let _mainAnnouncedIp = '127.0.0.1';
