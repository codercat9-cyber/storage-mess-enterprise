/**
 * haptic-dsp.ts — DSP pipeline для генерации haptic-паттернов из аудио.
 * 
 * Pipeline: PCM → Butterworth LPF 200Hz → RMS (окнами) → Onset Detection → PostProcess → VibrationPulse[]
 * 
 * Вдохновлено BeatVibrator (JumpingKeyCaps/BeatVibrator) — портировано на TypeScript/Web Audio.
 */

import { decodeAudioBuffer, decodeUnavailableReason } from '@/lib/decodeAudio';

// ─── Types ───

export interface VibrationPulse {
  timeMs: number;      // Время начала (мс от начала трека)
  amplitude: number;   // Амплитуда 0-255
  durationMs: number;  // Длительность импульса (мс)
}

export interface HapticPattern {
  pulses: VibrationPulse[];
  durationMs: number;
  bpm: number | null;
}

// ─── Butterworth 2nd-order Low-Pass Filter ───

function butterworthLowPass(samples: Float32Array, cutoffHz: number, sampleRate: number): Float32Array {
  const omega = 2 * Math.PI * cutoffHz / sampleRate;
  const sinO = Math.sin(omega);
  const cosO = Math.cos(omega);
  const q = Math.SQRT2 / 2; // 0.7071 — Butterworth Q
  const alpha = sinO / (2 * q);

  const a0Inv = 1 / (1 + alpha);
  const b0 = ((1 - cosO) / 2) * a0Inv;
  const b1 = (1 - cosO) * a0Inv;
  const b2 = b0;
  const a1 = (-2 * cosO) * a0Inv;
  const a2 = (1 - alpha) * a0Inv;

  const out = new Float32Array(samples.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;

  for (let i = 0; i < samples.length; i++) {
    const x0 = samples[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x0;
    y2 = y1; y1 = y0;
    out[i] = y0;
  }
  return out;
}

// ─── RMS Calculator ───

function computeRms(samples: Float32Array, windowSize: number, hopSize: number): Float32Array {
  const count = Math.floor((samples.length - windowSize) / hopSize) + 1;
  if (count <= 0) return new Float32Array(0);
  const rms = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const start = i * hopSize;
    let sum = 0;
    for (let j = start; j < start + windowSize && j < samples.length; j++) {
      sum += samples[j] * samples[j];
    }
    rms[i] = Math.sqrt(sum / windowSize);
  }

  // Normalize to [0, 1]
  let max = 0;
  for (let i = 0; i < rms.length; i++) if (rms[i] > max) max = rms[i];
  if (max > 0) for (let i = 0; i < rms.length; i++) rms[i] /= max;

  return rms;
}

// ─── Simple Onset Detection (RMS delta threshold) ───

interface Onset {
  timeMs: number;   // Время в мс
  amplitude: number; // Нормализованная амплитуда [0..1]
}

function detectOnsets(
  rmsValues: Float32Array,
  hopSize: number,
  sampleRate: number,
  threshold: number = 0.08,
  minIntervalMs: number = 60
): Onset[] {
  const onsets: Onset[] = [];
  const msPerFrame = (hopSize / sampleRate) * 1000;
  let lastOnsetMs = -minIntervalMs;

  for (let i = 1; i < rmsValues.length; i++) {
    const delta = rmsValues[i] - rmsValues[i - 1];
    const timeMs = i * msPerFrame;

    if (delta > threshold && timeMs - lastOnsetMs >= minIntervalMs) {
      // Амплитуда = текущий RMS (не дельта)
      onsets.push({ timeMs, amplitude: rmsValues[i] });
      lastOnsetMs = timeMs;
    }
  }
  return onsets;
}

// ─── Simple BPM Detection (autocorrelation on RMS) ───

function detectBpm(rmsValues: Float32Array, hopSize: number, sampleRate: number): number | null {
  const msPerFrame = (hopSize / sampleRate) * 1000;
  // BPM range: 60-200 → period range in frames
  const minLag = Math.round(60000 / 200 / msPerFrame); // ~200 BPM
  const maxLag = Math.round(60000 / 60 / msPerFrame);  // ~60 BPM

  if (maxLag >= rmsValues.length) return null;

  let bestLag = minLag;
  let bestCorr = -Infinity;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    let count = 0;
    for (let i = 0; i < rmsValues.length - lag; i++) {
      corr += rmsValues[i] * rmsValues[i + lag];
      count++;
    }
    corr /= count;
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }

  const bpm = Math.round(60000 / (bestLag * msPerFrame));
  return (bpm >= 60 && bpm <= 200) ? bpm : null;
}

