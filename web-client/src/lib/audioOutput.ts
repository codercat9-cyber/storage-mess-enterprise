// =============================================================================
// Audio Output Switching — переключение динамик ↔ разговорный динамик
// + выбор конкретного устройства ввода/вывода (микрофон, динамик)
// Работает в PWA на мобильных устройствах (Android Chrome) и на десктопе
// =============================================================================

export type AudioOutputMode = 'earpiece' | 'speaker';

export interface AudioDeviceInfo {
  deviceId: string;
  label: string;
  kind: 'audioinput' | 'audiooutput';
  isDefault: boolean;
}

let currentMode: AudioOutputMode = 'earpiece'; // По умолчанию — разговорный динамик
let currentOutputDeviceId: string | null = null; // Конкретный выбранный выход
let currentInputDeviceId: string | null = null;  // Конкретный выбранный вход (микрофон)
const trackedElements = new Set<HTMLMediaElement>();
const trackedContexts = new Set<AudioContext>(); // AudioContext'ы для setSinkId

// Слушатели изменения устройств
type DeviceChangeListener = () => void;
const deviceChangeListeners = new Set<DeviceChangeListener>();

// Подписка на смену устройств (подключение/отключение)
if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    deviceChangeListeners.forEach(fn => fn());
  });
}

export function onDeviceChange(listener: DeviceChangeListener): () => void {
  deviceChangeListeners.add(listener);
  return () => deviceChangeListeners.delete(listener);
}

/**
 * Определить платформу: mobile или desktop
 */
function isMobilePlatform(): boolean {
  return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/**
 * Поддерживается ли переключение аудиовыхода (HTMLMediaElement)
 */
export function isAudioOutputSupported(): boolean {
  return typeof HTMLMediaElement.prototype.setSinkId === 'function';
}

/**
 * Поддерживается ли AudioContext.setSinkId (Chrome 110+)
 */
function isAudioContextSinkIdSupported(): boolean {
  return typeof (AudioContext.prototype as any).setSinkId === 'function';
}

/**
 * Получить текущий режим
 */
export function getAudioOutputMode(): AudioOutputMode {
  return currentMode;
}

/**
 * Найти ID устройства для earpiece / speaker
 */
async function findDeviceId(mode: AudioOutputMode): Promise<string> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices.filter(d => d.kind === 'audiooutput');

    if (mode === 'earpiece') {
      // Приоритет: communications → earpiece → telephony → пустая строка (системный дефолт)
      const earpiece = outputs.find(d =>
        d.deviceId === 'communications' ||
        d.label.toLowerCase().includes('earpiece') ||
        d.label.toLowerCase().includes('разговорн') ||
        d.label.toLowerCase().includes('телефон') ||
        d.label.toLowerCase().includes('telephony')
      );
      if (earpiece) return earpiece.deviceId;
      // На мобильных, пустая строка обычно означает "основной динамик" (earpiece при звонке)
      return '';
    } else {
      // Speaker: ищем громкоговоритель
      const speaker = outputs.find(d =>
        d.label.toLowerCase().includes('speaker') ||
        d.label.toLowerCase().includes('громкоговоритель') ||
        d.label.toLowerCase().includes('громк') ||
        (d.deviceId === 'default' && outputs.length > 1)
      );
      if (speaker) return speaker.deviceId;
      return 'default';
    }
  } catch {
    return mode === 'earpiece' ? '' : 'default';
  }
}

/**
 * Применить sinkId к одному HTMLMediaElement
 */
async function applySinkId(element: HTMLMediaElement, deviceId: string): Promise<boolean> {
  try {
    await (element as any).setSinkId(deviceId);
    return true;
  } catch (err) {
    console.warn('[AudioOutput] setSinkId failed:', err);
    return false;
  }
}

/**
 * Применить sinkId к AudioContext (Chrome 110+)
 */
