import { Capacitor } from '@capacitor/core';
import { Device } from '@capacitor/device';

export const SECRET_APP_KEY = 'STORMESS_SECRET_KEY_2026_X9_ULTRA';

export interface DeviceFootprint {
  clientType: 'APK' | 'Browser' | 'PWA';
  deviceModel: string;
  os: string;
  uniqueKey: string;
}

let cachedFootprint: DeviceFootprint | null = null;

export async function getDeviceFootprint(): Promise<DeviceFootprint> {
  if (cachedFootprint) return cachedFootprint;

  let clientType: 'APK' | 'Browser' | 'PWA' = 'Browser';
  let deviceModel = 'Unknown Browser';
  let os = 'Unknown OS';

  if (Capacitor.isNativePlatform()) {
    clientType = 'APK';
    try {
      const info = await Device.getInfo();
      deviceModel = `${info.manufacturer} ${info.model}`;
      os = `${info.operatingSystem} ${info.osVersion}`;
    } catch (e) {
      deviceModel = 'Android Device';
      os = 'Android';
    }
  } else {
    const ua = navigator.userAgent;
    const isApk = ua.includes('StorageMessApp');
    const isPwa = !isApk && (window.matchMedia('(display-mode: standalone)').matches || 
                  (window.navigator as any).standalone || 
                  document.referrer.includes('android-app://'));
    clientType = isApk ? 'APK' : isPwa ? 'PWA' : 'Browser';
    
    // Simple user-agent parser
    if (ua.includes('Android')) {
      os = 'Android';
      const match = ua.match(/Android.*?; (.*?) Build/);
      if (match && match[1]) deviceModel = match[1];
      else deviceModel = 'Android Browser';
    } else if (ua.includes('iPhone') || ua.includes('iPad')) {
      os = 'iOS';
      deviceModel = ua.includes('iPad') ? 'iPad' : 'iPhone';
    } else if (ua.includes('Windows')) {
      os = 'Windows';
      deviceModel = 'PC';
    } else if (ua.includes('Macintosh')) {
      os = 'macOS';
      deviceModel = 'Mac';
    } else if (ua.includes('Linux')) {
      os = 'Linux';
      deviceModel = 'PC';
    }
  }

  cachedFootprint = {
    clientType,
    deviceModel,
    os,
    uniqueKey: SECRET_APP_KEY,
  };

  localStorage.setItem('device_footprint', JSON.stringify(cachedFootprint));

  return cachedFootprint;
}