// ─── Post-Processor (порт BeatVibrator PostProcessor) ───

const MIN_INTERVAL_MS = 80;    // Минимум между пульсами
const MERGE_WINDOW_MS = 120;   // Окно для слияния близких onset'ов
const MIN_INTENSITY = 0.08;    // Порог минимальной амплитуды
const BASE_DURATION_MS = 30;   // Базовая длительность
const MAX_DURATION_MS = 90;    // Макс длительность
const MIN_DURATION_MS = 15;    // Мин длительность

function postProcess(
  onsets: Onset[],
  bpm: number | null = null,
  division: number = 4,
  intensityScale: number = 1.0
): VibrationPulse[] {
  if (onsets.length === 0) return [];

  const sorted = [...onsets].sort((a, b) => a.timeMs - b.timeMs);
  const pulses: VibrationPulse[] = [];
  let lastTime = -MIN_INTERVAL_MS;
  let i = 0;

  while (i < sorted.length) {
    const { timeMs: baseTime, amplitude: baseAmp } = sorted[i];

    // Пропускаем слабые и слишком частые
    if (baseAmp < MIN_INTENSITY || baseTime - lastTime < MIN_INTERVAL_MS) {
      i++;
      continue;
    }

    // Merge близких onset'ов в одно окно
    let mergedTime = baseTime;
    let mergedAmp = baseAmp;
    let count = 1;
    let j = i + 1;

    while (j < sorted.length && sorted[j].timeMs - baseTime < MERGE_WINDOW_MS) {
      mergedAmp += sorted[j].amplitude;
      mergedTime += sorted[j].timeMs;
      count++;
      j++;
    }

    mergedAmp /= count;
    mergedTime /= count;

    // Perceptual compression: amp^0.6 (как в BeatVibrator)
    const compressed = Math.pow(Math.min(Math.max(mergedAmp, 0), 1), 0.6);

    // Динамическая длительность по интенсивности
    const dynamicDuration = Math.round(
      Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS,
        BASE_DURATION_MS + compressed * (MAX_DURATION_MS - BASE_DURATION_MS)
      ))
    );

    // BPM quantization (optional snap to grid)
    let finalTime: number;
    if (bpm && bpm > 0) {
      const gridMs = 60000 / bpm / division;
      finalTime = Math.round(mergedTime / gridMs) * gridMs;
    } else {
      finalTime = Math.round(mergedTime);
    }

    // Amplitude 0-255, с учётом intensityScale
    const amplitude = Math.round(
      Math.min(255, Math.max(20, compressed * 255 * intensityScale))
    );

    pulses.push({
      timeMs: finalTime,
      amplitude,
      durationMs: dynamicDuration,
    });

    lastTime = baseTime;
    i = j;
  }

  return pulses.sort((a, b) => a.timeMs - b.timeMs);
}

// ─── Main: Compute Haptic Pattern from Audio URL ───
// Сначала пробуем серверный анализ (FFmpeg + Node.js DSP) — телефон не грузится.
// Fallback на локальный Web Audio только если сервер недоступен.

