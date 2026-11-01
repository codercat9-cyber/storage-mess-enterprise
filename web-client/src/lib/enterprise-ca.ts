// =============================================================
// Корпоративный УЦ на устройстве: сертификат устройства и список отзыва.
// Подгружается из enterprise.ts, только если контур включён.
//
//   • Сертификат. После входа свой ключ LoRa (Ed25519, тот же, что
//     подписывает эфир, — sealer.ensureIdentity) уходит на подпись УЦ:
//     POST /api/enterprise/devices. Ответ проверяется (наш ли ключ, наша
//     ли учётка, подпись УЦ) и лежит в localStorage.
//   • Список отзыва (CRL) — при старте и раз в минуту. Подпись проверяем
//     ключом УЦ, закреплённым при первом получении: подменить УЦ молча
//     сервер (или тот, кто встал посередине) не может. Список старее уже
//     принятого не берём. Отозванные ключи уходят в sealer.setRevoked —
//     сообщения LoRa с ними помечаются «ключ отозван». Принятый список
//     лежит на устройстве: LoRa нужна как раз тогда, когда сервера нет.
//
// Подпись УЦ — Ed25519 над UTF-8 строкой JSON.stringify(cert | crl),
// ключи в порядке договора (certText / crlText).
// =============================================================

import { ed25519 } from '@noble/curves/ed25519';
import { enterpriseApi } from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { getDeviceFootprint } from '@/lib/device';
import { sealer } from '@/lib/lora';
import {
  DeviceCert, getEnterprise, setEnterpriseState, refreshEnterpriseInfo, toMs, ls, K_CA, K_CERT, K_CRL,
} from '@/lib/enterprise';

interface StoredCert { cert: DeviceCert; sig: string; ca_pub: string }
interface Crl { v: number; seq: number; issued_at: string | number; revoked: { ed_pub: string; at: string | number; reason?: string }[] }
interface StoredCrl { crl: Crl; sig: string; got_at: number }

const CRL_EVERY_MS = 60_000;
/** Сервер отказал в сертификате (например, локальная учётка) — не долбим каждую минуту. */
const REFUSED_PAUSE_MS = 10 * 60_000;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const unhex = (s: string) => Uint8Array.from(s.match(/../g) || [], x => parseInt(x, 16));
const enc = new TextEncoder();

// Строки, над которыми подписывал УЦ: ключи строго в порядке договора.
const certText = (c: DeviceCert) => JSON.stringify({
  v: c.v, user_id: c.user_id, username: c.username, ed_pub: c.ed_pub, issued_at: c.issued_at, expires_at: c.expires_at,
});
const crlText = (c: Crl) => JSON.stringify({
  v: c.v, seq: c.seq, issued_at: c.issued_at,
  revoked: (c.revoked || []).map(r => ({ ed_pub: r.ed_pub, at: r.at, reason: r.reason })),
});

/** Подпись УЦ верна? Сначала строка в порядке договора, потом — как пришло. */
function signedBy(texts: string[], sig: string, caPub: string): boolean {
  if (!HEX128.test(sig) || !HEX64.test(caPub)) return false;
  for (const t of texts) {
    try { if (ed25519.verify(unhex(sig), enc.encode(t), unhex(caPub))) return true; } catch { /* дальше */ }
  }
  return false;
}

/** Нет связи (запрос не дошёл) — не ошибка контура, просто ждём. */
const offline = (e: any) => !!e?.isAxiosError && !e?.response;

// ── ключ УЦ ──────────────────────────────────────────────────
/** Закрепить ключ УЦ при первом получении; потом — только сверять. */
function pinCa(caPub: string): boolean {
  const k = String(caPub || '').toLowerCase();
  if (!HEX64.test(k)) return false;
  const pinned = ls.get(K_CA);
  if (!pinned) {
    ls.set(K_CA, k);
    setEnterpriseState({ caPub: k, caMismatch: false });
    return true;
  }
  if (pinned !== k) {
    setEnterpriseState({ caMismatch: true });
    return false;
  }
  if (getEnterprise().caMismatch) setEnterpriseState({ caMismatch: false });
  return true;
}

