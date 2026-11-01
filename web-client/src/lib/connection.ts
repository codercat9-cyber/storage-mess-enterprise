// =====================================================================
// Connection Manager v3 — MILITARY-GRADE ultra-resilient connectivity
//
// Цель: достучаться до сервера ЛЮБОЙ ценой, даже из канализации.
//
// Стратегия:
//   Phase 0: Мгновенный — проверяем кэшированный URL (100ms)
//   Phase 1: Blitz — гонка ALL URLs параллельно с micro-timeout (3s)
//   Phase 2: Extended — retry отдельно каждый URL (5s timeout)
//   Phase 3: DNS bypass — DoH resolve + direct IP connect
//   Phase 4: Relay discovery — DNS TXT relay lookup
//   Phase ∞: Auto-reconnect с exponential backoff + jitter
//
// Принципы:
//   - Parallel-first: все проверки параллельно
//   - Micro-timeouts: 3s blitz, 6s extended
//   - Exponential backoff с jitter: 2→15 сек max
//   - Cached winner: рабочий URL перепроверяется за 1.5s
//   - Network change aware: мгновенный re-resolve при смене сети
// =====================================================================

// ─── Жёстко вшитые URL подключения ───
// Env переменные — только для переопределения при dev/тестах, иначе хардкод.
const PRIMARY_URL = import.meta.env.VITE_PRIMARY_URL || 'https://messenger.example.org';
// Тот же сервер по адресу напрямую, но ПО-ПРЕЖНЕМУ ПОД ШИФРОВАНИЕМ.
//
// Нужен, когда имя не разрешается или режется по имени: адрес обходит эту
// беду, а разговор остаётся закрытым.
// Запасное имя с настоящей подписью — второй кандидат после основного.
//
// Стоит ВЫШЕ адресов намеренно. По адресу сервер отдаёт собственный
// сертификат, и браузер на нём показывает красный экран: страница не
// может приказать ему доверять ключу, такого права у неё нет. А здесь
// подпись обычная, от Let's Encrypt, и переход происходит молча. Имя
// живёт у другого поставщика и в другой зоне — это не та строка, по
// которой нас режут.
const BACKUP_NAME_URL = import.meta.env.VITE_BACKUP_NAME_URL || 'https://backup.example.org';
const DIRECT_TLS_URL = import.meta.env.VITE_DIRECT_TLS_URL || 'https://203.0.113.10';
// Запасной путь БЕЗ шифрования. По нему видно всё: и переписку, и отметки
// времени, и опознавательные ключи. Поэтому он идёт последним и только
// тогда, когда шифрованные пути не прошли вовсе.
const FALLBACK_URL = import.meta.env.VITE_FALLBACK_URL || 'http://203.0.113.10:8080';
const LOCAL_URL = import.meta.env.VITE_LOCAL_URL || 'http://192.168.1.10:8080';

// === Пользовательский URL (VPN / кастомный сервер) ===
// Если задан — пробуется ПЕРВЫМ, до PRIMARY_URL
function getCustomServerUrl(): string {
  try { return localStorage.getItem('sm_custom_server_url') || ''; } catch { return ''; }
}

export function setCustomServerUrl(url: string): void {
  try {
    if (url.trim()) {
      localStorage.setItem('sm_custom_server_url', url.trim());
    } else {
      localStorage.removeItem('sm_custom_server_url');
    }
    // Сбрасываем кэш — при следующем resolve пойдёт по новой цепочке
    resetConnection();
  } catch {}
}

export function getCustomServerUrlValue(): string {
  return getCustomServerUrl();
}

// === Адреса, найденные оболочкой настольного клиента ===
//
// Страница живёт по правилам браузера: она не может постучаться в голый
// TCP-порт, не видит разницы между «сети нет» и «порт режут», ходит через
// системный прокси. Оболочка настольного клиента всего этого не ограничена
// и ищет сервер своими средствами — а сюда передаёт то, что нашла.
//
// Держим в памяти, а не в хранилище: при следующем запуске оболочка
// поищет заново, и вчерашняя находка только помешает.
let shellDiscoveredUrls: string[] = [];

export function setShellDiscoveredUrls(urls: string[]): void {
  const fresh = urls.filter(Boolean);
  const changed = fresh.join('|') !== shellDiscoveredUrls.join('|');
  shellDiscoveredUrls = fresh;

  // Нашлась дорога лучше текущей — переопределяемся, не дожидаясь, пока
  // человек упрётся в неработающий мессенджер.
  if (changed && fresh.length > 0 && resolvedBaseUrl && !fresh.includes(resolvedBaseUrl)) {
    console.log('[оболочка] адреса обновились, определяюсь заново:', fresh.join(', '));
    resetConnection();
    void resolveServerUrl();
  }
}

// === Relay-серверы для обхода белых списков ТСПУ ===
// Relay на российском VPS (IP в русском диапазоне → не блокируется ТСПУ)
// Relay просто проксирует все запросы (HTTP + WebSocket) к основному серверу
// Также подходят: Cloudflare Worker, Yandex Cloud Function, DDoS-Guard CDN
const BUILTIN_RELAY_URLS: string[] = [
  // Вшить URL relay-серверов сюда после деплоя:
  // 'https://relay1.yourdomain.ru',
  // 'https://your-worker.workers.dev',
];

