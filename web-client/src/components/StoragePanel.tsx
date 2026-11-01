import { useState, useEffect, useCallback, useRef } from 'react';
import { formatBytes } from '../lib/format';
import { fileApi } from '@/lib/api';
import { useUploadStore, etaSeconds } from '@/store/uploads';
import { downloadFileNative } from '@/lib/capacitor-bridge';
import { FileInfo } from '@/types';
import {
  X,
  Upload,
  Trash2,
  Download,
  Share2,
  File,
  Image,
  Film,
  Music,
  FileText,
  HardDrive,
  Search,
  Check,
  Copy,
  Globe,
  Lock,
  ChevronDown,
  Loader2,
  FileArchive,
  FolderOpen,
  Users,
} from 'lucide-react';

interface StoragePanelProps {
  onClose: () => void;
}

interface UploadItem {
  name: string;
  progress: number;
  done: boolean;
  error?: boolean;
}

type TabType = 'my' | 'public';



function getFileIcon(mimeType?: string, fileName?: string) {
  if (fileName) {
    const ext = fileName.split('.').pop()?.toLowerCase();
    if (ext === 'zip' || ext === 'rar' || ext === '7z' || ext === 'tar' || ext === 'gz' || ext === 'bz2') return FileArchive;
  }
  if (!mimeType) return File;
  if (mimeType.startsWith('image/')) return Image;
  if (mimeType.startsWith('video/')) return Film;
  if (mimeType.startsWith('audio/')) return Music;
  if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('archive') || mimeType.includes('compressed') || mimeType.includes('7z')) return FileArchive;
  if (mimeType.includes('pdf') || mimeType.includes('text') || mimeType.includes('document')) return FileText;
  return File;
}

function getFileColor(mimeType?: string, fileName?: string): string {
  if (fileName) {
    const ext = fileName.split('.').pop()?.toLowerCase();
    if (ext === 'zip' || ext === 'rar' || ext === '7z' || ext === 'tar' || ext === 'gz' || ext === 'bz2') return 'text-orange-400';
  }
  if (!mimeType) return 'text-gray-400';
  if (mimeType.startsWith('image/')) return 'text-green-400';
  if (mimeType.startsWith('video/')) return 'text-purple-400';
  if (mimeType.startsWith('audio/')) return 'text-yellow-400';
  if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('archive') || mimeType.includes('compressed') || mimeType.includes('7z')) return 'text-orange-400';
  if (mimeType.includes('pdf')) return 'text-red-400';
  return 'text-blue-400';
}

