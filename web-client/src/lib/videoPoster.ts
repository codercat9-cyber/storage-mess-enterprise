/**
 * Снятие кадра-обложки с видео через скрытый <video> + canvas.
 *
 * Зачем вообще: в Android WebView видимый <video> в состоянии паузы —
 * ненадёжная картинка. Кадр может не отрисоваться до первого play(), а когда
 * на экране несколько видео, система отбирает декодеры у тех, что не играют, и
 * уже нарисованный кадр гаснет. Снаружи это выглядит как «превью пропадает».
 * Поэтому в списке сообщений мы показываем обычный <img> с кадром, а настоящий
 * <video> держим невидимым до нажатия.
 *
 * Вынесено в отдельный модуль, чтобы кадры делили один кэш: обычные видео
 * (VideoThumbnail) и кружочки (VideoCirclePlayer) часто ссылаются на один и
 * тот же файл, и снимать кадр дважды незачем.
 */

const cache = new Map<string, string>();
const inFlight = new Map<string, Promise<string | null>>();

/** Уже снятый кадр, если он есть — можно показать сразу, без ожидания. */
export function getCachedPoster(src: string): string | null {
  return cache.get(src) || null;
}

export function captureVideoPoster(src: string, maxWidth = 480): Promise<string | null> {
  const hit = cache.get(src);
  if (hit) return Promise.resolve(hit);
  const running = inFlight.get(src);
  if (running) return running;

  const task = new Promise<string | null>(resolve => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    // crossOrigin не ставим: запросы same-origin, а лишний CORS-режим
    // заставил бы сервер отдавать заголовки, которых он не отдаёт.
    video.style.cssText =
      'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none';
    document.body.appendChild(video);

    let done = false;
    let seekTimer: ReturnType<typeof setTimeout> | null = null;
    let hardTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (seekTimer) clearTimeout(seekTimer);
      if (hardTimer) clearTimeout(hardTimer);
      try {
        video.pause();
        video.removeAttribute('src');
        video.load();
        video.remove();
      } catch { /* элемент уже мог уйти вместе с деревом */ }
    };

    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      if (value) cache.set(src, value);
      inFlight.delete(src);
      cleanup();
      resolve(value);
    };

    const capture = () => {
      if (done) return;
      try {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (!w || !h) return finish(null);
        const canvas = document.createElement('canvas');
        canvas.width = Math.min(w, maxWidth);
        canvas.height = Math.round(canvas.width * (h / w));
        const ctx = canvas.getContext('2d');
        if (!ctx) return finish(null);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.75);
        // Совсем короткая строка — это пустой чёрный кадр, он бесполезен.
        finish(dataUrl.length > 1000 ? dataUrl : null);
      } catch {
        finish(null);
      }
    };

    // Первый кадр часто чёрный (затемнение на старте), поэтому берём
    // немного вглубь ролика.
    const seekIntoClip = () => {
      if (done) return;
      const target = Math.min(0.5, (video.duration || 1) * 0.1);
      try { video.currentTime = target; } catch { capture(); return; }
      if (!seekTimer) seekTimer = setTimeout(capture, 3000);
    };

    video.onseeked = capture;
    video.onloadedmetadata = seekIntoClip;
    video.onloadeddata = () => {
      if (video.duration && video.duration > 0.1) seekIntoClip();
      else capture();
    };
    video.onerror = () => finish(null);
    hardTimer = setTimeout(() => finish(null), 10000);

    video.src = src;
  });

  inFlight.set(src, task);
  return task;
}
