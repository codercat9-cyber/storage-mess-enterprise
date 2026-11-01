import { useRef, useState, useEffect, useCallback } from 'react';
import { X, Send, SwitchCamera } from 'lucide-react';

interface VideoCircleRecorderProps {
  onSend: (blob: Blob, duration: number) => void;
  onCancel: () => void;
}

const MAX_DURATION = 60; // 60 секунд

export default function VideoCircleRecorder({ onSend, onCancel }: VideoCircleRecorderProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<number>(0);

  // getUserMedia может не завершиться НИКОГДА. На Android так бывает,
  // когда системный диалог разрешений не дошёл до WebView: промис не
  // отклоняется и не выполняется, кнопка записи остаётся заблокированной,
  // и пользователь видит панель с мёртвой красной кнопкой без объяснений.
  // Ограничиваем ожидание и показываем причину.
  const CAMERA_TIMEOUT_MS = 12000;

  const requestStream = (constraints: MediaStreamConstraints): Promise<MediaStream> => {
    if (!navigator.mediaDevices?.getUserMedia) {
      return Promise.reject(new Error(
        'Браузер не даёт доступ к камере. Обычно это значит, что страница открыта по HTTP, а не HTTPS.'
      ));
    }
    return Promise.race([
      navigator.mediaDevices.getUserMedia(constraints),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(
          'Камера не ответила. Проверьте разрешение на камеру и микрофон в настройках приложения.'
        )), CAMERA_TIMEOUT_MS)
      ),
    ]);
  };

  const startCamera = useCallback(async (facing: 'user' | 'environment') => {
    // Остановить предыдущий поток
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
    }
    setError(null);
    try {
      const stream = await requestStream({
        video: {
          facingMode: facing === 'environment' ? { exact: 'environment' } : 'user',
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30 }
        },
        audio: true,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => {});
      }
      setReady(true);
    } catch (err) {
      console.error('[VideoCircle] Camera error:', err);
      // Fallback если устройство не поддерживает exact: environment
      if (facing === 'environment') {
        try {
          const fbStream = await requestStream({
            video: { facingMode: 'environment' },
            audio: true,
          });
          streamRef.current = fbStream;
          if (videoRef.current) {
            videoRef.current.srcObject = fbStream;
            videoRef.current.play().catch(() => {});
          }
          setReady(true);
          return;
        } catch (e) {}
      }
      // Раньше здесь молча закрывалась панель — пользователь не понимал,
      // почему запись не начинается. Показываем причину и даём повтор.
      setError(err instanceof Error ? err.message : 'Не удалось включить камеру');
    }
  }, []);

  useEffect(() => {
    startCamera(facingMode);
    return () => {
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const switchCam = async () => {
    if (recording) return; // Запрет смены камеры во время записи, так как это разорвет MediaRecorder
    setReady(false);
    const next = facingMode === 'user' ? 'environment' : 'user';
    setFacingMode(next);
    
    // Пытаемся переключить камеру "на лету" без остановки потока
    if (streamRef.current) {
      const track = streamRef.current.getVideoTracks()[0];
      if (track) {
        try {
          await track.applyConstraints({
            facingMode: next === 'environment' ? { exact: 'environment' } : 'user'
          });
          if (videoRef.current) {
            videoRef.current.style.transform = next === 'user' ? 'scaleX(-1)' : 'none';
          }
          setReady(true);
          return;
        } catch (e) {
          console.warn('applyConstraints switch failed, fallback to restart', e);
        }
      }
      streamRef.current.getTracks().forEach(t => t.stop());
    }
    await startCamera(next);
  };

  const startRecorder = (): boolean => {
    if (!streamRef.current) return false;
    chunksRef.current = [];
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=h264,opus')
      ? 'video/webm;codecs=h264,opus'
      : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
        ? 'video/webm;codecs=vp8,opus'
        : MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4' : 'video/webm';
    try {
      const mr = new MediaRecorder(streamRef.current, { mimeType, videoBitsPerSecond: 600000 });
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onerror = () => setError('Запись прервалась');
      mr.start(100);
      recorderRef.current = mr;
      return true;
    } catch (err) {
      // Конструктор MediaRecorder бросает на неподдерживаемом mimeType.
      // Раньше исключение уходило наверх, а состояние уже переключилось
      // в «идёт запись»: шёл таймер, рос прогресс, но не писалось ничего.
      console.error('[VideoCircle] MediaRecorder error:', err);
      setError('Это устройство не поддерживает запись видео в поддерживаемом формате');
      return false;
    }
  };

  const handleRecord = () => {
    if (recording) return;
    if (!startRecorder()) return;
    setRecording(true);
    setDuration(0);
    intervalRef.current = window.setInterval(() => {
      setDuration(d => d + 1);
    }, 1000);
  };

  useEffect(() => {
    if (recording && duration >= MAX_DURATION) {
      handleSend();
    }
  }, [duration, recording]);

  const handleSend = () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    const mr = recorderRef.current;
    if (mr && mr.state !== 'inactive') {
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'video/webm' });
        if (blob.size > 0) {
          onSend(blob, duration || 1);
        } else {
          onCancel();
        }
        cleanup();
      };
      mr.stop();
    } else {
      cleanup();
      onCancel();
    }
    setRecording(false);
  };

  const handleCancel = () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    try { recorderRef.current?.stop(); } catch {}
    cleanup();
    onCancel();
  };

  const cleanup = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
  };

  const progress = duration / MAX_DURATION;
  const r = 120;
  const strokeW = 3;
  const circumference = 2 * Math.PI * (r - strokeW);

  return (
    <div className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center animate-fade-in">
      <div className="relative" style={{ width: 240, height: 240 }}>
        {/* Progress ring */}
        <svg className="absolute inset-0 -rotate-90 z-10" width={240} height={240}>
          <circle cx={120} cy={120} r={r - strokeW} fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth={strokeW} />
          {recording && (
            <circle cx={120} cy={120} r={r - strokeW} fill="none" stroke="#ef4444" strokeWidth={strokeW}
              strokeDasharray={circumference} strokeDashoffset={circumference * (1 - progress)}
              strokeLinecap="round" />
          )}
        </svg>

        {/* Camera preview */}
        <video
          ref={videoRef}
          className="w-full h-full object-cover rounded-full"
          style={{ transform: facingMode === 'user' ? 'scaleX(-1)' : 'none' }}
          playsInline
          muted
        />

        {/* Duration */}
        {recording && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-red-500/90 text-white text-xs px-2 py-0.5 rounded-full z-20 flex items-center gap-1">
            <div className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
            {Math.floor(duration / 60)}:{(duration % 60).toString().padStart(2, '0')}
          </div>
        )}
      </div>

      {/* Причина, по которой запись недоступна. Молчаливая заблокированная
          кнопка — худшее из возможных состояний: пользователь жмёт и не
          понимает, почему ничего не происходит. */}
      {error && (
        <div className="absolute top-8 left-4 right-4 mx-auto max-w-sm rounded-xl bg-red-500/95 px-4 py-3 text-center text-sm text-white shadow-lg">
          {error}
          <button
            onClick={() => startCamera(facingMode)}
            className="mt-2 block w-full rounded-lg bg-white/20 py-1.5 font-medium hover:bg-white/30"
          >
            Попробовать снова
          </button>
        </div>
      )}

      {/* Пока камера ещё открывается */}
      {!ready && !error && (
        <div className="absolute top-10 left-1/2 -translate-x-1/2 text-sm text-white/70">
          Включаю камеру…
        </div>
      )}

      {/* Controls */}
      <div className="absolute bottom-24 flex items-center gap-8">
        <button onClick={handleCancel} className="w-12 h-12 rounded-full bg-white/10 flex items-center justify-center text-white hover:bg-white/20">
          <X size={24} />
        </button>

        {!recording ? (
          <button onClick={handleRecord} disabled={!ready}
            title={ready ? 'Записать кружок' : 'Камера ещё не готова'}
            className="w-16 h-16 rounded-full bg-red-500 flex items-center justify-center text-white hover:bg-red-600 disabled:opacity-50 border-4 border-white/30">
            <div className="w-6 h-6 bg-white rounded-full" />
          </button>
        ) : (
          <button onClick={handleSend}
            className="w-16 h-16 rounded-full bg-blue-500 flex items-center justify-center text-white hover:bg-blue-600 border-4 border-white/30">
            <Send size={24} />
          </button>
        )}

        <button onClick={switchCam} disabled={recording} className="w-12 h-12 rounded-full bg-white/10 flex items-center justify-center text-white hover:bg-white/20 disabled:opacity-30 disabled:hover:bg-white/10">
          <SwitchCamera size={24} />
        </button>
      </div>
    </div>
  );
}
