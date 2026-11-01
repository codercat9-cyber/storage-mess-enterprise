import { useState, useEffect, useRef, useCallback } from 'react';
import { formatBytes } from '../lib/format';
import { Play, Pause, SkipBack, SkipForward, RotateCcw, RotateCw, Volume2, VolumeX, Download, Loader2, ChevronDown, ChevronUp, Vibrate, SlidersHorizontal } from 'lucide-react';
import { downloadFileNative, saveMediaToGallery } from '@/lib/capacitor-bridge';
import { computeHapticPattern, pulsesToAndroidWaveform, getPulsesInRange, type HapticPattern } from '../lib/haptic-dsp';
import { fetchAndDecodeAudio, decodeUnavailableReason } from '@/lib/decodeAudio';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { useMediaStore } from '@/store/media';
interface MusicPlayerProps {
  audioUrl: string;
  fileName: string;
  fileSize?: number;
  isOwn?: boolean;
  downloadUrl?: string;
  onEnded?: () => void;

  /**
   * Переключение записей в очереди.
   *
   * Раньше кнопки со стрелками перематывали внутри трека на ±10 секунд —
   * при том, что выглядят они как «предыдущая/следующая запись». Человек
   * жал «дальше», а плеер отматывал те же десять секунд и оставался на
   * месте. Теперь стрелки переключают записи (как везде), а перемотка
   * осталась там, где ей и место, — на полосе времени.
   */
  onNext?: () => void;
  onPrev?: () => void;
  hasNext?: boolean;
  hasPrev?: boolean;
}

// EQ band presets — 10-band parametric
const EQ_BANDS = [
  { freq: 31, label: '31', type: 'lowshelf' as BiquadFilterType },
  { freq: 63, label: '63', type: 'peaking' as BiquadFilterType },
  { freq: 125, label: '125', type: 'peaking' as BiquadFilterType },
  { freq: 250, label: '250', type: 'peaking' as BiquadFilterType },
  { freq: 500, label: '500', type: 'peaking' as BiquadFilterType },
  { freq: 1000, label: '1K', type: 'peaking' as BiquadFilterType },
  { freq: 2000, label: '2K', type: 'peaking' as BiquadFilterType },
  { freq: 4000, label: '4K', type: 'peaking' as BiquadFilterType },
  { freq: 8000, label: '8K', type: 'peaking' as BiquadFilterType },
  { freq: 16000, label: '16K', type: 'highshelf' as BiquadFilterType },
];

const EQ_PRESETS: Record<string, number[]> = {
  'Flat': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  'Bass Boost': [8, 6, 4, 2, 0, -1, -1, -2, -2, -3],
  'Treble Boost': [-3, -2, -2, -1, 0, 1, 2, 4, 6, 8],
  'Rock': [5, 4, 2, 0, -1, -1, 1, 3, 4, 5],
  'Pop': [-1, 0, 2, 3, 4, 3, 2, 1, 0, -1],
  'Jazz': [4, 3, 1, 0, -1, -2, 0, 1, 2, 4],
  'Classical': [5, 4, 3, 1, 0, -1, 0, 2, 3, 4],
  'Electronic': [6, 5, 3, 1, 0, 0, 1, 3, 4, 5],
  'Vocal': [-3, -2, -1, 0, 2, 4, 4, 2, 0, -2],
  'Hip-Hop': [7, 6, 4, 2, 0, 0, 1, 2, 1, 0],
  'R&B': [4, 3, 2, 1, 0, 1, 2, 2, 1, 0],
};