export async function computeHapticPattern(
  audioUrl: string,
  intensityScale: number = 1.0,
  onProgress?: (stage: string, pct: number) => void
): Promise<HapticPattern> {
  onProgress?.('Анализ на сервере...', 10);

  // 1. Пробуем серверный endpoint — вся тяжёлая работа на сервере
  try {
    const serverUrl = `/api/files/haptic-pattern?url=${encodeURIComponent(audioUrl)}&intensity=${intensityScale}`;
    const res = await fetch(serverUrl, { signal: AbortSignal.timeout(45000) });
    if (res.ok) {
      const data = await res.json() as HapticPattern;
      if (data && Array.isArray(data.pulses) && data.pulses.length > 0) {
        onProgress?.('Готово!', 100);
        return data;
      }
    }
  } catch (serverErr) {
    console.warn('[HapticDSP] Server analysis failed, falling back to local:', serverErr);
  }

  // 2. Fallback: локальный Web Audio API (если сервер недоступен)
  onProgress?.('Загрузка аудио...', 0);

  const response = await fetch(audioUrl);
  const arrayBuffer = await response.arrayBuffer();

  onProgress?.('Декодирование...', 20);

  // Разбор — через общий модуль. Контекст на один отсчёт, который стоял
  // здесь раньше, роняет процесс страницы в настольной сборке целиком:
  // подробности в lib/decodeAudio.ts.
  const audioBuffer = await decodeAudioBuffer(arrayBuffer);
  if (!audioBuffer) {
    // Движок оболочки не умеет разбирать звук, не убив окно. Серверный
    // разбор выше уже не ответил, значит остаётся только честно сказать.
    throw new Error(decodeUnavailableReason());
  }

  const sampleRate = audioBuffer.sampleRate;
  const pcm = audioBuffer.getChannelData(0); // Float32Array [-1..1]

  onProgress?.('Фильтрация басов...', 35);

  // 3. Butterworth low-pass 200Hz — оставляем только бочку/бас
  const filtered = butterworthLowPass(pcm, 200, sampleRate);

  onProgress?.('Анализ энергии...', 50);

  // 4. RMS по окнам 20ms с 50% overlap
  const windowSamples = Math.round(sampleRate * 0.02); // ~882 @ 44100
  const hopSamples = Math.floor(windowSamples / 2);
  const rmsValues = computeRms(filtered, windowSamples, hopSamples);

  onProgress?.('Детекция ударов...', 65);

  // 5. BPM detection
  const bpm = detectBpm(rmsValues, hopSamples, sampleRate);

  // 6. Onset detection (на отфильтрованном RMS)
  const onsets = detectOnsets(rmsValues, hopSamples, sampleRate, 0.06, 60);

  onProgress?.('Генерация паттерна...', 80);

  // 7. Post-processing → VibrationPulse[]
  const pulses = postProcess(onsets, bpm, 4, intensityScale);

  onProgress?.('Готово!', 100);

  return {
    pulses,
    durationMs: Math.round((pcm.length / sampleRate) * 1000),
    bpm,
  };
}

// ─── Convert to Android-compatible waveform arrays ───

/**
 * Конвертирует VibrationPulse[] в формат Android VibrationEffect.createWaveform(timings, amplitudes, -1).
 * timings: чередуются pause_ms и vibrate_ms
 * amplitudes: 0 для пауз, 1-255 для вибрации
 */
export function pulsesToAndroidWaveform(pulses: VibrationPulse[]): { timings: number[]; amplitudes: number[] } {
  if (pulses.length === 0) return { timings: [], amplitudes: [] };

  const timings: number[] = [];
  const amplitudes: number[] = [];
  let cursor = 0;

  for (const pulse of pulses) {
    // Пауза до этого пульса
    const gap = Math.max(0, pulse.timeMs - cursor);
    if (gap > 0) {
      timings.push(gap);
      amplitudes.push(0);
    }

    // Сам пульс
    timings.push(pulse.durationMs);
    amplitudes.push(pulse.amplitude);

    cursor = pulse.timeMs + pulse.durationMs;
  }

  return { timings, amplitudes };
}

/**
 * Для web fallback: получить пульсы для текущего окна времени.
 * Возвращает пульсы которые нужно тригернуть в интервале [fromMs, toMs).
 */
export function getPulsesInRange(
  pulses: VibrationPulse[],
  fromMs: number,
  toMs: number
): VibrationPulse[] {
  return pulses.filter(p => p.timeMs >= fromMs && p.timeMs < toMs);
}
