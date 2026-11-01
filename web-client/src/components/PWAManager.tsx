// =============================================================
// PWA Install Prompt — баннер «Установить приложение»
// + Тост обновления и offline-ready
// + Проверка обновлений для APK / Desktop / PWA через /api/updates
// Рендерится через Portal — вне layout-дерева приложения
// =============================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { downloadFileNative } from '@/lib/capacitor-bridge';
import { Download, RefreshCw, WifiOff, X, Smartphone, Monitor, ArrowDownCircle, Sparkles, Share } from 'lucide-react';
import { applyUpdate, onUpdateAvailable, onOfflineReady, isPWAInstalled } from '@/lib/pwa';
import { getBaseUrl } from '@/lib/connection';

// ─── Версия клиента (вшивается при сборке) ───
declare const __APP_VERSION__: string;
const CLIENT_VERSION = (typeof __APP_VERSION__ !== 'undefined') ? __APP_VERSION__ : '2.12.0';

// ─── Интервал проверки обновлений (30 мин) ───
const UPDATE_CHECK_INTERVAL = 30 * 60 * 1000;

/** Получаем реальную версию в зависимости от платформы */
function getClientVersion(): string {
  // APK: берём версию из AndroidBridge (из build.gradle versionName)
  try {
    const bridge = (window as any).AndroidBridge;
    if (bridge?.getAppVersion) {
      const v = bridge.getAppVersion();
      if (v && v !== '0.0.0') return v;
    }
  } catch {}
  // Electron desktop
  try {
    if ((window as any).__ELECTRON_APP_VERSION__) return (window as any).__ELECTRON_APP_VERSION__;
  } catch {}
  // Meta tag
  const meta = document.querySelector('meta[name="app-version"]') as HTMLMetaElement;
  if (meta?.content) return meta.content;
  // Fallback: хардкод
  return CLIENT_VERSION;
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface NativeUpdateInfo {
  platform: string;
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  changelog: string;
  downloadUrl?: string;
  downloads?: { windows?: string | null; linux?: string | null; mac?: string | null };
  filename?: string;
}

/** Определяем iOS (iPhone/iPad/iPod) */
function detectIOS(): boolean {
  return /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    // iPad на iOS 13+ представляется как Mac с тачскрином
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** PWA уже установлено как standalone на iOS */
function isIOSStandalone(): boolean {
  return (navigator as any).standalone === true;
}

/** Пользователь открыл именно в Safari (не Chrome iOS, не Firefox iOS) */
function isIOSSafari(): boolean {
  const ua = navigator.userAgent;
  return detectIOS() && /Safari/i.test(ua) && !/CriOS|FxiOS|OPiOS|mercury/i.test(ua);
}

/** Определяем тип платформы */
function detectPlatform(): 'pwa' | 'apk' | 'desktop' | 'web' {
  // Electron desktop
  if ((window as any).__ELECTRON__ || navigator.userAgent.includes('Electron')) {
    return 'desktop';
  }
  // Capacitor native app
  if ((window as any).Capacitor?.isNativePlatform?.()) {
    return 'apk';
  }
  // Android WebView (Capacitor/Cordova/TWA) — APK
  const ua = navigator.userAgent;
  if (
    ua.includes('wv') || // Android WebView
    (ua.includes('Android') && !ua.includes('Chrome/') && ua.includes('Version/')) || // старый WebView
    document.referrer.includes('android-app://') // TWA
  ) {
    return 'apk';
  }
  // PWA standalone
  if (isPWAInstalled()) {
    return 'pwa';
  }
  return 'web';
}

/** Определяем OS для desktop-загрузок */
function detectDesktopOS(): 'windows' | 'linux' | 'mac' {
  const ua = navigator.userAgent;
  if (ua.includes('Win')) return 'windows';
  if (ua.includes('Mac')) return 'mac';
  return 'linux';
}

/** Проверяем обновления на сервере */
async function checkServerUpdate(platform: string): Promise<NativeUpdateInfo | null> {
  try {
    const version = getClientVersion();
    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/api/updates/check?platform=${platform}&version=${encodeURIComponent(version)}`;
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.warn('⚠️ Update check failed:', err);
    return null;
  }
}

export default function PWAManager() {
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showInstallBanner, setShowInstallBanner] = useState(false);
  const [showIOSBanner, setShowIOSBanner] = useState(false);
  const [showUpdateToast, setShowUpdateToast] = useState(false);
  const [showOfflineToast, setShowOfflineToast] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [isInstalled, setIsInstalled] = useState(false);

  // Нативное обновление (APK / Desktop)
  const [nativeUpdate, setNativeUpdate] = useState<NativeUpdateInfo | null>(null);
  const [showNativeUpdate, setShowNativeUpdate] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const updateCheckRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Проверяем установку
  useEffect(() => {
    setIsInstalled(isPWAInstalled());
  }, []);

  // ═══ iOS install banner — Safari не поддерживает beforeinstallprompt ═══
  useEffect(() => {
    if (!isIOSSafari() || isIOSStandalone()) return; // только Safari и не уже установлено

    const dismissedAt = localStorage.getItem('pwa-ios-install-dismissed');
    if (dismissedAt) {
      const elapsed = Date.now() - Number(dismissedAt);
      if (elapsed < 7 * 24 * 60 * 60 * 1000) return; // ещё 7 дней не показываем
      localStorage.removeItem('pwa-ios-install-dismissed');
    }

    // Показываем через 3 секунды после загрузки
    const timer = setTimeout(() => setShowIOSBanner(true), 3000);
    return () => clearTimeout(timer);
  }, []);

  // ═══ Проверка обновлений с сервера (APK / Desktop / PWA / Web) ═══
  useEffect(() => {
    const platform = detectPlatform();

    const doCheck = async () => {
      const info = await checkServerUpdate(platform);
      if (info?.hasUpdate) {
        console.log(`🆕 Обновление доступно: ${info.latestVersion} (текущая: ${info.currentVersion})`);
        setNativeUpdate(info);

        // Для PWA — SW-обновление уже отдельно обрабатывается
        // Для APK/Desktop — показываем баннер
        if (platform === 'apk' || platform === 'desktop') {
          // Проверяем dismiss TTL (1 день для нативных)
          const dismissKey = `native-update-dismissed-${info.latestVersion}`;
          const dismissedAt = localStorage.getItem(dismissKey);
          if (dismissedAt) {
            const elapsed = Date.now() - Number(dismissedAt);
            if (elapsed < 24 * 60 * 60 * 1000) return; // ещё рано
            localStorage.removeItem(dismissKey);
          }
          setShowNativeUpdate(true);
        } else if (platform === 'web') {
          // Для обычного web тоже показываем — перезагрузка обновит
          setShowNativeUpdate(true);
        }
      }
    };

    // Первая проверка через 5 секунд после загрузки
    const initialTimer = setTimeout(doCheck, 5000);

    // Периодическая проверка
    updateCheckRef.current = setInterval(doCheck, UPDATE_CHECK_INTERVAL);

    return () => {
      clearTimeout(initialTimer);
      if (updateCheckRef.current) clearInterval(updateCheckRef.current);
    };
  }, []);

  // Берём prompt который был пойман ДО монтирования React (main.tsx)
  // или подписываемся на будущий
  useEffect(() => {
    const handlePrompt = (e: Event) => {
      setInstallPrompt(e as BeforeInstallPromptEvent);
      // Проверяем dismiss TTL
      const dismissedAt = localStorage.getItem('pwa-install-dismissed');
      let wasDismissed = false;
      if (dismissedAt) {
        const elapsed = Date.now() - Number(dismissedAt);
        const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
        if (elapsed < SEVEN_DAYS) {
          wasDismissed = true;
        } else {
          localStorage.removeItem('pwa-install-dismissed');
        }
      }
      if (!wasDismissed) {
        setTimeout(() => setShowInstallBanner(true), 2000);
      }
    };

    // Проверяем, не пришёл ли prompt ДО монтирования
    const earlyPrompt = (window as any).__pwa_deferred_prompt;
    if (earlyPrompt) {
      handlePrompt(earlyPrompt);
    }

    // Подписываемся на будущие prompts
    ((window as any).__pwa_prompt_listeners as Array<(e: Event) => void>).push(handlePrompt);

    // Отслеживаем успешную установку
    const onInstalled = () => {
      setIsInstalled(true);
      setShowInstallBanner(false);
      setInstallPrompt(null);
      console.log('✅ PWA установлено');
    };
    window.addEventListener('appinstalled', onInstalled);

    return () => {
      window.removeEventListener('appinstalled', onInstalled);
      // Убираем из listeners
      const listeners = (window as any).__pwa_prompt_listeners as Array<(e: Event) => void>;
      const idx = listeners.indexOf(handlePrompt);
      if (idx >= 0) listeners.splice(idx, 1);
    };
  }, []);

  // На Android без prompt — всё равно показываем баннер для APK через 3 сек
  useEffect(() => {
    const isAndroidUA = /Android/i.test(navigator.userAgent);
    const platform = detectPlatform();
    if (!isAndroidUA || platform === 'apk') return; // внутри APK — не нужно

    const dismissedAt = localStorage.getItem('pwa-install-dismissed');
    if (dismissedAt) {
      const elapsed = Date.now() - Number(dismissedAt);
      if (elapsed < 7 * 24 * 60 * 60 * 1000) return;
    }

    const timer = setTimeout(() => {
      // Если prompt не пришёл, но мы на Android — показываем баннер (для APK кнопки)
      if (!installPrompt) {
        setShowInstallBanner(true);
      }
    }, 3000);
    return () => clearTimeout(timer);
  }, [installPrompt]);

  // Подписываемся на обновления SW
  useEffect(() => {
    onUpdateAvailable(() => setShowUpdateToast(true));
    onOfflineReady(() => {
      console.log('[PWAManager] App is offline ready');
      // setShowOfflineToast(true);
      // setTimeout(() => setShowOfflineToast(false), 5000);
    });
  }, []);

  // Онлайн/оффлайн
  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  // Установить приложение
  const handleInstall = useCallback(async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === 'accepted') {
      setShowInstallBanner(false);
    }
    setInstallPrompt(null);
  }, [installPrompt]);

  // Закрыть баннер (запомнить на 7 дней)
  const dismissInstallBanner = useCallback(() => {
    setShowInstallBanner(false);
    localStorage.setItem('pwa-install-dismissed', String(Date.now()));
  }, []);

  // Закрыть iOS баннер (запомнить на 7 дней)
  const dismissIOSBanner = useCallback(() => {
    setShowIOSBanner(false);
    localStorage.setItem('pwa-ios-install-dismissed', String(Date.now()));
  }, []);

  // Обновить PWA (через SW)
  const handlePWAUpdate = useCallback(() => {
    setShowUpdateToast(false);
    applyUpdate();
  }, []);

  // Скачать нативное обновление (APK / Desktop)
  const handleNativeDownload = useCallback(async () => {
    if (!nativeUpdate) return;

    const baseUrl = getBaseUrl();

    if (nativeUpdate.platform === 'apk' && nativeUpdate.downloadUrl) {
      setDownloading(true);
      // Качаем сами, а не отдаём браузеру.
      //
      // window.open в настольном клиенте уходит в обработчик открытия окон,
      // и тот отправляет ссылку в системный браузер: человек нажимает
      // «Обновить» в приложении, а качает Chrome — без полосы, без
      // скорости, в чужую папку.
      void downloadFileNative(`${baseUrl}${nativeUpdate.downloadUrl}`,
                              `storagemess-${nativeUpdate.latestVersion || 'update'}.apk`);
      setTimeout(() => setDownloading(false), 3000);
    } else if (nativeUpdate.platform === 'desktop' && nativeUpdate.downloads) {
      const os = detectDesktopOS();
      const downloadPath = nativeUpdate.downloads[os];
      if (downloadPath) {
        setDownloading(true);
        const ext = os === 'windows' ? 'exe' : os === 'mac' ? 'dmg' : 'AppImage';
        void downloadFileNative(`${baseUrl}${downloadPath}`,
                                `STORAGE-MESS-${nativeUpdate.latestVersion || 'update'}.${ext}`);
        setTimeout(() => setDownloading(false), 3000);
      }
    } else if (nativeUpdate.platform === 'web') {
      // Обычный web — просто перезагружаем
      window.location.reload();
    }
  }, [nativeUpdate]);

  // Закрыть баннер нативного обновления (1 день для этой версии)
  const dismissNativeUpdate = useCallback(() => {
    setShowNativeUpdate(false);
    if (nativeUpdate) {
      const dismissKey = `native-update-dismissed-${nativeUpdate.latestVersion}`;
      localStorage.setItem(dismissKey, String(Date.now()));
    }
  }, [nativeUpdate]);

  // Определяем платформу
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const isAndroid = /Android/i.test(navigator.userAgent);
  const isInAPK = detectPlatform() === 'apk';
  const DeviceIcon = isMobile ? Smartphone : Monitor;

  // Скачать APK
  const handleDownloadAPK = useCallback(() => {
    const baseUrl = getBaseUrl();
    void downloadFileNative(`${baseUrl}/api/updates/download/apk`, 'storagemess.apk');
  }, []);

  // Рендерим через Portal в document.body — полностью вне layout-дерева
  return createPortal(
    <>
      {/* ═══ Баннер установки (APK vs PWA выбор) ═══ */}
      {showInstallBanner && !isInstalled && !isInAPK && (
        <div className="fixed bottom-4 left-4 right-4 z-[9999] animate-slide-up sm:left-auto sm:right-4 sm:w-96">
          <div className="bg-messenger-sidebar border border-messenger-border rounded-2xl shadow-2xl p-4 backdrop-blur-xl">
            <div className="flex items-start gap-3">
              {/* Иконка */}
              <div className="flex-shrink-0 w-12 h-12 bg-blue-600 rounded-xl flex items-center justify-center shadow-lg">
                <DeviceIcon className="w-6 h-6 text-white" />
              </div>

              <div className="flex-1 min-w-0">
                <h3 className="text-messenger-text font-semibold text-sm">
                  Установить STORAGE&MESS
                </h3>
                <p className="text-messenger-muted text-xs mt-0.5">
                  {isAndroid
                    ? 'Выберите способ установки'
                    : isMobile
                      ? 'Добавьте на главный экран для быстрого доступа'
                      : 'Установите как десктоп-приложение'}
                </p>

                <div className="flex flex-col gap-2 mt-3">
                  {/* APK — только для Android */}
                  {isAndroid && (
                    <button
                      onClick={handleDownloadAPK}
                      className="flex items-center gap-1.5 px-4 py-2 bg-green-600 hover:bg-green-500 text-white text-xs font-medium rounded-lg transition-colors w-full justify-center"
                    >
                      <ArrowDownCircle className="w-3.5 h-3.5" />
                      Скачать APK (рекомендуется)
                    </button>
                  )}
                  {/* PWA */}
                  {installPrompt && (
                    <button
                      onClick={handleInstall}
                      className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-lg transition-colors w-full justify-center"
                    >
                      <Download className="w-3.5 h-3.5" />
                      {isAndroid ? 'Установить как PWA (лайт)' : 'Установить'}
                    </button>
                  )}
                  <button
                    onClick={dismissInstallBanner}
                    className="px-3 py-1.5 text-messenger-muted hover:text-messenger-text text-xs rounded-lg transition-colors"
                  >
                    Позже
                  </button>
                </div>
              </div>

              <button
                onClick={dismissInstallBanner}
                className="flex-shrink-0 text-messenger-muted hover:text-messenger-text transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ iOS install banner — Safari не поддерживает beforeinstallprompt ═══ */}
      {showIOSBanner && (
        <div className="fixed bottom-0 left-0 right-0 z-[9999] animate-slide-up pb-safe">
          <div className="bg-messenger-sidebar border-t border-messenger-border shadow-2xl p-4 backdrop-blur-xl">
            <div className="flex items-start gap-3">
              {/* Иконка приложения */}
              <div className="flex-shrink-0 w-12 h-12 rounded-2xl overflow-hidden shadow-lg">
                <img src="/icon-192.png" alt="STORAGE&MESS" className="w-full h-full object-cover" />
              </div>

              <div className="flex-1 min-w-0">
                <h3 className="text-messenger-text font-semibold text-sm">
                  Установить STORAGE&MESS
                </h3>
                <p className="text-messenger-muted text-xs mt-0.5">
                  Добавьте на экран «Домой» для быстрого доступа
                </p>

                {/* Инструкция для iOS Safari */}
                <div className="flex items-center gap-2 mt-2.5 text-xs text-messenger-text">
                  <span className="flex items-center gap-1 bg-messenger-border rounded-lg px-2.5 py-1.5">
                    <Share className="w-3.5 h-3.5 text-blue-400" />
                    <span>Поделиться</span>
                  </span>
                  <span className="text-messenger-muted">→</span>
                  <span className="bg-messenger-border rounded-lg px-2.5 py-1.5">
                    На экран «Домой»
                  </span>
                </div>
              </div>

              <button
                onClick={dismissIOSBanner}
                className="flex-shrink-0 text-messenger-muted hover:text-messenger-text transition-colors mt-0.5"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Стрелка вниз — указывает на панель Safari */}
            <div className="flex justify-center mt-2">
              <div className="flex flex-col items-center gap-0.5 text-blue-400">
                <span className="text-[10px] text-messenger-muted">кнопка внизу экрана</span>
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
              </div>
            </div>

            <button
              onClick={dismissIOSBanner}
              className="mt-2 w-full py-1.5 text-messenger-muted hover:text-messenger-text text-xs rounded-lg transition-colors"
            >
              Закрыть
            </button>
          </div>
        </div>
      )}

      {/* ═══ Тост обновления PWA (через SW) ═══ */}
      {showUpdateToast && (        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[9999] animate-slide-down">
          <div className="bg-blue-600 text-white rounded-xl shadow-2xl px-4 py-3 flex items-center gap-3">
            <RefreshCw className="w-5 h-5 animate-spin" />
            <div>
              <p className="text-sm font-medium">Доступно обновление</p>
              <p className="text-xs text-blue-200">Перезагрузите для применения</p>
            </div>
            <button
              onClick={handlePWAUpdate}
              className="ml-2 px-3 py-1 bg-white text-blue-600 text-xs font-semibold rounded-lg hover:bg-blue-50 transition-colors"
            >
              Обновить
            </button>
            <button
              onClick={() => setShowUpdateToast(false)}
              className="text-blue-200 hover:text-white ml-1"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* ═══ Баннер нативного обновления (APK / Desktop / Web) ═══ */}
      {showNativeUpdate && nativeUpdate && (
        <div className="fixed bottom-4 left-4 right-4 z-[9999] animate-slide-up sm:left-auto sm:right-4 sm:w-[420px]">
          <div className="bg-gradient-to-r from-indigo-600 to-purple-600 rounded-2xl shadow-2xl p-4 text-white">
            <div className="flex items-start gap-3">
              {/* Иконка */}
              <div className="flex-shrink-0 w-11 h-11 bg-white/20 rounded-xl flex items-center justify-center backdrop-blur-sm">
                <Sparkles className="w-5 h-5 text-white" />
              </div>

              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-sm flex items-center gap-2">
                  Доступно обновление
                  <span className="text-xs bg-white/20 px-2 py-0.5 rounded-full font-normal">
                    v{nativeUpdate.latestVersion}
                  </span>
                </h3>

                {nativeUpdate.changelog && (
                  <p className="text-xs text-white/70 mt-1 line-clamp-2">
                    {nativeUpdate.changelog}
                  </p>
                )}

                <p className="text-xs text-white/50 mt-1">
                  Текущая версия: v{nativeUpdate.currentVersion}
                </p>

                <div className="flex items-center gap-2 mt-3">
                  <button
                    onClick={handleNativeDownload}
                    disabled={downloading}
                    className="flex items-center gap-1.5 px-4 py-1.5 bg-white text-indigo-700 text-xs font-semibold rounded-lg hover:bg-indigo-50 transition-colors disabled:opacity-60"
                  >
                    {downloading ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        Загрузка...
                      </>
                    ) : nativeUpdate.platform === 'web' ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5" />
                        Обновить
                      </>
                    ) : (
                      <>
                        <ArrowDownCircle className="w-3.5 h-3.5" />
                        Скачать
                      </>
                    )}
                  </button>
                  <button
                    onClick={dismissNativeUpdate}
                    className="px-3 py-1.5 text-white/70 hover:text-white text-xs rounded-lg transition-colors"
                  >
                    Позже
                  </button>
                </div>
              </div>

              <button
                onClick={dismissNativeUpdate}
                className="flex-shrink-0 text-white/50 hover:text-white transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Тост offline ready ═══ */}
      {showOfflineToast && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[9999] animate-slide-down">
          <div className="bg-green-600 text-white rounded-xl shadow-2xl px-4 py-3 flex items-center gap-3">
            <WifiOff className="w-5 h-5" />
            <div>
              <p className="text-sm font-medium">Готово к работе офлайн</p>
              <p className="text-xs text-green-200">Приложение закэшировано</p>
            </div>
            <button
              onClick={() => setShowOfflineToast(false)}
              className="text-green-200 hover:text-white ml-1"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

    </>,
    document.body
  );
}
