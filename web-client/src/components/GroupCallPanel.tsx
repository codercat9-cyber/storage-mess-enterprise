import { useRef, useEffect, useState, useCallback } from 'react';
import {
  PhoneOff,
  Mic,
  MicOff,
  Video,
  VideoOff,
  Volume2,
  Maximize2,
  Minimize2,
  Users,
  ShieldAlert,
  Wifi,
  Radio,
  ArrowLeftRight,
  Speaker,
  Volume1,
  Monitor,
  MonitorOff,
  ChevronUp,
  Settings2,
  RefreshCw,
} from 'lucide-react';
import {
  getLocalStream,
  getPeers,
  setParticipantVolume,
  getParticipantVolume,
  forceActivateRelayMode,
  deactivateRelayMode,
  isInRelayMode,
  toggleScreenShare,
  isScreenSharing,
  switchMicrophone,
  switchCamera,
  getCurrentFacingMode,
} from '@/lib/webrtc';
import { getApiUrl } from '@/lib/connection';
import {
  AudioOutputMode,
  AudioDeviceInfo,
  getAudioOutputMode,
  toggleAudioOutput,
  registerAudioElement,
  unregisterAudioElement,
  getOutputDevices,
  getInputDevices,
  setOutputDevice,
  setInputDevice,
  selectSmartDefault,
  onDeviceChange,
} from '@/lib/audioOutput';

interface Participant {
  userId: string;
  displayName?: string;
  stream: MediaStream | null;
  relayImage?: string | null;
  avatarUrl?: string | null;
}

interface GroupCallPanelProps {
  callType: 'audio' | 'video';
  connectionState: string;
  isRelay: boolean;
  isMuted: boolean;
  isVideoOff: boolean;
  participants: Participant[];
  onToggleMute: () => void;
  onToggleVideo: () => void;
  onEndCall: () => void;
  localAvatarUrl?: string | null;
  localDisplayName?: string;
  onScreenShareChange?: (active: boolean) => void;
}

// ===========================================================================
// Где стоит окно звонка.
//
// Хранится рядом с настройками, а не в состоянии компонента: компонент
// пересоздаётся при каждом переходе между чатами, и вместе с ним терялось
// положение — окно прыгало обратно в угол поверх переписки.
//
// При загрузке положение проверяется на попадание в экран. Окно могли
// оставить на большом мониторе, а открыть на телефоне — тогда сохранённые
// координаты уводят его за край, и «звонок пропал».
// ===========================================================================

const PANEL_POS_KEY = 'call_panel_pos';
const PANEL_SIZE_KEY = 'call_panel_size';
const PANEL_MIN_VISIBLE = 80;   // сколько пикселей окна обязано остаться на виду

function clampToScreen(x: number, y: number, w: number): { x: number; y: number } {
  const maxX = Math.max(0, window.innerWidth - PANEL_MIN_VISIBLE);
  const maxY = Math.max(0, window.innerHeight - PANEL_MIN_VISIBLE);
  return {
    x: Math.min(Math.max(0, x), maxX),
    y: Math.min(Math.max(0, y), maxY),
  };
}

function loadPanelPos(): { x: number; y: number } {
  try {
    const raw = localStorage.getItem(PANEL_POS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (typeof p?.x === 'number' && typeof p?.y === 'number' && p.x >= 0 && p.y >= 0) {
        return clampToScreen(p.x, p.y, 320);
      }
    }
  } catch { /* испорчено — встанем по умолчанию */ }
  return { x: -1, y: -1 };
}

function loadPanelSize(): { w: number; h: number } {
  try {
    const raw = localStorage.getItem(PANEL_SIZE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (typeof s?.w === 'number' && s.w >= 240) {
        return { w: Math.min(s.w, window.innerWidth), h: typeof s.h === 'number' ? s.h : 0 };
      }
    }
  } catch { /* испорчено */ }
  return { w: 320, h: 0 };
}

