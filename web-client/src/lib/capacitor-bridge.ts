/**
 * ═══════════════════════════════════════════════════════════════
 *  Capacitor Native Bridge
 * ═══════════════════════════════════════════════════════════════
 *  
 *  Detects if running inside Capacitor and provides native APIs:
 *  - Status bar styling
 *  - Back button handling  
 *  - Splash screen control
 *  - App lifecycle
 *  - Notifications via @capacitor/local-notifications
 */

// Capacitor auto-detects via window.Capacitor
const isCapacitor = (): boolean => {
  return !!(window as any).Capacitor?.isNativePlatform?.();
};

let initialized = false;

/**
 * Initialize all Capacitor native bridges.
 * Safe to call even when not in Capacitor — all calls are guarded.
 */
export async function initCapacitorBridge(): Promise<void> {
  if (initialized || !isCapacitor()) return;
  initialized = true;

  console.log('[Capacitor] Native platform detected, initializing bridge...');

  try {
    // Status bar
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    await StatusBar.setStyle({ style: Style.Dark });
    await StatusBar.setBackgroundColor({ color: '#0f0f0f' });
    console.log('[Capacitor] StatusBar configured');
  } catch (e) {
    console.warn('[Capacitor] StatusBar init failed:', e);
  }

  try {
    // Splash screen — hide after PWA loads
    const { SplashScreen } = await import('@capacitor/splash-screen');
    await SplashScreen.hide({ fadeOutDuration: 300 });
    console.log('[Capacitor] SplashScreen hidden');
  } catch (e) {
    console.warn('[Capacitor] SplashScreen hide failed:', e);
  }

  try {
    // Back button and App State
    const { App } = await import('@capacitor/app');
    App.addListener('backButton', ({ canGoBack }) => {
      if (canGoBack) {
        window.history.back();
      } else {
        App.minimizeApp();
      }
    });
    App.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) {
        window.dispatchEvent(new Event('app-pause'));

        // Останавливаем ролики и музыку, но НЕ звук разговора.
        //
        // Раньше здесь останавливалось всё подряд одним запросом ко всем
        // audio и video на странице — вместе с элементом, через который
        // звучит собеседник. Человек сворачивал приложение, и голос
        // пропадал: звонок формально шёл, а слышно не было ничего. Именно
        // это и выглядело как «звонки улетают при сворачивании».
        //
        // Элементы разговора помечены data-call-audio и пропускаются.
        document.querySelectorAll('video, audio').forEach((el) => {
          if ((el as HTMLElement).dataset?.callAudio !== undefined) return;
          (el as HTMLMediaElement).pause();
        });
      } else {
        console.log('[Capacitor] App resumed.');
        window.dispatchEvent(new Event('app-resume'));
      }
    });
    console.log('[Capacitor] App and back button handlers registered');
  } catch (e) {
    console.warn('[Capacitor] App plugin init failed:', e);
  }

  try {
    // Keyboard handling
    const { Keyboard } = await import('@capacitor/keyboard');
    Keyboard.addListener('keyboardWillShow', (info) => {
      document.body.style.setProperty('--keyboard-height', `${info.keyboardHeight}px`);
    });
    Keyboard.addListener('keyboardWillHide', () => {
      document.body.style.setProperty('--keyboard-height', '0px');
    });
    console.log('[Capacitor] Keyboard handlers registered');
  } catch (e) {
    console.warn('[Capacitor] Keyboard init failed:', e);
  }

  try {
    // Request notification permission on native (for LocalNotifications)
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    const perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted') {
      await LocalNotifications.requestPermissions();
    }

    // Обработка тапа по уведомлению — возвращаем фокус в приложение
    LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
      console.log('[Capacitor] Notification tapped:', action);
      // Фокусируем окно — предотвращаем открытие в браузере
      window.focus();
      const data = action.notification?.extra;
      if (data?.type === 'message' && data?.chatId) {
        window.dispatchEvent(new CustomEvent('navigate-to-chat', { detail: { chatId: data.chatId } }));
      } else if (data?.type === 'call') {
        // Фокус на приложение — звонок уже отображается через socket
      }
    });

    console.log('[Capacitor] LocalNotifications ready');
  } catch (e) {
    console.warn('[Capacitor] LocalNotifications init failed:', e);
  }

  try {
    // Фоновое выполнение (background-mode) для работы Service Worker и сокетов
    if ('cordova' in window) {
      const backgroundMode = (window as any).cordova?.plugins?.backgroundMode;
      if (backgroundMode) {
        backgroundMode.enable();
        backgroundMode.overrideBackButton();
        backgroundMode.on('activate', () => {
          backgroundMode.disableWebViewOptimizations();
          console.log('[Capacitor] Background mode activated, SW and WebSockets kept alive');
        });
        console.log('[Capacitor] Background mode initialized');
      }
    }
  } catch (e) {
    console.warn('[Capacitor] Background mode init failed:', e);
  }
}

