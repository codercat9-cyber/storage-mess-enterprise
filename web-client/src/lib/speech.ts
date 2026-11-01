// Расшифровка голосовых сообщений (Speech-to-Text)
// Серверная расшифровка через Vosk daemon / Groq / OpenAI / Whisper CLI

import { api } from './api';

interface TranscribeOptions {
  language?: string;
  onResult?: (text: string) => void;
  onError?: (error: string) => void;
}

// ═══════════════════════════════════════════════════════════════
//  Серверная расшифровка
// ═══════════════════════════════════════════════════════════════

async function transcribeViaServer(
  filename: string,
  language: string
): Promise<string | null> {
  const response = await api.post('/files/transcribe', { filename, language });
  return response.data?.text?.trim() || null;
}

// ═══════════════════════════════════════════════════════════════
//  Публичный API
// ═══════════════════════════════════════════════════════════════

/**
 * Расшифровать голосовое сообщение через сервер.
 */
export async function transcribeVoiceMessage(
  filename: string,
  options?: TranscribeOptions
): Promise<string | null> {
  const lang = options?.language || 'ru-RU';
  const serverLang = lang.split('-')[0]; // ru-RU → ru

  try {
    const text = await transcribeViaServer(filename, serverLang);
    if (text) {
      options?.onResult?.(text);
      return text;
    }
    options?.onError?.('Не удалось распознать речь в сообщении');
    return null;
  } catch (err: any) {
    const serverError = err.response?.data?.error || err.message || '';
    console.warn('Server transcription failed:', serverError);

    if (serverError.includes('not configured') || serverError.includes('not found')) {
      options?.onError?.(
        'Расшифровка не настроена на сервере.\n' +
        'Установите Vosk: pip install vosk\n' +
        'Или добавьте GROQ_API_KEY в .env (бесплатно: console.groq.com)'
      );
    } else {
      options?.onError?.(serverError || 'Ошибка расшифровки на сервере');
    }
    return null;
  }
}

/** Обратная совместимость — принимает filename напрямую */
export async function transcribeAudioFromUrl(
  filename: string,
  options?: TranscribeOptions & {
    onStart?: () => void;
    onEnd?: () => void;
  }
): Promise<string | null> {
  const parts = filename.split('/');
  const fn = parts[parts.length - 1]?.split('?')[0] || filename;

  options?.onStart?.();
  const result = await transcribeVoiceMessage(fn, options);
  options?.onEnd?.();
  return result;
}

export function stopTranscription(): void {
  // no-op — server handles transcription lifecycle
}

/** Отправить коррекцию транскрипции для обучения Vosk */
export async function learnTranscriptionCorrection(original: string, corrected: string): Promise<void> {
  try {
    await api.post('/files/transcribe/learn', { original, corrected });
  } catch (e) {
    console.warn('Failed to send transcription correction:', e);
  }
}

export function isSpeechRecognitionAvailable(): boolean {
  return true; // Серверная расшифровка всегда доступна
}

export const SUPPORTED_LANGUAGES = {
  'ru-RU': 'Русский',
  'en-US': 'English',
  'en-GB': 'English (UK)',
  'es-ES': 'Español',
  'fr-FR': 'Français',
  'de-DE': 'Deutsch',
  'it-IT': 'Italiano',
  'ja-JP': '日本語',
  'zh-CN': '中文',
  'pt-BR': 'Português',
};

export default {
  transcribeVoiceMessage,
  transcribeAudioFromUrl,
  stopTranscription,
  isSpeechRecognitionAvailable,
  SUPPORTED_LANGUAGES,
};
