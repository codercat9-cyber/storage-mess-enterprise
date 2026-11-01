import { Routes, Route, Navigate } from 'react-router-dom';
import { useEffect, useState, lazy, Suspense } from 'react';
import { useAuthStore } from '@/store/auth';
import { useThemeStore, applyRemoteSettings } from '@/store/theme';
import { useContactOverrides } from '@/store/contactOverrides';
import { initDesktopDownloads } from '@/store/fileDownloads';
import { initSocket, disconnectSocket } from '@/lib/socket';
import { resolveServerUrl } from '@/lib/connection';
import { updateApiBaseUrl, authApi, userApi } from '@/lib/api';
import { initE2EE, publishKeys, clearE2EEData } from '@/lib/e2ee';
import { initP2PSignaling, disconnectAll as disconnectAllP2P } from '@/lib/p2p';
import { initCapacitorBridge } from '@/lib/capacitor-bridge';
import { setSoundEnabled, setNotificationsEnabled } from '@/lib/notifications';
import { loadQueue } from '@/lib/offline-queue';
import { startEnterprise } from '@/lib/enterprise';

/** Загрузить профиль с сервера и обновить локальный кэш */
function syncProfileFromServer() {
  authApi.me().then(res => {
    const serverUser = res.data?.user || res.data;
    if (serverUser && serverUser.id) {
      useAuthStore.getState().updateUser(serverUser);
    }
  }).catch(() => {/* оффлайн — используем кэш */});
}

/**
 * Сверить свои подписи и аватарки контактов с сервером — в обе стороны.
 *
 * Раньше эта функция писала прямо в localStorage. Значения туда ложились,
 * но список чатов уже был отрисован и о них не узнавал: получалось, что на
 * новом устройстве своих аватарок «нет», пока не перезайдёшь. Теперь этим
 * занимается стор — он и перерисовку вызовет, и недостающее на сервере
 * дольёт со своего устройства.
 */
function syncContactOverridesFromServer() {
  useContactOverrides.getState().sync().catch(() => {});
}

/** Загрузить звуковые настройки с сервера */
function syncSoundSettingsFromServer() {
  userApi.getSettings().then(res => {
    const s = res.data?.settings;
    if (s) {
      setSoundEnabled(s.sound_enabled ?? true);
      setNotificationsEnabled(s.notifications_enabled ?? true);

      // Настройки оформления применяет applyRemoteSettings — она
      // отбросит серверную копию, если локальный выбор новее.
      // Раньше здесь безусловно перетиралась тема из localStorage,
      // из-за чего свежий выбор пользователя откатывался при запуске.
      applyRemoteSettings(s.settings_json);
    }
  }).catch(() => {/* оффлайн — используем локальные настройки */});
}

// Страницы — lazy loading
const LoginPage = lazy(() => import('@/pages/LoginPage'));
const QrLoginPage = lazy(() => import('@/pages/QrLoginPage'));
const RegisterPage = lazy(() => import('@/pages/RegisterPage'));
const RecoveryPage = lazy(() => import('@/pages/RecoveryPage'));
const TermsPage = lazy(() => import('@/pages/TermsPage'));
const ResetByTokenPage = lazy(() => import('@/pages/ResetByTokenPage'));
const ChatPage = lazy(() => import('@/pages/ChatPage'));
const SettingsPage = lazy(() => import('@/pages/SettingsPage'));
const AdminPage = lazy(() => import('@/pages/AdminPage'));

// Компоненты
const DebugConsole = lazy(() => import('@/components/DebugConsole'));
import NetworkAlert from '@/components/NetworkAlert';
import PWAManager from '@/components/PWAManager';
import ErrorBoundary from '@/components/ErrorBoundary';
import TermsGate from '@/components/TermsGate';
import DownloadsPanel from '@/components/DownloadsPanel';
import GlobalMediaPlayer from '@/components/GlobalMediaPlayer';
import ShareModal from '@/components/ShareModal';

// Fallback для Suspense
const PageFallback = () => (
  <div className="flex items-center justify-center h-screen w-screen bg-[#0a0a1a]">
    <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
  </div>
);

// Компонент для защищённых роутов
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

// Компонент для публичных роутов (редирект если авторизован)
function PublicRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  if (isAuthenticated) return <Navigate to="/" replace />;
  return <>{children}</>;
}

import { useNavigate } from 'react-router-dom';

// Компонент-обработчик нативных интентов из Android APK
function NativeEventRouter() {
  const navigate = useNavigate();

  useEffect(() => {
    const onOpenChat = (e: any) => {
      const { chatId } = e.detail;
      if (chatId) {
        navigate(`/chat/${chatId}`);
      }
    };
    
    // При "Ответить" на звонок из шторки - мы тоже переходим в чат
    // Если звонок активен, UI чата сам покажет экран звонка
    const onAnswerCall = (e: any) => {
      const { chatId } = e.detail;
      if (chatId) {
        navigate(`/chat/${chatId}`);
      }
    };

    window.addEventListener('native-open-chat', onOpenChat);
    window.addEventListener('native-answer-call', onAnswerCall);
    window.addEventListener('native-accept-call', onAnswerCall); // Legacy alias

    return () => {
      window.removeEventListener('native-open-chat', onOpenChat);
      window.removeEventListener('native-answer-call', onAnswerCall);
      window.removeEventListener('native-accept-call', onAnswerCall);
    };
  }, [navigate]);

  return null;
}

