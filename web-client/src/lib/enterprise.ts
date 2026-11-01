// =============================================================
// Корпоративный контур на устройстве — лёгкая часть.
//
//   • /api/enterprise/info — включён ли контур и как входить. Ответ
//     хранится на устройстве: экрану входа и LoRa он нужен и без связи.
//   • Общее состояние контура и хук для экранов.
//   • Запуск: если контур включён, подгружается enterprise-ca.ts —
//     сертификат устройства и список отзыва (там криптография и LoRa;
//     обычной сборке и экрану входа они не нужны).
// =============================================================

import { useEffect, useState } from 'react';
import { enterpriseApi } from '@/lib/api';
import { useAuthStore } from '@/store/auth';

export interface EnterpriseInfo { enabled: boolean; auth?: string; domain?: string; login_hint?: string }

export interface DeviceCert {
  v: number; user_id: string; username: string; ed_pub: string;
  issued_at: string | number; expires_at: string | number;
}

export interface EnterpriseState {
  info: EnterpriseInfo | null;
  /** сертификат этого устройства (проверен ключом УЦ) */
  cert: DeviceCert | null;
  /** ключ УЦ, закреплённый на устройстве */
  caPub: string | null;
  /** сервер назвал другой ключ УЦ — список отзыва и сертификат не приняты */
  caMismatch: boolean;
  crlSeq: number | null;
  /** когда принят последний список отзыва (мс) */
  crlAt: number | null;
  revokedCount: number;
  /** ключ этого устройства в списке отзыва */
  selfRevoked: boolean;
  error: string | null;
}

export const K_INFO = 'smess_ent_info';
export const K_CA = 'smess_ent_ca_pub';
export const K_CERT = 'smess_ent_device_cert';
export const K_CRL = 'smess_ent_crl';

export const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } },
  del: (k: string) => { try { localStorage.removeItem(k); } catch { /* */ } },
  json<T>(k: string): T | null { try { return JSON.parse(this.get(k) || 'null'); } catch { return null; } },
};

/** Время из договора: ISO-строка, секунды или миллисекунды. */
export function toMs(x: string | number | null | undefined): number {
  if (x === null || x === undefined || x === '') return NaN;
  if (typeof x === 'number') return x < 1e12 ? x * 1000 : x;
  if (/^\d+$/.test(x)) return toMs(Number(x));
  return Date.parse(x);
}

// ── состояние ────────────────────────────────────────────────
let state: EnterpriseState = {
  info: ls.json<EnterpriseInfo>(K_INFO),
  cert: null, caPub: ls.get(K_CA), caMismatch: false,
  crlSeq: null, crlAt: null, revokedCount: 0, selfRevoked: false, error: null,
};
const listeners = new Set<(s: EnterpriseState) => void>();

/** Только для enterprise-ca.ts. */
export function setEnterpriseState(p: Partial<EnterpriseState>) {
  state = { ...state, ...p };
  listeners.forEach(l => l(state));
}
export const getEnterprise = () => state;
export function onEnterprise(l: (s: EnterpriseState) => void) { listeners.add(l); l(state); return () => { listeners.delete(l); }; }

/** Для экранов: состояние контура, перерисовка при изменении. */
export function useEnterprise(): EnterpriseState {
  const [s, setS] = useState(state);
  useEffect(() => onEnterprise(setS), []);
  return s;
}

// ── info ─────────────────────────────────────────────────────
let infoInflight: Promise<EnterpriseInfo | null> | null = null;

/** Спросить сервер, включён ли контур. Без связи — то, что запомнено. */
export function refreshEnterpriseInfo(): Promise<EnterpriseInfo | null> {
  if (infoInflight) return infoInflight;
  infoInflight = (async () => {
    try {
      const d = (await enterpriseApi.info()).data || {};
      const info: EnterpriseInfo = {
        enabled: d.enabled === true,
        auth: d.auth || undefined,
        domain: d.domain || undefined,
        login_hint: d.login_hint || undefined,
      };
      ls.set(K_INFO, JSON.stringify(info));
      setEnterpriseState({ info });
      return info;
    } catch (e: any) {
      // Сервер ответил, но такого раздела нет — обычная сборка мессенджера
      if (e?.response && (e.response.status === 404 || e.response.status === 405)) {
        const info: EnterpriseInfo = { enabled: false };
        ls.set(K_INFO, JSON.stringify(info));
        setEnterpriseState({ info });
        return info;
      }
      return state.info; // нет связи — как было
    }
  })().finally(() => { infoInflight = null; });
  return infoInflight;
}

// ── запуск ───────────────────────────────────────────────────
let started = false;
const ca = () => import('@/lib/enterprise-ca');

/**
 * Сервер назвал другой ключ УЦ, и человек решил ему доверять (УЦ
 * пересоздали). Только по явному согласию — как «новый ключ — принять?»
 * у собеседников LoRa. Сертификат и список отзыва берутся заново.
 */
export async function trustNewCa(): Promise<void> {
  ls.del(K_CA); ls.del(K_CRL); ls.del(K_CERT);
  setEnterpriseState({ caPub: null, caMismatch: false, cert: null, crlSeq: null, crlAt: null, revokedCount: 0, error: null });
  const m = await ca();
  m.startCa();
  await m.refreshNow();
}

/** Один раз при старте приложения (App.tsx). */
export function startEnterprise() {
  if (started) return;
  started = true;

  // Запомненное «контур включён» — сразу, без сети: список отзыва нужен
  // LoRa именно тогда, когда сервера не видно
  if (state.info?.enabled) ca().then(m => m.startCa()).catch(() => {});
  refreshEnterpriseInfo().then(i => { if (i?.enabled) return ca().then(m => m.startCa()); }).catch(() => {});

  // Вход (пароль, QR, регистрация — всё проходит через стор): выпустить
  // сертификат устройства. Выход: сертификат принадлежал учётке — убираем.
  useAuthStore.subscribe((s, prev) => {
    const uid = s.user?.id, puid = prev.user?.id;
    if (s.accessToken && uid && (!prev.accessToken || uid !== puid)) {
      refreshEnterpriseInfo()
        .then(i => { if (i?.enabled) return ca().then(m => { m.startCa(); return m.ensureDeviceCert(); }); })
        .catch(() => {});
    }
    if (!s.accessToken && prev.accessToken) {
      ls.del(K_CERT);
      setEnterpriseState({ cert: null });
    }
  });
}
