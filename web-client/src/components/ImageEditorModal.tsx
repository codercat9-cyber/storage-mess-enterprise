import React, { useEffect, useRef, useState, useCallback } from 'react';
import { X, Send, RotateCcw, Crop, Pen, Check, Minus, Plus, Type } from 'lucide-react';

type Tool = 'draw' | 'crop' | 'text';

interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type DragHandle = 'tl' | 'tr' | 'bl' | 'br' | 'move' | null;

const COLORS = ['#ffffff', '#000000', '#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#a855f7', '#ec4899'];
const HANDLE_SIZE_CSS = 20; // bigger handles for mobile touch

interface TextOverlay {
  id: string;
  text: string;
  x: number;
  y: number;
  color: string;
  fontSize: number;
}

interface Props {
  file: File | null;
  onSend: (blob: Blob, caption?: string) => void;
  onCancel: () => void;
}

export default function ImageEditorModal({ file, onSend, onCancel }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const imgRef = useRef<HTMLImageElement | null>(null);
  const historyRef = useRef<ImageData[]>([]);
  const isDrawingRef = useRef(false);
  const lastPosRef = useRef<{ x: number; y: number } | null>(null);

  const [tool, setTool] = useState<Tool>('draw');
  const [color, setColor] = useState('#ffffff');
  const [lineWidth, setLineWidth] = useState(4);
  const [canUndo, setCanUndo] = useState(false);
  const [caption, setCaption] = useState('');
  const [sending, setSending] = useState(false);

  // crop state
  const [cropRect, setCropRect] = useState<CropRect>({ x: 0, y: 0, w: 0, h: 0 });
  const cropRectRef = useRef<CropRect>({ x: 0, y: 0, w: 0, h: 0 });
  const dragHandleRef = useRef<DragHandle>(null);
  const dragStartRef = useRef<{ mx: number; my: number; rect: CropRect } | null>(null);

  // text overlays
  const [textOverlays, setTextOverlays] = useState<TextOverlay[]>([]);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const draggingTextRef = useRef<{ id: string; startX: number; startY: number; origX: number; origY: number } | null>(null);

  // canvas display dimensions (CSS)
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });
  // actual image pixel dimensions (canvas internal resolution)
  const imgSizeRef = useRef({ w: 0, h: 0 });
  // scale factor: CSS display / canvas internal
  const scaleRef = useRef(1);

  // ── Load image ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      imgSizeRef.current = { w: img.naturalWidth, h: img.naturalHeight };

      const maxW = Math.min(window.innerWidth - 32, 640);
      const maxH = window.innerHeight * 0.55;
      const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
      const dw = Math.round(img.naturalWidth * scale);
      const dh = Math.round(img.naturalHeight * scale);
      setCanvasSize({ w: dw, h: dh });
      // scale = CSS / canvas_internal → для преобразования pointer coords
      scaleRef.current = scale;

      const initCrop: CropRect = { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
      cropRectRef.current = initCrop;
      setCropRect(initCrop);
    };
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // ── Draw image on canvas when size is ready ──────────────────────────────
  useEffect(() => {
    if (!canvasSize.w || !canvasSize.h || !imgRef.current) return;
    const canvas = canvasRef.current!;
    const natW = imgSizeRef.current.w;
    const natH = imgSizeRef.current.h;
    canvas.width = natW;
    canvas.height = natH;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(imgRef.current, 0, 0, natW, natH);
    historyRef.current = [];
    setCanUndo(false);
  }, [canvasSize]);

  // ── Pointer helpers ──────────────────────────────────────────────────────
  const getPos = (e: React.TouchEvent | React.PointerEvent | TouchEvent | PointerEvent) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    let clientX: number, clientY: number;
    if ('touches' in e) {
      const touch = e.touches[0] || (e as TouchEvent).changedTouches[0];
      clientX = touch.clientX;
      clientY = touch.clientY;
    } else {
      clientX = (e as PointerEvent).clientX;
      clientY = (e as PointerEvent).clientY;
    }
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  };

  const getHitHandle = (x: number, y: number, r: CropRect): DragHandle => {
    // Увеличенный hit area для пальцев (40px вместо 20px)
    const hs = Math.round(40 / (scaleRef.current || 1));
    const hitRadius = hs; // Радиус попадания от угла
    
    // Проверяем дистанцию до каждого угла
    if (Math.hypot(x - r.x, y - r.y) < hitRadius) return 'tl';
    if (Math.hypot(x - (r.x + r.w), y - r.y) < hitRadius) return 'tr';
    if (Math.hypot(x - r.x, y - (r.y + r.h)) < hitRadius) return 'bl';
    if (Math.hypot(x - (r.x + r.w), y - (r.y + r.h)) < hitRadius) return 'br';
    
    // Если не попали в углы, но внутри области - это move
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return 'move';
    return null;
  };

  // ── Unified touch+pointer handlers ────────────────────────────────────────
  const handleStart = (e: React.TouchEvent | React.PointerEvent) => {
    e.preventDefault();
    const pos = getPos(e);

    if (tool === 'text') {
      // Check if tapping on existing text overlay
      const canvas = canvasRef.current!;
      const rect = canvas.getBoundingClientRect();
      let clientX: number, clientY: number;
      if ('touches' in e) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
      } else {
        clientX = e.clientX;
        clientY = e.clientY;
      }
      // Check overlays in reverse (top first)
      for (let i = textOverlays.length - 1; i >= 0; i--) {
        const ov = textOverlays[i];
        const ovScreenX = rect.left + (ov.x / canvas.width) * rect.width;
        const ovScreenY = rect.top + (ov.y / canvas.height) * rect.height;
        const dist = Math.sqrt((clientX - ovScreenX) ** 2 + (clientY - ovScreenY) ** 2);
        if (dist < 60) {
          draggingTextRef.current = { id: ov.id, startX: clientX, startY: clientY, origX: ov.x, origY: ov.y };
          return;
        }
      }
      // Add new text overlay at tap position
      const newId = `text-${Date.now()}`;
      setTextOverlays(prev => [...prev, { id: newId, text: 'Текст', x: pos.x, y: pos.y, color, fontSize: 32 }]);
      setEditingTextId(newId);
      return;
    }

    if (tool === 'draw') {
      isDrawingRef.current = true;
      lastPosRef.current = pos;
      saveHistory();
      const canvas = canvasRef.current!;
      const ctx = canvas.getContext('2d')!;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, lineWidth / (scaleRef.current || 1) / 2, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    } else if (tool === 'crop') {
      const handle = getHitHandle(pos.x, pos.y, cropRectRef.current);
      dragHandleRef.current = handle;
      dragStartRef.current = { mx: pos.x, my: pos.y, rect: { ...cropRectRef.current } };
    }
  };

  const handleMove = (e: React.TouchEvent | React.PointerEvent) => {
    e.preventDefault();

    if (tool === 'text' && draggingTextRef.current) {
      const canvas = canvasRef.current!;
      const rect = canvas.getBoundingClientRect();
      let clientX: number, clientY: number;
      if ('touches' in e) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
      } else {
        clientX = e.clientX;
        clientY = e.clientY;
      }
      const dx = (clientX - draggingTextRef.current.startX) * (canvas.width / rect.width);
      const dy = (clientY - draggingTextRef.current.startY) * (canvas.height / rect.height);
      setTextOverlays(prev => prev.map(ov =>
        ov.id === draggingTextRef.current!.id
          ? { ...ov, x: draggingTextRef.current!.origX + dx, y: draggingTextRef.current!.origY + dy }
          : ov
      ));
      return;
    }

    if (tool === 'draw') {
      if (!isDrawingRef.current) return;
      const canvas = canvasRef.current!;
      const ctx = canvas.getContext('2d')!;
      const pos = getPos(e);
      const last = lastPosRef.current!;
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(pos.x, pos.y);
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth / (scaleRef.current || 1);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
      lastPosRef.current = pos;
    } else if (tool === 'crop') {
      if (!dragHandleRef.current || !dragStartRef.current) return;
      const pos = getPos(e);
      const dx = pos.x - dragStartRef.current.mx;
      const dy = pos.y - dragStartRef.current.my;
      const orig = dragStartRef.current.rect;
      const cw = canvasRef.current!.width;
      const ch = canvasRef.current!.height;
      const MIN = 40;
      let { x, y, w, h } = orig;

      if (dragHandleRef.current === 'move') {
        x = Math.max(0, Math.min(cw - w, orig.x + dx));
        y = Math.max(0, Math.min(ch - h, orig.y + dy));
      } else if (dragHandleRef.current === 'tl') {
        x = Math.max(0, Math.min(orig.x + orig.w - MIN, orig.x + dx));
        y = Math.max(0, Math.min(orig.y + orig.h - MIN, orig.y + dy));
        w = orig.x + orig.w - x;
        h = orig.y + orig.h - y;
      } else if (dragHandleRef.current === 'tr') {
        y = Math.max(0, Math.min(orig.y + orig.h - MIN, orig.y + dy));
        w = Math.max(MIN, Math.min(cw - orig.x, orig.w + dx));
        h = orig.y + orig.h - y;
      } else if (dragHandleRef.current === 'bl') {
        x = Math.max(0, Math.min(orig.x + orig.w - MIN, orig.x + dx));
        w = orig.x + orig.w - x;
        h = Math.max(MIN, Math.min(ch - orig.y, orig.h + dy));
      } else if (dragHandleRef.current === 'br') {
        w = Math.max(MIN, Math.min(cw - orig.x, orig.w + dx));
        h = Math.max(MIN, Math.min(ch - orig.y, orig.h + dy));
      }
      const newRect = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
      cropRectRef.current = newRect;
      setCropRect(newRect);
    }
  };

  const handleEnd = () => {
    isDrawingRef.current = false;
    lastPosRef.current = null;
    dragHandleRef.current = null;
    dragStartRef.current = null;
    draggingTextRef.current = null;
  };

  // ── History ──────────────────────────────────────────────────────────────
  const saveHistory = () => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    historyRef.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    if (historyRef.current.length > 30) historyRef.current.shift();
    setCanUndo(true);
  };

  const handleUndo = () => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    const snap = historyRef.current.pop();
    if (snap) ctx.putImageData(snap, 0, 0);
    setCanUndo(historyRef.current.length > 0);
  };

  // ── Apply crop ────────────────────────────────────────────────────────────
  const applyCrop = () => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    const r = cropRectRef.current;
    if (r.w < 10 || r.h < 10) return;
    saveHistory();
    const data = ctx.getImageData(r.x, r.y, r.w, r.h);
    canvas.width = r.w;
    canvas.height = r.h;
    ctx.putImageData(data, 0, 0);
    imgSizeRef.current = { w: r.w, h: r.h };
    const newRect = { x: 0, y: 0, w: r.w, h: r.h };
    cropRectRef.current = newRect;
    setCropRect(newRect);
    const maxW = Math.min(window.innerWidth - 32, 640);
    const maxH = window.innerHeight * 0.55;
    const newScale = Math.min(maxW / r.w, maxH / r.h, 1);
    scaleRef.current = newScale;
    setCanvasSize({ w: Math.round(r.w * newScale), h: Math.round(r.h * newScale) });
    setTool('draw');
  };

  // ── Bake text overlays into canvas before send ────────────────────────────
  const bakeTextOverlays = () => {
    if (textOverlays.length === 0) return;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    saveHistory();
    for (const ov of textOverlays) {
      const fs = ov.fontSize / (scaleRef.current || 1);
      ctx.font = `bold ${fs}px sans-serif`;
      ctx.fillStyle = ov.color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // text shadow for readability
      ctx.shadowColor = 'rgba(0,0,0,0.7)';
      ctx.shadowBlur = fs / 4;
      ctx.shadowOffsetX = 1;
      ctx.shadowOffsetY = 1;
      ctx.fillText(ov.text, ov.x, ov.y);
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
    }
    setTextOverlays([]);
  };

  // ── Send ──────────────────────────────────────────────────────────────────
  const handleSend = () => {
    if (sending) return;
    setSending(true);
    bakeTextOverlays();
    const canvas = canvasRef.current!;
    canvas.toBlob((blob) => {
      if (blob) onSend(blob, caption.trim() || undefined);
      setSending(false);
    }, 'image/jpeg', 0.92);
  };

  if (!file || !canvasSize.w) return null;

  // Crop overlay rendering via CSS (no separate canvas needed)
  const renderCropOverlay = () => {
    if (tool !== 'crop') return null;
    const r = cropRectRef.current;
    const cw = canvasRef.current?.width || 1;
    const ch = canvasRef.current?.height || 1;
    const scale = scaleRef.current || 1;
    const left = (r.x / cw) * 100;
    const top = (r.y / ch) * 100;
    const width = (r.w / cw) * 100;
    const height = (r.h / ch) * 100;
    const hs = HANDLE_SIZE_CSS;

    return (
      <>
        {/* Darken outside crop */}
        <div className="absolute inset-0 pointer-events-none" style={{
          background: `linear-gradient(rgba(0,0,0,0.6), rgba(0,0,0,0.6))`,
          clipPath: `polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%, ${left}% ${top}%, ${left}% ${top + height}%, ${left + width}% ${top + height}%, ${left + width}% ${top}%, ${left}% ${top}%)`,
        }} />
        {/* Crop border */}
        <div className="absolute pointer-events-none border-2 border-white" style={{
          left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%`,
        }}>
          {/* Grid lines */}
          <div className="absolute inset-0">
            <div className="absolute left-1/3 top-0 bottom-0 w-px bg-white/30" />
            <div className="absolute left-2/3 top-0 bottom-0 w-px bg-white/30" />
            <div className="absolute top-1/3 left-0 right-0 h-px bg-white/30" />
            <div className="absolute top-2/3 left-0 right-0 h-px bg-white/30" />
          </div>
        </div>
        {/* Corner handles */}
        {[
          { pos: 'top-0 left-0', translate: '-50% -50%', cx: left, cy: top },
          { pos: 'top-0 right-0', translate: '50% -50%', cx: left + width, cy: top },
          { pos: 'bottom-0 left-0', translate: '-50% 50%', cx: left, cy: top + height },
          { pos: 'bottom-0 right-0', translate: '50% 50%', cx: left + width, cy: top + height },
        ].map((h, i) => (
          <div key={i} className="absolute pointer-events-none" style={{
            left: `${h.cx}%`, top: `${h.cy}%`,
            width: hs, height: hs,
            transform: 'translate(-50%, -50%)',
            background: 'white',
            borderRadius: 3,
            boxShadow: '0 1px 4px rgba(0,0,0,0.5)',
          }} />
        ))}
      </>
    );
  };

  // Text overlays as positioned elements
  const renderTextOverlays = () => {
    if (tool !== 'text' || textOverlays.length === 0) return null;
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const cw = canvas.width;
    const ch = canvas.height;
    return textOverlays.map(ov => (
      <div
        key={ov.id}
        className="absolute pointer-events-none select-none"
        style={{
          left: `${(ov.x / cw) * 100}%`,
          top: `${(ov.y / ch) * 100}%`,
          transform: 'translate(-50%, -50%)',
          color: ov.color,
          fontSize: ov.fontSize,
          fontWeight: 'bold',
          textShadow: '1px 1px 4px rgba(0,0,0,0.7)',
          whiteSpace: 'nowrap',
        }}
      >
        {ov.text}
      </div>
    ));
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/95 select-none">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3 shrink-0">
        <button onClick={onCancel} className="p-2 rounded-full hover:bg-white/10 text-white transition-colors">
          <X className="w-6 h-6" />
        </button>
        <span className="text-white text-sm font-medium">Редактор</span>
        <button
          onClick={handleSend}
          disabled={sending}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 rounded-full text-sm font-medium transition-colors"
        >
          <Send className="w-4 h-4" />
          {sending ? '...' : 'Отправить'}
        </button>
      </div>

      {/* Canvas area — single canvas, no overlay canvas */}
      <div
        ref={containerRef}
        className="flex-1 flex items-center justify-center overflow-hidden px-4"
      >
        <div className="relative" style={{ width: canvasSize.w, height: canvasSize.h, maxWidth: '100%' }}>
          <canvas
            ref={canvasRef}
            style={{
              display: 'block',
              width: canvasSize.w,
              height: canvasSize.h,
              touchAction: 'none',
              userSelect: 'none',
              WebkitUserSelect: 'none',
            } as any}
            onPointerDown={handleStart}
            onPointerMove={handleMove}
            onPointerUp={handleEnd}
            onPointerCancel={handleEnd}
            onTouchStart={handleStart}
            onTouchMove={handleMove}
            onTouchEnd={handleEnd}
            onTouchCancel={handleEnd}
          />
          {/* CSS-based crop overlay (no second canvas!) */}
          {renderCropOverlay()}
          {/* Text overlays */}
          {renderTextOverlays()}
        </div>
      </div>

      {/* Caption input */}
      <div className="shrink-0 px-4 pt-2">
        <input
          type="text"
          value={caption}
          onChange={e => setCaption(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          placeholder="Добавить подпись..."
          className="w-full bg-white/10 text-white text-[14px] rounded-xl px-4 py-2.5 placeholder:text-white/40 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
        />
      </div>

      {/* Editing text overlay input */}
      {editingTextId && (() => {
        const ov = textOverlays.find(o => o.id === editingTextId);
        if (!ov) return null;
        return (
          <div className="shrink-0 px-4 pt-2">
            <div className="flex items-center gap-2">
              <input
                type="text"
                autoFocus
                value={ov.text}
                onChange={e => setTextOverlays(prev => prev.map(o => o.id === editingTextId ? { ...o, text: e.target.value } : o))}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); setEditingTextId(null); } }}
                onBlur={() => setEditingTextId(null)}
                placeholder="Введите текст..."
                className="flex-1 bg-yellow-500/20 text-white text-[14px] rounded-xl px-4 py-2.5 placeholder:text-white/40 focus:outline-none focus:ring-1 focus:ring-yellow-500/50 border border-yellow-500/30"
              />
              <button onClick={() => setEditingTextId(null)} className="bg-yellow-500 text-black p-2 rounded-full">
                <Check className="w-4 h-4" />
              </button>
            </div>
          </div>
        );
      })()}

      {/* Bottom toolbar */}
      <div className="shrink-0 pb-6 pt-3 px-4">
        {/* Tool selector */}
        <div className="flex items-center justify-center gap-2 mb-4">
          <button
            onClick={() => setTool('draw')}
            className={`flex flex-col items-center gap-1 px-4 py-2 rounded-xl text-xs transition-colors ${tool === 'draw' ? 'bg-white/20 text-white' : 'text-white/60 hover:text-white'}`}
          >
            <Pen className="w-5 h-5" />
            Кисть
          </button>
          <button
            onClick={() => setTool('crop')}
            className={`flex flex-col items-center gap-1 px-4 py-2 rounded-xl text-xs transition-colors ${tool === 'crop' ? 'bg-white/20 text-white' : 'text-white/60 hover:text-white'}`}
          >
            <Crop className="w-5 h-5" />
            Кадрирование
          </button>
          <button
            onClick={() => setTool('text')}
            className={`flex flex-col items-center gap-1 px-4 py-2 rounded-xl text-xs transition-colors ${tool === 'text' ? 'bg-white/20 text-white' : 'text-white/60 hover:text-white'}`}
          >
            <Type className="w-5 h-5" />
            Текст
          </button>
          {canUndo && (
            <button
              onClick={handleUndo}
              className="flex flex-col items-center gap-1 px-4 py-2 rounded-xl text-xs text-white/60 hover:text-white transition-colors"
            >
              <RotateCcw className="w-5 h-5" />
              Отменить
            </button>
          )}
        </div>

        {/* Draw controls */}
        {tool === 'draw' && (
          <div className="flex flex-col items-center gap-3">
            <div className="flex items-center gap-2 flex-wrap justify-center">
              {COLORS.map(c => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  className="rounded-full transition-transform"
                  style={{
                    width: 28,
                    height: 28,
                    background: c,
                    border: color === c ? '3px solid #60a5fa' : '2px solid rgba(255,255,255,0.3)',
                    transform: color === c ? 'scale(1.25)' : 'scale(1)',
                    boxShadow: c === '#ffffff' ? '0 0 0 1px rgba(0,0,0,0.4)' : undefined,
                  }}
                />
              ))}
            </div>
            <div className="flex items-center gap-3">
              <button onClick={() => setLineWidth(w => Math.max(2, w - 2))} className="text-white/70 hover:text-white p-2">
                <Minus className="w-5 h-5" />
              </button>
              <div className="rounded-full bg-white" style={{ width: lineWidth * 2 + 8, height: lineWidth * 2 + 8, minWidth: 12, minHeight: 12, maxWidth: 40, maxHeight: 40 }} />
              <button onClick={() => setLineWidth(w => Math.min(24, w + 2))} className="text-white/70 hover:text-white p-2">
                <Plus className="w-5 h-5" />
              </button>
            </div>
          </div>
        )}

        {/* Crop controls */}
        {tool === 'crop' && (
          <div className="flex items-center justify-center gap-4">
            <span className="text-white/60 text-xs">Тяни за уголки</span>
            <button
              onClick={applyCrop}
              className="flex items-center gap-2 bg-green-600 hover:bg-green-700 text-white px-5 py-2.5 rounded-full text-sm transition-colors"
            >
              <Check className="w-4 h-4" />
              Обрезать
            </button>
          </div>
        )}

        {/* Text controls */}
        {tool === 'text' && (
          <div className="flex flex-col items-center gap-3">
            <span className="text-white/60 text-xs">Нажми на фото чтобы добавить текст</span>
            <div className="flex items-center gap-2 flex-wrap justify-center">
              {COLORS.map(c => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  className="rounded-full transition-transform"
                  style={{
                    width: 24,
                    height: 24,
                    background: c,
                    border: color === c ? '3px solid #60a5fa' : '2px solid rgba(255,255,255,0.3)',
                    transform: color === c ? 'scale(1.2)' : 'scale(1)',
                  }}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