function getRelayUrls(): string[] {
  const envRelays = import.meta.env.VITE_RELAY_URLS;
  const fromEnv = envRelays
    ? String(envRelays).split(',').map(s => s.trim()).filter(Boolean)
    : [];
  try {
    const stored = localStorage.getItem('sm_relay_urls');
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) return [...BUILTIN_RELAY_URLS, ...fromEnv, ...parsed];
    }
  } catch {}
  return [...BUILTIN_RELAY_URLS, ...fromEnv];
}

export function setRelayUrls(urls: string[]): void {
  try {
    localStorage.setItem('sm_relay_urls', JSON.stringify(urls));
    resetConnection();
  } catch {}
}

export function getRelayUrlsValue(): string[] {
  return getRelayUrls();
}

// Кэш рабочего URL (для текущей сессии)
let resolvedBaseUrl: string | null = null;
let resolvedApiUrl: string | null = null;
let isResolving = false;
let resolvePromise: Promise<string> | null = null;

// === Состояние сети (IPv4/IPv6 fallback) ===
export type NetworkProtocol = 'ipv4' | 'unknown';
export type NetworkStatus = 'connected' | 'disconnected' | 'reconnecting' | 'syncing';

interface NetworkState {
  status: NetworkStatus;
  protocol: NetworkProtocol;
  ipv4Available: boolean;
  lastError: string | null;
  failedAt: Date | null;
  recoveredAt: Date | null;
}

let networkState: NetworkState = {
  status: 'connected',
  protocol: 'ipv4',
  ipv4Available: true,
  lastError: null,
  failedAt: null,
  recoveredAt: null,
};

// Слушатели изменения состояния сети
type NetworkListener = (state: NetworkState) => void;
const networkListeners: Set<NetworkListener> = new Set();

export function onNetworkStateChange(listener: NetworkListener): () => void {
  networkListeners.add(listener);
  // Сразу отдаём текущее состояние
  listener(networkState);
  return () => networkListeners.delete(listener);
}

function notifyNetworkListeners() {
  networkListeners.forEach(fn => fn({ ...networkState }));
}

function updateNetworkState(patch: Partial<NetworkState>) {
  networkState = { ...networkState, ...patch };
  notifyNetworkListeners();
}

export function getNetworkState(): NetworkState {
  return { ...networkState };
}

/**
 * Проверить доступность сервера по URL
 * ВОЕННЫЙ УРОВЕНЬ: micro-timeout, no-cors fallback, connection reuse hints
 */
async function checkServer(baseUrl: string, timeoutMs = 4000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(`${baseUrl}/api/health`, {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
      // keepalive hint — переиспользование TCP
      keepalive: true,
    });

    clearTimeout(timer);
    if (!response.ok) return false;

    // Кода 200 НЕДОСТАТОЧНО. В APK интерфейс живёт на https://localhost,
    // и локальный сервер Capacitor на любой неизвестный путь отдаёт
    // index.html с кодом 200. Проверка проходила, причём мгновенно, и
    // этот кандидат выигрывал гонку у настоящего сервера всегда. Дальше
    // все запросы, включая вход, уходили в собственные ассеты и получали
    // HTML вместо JSON — «ошибка входа» при полностью исправном сервере.
    //
    // Поэтому убеждаемся, что ответил именно наш API: JSON со
    // status: 'ok'. Страница-заглушка такого ответа дать не может.
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) return false;
    const body = await response.json().catch(() => null);
    return body?.status === 'ok';
  } catch {
    return false;
  }
}

/**
 * Быстрый HEAD check — ещё быстрее чем GET health
 * Для мгновенной проверки кэшированного URL
 */
async function quickCheck(baseUrl: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`${baseUrl}/api/health`, {
      method: 'HEAD',
      signal: controller.signal,
      cache: 'no-store',
    });
    clearTimeout(timer);
    if (!response.ok) return false;
    // Тот же подвох, что и в checkServer: локальный сервер приложения
    // отвечает 200 на что угодно. Тела у HEAD нет, поэтому смотрим тип
    // содержимого — страница-заглушка отдаёт text/html.
    const contentType = response.headers.get('content-type') || '';
    return contentType.includes('application/json');
  } catch {
    return false;
  }
}

// =============================================================================
// DNS-over-HTTPS (DoH) — обход DNS-блокировок ТСПУ
// Если ISP-шный DNS не резолвит домен (перехват/подмена), доходим через DoH.
// =============================================================================

const DOH_PROVIDERS = [
  // Яндекс DoH — ПЕРВЫЙ! Гарантированно в белом списке ТСПУ (российский сервис)
  'https://common.dot.dns.yandex.net/dns-query',
  'https://dns.google/resolve',           // Google DoH (JSON API)
  'https://cloudflare-dns.com/dns-query',  // Cloudflare DoH (JSON API)
  'https://dns.quad9.net:5053/dns-query',  // Quad9 DoH
];

