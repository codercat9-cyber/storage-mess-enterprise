import { useState, useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, X, Copy, Trash2, Bug, Wrench, AlertTriangle, Info, CheckCircle } from 'lucide-react';

interface LogEntry {
  id: string;
  timestamp: string;
  level: 'log' | 'info' | 'warn' | 'error';
  message: string;
  data?: unknown;
  suggestion?: string;
}

// Паттерны ошибок → рекомендации по ремонту на русском
const REPAIR_SUGGESTIONS: Array<{ pattern: RegExp; suggestion: string }> = [
  { pattern: /Failed to fetch|fetch.*failed|NetworkError|ERR_NETWORK/i, suggestion: '🔧 Проверь интернет-соединение. Если VPN/прокси — попробуй отключить или сменить сервер.' },
  { pattern: /WebSocket.*closed|socket.*disconnect|connection.*lost/i, suggestion: '🔧 Соединение с сервером потеряно. Обычно переподключение автоматическое. Проверь Wi-Fi/мобильную сеть.' },
  { pattern: /CORS|Access-Control|blocked by CORS/i, suggestion: '🔧 Ошибка CORS — сервер не разрешает запросы с этого домена. Обратись к администратору.' },
  { pattern: /401|Unauthorized|token.*expired|jwt.*expired/i, suggestion: '🔧 Сессия истекла. Перелогинься — Настройки → Выйти → Войти заново.' },
  { pattern: /403|Forbidden/i, suggestion: '🔧 Доступ запрещён. Возможно, у тебя нет прав на это действие.' },
  { pattern: /404|Not Found/i, suggestion: '🔧 Ресурс не найден. Возможно, он был удалён или URL неверный.' },
  { pattern: /500|Internal Server Error/i, suggestion: '🔧 Ошибка на сервере. Попробуй повторить через минуту. Если повторяется — сообщи администратору.' },
  { pattern: /timeout|ETIMEDOUT|ECONNABORTED/i, suggestion: '🔧 Таймаут соединения. Сервер не отвечает — проверь сеть или попробуй позже.' },
  { pattern: /quota.*exceeded|storage.*full|IndexedDB/i, suggestion: '🔧 Память браузера переполнена. Очисти кэш: Настройки браузера → Данные сайтов → Удалить.' },
  { pattern: /permission.*denied|NotAllowedError/i, suggestion: '🔧 Нет разрешения. Проверь настройки: камера, микрофон, уведомления в разрешениях браузера/приложения.' },
  { pattern: /microphone|getUserMedia|audio.*input/i, suggestion: '🔧 Проблема с микрофоном. Проверь: разрешён ли доступ, подключён ли микрофон, не занят ли другим приложением.' },
  { pattern: /camera|video.*input/i, suggestion: '🔧 Проблема с камерой. Проверь разрешения и что камера не используется другим приложением.' },
  { pattern: /SSL|TLS|certificate|cert.*invalid|ERR_CERT/i, suggestion: '🔧 Проблема с SSL-сертификатом. Проверь дату/время на устройстве. Если самоподписанный серт — добавь исключение.' },
  { pattern: /DNS|ENOTFOUND|name.*resolution/i, suggestion: '🔧 DNS не может найти сервер. Попробуй сменить DNS на 8.8.8.8 или 77.88.8.8 (Яндекс).' },
  { pattern: /Bluetooth|BLE|GATT/i, suggestion: '🔧 Ошибка Bluetooth. Проверь: включён ли BT, поддерживает ли устройство BLE, есть ли разрешение на местоположение.' },
  { pattern: /out of memory|heap|allocation/i, suggestion: '🔧 Нехватка памяти. Закрой лишние вкладки/приложения. Если проблема постоянная — перезагрузи приложение.' },
  { pattern: /chunk.*failed|loading.*chunk|dynamic.*import/i, suggestion: '🔧 Не удалось загрузить часть приложения. Обнови страницу (Ctrl+Shift+R) для загрузки новой версии.' },
  { pattern: /Unhandled Promise Rejection/i, suggestion: '🔧 Необработанная ошибка в async-коде. Если повторяется — сообщи разработчику с текстом ошибки.' },
  { pattern: /ResizeObserver/i, suggestion: 'ℹ️ Безвредная ошибка ResizeObserver — можно игнорировать, не влияет на работу.' },
  { pattern: /hydrat|mismatch/i, suggestion: 'ℹ️ Ошибка гидрации — обнови страницу.' },
];

function getSuggestion(message: string): string | undefined {
  for (const { pattern, suggestion } of REPAIR_SUGGESTIONS) {
    if (pattern.test(message)) return suggestion;
  }
  return undefined;
}

let logId = 0;

// Глобальные счётчики для доступа из SettingsPage
let _globalErrors = 0;
let _globalWarns = 0;
let _globalTotal = 0;

