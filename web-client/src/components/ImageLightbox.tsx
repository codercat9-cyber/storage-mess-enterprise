/**
 * ImageLightbox — полноэкранная галерея с листанием (свайп / стрелки)
 * Показывает изображения из текущего чата, поддерживает touch‑свайп.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { X, ChevronLeft, ChevronRight, Download } from 'lucide-react';
import { fileApi } from '@/lib/api';
import { downloadFileNative } from '@/lib/capacitor-bridge';

export interface GalleryImage {
  fileId: string;
  messageId: string;
  url: string;         // viewUrl
  downloadUrl: string;
}

interface Props {
  images: GalleryImage[];
  initialIndex: number;
  onClose: () => void;
}

export default function ImageLightbox({ images, initialIndex, onClose }: Props) {
  const [index, setIndex] = useState(initialIndex);
  const [scale, setScale] = useState(1);
  const touchStartX = useRef(0);
  const touchDeltaX = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const img = images[index];
  const hasPrev = index > 0;
  const hasNext = index < images.length - 1;

  const goPrev = useCallback(() => { if (hasPrev) { setIndex(i => i - 1); setScale(1); } }, [hasPrev]);
  const goNext = useCallback(() => { if (hasNext) { setIndex(i => i + 1); setScale(1); } }, [hasNext]);

  // Keyboard navigation
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') goPrev();
      if (e.key === 'ArrowRight') goNext();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, goPrev, goNext]);

  // Lock body scroll
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  // Touch swipe
  const onTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
    touchDeltaX.current = 0;
  };
  const onTouchMove = (e: React.TouchEvent) => {
    touchDeltaX.current = e.touches[0].clientX - touchStartX.current;
  };
  const onTouchEnd = () => {
    if (touchDeltaX.current > 60) goPrev();
    else if (touchDeltaX.current < -60) goNext();
    touchDeltaX.current = 0;
  };

  // Double-tap zoom
  const lastTap = useRef(0);
  const onDoubleTap = () => {
    const now = Date.now();
    if (now - lastTap.current < 300) {
      setScale(s => s === 1 ? 2 : 1);
    }
    lastTap.current = now;
  };

  if (!img) return null;

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-[9999] bg-black/95 flex items-center justify-center"
      onClick={(e) => { if (e.target === containerRef.current) onClose(); }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/70 to-transparent">
        <span className="text-white/60 text-sm">{index + 1} / {images.length}</span>
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => downloadFileNative(img.downloadUrl, `image-${img.fileId}.jpg`)} className="p-2 rounded-full hover:bg-white/10 text-white/80 transition-colors">
            <Download size={20} />
          </button>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-white/10 text-white/80 transition-colors">
            <X size={22} />
          </button>
        </div>
      </div>

      {/* Arrows */}
      {hasPrev && (
        <button onClick={(e) => { e.stopPropagation(); goPrev(); }} className="absolute left-2 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-black/50 hover:bg-black/70 text-white transition-colors hidden sm:flex">
          <ChevronLeft size={28} />
        </button>
      )}
      {hasNext && (
        <button onClick={(e) => { e.stopPropagation(); goNext(); }} className="absolute right-2 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-black/50 hover:bg-black/70 text-white transition-colors hidden sm:flex">
          <ChevronRight size={28} />
        </button>
      )}

      {/* Image */}
      <img
        key={img.fileId}
        src={img.url}
        alt=""
        className="max-w-[95vw] max-h-[90vh] object-contain select-none transition-transform duration-200"
        style={{ transform: `scale(${scale})` }}
        onClick={onDoubleTap}
        draggable={false}
      />
    </div>
  );
}