/**
 * Резолвит домен через DNS-over-HTTPS.
 * Возвращает IP-адрес или null если не удалось.
 * Пробует несколько DoH-провайдеров параллельно (race).
 */
async function resolveDomainViaDoH(domain: string): Promise<string | null> {
  // Если это уже IP — возвращаем как есть
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(domain)) return domain;
  if (domain.startsWith('[')) return null; // IPv6 literal

  const doResolve = async (providerUrl: string): Promise<string | null> => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);

      const sep = providerUrl.includes('?') ? '&' : '?';
      const url = `${providerUrl}${sep}name=${encodeURIComponent(domain)}&type=A`;
      
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/dns-json' },
        signal: controller.signal,
        cache: 'no-store',
      });
      clearTimeout(timer);

      if (!response.ok) return null;
      const data = await response.json();
      
      // RFC 8484 JSON format: data.Answer[].data
      const answers = data.Answer || [];
      const aRecord = answers.find((a: any) => a.type === 1); // type 1 = A record
      if (aRecord && aRecord.data) {
        console.log(`[DoH] Resolved ${domain} → ${aRecord.data} via ${new URL(providerUrl).hostname}`);
        return aRecord.data;
      }
    } catch {
      // Этот DoH-провайдер недоступен
    }
    return null;
  };

  // Race: кто первый резолвит — тот и победил
  // Используем Promise.race с обёрткой (Promise.any не во всех таргетах)
  try {
    const promises = DOH_PROVIDERS.map(p =>
      doResolve(p).then(ip => {
        if (ip) return ip;
        return null;
      }).catch(() => null)
    );
    // Ждём все, берём первый непустой
    const results = await Promise.all(promises);
    const firstGood = results.find(r => r !== null);
    if (firstGood) return firstGood;
  } catch {}
  console.warn('[DoH] All DoH providers failed for', domain);
  return null;
}

/**
 * Поиск relay-серверов через DNS TXT записи.
 * Юзер добавляет DNS запись: _relay.messenger.example.org TXT "relay=https://relay1.example.ru"
 * APK автоматически находит новые relay даже если основной сервер заблокирован.
 * DNS TXT можно обновить за минуту — клиенты узнают новый relay без обновления APK.
 */
async function discoverRelaysViaDnsTxt(domain: string): Promise<string[]> {
  const relays: string[] = [];
  for (const provider of DOH_PROVIDERS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const sep = provider.includes('?') ? '&' : '?';
      const url = `${provider}${sep}name=_relay.${encodeURIComponent(domain)}&type=TXT`;
      const resp = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/dns-json' },
        signal: controller.signal,
        cache: 'no-store',
      });
      clearTimeout(timer);
      if (!resp.ok) continue;
      const data = await resp.json();
      for (const record of (data.Answer || [])) {
        if (record.type === 16 && record.data) {
          const txt = String(record.data).replace(/^"|"$/g, '');
          if (txt.startsWith('relay=')) {
            const relayUrl = txt.slice(6).trim();
            if (relayUrl.startsWith('https://')) relays.push(relayUrl);
          }
        }
      }
      if (relays.length > 0) break;
    } catch {}
  }
  if (relays.length > 0) console.log(`[DNS TXT] Discovered ${relays.length} relay(s) for ${domain}`);
  return relays;
}

/**
 * Локальный ли это адрес (домашняя сеть, сам телефон).
 *
 * Такие адреса значат РАЗНОЕ в разных сетях: 192.168.1.10 дома — это
 * машина с сервером, а в городе — либо ничего, либо чужой роутер.
 * Поэтому их нельзя ни запоминать как «последний рабочий», ни
 * подставлять без проверки.
 */
