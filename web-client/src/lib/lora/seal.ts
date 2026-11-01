// Закрытая часть STORAGE&MESS — в открытый код не входит.
// Здесь заглушка с тем же интерфейсом: открытая сборка работает без этого механизма.
// Защита содержимого LoRa: подписи, личные сообщения, обмен ключами.
// В открытой сборке сообщения идут как есть — под общим ключом канала
// Meshtastic; защищённые кадры полной сборки здесь не открываются.
import { addrFromNode } from './smesh';

export const SMESH_T_CTRL = 3;
export const SMESH_T_SEALED = 0x08;
export type Trust = 'none' | 'signed' | 'private';
export interface SealHeader { type: number; msgId: number; from: Uint8Array; to: Uint8Array }
export interface SealStore {
  load(): Uint8Array | null;
  save(seed: Uint8Array): void;
  loadBook?(): string | null;
  saveBook?(json: string): void;
}
export interface PeerInfo { node: number; id: string; changed?: string; revoked?: boolean }
export interface Opened { type: number; body: Uint8Array; trust: Trust; key?: string; revoked?: boolean }

export class Sealer {
  private myNode = 0;
  constructor(_store: SealStore, _notice: (s: string) => void = () => {}) {}
  get name() { return 'нет (открытая сборка)'; }
  get active() { return false; }
  init(myNode: number) { this.myNode = myNode; }
  // Личность устройства и отзыв ключей УЦ — в полной сборке
  ensureIdentity() {}
  rotateIdentity() {}
  publicKeyHex(): string { return ''; }
  setRevoked(_list: string[]) {}
  isRevoked(_edHex: string) { return false; }
  get revokedCount() { return 0; }
  get selfRevoked() { return false; }
  self(): Uint8Array { return addrFromNode(this.myNode); }
  id(): string { return ''; }
  overhead(_toAll: boolean) { return 0; }
  peer(node: number): Uint8Array | null { return addrFromNode(node); }
  peers(): PeerInfo[] { return []; }
  trust(_node: number): boolean { return false; }
  seal(h: SealHeader, body: Uint8Array) { return { type: h.type, from: h.from, body }; }
  open(_fromNode: number, h: SealHeader, body: Uint8Array, _now?: number): Opened | null {
    return h.type & SMESH_T_SEALED ? null : { type: h.type, body, trust: 'none' };
  }
  onCtrl(_fromNode: number, _h: SealHeader, _body: Uint8Array, _now?: number) {}
  ctrlOut(_now: number): { toNode: number; to: Uint8Array; body: Uint8Array } | null { return null; }
}

export const localSealStore: SealStore = { load: () => null, save: () => {} };
