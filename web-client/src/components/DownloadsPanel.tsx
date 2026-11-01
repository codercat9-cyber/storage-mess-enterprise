import { useDownloadStore, downloadEta, type DownloadItem } from '@/store/fileDownloads';
import { formatBytes } from '@/lib/format';
import { Download, X, FolderOpen, CheckCircle2, AlertTriangle } from 'lucide-react';

/**
 * Панель скачиваний настольного приложения.
 *
 * Показываем только когда есть что показывать. В браузере не появляется
 * вовсе: там за скачивание отвечает сам браузер и вторая полоска рядом с
 * его собственной только мешала бы.
 */

function humanEta(sec: number | null): string {
  if (sec === null) return '';
  if (sec < 60) return `${sec} с`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} мин`;
  return `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

function Row({ item }: { item: DownloadItem }) {
  const api = (window as any).electronAPI;
  const running = item.state === 'started' || item.state === 'progressing' || item.state === 'paused';
  const percent = item.total > 0 ? Math.min(100, Math.round((item.received / item.total) * 100)) : 0;
  const eta = humanEta(downloadEta(item));

  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <div className="w-9 h-9 rounded-lg bg-primary-500/10 flex items-center justify-center shrink-0">
        {item.state === 'completed'
          ? <CheckCircle2 size={18} className="text-green-500" />
          : item.state === 'cancelled' || item.state === 'interrupted'
            ? <AlertTriangle size={18} className="text-amber-500" />
            : <Download size={18} className="text-primary-500" />}
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-[13px] text-messenger-text truncate" title={item.path || item.filename}>
          {item.filename}
        </p>

        {running && (
          <>
            <div className="h-1 rounded-full bg-messenger-border/60 mt-1.5 overflow-hidden">
              <div
                className="h-full bg-primary-500 transition-[width] duration-200"
                style={{ width: item.total > 0 ? `${percent}%` : '35%' }}
              />
            </div>
            <p className="text-[11px] text-messenger-muted mt-1">
              {item.total > 0
                ? `${formatBytes(item.received)} из ${formatBytes(item.total)}`
                : formatBytes(item.received)}
              {item.speed > 0 && ` · ${formatBytes(item.speed)}/с`}
              {eta && ` · осталось ${eta}`}
            </p>
          </>
        )}

        {item.state === 'completed' && (
          <p className="text-[11px] text-messenger-muted mt-0.5">
            {formatBytes(item.received)} · в папке «Загрузки»
          </p>
        )}

        {(item.state === 'cancelled' || item.state === 'interrupted') && (
          <p className="text-[11px] text-amber-500 mt-0.5">
            {item.state === 'cancelled' ? 'Отменено' : 'Прервано — связь оборвалась'}
          </p>
        )}
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {item.state === 'completed' && item.path && (
          <>
            <button
              type="button"
              title="Открыть файл"
              onClick={() => api?.openDownloaded?.(item.path)}
              className="p-1.5 rounded-lg hover:bg-messenger-hover text-messenger-muted hover:text-primary-500 transition-colors"
            >
              <Download size={15} />
            </button>
            <button
              type="button"
              title="Показать в папке"
              onClick={() => api?.revealDownloaded?.(item.path)}
              className="p-1.5 rounded-lg hover:bg-messenger-hover text-messenger-muted hover:text-primary-500 transition-colors"
            >
              <FolderOpen size={15} />
            </button>
          </>
        )}

        <button
          type="button"
          title={running ? 'Отменить' : 'Убрать из списка'}
          onClick={() => {
            if (running) api?.cancelDownload?.(item.id);
            else useDownloadStore.getState().remove(item.id);
          }}
          className="p-1.5 rounded-lg hover:bg-messenger-hover text-messenger-muted hover:text-red-400 transition-colors"
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
}

export default function DownloadsPanel() {
  const items = useDownloadStore(s => s.items);
  if (items.length === 0) return null;

  const running = items.filter(i => i.state === 'started' || i.state === 'progressing' || i.state === 'paused').length;

  return (
    <div className="fixed bottom-4 right-4 z-[9998] w-[340px] max-w-[calc(100vw-2rem)]">
      <div className="rounded-2xl border border-messenger-border/60 bg-messenger-bg/95 backdrop-blur-xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 border-b border-messenger-border/50">
          <p className="text-[12px] font-medium text-messenger-muted uppercase tracking-wider">
            {running > 0 ? `Скачивание (${running})` : 'Скачано'}
          </p>
          <button
            type="button"
            onClick={() => useDownloadStore.getState().clearFinished()}
            className="text-[11px] text-messenger-muted hover:text-primary-500 transition-colors"
          >
            Очистить
          </button>
        </div>
        <div className="max-h-[300px] overflow-y-auto divide-y divide-messenger-border/40">
          {items.map(item => <Row key={item.id} item={item} />)}
        </div>
      </div>
    </div>
  );
}