export default function GroupCallPanel({
  callType,
  connectionState,
  isRelay,
  isMuted,
  isVideoOff,
  participants,
  onToggleMute,
  onToggleVideo,
  onEndCall,
  localAvatarUrl,
  localDisplayName,
  onScreenShareChange,
}: GroupCallPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  // Положение и размер живут ВНЕ компонента.
  //
  // Раньше они лежали в его состоянии, а компонент пересоздаётся при каждом
  // переходе между чатами и вкладками. Человек аккуратно ставил окно
  // звонка в угол, переключался на другой чат — и окно возвращалось на
  // исходное место, поверх переписки. Теперь оно остаётся там, куда его
  // поставили, и переживает переходы.
  const [panelPos, setPanelPos] = useState(() => loadPanelPos());
  const [panelSize, setPanelSize] = useState(() => loadPanelSize());
  const isDragging = useRef(false);
  const isResizing = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const [volumeSliders, setVolumeSliders] = useState<Record<string, boolean>>({});
  const [audioMode, setAudioMode] = useState<AudioOutputMode>(getAudioOutputMode());
  const [isScreenShare, setIsScreenShare] = useState(false);
  const [showDeviceMenu, setShowDeviceMenu] = useState(false);
  const [outputDevices, setOutputDevices] = useState<AudioDeviceInfo[]>([]);
  const [inputDevices, setInputDevices] = useState<AudioDeviceInfo[]>([]);
  const [selectedOutputId, setSelectedOutputId] = useState<string>('default');
  const [selectedInputId, setSelectedInputId] = useState<string>('default');
  const deviceMenuRef = useRef<HTMLDivElement>(null);

  // Уход приложения в фон.
  //
  // Раньше здесь глушился микрофон — и обратно не включался. Человек
  // сворачивал мессенджер, чтобы посмотреть что-то параллельно, возвращался
  // и продолжал говорить, не зная, что его давно никто не слышит. Ради
  // фонового звонка всё и затевалось, а он таким образом обессмысливался.
  //
  // Микрофон в фоне НЕ трогаем: разговор должен продолжаться, пока трубку
  // не положили.
  //
  // Камеру выключаем — в фоне она всё равно недоступна, Android отдаёт
  // чёрный кадр. Но запоминаем, сами ли мы её выключили, и при возвращении
  // включаем обратно. Если человек выключил видео сам — не трогаем, это его
  // решение, а не наше.
  const videoPausedByUs = useRef(false);

  useEffect(() => {
    const handleAppPause = () => {
      if (callType === 'video' && !isVideoOff) {
        videoPausedByUs.current = true;
        onToggleVideo();
      }
    };

    const handleAppResume = () => {
      if (videoPausedByUs.current && callType === 'video' && isVideoOff) {
        videoPausedByUs.current = false;
        onToggleVideo();
      }
    };

    window.addEventListener('app-pause', handleAppPause);
    window.addEventListener('app-resume', handleAppResume);
    return () => {
      window.removeEventListener('app-pause', handleAppPause);
      window.removeEventListener('app-resume', handleAppResume);
    };
  }, [isVideoOff, onToggleVideo, callType]);

  useEffect(() => {
    if (callType === 'video') setIsExpanded(true);
  }, [callType]);

  // Позиция при первом рендере — только если её ещё не выбирали.
  useEffect(() => {
    if (panelPos.x === -1) {
      setPanelPos({
        x: Math.max(0, window.innerWidth - 336),
        y: Math.max(0, window.innerHeight - 300),
      });
    }
  }, []);

  // Запоминаем, куда человек поставил окно.
  useEffect(() => {
    if (panelPos.x < 0 || panelPos.y < 0) return;
    try { localStorage.setItem(PANEL_POS_KEY, JSON.stringify(panelPos)); } catch { /* приватный режим */ }
  }, [panelPos]);

  useEffect(() => {
    try { localStorage.setItem(PANEL_SIZE_KEY, JSON.stringify(panelSize)); } catch { /* приватный режим */ }
  }, [panelSize]);

  // Экран изменился — возвращаем окно на видное место.
  //
  // Без этого достаточно повернуть телефон или свернуть окно браузера,
  // чтобы звонок оказался за краем экрана: он идёт, а управления не видно
  // и трубку не положить.
  useEffect(() => {
    const onResize = () => {
      setPanelPos(prev => (prev.x < 0 ? prev : clampToScreen(prev.x, prev.y, panelSize.w)));
      setPanelSize(prev => ({ ...prev, w: Math.min(prev.w, window.innerWidth - 16) }));
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, [panelSize.w]);

  // Инициализация — smart default + загрузка списка устройств
  useEffect(() => {
    selectSmartDefault().then(({ outputId, inputId }) => {
      setSelectedOutputId(outputId);
      setSelectedInputId(inputId);
    });
    loadDevices();
    const unsub = onDeviceChange(loadDevices);
    return unsub;
  }, []);

  async function loadDevices() {
    const [outs, ins] = await Promise.all([getOutputDevices(), getInputDevices()]);
    setOutputDevices(outs);
    setInputDevices(ins);
  }

  // Закрытие device menu при клике снаружи
  useEffect(() => {
    if (!showDeviceMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (deviceMenuRef.current && !deviceMenuRef.current.contains(e.target as Node)) {
        setShowDeviceMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showDeviceMenu]);

  // Локальное видео
  useEffect(() => {
    if (localVideoRef.current) {
      const stream = getLocalStream();
      if (stream) localVideoRef.current.srcObject = stream;
    }
  }, [callType, isVideoOff]);

  // Позиция и размер панели (без inline style в JSX)
  useEffect(() => {
    if (!panelRef.current) return;
    const panel = panelRef.current;

    if (panelPos.x >= 0) {
      panel.style.left = `${panelPos.x}px`;
      panel.style.right = '';
    } else {
      panel.style.left = '';
      panel.style.right = '16px';
    }

    if (panelPos.y >= 0) {
      panel.style.top = `${panelPos.y}px`;
      panel.style.bottom = '';
    } else {
      panel.style.top = '';
      panel.style.bottom = '16px';
    }

    panel.style.width = `${panelSize.w}px`;
    panel.style.height = panelSize.h ? `${panelSize.h}px` : 'auto';
  }, [panelPos, panelSize]);

  // Drag
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, input, [data-resize-handle]')) return;
    isDragging.current = true;
    const rect = panelRef.current?.getBoundingClientRect();
    if (rect) dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    e.preventDefault();
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging.current) {
        setPanelPos({
          x: Math.max(0, Math.min(window.innerWidth - 100, e.clientX - dragOffset.current.x)),
          y: Math.max(0, Math.min(window.innerHeight - 50, e.clientY - dragOffset.current.y)),
        });
      }
      if (isResizing.current && panelRef.current) {
        const rect = panelRef.current.getBoundingClientRect();
        setPanelSize({
          w: Math.max(280, e.clientX - rect.left),
          h: Math.max(200, e.clientY - rect.top),
        });
      }
    };
    const up = () => { isDragging.current = false; isResizing.current = false; };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', handleMouseMove); window.removeEventListener('mouseup', up); };
  }, []);

  const toggleExpand = useCallback(() => {
    setIsExpanded(prev => {
      if (!prev) {
        const w = Math.min(800, window.innerWidth - 40);
        const h = Math.min(600, window.innerHeight - 40);
        setPanelSize({ w, h });
        setPanelPos({ x: (window.innerWidth - w) / 2, y: (window.innerHeight - h) / 2 });
      } else {
        setPanelSize({ w: 320, h: 0 });
        setPanelPos({ x: window.innerWidth - 336, y: window.innerHeight - 300 });
      }
      return !prev;
    });
  }, []);

  const toggleVolumeSlider = (userId: string) => {
    setVolumeSliders(prev => ({ ...prev, [userId]: !prev[userId] }));
  };

  const handleVolumeChange = (userId: string, val: number) => {
    setParticipantVolume(userId, val);
  };

  const handleToggleSpeaker = async () => {
    const newMode = await toggleAudioOutput();
    setAudioMode(newMode);
  };

  const statusText = connectionState === 'relay' || isRelay
    ? '📡 Relay (через сервер)'
    : connectionState === 'connected'
    ? '🟢 P2P'
    : connectionState === 'connecting'
    ? '🟡 Подключение...'
    : connectionState === 'failed'
    ? '🔴 Ошибка'
    : '🔄 Ожидание...';

  return (
    <div
      ref={panelRef}
      onMouseDown={handleMouseDown}
      className={`fixed z-50 bg-gray-900/95 backdrop-blur-sm rounded-xl shadow-2xl border border-gray-700/50 select-none flex flex-col overflow-hidden call-panel ${isDragging.current ? 'cursor-grabbing' : 'cursor-grab'}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-gray-800/80 border-b border-gray-700/50">
        <div className="flex items-center gap-2">
          <Users size={14} className="text-green-400" />
          <span className="text-xs text-gray-300 font-medium">
            {callType === 'audio' ? 'Аудиозвонок' : 'Видеозвонок'}
            <span className="ml-2 text-gray-500">
              ({participants.length + 1} чел.)
            </span>
          </span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-gray-500 mr-1">{statusText}</span>
          <button
            onClick={toggleExpand}
            className="p-1 hover:bg-gray-700 text-gray-400 hover:text-white rounded transition-colors"
          >
            {isExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
      </div>

      {/* Participant Grid */}
      <div className="flex-1 overflow-auto p-2">
        <div
          className={`grid gap-2 ${isExpanded ? 'call-panel-grid-expanded' : 'call-panel-grid'}`}
        >
          {/* Local (self) tile */}
          <div className={`relative bg-gray-800 rounded-lg overflow-hidden flex flex-col items-center justify-center ${isExpanded ? 'call-panel-tile-expanded' : 'call-panel-tile'}`}
          >
            {/* Показываем видео если callType=video И камера включена, ИЛИ если мы принудительно включили камеру в аудио-звонке */}
            {(callType === 'video' || !isVideoOff) && !isVideoOff ? (
              <video
                ref={localVideoRef}
                autoPlay
                muted
                playsInline
                className="w-full h-full object-cover scale-x-[-1]"
              />
            ) : (
              <AvatarDisplay
                avatarUrl={localAvatarUrl}
                displayName={localDisplayName || 'Вы'}
                size={isExpanded ? 'lg' : 'md'}
              />
            )}
            <div className="absolute bottom-1 left-1 right-1 flex items-center justify-between">
              <span className="text-[10px] text-white bg-black/50 px-1.5 py-0.5 rounded">
                Вы {isMuted && '🔇'} {isRelay && '📡'}
              </span>
            </div>
          </div>

          {/* Remote participants */}
          {participants.map(p => (
            <ParticipantTile
              key={p.userId}
              participant={p}
              callType={callType}
              isExpanded={isExpanded}
              isRelay={isRelay}
              showVolume={!!volumeSliders[p.userId]}
              onToggleVolume={() => toggleVolumeSlider(p.userId)}
              onVolumeChange={(val) => handleVolumeChange(p.userId, val)}
            />
          ))}
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center justify-center gap-2 px-3 py-2.5 bg-gray-800/60 border-t border-gray-700/50 flex-wrap relative">
        <button
          onClick={onToggleMute}
          className={`p-2.5 rounded-full transition-colors ${isMuted ? 'bg-red-500 hover:bg-red-600' : 'bg-gray-700 hover:bg-gray-600'} text-white`}
          title={isMuted ? 'Включить микрофон' : 'Выключить микрофон'}
        >
          {isMuted ? <MicOff size={18} /> : <Mic size={18} />}
        </button>

        {/* КНОПКА КАМЕРЫ — ТЕПЕРЬ СИНЯЯ ДЛЯ ЗАМЕТНОСТИ */}
        <button
          onClick={onToggleVideo}
          className={`p-2.5 rounded-full transition-colors ${isVideoOff ? 'bg-red-500 hover:bg-red-600' : 'bg-blue-600 hover:bg-blue-700'} text-white`}
          title={isVideoOff ? 'Включить камеру' : 'Выключить камеру'}
        >
          {isVideoOff ? <VideoOff size={18} /> : <Video size={18} />}
        </button>

        {/* Переключить камеру (фронт/задняя) — только когда видео включено */}
        {!isVideoOff && (
          <button
            onClick={async () => {
              const ok = await switchCamera();
              if (!ok) console.warn('[UI] Camera switch failed');
            }}
            className="p-2.5 rounded-full transition-colors bg-gray-700 hover:bg-gray-600 text-white"
            title={`Переключить камеру (${getCurrentFacingMode() === 'user' ? 'на заднюю' : 'на фронтальную'})`}
          >
            <RefreshCw size={18} />
          </button>
        )}

        {/* Демонстрация экрана */}
        <button
          onClick={async () => {
            const newState = !isScreenShare;
            const ok = await toggleScreenShare(newState);
            if (ok) {
              setIsScreenShare(newState);
              onScreenShareChange?.(newState);
            }
          }}
          className={`p-2.5 rounded-full transition-colors ${
            isScreenShare
              ? 'bg-green-500 hover:bg-green-600'
              : 'bg-gray-700 hover:bg-gray-600'
          } text-white`}
          title={isScreenShare ? 'Остановить демонстрацию' : 'Демонстрация экрана'}
        >
          {isScreenShare ? <MonitorOff size={18} /> : <Monitor size={18} />}
        </button>

        {/* Кнопка переключения динамик: разговорный ↔ громкая связь */}
        <button
          onClick={handleToggleSpeaker}
          className={`p-2.5 rounded-full transition-colors ${
            audioMode === 'speaker'
              ? 'bg-blue-500 hover:bg-blue-600'
              : 'bg-gray-700 hover:bg-gray-600'
          } text-white`}
          title={audioMode === 'speaker' ? 'Переключить на разговорный динамик' : 'Включить громкую связь'}
        >
          {audioMode === 'speaker' ? <Speaker size={18} /> : <Volume1 size={18} />}
        </button>

        {/* Настройки устройств */}
        <button
          onClick={() => { setShowDeviceMenu(prev => !prev); loadDevices(); }}
          className={`p-2.5 rounded-full transition-colors ${showDeviceMenu ? 'bg-blue-500 hover:bg-blue-600' : 'bg-gray-700 hover:bg-gray-600'} text-white`}
          title="Настройки микрофона и динамика"
        >
          <Settings2 size={18} />
        </button>

        {/* Кнопка переключения P2P ↔ Relay */}
        <button
          onClick={() => {
            try {
              if (isRelay) {
                deactivateRelayMode();
              } else {
                forceActivateRelayMode();
              }
            } catch (err) {
              console.error('[UI] Mode switch error:', err);
            }
          }}
          className={`p-2.5 rounded-full transition-colors ${
            isRelay 
              ? 'bg-orange-500 hover:bg-orange-600' 
              : 'bg-gray-700 hover:bg-gray-600'
          } text-white`}
          title={isRelay ? 'Переключить на P2P (прямое)' : 'Переключить на Relay (через сервер)'}
        >
          {isRelay ? (
            <div className="relative">
              <Radio size={18} />
              <ArrowLeftRight size={8} className="absolute -top-1 -right-1" />
            </div>
          ) : (
            <div className="relative">
              <Wifi size={18} />
              <ArrowLeftRight size={8} className="absolute -top-1 -right-1" />
            </div>
          )}
        </button>

        <button
          onClick={onEndCall}
          className="p-2.5 bg-red-500 hover:bg-red-600 text-white rounded-full transition-colors"
          title="Завершить звонок"
        >
          <PhoneOff size={18} />
        </button>

        {/* Device Selection Menu */}
        {showDeviceMenu && (
          <div
            ref={deviceMenuRef}
            className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-gray-900 border border-gray-600 rounded-xl shadow-2xl p-3 min-w-[260px] max-w-[340px] z-50 animate-scale-in"
            onClick={e => e.stopPropagation()}
          >
            {/* Микрофон */}
            {inputDevices.length > 0 && (
              <div className="mb-3">
                <p className="text-[11px] text-gray-400 font-medium mb-1.5 flex items-center gap-1">
                  <Mic size={12} /> Микрофон
                </p>
                <select
                  value={selectedInputId}
                  onChange={async (e) => {
                    const id = e.target.value;
                    setSelectedInputId(id);
                    setInputDevice(id);
                    await switchMicrophone(id);
                  }}
                  className="w-full bg-gray-800 text-gray-200 text-[12px] rounded-lg px-2 py-1.5 border border-gray-600 focus:outline-none focus:border-blue-500"
                >
                  {inputDevices.map(d => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Динамик */}
            {outputDevices.length > 0 && (
              <div>
                <p className="text-[11px] text-gray-400 font-medium mb-1.5 flex items-center gap-1">
                  <Speaker size={12} /> Динамик
                </p>
                <select
                  value={selectedOutputId}
                  onChange={async (e) => {
                    const id = e.target.value;
                    setSelectedOutputId(id);
                    await setOutputDevice(id);
                  }}
                  className="w-full bg-gray-800 text-gray-200 text-[12px] rounded-lg px-2 py-1.5 border border-gray-600 focus:outline-none focus:border-blue-500"
                >
                  {outputDevices.map(d => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {inputDevices.length === 0 && outputDevices.length === 0 && (
              <p className="text-[11px] text-gray-500 text-center py-2">Устройства не обнаружены</p>
            )}
          </div>
        )}
      </div>

      {/* Resize handle */}
      <div
        data-resize-handle
        onMouseDown={(e) => { isResizing.current = true; e.preventDefault(); e.stopPropagation(); }}
        className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize call-resize-handle"
      />
    </div>
  );
}

// =====================================================
// AvatarDisplay — показ аватарки или инициалов
// =====================================================
function AvatarDisplay({ avatarUrl, displayName, size = 'md' }: { avatarUrl?: string | null; displayName: string; size?: 'sm' | 'md' | 'lg' }) {
  const sizeClasses = {
    sm: 'w-12 h-12 text-sm',
    md: 'w-20 h-20 text-xl',
    lg: 'w-28 h-28 text-3xl',
  };
  const nameClasses = {
    sm: 'text-[11px]',
    md: 'text-[13px]',
    lg: 'text-[15px]',
  };
  const initials = displayName.slice(0, 2).toUpperCase();
  
  const apiUrl = getApiUrl();

  const avatarElement = avatarUrl ? (() => {
    const fullUrl = avatarUrl.startsWith('http') ? avatarUrl : `${apiUrl}${avatarUrl.startsWith('/') ? '' : '/'}${avatarUrl}`;
    return (
      <div className={`${sizeClasses[size]} rounded-full overflow-hidden bg-gray-700 flex items-center justify-center shadow-lg`}>
        <img 
          src={fullUrl} 
          alt={displayName}
          className="w-full h-full object-cover"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = 'none';
            (e.target as HTMLImageElement).parentElement!.innerHTML = `<span class="text-white font-bold">${initials}</span>`;
          }}
        />
      </div>
    );
  })() : (
    <div className={`${sizeClasses[size]} rounded-full bg-blue-600 flex items-center justify-center text-white font-bold shadow-lg`}>
      {initials}
    </div>
  );

  return (
    <div className="flex flex-col items-center gap-2">
      {avatarElement}
      <span className={`${nameClasses[size]} text-white/80 font-medium truncate max-w-[90%] text-center`}>
        {displayName}
      </span>
    </div>
  );
}

// =====================================================
// ParticipantTile — один участник с аватаркой
// =====================================================
function ParticipantTile({
  participant,
  callType,
  isExpanded,
  showVolume,
  onToggleVolume,
  onVolumeChange,
  isRelay,
}: {
  participant: Participant;
  callType: 'audio' | 'video';
  isExpanded: boolean;
  showVolume: boolean;
  onToggleVolume: () => void;
  onVolumeChange: (val: number) => void;
  isRelay: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [vol, setVol] = useState(1);
  const [trackRevision, setTrackRevision] = useState(0);
  const hasVideo = participant.stream?.getVideoTracks().some(t => t.readyState === 'live' && t.enabled);

  // Слушаем изменения треков (mute/unmute/ended) для реактивного hasVideo
  useEffect(() => {
    if (!participant.stream) return;
    const tracks = participant.stream.getVideoTracks();
    const bump = () => setTrackRevision(r => r + 1);
    tracks.forEach(t => {
      t.addEventListener('mute', bump);
      t.addEventListener('unmute', bump);
      t.addEventListener('ended', bump);
    });
    return () => {
      tracks.forEach(t => {
        t.removeEventListener('mute', bump);
        t.removeEventListener('unmute', bump);
        t.removeEventListener('ended', bump);
      });
    };
  }, [participant.stream]);

  useEffect(() => {
    try {
      if (participant.stream) {
        if (videoRef.current) {
          videoRef.current.srcObject = participant.stream;
          videoRef.current.play().catch(() => {});
        }
        if (audioRef.current) {
          audioRef.current.srcObject = participant.stream;
          audioRef.current.play().catch(() => {});
          registerAudioElement(audioRef.current);
        }
      }
    } catch (err) {
      console.warn('[ParticipantTile] Error setting stream:', err);
    }
    return () => {
      if (audioRef.current) unregisterAudioElement(audioRef.current);
    };
  }, [participant.stream, hasVideo, callType, trackRevision]);

  useEffect(() => {
    setVol(getParticipantVolume(participant.userId));
  }, [participant.userId]);

  const handleVol = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setVol(v);
    onVolumeChange(v);
  };

  const name = participant.displayName || participant.userId.slice(0, 8);
  // Показываем видео если либо звонок видео-типа, либо у участника РЕАЛЬНО есть видео-трек
  const showVideo = (callType === 'video' || hasVideo) && (hasVideo || participant.relayImage);

  return (
    <div className={`relative bg-gray-800 rounded-lg overflow-hidden flex flex-col items-center justify-center ${isExpanded ? 'call-panel-tile-expanded' : 'call-panel-tile'}`}
    >
      {/* Дорожка участника. data-call-audio — чтобы уход приложения в фон
          не остановил её вместе с роликами и музыкой. */}
      <audio ref={audioRef} autoPlay playsInline muted className="hidden-audio" data-call-audio />

      {showVideo ? (
        // В режиме Relay предпочитаем relayImage (JPEG)
        (isRelay && participant.relayImage) ? (
          <img 
            src={participant.relayImage} 
            className="w-full h-full object-cover" 
            alt={name}
          />
        ) : (
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="w-full h-full object-cover"
          />
        )
      ) : (
        /* Аватарка или инициалы когда видео выключено */
        <AvatarDisplay
          avatarUrl={participant.avatarUrl}
          displayName={name}
          size={isExpanded ? 'lg' : 'md'}
        />
      )}

      {/* Name + volume button */}
      <div className="absolute bottom-1 left-1 right-1 flex items-center justify-between pointer-events-none">
        <span className="text-[10px] text-white bg-black/50 px-1.5 py-0.5 rounded truncate max-w-[70%]">
          {name} {isRelay && '📡'}
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); onToggleVolume(); }}
          className="p-0.5 hover:bg-white/20 rounded text-white/70 hover:text-white pointer-events-auto"
          title="Громкость"
        >
          <Volume2 size={12} />
        </button>
      </div>

      {/* Volume slider */}
      {showVolume && (
        <div className="absolute top-1 left-1 right-1 bg-black/70 rounded p-1.5 flex items-center gap-1"
          onClick={e => e.stopPropagation()}
        >
          <Volume2 size={10} className="text-white/60 flex-shrink-0" />
          <input
            type="range"
            min="0"
            max="2"
            step="0.05"
            value={vol}
            onChange={handleVol}
            className="flex-1 h-1 accent-blue-500"
            aria-label={`Громкость участника ${name}`}
            title={`Громкость участника ${name}`}
          />
          <span className="text-[9px] text-white/60 w-6 text-right">{Math.round(vol * 100)}%</span>
        </div>
      )}
    </div>
  );
}
