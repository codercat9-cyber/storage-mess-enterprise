import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { User } from '@/types';
import { clearAllOfflineData } from '@/lib/offline-cache';

/** Передаём токен в Android foreground service для фоновых уведомлений */
function syncTokenToAndroid(token: string | null) {
  try {
    const bridge = (window as any).AndroidBridge;
    console.log('[AUTH] syncTokenToAndroid called, bridge=' + !!bridge + ', token=' + (token ? 'yes(' + token.substring(0, 10) + '...)' : 'null'));
    if (!bridge) return;
    if (token) {
      bridge.saveAuthToken?.(token);
      console.log('[AUTH] saveAuthToken CALLED on AndroidBridge');
    } else {
      bridge.clearAuthToken?.();
      console.log('[AUTH] clearAuthToken CALLED on AndroidBridge');
    }
  } catch (e) { 
    console.error('[AUTH] syncTokenToAndroid ERROR:', e);
  }
}

async function syncFcmTokenToBackend(accessToken: string | null) {
  if (!accessToken) return;
  try {
    const bridge = (window as any).AndroidBridge;
    if (bridge && bridge.getFcmToken) {
      const fcmToken = bridge.getFcmToken();
      if (fcmToken) {
        // Мы отправляем его на новый эндпоинт
        const serverUrl = localStorage.getItem('kotex-server-url') || 'https://messenger.example.org';
        await fetch(`${serverUrl}/api/users/push-token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`,
          },
          // Подписываем устройство: у человека их теперь может быть
          // несколько, и в диагностике надо понимать, чей это токен.
          body: JSON.stringify({
            token: fcmToken,
            platform: 'android',
            device_label: (() => {
              try {
                const fp = JSON.parse(localStorage.getItem('device_footprint') || '{}');
                return [fp.manufacturer, fp.model].filter(Boolean).join(' ') || navigator.userAgent.slice(0, 80);
              } catch { return navigator.userAgent.slice(0, 80); }
            })(),
          }),
        });
        console.log('[AUTH] FCM token synced to backend');
      }
    }
  } catch (e) {
    console.error('[AUTH] FCM sync failed:', e);
  }
}

// Fallback: если onRehydrate сработала слишком рано — повторяем через 3 секунды
setTimeout(() => {
  try {
    const bridge = (window as any).AndroidBridge;
    if (!bridge) return;
    // Zustand persist хранит в localStorage под ключом 'kotex-auth'
    const stored = localStorage.getItem('kotex-auth');
    if (!stored) return;
    const parsed = JSON.parse(stored);
    const token = parsed?.state?.accessToken;
    if (token) {
      console.log('[AUTH] Fallback: sending token to AndroidBridge');
      bridge.saveAuthToken(token);
    }
  } catch (e) { /* ignore */ }
}, 3000);

interface AuthState {
  user: User | null;
  accessToken: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  
  setUser: (user: User | null) => void;
  setAccessToken: (token: string | null) => void;
  setTokens: (accessToken: string, refreshToken: string) => void;
  login: (user: User, accessToken: string, refreshToken: string) => void;
  logout: () => void;
  updateUser: (updates: Partial<User>) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,

      setUser: (user) => set({ user }),
      
      setAccessToken: (accessToken) => {
        set({ accessToken });
        if (accessToken) {
          syncTokenToAndroid(accessToken);
          syncFcmTokenToBackend(accessToken);
        }
      },
      
      setTokens: (accessToken, refreshToken) => {
        set({ accessToken, refreshToken });
        syncTokenToAndroid(accessToken);
        syncFcmTokenToBackend(accessToken);
      },
      
      login: (user, accessToken, refreshToken) => {
        set({
          user,
          accessToken,
          refreshToken,
          isAuthenticated: true,
        });
        syncTokenToAndroid(accessToken);
        syncFcmTokenToBackend(accessToken);
      },
      
      logout: () => {
        set({
          user: null,
          accessToken: null,
          refreshToken: null,
          isAuthenticated: false,
        });
        syncTokenToAndroid(null);
        clearAllOfflineData().catch(() => {});
      },
      
      updateUser: (updates) => set((state) => ({
        user: state.user ? { ...state.user, ...updates } : null,
      })),
    }),
    {
      name: 'kotex-auth',
      partialize: (state) => ({
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),
      onRehydrate: () => {
        return (state) => {
          // При загрузке из localStorage — передать токен в Android сервис
          if (state?.accessToken) {
            syncTokenToAndroid(state.accessToken);
          }
        };
      },
    }
  )
);

export default useAuthStore;
