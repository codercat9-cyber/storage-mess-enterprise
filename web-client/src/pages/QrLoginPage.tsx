import { useEffect, useState, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, RefreshCw, AlertCircle } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store/auth';

export default function QrLoginPage() {
  const [qrToken, setQrToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const pollingRef = useRef<number | null>(null);

  const initQrSession = async () => {
    try {
      setError(null);
      const res = await api.post('/auth/qr/init');
      setQrToken(res.data.token);
    } catch (err) {
      console.error('Failed to init QR session', err);
      setError('Не удалось создать QR-код. Попробуйте еще раз.');
    }
  };

  useEffect(() => {
    initQrSession();
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, []);

  useEffect(() => {
    if (!qrToken) return;

    pollingRef.current = window.setInterval(async () => {
      try {
        const res = await api.get(`/auth/qr/status?token=${qrToken}&_t=${Date.now()}`);
        if (res.data.status === 'approved') {
          if (pollingRef.current) clearInterval(pollingRef.current);
          const { accessToken, refreshToken, userId } = res.data.data;
          
          // Получаем профиль пользователя
          const meRes = await api.get('/auth/me', {
            headers: { Authorization: `Bearer ${accessToken}` }
          });
          
          // Сохраняем в store
          useAuthStore.getState().login(
            meRes.data.user,
            accessToken,
            refreshToken
          );
          
          // Переходим в чаты
          navigate('/');
        }
      } catch (err: any) {
        console.error('QR Login polling error:', err);
        if (err.response?.status === 404) {
          // Токен протух
          if (pollingRef.current) clearInterval(pollingRef.current);
          setError('Время ожидания истекло. Обновите QR-код.');
          setQrToken(null);
        }
      }
    }, 2000);

    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [qrToken, navigate]);

  return (
    <div className="h-full flex flex-col items-center justify-center p-4 bg-messenger-bg">
      <div className="w-full max-w-sm">
        <Link to="/login" className="inline-flex items-center gap-2 text-messenger-muted hover:text-white transition-colors mb-8">
          <ArrowLeft size={20} />
          <span>Назад к логину</span>
        </Link>

        <div className="text-center mb-8 animate-fadeIn">
          <h1 className="text-3xl font-medium text-messenger-text mb-2">Вход по QR-коду</h1>
          <p className="text-messenger-muted text-[16px]">Отсканируйте код с помощью мобильного приложения Storage&Mess, чтобы войти.</p>
        </div>

        <div className="bg-white p-6 rounded-2xl shadow-xl flex flex-col items-center justify-center animate-slideUp relative min-h-[300px]">
          {error ? (
            <div className="flex flex-col items-center text-center">
              <AlertCircle size={48} className="text-red-500 mb-4" />
              <p className="text-gray-800 font-medium mb-4">{error}</p>
              <button 
                onClick={initQrSession}
                className="px-6 py-2 bg-messenger-primary text-white rounded-lg font-medium hover:bg-messenger-primary/90 transition-colors"
              >
                Обновить код
              </button>
            </div>
          ) : qrToken ? (
            <div className="flex flex-col items-center animate-fadeIn">
              <div className="bg-white p-4 rounded-xl shadow-inner border border-gray-100 mb-4">
                <QRCodeSVG 
                  value={qrToken} 
                  size={200}
                  level="M"
                  includeMargin={false}
                  imageSettings={{
                    src: '/icons/icon-192x192.png',
                    x: undefined,
                    y: undefined,
                    height: 40,
                    width: 40,
                    excavate: true,
                  }}
                />
              </div>
              <p className="text-gray-500 text-sm font-medium animate-pulse">Ожидание сканирования...</p>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center">
              <RefreshCw size={40} className="text-gray-400 animate-spin mb-4" />
              <p className="text-gray-500 font-medium">Генерация кода...</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
