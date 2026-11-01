import { useEffect, useState, useRef } from 'react';
import { formatBytes } from '../lib/format';
import { useMediaStore } from '@/store/media';
import { X, SkipForward, SkipBack, Download, Maximize2 } from 'lucide-react';
import MusicPlayer from './MusicPlayer';
import { saveMediaToGallery } from '@/lib/capacitor-bridge';


export default function GlobalMediaPlayer() {
  const { currentMedia, closeMedia, queue, queueIndex, playNext, playPrev, removeFromQueue } = useMediaStore();
  const [minimized, setMinimized] = useState(false);
  const [videoPlaybackRate, setVideoPlaybackRate] = useState(1);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Подстраиваемся под проигрыватель телефона, только когда он ведёт звук.
  //
  // Здесь была причина, по которой записи «переключались и не начинали
  // играть». Опрос шёл КАЖДУЮ СЕКУНДУ и безусловно подгонял очередь под
  // номер, который сообщает телефон. А телефон в это время не играл ничего
  // и отвечал нулём — своим значением по умолчанию. Получалось так: человек
  // жмёт «следующая», очередь честно переходит на вторую запись, и меньше
  // чем через секунду её отбрасывает обратно на первую. На экране —
  // дёрганье и тишина.
  //
  // Теперь слушаем телефон лишь тогда, когда он и правда ведёт запись, и
  // доверяем его номеру только при живом воспроизведении.
  useEffect(() => {
    let interval: any;
    if ((window as any).AndroidBridge?.getNativeMusicState) {
      interval = setInterval(() => {
        try {
          const store = useMediaStore.getState();
          if (!store.nativeHapticMode || !store.nativeOwnedUrl) return;

          const state = JSON.parse((window as any).AndroidBridge.getNativeMusicState());
          if (!state.isPlaying) return;

          if (state.index !== store.queueIndex &&
              state.index >= 0 && store.queue.length > state.index) {
            store.setQueueIndex(state.index);
          }
        } catch (e) {}
      }, 1000);
    }
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = videoPlaybackRate;
    }
  }, [videoPlaybackRate, currentMedia]);

  if (!currentMedia) return null;

  /** Звучит ли что-нибудь прямо сейчас — по кнопке в самом проигрывателе. */
  const isSomethingPlaying = () => {
    // Кнопка показывает «пауза», пока идёт воспроизведение. Смотрим на неё,
    // а не на внутреннее состояние: проигрыватель живёт отдельным
    // компонентом, и лезть к нему напрямую отсюда неоткуда.
    return Boolean(document.querySelector('svg.lucide-pause'));
  };

  /**
   * Переключение записей.
   *
   * Нативному плееру Android сообщаем отдельно: на телефоне музыку играет
   * своя служба, и если её не предупредить, интерфейс покажет одну запись,
   * а из динамика будет звучать другая.
   */
  // Нативному проигрывателю говорим о переключении только когда он и
  // ведёт звук. Иначе он начинал играть свою очередь параллельно с
  // обычным воспроизведением — два трека разом.
  const goNext = () => {
    // Играли до переключения — значит и на следующей записи продолжаем.
    useMediaStore.getState().setAutoPlayNext(isSomethingPlaying());
    if (useMediaStore.getState().nativeHapticMode) {
      try { (window as any).AndroidBridge?.playNextNativeMusic?.(); } catch { /* не Android */ }
    }
    playNext();
  };

  const goPrev = () => {
    useMediaStore.getState().setAutoPlayNext(isSomethingPlaying());
    if (useMediaStore.getState().nativeHapticMode) {
      try { (window as any).AndroidBridge?.playPrevNativeMusic?.(); } catch { /* не Android */ }
    }
    playPrev();
  };

  const saveMedia = (url: string, name: string, kind: 'video' | 'audio') => {
    void saveMediaToGallery(url, name, kind);
  };

  const cycleVideoSpeed = () => {
    const speeds = [0.5, 1, 1.5, 2, 3, 4, 6, 8, 10, 12];
    const idx = speeds.indexOf(videoPlaybackRate);
    const next = speeds[(idx >= 0 ? idx + 1 : 2) % speeds.length];
    setVideoPlaybackRate(next);
  };

  return (
    <div className={`fixed bottom-4 left-4 right-4 md:left-1/2 md:right-auto md:-translate-x-1/2 md:w-auto z-[9999] transition-all duration-300 ${minimized ? 'translate-y-[120%]' : 'translate-y-0'}`}>
      <div className="relative bg-messenger-bg/90 backdrop-blur-xl border border-messenger-border/50 rounded-2xl shadow-2xl p-3 select-none flex flex-col md:flex-row items-start gap-4 w-full md:max-w-4xl max-h-[80vh] overflow-y-auto no-scrollbar">
        
        {/* Header Controls */}
        <div className="absolute top-2 right-2 flex items-center gap-1 z-50">
          <button 
            onClick={() => setMinimized(true)}
            className="bg-messenger-hover text-messenger-text hover:text-white rounded-full p-1.5 shadow-md transition-colors border border-messenger-border/50"
            title="Свернуть"
          >
            <div className="w-4 h-0.5 bg-current mt-2 mb-1.5" />
          </button>
          <button 
            onClick={closeMedia}
            className="bg-messenger-hover text-messenger-text hover:text-red-400 rounded-full p-1.5 shadow-md transition-colors border border-messenger-border/50"
            title="Закрыть"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex flex-col gap-2 w-full md:min-w-[300px] mt-2">
          {currentMedia.type === 'audio' && (
            <div className="w-full">
              <MusicPlayer
                audioUrl={currentMedia.url}
                fileName={currentMedia.fileName}
                fileSize={currentMedia.fileSize}
                downloadUrl={currentMedia.downloadUrl}
                isOwn={false}
                onEnded={playNext}
                onNext={goNext}
                onPrev={goPrev}
                hasNext={queueIndex < queue.length - 1}
                hasPrev={queueIndex > 0}
              />
            </div>
          )}
          
          {currentMedia.type === 'video' && (
            // Видео раньше ужималось в окошко 200 пикселей высотой, из-за
            // чего смотреть было нечего: лица не разобрать, титры не
            // прочитать. Теперь кадр занимает столько, сколько есть, а
            // управление вынесено под него и не наезжает на картинку.
            <div className="w-full md:min-w-[420px] md:max-w-[560px] flex flex-col gap-2">
              <div className="flex items-center gap-2 px-1">
                <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm shrink-0 bg-indigo-500/10">🎬</div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-medium truncate">{currentMedia.fileName}</p>
                  {currentMedia.fileSize && <p className="text-[11px] text-gray-400">{formatBytes(currentMedia.fileSize)}</p>}
                </div>
              </div>

              <video
                ref={videoRef}
                src={currentMedia.url}
                controls
                autoPlay
                playsInline
                onEnded={playNext}
                className="w-full rounded-xl max-h-[60vh] object-contain bg-black"
              />

              <div className="flex items-center gap-1 px-1">
                {queue.length > 1 && (
                  <>
                    <button onClick={goPrev} disabled={queueIndex <= 0}
                            className="p-1.5 rounded-full hover:bg-white/10 text-indigo-400 disabled:opacity-30"
                            title="Предыдущее">
                      <SkipBack size={16} />
                    </button>
                    <button onClick={goNext} disabled={queueIndex >= queue.length - 1}
                            className="p-1.5 rounded-full hover:bg-white/10 text-indigo-400 disabled:opacity-30"
                            title="Следующее">
                      <SkipForward size={16} />
                    </button>
                  </>
                )}

                <button onClick={() => videoRef.current?.requestFullscreen?.()}
                        className="p-1.5 rounded-full hover:bg-white/10 text-messenger-muted"
                        title="Во весь экран">
                  <Maximize2 size={15} />
                </button>

                {currentMedia.downloadUrl && (
                  <button
                    onClick={() => saveMedia(currentMedia.downloadUrl!, currentMedia.fileName, 'video')}
                    className="p-1.5 rounded-full hover:bg-white/10 text-messenger-muted"
                    title="Сохранить в галерею">
                    <Download size={15} />
                  </button>
                )}

                <button onClick={cycleVideoSpeed}
                        className="ml-auto text-[11px] font-bold px-2 py-1 rounded-lg bg-indigo-500/20 text-indigo-400"
                        title="Скорость">
                  {videoPlaybackRate}×
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Queue panel */}
        {queue.length > 0 && (
          <div className="flex flex-col w-full md:w-[240px] max-h-[240px] border-t md:border-t-0 md:border-l border-messenger-border/50 mt-2 md:mt-0 pt-2 md:pt-0 pl-0 md:pl-3">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-medium text-messenger-muted uppercase tracking-wider">
                Очередь ({queueIndex + 1} из {queue.length})
              </p>
              <div className="flex items-center gap-0.5">
                <button onClick={goPrev} disabled={queueIndex <= 0}
                        className="p-1 hover:bg-messenger-hover rounded-full text-indigo-400 disabled:opacity-30 disabled:hover:bg-transparent"
                        title="Предыдущая">
                  <SkipBack size={14} />
                </button>
                <button onClick={goNext} disabled={queueIndex >= queue.length - 1}
                        className="p-1 hover:bg-messenger-hover rounded-full text-indigo-400 disabled:opacity-30 disabled:hover:bg-transparent"
                        title="Следующая">
                  <SkipForward size={14} />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto no-scrollbar space-y-1 pr-1">
              {queue.map((item, idx) => (
                <div key={item.id || idx} onClick={() => useMediaStore.getState().setQueueIndex(idx)} className={`flex items-center gap-2 p-1.5 rounded-lg hover:bg-white/5 group cursor-pointer ${idx === useMediaStore.getState().queueIndex ? 'bg-indigo-500/20' : ''}`}>
                  <div className="w-6 h-6 rounded bg-indigo-500/20 flex items-center justify-center text-[10px] shrink-0">
                    {idx === useMediaStore.getState().queueIndex ? '▶️' : (item.type === 'audio' ? '🎵' : '🎬')}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] text-white truncate">{item.fileName}</p>
                  </div>
                  <button onClick={() => removeFromQueue(idx)} className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-red-400">
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Re-open Tab if minimized */}
      {minimized && (
        <div 
          onClick={() => setMinimized(false)}
          className="absolute -top-[60px] left-0 right-0 md:left-1/2 md:right-auto md:-translate-x-1/2 bg-messenger-bg/95 backdrop-blur-xl border border-messenger-border/50 text-white rounded-2xl shadow-2xl p-2 px-3 text-sm font-medium hover:bg-white/5 transition-colors cursor-pointer flex items-center justify-between gap-4 mx-4 md:mx-0 w-[calc(100%-2rem)] md:w-[320px]"
        >
          <div className="flex items-center gap-3 overflow-hidden flex-1">
            <div className="w-8 h-8 rounded-full bg-indigo-500/20 flex items-center justify-center shrink-0">
               {currentMedia.type === 'audio' ? '🎵' : '🎬'}
            </div>
            <div className="truncate text-xs font-medium max-w-[180px]">
              {currentMedia.fileName}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {queue.length > 1 && (
              <>
                <button className="text-indigo-400 p-1.5 hover:bg-white/10 rounded-full disabled:opacity-30"
                        disabled={queueIndex <= 0}
                        onClick={(e) => { e.stopPropagation(); goPrev(); }} title="Предыдущая">
                  <SkipBack size={14} />
                </button>
                <button className="text-indigo-400 p-1.5 hover:bg-white/10 rounded-full disabled:opacity-30"
                        disabled={queueIndex >= queue.length - 1}
                        onClick={(e) => { e.stopPropagation(); goNext(); }} title="Следующая">
                  <SkipForward size={14} />
                </button>
              </>
            )}
            <button className="text-gray-400 p-1.5 hover:text-white hover:bg-white/10 rounded-full" onClick={(e) => { 
              e.stopPropagation(); 
              if ((window as any).AndroidBridge?.stopNativeMusic) {
                 (window as any).AndroidBridge.stopNativeMusic();
              }
              closeMedia(); 
            }} title="Закрыть">
              <X size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
