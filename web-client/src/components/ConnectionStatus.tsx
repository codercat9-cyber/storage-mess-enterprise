// =============================================================
// ConnectionStatus — компактный индикатор состояния соединения
//
// Показывает только статус сети (переподключение / офлайн).
// Сообщения в очереди отображаются прямо в чате с часиками — 
// баннер "N в очереди" убран.
// =============================================================

import { useState, useEffect } from 'react';
import { WifiOff, Loader2 } from 'lucide-react';
import { onNetworkStateChange, NetworkStatus } from '@/lib/connection';
import { isSocketConnected } from '@/lib/socket';

export default function ConnectionStatus() {
  const [netStatus, setNetStatus] = useState<NetworkStatus>('connected');
  const [socketOk, setSocketOk] = useState(true);
  const [online, setOnline] = useState(navigator.onLine);

  // Подписка на сетевой статус
  useEffect(() => {
    return onNetworkStateChange((state) => {
      setNetStatus(state.status);
    });
  }, []);

  // Проверяем сокет каждые 3 сек
  useEffect(() => {
    const check = () => setSocketOk(isSocketConnected());
    check();
    const interval = setInterval(check, 3000);
    return () => clearInterval(interval);
  }, []);

  // navigator.onLine
  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  const isOffline = !online;
  const isReconnecting = netStatus === 'reconnecting' || (!socketOk && online);

  // Всё хорошо — ничего не показываем
  if (!isOffline && !isReconnecting) return null;

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
      {isOffline ? (
        <div className="flex items-center gap-1.5 text-red-400 bg-red-950/60 rounded-full px-2.5 py-1">
          <WifiOff className="w-3 h-3" />
          <span>Нет сети</span>
        </div>
      ) : isReconnecting ? (
        <div className="flex items-center gap-1.5 text-yellow-400 bg-yellow-950/60 rounded-full px-2.5 py-1">
          <Loader2 className="w-3 h-3 animate-spin" />
          <span>Переподключение...</span>
        </div>
      ) : null}
    </div>
  );
}