// ── список отзыва ────────────────────────────────────────────
function applyCrl(c: Crl, gotAt: number) {
  const list = (c.revoked || []).map(r => String(r.ed_pub || '').toLowerCase()).filter(x => HEX64.test(x));
  sealer.setRevoked(list);
  setEnterpriseState({ crlSeq: Number(c.seq), crlAt: gotAt, revokedCount: list.length, selfRevoked: sealer.selfRevoked });
}

/** Принятый раньше список — сразу при старте, ещё до связи с сервером. */
function applyStoredCrl() {
  const s = ls.json<StoredCrl>(K_CRL);
  const ca = ls.get(K_CA);
  if (!s?.crl || !ca) return;
  // Перепроверяем: localStorage мог поменять кто угодно с доступом к устройству
  if (!signedBy([crlText(s.crl), JSON.stringify(s.crl)], s.sig, ca)) { ls.del(K_CRL); return; }
  applyCrl(s.crl, s.got_at || 0);
}

export async function refreshCrl(): Promise<void> {
  try {
    if (!ls.get(K_CA)) {
      const r = (await enterpriseApi.ca()).data;
      if (r?.alg && String(r.alg).toLowerCase() !== 'ed25519') throw new Error(`УЦ: неизвестный алгоритм ${r.alg}`);
      if (!pinCa(r?.ca_pub)) throw new Error('УЦ: сервер не назвал ключ');
    }
    const ca = ls.get(K_CA)!;
    const d = (await enterpriseApi.crl()).data;
    const crl: Crl | undefined = d?.crl;
    const sig = String(d?.sig || '').toLowerCase();
    if (!crl || typeof crl.seq !== 'number' || !Array.isArray(crl.revoked)) throw new Error('Список отзыва: непонятный ответ сервера');
    if (!signedBy([crlText(crl), JSON.stringify(crl)], sig, ca)) {
      // Подпись не сходится с закреплённым ключом — возможно, УЦ сменили. Сверим.
      try {
        const now = (await enterpriseApi.ca()).data?.ca_pub;
        if (now) pinCa(now);
      } catch { /* */ }
      throw new Error(getEnterprise().caMismatch
        ? 'Сервер назвал другой ключ УЦ, чем при первом знакомстве — список отзыва не принят'
        : 'Список отзыва: подпись УЦ не сходится — не принят');
    }
    const prev = ls.json<StoredCrl>(K_CRL);
    if (prev?.crl && crl.seq < prev.crl.seq) {
      throw new Error(`Список отзыва старее принятого (№${crl.seq} < №${prev.crl.seq}) — не принят`);
    }
    const now = Date.now();
    ls.set(K_CRL, JSON.stringify({ crl, sig, got_at: now } satisfies StoredCrl));
    applyCrl(crl, now);
    if (getEnterprise().caMismatch) setEnterpriseState({ caMismatch: false });
    if (/^(Список отзыва|УЦ|Сервер назвал)/.test(getEnterprise().error || '')) setEnterpriseState({ error: null });
  } catch (e: any) {
    if (offline(e)) return; // нет связи — держим прежний список, без шума
    // Раздела нет (сервер без контура) — тоже не ошибка устройства
    if (e?.response?.status === 404) return;
    setEnterpriseState({ error: e?.response?.data?.error ? `Список отзыва: ${e.response.data.error}` : (e?.message || String(e)) });
  }
}

// ── сертификат устройства ────────────────────────────────────
function loadCert(): StoredCert | null {
  const s = ls.json<StoredCert>(K_CERT);
  const ca = ls.get(K_CA);
  if (!s?.cert || !ca || s.ca_pub !== ca) return null;
  return signedBy([certText(s.cert), JSON.stringify(s.cert)], s.sig, ca) ? s : null;
}

/** Срок кончился или кончается: осталось меньше трети срока (но не больше 3 суток). */
function expiresSoon(c: DeviceCert, now = Date.now()): boolean {
  const from = toMs(c.issued_at), to = toMs(c.expires_at);
  if (!isFinite(to)) return false; // бессрочный
  const life = isFinite(from) ? Math.max(0, to - from) : 0;
  return to - now < Math.min(3 * 86400_000, life / 3);
}

