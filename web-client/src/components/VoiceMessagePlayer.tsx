import { useState, useRef, useEffect, useCallback } from 'react';
import { Play, Pause, Loader2, Check, X, Pencil } from 'lucide-react';

interface VoiceMessagePlayerProps {
  audioUrl: string;
  duration?: number;
  isOwn: boolean;
  onTranscribe?: () => void;
  onEditTranscription?: (newText: string) => void;
  transcription?: {
    text: string;
    isLoading: boolean;
    error?: string;
  } | null;
}

export default function VoiceMessagePlayer({
  audioUrl,
  duration: metaDuration,
  isOwn,
  onTranscribe,
  onEditTranscription,
  transcription,
}: VoiceMessagePlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(metaDuration || 0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isEditingTranscript, setIsEditingTranscript] = useState(false);
  const [editText, setEditText] = useState('');
  const animFrameRef = useRef<number>(0);
  const waveformRef = useRef<HTMLDivElement>(null);

  const formatTime = (sec: number) => {
    const s = Math.round(sec);
    const m = Math.floor(s / 60);
    const ss = s % 60;
    return `${m}:${ss.toString().padStart(2, '0')}`;
  };

  // ─── Audio setup ───
  useEffect(() => {
    const audio = new Audio();
    audio.crossOrigin = 'anonymous';
    audio.preload = 'metadata';
    audio.src = audioUrl;
    audioRef.current = audio;

    const onMeta = () => {
      if (audio.duration && isFinite(audio.duration)) setDuration(audio.duration);
      setIsLoading(false);
    };
    const onEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
      cancelAnimationFrame(animFrameRef.current);
    };
    const onErr = () => { setIsLoading(false); setIsPlaying(false); };
    const onWait = () => setIsLoading(true);
    const onCan = () => setIsLoading(false);

    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onErr);
    audio.addEventListener('waiting', onWait);
    audio.addEventListener('canplay', onCan);

    return () => {
      cancelAnimationFrame(animFrameRef.current);
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onErr);
      audio.removeEventListener('waiting', onWait);
      audio.removeEventListener('canplay', onCan);
      audio.pause();
      audio.src = '';
    };
  }, [audioUrl]);

  // ─── RAF time update ───
  const tick = useCallback(() => {
    const a = audioRef.current;
    if (a && !a.paused) {
      setCurrentTime(a.currentTime);
      animFrameRef.current = requestAnimationFrame(tick);
    }
  }, []);

  const togglePlay = async () => {
    const a = audioRef.current;
    if (!a) return;
    if (isPlaying) {
      a.pause();
      cancelAnimationFrame(animFrameRef.current);
      setIsPlaying(false);
    } else {
      setIsLoading(true);
      try {
        a.playbackRate = playbackRate;
        await a.play();
        setIsPlaying(true);
        setIsLoading(false);
        animFrameRef.current = requestAnimationFrame(tick);
      } catch {
        setIsLoading(false);
      }
    }
  };

  const handleSeek = (clientX: number) => {
    const a = audioRef.current;
    const el = waveformRef.current;
    if (!a || !duration || !el) return;
    const rect = el.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    a.currentTime = pct * duration;
    setCurrentTime(pct * duration);
  };

  const cycleSpeed = () => {
    const speeds = [1, 1.5, 2, 3, 4, 6, 8, 10, 12];
    const idx = speeds.indexOf(playbackRate);
    const next = speeds[(idx + 1) % speeds.length];
    setPlaybackRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };

  const progress = duration > 0 ? currentTime / duration : 0;

  // ─── Waveform bars ───
  const barCount = 36;
  const bars = useRef<number[]>([]);
  if (bars.current.length === 0) {
    let hash = 0;
    for (let i = 0; i < audioUrl.length; i++) {
      hash = ((hash << 5) - hash) + audioUrl.charCodeAt(i);
      hash |= 0;
    }
    bars.current = Array.from({ length: barCount }, (_, i) => {
      const seed = Math.abs(Math.sin(hash + i * 1.7) * 10000);
      return 0.18 + (seed % 100) / 100 * 0.82;
    });
  }

  const showTranscription = transcription && (transcription.text || transcription.isLoading || transcription.error);

  return (
    <div className="voice-player w-full min-w-[200px] max-w-[340px]">
      {/* ═══ Main row ═══ */}
      <div className="flex items-center gap-2.5">
        {/* Play circle */}
        <button
          onClick={togglePlay}
          className={`flex-shrink-0 w-11 h-11 rounded-full flex items-center justify-center transition-all shadow-sm ${
            isOwn
              ? 'bg-white/20 hover:bg-white/30 text-white'
              : 'bg-primary-500 hover:bg-primary-600 text-white'
          }`}
        >
          {isLoading ? (
            <Loader2 size={20} className="animate-spin" />
          ) : isPlaying ? (
            <Pause size={18} fill="currentColor" />
          ) : (
            <Play size={18} fill="currentColor" className="ml-0.5" />
          )}
        </button>

        {/* Waveform + info */}
        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
          {/* Waveform */}
          <div
            ref={waveformRef}
            className="voice-waveform h-[28px] flex items-center gap-[1.5px] cursor-pointer voice-bar-container"
            onClick={(e) => handleSeek(e.clientX)}
            onTouchStart={(e) => {
              const t = e.touches[0];
              if (t) handleSeek(t.clientX);
            }}
          >
            {bars.current.map((h, i) => {
              const bp = (i + 0.5) / barCount;
              const active = bp <= progress;
              const hStep = Math.max(1, Math.min(20, Math.round(h * 20)));
              return (
                <div
                  key={i}
                  className={`voice-bar voice-h-${hStep} flex-1 rounded-full transition-colors duration-100 ${
                    active
                      ? (isOwn ? 'bg-white' : 'bg-primary-500')
                      : (isOwn ? 'bg-white/30' : 'bg-primary-500/25')
                  }`}
                />
              );
            })}
          </div>

          {/* Time + speed + transcribe */}
          <div className="flex items-center justify-between px-0.5">
            <span className={`text-[11px] tabular-nums leading-none ${
              isOwn ? 'text-white/70' : 'text-messenger-muted'
            }`}>
              {isPlaying ? formatTime(currentTime) : formatTime(duration)}
            </span>

            <div className="flex items-center gap-1">
              {/* Speed */}
              <button
                onClick={cycleSpeed}
                className={`text-[10px] font-bold px-1.5 py-0.5 rounded transition-colors leading-none ${
                  isOwn
                    ? playbackRate !== 1 ? 'bg-white/25 text-white' : 'text-white/50 hover:text-white'
                    : playbackRate !== 1 ? 'bg-primary-500/20 text-primary-500' : 'text-messenger-muted hover:text-messenger-text'
                }`}
              >
                {playbackRate}×
              </button>

              {/* Transcribe Аа */}
              {onTranscribe && (
                <button
                  onClick={(e) => { e.stopPropagation(); onTranscribe(); }}
                  disabled={transcription?.isLoading}
                  className={`text-[10px] font-semibold flex items-center gap-0.5 px-1.5 py-0.5 rounded transition-colors leading-none ${
                    isOwn
                      ? transcription?.text ? 'bg-white/20 text-white' : 'text-white/50 hover:text-white hover:bg-white/10'
                      : transcription?.text ? 'bg-primary-500/15 text-primary-500' : 'text-messenger-muted hover:text-messenger-text hover:bg-messenger-hover'
                  } ${transcription?.isLoading ? 'opacity-60' : ''}`}
                  title="Расшифровать в текст"
                >
                  {transcription?.isLoading ? (
                    <Loader2 size={10} className="animate-spin" />
                  ) : (
                    <span>Аа</span>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ═══ Transcription ═══ */}
      {showTranscription && (
        <div className={`mt-1.5 px-2.5 py-1.5 rounded-lg text-[12px] leading-relaxed ${
          transcription.error
            ? isOwn ? 'bg-red-400/20 text-red-100' : 'bg-red-500/10 text-red-400'
            : isOwn ? 'bg-white/10 text-white/90' : 'bg-messenger-hover/80 text-messenger-text'
        }`}>
          {transcription.error ? (
            <p>{transcription.error}</p>
          ) : transcription.isLoading && !transcription.text ? (
            <span className="flex items-center gap-1.5 text-[11px]">
              <Loader2 size={11} className="animate-spin" />
              Расшифровка...
            </span>
          ) : isEditingTranscript ? (
            <div className="flex flex-col gap-1">
              <textarea
                autoFocus
                value={editText}
                onChange={e => setEditText(e.target.value)}
                className={`w-full bg-transparent border rounded p-2 text-sm leading-relaxed resize-y outline-none min-h-[100px] ${
                  isOwn ? 'border-white/30 text-white placeholder-white/40' : 'border-messenger-border text-messenger-text'
                }`}
                placeholder="Напишите правильный текст для обучения ИИ..."
              />
              <div className="flex items-center gap-1 justify-end">
                <button
                  onClick={() => setIsEditingTranscript(false)}
                  className={`p-1 rounded hover:bg-black/10 ${isOwn ? 'text-white/60' : 'text-messenger-muted'}`}
                ><X size={14} /></button>
                <button
                  onClick={() => {
                    if (editText.trim() && editText.trim() !== transcription.text) {
                      onEditTranscription?.(editText.trim());
                    }
                    setIsEditingTranscript(false);
                  }}
                  className={`p-1 rounded hover:bg-black/10 ${isOwn ? 'text-green-300' : 'text-green-500'}`}
                ><Check size={14} /></button>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-1">
              <p className="flex-1">{transcription.text}</p>
              {onEditTranscription && transcription.text && (
                <button
                  onClick={() => { setEditText(transcription.text); setIsEditingTranscript(true); }}
                  className={`shrink-0 p-0.5 rounded opacity-50 hover:opacity-100 transition-opacity ${
                    isOwn ? 'text-white' : 'text-messenger-muted'
                  }`}
                  title="Исправить расшифровку"
                ><Pencil size={11} /></button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