export default function StoragePanel({ onClose }: StoragePanelProps) {
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [publicFiles, setPublicFiles] = useState<FileInfo[]>([]);
  const [activeTab, setActiveTab] = useState<TabType>('my');
  const [stats, setStats] = useState<{
    totalFiles: number;
    totalSize: number;
    diskTotal: number;
    diskFree: number;
    diskUsed: number;
    userFiles: number;
    userTotalSize: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  // Подробности хода загрузки — из общего журнала, он же переживает уход
  // с этого экрана.
  const storeUploads = useUploadStore(s => s.items);
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'date' | 'size' | 'name'>('date');
  const [hasMore, setHasMore] = useState(true);
  const [hasMorePublic, setHasMorePublic] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadFiles = useCallback(async (offset = 0, append = false) => {
    try {
      const res = await fileApi.getMyFiles(50, offset);
      const newFiles = res.data.files || [];
      setFiles(prev => append ? [...prev, ...newFiles] : newFiles);
      setHasMore(newFiles.length === 50);
    } catch (e) {
      console.error('Failed to load files:', e);
    }
  }, []);

  const loadPublicFiles = useCallback(async (offset = 0, append = false) => {
    try {
      const res = await fileApi.getPublicFiles(50, offset);
      const newFiles = res.data.files || [];
      setPublicFiles(prev => append ? [...prev, ...newFiles] : newFiles);
      setHasMorePublic(newFiles.length === 50);
    } catch (e) {
      console.error('Failed to load public files:', e);
    }
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const res = await fileApi.getStats();
      setStats(res.data);
    } catch (e) {
      console.error('Failed to load stats:', e);
    }
  }, []);

  useEffect(() => {
    Promise.all([loadFiles(), loadPublicFiles(), loadStats()]).finally(() => setLoading(false));
  }, [loadFiles, loadPublicFiles, loadStats]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;

    const items: UploadItem[] = Array.from(fileList).map(f => ({ name: f.name, progress: 0, done: false }));
    setUploads(items);

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      // Дублируем в общий журнал загрузок: он переживает уход с этого
      // экрана и знает про докачку, скорость и отмену.
      const uploadId = `storage:${file.name}:${file.size}:${file.lastModified}`;
      const controller = new AbortController();
      useUploadStore.getState().start({
        id: uploadId, fileName: file.name, fileSize: file.size,
        source: 'storage', abort: () => controller.abort(),
      });
      try {
        await fileApi.smartUpload(file, (percent) => {
          setUploads(prev => prev.map((u, j) => j === i ? { ...u, progress: percent } : u));
        }, 'storage', {
          signal: controller.signal,
          onSession: (sid) => useUploadStore.getState().setSession(uploadId, sid),
          onTick: (t) => useUploadStore.getState().progress(uploadId, t.loaded, t.stage, t.percent),
        });
        useUploadStore.getState().finish(uploadId, 'done');
        setUploads(prev => prev.map((u, j) => j === i ? { ...u, progress: 100, done: true } : u));
      } catch (err: any) {
        const canceled = err?.name === 'AbortError' || err?.code === 'ERR_CANCELED';
        useUploadStore.getState().finish(uploadId, canceled ? 'canceled' : 'error', err?.message);
        if (!canceled) console.error('Upload failed:', err);
        setUploads(prev => prev.map((u, j) => j === i ? { ...u, error: !canceled, done: true } : u));
      }
    }

    await Promise.all([loadFiles(), loadPublicFiles(), loadStats()]);
    setTimeout(() => setUploads([]), 2000);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleDelete = async (fileId: string) => {
    try {
      await fileApi.deleteFile(fileId);
      setFiles(prev => prev.filter(f => f.id !== fileId));
      loadStats();
    } catch (e) {
      console.error('Delete failed:', e);
    }
  };

  const handleTogglePublic = async (fileId: string, currentPublic: boolean) => {
    try {
      await fileApi.setPublic(fileId, !currentPublic);
      setFiles(prev => prev.map(f => f.id === fileId ? { ...f, is_public: !currentPublic } : f));
      setPublicFiles(prev => {
        if (!currentPublic) {
          const file = files.find(f => f.id === fileId);
          return file ? [{ ...file, is_public: true }, ...prev] : prev;
        }
        return prev.filter(f => f.id !== fileId);
      });
    } catch (e) {
      console.error('Toggle public failed:', e);
    }
  };

  const handleCopyLink = (fileId: string) => {
    const url = fileApi.getShareUrl(fileId);
    navigator.clipboard.writeText(url).then(() => {
      setCopiedId(fileId);
      setTimeout(() => setCopiedId(null), 2000);
    });
  };

  const handleDownload = (fileId: string, fileName: string) => {
    const url = fileApi.getDownloadUrl(fileId);
    downloadFileNative(url, fileName);
  };

  // Фильтрация и сортировка
  const sourceFiles = activeTab === 'my' ? files : publicFiles;
  const filteredFiles = sourceFiles
    .filter(f => !searchQuery || f.original_name.toLowerCase().includes(searchQuery.toLowerCase()))
    .sort((a, b) => {
      if (sortBy === 'date') return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      if (sortBy === 'size') return b.size - a.size;
      return a.original_name.localeCompare(b.original_name);
    });

  const usedPercent = stats && stats.diskTotal > 0
    ? Math.round((stats.diskUsed / stats.diskTotal) * 100)
    : 0;

  const isUploading = uploads.length > 0 && uploads.some(u => !u.done);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-messenger-bg w-full max-w-2xl max-h-[85vh] rounded-2xl flex flex-col overflow-hidden shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-messenger-border">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full overflow-hidden shadow-sm flex-shrink-0">
              <img src="/storage-icon.png" alt="" className="w-full h-full object-cover" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-messenger-text">Хранилище</h2>
              {stats && (
                <p className="text-xs text-messenger-muted">
                  {formatBytes(stats.userTotalSize)} из {formatBytes(stats.diskTotal)} использовано
                </p>
              )}
            </div>
          </div>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-messenger-hover text-messenger-muted">
            <X className="w-5 h-5" />
          </button>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center p-12">
            <Loader2 className="w-8 h-8 animate-spin text-primary-500" />
          </div>
        ) : (
          <>
            {/* Storage bar */}
            {stats && stats.diskTotal > 0 && (
              <div className="px-4 pt-4">
                <div className="flex justify-between text-xs text-messenger-muted mb-1.5">
                  <span>Диск: {formatBytes(stats.diskUsed)} / {formatBytes(stats.diskTotal)}</span>
                  <span>{usedPercent}%</span>
                </div>
                <div className="w-full h-2.5 bg-messenger-hover rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      usedPercent > 90 ? 'bg-red-500' : usedPercent > 70 ? 'bg-yellow-500' : 'bg-primary-500'
                    }`}
                    style={{ width: `${usedPercent}%` }}
                  />
                </div>
                <div className="flex gap-4 mt-2 text-xs text-messenger-muted">
                  <span>Ваши файлы: <b className="text-messenger-text">{stats.userFiles}</b> ({formatBytes(stats.userTotalSize)})</span>
                  <span>Всего на сервере: <b className="text-messenger-text">{stats.totalFiles}</b> ({formatBytes(stats.totalSize)})</span>
                  <span>Свободно: <b className="text-messenger-text">{formatBytes(stats.diskFree)}</b></span>
                </div>
              </div>
            )}

            {/* Tabs */}
            <div className="flex items-center gap-0 px-4 pt-3 border-b border-messenger-border">
              <button
                onClick={() => setActiveTab('my')}
                className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === 'my'
                    ? 'border-primary-500 text-primary-500'
                    : 'border-transparent text-messenger-muted hover:text-messenger-text'
                }`}
              >
                <FolderOpen className="w-4 h-4" />
                Загруженное
              </button>
              <button
                onClick={() => setActiveTab('public')}
                className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === 'public'
                    ? 'border-primary-500 text-primary-500'
                    : 'border-transparent text-messenger-muted hover:text-messenger-text'
                }`}
              >
                <Users className="w-4 h-4" />
                Общедоступное
              </button>
            </div>

            {/* Actions bar */}
            <div className="flex items-center gap-2 px-4 py-3">
              {activeTab === 'my' && (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isUploading}
                  className="flex items-center gap-2 px-4 py-2 bg-primary-500 text-white rounded-full text-sm font-medium hover:bg-primary-600 disabled:opacity-50 transition-colors"
                >
                  {isUploading ? (
                    <><Loader2 className="w-4 h-4 animate-spin" />Загрузка...</>
                  ) : (
                    <><Upload className="w-4 h-4" />Загрузить</>
                  )}
                </button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleUpload}
              />

              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-messenger-muted" />
                <input
                  type="text"
                  placeholder="Поиск файлов..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 bg-messenger-input border border-messenger-border rounded-full text-sm text-messenger-text placeholder-messenger-muted focus:outline-none focus:border-primary-500"
                />
              </div>

              <select
                value={sortBy}
                onChange={e => setSortBy(e.target.value as 'date' | 'size' | 'name')}
                className="px-3 py-2 bg-messenger-input border border-messenger-border rounded-full text-sm text-messenger-text focus:outline-none"
              >
                <option value="date">По дате</option>
                <option value="size">По размеру</option>
                <option value="name">По имени</option>
              </select>
            </div>

            {/* Upload progress list */}
            {uploads.length > 0 && (
              <div className="px-4 pb-2 space-y-1.5">
                {uploads.map((item, i) => (
                  <div key={i} className="flex items-center gap-3 p-2 rounded-xl bg-messenger-hover/50">
                    <div className="relative w-9 h-9 flex items-center justify-center shrink-0">
                      <svg className="w-9 h-9 -rotate-90" viewBox="0 0 36 36">
                        <circle cx="18" cy="18" r="15" fill="none" stroke="currentColor" strokeWidth="2" className="text-messenger-border" />
                        <circle cx="18" cy="18" r="15" fill="none" stroke="currentColor" strokeWidth="2.5"
                          strokeDasharray={`${item.progress * 0.9425} 94.25`}
                          strokeLinecap="round"
                          className={item.error ? 'text-red-500' : item.done ? 'text-green-500' : 'text-primary-500'}
                        />
                      </svg>
                      <span className="absolute text-[9px] font-bold text-messenger-text">
                        {item.done ? (item.error ? '✕' : '✓') : `${item.progress}%`}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-messenger-text truncate">{item.name}</p>
                      {/* Подробности берём из общего журнала: сколько байт
                          ушло, с какой скоростью и сколько ждать. Раньше тут
                          было только слово «Загрузка...». */}
                      {(() => {
                        const live = storeUploads.find(u => u.fileName === item.name && u.source === 'storage');
                        if (item.error) return <p className="text-xs text-red-400">Ошибка загрузки</p>;
                        if (item.done) return <p className="text-xs text-green-500">Загружено{live ? ` · ${formatBytes(live.fileSize)}` : ''}</p>;
                        if (!live) return <p className="text-xs text-messenger-muted">Загрузка...</p>;
                        const eta = etaSeconds(live);
                        return (
                          <p className="text-xs text-messenger-muted tabular-nums">
                            {formatBytes(live.loaded)} / {formatBytes(live.fileSize)}
                            {live.speed > 0 && ` · ${formatBytes(live.speed)}/с`}
                            {eta !== null && eta > 0 && ` · осталось ${eta < 60 ? `${eta} с` : `${Math.ceil(eta / 60)} мин`}`}
                          </p>
                        );
                      })()}
                    </div>
                    {!item.done && (() => {
                      const live = storeUploads.find(u => u.fileName === item.name && u.source === 'storage');
                      if (!live || live.status !== 'uploading') return null;
                      return (
                        <button
                          onClick={() => useUploadStore.getState().cancel(live.id)}
                          title="Отменить загрузку"
                          className="p-1.5 rounded-full text-messenger-muted hover:text-red-400 hover:bg-messenger-hover shrink-0"
                        >✕</button>
                      );
                    })()}
                  </div>
                ))}
              </div>
            )}

            {/* File list */}
            <div className="flex-1 overflow-y-auto px-4 pb-4">
              {filteredFiles.length === 0 ? (
                <div className="text-center py-12 text-messenger-muted">
                  <img src="/storage-icon.png" alt="" className="w-16 h-16 mx-auto mb-3 opacity-20 grayscale object-contain" />
                  <p>{searchQuery ? 'Файлы не найдены' : activeTab === 'public' ? 'Нет общедоступных файлов' : 'Хранилище пусто'}</p>
                  {activeTab === 'my' && !searchQuery && <p className="text-xs mt-1">Загрузите файлы кнопкой выше или отправьте в чате</p>}
                </div>
              ) : (
                <div className="space-y-1">
                  {filteredFiles.map(file => {
                    const Icon = getFileIcon(file.mime_type, file.original_name);
                    const isOwn = activeTab === 'my';
                    return (
                      <div
                        key={file.id}
                        className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-messenger-hover group transition-colors"
                      >
                        <div className={`w-9 h-9 rounded-lg bg-messenger-hover flex items-center justify-center flex-shrink-0 ${getFileColor(file.mime_type, file.original_name)}`}>
                          <Icon className="w-5 h-5" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-messenger-text truncate">{file.original_name}</p>
                          <p className="text-xs text-messenger-muted">
                            {formatBytes(file.size)} · {new Date(file.created_at).toLocaleDateString('ru-RU')}
                            {file.is_public && <span className="ml-1 text-green-400">· публичный</span>}
                          </p>
                        </div>
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => handleDownload(file.id, file.original_name)}
                            className="p-1.5 rounded-lg hover:bg-messenger-input text-messenger-muted hover:text-messenger-text"
                            title="Скачать"
                          >
                            <Download className="w-4 h-4" />
                          </button>
                          {isOwn && (
                            <button
                              onClick={() => handleTogglePublic(file.id, file.is_public)}
                              className={`p-1.5 rounded-lg hover:bg-messenger-input ${file.is_public ? 'text-green-400' : 'text-messenger-muted hover:text-messenger-text'}`}
                              title={file.is_public ? 'Сделать приватным' : 'Сделать публичным'}
                            >
                              {file.is_public ? <Globe className="w-4 h-4" /> : <Lock className="w-4 h-4" />}
                            </button>
                          )}
                          <button
                            onClick={() => handleCopyLink(file.id)}
                            className="p-1.5 rounded-lg hover:bg-messenger-input text-messenger-muted hover:text-messenger-text"
                            title="Скопировать ссылку"
                          >
                            {copiedId === file.id ? <Check className="w-4 h-4 text-green-400" /> : <Share2 className="w-4 h-4" />}
                          </button>
                          {isOwn && (
                            <button
                              onClick={() => handleDelete(file.id)}
                              className="p-1.5 rounded-lg hover:bg-red-500/20 text-messenger-muted hover:text-red-400"
                              title="Удалить"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {activeTab === 'my' && hasMore && (
                    <button
                      onClick={() => loadFiles(files.length, true)}
                      className="w-full py-2 text-sm text-primary-500 hover:text-primary-400"
                    >
                      Загрузить ещё...
                    </button>
                  )}
                  {activeTab === 'public' && hasMorePublic && (
                    <button
                      onClick={() => loadPublicFiles(publicFiles.length, true)}
                      className="w-full py-2 text-sm text-primary-500 hover:text-primary-400"
                    >
                      Загрузить ещё...
                    </button>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
