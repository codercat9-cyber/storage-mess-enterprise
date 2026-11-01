import { useState, useEffect } from 'react';
import { Download, X, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { getBaseUrl } from '@/lib/connection';

const CHECK_INTERVAL = 30 * 60 * 1000; // 30 минут
const UPDATE_DISMISSED_KEY = 'update_dismissed_version';

interface UpdateInfo {
  hasUpdate: boolean;
  latestVersion: string;
  currentVersion: string;
  changelog?: string;
  downloadUrl?: string;
}

function getAppVersion(): string {
  // Android WebView bridge
  try {
    const bridge = (window as any).AndroidBridge;
    if (bridge?.getAppVersion) return bridge.getAppVersion();
  } catch {}
  // PWA / Browser — используем версию из meta или package
  return (document.querySelector('meta[name="app-version"]') as HTMLMetaElement)?.content || '2.12.0';
}

function getPlatform(): string {
  if ((window as any).AndroidBridge) return 'apk';
  return 'web';
}

export default function UpdateChecker() {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const checkForUpdate = async () => {
    try {
      const version = getAppVersion();
      const platform = getPlatform();
      const { data } = await api.get(`/updates/check?platform=${platform}&version=${encodeURIComponent(version)}&_t=${Date.now()}`);
      if (data.hasUpdate) {
        // Не показываем, если юзер уже dismiss'нул эту версию
        const dismissedVer = localStorage.getItem(UPDATE_DISMISSED_KEY);
        if (dismissedVer === data.latestVersion) return;
        setUpdateInfo(data);
        setDismissed(false);
      }
    } catch (e) {
      // Сервер недоступен — молча игнорируем
    }
  };

  useEffect(() => {
    // Первая проверка через 5 секунд после старта
    const t = setTimeout(checkForUpdate, 5000);
    // Повторная проверка каждые 30 минут
    const interval = setInterval(checkForUpdate, CHECK_INTERVAL);
    return () => { clearTimeout(t); clearInterval(interval); };
  }, []);

  const handleDismiss = () => {
    if (updateInfo) {
      localStorage.setItem(UPDATE_DISMISSED_KEY, updateInfo.latestVersion);
    }
    setDismissed(true);
  };

  const handleUpdate = () => {
    if (!updateInfo?.downloadUrl) return;
    const platform = getPlatform();

    if (platform === 'apk') {
      // Для Android APK — открываем URL скачивания в браузере
      setDownloading(true);
      const url = `${getBaseUrl()}${updateInfo.downloadUrl}`;
      // Через AndroidBridge или просто window.open
      try {
        (window as any).AndroidBridge?.showToast?.('Скачивание обновления...');
      } catch {}
      window.open(url, '_system');
      setTimeout(() => setDownloading(false), 3000);
    } else {
      // Web — перезагрузка страницы с очисткой кэша
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(regs => {
          regs.forEach(r => r.unregister());
        });
      }
      if ('caches' in window) {
        caches.keys().then(names => names.forEach(name => caches.delete(name)));
      }
      window.location.reload();
    }
  };

  if (!updateInfo || dismissed) return null;

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[200] w-[calc(100%-32px)] max-w-[380px] animate-slide-down">
      <div className="bg-messenger-sidebar border border-messenger-accent/30 rounded-2xl shadow-2xl p-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-messenger-accent/10 flex items-center justify-center shrink-0">
            <RefreshCw size={20} className="text-messenger-accent" />
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="font-semibold text-messenger-text text-sm">Доступно обновление</h4>
            <p className="text-messenger-muted text-xs mt-0.5">
              v{updateInfo.currentVersion} → v{updateInfo.latestVersion}
            </p>
            {updateInfo.changelog && (
              <p className="text-messenger-muted text-xs mt-1 line-clamp-2">{updateInfo.changelog}</p>
            )}
          </div>
          <button onClick={handleDismiss} className="p-1 rounded-full hover:bg-messenger-hover text-messenger-muted shrink-0">
            <X size={16} />
          </button>
        </div>
        <div className="flex gap-2 mt-3">
          <button onClick={handleDismiss} className="flex-1 px-3 py-2 rounded-xl text-xs font-medium text-messenger-muted hover:bg-messenger-hover transition-colors">
            Позже
          </button>
          <button onClick={handleUpdate} disabled={downloading} className="flex-1 px-3 py-2 rounded-xl text-xs font-medium text-white bg-messenger-accent hover:bg-messenger-accent/90 transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50">
            <Download size={14} />
            {downloading ? 'Скачивание...' : 'Обновить'}
          </button>
        </div>
      </div>
    </div>
  );
}
