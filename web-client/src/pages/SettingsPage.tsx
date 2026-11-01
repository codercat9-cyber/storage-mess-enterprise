import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { getDownloads, detectPlatform, platformName, hasNativeBuild, fetchVersions } from '@/lib/downloads';
import CompanionApps from '@/components/CompanionApps';
import { useAuthStore } from '@/store/auth';
import { useThemeStore, THEMES, ThemeId, CustomThemeVars, DEFAULT_GRADIENT, FONT_SIZE_MIN, FONT_SIZE_MAX, FONT_FAMILIES, FONT_GROUPS, FontFamilyId, FontGroupId, UI_SCALE_MIN, UI_SCALE_MAX } from '@/store/theme';
import { WALLPAPERS, getWallpaperCSS } from '@/lib/wallpapers';
import { api, userApi, authApi, fileApi } from '@/lib/api';
import { UserSettings } from '@/types';
import { setSoundEnabled, setNotificationsEnabled, setCustomMessageSound, setCustomRingtone, getCustomMessageSoundName, getCustomRingtoneName, hasCustomMessageSound, hasCustomRingtone, previewMessageSound, previewRingtone } from '@/lib/notifications';
import { getCustomServerUrlValue, setCustomServerUrl, getBaseUrl, resetConnection } from '@/lib/connection';
import { getPendingCount, flushQueue } from '@/lib/offline-queue';
import { useChatStore } from '@/store/chat';
import { isE2EEEnabled, setE2EEEnabled, getDeviceId, initE2EE, publishKeys } from '@/lib/e2ee';
import { ArrowLeft, User, Bell, Globe, LogOut, Loader2, Camera, Trash2, Pencil, AlertTriangle, Palette, ChevronDown, ChevronUp, ChevronRight, Shield, Copy, Check, ImagePlus, X, Radio, Music, Volume2, RotateCcw, Wifi, Send, Server, Lock, Bug, Mail, Download } from 'lucide-react';
import LoraPanel from '@/components/LoraPanel';
import LanServerPicker from '@/components/LanServerPicker';

