import { useState, useRef, useCallback, useEffect } from 'react';
import { Film } from 'lucide-react';

const thumbnailCache = new Map<string, string>();

interface VideoThumbnailProps {
  src: string;
  className?: string;
  onClick?: () => void;
}

/**
 * Генерирует thumbnail из первого кадра видео через скрытый <video> + canvas.
 * НИКОГДА не рендерит видимый <video> — только <img> или placeholder.
 * Это критично для Android WebView, где <video> показывает нативные контролы.
 */
export default function VideoThumbnail({ src, className = '', onClick }: VideoThumbnailProps) {
  const [poster, setPoster] = useState<string | null>(() => thumbnailCache.get(src) || null);
  const [failed, setFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const attempted = useRef(false);

  const generateThumbnail = useCallback(() => {
    if (attempted.current || poster) return;
    attempted.current = true;

    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    // НЕ ставим crossOrigin — same-origin запросы работают без него
    video.style.position = 'fixed';
    video.style.top = '-9999px';
    video.style.width = '1px';
    video.style.height = '1px';
    video.style.opacity = '0';
    video.style.pointerEvents = 'none';
    document.body.appendChild(video);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try {
        video.pause();
        video.removeAttribute('src');
        video.load();
        if (video.parentNode) document.body.removeChild(video);
      } catch {}
    };

    const captureFrame = () => {
      try {
        const canvas = document.createElement('canvas');
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (!w || !h) { setFailed(true); cleanup(); return; }
        canvas.width = Math.min(w, 480);
        canvas.height = Math.round(canvas.width * (h / w));
        const ctx = canvas.getContext('2d');
        if (!ctx) { setFailed(true); cleanup(); return; }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.75);
        if (dataUrl.length > 1000) {
          thumbnailCache.set(src, dataUrl);
          setPoster(dataUrl);
        } else {
          setFailed(true);
        }
      } catch {
        setFailed(true);
      }
      cleanup();
    };

    // Стратегия: пробуем seek → если не сработал за 3с, берём текущий кадр
    let seekTimeout: ReturnType<typeof setTimeout> | null = null;
    let gotFrame = false;

    video.onseeked = () => {
      if (gotFrame) return;
      gotFrame = true;
      if (seekTimeout) clearTimeout(seekTimeout);
      captureFrame();
    };

    // loadedmetadata fires early (only need headers), triggers seek
    video.onloadedmetadata = () => {
      if (gotFrame) return;
      const target = Math.min(0.5, (video.duration || 1) * 0.1);
      video.currentTime = target;
      seekTimeout = setTimeout(() => {
        if (!gotFrame) captureFrame();
      }, 3000);
    };

    video.onloadeddata = () => {
      if (gotFrame) return;
      if (video.duration && video.duration > 0.1) {
        video.currentTime = Math.min(0.5, video.duration * 0.1);
        if (!seekTimeout) {
          seekTimeout = setTimeout(() => {
            if (!gotFrame) captureFrame();
          }, 3000);
        }
      } else {
        gotFrame = true;
        captureFrame();
      }
    };

    // Fallback: если loadeddata/metadata не дали результат, пробуем play()
    video.oncanplay = () => {
      if (gotFrame || poster || failed) return;
      video.play().then(() => {
        setTimeout(() => {
          video.pause();
          if (!gotFrame && !poster && !failed) { gotFrame = true; captureFrame(); }
        }, 200);
      }).catch(() => {});
    };

    video.onerror = () => { setFailed(true); cleanup(); };

    // Общий таймаут — 10 секунд
    setTimeout(() => {
      if (!poster && !failed) { setFailed(true); cleanup(); }
    }, 10000);

    video.src = src;
  }, [src, poster, failed]);

  useEffect(() => {
    // Lazy: генерим thumbnail только когда элемент виден на экране
    if (poster || thumbnailCache.has(src)) {
      if (!poster && thumbnailCache.has(src)) setPoster(thumbnailCache.get(src)!);
      return;
    }
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          generateThumbnail();
          observer.disconnect();
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [generateThumbnail, src, poster]);

  // Успешно сгенерированный thumbnail
  if (poster) {
    return <img src={poster} className={className} onClick={onClick} loading="lazy" draggable={false} />;
  }

  // Placeholder — тёмный фон с иконкой (вместо видео-элемента!)
  return (
    <div ref={containerRef} className={`${className} flex items-center justify-center bg-[#1a1a2e]`} onClick={onClick}>
      <Film size={32} className="text-white/30" />
    </div>
  );
}
