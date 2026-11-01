import crypto from 'crypto';

export const SECRET_APP_KEY = 'STORMESS_SECRET_KEY_2026_X9_ULTRA';

export function getDeviceLogString(footprint: any): string {
  if (!footprint) return 'Unknown Device';
  const md5Hash = crypto.createHash('md5').update(footprint.uniqueKey || 'none').digest('hex');
  const valid = footprint.uniqueKey === SECRET_APP_KEY ? '✅' : '❌';
  return `[${footprint.clientType}] ${footprint.deviceModel} (${footprint.os}) | Key: ${valid} (MD5: ${md5Hash.slice(0, 8)}...)`;
}
