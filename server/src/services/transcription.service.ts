import { exec, ChildProcess, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';

const execAsync = promisify(exec);

interface TranscriptionResult {
  text: string;
  language?: string;
}

interface PendingTask {
  id: string;
  resolve: (result: TranscriptionResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  language: string;
}

interface QueueItem {
  file: string;
  language: string;
  resolve: (r: TranscriptionResult) => void;
  reject: (e: Error) => void;
}

class TranscriptionService {
  private daemonScriptPath = path.join(process.cwd(), 'scripts', 'vosk_daemon.py');

  // Python / Vosk availability cache
  private pythonPath: string | null = null;
  private pythonChecked = false;
  private voskAvailable = false;
  private whisperChecked = false;
  private whisperAvailable = false;

  // ── Daemon process ──
  private daemon: ChildProcess | null = null;
  private daemonReady = false;
  private daemonStarting = false;
  private daemonModel = '';
  private daemonPid = 0;
  private rl: readline.Interface | null = null;

  // ── Task queue (strictly sequential — 1 at a time) ──
  private pending = new Map<string, PendingTask>();
  private queue: QueueItem[] = [];
  private activeTaskId: string | null = null;

  // ── Auto-restart with exponential backoff ──
  private restartAttempts = 0;
  private maxRestartAttempts = 5;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Health check ──
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private lastPong = 0;

  // ── Stats ──
  private stats = { totalTasks: 0, totalErrors: 0, daemonRestarts: 0 };

  // ═══════════════════════════════════════════════════════
  //  Public API
  // ═══════════════════════════════════════════════════════

  async transcribe(audioFilePath: string, language = 'ru'): Promise<TranscriptionResult> {
    if (!fs.existsSync(audioFilePath)) {
      throw new Error('Audio file not found');
    }

    // 1. Vosk daemon (free, offline, persistent)
    if (await this.ensureDaemon()) {
      logger.info(`Transcribing via Vosk daemon [${this.daemonModel}]...`);
      return this.enqueue(audioFilePath, language);
    }

    // 2. Groq API (free, online)
    if (process.env.GROQ_API_KEY) {
      logger.info('Transcribing via Groq API (free)...');
      return this.transcribeWhisperAPI(
        audioFilePath, language, process.env.GROQ_API_KEY,
        'https://api.groq.com/openai/v1/audio/transcriptions',
        'whisper-large-v3-turbo'
      );
    }

    // 3. OpenAI Whisper API (paid)
    if (process.env.OPENAI_API_KEY) {
      logger.info('Transcribing via OpenAI Whisper API...');
      return this.transcribeWhisperAPI(
        audioFilePath, language, process.env.OPENAI_API_KEY,
        'https://api.openai.com/v1/audio/transcriptions',
        'whisper-1'
      );
    }

    // 4. Local whisper CLI
    if (await this.checkWhisperCLI()) {
      logger.info('Transcribing via local Whisper CLI...');
      return this.transcribeWhisperCLI(audioFilePath, language);
    }

    throw new Error(
      'Transcription not configured. Free options:\n' +
      '  Offline: pip install vosk (Python 3.9+ required)\n' +
      '  Groq API: Set GROQ_API_KEY in .env (free key at console.groq.com)'
    );
  }

  /** Graceful shutdown — call on server exit. */
  shutdown(): void {
    this.stopHealthCheck();
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    this.maxRestartAttempts = 0; // prevent auto-restart
    this.sendDaemonCommand('shutdown');
    setTimeout(() => { try { this.daemon?.kill('SIGKILL'); } catch {} }, 3000);
    this.cleanupDaemon('shutdown');
  }

  /** Send a user correction to the Vosk daemon for learning. */
  learnCorrection(original: string, corrected: string): void {
    if (!original || !corrected || original.trim() === corrected.trim()) return;
    try {
      if (this.daemon?.stdin?.writable && this.daemonReady) {
        this.daemon.stdin.write(JSON.stringify({ cmd: 'learn', original: original.trim(), corrected: corrected.trim() }) + '\n');
        logger.info(`Vosk learn: correction applied (${original.trim().length} → ${corrected.trim().length} chars)`);
      }
    } catch (e) {
      logger.warn('Failed to send learn command to daemon:', e);
    }
  }

  getStats() {
    return {
      ...this.stats,
      daemonAlive: this.daemonReady,
      daemonModel: this.daemonModel,
      daemonPid: this.daemonPid,
      queueLength: this.queue.length,
      activeTask: !!this.activeTaskId,
    };
  }

  // ═══════════════════════════════════════════════════════
  //  Daemon lifecycle
  // ═══════════════════════════════════════════════════════

  private async ensureDaemon(): Promise<boolean> {
    if (this.daemonReady) return true;
    if (this.daemonStarting) {
      // Wait for in-progress startup (up to 60s)
      return this.waitForDaemon();
    }

    // Check prerequisites once
    if (!this.pythonChecked) {
      this.pythonChecked = true;
      this.pythonPath = await this.findPython();
      if (!this.pythonPath) {
        logger.info('Python not found — Vosk daemon disabled.');
        return false;
      }
      try {
        const env = { ...process.env, PYTHONPATH: (process.env.PYTHONPATH || '') + '' };
        await execAsync(`"${this.pythonPath}" -c "import vosk; print('ok')"`, { timeout: 30000, env });
        this.voskAvailable = true;
        logger.info('Vosk Python module OK');
      } catch (err: any) {
        logger.info(`Vosk Python module check failed: ${err.message}. Run: pip install vosk`);
        return false;
      }
    }

    if (!this.voskAvailable || !this.pythonPath) return false;
    if (!fs.existsSync(this.daemonScriptPath)) {
      logger.error(`Daemon script missing: ${this.daemonScriptPath}`);
      return false;
    }

    try {
      await this.spawnDaemon();
      return this.daemonReady;
    } catch (e: any) {
      logger.error('Daemon start failed:', e.message);
      return false;
    }
  }

  /** Wait for an already-starting daemon (another call triggered it). */
  private waitForDaemon(): Promise<boolean> {
    return new Promise(resolve => {
      const check = setInterval(() => {
        if (this.daemonReady) { clearInterval(check); resolve(true); }
        if (!this.daemonStarting && !this.daemonReady) { clearInterval(check); resolve(false); }
      }, 200);
      // Max 180s wait (large model can take time to mmap)
      setTimeout(() => { clearInterval(check); resolve(this.daemonReady); }, 180000);
    });
  }

  private spawnDaemon(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.daemonReady) { resolve(); return; }
      if (!this.pythonPath) { reject(new Error('No python')); return; }

      this.daemonStarting = true;
      logger.info('Spawning Vosk daemon process...');

      // nice -n 10: lower priority so transcription doesn't starve the main server
      const useNice = process.platform !== 'win32';
      const cmd = useNice ? 'nice' : this.pythonPath;
      const args = useNice
        ? ['-n', '10', this.pythonPath, '-u', this.daemonScriptPath]
        : ['-u', this.daemonScriptPath];

      const proc = spawn(cmd, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONPATH: (process.env.PYTHONPATH || '') + '' },
      });

      this.daemon = proc;
      let resolved = false;

      // Stderr — log but don't fail
      proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) logger.debug(`Vosk daemon stderr: ${text.slice(0, 300)}`);
      });

      // Stdout — JSON line protocol
      this.rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });
      this.rl.on('line', (line: string) => this.handleDaemonLine(line, () => {
        if (!resolved) { resolved = true; resolve(); }
      }));

      proc.on('exit', (code, signal) => {
        logger.warn(`Vosk daemon exited (code=${code}, signal=${signal})`);
        this.handleDaemonExit();
        if (!resolved) { resolved = true; reject(new Error(`Daemon exited during startup (code=${code})`)); }
      });

      proc.on('error', (err) => {
        logger.error('Vosk daemon spawn error:', err.message);
        this.cleanupDaemon('spawn-error');
        if (!resolved) { resolved = true; reject(err); }
      });

      // Startup timeout: 60s (large model mmap can be slow on first load)
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          logger.error('Vosk daemon startup timeout (60s)');
          this.sendDaemonCommand('shutdown');
          setTimeout(() => { try { this.daemon?.kill('SIGKILL'); } catch {} }, 2000);
          this.cleanupDaemon('timeout');
          reject(new Error('Daemon startup timeout'));
        }
      }, 60000);
    });
  }

  private handleDaemonLine(line: string, onReady: () => void): void {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }

    // ── Startup messages ──
    if (msg.status === 'loading') {
      logger.info(`Vosk daemon: loading model "${msg.model}" (${msg.reason || 'auto'})`);
      return;
    }

    if (msg.status === 'ready') {
      this.daemonReady = true;
      this.daemonStarting = false;
      this.daemonModel = msg.model || '';
      this.daemonPid = msg.pid || 0;
      this.restartAttempts = 0; // successful start resets backoff
      logger.info(`Vosk daemon READY — model: ${this.daemonModel}, reason: ${msg.reason || '?'}, pid: ${this.daemonPid}, load: ${msg.load_time_sec}s, ffmpeg: ${msg.ffmpeg}`);
      this.startHealthCheck();
      onReady();
      // Process any queued tasks that arrived while daemon was starting
      this.processQueue();
      return;
    }

    if (msg.fatal) {
      logger.error(`Vosk daemon FATAL: ${msg.error}`);
      this.sendDaemonCommand('shutdown');
      this.cleanupDaemon('fatal');
      return;
    }

    // ── Task response ──
    if (msg.id) {
      const task = this.pending.get(msg.id);
      if (!task) return;

      clearTimeout(task.timer);
      this.pending.delete(msg.id);
      this.activeTaskId = null;

      if (msg.error) {
        this.stats.totalErrors++;
        logger.warn(`Vosk task ${msg.id} error (${msg.elapsed_sec}s): ${msg.error}`);
        task.reject(new Error(`Vosk: ${msg.error}`));
      } else {
        this.stats.totalTasks++;
        const textLen = (msg.text || '').length;
        logger.info(`Vosk task ${msg.id} OK (${msg.elapsed_sec}s): ${textLen} chars`);
        task.resolve({ text: msg.text || '', language: msg.language || task.language });
      }

      // Next in queue
      this.processQueue();
      return;
    }

    // ── Health response ──
    if (msg.cmd === 'pong') {
      this.lastPong = Date.now();
    }
  }

  private handleDaemonExit(): void {
    const hadPending = this.pending.size > 0 || this.queue.length > 0;
    this.cleanupDaemon('exit');

    // Reject all in-flight tasks
    for (const [, task] of this.pending) {
      clearTimeout(task.timer);
      task.reject(new Error('Vosk daemon process exited unexpectedly'));
    }
    this.pending.clear();
    this.activeTaskId = null;

    // If there are queued items, try auto-restart
    if (hadPending && this.restartAttempts < this.maxRestartAttempts) {
      this.scheduleRestart();
    } else {
      // Reject remaining queue
      for (const item of this.queue) {
        item.reject(new Error('Vosk daemon crashed and will not restart'));
      }
      this.queue = [];
    }
  }

  private scheduleRestart(): void {
    this.restartAttempts++;
    this.stats.daemonRestarts++;
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s
    const delay = Math.min(1000 * Math.pow(2, this.restartAttempts - 1), 16000);
    logger.info(`Vosk daemon auto-restart #${this.restartAttempts} in ${delay}ms (${this.queue.length} tasks waiting)`);

    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      try {
        await this.spawnDaemon();
        // processQueue() is called from handleDaemonLine on 'ready'
      } catch (e: any) {
        logger.error(`Vosk daemon restart #${this.restartAttempts} failed: ${e.message}`);
        // Reject all remaining queue
        for (const item of this.queue) {
          item.reject(new Error(`Vosk daemon restart failed: ${e.message}`));
        }
        this.queue = [];
      }
    }, delay);
  }

  // ═══════════════════════════════════════════════════════
  //  Task queue — strictly one at a time
  // ═══════════════════════════════════════════════════════

  private enqueue(file: string, language: string): Promise<TranscriptionResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ file, language, resolve, reject });

      const pos = this.queue.length;
      if (pos > 1) {
        logger.info(`Vosk: queued task #${pos} (${path.basename(file)})`);
      }

      this.processQueue();
    });
  }

  private processQueue(): void {
    if (this.activeTaskId) return;          // One at a time
    if (this.queue.length === 0) return;
    if (!this.daemonReady || !this.daemon?.stdin?.writable) return;

    const item = this.queue.shift()!;
    const id = crypto.randomUUID();
    this.activeTaskId = id;

    // Per-task timeout: 120s
    const timer = setTimeout(() => {
      if (this.pending.has(id)) {
        this.pending.delete(id);
        this.activeTaskId = null;
        logger.warn(`Vosk task ${id} timed out (120s)`);
        item.reject(new Error('Vosk: transcription timeout (120s)'));
        this.processQueue();
      }
    }, 120_000);

    this.pending.set(id, {
      id, resolve: item.resolve, reject: item.reject, timer, language: item.language,
    });

    const msg = JSON.stringify({ id, file: item.file, language: item.language }) + '\n';
    try {
      this.daemon.stdin!.write(msg);
    } catch (e: any) {
      clearTimeout(timer);
      this.pending.delete(id);
      this.activeTaskId = null;
      item.reject(new Error(`Failed to write to daemon: ${e.message}`));
      this.processQueue();
    }
  }

  // ═══════════════════════════════════════════════════════
  //  Health check — ping every 30s, restart if no pong
  // ═══════════════════════════════════════════════════════

  private startHealthCheck(): void {
    this.stopHealthCheck();
    this.lastPong = Date.now();

    this.healthInterval = setInterval(() => {
      if (!this.daemonReady || !this.daemon) return;

      // If no pong for 90s, daemon is stuck
      if (Date.now() - this.lastPong > 90_000) {
        logger.error('Vosk daemon unresponsive (no pong for 90s), killing...');
        try { this.daemon.kill('SIGKILL'); } catch {}
        return;
      }

      this.sendDaemonCommand('ping');
    }, 30_000);
  }

  private stopHealthCheck(): void {
    if (this.healthInterval) { clearInterval(this.healthInterval); this.healthInterval = null; }
  }

  // ═══════════════════════════════════════════════════════
  //  Daemon helpers
  // ═══════════════════════════════════════════════════════

  private sendDaemonCommand(cmd: string): void {
    try {
      if (this.daemon?.stdin?.writable) {
        this.daemon.stdin.write(JSON.stringify({ cmd }) + '\n');
      }
    } catch { /* ignore */ }
  }

  private cleanupDaemon(reason: string): void {
    this.stopHealthCheck();
    this.daemonReady = false;
    this.daemonStarting = false;
    this.daemonPid = 0;
    if (this.rl) { try { this.rl.close(); } catch {} this.rl = null; }
    this.daemon = null;
    logger.debug(`Vosk daemon cleaned up (reason: ${reason})`);
  }

  private async findPython(): Promise<string | null> {
    const candidates = ['python3', 'python'];
    if (process.platform === 'win32') {
      candidates.unshift(
        'C:\\Python39\\python.exe', 'C:\\Python310\\python.exe',
        'C:\\Python311\\python.exe', 'C:\\Python312\\python.exe',
      );
      const appData = process.env.LOCALAPPDATA || '';
      if (appData) {
        for (const ver of ['39', '310', '311', '312']) {
          candidates.push(path.join(appData, 'Programs', 'Python', `Python${ver}`, 'python.exe'));
        }
      }
    }

    for (const pyPath of candidates) {
      try {
        const { stdout } = await execAsync(`"${pyPath}" --version`, { timeout: 5000 });
        if (stdout.includes('Python')) {
          logger.info(`Python found: ${pyPath} — ${stdout.trim()}`);
          return pyPath;
        }
      } catch { /* next */ }
    }
    return null;
  }

  // =====================================================
  //  Whisper API (OpenAI / Groq)
  // =====================================================

  private async transcribeWhisperAPI(
    filePath: string,
    language: string,
    apiKey: string,
    apiUrl: string,
    model: string
  ): Promise<TranscriptionResult> {
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const ext = path.extname(fileName).toLowerCase();

    const mimeMap: Record<string, string> = {
      '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
      '.webm': 'audio/webm', '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav', '.m4a': 'audio/mp4',
      '.flac': 'audio/flac',
    };

    const formData = new FormData();
    formData.append('file', new Blob([fileBuffer], { type: mimeMap[ext] || 'audio/ogg' }), fileName);
    formData.append('model', model);
    if (language) formData.append('language', language);

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });

    if (!response.ok) {
      const body = await response.text();
      logger.error('API error:', response.status, body);
      throw new Error(`API ${response.status}: ${body.slice(0, 200)}`);
    }

    const result = (await response.json()) as { text: string };
    return { text: (result.text || '').trim(), language };
  }

  // =====================================================
  //  Local Whisper CLI
  // =====================================================

  private async transcribeWhisperCLI(
    filePath: string,
    language: string
  ): Promise<TranscriptionResult> {
    const tmpDir = path.join(process.cwd(), 'storage', 'temp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const baseName = path.basename(filePath, path.extname(filePath));

    try {
      await execAsync(
        `whisper "${filePath}" --language ${language} --model base --output_format txt --output_dir "${tmpDir}"`,
        { timeout: 120_000 }
      );

      const txtPath = path.join(tmpDir, `${baseName}.txt`);
      if (fs.existsSync(txtPath)) {
        const text = fs.readFileSync(txtPath, 'utf-8').trim();
        try { fs.unlinkSync(txtPath); } catch {}
        return { text, language };
      }

      throw new Error('Whisper did not create output file');
    } catch (error: any) {
      if (error.killed) throw new Error('Whisper: timeout (> 120s)');
      throw new Error(`Whisper CLI: ${error.message?.slice(0, 300)}`);
    }
  }

  private async checkWhisperCLI(): Promise<boolean> {
    if (this.whisperChecked) return this.whisperAvailable;
    this.whisperChecked = true;

    try {
      await execAsync('whisper --help', { timeout: 10_000 });
      this.whisperAvailable = true;
      logger.info('Whisper CLI detected');
    } catch {
      this.whisperAvailable = false;
    }

    return this.whisperAvailable;
  }
}

export const transcriptionService = new TranscriptionService();