/**
 * Check if currently running inside Capacitor native app
 */
export function isNativeApp(): boolean {
  return isCapacitor();
}

/**
 * Сохранить медиа так, чтобы оно появилось в галерее устройства.
 *
 * Обычное скачивание на Android клало файл в каталог документов
 * приложения: формально сохранено, а в галерее пусто — человек жмёт
 * «скачать», видит сообщение об успехе и не находит ни фото, ни видео.
 * Нативная сторона раскладывает по типу через MediaStore: картинки в
 * «Изображения», видео в «Видео», музыку в «Музыку».
 *
 * Где нативной стороны нет (браузер, настольное приложение) — обычное
 * скачивание, там оно и так работает правильно.
 */
export async function saveMediaToGallery(
  url: string,
  filename: string,
  kind: 'image' | 'video' | 'audio' | 'file' = 'file'
): Promise<void> {
  const bridge = (window as any).AndroidBridge;
  if (bridge?.saveToGallery) {
    const mime = kind === 'image' ? 'image/*'
               : kind === 'video' ? 'video/*'
               : kind === 'audio' ? 'audio/*'
               : '*/*';
    try {
      bridge.saveToGallery(url, filename, mime);
      return;
    } catch (e) {
      console.warn('Не вышло сохранить в галерею, качаем обычным путём:', e);
    }
  }
  await downloadFileNative(url, filename);
}

export async function downloadFileNative(url: string, filename: string): Promise<void> {
  // ─── Настольное приложение: качаем сами, а не отдаём браузеру ───
  //
  // Ниже по коду лежит «веб-запасной путь»: ссылка с download и
  // target="_blank". В браузере это нормальное скачивание, а в оболочке —
  // нет. target="_blank" уходит в обработчик открытия окон, и тот
  // отправляет адрес в системный браузер: нажимаешь «скачать» в
  // приложении, а качает Chrome. Вдобавок сам атрибут download работает
  // только для своего источника, а интерфейс здесь живёт на 127.0.0.1,
  // файлы же — на сервере.
  const electron = (window as any).electronAPI;
  if (electron?.downloadFile) {
    try {
      // blob: и data: оболочке не передать — их знает только страница.
      // Такие сохраняем прежним способом, но уже без target="_blank".
      if (/^(blob:|data:)/i.test(url)) {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        return;
      }
      await electron.downloadFile(url, filename);
      return;
    } catch (e) {
      console.error('[Настольное] не удалось начать загрузку:', e);
      // Дальше пробуем обычным путём — лучше так, чем ничего.
    }
  }

  if (isCapacitor()) {
    try {
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      
      console.log(`[Capacitor] Downloading file to Blob: ${filename} from ${url}`);
      
      // Загружаем в память (поддерживает blob:, data:, и обычные http URL)
      const res = await fetch(url);
      const blob = await res.blob();
      
      // Конвертируем Blob в Base64
      const base64Data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = reject;
        reader.onloadend = () => {
          const dataUrl = reader.result as string;
          const b64 = dataUrl.split(',')[1];
          resolve(b64);
        };
        reader.readAsDataURL(blob);
      });
      
      // Сохраняем расшифрованный файл на диск
      const result = await Filesystem.writeFile({
        path: filename,
        data: base64Data,
        directory: Directory.Documents,
      });
      
      console.log('[Capacitor] File saved successfully:', result.uri);
      
      try {
        const { Share } = await import('@capacitor/share');
        await Share.share({
          title: 'Скачанный файл',
          text: `Открыть файл ${filename}?`,
          url: result.uri,
          dialogTitle: 'Открыть или сохранить файл'
        });
      } catch (shareErr) {
        console.warn('[Capacitor] Share failed:', shareErr);
        try {
           const { LocalNotifications } = await import('@capacitor/local-notifications');
           await LocalNotifications.schedule({
             notifications: [{
               title: 'Загрузка завершена',
               body: `Файл ${filename} сохранен. Ищите в файлах устройства.`,
               id: Math.floor(Math.random() * 100000),
               schedule: { at: new Date(Date.now() + 1000) },
             }]
           });
        } catch (e) {
           alert(`Файл скачан: ${filename}`);
        }
      }
    } catch (e) {
      console.error('[Capacitor] Blob download/save error:', e);
      alert('Ошибка скачивания: ' + (e as Error).message);
    }
  } else {
    // Обычный браузер: пусть скачивает он сам.
    //
    // target="_blank" здесь убран намеренно. Он не нужен даже в вебе:
    // при работающем download открывается лишняя пустая вкладка, а если
    // источник чужой, то download игнорируется и вкладка вместо
    // скачивания просто показывает файл.
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
}

export default { initCapacitorBridge, isNativeApp, downloadFileNative, saveMediaToGallery };
