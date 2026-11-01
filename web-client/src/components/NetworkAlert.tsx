import { useState, useEffect } from 'react';
import {
  NetworkStatus,
  onNetworkStateChange,
} from '@/lib/connection';
import { WifiOff, Loader2 } from 'lucide-react';

// NetworkAlert — уведомление о проблемах с подключением (визуальное)

export default function NetworkAlert() {
  const [status, setStatus] = useState<NetworkStatus>('connected');

  useEffect(() => {
    const unsub = onNetworkStateChange((state) => {
      setStatus(state.status);
    });
    return unsub;
  }, []);

  // Отключено по запросу: все сетевые статусы теперь отображаются только в Sidebar
  return null;
}
