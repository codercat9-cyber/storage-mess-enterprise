import { getDeviceFootprint } from './lib/device';

// Polyfill: crypto.randomUUID для старых браузеров (Chrome < 92, Samsung S8 etc.)
if (typeof crypto !== 'undefined' && !crypto.randomUUID) {
  (crypto as any).randomUUID = () => {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}

// Помечаем, что мы внутри APK.
//
// Нужно для правил вёрстки, которые в браузере не нужны, а в приложении
// мешают. Первое такое правило — выделение текста в сообщениях: длинное
// нажатие открывает наше меню (Ответить / Скопировать / Переслать) и
// ОДНОВРЕМЕННО системное выделение WebView подсвечивает слово и лезет
// поверх со своей панелью. В браузере выделение полезно, в приложении —
// только мешает, копировать там есть чем.
(function markApk() {
  try {
    const isApk = !!(window as any).AndroidBridge
      || !!(window as any).Capacitor?.isNativePlatform?.()
      || /StorageMess/i.test(navigator.userAgent);
    if (isApk) document.documentElement.classList.add('in-apk');
  } catch {}
})();

// Подхватываем системный масштаб шрифта через AndroidBridge
// WebView textZoom уже не залочен на 100%, но для PWA/desktop — применяем через CSS
(function applySystemFontScale() {
  try {
    const bridge = (window as any).AndroidBridge;
    if (bridge?.getSystemFontScale) {
      const scale = bridge.getSystemFontScale();
      if (scale && scale !== 1.0) {
        document.documentElement.style.fontSize = `${scale * 100}%`;
      }
    }
  } catch {}
})();

// Polyfill: flex gap для Chrome < 84 (Samsung S8 WebView)
// Определяем поддержку gap на flex-контейнерах и добавляем fallback через CSS
(function detectFlexGap() {
  try {
    var d = document.createElement('div');
    d.style.display = 'flex';
    d.style.gap = '1px';
    d.style.position = 'absolute';
    d.style.width = '2px';
    d.appendChild(document.createElement('div'));
    d.appendChild(document.createElement('div'));
    d.firstChild && ((d.firstChild as HTMLElement).style.width = '1px');
    d.lastChild && ((d.lastChild as HTMLElement).style.width = '1px');
    document.body.appendChild(d);
    var ok = d.scrollWidth === 3; // 1px + 1px gap + 1px = 3px
    document.body.removeChild(d);
    if (!ok) document.documentElement.classList.add('no-flex-gap');
  } catch (e) {}
})();

import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';

// PWA Service Worker
import { initPWA } from '@/lib/pwa';
import { initNotifications, requestNotificationPermission, setupNotificationClickHandler } from '@/lib/notifications';

// ⚡ Ловим beforeinstallprompt КАК МОЖНО РАНЬШЕ — до React рендера.
// Chrome может выстрелить событие до того как компоненты смонтируются.
(window as any).__pwa_deferred_prompt = null;
(window as any).__pwa_prompt_listeners = [] as Array<(e: Event) => void>;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  (window as any).__pwa_deferred_prompt = e;
  // Уведомляем всех подписчиков (PWAManager подпишется позже)
  ((window as any).__pwa_prompt_listeners as Array<(e: Event) => void>).forEach(cb => cb(e));
});

// Pre-fetch device footprint
getDeviceFootprint().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </React.StrictMode>
  );
});

// PWA — только для браузера. В Capacitor APK контент локальный, SW только мешает.
const __isNativeApp = !!(window as any).Capacitor?.isNativePlatform?.();

if (__isNativeApp) {
  // Разрегистрируем SW от предыдущих запусков и чистим кэши
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(regs => {
      regs.forEach(r => r.unregister());
    });
    caches.keys().then(names => {
      names.forEach(name => caches.delete(name));
    });
  }
} else {
  try {
    initPWA();
  } catch (e) {
    console.warn('PWA init error (non-fatal):', e);
  }
}

// ─── Свежий ли интерфейс внутри APK ───
//
// Оболочка живёт в assets/www и обновляется сборкой. Однажды сборка
// месяцами обновляла НЕ ту папку, приложение показывало июльский
// интерфейс, а узнать об этом можно было только отладчиком по USB.
// Теперь версия приложения приходит в User-Agent, а рядом с оболочкой
// лежит метка build-stamp.txt от той же сборки. Не совпало — значит
// показывается чужой интерфейс, и это видно в журнале сразу.
(function checkShellFreshness() {
  const m = navigator.userAgent.match(/StorageMessApp\/([\d.]+)/);
  if (!m) return;                       // не APK — сверять не с чем
  const appVersion = m[1];
  fetch('/build-stamp.txt', { cache: 'no-store' })
    .then(r => (r.ok ? r.text() : ''))
    .then(stamp => {
      const shellVersion = stamp.trim();
      // Метки нет — значит запрос ушёл в SPA-фолбэк и вернул страницу.
      // Принимаем только то, что похоже на версию, иначе получаем
      // «оболочка устарела: <!DOCTYPE html>» на ровном месте.
      if (!/^\d+\.\d+\.\d+$/.test(shellVersion)) return;
      (window as any).__shellVersion = shellVersion;
      (window as any).__appVersion = appVersion;
      if (shellVersion && shellVersion !== appVersion) {
        console.error(
          `[ОБОЛОЧКА УСТАРЕЛА] приложение ${appVersion}, интерфейс ${shellVersion}. ` +
          `Внутри APK лежит бандл от другой сборки — пересобрать через android/run-build.sh.`
        );
      }
    })
    .catch(() => {});
})();

// Инициализируем систему уведомлений и звуков
try {
  initNotifications();
  setupNotificationClickHandler();
  // Запрашиваем разрешение на уведомления (показывает промпт только 1 раз)
  requestNotificationPermission().then((granted) => {
    console.log('🔔 Notifications permission:', granted ? 'granted' : 'not granted');
  });
} catch (e) {
  console.warn('Notification init error (non-fatal):', e);
}
