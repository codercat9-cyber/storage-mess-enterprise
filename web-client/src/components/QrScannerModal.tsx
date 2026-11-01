import React, { useEffect, useState, useRef } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { X, CheckCircle, AlertCircle } from 'lucide-react';
import { api } from '@/lib/api';

interface QrScannerModalProps {
  onClose: () => void;
}

export default function QrScannerModal({ onClose }: QrScannerModalProps) {
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const [isScanning, setIsScanning] = useState(false);

  useEffect(() => {
    let isMounted = true;
    const scanner = new Html5Qrcode('qr-reader');
    scannerRef.current = scanner;

    const startScanner = async () => {
      try {
        await scanner.start(
          { facingMode: 'environment' },
          {
            fps: 10,
            qrbox: { width: 250, height: 250 },
            aspectRatio: 1.0
          },
          async (decodedText) => {
            if (!isMounted) return;
            // Успешно считан QR
            try {
              if (scannerRef.current?.isScanning) {
                await scannerRef.current.stop();
              }
              setIsScanning(false);
              
              // Отправляем на сервер
              const res = await api.post('/auth/qr/confirm', { token: decodedText });
              if (res.data.success) {
                setSuccess(true);
                setTimeout(() => {
                  if (isMounted) onClose();
                }, 2000);
              }
            } catch (err: any) {
              console.error('QR confirm error', err);
              setError(err.response?.data?.error || 'Неверный или устаревший QR-код');
            }
          },
          (errorMessage) => {
            // Игнорируем ошибки парсинга кадра
          }
        );
        if (isMounted) setIsScanning(true);
      } catch (err) {
        console.error('Failed to start scanner', err);
        if (isMounted) setError('Не удалось запустить камеру. Проверьте разрешения.');
      }
    };

    startScanner();

    return () => {
      isMounted = false;
      if (scannerRef.current?.isScanning) {
        scannerRef.current.stop().catch(console.error);
      }
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-4">
      <div className="bg-messenger-bg border border-messenger-border rounded-2xl w-full max-w-md overflow-hidden relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-10 w-8 h-8 rounded-full bg-black/50 text-white flex items-center justify-center hover:bg-black/80 transition-colors"
        >
          <X size={20} />
        </button>
        
        <div className="p-6 text-center border-b border-messenger-border/50">
          <h2 className="text-xl font-medium text-white mb-2">Авторизация на ПК</h2>
          <p className="text-messenger-muted text-sm">Наведите камеру на QR-код на экране компьютера</p>
        </div>

        <div className="relative bg-black min-h-[300px] flex items-center justify-center">
          {success ? (
            <div className="absolute inset-0 bg-green-500/20 flex flex-col items-center justify-center animate-fadeIn">
              <CheckCircle size={64} className="text-green-500 mb-4" />
              <p className="text-white font-medium text-lg">Успешный вход!</p>
            </div>
          ) : error ? (
            <div className="absolute inset-0 bg-red-500/10 flex flex-col items-center justify-center p-6 text-center animate-fadeIn">
              <AlertCircle size={48} className="text-red-500 mb-4" />
              <p className="text-white font-medium mb-4">{error}</p>
              <button
                onClick={onClose}
                className="px-6 py-2 bg-messenger-primary text-white rounded-lg hover:bg-messenger-primary/90"
              >
                Закрыть
              </button>
            </div>
          ) : (
            <div id="qr-reader" className="w-full h-full" />
          )}
        </div>
      </div>
    </div>
  );
}