export function getDebugStats() {
  return { errors: _globalErrors, warnings: _globalWarns, total: _globalTotal };
}

export default function DebugConsole() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [filter, setFilter] = useState<'all' | 'log' | 'info' | 'warn' | 'error'>('all');
  const [showSuggestions, setShowSuggestions] = useState(true);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Открытие консоли из настроек (событие 'open-debug-console')
  useEffect(() => {
    const handleOpen = () => {
      setIsVisible(true);
      setIsOpen(true);
    };
    window.addEventListener('open-debug-console', handleOpen);
    return () => window.removeEventListener('open-debug-console', handleOpen);
  }, []);

  // Перехватываем console методы
  useEffect(() => {
    const originalLog = console.log;
    const originalInfo = console.info;
    const originalWarn = console.warn;
    const originalError = console.error;

    const addLog = (level: 'log' | 'info' | 'warn' | 'error', ...args: unknown[]) => {
      const message = args.map(arg => {
        if (typeof arg === 'object') {
          try {
            return JSON.stringify(arg, null, 2);
          } catch {
            return String(arg);
          }
        }
        return String(arg);
      }).join(' ');

      const suggestion = (level === 'error' || level === 'warn') ? getSuggestion(message) : undefined;

      const entry: LogEntry = {
        id: `log-${logId++}`,
        timestamp: new Date().toLocaleTimeString('ru-RU', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        level,
        message,
        data: args.length > 1 ? args : undefined,
        suggestion,
      };

      _globalTotal++;
      if (level === 'error') _globalErrors++;
      if (level === 'warn') _globalWarns++;

      setLogs(prev => [...prev.slice(-499), entry]);
    };

    console.log = (...args) => {
      originalLog(...args);
      addLog('log', ...args);
    };

    console.info = (...args) => {
      originalInfo(...args);
      addLog('info', ...args);
    };

    console.warn = (...args) => {
      originalWarn(...args);
      addLog('warn', ...args);
    };

    console.error = (...args) => {
      originalError(...args);
      addLog('error', ...args);
    };

    const handleError = (event: ErrorEvent) => {
      addLog('error', `Необработанная ошибка: ${event.error?.message || event.message}`);
    };

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      addLog('error', `Необработанный промис:`, event.reason);
    };

    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleUnhandledRejection);

    return () => {
      console.log = originalLog;
      console.info = originalInfo;
      console.warn = originalWarn;
      console.error = originalError;
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
    };
  }, []);

  useEffect(() => {
    if (isOpen) {
      logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, isOpen]);

  const filteredLogs = logs.filter(log => filter === 'all' || log.level === filter);
  const errorCount = logs.filter(l => l.level === 'error').length;
  const warnCount = logs.filter(l => l.level === 'warn').length;

  const getLevelColor = (level: string) => {
    switch (level) {
      case 'error': return 'text-red-400 bg-red-500/10 border-l-2 border-red-500';
      case 'warn': return 'text-yellow-400 bg-yellow-500/10 border-l-2 border-yellow-500';
      case 'info': return 'text-blue-400 bg-blue-500/10 border-l-2 border-blue-500';
      default: return 'text-gray-400 bg-gray-500/5 border-l-2 border-gray-600';
    }
  };

  const getLevelLabel = (level: string) => {
    switch (level) {
      case 'error': return 'ОШИБКА';
      case 'warn': return 'ВНИМАНИЕ';
      case 'info': return 'ИНФО';
      default: return 'ЛОГ';
    }
  };

  const getFilterLabel = (f: string) => {
    switch (f) {
      case 'all': return 'Все';
      case 'error': return 'Ошибки';
      case 'warn': return 'Предупр.';
      case 'info': return 'Инфо';
      case 'log': return 'Логи';
      default: return f;
    }
  };

  const copyToClipboard = () => {
    const text = filteredLogs
      .map(log => {
        let line = `[${log.timestamp}] ${getLevelLabel(log.level)}: ${log.message}`;
        if (log.suggestion) line += `\n  → ${log.suggestion}`;
        return line;
      })
      .join('\n');
    navigator.clipboard.writeText(text);
  };

  const clearLogs = () => {
    setLogs([]);
    logId = 0;
    _globalErrors = 0;
    _globalWarns = 0;
    _globalTotal = 0;
  };

  // Скрытое состояние — вообще ничего не рендерим (никаких иконок на экране)
  if (!isVisible) {
    return null;
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50">
      {/* Заголовок */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`w-full py-2 px-4 flex items-center justify-between border-t ${
          isOpen
            ? 'bg-messenger-sidebar border-messenger-border'
            : 'bg-gray-900 border-gray-700'
        }`}
      >
        <div className="flex items-center gap-3">
          <Bug className="w-4 h-4 text-gray-400" />
          <span className="font-mono font-medium text-sm text-messenger-text">Консоль отладки</span>
          {errorCount > 0 && (
            <span className="px-2 py-0.5 bg-red-500/20 text-red-400 text-xs rounded-full font-mono">
              {errorCount} ошиб.
            </span>
          )}
          {warnCount > 0 && (
            <span className="px-2 py-0.5 bg-yellow-500/20 text-yellow-400 text-xs rounded-full font-mono">
              {warnCount} предупр.
            </span>
          )}
          <span className="text-xs text-gray-500">всего: {logs.length}</span>
        </div>
        <div className="flex items-center gap-1">
          <span
            role="button"
            onClick={(e) => {
              e.stopPropagation();
              setIsVisible(false);
              setIsOpen(false);
            }}
            className="p-1 hover:bg-gray-700 text-gray-400 hover:text-gray-200 rounded cursor-pointer"
            title="Закрыть консоль"
          >
            <X size={16} />
          </span>
          {isOpen ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
        </div>
      </button>

      {/* Консоль */}
      {isOpen && (
        <div className="bg-gray-950 border-t border-messenger-border max-h-80 flex flex-col">
          {/* Тулбар */}
          <div className="flex items-center gap-1.5 p-2 bg-gray-900 border-b border-messenger-border flex-wrap">
            {(['all', 'log', 'info', 'warn', 'error'] as const).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-2.5 py-1 text-xs rounded font-mono transition-colors ${
                  filter === f
                    ? 'bg-primary-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                }`}
              >
                {getFilterLabel(f)}
              </button>
            ))}
            <div className="flex-1" />
            <button
              onClick={() => setShowSuggestions(!showSuggestions)}
              className={`p-1 rounded transition-colors ${showSuggestions ? 'bg-primary-600/30 text-primary-400' : 'text-gray-500 hover:text-gray-200'}`}
              title={showSuggestions ? 'Скрыть подсказки' : 'Показать подсказки'}
            >
              <Wrench size={15} />
            </button>
            <button
              onClick={copyToClipboard}
              className="p-1 hover:bg-gray-800 text-gray-400 hover:text-gray-200 rounded"
              title="Копировать логи"
            >
              <Copy size={15} />
            </button>
            <button
              onClick={clearLogs}
              className="p-1 hover:bg-gray-800 text-gray-400 hover:text-red-400 rounded"
              title="Очистить всё"
            >
              <Trash2 size={15} />
            </button>
            <button
              onClick={() => { setIsVisible(false); setIsOpen(false); }}
              className="p-1 hover:bg-gray-800 text-gray-400 hover:text-gray-200 rounded"
              title="Закрыть"
            >
              <X size={15} />
            </button>
          </div>

          {/* Сводка */}
          {(errorCount > 0 || warnCount > 0) && (
            <div className="px-3 py-1.5 bg-gray-900/50 border-b border-messenger-border flex items-center gap-4 text-xs">
              <span className="text-gray-500">Сводка:</span>
              {errorCount > 0 && (
                <span className="flex items-center gap-1 text-red-400">
                  <AlertTriangle size={12} /> {errorCount} {errorCount === 1 ? 'ошибка' : errorCount < 5 ? 'ошибки' : 'ошибок'}
                </span>
              )}
              {warnCount > 0 && (
                <span className="flex items-center gap-1 text-yellow-400">
                  <Info size={12} /> {warnCount} {warnCount === 1 ? 'предупреждение' : warnCount < 5 ? 'предупреждения' : 'предупреждений'}
                </span>
              )}
            </div>
          )}

          {/* Логи */}
          <div className="flex-1 overflow-y-auto font-mono text-xs space-y-0.5 p-2">
            {filteredLogs.length === 0 ? (
              <div className="text-gray-500 text-center py-8">
                {logs.length === 0 ? 'Логов пока нет' : `Нет записей типа «${getFilterLabel(filter)}»`}
              </div>
            ) : (
              filteredLogs.map(log => (
                <div key={log.id} className="space-y-0.5">
                  <div className={`flex gap-2 p-1.5 rounded ${getLevelColor(log.level)}`}>
                    <span className="text-gray-500 flex-shrink-0">{log.timestamp}</span>
                    <span className="font-bold flex-shrink-0 w-[72px] text-[10px] leading-4">{getLevelLabel(log.level)}</span>
                    <span className="break-all flex-1">{log.message}</span>
                  </div>
                  {showSuggestions && log.suggestion && (
                    <div className="ml-6 px-3 py-1.5 bg-primary-500/10 border border-primary-500/20 rounded text-primary-300 text-[11px] leading-4">
                      {log.suggestion}
                    </div>
                  )}
                </div>
              ))
            )}
            <div ref={logsEndRef} />
          </div>
        </div>
      )}
    </div>
  );
}
