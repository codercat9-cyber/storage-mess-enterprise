// Закрытая часть STORAGE&MESS — в открытый код не входит.
// Здесь заглушка с тем же интерфейсом: открытая сборка работает без этого механизма.
// Шифрование звонков и маскировка SDP. Без них звонок идёт по обычному WebRTC (DTLS-SRTP).
export interface EncryptedPacket {
  ct: string;
  iv: string;
  t: number;
}

export async function generateCallKeys(): Promise<string> { return ''; }
export async function deriveSessionKey(_peerId: string, _peerPublicKeyBase64: string): Promise<void> { /* */ }
export function hasSessionKey(_peerId: string): boolean { return false; }
export function getPublicKeyBase64(): string | null { return null; }
export async function generateRelayBroadcastKey(): Promise<void> { /* */ }
export async function encryptAudio(_audioBase64: string, _peerId?: string): Promise<EncryptedPacket | null> { return null; }
export async function encryptVideo(_imageBase64: string, _peerId?: string): Promise<EncryptedPacket | null> { return null; }
export async function decryptPacket(_packet: EncryptedPacket, _peerId?: string): Promise<{ data: Uint8Array; type: number } | null> { return null; }
export async function decryptAudio(_packet: EncryptedPacket, _peerId?: string): Promise<string | null> { return null; }
export async function decryptVideo(_packet: EncryptedPacket, _peerId?: string): Promise<string | null> { return null; }
export function startChaffTraffic(_sendCallback: (packet: EncryptedPacket) => void): void { /* */ }
export function stopChaffTraffic(): void { /* */ }
export function obfuscateSDP(sdp: string): { sdp: string; realFingerprint: string } { return { sdp, realFingerprint: '' }; }
export function deobfuscateSDP(sdp: string, _realFingerprint?: string): string { return sdp; }
export function withJitter<T>(fn: () => T): Promise<T> { return Promise.resolve(fn()); }
export function cleanupCallCrypto(): void { /* */ }

export default {
  generateCallKeys, deriveSessionKey, hasSessionKey, getPublicKeyBase64, generateRelayBroadcastKey,
  encryptAudio, encryptVideo, decryptAudio, decryptVideo, decryptPacket, obfuscateSDP, deobfuscateSDP,
  withJitter, startChaffTraffic, stopChaffTraffic, cleanupCallCrypto,
};
