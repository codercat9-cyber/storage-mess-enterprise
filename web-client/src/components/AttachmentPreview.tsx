import { useState, useRef, useEffect } from 'react';
import { formatBytes } from '../lib/format';
import { X, Send, Image as ImageIcon, FileIcon, Film } from 'lucide-react';

interface AttachmentPreviewProps {
  files: File[];
  onSend: (files: File[], caption: string) => void;
  onCancel: () => void;
}

/** Превью вложений перед отправкой — с полем для подписи */
export default function AttachmentPreview({ files, onSend, onCancel }: AttachmentPreviewProps) {
  const [caption, setCaption] = useState('');
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const urls: string[] = [];
    for (const file of files) {
      if (file.type.startsWith('image/') || file.type.startsWith('video/')) {
        urls.push(URL.createObjectURL(file));
      } else {
        urls.push('');
      }
    }
    setPreviewUrls(urls);
    setTimeout(() => inputRef.current?.focus(), 100);
    return () => { urls.forEach(u => { if (u) URL.revokeObjectURL(u); }); };
  }, [files]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend(files, caption.trim());
    }
    if (e.key === 'Escape') {
      onCancel();
    }
  };

  return (
    <div className="fixed inset-0 z-[80] bg-black/70 flex items-center justify-center animate-fade-in" onClick={onCancel}>
      <div className="bg-messenger-sidebar rounded-2xl w-full max-w-md mx-4 shadow-2xl border border-messenger-border overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-messenger-border">
          <h3 className="font-medium text-messenger-text">
            {files.length === 1 ? 'Отправить файл' : `Отправить ${files.length} файлов`}
          </h3>
          <button onClick={onCancel} className="p-1.5 rounded-full hover:bg-messenger-hover text-messenger-muted"><X size={18} /></button>
        </div>

        {/* Preview grid */}
        <div className="p-4 max-h-[50vh] overflow-y-auto">
          {files.length === 1 ? (
            <div className="flex justify-center">
              {files[0].type.startsWith('image/') && previewUrls[0] ? (
                <img src={previewUrls[0]} alt="" className="max-h-[40vh] rounded-xl object-contain" />
              ) : files[0].type.startsWith('video/') && previewUrls[0] ? (
                <video src={previewUrls[0]} className="max-h-[40vh] rounded-xl" controls playsInline muted />
              ) : (
                <div className="flex items-center gap-3 p-4 bg-messenger-hover/50 rounded-xl w-full">
                  <FileIcon size={32} className="text-blue-400 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-[14px] font-medium truncate text-messenger-text">{files[0].name}</p>
                    <p className="text-[12px] text-messenger-muted">{formatBytes(files[0].size)}</p>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {files.map((file, i) => (
                <div key={i} className="aspect-square rounded-lg overflow-hidden bg-messenger-hover/30 flex items-center justify-center">
                  {file.type.startsWith('image/') && previewUrls[i] ? (
                    <img src={previewUrls[i]} alt="" className="w-full h-full object-cover" />
                  ) : file.type.startsWith('video/') && previewUrls[i] ? (
                    <div className="relative w-full h-full">
                      <video src={previewUrls[i]} className="w-full h-full object-cover" muted />
                      <Film size={24} className="absolute inset-0 m-auto text-white drop-shadow-lg" />
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-1 p-2">
                      <FileIcon size={24} className="text-blue-400" />
                      <span className="text-[10px] text-messenger-muted text-center truncate w-full">{file.name}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Caption input + send */}
        <div className="px-4 pb-4 flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={caption}
            onChange={e => setCaption(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Добавить подпись..."
            className="flex-1 bg-messenger-input rounded-xl px-4 py-2.5 text-[14px] text-messenger-text placeholder:text-messenger-muted focus:outline-none border border-transparent focus:border-messenger-accent/50"
          />
          <button
            onClick={() => onSend(files, caption.trim())}
            className="w-10 h-10 rounded-full bg-messenger-accent text-white flex items-center justify-center hover:opacity-90 transition-opacity shrink-0"
          >
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
