// Голосовые сообщения - запись и воспроизведение
let mediaRecorder: MediaRecorder | null = null;
let audioChunks: Blob[] = [];
let recordingStartTime: number = 0;
let recordingStream: MediaStream | null = null;
let recordingMimeType: string = 'audio/webm';

// Определяем лучший поддерживаемый MIME-тип для записи
function getBestAudioMime(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
    'audio/mp4',
  ];
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return ''; // пусто = браузер выберет сам
}

// Получить расширение файла по MIME-типу
function mimeToExt(mime: string): string {
  if (mime.includes('webm')) return '.webm';
  if (mime.includes('ogg')) return '.ogg';
  if (mime.includes('mp4')) return '.mp4';
  if (mime.includes('mpeg')) return '.mp3';
  return '.webm'; // по умолчанию
}

// Начать запись голосового сообщения
export async function startRecording(): Promise<boolean> {
  try {
    // Запрашиваем доступ к микрофону
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordingStream = stream;
    
    audioChunks = [];
    
    // Выбираем лучший поддерживаемый формат
    const bestMime = getBestAudioMime();
    recordingMimeType = bestMime || 'audio/webm';
    
    const options: MediaRecorderOptions = {};
    if (bestMime) {
      options.mimeType = bestMime;
    }
    
    mediaRecorder = new MediaRecorder(stream, options);
    // Сохраняем реальный MIME-тип который MediaRecorder выбрал
    recordingMimeType = mediaRecorder.mimeType || recordingMimeType;
    console.log('MediaRecorder using mimeType:', recordingMimeType);
    
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };
    
    // Записываем одним куском (без timeslice) — 
    // это гарантирует целостный WebM-файл с EBML-заголовком.
    // Раньше start(100) разбивал на чанки по 100ms, что иногда 
    // приводило к потере заголовка при склейке → повреждённые файлы.
    mediaRecorder.start();
    recordingStartTime = Date.now();
    
    console.log('Recording started');
    return true;
  } catch (error) {
    console.error('Error starting recording:', error);
    return false;
  }
}

// Остановить запись и вернуть Blob
export function stopRecording(): Promise<{ blob: Blob; duration: number } | null> {
  return new Promise((resolve) => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      resolve(null);
      return;
    }
    
    const duration = Date.now() - recordingStartTime;
    
    mediaRecorder.onstop = () => {
      // Используем РЕАЛЬНЫЙ MIME-тип от MediaRecorder
      const blob = new Blob(audioChunks, { type: recordingMimeType });
      
      // Останавливаем все треки
      if (recordingStream) {
        recordingStream.getTracks().forEach(track => track.stop());
        recordingStream = null;
      }
      
      console.log('Recording stopped, duration:', duration, 'ms, size:', blob.size);
      resolve({ blob, duration });
    };
    
    mediaRecorder.stop();
  });
}

// Отменить запись
export function cancelRecording(): void {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  
  if (recordingStream) {
    recordingStream.getTracks().forEach(track => track.stop());
    recordingStream = null;
  }
  
  audioChunks = [];
}

// Воспроизвести аудио blob
export function playAudio(blob: Blob): HTMLAudioElement | null {
  const audioUrl = URL.createObjectURL(blob);
  const audio = new Audio(audioUrl);
  try { (window as any).AndroidBridge?.requestAudioFocus?.(); } catch (e) {}
  audio.play().catch((err) => {
    console.warn('Audio blob play() rejected:', err?.name || err);
  });
  return audio;
}

// Воспроизвести аудио с сервера по URL
export function playAudioFromUrl(url: string): HTMLAudioElement | null {
  const audio = new Audio();
  
  // Устанавливаем обработчики ДО начала воспроизведения
  audio.onerror = (e) => {
    console.error('Audio playback error:', audio.error?.code, audio.error?.message, url);
  };
  
  audio.crossOrigin = 'anonymous';
  audio.src = url;
  
  try { (window as any).AndroidBridge?.requestAudioFocus?.(); } catch (e) {}
  // play() возвращает Promise — обязательно обрабатываем отказ
  const playPromise = audio.play();
  if (playPromise) {
    playPromise.catch((err) => {
      const errName = err?.name || '';
      // NotSupportedError = файл повреждён или формат не поддерживается — НЕ делаем retry
      if (errName === 'NotSupportedError') {
        console.error('Audio format not supported (file may be corrupt):', url);
        return;
      }
      console.warn('Audio play() rejected:', errName, '- retrying after load');
      // Autoplay заблокирован — пробуем через canplaythrough
      const retryPlay = () => {
        audio.play().catch(e => console.error('Audio retry failed:', e?.name || e));
        audio.removeEventListener('canplaythrough', retryPlay);
      };
      audio.addEventListener('canplaythrough', retryPlay);
      audio.load();
    });
  }
  
  return audio;
}

// Конвертировать Blob в base64 для отправки
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result as string;
      // Убираем data:audio/ogg;base64, prefix
      const base64Data = base64.split(',')[1];
      resolve(base64Data);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Конвертировать base64 в Blob
export function base64ToBlob(base64: string, mimeType: string = 'audio/ogg'): Blob {
  const byteCharacters = atob(base64);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: mimeType });
}

export default {
  startRecording,
  stopRecording,
  cancelRecording,
  playAudio,
  blobToBase64,
  base64ToBlob,
};