async function deviceLabel(): Promise<string> {
  try {
    const f = await getDeviceFootprint();
    return [f.clientType, f.deviceModel, f.os].filter(Boolean).join(' · ').slice(0, 120);
  } catch { return navigator.userAgent.slice(0, 120); }
}

let enrolling: Promise<void> | null = null;
let refused: { key: string; at: number } | null = null;

/** После входа: у устройства должен быть действующий сертификат УЦ. */
export function ensureDeviceCert(): Promise<void> {
  if (enrolling) return enrolling;
  enrolling = (async () => {
    if (!getEnterprise().info?.enabled) return;
    const auth = useAuthStore.getState();
    const uid = auth.user?.id ? String(auth.user.id) : '';
    if (!auth.accessToken || !uid) return;

    sealer.ensureIdentity();
    // Ключ этого устройства уже отозван (учётку блокировали, потом вернули) —
    // со старым ключом эфир помечал бы каждое сообщение. Нужен новый.
    if (sealer.selfRevoked) sealer.rotateIdentity();
    const pub = sealer.publicKeyHex();

    const have = loadCert();
    if (have && String(have.cert.user_id) === uid && have.cert.ed_pub === pub && !expiresSoon(have.cert)) {
      if (getEnterprise().cert?.ed_pub !== pub) setEnterpriseState({ cert: have.cert, selfRevoked: sealer.selfRevoked });
      return;
    }
    const key = `${uid}:${pub}`;
    if (refused && refused.key === key && Date.now() - refused.at < REFUSED_PAUSE_MS) return;

    let d: any;
    try {
      d = (await enterpriseApi.enrollDevice(pub, await deviceLabel())).data;
    } catch (e: any) {
      if (e?.response) refused = { key, at: Date.now() };
      throw e;
    }
    const cert: DeviceCert | undefined = d?.cert;
    const sig = String(d?.sig || '').toLowerCase();
    const caPub = String(d?.ca_pub || '').toLowerCase();
    if (!cert || String(cert.ed_pub).toLowerCase() !== pub) throw new Error('УЦ подписал не наш ключ');
    if (String(cert.user_id) !== uid) throw new Error('выдан на другую учётку');
    if (!pinCa(caPub)) throw new Error('ключ УЦ не совпадает с закреплённым на устройстве');
    if (!signedBy([certText(cert), JSON.stringify(cert)], sig, caPub)) throw new Error('подпись УЦ не сходится');
    ls.set(K_CERT, JSON.stringify({ cert, sig, ca_pub: caPub } satisfies StoredCert));
    refused = null;
    const err = getEnterprise().error;
    setEnterpriseState({ cert, selfRevoked: sealer.selfRevoked, ...(err?.startsWith('Сертификат') ? { error: null } : {}) });
  })().catch((e: any) => {
    if (offline(e)) return; // нет связи — повторим на следующем круге, без красной строки
    setEnterpriseState({ error: `Сертификат устройства: ${e?.response?.data?.error || e?.message || String(e)}` });
  }).finally(() => { enrolling = null; });
  return enrolling;
}

// ── запуск ───────────────────────────────────────────────────
let timer: ReturnType<typeof setInterval> | null = null;

async function tick() {
  const info = await refreshEnterpriseInfo();
  if (!info?.enabled) return;
  await refreshCrl();
  if (useAuthStore.getState().accessToken) await ensureDeviceCert();
}

/** Сразу, не дожидаясь минуты (после смены ключа УЦ). */
export const refreshNow = () => tick();

/** Запускается из enterprise.ts; повторный вызов ничего не делает. */
export function startCa() {
  if (timer) return;
  // Что известно с прошлого раза — сразу, без сети
  applyStoredCrl();
  const u = useAuthStore.getState().user;
  const have = loadCert();
  if (have && u?.id && String(have.cert.user_id) === String(u.id)) setEnterpriseState({ cert: have.cert });

  tick().catch(() => {});
  timer = setInterval(() => { tick().catch(() => {}); }, CRL_EVERY_MS);
}