export default function App() {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const theme = useThemeStore((state) => state.theme);

  useEffect(() => {
    useThemeStore.getState().setTheme(theme);
  }, [theme]);

  // Initialize Capacitor bridge if running inside native app
  useEffect(() => {
    initCapacitorBridge();
    // Ход скачивания из оболочки настольного приложения. В браузере
    // подписываться не на что — там качает сам браузер, и функция
    // молча ничего не делает.
    initDesktopDownloads();
    // Корпоративный контур: сертификат устройства и список отзыва УЦ.
    // На обычном сервере — один запрос /enterprise/info и тишина.
    startEnterprise();
  }, []);

  // Keyboard.resize: 'native' в Capacitor сам ресайзит WebView.
  // Никакого ручного viewport-хака не нужно — он только ломает вещи.
  // Только сбрасываем нежелательный scroll при фокусе на input.
  useEffect(() => {
    const preventWindowScroll = () => {
      // Не сбрасываем скролл если активен input/contentEditable —
      // иначе WebView не сможет прокрутить к месту ввода
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.getAttribute('contenteditable'))) {
        return;
      }
      if (window.scrollY > 0) {
        window.scrollTo(0, 0);
      }
    };
    window.addEventListener('scroll', preventWindowScroll, { passive: true });
    return () => window.removeEventListener('scroll', preventWindowScroll);
  }, []);

  useEffect(() => {
    // resolveServerUrl работает в фоне, мы не ждём его для рендера UI
    resolveServerUrl().then(() => {
      updateApiBaseUrl();
    }).catch(() => {
      console.warn('Failed to resolve server url initially');
      // Всё равно объявляем адрес — иначе запросы будут ждать его до
      // упора. Пусть уйдут по тому, что есть: хуже не станет.
      updateApiBaseUrl();
    });
  }, []);

  useEffect(() => {
    let onRecovered: (() => void) | null = null;
    if (isAuthenticated) {
      initSocket();
      // Загружаем офлайн-очередь сообщений из IndexedDB
      loadQueue().catch(() => {});
      // Синхронизируем профиль с сервером (обновляем avatar_url и прочие данные)
      syncProfileFromServer();
      // Загружаем contact overrides (локальные ники/аватары) с сервера
      syncContactOverridesFromServer();
      // Синхронизируем настройки звуков
      syncSoundSettingsFromServer();
      const token = useAuthStore.getState().accessToken;
      if (token) {
        initE2EE().then(() => publishKeys(token)).then(() => setTimeout(() => initP2PSignaling(), 500)).catch(err => {});
      }
      onRecovered = () => {
        disconnectSocket();
        initSocket();
        syncProfileFromServer();
        const t = useAuthStore.getState().accessToken;
        if (t) publishKeys(t).catch(() => {});
      };
      window.addEventListener('server-recovered', onRecovered);
    } else {
      disconnectAllP2P();
      disconnectSocket();
    }
    return () => {
      if (onRecovered) window.removeEventListener('server-recovered', onRecovered);
      disconnectAllP2P();
      disconnectSocket();
    };
  }, [isAuthenticated]);

  return (
    <div className="flex flex-col h-full overflow-hidden bg-messenger-bg">
      <NativeEventRouter />
      <TermsGate />
      <ErrorBoundary where="основное окно">
      <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route path="/login" element={<PublicRoute><LoginPage /></PublicRoute>} />
          <Route path="/terms" element={<TermsPage />} />
          <Route path="/privacy" element={<TermsPage />} />
          <Route path="/qr-login" element={<PublicRoute><QrLoginPage /></PublicRoute>} />
          <Route path="/register" element={<PublicRoute><RegisterPage /></PublicRoute>} />
          <Route path="/recover" element={<PublicRoute><RecoveryPage /></PublicRoute>} />
          <Route path="/reset-password" element={<PublicRoute><ResetByTokenPage /></PublicRoute>} />
          <Route path="/" element={<ProtectedRoute><ChatPage /></ProtectedRoute>} />
          <Route path="/admin" element={<ProtectedRoute><AdminPage /></ProtectedRoute>} />
          <Route path="/chat/:chatId" element={<ProtectedRoute><ChatPage /></ProtectedRoute>} />
          <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      </ErrorBoundary>
      <NetworkAlert />
      <PWAManager />
      {/*
        Плеер под отдельной ловушкой, и это не перестраховка.
        Он общий: включаешь музыку или видео в любом чате — рисуется он.
        Пока ловушки не было, любая его ошибка снимала всё дерево React
        разом, и мессенджер гас в белый экран целиком.
      */}
      <ErrorBoundary where="проигрыватель">
        <GlobalMediaPlayer />
      </ErrorBoundary>
      <DownloadsPanel />
      <ShareModal />
      <Suspense fallback={null}><DebugConsole /></Suspense>
    </div>
  );
}
