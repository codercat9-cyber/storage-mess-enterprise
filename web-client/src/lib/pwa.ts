// =============================================================
// PWA утилиты — регистрация SW, обновления, push подписка
// =============================================================

// @ts-ignore — virtual module из vite-plugin-pwa, доступен только в сборке
import { registerSW } from 'virtual:pwa-register';

// ─── Состояние ───
let swRegistration: ServiceWorkerRegistration | null = null;
let updateAvailableCallback: (() => void) | null = null;
let offlineReadyCallback: (() => void) | null = null;

/**
 * Очистка кешей при обновлении Service Worker.
 *
 * Токен авторизации здесь НЕ трогаем, хотя раньше трогали. Старое
 * поведение выкидывало `kotex-auth` при каждом обновлении SW — то есть
 * **разлогинивало всех после каждого выпуска веба**. Для пользователя
 * это неотличимо от поломки входа: он ничего не делал, а его выбросило
 * и просит пароль.
 *
 * Смысл очистки — выбросить устаревшие ФАЙЛЫ оболочки, а не сессию.
 * Устаревший бандл лечится очисткой кешей и перезагрузкой; сессия к
 * версии оболочки отношения не имеет.
 */
export async function clearAuthAndCaches(): Promise<void> {
  try {
    if ('caches' in window) {
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.map(name => caches.delete(name)));
      console.log('[PWA] Кеши очищены:', cacheNames.length, 'штук');
    }
  } catch (e) {
    console.warn('[PWA] Ошибка очистки при обновлении:', e);
  }
}

// ─── Очистка устаревшего кеша эмодзи ───
async function clearStaleEmojiCache() {
  try {
    // Удаляем эмодзи из старого images-cache (там могли остаться с чёрным фоном)
    const imagesCache = await caches.open('images-cache');
    const keys = await imagesCache.keys();
    let cleared = 0;
    for (const request of keys) {
      if (request.url.includes('/emoji/')) {
        await imagesCache.delete(request);
        cleared++;
      }
    }
    // Также очищаем старый emoji-cache целиком для свежего старта
    if (await caches.has('emoji-cache')) {
      await caches.delete('emoji-cache');
      cleared++;
    }
    if (cleared > 0) {
      console.log(`🧹 Очищено ${cleared} устаревших эмодзи из кеша`);
    }
  } catch (e) {
    console.warn('Не удалось очистить кеш эмодзи:', e);
  }
}

// ─── Регистрация Service Worker ───
export function initPWA() {
  if (!('serviceWorker' in navigator)) {
    console.log('⚠️ Service Worker не поддерживается');
    return;
  }

  // ВАЖНО: Если мы в APK, мы НЕ регистрируем SW.
  // Иначе MainActivity убьёт его и перезагрузит страницу, а мы снова его зарегистрируем (бесконечный цикл reload).
  const isApk = navigator.userAgent.includes('StorageMessApp') || location.hostname === 'localhost';
  if (isApk) {
    console.log('📱 Запуск в APK — PWA Service Worker полностью отключён, используется нативный кэш Android WebView.');
    return;
  }

  // Одноразовая очистка старых эмодзи из кеша
  const EMOJI_CACHE_VERSION = 'emoji-v2';
  if (localStorage.getItem('emoji-cache-ver') !== EMOJI_CACHE_VERSION) {
    clearStaleEmojiCache().then(() => {
      localStorage.setItem('emoji-cache-ver', EMOJI_CACHE_VERSION);
    });
  }

  // ─── controllerchange: SW обновился → чистим кеши → reload ───
  // Флаг: если на момент запуска уже был активный контроллер — это НЕ первая установка
  const hadControllerOnStart = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadControllerOnStart) {
      // Первая установка SW — просто запоминаем факт
      console.log('[PWA] Первая установка SW — не сбрасываем сессию');
      return;
    }
    // SW обновился — выбрасываем устаревшие файлы оболочки и
    // перезагружаемся. Сессию не трогаем: пользователь не должен
    // оказываться на экране входа из-за выпуска новой версии.
    console.log('[PWA] SW обновлён — очищаем кеши оболочки, перезагружаем...');
    clearAuthAndCaches().then(() => {
      window.location.reload();
    });
  });

  const updateSW = registerSW({
    immediate: true,
    onRegisteredSW(swUrl: string, registration: ServiceWorkerRegistration | undefined) {
      swRegistration = registration || null;
      console.log('✅ Service Worker зарегистрирован:', swUrl);

      // Периодическая проверка обновлений (каждые 60 минут)
      if (registration) {
        setInterval(() => {
          registration.update().catch(console.error);
        }, 60 * 60 * 1000);
      }
    },
    onOfflineReady() {
      console.log('📱 PWA готово к работе offline');
      offlineReadyCallback?.();
    },
    onNeedRefresh() {
      console.log('🔄 Доступно обновление PWA');
      updateAvailableCallback?.();
    },
    onRegisterError(error: any) {
      console.error('❌ Ошибка регистрации SW:', error);
    },
  });

  // Экспортируем функцию обновления
  (window as any).__pwa_updateSW = updateSW;
}