async function applyContextSinkId(ctx: AudioContext, deviceId: string): Promise<boolean> {
  try {
    await (ctx as any).setSinkId(deviceId);
    return true;
  } catch (err) {
    console.warn('[AudioOutput] AudioContext.setSinkId failed:', err);
    return false;
  }
}

/**
 * Переключить режим аудиовыхода
 */
export async function setAudioOutputMode(mode: AudioOutputMode): Promise<boolean> {
  currentMode = mode;
  const deviceId = await findDeviceId(mode);
  let success = false;

  // Применяем к HTMLMediaElement (если setSinkId поддерживается)
  if (isAudioOutputSupported()) {
    for (const el of trackedElements) {
      if (el.isConnected) {
        const ok = await applySinkId(el, deviceId);
        if (ok) success = true;
      } else {
        trackedElements.delete(el);
      }
    }
  }

  // Применяем к AudioContext (Chrome 110+) — КРИТИЧНО для WebRTC GainNode
  if (isAudioContextSinkIdSupported()) {
    for (const ctx of trackedContexts) {
      if (ctx.state !== 'closed') {
        const ok = await applyContextSinkId(ctx, deviceId);
        if (ok) success = true;
      } else {
        trackedContexts.delete(ctx);
      }
    }
  }

  console.log(`[AudioOutput] Switched to ${mode} (deviceId: ${deviceId}), elements: ${trackedElements.size}, contexts: ${trackedContexts.size}`);
  return success;
}

/**
 * Переключить (toggle) между earpiece ↔ speaker
 */
export async function toggleAudioOutput(): Promise<AudioOutputMode> {
  const newMode: AudioOutputMode = currentMode === 'earpiece' ? 'speaker' : 'earpiece';
  await setAudioOutputMode(newMode);
  return newMode;
}

/**
 * Зарегистрировать audio/video элемент для управления выходом.
 * При регистрации сразу применяет текущий режим.
 */
export function registerAudioElement(element: HTMLMediaElement): void {
  if (!element || trackedElements.has(element)) return;
  trackedElements.add(element);

  if (isAudioOutputSupported()) {
    findDeviceId(currentMode).then(deviceId => {
      applySinkId(element, deviceId).catch(() => {});
    });
  }
}

/**
 * Убрать элемент из отслеживания
 */
export function unregisterAudioElement(element: HTMLMediaElement): void {
  trackedElements.delete(element);
}

/**
 * Зарегистрировать AudioContext для управления выходом.
 * При регистрации сразу применяет текущий режим.
 */
export function registerAudioContext(ctx: AudioContext): void {
  if (!ctx || trackedContexts.has(ctx)) return;
  trackedContexts.add(ctx);

  if (isAudioContextSinkIdSupported()) {
    findDeviceId(currentMode).then(deviceId => {
      applyContextSinkId(ctx, deviceId).catch(() => {});
    });
  }
}

/**
 * Убрать AudioContext из отслеживания
 */
export function unregisterAudioContext(ctx: AudioContext): void {
  trackedContexts.delete(ctx);
}

/**
 * Сбросить все (при завершении звонка)
 */
export function resetAudioOutput(): void {
  trackedElements.clear();
  trackedContexts.clear();
  currentMode = 'earpiece';
  currentOutputDeviceId = null;
  currentInputDeviceId = null;
}

// =============================================================================
// Перечисление и выбор конкретных устройств (десктоп + мобильный)
// =============================================================================

/**
 * Получить список доступных аудиоустройств вывода (динамики, наушники, bluetooth)
 */
export async function getOutputDevices(): Promise<AudioDeviceInfo[]> {
  try {
    let devices = await navigator.mediaDevices.enumerateDevices();
    let outputs = devices.filter(d => d.kind === 'audiooutput');
    // Убрали автоматический getUserMedia, чтобы не вызывать ducking при входе в чат
    return outputs.map(d => ({
      deviceId: d.deviceId,
      label: d.label || `Динамик (${d.deviceId.slice(0, 8)})`,
      kind: 'audiooutput' as const,
      isDefault: d.deviceId === 'default',
    }));
  } catch {
    return [];
  }
}

