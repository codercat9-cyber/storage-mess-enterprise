// =============================================================================
// Notification & Sound Service — PWA уведомления со звуком
//
// Звук сообщения: ICQ-style «Uh-Oh» (два быстрых тона)
// Звук звонка: Skype-style рингтон (тройные восходящие ноты)
// Поддержка кастомных звуков из localStorage
// =============================================================================

// ─── Дефолтные звуковые файлы ───
const DEFAULT_MESSAGE_SOUND_URL = '/sounds/message.mp3';
const DEFAULT_RINGTONE_SOUND_URL = '/sounds/ringtone.mp3';

// ─── localStorage ключи для кастомных звуков ───
const CUSTOM_MESSAGE_SOUND_KEY = 'custom_message_sound';
const CUSTOM_RINGTONE_SOUND_KEY = 'custom_ringtone_sound';
const CUSTOM_MESSAGE_SOUND_NAME_KEY = 'custom_message_sound_name';
const CUSTOM_RINGTONE_SOUND_NAME_KEY = 'custom_ringtone_sound_name';

// ─── Состояние ───
let messageAudio: HTMLAudioElement | null = null;
let ringtoneAudio: HTMLAudioElement | null = null;
let ringtoneLoopInterval: ReturnType<typeof setInterval> | null = null;
let notificationPermission: NotificationPermission = 'default';
let soundEnabled = true;
let notificationsEnabled = true;

// ─── Per-chat mute ───
const MUTED_CHATS_KEY = 'muted_chats';

