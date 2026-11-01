import { useState, useEffect, useRef, useMemo } from 'react';
import { formatBytes } from '../lib/format';
import { useAuthStore } from '@/store/auth';
import { useChatStore } from '@/store/chat';
import { useMediaStore } from '@/store/media';
import { muteApi } from '@/lib/api';
import { useUploadStore, etaSeconds, stageLabel, overallPercent } from '@/store/uploads';
import { useContactOverrides } from '@/store/contactOverrides';
import { chatApi, fileApi, userApi, reportApi } from '@/lib/api';
import { downloadFileNative } from '@/lib/capacitor-bridge';
import { socketEmit, isSocketConnected } from '@/lib/socket';
import { getLoraStatus, loraSendChat } from '@/lib/lora';
import { startRecording, stopRecording, cancelRecording } from '@/lib/voice';
import { transcribeAudioFromUrl, learnTranscriptionCorrection } from '@/lib/speech';
import { 
  encryptMessage, isE2EEEnabled, hasPeerKeys, getFingerprint,
  getPeerFingerprint, formatFingerprint, prepareChat, getPeerDeviceCount, decryptMessages
} from '@/lib/e2ee';
import { isPeerConnected, sendTextP2P, sendTypingP2P, connectToPeer } from '@/lib/p2p';
import { enqueueMessage, sendInOrder, isNetworkFailure, getPendingCount } from '@/lib/offline-queue';
import { saveGeoPoint, cacheSingleMessage } from '@/lib/offline-cache';
import { Chat, Message } from '@/types';
import VoiceMessagePlayer from '@/components/VoiceMessagePlayer';
import MusicPlayer from '@/components/MusicPlayer';
import ConnectionStatus from '@/components/ConnectionStatus';
import EmojiPicker, { renderTextWithEmoji, isCustomEmoji, getEmojiUrl } from '@/components/EmojiPicker';
import VideoThumbnail from '@/components/VideoThumbnail';
import VideoCirclePlayer from '@/components/VideoCirclePlayer';
import VideoCircleRecorder from '@/components/VideoCircleRecorder';
import CameraCapture from '@/components/CameraCapture';
import ImageLightbox, { GalleryImage } from '@/components/ImageLightbox';
import ImageEditorModal from '@/components/ImageEditorModal';
import AttachmentPreview from '@/components/AttachmentPreview';
import GifPicker from '@/components/GifPicker';
import { isChatMuted, setChatMuted } from '@/lib/notifications';

/** Форматирование last_seen — точное время вместо "был(а) недавно" */
function formatLastSeen(lastSeen?: string): string {
  if (!lastSeen) return 'был(а) недавно';
  const date = new Date(lastSeen);
  if (isNaN(date.getTime())) return 'был(а) недавно';
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  if (diffMin < 1) return 'был(а) только что';
  if (diffMin < 60) return `был(а) ${diffMin} мин. назад`;
  if (diffHours < 24) return `был(а) ${diffHours} ч. назад`;
  // Больше суток — показываем дату и время
  const day = date.getDate().toString().padStart(2, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  // Если этот год — без года
  if (date.getFullYear() === now.getFullYear()) {
    return `был(а) ${day}.${month} в ${hours}:${minutes}`;
  }
  return `был(а) ${day}.${month}.${date.getFullYear()} в ${hours}:${minutes}`;
}

// Extract text with custom emoji codes from contentEditable DOM
function extractContentWithEmoji(el: HTMLElement): string {
  let result = '';
  el.childNodes.forEach(node => {
    if (node.nodeType === Node.TEXT_NODE) {
      result += node.textContent || '';
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const elem = node as HTMLElement;
      if (elem.tagName === 'IMG' && elem.dataset.emoji) {
        result += `[e:${elem.dataset.emoji}]`;
      } else if (elem.tagName === 'BR') {
        result += '\n';
      } else {
        result += extractContentWithEmoji(elem);
      }
    }
  });
  return result;
}

// @mention helpers
function getMentionQueryFromCaret(el: HTMLDivElement): string | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  try {
    const range = sel.getRangeAt(0);
    const preRange = document.createRange();
    preRange.selectNodeContents(el);
    preRange.setEnd(range.endContainer, range.endOffset);
    const textBeforeCursor = preRange.toString();
    const match = textBeforeCursor.match(/@([^\s@]*)$/);
    return match ? match[1] : null;
  } catch { return null; }
}

function insertMentionAtCaret(el: HTMLDivElement, username: string) {
  el.focus();
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  try {
    const range = sel.getRangeAt(0);
    const preRange = document.createRange();
    preRange.selectNodeContents(el);
    preRange.setEnd(range.endContainer, range.endOffset);
    const textBefore = preRange.toString();
    const match = textBefore.match(/@([^\s@]*)$/);
    if (!match) return;
    const queryLen = match[0].length;
    const newRange = range.cloneRange();
    newRange.setStart(range.endContainer, Math.max(0, range.endOffset - queryLen));
    newRange.deleteContents();
    const textNode = document.createTextNode(`@${username} `);
    newRange.insertNode(textNode);
    newRange.setStartAfter(textNode);
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);
  } catch { /* ignore */ }
}

// Set contentEditable content, rendering emoji codes as <img>
function setContentEditableWithEmoji(el: HTMLElement, content: string) {
  el.innerHTML = '';
  const regex = /\[e:(\d+_\d+)\]/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      el.appendChild(document.createTextNode(content.slice(lastIndex, match.index)));
    }
    const img = document.createElement('img');
    img.src = `/emoji/${match[1]}.png?v2`;
    img.dataset.emoji = match[1];
    img.className = 'inline-emoji';
    img.draggable = false;
    el.appendChild(img);
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < content.length) {
    el.appendChild(document.createTextNode(content.slice(lastIndex)));
  }
}

// Insert a custom emoji <img> at the end of contentEditable
function appendEmojiToContentEditable(el: HTMLElement, emojiCode: string) {
  const m = emojiCode.match(/\[e:(\d+_\d+)\]/);
  if (m) {
    const img = document.createElement('img');
    img.src = `/emoji/${m[1]}.png?v2`;
    img.dataset.emoji = m[1];
    img.className = 'inline-emoji';
    img.draggable = false;
    el.appendChild(img);
  } else {
    // Regular unicode emoji
    el.appendChild(document.createTextNode(emojiCode));
  }
}
import { 
  Flag,
  Phone, 
  Video, 
  MoreVertical, 
  Paperclip, 
  Smile, 
  Send,
  ArrowDown,
  ArrowLeft,
  Check,
  CheckCheck,
  Loader2,
  Mic,
  X,
  Square,
  Trash2,
  Lock,
  Wifi,
  Shield,
  ShieldCheck,
  Download,
  FileIcon,
  User as UserIcon,
  Edit3,
  AtSign,
  Clock,
  ChevronLeft,
  Reply,
  Forward,
  CornerDownRight,
  Search,
  Image as ImageIcon,
  MapPin,
  Music as MusicIcon,
  Key,
  Copy,
  CornerUpLeft,
  Keyboard,
  Users,
  SmilePlus,
  Camera,
  Link as LinkIcon,
  Play,
  Film,
  Eye,
  MessageSquare,
  MessageCircle,
  BellOff,
  Bell,
  LogOut,
  UserPlus,
  Pencil,
  Bookmark
} from 'lucide-react';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';
import { useNavigate } from 'react-router-dom';
import { useThemeStore } from '@/store/theme';
import { ReactionSummary } from '@/types';
import { getWallpaperCSS } from '@/lib/wallpapers';

interface ChatAreaProps {
  chat: Chat;
  onInitiateCall?: (type: 'audio' | 'video', forceRelay?: boolean) => void;
  isCallActive?: boolean;
}

interface VoiceTranscription {
  [messageId: string]: {
    text: string;
    isLoading: boolean;
    error?: string;
  };
}