// ─── Обновление приложения ───
export function applyUpdate() {
  const updateSW = (window as any).__pwa_updateSW;
  if (updateSW) {
    updateSW(true); // true = reload
  }
}

// ─── Колбэки ───
export function onUpdateAvailable(cb: () => void) {
  updateAvailableCallback = cb;
}

export function onOfflineReady(cb: () => void) {
  offlineReadyCallback = cb;
}

/**
 * Регистрация service worker — из памяти или спросив у браузера.
 *
 * Раньше здесь была только переменная, которую заполняет колбэк
 * регистрации. Если подписка вызывалась раньше, чем колбэк успевал
 * сработать (а на запуске так и происходит), функция сдавалась с
 * «SW не зарегистрирован для push» — хотя воркер был на месте. Отсюда и
 * жалобы, что уведомления «просто перестают приходить»: ничего не
 * отваливалось, мы спрашивали не у того.
 *
 * Теперь при пустой переменной спрашиваем сам браузер. `ready` ждёт
 * бесконечно, если воркера нет вовсе, поэтому ограничиваем ожидание.
 */
async function получитьРегистрацию(): Promise<ServiceWorkerRegistration | null> {
  if (swRegistration) return swRegistration;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;

  try {
    const уже = await navigator.serviceWorker.getRegistration();
    if (уже) { swRegistration = уже; return уже; }

    const готовность = navigator.serviceWorker.ready;
    const срок = new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000));
    const итог = await Promise.race([готовность, срок]);
    if (итог) { swRegistration = итог; return итог; }
  } catch (e) {
    console.warn('Не удалось получить регистрацию service worker:', e);
  }
  return null;
}

// ─── Push уведомления ───
export async function subscribeToPush(serverUrl: string, token: string): Promise<boolean> {
  // Пробуем подписаться на Web Push в любом окружении (включая APK)
  // Если WebView поддерживает кастомный Service Worker с pushManager, он должен работать.

  const registration = await получитьРегистрацию();
  if (!registration) {
    console.warn('SW не зарегистрирован для push');
    return false;
  }

  try {
    // Запрашиваем разрешение
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      console.log('Push-уведомления отклонены пользователем');
      return false;
    }

    // Получаем VAPID ключ с сервера
    const response = await fetch(`${serverUrl}/api/push/vapid-key`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      console.warn('Не удалось получить VAPID ключ');
      return false;
    }

    const { publicKey } = await response.json();

    // Подписываемся
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
    });

    // Отправляем подписку на сервер
    await fetch(`${serverUrl}/api/push/subscribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(subscription.toJSON()),
    });

    console.log('✅ Push-подписка активирована');
    return true;
  } catch (err) {
    // В APK (WebView) подписка через Web Push часто падает, если нет Google Play Services.
    // Логируем как warning, чтобы не триггерить красные ошибки/тосты в UI.
    console.warn('⚠️ Ошибка подписки push (WebView не поддерживает VAPID):', err);
    return false;
  }
}

// ─── Утилиты ───
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from(rawData, (char) => char.charCodeAt(0));
}

// ─── Информация о PWA ───
export function isPWAInstalled(): boolean {
  // Проверяем mode display-mode: standalone
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as any).standalone === true ||
    document.referrer.includes('android-app://')
  );
}

export function isServiceWorkerActive(): boolean {
  return !!navigator.serviceWorker?.controller;
}

// ─── Background Sync ───
export async function scheduleMessageSync(payload: any, token: string) {
  if (!('serviceWorker' in navigator) || !('SyncManager' in window)) {
    return false;
  }

  try {
    // Сохраняем сообщение в IndexedDB
    const db = await openPendingDB();
    const tx = db.transaction('pending', 'readwrite');
    tx.objectStore('pending').add({ payload, token, createdAt: Date.now() });

    // Регистрируем sync
    const reg = await navigator.serviceWorker.ready;
    await (reg as any).sync.register('send-pending-messages');
    return true;
  } catch {
    return false;
  }
}

function openPendingDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('storage-mess-pending', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('pending')) {
        db.createObjectStore('pending', { keyPath: 'id', autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