export function getMutedChats(): Set<string> {
  try {
    const raw = localStorage.getItem(MUTED_CHATS_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch { return new Set(); }
}

export function isChatMuted(chatId: string): boolean {
  return getMutedChats().has(chatId);
}

export function setChatMuted(chatId: string, muted: boolean): void {
  const set = getMutedChats();
  if (muted) set.add(chatId); else set.delete(chatId);
  try { localStorage.setItem(MUTED_CHATS_KEY, JSON.stringify([...set])); } catch {}
}

function getMessageSoundUrl(): string {
  try {
    return localStorage.getItem(CUSTOM_MESSAGE_SOUND_KEY) || DEFAULT_MESSAGE_SOUND_URL;
  } catch { return DEFAULT_MESSAGE_SOUND_URL; }
}

function getRingtoneSoundUrl(): string {
  try {
    return localStorage.getItem(CUSTOM_RINGTONE_SOUND_KEY) || DEFAULT_RINGTONE_SOUND_URL;
  } catch { return DEFAULT_RINGTONE_SOUND_URL; }
}

// Предзагрузка аудио для мгновенного воспроизведения
function preloadAudio(): void {
  const msgUrl = getMessageSoundUrl();
  if (!messageAudio || messageAudio.src !== msgUrl) {
    messageAudio = new Audio(msgUrl);
    messageAudio.preload = 'auto';
    messageAudio.volume = 0.7;
  }
  const ringUrl = getRingtoneSoundUrl();
  if (!ringtoneAudio || ringtoneAudio.src !== ringUrl) {
    ringtoneAudio = new Audio(ringUrl);
    ringtoneAudio.preload = 'auto';
    ringtoneAudio.volume = 0.9;
    ringtoneAudio.loop = true;
  }
}

// ─── Кастомные звуки ───
export function setCustomMessageSound(dataUrl: string | null, fileName?: string): void {
  try {
    if (dataUrl) {
      localStorage.setItem(CUSTOM_MESSAGE_SOUND_KEY, dataUrl);
      if (fileName) localStorage.setItem(CUSTOM_MESSAGE_SOUND_NAME_KEY, fileName);
    } else {
      localStorage.removeItem(CUSTOM_MESSAGE_SOUND_KEY);
      localStorage.removeItem(CUSTOM_MESSAGE_SOUND_NAME_KEY);
    }
    // Пересоздаём аудио объект с новым URL
    messageAudio = null;
    preloadAudio();
  } catch {}
}

export function setCustomRingtone(dataUrl: string | null, fileName?: string): void {
  try {
    if (dataUrl) {
      localStorage.setItem(CUSTOM_RINGTONE_SOUND_KEY, dataUrl);
      if (fileName) localStorage.setItem(CUSTOM_RINGTONE_SOUND_NAME_KEY, fileName);
    } else {
      localStorage.removeItem(CUSTOM_RINGTONE_SOUND_KEY);
      localStorage.removeItem(CUSTOM_RINGTONE_SOUND_NAME_KEY);
    }
    ringtoneAudio = null;
    preloadAudio();
  } catch {}
}

export function getCustomMessageSoundName(): string | null {
  try { return localStorage.getItem(CUSTOM_MESSAGE_SOUND_NAME_KEY); } catch { return null; }
}

export function getCustomRingtoneName(): string | null {
  try { return localStorage.getItem(CUSTOM_RINGTONE_SOUND_NAME_KEY); } catch { return null; }
}

export function hasCustomMessageSound(): boolean {
  try { return !!localStorage.getItem(CUSTOM_MESSAGE_SOUND_KEY); } catch { return false; }
}

export function hasCustomRingtone(): boolean {
  try { return !!localStorage.getItem(CUSTOM_RINGTONE_SOUND_KEY); } catch { return false; }
}

// ─── Инициализация ───
export function initNotifications(): void {
  preloadAudio();

  // Проверяем текущее разрешение
  if ('Notification' in window) {
    notificationPermission = Notification.permission;
  }

  // Разблокировка звука после первого касания — и почему её здесь больше
  // почти нет.
  //
  // Браузер не даёт проигрывать звук, пока человек не коснулся страницы.
  // Обходили это так: при первом касании проигрывали звук сообщения и
  // рингтон, тут же ставя на паузу. Человек ничего не слышал — но система
  // слышала. Android на каждое такое проигрывание выдаёт приложению
  // звуковой фокус и приглушает чужое: открываешь мессенджер, трогаешь
  // экран — и музыка в другом приложении становится тише. Причём дважды,
  // потому что звуков было два.
  //
  // В приложении на телефоне это вообще не нужно: оболочка разрешает
  // воспроизведение без жеста (setMediaPlaybackRequiresUserGesture(false)),
  // и звуки играют сразу. Разблокировка нужна только обычному браузеру.
  const этоПриложение =
    typeof window !== 'undefined' &&
    (Boolean((window as any).Capacitor?.isNativePlatform?.()) ||
      Boolean((window as any).AndroidBridge) ||
      /Electron/i.test(navigator.userAgent));

  if (этоПриложение) return;

  const unlockAudio = () => {
    // Разблокируем ОДИН звук и полностью беззвучно: с нулевой громкостью
    // система не считает это воспроизведением и чужое не приглушает.
    // Рингтон не трогаем — он и так зазвучит, когда придёт звонок.
    if (messageAudio) {
      const былаГромкость = messageAudio.volume;
      messageAudio.volume = 0;
      messageAudio.play().then(() => {
        messageAudio!.pause();
        messageAudio!.currentTime = 0;
        messageAudio!.volume = былаГромкость;
      }).catch(() => {
        if (messageAudio) messageAudio.volume = былаГромкость;
      });
    }
    document.removeEventListener('click', unlockAudio);
    document.removeEventListener('touchstart', unlockAudio);
    document.removeEventListener('keydown', unlockAudio);
  };

  document.addEventListener('click', unlockAudio, { once: true });
  document.addEventListener('touchstart', unlockAudio, { once: true });
  document.addEventListener('keydown', unlockAudio, { once: true });
}

// ─── Запрос разрешения на уведомления ───
export async function requestNotificationPermission(): Promise<boolean> {
  if (!('Notification' in window)) {
    console.warn('[NOTIFY] Notifications API not supported');
    return false;
  }

  if (Notification.permission === 'granted') {
    notificationPermission = 'granted';
    return true;
  }

  if (Notification.permission === 'denied') {
    console.warn('[NOTIFY] Notifications blocked by user');
    return false;
  }

  try {
    const permission = await Notification.requestPermission();
    notificationPermission = permission;
    return permission === 'granted';
  } catch {
    return false;
  }
}

// ─── Настройки ───
export function setSoundEnabled(enabled: boolean): void {
  soundEnabled = enabled;
}

export function setNotificationsEnabled(enabled: boolean): void {
  notificationsEnabled = enabled;
}

// Тестовое воспроизведение (для проверки кастомных звуков)
export function previewMessageSound(): void {
  preloadAudio();
  if (messageAudio) {
    messageAudio.currentTime = 0;
    messageAudio.play().catch(() => {});
  }
}

export function previewRingtone(): void {
  preloadAudio();
  if (ringtoneAudio) {
    ringtoneAudio.currentTime = 0;
    ringtoneAudio.loop = false; // Не зацикливаем для превью
    ringtoneAudio.play().catch(() => {});
    setTimeout(() => { if (ringtoneAudio) { ringtoneAudio.pause(); ringtoneAudio.currentTime = 0; } }, 3000);
  }
}

export function getSoundEnabled(): boolean {
  return soundEnabled;
}

export function getNotificationsEnabled(): boolean {
  return notificationsEnabled;
}

// ─── Воспроизведение звуков ───

export function playMessageSound(): void {
  if (!soundEnabled) return;

  // APK: нативный звук через STREAM_NOTIFICATION (громкость "Уведомления")
  const bridge = (window as any).AndroidBridge;
  if (bridge?.playMessageSound) {
    try { bridge.playMessageSound(); return; } catch (e) { console.warn('Native playMessageSound error:', e); }
  }

  // Capacitor plugin fallback
  if ((window as any).Capacitor?.isNativePlatform?.()) {
    try {
      const NativeAudio = (window as any).Capacitor.Plugins.NativeAudio;
      if (NativeAudio) {
        NativeAudio.playMessageSound({ path: getMessageSoundUrl().replace('/', '') });
        return;
      }
    } catch (e) { console.warn('NativeAudio error:', e); }
  }

  // Web fallback: HTMLAudioElement (STREAM_MUSIC)
  preloadAudio();
  try {
    if (messageAudio) {
      messageAudio.currentTime = 0;
      messageAudio.play().catch((err) => {
        console.warn('[NOTIFY] Cannot play message sound:', err.name);
      });
    }
  } catch (e) {
    console.warn('[NOTIFY] Message sound error:', e);
  }
}

export function playRingtone(): void {
  if (!soundEnabled) return;

  // APK: нативный рингтон через STREAM_RING (громкость "Звонок")
  const bridge = (window as any).AndroidBridge;
  if (bridge?.playNativeRingtone) {
    try { bridge.playNativeRingtone(); return; } catch (e) { console.warn('Native playNativeRingtone error:', e); }
  }

  // Capacitor plugin fallback
  if ((window as any).Capacitor?.isNativePlatform?.()) {
    try {
      const NativeAudio = (window as any).Capacitor.Plugins.NativeAudio;
      if (NativeAudio) {
        NativeAudio.playRingtone({ path: getRingtoneSoundUrl().replace('/', '') });
        return;
      }
    } catch (e) { console.warn('NativeAudio error:', e); }
  }

  // Web fallback: HTMLAudioElement (STREAM_MUSIC)
  preloadAudio();

  if (ringtoneAudio && !ringtoneAudio.paused) {
    console.log('[NOTIFY] Ringtone is already playing, skipping duplicate start');
    return;
  }

  try {
    if (ringtoneAudio) {
      ringtoneAudio.currentTime = 0;
      ringtoneAudio.loop = true;
      ringtoneAudio.play().catch((err) => {
        console.warn('[NOTIFY] Cannot play ringtone:', err.name);
        if (!ringtoneLoopInterval) {
          ringtoneLoopInterval = setInterval(() => {
            ringtoneAudio?.play().catch(() => {});
          }, 4000);
        }
      });
    }
  } catch (e) {
    console.warn('[NOTIFY] Ringtone error:', e);
  }
}

export function stopRingtone(): void {
  // APK: остановить нативный рингтон
  const bridge = (window as any).AndroidBridge;
  if (bridge?.stopNativeRingtone) {
    try { bridge.stopNativeRingtone(); } catch (e) {}
  }

  if ((window as any).Capacitor?.isNativePlatform?.()) {
    try {
      const NativeAudio = (window as any).Capacitor.Plugins.NativeAudio;
      if (NativeAudio) NativeAudio.stopRingtone();
    } catch (e) {}
  }

  if (ringtoneAudio) {
    ringtoneAudio.pause();
    ringtoneAudio.currentTime = 0;
    ringtoneAudio.loop = false;
  }
  if (ringtoneLoopInterval) {
    clearInterval(ringtoneLoopInterval);
    ringtoneLoopInterval = null;
  }
}

/**
 * Проверить, играет ли рингтон
 */
export function isRingtonePlaying(): boolean {
  return ringtoneAudio ? !ringtoneAudio.paused : false;
}

// ─── PWA Уведомления ───

/**
 * Показать уведомление о новом сообщении + звук ICQ
 */
export function notifyNewMessage(
  senderName: string,
  messageText: string,
  chatId?: string,
  avatarUrl?: string,
  messageId?: string,
  forceMentioned?: boolean,
): void {
  // Per-chat mute: пропускаем уведомление если чат замьючен (кроме @mention)
  if (chatId && isChatMuted(chatId) && !forceMentioned) return;

  // Звук всегда (если включён), даже когда вкладка активна
  playMessageSound();

  // Android APK: нативное уведомление + вибрация (работает даже в фоне)
  const bridge = (window as any).AndroidBridge;
  if (bridge?.showMessageNotificationWithId || bridge?.showMessageNotification) {
    try {
      const isBackground = bridge.isAppInBackground?.() ?? (document.visibilityState !== 'visible');
      if (isBackground) {
        const text = messageText.length > 200 ? messageText.slice(0, 197) + '...' : messageText;
        if (bridge.showMessageNotificationWithId) {
          bridge.showMessageNotificationWithId(senderName, text, chatId || '', avatarUrl || '', messageId || '');
        } else {
          bridge.showMessageNotification(senderName, text, chatId || '', avatarUrl || '');
        }
        return; // Нативное уведомление показано — web-уведомление не нужно
      }
    } catch (e) { /* fallback to web notification */ }
  }

  // PWA уведомление только если вкладка не в фокусе
  if (document.visibilityState === 'visible') return;
  if (!notificationsEnabled) return;

  showNotification(
    `💬 ${senderName}`,
    {
      body: messageText.length > 100 ? messageText.slice(0, 97) + '...' : messageText,
      icon: avatarUrl || '/pwa-192x192.png',
      badge: '/pwa-64x64.png',
      tag: `msg-${chatId || 'default'}`, // Группировка по чату
      renotify: true, // Уведомлять даже если есть предыдущее с таким tag
      data: { type: 'message', chatId, messageId },
      silent: true, // Мы играем свой звук, системный не нужен
    },
  );
}

/**
 * Показать уведомление о входящем звонке + рингтон Skype
 */
export function notifyIncomingCall(
  callerName: string,
  callType: 'audio' | 'video',
  callId?: string,
): void {
  // Рингтон
  playRingtone();

  // Android APK: нативное уведомление + вибрация (показ на экране блокировки)
  const bridge = (window as any).AndroidBridge;
  if (bridge?.showCallNotification) {
    try {
      bridge.showCallNotification(callerName, callType, callId || '', '');
    } catch (e) { /* fallback */ }
  }

  // PWA уведомление (даже если вкладка активна — звонок важен)
  if (!notificationsEnabled) return;

  const callTypeText = callType === 'video' ? '📹 Видеозвонок' : '📞 Аудиозвонок';

  showNotification(
    `${callTypeText} от ${callerName}`,
    {
      body: 'Нажмите чтобы ответить',
      icon: '/pwa-192x192.png',
      badge: '/pwa-64x64.png',
      tag: `call-${callId || 'incoming'}`,
      renotify: true,
      requireInteraction: true, // Не исчезает автоматически
      data: { type: 'call', callId, callType },
      silent: true, // Свой рингтон
    },
  );
}

/**
 * Закрыть уведомление о звонке (когда ответили или сбросили)
 */
export function dismissCallNotification(callId?: string): void {
  stopRingtone();

  // Android APK: убрать нативное уведомление
  const bridge = (window as any).AndroidBridge;
  if (bridge?.dismissCallNotification) {
    try { bridge.dismissCallNotification(); } catch (e) {}
  }

  // Закрываем уведомление через Service Worker
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: 'DISMISS_NOTIFICATION',
      tag: `call-${callId || 'incoming'}`,
    });
  }
}

