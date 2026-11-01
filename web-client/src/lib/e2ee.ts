// Закрытая часть STORAGE&MESS — в открытый код не входит.
// Здесь заглушка с тем же интерфейсом: открытая сборка работает без этого механизма.
// Сквозное шифрование сообщений. В открытой сборке выключено всегда:
// сообщения уходят как есть, isE2EEEnabled() === false.

export interface E2EEKeyPair {
  publicKey: JsonWebKey;        // Экспортированный public key (JWK)
  privateKey: CryptoKey;        // Приватный ключ (не экспортируется)
  publicKeyHash: string;        // SHA-256 hash public key (fingerprint)
}

export interface E2EEIdentity {
  signing: E2EEKeyPair;         // ECDSA — для подписей
  exchange: E2EEKeyPair;        // ECDH — для обмена ключами
}

export interface EncryptedMessage {
  ciphertext: string;           // Base64 зашифрованных данных
  iv: string;                   // Base64 initialization vector
  signature: string;            // Base64 подпись отправителя
  senderPublicKey: string;      // Fingerprint отправителя
}

export interface PeerKeys {
  signingKey: CryptoKey;        // ECDSA public key собеседника
  exchangeKey: CryptoKey;       // ECDH public key собеседника
  fingerprint: string;          // Отпечаток ключа
  deviceId: string;             // какому устройству принадлежит
}

export interface E2EEEnvelope {
  v: 2;
  from: string;                             // устройство отправителя
  copies: Record<string, EncryptedMessage>; // устройство получателя → шифротекст

  // Те же поля, что у одиночного сообщения старого формата. Заполняются
  // копией для устройства «legacy», чтобы необновлённое приложение нашло
  // привычную структуру и прочитало текст, а не показало замок.
  ciphertext?: string;
  iv?: string;
  signature?: string;
  senderPublicKey?: string;
}

export function getDeviceId(): string {
  try {
    let id = localStorage.getItem('e2ee_device_id');
    if (!id) { id = Math.random().toString(36).slice(2, 10); localStorage.setItem('e2ee_device_id', id); }
    return id;
  } catch { return 'open'; }
}
export function formatFingerprint(hash: string): string { return hash; }
export async function initE2EE(): Promise<E2EEIdentity> { return {} as E2EEIdentity; }
export async function publishKeys(_token: string): Promise<boolean> { return false; }
export async function fetchPeerDevices(_userId: string, _token: string, _force = false): Promise<Map<string, PeerKeys>> { return new Map(); }
export async function fetchPeerKeys(_userId: string, _token: string): Promise<PeerKeys | null> { return null; }
export async function encryptMessage(_plaintext: string, _recipientUserId: string, _token: string, _myUserId?: string): Promise<E2EEEnvelope | null> { return null; }
export async function decryptMessage(_encrypted: E2EEEnvelope | EncryptedMessage, _senderUserId: string, _token: string, _isOwn = false): Promise<string | null> { return null; }
export async function generateChallenge(): Promise<{ challenge: string; expected: string } | null> { return null; }
export async function answerChallenge(_challengeB64: string): Promise<string | null> { return null; }
export async function verifyChallenge(_challengeB64: string, _answerB64: string, _peerSigningKey: CryptoKey): Promise<boolean> { return false; }
export function getIdentity(): E2EEIdentity | null { return null; }
export function getFingerprint(): string | null { return null; }
export async function decryptMessages<T>(messages: T[], _token: string, _myUserId?: string): Promise<T[]> { return messages; }
export function getPeerFingerprint(_userId: string): string | null { return null; }
export function getPeerDeviceCount(_userId: string): number { return 0; }
export function isE2EEEnabled(): boolean { return false; }
export function setE2EEEnabled(_enabled: boolean): void { /* нет в открытой сборке */ }
export function hasPeerKeys(_userId: string): boolean { return false; }
export async function prepareChat(_peerUserId: string, _token: string): Promise<boolean> { return false; }
export function clearE2EEData(): void { /* */ }
export async function encryptForGroup(_plaintext: string, _memberUserIds: string[], _token: string): Promise<E2EEEnvelope | null> { return null; }

export default {
  initE2EE, publishKeys, fetchPeerKeys, encryptMessage, decryptMessage, generateChallenge, answerChallenge,
  verifyChallenge, getIdentity, getFingerprint, getPeerFingerprint, isE2EEEnabled, setE2EEEnabled,
  hasPeerKeys, clearE2EEData, formatFingerprint, encryptForGroup,
};
