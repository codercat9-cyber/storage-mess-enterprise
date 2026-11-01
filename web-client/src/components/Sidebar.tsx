import { useState, useCallback, useRef, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/store/auth';
import { useChatStore } from '@/store/chat';
import { useContactOverrides } from '@/store/contactOverrides';
import { chatApi, userApi } from '@/lib/api';
import { downloadFileNative } from '@/lib/capacitor-bridge';
import { Chat, User } from '@/types';
import { renderTextWithEmoji } from '@/components/EmojiPicker';
import QrScannerModal from '@/components/QrScannerModal';
import CallAdminModal from '@/components/CallAdminModal';
import InstallHelp from '@/components/InstallHelp';
import CompanionApps from '@/components/CompanionApps';
import { getDownloads, detectPlatform, platformName, hasNativeBuild } from '@/lib/downloads';
import { 
  Search, 
  Menu,
  Plus, 
  Settings, 
  Users, 
  X,
  Loader2,
  Download,
  Trash2,
  LogOut as LeaveIcon,
  Phone,
  HardDrive,
  PenSquare,
  Megaphone,
  UserPlus,
  ChevronDown,
  ArrowLeft,
  Check,
  CheckCheck,
  Bookmark,
  QrCode,
  WifiOff,
  LifeBuoy,
} from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';
import { ru } from 'date-fns/locale';
import { isPWAInstalled } from '@/lib/pwa';
import { getBaseUrl, NetworkStatus, onNetworkStateChange } from '@/lib/connection';

type FilterTab = 'all' | 'private' | 'group' | 'channel';
type CreateMode = 'none' | 'pick' | 'group_name' | 'channel_name' | 'group_members' | 'channel_members';

interface SidebarProps {
  onOpenGroupCall?: () => void;
  onOpenStorage?: () => void;
}

export default function Sidebar({ onOpenGroupCall, onOpenStorage }: SidebarProps = {}) {
  const user = useAuthStore((state) => state.user);
  const { chats, currentChat, onlineUsers, addChat, removeChat, typingUsers } = useChatStore();
  const navigate = useNavigate();

  const [searchQuery, setSearchQuery] = useState('');
  const [showNewChat, setShowNewChat] = useState(false);
  const [showManualInstall, setShowManualInstall] = useState(false);
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [searching, setSearching] = useState(false);
  const [chatContextMenu, setChatContextMenu] = useState<{ x: number; y: number; chat: Chat } | null>(null);
  const [deleteChatDialog, setDeleteChatDialog] = useState<Chat | null>(null);
  const [filterTab, setFilterTab] = useState<FilterTab>('all');
  const [createMode, setCreateMode] = useState<CreateMode>('none');
  const [newGroupName, setNewGroupName] = useState('');
  const [selectedMembers, setSelectedMembers] = useState<User[]>([]);
  const [memberSearchQuery, setMemberSearchQuery] = useState('');
  const [memberSearchResults, setMemberSearchResults] = useState<User[]>([]);
  const [memberSearching, setMemberSearching] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showInviteDialog, setShowInviteDialog] = useState<Chat | null>(null);
  const [inviteSearchQuery, setInviteSearchQuery] = useState('');
  const [inviteSearchResults, setInviteSearchResults] = useState<User[]>([]);
  const [inviteSearching, setInviteSearching] = useState(false);
  
  // Telegram-like menu
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  
  // Connection status
  const [netStatus, setNetStatus] = useState<NetworkStatus>('connected');

  useEffect(() => {
    const unsub = onNetworkStateChange((state) => {
      setNetStatus(state.status);
    });
    return unsub;
  }, []);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Поиск пользователей для нового чата
  const handleSearch = async (query: string) => {
    setSearchQuery(query);
    
    // Remove leading @ for search API
    const cleanQuery = query.startsWith('@') ? query.slice(1) : query;
    
    if (cleanQuery.length < 2) {
      setSearchResults([]);
      return;
    }

    setSearching(true);
    try {
      const response = await userApi.search(cleanQuery);
      setSearchResults(response.data.users.filter((u: User) => u.id !== user?.id));
    } catch (error) {
      console.error('Search failed:', error);
    } finally {
      setSearching(false);
    }
  };

  // Создание приватного чата
  const handleStartChat = async (otherUser: User) => {
    try {
      const response = await chatApi.createPrivateChat(otherUser.id);
      const chat = response.data.chat;
      addChat(chat);
      setShowNewChat(false);
      setSearchQuery('');
      setSearchResults([]);
      navigate(`/chat/${chat.id}`);
    } catch (error) {
      console.error('Failed to create chat:', error);
    }
  };

  // Читаем через стор, а не из localStorage напрямую: тогда список
  // перерисуется, когда сверка с сервером принесёт чужие подписи и
  // аватарки. При чтении из localStorage React об их появлении не узнаёт,
  // и на новом устройстве всё выглядело как «синхронизация не работает».
  const overrides = useContactOverrides(s => s.map);
  const getLocalNick = (userId: string): string | null => overrides[userId]?.nick || null;

  const isSavedMessages = (chat: Chat) => chat.type === 'favorites' || (chat.type === 'private' && (chat.members?.every(m => m.id === user?.id) ?? false));

  const getChatName = (chat: Chat) => {
    if (isSavedMessages(chat)) return 'Избранное';
    if (chat.type === 'group' || chat.type === 'channel') return chat.name;
    const otherMember = chat.members?.find(m => m.id !== user?.id);
    if (!otherMember) return 'Unknown';
    const localNick = getLocalNick(otherMember.id);
    return localNick || otherMember.display_name || otherMember.username || 'Unknown';
  };

  const getChatAvatarUrl = (chat: Chat): string | undefined => {
    if (chat.type === 'group' || chat.type === 'channel') return chat.avatar_url;
    if (isSavedMessages(chat)) return undefined;
    const otherMember = chat.members?.find(m => m.id !== user?.id);
    if (!otherMember) return undefined;
    return overrides[otherMember.id]?.avatar || otherMember?.avatar_url;
  };

  const getChatAvatarLetter = (chat: Chat): string => {
    if (chat.type === 'group' || chat.type === 'channel') return chat.name?.[0] || (chat.type === 'channel' ? 'К' : 'Г');
    if (isSavedMessages(chat)) return 'И';
    const otherMember = chat.members?.find(m => m.id !== user?.id);
    if (!otherMember) return '?';
    const localNick = getLocalNick(otherMember.id);
    return localNick?.[0] || otherMember.display_name?.[0] || otherMember.username?.[0] || '?';
  };

  const isChatOnline = (chat: Chat) => {
    if (chat.type === 'group' || isSavedMessages(chat)) return false;
    const otherMember = chat.members?.find(m => m.id !== user?.id);
    return otherMember ? onlineUsers.has(otherMember.id) : false;
  };

  const handleChatContextMenu = (e: React.MouseEvent | React.TouchEvent, chat: Chat) => {
    e.preventDefault();
    let x: number, y: number;
    if ('touches' in e) {
      const touch = e.touches[0] || (e as any).changedTouches?.[0];
      x = touch?.clientX ?? 0;
      y = touch?.clientY ?? 0;
    } else {
      x = e.clientX;
      y = e.clientY;
    }
    setChatContextMenu({ x, y, chat });
  };

  // Long press для мобилок (контекстное меню по тач)
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressChatRef = useRef<Chat | null>(null);

  const handleTouchStart = (chat: Chat, e: React.TouchEvent) => {
    longPressChatRef.current = chat;
    longPressTimerRef.current = setTimeout(() => {
      handleChatContextMenu(e, chat);
    }, 500);
  };

  const handleTouchEnd = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const handleDeleteChat = async () => {
    if (!deleteChatDialog) return;
    try {
      await chatApi.deleteChat(deleteChatDialog.id);
      removeChat(deleteChatDialog.id);
      if (currentChat?.id === deleteChatDialog.id) {
        navigate('/');
      }
    } catch (error) {
      console.error('Failed to delete chat:', error);
    } finally {
      setDeleteChatDialog(null);
    }
  };

  const handleLeaveChat = async (chat: Chat) => {
    try {
      await chatApi.leaveChat(chat.id);
      removeChat(chat.id);
      if (currentChat?.id === chat.id) {
        navigate('/');
      }
    } catch (error) {
      console.error('Failed to leave chat:', error);
    }
  };

  const formatChatTime = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    if (date.toDateString() === now.toDateString()) {
      return format(date, 'HH:mm');
    }
    return format(date, 'dd.MM');
  };

  // Поиск участников для группы/канала
  const handleMemberSearch = async (query: string) => {
    setMemberSearchQuery(query);
    const cleanQuery = query.startsWith('@') ? query.slice(1) : query;
    if (cleanQuery.length < 2) { setMemberSearchResults([]); return; }
    setMemberSearching(true);
    try {
      const response = await userApi.search(cleanQuery);
      setMemberSearchResults(response.data.users.filter((u: User) => u.id !== user?.id && !selectedMembers.some(s => s.id === u.id)));
    } catch (e) { console.error('Search failed:', e); }
    finally { setMemberSearching(false); }
  };

  const toggleMember = (u: User) => {
    if (selectedMembers.some(s => s.id === u.id)) {
      setSelectedMembers(prev => prev.filter(s => s.id !== u.id));
    } else {
      setSelectedMembers(prev => [...prev, u]);
    }
  };

  const handleCreateGroupOrChannel = async () => {
    if (!newGroupName.trim()) return;
    setCreating(true);
    try {
      const memberIds = selectedMembers.map(m => m.id);
      const isChannel = createMode === 'channel_members';
      const response = isChannel
        ? await chatApi.createChannel(newGroupName.trim(), memberIds)
        : await chatApi.createGroupChat(newGroupName.trim(), memberIds);
      const chat = response.data.chat;
      addChat(chat);
      navigate(`/chat/${chat.id}`);
      resetCreate();
    } catch (e) { console.error('Create failed:', e); }
    finally { setCreating(false); }
  };

  const resetCreate = () => {
    setCreateMode('none');
    setShowNewChat(false);
    setNewGroupName('');
    setSelectedMembers([]);
    setMemberSearchQuery('');
    setMemberSearchResults([]);
    setSearchQuery('');
    setSearchResults([]);
  };

  // Invite to existing chat
  const handleInviteSearch = async (query: string) => {
    setInviteSearchQuery(query);
    if (query.length < 2) { setInviteSearchResults([]); return; }
    setInviteSearching(true);
    try {
      const response = await userApi.search(query);
      const existingIds = showInviteDialog?.members.map(m => m.id) || [];
      setInviteSearchResults(response.data.users.filter((u: User) => u.id !== user?.id && !existingIds.includes(u.id)));
    } catch (e) { console.error('Search failed:', e); }
    finally { setInviteSearching(false); }
  };

  const handleInviteMember = async (u: User) => {
    if (!showInviteDialog) return;
    try {
      await chatApi.addMember(showInviteDialog.id, u.id);
      setInviteSearchResults(prev => prev.filter(r => r.id !== u.id));
    } catch (e) { console.error('Invite failed:', e); }
  };

  // Фильтрация чатов (Избранное всегда наверху)
  const filteredChats = chats.filter(chat => {
    if (filterTab === 'all') return true;
    if (filterTab === 'private') return chat.type === 'private' || chat.type === 'favorites';
    if (filterTab === 'group') return chat.type === 'group';
    if (filterTab === 'channel') return chat.type === 'channel';
    return true;
  }).filter(chat => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    const name = (getChatName(chat) || '').toLowerCase();
    return name.includes(q);
  }).sort((a, b) => {
    if (a.type === 'favorites' && b.type !== 'favorites') return -1;
    if (b.type === 'favorites' && a.type !== 'favorites') return 1;
    return 0;
  });

  const [isQrScannerOpen, setIsQrScannerOpen] = useState(false);
  const [isCallAdminOpen, setIsCallAdminOpen] = useState(false);

  return (
    <div className="w-full h-full bg-messenger-sidebar flex flex-col relative">
      {/* Header - Telegram Style */}
      <div className="flex items-center gap-3 px-4 h-14 shrink-0">
        <div className="relative" ref={menuRef}>
          <button 
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            className="p-2 -ml-2 rounded-full hover:bg-messenger-hover text-messenger-muted hover:text-messenger-text transition-colors"
          >
            <Menu className="w-5 h-5" />
          </button>

          {/* Dropdown Menu */}
          {isMenuOpen && (
            <div className="absolute top-12 left-0 w-64 bg-messenger-sidebar border border-messenger-border rounded-xl shadow-2xl z-50 py-2 animate-scale-in">
              <Link 
                to="/settings" 
                onClick={() => setIsMenuOpen(false)}
                className="flex items-center gap-4 px-4 py-2 hover:bg-messenger-hover text-messenger-text transition-colors"
              >
                <Settings className="w-5 h-5 text-messenger-muted" />
                <span>Настройки</span>
              </Link>
              <button 
                onClick={() => { setIsMenuOpen(false); setIsQrScannerOpen(true); }}
                className="w-full flex items-center gap-4 px-4 py-2 hover:bg-messenger-hover text-messenger-text transition-colors"
              >
                <QrCode className="w-5 h-5 text-messenger-muted" />
                <span>Сканировать QR (Вход на ПК)</span>
              </button>
              <button 
                onClick={() => { setIsMenuOpen(false); onOpenGroupCall?.(); }}
                className="w-full flex items-center gap-4 px-4 py-2 hover:bg-messenger-hover text-messenger-text transition-colors"
              >
                <Phone className="w-5 h-5 text-messenger-muted" />
                <span>Групповой звонок</span>
              </button>
              <button 
                onClick={() => { setIsMenuOpen(false); onOpenStorage?.(); }}
                className="w-full flex items-center gap-4 px-4 py-2 hover:bg-messenger-hover text-messenger-text transition-colors"
              >
                <div className="w-5 h-5 rounded-full overflow-hidden flex-shrink-0 border border-messenger-border shadow-sm">
                  <img src="/storage-icon.png" alt="" className="w-full h-full object-cover" />
                </div>
                <span>Хранилище S&M</span>
              </button>

              {/* Позвать администратора. Раньше правило «админ смотрит
                  переписку, только когда позвали» держалось на честном
                  слове: позвать было нечем, жаловались в личку. */}
              <button
                onClick={() => { setIsMenuOpen(false); setIsCallAdminOpen(true); }}
                className="w-full flex items-center gap-4 px-4 py-2 hover:bg-messenger-hover text-messenger-text transition-colors"
              >
                <LifeBuoy className="w-5 h-5 text-messenger-muted" />
                <span>Позвать администратора</span>
              </button>

              {!isPWAInstalled() && (
                <>
                  <div className="h-px bg-messenger-border my-1"></div>
                  <button 
                    onClick={() => {
                      setIsMenuOpen(false);
                      setShowManualInstall(true);
                    }}
                    className="w-full flex items-center gap-4 px-4 py-2 hover:bg-messenger-hover text-messenger-text transition-colors"
                  >
                    <Download className="w-5 h-5 text-messenger-muted" />
                    <span>Установить приложение</span>
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0 flex flex-col justify-center h-full">
          {netStatus === 'connected' ? (
            <h2 className="text-[17px] font-medium text-messenger-text truncate animate-fade-in">
              Storage Messenger
            </h2>
          ) : (
            <div className="flex items-center gap-2 animate-fade-in">
              <Loader2 className="w-4 h-4 text-messenger-muted animate-spin shrink-0" />
              <h2 className="text-[15px] font-medium text-messenger-muted truncate">
                {netStatus === 'syncing' ? 'Обновление...' : 'Ожидание сети...'}
              </h2>
            </div>
          )}
        </div>
      </div>

      <div className="px-3 pb-2 pt-1 shrink-0">
        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <Search className="h-4 w-4 text-messenger-muted" />
          </div>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="Поиск чатов и @людей..."
            className="w-full bg-messenger-input border-none rounded-full py-1.5 pl-10 pr-4 text-sm text-messenger-text placeholder-messenger-muted focus:ring-2 focus:ring-messenger-accent transition-all"
          />
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center px-2 gap-1 shrink-0 border-b border-messenger-border pb-1.5">
        {([
          { key: 'all', label: 'Все' },
          { key: 'private', label: 'Личные' },
          { key: 'group', label: 'Группы' },
          { key: 'channel', label: 'Каналы' },
        ] as { key: FilterTab; label: string }[]).map(tab => (
          <button
            key={tab.key}
            onClick={() => setFilterTab(tab.key)}
            className={`px-3 py-1.5 rounded-full text-[13px] font-medium transition-colors ${
              filterTab === tab.key
                ? 'bg-messenger-accent text-white'
                : 'text-messenger-muted hover:bg-messenger-hover'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Chat List */}
      <div className="flex-1 overflow-y-auto no-scrollbar">
        {filteredChats.length === 0 ? (
          <div className="p-4 flex flex-col items-center justify-center h-full text-messenger-muted">
            <Users className="w-12 h-12 mb-2 opacity-30" />
            <p className="font-medium text-sm">Нет чатов</p>
          </div>
        ) : (
          <div className="px-2 py-1">
            {filteredChats.map((chat, index) => {
              const isSelected = currentChat?.id === chat.id;
              return (
                <div key={chat.id}>
                  {index > 0 && (
                    <div className="mx-2 my-0.5">
                      <div className="h-px bg-messenger-divider" />
                    </div>
                  )}
                <Link
                  to={`/chat/${chat.id}`}
                  onContextMenu={(e) => handleChatContextMenu(e, chat)}
                  onTouchStart={(e) => handleTouchStart(chat, e)}
                  onTouchEnd={handleTouchEnd}
                  onTouchMove={handleTouchEnd}
                  className={`flex items-center gap-3 p-2 rounded-xl transition-colors ${
                    isSelected 
                      ? 'bg-messenger-accent text-white' 
                      : 'hover:bg-messenger-hover text-messenger-text'
                  }`}
                >
                  {/* Avatar */}
                  <div className="relative shrink-0">
                    <div className={`w-12 h-12 rounded-full overflow-hidden flex items-center justify-center text-lg font-medium shadow-sm text-white ${
                      chat.type === 'favorites' || isSavedMessages(chat) ? 'bg-gradient-to-br from-blue-500 to-indigo-600' :
                      chat.type === 'channel' ? 'bg-gradient-to-br from-violet-500 to-purple-600' : 'bg-gradient-to-br from-blue-400 to-blue-600'
                    }`}>
                      {chat.type === 'favorites' || isSavedMessages(chat) ? (
                        <Bookmark className="w-6 h-6" />
                      ) : getChatAvatarUrl(chat) ? (
                        <img src={getChatAvatarUrl(chat)} alt="" className="w-full h-full object-cover" />
                      ) : (
                        getChatAvatarLetter(chat)
                      )}
                    </div>
                    {isChatOnline(chat) && (
                      <div className={`absolute bottom-0 right-0 w-3.5 h-3.5 rounded-full border-2 ${isSelected ? 'border-messenger-accent' : 'border-messenger-sidebar'} bg-[#0ac630]`} />
                    )}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0 flex flex-col justify-center py-1">
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="font-medium truncate text-[15px]">
                        {getChatName(chat)}
                      </span>
                      {chat.lastMessage && (
                        <span className={`text-xs whitespace-nowrap ml-2 ${isSelected ? 'text-white/80' : chat.unreadCount > 0 ? 'text-[#3390ec]' : 'text-messenger-muted'}`}>
                          {formatChatTime(chat.lastMessage.created_at)}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <p className={`text-[14px] truncate ${isSelected ? 'text-white/90' : 'text-messenger-muted'}`}>
                        {(() => {
                          // Отображаем «печатает» если кто-то набирает
                          const chatTyping = (typingUsers[chat.id] || []).filter(uid => uid !== user?.id);
                          if (chatTyping.length > 0) {
                            if (chat.type === 'group' || chat.type === 'channel') {
                              const names = chatTyping.map(uid => {
                                const m = chat.members?.find(mm => mm.id === uid);
                                return m?.display_name || m?.username || '???';
                              });
                              return <span className={isSelected ? 'text-white' : 'text-messenger-accent'}>{names.length === 1 ? `${names[0]} печатает...` : `${names.join(', ')} печатают...`}</span>;
                            }
                            return <span className={isSelected ? 'text-white' : 'text-messenger-accent'}>печатает...</span>;
                          }
                          return chat.lastMessage
                          ? (() => {
                              const senderPrefix = (chat.type === 'group' || chat.type === 'channel') && chat.lastMessage.sender
                                ? (chat.lastMessage.sender.id === user?.id ? 'Вы' : (chat.lastMessage.sender.display_name || chat.lastMessage.sender.username || '')) + ': '
                                : '';
                              const content = chat.lastMessage.type === 'voice' ? '🎤 Голосовое'
                                : chat.lastMessage.type === 'image' ? '📷 Фото'
                                : chat.lastMessage.type === 'video' ? '🎬 Видео'
                                : chat.lastMessage.type === 'file' ? '📎 Файл'
                                : chat.lastMessage.type === 'audio' ? '🎵 Аудио'
                                : chat.lastMessage.content || 'Нет сообщений';
                              const fullText = senderPrefix + content;
                              const parts = renderTextWithEmoji(fullText);
                              return <>
                                {parts.map((part, i) => {
                                  if (typeof part === 'string') return <span key={i}>{part}</span>;
                                  return <img key={i} src={part.src} alt="" className="inline-emoji" draggable={false} />;
                                })}
                              </>;
                            })()
                          : 'Нет сообщений';
                        })()}
                      </p>
                      {/* Галочки / badge справа под временем */}
                      {chat.unreadCount > 0 ? (
                        <span className={`flex-shrink-0 min-w-[20px] h-[20px] rounded-full flex items-center justify-center text-[11px] font-bold px-1.5 ${
                          isSelected ? 'bg-white text-messenger-accent' : 'bg-[#3390ec] text-white'
                        }`}>
                          {chat.unreadCount > 99 ? '99+' : chat.unreadCount}
                        </span>
                      ) : chat.lastMessage && (chat.lastMessage.sender_id === user?.id || chat.lastMessage.sender?.id === user?.id) && (
                        (chat.lastMessage as any).status === 'read'
                          ? <CheckCheck size={16} className={`flex-shrink-0 ${isSelected ? 'text-white/80' : 'text-[#3390ec]'}`} />
                          : <Check size={16} className={`flex-shrink-0 ${isSelected ? 'text-white/60' : 'text-messenger-muted'}`} />
                      )}
                    </div>
                  </div>
                </Link>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Global Search Results */}
      {searchQuery.trim().length >= 2 && searchResults.length > 0 && (
        <div className="flex-none max-h-[40%] overflow-y-auto no-scrollbar border-t border-messenger-border bg-messenger-sidebar">
          <div className="px-4 py-2 sticky top-0 bg-messenger-sidebar/95 backdrop-blur z-10 border-b border-messenger-border/50">
            <span className="text-[11px] font-bold text-messenger-muted uppercase tracking-wider">Глобальный поиск</span>
          </div>
          <div className="px-2 py-1 pb-4">
            {searchResults.map((u) => (
              <div 
                key={u.id}
                onClick={() => handleStartChat(u)}
                className="flex items-center gap-3 p-2 rounded-xl hover:bg-messenger-hover transition-colors cursor-pointer"
              >
                <div className="w-12 h-12 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white text-lg font-medium shrink-0 shadow-sm overflow-hidden">
                  {u.avatar_url ? (
                    <img src={u.avatar_url} alt="" className="w-full h-full object-cover" />
                  ) : (
                    u.display_name?.[0] || u.username?.[0] || '?'
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-[15px] text-messenger-text truncate">{u.display_name || u.username}</p>
                  <p className="text-[13px] text-[#3390ec] truncate">@{u.username}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Floating Action Button (Telegram style New Chat) */}
      <button
        onClick={() => setShowNewChat(true)}
        className="absolute bottom-6 right-6 w-14 h-14 bg-messenger-accent rounded-full flex items-center justify-center text-white shadow-lg hover:bg-opacity-90 transition-transform active:scale-95"
        title="Новый чат"
      >
        <PenSquare className="w-6 h-6" />
      </button>

      {/* New Chat / Create Group / Create Channel Modal */}
      {showNewChat && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100]">
          <div className="bg-messenger-sidebar rounded-xl w-full max-w-md m-4 animate-scale-in overflow-hidden shadow-2xl">
            {/* Header */}
            <div className="p-4 border-b border-messenger-border flex items-center gap-4">
              {createMode === 'none' ? (
                <button
                  onClick={resetCreate}
                  className="p-2 -ml-2 rounded-full hover:bg-messenger-hover text-messenger-muted transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              ) : (
                <button
                  onClick={() => {
                    if (createMode === 'group_members') setCreateMode('group_name');
                    else if (createMode === 'channel_members') setCreateMode('channel_name');
                    else if (createMode === 'group_name' || createMode === 'channel_name') setCreateMode('none');
                    else setCreateMode('none');
                  }}
                  className="p-2 -ml-2 rounded-full hover:bg-messenger-hover text-messenger-muted transition-colors"
                >
                  <ArrowLeft className="w-5 h-5" />
                </button>
              )}
              <h3 className="font-medium text-lg text-messenger-text">
                {createMode === 'none' && 'Новый чат'}
                {createMode === 'group_name' && 'Новая группа'}
                {createMode === 'channel_name' && 'Новый канал'}
                {createMode === 'group_members' && 'Участники группы'}
                {createMode === 'channel_members' && 'Участники канала'}
              </h3>
            </div>

            {/* Step: Default — search users + create options */}
            {createMode === 'none' && (
              <>
                <div className="p-3">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-messenger-muted" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => handleSearch(e.target.value)}
                      placeholder="Поиск пользователей..."
                      className="w-full bg-messenger-input border border-transparent focus:border-messenger-accent rounded-lg py-2 pl-10 pr-4 text-sm text-messenger-text placeholder-messenger-muted outline-none transition-all"
                      autoFocus
                    />
                  </div>
                </div>
                <div className="max-h-80 overflow-y-auto pb-2">
                  {!searchQuery && (
                    <>
                      <button
                        onClick={() => setCreateMode('group_name')}
                        className="w-full px-4 py-3 flex items-center gap-4 hover:bg-messenger-hover transition-colors text-left"
                      >
                        <div className="w-10 h-10 rounded-full bg-messenger-hover flex items-center justify-center text-messenger-accent">
                          <Users className="w-5 h-5" />
                        </div>
                        <span className="font-medium text-messenger-text">Создать группу</span>
                      </button>
                      <button
                        onClick={() => setCreateMode('channel_name')}
                        className="w-full px-4 py-3 flex items-center gap-4 hover:bg-messenger-hover transition-colors text-left"
                      >
                        <div className="w-10 h-10 rounded-full bg-messenger-hover flex items-center justify-center text-purple-400">
                          <Megaphone className="w-5 h-5" />
                        </div>
                        <span className="font-medium text-messenger-text">Создать канал</span>
                      </button>
                    </>
                  )}
                  {searching ? (
                    <div className="p-8 text-center">
                      <Loader2 className="w-6 h-6 animate-spin mx-auto text-messenger-accent" />
                    </div>
                  ) : searchResults.length > 0 ? (
                    searchResults.map(u => (
                      <button
                        key={u.id}
                        onClick={() => handleStartChat(u)}
                        className="w-full flex items-center gap-3 px-4 py-2 hover:bg-messenger-hover transition-colors text-left"
                      >
                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center text-white font-medium overflow-hidden">
                          {u.avatar_url ? (
                            <img src={u.avatar_url} alt="" className="w-full h-full object-cover" />
                          ) : (
                            u.display_name?.[0] || u.username[0]
                          )}
                        </div>
                        <div>
                          <p className="font-medium text-messenger-text">{u.display_name || u.username}</p>
                          <p className="text-sm text-messenger-muted">@{u.username}</p>
                        </div>
                      </button>
                    ))
                  ) : searchQuery.length >= 2 ? (
                    <div className="p-8 text-center text-messenger-muted text-sm">Пользователи не найдены</div>
                  ) : null}
                </div>
              </>
            )}

            {/* Step: Name input for group or channel */}
            {(createMode === 'group_name' || createMode === 'channel_name') && (
              <div className="p-4 space-y-4">
                <div className="flex items-center gap-4">
                  <div className={`w-16 h-16 rounded-full flex items-center justify-center text-white text-2xl font-medium shrink-0 ${
                    createMode === 'channel_name' ? 'bg-gradient-to-br from-violet-500 to-purple-600' : 'bg-gradient-to-br from-blue-400 to-blue-600'
                  }`}>
                    {newGroupName ? newGroupName[0].toUpperCase() : (createMode === 'channel_name' ? 'К' : 'Г')}
                  </div>
                  <input
                    type="text"
                    value={newGroupName}
                    onChange={(e) => setNewGroupName(e.target.value)}
                    placeholder={createMode === 'channel_name' ? 'Название канала' : 'Название группы'}
                    className="flex-1 bg-messenger-input border border-transparent focus:border-messenger-accent rounded-lg py-2.5 px-4 text-sm text-messenger-text placeholder-messenger-muted outline-none transition-all"
                    autoFocus
                  />
                </div>
                <button
                  onClick={() => {
                    if (!newGroupName.trim()) return;
                    setCreateMode(createMode === 'channel_name' ? 'channel_members' : 'group_members');
                  }}
                  disabled={!newGroupName.trim()}
                  className="w-full py-2.5 rounded-lg bg-messenger-accent text-white font-medium text-sm disabled:opacity-40 hover:bg-opacity-90 transition-colors"
                >
                  Далее
                </button>
              </div>
            )}

            {/* Step: Member selection */}
            {(createMode === 'group_members' || createMode === 'channel_members') && (
              <div className="flex flex-col" style={{ maxHeight: '70vh' }}>
                {/* Selected members chips */}
                {selectedMembers.length > 0 && (
                  <div className="px-3 pt-3 flex flex-wrap gap-1.5">
                    {selectedMembers.map(m => (
                      <span
                        key={m.id}
                        onClick={() => toggleMember(m)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-messenger-accent/20 text-messenger-accent text-xs font-medium cursor-pointer hover:bg-messenger-accent/30 transition-colors"
                      >
                        {m.display_name || m.username}
                        <X className="w-3 h-3" />
                      </span>
                    ))}
                  </div>
                )}
                {/* Search */}
                <div className="p-3">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-messenger-muted" />
                    <input
                      type="text"
                      value={memberSearchQuery}
                      onChange={(e) => handleMemberSearch(e.target.value)}
                      placeholder="Поиск участников..."
                      className="w-full bg-messenger-input border border-transparent focus:border-messenger-accent rounded-lg py-2 pl-10 pr-4 text-sm text-messenger-text placeholder-messenger-muted outline-none transition-all"
                      autoFocus
                    />
                  </div>
                </div>
                {/* Results */}
                <div className="flex-1 overflow-y-auto max-h-60 pb-2">
                  {memberSearching ? (
                    <div className="p-8 text-center">
                      <Loader2 className="w-6 h-6 animate-spin mx-auto text-messenger-accent" />
                    </div>
                  ) : memberSearchResults.map(u => (
                    <button
                      key={u.id}
                      onClick={() => toggleMember(u)}
                      className="w-full flex items-center gap-3 px-4 py-2 hover:bg-messenger-hover transition-colors text-left"
                    >
                      <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center text-white font-medium overflow-hidden">
                        {u.avatar_url ? (
                          <img src={u.avatar_url} alt="" className="w-full h-full object-cover" />
                        ) : (
                          u.display_name?.[0] || u.username[0]
                        )}
                      </div>
                      <div className="flex-1">
                        <p className="font-medium text-messenger-text">{u.display_name || u.username}</p>
                        <p className="text-sm text-messenger-muted">@{u.username}</p>
                      </div>
                      {selectedMembers.some(s => s.id === u.id) && (
                        <Check className="w-5 h-5 text-messenger-accent" />
                      )}
                    </button>
                  ))}
                </div>
                {/* Create button */}
                <div className="p-3 border-t border-messenger-border">
                  <button
                    onClick={handleCreateGroupOrChannel}
                    disabled={creating}
                    className="w-full py-2.5 rounded-lg bg-messenger-accent text-white font-medium text-sm disabled:opacity-40 hover:bg-opacity-90 transition-colors flex items-center justify-center gap-2"
                  >
                    {creating && <Loader2 className="w-4 h-4 animate-spin" />}
                    {createMode === 'channel_members' ? 'Создать канал' : 'Создать группу'}
                    {selectedMembers.length > 0 && ` (${selectedMembers.length})`}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Install dialog — APK + PWA */}
      {showManualInstall && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50" onClick={() => setShowManualInstall(false)}>
          <div
            className="bg-messenger-sidebar border border-messenger-border rounded-2xl shadow-2xl p-5 max-w-sm w-full mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 bg-messenger-accent rounded-xl flex items-center justify-center">
                <Download className="w-6 h-6 text-white" />
              </div>
              <div>
                <h3 className="font-semibold text-messenger-text">Установить S&M</h3>
                <p className="text-xs text-messenger-muted">
                  {hasNativeBuild() ? `Для ${platformName(detectPlatform())}` : 'Выберите способ установки'}
                </p>
              </div>
            </div>

            <div className="space-y-3">
              {/* Загрузки по системе, а не одна кнопка «Скачать APK» на всех.
                  Раньше человеку с Windows и с Linux предлагали именно APK —
                  просто потому, что кнопка была прибита гвоздями. Настольные
                  сборки тогда были битые, теперь они есть и проверены. */}
              {getDownloads().map(d => (
                <button
                  key={d.id}
                  onClick={() => {
                    // Через свой загрузчик, а не в браузер: в настольном
                    // клиенте window.open уводит ссылку в системный браузер,
                    // и человек качает установщик мимо приложения — без
                    // полосы и в чужую папку.
                    void downloadFileNative(d.url, d.filename || 'STORAGE-MESS');
                    setShowManualInstall(false);
                  }}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${
                    d.primary
                      ? 'bg-green-600 hover:bg-green-500 text-white'
                      : 'bg-messenger-hover hover:bg-messenger-border text-messenger-text'}`}
                >
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${
                    d.primary ? 'bg-white/20' : 'bg-black/20'}`}>
                    <Download className="w-5 h-5" />
                  </div>
                  <div className="text-left min-w-0">
                    <p className="font-semibold text-sm">{d.title}</p>
                    <p className={`text-[11px] ${d.primary ? 'text-white/70' : 'text-messenger-muted'}`}>{d.hint}</p>
                  </div>
                  {d.primary && (
                    <span className="ml-auto text-[10px] bg-white/20 px-2 py-0.5 rounded-full shrink-0">
                      ваша система
                    </span>
                  )}
                </button>
              ))}

              {/* Под macOS сборки нет — собирать её можно только на маке.
                  Говорим прямо, а не подсовываем APK. */}
              {!hasNativeBuild() && (
                <p className="text-[11px] text-messenger-muted px-1">
                  Отдельного приложения для {platformName(detectPlatform())} пока нет — работает
                  веб-версия, её можно установить кнопкой ниже или из адресной строки браузера.
                </p>
              )}

              {/* PWA — только если браузер поддерживает install prompt */}
              {(window as any).__pwa_deferred_prompt && (
                <button
                  onClick={() => {
                    const prompt = (window as any).__pwa_deferred_prompt;
                    if (prompt && prompt.prompt) {
                      prompt.prompt();
                      prompt.userChoice.then((result: any) => {
                        if (result.outcome === 'accepted') {
                          (window as any).__pwa_deferred_prompt = null;
                        }
                      });
                      setShowManualInstall(false);
                    }
                  }}
                  className="w-full flex items-center gap-3 px-4 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-xl transition-colors"
                >
                  <div className="w-10 h-10 bg-white/20 rounded-lg flex items-center justify-center shrink-0">
                    <Download className="w-5 h-5" />
                  </div>
                  <div className="text-left">
                    <p className="font-semibold text-sm">Установить PWA</p>
                    <p className="text-[11px] text-white/70">Лёгкая версия, работает из браузера</p>
                  </div>
                </button>
              )}

              {/* По обращению: человек не смог поставить приложение и с тех
                  пор сидит из браузера, а сам файл при разборе оказался в
                  полном порядке. Значит объяснять надо не сборку, а отказ
                  телефона — см. InstallHelp. */}
              <InstallHelp compact />

              <CompanionApps />

              {/* Инструкция ручной установки PWA */}
              <div className="text-xs text-messenger-muted bg-messenger-hover rounded-lg p-3">
                {/Android/i.test(navigator.userAgent) ? (
                  <p>Если кнопка PWA не работает: меню браузера ⋮ → «Установить приложение»</p>
                ) : /iPhone|iPad|iPod/i.test(navigator.userAgent) ? (
                  <p>Safari: ⬆️ Поделиться → «На экран Домой» → «Добавить»</p>
                ) : (
                  <p>В браузере: ⋮ или 🔒 в адресной строке → «Установить»</p>
                )}
              </div>
            </div>

            <button
              onClick={() => setShowManualInstall(false)}
              className="w-full mt-4 py-2 rounded-lg bg-messenger-hover hover:bg-messenger-border text-messenger-text text-sm font-medium transition-colors"
            >
              Закрыть
            </button>
          </div>
        </div>
      )}

      {/* Chat Context Menu */}
      {chatContextMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setChatContextMenu(null)} />
          <div
            ref={(el) => { if (el) { el.style.left = `${chatContextMenu.x}px`; el.style.top = `${chatContextMenu.y}px`; } }}
            className="fixed z-50 bg-messenger-sidebar border border-messenger-border rounded-lg shadow-xl py-1 min-w-[180px]"
          >
            {(chatContextMenu.chat.type === 'group' || chatContextMenu.chat.type === 'channel') && (
              <button
                onClick={() => {
                  setShowInviteDialog(chatContextMenu.chat);
                  setChatContextMenu(null);
                }}
                className="w-full flex items-center gap-3 px-4 py-2 text-sm text-messenger-text hover:bg-messenger-hover transition-colors"
              >
                <UserPlus size={18} />
                Пригласить
              </button>
            )}
            {(chatContextMenu.chat.type === 'group' || chatContextMenu.chat.type === 'channel') && (
              <button
                onClick={() => {
                  handleLeaveChat(chatContextMenu.chat);
                  setChatContextMenu(null);
                }}
                className="w-full flex items-center gap-3 px-4 py-2 text-sm text-messenger-text hover:bg-messenger-hover transition-colors"
              >
                <LeaveIcon size={18} />
                {chatContextMenu.chat.type === 'channel' ? 'Покинуть канал' : 'Покинуть группу'}
              </button>
            )}
            <button
              onClick={() => {
                setDeleteChatDialog(chatContextMenu.chat);
                setChatContextMenu(null);
              }}
              className="w-full flex items-center gap-3 px-4 py-2 text-sm text-red-500 hover:bg-messenger-hover transition-colors"
            >
              <Trash2 size={18} />
              Удалить чат
            </button>
          </div>
        </>
      )}

      {/* Invite Members Dialog */}
      {showInviteDialog && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={() => { setShowInviteDialog(null); setInviteSearchQuery(''); setInviteSearchResults([]); }}>
          <div
            className="bg-messenger-sidebar rounded-xl w-full max-w-md m-4 animate-scale-in overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4 border-b border-messenger-border flex items-center gap-4">
              <button
                onClick={() => { setShowInviteDialog(null); setInviteSearchQuery(''); setInviteSearchResults([]); }}
                className="p-2 -ml-2 rounded-full hover:bg-messenger-hover text-messenger-muted transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
              <h3 className="font-medium text-lg text-messenger-text">
                Пригласить в «{showInviteDialog.name}»
              </h3>
            </div>
            <div className="p-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-messenger-muted" />
                <input
                  type="text"
                  value={inviteSearchQuery}
                  onChange={(e) => handleInviteSearch(e.target.value)}
                  placeholder="Поиск пользователей..."
                  className="w-full bg-messenger-input border border-transparent focus:border-messenger-accent rounded-lg py-2 pl-10 pr-4 text-sm text-messenger-text placeholder-messenger-muted outline-none transition-all"
                  autoFocus
                />
              </div>
            </div>
            <div className="max-h-80 overflow-y-auto pb-2">
              {inviteSearching ? (
                <div className="p-8 text-center">
                  <Loader2 className="w-6 h-6 animate-spin mx-auto text-messenger-accent" />
                </div>
              ) : inviteSearchResults.length > 0 ? (
                inviteSearchResults.map(u => (
                  <div key={u.id} className="flex items-center gap-3 px-4 py-2 hover:bg-messenger-hover transition-colors">
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center text-white font-medium overflow-hidden">
                      {u.avatar_url ? (
                        <img src={u.avatar_url} alt="" className="w-full h-full object-cover" />
                      ) : (
                        u.display_name?.[0] || u.username[0]
                      )}
                    </div>
                    <div className="flex-1">
                      <p className="font-medium text-messenger-text">{u.display_name || u.username}</p>
                      <p className="text-sm text-messenger-muted">@{u.username}</p>
                    </div>
                    <button
                      onClick={() => handleInviteMember(u)}
                      className="px-3 py-1 rounded-full bg-messenger-accent text-white text-xs font-medium hover:bg-opacity-90 transition-colors"
                    >
                      Добавить
                    </button>
                  </div>
                ))
              ) : inviteSearchQuery.length >= 2 ? (
                <div className="p-8 text-center text-messenger-muted text-sm">Пользователи не найдены</div>
              ) : (
                <div className="p-8 text-center text-messenger-muted text-sm">Введите имя для поиска</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Delete Chat Confirmation */}
      {deleteChatDialog && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={() => setDeleteChatDialog(null)}>
          <div
            className="bg-messenger-sidebar border border-messenger-border rounded-xl shadow-2xl p-6 max-w-sm w-full mx-4 animate-scale-in"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-medium text-messenger-text mb-2">Удалить чат</h3>
            <p className="text-sm text-messenger-muted mb-6">
              Вы действительно хотите удалить чат с <strong>{getChatName(deleteChatDialog)}</strong>? Это действие нельзя отменить.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteChatDialog(null)}
                className="py-2 px-4 rounded hover:bg-messenger-hover text-messenger-accent font-medium transition-colors"
              >
                ОТМЕНА
              </button>
              <button
                onClick={handleDeleteChat}
                className="py-2 px-4 rounded hover:bg-red-500/10 text-red-500 font-medium transition-colors"
              >
                УДАЛИТЬ
              </button>
            </div>
          </div>
        </div>
      )}
      
      {isQrScannerOpen && (
        <QrScannerModal onClose={() => setIsQrScannerOpen(false)} />
      )}

      {isCallAdminOpen && (
        <CallAdminModal
          chatId={currentChat?.id ?? null}
          chatName={currentChat ? getChatName(currentChat) : undefined}
          onClose={() => setIsCallAdminOpen(false)}
        />
      )}
    </div>
  );
}