/**
 * Уведомление о завершении звонка
 */
export function notifyCallEnded(): void {
  stopRingtone();
}

// ─── Внутренняя функция — показ уведомления ───
function showNotification(
  title: string,
  options: NotificationOptions & { data?: any; renotify?: boolean; requireInteraction?: boolean },
): void {
  // В Capacitor нативном приложении — используем LocalNotifications
  // (не создаёт уродский (ⓘ) значок, использует иконку приложения)
  if ((window as any).Capacitor?.isNativePlatform?.()) {
    import('@capacitor/local-notifications').then(({ LocalNotifications }) => {
      LocalNotifications.schedule({
        notifications: [{
          title: title,
          body: options.body || '',
          id: Math.floor(Math.random() * 100000),
          sound: undefined,
          extra: options.data,
        }]
      });
    }).catch((e: any) => console.warn('[NOTIFY] LocalNotifications error:', e));
    return;
  }

  if (notificationPermission !== 'granted') {
    // Пробуем запросить разрешение
    requestNotificationPermission().then((granted) => {
      if (granted) showNotification(title, options);
    });
    return;
  }

  try {
    // Предпочитаем Service Worker уведомления (работают в фоне, PWA)
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.ready.then((registration) => {
        // Silent уведомления НЕ могут иметь vibrate (спецификация браузера)
        const swOptions: any = { ...options };
        if (!options.silent) {
          swOptions.vibrate = options.data?.type === 'call'
            ? [300, 200, 300, 200, 300] // Длинная вибрация для звонка
            : [100, 50, 100];            // Короткая для сообщения
        }
        registration.showNotification(title, swOptions);
      }).catch(() => {
        // Fallback: обычное уведомление
        new Notification(title, options as any);
      });
    } else {
      // Fallback: обычное уведомление (не PWA)
      new Notification(title, options as any);
    }
  } catch (e) {
    console.warn('[NOTIFY] Cannot show notification:', e);
  }
}

// ─── Обработка кликов по уведомлениям (из Service Worker) ───
export function setupNotificationClickHandler(): void {
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data;
    if (!data) return;

    if (data.type === 'NOTIFICATION_CLICK') {
      // Фокусируем окно
      window.focus();

      if (data.notificationData?.type === 'message' && data.notificationData?.chatId) {
        // Переход к чату
        const chatId = data.notificationData.chatId;
        window.dispatchEvent(new CustomEvent('navigate-to-chat', { detail: { chatId } }));
      } else if (data.notificationData?.type === 'call') {
        // Фокус на звонок — ничего extra не делаем, UI уже показывает диалог звонка
      }
    }
  });
}