function isPrivateHost(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    if (h === 'localhost' || h.endsWith('.local')) return true;
    if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
    if (/^169\.254\./.test(h)) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * BLITZ гонка серверов — кто первый ответит, тот победил.
 * Запускает ВСЕ проверки одновременно.
 * Staggered start: каждый следующий кандидат стартует с задержкой 100ms
 * (даёт преимущество первому кандидату, но не блокирует остальных)
 */
async function raceCheckServers(
  candidates: Array<{ url: string; protocol: NetworkProtocol }>,
  timeoutMs = 4000
): Promise<{ url: string; protocol: NetworkProtocol } | null> {
  if (candidates.length === 0) return null;

  return new Promise<{ url: string; protocol: NetworkProtocol } | null>(resolve => {
    let resolved = false;
    let remaining = candidates.length;
    const globalTimer = setTimeout(() => {
      if (!resolved) { resolved = true; resolve(null); }
    }, timeoutMs + 500); // hard deadline

    candidates.forEach((candidate, idx) => {
      // Staggered: каждый следующий кандидат стартует через 50ms
      // Первый (обычно PRIMARY) получает фору
      setTimeout(() => {
        if (resolved) return;
        checkServer(candidate.url, timeoutMs).then(ok => {
          if (ok && !resolved) {
            resolved = true;
            clearTimeout(globalTimer);
            resolve(candidate);
          }
          remaining--;
          if (remaining === 0 && !resolved) {
            resolved = true;
            clearTimeout(globalTimer);
            resolve(null);
          }
        }).catch(() => {
          remaining--;
          if (remaining === 0 && !resolved) {
            resolved = true;
            clearTimeout(globalTimer);
            resolve(null);
          }
        });
      }, idx * 50);
    });
  });
}

/**
 * Определить рабочий URL сервера
 * Пробует PRIMARY → FALLBACK → window.location.origin
 */
export async function resolveServerUrl(): Promise<string> {
  // Если уже определили — возвращаем кэш
  if (resolvedBaseUrl) return resolvedBaseUrl;

  // Если уже идёт определение — ждём результат
  if (isResolving && resolvePromise) return resolvePromise;

  isResolving = true;
  resolvePromise = doResolve();

  const result = await resolvePromise;
  isResolving = false;
  resolvePromise = null;

  return result;
}

// Корпоративный сервер раздаёт свой веб-клиент сам, и такой сборке нужен
// только свой адрес (VITE_SAME_ORIGIN=1): ни общих серверов мессенджера, ни
// запасных путей — переписка организации не уходит за её периметр. Явный
// «Свой сервер» (APK, десктоп) по-прежнему главнее.
const SAME_ORIGIN = import.meta.env.VITE_SAME_ORIGIN === '1';

async function doResolve(): Promise<string> {
  if (SAME_ORIGIN && typeof window !== 'undefined' && !getCustomServerUrl() &&
      /^https?:/.test(window.location.origin)) {
    resolvedBaseUrl = window.location.origin;
    resolvedApiUrl = `${resolvedBaseUrl}/api`;
    return resolvedBaseUrl;
  }
  const candidates: Array<{ url: string; protocol: NetworkProtocol }> = [];

  // Убрано "Android WebView Fast Path", так как теперь Android всегда грузится
  // из локальных ассетов мгновенно. Нам нужно реально проверять доступность сервера.
  const currentOrigin = typeof window !== 'undefined' ? window.location.origin : '';

  // Кастомный URL (VPN / ручная настройка) — ПЕРВЫЙ
  const customUrl = getCustomServerUrl();
  if (customUrl) candidates.push({ url: customUrl, protocol: 'ipv4' });

  // Найденное оболочкой — сразу за волей пользователя. Эти адреса уже
  // проверены на живость средствами, которых у страницы нет, так что
  // пробовать их раньше общего списка — экономия времени на запуске.
  for (const url of shellDiscoveredUrls) {
    if (!candidates.some(c => c.url === url)) candidates.push({ url, protocol: 'ipv4' });
  }

  // IPv4 кандидаты
  if (PRIMARY_URL) candidates.push({ url: PRIMARY_URL, protocol: 'ipv4' });
  // Запасное имя идёт сразу за основным: в браузере это единственный
  // запасной путь, который не упирается в предупреждение о сертификате.
  if (BACKUP_NAME_URL) candidates.push({ url: BACKUP_NAME_URL, protocol: 'ipv4' });
  // Сначала шифрованный путь по адресу, и только потом открытый.
  //
  // Раньше сразу за доменом шёл незашифрованный запасной порт: стоило
  // домену не ответить — и всё общение уходило открытым текстом, хотя
  // тот же сервер прекрасно отвечал по адресу под шифрованием.
  if (DIRECT_TLS_URL) candidates.push({ url: DIRECT_TLS_URL, protocol: 'ipv4' });
  if (FALLBACK_URL) candidates.push({ url: FALLBACK_URL, protocol: 'ipv4' });
  if (LOCAL_URL) candidates.push({ url: LOCAL_URL, protocol: 'ipv4' });

  // window.location.origin — только в браузере, где origin И ЕСТЬ сервер.
  // В APK это https://localhost, то есть собственные ассеты приложения:
  // сервером они не являются никогда. Проверки содержимого в checkServer
  // уже достаточно, но заведомо неверный кандидат всё равно тратит время
  // гонки, а на плохой связи каждая секунда заметна.
  // Оболочка приложения, а не сайт.
  //
  // Кроме APK сюда попал и настольный клиент: он раздаёт интерфейс сам себе
  // по адресу вида http://127.0.0.1:38133. Прежняя проверка знала только
  // слово «localhost», поэтому настольный клиент честно добавлял САМОГО СЕБЯ
  // в список серверов, выигрывал гонку (свой же адрес отвечает мгновенно) и
  // отправлял туда вход. В ответ приходил HTML вместо данных — человек видел
  // «Ошибка входа» с правильным паролем.
  const isLoopbackOrigin =
    /^https?:\/\/(localhost|127(\.\d+){3}|\[::1\])(:\d+)?$/i.test(currentOrigin);
  const isNativeShell =
    typeof window !== 'undefined' &&
    (Boolean((window as any).Capacitor?.isNativePlatform?.()) ||
      isLoopbackOrigin ||
      /Electron/i.test(navigator.userAgent) ||
      currentOrigin.startsWith('capacitor://'));

  if (currentOrigin && !currentOrigin.startsWith('file:') && !isNativeShell &&
      !candidates.some(c => c.url === currentOrigin)) {
    candidates.push({ url: currentOrigin, protocol: 'ipv4' });
  }

  // Relay серверы — добавляем сразу в основной пул
  const relays = getRelayUrls();
  for (const relayUrl of relays) {
    if (relayUrl && !candidates.some(c => c.url === relayUrl)) {
      candidates.push({ url: relayUrl, protocol: 'ipv4' });
    }
  }

  const ipv4Candidates = [...candidates];

  // === Phase 0: Мгновенная проверка кэшированного URL ===
  // Если раньше работал конкретный URL — отдаём его сразу и проверяем в фоне
  // Кэш локального адреса НЕ подставляем: он верен только в той сети,
  // где был записан. Именно это ломало вход в городе — приложение
  // возвращало запомненный 192.168.1.10 мгновенно и без проверки, и
  // пользователь жал «Войти» раньше, чем фоновая проверка успевала
  // понять, что адреса нет. Дома локальный сервер всё равно найдётся —
  // просто ярусом ниже, после домена и внешнего адреса.
  const cached = getLastGoodUrl();

  // Внешний адрес цифрами из кэша ПОДСТАВЛЯЕМ, как и домен.
  //
  // Была попытка отсекать любой адрес цифрами — на том основании, что
  // внешний IP якобы сменился и старый мёртв. Основание оказалось ложным:
  // проверка делалась с машины, которая ходит через туннель Karing, а
  // сервер ходит мимо него по группе novpn. Изнутри туннеля внешний адрес
  // не отвечает и выглядит как чужой — отсюда и ошибочный вывод.
  //
  // На самом деле 203.0.113.10 — рабочий адрес провайдера, и для тех, у
  // кого домен режут, это ЕДИНСТВЕННЫЙ путь к серверу. Отсекать его из
  // быстрого пути значит замедлять запуск именно там, где связь и так
  // плохая. Отсекаем по-прежнему только локальные адреса: они верны
  // ровно в той сети, где записаны, и именно они ломали вход в городе.
  if (cached && isPrivateHost(cached)) {
    console.log(`↩️ Phase 0: пропускаю локальный кэш ${cached} — проверю по порядку`);
    try { localStorage.removeItem('sm_last_good_url'); } catch {}
  }
  const lastGoodUrl = cached && !isPrivateHost(cached) ? cached : '';
  if (lastGoodUrl) {
    console.log(`⚡ Phase 0: Quick-return last good URL: ${lastGoodUrl}`);
    
    // Мгновенно переключаем в syncing, чтобы UI не блокировался
    updateNetworkState({
      status: 'syncing',
      protocol: 'ipv4',
      ipv4Available: true,
      lastError: null,
      recoveredAt: null,
    });
    
    resolvedBaseUrl = lastGoodUrl;
    resolvedApiUrl = `${lastGoodUrl}/api`;
    
    // Фоновая проверка (3.5s)
    quickCheck(lastGoodUrl, 3500).then(quick => {
      if (quick) {
        console.log(`✅ Phase 0: Last good URL still works!`);
        setResolved(lastGoodUrl, 'ipv4');
        window.dispatchEvent(new CustomEvent('server-recovered'));
      } else {
        console.warn(`⚠️ Phase 0: Last good URL failed, starting deep resolve`);
        try { localStorage.removeItem('sm_last_good_url'); } catch {}
        resetConnection();
        resolveServerUrl();
      }
    });
    
    return lastGoodUrl;
  }

  // === Быстрый выход при оффлайне ===
  const isOffline = (typeof navigator !== 'undefined' && !navigator.onLine) ||
                    (typeof window !== 'undefined' && window.location.protocol === 'file:');
  if (isOffline) {
    console.warn('📴 Device is offline');
    // В APK origin — собственные ассеты, а не сервер: как запасной
    // адрес он бесполезен и лишь маскирует потерю связи под успех.
    const originFallback = isNativeShell ? '' : currentOrigin;
    const fallbackUrl = originFallback || (candidates.length > 0 ? candidates[0].url : PRIMARY_URL);
    resolvedBaseUrl = fallbackUrl;
    resolvedApiUrl = `${fallbackUrl}/api`;
    updateNetworkState({
      status: 'disconnected', protocol: 'unknown',
      ipv4Available: false,
      lastError: 'Device is offline', failedAt: new Date(),
    });
    startAutoReconnect(candidates);
    return resolvedBaseUrl;
  }

  if (candidates.length === 0) {
    resolvedBaseUrl = (isNativeShell ? '' : currentOrigin) || PRIMARY_URL;
    resolvedApiUrl = `${resolvedBaseUrl}/api`;
    return resolvedBaseUrl;
  }

  // === Phase 1: ПО ПОРЯДКУ, а не наперегонки ===
  //
  // Раньше здесь была общая гонка всех адресов с форой в 50 мс первому.
  // Форы не хватало никогда: дома локальный 192.168.1.10 отвечает за
  // пару миллисекунд, а домен через интернет — за десятки. Локальный
  // адрес выигрывал ВСЕГДА, записывался как «последний рабочий» — и
  // назавтра в городе приложение било в него и не пускало войти.
  //
  // Порядок теперь жёсткий и по смыслу, а не по скорости:
  //   1) заданный вручную адрес — воля пользователя выше всего;
  //   2) домен messenger.example.org — основной путь откуда угодно;
  //   3) внешний адрес роутера — если с доменом беда (DNS, блокировка);
  //   4) локальная сеть и всё остальное — только когда снаружи никак.
  // Внутри яруса гонка остаётся: там адреса равнозначны.
  const tiers: Array<{ name: string; urls: typeof ipv4Candidates; timeout: number }> = [];
  const used = new Set<string>();
  const takeTier = (name: string, match: (u: string) => boolean, timeout: number) => {
    const urls = ipv4Candidates.filter(c => !used.has(c.url) && match(c.url));
    urls.forEach(c => used.add(c.url));
    if (urls.length) tiers.push({ name, urls, timeout });
  };

  takeTier('заданный вручную', u => Boolean(customUrl) && u === customUrl, 4000);
  // Открытый путь выносим в самый конец очереди проверок: он должен
  // использоваться, только когда ни один закрытый не прошёл.
  const незашифрованный = (u: string) => u.startsWith('http://');
  // Оболочка уже убедилась, что по этим адресам отвечает именно наш сервер,
  // поэтому им хватает короткого срока ожидания.
  takeTier('найдено оболочкой', u => shellDiscoveredUrls.includes(u), 3000);
  takeTier('домен', u => u === PRIMARY_URL, 5000);
  takeTier('внешний адрес', u => !isPrivateHost(u) && !незашифрованный(u), 5000);
  takeTier('локальная сеть', u => !незашифрованный(u), 4000);
  takeTier('без шифрования (последняя надежда)', () => true, 4000);

  for (const tier of tiers) {
    console.log(`🔎 Phase 1: пробую «${tier.name}» — ${tier.urls.map(u => u.url).join(', ')}`);
    const winner = await raceCheckServers(tier.urls, tier.timeout);
    if (winner) {
      console.log(`✅ Phase 1: отвечает ${winner.url} (${tier.name})`);
      return setResolved(winner.url, winner.protocol);
    }
  }

  // === Phase 2: Extended — гонка с увеличенным таймаутом (12 сек) ===
  // 12s: достаточно даже для медленного VPN через ТСПУ
  console.log(`⏳ Phase 2: Extended race (12s)...`);
  const extWinner = await raceCheckServers(ipv4Candidates, 12000);
  if (extWinner) {
    console.log(`✅ Phase 2: Extended winner: ${extWinner.url}`);
    return setResolved(extWinner.url, extWinner.protocol);
  }

  // === Phase 3: DNS-over-HTTPS bypass ===
  console.log('🛡️ Phase 3: DNS-over-HTTPS bypass...');
  try {
    const primaryHostname = new URL(PRIMARY_URL).hostname;
    const dohIp = await resolveDomainViaDoH(primaryHostname);
    if (dohIp) {
      const dohUrl = `https://${dohIp}`;
      const dohAvailable = await checkServer(dohUrl, 5000);
      if (dohAvailable) {
        console.log(`✅ Phase 3: DoH bypass → ${dohIp}`);
        return setResolved(dohUrl, 'ipv4');
      }
    }
  } catch (err) {
    console.warn('[DoH] Failed:', err);
  }

  // === Phase 4: Relay Discovery через DNS TXT ===
  console.log('🛡️ Phase 4: Relay discovery via DNS TXT...');
  try {
    const primaryHostname = new URL(PRIMARY_URL).hostname;
    const discoveredRelays = await discoverRelaysViaDnsTxt(primaryHostname);
    if (discoveredRelays.length > 0) {
      const relayCandidates = discoveredRelays.map(url => ({ url, protocol: 'ipv4' as NetworkProtocol }));
      const relayWinner = await raceCheckServers(relayCandidates, 5000);
      if (relayWinner) {
        console.log(`✅ Phase 4: Relay → ${relayWinner.url}`);
        return setResolved(relayWinner.url, 'ipv4');
      }
    }
  } catch (err) {
    console.warn('[Relay Discovery] Failed:', err);
  }

  // === Phase FAIL: всё мертво ===
  resolvedBaseUrl = (isNativeShell ? '' : currentOrigin) || candidates[0]?.url || PRIMARY_URL;
  resolvedApiUrl = `${resolvedBaseUrl}/api`;
  console.error('🚨 ALL PHASES FAILED — total blackout');
  updateNetworkState({
    status: 'disconnected', protocol: 'unknown',
    ipv4Available: false,
    lastError: 'All servers unreachable (IPv4 + DoH + Relay)',
    failedAt: new Date(),
  });

  // Агрессивный авто-реконнект
  startAutoReconnect(candidates);
  return resolvedBaseUrl;
}

// Сохраняем последний рабочий URL для мгновенного реконнекта
function saveLastGoodUrl(url: string): void {
  // Локальные адреса не запоминаем вовсе. Запомненный домашний адрес
  // — это сломанный вход на следующий день в городе, а выигрыш от него
  // нулевой: дома он и так находится за доли секунды.
  if (isPrivateHost(url)) {
    try { localStorage.removeItem('sm_last_good_url'); } catch {}
    return;
  }
  try { localStorage.setItem('sm_last_good_url', url); } catch {}
}
function getLastGoodUrl(): string {
  try { return localStorage.getItem('sm_last_good_url') || ''; } catch { return ''; }
}

// Хелпер: выставить resolved URL + обновить состояние
function setResolved(url: string, protocol: NetworkProtocol): string {
  resolvedBaseUrl = url;
  resolvedApiUrl = `${url}/api`;
  saveLastGoodUrl(url);

  // === ПРОКИДЫВАЕМ ОБХОД ТСПУ В ANDROID ===
  // Чтобы фоновый сервис push-уведомлений тоже знал новый рабочий URL
  if (typeof window !== 'undefined' && 'AndroidBridge' in window) {
    try {
      (window as any).AndroidBridge.updateServerUrl(url);
    } catch (e) {
      console.warn('Failed to update native server URL', e);
    }
  }

  updateNetworkState({
    status: 'connected',
    protocol,
    ipv4Available: protocol === 'ipv4',
    lastError: null,
    recoveredAt: new Date(),
  });
  startHealthCheck();
  return resolvedBaseUrl;
}

// === АГРЕССИВНЫЙ авто-реконнект с exponential backoff + jitter ===
let autoReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;

function startAutoReconnect(candidates: Array<{ url: string; protocol: NetworkProtocol }>) {
  if (autoReconnectTimer) return;

  console.log('🔄 Starting aggressive auto-reconnect...');
  reconnectAttempt = 0;
  scheduleNextReconnect(candidates);
}

function scheduleNextReconnect(candidates: Array<{ url: string; protocol: NetworkProtocol }>) {
  reconnectAttempt++;
  // Exponential backoff: 2→3→5→8→12→15 sec, max 15 sec
  // Plus random jitter ±30% (предотвращает thundering herd)
  const baseDelay = Math.min(2000 * Math.pow(1.4, reconnectAttempt - 1), 15000);
  const jitter = baseDelay * (0.7 + Math.random() * 0.6); // 70-130% of base
  const delay = Math.round(jitter);

  autoReconnectTimer = setTimeout(async () => {
    autoReconnectTimer = null;

    console.log(`🔄 Reconnect #${reconnectAttempt} (delay was ${delay}ms)...`);
    updateNetworkState({ status: 'reconnecting' });

    // Blitz race всех кандидатов
    const timeout = Math.min(3000 + reconnectAttempt * 500, 8000);
    const winner = await raceCheckServers(candidates, timeout);
    if (winner) {
      console.log(`🎉 Reconnected: ${winner.url}`);
      reconnectAttempt = 0;
      setResolved(winner.url, winner.protocol);
      window.dispatchEvent(new CustomEvent('server-recovered'));
      return;
    }

    // Каждую 2ю попытку — DoH bypass (чаще чем раньше)
    if (reconnectAttempt % 2 === 0) {
      try {
        const primaryHostname = new URL(PRIMARY_URL).hostname;
        const dohIp = await resolveDomainViaDoH(primaryHostname);
        if (dohIp) {
          const dohUrl = `https://${dohIp}`;
          const ok = await checkServer(dohUrl, timeout);
          if (ok) {
            console.log(`🎉 DoH reconnect via ${dohIp}`);
            reconnectAttempt = 0;
            setResolved(dohUrl, 'ipv4');
            window.dispatchEvent(new CustomEvent('server-recovered'));
            return;
          }
        }
      } catch {}
    }

    // Каждую 3ю — relay discovery
    if (reconnectAttempt % 3 === 0) {
      try {
        const primaryHostname = new URL(PRIMARY_URL).hostname;
        const discoveredRelays = await discoverRelaysViaDnsTxt(primaryHostname);
        if (discoveredRelays.length > 0) {
          const relayResult = await raceCheckServers(
            discoveredRelays.map(url => ({ url, protocol: 'ipv4' as NetworkProtocol })),
            timeout
          );
          if (relayResult) {
            console.log(`🎉 Relay reconnect via ${relayResult.url}`);
            reconnectAttempt = 0;
            setResolved(relayResult.url, 'ipv4');
            window.dispatchEvent(new CustomEvent('server-recovered'));
            return;
          }
        }
      } catch {}
    }

    // Не нашли — продолжаем retry
    scheduleNextReconnect(candidates);
  }, delay);
}

function stopAutoReconnect() {
  if (autoReconnectTimer) {
    clearTimeout(autoReconnectTimer);
    autoReconnectTimer = null;
  }
  reconnectAttempt = 0;
}

// Мгновенный реконнект при смене состояния сети
if (typeof window !== 'undefined') {
  window.addEventListener('native-network-change', (e: any) => {
    const isOnline = e.detail?.online;
    if (isOnline) {
      console.log('🌐 Native Network ONLINE — instant re-resolve...');
      stopAutoReconnect();
      resetConnection();
      resolveServerUrl();
    } else {
      console.log('📴 Native Network OFFLINE');
      updateNetworkState({
        status: 'disconnected', protocol: 'unknown',
        ipv4Available: false,
        lastError: 'Network offline', failedAt: new Date(),
      });
    }
  });

  window.addEventListener('online', () => {
    console.log('🌐 Network ONLINE — instant re-resolve...');
    stopAutoReconnect();
    resetConnection();
    // Мгновенный resolve, без задержки
    resolveServerUrl();
  });

  window.addEventListener('offline', () => {
    console.log('📴 Network OFFLINE');
    updateNetworkState({
      status: 'disconnected', protocol: 'unknown',
      ipv4Available: false,
      lastError: 'Network offline', failedAt: new Date(),
    });
  });

  // Слушаем network change (WiFi → LTE, LTE → WiFi)
  if ('connection' in navigator) {
    const conn = (navigator as any).connection;
    if (conn && conn.addEventListener) {
      conn.addEventListener('change', () => {
        console.log('🔄 Network type changed — re-resolving...');
        stopAutoReconnect();
        resetConnection();
        resolveServerUrl();
      });
    }
  }

  // Visibility change: когда приложение возвращается из фона
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // В Android WebView — не трогаем, WebView сам решает
      const isAndroid = 'AndroidBridge' in window;
      if (isAndroid) return;

      console.log('👁️ App visible — quick health check...');
      // Не сбрасываем сразу — двойная проверка (VPN может тормозить после resume)
      if (resolvedBaseUrl) {
        quickCheck(resolvedBaseUrl, 4000).then(ok => {
          if (ok) return;
          // Вторая попытка через 2с
          setTimeout(() => {
            quickCheck(resolvedBaseUrl!, 5000).then(ok2 => {
              if (!ok2) {
                console.log('⚠️ Server lost after resume — re-resolving...');
                resetConnection();
                resolveServerUrl();
              }
            });
          }, 2000);
        });
      }
    }
  });
}