export default function ChatArea({ chat, onInitiateCall, isCallActive }: ChatAreaProps) {
  const user = useAuthStore((state) => state.user);
  const { messages, typingUsers, clearUnread, onlineUsers, chats, hasMoreMessages, prependMessages, setHasMoreMessages } = useChatStore();
  const { wallpaper, resolvedTheme, customGradient, customImage, imageOpacity } = useThemeStore();
  const navigate = useNavigate();
  const chatMessages = messages[chat.id] || [];

  // Собираем все изображения чата для галереи
  const galleryImages = useMemo<GalleryImage[]>(() => {
    return chatMessages
      .filter((m: Message) => m.type === 'image' || m.type === 'gif')
      .map((m: Message) => {
        const meta = typeof m.metadata === 'string' ? (() => { try { return JSON.parse(m.metadata); } catch { return null; } })() : m.metadata;
        const fileId = meta?.file_id;
        if (!fileId) return null;
        return {
          fileId,
          messageId: m.id,
          url: fileApi.getViewUrl(fileId),
          downloadUrl: fileApi.getDownloadUrl(fileId),
        };
      })
      .filter(Boolean) as GalleryImage[];
  }, [chatMessages]);

  const openLightbox = (fileId: string) => {
    const idx = galleryImages.findIndex(g => g.fileId === fileId);
    if (idx >= 0) {
      setLightboxIndex(idx);
      setLightboxOpen(true);
    }
  };

  const wallpaperStyle = getWallpaperCSS(wallpaper, resolvedTheme === 'dark', {
    gradient: customGradient,
    image: customImage,
    imageOpacity,
  });
  const [messageText, setMessageText] = useState('');
  const [sending, setSending] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [transcriptions, setTranscriptions] = useState<VoiceTranscription>({});
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; message: Message } | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<{ message: Message } | null>(null);
  // Жалоба на чужое сообщение: причина + комментарий → модераторам
  const [reportDialog, setReportDialog] = useState<{ message: Message; reason: string; comment: string; sending: boolean; done?: string } | null>(null);
  const [p2pConnected, setP2PConnected] = useState(false);
  const [showFingerprint, setShowFingerprint] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showGifPicker, setShowGifPicker] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  // Загрузки этого чата плюс те, что ещё не убрали с глаз после завершения.
  const allUploads = useUploadStore(s => s.items);
  const visibleUploads = useMemo(
    () => allUploads.filter(u => u.chatId === chat.id && u.status !== 'canceled'),
    [allUploads, chat.id],
  );
  const uploadQueueRef = useRef<(() => Promise<void>)[]>([]);
  const isProcessingQueueRef = useRef(false);

  const enqueueUpload = async (task: () => Promise<void>) => {
    uploadQueueRef.current.push(task);
    if (!isProcessingQueueRef.current) {
      isProcessingQueueRef.current = true;
      setUploadingFile(true);
      while (uploadQueueRef.current.length > 0) {
        const nextTask = uploadQueueRef.current.shift();
        if (nextTask) {
          try {
            await nextTask();
          } catch (e) {
            console.error('Task in upload queue failed:', e);
          }
        }
      }
      isProcessingQueueRef.current = false;
      setUploadingFile(false);
    }
  };

  // Отправка файла с записью в общий журнал загрузок.
  //
  // Раньше все восемь мест в этом файле звали smartUpload с `undefined`
  // вместо обработчика прогресса: механизм процентов был написан, но им никто
  // не пользовался, и человек видел только крутилку со словом «Загрузка».
  // Теперь каждая отправка попадает в журнал — с именем, размером,
  // процентом, скоростью, остатком времени и кнопкой отмены.
  const trackedUpload = (file: File) => {
    const id = `${chat.id}:${file.name}:${file.size}:${file.lastModified}`;
    const controller = new AbortController();
    const store = useUploadStore.getState();
    store.start({
      id, fileName: file.name, fileSize: file.size,
      source: 'chat', chatId: chat.id, abort: () => controller.abort(),
    });
    return fileApi.smartUpload(file, undefined, 'chat', {
      signal: controller.signal,
      onSession: (sessionId) => useUploadStore.getState().setSession(id, sessionId),
      onTick: (t) => useUploadStore.getState().progress(id, t.loaded, t.stage, t.percent),
    }).then(res => {
      useUploadStore.getState().finish(id, 'done');
      return res;
    }).catch(err => {
      const canceled = err?.name === 'AbortError' || err?.code === 'ERR_CANCELED';
      useUploadStore.getState().finish(id, canceled ? 'canceled' : 'error',
        canceled ? undefined : (err?.message || 'Не удалось отправить'));
      throw err;
    });
  };
  const [showDropdownMenu, setShowDropdownMenu] = useState(false);
  const [showCallMenu, setShowCallMenu] = useState<'audio' | 'video' | null>(null);
  const [chatMuted, setChatMutedState] = useState(() => isChatMuted(chat.id));
  const [showUserInfo, setShowUserInfo] = useState(false);
  // Отключены ли уведомления от собеседника — настройка живёт на сервере.
  // Локальный список беззвучных чатов тоже есть, но он молчит только внутри
  // открытого приложения: сервер о нём не знает и продолжает слать
  // уведомления на телефон. Отсюда и жалобы, что кнопка не работает.
  const [contactMuted, setContactMuted] = useState(false);
  const [showAvatarFullscreen, setShowAvatarFullscreen] = useState(false);
  const [editingLocalNick, setEditingLocalNick] = useState(false);
  const [localNickInput, setLocalNickInput] = useState('');
  const localAvatarInputRef = useRef<HTMLInputElement>(null);
  const groupAvatarInputRef = useRef<HTMLInputElement>(null);
  const [replyToMessage, setReplyToMessage] = useState<Message | null>(null);
  const [forwardMessage, setForwardMessage] = useState<Message | null>(null);
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  const [showAttachmentMenu, setShowAttachmentMenu] = useState(false);
  const [showVideoCircleRecorder, setShowVideoCircleRecorder] = useState(false);
  const [showCameraCapture, setShowCameraCapture] = useState(false);
  const [showReactionPicker, setShowReactionPicker] = useState<{ messageId: string; chatId: string } | null>(null);
  const [infoTab, setInfoTab] = useState<'info' | 'media' | 'files' | 'music' | 'voice' | 'links'>('info');
  const [mediaItems, setMediaItems] = useState<Message[]>([]);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaSearchQuery, setMediaSearchQuery] = useState('');
  const [mediaItemMenu, setMediaItemMenu] = useState<{ msg: Message; x: number; y: number } | null>(null);
  const [showChatSearch, setShowChatSearch] = useState(false);
  const [chatSearchQuery, setChatSearchQuery] = useState('');
  const [chatSearchResults, setChatSearchResults] = useState<Message[]>([]);
  const [chatSearchLoading, setChatSearchLoading] = useState(false);
  const mediaLongPressTimer = useRef<any>(null);
  // Меню медиа открыто длинным нажатием — палец ещё на экране. Закрывать
  // разрешаем только по НОВОМУ касанию, а не по отпусканию того же пальца.
  const mediaMenuArmedRef = useRef(false);
  // Чат ещё не «приземлился» на последнее сообщение: пока флаг стоит,
  // любое изменение высоты ленты доводит её до низа принудительно.
  const pinToBottomRef = useRef(true);
  const musicInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Флаг: идёт загрузка старых сообщений (prepend) — НЕ скролить вниз
  const isLoadingOlderRef = useRef(false);
  // Флаг: пользователь осознанно скроллит вверх — НЕ мешать
  const userScrolledUpRef = useRef(false);
  // Invite members dialog state
  const [showInviteMembers, setShowInviteMembers] = useState(false);
  const [inviteSearchQuery, setInviteSearchQuery] = useState('');
  const [inviteSearchResults, setInviteSearchResults] = useState<any[]>([]);
  const [inviteSearching, setInviteSearching] = useState(false);
  const [imageEditorFile, setImageEditorFile] = useState<File | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<File[] | null>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const attachmentMenuRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messageInputRef = useRef<HTMLDivElement>(null);

  const getOtherUser = () => {
    if (chat.type === 'group') return null;
    return chat.members?.find(m => m.id !== user?.id);
  };

  const otherUser = getOtherUser();
  const isOnline = otherUser ? onlineUsers.has(otherUser.id) : false;
  const isGroup = chat.type === 'group' || chat.type === 'channel';

  // Ключи собеседника подтягиваем при открытии переписки.
  //
  // Здесь был замкнутый круг, из-за которого шифрование не сработало ни
  // разу за всю историю: шифровали только при наличии ключей в памяти, а в
  // память они попадали только в момент шифрования. Кэш пуст с рождения —
  // значит не шифруем — значит за ключами не идём.
  const [peerKeysReady, setPeerKeysReady] = useState(false);
  useEffect(() => {
    setPeerKeysReady(false);
    if (!isE2EEEnabled() || !otherUser) return;
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    let cancelled = false;
    void prepareChat(otherUser.id, token).then(ok => {
      if (!cancelled) setPeerKeysReady(ok);
    });
    return () => { cancelled = true; };
  }, [otherUser?.id]);

  const e2eeActive = isE2EEEnabled() && !!otherUser && (peerKeysReady || hasPeerKeys(otherUser.id));

  // Lightbox gallery state
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);

  // Стабильный цвет на основе userId
  const senderColors = ['#e17076', '#7bc862', '#e5ca77', '#65aadd', '#a695e7', '#ee7aae', '#6ec9cb', '#faa774'];
  const getSenderColor = (userId: string) => {
    let hash = 0;
    for (let i = 0; i < userId.length; i++) hash = ((hash << 5) - hash) + userId.charCodeAt(i);
    return senderColors[Math.abs(hash) % senderColors.length];
  };

  const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '👎'];

  // Invite members handlers
  const inviteSearchTimer = useRef<any>(null);
  const handleInviteSearch = async (query: string) => {
    setInviteSearchQuery(query);
    const cleanQuery = query.startsWith('@') ? query.slice(1) : query;
    if (cleanQuery.length < 2) { setInviteSearchResults([]); return; }
    
    if (inviteSearchTimer.current) clearTimeout(inviteSearchTimer.current);
    
    inviteSearchTimer.current = setTimeout(async () => {
      setInviteSearching(true);
      try {
        const response = await userApi.search(cleanQuery);
        const existingIds = chat.members?.map((m: any) => m.id) || [];
        setInviteSearchResults(response.data.users.filter((u: any) => u.id !== user?.id && !existingIds.includes(u.id)));
      } catch (e) { console.error('Invite search failed:', e); }
      finally { setInviteSearching(false); }
    }, 500);
  };

  const handleInviteMember = async (u: any) => {
    try {
      await chatApi.addMember(chat.id, u.id);
      setInviteSearchResults(prev => prev.filter(r => r.id !== u.id));
    } catch (e) { console.error('Invite failed:', e); }
  };

  const handleToggleReaction = async (chatId: string, messageId: string, emoji: string) => {
    try {
      await chatApi.toggleReaction(chatId, messageId, emoji);
    } catch (err) {
      console.error('Failed to toggle reaction:', err);
    }
  };

  const handleGroupAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !file.type.startsWith('image/')) return;
    try {
      const { data } = await chatApi.uploadGroupAvatar(chat.id, file);
      useChatStore.getState().updateChat(chat.id, { avatar_url: data.avatarUrl });
    } catch (err) {
      console.error('Failed to upload group avatar:', err);
    }
  };

  // Подписи и аватарки контактов держит общий стор: он же пишет их в
  // память браузера, он же отправляет на сервер и он же перерисовывает
  // список чатов. Раньше каждое место возилось с localStorage само, и
  // сохранение подписи затирало на сервере аватарку — см. комментарий в
  // store/contactOverrides.ts.
  const contactOverrides = useContactOverrides(s => s.map);

  const getLocalAvatar = (userId: string): string | null => contactOverrides[userId]?.avatar || null;

  const setLocalAvatar = (userId: string, dataUrl: string | null) => {
    useContactOverrides.getState().setAvatar(userId, dataUrl);
  };

  const handleLocalAvatarUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !otherUser) return;
    if (!file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      const canvas = document.createElement('canvas');
      const img = new window.Image();
      img.onload = () => {
        const size = 256;
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d')!;
        const s = Math.min(img.width, img.height);
        const sx = (img.width - s) / 2;
        const sy = (img.height - s) / 2;
        ctx.drawImage(img, sx, sy, s, s, 0, 0, size, size);
        setLocalAvatar(otherUser.id, canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const getUserAvatarUrl = () => {
    if (!otherUser) return chat.avatar_url;
    return getLocalAvatar(otherUser.id) || otherUser.avatar_url;
  };

  const getLocalNick = (userId: string): string | null => contactOverrides[userId]?.nick || null;

  const setLocalNick = (userId: string, nick: string | null) => {
    useContactOverrides.getState().setNick(userId, nick);
  };

  const isSavedMessages = chat.type === 'favorites' || (chat.type === 'private' && (chat.members?.every(m => m.id === user?.id) ?? false));

  const getDisplayName = () => {
    if (chat.type === 'group' || chat.type === 'channel') return chat.name || (chat.type === 'group' ? 'Группа' : 'Канал');
    if (isSavedMessages) return 'Избранное';
    if (!otherUser) return '?';
    const localNick = getLocalNick(otherUser.id);
    return localNick || otherUser.display_name || otherUser.username;
  };

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (showDropdownMenu && dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdownMenu(false);
      }
      if (showAttachmentMenu && attachmentMenuRef.current && !attachmentMenuRef.current.contains(e.target as Node)) {
        // Check if we clicked the paperclip button to avoid immediate toggle off
        const paperclipBtn = document.getElementById('paperclip-btn');
        if (paperclipBtn && paperclipBtn.contains(e.target as Node)) return;
        setShowAttachmentMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showDropdownMenu, showAttachmentMenu]);

  useEffect(() => {
    if (!otherUser) return;
    const checkP2P = () => setP2PConnected(isPeerConnected(otherUser.id));
    checkP2P();
    const interval = setInterval(checkP2P, 2000);
    return () => clearInterval(interval);
  }, [otherUser?.id]);

  // Завершённые загрузки сами уходят с глаз через несколько секунд.
  // Ошибки оставляем — их человек должен увидеть и убрать сам.
  useEffect(() => {
    const done = allUploads.filter(u => u.status === 'done');
    if (done.length === 0) return;
    const t = setTimeout(() => {
      const store = useUploadStore.getState();
      done.forEach(u => store.remove(u.id));
    }, 4000);
    return () => clearTimeout(t);
  }, [allUploads]);

  // Прыжок к последнему сообщению. Двигаем сам контейнер, а не зовём
  // scrollIntoView на якоре: якорь может быть ещё не отрисован (лента
  // приходит из кэша и из сети асинхронно), и тогда scrollIntoView молча
  // ничего не делает — именно из-за этого чат открывался где-то вверху.
  const scrollToBottom = (instant?: boolean) => {
    const c = messagesContainerRef.current;
    if (c) {
      // Явное behavior обязательно: у контейнера в разметке класс
      // scroll-smooth, то есть scroll-behavior: smooth. Простое
      // присваивание scrollTop подчиняется этому стилю и вместо прыжка
      // запускает анимацию — а если её каждый кадр перезапускать, лента
      // ползёт к последнему сообщению секунд восемь.
      c.scrollTo({ top: c.scrollHeight, behavior: instant ? 'instant' : 'smooth' });
      return;
    }
    messagesEndRef.current?.scrollIntoView({ behavior: instant ? 'instant' : 'smooth' });
  };

  // При смене чата — скроллим вниз, сбрасываем флаги
  useEffect(() => {
    userScrolledUpRef.current = false;
    isLoadingOlderRef.current = false;
    pinToBottomRef.current = true;
    scrollToBottom(true);
    clearUnread(chat.id);
    if (chatMessages.length > 0) {
      socketEmit.markAsRead(chat.id, chatMessages[chatMessages.length - 1].id);
    }
    // Убираем нативные уведомления для этого чата (Android APK)
    try { (window as any).AndroidBridge?.dismissMessageNotifications?.(chat.id); } catch (e) {}
    setChatMutedState(isChatMuted(chat.id));
  }, [chat.id]);

  // Держим ленту у последнего сообщения, пока чат «устаканивается».
  //
  // Раньше здесь было два вызова scrollToBottom — сразу и через 100 мс. Оба
  // приходились на момент, когда сообщений в DOM ещё нет: список берётся из
  // IndexedDB и с сервера, картинки и кружочки догружаются потом и раздвигают
  // ленту уже после «скролла». Дальше работало правило «доводить до низа,
  // только если пользователь уже у низа» — а он оказывался у самого верха,
  // и правило молчало. Отсюда «откидывает куда-то вверх».
  //
  // Теперь за высотой контейнера следит ResizeObserver: пока стоит
  // pinToBottomRef, каждое изменение размеров возвращает ленту вниз. Флаг
  // снимается при первой же осознанной прокрутке пользователя (см.
  // handleScroll) либо через 1,5 с после того, как лента перестала расти.
  useEffect(() => {
    // Контейнер намеренно НЕ берём здесь один раз. В момент запуска эффекта
    // его ещё нет в дереве: пока список сообщений не готов, на экране стоит
    // заглушка. Прошлая версия проверяла ref в начале, выходила по `return`
    // и больше не запускалась — доводка не выполнялась ни разу. Ищем
    // контейнер в каждом кадре.

    // Доводим покадрово, а не по событиям.
    //
    // Через ResizeObserver это не работает: контейнер занимает всю
    // свободную высоту и сам не меняет размер, а растут его дети — по
    // одному узлу на сообщение (их полсотни). Наблюдатель за контейнером
    // молчал, и «доводка» не выполнялась ни разу.
    //
    // Кадровый цикл проще и надёжнее: пока лента растёт (приходят
    // сообщения, догружаются картинки и кружочки), мы каждый кадр
    // возвращаемся к последнему сообщению. Цикл заканчивается, когда
    // высота перестала меняться и мы действительно внизу — либо по
    // жёсткому пределу, чтобы не крутиться на медленной сети вечно.
    const HARD_STOP_MS = 15000;
    const STABLE_MS = 700;

    // Картинки без заданных размеров занимают ноль высоты, пока не
    // загрузятся, а потом разом раздвигают ленту на тысячи пикселей.
    // В живом чате их полтора десятка, и приходят они секунд восемь —
    // если бросить доводку раньше, чат так и останется висеть посреди
    // истории. Поэтому ждём, пока картинки встанут.
    const imagesSettled = (el: HTMLElement) =>
      [...el.querySelectorAll('img')].every(img => img.complete);

    let raf = 0;
    let lastHeight = -1;
    let stableSince = 0;
    const startedAt = performance.now();

    const step = (now: number) => {
      if (!pinToBottomRef.current) return;
      const expired = now - startedAt > HARD_STOP_MS;

      const container = messagesContainerRef.current;
      if (!container) {
        // Список ещё не отрисован — ждём следующего кадра.
        if (expired) { pinToBottomRef.current = false; return; }
        raf = requestAnimationFrame(step);
        return;
      }

      const h = container.scrollHeight;
      if (h !== lastHeight) { lastHeight = h; stableSince = now; }

      const target = h - container.clientHeight;
      if (Math.abs(container.scrollTop - target) > 1) {
        // Именно scrollTo с behavior:'instant', а не scrollTop = target:
        // у контейнера класс scroll-smooth, и присваивание запускало бы
        // анимацию, которую следующий кадр тут же перезапускает.
        container.scrollTo({ top: target, behavior: 'instant' });
      }

      const settled = stableSince > 0 && now - stableSince > STABLE_MS && imagesSettled(container);
      if (settled || expired) { pinToBottomRef.current = false; return; }

      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);

    // Снимаем доводку только по настоящему жесту. Событие scroll для этого
    // не годится: его порождает и наш собственный scrollTop, и тогда лента
    // бросает доводку на полпути и застывает посреди истории. Слушаем на
    // окне, потому что контейнера в момент подписки ещё может не быть.
    const release = () => { pinToBottomRef.current = false; };
    window.addEventListener('wheel', release, { passive: true });
    window.addEventListener('touchstart', release, { passive: true });
    window.addEventListener('keydown', release);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('wheel', release);
      window.removeEventListener('touchstart', release);
      window.removeEventListener('keydown', release);
    };
  }, [chat.id]);

  // Помечаем как прочитанное при возвращении на вкладку
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && chatMessages.length > 0) {
        const lastMsg = chatMessages[chatMessages.length - 1];
        if (lastMsg.sender_id !== user?.id) {
          socketEmit.markAsRead(chat.id, lastMsg.id);
          clearUnread(chat.id);
        }
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [chat.id, chatMessages.length]);

  useEffect(() => {
    // НЕ скроллим если идёт загрузка старых сообщений (prepend) —
    // иначе scrollToBottom борется с восстановлением позиции в loadOlderMessages
    if (isLoadingOlderRef.current) return;

    const container = messagesContainerRef.current;
    if (container) {
      const distFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      // Скроллим вниз ТОЛЬКО если пользователь УЖЕ внизу (< 300px от дна)
      // или пользователь не скроллил вверх осознанно
      if (distFromBottom < 300 && !userScrolledUpRef.current) {
        scrollToBottom();
      }
    }
    // Помечаем сообщения как прочитанные после загрузки / получения новых
    if (chatMessages.length > 0) {
      const lastMsg = chatMessages[chatMessages.length - 1];
      if (lastMsg.sender_id !== user?.id) {
        // Помечаем как прочитанные только если пользователь видит низ чата
        const container2 = messagesContainerRef.current;
        const nearBottom = container2 ? (container2.scrollHeight - container2.scrollTop - container2.clientHeight < 300) : true;
        if (nearBottom && !userScrolledUpRef.current) {
          socketEmit.markAsRead(chat.id, lastMsg.id);
          clearUnread(chat.id);
        }
      }
    }
  }, [chatMessages.length]);

  // Scroll to bottom when mobile keyboard appears (visualViewport shrinks)
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let prevHeight = vv.height;

    const onResize = () => {
      const newHeight = vv.height;
      // Keyboard appeared — viewport got shorter
      // НО не скроллим если пользователь осознанно листает вверх
      if (newHeight < prevHeight - 50 && !userScrolledUpRef.current) {
        setTimeout(() => {
          messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
        }, 80);
      }
      prevHeight = newHeight;
    };

    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, [chat.id]);

  // Throttled scroll handler — не чаще 1 раза в 100ms, предотвращает спам
  const scrollThrottleRef = useRef(false);
  const handleScroll = () => {
    if (scrollThrottleRef.current) return;
    scrollThrottleRef.current = true;
    setTimeout(() => { scrollThrottleRef.current = false; }, 100);

    const container = messagesContainerRef.current;
    if (!container) return;

    const distFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const isNearBottom = distFromBottom < 200;

    // Отслеживаем: пользователь осознанно листает вверх.
    //
    // Флаг pinToBottomRef здесь НЕ трогаем. Этот обработчик срабатывает и на
    // наш собственный программный скролл: пока лента едет к последнему
    // сообщению, она проходит через «далеко от низа», и снятие флага прямо
    // здесь отменяло доводку на полпути — чат так и оставался посередине.
    // Флаг снимает только настоящий жест пальцем или колесом (см. эффект
    // с pinToBottomRef ниже).
    if (!isNearBottom && !isLoadingOlderRef.current) {
      userScrolledUpRef.current = true;
    }
    if (isNearBottom) {
      userScrolledUpRef.current = false;
    }

    setShowScrollButton(!isNearBottom);

    // Помечаем сообщения как прочитанные при прокрутке вниз
    if (isNearBottom && chatMessages.length > 0) {
      const lastMsg = chatMessages[chatMessages.length - 1];
      if (lastMsg.sender_id !== user?.id) {
        socketEmit.markAsRead(chat.id, lastMsg.id);
        clearUnread(chat.id);
      }
    }
    // Подгрузка старых сообщений при скролле вверх.
    // Не трогаем, пока лента ещё едет к последнему сообщению: иначе на
    // открытии чата мы оказываемся у нуля по scrollTop и сами себе
    // подгружаем историю, дёргая позицию.
    if (container.scrollTop < 300 && !pinToBottomRef.current
        && !loadingOlder && !isLoadingOlderRef.current && hasMoreMessages[chat.id]) {
      loadOlderMessages();
    }
  };

  const loadOlderMessages = async () => {
    if (loadingOlder || isLoadingOlderRef.current || !hasMoreMessages[chat.id] || chatMessages.length === 0) return;
    isLoadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const oldestMsg = chatMessages[0];
      const MSG_LIMIT = 50;
      const { data } = await chatApi.getMessages(chat.id, oldestMsg.created_at, MSG_LIMIT);
      const olderMsgs = await decryptMessages<Message>(
        data.messages || [], useAuthStore.getState().accessToken || '', user?.id);
      if (olderMsgs.length > 0) {
        // Сохраняем позицию скролла ПЕРЕД prepend
        const container = messagesContainerRef.current;
        const prevScrollHeight = container?.scrollHeight || 0;
        const prevScrollTop = container?.scrollTop || 0;
        prependMessages(chat.id, olderMsgs);
        // Восстанавливаем позицию скролла после добавления старых сообщений
        // Двойной rAF гарантирует что DOM обновился
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (container) {
              const newScrollHeight = container.scrollHeight;
              container.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
            }
            // Снимаем флаг ПОСЛЕ восстановления позиции
            isLoadingOlderRef.current = false;
          });
        });
      } else {
        isLoadingOlderRef.current = false;
      }
      setHasMoreMessages(chat.id, olderMsgs.length >= MSG_LIMIT);
    } catch (e) {
      console.error('Failed to load older messages:', e);
      isLoadingOlderRef.current = false;
    } finally {
      setLoadingOlder(false);
    }
  };

  const handleSendMessage = async () => {
    if (!messageText.trim()) return;

    const content = messageText.trim();

    // Editing mode
    if (editingMessage) {
      setMessageText('');
      if (messageInputRef.current) {
        messageInputRef.current.innerHTML = '';
        messageInputRef.current.focus();
      }
      setEditingMessage(null);
      setSending(true);
      try {
        await socketEmit.editMessage(chat.id, editingMessage.id, content);
      } catch (error) {
        console.error('Failed to edit message:', error);
        setMessageText(content);
        if (messageInputRef.current) setContentEditableWithEmoji(messageInputRef.current, content);
      } finally {
        setSending(false);
      }
      return;
    }

    const replyId = replyToMessage?.id;
    setMessageText('');
    if (messageInputRef.current) {
      messageInputRef.current.innerHTML = '';
      messageInputRef.current.focus();
    }
    setReplyToMessage(null);

    // === ОПТИМИСТИЧНАЯ ВСТАВКА: сообщение сразу появляется в чате ===
    const currentUser = useAuthStore.getState().user;
    const pendingId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const optimisticMsg: Message = {
      id: pendingId,
      chat_id: chat.id,
      sender_id: currentUser?.id || '',
      sender: currentUser as any,
      content,
      type: 'text',
      status: 'pending',
      reply_to_id: replyId,
      created_at: new Date().toISOString(),
    };
    useChatStore.getState().addMessage(optimisticMsg);
    userScrolledUpRef.current = false;
    scrollToBottom();

    // Mesh (BLE, дальше LoRa): тот же client_id, что уйдёт на сервер, —
    // получатель склеит копию из mesh с серверной. Раньше mesh включался
    // только после провала отправки на сервер, то есть через 10 с таймаута.
    let meshSent = false;
    const meshFanout = () => {
      if (meshSent) return;
      try {
        const bridge = (window as any).AndroidBridge;
        if (!bridge?.isMeshActive?.()) return;
        const me = useAuthStore.getState().user;
        const name = me?.display_name || me?.username || 'User';
        if (bridge.sendMeshMessageWithId) bridge.sendMeshMessageWithId(content, name, null, String(chat.id), pendingId);
        else if (bridge.sendMeshMessage) bridge.sendMeshMessage(content, name, null, String(chat.id));
        else return;
        meshSent = true;
        useChatStore.getState().updateMessage(pendingId, { metadata: { viaMesh: true } as any });
        console.log('📡 [MESH] отправлено по mesh');
      } catch (meshErr) {
        console.warn('📡 [MESH] не ушло:', meshErr);
      }
    };
    // LoRa (свой узел Meshtastic): тот же client_id — копии склеятся
    let loraSent = false;
    const loraFanout = () => {
      if (loraSent) return;
      const me = useAuthStore.getState().user;
      if (!me?.id || getLoraStatus().state !== 'ready') return;
      loraSent = true;
      loraSendChat(String(chat.id), me.id, pendingId, content).then(ok => {
        if (ok) {
          useChatStore.getState().updateMessage(pendingId, { metadata: { viaLora: true } as any });
          console.log('📡 [LoRa] отправлено в эфир');
        }
      });
    };
    // Сервер недоступен — в mesh и LoRa сразу; на сервер уйдёт из очереди
    if (!isSocketConnected()) { meshFanout(); loraFanout(); }

    // Сообщение уже показано — ставим в очередь для повторной отправки.
    const queueIt = () => enqueueMessage({
      id: pendingId,
      chatId: chat.id,
      content,
      type: 'text',
      replyToId: replyId,
    });

    try {
      // Всё — от шифрования до постановки в очередь при сбое — одним звеном
      // цепочки: место в ней занимается синхронно, в момент нажатия. Иначе
      // следующее сообщение обгонит это, пока оно шифруется или висит на
      // таймауте (см. sendInOrder).
      const queued = await sendInOrder(async () => {
        // Пока в очереди лежат недоставленные — новое встаёт за ними.
        if (getPendingCount() > 0) {
          await queueIt();
          return true;
        }

        const token = useAuthStore.getState().accessToken;
        if (otherUser && p2pConnected) {
          sendTextP2P(otherUser.id, crypto.randomUUID(), content);
        }

        // Шифруем не «для человека», а для каждого его устройства, и заодно
        // для своих остальных — иначе отправленное с компьютера не откроется
        // на телефоне.
        let encrypted = null;
        if (e2eeActive && otherUser && token) {
          encrypted = await encryptMessage(content, otherUser.id, token, user?.id);
        }

        let response;
        try {
          if (encrypted) {
            response = await chatApi.sendMessage(chat.id, {
              content: '🔒',
              reply_to_id: replyId,
              metadata: { e2ee: encrypted } as any,
              client_id: pendingId,
            });
          } else {
            response = await chatApi.sendMessage(chat.id, { content, reply_to_id: replyId, client_id: pendingId });
          }
        } catch (error) {
          // Если ответ есть (4xx/5xx), сервер запрос получил — в очередь
          // нельзя. Нет ответа или таймаут — недоставка, и в очередь его
          // кладём ЗДЕСЬ, внутри звена: следующее сообщение должно уже
          // увидеть очередь непустой.
          if (!isNetworkFailure(error)) throw error;
          console.error('Failed to send message:', error);
          await queueIt();
          return true;
        }
        // Заменяем оптимистичное сообщение на реальное от сервера
        const sentMsg = response.data?.message;
        if (sentMsg) {
          if (encrypted) {
            sentMsg.content = content;
            sentMsg.metadata = { ...sentMsg.metadata, e2ee_decrypted: true };
          }
          useChatStore.getState().replacePendingMessage(pendingId, sentMsg);
          cacheSingleMessage(sentMsg).catch(() => {});
        }
        return false;
      });
      stopTyping();

      if (queued) {
        console.log('📦 Message queued for offline delivery');

        meshFanout();
        loraFanout();
      }
    } catch (error) {
      // Сервер ответил ошибкой (или очередь не записалась) — помечаем как
      // failed: красный крестик, не крутящиеся часики.
      console.error('Failed to send message:', error);
      useChatStore.getState().updateMessage(pendingId, { status: 'failed' as any });
    } finally {
      scrollToBottom();
      requestAnimationFrame(() => messageInputRef.current?.focus());
    }
  };

  const handleMediaClick = (clickedMsgIndex: number, type: 'audio' | 'video') => {
    const store = useMediaStore.getState();
    const queueItems: any[] = [];
    let startAt = 0;

    // Очередь — ВСЕ записи этого вида в переписке, а не только те, что
    // ниже нажатой. Раньше собирались лишь последующие, и вернуться к
    // предыдущей песне было нельзя: кнопка «назад» упиралась в пустоту,
    // хотя выше в чате лежала половина списка.
    for (let i = 0; i < chatMessages.length; i++) {
      const msg = chatMessages[i];
      if (msg.type === type) {
        const meta = typeof msg.metadata === 'string' ? (() => { try { return JSON.parse(msg.metadata); } catch { return null; } })() : msg.metadata;
        const fileId = meta?.file_id;
        if (!fileId) continue;
        const url = fileApi.getViewUrl(fileId);
        const downloadUrl = fileApi.getDownloadUrl(fileId);
        // Запоминаем, на какой записи в собранном списке оказалась нажатая.
        if (i === clickedMsgIndex) startAt = queueItems.length;
        queueItems.push({
          type,
          url,
          fileName: meta?.file_name || msg.content || (type === 'audio' ? 'Аудио' : 'Видео'),
          fileSize: meta?.file_size,
          downloadUrl: downloadUrl,
          id: msg.id
        });
      }
    }

    if (queueItems.length > 0) {
      store.playQueue(queueItems, startAt);
    }
  };

  const handleMusicUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    
    enqueueUpload(async () => {
      try {
        for (const file of Array.from(files)) {
          const response = await trackedUpload(file);
          const uploadedFile = response.data.file;
          const msgResponse = await chatApi.sendMessage(chat.id, {
            content: uploadedFile.original_name,
            type: 'audio',
            metadata: { file_id: uploadedFile.id, file_name: uploadedFile.original_name, file_size: uploadedFile.size, mime_type: uploadedFile.mime_type || file.type } as any,
          });
          const sentMsg = msgResponse.data?.message;
          if (sentMsg) {
            useChatStore.getState().addMessage(sentMsg);
            cacheSingleMessage(sentMsg).catch(() => {});
          }
        }
        userScrolledUpRef.current = false;
        scrollToBottom();
      } catch (error) { console.error('Music upload failed:', error); }
      finally { if (musicInputRef.current) musicInputRef.current.value = ''; }
    });
  };

  const handleVideoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    
    enqueueUpload(async () => {
      try {
        for (const file of Array.from(files)) {
          const response = await trackedUpload(file);
          const uploadedFile = response.data.file;
          const msgResponse = await chatApi.sendMessage(chat.id, {
            content: uploadedFile.original_name,
            type: 'video',
            metadata: { file_id: uploadedFile.id, file_name: uploadedFile.original_name, file_size: uploadedFile.size, mime_type: uploadedFile.mime_type || file.type } as any,
          });
          const sentMsg = msgResponse.data?.message;
          if (sentMsg) {
            useChatStore.getState().addMessage(sentMsg);
            cacheSingleMessage(sentMsg).catch(() => {});
          }
        }
        userScrolledUpRef.current = false;
        scrollToBottom();
      } catch (error) { console.error('Video upload failed:', error); }
      finally { if (videoInputRef.current) videoInputRef.current.value = ''; }
    });
  };

  const startTyping = () => {
    socketEmit.startTyping(chat.id);
    if (otherUser && p2pConnected) sendTypingP2P(otherUser.id, true);
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => stopTyping(), 3000);
  };

  const stopTyping = () => {
    socketEmit.stopTyping(chat.id);
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
  };

  const handleStartRecording = async () => {
    const started = await startRecording();
    if (started) {
      setIsRecording(true);
      setRecordingDuration(0);
      const interval = setInterval(() => setRecordingDuration(d => d + 1), 1000);
      (window as any).recordingInterval = interval;
    }
  };

  const handleStopRecording = async () => {
    if ((window as any).recordingInterval) clearInterval((window as any).recordingInterval);
    const result = await stopRecording();
    setIsRecording(false);
    if (result && result.blob) {
      enqueueUpload(async () => {
        try {
          const voiceResponse = await chatApi.sendVoiceMessage(chat.id, result.blob, result.duration);
          const sentMsg = voiceResponse.data?.message;
          if (sentMsg) {
            useChatStore.getState().addMessage(sentMsg);
            cacheSingleMessage(sentMsg).catch(() => {});
          }
          userScrolledUpRef.current = false;
          scrollToBottom();
        } catch (error) { console.error('Voice send failed:', error); }
      });
    }
  };

  const handleCancelRecording = () => {
    if ((window as any).recordingInterval) clearInterval((window as any).recordingInterval);
    cancelRecording();
    setIsRecording(false);
    setRecordingDuration(0);
  };

  const handleImageEditorSave = async (file: File) => {
    setImageEditorFile(null);
    enqueueUpload(async () => {
      try {
        const response = await trackedUpload(file);
        const uploadedFile = response.data.file;
        const msgResponse = await chatApi.sendMessage(chat.id, {
          content: file.name,
          type: 'image',
          metadata: { file_id: uploadedFile.id, file_name: file.name, file_size: uploadedFile.size, mime_type: 'image/jpeg' } as any,
        });
        const sentMsg = msgResponse.data?.message;
        if (sentMsg) {
          useChatStore.getState().addMessage(sentMsg);
          cacheSingleMessage(sentMsg).catch(() => {});
        }
        userScrolledUpRef.current = false;
        scrollToBottom();
      } catch (error) { console.error('Image editor upload failed:', error); }
    });
  };

  const handleImageEditorSend = async (blob: Blob, caption?: string, fileName = `photo_${Date.now()}.jpg`) => {
    setImageEditorFile(null);
    enqueueUpload(async () => {
      try {
        const file = new File([blob], fileName, { type: 'image/jpeg' });
        const response = await trackedUpload(file);
        const uploadedFile = response.data.file;
        const msgResponse = await chatApi.sendMessage(chat.id, {
          content: caption || '',
          type: 'image',
          metadata: { file_id: uploadedFile.id, file_name: file.name, file_size: uploadedFile.size, mime_type: 'image/jpeg' } as any,
        });
        const sentMsg = msgResponse.data?.message;
        if (sentMsg) {
          useChatStore.getState().addMessage(sentMsg);
          cacheSingleMessage(sentMsg).catch(() => {});
        }
        userScrolledUpRef.current = false;
        scrollToBottom();
      } catch (error) { console.error('Image editor upload failed:', error); }
    });
  };

  const handleCameraPhoto = (blob: Blob) => {
    setShowCameraCapture(false);
    const file = new File([blob], `photo_${Date.now()}.jpg`, { type: 'image/jpeg' });
    setImageEditorFile(file);
  };

  const handleCameraVideo = async (blob: Blob, duration: number) => {
    setShowCameraCapture(false);
    enqueueUpload(async () => {
      try {
        const file = new File([blob], `video_${Date.now()}.webm`, { type: blob.type || 'video/webm' });
        const response = await trackedUpload(file);
        const uploadedFile = response.data.file;
        const msgResponse = await chatApi.sendMessage(chat.id, {
          content: 'Видео',
          type: 'video',
          metadata: { file_id: uploadedFile.id, file_name: file.name, file_size: uploadedFile.size, mime_type: file.type, duration } as any,
        });
        const sentMsg = msgResponse.data?.message;
        if (sentMsg) {
          useChatStore.getState().addMessage(sentMsg);
          cacheSingleMessage(sentMsg).catch(() => {});
        }
        userScrolledUpRef.current = false;
        scrollToBottom();
      } catch (error) { console.error('Camera video upload failed:', error); }
    });
  };

  const handleSendVideoCircle = async (blob: Blob, duration: number) => {
    setShowVideoCircleRecorder(false);
    enqueueUpload(async () => {
      try {
        const file = new File([blob], `video_circle_${Date.now()}.webm`, { type: blob.type || 'video/webm' });
        const response = await trackedUpload(file);
        const uploadedFile = response.data.file;
        const msgResponse = await chatApi.sendMessage(chat.id, {
          content: 'Видеосообщение',
          type: 'video',
          metadata: { file_id: uploadedFile.id, file_name: file.name, file_size: uploadedFile.size, mime_type: file.type, is_circle: true, duration } as any,
        });
        const sentMsg = msgResponse.data?.message;
        if (sentMsg) {
          useChatStore.getState().addMessage(sentMsg);
          cacheSingleMessage(sentMsg).catch(() => {});
        }
        userScrolledUpRef.current = false;
        scrollToBottom();
      } catch (error) { console.error('Video circle upload failed:', error); }
    });
  };

  // Загрузка медиа для вкладок профиля.
  //
  // Раньше брали ровно 100 записей и на этом останавливались. В живых чатах
  // фотографий и голосовых больше, и поиск по вкладке искал только внутри
  // последней сотни: всё, что старше, найти было нельзя в принципе — отсюда
  // «поиск не работает». Теперь дочитываем страницами до конца (с потолком,
  // чтобы не утащить в память гигантский чат), показывая первую страницу
  // сразу — ждать полной загрузки не нужно.
  const MEDIA_PAGE = 200;
  const MEDIA_MAX = 2000;
  const mediaLoadIdRef = useRef(0);

  const loadMediaTab = async (tab: string) => {
    const runId = ++mediaLoadIdRef.current;
    setMediaLoading(true);
    setMediaItems([]);
    try {
      const acc: Message[] = [];
      for (let offset = 0; offset < MEDIA_MAX; offset += MEDIA_PAGE) {
        const { data } = await chatApi.getChatMedia(chat.id, tab, MEDIA_PAGE, offset);
        // Пользователь успел переключить вкладку или чат — бросаем.
        if (runId !== mediaLoadIdRef.current) return;
        const page: Message[] = data.messages || [];
        acc.push(...page);
        setMediaItems([...acc]);
        if (offset === 0) setMediaLoading(false);
        if (page.length < MEDIA_PAGE) break;
      }
    } catch (e) {
      console.error('Failed to load media:', e);
      if (runId === mediaLoadIdRef.current) setMediaItems([]);
    } finally {
      if (runId === mediaLoadIdRef.current) setMediaLoading(false);
    }
  };

  // Фильтрация медиа по поисковому запросу.
  //
  // Было: искали только в `file_name || content`. У голосовых имени файла нет
  // вовсе (в метаданных лежит `originalName: "voice.webm"` и, если распознали,
  // `transcript`), поэтому поиск по вкладке «Голосовые» не находил ничего
  // никогда. У пересланных терялось имя отправителя, по дате искать было
  // нельзя. Теперь собираем всё, по чему человек реально может искать.
  const mediaSearchTokens = mediaSearchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filteredMediaItems = mediaSearchTokens.length === 0 ? mediaItems : mediaItems.filter(msg => {
    const meta = parseMetadata(msg.metadata);
    const haystack = [
      meta?.file_name,
      meta?.transcript,            // распознанный текст голосового
      meta?.forwarded_from,
      meta?.mime_type,
      msg.content,
      msg.sender?.display_name,
      msg.sender?.username,
      msg.created_at ? format(new Date(msg.created_at), 'dd.MM.yyyy') : '',
    ].filter(Boolean).join(' ').toLowerCase();
    // Все слова запроса должны найтись — так «кот март» отбирает то,
    // что и про кота, и за март, в любом порядке.
    return mediaSearchTokens.every(t => haystack.includes(t));
  });

  // Long-press на элементе медиа (мобильный + десктоп)
  const handleMediaItemPress = (msg: Message, e: React.MouseEvent | React.TouchEvent) => {
    const getCoords = () => {
      if ('touches' in e) {
        return { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }
      return { x: (e as React.MouseEvent).clientX, y: (e as React.MouseEvent).clientY };
    };
    const coords = getCoords();
    mediaLongPressTimer.current = setTimeout(() => {
      // Меню открылось, но палец ещё на экране. Его отпускание породит
      // click/pointerup, который не должен считаться «нажал мимо меню».
      mediaMenuArmedRef.current = false;
      setMediaItemMenu({ msg, x: coords.x, y: coords.y });
    }, 500);
  };
  const handleMediaItemRelease = () => {
    if (mediaLongPressTimer.current) {
      clearTimeout(mediaLongPressTimer.current);
      mediaLongPressTimer.current = null;
    }
    // Палец, которым открыли меню, поднят — теперь следующее касание
    // закрывает меню. До этого момента подложка глухая. Ставим
    // безусловно: значение состояния в замыкании может отставать от
    // только что открытого меню, а когда меню нет — подложки тоже нет,
    // и флаг ни на что не влияет.
    mediaMenuArmedRef.current = true;
  };

  // Правый клик на элементе медиа
  const handleMediaItemContext = (msg: Message, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Правый клик приходит уже после отпускания кнопки — меню можно
    // закрывать сразу следующим кликом.
    mediaMenuArmedRef.current = true;
    setMediaItemMenu({ msg, x: e.clientX, y: e.clientY });
  };

  // Удалить сообщение из медиа-панели
  const handleMediaDelete = async (msg: Message, mode: 'for_me' | 'for_all') => {
    try {
      await chatApi.deleteMessage(msg.chat_id, msg.id, mode);
      setMediaItems(prev => prev.filter(m => m.id !== msg.id));
      setMediaItemMenu(null);
    } catch (e) { console.error('Delete media message failed:', e); }
  };

  // Перейти к сообщению в чате (с подгрузкой если нет в DOM)
  const scrollToMessage = async (messageId: string) => {
    setShowUserInfo(false);
    setShowChatSearch(false);

    // Попробуем найти в текущем DOM
    const existing = document.getElementById(`msg-${messageId}`);
    if (existing) {
      setTimeout(() => {
        existing.scrollIntoView({ behavior: 'smooth', block: 'center' });
        existing.classList.add('animate-highlight');
        setTimeout(() => existing.classList.remove('animate-highlight'), 1500);
      }, 100);
      return;
    }

    // Сообщения нет в DOM — загружаем блок вокруг него
    try {
      const { data } = await chatApi.getMessagesAround(chat.id, messageId, 25);
      const msgs = await decryptMessages<Message>(
        data.messages || [], useAuthStore.getState().accessToken || '', user?.id);
      if (msgs.length > 0) {
        // Заменяем сообщения в сторе на загруженный блок
        useChatStore.getState().setMessages(chat.id, msgs);
        setHasMoreMessages(chat.id, true); // Могут быть ещё старые сообщения
        userScrolledUpRef.current = true; // Не автоскроллить вниз

        // Ждём ререндер и скроллим
        await new Promise(r => setTimeout(r, 150));
        const el = document.getElementById(`msg-${messageId}`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.classList.add('animate-highlight');
          setTimeout(() => el.classList.remove('animate-highlight'), 1500);
        }
      }
    } catch (e) {
      console.error('Failed to load messages around:', e);
    }
  };

  // Поиск сообщений в чате
  const chatSearchTimer = useRef<any>(null);
  const handleChatSearch = async (query: string) => {
    setChatSearchQuery(query);
    if (!query.trim()) { setChatSearchResults([]); return; }
    
    if (chatSearchTimer.current) clearTimeout(chatSearchTimer.current);
    
    chatSearchTimer.current = setTimeout(async () => {
      setChatSearchLoading(true);
      try {
        const { data } = await chatApi.searchChatMessages(chat.id, query.trim(), 50);
        setChatSearchResults(data.messages || []);
      } catch (e) { console.error('Chat search failed:', e); setChatSearchResults([]); }
      finally { setChatSearchLoading(false); }
    }, 500);
  };

  // При смене вкладки загружаем данные
  useEffect(() => {
    if (!showUserInfo || isGroup || !otherUser?.id) return;
    let живо = true;
    muteApi.list()
      .then(r => { if (живо) setContactMuted((r.data?.muted || []).includes(otherUser.id)); })
      .catch(() => { /* не дозвонились — покажем как «уведомления включены» */ });
    return () => { живо = false; };
  }, [showUserInfo, isGroup, otherUser?.id]);

  /** Переключить уведомления от собеседника: и на сервере, и локально. */
  const переключитьУведомления = async (станетТихо: boolean) => {
    setContactMuted(станетТихо);
    setChatMuted(chat.id, станетТихо);
    setChatMutedState(станетТихо);
    if (isGroup || !otherUser?.id) return;
    try {
      await muteApi.set(otherUser.id, станетТихо);
    } catch {
      setContactMuted(!станетТихо);
      setChatMuted(chat.id, !станетТихо);
      setChatMutedState(!станетТихо);
    }
  };

  useEffect(() => {
    if (showUserInfo && infoTab !== 'info') {
      loadMediaTab(infoTab);
      setMediaSearchQuery('');
    }
  }, [infoTab, showUserInfo]);

  // Отправка геолокации
  const handleSendLocation = () => {
    setShowAttachmentMenu(false);

    const sendLocation = async (latitude: number, longitude: number) => {
      // Сохраняем GPS-данные локально (офлайн persistence)
      saveGeoPoint({ latitude, longitude, timestamp: Date.now(), synced: true }).catch(() => {});
      const mapUrl = `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=16/${latitude}/${longitude}`;
      try {
        await chatApi.sendMessage(chat.id, { content: `📍 Моя геолокация\n${mapUrl}`, type: 'text' });
        userScrolledUpRef.current = false;
        scrollToBottom();
      } catch (e) { console.error('Send location failed:', e); }
    };

    // Нативный Android — через JS Bridge с системным разрешением
    if ((window as any).AndroidBridge?.requestNativeLocation) {
      const onResult = (e: Event) => {
        const { latitude, longitude } = (e as CustomEvent).detail;
        sendLocation(latitude, longitude);
        cleanup();
      };
      const onError = (e: Event) => {
        alert((e as CustomEvent).detail?.error || 'Ошибка геолокации');
        cleanup();
      };
      const onTimeout = () => {
        // Fallback: попробовать browser API если нативный таймаут
        if (navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(
            (pos) => sendLocation(pos.coords.latitude, pos.coords.longitude),
            () => alert('Не удалось получить геолокацию'),
            { enableHighAccuracy: false, timeout: 10000 }
          );
        } else {
          alert('Не удалось получить геолокацию: таймаут');
        }
        cleanup();
      };
      const cleanup = () => {
        window.removeEventListener('native-location-result', onResult);
        window.removeEventListener('native-location-error', onError);
        window.removeEventListener('native-location-timeout', onTimeout);
      };
      window.addEventListener('native-location-result', onResult, { once: true });
      window.addEventListener('native-location-error', onError, { once: true });
      window.addEventListener('native-location-timeout', onTimeout, { once: true });
      (window as any).AndroidBridge.requestNativeLocation();
      return;
    }

    // Fallback: browser geolocation API
    if (!navigator.geolocation) { alert('Геолокация не поддерживается'); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => sendLocation(pos.coords.latitude, pos.coords.longitude),
      (err) => { alert('Не удалось получить геолокацию: ' + err.message); },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  // Отправка музыкального файла
  const handleMusicSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setShowAttachmentMenu(false);
    setUploadingFile(true);
    try {
      for (const file of Array.from(files)) {
        const response = await trackedUpload(file);
        const uploadedFile = response.data.file;
        await chatApi.sendMessage(chat.id, {
          content: uploadedFile.original_name,
          type: 'audio',
          metadata: { file_id: uploadedFile.id, file_name: uploadedFile.original_name, file_size: uploadedFile.size, mime_type: uploadedFile.mime_type || file.type } as any,
        });
      }
      userScrolledUpRef.current = false;
      scrollToBottom();
    } catch (error) { console.error('Music upload failed:', error); }
    finally { setUploadingFile(false); if (musicInputRef.current) musicInputRef.current.value = ''; }
  };

  const handleTranscribeVoice = async (messageId: string, filename: string) => {
    if (transcriptions[messageId] && !transcriptions[messageId].isLoading) {
      setTranscriptions(prev => { const { [messageId]: _, ...rest } = prev; return rest; });
      return;
    }
    setTranscriptions(prev => ({ ...prev, [messageId]: { text: '', isLoading: true } }));
    try {
      const result = await transcribeAudioFromUrl(filename, {
        language: 'ru-RU',
        onResult: (text) => setTranscriptions(prev => ({ ...prev, [messageId]: { text, isLoading: false } })),
        onError: (error) => setTranscriptions(prev => ({ ...prev, [messageId]: { text: '', isLoading: false, error } }))
      });
      if (result) setTranscriptions(prev => ({ ...prev, [messageId]: { text: result, isLoading: false } }));
    } catch (error) {
      setTranscriptions(prev => ({ ...prev, [messageId]: { text: '', isLoading: false, error: 'Ошибка' } }));
    }
  };

  const handleEditTranscription = (messageId: string, newText: string) => {
    const current = transcriptions[messageId];
    if (current?.text && current.text !== newText) {
      // Отправляем коррекцию на сервер для обучения Vosk
      learnTranscriptionCorrection(current.text, newText);
    }
    // Обновляем UI
    setTranscriptions(prev => ({ ...prev, [messageId]: { text: newText, isLoading: false } }));
  };

  const parseMetadata = (metadata: any) => {
    if (!metadata) return null;
    if (typeof metadata === 'string') { try { return JSON.parse(metadata); } catch { return null; } }
    return metadata;
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  /**
   * Общий приём файлов: из окна выбора, перетаскиванием и вставкой.
   *
   * Раньше это жило только внутри обработчика поля выбора файла, поэтому
   * добавить перетаскивание было некуда. На телефоне это незаметно, а на
   * компьютере оба привычных способа — бросить файл в окно и вставить
   * скриншот через Ctrl+V — просто отсутствовали.
   */
  const acceptIncomingFiles = (list: FileList | File[] | null) => {
    const files = list ? Array.from(list) : [];
    if (files.length === 0) return;
    setShowAttachmentMenu(false);
    // Одна картинка (кроме гифки) — сразу в редактор, как и было.
    if (files.length === 1 && files[0].type.startsWith('image/') && files[0].type !== 'image/gif') {
      setImageEditorFile(files[0]);
      return;
    }
    setPendingAttachments(files);
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    acceptIncomingFiles(e.target.files);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Перетаскивание файлов в окно чата.
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);

  const onDragEnter = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    // Счётчик, а не флаг: dragenter/dragleave сыплются и от дочерних
    // элементов, и подсветка мигала бы при проходе над каждым сообщением.
    dragDepth.current += 1;
    setDragOver(true);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  };
  const onDropFiles = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    acceptIncomingFiles(e.dataTransfer.files);
  };

  const handleSendAttachments = async (files: File[], caption: string) => {
    setPendingAttachments(null);
    enqueueUpload(async () => {
      try {
        for (const file of files) {
          const response = await trackedUpload(file);
          const uploadedFile = response.data.file;
          let msgType = file.type === 'image/gif' ? 'gif' : file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'file';
          const content = caption || '';
          const msgResponse = await chatApi.sendMessage(chat.id, {
            content,
            type: msgType,
            metadata: { file_id: uploadedFile.id, file_name: uploadedFile.original_name, file_size: uploadedFile.size, mime_type: uploadedFile.mime_type || file.type } as any,
          });
          const sentMsg = msgResponse.data?.message;
          if (sentMsg) {
            useChatStore.getState().addMessage(sentMsg);
            cacheSingleMessage(sentMsg).catch(() => {});
          }
        }
        userScrolledUpRef.current = false;
        scrollToBottom();
      } catch (error) { console.error('Upload failed:', error); }
      finally { if (fileInputRef.current) fileInputRef.current.value = ''; }
    });
  };

  const handleDeleteMessage = async (mode: 'for_me' | 'for_all') => {
    if (!deleteDialog) return;
    try {
      await chatApi.deleteMessage(chat.id, deleteDialog.message.id, mode);
      if (mode === 'for_me') useChatStore.getState().removeMessage(chat.id, deleteDialog.message.id);
    } catch (error) { console.error('Delete failed:', error); }
    finally { setDeleteDialog(null); }
  };

  useEffect(() => {
    const handleSendSharedFile = async (e: any) => {
      const { chatId, file: sharedFile } = e.detail;
      if (chat.id !== chatId) return;

      // Shared TEXT/LINK — просто отправляем как сообщение
      if (sharedFile.text) {
        try {
          // Третьим параметром идёт ТИП сообщения, а не полезная нагрузка:
          // сюда передавали null, и тип уезжал пустым вместо 'text'.
          await socketEmit.sendMessage(chat.id, sharedFile.text);
        } catch (err) {
          console.error('Failed to send shared text:', err);
        }
        return;
      }

      // Shared FILE — читаем через AndroidBridge (Base64) или fetch
      try {
        let fileObj: File | null = null;
        const bridge = (window as any).AndroidBridge;

        if (bridge && bridge.readFileAsBase64 && sharedFile.path) {
          // Нативный путь — читаем через Java Bridge напрямую
          const b64: string | null = bridge.readFileAsBase64(sharedFile.path);
          if (b64) {
            const binary = atob(b64);
            const len = binary.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
            const blob = new Blob([bytes], { type: sharedFile.mimeType || 'application/octet-stream' });
            fileObj = new File([blob], sharedFile.name || 'SharedFile', { type: sharedFile.mimeType || 'application/octet-stream' });
          }
        }

        if (!fileObj && sharedFile.path) {
          // Fallback: пробуем fetch (работает для http:// путей)
          let src = sharedFile.path;
          if (!src.startsWith('http') && !src.startsWith('file://')) {
            src = 'file://' + src;
          }
          try {
            const res = await fetch(src);
            const blob = await res.blob();
            fileObj = new File([blob], sharedFile.name || 'SharedFile', { type: sharedFile.mimeType || blob.type || 'application/octet-stream' });
          } catch (fetchErr) {
            console.error('Fetch fallback failed:', fetchErr);
          }
        }

        if (fileObj) {
          setPendingAttachments([fileObj]);
        } else {
          console.error('Could not read shared file from path:', sharedFile.path);
        }
      } catch (err) {
        console.error('Failed to load shared file:', err);
      }
    };
    window.addEventListener('send-shared-file', handleSendSharedFile);
    return () => window.removeEventListener('send-shared-file', handleSendSharedFile);
  }, [chat.id]);

  const typingUsersList = typingUsers[chat.id] || [];
  const isTyping = typingUsersList.length > 0;

  return (
    <div
      className="flex-1 flex flex-col min-h-0 overflow-hidden relative"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDropFiles}
    >
      {/* Файл тащат в окно — показываем, куда его бросать.
          На компьютере это основной способ отправить файл, и раньше его
          не было вовсе: приходилось лезть в мобильную шторку. */}
      {dragOver && (
        <div className="absolute inset-0 z-[120] flex items-center justify-center
                        bg-messenger-bg/85 backdrop-blur-sm pointer-events-none">
          <div className="border-2 border-dashed border-messenger-accent rounded-2xl
                          px-10 py-8 text-center">
            <Paperclip className="w-10 h-10 mx-auto text-messenger-accent mb-3 -rotate-45" />
            <p className="text-messenger-text font-medium">Отпустите, чтобы прикрепить</p>
            <p className="text-messenger-muted text-[13px] mt-1">
              Можно несколько файлов сразу
            </p>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="h-14 px-3 flex items-center justify-between bg-messenger-sidebar border-b border-messenger-border shrink-0 z-20 shadow-sm cursor-pointer" onClick={() => setShowUserInfo(v => !v)}>
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <button onClick={(e) => { e.stopPropagation(); navigate('/'); }} className="md:hidden p-1.5 -ml-1.5 rounded-full hover:bg-messenger-hover text-messenger-muted transition-colors"><ArrowLeft className="w-5 h-5" /></button>
          <div className="relative shrink-0">
            <div className={`w-10 h-10 rounded-full overflow-hidden flex items-center justify-center text-white font-medium shadow-sm ${chat.type === 'channel' ? 'bg-gradient-to-br from-violet-500 to-purple-600' : isSavedMessages ? 'bg-gradient-to-br from-blue-500 to-indigo-600' : 'bg-gradient-to-br from-blue-400 to-blue-600'}`} onClick={(e) => { e.stopPropagation(); const url = isGroup ? chat.avatar_url : getUserAvatarUrl(); if (url) setShowAvatarFullscreen(true); }}>
              {(() => {
                if (isSavedMessages) return <Bookmark className="w-5 h-5 text-white" />;
                const url = isGroup ? chat.avatar_url : getUserAvatarUrl();
                if (url) return <img src={url} alt="" className="w-full h-full object-cover" />;
                return isGroup ? (chat.name?.[0] || 'G').toUpperCase() : (getDisplayName())?.[0] || '?';
              })()}
            </div>
            {isOnline && !isSavedMessages && <div className="absolute bottom-0 right-0 w-3 h-3 bg-[#0ac630] border-2 border-messenger-sidebar rounded-full" />}
          </div>
          <div className="min-w-0">
            <h2 className="font-semibold text-messenger-text text-[15px] truncate leading-tight">{getDisplayName()}</h2>
            <p className="text-[13px] text-messenger-accent leading-tight mt-0.5 flex items-center gap-1">
              {isTyping ? (() => {
                if (isGroup) {
                  const typingNames = typingUsersList.map(uid => {
                    const member = chat.members?.find(m => m.id === uid);
                    return member?.display_name || member?.username || '???';
                  });
                  return typingNames.length === 1 ? `${typingNames[0]} печатает...` : `${typingNames.join(', ')} печатают...`;
                }
                return 'печатает...';
              })() : isSavedMessages ? <span className="text-messenger-muted">Заметки и файлы</span> : isOnline ? 'в сети' : isGroup ? <span className="text-messenger-muted">{chat.members?.length || 0} участников</span> : <span className="text-messenger-muted">{formatLastSeen(otherUser?.last_seen)}</span>}
              {e2eeActive && !isSavedMessages && <Lock className="w-3 h-3 ml-1 opacity-70" />}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
          <button onClick={() => setShowChatSearch(!showChatSearch)} className={`p-2 rounded-full hover:bg-messenger-hover transition-colors ${showChatSearch ? 'text-primary-500 bg-messenger-hover' : 'text-messenger-muted'}`}><Search className="w-5 h-5" /></button>
          <div className="relative">
            <button onClick={() => setShowCallMenu(showCallMenu === 'audio' ? null : 'audio')} disabled={isCallActive} className="p-2 rounded-full hover:bg-messenger-hover text-messenger-muted disabled:opacity-30 transition-colors"><Phone className="w-5 h-5" /></button>
            {showCallMenu === 'audio' && (
              <div className="absolute right-0 top-full mt-1 bg-messenger-sidebar border border-messenger-border rounded-xl shadow-2xl z-50 py-1 min-w-[220px] animate-scale-in flex flex-col overflow-hidden">
                <button onClick={() => { setShowCallMenu(null); onInitiateCall?.('audio', false); }} className="w-full flex flex-col items-start px-4 py-2 hover:bg-messenger-hover transition-colors text-left border-b border-messenger-border/50">
                  <span className="font-semibold text-messenger-text flex items-center gap-2"><Phone className="w-4 h-4 text-green-400"/> P2P Вызов (UDP)</span>
                  <span className="text-[12px] text-messenger-muted mt-0.5">Быстрый прямой звонок</span>
                </button>
                <button onClick={() => { setShowCallMenu(null); onInitiateCall?.('audio', true); }} className="w-full flex flex-col items-start px-4 py-2 hover:bg-messenger-hover transition-colors text-left">
                  <span className="font-semibold text-messenger-text flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-blue-400"/> Анти-ТСПУ (TCP)</span>
                  <span className="text-[12px] text-messenger-muted mt-0.5">Туннель (100% обход)</span>
                </button>
              </div>
            )}
          </div>
          <div className="relative">
            <button onClick={() => setShowCallMenu(showCallMenu === 'video' ? null : 'video')} disabled={isCallActive} className="p-2 rounded-full hover:bg-messenger-hover text-messenger-muted disabled:opacity-30 transition-colors"><Video className="w-5 h-5" /></button>
            {showCallMenu === 'video' && (
              <div className="absolute right-0 top-full mt-1 bg-messenger-sidebar border border-messenger-border rounded-xl shadow-2xl z-50 py-1 min-w-[220px] animate-scale-in flex flex-col overflow-hidden">
                <button onClick={() => { setShowCallMenu(null); onInitiateCall?.('video', false); }} className="w-full flex flex-col items-start px-4 py-2 hover:bg-messenger-hover transition-colors text-left border-b border-messenger-border/50">
                  <span className="font-semibold text-messenger-text flex items-center gap-2"><Video className="w-4 h-4 text-green-400"/> P2P Видео (UDP)</span>
                  <span className="text-[12px] text-messenger-muted mt-0.5">Быстрый прямой звонок</span>
                </button>
                <button onClick={() => { setShowCallMenu(null); onInitiateCall?.('video', true); }} className="w-full flex flex-col items-start px-4 py-2 hover:bg-messenger-hover transition-colors text-left">
                  <span className="font-semibold text-messenger-text flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-blue-400"/> Анти-ТСПУ (TCP)</span>
                  <span className="text-[12px] text-messenger-muted mt-0.5">Туннель (100% обход)</span>
                </button>
              </div>
            )}
          </div>
          <div className="relative" ref={dropdownRef}>
            <button onClick={() => setShowDropdownMenu(!showDropdownMenu)} className="p-2 rounded-full hover:bg-messenger-hover text-messenger-muted transition-colors"><MoreVertical className="w-5 h-5" /></button>
            {showDropdownMenu && (
              <div className="absolute right-0 top-full mt-1 bg-messenger-sidebar border border-messenger-border rounded-xl shadow-2xl z-50 py-1.5 min-w-[200px] animate-scale-in">
                <button onClick={() => { setShowDropdownMenu(false); setShowUserInfo(true); }} className="w-full flex items-center gap-3 px-4 py-2 hover:bg-messenger-hover transition-colors text-[15px]"><UserIcon size={18} className="text-messenger-muted" />Информация</button>
                <button onClick={() => { setShowDropdownMenu(false); void переключитьУведомления(!chatMuted); }} className="w-full flex items-center gap-3 px-4 py-2 hover:bg-messenger-hover transition-colors text-[15px]">{chatMuted ? <Bell size={18} className="text-messenger-muted" /> : <BellOff size={18} className="text-messenger-muted" />}<span>{chatMuted ? 'Включить уведомления' : 'Выключить уведомления'}</span></button>
                {otherUser && <button onClick={() => { setShowDropdownMenu(false); setEditingLocalNick(true); setLocalNickInput(getLocalNick(otherUser.id) || ''); }} className="w-full flex items-center gap-3 px-4 py-2 hover:bg-messenger-hover transition-colors text-[15px]"><Edit3 size={18} className="text-messenger-muted" />Изменить имя</button>}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Chat Search Panel */}
      {showChatSearch && (
        <div className="border-b border-messenger-border bg-messenger-sidebar px-3 py-2 flex-shrink-0">
          <div className="flex items-center gap-2">
            <Search size={18} className="text-messenger-muted shrink-0" />
            <input
              type="text"
              value={chatSearchQuery}
              onChange={e => handleChatSearch(e.target.value)}
              placeholder="Поиск сообщений в чате..."
              className="flex-1 bg-transparent text-[14px] text-messenger-text placeholder:text-messenger-muted focus:outline-none"
              autoFocus
            />
            <button onClick={() => { setShowChatSearch(false); setChatSearchQuery(''); setChatSearchResults([]); }} className="p-1 rounded-full hover:bg-messenger-hover text-messenger-muted"><X size={16} /></button>
          </div>
          {chatSearchQuery.trim() && (
            <div className="mt-2 max-h-[300px] overflow-y-auto space-y-0.5">
              {chatSearchLoading ? (
                <div className="flex justify-center py-4"><Loader2 className="w-5 h-5 animate-spin text-messenger-muted" /></div>
              ) : chatSearchResults.length === 0 ? (
                <p className="text-center py-4 text-[13px] text-messenger-muted">Ничего не найдено</p>
              ) : (
                chatSearchResults.map(msg => (
                  <button
                    key={msg.id}
                    onClick={() => scrollToMessage(msg.id)}
                    className="w-full text-left px-3 py-2 rounded-lg hover:bg-messenger-hover transition-colors"
                  >
                    <div className="flex items-center gap-2 text-[12px] text-messenger-muted">
                      <span className="font-medium text-messenger-text">{msg.sender?.display_name || msg.sender?.username}</span>
                      <span>{msg.created_at ? (function(){ try { return format(new Date(msg.created_at), 'dd.MM.yy HH:mm') } catch(e){return ''} })() : ''}</span>
                    </div>
                    <p className="text-[13px] text-messenger-text truncate mt-0.5">{msg.content}</p>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      )}

      {/* Connection Status Indicator */}
      <ConnectionStatus />

      {/* Messages */}
      <div ref={messagesContainerRef} onScroll={handleScroll} style={wallpaperStyle} className="messages-container flex-1 overflow-y-auto overflow-x-hidden px-2 sm:px-4 py-4 space-y-1.5 min-h-0 scroll-smooth">
        {/* Индикатор загрузки старых сообщений */}
        {loadingOlder && (
          <div className="flex justify-center py-3">
            <Loader2 className="w-5 h-5 animate-spin text-messenger-muted" />
          </div>
        )}
        {chatMessages.map((message, index) => {
          const isOwn = message.sender_id === user?.id;
          const showDate = index === 0 || new Date(message.created_at).toDateString() !== new Date(chatMessages[index - 1].created_at).toDateString();
          const isLastInGroup = index === chatMessages.length - 1 || chatMessages[index + 1].sender_id !== message.sender_id || new Date(chatMessages[index + 1].created_at).toDateString() !== new Date(message.created_at).toDateString();
          const isFirstInGroup = index === 0 || chatMessages[index - 1].sender_id !== message.sender_id || new Date(message.created_at).toDateString() !== new Date(chatMessages[index - 1].created_at).toDateString();
          const showSenderInfo = isGroup && !isOwn && isFirstInGroup;
          const showSenderAvatar = isGroup && !isOwn && isLastInGroup;
          const msgReactions: ReactionSummary[] = (message as any).reactions || [];
          return (
            <div key={message.id} id={`msg-${message.id}`} className="flex flex-col">
              {showDate && (
                <div className="flex justify-center my-4 sticky top-2 z-10 pointer-events-none">
                  <span className="text-[13px] font-medium text-white bg-black/30 backdrop-blur-md px-3 py-1 rounded-full shadow-sm">{format(new Date(message.created_at), 'd MMMM', { locale: ru })}</span>
                </div>
              )}
              <div className={`group flex ${isOwn ? 'justify-end' : 'justify-start'} ${isLastInGroup ? 'mb-2' : 'mb-0.5'} ${isGroup && !isOwn ? 'pl-1' : ''}`}>
                {/* Аватар отправителя в группе */}
                {isGroup && !isOwn && (
                  <div className="w-8 shrink-0 self-end mr-1.5">
                    {showSenderAvatar && (
                      <div className="w-8 h-8 rounded-full overflow-hidden bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center text-white text-xs font-medium">
                        {message.sender?.avatar_url ? (
                          <img src={message.sender.avatar_url} alt="" className="w-full h-full object-cover" />
                        ) : (
                          (message.sender?.display_name || message.sender?.username || '?')[0].toUpperCase()
                        )}
                      </div>
                    )}
                  </div>
                )}
                <div className="flex flex-col max-w-[85%] sm:max-w-[70%] min-w-0 overflow-hidden">
                  {(() => {
                    // Кружочки — без bubble (без padding, фона, тени)
                    const isCircleVideo = message.type === 'video' && (() => { const m = parseMetadata(message.metadata); return m?.is_circle; })();
                    return (
                  <div onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, message }); }} className={isCircleVideo
                    ? `relative ${isOwn ? 'ml-auto' : 'mr-auto'}`
                    : `relative px-3 pt-2 pb-1.5 shadow-telegram text-[15px] leading-[1.3] break-words overflow-hidden ${isOwn ? `msg-bubble-own ml-auto rounded-2xl` : `msg-bubble-other mr-auto rounded-2xl`}`
                  } style={isCircleVideo ? undefined : { wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                    {/* Имя отправителя в группе */}
                    {showSenderInfo && (
                      <p className="text-[13px] font-medium mb-0.5 cursor-default" style={{ color: getSenderColor(message.sender_id) }}>
                        {message.sender?.display_name || message.sender?.username || 'Неизвестный'}
                      </p>
                    )}
                  {/* Reply-to block */}
                  {message.reply_to_id && (() => {
                    const replyMsg = chatMessages.find(m => m.id === message.reply_to_id);
                    if (!replyMsg) return null;
                    const replySender = replyMsg.sender?.display_name || replyMsg.sender?.username || '';
                    const replyPreview = replyMsg.type === 'voice' ? '🎤 Голосовое' : replyMsg.type === 'image' ? '📷 Фото' : replyMsg.type === 'gif' ? '🎞 GIF' : replyMsg.type === 'video' ? '🎬 Видео' : (replyMsg.content || '').slice(0, 60);
                    const replyParts = renderTextWithEmoji(replyPreview);
                    return (
                      <div className={`flex gap-2 mb-1.5 pb-1.5 border-b ${isOwn ? 'border-white/10' : 'border-black/10'} cursor-pointer`} onClick={() => { const el = document.getElementById(`msg-${replyMsg.id}`); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('animate-highlight'); setTimeout(() => el.classList.remove('animate-highlight'), 1500); } }}>
                        <div className={`w-0.5 rounded-full shrink-0 ${isOwn ? 'bg-white/60' : 'bg-messenger-accent'}`} />
                        <div className="min-w-0">
                          <p className={`text-[12px] font-medium ${isOwn ? 'text-white/80' : 'text-messenger-accent'}`}>{replySender}</p>
                          <p className={`text-[12px] truncate ${isOwn ? 'text-white/50' : 'text-messenger-muted'}`}>{replyParts.map((part, i) => typeof part === 'string' ? <span key={i}>{part}</span> : <img key={i} src={part.src} alt="" className="inline-emoji" draggable={false} />)}</p>
                        </div>
                      </div>
                    );
                  })()}
                  {/* Forwarded message header */}
                  {(() => {
                    const fwdMeta = parseMetadata(message.metadata);
                    const fwdFromMeta = fwdMeta?.forwarded_from;
                    const fwdTextMatch = !fwdFromMeta && message.content?.match(/^↗ Переслано от (.+?):\n/);
                    const fwdSender = fwdFromMeta || (fwdTextMatch ? fwdTextMatch[1] : null);
                    if (!fwdSender) return null;
                    return (
                      <div className={`flex items-center gap-1.5 mb-1 pb-1 border-b ${isOwn ? 'border-white/10' : 'border-black/10'}`}>
                        <CornerDownRight size={13} className={isOwn ? 'text-white/50' : 'text-messenger-accent'} />
                        <p className={`text-[12px] font-medium ${isOwn ? 'text-white/60' : 'text-messenger-accent'}`}>
                          Переслано от {fwdSender}
                        </p>
                      </div>
                    );
                  })()}
                  {message.type === 'voice' ? (() => {
                    const meta = parseMetadata(message.metadata);
                    const clientTranscription = transcriptions[message.id] || null;
                    const serverTranscript = meta?.transcript;
                    const effectiveTranscription = clientTranscription || (serverTranscript ? { text: serverTranscript, isLoading: false } : null);
                    
                    const voiceUrl = meta?.file_id 
                      ? fileApi.getViewUrl(meta.file_id) 
                      : `${import.meta.env.VITE_API_URL || window.location.origin + '/api'}/files/voice/${meta?.filename || meta?.file_name}`;

                    return (
                      <div className="max-w-[240px]">
                        <VoiceMessagePlayer 
                          audioUrl={voiceUrl} 
                          duration={Math.round((meta?.duration || 0) / 1000)} 
                          isOwn={isOwn} 
                          onTranscribe={() => handleTranscribeVoice(message.id, meta?.filename || meta?.file_name || meta?.file_id)} 
                          onEditTranscription={(newText) => handleEditTranscription(message.id, newText)} 
                          transcription={effectiveTranscription} 
                        />
                      </div>
                    );
                  })() : message.type === 'image' ? (() => {
                    const imgMeta = parseMetadata(message.metadata);
                    const imgFileId = imgMeta?.file_id;
                    const imgViewUrl = imgFileId ? fileApi.getViewUrl(imgFileId) : null;
                    const imgThumbUrl = imgFileId ? fileApi.getThumbnailUrl(imgFileId) : null;
                    const imgDownUrl = imgFileId ? fileApi.getDownloadUrl(imgFileId) : null;
                    const showCaption = message.content && message.content !== 'Фото' && message.content !== imgMeta?.file_name;
                    return imgViewUrl ? (
                      <div className="flex flex-col gap-1.5 max-w-full sm:max-w-[400px]">
                        <div className="relative group">
                          <div className="rounded-lg bg-[#1a1a2e] animate-pulse min-h-[100px]" style={{ display: 'none' }} data-skeleton="true" />
                          <img
                            src={imgThumbUrl || imgViewUrl}
                            className="rounded-lg max-w-full cursor-pointer"
                            onClick={() => imgFileId && openLightbox(imgFileId)}
                            loading="lazy"
                            decoding="async"
                            onLoad={(e) => { const skel = e.currentTarget.parentElement?.querySelector('[data-skeleton]') as HTMLElement; if (skel) skel.style.display = 'none'; }}
                            onError={(e) => { const t = e.currentTarget; t.style.display = 'none'; const p = t.parentElement; if (p) { const skel = p.querySelector('[data-skeleton]') as HTMLElement; if (skel) { skel.style.display = 'none'; } const d = document.createElement('div'); d.className = 'rounded-lg bg-[#1a1a2e] flex items-center justify-center text-white/30 text-sm p-8'; d.textContent = 'Изображение недоступно'; p.insertBefore(d, t); } }}
                          />
                          {imgDownUrl && <button type="button" onClick={e => { e.stopPropagation(); downloadFileNative(imgDownUrl, imgMeta?.file_name || 'image.jpg'); }} className="absolute top-2 right-2 w-8 h-8 rounded-full bg-black/60 flex items-center justify-center text-white opacity-0 group-hover:opacity-100 sm:group-hover:opacity-100 active:opacity-100 transition-opacity"><Download size={16} /></button>}
                        </div>
                        {showCaption && <p className="text-[14px] whitespace-pre-wrap leading-relaxed px-1">{message.content}</p>}
                      </div>
                    ) : null;
                  })() : message.type === 'gif' ? (() => {
                    const gifMeta = parseMetadata(message.metadata);
                    const gifFileId = gifMeta?.file_id;
                    const gifUrl = gifMeta?.gif_url || (gifFileId ? fileApi.getViewUrl(gifFileId) : null);
                    return gifUrl ? (
                      <div className="relative max-w-full sm:max-w-[320px] group cursor-pointer" onClick={() => { if (gifUrl) window.open(gifUrl, '_blank'); }}>
                        <img
                          src={gifUrl}
                          className="rounded-lg max-w-full"
                          loading="lazy"
                        />
                        <div className="absolute bottom-2 left-2 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded font-bold">GIF</div>
                      </div>
                    ) : null;
                  })() : message.type === 'video' ? (() => {
                    const vMeta = parseMetadata(message.metadata);
                    const vUrl = vMeta?.file_id ? fileApi.getViewUrl(vMeta.file_id) : null;
                    const vDownUrl = vMeta?.file_id ? fileApi.getDownloadUrl(vMeta.file_id) : null;
                    const showCaption = message.content && message.content !== 'Видео' && message.content !== vMeta?.file_name;
                    if (vMeta?.is_circle && vUrl) {
                      return <VideoCirclePlayer src={vUrl} size={240} fileSize={vMeta?.file_size} duration={vMeta?.duration} />;
                    }
                    return vUrl ? (
                      <div className="flex flex-col gap-1.5 max-w-full w-[260px]">
                        <div className="relative w-full rounded-xl overflow-hidden cursor-pointer group bg-[#1a1a2e]" onClick={() => handleMediaClick(index, 'video')}>
                          <div className="aspect-video">
                            <VideoThumbnail src={vUrl} className="w-full h-full object-cover" />
                          </div>
                          <div className="absolute inset-0 flex items-center justify-center">
                            <div className="w-12 h-12 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center shadow-lg"><svg className="w-5 h-5 text-white ml-0.5" fill="currentColor" viewBox="0 0 20 20"><path d="M6.3 2.84A1.5 1.5 0 004 4.11v11.78a1.5 1.5 0 002.3 1.27l9.344-5.891a1.5 1.5 0 000-2.538L6.3 2.84z"/></svg></div>
                          </div>
                          {vDownUrl && <button type="button" onClick={e => { e.stopPropagation(); downloadFileNative(vDownUrl, vMeta?.file_name || 'video.mp4'); }} className="absolute top-2 right-2 w-8 h-8 rounded-full bg-black/60 flex items-center justify-center text-white opacity-0 group-hover:opacity-100 active:opacity-100 transition-opacity z-10"><Download size={16} /></button>}
                          {vMeta?.file_size && <div className="absolute bottom-2 left-2 bg-black/60 text-white text-[11px] px-1.5 py-0.5 rounded">{formatBytes(vMeta.file_size)}</div>}
                        </div>
                        {showCaption && <p className="text-[14px] whitespace-pre-wrap leading-relaxed px-1">{message.content}</p>}
                      </div>
                    ) : null;
                  })() : message.type === 'audio' ? (() => {
                    const aMeta = parseMetadata(message.metadata);
                    const aFileId = aMeta?.file_id;
                    const aUrl = aFileId ? fileApi.getViewUrl(aFileId) : null;
                    const aDownloadUrl = aFileId ? fileApi.getDownloadUrl(aFileId) : undefined;
                    return aUrl ? (
                      <div 
                        onClick={() => handleMediaClick(index, 'audio')}
                        className="flex items-center gap-3 py-1 cursor-pointer hover:opacity-80 min-w-[200px]"
                      >
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center text-lg ${isOwn ? 'bg-white/20' : 'bg-indigo-500/10'}`}>🎵</div>
                        <div className="flex-1 min-w-0">
                          <p className="text-[14px] font-medium truncate">{aMeta?.file_name || message.content || 'Аудио'}</p>
                          <p className={`text-[12px] ${isOwn ? 'text-white/60' : 'text-gray-400'}`}>Нажмите чтобы воспроизвести</p>
                        </div>
                      </div>
                    ) : null;
                  })() : message.type === 'file' ? (() => {
                    const fMeta = parseMetadata(message.metadata);
                    const fUrl = fMeta?.file_id ? fileApi.getDownloadUrl(fMeta.file_id) : null;
                    return (
                      <button type="button" onClick={(e) => { e.stopPropagation(); if (fUrl) downloadFileNative(fUrl, fMeta?.file_name || 'Файл'); }} className="flex items-center gap-3 py-1 min-w-[200px] hover:opacity-80 text-left w-full">
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center text-lg ${isOwn ? 'bg-white/20' : 'bg-blue-500/10'}`}>📎</div>
                        <div className="flex-1 min-w-0">
                          <p className="text-[14px] font-medium truncate">{fMeta?.file_name || message.content || 'Файл'}</p>
                          {fMeta?.file_size && <p className={`text-[12px] ${isOwn ? 'text-white/60' : 'text-gray-400'}`}>{formatBytes(fMeta.file_size)}</p>}
                        </div>
                      </button>
                    );
                  })() : (() => {
                    const rawContent = message.content || '';
                    const content = rawContent.replace(/^↗ Переслано от .+?:\n/, '');
                    const isOnlyEmoji = /^(\[e:\d+_\d+\]\s*)+$/.test(content.trim());
                    const parts = renderTextWithEmoji(content);
                    return (
                      <p className="whitespace-pre-wrap">
                        {parts.map((part, i) => {
                          if (typeof part === 'string') {
                            // Сначала разбиваем по ссылкам, потом по @mentions
                            return part.split(/(https?:\/\/[^\s<]+|@[a-zA-Z0-9_]+)/g).map((seg, j) =>
                              /^https?:\/\//.test(seg)
                                ? <a key={`${i}-${j}`} href={seg} target="_blank" rel="noopener noreferrer" className="text-blue-400 underline hover:text-blue-300 break-all">{seg}</a>
                                : /^@[a-zA-Z0-9_]+$/.test(seg)
                                  ? <span key={`${i}-${j}`} className="text-blue-400 font-medium cursor-pointer hover:underline">{seg}</span>
                                  : <span key={`${i}-${j}`}>{seg}</span>
                            );
                          }
                          return <img key={i} src={part.src} alt="" className={`inline-emoji ${isOnlyEmoji ? 'inline-emoji-large' : ''}`} draggable={false} />;
                        })}
                      </p>
                    );
                  })()}
                  <div className="msg-time flex flex-col items-end ml-auto text-[11px] pt-1 float-right translate-y-0.5">
                    <div className="flex items-center gap-1">
                      {message.edited_at && <span className="opacity-60">ред.</span>}
                      <span>{format(new Date(message.created_at), 'HH:mm')}</span>
                    </div>
                    {isOwn && (
                      <div className="flex items-center justify-end -mt-0.5">
                        {(message.status as any) === 'failed'
                          ? <span className="text-red-400 text-[10px] font-bold" title="Ошибка отправки">!</span>
                          : message.status === 'pending'
                            ? <Clock className="w-3 h-3 opacity-40 animate-pulse" />
                            : message.status === 'read'
                              ? <CheckCheck className="w-3 h-3 text-[#4ac959]" />
                              : <Check className="w-3 h-3 opacity-60" />
                        }
                      </div>
                    )}
                  </div>
                  {/* Реакции внутри пузыря */}
                  {msgReactions.length > 0 && (
                    <div className="clear-both border-t border-white/10 mt-1.5 pt-1.5">
                      <div className="flex flex-wrap gap-1.5">
                        {msgReactions.map(r => {
                          const isMine = r.users.some(u => u.id === user?.id);
                          return (
                            <button
                              key={r.emoji}
                              onClick={() => handleToggleReaction(message.chat_id, message.id, r.emoji)}
                              className={`group/reaction relative flex items-center gap-1 pl-0.5 pr-2 py-0.5 rounded-full text-[13px] transition-colors ${
                                isMine
                                  ? 'bg-messenger-accent/20 hover:bg-red-500/20'
                                  : 'bg-white/10 hover:bg-white/15'
                              }`}
                              title={isMine ? `Нажмите чтобы убрать \u2022 ${r.users.map(u => u.display_name || u.username).join(', ')}` : r.users.map(u => u.display_name || u.username).join(', ')}
                            >
                              {/* Крестик удаления для своих реакций */}
                              {isMine && (
                                <div className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover/reaction:opacity-100 transition-opacity">
                                  <X size={8} />
                                </div>
                              )}
                              {/* Аватарки пользователей */}
                              <div className="flex -space-x-1.5">
                                {r.users.slice(0, 3).map(u => (
                                  <div
                                    key={u.id}
                                    className="w-5 h-5 rounded-full overflow-hidden ring-1 ring-black/20 flex-shrink-0 flex items-center justify-center text-[9px] font-medium text-white"
                                    style={{ backgroundColor: u.avatar_url ? undefined : getSenderColor(u.id) }}
                                  >
                                    {u.avatar_url ? (
                                      <img src={u.avatar_url} alt="" className="w-full h-full object-cover" />
                                    ) : (
                                      (u.display_name || u.username || '?')[0].toUpperCase()
                                    )}
                                  </div>
                                ))}
                                {r.users.length > 3 && (
                                  <div className="w-5 h-5 rounded-full bg-black/30 ring-1 ring-black/20 flex-shrink-0 flex items-center justify-center text-[9px] font-medium text-white">
                                    +{r.users.length - 3}
                                  </div>
                                )}
                              </div>
                              {isCustomEmoji(r.emoji) ? (
                                <img src={getEmojiUrl(r.emoji)} alt="" className="w-5 h-5 object-contain" draggable={false} />
                              ) : (
                                <span>{r.emoji}</span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  </div>
                  ); })()}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {showScrollButton && <button onClick={() => { userScrolledUpRef.current = false; scrollToBottom(); }} className="absolute bottom-20 right-4 w-12 h-12 bg-messenger-sidebar border border-messenger-border rounded-full shadow-lg hover:bg-messenger-hover transition-colors z-10 flex items-center justify-center text-messenger-muted"><ArrowDown className="w-6 h-6" /></button>}

      {/* Attachment Menu (Fixed overlay - not affected by keyboard) */}
      {showAttachmentMenu && (
        <div className="fixed inset-0 z-[45] bg-black/30" onClick={() => setShowAttachmentMenu(false)}>
          <div ref={attachmentMenuRef} className="absolute bottom-0 left-0 right-0 bg-messenger-sidebar border-t border-messenger-border rounded-t-2xl shadow-2xl animate-slide-up-full overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="p-3 border-b border-messenger-border font-medium text-messenger-muted text-sm flex items-center justify-between">
              <span>Прикрепить</span>
              <button onClick={() => setShowAttachmentMenu(false)} className="p-1 rounded-full hover:bg-messenger-hover"><X size={18} /></button>
            </div>
            <div className="flex overflow-x-auto no-scrollbar p-4 gap-6 scroll-smooth pb-[env(safe-area-inset-bottom,16px)]">
              <button onClick={() => { setShowAttachmentMenu(false); setShowCameraCapture(true); }} className="flex flex-col items-center gap-2 shrink-0 min-w-[64px]">
                <div className="w-14 h-14 rounded-full bg-cyan-500 flex items-center justify-center text-white shadow-lg transition-transform active:scale-90"><Camera size={28} /></div>
                <span className="text-xs text-messenger-muted">Камера</span>
              </button>
              <button onClick={() => { setShowAttachmentMenu(false); fileInputRef.current?.setAttribute('accept', 'image/*,video/*'); fileInputRef.current?.click(); }} className="flex flex-col items-center gap-2 shrink-0 min-w-[64px]">
                <div className="w-14 h-14 rounded-full bg-blue-500 flex items-center justify-center text-white shadow-lg transition-transform active:scale-90"><ImageIcon size={28} /></div>
                <span className="text-xs text-messenger-muted">Галерея</span>
              </button>
              <button onClick={() => { setShowAttachmentMenu(false); fileInputRef.current?.removeAttribute('accept'); fileInputRef.current?.click(); }} className="flex flex-col items-center gap-2 shrink-0 min-w-[64px]">
                <div className="w-14 h-14 rounded-full bg-green-500 flex items-center justify-center text-white shadow-lg transition-transform active:scale-90"><FileIcon size={28} /></div>
                <span className="text-xs text-messenger-muted">Файл</span>
              </button>
              <button onClick={() => { setShowAttachmentMenu(false); handleSendLocation(); }} className="flex flex-col items-center gap-2 shrink-0 min-w-[64px]">
                <div className="w-14 h-14 rounded-full bg-orange-500 flex items-center justify-center text-white shadow-lg transition-transform active:scale-90"><MapPin size={28} /></div>
                <span className="text-xs text-messenger-muted">Локация</span>
              </button>
              <button onClick={() => { setShowAttachmentMenu(false); setShowVideoCircleRecorder(true); }} className="flex flex-col items-center gap-2 shrink-0 min-w-[64px]">
                <div className="w-14 h-14 rounded-full bg-purple-500 flex items-center justify-center text-white shadow-lg transition-transform active:scale-90"><Video size={28} /></div>
                <span className="text-xs text-messenger-muted">Кружочек</span>
              </button>
              <button onClick={() => { setShowAttachmentMenu(false); musicInputRef.current?.click(); }} className="flex flex-col items-center gap-2 shrink-0 min-w-[64px]">
                <div className="w-14 h-14 rounded-full bg-pink-500 flex items-center justify-center text-white shadow-lg transition-transform active:scale-90"><MusicIcon size={28} /></div>
                <span className="text-xs text-messenger-muted">Музыка</span>
              </button>
              <button onClick={() => { setShowAttachmentMenu(false); videoInputRef.current?.click(); }} className="flex flex-col items-center gap-2 shrink-0 min-w-[64px]">
                <div className="w-14 h-14 rounded-full bg-indigo-500 flex items-center justify-center text-white shadow-lg transition-transform active:scale-90"><Video size={28} /></div>
                <span className="text-xs text-messenger-muted">Видео</span>
              </button>
              <button onClick={() => { setShowAttachmentMenu(false); alert('Безопасное хранилище паролей скоро появится!'); }} className="flex flex-col items-center gap-2 shrink-0 min-w-[64px]">
                <div className="w-14 h-14 rounded-full bg-slate-600 flex items-center justify-center text-white shadow-lg transition-transform active:scale-90"><Key size={28} /></div>
                <span className="text-xs text-messenger-muted">Пароли</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Input Area */}
      <div className="bg-messenger-sidebar border-t border-messenger-border flex-shrink-0 z-30">
        {/* Ход загрузки — по каждому файлу отдельной строкой.
            Было одно слово «Загрузка файла...» и крутилка: непонятно ни что
            грузится, ни сколько осталось, ни как отменить. */}
        {visibleUploads.length > 0 && (
          <div className="px-3 pt-2 pb-1 max-w-messenger mx-auto flex flex-col gap-1.5">
            {visibleUploads.map(u => {
              const pct = overallPercent(u);
                const этап = stageLabel(u);
              const eta = etaSeconds(u);
              const bad = u.status === 'error';
              return (
                <div key={u.id} className="flex items-center gap-2.5">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="text-[13px] text-messenger-text truncate flex-1 min-w-0">{u.fileName}</span>
                      <span className={`text-[12px] tabular-nums shrink-0 ${bad ? 'text-red-400' : 'text-messenger-accent'}`}>
                        {u.status === 'done' ? 'готово' : bad ? 'ошибка' : `${pct}%`}
                      </span>
                    </div>
                    <div className="h-1 rounded-full bg-messenger-hover overflow-hidden mt-1">
                      <div
                        className={`h-full rounded-full transition-[width] duration-200 ${bad ? 'bg-red-500' : 'bg-messenger-accent'}`}
                        style={{ width: `${u.status === 'done' ? 100 : pct}%` }}
                      />
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 text-[11px] text-messenger-muted">
                      <span className="tabular-nums">{formatBytes(u.loaded)} / {formatBytes(u.fileSize)}</span>
                      {этап
                          ? <span className="text-messenger-accent">{этап}</span>
                          : (u.status === 'uploading' && u.speed > 0 && <span className="tabular-nums">{formatBytes(u.speed)}/с</span>)}
                      {u.status === 'uploading' && eta !== null && eta > 0 && (
                        <span className="tabular-nums">осталось {eta < 60 ? `${eta} с` : `${Math.ceil(eta / 60)} мин`}</span>
                      )}
                      {bad && u.error && <span className="text-red-400 truncate">{u.error}</span>}
                    </div>
                  </div>
                  {u.status === 'uploading' ? (
                    <button
                      onClick={() => useUploadStore.getState().cancel(u.id)}
                      title="Отменить"
                      className="p-1.5 rounded-full text-messenger-muted hover:text-red-400 hover:bg-messenger-hover shrink-0"
                    ><X size={16} /></button>
                  ) : (
                    <button
                      onClick={() => useUploadStore.getState().remove(u.id)}
                      title="Убрать"
                      className="p-1.5 rounded-full text-messenger-muted hover:bg-messenger-hover shrink-0"
                    ><X size={16} /></button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {editingMessage && (
          <div className="px-4 pt-2 pb-1 flex items-center gap-3 max-w-messenger mx-auto">
            <div className="w-0.5 h-9 bg-messenger-accent rounded-full shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-messenger-accent text-[13px] font-medium flex items-center gap-1"><Edit3 size={14} /> Редактирование</p>
              <p className="text-messenger-muted text-[13px] truncate">{renderTextWithEmoji(editingMessage.content || '').map((part, i) => typeof part === 'string' ? <span key={i}>{part}</span> : <img key={i} src={part.src} alt="" className="inline-emoji" draggable={false} />)}</p>
            </div>
            <button onClick={() => { setEditingMessage(null); setMessageText(''); if (messageInputRef.current) messageInputRef.current.innerHTML = ''; }} className="p-1 rounded-full hover:bg-messenger-hover text-messenger-muted shrink-0"><X size={18} /></button>
          </div>
        )}
        {replyToMessage && !editingMessage && (
          <div className="px-4 pt-2 pb-1 flex items-center gap-3 max-w-messenger mx-auto">
            <div className="w-0.5 h-9 bg-messenger-accent rounded-full shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-messenger-accent text-[13px] font-medium">{replyToMessage.sender?.display_name || replyToMessage.sender?.username || 'Сообщение'}</p>
              <p className="text-messenger-muted text-[13px] truncate">{(() => { const txt = replyToMessage.type === 'voice' ? '🎤 Голосовое сообщение' : replyToMessage.type === 'image' ? '📷 Фотография' : replyToMessage.type === 'video' ? '🎬 Видео' : replyToMessage.content || ''; return renderTextWithEmoji(txt).map((part, i) => typeof part === 'string' ? <span key={i}>{part}</span> : <img key={i} src={part.src} alt="" className="inline-emoji" draggable={false} />); })()}</p>
            </div>
            <button onClick={() => setReplyToMessage(null)} className="p-1 rounded-full hover:bg-messenger-hover text-messenger-muted shrink-0"><X size={18} /></button>
          </div>
        )}
        <div className="px-2 sm:px-4 pb-3 pt-2 flex items-end gap-1.5 max-w-messenger mx-auto">
          {/* @mention suggestions */}
          {mentionQuery !== null && isGroup && (() => {
            const q = mentionQuery.toLowerCase();
            const suggestions = (chat.members || []).filter(m =>
              m.id !== user?.id &&
              (m.username.toLowerCase().startsWith(q) || (m.display_name || '').toLowerCase().startsWith(q))
            ).slice(0, 6);
            if (!suggestions.length) return null;
            return (
              <div className="absolute bottom-full left-2 right-2 mb-1 bg-messenger-sidebar border border-messenger-border rounded-xl shadow-xl overflow-hidden z-40 max-w-messenger mx-auto">
                {suggestions.map(m => (
                  <button
                    key={m.id}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      if (messageInputRef.current) {
                        insertMentionAtCaret(messageInputRef.current, m.username);
                        const text = extractContentWithEmoji(messageInputRef.current);
                        setMessageText(text);
                      }
                      setMentionQuery(null);
                    }}
                    className="w-full flex items-center gap-3 px-3 py-2 hover:bg-messenger-hover transition-colors text-left"
                  >
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center text-white text-sm font-medium shrink-0 overflow-hidden">
                      {m.avatar_url ? <img src={m.avatar_url} alt="" className="w-full h-full object-cover" /> : (m.display_name || m.username).charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-messenger-text truncate">{m.display_name || m.username}</p>
                      <p className="text-xs text-messenger-muted truncate">@{m.username}</p>
                    </div>
                  </button>
                ))}
              </div>
            );
          })()}
          <button id="paperclip-btn" onClick={() => setShowAttachmentMenu(!showAttachmentMenu)} className={`p-2.5 rounded-full transition-colors shrink-0 ${showAttachmentMenu ? 'text-messenger-accent bg-messenger-hover' : 'text-messenger-muted hover:bg-messenger-hover'}`}>
            <Paperclip size={22} className={showAttachmentMenu ? '' : '-rotate-45'} />
          </button>
          <input ref={fileInputRef} type="file" multiple onChange={handleFileSelect} className="hidden" />
          <div className="flex-1 min-w-0 bg-messenger-input rounded-2xl flex items-end min-h-[40px] border border-transparent focus-within:border-messenger-accent/50 transition-colors shadow-sm">
            <button onClick={() => { if (showEmojiPicker) { setShowEmojiPicker(false); setTimeout(() => messageInputRef.current?.focus(), 50); } else { setShowEmojiPicker(true); setShowGifPicker(false); messageInputRef.current?.blur(); } }} className="p-2 text-messenger-muted hover:text-messenger-accent flex items-center justify-center shrink-0">{showEmojiPicker ? <Keyboard size={22} /> : <Smile size={22} />}</button>
            <button onClick={() => { if (showGifPicker) { setShowGifPicker(false); setTimeout(() => messageInputRef.current?.focus(), 50); } else { setShowGifPicker(true); setShowEmojiPicker(false); messageInputRef.current?.blur(); } }} className={`p-2 flex items-center justify-center shrink-0 text-[12px] font-bold rounded transition-colors ${showGifPicker ? 'text-messenger-accent' : 'text-messenger-muted hover:text-messenger-accent'}`}>GIF</button>
            <div
              ref={messageInputRef}
              contentEditable="true"
              role="textbox"
              inputMode="text"
              tabIndex={0}
              aria-placeholder="Сообщение..."
              style={{ WebkitUserSelect: 'text', userSelect: 'text' } as React.CSSProperties}
              onClick={() => messageInputRef.current?.focus()}
              onInput={(e) => { const el = e.target as HTMLDivElement; const text = extractContentWithEmoji(el); setMessageText(text); startTyping(); setMentionQuery(getMentionQueryFromCaret(el)); }}
              onCompositionEnd={(e) => { const text = extractContentWithEmoji(e.target as HTMLDivElement); setMessageText(text); }}
              onKeyDown={(e) => { if (mentionQuery !== null && e.key === 'Escape') { e.preventDefault(); setMentionQuery(null); return; } if (e.key === 'Enter' && !e.shiftKey && !/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) { e.preventDefault(); handleSendMessage(); } }}
              onFocus={() => { if (showEmojiPicker) setShowEmojiPicker(false); }}
              onPaste={(e) => {
                // Сначала смотрим, нет ли в буфере файлов: скриншот через
                // Ctrl+V — самый частый способ отправить картинку с
                // компьютера, а раньше вставлялся только текст, и всё
                // остальное молча выбрасывалось.
                const files = Array.from(e.clipboardData.files || []);
                if (files.length > 0) {
                  e.preventDefault();
                  acceptIncomingFiles(files);
                  return;
                }
                e.preventDefault();
                const text = e.clipboardData.getData('text/plain');
                document.execCommand('insertText', false, text);
              }}
              suppressContentEditableWarning
              className="msg-editable flex-1 bg-transparent py-2 pr-2 text-[16px] text-messenger-text focus:outline-none min-w-0 break-words whitespace-pre-wrap overflow-y-auto max-h-[120px] [&:empty]:before:content-[attr(aria-placeholder)] [&:empty]:before:text-messenger-muted [&:empty]:before:pointer-events-none"
            />
          </div>
          {isRecording ? (
            <div className="flex items-center gap-1.5 h-[44px] bg-messenger-input rounded-full px-3 animate-scale-in shrink-0">
              <div className="w-2.5 h-2.5 bg-red-500 rounded-full animate-pulse" />
              <span className="text-[14px] tabular-nums text-messenger-text">{formatDuration(recordingDuration)}</span>
              <button onClick={handleCancelRecording} className="text-messenger-muted hover:text-red-500 p-1"><Trash2 size={18} /></button>
              <button onClick={handleStopRecording} className="text-messenger-accent p-1"><Send size={18} /></button>
            </div>
          ) : (
            <button
              onClick={messageText.trim() ? handleSendMessage : handleStartRecording}
              onContextMenu={(e) => { if (!messageText.trim()) { e.preventDefault(); setShowVideoCircleRecorder(true); } }}
              onTouchStart={() => { if (!messageText.trim()) { (window as any).__micLongPress = setTimeout(() => { (window as any).__micLongPressed = true; setShowVideoCircleRecorder(true); }, 500); }}}
              onTouchEnd={() => { clearTimeout((window as any).__micLongPress); setTimeout(() => { (window as any).__micLongPressed = false; }, 100); }}
              onTouchCancel={() => { clearTimeout((window as any).__micLongPress); }}
              className="w-[44px] h-[44px] rounded-full bg-messenger-accent/10 text-messenger-accent hover:bg-messenger-accent/20 transition-colors shrink-0 flex items-center justify-center"
            >
              {messageText.trim() ? <Send size={20} /> : <Mic size={22} />}
            </button>
          )}
        </div>
      </div>

      {showEmojiPicker && (
        <div className="bg-messenger-sidebar border-t border-messenger-border flex-shrink-0 z-30">
          <EmojiPicker onEmojiSelect={(emoji) => { setMessageText(prev => prev + emoji); if (messageInputRef.current) { appendEmojiToContentEditable(messageInputRef.current, emoji); } }} onClose={() => { setShowEmojiPicker(false); setTimeout(() => messageInputRef.current?.focus(), 50); }} />
        </div>
      )}

      {showGifPicker && (
        <div className="flex-shrink-0 z-30">
          <GifPicker
            onSelect={async (gifUrl, _previewUrl, width, height) => {
              setShowGifPicker(false);
              try {
                const msgResponse = await chatApi.sendMessage(chat.id, {
                  content: gifUrl,
                  type: 'gif',
                  metadata: { gif_url: gifUrl, width, height } as any,
                });
                const sentMsg = msgResponse.data?.message;
                if (sentMsg) {
                  useChatStore.getState().addMessage(sentMsg);
                  cacheSingleMessage(sentMsg).catch(() => {});
                }
                userScrolledUpRef.current = false;
                scrollToBottom();
              } catch (e) { console.error('GIF send failed:', e); }
            }}
            onClose={() => { setShowGifPicker(false); setTimeout(() => messageInputRef.current?.focus(), 50); }}
          />
        </div>
      )}

      {/* Video Circle Recorder */}
      {showVideoCircleRecorder && (
        <VideoCircleRecorder
          onSend={handleSendVideoCircle}
          onCancel={() => setShowVideoCircleRecorder(false)}
        />
      )}

      {/* Camera Capture */}
      {showCameraCapture && (
        <CameraCapture
          onSendPhoto={handleCameraPhoto}
          onSendVideo={handleCameraVideo}
          onCancel={() => setShowCameraCapture(false)}
        />
      )}

      {/* Context Menu */}
      {contextMenu && (
        <div className="fixed inset-0 z-[80]" onClick={() => { setContextMenu(null); setShowReactionPicker(null); }}>
          <div
            className="absolute bg-messenger-sidebar rounded-xl shadow-2xl border border-messenger-border py-1.5 min-w-[180px] max-w-[calc(100vw-16px)] animate-scale-in"
            style={{
              top: Math.min(contextMenu.y, window.innerHeight - (showReactionPicker ? 520 : 320)),
              left: '50%',
              transform: 'translateX(-50%)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Быстрые реакции */}
            <div className="flex items-center gap-1 px-3 py-2 border-b border-messenger-border">
              {QUICK_REACTIONS.map(emoji => (
                <button
                  key={emoji}
                  onClick={() => { handleToggleReaction(contextMenu.message.chat_id, contextMenu.message.id, emoji); setContextMenu(null); setShowReactionPicker(null); }}
                  className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-messenger-hover transition-all hover:scale-125 text-[18px]"
                >
                  {emoji}
                </button>
              ))}
              {/* Разделитель */}
              <div className="w-px h-6 bg-messenger-border mx-0.5" />
              {/* Кнопка открытия полного эмодзи-пикера */}
              <button
                onClick={() => setShowReactionPicker(showReactionPicker ? null : { messageId: contextMenu.message.id, chatId: contextMenu.message.chat_id })}
                className={`w-8 h-8 flex items-center justify-center rounded-full transition-all hover:scale-110 ${
                  showReactionPicker ? 'bg-messenger-accent/20 text-messenger-accent' : 'hover:bg-messenger-hover text-messenger-muted'
                }`}
                title="Выбрать эмодзи"
              >
                <SmilePlus size={18} />
              </button>
            </div>
            {/* Полный эмодзи-пикер для реакций */}
            {showReactionPicker && (
              <div className="border-b border-messenger-border">
                <EmojiPicker
                  onEmojiSelect={(emoji) => {
                    handleToggleReaction(showReactionPicker.chatId, showReactionPicker.messageId, emoji);
                    setContextMenu(null);
                    setShowReactionPicker(null);
                  }}
                  onClose={() => setShowReactionPicker(null)}
                />
              </div>
            )}
            <button onClick={() => { setReplyToMessage(contextMenu.message); setContextMenu(null); setShowReactionPicker(null); }} className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-messenger-hover transition-colors text-[14px] text-messenger-text">
              <Reply size={18} className="text-messenger-muted" />
              <span>Ответить</span>
            </button>
            <button onClick={() => { navigator.clipboard.writeText(contextMenu.message.content || ''); setContextMenu(null); setShowReactionPicker(null); }} className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-messenger-hover transition-colors text-[14px] text-messenger-text">
              <Copy size={18} className="text-messenger-muted" />
              <span>Скопировать</span>
            </button>
            <button onClick={() => { setForwardMessage(contextMenu.message); setContextMenu(null); setShowReactionPicker(null); }} className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-messenger-hover transition-colors text-[14px] text-messenger-text">
              <Forward size={18} className="text-messenger-muted" />
              <span>Переслать</span>
            </button>
            {contextMenu.message.sender_id !== user?.id && !String(contextMenu.message.id).startsWith('pending-') && (
              <button onClick={() => { setReportDialog({ message: contextMenu.message, reason: '', comment: '', sending: false }); setContextMenu(null); setShowReactionPicker(null); }} className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-messenger-hover transition-colors text-[14px] text-orange-400">
                <Flag size={18} />
                <span>Пожаловаться</span>
              </button>
            )}
            {contextMenu.message.sender_id === user?.id && (contextMenu.message.type === 'text' || contextMenu.message.content) && (
              <button onClick={() => { setEditingMessage(contextMenu.message); const rawTxt = contextMenu.message.content || ''; const txt = rawTxt.replace(/^↗ Переслано от .+?:\n/, ''); setMessageText(txt); if (messageInputRef.current) { setContentEditableWithEmoji(messageInputRef.current, txt); } setContextMenu(null); setShowReactionPicker(null); setTimeout(() => messageInputRef.current?.focus(), 50); }} className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-messenger-hover transition-colors text-[14px] text-messenger-text">
                <Edit3 size={18} className="text-messenger-muted" />
                <span>Изменить</span>
              </button>
            )}
            <div className="border-t border-messenger-border my-1" />
            <button onClick={() => { setDeleteDialog({ message: contextMenu.message }); setContextMenu(null); setShowReactionPicker(null); }} className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-messenger-hover transition-colors text-[14px] text-red-400">
              <Trash2 size={18} />
              <span>Удалить</span>
            </button>
          </div>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      {reportDialog && (
        <div className="fixed inset-0 z-[9999] bg-black/60 flex items-center justify-center p-4" onClick={() => !reportDialog.sending && setReportDialog(null)}>
          <div className="w-full max-w-sm rounded-2xl bg-messenger-sidebar p-5 space-y-3" onClick={e => e.stopPropagation()}>
            {reportDialog.done ? (
              <>
                <div className="text-[15px] text-messenger-text">{reportDialog.done}</div>
                <button onClick={() => setReportDialog(null)} className="w-full py-2.5 rounded-xl bg-primary-500 text-white text-sm font-medium">Понятно</button>
              </>
            ) : (
              <>
                <div className="text-[16px] font-semibold text-messenger-text">Пожаловаться на сообщение</div>
                <div className="text-[12px] text-messenger-muted">Модераторы увидят только это сообщение. Ваше имя автору не показывается.</div>
                <div className="grid grid-cols-1 gap-1.5">
                  {([
                  ['illegal', 'Противозаконное'],
                  ['violence', 'Насилие, угрозы, травля'],
                  ['extremism', 'Экстремизм, терроризм'],
                  ['drugs', 'Наркотики'],
                  ['csam', 'Вред детям'],
                  ['porn', 'Порнография'],
                  ['fraud', 'Мошенничество'],
                  ['spam', 'Спам'],
                  ['other', 'Другое']
                  ] as const).map(([id, label]) => (
                    <button key={id} onClick={() => setReportDialog({ ...reportDialog, reason: id })}
                            className={`text-left px-3 py-2 rounded-lg text-[14px] ${reportDialog.reason === id ? 'bg-orange-500/20 text-orange-300' : 'bg-messenger-hover/60 text-messenger-text'}`}>
                      {label}
                    </button>
                  ))}
                </div>
                <textarea value={reportDialog.comment} onChange={e => setReportDialog({ ...reportDialog, comment: e.target.value })}
                          placeholder="Что не так (необязательно)" maxLength={1000} rows={2}
                          className="w-full rounded-lg bg-messenger-hover/60 p-2 text-[14px] text-messenger-text outline-none resize-none" />
                <div className="flex gap-2">
                  <button onClick={() => setReportDialog(null)} className="flex-1 py-2.5 rounded-xl bg-messenger-hover text-messenger-text text-sm">Отмена</button>
                  <button
                    disabled={!reportDialog.reason || reportDialog.sending}
                    onClick={async () => {
                      setReportDialog({ ...reportDialog, sending: true });
                      try {
                        await reportApi.create({ message_id: reportDialog.message.id, reason: reportDialog.reason, comment: reportDialog.comment || undefined });
                        setReportDialog({ ...reportDialog, sending: false, done: 'Жалоба отправлена. Спасибо — модераторы разберутся.' });
                      } catch (e: any) {
                        setReportDialog({ ...reportDialog, sending: false, done: e?.response?.data?.error || 'Не удалось отправить — проверьте связь и попробуйте ещё раз.' });
                      }
                    }}
                    className="flex-1 py-2.5 rounded-xl bg-orange-500 text-white text-sm font-medium disabled:opacity-40">
                    {reportDialog.sending ? 'Отправляю…' : 'Отправить'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {deleteDialog && (
        <div className="fixed inset-0 z-[90] bg-black/60 flex items-center justify-center animate-fade-in" onClick={() => setDeleteDialog(null)}>
          <div className="bg-messenger-sidebar rounded-2xl p-6 w-full max-w-sm mx-4 shadow-2xl border border-messenger-border" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-medium mb-2">Удалить сообщение</h3>
            <p className="text-sm text-messenger-muted mb-5">Вы уверены, что хотите удалить это сообщение?</p>
            <div className="flex flex-col gap-2">
              {deleteDialog.message.sender_id === user?.id && (
                <button onClick={() => handleDeleteMessage('for_all')} className="w-full py-2.5 rounded-xl bg-red-500 text-white hover:bg-red-600 transition-colors text-sm font-medium">Удалить для всех</button>
              )}
              <button onClick={() => handleDeleteMessage('for_me')} className="w-full py-2.5 rounded-xl bg-messenger-hover text-messenger-text hover:bg-messenger-border transition-colors text-sm">Удалить для меня</button>
              <button onClick={() => setDeleteDialog(null)} className="w-full py-2.5 rounded-xl text-messenger-muted hover:bg-messenger-hover transition-colors text-sm">Отмена</button>
            </div>
          </div>
        </div>
      )}

      {/* Forward Message Dialog */}
      {forwardMessage && (
        <div className="fixed inset-0 z-[90] bg-black/60 flex items-center justify-center animate-fade-in" onClick={() => setForwardMessage(null)}>
          <div className="bg-messenger-sidebar rounded-2xl w-full max-w-sm mx-4 shadow-2xl border border-messenger-border max-h-[70vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="p-4 border-b border-messenger-border flex items-center justify-between">
              <h3 className="text-lg font-medium">Переслать в чат</h3>
              <button onClick={() => setForwardMessage(null)} className="p-1 rounded-full hover:bg-messenger-hover text-messenger-muted"><X size={18} /></button>
            </div>
            <div className="overflow-y-auto flex-1 py-2">
              {chats.filter(c => c.id !== chat.id).map(c => {
                const cName = c.type === 'group' ? c.name : c.members?.find(m => m.id !== user?.id)?.display_name || c.members?.find(m => m.id !== user?.id)?.username || 'Чат';
                return (
                  <button key={c.id} onClick={async () => {
                    try {
                      const senderName = forwardMessage.sender?.display_name || forwardMessage.sender?.username || '';
                      const fwdPrefix = `↗ Переслано от ${senderName}`;
                      const fwdMeta = parseMetadata(forwardMessage.metadata);

                      if ((forwardMessage.type === 'image' || forwardMessage.type === 'gif' || forwardMessage.type === 'video' || forwardMessage.type === 'audio' || forwardMessage.type === 'file') && fwdMeta?.file_id) {
                        // Пересылка медиафайлов с сохранением типа и metadata
                        await chatApi.sendMessage(c.id, {
                          content: forwardMessage.content || fwdPrefix,
                          type: forwardMessage.type,
                          metadata: {
                            ...fwdMeta,
                            forwarded_from: senderName,
                          } as any,
                        });
                      } else if (forwardMessage.type === 'voice' && fwdMeta?.filename) {
                        // Пересылка голосовых с сохранением metadata
                        await chatApi.sendMessage(c.id, {
                          content: forwardMessage.content || '🎤 Голосовое сообщение',
                          type: 'voice',
                          metadata: {
                            ...fwdMeta,
                            forwarded_from: senderName,
                          } as any,
                        });
                      } else {
                        // Текстовые сообщения
                        const fwd = `${fwdPrefix}:\n${forwardMessage.content || ''}`;
                        await chatApi.sendMessage(c.id, { content: fwd, type: 'text' });
                      }
                      setForwardMessage(null);
                    } catch (err) { console.error('Forward failed:', err); }
                  }} className="w-full flex items-center gap-3 px-4 py-3 hover:bg-messenger-hover transition-colors">
                    <div className="w-10 h-10 rounded-full bg-primary-500 flex items-center justify-center text-white font-medium">{(cName || '?')[0].toUpperCase()}</div>
                    <span className="text-[15px] truncate">{cName}</span>
                  </button>
                );
              })}
              {chats.filter(c => c.id !== chat.id).length === 0 && (
                <p className="text-center text-messenger-muted py-8 text-sm">Нет других чатов</p>
              )}
            </div>
          </div>
        </div>
      )}
      
      {/* Fullscreen Avatar */}
      {showAvatarFullscreen && (
        <div className="fixed inset-0 z-[70] bg-black/90 flex items-center justify-center animate-fade-in" onClick={() => setShowAvatarFullscreen(false)}>
          <button onClick={() => setShowAvatarFullscreen(false)} className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors z-10"><X size={24} /></button>
          <img
            src={chat.type === 'group' ? chat.avatar_url : getUserAvatarUrl()}
            alt="Аватар"
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {/* Edit Local Nickname */}
      {editingLocalNick && otherUser && (
        <div className="fixed inset-0 z-[70] bg-black/60 flex items-center justify-center animate-fade-in" onClick={() => setEditingLocalNick(false)}>
          <div className="bg-messenger-sidebar rounded-2xl p-6 w-full max-w-sm mx-4 shadow-2xl border border-messenger-border" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-medium mb-4">Изменить имя контакта</h3>
            <p className="text-sm text-messenger-muted mb-3">Это имя будет видно только вам</p>
            <input
              type="text"
              value={localNickInput}
              onChange={(e) => setLocalNickInput(e.target.value)}
              placeholder={otherUser.display_name || otherUser.username}
              className="w-full px-4 py-2.5 rounded-xl bg-messenger-bg border border-messenger-border text-messenger-text focus:outline-none focus:border-primary-500 mb-4"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setLocalNick(otherUser.id, localNickInput || null);
                  setEditingLocalNick(false);
                }
              }}
            />
            <div className="flex gap-2 justify-end">
              {getLocalNick(otherUser.id) && (
                <button onClick={() => { setLocalNick(otherUser.id, null); setEditingLocalNick(false); }} className="px-4 py-2 rounded-xl text-red-400 hover:bg-red-500/10 transition-colors text-sm">Сбросить</button>
              )}
              <button onClick={() => setEditingLocalNick(false)} className="px-4 py-2 rounded-xl text-messenger-muted hover:bg-messenger-hover transition-colors text-sm">Отмена</button>
              <button onClick={() => { setLocalNick(otherUser.id, localNickInput || null); setEditingLocalNick(false); }} className="px-4 py-2 rounded-xl bg-primary-500 text-white hover:bg-primary-600 transition-colors text-sm">Сохранить</button>
            </div>
          </div>
        </div>
      )}

      {/* Hidden input for local avatar */}
      <input ref={localAvatarInputRef} type="file" accept="image/*" onChange={handleLocalAvatarUpload} className="hidden" />

      {/* Hidden input for group avatar */}
      <input ref={groupAvatarInputRef} type="file" accept="image/*" onChange={handleGroupAvatarUpload} className="hidden" />

      {/* Hidden input for music files */}
      <input ref={musicInputRef} type="file" accept="audio/mpeg, audio/mp4, audio/ogg, audio/wav, audio/x-wav, audio/aac, audio/*" multiple onChange={handleMusicUpload} className="hidden" />

      {/* Hidden input for video files */}
      <input ref={videoInputRef} type="file" accept="video/mp4, video/x-m4v, video/webm, video/quicktime, video/*" multiple onChange={handleVideoUpload} className="hidden" />

      {/* User / Group Info Panel */}
      {showUserInfo && (
        <>
        <div className="fixed inset-0 z-[59] bg-black/30 md:block hidden" onClick={() => { setShowUserInfo(false); setInfoTab('info'); }} />
        <div className="fixed inset-0 md:inset-y-0 md:right-0 md:left-auto z-[60] flex md:w-full md:max-w-sm w-full bg-messenger-sidebar md:border-l border-messenger-border shadow-2xl flex-col animate-slide-in-right">
          {/* Header */}
          <div className="flex items-center gap-3 px-4 h-14 border-b border-messenger-border flex-shrink-0">
            <button onClick={() => { setShowUserInfo(false); setInfoTab('info'); }} className="p-2 -ml-2 rounded-full hover:bg-messenger-hover text-messenger-muted"><ArrowLeft size={24} /></button>
            <h3 className="font-medium text-lg flex-1">Информация</h3>
            {isGroup && (
              <button onClick={() => groupAvatarInputRef.current?.click()} className="p-2 rounded-full hover:bg-messenger-hover text-messenger-muted"><Pencil size={18} /></button>
            )}
          </div>
          
          {/* Tabs — для групп: Участники/Медиа/Файлы, для лички: Профиль/Медиа/Файлы/... */}
          <div className="flex border-b border-messenger-border flex-shrink-0 overflow-x-auto no-scrollbar">
            {(isGroup ? [
              ['info', 'Участники'],
              ['media', 'Медиа'],
              ['files', 'Файлы'],
              ['music', 'Музыка'],
              ['voice', 'Голосовые'],
            ] as const : [
              ['info', 'Профиль'],
              ['media', 'Медиа'],
              ['files', 'Файлы'],
              ['music', 'Музыка'],
              ['voice', 'Голосовые'],
              ['links', 'Ссылки'],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setInfoTab(key)}
                className={`px-3 py-2.5 text-[13px] font-medium whitespace-nowrap transition-colors border-b-2 ${infoTab === key ? 'border-primary-500 text-primary-500' : 'border-transparent text-messenger-muted hover:text-messenger-text'}`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Search bar for media tabs */}
          {infoTab !== 'info' && (
            <div className="px-3 py-2 border-b border-messenger-border flex-shrink-0">
              <div className="flex items-center gap-2 bg-messenger-hover/60 rounded-lg px-3 py-1.5">
                <Search size={16} className="text-messenger-muted shrink-0" />
                <input
                  type="text"
                  value={mediaSearchQuery}
                  onChange={e => setMediaSearchQuery(e.target.value)}
                  placeholder={infoTab === 'voice' ? 'Имя, кто прислал, дата, текст...' : 'Имя, кто прислал, дата...'}
                  className="flex-1 bg-transparent text-[13px] text-messenger-text placeholder:text-messenger-muted focus:outline-none"
                />
                {mediaSearchQuery && (
                  <button onClick={() => setMediaSearchQuery('')} className="p-0.5 rounded-full hover:bg-messenger-hover text-messenger-muted"><X size={14} /></button>
                )}
              </div>
              {/* Честно говорим, сколько записей просмотрено — чтобы «ничего
                  не найдено» не путали с «ещё не догрузилось». */}
              <div className="flex items-center gap-2 mt-1 px-1 text-[11px] text-messenger-muted">
                {mediaSearchQuery.trim()
                  ? <span>найдено {filteredMediaItems.length} из {mediaItems.length}</span>
                  : <span>всего {mediaItems.length}</span>}
                {mediaLoading && <span className="opacity-70">· загружаю…</span>}
                {mediaItems.length >= MEDIA_MAX && <span className="opacity-70">· показаны последние {MEDIA_MAX}</span>}
              </div>
            </div>
          )}

          <div className="overflow-y-auto flex-1">
            {/* === Tab: Profile / Members === */}
            {infoTab === 'info' && isGroup && (
              <div className="flex flex-col">
                {/* Аватар группы */}
                <div className="flex flex-col items-center pt-6 pb-4">
                  <div
                    className="w-24 h-24 rounded-full overflow-hidden shadow-lg cursor-pointer hover:opacity-90 transition-opacity relative group"
                    onClick={() => {
                      const url = chat.avatar_url;
                      if (url) { setShowUserInfo(false); setShowAvatarFullscreen(true); }
                    }}
                  >
                    {(() => {
                      const url = chat.avatar_url;
                      if (url) return <img src={url} alt="" className="w-full h-full object-cover" />;
                      return <div className={`w-full h-full flex items-center justify-center text-white text-4xl ${chat.type === 'channel' ? 'bg-gradient-to-br from-violet-500 to-purple-600' : 'bg-gradient-to-br from-blue-400 to-blue-600'}`}>{(chat.name || '?')[0]}</div>;
                    })()}
                  </div>
                  <h2 className="text-xl font-medium mt-3">{chat.name || 'Группа'}</h2>
                  <p className="text-messenger-muted text-sm mt-1">
                    {chat.members?.length || 0} участников{(() => {
                      const online = (chat.members || []).filter(m => onlineUsers.has(m.id)).length;
                      return online > 0 ? `, ${online} в сети` : '';
                    })()}
                  </p>
                </div>

                {/* Кнопки быстрых действий */}
                <div className="flex items-center justify-center gap-2 px-4 pb-4">
                  <button onClick={() => { setShowUserInfo(false); }} className="flex flex-col items-center gap-1 px-4 py-2 rounded-xl bg-messenger-hover/60 hover:bg-messenger-hover transition-colors min-w-[72px]">
                    <MessageCircle size={20} className="text-messenger-text" />
                    <span className="text-[11px] text-messenger-muted">Чат</span>
                  </button>
                  <button onClick={() => { setShowUserInfo(false); onInitiateCall?.('audio'); }} disabled={isCallActive} className="flex flex-col items-center gap-1 px-4 py-2 rounded-xl bg-messenger-hover/60 hover:bg-messenger-hover transition-colors min-w-[72px] disabled:opacity-30">
                    <BellOff size={20} className="text-messenger-text" />
                    <span className="text-[11px] text-messenger-muted">Звук</span>
                  </button>
                  <button onClick={() => { setShowUserInfo(false); onInitiateCall?.('video'); }} disabled={isCallActive} className="flex flex-col items-center gap-1 px-4 py-2 rounded-xl bg-messenger-hover/60 hover:bg-messenger-hover transition-colors min-w-[72px] disabled:opacity-30">
                    <Video size={20} className="text-messenger-text" />
                    <span className="text-[11px] text-messenger-muted">Видеочат</span>
                  </button>
                  <button onClick={async () => { if (confirm('Покинуть группу?')) { try { await chatApi.leaveChat(chat.id); useChatStore.getState().removeChat(chat.id); navigate('/'); } catch {} }}} className="flex flex-col items-center gap-1 px-4 py-2 rounded-xl bg-messenger-hover/60 hover:bg-messenger-hover transition-colors min-w-[72px]">
                    <LogOut size={20} className="text-red-400" />
                    <span className="text-[11px] text-red-400">Покинуть</span>
                  </button>
                </div>

                <div className="border-t border-messenger-border" />

                {/* Добавить участников */}
                <button onClick={() => setShowInviteMembers(true)} className="flex items-center gap-3 px-5 py-3.5 hover:bg-messenger-hover transition-colors text-messenger-accent">
                  <UserPlus size={20} />
                  <span className="text-[15px] font-medium">Добавить участников</span>
                </button>

                {/* Invite Members Modal */}
                {showInviteMembers && (
                  <div className="px-4 py-3 border-b border-messenger-border">
                    <div className="relative mb-2">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-messenger-muted" />
                      <input
                        type="text"
                        value={inviteSearchQuery}
                        onChange={(e) => handleInviteSearch(e.target.value)}
                        placeholder="Поиск пользователей..."
                        className="w-full bg-messenger-input border border-transparent focus:border-messenger-accent rounded-lg py-2 pl-10 pr-10 text-sm text-messenger-text placeholder-messenger-muted outline-none transition-all"
                        autoFocus
                      />
                      <button onClick={() => { setShowInviteMembers(false); setInviteSearchQuery(''); setInviteSearchResults([]); }}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-full hover:bg-messenger-hover text-messenger-muted">
                        <X size={16} />
                      </button>
                    </div>
                    <div className="max-h-60 overflow-y-auto">
                      {inviteSearching ? (
                        <div className="p-4 text-center"><Loader2 className="w-5 h-5 animate-spin mx-auto text-messenger-accent" /></div>
                      ) : inviteSearchResults.length > 0 ? (
                        inviteSearchResults.map((u: any) => (
                          <div key={u.id} className="flex items-center gap-3 px-2 py-2 hover:bg-messenger-hover rounded-lg transition-colors">
                            <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center text-white text-sm font-medium overflow-hidden shrink-0">
                              {u.avatar_url ? <img src={u.avatar_url} alt="" className="w-full h-full object-cover" /> : (u.display_name || u.username)?.[0]?.toUpperCase()}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-[14px] font-medium truncate text-messenger-text">{u.display_name || u.username}</p>
                              <p className="text-[12px] text-messenger-muted">@{u.username}</p>
                            </div>
                            <button onClick={() => handleInviteMember(u)}
                              className="px-3 py-1 rounded-full bg-messenger-accent text-white text-xs font-medium hover:opacity-90 transition-opacity shrink-0">
                              Добавить
                            </button>
                          </div>
                        ))
                      ) : inviteSearchQuery.length >= 2 ? (
                        <p className="p-4 text-center text-messenger-muted text-sm">Пользователи не найдены</p>
                      ) : (
                        <p className="p-4 text-center text-messenger-muted text-sm">Введите имя для поиска</p>
                      )}
                    </div>
                  </div>
                )}

                <div className="border-t border-messenger-border" />

                {/* Список участников */}
                <div className="py-1">
                  {(chat.members || []).map(member => {
                    const isAdmin = chat.created_by === member.id;
                    const memberOnline = onlineUsers.has(member.id);
                    const localNick = getLocalNick(member.id);
                    return (
                      <div key={member.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-messenger-hover transition-colors">
                        <div className="relative shrink-0">
                          <div className="w-11 h-11 rounded-full overflow-hidden bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center text-white text-sm font-medium">
                            {member.avatar_url ? <img src={member.avatar_url} alt="" className="w-full h-full object-cover" /> : (member.display_name || member.username || '?')[0].toUpperCase()}
                          </div>
                          {memberOnline && <div className="absolute bottom-0 right-0 w-3 h-3 bg-[#0ac630] border-2 border-messenger-sidebar rounded-full" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-[15px] font-medium truncate text-messenger-text flex items-center gap-1.5">
                            {member.display_name || member.username}
                            {isAdmin && <span className="text-[10px] text-messenger-accent font-normal bg-messenger-accent/10 px-1.5 py-0.5 rounded">admin</span>}
                          </p>
                          <p className="text-[13px] text-messenger-muted">{memberOnline ? 'в сети' : 'не в сети'}</p>
                        </div>
                        {localNick && (
                          <span className="text-[13px] text-messenger-muted shrink-0">{localNick}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {/* === Tab: Profile (private chat) === */}
            {infoTab === 'info' && !isGroup && (
              <div className="p-6 flex flex-col items-center">
                {/* Аватар */}
                <div
                  className="w-28 h-28 rounded-full overflow-hidden mb-4 shadow-lg cursor-pointer hover:opacity-90 transition-opacity relative group"
                  onClick={() => {
                    const url = getUserAvatarUrl();
                    if (url) { setShowUserInfo(false); setShowAvatarFullscreen(true); }
                  }}
                >
                  {(() => {
                    const url = getUserAvatarUrl();
                    if (url) return <img src={url} alt="" className="w-full h-full object-cover" />;
                    return <div className="w-full h-full flex items-center justify-center bg-primary-500 text-white text-4xl">{(getDisplayName())?.[0]}</div>;
                  })()}
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white text-sm"><Camera size={24} /></div>
                </div>
                <h2 className="text-xl font-medium">{getDisplayName()}</h2>
                {otherUser && <p className="text-messenger-muted">@{otherUser.username}</p>}
                {otherUser && getLocalNick(otherUser.id) && (
                  <p className="text-sm text-messenger-muted mt-1">Настоящее имя: {otherUser.display_name || otherUser.username}</p>
                )}
                <div className="w-full mt-6 space-y-1">
                  {getUserAvatarUrl() && (
                    <button onClick={() => { setShowUserInfo(false); setShowAvatarFullscreen(true); }} className="w-full flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-messenger-hover transition-colors text-left text-[15px]">
                      <span className="text-messenger-muted">📷</span><span>Открыть фото</span>
                    </button>
                  )}
                  {otherUser && (
                    <button onClick={() => localAvatarInputRef.current?.click()} className="w-full flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-messenger-hover transition-colors text-left text-[15px]">
                      <ImageIcon size={18} className="text-messenger-muted" /><span>Установить свою аватарку</span>
                    </button>
                  )}
                  {otherUser && getLocalAvatar(otherUser.id) && (
                    <button onClick={() => { setLocalAvatar(otherUser.id, null); }} className="w-full flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-messenger-hover transition-colors text-left text-[15px] text-red-400">
                      <Trash2 size={18} /><span>Сбросить аватарку</span>
                    </button>
                  )}
                  {otherUser && (
                    <button onClick={() => { setShowUserInfo(false); setEditingLocalNick(true); setLocalNickInput(getLocalNick(otherUser.id) || ''); }} className="w-full flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-messenger-hover transition-colors text-left text-[15px]">
                      <Edit3 size={18} className="text-messenger-muted" /><span>Изменить имя</span>
                    </button>
                  )}
                    {otherUser && (
                      <button
                        onClick={() => void переключитьУведомления(!contactMuted)}
                        className="w-full flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-messenger-hover transition-colors text-left text-[15px]"
                      >
                        {contactMuted
                          ? <BellOff size={18} className="text-amber-500" />
                          : <Bell size={18} className="text-messenger-muted" />}
                        <span className="flex-1">
                          {contactMuted ? 'Включить уведомления' : 'Отключить уведомления'}
                        </span>
                      </button>
                    )}
                    {otherUser && contactMuted && (
                      <p className="px-4 pb-2 -mt-1 text-[12px] text-messenger-muted leading-snug">
                        Сообщения приходят и остаются в переписке — телефон о них молчит.
                      </p>
                    )}
                </div>

                {/* Быстрые действия */}
                <div className="w-full mt-4 pt-4 border-t border-messenger-border">
                  <h3 className="text-[13px] font-medium text-messenger-muted uppercase tracking-wide mb-3 px-1">Отправить</h3>
                  <div className="flex gap-4 px-1">
                    <button onClick={handleSendLocation} className="flex flex-col items-center gap-1.5">
                      <div className="w-12 h-12 rounded-full bg-orange-500/15 flex items-center justify-center"><MapPin size={22} className="text-orange-500" /></div>
                      <span className="text-[11px] text-messenger-muted">Локация</span>
                    </button>
                    <button onClick={() => musicInputRef.current?.click()} className="flex flex-col items-center gap-1.5">
                      <div className="w-12 h-12 rounded-full bg-pink-500/15 flex items-center justify-center"><MusicIcon size={22} className="text-pink-500" /></div>
                      <span className="text-[11px] text-messenger-muted">Музыка</span>
                    </button>
                    <button onClick={() => { fileInputRef.current?.setAttribute('accept', 'image/*,video/*'); fileInputRef.current?.click(); }} className="flex flex-col items-center gap-1.5">
                      <div className="w-12 h-12 rounded-full bg-blue-500/15 flex items-center justify-center"><ImageIcon size={22} className="text-blue-500" /></div>
                      <span className="text-[11px] text-messenger-muted">Фото</span>
                    </button>
                    <button onClick={() => { fileInputRef.current?.removeAttribute('accept'); fileInputRef.current?.click(); }} className="flex flex-col items-center gap-1.5">
                      <div className="w-12 h-12 rounded-full bg-green-500/15 flex items-center justify-center"><FileIcon size={22} className="text-green-500" /></div>
                      <span className="text-[11px] text-messenger-muted">Файл</span>
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* === Tab: Media (images + videos) === */}
            {infoTab === 'media' && (
              <div className="p-3">
                {mediaLoading ? (
                  <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-messenger-muted" /></div>
                ) : filteredMediaItems.length === 0 ? (
                  <div className="text-center py-12 text-messenger-muted">
                    <Film size={48} className="mx-auto mb-3 opacity-30" />
                    <p className="text-sm">{mediaSearchQuery ? 'Ничего не найдено' : 'Нет медиафайлов'}</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-3 gap-1">
                    {filteredMediaItems.map(msg => {
                      const meta = parseMetadata(msg.metadata);
                      const fileId = meta?.file_id;
                      if (!fileId) return null;
                      const url = fileApi.getViewUrl(fileId);
                      return msg.type === 'video' ? (
                        <div key={msg.id} className="aspect-square relative rounded-lg overflow-hidden cursor-pointer group bg-black/20" onClick={() => window.open(url, '_blank')}
                          onContextMenu={e => handleMediaItemContext(msg, e)}
                          onTouchStart={e => handleMediaItemPress(msg, e)} onTouchEnd={handleMediaItemRelease}
                          onMouseDown={e => { if (e.button === 0) handleMediaItemPress(msg, e); }} onMouseUp={handleMediaItemRelease} onMouseLeave={handleMediaItemRelease}
                        >
                          <VideoThumbnail src={url} className="w-full h-full object-cover" />
                          <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                            <Play size={24} className="text-white" fill="white" />
                          </div>
                          <div className="absolute bottom-1 left-1 text-[10px] text-white bg-black/60 px-1 rounded">{format(new Date(msg.created_at), 'dd.MM.yy')}</div>
                        </div>
                      ) : (
                        <div key={msg.id} className="aspect-square relative rounded-lg overflow-hidden cursor-pointer group bg-black/10" onClick={() => window.open(url, '_blank')}
                          onContextMenu={e => handleMediaItemContext(msg, e)}
                          onTouchStart={e => handleMediaItemPress(msg, e)} onTouchEnd={handleMediaItemRelease}
                          onMouseDown={e => { if (e.button === 0) handleMediaItemPress(msg, e); }} onMouseUp={handleMediaItemRelease} onMouseLeave={handleMediaItemRelease}
                        >
                          <img src={url} alt="" className="w-full h-full object-cover" loading="lazy" onError={(e) => { e.currentTarget.style.opacity = '0'; }} />
                          <div className="absolute bottom-1 left-1 text-[10px] text-white bg-black/60 px-1 rounded">{format(new Date(msg.created_at), 'dd.MM.yy')}</div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* === Tab: Files === */}
            {infoTab === 'files' && (
              <div className="p-3">
                {mediaLoading ? (
                  <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-messenger-muted" /></div>
                ) : filteredMediaItems.length === 0 ? (
                  <div className="text-center py-12 text-messenger-muted">
                    <FileIcon size={48} className="mx-auto mb-3 opacity-30" />
                    <p className="text-sm">{mediaSearchQuery ? 'Ничего не найдено' : 'Нет файлов'}</p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {filteredMediaItems.map(msg => {
                      const meta = parseMetadata(msg.metadata);
                      const fileId = meta?.file_id;
                      const url = fileId ? fileApi.getDownloadUrl(fileId) : '#';
                      return (
                        <div key={msg.id} className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-messenger-hover transition-colors"
                          onContextMenu={e => handleMediaItemContext(msg, e)}
                          onTouchStart={e => handleMediaItemPress(msg, e)} onTouchEnd={handleMediaItemRelease}
                          onMouseDown={e => { if (e.button === 0) handleMediaItemPress(msg, e); }} onMouseUp={handleMediaItemRelease} onMouseLeave={handleMediaItemRelease}
                        >
                          <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center shrink-0"><FileIcon size={20} className="text-blue-500" /></div>
                          <div className="flex-1 min-w-0">
                            <p className="text-[14px] truncate">{meta?.file_name || msg.content || 'Файл'}</p>
                            <div className="flex items-center gap-2 text-[12px] text-messenger-muted">
                              {meta?.file_size && <span>{formatBytes(meta.file_size)}</span>}
                              <span>{format(new Date(msg.created_at), 'dd.MM.yy')}</span>
                              <span>от {msg.sender?.display_name || msg.sender?.username}</span>
                            </div>
                          </div>
                          <button type="button" className="p-2 rounded-full hover:bg-messenger-hover" onClick={e => { e.stopPropagation(); downloadFileNative(url, meta?.file_name || 'Файл'); }}><Download size={16} className="text-messenger-muted shrink-0" /></button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* === Tab: Music === */}
            {infoTab === 'music' && (
              <div className="p-3">
                <button onClick={() => musicInputRef.current?.click()} className="w-full flex items-center justify-center gap-2 px-4 py-2.5 mb-3 rounded-xl bg-pink-500/10 hover:bg-pink-500/20 transition-colors text-pink-500 text-sm font-medium">
                  <MusicIcon size={16} /> Отправить музыку
                </button>
                {mediaLoading ? (
                  <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-messenger-muted" /></div>
                ) : filteredMediaItems.length === 0 ? (
                  <div className="text-center py-12 text-messenger-muted">
                    <MusicIcon size={48} className="mx-auto mb-3 opacity-30" />
                    <p className="text-sm">{mediaSearchQuery ? 'Ничего не найдено' : 'Нет аудиофайлов'}</p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {filteredMediaItems.map(msg => {
                      const meta = parseMetadata(msg.metadata);
                      const fileId = meta?.file_id;
                      const url = fileId ? fileApi.getDownloadUrl(fileId) : '#';
                      return (
                        <div key={msg.id} className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-messenger-hover transition-colors"
                          onContextMenu={e => handleMediaItemContext(msg, e)}
                          onTouchStart={e => handleMediaItemPress(msg, e)} onTouchEnd={handleMediaItemRelease}
                          onMouseDown={e => { if (e.button === 0) handleMediaItemPress(msg, e); }} onMouseUp={handleMediaItemRelease} onMouseLeave={handleMediaItemRelease}
                        >
                          <div className="w-10 h-10 rounded-lg bg-pink-500/10 flex items-center justify-center shrink-0"><MusicIcon size={20} className="text-pink-500" /></div>
                          <div className="flex-1 min-w-0">
                            <p className="text-[14px] truncate">{meta?.file_name || msg.content || 'Аудио'}</p>
                            <div className="flex items-center gap-2 text-[12px] text-messenger-muted">
                              {meta?.file_size && <span>{formatBytes(meta.file_size)}</span>}
                              <span>{format(new Date(msg.created_at), 'dd.MM.yy')}</span>
                            </div>
                          </div>
                          <button type="button" className="p-2 rounded-full hover:bg-messenger-hover" onClick={e => { e.stopPropagation(); downloadFileNative(url, meta?.file_name || 'Аудио'); }}><Download size={16} className="text-messenger-muted" /></button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* === Tab: Voice messages === */}
            {infoTab === 'voice' && (
              <div className="p-3">
                {mediaLoading ? (
                  <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-messenger-muted" /></div>
                ) : filteredMediaItems.length === 0 ? (
                  <div className="text-center py-12 text-messenger-muted">
                    <Mic size={48} className="mx-auto mb-3 opacity-30" />
                    <p className="text-sm">{mediaSearchQuery ? 'Ничего не найдено' : 'Нет голосовых сообщений'}</p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {filteredMediaItems.map(msg => {
                      const meta = parseMetadata(msg.metadata);
                      const dur = meta?.duration ? Math.round(meta.duration / 1000) : 0;
                      return (
                        <div key={msg.id} className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-messenger-hover transition-colors"
                          onContextMenu={e => handleMediaItemContext(msg, e)}
                          onTouchStart={e => handleMediaItemPress(msg, e)} onTouchEnd={handleMediaItemRelease}
                          onMouseDown={e => { if (e.button === 0) handleMediaItemPress(msg, e); }} onMouseUp={handleMediaItemRelease} onMouseLeave={handleMediaItemRelease}
                        >
                          <div className="w-10 h-10 rounded-lg bg-green-500/10 flex items-center justify-center shrink-0"><Mic size={20} className="text-green-500" /></div>
                          <div className="flex-1 min-w-0">
                            <p className="text-[14px]">🎙 {dur > 0 ? `${Math.floor(dur / 60)}:${(dur % 60).toString().padStart(2, '0')}` : 'Голосовое'}</p>
                            <div className="flex items-center gap-2 text-[12px] text-messenger-muted">
                              <span>{format(new Date(msg.created_at), 'dd.MM.yy HH:mm')}</span>
                              <span>от {msg.sender?.display_name || msg.sender?.username}</span>
                            </div>
                            {meta?.transcript && <p className="text-[12px] text-messenger-muted mt-1 italic">«{meta.transcript}»</p>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* === Tab: Links === */}
            {infoTab === 'links' && (
              <div className="p-3">
                {mediaLoading ? (
                  <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-messenger-muted" /></div>
                ) : filteredMediaItems.length === 0 ? (
                  <div className="text-center py-12 text-messenger-muted">
                    <LinkIcon size={48} className="mx-auto mb-3 opacity-30" />
                    <p className="text-sm">{mediaSearchQuery ? 'Ничего не найдено' : 'Нет ссылок'}</p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {filteredMediaItems.map(msg => {
                      const urls = (msg.content || '').match(/https?:\/\/[^\s<]+/g) || [];
                      return (
                        <div key={msg.id} className="px-3 py-2.5 rounded-xl hover:bg-messenger-hover transition-colors"
                          onContextMenu={e => handleMediaItemContext(msg, e)}
                          onTouchStart={e => handleMediaItemPress(msg, e)} onTouchEnd={handleMediaItemRelease}
                          onMouseDown={e => { if (e.button === 0) handleMediaItemPress(msg, e); }} onMouseUp={handleMediaItemRelease} onMouseLeave={handleMediaItemRelease}
                        >
                          {urls.map((url, i) => (
                            <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 text-blue-400 hover:text-blue-300">
                              <LinkIcon size={16} className="shrink-0" />
                              <span className="text-[14px] truncate">{url}</span>
                            </a>
                          ))}
                          <div className="flex items-center gap-2 text-[12px] text-messenger-muted mt-1 pl-7">
                            <span>{format(new Date(msg.created_at), 'dd.MM.yy HH:mm')}</span>
                            <span>от {msg.sender?.display_name || msg.sender?.username}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Media item context menu overlay */}
          {mediaItemMenu && (
            <>
              {/* Подложка закрывает меню по НОВОМУ касанию, а не по времени.
                  Было: «закрыть, если с открытия прошло больше 500 мс» — а меню
                  открывается длинным нажатием ровно на 500 мс. Подержал палец
                  чуть дольше и отпустил — тот же самый палец меню и закрывал.
                  Теперь подложка глухая, пока палец, открывший меню, не поднят
                  (mediaMenuArmedRef), и реагирует на pointerdown, то есть на
                  начало нового касания, а не на конец старого. */}
              <div
                className="fixed inset-0 z-[70]"
                onPointerDown={() => { if (mediaMenuArmedRef.current) setMediaItemMenu(null); }}
                onContextMenu={e => { e.preventDefault(); setMediaItemMenu(null); }}
              />
              <div
                className="fixed z-[71] bg-messenger-sidebar border border-messenger-border rounded-xl shadow-2xl py-1.5 min-w-[200px] animate-scale-in"
                style={{
                  top: Math.min(mediaItemMenu.y, window.innerHeight - 160),
                  left: mediaItemMenu.x > window.innerWidth / 2 ? undefined : mediaItemMenu.x,
                  right: mediaItemMenu.x > window.innerWidth / 2 ? (window.innerWidth - mediaItemMenu.x) : undefined,
                }}
              >
                <button
                  onClick={() => { scrollToMessage(mediaItemMenu.msg.id); setMediaItemMenu(null); }}
                  className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-messenger-hover transition-colors text-[14px] text-messenger-text"
                >
                  <MessageSquare size={16} className="text-messenger-muted" /> Найти в чате
                </button>
                <button
                  onClick={() => handleMediaDelete(mediaItemMenu.msg, 'for_me')}
                  className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-messenger-hover transition-colors text-[14px] text-red-400"
                >
                  <Trash2 size={16} /> Удалить для себя
                </button>
                {mediaItemMenu.msg.sender_id === user?.id && (
                  <button
                    onClick={() => handleMediaDelete(mediaItemMenu.msg, 'for_all')}
                    className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-messenger-hover transition-colors text-[14px] text-red-400"
                  >
                    <Trash2 size={16} /> Удалить для всех
                  </button>
                )}
              </div>
            </>
          )}
        </div>
        </>
      )}

      {/* Image gallery lightbox */}
      {lightboxOpen && galleryImages.length > 0 && (
        <ImageLightbox
          images={galleryImages}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxOpen(false)}
        />
      )}

      {/* Image editor */}
      {imageEditorFile && (
        <ImageEditorModal
          file={imageEditorFile}
          onSend={(blob, caption) => handleImageEditorSend(blob, caption, imageEditorFile.name || `photo_${Date.now()}.jpg`)}
          onCancel={() => setImageEditorFile(null)}
        />
      )}

      {/* Attachment preview with caption */}
      {pendingAttachments && (
        <AttachmentPreview
          files={pendingAttachments}
          onSend={handleSendAttachments}
          onCancel={() => setPendingAttachments(null)}
        />
      )}
    </div>
  );
}
