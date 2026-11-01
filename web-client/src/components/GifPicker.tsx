import { useState, useRef, useCallback, useEffect } from 'react';
import { Search, X, Loader2, Sparkles } from 'lucide-react';

interface GifPickerProps {
  onSelect: (gifUrl: string, previewUrl: string, width: number, height: number) => void;
  onClose: () => void;
}

// Tenor API v2 (free tier — 5 req/sec, нужен ключ)
// Используем GIPHY public API как fallback (бесплатный)
const GIPHY_API_KEY = 'CdGDV2dmaVBBvo58mOboKfFrHqOWuDsu'; // public beta key
const GIPHY_SEARCH_URL = 'https://api.giphy.com/v1/gifs/search';
const GIPHY_TRENDING_URL = 'https://api.giphy.com/v1/gifs/trending';

interface GiphyGif {
  id: string;
  images: {
    fixed_height: { url: string; width: string; height: string };
    fixed_height_small: { url: string; width: string; height: string };
    original: { url: string; width: string; height: string };
    downsized_medium: { url: string; width: string; height: string };
  };
  title: string;
}

export default function GifPicker({ onSelect, onClose }: GifPickerProps) {
  const [query, setQuery] = useState('');
  const [gifs, setGifs] = useState<GiphyGif[]>([]);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const searchTimeout = useRef<ReturnType<typeof setTimeout>>();
  const containerRef = useRef<HTMLDivElement>(null);

  const fetchGifs = useCallback(async (q: string, off: number = 0, append = false) => {
    setLoading(true);
    try {
      const url = q.trim()
        ? `${GIPHY_SEARCH_URL}?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(q)}&limit=20&offset=${off}&lang=ru`
        : `${GIPHY_TRENDING_URL}?api_key=${GIPHY_API_KEY}&limit=20&offset=${off}`;
      const res = await fetch(url);
      const data = await res.json();
      const newGifs = data.data || [];
      setGifs(prev => append ? [...prev, ...newGifs] : newGifs);
      setOffset(off + newGifs.length);
    } catch (e) {
      console.error('GIPHY fetch error:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load trending on mount
  useEffect(() => { fetchGifs(''); }, []);

  const handleSearch = (value: string) => {
    setQuery(value);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      setOffset(0);
      fetchGifs(value);
    }, 400);
  };

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el || loading) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 100) {
      fetchGifs(query, offset, true);
    }
  };

  const handleGifClick = (gif: GiphyGif) => {
    const img = gif.images.downsized_medium || gif.images.original;
    const preview = gif.images.fixed_height_small || gif.images.fixed_height;
    onSelect(
      img.url,
      preview.url,
      parseInt(img.width) || 300,
      parseInt(img.height) || 200
    );
  };

  return (
    <div className="flex flex-col h-[350px] bg-messenger-sidebar border-t border-messenger-border">
      {/* Search header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-messenger-border shrink-0">
        <Search size={16} className="text-messenger-muted shrink-0" />
        <input
          type="text"
          value={query}
          onChange={e => handleSearch(e.target.value)}
          placeholder="Поиск GIF..."
          className="flex-1 bg-transparent text-[14px] text-messenger-text placeholder:text-messenger-muted focus:outline-none"
          autoFocus
        />
        <button onClick={onClose} className="p-1 rounded-full hover:bg-messenger-hover text-messenger-muted"><X size={16} /></button>
      </div>

      {/* GIF grid */}
      <div ref={containerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-2">
        {gifs.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center h-full text-messenger-muted gap-2">
            <Sparkles size={32} className="opacity-30" />
            <p className="text-sm">Введите запрос для поиска GIF</p>
          </div>
        )}
        <div className="grid grid-cols-2 gap-1.5">
          {gifs.map(gif => (
            <div
              key={gif.id}
              className="relative rounded-lg overflow-hidden cursor-pointer hover:opacity-80 transition-opacity bg-black/10"
              style={{ aspectRatio: `${gif.images.fixed_height.width} / ${gif.images.fixed_height.height}` }}
              onClick={() => handleGifClick(gif)}
            >
              <img
                src={gif.images.fixed_height.url}
                alt={gif.title}
                className="w-full h-full object-cover"
                loading="lazy"
              />
            </div>
          ))}
        </div>
        {loading && (
          <div className="flex justify-center py-4">
            <Loader2 className="w-6 h-6 animate-spin text-messenger-muted" />
          </div>
        )}
      </div>

      {/* GIPHY attribution */}
      <div className="text-center text-[10px] text-messenger-muted/50 py-1 border-t border-messenger-border shrink-0">
        Powered by GIPHY
      </div>
    </div>
  );
}