/**
 * Получить текущий base URL (синхронно, если уже определён)
 * Если ещё не определён — возвращает window.location.origin
 */
export function getBaseUrl(): string {
  return resolvedBaseUrl || (typeof window !== 'undefined' ? window.location.origin : '');
}

/**
 * Получить API URL
 */
export function getApiUrl(): string {
  return resolvedApiUrl || `${getBaseUrl()}/api`;
}

/**
 * Сбросить кэш (при потере соединения)
 */
export function resetConnection(): void {
  resolvedBaseUrl = null;
  resolvedApiUrl = null;
  console.log('🔄 Connection cache reset, will re-resolve on next request');
}

/**
 * Проверить работоспособность текущего подключения
 * ВОЕННЫЙ УРОВЕНЬ: быстрая проверка → мгновенный re-resolve при потере
 */
export async function recheckConnection(): Promise<string> {
  if (resolvedBaseUrl) {
    // Quick check — 2 сек максимум
    const still = await quickCheck(resolvedBaseUrl, 2000);
    if (still) return resolvedBaseUrl;

    // Вторая попытка — 4 сек (мобильная сеть может тупить)
    const retry = await checkServer(resolvedBaseUrl, 4000);
    if (retry) return resolvedBaseUrl;

    console.warn('⚠ Connection lost, rapid re-resolve...');
    updateNetworkState({ status: 'reconnecting', lastError: 'Connection lost' });
    resetConnection();
  }
  return resolveServerUrl();
}

// === Фоновый health-check текущего подключения ===
let healthCheckInterval: ReturnType<typeof setInterval> | null = null;

function startHealthCheck() {
  if (healthCheckInterval) return;

  // Каждые 60 сек проверяем что текущий URL жив
  // 60s вместо 30s — при ТСПУ RST flood меньше ложных срабатываний
  healthCheckInterval = setInterval(async () => {
    if (!resolvedBaseUrl) return;
    // Тройная проверка с увеличенными таймаутами (VPN + ТСПУ)
    const ok = await quickCheck(resolvedBaseUrl, 4000);
    if (ok) return;
    // Пауза 2с — ТСПУ RST flood может быть кратковременным
    await new Promise(r => setTimeout(r, 2000));
    const retry1 = await quickCheck(resolvedBaseUrl, 5000);
    if (retry1) return;
    // Третья попытка с полным GET
    const retry2 = await checkServer(resolvedBaseUrl, 6000);
    if (retry2) return;
    console.warn('⚠️ Health check failed 3 times — re-resolving...');
    resetConnection();
    resolveServerUrl();
  }, 60_000);
}

function stopHealthCheck() {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
}

// EOF
