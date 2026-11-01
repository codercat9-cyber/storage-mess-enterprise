// Закрытая часть STORAGE&MESS — в открытый код не входит.
// Здесь заглушка с тем же интерфейсом: открытая сборка работает без этого механизма.
// Защита от DPI/ТСПУ на уровне сети.
import tls from 'tls';

export interface DPIProtectionConfig { [key: string]: unknown }

export function initDPIProtection(_opts?: Partial<DPIProtectionConfig>): void { /* нет в открытой сборке */ }
export function hardenTlsSocket(_socket: tls.TLSSocket): void { /* нет в открытой сборке */ }
export function onDPIAlert(_reasons: string[]): void { /* нет в открытой сборке */ }
export function getProtectionLevel(): string { return 'off'; }
export function cleanupDPIProtection(): void { /* нет в открытой сборке */ }
export function getIptablesStats(): string { return ''; }
export function getDPIProtectionStatus(): string { return 'not included in the open-source build'; }