/**
 * Получить список доступных микрофонов
 */
export async function getInputDevices(): Promise<AudioDeviceInfo[]> {
  try {
    let devices = await navigator.mediaDevices.enumerateDevices();
    let inputs = devices.filter(d => d.kind === 'audioinput');
    // Убрали автоматический getUserMedia, чтобы не вызывать ducking при входе в чат
    return inputs.map(d => ({
      deviceId: d.deviceId,
      label: d.label || `Микрофон (${d.deviceId.slice(0, 8)})`,
      kind: 'audioinput' as const,
      isDefault: d.deviceId === 'default',
    }));
  } catch {
    return [];
  }
}

/**
 * Установить конкретное устройство вывода звука по deviceId
 */
export async function setOutputDevice(deviceId: string): Promise<boolean> {
  currentOutputDeviceId = deviceId;
  let success = false;

  if (isAudioOutputSupported()) {
    for (const el of trackedElements) {
      if (el.isConnected) {
        const ok = await applySinkId(el, deviceId);
        if (ok) success = true;
      } else {
        trackedElements.delete(el);
      }
    }
  }

  if (isAudioContextSinkIdSupported()) {
    for (const ctx of trackedContexts) {
      if (ctx.state !== 'closed') {
        const ok = await applyContextSinkId(ctx, deviceId);
        if (ok) success = true;
      } else {
        trackedContexts.delete(ctx);
      }
    }
  }

  console.log(`[AudioOutput] Set output device: ${deviceId}`);
  return success;
}

/**
 * Получить текущий выбранный deviceId для вывода
 */
export function getCurrentOutputDeviceId(): string | null {
  return currentOutputDeviceId;
}

/**
 * Получить текущий выбранный deviceId для ввода
 */
export function getCurrentInputDeviceId(): string | null {
  return currentInputDeviceId;
}

/**
 * Установить текущий микрофон (deviceId хранится, применяется при следующем getUserMedia)
 */
export function setInputDevice(deviceId: string): void {
  currentInputDeviceId = deviceId;
  console.log(`[AudioOutput] Set input device: ${deviceId}`);
}

/**
 * Умный выбор устройства по умолчанию при начале звонка.
 * Mobile: earpiece (разговорный динамик).
 * Desktop: приоритет headphones > bluetooth > default speakers.
 */
export async function selectSmartDefault(): Promise<{ outputId: string; inputId: string }> {
  const outputs = await getOutputDevices();
  const inputs = await getInputDevices();
  
  let outputId = 'default';
  let inputId = 'default';

  if (isMobilePlatform()) {
    // Мобильный — earpiece по умолчанию
    currentMode = 'earpiece';
    const earpieceId = await findDeviceId('earpiece');
    outputId = earpieceId || '';
  } else {
    // Десктоп — ищем наушники/bluetooth/колонка
    currentMode = 'speaker';
    
    const headphones = outputs.find(d =>
      /headphone|наушник|headset|гарнитур/i.test(d.label)
    );
    const bluetooth = outputs.find(d =>
      /bluetooth|блютуз|bt /i.test(d.label)
    );
    const usbAudio = outputs.find(d =>
      /usb|юсб/i.test(d.label)
    );
    
    if (headphones) {
      outputId = headphones.deviceId;
    } else if (bluetooth) {
      outputId = bluetooth.deviceId;
    } else if (usbAudio) {
      outputId = usbAudio.deviceId;
    } else {
      outputId = outputs.find(d => d.isDefault)?.deviceId || 'default';
    }
  }

  // Микрофон — default или первый доступный
  inputId = inputs.find(d => d.isDefault)?.deviceId || inputs[0]?.deviceId || 'default';

  currentOutputDeviceId = outputId;
  currentInputDeviceId = inputId;

  // Применяем выход к уже зарегистрированным элементам
  if (outputId && outputId !== 'default') {
    await setOutputDevice(outputId);
  }

  return { outputId, inputId };
}
