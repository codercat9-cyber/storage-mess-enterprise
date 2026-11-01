import { useRef, useState, useEffect, useCallback } from 'react';
import { X, Send, SwitchCamera, Camera, Video } from 'lucide-react';

interface CameraCaptureProps {
  onSendPhoto: (blob: Blob) => void;
  onSendVideo: (blob: Blob, duration: number) => void;
  onCancel: () => void;
}

const MAX_VIDEO_DURATION = 120; // 2 минуты

export default function CameraCapture({ onSendPhoto, onSendVideo, onCancel }: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const [mode, setMode] = useState<'photo' | 'video'>('photo');
  const [recording, setRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('environment');
  const [ready, setReady] = useState(false);
  const [capturedPhoto, setCapturedPhoto] = useState<string | null>(null);
  const [capturedBlob, setCapturedBlob] = useState<Blob | null>(null);
  const intervalRef = useRef<number>(0);

  const startCamera = useCallback(async (facing: 'user' | 'environment', withAudio: boolean) => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
    }
    setReady(false);
    try {
      // Back camera: жёсткий лимит 720p чтобы WebView не тупил с 4K
      const isBack = facing === 'environment';
      const constraints: MediaStreamConstraints = {
        video: {
          facingMode: facing,
          width: isBack ? { ideal: 1280, max: 1280 } : { ideal: 1920 },
          height: isBack ? { ideal: 720, max: 720 } : { ideal: 1080 },
          frameRate: isBack ? { ideal: 30, max: 30 } : undefined,
        },
        audio: withAudio,
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => {});
      }
      setReady(true);
    } catch (err) {
      console.error('[Camera] Error:', err);
      // Fallback: пробуем без конкретных constraints
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: withAudio });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
        setReady(true);
      } catch (e2) {
        console.error('[Camera] Fallback failed:', e2);
        onCancel();
      }
    }
  }, [onCancel]);

  useEffect(() => {
    startCamera(facingMode, mode === 'video');
    return () => {
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Перезапуск камеры при смене режима (фото→видео нужен аудио)
  useEffect(() => {
    startCamera(facingMode, mode === 'video');
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const switchCamera = useCallback(() => {
    const next = facingMode === 'user' ? 'environment' : 'user';
    setFacingMode(next);
    startCamera(next, mode === 'video');
  }, [facingMode, mode, startCamera]);

  // Фото — полное разрешение с камеры
  const takePhoto = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    // Используем реальное разрешение видеопотока
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    // Качество 0.95 для основной камеры, чтобы не резать детали
    canvas.toBlob((blob) => {
      if (blob) {
        setCapturedBlob(blob);
        setCapturedPhoto(canvas.toDataURL('image/jpeg', 0.85)); // Preview можно сжать
      }
    }, 'image/jpeg', 0.95);
  }, []);

  const retakePhoto = useCallback(() => {
    setCapturedPhoto(null);
    setCapturedBlob(null);
  }, []);

  const sendPhoto = useCallback(() => {
    if (capturedBlob) {
      onSendPhoto(capturedBlob);
    }
  }, [capturedBlob, onSendPhoto]);

  // Видео
  const startRecording = useCallback(() => {
    if (!streamRef.current) return;
    chunksRef.current = [];
    
    // Нужен аудио — перезапускаем стрим с аудио
    const doRecord = async () => {
      if (!streamRef.current!.getAudioTracks().length) {
        try {
          const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const videoTrack = streamRef.current!.getVideoTracks()[0];
          const combined = new MediaStream([videoTrack, ...audioStream.getAudioTracks()]);
          streamRef.current = combined;
        } catch { /* без аудио */ }
      }
      
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=h264,opus')
        ? 'video/webm;codecs=h264,opus'  // h264 = hardware-accelerated на большинстве Android
        : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
          ? 'video/webm;codecs=vp8,opus'
          : 'video/webm';
      const recorder = new MediaRecorder(streamRef.current!, { mimeType, videoBitsPerSecond: 1_500_000 });
      recorderRef.current = recorder;
      
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeType });
        onSendVideo(blob, duration);
      };
      
      recorder.start(100);
      setRecording(true);
      setDuration(0);
      intervalRef.current = window.setInterval(() => {
        setDuration(prev => prev + 1);
      }, 1000);
    };
    doRecord();
  }, [onSendVideo]);

  useEffect(() => {
    if (recording && duration >= MAX_VIDEO_DURATION) {
      stopRecording();
    }
  }, [duration, recording]);

  const stopRecording = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    }
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = 0;
    }
    setRecording(false);
  }, []);

  const handleCancel = useCallback(() => {
    if (recording) stopRecording();
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    onCancel();
  }, [recording, stopRecording, onCancel]);

  const formatTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;

  return (
    <div className="fixed inset-0 z-[9999] bg-black flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-black/80 z-10">
        <button onClick={handleCancel} className="w-10 h-10 flex items-center justify-center text-white">
          <X size={24} />
        </button>
        <div className="flex gap-2">
          <button
            onClick={() => { setMode('photo'); retakePhoto(); }}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${mode === 'photo' ? 'bg-white text-black' : 'bg-white/20 text-white'}`}
          >
            Фото
          </button>
          <button
            onClick={() => { setMode('video'); retakePhoto(); }}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${mode === 'video' ? 'bg-red-500 text-white' : 'bg-white/20 text-white'}`}
          >
            Видео
          </button>
        </div>
        <button onClick={switchCamera} className="w-10 h-10 flex items-center justify-center text-white">
          <SwitchCamera size={22} />
        </button>
      </div>

      {/* Preview */}
      <div className="flex-1 relative overflow-hidden flex items-center justify-center bg-black">
        <video
          ref={videoRef}
          className={`w-full h-full object-cover ${capturedPhoto ? 'hidden' : ''}`}
          autoPlay
          playsInline
          muted
        />
        {capturedPhoto && (
          <img src={capturedPhoto} className="w-full h-full object-contain" alt="Preview" />
        )}
        <canvas ref={canvasRef} className="hidden" />
        
        {recording && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-red-600 text-white px-3 py-1 rounded-full text-sm font-mono flex items-center gap-2">
            <div className="w-2 h-2 bg-white rounded-full animate-pulse" />
            {formatTime(duration)}
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="flex items-center justify-center gap-8 py-6 bg-black/80">
        {mode === 'photo' ? (
          capturedPhoto ? (
            <>
              <button onClick={retakePhoto} className="w-14 h-14 rounded-full bg-white/20 flex items-center justify-center text-white">
                <X size={24} />
              </button>
              <button onClick={sendPhoto} className="w-16 h-16 rounded-full bg-blue-500 flex items-center justify-center text-white shadow-lg">
                <Send size={24} className="ml-1" />
              </button>
            </>
          ) : (
            <button onClick={takePhoto} className="w-16 h-16 rounded-full border-4 border-white bg-white/20 flex items-center justify-center active:bg-white/40 transition-colors">
              <Camera size={28} className="text-white" />
            </button>
          )
        ) : (
          recording ? (
            <button onClick={stopRecording} className="w-16 h-16 rounded-full bg-red-500 flex items-center justify-center shadow-lg">
              <div className="w-6 h-6 bg-white rounded-sm" />
            </button>
          ) : (
            <button onClick={startRecording} className="w-16 h-16 rounded-full border-4 border-red-500 bg-red-500/20 flex items-center justify-center active:bg-red-500/40 transition-colors">
              <Video size={28} className="text-white" />
            </button>
          )
        )}
      </div>
    </div>
  );
}