export default function MusicPlayer({ audioUrl, fileName, fileSize, isOwn, downloadUrl, onEnded, onNext, onPrev, hasNext, hasPrev }: MusicPlayerProps) {
  const { queue, currentMedia } = useMediaStore();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const eqFiltersRef = useRef<BiquadFilterNode[]>([]);
  const convolverRef = useRef<ConvolverNode | null>(null);
  const dryGainRef = useRef<GainNode | null>(null);
  const wetGainRef = useRef<GainNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const animFrameRef = useRef<number>(0);
  const connectedRef = useRef(false);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [showControls, setShowControls] = useState(false);

  const [eqGains, setEqGains] = useState<number[]>([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const [reverbMix, setReverbMix] = useState(0);
  const [activePreset, setActivePreset] = useState('Flat');
  const [waveformData, setWaveformData] = useState<Float32Array | null>(null);
  const [isSeeking, setIsSeeking] = useState(false);
  const [vibrateEnabled, setVibrateEnabled] = useState(false);
  // Режим общий на всё приложение: см. пояснение в store/media.ts. Своё
  // состояние у каждой записи означало бы, что при переходе к следующей
  // песне режим молча выключается, а звук остаётся у нативного плеера.
  const nativeHapticMode = useMediaStore(st => st.nativeHapticMode);
  const setNativeHapticMode = useMediaStore(st => st.setNativeHapticMode);
  const nativeOwnedUrl = useMediaStore(st => st.nativeOwnedUrl);
  const setNativeOwnedUrl = useMediaStore(st => st.setNativeOwnedUrl);

  // Ведёт ли звук ЭТОЙ записи проигрыватель телефона.
  //
  // Проверять сам режим недостаточно: он включён на всё приложение, а
  // телефон в этот миг может не играть ничего (человек нажал пуск до
  // включения режима, или запуск не удался). Раньше по одному лишь режиму
  // уходили перемотка и запрос времени — и упирались в пустоту.
  const nativeOwnsThis = nativeHapticMode && nativeOwnedUrl === audioUrl;

  // Время воспроизведения — у того, кто на самом деле играет.
  const nativeOwnsRef = useRef(false);
  nativeOwnsRef.current = nativeOwnsThis;
  const playbackMs = useCallback((): number => {
    if (nativeOwnsRef.current) {
      try {
        const ms = (window as any).AndroidBridge?.getNativeMusicTime?.();
        if (typeof ms === 'number' && ms >= 0) return ms;
      } catch { /* моста нет — ниже возьмём у страницы */ }
    }
    const a = audioRef.current;
    return a ? a.currentTime * 1000 : 0;
  }, []);

  // Играет ли хоть что-нибудь — тоже зависит от того, кто ведёт.
  const playbackRunning = useCallback((): boolean => {
    if (nativeOwnsRef.current) {
      try {
        const st = JSON.parse((window as any).AndroidBridge?.getNativeMusicState?.() || '{}');
        return Boolean(st.isPlaying);
      } catch { return false; }
    }
    const a = audioRef.current;
    return Boolean(a && !a.paused);
  }, []);
  const [hapticIntensity, setHapticIntensity] = useState(0.6);
  const [hapticPattern, setHapticPattern] = useState<HapticPattern | null>(null);
  const [hapticAnalyzing, setHapticAnalyzing] = useState(false);
  const [hapticStatus, setHapticStatus] = useState('');
  // Почему запись не играет — человеку, а не только в журнал.
  const [playError, setPlayError] = useState('');

  // Sync native state
  useEffect(() => {
    let interval: any;
    if (nativeHapticMode && (window as any).AndroidBridge?.getNativeMusicState) {
      interval = setInterval(() => {
        try {
          const stateStr = (window as any).AndroidBridge.getNativeMusicState();
          const state = JSON.parse(stateStr);
          // If native player is playing THIS track
          const store = useMediaStore.getState();
          if (store.currentMedia?.url === audioUrl) {
            if (state.isPlaying !== isPlaying) {
              setIsPlaying(state.isPlaying);
            }
            if (state.currentTime > 0) {
              setCurrentTime(state.currentTime);
            }
            // Телефон играет эту запись — закрепляем за ним ведение.
            // Нужно на случай, когда воспроизведение начал не этот
            // экземпляр: например, оно продолжилось из шторки уведомлений.
            if (state.isPlaying && store.nativeOwnedUrl !== audioUrl) {
              store.setNativeOwnedUrl(audioUrl);
            }
          } else {
            // Not current track
            if (isPlaying) setIsPlaying(false);
          }
        } catch (e) {}
      }, 500);
    }
    return () => clearInterval(interval);
  }, [nativeHapticMode, audioUrl, isPlaying]);
  const vibrateRef = useRef(false);
  const hapticIntensityRef = useRef(0.6);
  const vibrateFrameRef = useRef<number>(0);
  const hapticPatternRef = useRef<HapticPattern | null>(null);

  // Отсчёт времени нужен обработчикам, которые вешаются раньше его
  // объявления, поэтому держим ссылку.
  const tickRef = useRef<() => void>(() => {});
  // Играли ли перед сменой записи — чтобы продолжить на следующей.
  const wasPlayingRef = useRef(false);
  // Ссылка на запуск: сам обработчик объявлен ниже, а нужен он в эффекте
  // выше по файлу.
  const startPlaybackRef = useRef<(() => Promise<void>) | null>(null);

  // Initialize audio element
  useEffect(() => {
    // Сброс отсчётов при смене записи.
    //
    // Проигрыватель ОДИН на всё окно, у него просто меняется адрес записи.
    // Компонент при этом не пересоздаётся, и всё, что он помнил, остаётся:
    // прошлое время, прошлая длительность, прошлый признак «играет». Со
    // стороны выглядело так, будто плеер завис на случайной секунде посреди
    // новой песни и не начинает играть — время старое, полоса стоит, а
    // играть нечему: новая запись ещё даже не загружена.
    // Признак берём из общего хранилища: сам проигрыватель при смене
    // записи пересоздаётся и своё «играло до этого» теряет.
    // Признак НЕ сбрасываем здесь.
    //
    // Прошлая попытка гасила его сразу при чтении — и если этот участок
    // отрабатывал ещё раз (а при смене записи так и бывает), второй проход
    // видел уже пустое значение и создавал проигрыватель без указания
    // играть. Гасим только после того, как звук действительно пошёл.
    const resumeAfterSwitch = useMediaStore.getState().autoPlayNext;
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
    setPlayError('');

    const audio = new Audio();
    audio.crossOrigin = 'anonymous';
    audio.preload = 'metadata';

    // Продолжение поручаем самому проигрывателю, а не своим обработчикам.
    //
    // Две прошлые попытки запускать звук вручную — по событию о готовности
    // сведений — не срабатывали: признак «играло до переключения»
    // обновляется на следующем проходе отрисовки, и проверка всякий раз
    // видела прошлое значение. Здесь же мы просто говорим «начинай, как
    // будешь готов», и порядок обновлений перестаёт что-либо решать.
    if (resumeAfterSwitch) {
      audio.autoplay = true;
      audio.preload = 'auto';
    }

    audio.src = audioUrl;
    audioRef.current = audio;

    // Состояние берём из самих событий проигрывателя — тогда подпись на
    // кнопке всегда совпадает с тем, что происходит на самом деле, кто бы
    // ни начал воспроизведение: человек, очередь или система.
    const onPlay = () => {
      setIsPlaying(true);
      setIsLoading(false);
      // Дошли до звука — намерение исполнено.
      useMediaStore.getState().setAutoPlayNext(false);
      animFrameRef.current = requestAnimationFrame(tickRef.current);
    };
    // Вторая попытка, когда данных уже достаточно: на медленной связи
    // указание играть иногда не срабатывает с первого раза, и запись
    // молча остаётся стоять.
    const onCanPlay2 = () => {
      if (!useMediaStore.getState().autoPlayNext) return;
      audio.play().catch(() => { /* не вышло — остаётся кнопка */ });
    };
    audio.addEventListener('canplay', onCanPlay2);
    const onPause = () => setIsPlaying(false);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);

    const onMeta = () => {
      if (audio.duration && isFinite(audio.duration)) setDuration(audio.duration);
      setIsLoading(false);

      // Играли до переключения — продолжаем и на новой записи. Иначе
      // человек жмёт «следующая» и попадает в тишину, где надо ещё раз
      // нажать пуск.
      if (resumeAfterSwitch || useMediaStore.getState().autoPlayNext) {
        void audio.play().catch(() => { /* попробуем ещё по canplay */ });
      }
    };
    const handleEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
      cancelAnimationFrame(animFrameRef.current);
      if (onEnded) onEnded();
    };
    const onErr = () => { setIsLoading(false); setIsPlaying(false); };
    const onWait = () => setIsLoading(true);
    const onCan = () => setIsLoading(false);

    audio.addEventListener('loadedmetadata', onMeta);
    // Файл мог оказаться в памяти браузера, и тогда сведения о нём готовы
    // ещё до того, как мы подписались, — события уже не будет.
    if (audio.readyState >= 1) onMeta();
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('error', onErr);
    audio.addEventListener('waiting', onWait);
    audio.addEventListener('canplay', onCan);

    (window as any).onNativeTrackChanged = (index: number) => {
      // Get latest state
      const state = useMediaStore.getState();
      if (index >= 0 && index < state.queue.length) {
        // Именно указатель: setMedia обрезал бы очередь до одной записи,
        // и после первого же переключения телефоном список пропадал.
        state.setQueueIndex(index);
        state.setNativeOwnedUrl(state.queue[index].url);
      } else {
        setIsPlaying(false);
        setCurrentTime(0);
        cancelAnimationFrame(animFrameRef.current);
      }
    };

    return () => {
      // Останавливаем телефон, только если он играл ИМЕННО эту запись.
      //
      // Раньше остановка шла при любой смене адреса — в том числе когда
      // телефон сам перешёл к следующей песне в своей очереди. Он начинал
      // играть, а JS тут же его глушил.
      const st = useMediaStore.getState();
      if ((window as any).AndroidBridge && st.nativeOwnedUrl === audioUrl) {
        (window as any).AndroidBridge.stopNativeMusic();
        st.setNativeOwnedUrl(null);
      }
      cancelAnimationFrame(animFrameRef.current);
      audio.removeEventListener('canplay', onCanPlay2);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('error', onErr);
      audio.removeEventListener('waiting', onWait);
      audio.removeEventListener('canplay', onCan);
      audio.pause();
      audio.src = '';
      if (audioCtxRef.current?.state !== 'closed') {
        audioCtxRef.current?.close().catch(() => {});
      }
    };
  }, [audioUrl]);

  // Setup Web Audio API chain: Source → EQ → Dry/Wet → Analyser → Gain → Destination
  const setupAudioChain = useCallback(() => {
    if (connectedRef.current || !audioRef.current) return;

    // Эквалайзер, эхо и полоски — украшение. Если звуковой движок их не
    // даст, музыка всё равно должна играть.
    //
    // Мест, где здесь можно упасть, хватает: createMediaElementSource
    // бросает, если элемент уже подключён к другому контексту; сам
    // AudioContext может не создаться, когда система занята другим
    // приложением. Раньше такое падение вылетало наружу из обработчика
    // нажатия — и трек просто не начинался, без единого слова почему.
    let ctx: AudioContext;
    let source: MediaElementAudioSourceNode;
    try {
      ctx = new AudioContext();
      audioCtxRef.current = ctx;
      source = ctx.createMediaElementSource(audioRef.current);
      sourceRef.current = source;
    } catch (err) {
      console.warn('[Плеер] звуковая обработка недоступна, играем напрямую:', err);
      // Помечаем как «подключено», иначе на каждое нажатие будет новая
      // попытка и новый висящий AudioContext.
      connectedRef.current = true;
      try { audioCtxRef.current?.close(); } catch { /* уже закрыт */ }
      audioCtxRef.current = null;
      return;
    }

    // EQ filters chain
    const filters = EQ_BANDS.map((band, i) => {
      const f = ctx.createBiquadFilter();
      f.type = band.type;
      f.frequency.value = band.freq;
      f.gain.value = eqGains[i];
      if (band.type === 'peaking') f.Q.value = 1.4;
      return f;
    });
    eqFiltersRef.current = filters;

    // Reverb via ConvolverNode
    const convolver = ctx.createConvolver();
    convolverRef.current = convolver;
    generateImpulseResponse(ctx, convolver);

    // Dry/Wet for reverb mix
    const dryGain = ctx.createGain();
    dryGain.gain.value = 1;
    dryGainRef.current = dryGain;

    const wetGain = ctx.createGain();
    wetGain.gain.value = 0;
    wetGainRef.current = wetGain;

    // Analyser for waveform visualization
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;
    analyserRef.current = analyser;

    // Master gain
    const gain = ctx.createGain();
    gain.gain.value = volume;
    gainRef.current = gain;

    // Merge node for dry + wet
    const merger = ctx.createGain();

    // Connect chain: source → eq1 → eq2 → eq3 → eq4 → eq5 → split
    let lastNode: AudioNode = source;
    for (const f of filters) {
      lastNode.connect(f);
      lastNode = f;
    }

    // Split into dry and wet paths
    lastNode.connect(dryGain);
    lastNode.connect(convolver);
    convolver.connect(wetGain);

    // Merge → analyser → gain → output
    dryGain.connect(merger);
    wetGain.connect(merger);
    merger.connect(analyser);
    analyser.connect(gain);
    gain.connect(ctx.destination);

    connectedRef.current = true;
  }, []);

  // Generate impulse response for reverb
  const generateImpulseResponse = (ctx: AudioContext, convolver: ConvolverNode) => {
    const rate = ctx.sampleRate;
    const length = rate * 2; // 2 seconds
    const impulse = ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = impulse.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (rate * 0.4));
      }
    }
    convolver.buffer = impulse;
  };

  // Decode audio for static waveform overview
  //
  // Здесь и жил белый экран настольной версии. Разбор шёл через
  // OfflineAudioContext на один отсчёт, и в сборке с Chromium постарше
  // это уводило процесс страницы по нулевому указателю — насмерть, вместе
  // со всем окном. Заменено на общий разбор, см. lib/decodeAudio.ts.
  useEffect(() => {
    const fetchWaveform = async () => {
      try {
        const decoded = await fetchAndDecodeAudio(audioUrl);
        if (!decoded) return; // разбор на этом движке запрещён — плеер просто без картинки волны
        const raw = decoded.getChannelData(0);
        // Downsample to ~200 points
        const samples = 200;
        const step = Math.floor(raw.length / samples);
        const data = new Float32Array(samples);
        for (let i = 0; i < samples; i++) {
          let sum = 0;
          const start = i * step;
          for (let j = start; j < start + step && j < raw.length; j++) {
            sum += Math.abs(raw[j]);
          }
          data[i] = sum / step;
        }
        setWaveformData(data);
      } catch { /* silent */ }
    };
    fetchWaveform();
  }, [audioUrl]);

  // Draw static waveform overview
  useEffect(() => {
    const canvas = waveformCanvasRef.current;
    if (!canvas || !waveformData) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    // Нормируем не по самому громкому месту, а по девяностому проценту.
    //
    // По максимуму получалась плоская линия: одного щелчка или удара в
    // начале записи хватало, чтобы всё остальное сжалось почти в ноль —
    // на экране оставался всплеск слева и пустота дальше. Отсечка по
    // проценту делает волну похожей на саму музыку, а редкие выбросы
    // просто упираются в потолок.
    const sorted = Array.from(waveformData).sort((a, b) => a - b);
    const p90 = sorted[Math.floor(sorted.length * 0.9)] || 0;
    const maxVal = Math.max(p90, 0.01);
    const barWidth = w / waveformData.length;
    const progress = duration > 0 ? currentTime / duration : 0;

    for (let i = 0; i < waveformData.length; i++) {
      const x = i * barWidth;
      const barH = Math.min(1, waveformData[i] / maxVal) * h * 0.9;
      const isPast = i / waveformData.length < progress;
      
      ctx.fillStyle = isPast
        ? (isOwn ? 'rgba(255,255,255,0.8)' : 'rgba(99,102,241,0.9)')
        : (isOwn ? 'rgba(255,255,255,0.25)' : 'rgba(99,102,241,0.25)');
      ctx.fillRect(x + 0.5, (h - barH) / 2, Math.max(barWidth - 1, 1), barH);
    }
  }, [waveformData, currentTime, duration, isOwn]);

  // Realtime frequency visualization
  const drawVisualization = useCallback(() => {
    const startDraw = () => {
      const analyser = analyserRef.current;
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (!analyser) {
        // Analyser not yet ready — retry in 100ms
        setTimeout(startDraw, 100);
        return;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const bufLen = analyser.frequencyBinCount;
      const dataArr = new Uint8Array(bufLen);

      const draw = () => {
        animFrameRef.current = requestAnimationFrame(draw);
        analyser.getByteFrequencyData(dataArr);

        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
          canvas.width = w * dpr;
          canvas.height = h * dpr;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        const barW = (w / bufLen) * 2.5;
        let x = 0;
        for (let i = 0; i < bufLen; i++) {
          const barH = (dataArr[i] / 255) * h;
          const hue = (i / bufLen) * 240 + 200;
          ctx.fillStyle = `hsla(${hue}, 80%, 60%, 0.85)`;
          ctx.fillRect(x, h - barH, barW - 1, barH);
          x += barW;
          if (x > w) break;
        }
      };
      draw();
    };
    startDraw();
  }, []);

  // Update EQ filter gains
  useEffect(() => {
    eqFiltersRef.current.forEach((f, i) => {
      if (f && eqGains[i] !== undefined) {
        f.gain.value = eqGains[i];
      }
    });
  }, [eqGains]);

  // Update reverb mix
  useEffect(() => {
    if (dryGainRef.current) dryGainRef.current.gain.value = 1 - reverbMix * 0.5;
    if (wetGainRef.current) wetGainRef.current.gain.value = reverbMix;
  }, [reverbMix]);

  // Update volume
  useEffect(() => {
    if (gainRef.current) gainRef.current.gain.value = muted ? 0 : volume;
    if (audioRef.current) audioRef.current.volume = 1; // Volume handled by GainNode
  }, [volume, muted]);

  // Beat-synced vibration engine (pre-computed DSP pattern)
  useEffect(() => {
    vibrateRef.current = vibrateEnabled;
  }, [vibrateEnabled]);

  useEffect(() => {
    hapticIntensityRef.current = hapticIntensity;
  }, [hapticIntensity]);

  // Keep ref in sync
  useEffect(() => {
    hapticPatternRef.current = hapticPattern;
  }, [hapticPattern]);

  // Сменилась запись — старый рисунок вибрации больше не годится.
  //
  // Здесь и была причина, по которой «вибрация работает непонятно как»:
  // рисунок считается один раз и хранился до конца сессии, а условие ниже
  // пропускало анализ, если он уже есть. Включив вибрацию на одной песне и
  // переключившись на другую, человек получал телефон, который трясётся в
  // ритме ПРЕДЫДУЩЕГО трека. Похоже на случайную дрожь — и не связывается с
  // музыкой, которая играет сейчас.
  const analyzedUrlRef = useRef<string | null>(null);
  useEffect(() => {
    if (analyzedUrlRef.current && analyzedUrlRef.current !== audioUrl) {
      setHapticPattern(null);
      setHapticStatus('');
      try { (window as any).AndroidBridge?.stopVibration?.(); } catch { /* не Android */ }
    }
  }, [audioUrl]);

  // Считаем рисунок вибрации, когда её включили.
  useEffect(() => {
    if (!vibrateEnabled || hapticPattern || hapticAnalyzing) return;

    setHapticAnalyzing(true);
    setHapticStatus('Разбираю запись…');
    const urlAtStart = audioUrl;

    computeHapticPattern(audioUrl, hapticIntensity, (stage, pct) => {
      setHapticStatus(`${stage} ${pct}%`);
    }).then(pattern => {
      // Пока считали, могли переключить запись — тогда результат не наш.
      if (urlAtStart !== audioUrl) return;
      analyzedUrlRef.current = urlAtStart;
      setHapticPattern(pattern);
      setHapticAnalyzing(false);
      const bpmInfo = pattern.bpm ? `, ${pattern.bpm} уд/мин` : '';
      setHapticStatus(pattern.pulses.length
        ? `${pattern.pulses.length} ударов${bpmInfo}`
        : 'Ударов не нашлось — вибрировать не под что');
    }).catch(err => {
      console.warn('[Вибрация] разбор не удался:', err);
      setHapticAnalyzing(false);
      // Объясняем причину, а не отделываемся «не удалось»: чаще всего это
      // движок, который не умеет разбирать звук, а не сама запись.
      const reason = decodeUnavailableReason();
      setHapticStatus(reason ? `Здесь недоступно: ${reason}` : 'Не удалось разобрать запись');
    });
  }, [vibrateEnabled, audioUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Playback vibration sync
  useEffect(() => {
    if (!vibrateEnabled || !isPlaying || !hapticPattern || hapticPattern.pulses.length === 0) {
      cancelAnimationFrame(vibrateFrameRef.current);
      // Stop native vibration
      const bridge = (window as any).AndroidBridge;
      if (bridge?.stopVibration) bridge.stopVibration();
      return;
    }

    const bridge = (window as any).AndroidBridge;
    const isNative = !!bridge?.vibrateWithAmplitudes;
    const canVibrate = 'vibrate' in navigator;

    // Native: send SHORT chunks (5 seconds) to avoid Android waveform size limits
    // Samsung/Xiaomi silently drop waveforms > ~1000 entries
    const CHUNK_DURATION_MS = 5000;

    // Мотор раскачивается не мгновенно: от команды до ощутимой отдачи
    // проходит несколько десятков миллисекунд. На медленной музыке это
    // незаметно, а на битах в 120 ударов промежуток между ними всего
    // полсекунды — и вибрация ощутимо отстаёт. Поэтому команду отдаём
    // чуть раньше самого удара.
    const MOTOR_LAG_MS = 35;

    const sendNativeChunk = (fromMs: number) => {
      const pattern = hapticPatternRef.current;
      if (!pattern || !bridge?.vibrateWithAmplitudes) return;

      const toMs = fromMs + CHUNK_DURATION_MS;
      // Get pulses only for this 5-second chunk
      const chunk = pattern.pulses.filter(p => p.timeMs >= fromMs && p.timeMs < toMs);
      if (chunk.length === 0) return;

      // Пересчитываем время от начала куска и сдвигаем на задержку мотора.
      const { timings, amplitudes } = pulsesToAndroidWaveform(
        chunk.map(p => ({
          ...p,
          timeMs: Math.max(0, p.timeMs - fromMs - MOTOR_LAG_MS),
          amplitude: Math.round(p.amplitude * hapticIntensityRef.current),
        }))
      );

      if (timings.length > 0) {
        try {
          bridge.vibrateWithAmplitudes(
            JSON.stringify(timings),
            JSON.stringify(amplitudes)
          );
        } catch (e) {
          console.warn('[Haptic] vibrateWithAmplitudes failed:', e);
        }
      }
    };

    if (isNative) {
      // Куски отправляются встык, без остановки предыдущего.
      //
      // Раньше каждые 4 секунды вызывался stopVibration и следом
      // отправлялся новый кусок «с текущего момента». Получалась дёрганая
      // дробь: система обрывала рисунок на полуслове и начинала заново,
      // причём с опозданием — пока вызов дойдёт до неё, музыка уже ушла
      // вперёд. Ритм не совпадал ни с чем.
      //
      // Теперь следующий кусок уходит ЗАРАНЕЕ, до того как доиграет
      // текущий, и очередь не прерывается.
      let nextChunkStartMs = playbackMs();

      sendNativeChunk(nextChunkStartMs);
      nextChunkStartMs += CHUNK_DURATION_MS;

      const feeder = setInterval(() => {
        // Время берём у того, кто играет.
        //
        // Здесь стояло `audioRef.current.paused` — проигрыватель страницы.
        // Но в режиме ⚡ HAPTIC звук ведёт телефон, а страница как раз
        // стоит на паузе: условие срабатывало на первом же круге, и подача
        // прекращалась. Уходил ровно один кусок в пять секунд — отсюда
        // «вибрация начинается и тут же сбивается».
        if (!vibrateRef.current || !playbackRunning()) return;
        const currentMs = playbackMs();

        // Перемотали — очередь устарела, начинаем от новой позиции.
        if (Math.abs(currentMs - (nextChunkStartMs - CHUNK_DURATION_MS)) > CHUNK_DURATION_MS * 1.5) {
          try { bridge.stopVibration(); } catch (e) {}
          nextChunkStartMs = currentMs;
        }

        // Досылаем, пока музыка не догнала конец отправленного.
        if (currentMs + CHUNK_DURATION_MS >= nextChunkStartMs) {
          sendNativeChunk(nextChunkStartMs);
          nextChunkStartMs += CHUNK_DURATION_MS;
        }
      }, 1000);

      return () => {
        clearInterval(feeder);
        try { bridge.stopVibration(); } catch (e) {}
      };
    }

    // Web fallback: RAF loop checking current time against pattern
    let lastTriggeredMs = -1;

    const vibrateLoop = () => {
      if (!vibrateRef.current) return;
      vibrateFrameRef.current = requestAnimationFrame(vibrateLoop);

      const pattern = hapticPatternRef.current;
      if (!pattern || !playbackRunning()) return;

      const currentMs = playbackMs();
      const windowMs = 30; // check window ~30ms

      const pulses = getPulsesInRange(pattern.pulses, currentMs - windowMs, currentMs + windowMs);
      for (const pulse of pulses) {
        // Avoid triggering the same pulse twice
        if (pulse.timeMs <= lastTriggeredMs) continue;
        const vibDuration = Math.round(pulse.durationMs * hapticIntensityRef.current);
        if (vibDuration > 0) {
          if (canVibrate) {
            navigator.vibrate(vibDuration);
          } else if ((window as any).Telegram?.WebApp?.HapticFeedback) {
            (window as any).Telegram.WebApp.HapticFeedback.impactOccurred('light');
          } else {
            try { Haptics.impact({ style: ImpactStyle.Light }).catch(() => {}); } catch(e) {}
          }
          lastTriggeredMs = pulse.timeMs;
        }
      }
    };

    vibrateFrameRef.current = requestAnimationFrame(vibrateLoop);

    return () => {
      cancelAnimationFrame(vibrateFrameRef.current);
      if (canVibrate) navigator.vibrate(0);
    };
  }, [vibrateEnabled, isPlaying, hapticPattern]);

  const isPlayingRef = useRef(false);
  useEffect(() => {
    wasPlayingRef.current = isPlaying;
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  // Time tracking
  const tick = useCallback(() => {
    if (isSeeking) return;
    const a = audioRef.current;
    if (nativeOwnsThis && isPlaying) {
      const ms = playbackMs();
      if (ms > 0) setCurrentTime(ms / 1000);
      animFrameRef.current = requestAnimationFrame(tick);
    } else if (a && !a.paused) {
      setCurrentTime(a.currentTime);
      animFrameRef.current = requestAnimationFrame(tick);
    }
  }, [isSeeking, isPlaying, nativeOwnsThis, playbackMs]);

  tickRef.current = tick;

  const togglePlay = async () => {
    const a = audioRef.current;
    if (!a) return;

    if (isPlaying) {
      if (nativeOwnsThis && (window as any).AndroidBridge) {
        (window as any).AndroidBridge.pauseNativeMusic();
      } else {
        a.pause();
      }
      cancelAnimationFrame(animFrameRef.current);
      setIsPlaying(false);
    } else {
      setIsLoading(true);
      try { (window as any).AndroidBridge?.requestAudioFocus?.(); } catch (e) {}
      
      if (nativeHapticMode && (window as any).AndroidBridge) {
        let queueToSend = queue;
        if (queueToSend.length === 0 && currentMedia) queueToSend = [currentMedia];
        let index = queueToSend.findIndex((m) => m.url === audioUrl);
        if (index === -1) index = 0;
        
        const qJson = JSON.stringify(queueToSend.map(m => ({
            url: m.url,
            title: m.fileName || 'Audio',
            artist: 'Storage Messenger',
            coverUrl: ''
        })));
        (window as any).AndroidBridge.playNativeMusic(qJson, index);
        // С этого мгновения запись ведёт телефон — на это опираются
        // перемотка, отсчёт времени и подача вибрации.
        setNativeOwnedUrl(audioUrl);
        setIsPlaying(true);
        setIsLoading(false);
        animFrameRef.current = requestAnimationFrame(tick);
      } else {
        await startPlayback();
      }
    }
  };

  /** Запустить воспроизведение текущей записи страницей. */
  const startPlayback = async () => {
    const a = audioRef.current;
    if (!a) return;
    setIsLoading(true);
    {
      {
        // Играет страница — телефон больше ничего не ведёт.
        setNativeOwnedUrl(null);
        setupAudioChain();
        if (audioCtxRef.current?.state === 'suspended') {
          await audioCtxRef.current.resume();
        }
        try {
          a.playbackRate = playbackRate;
          await a.play();
          setIsPlaying(true);
          setIsLoading(false);
          animFrameRef.current = requestAnimationFrame(tick);
          drawVisualization();
        } catch (err: any) {
          // Молчать здесь нельзя.
          //
          // Раньше стоял пустой catch, и отказ воспроизведения выглядел
          // как «нажал — ничего не произошло»: ни звука, ни объяснения, ни
          // строчки в журнале. Именно так и проявлялось «трек переключен,
          // а играть не начинает» — причина была, но её никто не видел.
          console.warn('[плеер] воспроизведение отклонено:', err?.name, err?.message);
          setIsLoading(false);

          // Частая причина — обработка звука: узел уже занят прошлой
          // записью или контекст закрыт вместе с ней. Тогда играем напрямую,
          // без эквалайзера: лучше звук без обработки, чем тишина.
          try {
            if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
              await audioCtxRef.current.close().catch(() => {});
            }
            audioCtxRef.current = null;
            sourceRef.current = null;
            await a.play();
            setIsPlaying(true);
            animFrameRef.current = requestAnimationFrame(tick);
          } catch (err2: any) {
            console.warn('[плеер] и напрямую не вышло:', err2?.name, err2?.message);
            // «Нет поддерживаемых источников» означает, что телефон не берётся
            // за этот файл: чаще всего внутри звукового контейнера лежит ещё
            // и видеодорожка — обложка или клип. Молчаливая кнопка тут хуже
            // всего: человек жмёт и не понимает, сломано приложение или файл.
            setPlayError(
              err2?.name === 'NotSupportedError'
                ? 'Эта запись не открывается проигрывателем: внутри файла есть видеодорожка. Перезалейте её — новые загрузки чинятся автоматически.'
                : 'Не удалось воспроизвести эту запись.',
            );
          }
        }
      }
    }
  };

  // Обновляем ссылку каждый раз: внутри togglePlay замкнуты свежие
  // значения состояния, и старый снимок запустил бы не то.
  startPlaybackRef.current = async () => {
    // Именно запуск, а не переключение.
    //
    // Раньше здесь стояла проверка «если не играет — переключить». Но
    // признак «играет» обновляется на следующем проходе отрисовки, а
    // сведения о новой записи приходят раньше — проверка видела ещё
    // прошлое значение и запуск пропускала. Внешне это и было «трек
    // сменился, а играть не начинает».
    const a = audioRef.current;
    if (!a || !a.paused) return;
    await startPlayback();
  };

  const handleSeek = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = waveformCanvasRef.current;
    const a = audioRef.current;
    if (!canvas || !a || !duration) return;

    const rect = canvas.getBoundingClientRect();
    const clientX = e.clientX;
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const newTime = pct * duration;
    // Защита от NaN/Infinity
    if (!isFinite(newTime) || newTime < 0) return;
    const targetTime = Math.min(newTime, duration - 0.01);
    
    // Телефону перемотку отдаём, только если он и играет эту запись.
    // По одному лишь включённому режиму команда уходила в пустоту: полоса
    // двигалась, звук стоял.
    if (nativeOwnsThis && (window as any).AndroidBridge?.seekNativeMusic) {
      (window as any).AndroidBridge.seekNativeMusic(Math.floor(targetTime * 1000));
      setCurrentTime(targetTime);
    } else {
      a.currentTime = targetTime;
      setCurrentTime(a.currentTime);
    }
  };

  const skip = (secs: number) => {
    const a = audioRef.current;
    if (!duration) return;

    // В нативном режиме звук ведёт проигрыватель телефона, и правка
    // currentTime у скрытого <audio> не делает ничего: полоса уезжала, а
    // звучание оставалось на месте. Перемотку надо передавать туда же,
    // куда передаются пуск и остановка.
    if (nativeOwnsThis && (window as any).AndroidBridge?.seekNativeMusic) {
      const target = Math.max(0, Math.min(duration, currentTime + secs));
      (window as any).AndroidBridge.seekNativeMusic(Math.floor(target * 1000));
      setCurrentTime(target);
      return;
    }

    if (!a) return;
    a.currentTime = Math.max(0, Math.min(duration, a.currentTime + secs));
    setCurrentTime(a.currentTime);
  };

  const cycleSpeed = () => {
    const speeds = [0.5, 1, 1.5, 2, 3, 4, 6, 8, 10, 12];
    const idx = speeds.indexOf(playbackRate);
    const next = speeds[(idx >= 0 ? idx + 1 : 2) % speeds.length];
    setPlaybackRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };

  const applyPreset = (name: string) => {
    const gains = EQ_PRESETS[name];
    if (gains) {
      setEqGains([...gains]);
      setActivePreset(name);
    }
  };

  const formatTime = (s: number) => {
    if (!isFinite(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const accent = isOwn ? 'text-white' : 'text-indigo-500';
  const accentBg = isOwn ? 'bg-white/15' : 'bg-indigo-500/10';
  const accentBgActive = isOwn ? 'bg-white/30' : 'bg-indigo-500/25';
  const mutedColor = isOwn ? 'text-white/50' : 'text-gray-400';
  const sliderTrack = isOwn ? 'bg-white/20' : 'bg-indigo-500/15';
  const sliderFill = isOwn ? 'bg-white/70' : 'bg-indigo-500';

  return (
    <div className="min-w-[260px] max-w-[340px] select-none">
      {/* Header: filename + size */}
      <div className="flex items-center gap-2 mb-2">
        <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm shrink-0 ${accentBg}`}>🎵</div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium truncate">{fileName}</p>
          {fileSize && <p className={`text-[11px] ${mutedColor}`}>{formatBytes(fileSize)}</p>}
        </div>
        {downloadUrl && (
          <button type="button"
            className={`p-1.5 rounded-full hover:${accentBg} shrink-0`}
            title="Сохранить в «Музыку» устройства"
            onClick={e => {
              e.stopPropagation();
              // Раньше файл уходил в каталог документов приложения и не
              // появлялся ни в галерее, ни в проигрывателях: человек качал
              // и не находил.
              void saveMediaToGallery(downloadUrl, fileName || 'Аудио', 'audio');
            }}>
            <Download size={14} className={mutedColor} />
          </button>
        )}
      </div>

      {/* Waveform (audio overview) + seeking */}
      <div className="relative mb-1.5">
        <canvas
          ref={waveformCanvasRef}
          className="w-full h-10 rounded-lg cursor-pointer touch-none"
          onPointerDown={(e) => { setIsSeeking(true); handleSeek(e); (e.target as HTMLElement).setPointerCapture(e.pointerId); }}
          onPointerMove={(e) => { if (isSeeking) handleSeek(e); }}
          onPointerUp={(e) => { if (isSeeking) { handleSeek(e); setIsSeeking(false); } }}
          onPointerCancel={() => setIsSeeking(false)}
        />
        {/* Playhead indicator */}
        {duration > 0 && (
          <div
            className={`absolute top-0 bottom-0 w-0.5 ${isOwn ? 'bg-white' : 'bg-indigo-500'} pointer-events-none`}
            style={{ left: `${(currentTime / duration) * 100}%` }}
          />
        )}
      </div>

      {/* Time + controls row */}
      <div className="flex items-center gap-1 mb-1">
        <span className={`text-[11px] ${mutedColor} w-9 text-center`}>{formatTime(currentTime)}</span>

        {/* Четыре отдельные кнопки вместо двух перегруженных.
            Раньше стрелки делали то перемотку, то переключение — и человек
            не мог предсказать, что будет. Теперь двойная стрелка это
            «другая запись», одинарная с цифрой — «на 10 секунд». */}
        {onPrev && (
          <button onClick={onPrev} disabled={!hasPrev}
                  title="Предыдущая запись"
                  className={`p-1 rounded-full hover:${accentBg} disabled:opacity-30`}>
            <SkipBack size={14} className={accent} />
          </button>
        )}

        <button onClick={() => skip(-10)} title="Назад на 10 секунд"
                className={`p-1 rounded-full hover:${accentBg} flex items-center`}>
          <RotateCcw size={13} className={accent} />
        </button>

        <button onClick={togglePlay}
          className={`w-8 h-8 rounded-full ${accentBgActive} flex items-center justify-center hover:opacity-80 transition-opacity`}>
          {isLoading ? (
            <Loader2 size={16} className={`${accent} animate-spin`} />
          ) : isPlaying ? (
            <Pause size={16} className={accent} fill="currentColor" />
          ) : (
            <Play size={16} className={`${accent} ml-0.5`} fill="currentColor" />
          )}
        </button>

        <button onClick={() => skip(10)} title="Вперёд на 10 секунд"
                className={`p-1 rounded-full hover:${accentBg} flex items-center`}>
          <RotateCw size={13} className={accent} />
        </button>

        {onNext && (
          <button onClick={onNext} disabled={!hasNext}
                  title="Следующая запись"
                  className={`p-1 rounded-full hover:${accentBg} disabled:opacity-30`}>
            <SkipForward size={14} className={accent} />
          </button>
        )}

        <span className={`text-[11px] ${mutedColor} w-9 text-center`}>{formatTime(duration)}</span>
      </div>

      {/* Вспомогательные кнопки — отдельным рядом.
          Все двенадцать в одну строку не помещались на телефоне: широкая
          кнопка ⚡ HAPTIC не сжимается, остальные жались, а последняя —
          раскрытие эквалайзера — выдавливалась за край экрана. Со стороны
          выглядело так, будто эквалайзер пропал совсем. */}
      <div className="flex items-center gap-1.5 mb-1 flex-wrap">
        <button onClick={cycleSpeed}
          className={`text-[10px] font-bold px-2 h-6 rounded-full ${accentBg} ${accent} shrink-0`}>
          {playbackRate}x
        </button>

        <button onClick={() => setVibrateEnabled(!vibrateEnabled)}
          className={`p-1 rounded-full shrink-0 hover:${accentBg} ${vibrateEnabled ? 'animate-pulse' : ''}`}
          title="Вибрация по басу">
          <Vibrate size={14} className={vibrateEnabled ? 'text-red-500' : mutedColor} />
        </button>

        <button onClick={() => setMuted(!muted)} className={`p-1 rounded-full shrink-0 hover:${accentBg}`}>
          {muted ? <VolumeX size={14} className={mutedColor} /> : <Volume2 size={14} className={accent} />}
        </button>

        {/* Native Haptic Toggle */}
        <button
          title="Native 6-channel Haptic Mode"
          className={`flex items-center justify-center h-6 px-2 rounded-full text-[10px] font-bold tracking-wider transition-colors shrink-0 ${nativeHapticMode ? 'bg-indigo-500 text-white' : 'bg-white/10 text-white/50'}`}
          onClick={async () => {
            const wasPlaying = isPlaying;
            if (wasPlaying) await togglePlay();
            setNativeHapticMode(!nativeHapticMode);
          }}
        >
          ⚡ HAPTIC
        </button>

        {/* Кнопка эквалайзера — с названием, а не голой стрелкой.
            Стрелка вверх-вниз ничего не говорит о том, что за ней: человек
            смотрел на ряд значков и не находил эквалайзер, хотя кнопка
            была на месте. Теперь на ней ползунки и подпись. */}
        <button onClick={() => setShowControls(!showControls)}
          title={nativeHapticMode ? 'Эквалайзер (в режиме HAPTIC не действует)' : 'Эквалайзер и звук'}
          className={`flex items-center gap-1 h-6 px-2 rounded-full shrink-0 text-[10px] font-bold tracking-wider transition-colors ${
            showControls
              ? (isOwn ? 'bg-white/30 text-white' : 'bg-indigo-500/25 text-indigo-400')
              : (isOwn ? 'bg-white/10 text-white/60' : 'bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-white/60')
          }`}>
          <SlidersHorizontal size={12} />
          <span>ЭКВАЛАЙЗЕР</span>
          {showControls ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
        </button>
      </div>

      {playError && (
        <p className="text-[11px] text-red-400 mb-1 px-1 leading-snug">{playError}</p>
      )}

      {/* Volume slider */}
      {!muted && (
        <div className="flex items-center gap-2 mb-1 px-1">
          <Volume2 size={12} className={mutedColor} />
          <div className={`flex-1 h-1 rounded-full ${sliderTrack} relative cursor-pointer`}
            onClick={e => {
              const rect = e.currentTarget.getBoundingClientRect();
              setVolume(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
            }}>
            <div className={`h-full rounded-full ${sliderFill}`} style={{ width: `${volume * 100}%` }} />
          </div>
        </div>
      )}

      {/* Expanded controls: EQ + Reverb + Frequency Viz */}
      {showControls && (
        <div className={`mt-2 p-2.5 rounded-xl ${isOwn ? 'bg-white/10' : 'bg-gray-50 dark:bg-white/5'} space-y-3`}>

          {/* Frequency visualization */}
          <div>
            <p className={`text-[10px] font-medium ${mutedColor} uppercase tracking-wider mb-1`}>Визуализация</p>
            <canvas ref={canvasRef} className="w-full h-12 rounded-lg" />
          </div>

          {/* EQ Presets */}
          <div className={nativeHapticMode ? 'opacity-50' : ''}>
            <p className={`text-[10px] font-medium ${mutedColor} uppercase tracking-wider mb-1.5`}>Эквалайзер</p>
            {nativeHapticMode && (
              // Раньше вместо этой строки просто гасла кнопка раскрытия, и
              // человек видел, что эквалайзер «пропал», без единого слова о
              // причине. Причина есть: в режиме HAPTIC звук идёт мимо
              // обработки, через проигрыватель телефона.
              <p className={`text-[10px] ${mutedColor} mb-1.5 normal-case`}>
                В режиме ⚡ HAPTIC звук идёт через проигрыватель телефона,
                поэтому настройки ниже на него не влияют. Выключите режим,
                чтобы вернуть эквалайзер.
              </p>
            )}
            <div className="flex flex-wrap gap-1 mb-2">
              {Object.keys(EQ_PRESETS).map(name => (
                <button key={name}
                  onClick={() => applyPreset(name)}
                  className={`text-[10px] px-2 py-0.5 rounded-full transition-colors ${
                    activePreset === name
                      ? (isOwn ? 'bg-white/30 text-white' : 'bg-indigo-500/20 text-indigo-500')
                      : (isOwn ? 'bg-white/10 text-white/60' : 'bg-gray-100 dark:bg-white/5 text-gray-500')
                  }`}>
                  {name}
                </button>
              ))}
            </div>

            {/* EQ sliders */}
            <div className="flex items-end gap-1 justify-between">
              {EQ_BANDS.map((band, i) => (
                <div key={band.freq} className="flex flex-col items-center gap-1 flex-1">
                  <div className={`relative w-1.5 h-16 rounded-full ${sliderTrack} cursor-pointer`}
                    onClick={e => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const pct = 1 - (e.clientY - rect.top) / rect.height;
                      const val = Math.round((pct * 24 - 12) * 10) / 10;
                      const newGains = [...eqGains];
                      newGains[i] = Math.max(-12, Math.min(12, val));
                      setEqGains(newGains);
                      setActivePreset('');
                    }}>
                    <div className={`absolute bottom-0 w-full rounded-full ${sliderFill}`}
                      style={{ height: `${((eqGains[i] + 12) / 24) * 100}%` }} />
                    {/* Knob */}
                    <div className={`absolute left-1/2 -translate-x-1/2 w-3 h-3 rounded-full border-2 
                      ${isOwn ? 'bg-white border-white/50' : 'bg-indigo-500 border-indigo-400'}
                      shadow-sm`}
                      style={{ bottom: `calc(${((eqGains[i] + 12) / 24) * 100}% - 6px)` }}
                    />
                  </div>
                  <span className={`text-[9px] ${mutedColor}`}>{band.label}</span>
                  <span className={`text-[8px] ${mutedColor}`}>{eqGains[i] > 0 ? '+' : ''}{eqGains[i].toFixed(0)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Reverb */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <p className={`text-[10px] font-medium ${mutedColor} uppercase tracking-wider`}>Реверберация</p>
              <span className={`text-[10px] ${mutedColor}`}>{Math.round(reverbMix * 100)}%</span>
            </div>
            <div className={`h-1.5 rounded-full ${sliderTrack} relative cursor-pointer`}
              onClick={e => {
                const rect = e.currentTarget.getBoundingClientRect();
                setReverbMix(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
              }}>
              <div className={`h-full rounded-full ${sliderFill} transition-all`}
                style={{ width: `${reverbMix * 100}%` }} />
            </div>
          </div>

          {/* Vibration (beat-synced haptics) */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <p className={`text-[10px] font-medium ${mutedColor} uppercase tracking-wider`}>
                <Vibrate size={10} className="inline mr-1" />
                Вибрация в такт
              </p>
              <button
                onClick={() => setVibrateEnabled(!vibrateEnabled)}
                className={`text-[10px] px-2 py-0.5 rounded-full transition-colors ${
                  vibrateEnabled
                    ? 'bg-red-500/20 text-red-500'
                    : (isOwn ? 'bg-white/10 text-white/60' : 'bg-gray-100 dark:bg-white/5 text-gray-500')
                }`}>
                {hapticAnalyzing ? '⏳' : vibrateEnabled ? 'ВКЛ' : 'ВЫКЛ'}
              </button>
            </div>
            {vibrateEnabled && (
              <>
                <div className="flex items-center justify-between mb-1">
                  <span className={`text-[9px] ${mutedColor}`}>Интенсивность</span>
                  <span className={`text-[9px] ${mutedColor}`}>{Math.round(hapticIntensity * 100)}%</span>
                </div>
                <div className={`h-1.5 rounded-full ${sliderTrack} relative cursor-pointer mb-1`}
                  onClick={e => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setHapticIntensity(Math.max(0.1, Math.min(1, (e.clientX - rect.left) / rect.width)));
                  }}>
                  <div className={`h-full rounded-full bg-red-500/70 transition-all`}
                    style={{ width: `${hapticIntensity * 100}%` }} />
                </div>
                <p className={`text-[9px] ${mutedColor}`}>
                  {hapticAnalyzing ? '⏳ ' : '🎵 '}{hapticStatus || 'DSP-анализ ударов'}
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