export default function SettingsPage() {
  // Версии сборок для раздела загрузок — телефонная и настольная нумеруются
  // независимо, без подписи непонятно, что именно скачиваешь.
  const [dlVersions, setDlVersions] = useState<Record<string, string>>({});
  useEffect(() => { fetchVersions().then(setDlVersions).catch(() => {}); }, []);

  const user = useAuthStore((state) => state.user);
  const setUser = useAuthStore((state) => state.setUser);
  const logout = useAuthStore((state) => state.logout);
  const refreshToken = useAuthStore((state) => state.refreshToken);
  const { theme: currentTheme, setTheme, customVars, setCustomVar, wallpaper: currentWallpaper, setWallpaper, customGradient, setCustomGradient, customImage, setCustomImage, imageOpacity, setImageOpacity, resolvedTheme, fontSize, fontFamily, setFontSize, setFontFamily, uiScale, setUiScale, forceTcpRelay, setForceTcpRelay } = useThemeStore();
  const [showCustomEditor, setShowCustomEditor] = useState(false);
  const [showGradientEditor, setShowGradientEditor] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingName, setEditingName] = useState(false);
  const [displayName, setDisplayName] = useState(user?.display_name || '');
  const [savingName, setSavingName] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [generatingKey, setGeneratingKey] = useState(false);
  const [keyCopied, setKeyCopied] = useState(false);
  const [meshActive, setMeshActive] = useState(false);
  const [meshPeerCount, setMeshPeerCount] = useState(0);
  const [meshDeviceId, setMeshDeviceId] = useState('');

  // Password change
  const [showPasswordChange, setShowPasswordChange] = useState(false);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const msgSoundInputRef = useRef<HTMLInputElement>(null);
  const ringtoneSoundInputRef = useRef<HTMLInputElement>(null);
  const [customMsgSoundName, setCustomMsgSoundName] = useState(getCustomMessageSoundName());
  const [customRingtoneName, setCustomRingtoneName] = useState(getCustomRingtoneName());
  const isDarkForWp = resolvedTheme === 'dark';

  // Network / VPN settings
  const [customServerUrl, setCustomServerUrlState] = useState(getCustomServerUrlValue());
  const [serverUrlSaved, setServerUrlSaved] = useState(false);
  const [currentServerUrl, setCurrentServerUrl] = useState(getBaseUrl());
  const [pendingMsgCount, setPendingMsgCount] = useState(getPendingCount());
  const [flushingQueue, setFlushingQueue] = useState(false);

  // Email Bridge settings
  const [emailBridgeEmail, setEmailBridgeEmail] = useState('');
  const [emailBridgePassword, setEmailBridgePassword] = useState('');
  const [emailBridgeHasPassword, setEmailBridgeHasPassword] = useState(false);
  const [emailBridgeEnabled, setEmailBridgeEnabled] = useState(false);
  const [emailBridgeSaving, setEmailBridgeSaving] = useState(false);
  const [emailBridgeSaved, setEmailBridgeSaved] = useState(false);

  useEffect(() => {
    async function loadSettings() {
      try {
        const response = await userApi.getSettings();
        const s = response.data.settings;
        setSettings(s);
        // Синхронизируем звуковые настройки с notification service
        if (s) {
          setSoundEnabled(s.sound_enabled ?? true);
          setNotificationsEnabled(s.notifications_enabled ?? true);
        }
      } catch (error) {
        console.error('Failed to load settings:', error);
      } finally {
        setLoading(false);
      }
    }

    loadSettings();

    // Load email bridge settings
    authApi.getEmailBridgeSettings().then(res => {
      setEmailBridgeEmail(res.data.email || '');
      setEmailBridgeEnabled(res.data.enabled || false);
      setEmailBridgeHasPassword(res.data.hasPassword || false);
    }).catch(() => {});
  }, []);

  // BLE Mesh state polling (Capacitor plugin, Web Bluetooth API, или legacy AndroidBridge)
  const [isNativePlatform, setIsNativePlatform] = useState(false);
  const [hasBluetooth, setHasBluetooth] = useState(false);

  // Service notification & battery optimization
  const [serviceNotifHidden, setServiceNotifHidden] = useState(false);
  const [batteryOptExempt, setBatteryOptExempt] = useState(false);
  // Web Bluetooth mesh state (для десктопа/ноута)
  const [webBleMeshState, setWebBleMeshState] = useState<{
    server: any;
    device: any;
    peers: Set<string>;
  }>({ server: null, device: null, peers: new Set() });


  useEffect(() => {
    // Проверяем наличие Bluetooth на устройстве (Web Bluetooth API)
    if (typeof navigator !== 'undefined' && 'bluetooth' in navigator) {
      setHasBluetooth(true);
    }
  }, []);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;

    async function initMeshPolling() {
      // Try Capacitor plugin first
      try {
        const Capacitor = (window as any).Capacitor;
        if (Capacitor && Capacitor.isNativePlatform()) {
          setIsNativePlatform(true);
          setHasBluetooth(true);
          const BleMesh = Capacitor.Plugins?.BleMesh;
          if (BleMesh) {
            const status = await BleMesh.isMeshActive();
            setMeshActive(status.active);
            if (status.active) {
              const id = await BleMesh.getMeshDeviceId();
              setMeshDeviceId(id.deviceId || '');
            }
            interval = setInterval(async () => {
              try {
                // Poll only for peer count and device id if active, trust React state for toggle
                if (meshActive) {
                  const c = await BleMesh.getMeshPeerCount();
                  setMeshPeerCount(c.count || 0);
                }
              } catch {}
            }, 3000);
            return;
          }
        }
      } catch (err) { console.error('Capacitor check failed', err); }

      // Legacy AndroidBridge fallback
      const bridge = (window as any).AndroidBridge;
      if (bridge?.isMeshActive) {
        setHasBluetooth(true);
        // Initial state load only once
        setMeshActive(bridge.isMeshActive());
        setMeshDeviceId(bridge.getMeshDeviceId?.() || '');
        
        interval = setInterval(() => {
          // Poll only for peer count and device id, trust React state for active
          if (meshActive) {
             setMeshPeerCount(bridge.getMeshPeerCount?.() || 0);
             if (!meshDeviceId) {
                 setMeshDeviceId(bridge.getMeshDeviceId?.() || '');
             }
          }
        }, 3000);
        return;
      }

      // Web Bluetooth API (Chrome/Edge на ноутах/компах)
      // Поллинг не нужен — состояние управляется через toggleMesh
    }

    initMeshPolling();
    return () => { if (interval) clearInterval(interval); };
  }, []);

  // Check service notification & battery status on native
  useEffect(() => {
    const bridge = (window as any).AndroidBridge;
    if (bridge?.isServiceNotificationHidden) {
      setServiceNotifHidden(bridge.isServiceNotificationHidden());
      setBatteryOptExempt(bridge.isBatteryOptimizationExempt?.() || false);
    }
  }, []);

  // Mesh Service UUID — ДОЛЖЕН совпадать с BleMeshService.java
  const MESH_SERVICE_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  const MESH_CHAR_UUID    = 'a1b2c3d4-e5f6-7890-abcd-ef1234567891';

  const toggleMesh = async () => {
    // Try Capacitor plugin first
    try {
      const Capacitor = (window as any).Capacitor;
      if (Capacitor && Capacitor.isNativePlatform()) {
        const BleMesh = Capacitor.Plugins?.BleMesh;
        if (BleMesh) {
          if (meshActive) {
            await BleMesh.stopMeshMode();
            setMeshActive(false);
            setMeshPeerCount(0);
          } else {
            await BleMesh.startMeshMode({ userId: String(user?.id || ''), displayName: user?.display_name || '' });
            setMeshActive(true);
          }
          return;
        }
      }
    } catch (err) { console.error('Capacitor BleMesh failed', err); }

    // Legacy AndroidBridge fallback
    const bridge = (window as any).AndroidBridge;
    if (bridge?.startMeshMode) {
      if (meshActive) {
        bridge.stopMeshMode();
        setMeshActive(false);
        setMeshPeerCount(0);
      } else {
        bridge.startMeshMode(String(user?.id || ''), user?.display_name || '');
        setMeshActive(true);
      }
      return;
    }

    // === Web Bluetooth API (Chrome/Edge на ноутах/компах) ===
    if (!(navigator as any).bluetooth) return;

    if (meshActive) {
      // Отключаемся
      try {
        webBleMeshState.device?.gatt?.disconnect();
      } catch {}
      setWebBleMeshState({ server: null, device: null, peers: new Set() });
      setMeshActive(false);
      setMeshPeerCount(0);
      setMeshDeviceId('');
      return;
    }

    // Включаем — сканируем BLE устройства
    try {
      const device = await (navigator as any).bluetooth.requestDevice({
        filters: [{ services: [MESH_SERVICE_UUID] }],
        optionalServices: [MESH_SERVICE_UUID],
      });

      if (!device.gatt) throw new Error('GATT not available');

      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(MESH_SERVICE_UUID);
      const characteristic = await service.getCharacteristic(MESH_CHAR_UUID);

      // Подписываемся на уведомления (входящие mesh-сообщения)
      await characteristic.startNotifications();
      characteristic.addEventListener('characteristicvaluechanged', (event: any) => {
        const value = event.target.value;
        const decoder = new TextDecoder();
        const message = decoder.decode(value);
        try {
          const data = JSON.parse(message);
          window.dispatchEvent(new CustomEvent('mesh-message', { detail: data }));
        } catch {
          console.log('[Web BLE Mesh] Raw message:', message);
        }
      });

      // Слушаем отключение
      device.addEventListener('gattserverdisconnected', () => {
        setMeshActive(false);
        setMeshPeerCount(0);
        setMeshDeviceId('');
        setWebBleMeshState({ server: null, device: null, peers: new Set() });
      });

      setWebBleMeshState({ server, device, peers: new Set([device.id]) });
      setMeshActive(true);
      setMeshPeerCount(1);
      setMeshDeviceId(device.id || device.name || 'web-ble');
    } catch (err: any) {
      // Пользователь отменил выбор устройства или ошибка BLE
      if (err.name !== 'NotFoundError') {
        console.error('[Web BLE Mesh] Error:', err);
      }
    }
  };

  const handleLogout = async () => {
    try {
      if (refreshToken) {
        await authApi.logout(refreshToken);
      }
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      logout();
      navigate('/login');
    }
  };

  const updateSetting = async (key: keyof UserSettings, value: any) => {
    try {
      await userApi.updateSettings({ [key]: value });
      setSettings(prev => prev ? { ...prev, [key]: value } : null);
      // Синхронизация с notification service
      if (key === 'sound_enabled') setSoundEnabled(!!value);
      if (key === 'notifications_enabled') setNotificationsEnabled(!!value);
    } catch (error) {
      console.error('Failed to update setting:', error);
    }
  };

  const handleSaveName = async () => {
    if (!displayName.trim()) return;
    setSavingName(true);
    try {
      const response = await userApi.updateProfile({ display_name: displayName.trim() });
      if (response.data.user) {
        useAuthStore.getState().setUser(response.data.user);
      }
      setEditingName(false);
    } catch (error) {
      console.error('Failed to update name:', error);
    } finally {
      setSavingName(false);
    }
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    if (!file.type.startsWith('image/')) {
      alert('Выберите изображение');
      return;
    }
    
    setUploadingAvatar(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const { data } = await api.post('/files/avatar', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      
      const avatarUrl = data.avatarUrl + '?t=' + Date.now();
      
      const profileResponse = await userApi.updateProfile({ avatar_url: avatarUrl });
      if (profileResponse.data.user) {
        useAuthStore.getState().setUser(profileResponse.data.user);
      }
    } catch (error) {
      console.error('Failed to upload avatar:', error);
    } finally {
      setUploadingAvatar(false);
      if (avatarInputRef.current) avatarInputRef.current.value = '';
    }
  };

  const handleDeleteAccount = async () => {
    if (deleteConfirmText !== 'УДАЛИТЬ') return;
    setDeletingAccount(true);
    try {
      await userApi.deleteAccount();
      logout();
      navigate('/login');
    } catch (error) {
      console.error('Failed to delete account:', error);
      alert('Ошибка при удалении аккаунта');
    } finally {
      setDeletingAccount(false);
    }
  };

  const handleChangePassword = async () => {
    setPasswordError('');
    setPasswordSuccess(false);

    if (!oldPassword || !newPassword) {
      setPasswordError('Заполните все поля');
      return;
    }
    if (newPassword.length < 6) {
      setPasswordError('Новый пароль — минимум 6 символов');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('Пароли не совпадают');
      return;
    }

    setChangingPassword(true);
    try {
      await authApi.changePassword({ old_password: oldPassword, new_password: newPassword });
      setPasswordSuccess(true);
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setTimeout(() => { setPasswordSuccess(false); setShowPasswordChange(false); }, 2000);
    } catch (error: any) {
      const msg = error?.response?.data?.error;
      setPasswordError(msg === 'Invalid current password' ? 'Неверный текущий пароль' : (msg || 'Ошибка при смене пароля'));
    } finally {
      setChangingPassword(false);
    }
  };

  const handleGetRecoveryKey = async () => {
    setGeneratingKey(true);
    try {
      const res = await userApi.regenerateRecoveryKey();
      setRecoveryKey(res.data.recoveryKey);
      setKeyCopied(false);
    } catch (error) {
      console.error('Failed to generate recovery key:', error);
      alert('Ошибка при генерации ключа восстановления');
    } finally {
      setGeneratingKey(false);
    }
  };

  const handleCopyKey = () => {
    if (!recoveryKey) return;
    navigator.clipboard.writeText(recoveryKey);
    setKeyCopied(true);
    setTimeout(() => setKeyCopied(false), 2000);
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-messenger-bg">
        <Loader2 className="w-8 h-8 animate-spin text-primary-500" />
      </div>
    );
  }

  return (
    <div className="h-full flex-1 bg-[#f4f4f5] dark:bg-[#0f0f0f] overflow-y-auto animate-fadeIn relative flex justify-center">
      {/* Container to mimic Telegram's center column */}
      <div className="w-full max-w-[600px] bg-white dark:bg-[#212121] min-h-full flex flex-col shadow-sm">
        
        {/* Header */}
        <div className="h-14 flex items-center px-2 sticky top-0 bg-white/90 dark:bg-[#212121]/90 backdrop-blur-md z-10 border-b border-messenger-border shadow-sm shrink-0">
          <button
            onClick={() => navigate('/')}
            className="p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
          >
            <ArrowLeft className="w-6 h-6 text-messenger-text" />
          </button>
          <h1 className="text-[19px] font-medium text-messenger-text ml-4">Настройки</h1>
        </div>

        <div className="flex-1 overflow-y-auto pb-10">
          {/* Профиль */}
          <div className="flex flex-col items-center pt-8 pb-6 px-4 border-b border-messenger-border/50 bg-white dark:bg-[#212121]">
            <div className="relative group mb-4">
              {user?.avatar_url ? (
                <img 
                  src={user.avatar_url} 
                  alt="Avatar" 
                  className="w-28 h-28 rounded-full object-cover shadow-md"
                />
              ) : (
                <div className="w-28 h-28 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center text-4xl text-white font-medium shadow-md">
                  {user?.display_name?.[0] || user?.username?.[0] || '?'}
                </div>
              )}
              <button
                onClick={() => avatarInputRef.current?.click()}
                disabled={uploadingAvatar}
                className="absolute inset-0 flex items-center justify-center bg-black/40 rounded-full opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer backdrop-blur-[2px]"
              >
                {uploadingAvatar ? (
                  <Loader2 className="w-8 h-8 text-white animate-spin" />
                ) : (
                  <Camera className="w-8 h-8 text-white" />
                )}
              </button>
              <input ref={avatarInputRef} type="file" accept="image/*" onChange={handleAvatarUpload} className="hidden" />
            </div>

            {editingName ? (
              <div className="flex items-center gap-2 w-full max-w-xs">
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="w-full bg-transparent border-b-2 border-primary-500 focus:outline-none text-center text-lg text-messenger-text py-1"
                  placeholder="Имя"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveName();
                    if (e.key === 'Escape') setEditingName(false);
                  }}
                />
                <button onClick={handleSaveName} disabled={savingName || !displayName.trim()} className="text-primary-500 font-medium px-2 hover:bg-primary-500/10 rounded">
                  {savingName ? <Loader2 className="w-5 h-5 animate-spin" /> : 'ОК'}
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2 group/name cursor-pointer rounded-lg px-3 py-1 hover:bg-black/5 dark:hover:bg-white/5 transition-colors" onClick={() => { setDisplayName(user?.display_name || ''); setEditingName(true); }}>
                <p className="text-xl font-medium text-messenger-text">{user?.display_name || user?.username}</p>
                <Pencil className="w-4 h-4 text-messenger-muted opacity-0 group-hover/name:opacity-100 transition-opacity" />
              </div>
            )}
            <p className="text-[15px] text-messenger-muted mt-1">@{user?.username}</p>
          </div>

          <div className="h-2 bg-[#f4f4f5] dark:bg-[#0f0f0f] border-y border-messenger-border/50 w-full" />

          {/* Уведомления */}
          <div className="py-2 bg-white dark:bg-[#212121]">
            <div className="px-5 py-2 flex items-center gap-4 text-messenger-accent font-medium text-[15px]">
              <Bell className="w-5 h-5" /> Уведомления и звук
            </div>
            <label className="flex items-center justify-between px-5 py-3 hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer transition-colors">
              <div className="flex flex-col">
                <span className="text-[16px] text-messenger-text">Push-уведомления</span>
                <span className="text-[13px] text-messenger-muted mt-0.5">Показывать уведомления о сообщениях</span>
              </div>
              <input
                type="checkbox"
                checked={settings?.notifications_enabled ?? true}
                onChange={(e) => updateSetting('notifications_enabled', e.target.checked)}
                className="w-10 h-5 bg-messenger-border rounded-full appearance-none relative checked:bg-primary-500 transition-colors cursor-pointer before:content-[''] before:absolute before:w-4 before:h-4 before:bg-white before:rounded-full before:top-0.5 before:left-0.5 checked:before:translate-x-5 before:transition-transform before:shadow-sm"
              />
            </label>
            <label className="flex items-center justify-between px-5 py-3 hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer transition-colors">
              <div className="flex flex-col">
                <span className="text-[16px] text-messenger-text">Звук</span>
                <span className="text-[13px] text-messenger-muted mt-0.5">Воспроизводить звук при получении</span>
              </div>
              <input
                type="checkbox"
                checked={settings?.sound_enabled ?? true}
                onChange={(e) => updateSetting('sound_enabled', e.target.checked)}
                className="w-10 h-5 bg-messenger-border rounded-full appearance-none relative checked:bg-primary-500 transition-colors cursor-pointer before:content-[''] before:absolute before:w-4 before:h-4 before:bg-white before:rounded-full before:top-0.5 before:left-0.5 checked:before:translate-x-5 before:transition-transform before:shadow-sm"
              />
            </label>
            {/* Кастомные звуки уведомлений */}
            <div className="px-5 py-3">
              <input ref={msgSoundInputRef} type="file" accept="audio/*" className="hidden" onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => {
                  setCustomMessageSound(reader.result as string, file.name);
                  setCustomMsgSoundName(file.name);
                };
                reader.readAsDataURL(file);
                e.target.value = '';
              }} />
              <input ref={ringtoneSoundInputRef} type="file" accept="audio/*" className="hidden" onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => {
                  setCustomRingtone(reader.result as string, file.name);
                  setCustomRingtoneName(file.name);
                };
                reader.readAsDataURL(file);
                e.target.value = '';
              }} />

              <div className="flex items-center justify-between py-2">
                <div className="flex flex-col flex-1 min-w-0">
                  <span className="text-[16px] text-messenger-text">Звук сообщений</span>
                  <span className="text-[13px] text-messenger-muted mt-0.5 truncate">
                    {customMsgSoundName || 'ICQ — Uh-Oh (стандартный)'}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button onClick={() => previewMessageSound()} className="p-2 rounded-full hover:bg-messenger-hover text-messenger-muted" title="Прослушать"><Volume2 size={18} /></button>
                  <button onClick={() => msgSoundInputRef.current?.click()} className="p-2 rounded-full hover:bg-messenger-hover text-messenger-accent" title="Выбрать файл"><Music size={18} /></button>
                  {hasCustomMessageSound() && (
                    <button onClick={() => { setCustomMessageSound(null); setCustomMsgSoundName(null); }} className="p-2 rounded-full hover:bg-messenger-hover text-messenger-muted" title="Сбросить"><RotateCcw size={16} /></button>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between py-2">
                <div className="flex flex-col flex-1 min-w-0">
                  <span className="text-[16px] text-messenger-text">Звук звонков</span>
                  <span className="text-[13px] text-messenger-muted mt-0.5 truncate">
                    {customRingtoneName || 'Skype — рингтон (стандартный)'}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button onClick={() => previewRingtone()} className="p-2 rounded-full hover:bg-messenger-hover text-messenger-muted" title="Прослушать"><Volume2 size={18} /></button>
                  <button onClick={() => ringtoneSoundInputRef.current?.click()} className="p-2 rounded-full hover:bg-messenger-hover text-messenger-accent" title="Выбрать файл"><Music size={18} /></button>
                  {hasCustomRingtone() && (
                    <button onClick={() => { setCustomRingtone(null); setCustomRingtoneName(null); }} className="p-2 rounded-full hover:bg-messenger-hover text-messenger-muted" title="Сбросить"><RotateCcw size={16} /></button>
                  )}
                </div>
              </div>

              {/*
                Вибрацией на Android распоряжается сама система — через
                настройки канала уведомлений. Своего переключателя тут быть
                не может: рисунок вибрации у канала задаётся один раз при
                создании и потом не меняется, а подменять его вручную из
                приложения как раз и было той ошибкой, из-за которой телефон
                дёргался дважды на каждое сообщение и не слушался ни
                беззвучного режима, ни «Не беспокоить».
                Поэтому даём прямую дорогу туда, где это выключается.
              */}
              {(window as any).AndroidBridge?.openNotificationSettings && (
                <div className="pt-1">
                  <button
                    onClick={() => (window as any).AndroidBridge.openNotificationSettings('messages')}
                    className="w-full flex items-center justify-between py-2 text-left"
                  >
                    <div className="flex flex-col flex-1 min-w-0">
                      <span className="text-[16px] text-messenger-text">Вибрация сообщений</span>
                      <span className="text-[13px] text-messenger-muted mt-0.5">
                        Настройки Android — там же можно выключить совсем
                      </span>
                    </div>
                    <ChevronRight size={18} className="text-messenger-muted shrink-0" />
                  </button>
                  <button
                    onClick={() => (window as any).AndroidBridge.openNotificationSettings('calls')}
                    className="w-full flex items-center justify-between py-2 text-left"
                  >
                    <div className="flex flex-col flex-1 min-w-0">
                      <span className="text-[16px] text-messenger-text">Вибрация звонков</span>
                      <span className="text-[13px] text-messenger-muted mt-0.5">Настройки Android</span>
                    </div>
                    <ChevronRight size={18} className="text-messenger-muted shrink-0" />
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="h-2 bg-[#f4f4f5] dark:bg-[#0f0f0f] border-y border-messenger-border/50 w-full" />

          {/* Внешний вид */}
          <div className="py-2 bg-white dark:bg-[#212121]">
            <div className="px-5 py-2 flex items-center gap-4 text-messenger-accent font-medium text-[15px]">
              <Palette className="w-5 h-5" /> Оформление
            </div>
            
            <div className="px-5 py-3">
              <div className="flex flex-wrap gap-3">
                {THEMES.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => {
                      setTheme(t.id);
                      updateSetting('theme', t.id);
                      if (t.id === 'custom') setShowCustomEditor(true);
                    }}
                    className="flex flex-col items-center gap-2 group"
                  >
                    <div
                      className={`w-14 h-14 rounded-full shadow-md flex items-center justify-center text-xl transition-all duration-200 border-2 ${
                        currentTheme === t.id
                          ? 'border-primary-500 scale-110'
                          : 'border-transparent hover:scale-105'
                      }`}
                      style={{ background: t.preview }}
                    >
                      {t.icon}
                      {currentTheme === t.id && (
                        <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-primary-500 border-2 border-white dark:border-[#212121] flex items-center justify-center">
                          <div className="w-1.5 h-2 border-b-2 border-r-2 border-white rotate-45 -translate-y-0.5"></div>
                        </div>
                      )}
                    </div>
                    <span className={`text-[13px] ${currentTheme === t.id ? 'text-primary-500 font-medium' : 'text-messenger-muted group-hover:text-messenger-text'}`}>
                      {t.label}
                    </span>
                  </button>
                ))}
              </div>

              {/* Wallpaper Picker */}
              <div className="mt-5">
                <p className="text-[14px] font-medium text-messenger-text mb-3">Фон чата</p>
                <div className="grid grid-cols-4 sm:grid-cols-5 gap-2">
                  {WALLPAPERS.map((wp) => {
                    const isSelected = currentWallpaper === wp.id;
                    const previewStyle = getWallpaperCSS(wp.id, isDarkForWp);
                    return (
                      <button
                        key={wp.id}
                        onClick={() => setWallpaper(wp.id)}
                        className={`relative aspect-[3/4] rounded-xl overflow-hidden border-2 transition-all ${
                          isSelected ? 'border-primary-500 scale-[1.02] shadow-lg' : 'border-transparent hover:border-messenger-border'
                        }`}
                        style={previewStyle}
                      >
                        <span className="absolute inset-0 flex flex-col items-center justify-center gap-1">
                          <span className="text-2xl">{wp.emoji}</span>
                          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                            isDarkForWp ? 'bg-black/40 text-white/80' : 'bg-white/60 text-black/70'
                          }`}>{wp.name}</span>
                        </span>
                        {isSelected && (
                          <div className="absolute top-1 right-1 w-5 h-5 rounded-full bg-primary-500 flex items-center justify-center">
                            <div className="w-1.5 h-2 border-b-2 border-r-2 border-white rotate-45 -translate-y-0.5"></div>
                          </div>
                        )}
                      </button>
                    );
                  })}

                  {/* Custom gradient button */}
                  <button
                    onClick={() => { setWallpaper('custom-gradient'); setShowGradientEditor(true); }}
                    className={`relative aspect-[3/4] rounded-xl overflow-hidden border-2 transition-all ${
                      currentWallpaper === 'custom-gradient' ? 'border-primary-500 scale-[1.02] shadow-lg' : 'border-transparent hover:border-messenger-border'
                    }`}
                    style={{
                      background: `linear-gradient(${customGradient.angle}deg, ${customGradient.color1}, ${customGradient.color2})`,
                    }}
                  >
                    <span className="absolute inset-0 flex flex-col items-center justify-center gap-1">
                      <span className="text-2xl">🎨</span>
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                        isDarkForWp ? 'bg-black/40 text-white/80' : 'bg-white/60 text-black/70'
                      }`}>Градиент</span>
                    </span>
                    {currentWallpaper === 'custom-gradient' && (
                      <div className="absolute top-1 right-1 w-5 h-5 rounded-full bg-primary-500 flex items-center justify-center">
                        <div className="w-1.5 h-2 border-b-2 border-r-2 border-white rotate-45 -translate-y-0.5"></div>
                      </div>
                    )}
                  </button>

                  {/* Custom image button */}
                  <button
                    onClick={() => {
                      if (currentWallpaper === 'custom-image' && customImage) {
                        // Already set — just select it
                        return;
                      }
                      imageInputRef.current?.click();
                    }}
                    className={`relative aspect-[3/4] rounded-xl overflow-hidden border-2 transition-all ${
                      currentWallpaper === 'custom-image' ? 'border-primary-500 scale-[1.02] shadow-lg' : 'border-transparent hover:border-messenger-border'
                    }`}
                    style={customImage ? {
                      backgroundImage: `url(${customImage})`,
                      backgroundSize: 'cover',
                      backgroundPosition: 'center',
                    } : {
                      backgroundColor: isDarkForWp ? '#1a1a2e' : '#e8e8f0',
                    }}
                  >
                    <span className="absolute inset-0 flex flex-col items-center justify-center gap-1">
                      <span className="text-2xl">{customImage ? '🖼️' : '📷'}</span>
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                        isDarkForWp ? 'bg-black/40 text-white/80' : 'bg-white/60 text-black/70'
                      }`}>Фото</span>
                    </span>
                    {currentWallpaper === 'custom-image' && (
                      <div className="absolute top-1 right-1 w-5 h-5 rounded-full bg-primary-500 flex items-center justify-center">
                        <div className="w-1.5 h-2 border-b-2 border-r-2 border-white rotate-45 -translate-y-0.5"></div>
                      </div>
                    )}
                  </button>
                  <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      // Resize and compress
                      const reader = new FileReader();
                      reader.onload = () => {
                        const img = new Image();
                        img.onload = () => {
                          const canvas = document.createElement('canvas');
                          const MAX = 1920;
                          let w = img.width, h = img.height;
                          if (w > MAX || h > MAX) {
                            if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
                            else { w = Math.round(w * MAX / h); h = MAX; }
                          }
                          canvas.width = w;
                          canvas.height = h;
                          const ctx = canvas.getContext('2d')!;
                          ctx.drawImage(img, 0, 0, w, h);
                          const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
                          setCustomImage(dataUrl);
                          setWallpaper('custom-image');
                        };
                        img.src = reader.result as string;
                      };
                      reader.readAsDataURL(file);
                      e.target.value = '';
                    }}
                  />
                </div>

                {/* Gradient editor */}
                {currentWallpaper === 'custom-gradient' && (
                  <div className="mt-3 bg-black/5 dark:bg-white/5 rounded-xl p-4 animate-scale-in">
                    <button
                      onClick={() => setShowGradientEditor(!showGradientEditor)}
                      className="flex items-center justify-between w-full text-messenger-text font-medium text-[14px]"
                    >
                      <span>Настроить градиент</span>
                      {showGradientEditor ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </button>

                    {showGradientEditor && (
                      <div className="mt-3 space-y-3">
                        {/* Preview */}
                        <div
                          className="w-full h-24 rounded-lg border border-messenger-border/50"
                          style={{
                            backgroundColor: isDarkForWp ? '#0f172a' : '#e2e8f0',
                            backgroundImage: `linear-gradient(${customGradient.angle}deg, ${customGradient.opacity < 1 ? `rgba(${parseInt(customGradient.color1.slice(1,3),16)},${parseInt(customGradient.color1.slice(3,5),16)},${parseInt(customGradient.color1.slice(5,7),16)},${customGradient.opacity})` : customGradient.color1}, ${customGradient.opacity < 1 ? `rgba(${parseInt(customGradient.color2.slice(1,3),16)},${parseInt(customGradient.color2.slice(3,5),16)},${parseInt(customGradient.color2.slice(5,7),16)},${customGradient.opacity})` : customGradient.color2})`,
                          }}
                        />

                        {/* Color pickers */}
                        <div className="grid grid-cols-2 gap-3">
                          <label className="flex items-center justify-between bg-white dark:bg-[#2c2c2c] px-3 py-2 rounded-lg shadow-sm">
                            <span className="text-[13px] text-messenger-text">Цвет 1</span>
                            <div className="relative w-7 h-7 rounded overflow-hidden border border-messenger-border shrink-0">
                              <input
                                type="color"
                                value={customGradient.color1}
                                onChange={(e) => setCustomGradient({ color1: e.target.value })}
                                className="absolute -inset-2 w-12 h-12 cursor-pointer"
                              />
                            </div>
                          </label>
                          <label className="flex items-center justify-between bg-white dark:bg-[#2c2c2c] px-3 py-2 rounded-lg shadow-sm">
                            <span className="text-[13px] text-messenger-text">Цвет 2</span>
                            <div className="relative w-7 h-7 rounded overflow-hidden border border-messenger-border shrink-0">
                              <input
                                type="color"
                                value={customGradient.color2}
                                onChange={(e) => setCustomGradient({ color2: e.target.value })}
                                className="absolute -inset-2 w-12 h-12 cursor-pointer"
                              />
                            </div>
                          </label>
                        </div>

                        {/* Angle slider */}
                        <label className="block bg-white dark:bg-[#2c2c2c] px-3 py-2 rounded-lg shadow-sm">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-[13px] text-messenger-text">Угол</span>
                            <span className="text-[12px] text-messenger-muted">{customGradient.angle}°</span>
                          </div>
                          <input
                            type="range"
                            min="0"
                            max="360"
                            value={customGradient.angle}
                            onChange={(e) => setCustomGradient({ angle: Number(e.target.value) })}
                            className="w-full accent-primary-500"
                          />
                        </label>

                        {/* Opacity slider */}
                        <label className="block bg-white dark:bg-[#2c2c2c] px-3 py-2 rounded-lg shadow-sm">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-[13px] text-messenger-text">Прозрачность</span>
                            <span className="text-[12px] text-messenger-muted">{Math.round(customGradient.opacity * 100)}%</span>
                          </div>
                          <input
                            type="range"
                            min="0"
                            max="100"
                            value={Math.round(customGradient.opacity * 100)}
                            onChange={(e) => setCustomGradient({ opacity: Number(e.target.value) / 100 })}
                            className="w-full accent-primary-500"
                          />
                        </label>

                        {/* Optional pattern overlay */}
                        <div className="bg-white dark:bg-[#2c2c2c] px-3 py-2 rounded-lg shadow-sm">
                          <span className="text-[13px] text-messenger-text block mb-2">Узор поверх градиента</span>
                          <div className="flex flex-wrap gap-1.5">
                            <button
                              onClick={() => setCustomGradient({ patternId: undefined })}
                              className={`px-2 py-1 rounded-md text-[12px] transition-colors ${
                                !customGradient.patternId
                                  ? 'bg-primary-500 text-white'
                                  : 'bg-black/5 dark:bg-white/10 text-messenger-muted hover:text-messenger-text'
                              }`}
                            >
                              Нет
                            </button>
                            {WALLPAPERS.filter(w => w.id !== 'none' && w.id !== 'default').map(wp => (
                              <button
                                key={wp.id}
                                onClick={() => setCustomGradient({ patternId: wp.id })}
                                className={`px-2 py-1 rounded-md text-[12px] transition-colors ${
                                  customGradient.patternId === wp.id
                                    ? 'bg-primary-500 text-white'
                                    : 'bg-black/5 dark:bg-white/10 text-messenger-muted hover:text-messenger-text'
                                }`}
                              >
                                {wp.emoji}
                              </button>
                            ))}
                          </div>
                        </div>

                        {/* Reset */}
                        <button
                          onClick={() => setCustomGradient({ ...DEFAULT_GRADIENT })}
                          className="w-full py-2 rounded-lg bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 text-messenger-muted text-[13px] transition-colors"
                        >
                          Сбросить
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Image actions */}
                {currentWallpaper === 'custom-image' && customImage && (
                  <div className="mt-3 space-y-2">
                    {/* Image opacity slider */}
                    <label className="block bg-black/5 dark:bg-white/5 px-3 py-2 rounded-lg">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[13px] text-messenger-text">Прозрачность фото</span>
                        <span className="text-[12px] text-messenger-muted">{Math.round(imageOpacity * 100)}%</span>
                      </div>
                      <input
                        type="range"
                        min="10"
                        max="100"
                        value={Math.round(imageOpacity * 100)}
                        onChange={(e) => setImageOpacity(Number(e.target.value) / 100)}
                        className="w-full accent-primary-500"
                      />
                    </label>
                    <div className="flex gap-2">
                      <button
                        onClick={() => imageInputRef.current?.click()}
                        className="flex-1 py-2 rounded-lg bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 text-messenger-text text-[13px] font-medium transition-colors flex items-center justify-center gap-1.5"
                      >
                        <ImagePlus className="w-4 h-4" /> Сменить фото
                      </button>
                      <button
                        onClick={() => { setCustomImage(''); setWallpaper('default'); setImageOpacity(1); }}
                        className="px-4 py-2 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-500 text-[13px] font-medium transition-colors flex items-center justify-center gap-1.5"
                      >
                        <X className="w-4 h-4" /> Удалить
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Масштаб интерфейса */}
              <div className="mt-5">
                <p className="text-[14px] font-medium text-messenger-text mb-2">Масштаб интерфейса: <span className="text-primary-500">{uiScale}px</span></p>
                <div className="flex items-center gap-3">
                  <span className="text-[11px] text-messenger-muted">{UI_SCALE_MIN}</span>
                  <input
                    type="range"
                    min={UI_SCALE_MIN}
                    max={UI_SCALE_MAX}
                    value={uiScale}
                    onChange={(e) => setUiScale(Number(e.target.value))}
                    className="flex-1 h-2 rounded-full appearance-none cursor-pointer accent-primary-500 bg-black/10 dark:bg-white/10"
                  />
                  <span className="text-[11px] text-messenger-muted">{UI_SCALE_MAX}</span>
                </div>
                <p className="text-[11px] text-messenger-muted mt-1 text-center">Меняет размер всех элементов UI (кнопки, отступы, хедер)</p>
              </div>

              {/* Размер текста */}
              <div className="mt-5">
                <p className="text-[14px] font-medium text-messenger-text mb-2">Размер текста: <span className="text-primary-500">{fontSize}px</span></p>
                <div className="flex items-center gap-3">
                  <span className="text-[11px] text-messenger-muted">{FONT_SIZE_MIN}</span>
                  <input
                    type="range"
                    min={FONT_SIZE_MIN}
                    max={FONT_SIZE_MAX}
                    value={fontSize}
                    onChange={(e) => setFontSize(Number(e.target.value))}
                    className="flex-1 h-2 rounded-full appearance-none cursor-pointer accent-primary-500 bg-black/10 dark:bg-white/10"
                  />
                  <span className="text-[11px] text-messenger-muted">{FONT_SIZE_MAX}</span>
                </div>
                <p className="text-center mt-2 text-messenger-muted" style={{ fontSize: `${fontSize}px`, fontFamily: FONT_FAMILIES.find(f => f.id === fontFamily)?.value, fontStyle: fontFamily === 'gost_b_italic' ? 'italic' : 'normal' }}>Привет, мир!</p>
              </div>

              {/* Шрифт — свёрнутая панель по разделам */}
              <div className="mt-4">
                <FontPicker current={fontFamily} onPick={setFontFamily} />
              </div>

              {currentTheme === 'custom' && (
                <div className="mt-4 bg-black/5 dark:bg-white/5 rounded-xl p-4 animate-scale-in">
                  <button
                    onClick={() => setShowCustomEditor(!showCustomEditor)}
                    className="flex items-center justify-between w-full text-messenger-text font-medium"
                  >
                    <span>Настроить свою тему</span>
                    {showCustomEditor ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                  </button>

                  {showCustomEditor && (
                    <div className="mt-4 space-y-4">
                      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                        {([
                          ['bg', 'Фон'],
                          ['sidebar', 'Боковая панель'],
                          ['chat', 'Чат'],
                          ['input', 'Поля ввода'],
                          ['hover', 'Наведение'],
                          ['border', 'Границы'],
                          ['divider', 'Разделитель чатов'],
                          ['text', 'Текст'],
                          ['muted', 'Приглушённый'],
                          ['accent', 'Акцент'],
                          ['own', 'Свои сообщения'],
                          ['other', 'Чужие сообщения'],
                        ] as [keyof CustomThemeVars, string][]).map(([key, label]) => (
                          <label key={key} className="flex items-center justify-between bg-white dark:bg-[#2c2c2c] px-3 py-2 rounded-lg shadow-sm">
                            <span className="text-[13px] text-messenger-text">{label}</span>
                            <div className="relative w-7 h-7 rounded overflow-hidden border border-messenger-border shrink-0">
                              <input
                                type="color"
                                value={customVars[key] as string}
                                onChange={(e) => setCustomVar(key, e.target.value)}
                                className="absolute -inset-2 w-12 h-12 cursor-pointer"
                              />
                            </div>
                          </label>
                        ))}
                      </div>
                      
                      <div className="space-y-4 bg-white dark:bg-[#2c2c2c] p-4 rounded-lg shadow-sm">
                        <label className="flex items-center justify-between">
                          <span className="text-[14px] text-messenger-text">Цветовая схема</span>
                          <select
                            value={customVars.colorScheme}
                            onChange={(e) => setCustomVar('colorScheme', e.target.value as 'light' | 'dark')}
                            className="bg-transparent border border-messenger-border rounded-md px-2 py-1 text-sm focus:outline-none focus:border-primary-500"
                          >
                            <option value="dark">Тёмная</option>
                            <option value="light">Светлая</option>
                          </select>
                        </label>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="h-2 bg-[#f4f4f5] dark:bg-[#0f0f0f] border-y border-messenger-border/50 w-full" />

          {/* Язык */}
          <div className="py-2 bg-white dark:bg-[#212121]">
            <div className="px-5 py-2 flex items-center gap-4 text-messenger-accent font-medium text-[15px]">
              <Globe className="w-5 h-5" /> Язык
            </div>
            <label className="flex items-center justify-between px-5 py-3 hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
              <span className="text-[16px] text-messenger-text">Язык приложения</span>
              <select
                value={settings?.language || 'ru'}
                onChange={(e) => updateSetting('language', e.target.value)}
                className="bg-transparent border-none text-primary-500 font-medium text-[15px] focus:outline-none cursor-pointer text-right appearance-none"
              >
                <option value="ru">Русский</option>
                <option value="en">English</option>
              </select>
            </label>
          </div>

          <div className="h-2 bg-[#f4f4f5] dark:bg-[#0f0f0f] border-y border-messenger-border/50 w-full" />

          {/* Обход ТСПУ */}
          <div className="py-2 bg-white dark:bg-[#212121]">
            <div className="px-5 py-2 flex items-center gap-4 text-messenger-accent font-medium text-[15px]">
              <Shield className="w-5 h-5" /> Обход блокировок (ТСПУ)
            </div>
            <div className="px-5 py-1">
              <p className="text-[12px] text-messenger-muted leading-relaxed mb-3">
                Если звонки зависают на надписи "Подключение..." (блокировка UDP провайдером), включите эту опцию. Звонки будут использовать TCP-relay сервера.
              </p>
            </div>
            <label className="flex items-center justify-between px-5 py-3 hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer transition-colors">
              <div className="flex flex-col">
                <span className="text-[16px] text-messenger-text">Форсировать TCP (Звонки)</span>
                <span className="text-[13px] text-messenger-muted mt-0.5">
                  Рекомендуется при проблемах с сетью
                </span>
              </div>
              <input
                type="checkbox"
                checked={forceTcpRelay}
                onChange={(e) => setForceTcpRelay(e.target.checked)}
                className="w-10 h-5 bg-messenger-border rounded-full appearance-none relative checked:bg-primary-500 transition-colors cursor-pointer before:content-[''] before:absolute before:w-4 before:h-4 before:bg-white before:rounded-full before:top-0.5 before:left-0.5 checked:before:translate-x-5 before:transition-transform before:shadow-sm"
              />
            </label>
          </div>

          {/* Связь судного дня — BLE Mesh (Capacitor APK, Web Bluetooth, или AndroidBridge) */}
          <div className="py-2 bg-white dark:bg-[#212121]">
            <div className="px-5 py-2 flex items-center gap-4 text-red-500 font-medium text-[15px]">
              <Radio className="w-5 h-5" /> Связь судного дня
            </div>
            <p className="px-5 text-[12px] text-messenger-muted mb-2">
              {isNativePlatform
                ? 'Офлайн-связь через Bluetooth. Сообщения передаются между устройствами по цепочке без интернета.'
                : hasBluetooth
                  ? 'Bluetooth-связь через Web Bluetooth API. Подключись к ближайшему устройству с mesh для обмена сообщениями без интернета.'
                  : 'Для Bluetooth-mesh нужен Chrome или Edge с поддержкой Web Bluetooth. Или установи APK для полного функционала.'}
            </p>
            {(isNativePlatform || hasBluetooth || (window as any).AndroidBridge?.startMeshMode) ? (
              <>
                <label className="flex items-center justify-between px-5 py-3 hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer transition-colors">
                  <div className="flex flex-col">
                    <span className="text-[16px] text-messenger-text">BLE Mesh</span>
                    <span className="text-[13px] text-messenger-muted mt-0.5">
                      {meshActive
                        ? `Активен · Соседей: ${meshPeerCount}`
                        : 'Выключен'}
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    checked={meshActive}
                    onChange={toggleMesh}
                    className="w-10 h-5 bg-messenger-border rounded-full appearance-none relative checked:bg-red-500 transition-colors cursor-pointer before:content-[''] before:absolute before:w-4 before:h-4 before:bg-white before:rounded-full before:top-0.5 before:left-0.5 checked:before:translate-x-5 before:transition-transform before:shadow-sm"
                  />
                </label>
                {meshActive && meshDeviceId && (
                  <p className="px-5 pb-3 text-[12px] text-messenger-muted">
                    ID устройства: <span className="font-mono text-messenger-text">{meshDeviceId}</span>
                  </p>
                )}
                <LoraPanel />
                <LanServerPicker />
              </>
            ) : (
              <div className="px-5 pb-3">
                <p className="text-[13px] text-messenger-muted italic">
                  Bluetooth недоступен в этом браузере. Используй Chrome/Edge или скачай APK.
                </p>
              </div>
            )}
          </div>

          <div className="h-2 bg-[#f4f4f5] dark:bg-[#0f0f0f] border-y border-messenger-border/50 w-full" />

          {/* Почтовый мост — Email Bridge */}
          <div className="py-2 bg-white dark:bg-[#212121]">
            <div className="px-5 py-2 flex items-center gap-4 text-messenger-accent font-medium text-[15px]">
              <Mail className="w-5 h-5" /> Почтовый мост
            </div>

            <div className="px-5 py-1">
              <p className="text-[12px] text-messenger-muted leading-relaxed mb-3">
                📨 Когда ты оффлайн, сообщения будут дублироваться на твой email. Можно отвечать прямо из почты — ответ появится в чате. Работает даже если сервер заблокирован по IP.
              </p>
            </div>

            <div className="px-5 py-2 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-[14px] text-messenger-text">Включить email fallback</span>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  className="sr-only peer"
                  checked={emailBridgeEnabled}
                  onChange={async (e) => {
                    const enabled = e.target.checked;
                    setEmailBridgeEnabled(enabled);
                    try {
                      await authApi.updateEmailBridgeSettings({ enabled });
                    } catch {
                      setEmailBridgeEnabled(!enabled);
                    }
                  }}
                />
                <div className="w-11 h-6 bg-gray-200 dark:bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-messenger-accent" />
              </label>
            </div>

            <div className="px-5 py-2">
              <div className="space-y-3">
                <div>
                  <label className="text-[12px] text-messenger-muted mb-1 block">Email для доставки:</label>
                  <input
                    type="email"
                    value={emailBridgeEmail}
                    onChange={(e) => setEmailBridgeEmail(e.target.value)}
                    placeholder="user@yandex.ru"
                    className="w-full bg-[#f4f4f5] dark:bg-[#181818] border border-messenger-border/50 rounded-lg px-3 py-2 text-[14px] text-messenger-text placeholder:text-messenger-muted/50 outline-none focus:border-messenger-accent"
                  />
                </div>
                <div>
                  <label className="text-[12px] text-messenger-muted mb-1 block">
                    Пароль приложения {emailBridgeHasPassword && <span className="text-green-500 font-medium">(✓ Сохранён)</span>}
                  </label>
                  <input
                    type="password"
                    value={emailBridgePassword}
                    onChange={(e) => setEmailBridgePassword(e.target.value)}
                    placeholder={emailBridgeHasPassword ? '•••••••• (оставьте пустым для сохранения старого)' : 'Пароль приложения (16 символов)'}
                    className="w-full bg-[#f4f4f5] dark:bg-[#181818] border border-messenger-border/50 rounded-lg px-3 py-2 text-[14px] text-messenger-text placeholder:text-messenger-muted/50 outline-none focus:border-messenger-accent"
                  />
                  <p className="text-[11px] text-messenger-muted mt-1.5 leading-relaxed">
                    ⚙️ Пароль нужен для отправки уведомлений от вашего имени самому себе и чтения ответов. Создайте «Пароль приложения» в настройках безопасности Яндекса, Gmail или Mail.ru.
                  </p>
                </div>
                <button
                  onClick={async () => {
                    setEmailBridgeSaving(true);
                    setEmailBridgeSaved(false);
                    try {
                      // Сначала тестируем
                      if (emailBridgePassword) {
                        const testRes = await authApi.testPersonalEmail({ email: emailBridgeEmail, password: emailBridgePassword });
                        if (!testRes.data.success) throw new Error();
                      }
                      
                      // Если тест прошёл или пароль не менялся, сохраняем
                      await authApi.updateEmailBridgeSettings({ 
                        email: emailBridgeEmail,
                        ...(emailBridgePassword ? { password: emailBridgePassword } : {})
                      });
                      
                      setEmailBridgeSaved(true);
                      if (emailBridgePassword) {
                        setEmailBridgeHasPassword(true);
                        setEmailBridgePassword('');
                      }
                      setTimeout(() => setEmailBridgeSaved(false), 3000);
                    } catch (e: any) {
                      const msg = e.response?.data?.error || 'Ошибка проверки. Убедитесь, что IMAP/SMTP включены, и пароль приложения верный.';
                      alert(msg);
                    }
                    setEmailBridgeSaving(false);
                  }}
                  disabled={emailBridgeSaving || !emailBridgeEmail || (!emailBridgeHasPassword && !emailBridgePassword)}
                  className="w-full py-2.5 bg-gradient-to-r from-blue-500 to-indigo-600 text-white rounded-lg text-[14px] font-medium disabled:opacity-50 hover:opacity-90 transition-opacity flex items-center justify-center gap-2"
                >
                  {emailBridgeSaving ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : emailBridgeSaved ? (
                    <>
                      <Check className="w-4 h-4" /> Проверено и сохранено
                    </>
                  ) : (
                    'Проверить и сохранить'
                  )}
                </button>
              </div>
            </div>
          </div>

          <div className="h-2 bg-[#f4f4f5] dark:bg-[#0f0f0f] border-y border-messenger-border/50 w-full" />

          {/* Уведомления и батарея — только на Android APK */}
          {(window as any).AndroidBridge?.openServiceNotificationSettings && (
            <>
              <div className="py-2 bg-white dark:bg-[#212121]">
                <div className="px-5 py-2 flex items-center gap-4 text-messenger-accent font-medium text-[15px]">
                  <Bell className="w-5 h-5" /> Фоновая работа
                </div>

                <div className="px-5 py-1">
                  <p className="text-[12px] text-messenger-muted leading-relaxed mb-3">
                    📱 STORAGE&MESS работает в фоне через SSE-подключение — полностью автономно, без Google/Firebase. Android требует показывать служебное уведомление для фоновых сервисов, но его можно скрыть.
                  </p>
                </div>

                {/* Скрыть служебное уведомление */}
                <div className="px-5 py-2">
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <div className="text-[14px] text-messenger-text">Скрыть уведомление в шторке</div>
                      <div className="text-[11px] text-messenger-muted mt-0.5">
                        {serviceNotifHidden
                          ? '✅ Канал отключён — уведомление скрыто'
                          : '⚡ Откроет настройки канала → отключи его'}
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        (window as any).AndroidBridge?.openServiceNotificationSettings();
                        // Перепроверим через 3 сек после возврата
                        setTimeout(() => {
                          const hidden = (window as any).AndroidBridge?.isServiceNotificationHidden?.();
                          if (hidden !== undefined) setServiceNotifHidden(hidden);
                        }, 3000);
                      }}
                      className={`px-4 py-2 rounded-lg text-[13px] font-medium transition-opacity ${
                        serviceNotifHidden
                          ? 'bg-green-500/20 text-green-600 dark:text-green-400'
                          : 'bg-messenger-accent text-white hover:opacity-90'
                      }`}
                    >
                      {serviceNotifHidden ? 'Готово' : 'Скрыть'}
                    </button>
                  </div>
                </div>

                {/* Battery optimization */}
                <div className="px-5 py-2">
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <div className="text-[14px] text-messenger-text">Защита от оптимизации батареи</div>
                      <div className="text-[11px] text-messenger-muted mt-0.5">
                        {batteryOptExempt
                          ? '✅ Приложение исключено — фоновый сервис защищён'
                          : '⚠️ Samsung/Xiaomi могут убить фоновый сервис'}
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        (window as any).AndroidBridge?.requestBatteryOptimizationExemption();
                        setTimeout(() => {
                          const exempt = (window as any).AndroidBridge?.isBatteryOptimizationExempt?.();
                          if (exempt !== undefined) setBatteryOptExempt(exempt);
                        }, 3000);
                      }}
                      className={`px-4 py-2 rounded-lg text-[13px] font-medium transition-opacity ${
                        batteryOptExempt
                          ? 'bg-green-500/20 text-green-600 dark:text-green-400'
                          : 'bg-orange-500 text-white hover:opacity-90'
                      }`}
                    >
                      {batteryOptExempt ? 'Защищено' : 'Защитить'}
                    </button>
                  </div>
                </div>
              </div>

              <div className="h-2 bg-[#f4f4f5] dark:bg-[#0f0f0f] border-y border-messenger-border/50 w-full" />
            </>
          )}

          {/* Сеть и подключение */}
          <div className="py-2 bg-white dark:bg-[#212121]">
            <div className="px-5 py-2 flex items-center gap-4 text-messenger-accent font-medium text-[15px]">
              <Wifi className="w-5 h-5" /> Сеть и подключение
            </div>

            {/* Текущий сервер */}
            <div className="px-5 py-2">
              <div className="flex items-center gap-2 text-[13px] text-messenger-muted mb-1">
                <Server className="w-3.5 h-3.5" />
                <span>Текущий сервер:</span>
              </div>
              <p className="text-[13px] text-messenger-text font-mono break-all bg-black/5 dark:bg-white/5 rounded px-2 py-1.5">
                {currentServerUrl || 'Не определён'}
              </p>
            </div>

            {/* Кастомный URL (VPN) */}
            <div className="px-5 py-3">
              <p className="text-[13px] text-messenger-muted mb-2">
                Кастомный URL сервера (VPN, прокси, свой сервер). Будет пробоваться первым при подключении.
              </p>
              <div className="flex gap-2">
                <input
                  type="url"
                  value={customServerUrl}
                  onChange={(e) => setCustomServerUrlState(e.target.value)}
                  placeholder="https://vpn-server.example.com"
                  className="flex-1 rounded-lg border border-messenger-border bg-messenger-input px-3 py-2 text-[14px] text-messenger-text placeholder:text-messenger-muted/60 outline-none focus:border-primary-500"
                />
                <button
                  onClick={() => {
                    setCustomServerUrl(customServerUrl);
                    setServerUrlSaved(true);
                    setTimeout(() => setServerUrlSaved(false), 2000);
                  }}
                  className="px-4 py-2 rounded-lg bg-primary-500 hover:bg-primary-600 text-white text-[13px] font-medium transition-colors"
                >
                  {serverUrlSaved ? '✓' : 'OK'}
                </button>
              </div>
              {customServerUrl && (
                <button
                  onClick={() => {
                    setCustomServerUrlState('');
                    setCustomServerUrl('');
                  }}
                  className="mt-2 text-[12px] text-red-400 hover:text-red-300 transition-colors"
                >
                  Очистить кастомный URL
                </button>
              )}
            </div>

            {/* Офлайн-очередь сообщений */}
            {pendingMsgCount > 0 && (
              <div className="px-5 py-3 border-t border-messenger-border/30">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Send className="w-4 h-4 text-blue-400" />
                    <span className="text-[14px] text-messenger-text">{pendingMsgCount} сообщ. в очереди</span>
                  </div>
                  <button
                    disabled={flushingQueue}
                    onClick={async () => {
                      setFlushingQueue(true);
                      try {
                        const result = await flushQueue((pendingId, sentMsg) => {
                          useChatStore.getState().replacePendingMessage(pendingId, sentMsg);
                        });
                        setPendingMsgCount(getPendingCount());
                        if (result.sent > 0) alert(`Отправлено: ${result.sent}`);
                      } catch {} finally { setFlushingQueue(false); }
                    }}
                    className="px-3 py-1.5 rounded-lg bg-blue-500/10 text-blue-400 text-[13px] font-medium hover:bg-blue-500/20 transition-colors disabled:opacity-50"
                  >
                    {flushingQueue ? 'Отправка...' : 'Отправить сейчас'}
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="h-2 bg-[#f4f4f5] dark:bg-[#0f0f0f] border-y border-messenger-border/50 w-full" />

          {/* Безопасность */}
          <div className="py-2 bg-white dark:bg-[#212121]">
            <div className="px-5 py-2 flex items-center gap-4 text-messenger-accent font-medium text-[15px]">
              <Shield className="w-5 h-5" /> Безопасность
            </div>

            {/* Сквозное шифрование */}
            <E2EESettings />

            {/* Смена пароля */}
            <div className="px-5 py-3 border-b border-messenger-border/30">
              {!showPasswordChange ? (
                <button
                  onClick={() => { setShowPasswordChange(true); setPasswordError(''); setPasswordSuccess(false); }}
                  className="w-full py-2.5 rounded-lg bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 text-messenger-text font-medium transition-colors flex items-center justify-center gap-2"
                >
                  <Lock className="w-4 h-4" />
                  Сменить пароль
                </button>
              ) : (
                <div className="space-y-3 animate-fadeIn">
                  <input
                    type="password"
                    value={oldPassword}
                    onChange={(e) => setOldPassword(e.target.value)}
                    placeholder="Текущий пароль"
                    className="w-full rounded-lg border border-messenger-border bg-messenger-input px-3 py-2 text-[14px] text-messenger-text placeholder:text-messenger-muted/60 outline-none focus:border-primary-500"
                  />
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Новый пароль (мин. 6 символов)"
                    className="w-full rounded-lg border border-messenger-border bg-messenger-input px-3 py-2 text-[14px] text-messenger-text placeholder:text-messenger-muted/60 outline-none focus:border-primary-500"
                  />
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Подтвердите новый пароль"
                    className="w-full rounded-lg border border-messenger-border bg-messenger-input px-3 py-2 text-[14px] text-messenger-text placeholder:text-messenger-muted/60 outline-none focus:border-primary-500"
                    onKeyDown={(e) => { if (e.key === 'Enter') handleChangePassword(); }}
                  />
                  {passwordError && (
                    <p className="text-[13px] text-red-500">{passwordError}</p>
                  )}
                  {passwordSuccess && (
                    <p className="text-[13px] text-green-500">Пароль успешно изменён!</p>
                  )}
                  <div className="flex gap-2">
                    <button
                      onClick={() => { setShowPasswordChange(false); setOldPassword(''); setNewPassword(''); setConfirmPassword(''); setPasswordError(''); }}
                      className="flex-1 py-2 rounded-lg bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 text-messenger-text font-medium transition-colors text-[13px]"
                    >
                      Отмена
                    </button>
                    <button
                      onClick={handleChangePassword}
                      disabled={changingPassword}
                      className="flex-1 py-2 rounded-lg bg-primary-500 hover:bg-primary-600 text-white font-medium transition-colors flex items-center justify-center gap-2 disabled:opacity-50 text-[13px]"
                    >
                      {changingPassword ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Сохранить'}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Ключ восстановления */}
            <div className="px-5 py-3">
              <p className="text-[13px] text-messenger-muted mb-3">
                Ключ восстановления позволяет сбросить пароль, если вы его забудете. Сохраните его в надёжном месте.
              </p>
              {!recoveryKey ? (
                <button
                  onClick={handleGetRecoveryKey}
                  disabled={generatingKey}
                  className="w-full py-2.5 rounded-lg bg-primary-500 hover:bg-primary-600 text-white font-medium transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {generatingKey ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    <>
                      <Shield className="w-4 h-4" />
                      Получить ключ восстановления
                    </>
                  )}
                </button>
              ) : (
                <div className="space-y-3 animate-fadeIn">
                  <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-lg p-3">
                    <p className="text-[13px] text-amber-700 dark:text-amber-400 font-medium mb-2">
                      ⚠️ Запишите этот ключ! Он не будет показан повторно.
                    </p>
                    <code className="block text-center font-mono text-[15px] text-amber-900 dark:text-amber-300 bg-white dark:bg-black/20 rounded px-3 py-2 select-all break-all">
                      {recoveryKey}
                    </code>
                  </div>
                  <button
                    onClick={handleCopyKey}
                    className="w-full py-2 rounded-lg bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 text-messenger-text font-medium transition-colors flex items-center justify-center gap-2"
                  >
                    {keyCopied ? (
                      <><Check className="w-4 h-4 text-green-500" /> Скопировано</>
                    ) : (
                      <><Copy className="w-4 h-4" /> Скопировать ключ</>
                    )}
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="h-2 bg-[#f4f4f5] dark:bg-[#0f0f0f] border-y border-messenger-border/50 w-full" />

          {/* Вход в панель — администратору И модератору.
              Раньше условие было `role === 'admin'`, поэтому модератор не
              видел вообще ничего: сама панель его пускала, но двери к ней
              не существовало.
              Это удобство, а не защита: доступ всё равно проверяет сервер,
              а посторонним раздел отвечает 404. */}
          {((user as any)?.role === 'admin' || (user as any)?.role === 'moderator') && (() => {
            const moder = (user as any)?.role === 'moderator';
            return (
              <div className="py-2 bg-white dark:bg-[#212121]">
                <button
                  onClick={() => navigate('/admin')}
                  className="w-full flex items-center gap-4 px-5 py-3.5 hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-messenger-text text-[16px]"
                >
                  <div className={`w-10 h-10 bg-gradient-to-tr ${moder ? 'from-sky-500 to-indigo-500' : 'from-amber-500 to-red-500'} rounded-xl flex items-center justify-center shrink-0`}>
                    <span className="text-xl">🛡️</span>
                  </div>
                  <div className="flex-1 text-left">
                    <span className={`font-bold ${moder ? 'text-sky-400' : 'text-amber-500'}`}>
                      {moder ? 'Панель модератора' : 'Админ-панель'}
                    </span>
                    <p className="text-[12px] text-messenger-muted mt-0.5">
                      {moder
                        ? 'Люди, обращения, сводка по серверу, журнал. Чужая переписка закрыта'
                        : 'Люди, модерация, сводка по серверу, журнал действий'}
                    </p>
                  </div>
                </button>
              </div>
            );
          })()}

          {/* Приложение для этой системы.
              Раньше здесь была одна ссылка на APK магазина обновлений — её
              видел и тот, кто зашёл с компьютера. Сервер прекрасно понимает,
              откуда зашли, но на предложение это никак не влияло. */}
          <div className="py-2 bg-white dark:bg-[#212121]">
            <div className="px-5 pt-1 pb-2 text-[12px] text-messenger-muted">
              Приложение · определили: {platformName(detectPlatform())}
            </div>
            {getDownloads().map(d => (
              <a
                key={d.id}
                href={d.url}
                className="w-full flex items-center gap-4 px-5 py-3.5 hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-messenger-text text-[16px]"
              >
                <div className={`w-10 h-10 bg-gradient-to-tr ${d.primary ? 'from-green-500 to-emerald-600' : 'from-slate-500 to-slate-600'} rounded-xl flex items-center justify-center shrink-0`}>
                  <span className="text-xl">{d.id === 'apk' ? '🤖' : d.id === 'windows' ? '🪟' : '🐧'}</span>
                </div>
                <div className="flex-1 text-left min-w-0">
                  <span className={`font-bold ${d.primary ? 'text-green-600 dark:text-green-400' : ''}`}>
                    {d.title}
                  </span>
                  <p className="text-[12px] text-messenger-muted mt-0.5">
                    {/* Версия обязательно: телефонная и настольная сборки
                        нумеруются независимо, и без подписи непонятно, что
                        именно скачалось. */}
                    {dlVersions[d.id] ? `версия ${dlVersions[d.id]} · ` : ''}
                    {d.primary ? `${d.hint} · для вашей системы` : d.hint}
                  </p>
                </div>
                <div className="w-8 h-8 rounded-full bg-black/5 dark:bg-white/5 flex items-center justify-center shrink-0">
                  <Download className="w-4 h-4 text-messenger-muted" />
                </div>
              </a>
            ))}
            {!hasNativeBuild() && (
              <p className="px-5 pb-2 text-[12px] text-messenger-muted">
                Отдельного приложения для {platformName(detectPlatform())} пока нет — работает веб-версия.
              </p>
            )}
            <div className="px-5 pb-1">
              <CompanionApps />
            </div>
          </div>

          {/* Магазин обновлений — отдельно, это Android-приложение и им
              и остаётся; показываем только там, где его можно поставить. */}
          {detectPlatform() === 'android' && (
            <div className="py-2 bg-white dark:bg-[#212121]">
              <a
                href="/updates/storage-store.apk"
                download="storage-store.apk"
                className="w-full flex items-center gap-4 px-5 py-3.5 hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-messenger-text text-[16px]"
              >
                <div className="w-10 h-10 bg-gradient-to-tr from-indigo-500 to-purple-500 rounded-xl flex items-center justify-center shrink-0">
                  <span className="text-xl">📦</span>
                </div>
                <div className="flex-1 text-left">
                  <span className="font-bold text-indigo-500 dark:text-indigo-400">ХРАНИЛИЩЕ (Store)</span>
                  <p className="text-[12px] text-messenger-muted mt-0.5">Магазин обновлений мессенджера</p>
                </div>
                <div className="w-8 h-8 rounded-full bg-indigo-50 dark:bg-indigo-500/10 flex items-center justify-center">
                  <Download className="w-4 h-4 text-indigo-500 dark:text-indigo-400" />
                </div>
              </a>
            </div>
          )}

          <div className="h-2 bg-[#f4f4f5] dark:bg-[#0f0f0f] border-y border-messenger-border/50 w-full" />

          {/* Консоль отладки */}
          <div className="py-2 bg-white dark:bg-[#212121]">
            <button
              onClick={() => window.dispatchEvent(new Event('open-debug-console'))}
              className="w-full flex items-center gap-4 px-5 py-3.5 hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-messenger-text text-[16px]"
            >
              <Bug className="w-6 h-6 text-messenger-muted" />
              <div className="flex-1 text-left">
                <span className="font-medium">Консоль отладки</span>
                <p className="text-[12px] text-messenger-muted mt-0.5">Логи, ошибки и диагностика</p>
              </div>
              <ChevronDown className="w-5 h-5 text-messenger-muted" />
            </button>
          </div>

          <div className="h-2 bg-[#f4f4f5] dark:bg-[#0f0f0f] border-y border-messenger-border/50 w-full" />

          {/* Правила: мессенджер не СМИ, ответственность пользователей, жалобы */}
          <div className="py-2 bg-white dark:bg-[#212121]">
            <button
              onClick={() => navigate('/terms')}
              className="w-full flex items-center gap-4 px-5 py-3.5 hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-messenger-text text-[16px]"
            >
              <span className="w-6 text-center text-xl leading-none">§</span>
              <span className="flex-1 text-left">
                Правила использования
                <span className="block text-[12px] text-messenger-muted">Мессенджер не является СМИ · за содержимое отвечают авторы · жалобы</span>
              </span>
            </button>
          </div>

          <div className="h-2 bg-[#f4f4f5] dark:bg-[#0f0f0f] border-y border-messenger-border/50 w-full" />

          {/* Выход */}
          <div className="py-2 bg-white dark:bg-[#212121]">
            <button
              onClick={handleLogout}
              className="w-full flex items-center gap-4 px-5 py-3.5 hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-red-500 font-medium text-[16px]"
            >
              <LogOut className="w-6 h-6" />
              Выйти из аккаунта
            </button>
          </div>

          <div className="h-2 bg-[#f4f4f5] dark:bg-[#0f0f0f] border-y border-messenger-border/50 w-full" />

          {/* Удаление аккаунта */}
          <div className="py-4 bg-white dark:bg-[#212121] mt-auto">
            {!showDeleteConfirm ? (
              <button
                onClick={() => setShowDeleteConfirm(true)}
                className="w-full flex items-center justify-center gap-2 px-5 py-3 text-red-500 opacity-60 hover:opacity-100 transition-opacity text-[15px]"
              >
                <AlertTriangle className="w-5 h-5" />
                Удалить аккаунт навсегда
              </button>
            ) : (
              <div className="px-5 pb-4 animate-fadeIn">
                <p className="text-sm text-red-500 font-medium mb-2 text-center">
                  Это действие необратимо. Введите «УДАЛИТЬ» для подтверждения:
                </p>
                <input
                  type="text"
                  value={deleteConfirmText}
                  onChange={(e) => setDeleteConfirmText(e.target.value)}
                  placeholder="УДАЛИТЬ"
                  className="w-full bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-2 text-center text-red-500 font-medium focus:outline-none focus:border-red-500 mb-3"
                  autoFocus
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setShowDeleteConfirm(false);
                      setDeleteConfirmText('');
                    }}
                    className="flex-1 py-2.5 rounded-lg bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 text-messenger-text font-medium transition-colors"
                  >
                    Отмена
                  </button>
                  <button
                    onClick={handleDeleteAccount}
                    disabled={deleteConfirmText !== 'УДАЛИТЬ' || deletingAccount}
                    className="flex-1 py-2.5 rounded-lg bg-red-500 hover:bg-red-600 text-white disabled:opacity-40 disabled:cursor-not-allowed font-medium transition-colors flex items-center justify-center"
                  >
                    {deletingAccount ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Удалить'}
                  </button>
                </div>
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Сквозное шифрование.
//
// До сих пор оно не зашифровало ни одного сообщения из почти восьми тысяч,
// хотя код был написан и ключи опубликованы у 46 человек из 47. Мешал
// замкнутый круг: шифровали только при наличии ключей собеседника в памяти,
// а в память они попадали только в момент шифрования.
//
// Круг разорван, ключи теперь свои у каждого устройства. Но включается это
// по-прежнему вручную: сперва проверить на своих устройствах, что переписка
// не рвётся при заходе с телефона и компьютера одновременно, и только потом
// раздавать остальным.
// =============================================================================
function E2EESettings() {
  const [enabled, setEnabled] = useState(isE2EEEnabled());
  const [devices, setDevices] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);

  const loadDevices = async () => {
    try {
      const r = await api.get('/e2ee/devices');
      setDevices(r.data?.devices || []);
    } catch { setDevices([]); }
  };

  useEffect(() => { if (enabled) void loadDevices(); }, [enabled]);

  const toggle = async () => {
    const next = !enabled;
    setBusy(true);
    try {
      setE2EEEnabled(next);
      setEnabled(next);
      if (next) {
        // Ключи этого устройства должны оказаться на сервере до того, как
        // кто-то попробует нам написать — иначе шифровать будет нечем.
        const token = useAuthStore.getState().accessToken;
        if (token) { await initE2EE(); await publishKeys(token); }
        await loadDevices();
      }
    } finally { setBusy(false); }
  };

  const forget = async (deviceId: string) => {
    setBusy(true);
    try {
      await api.delete(`/e2ee/devices/${deviceId}`);
      await loadDevices();
    } catch { /* не вышло — список просто не изменится */ }
    finally { setBusy(false); }
  };

  const thisDevice = getDeviceId();

  return (
    <div className="px-5 py-3 border-b border-messenger-border/30 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[14px] text-messenger-text font-medium">Сквозное шифрование</div>
          <div className="text-[12px] text-messenger-muted leading-snug">
            Сервер перестаёт видеть текст переписки. Сообщения шифруются
            отдельно для каждого вашего устройства.
          </div>
        </div>
        <button
          onClick={toggle}
          disabled={busy}
          className={`shrink-0 w-12 h-7 rounded-full transition-colors relative ${
            enabled ? 'bg-primary-500' : 'bg-black/20 dark:bg-white/20'
          } disabled:opacity-50`}
        >
          <span className={`absolute top-1 w-5 h-5 rounded-full bg-white transition-all ${
            enabled ? 'left-6' : 'left-1'
          }`} />
        </button>
      </div>

      {enabled && (
        <div className="pt-1 space-y-1.5">
          <div className="text-[12px] text-messenger-muted">
            Пока включено не у всех, переписка с теми, кто ещё не включил,
            остаётся обычной — иначе они не смогли бы её прочитать.
          </div>

          {devices && devices.length > 0 && (
            <div className="space-y-1">
              <div className="text-[12px] text-messenger-muted">Ваши устройства:</div>
              {devices.map((d: any) => (
                <div key={d.deviceId} className="flex items-center justify-between gap-2 text-[12px]">
                  <span className="truncate text-messenger-text">
                    {d.deviceLabel || 'Устройство'}
                    {d.deviceId === thisDevice && <span className="text-messenger-muted"> — это</span>}
                  </span>
                  {d.deviceId !== thisDevice && (
                    <button onClick={() => forget(d.deviceId)} disabled={busy}
                            className="shrink-0 text-red-400 hover:underline disabled:opacity-50">
                      забыть
                    </button>
                  )}
                </div>
              ))}
              <div className="text-[11px] text-messenger-muted leading-snug pt-0.5">
                «Забыть» — если устройство потеряно или им больше не
                пользуются: ему перестанут слать копии сообщений.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Выбор шрифта.
//
// Шрифтов стало под сорок, и плоским списком это уже не читается: чтобы
// добраться до готических, пришлось бы прокручивать мимо всех остальных.
// Поэтому разделы, и раскрыт только тот, где стоит текущий выбор —
// остальные свёрнуты и не занимают экран.
//
// Каждое название написано своим же шрифтом: так видно, как он выглядит,
// ещё до выбора. Рядом образец с русскими буквами — а у шрифтов без
// кириллицы честно сказано, что русский текст останется системным.
// =============================================================================
function FontPicker({ current, onPick }: {
  current: FontFamilyId;
  onPick: (id: FontFamilyId) => void;
}) {
  const currentFont = FONT_FAMILIES.find(f => f.id === current);
  const [openGroup, setOpenGroup] = useState<FontGroupId | null>(currentFont?.group ?? 'base');

  return (
    <div>
      <div className="flex items-baseline justify-between mb-3">
        <p className="text-[14px] font-medium text-messenger-text">Шрифт</p>
        <p className="text-[12px] text-messenger-muted truncate max-w-[60%]"
           style={{ fontFamily: currentFont?.value }}>
          {currentFont?.label || '—'}
        </p>
      </div>

      <div className="space-y-2">
        {FONT_GROUPS.map(group => {
          const fonts = FONT_FAMILIES.filter(f => f.group === group.id);
          if (fonts.length === 0) return null;
          const isOpen = openGroup === group.id;
          const hasCurrent = fonts.some(f => f.id === current);

          return (
            <div key={group.id} className="rounded-xl overflow-hidden bg-black/5 dark:bg-white/5">
              <button
                onClick={() => setOpenGroup(isOpen ? null : group.id)}
                className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-black/5 dark:hover:bg-white/5"
              >
                <span className="text-[13px] font-medium text-messenger-text">
                  {group.label}
                  <span className="ml-2 text-[11px] text-messenger-muted">{fonts.length}</span>
                  {hasCurrent && !isOpen && (
                    <span className="ml-2 text-[11px] text-primary-500">выбран здесь</span>
                  )}
                </span>
                {isOpen
                  ? <ChevronUp className="w-4 h-4 text-messenger-muted" />
                  : <ChevronDown className="w-4 h-4 text-messenger-muted" />}
              </button>

              {isOpen && (
                <div className="px-2 pb-2 space-y-1">
                  {fonts.map(f => (
                    <button
                      key={f.id}
                      onClick={() => onPick(f.id)}
                      className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg transition-all ${
                        current === f.id
                          ? 'bg-primary-500/10 border border-primary-500/30'
                          : 'border border-transparent hover:bg-black/5 dark:hover:bg-white/10'
                      }`}
                    >
                      <span className="flex flex-col items-start min-w-0">
                        <span
                          className={`text-[15px] truncate ${current === f.id ? 'text-primary-500 font-medium' : 'text-messenger-text'}`}
                          style={{ fontFamily: f.value, fontStyle: f.id.endsWith('_italic') ? 'italic' : 'normal' }}
                        >
                          {f.label}
                        </span>
                        {!f.cyrillic && (
                          <span className="text-[10px] text-messenger-muted">
                            только латиница — русский останется системным
                          </span>
                        )}
                      </span>
                      <span
                        className="text-[13px] text-messenger-muted shrink-0"
                        style={{ fontFamily: f.value, fontStyle: f.id.endsWith('_italic') ? 'italic' : 'normal' }}
                      >
                        {f.cyrillic ? 'Привет, мир!' : 'Hello, world!'}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
