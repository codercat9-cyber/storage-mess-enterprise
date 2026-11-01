import { useState } from 'react';
import type { MockChat } from '@/mock/types';
import mockChats from '@/mock/chats.json';

/**
 * TelegramLayout — Two-Pane Layout (Step 1)
 *
 * Left pane:  Chat list sidebar (fixed 360px, scrollable)
 * Right pane: Active chat area (fluid width)
 *
 * This is a dumb visual shell — no API calls, no encryption.
 * Uses mock JSON data and simple useState for active chat selection.
 */

const chats = mockChats as MockChat[];

/* ── Helpers ─────────────────────────────────────── */

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function avatarLetters(name: string): string {
  return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

/* ── Color pool for avatar backgrounds ───────────── */
const AVATAR_COLORS = [
  'bg-red-500', 'bg-orange-500', 'bg-amber-600',
  'bg-emerald-500', 'bg-cyan-600', 'bg-blue-500',
  'bg-violet-500', 'bg-pink-500',
];

function avatarColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = id.charCodeAt(i) + ((h << 5) - h);
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

/* ═══════════════════════════════════════════════════
   MAIN COMPONENT
   ═══════════════════════════════════════════════════ */

export default function TelegramLayout() {
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const activeChat = chats.find(c => c.id === activeChatId) ?? null;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#17212b] text-white font-sans">

      {/* ── LEFT PANE: Chat list ────────────────── */}
      <aside className="w-[360px] flex-shrink-0 flex flex-col border-r border-[#242f3d] bg-[#17212b]">

        {/* Top bar */}
        <header className="h-[56px] flex items-center gap-3 px-4 border-b border-[#242f3d]">
          <button className="p-1.5 rounded-full hover:bg-[#232e3c] transition-colors">
            <svg viewBox="0 0 24 24" className="w-6 h-6 text-[#aaaaaa]" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          </button>
          <div className="flex-1 relative">
            <input
              type="text"
              placeholder="Поиск"
              className="w-full h-[36px] rounded-full bg-[#242f3d] text-[14px] text-[#cccccc] placeholder-[#707579] pl-10 pr-4 focus:outline-none focus:ring-1 focus:ring-[#3390ec]/50 transition-colors"
            />
            <svg viewBox="0 0 24 24" className="w-[18px] h-[18px] text-[#707579] absolute left-3 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          </div>
        </header>

        {/* Chat list */}
        <nav className="flex-1 overflow-y-auto" role="list">
          {chats.map(chat => {
            const isActive = chat.id === activeChatId;
            return (
              <button
                key={chat.id}
                role="listitem"
                onClick={() => setActiveChatId(chat.id)}
                className={`w-full flex items-center gap-3 px-3 py-2 transition-colors cursor-pointer ${
                  isActive ? 'bg-[#3390ec]' : 'hover:bg-[#232e3c]'
                }`}
              >
                {/* Avatar */}
                <div className={`w-[54px] h-[54px] rounded-full flex items-center justify-center text-white text-[18px] font-medium shrink-0 relative ${avatarColor(chat.user.id)}`}>
                  {avatarLetters(chat.user.name)}
                  {chat.user.online && (
                    <span className="absolute bottom-0 right-0 w-[14px] h-[14px] bg-[#0ac630] border-[2.5px] border-[#17212b] rounded-full" />
                  )}
                </div>

                {/* Text block */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="text-[15px] font-medium truncate">{chat.user.name}</span>
                    <span className={`text-[12px] shrink-0 ml-2 ${
                      chat.unreadCount > 0 && !isActive ? 'text-[#3390ec]' : 'text-[#707579]'
                    }`}>
                      {chat.lastMessage.isOwn && chat.lastMessage.isRead && (
                        <svg viewBox="0 0 16 11" className="w-[16px] h-[11px] inline-block mr-0.5 text-[#4dcd5e]" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><polyline points="1 5 5 9 10 2"/><polyline points="6 5 10 9 15 2"/></svg>
                      )}
                      {formatTime(chat.lastMessage.timestamp)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between mt-0.5">
                    <p className={`text-[14px] truncate ${isActive ? 'text-white/75' : 'text-[#707579]'}`}>
                      {chat.lastMessage.isOwn && <span className={isActive ? 'text-white/90' : 'text-[#3390ec]'}>Вы:&nbsp;</span>}
                      {chat.lastMessage.text}
                    </p>
                    {chat.unreadCount > 0 && !isActive && (
                      <span className="ml-2 shrink-0 w-[22px] h-[22px] rounded-full bg-[#3390ec] text-white text-[12px] font-medium flex items-center justify-center">
                        {chat.unreadCount}
                      </span>
                    )}
                    {chat.isPinned && chat.unreadCount === 0 && (
                      <svg viewBox="0 0 24 24" className="w-[18px] h-[18px] text-[#707579] ml-2 shrink-0 rotate-45" fill="currentColor"><path d="M16 3l-4 4-4-1-3 3 5 5-4 4h2l3-3 5 5 3-3-1-4 4-4z"/></svg>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </nav>
      </aside>

      {/* ── RIGHT PANE: Chat area ──────────────── */}
      <main className="flex-1 flex flex-col min-w-0 bg-[#0e1621]">
        {activeChat ? (
          <>
            {/* Chat header */}
            <header className="h-[56px] flex items-center gap-3 px-5 border-b border-[#242f3d] bg-[#17212b] shrink-0">
              <div className={`w-[42px] h-[42px] rounded-full flex items-center justify-center text-white text-[15px] font-medium shrink-0 ${avatarColor(activeChat.user.id)}`}>
                {avatarLetters(activeChat.user.name)}
              </div>
              <div className="min-w-0">
                <h2 className="text-[16px] font-semibold truncate leading-tight">{activeChat.user.name}</h2>
                <p className="text-[13px] leading-tight mt-0.5">
                  {activeChat.user.online
                    ? <span className="text-[#3390ec]">в сети</span>
                    : <span className="text-[#707579]">был(а) недавно</span>
                  }
                </p>
              </div>
              <div className="ml-auto flex items-center gap-1">
                <button className="p-2 rounded-full hover:bg-[#232e3c] text-[#aaaaaa] transition-colors">
                  <svg viewBox="0 0 24 24" className="w-[22px] h-[22px]" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                </button>
                <button className="p-2 rounded-full hover:bg-[#232e3c] text-[#aaaaaa] transition-colors">
                  <svg viewBox="0 0 24 24" className="w-[22px] h-[22px]" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6A19.79 19.79 0 012.12 4.18 2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>
                </button>
                <button className="p-2 rounded-full hover:bg-[#232e3c] text-[#aaaaaa] transition-colors">
                  <svg viewBox="0 0 24 24" className="w-[22px] h-[22px]" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
                </button>
              </div>
            </header>

            {/* Message area — empty placeholder for now */}
            <div className="flex-1 overflow-y-auto" />

            {/* Input bar */}
            <div className="px-4 pb-4 pt-2 bg-[#17212b] border-t border-[#242f3d] shrink-0">
              <div className="flex items-end gap-2 max-w-[780px] mx-auto">
                <button className="p-2 rounded-full hover:bg-[#232e3c] text-[#aaaaaa] transition-colors shrink-0">
                  <svg viewBox="0 0 24 24" className="w-[24px] h-[24px]" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
                </button>
                <div className="flex-1 min-h-[44px] bg-[#242f3d] rounded-xl flex items-center px-4">
                  <span className="text-[15px] text-[#707579] select-none">Сообщение...</span>
                </div>
                <button className="p-2 rounded-full hover:bg-[#232e3c] text-[#aaaaaa] transition-colors shrink-0">
                  <svg viewBox="0 0 24 24" className="w-[24px] h-[24px]" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
                </button>
              </div>
            </div>
          </>
        ) : (
          /* Empty state */
          <div className="flex-1 flex items-center justify-center">
            <p className="text-[#707579] text-[15px]">Выберите чат, чтобы начать переписку</p>
          </div>
        )}
      </main>
    </div>
  );
}
