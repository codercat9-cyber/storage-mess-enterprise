import React, { useEffect, useState } from 'react';
import { useAuthStore } from '@/store/auth';
import { useChatStore } from '@/store/chat';
import { useNavigate } from 'react-router-dom';
import { X, Send, File, Link } from 'lucide-react';

interface SharedFileEvent {
  path?: string;
  mimeType?: string;
  name?: string;
  text?: string;
}

export default function ShareModal() {
  const [sharedFile, setSharedFile] = useState<SharedFileEvent | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const chats = useChatStore((state) => state.chats);
  const currentUser = useAuthStore((state) => state.user);
  const navigate = useNavigate();

  useEffect(() => {
    const handleSharedFile = (e: any) => {
      const detail = e.detail as SharedFileEvent;
      if (detail && (detail.path || detail.text)) {
        setSharedFile(detail);
        setSelectedChatId(null);
        setIsOpen(true);
      }
    };
    window.addEventListener('native-shared-file', handleSharedFile);
    return () => window.removeEventListener('native-shared-file', handleSharedFile);
  }, []);

  const handleSend = async () => {
    if (!sharedFile || !selectedChatId) return;
    setSending(true);

    const fileToShare = sharedFile;
    const chatId = selectedChatId;

    setIsOpen(false);
    setSharedFile(null);
    setSelectedChatId(null);

    // Переходим в чат
    navigate(`/chat/${chatId}`);

    // Даём ChatArea время смонтироваться и подписаться на событие
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('send-shared-file', {
        detail: { chatId, file: fileToShare }
      }));
    }, 600);

    setSending(false);
  };

  if (!isOpen || !sharedFile) return null;

  const isText = !!sharedFile.text;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div className="bg-messenger-bg rounded-t-2xl sm:rounded-xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[85vh] border border-white/10">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/5 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-messenger-accent/20 flex items-center justify-center">
              {isText
                ? <Link size={17} className="text-messenger-accent" />
                : <File size={17} className="text-messenger-accent" />
              }
            </div>
            <div className="min-w-0">
              <p className="text-[15px] font-semibold text-messenger-text truncate max-w-[220px]">
                {sharedFile.name || (isText ? sharedFile.text?.slice(0, 40) + '...' : 'Файл')}
              </p>
              <p className="text-[12px] text-messenger-muted">Выберите чат для отправки</p>
            </div>
          </div>
          <button
            onClick={() => { setIsOpen(false); setSharedFile(null); setSelectedChatId(null); }}
            className="text-messenger-muted hover:text-white p-1.5 rounded-full hover:bg-white/10 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Chat list */}
        <div className="flex-1 overflow-y-auto py-2">
          {chats.length === 0 && (
            <p className="text-center text-messenger-muted text-sm py-8">Нет доступных чатов</p>
          )}
          {chats.map(chat => {
            const isGroup = chat.type === 'group';
            const otherUser = !isGroup && chat.members ? chat.members.find(m => m.id !== currentUser?.id) : null;
            const displayName = isGroup ? chat.name : (otherUser?.display_name || otherUser?.username || 'Неизвестный');
            const selected = selectedChatId === chat.id;

            return (
              <button
                key={chat.id}
                onClick={() => setSelectedChatId(selected ? null : chat.id)}
                className={`w-full flex items-center gap-3 px-4 py-3 transition-colors text-left ${
                  selected ? 'bg-messenger-accent/20' : 'hover:bg-white/5'
                }`}
              >
                <div className={`w-12 h-12 rounded-full flex items-center justify-center shrink-0 font-medium overflow-hidden text-sm ${
                  selected ? 'bg-messenger-accent text-white' : 'bg-primary-500/20 text-primary-300'
                }`}>
                  {!isGroup && otherUser?.avatar_url ? (
                    <img src={otherUser.avatar_url} alt="" className="w-full h-full object-cover" />
                  ) : (
                    displayName?.[0]?.toUpperCase()
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className={`font-medium truncate ${selected ? 'text-messenger-accent' : 'text-messenger-text'}`}>
                    {displayName}
                  </p>
                  {isGroup && <p className="text-xs text-messenger-muted">Группа</p>}
                </div>
                {selected && (
                  <div className="w-5 h-5 rounded-full bg-messenger-accent flex items-center justify-center shrink-0">
                    <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* Send button */}
        <div className="px-4 py-4 border-t border-white/5 shrink-0">
          <button
            onClick={handleSend}
            disabled={!selectedChatId || sending}
            className={`w-full flex items-center justify-center gap-2 py-3.5 rounded-xl text-[15px] font-semibold transition-all ${
              selectedChatId && !sending
                ? 'bg-messenger-accent text-white hover:opacity-90 active:scale-[0.98]'
                : 'bg-white/10 text-messenger-muted cursor-not-allowed'
            }`}
          >
            <Send size={18} />
            {sending ? 'Отправка...' : selectedChatId ? 'Отправить' : 'Выберите чат'}
          </button>
        </div>
      </div>
    </div>
  );
}
