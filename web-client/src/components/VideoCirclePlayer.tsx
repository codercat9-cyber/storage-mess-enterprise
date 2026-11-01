import { useRef, useState, useEffect, useCallback } from 'react';

import { formatBytes } from '../lib/format';
import { captureVideoPoster, getCachedPoster } from '../lib/videoPoster';
interface VideoCirclePlayerProps {
  src: string;
  size?: number;
  fileSize?: number;
  duration?: number;
}

/** Круглое видеосообщение — без внешней рамки, с перемоткой */
export default function VideoCirclePlayer({ src, size = 240, fileSize, duration }: VideoCirclePlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [dragging, setDragging] = useState(false);
  const animRef = useRef<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);
  // Кадр-обложка. Пока кружочек не играет, показываем картинку, а не сам
  // <video>: в Android WebView неиграющее видео гаснет, когда система
  // отбирает у него декодер — превью «пропадало» именно поэтому.
  const [poster, setPoster] = useState<string | null>(() => getCachedPoster(src));
  const [started, setStarted] = useState(false);

  const toggle = () => {
    if (dragging) return;
    const v = videoRef.current;
    if (!v) return;
    if (playing) {
      v.pause();
      setPlaying(false);
      cancelAnimationFrame(animRef.current);
    } else {
      try { (window as any).AndroidBridge?.requestAudioFocus?.(); } catch (e) {}
      setStarted(true);
      v.play().then(() => setPlaying(true)).catch(() => { setStarted(false); });
    }
  };

  // Снимаем кадр-обложку, когда кружочек появился на экране. Раньше — незачем:
  // в ленте их может быть десятки.
  useEffect(() => {
    if (poster) return;
    const el = containerRef.current;
    if (!el) return;
    let alive = true;
    const io = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      io.disconnect();
      captureVideoPoster(src, 480).then(p => { if (alive && p) setPoster(p); });
    }, { threshold: 0.1 });
    io.observe(el);
    return () => { alive = false; io.disconnect(); };
  }, [src, poster]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    const update = () => {
      if (v.duration) {
        setProgress(v.currentTime / v.duration);
        setCurrentTime(v.currentTime);
      }
      animRef.current = requestAnimationFrame(update);
    };

    const onPlay = () => { animRef.current = requestAnimationFrame(update); };
    const onPause = () => { cancelAnimationFrame(animRef.current); setPlaying(false); };
    // Досмотрели до конца — возвращаем обложку. Оставлять последний кадр
    // нельзя: он потухнет, как только система заберёт декодер.
    const onEnd = () => { setPlaying(false); setStarted(false); setProgress(0); setCurrentTime(0); cancelAnimationFrame(animRef.current); };

    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('ended', onEnd);
    return () => {
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('ended', onEnd);
      cancelAnimationFrame(animRef.current);
    };
  }, []);

  // Перемотка по касанию/клику на прогресс-кольце
  const seekFromEvent = useCallback((clientX: number, clientY: number) => {
    const el = containerRef.current;
    const v = videoRef.current;
    if (!el || !v || !v.duration) return;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const angle = Math.atan2(clientX - cx, -(clientY - cy));
    let normalized = angle / (2 * Math.PI);
    if (normalized < 0) normalized += 1;
    v.currentTime = normalized * v.duration;
    setProgress(normalized);
    setCurrentTime(v.currentTime);
  }, []);

  const handlePointerDown = (e: React.PointerEvent) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const r = rect.width / 2;
    // Только если кликнули по краю кольца (внешние 20% радиуса)
    if (dist > r * 0.75) {
      e.preventDefault();
      e.stopPropagation();
      setDragging(true);
      seekFromEvent(e.clientX, e.clientY);
      (el as any).setPointerCapture?.(e.pointerId);
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    seekFromEvent(e.clientX, e.clientY);
  };

  const handlePointerUp = () => {
    if (dragging) {
      setDragging(false);
    }
  };

  const r = size / 2;
  const strokeW = 2.5;
  const circumference = 2 * Math.PI * (r - strokeW);

  const formatDur = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const videoDur = videoRef.current?.duration || duration || 0;

  return (
    <div
      ref={containerRef}
      className="relative inline-block cursor-pointer select-none"
      style={{ width: size, height: size }}
      onClick={toggle}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {/* Тонкое прогресс-кольцо */}
      <svg className="absolute inset-0 -rotate-90 z-10 pointer-events-none" width={size} height={size}>
        <circle cx={r} cy={r} r={r - strokeW} fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth={strokeW} />
        <circle cx={r} cy={r} r={r - strokeW} fill="none" stroke="#3b82f6" strokeWidth={strokeW}
          strokeDasharray={circumference} strokeDashoffset={circumference * (1 - progress)}
          strokeLinecap="round" />
      </svg>

      {/* Video — без padding, прямо до краёв круга.
          Прячем его под обложкой, пока не нажали play: паузное видео в
          Android WebView теряет картинку, а <img> держится всегда. */}
      <video
        ref={videoRef}
        src={src}
        className="w-full h-full object-cover rounded-full"
        style={{ visibility: started ? 'visible' : 'hidden' }}
        playsInline
        preload="metadata"
        muted={false}
      />

      {!started && (
        poster
          ? <img src={poster} alt="" draggable={false}
                 className="absolute inset-0 w-full h-full object-cover rounded-full" />
          : <div className="absolute inset-0 rounded-full bg-[#1a1a2e]" />
      )}

      {/* Play overlay */}
      {!playing && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/20 rounded-full z-20 pointer-events-none">
          <div className="w-10 h-10 rounded-full bg-black/50 flex items-center justify-center backdrop-blur-sm">
            <svg className="w-4 h-4 text-white ml-0.5" fill="currentColor" viewBox="0 0 20 20">
              <path d="M6.3 2.84A1.5 1.5 0 004 4.11v11.78a1.5 1.5 0 002.3 1.27l9.344-5.891a1.5 1.5 0 000-2.538L6.3 2.84z"/>
            </svg>
          </div>
        </div>
      )}

      {/* Duration / time badge */}
      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/60 text-white text-[11px] px-2 py-0.5 rounded-full z-20 flex gap-1.5 pointer-events-none">
        {playing || currentTime > 0
          ? <span>{formatDur(currentTime)}{videoDur > 0 ? ` / ${formatDur(videoDur)}` : ''}</span>
          : <>
              {duration ? <span>{formatDur(duration)}</span> : null}
              {fileSize ? <span>{formatBytes(fileSize)}</span> : null}
            </>
        }
      </div>
    </div>
  );
}
