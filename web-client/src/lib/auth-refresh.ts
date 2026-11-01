// =============================================================
// Обновление токена доступа — одно на всё приложение.
//
// Раньше его делали двое независимо: перехватчик axios и сокет. У сокета
// была «защита» от повтора — если обновление уже шло, второй вызов сразу
// отвечал «не удалось», и сокет по этому ответу разлогинивал. На медленной
// сети сокет переподключается чаще, чем отвечает сервер, — и человека
// выкидывало на ровном месте. Плюс любой сбой обновления, кроме «нет
// сети», считался концом сессии: перезапуск сервера, обрыв от DPI, 5xx.
// А пароль многие уже не помнят.
//
// Теперь: все ждут одно и то же обновление, а выходом кончается только
// прямой ответ сервера 401 — «такой сессии больше нет».
// =============================================================

import axios from 'axios';
import { useAuthStore } from '@/store/auth';

/** ok — новый токен получен; rejected — сервер сказал «сессии нет»;
 *  failed — не достучались или сбой, сессию НЕ трогаем. */
export type RefreshResult = 'ok' | 'rejected' | 'failed';

let inflight: Promise<RefreshResult> | null = null;

export function refreshAccessToken(apiUrl: string): Promise<RefreshResult> {
  if (inflight) return inflight;
  inflight = (async (): Promise<RefreshResult> => {
    const refreshToken = useAuthStore.getState().refreshToken;
    if (!refreshToken) return 'failed';
    try {
      const response = await axios.post(`${apiUrl}/auth/refresh`, { refreshToken }, { timeout: 20000 });
      const accessToken = response.data?.accessToken;
      if (!accessToken) return 'failed';
      // Сервер может выдать и новый токен обновления (смена секрета подписи)
      const rotated = response.data?.refreshToken;
      if (rotated) useAuthStore.getState().setTokens(accessToken, rotated);
      else useAuthStore.getState().setAccessToken(accessToken);
      return 'ok';
    } catch (err) {
      const status = (err as any)?.response?.status;
      console.warn('🔐 Token refresh error:', status ?? (err as any)?.code ?? err);
      return status === 401 ? 'rejected' : 'failed';
    }
  })().finally(() => { inflight = null; });
  return inflight;
}
