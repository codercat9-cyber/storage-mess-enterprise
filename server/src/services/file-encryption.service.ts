// Закрытая часть STORAGE&MESS — в открытый код не входит.
// Здесь заглушка с тем же интерфейсом: открытая сборка работает без этого механизма.
// Шифрование файлов на диске. В открытой сборке файлы хранятся как есть.
import fs from 'fs';
import crypto from 'crypto';
import { Readable } from 'stream';
import { config } from '../config/index.js';

export class FileEncryptionService {
  isEnabled(): boolean { return false; }
  isFileEncrypted(_filePath: string, _expectedPlainSize?: number): boolean { return false; }

  generateDownloadToken(userId: string, fileId: string, expiresInSeconds: number = 3600): string {
    const payload = `${userId}:${fileId}:${Date.now() + expiresInSeconds * 1000}`;
    const sig = crypto.createHmac('sha256', config.jwt.secret).update(payload).digest('hex').slice(0, 16);
    return Buffer.from(`${payload}:${sig}`).toString('base64url');
  }

  verifyDownloadToken(token: string): { userId: string; fileId: string } | null {
    try {
      const [userId, fileId, expires, sig] = Buffer.from(token, 'base64url').toString().split(':');
      const want = crypto.createHmac('sha256', config.jwt.secret).update(`${userId}:${fileId}:${expires}`).digest('hex').slice(0, 16);
      if (sig !== want || Date.now() > Number(expires)) return null;
      return { userId, fileId };
    } catch {
      return null;
    }
  }

  encryptBuffer(plaintext: Buffer): Buffer { return plaintext; }
  decryptBuffer(data: Buffer): Buffer { return data; }

  async encryptFile(inputPath: string, outputPath?: string,
                    _onProgress?: (doneBytes: number, totalBytes: number) => void): Promise<void> {
    if (outputPath && outputPath !== inputPath) await fs.promises.copyFile(inputPath, outputPath);
  }

  createDecryptStream(filePath: string): Readable {
    return fs.createReadStream(filePath);
  }

  async createDecryptRangeStream(filePath: string, start: number, end: number): Promise<{ stream: Readable; totalSize: number }> {
    const totalSize = (await fs.promises.stat(filePath)).size;
    return { stream: fs.createReadStream(filePath, { start, end }), totalSize };
  }

  async getDecryptedSize(filePath: string): Promise<number> {
    return (await fs.promises.stat(filePath)).size;
  }
}

export const fileEncryption = new FileEncryptionService();
export default fileEncryption;
