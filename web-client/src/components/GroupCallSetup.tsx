import { useState, useEffect } from 'react';
import { useAuthStore } from '@/store/auth';
import { useChatStore } from '@/store/chat';
import { userApi } from '@/lib/api';
import { User } from '@/types';
import {
  X,
  Search,
  Phone,
  Video,
  Plus,
  Check,
  Users,
  Loader2,
} from 'lucide-react';

interface GroupCallSetupProps {
  onStartCall: (userIds: string[], type: 'audio' | 'video') => void;
  onClose: () => void;
}

export default function GroupCallSetup({ onStartCall, onClose }: GroupCallSetupProps) {
  const currentUser = useAuthStore((state) => state.user);
  const { chats, onlineUsers } = useChatStore();
  
  const [selectedUsers, setSelectedUsers] = useState<User[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [searching, setSearching] = useState(false);
  const [activeTab, setActiveTab] = useState<'contacts' | 'search'>('contacts');

  // Собираем контакты из существующих чатов (уникальные пользователи)
  const knownUsers: User[] = [];
  const seenIds = new Set<string>();
  for (const chat of chats) {
    for (const member of chat.members) {
      if (member.id !== currentUser?.id && !seenIds.has(member.id)) {
        seenIds.add(member.id);
        knownUsers.push(member);
      }
    }
  }

  // Сортируем — онлайн сначала
  knownUsers.sort((a, b) => {
    const aOnline = onlineUsers.has(a.id) ? 1 : 0;
    const bOnline = onlineUsers.has(b.id) ? 1 : 0;
    return bOnline - aOnline;
  });

  // Поиск пользователей
  useEffect(() => {
    if (activeTab !== 'search' || searchQuery.length < 2) {
      setSearchResults([]);
      return;
    }

    const timeout = setTimeout(async () => {
      setSearching(true);
      const cleanQuery = searchQuery.startsWith('@') ? searchQuery.slice(1) : searchQuery;
      try {
        const response = await userApi.search(cleanQuery);
        setSearchResults(
          response.data.users.filter((u: User) => u.id !== currentUser?.id)
        );
      } catch (error) {
        console.error('Search failed:', error);
      } finally {
        setSearching(false);
      }
    }, 300);

    return () => clearTimeout(timeout);
  }, [searchQuery, activeTab, currentUser?.id]);

  const toggleUser = (user: User) => {
    setSelectedUsers(prev => {
      const exists = prev.find(u => u.id === user.id);
      if (exists) return prev.filter(u => u.id !== user.id);
      return [...prev, user];
    });
  };

  const isSelected = (userId: string) => selectedUsers.some(u => u.id === userId);

  const handleStartCall = (type: 'audio' | 'video') => {
    if (selectedUsers.length === 0) return;
    onStartCall(selectedUsers.map(u => u.id), type);
  };

  const displayList = activeTab === 'search' ? searchResults : knownUsers;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-messenger-bg border border-messenger-border rounded-2xl shadow-2xl w-[420px] max-w-[95vw] max-h-[80vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-messenger-border">
          <div className="flex items-center gap-2">
            <Users size={20} className="text-primary-400" />
            <h3 className="text-lg font-semibold text-messenger-text">Групповой звонок</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-messenger-hover text-messenger-muted hover:text-messenger-text transition-colors"
            title="Закрыть"
          >
            <X size={20} />
          </button>
        </div>

        {/* Выбранные участники */}
        {selectedUsers.length > 0 && (
          <div className="px-4 py-2 border-b border-messenger-border flex flex-wrap gap-1.5">
            {selectedUsers.map(user => (
              <div
                key={user.id}
                className="flex items-center gap-1 bg-primary-600/20 text-primary-400 px-2 py-1 rounded-full text-xs"
              >
                <span className="max-w-[100px] truncate">{user.display_name || user.username}</span>
                <button
                  onClick={() => toggleUser(user)}
                  className="hover:text-primary-200 transition-colors"
                  title="Убрать"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Tabs */}
        <div className="flex border-b border-messenger-border">
          <button
            onClick={() => setActiveTab('contacts')}
            className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === 'contacts'
                ? 'text-primary-400 border-b-2 border-primary-400'
                : 'text-messenger-muted hover:text-messenger-text'
            }`}
          >
            Контакты
          </button>
          <button
            onClick={() => setActiveTab('search')}
            className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === 'search'
                ? 'text-primary-400 border-b-2 border-primary-400'
                : 'text-messenger-muted hover:text-messenger-text'
            }`}
          >
            Поиск
          </button>
        </div>

        {/* Search input */}
        {activeTab === 'search' && (
          <div className="px-4 py-2 border-b border-messenger-border">
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-messenger-muted" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Поиск по имени..."
                className="w-full pl-9 pr-3 py-2 bg-messenger-sidebar border border-messenger-border rounded-lg text-messenger-text text-sm focus:outline-none focus:ring-1 focus:ring-primary-500"
                autoFocus
              />
            </div>
          </div>
        )}

        {/* User list */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {searching && (
            <div className="flex items-center justify-center py-8 text-messenger-muted">
              <Loader2 size={20} className="animate-spin mr-2" />
              Поиск...
            </div>
          )}

          {!searching && displayList.length === 0 && (
            <div className="flex items-center justify-center py-8 text-messenger-muted text-sm">
              {activeTab === 'search' 
                ? (searchQuery.length < 2 ? 'Введите минимум 2 символа' : 'Никого не найдено')
                : 'Нет контактов'
              }
            </div>
          )}

          {!searching && displayList.map(user => {
            const selected = isSelected(user.id);
            const online = onlineUsers.has(user.id);
            return (
              <button
                key={user.id}
                onClick={() => toggleUser(user)}
                className={`w-full flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-messenger-hover ${
                  selected ? 'bg-primary-600/10' : ''
                }`}
              >
                {/* Avatar */}
                <div className="relative flex-shrink-0">
                  {user.avatar_url ? (
                    <img
                      src={user.avatar_url}
                      alt=""
                      className="w-10 h-10 rounded-full object-cover"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-messenger-sidebar flex items-center justify-center text-messenger-text font-medium">
                      {(user.display_name || user.username)?.[0]?.toUpperCase()}
                    </div>
                  )}
                  {/* Online indicator */}
                  {online && (
                    <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-green-500 rounded-full border-2 border-messenger-bg" />
                  )}
                </div>

                {/* Name */}
                <div className="flex-1 min-w-0 text-left">
                  <p className="text-sm font-medium text-messenger-text truncate">
                    {user.display_name || user.username}
                  </p>
                  {user.display_name && (
                    <p className="text-xs text-messenger-muted truncate">@{user.username}</p>
                  )}
                </div>

                {/* Selection indicator */}
                <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
                  selected
                    ? 'bg-primary-500 border-primary-500 text-white'
                    : 'border-messenger-muted/30'
                }`}>
                  {selected && <Check size={14} />}
                </div>
              </button>
            );
          })}
        </div>

        {/* Кнопки звонка */}
        <div className="px-4 py-3 border-t border-messenger-border flex items-center justify-between gap-3">
          <div className="text-xs text-messenger-muted">
            {selectedUsers.length > 0
              ? `Выбрано: ${selectedUsers.length} чел.`
              : 'Выберите участников'
            }
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => handleStartCall('audio')}
              disabled={selectedUsers.length === 0}
              className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
            >
              <Phone size={16} />
              Аудио
            </button>
            <button
              onClick={() => handleStartCall('video')}
              disabled={selectedUsers.length === 0}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
            >
              <Video size={16} />
              Видео
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
