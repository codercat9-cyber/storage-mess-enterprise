import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// ═══ Все доступные темы ═══
export type ThemeId = 'light' | 'dark' | 'system' | 'midnight' | 'forest' | 'rose' | 'ocean' | 'sunset' | 'lavender' | 'custom';

export interface ThemeMeta {
  id: ThemeId;
  label: string;
  icon: string;       // emoji
  colorScheme: 'light' | 'dark';
  preview: string;     // hex акцент-цвет для превью
}

export const THEMES: ThemeMeta[] = [
  { id: 'dark',     label: 'Тёмная',           icon: '🌙', colorScheme: 'dark',  preview: '#3b82f6' },
  { id: 'light',    label: 'Светлая',          icon: '☀️', colorScheme: 'light', preview: '#4f7df3' },
  { id: 'midnight', label: 'Полночь',          icon: '🌌', colorScheme: 'dark',  preview: '#6366f1' },
  { id: 'forest',   label: 'Лес',              icon: '🌲', colorScheme: 'dark',  preview: '#34d399' },
  { id: 'ocean',    label: 'Океан',            icon: '🌊', colorScheme: 'dark',  preview: '#22d3ee' },
  { id: 'rose',     label: 'Роза',             icon: '🌹', colorScheme: 'dark',  preview: '#f472b6' },
  { id: 'sunset',   label: 'Закат',            icon: '🌅', colorScheme: 'dark',  preview: '#fb923c' },
  { id: 'lavender', label: 'Лаванда',          icon: '💜', colorScheme: 'light', preview: '#8b5cf6' },
  { id: 'system',   label: 'Системная',        icon: '⚙️', colorScheme: 'dark',  preview: '#94a3b8' },
  { id: 'custom',   label: 'Своя тема',        icon: '🎨', colorScheme: 'dark',  preview: '#f97316' },
];

// ═══ Кастомные CSS-переменные для custom-темы ═══
export interface CustomThemeVars {
  bg: string;
  sidebar: string;
  chat: string;
  input: string;
  hover: string;
  border: string;
  divider: string;
  text: string;
  muted: string;
  accent: string;
  own: string;
  other: string;
  bgOpacity: number;       // 0..1 — прозрачность фона
  sidebarOpacity: number;  // 0..1
  blur: number;            // 0..20 — blur для backdrop
  colorScheme: 'light' | 'dark';
}

export const DEFAULT_CUSTOM: CustomThemeVars = {
  bg:             '#0f172a',
  sidebar:        '#1e293b',
  chat:           '#0f172a',
  input:          '#1e293b',
  hover:          '#334155',
  border:         '#334155',
  divider:        '#2a3548',
  text:           '#f1f5f9',
  muted:          '#94a3b8',
  accent:         '#f97316',
  own:            '#ea580c',
  other:          '#1e293b',
  bgOpacity:      1,
  sidebarOpacity: 1,
  blur:           0,
  colorScheme:    'dark',
};

// ═══ Custom gradient wallpaper config ═══
export interface CustomGradient {
  color1: string;
  color2: string;
  angle: number;       // 0..360
  opacity: number;     // 0..1
  patternId?: string;  // optional overlay pattern from existing wallpapers
}

export const DEFAULT_GRADIENT: CustomGradient = {
  color1: '#0f172a',
  color2: '#1e3a5f',
  angle: 135,
  opacity: 1,
};

// ═══ Размер текста (1..30) ═══
export const FONT_SIZE_MIN = 1;
export const FONT_SIZE_MAX = 30;
export const FONT_SIZE_DEFAULT = 16;

// ═══ Масштаб UI (10..24 px — меняет html font-size / rem) ═══
export const UI_SCALE_MIN = 10;
export const UI_SCALE_MAX = 24;
export const UI_SCALE_DEFAULT = 14;

// ═══ Шрифты ═══

export type FontFamilyId =
  | 'system' | 'roboto' | 'inter' | 'noto' | 'comfortaa' | 'century_gothic' | 'bahanscript'
  | 'gost_a' | 'gost_a_italic' | 'gost_b' | 'gost_b_italic'
  | 'cyberpunk_rus' | 'rajdhani' | 'chakra' | 'orbitron' | 'exo2' | 'russo' | 'play' | 'audiowide' | 'syncopate'
  | 'unifraktur' | 'unifraktur_cook' | 'pirata' | 'ruslan' | 'forum'
  | 'caveat' | 'bad_script' | 'marck' | 'pacifico' | 'lobster'
  | 'montserrat' | 'opensans' | 'ptsans' | 'ptserif' | 'ubuntu' | 'firasans' | 'oswald' | 'rubik' | 'jura' | 'sourcecode'
  | 'tinos' | 'arimo' | 'cousine' | 'garamond' | 'gelasio' | 'lora' | 'merriweather' | 'crimson' | 'baskerville' | 'alegreya' | 'comicneue' | 'anton'
  | 'courierprime' | 'specialelite' | 'cutivemono' | 'xanhmono' | 'synemono'
  | 'jetbrains' | 'plexmono' | 'robotomono' | 'spacemono' | 'inconsolata' | 'anonymouspro' | 'ubuntumono' | 'firacode'
  | 'raleway' | 'nunito' | 'manrope' | 'cormorant' | 'literata' | 'spectral' | 'vollkorn' | 'cuprum' | 'yeseva';

/** Раздел списка шрифтов — по ним панель складывается в группы. */
export type FontGroupId = 'base' | 'gost' | 'cyber' | 'gothic' | 'hand' | 'office' | 'type' | 'mono';

export const FONT_GROUPS: { id: FontGroupId; label: string }[] = [
  { id: 'base',   label: 'Обычные' },
  { id: 'gost',   label: 'ГОСТ (чертёжные)' },
  { id: 'cyber',  label: 'Киберпанк и техно' },
  { id: 'gothic', label: 'Готические' },
  { id: 'hand',   label: 'Рукописные' },
  { id: 'office', label: 'Как в редакторе' },
  { id: 'type',   label: 'Машинописные' },
  { id: 'mono',   label: 'Моноширинные' },
];

/**
 * Список шрифтов.
 *
 * `cyrillic: false` — у шрифта нет русских букв, и текст на русском
 * покажется системным. Это не поломка, а свойство шрифта: готические и
 * часть техно-шрифтов рисовались только под латиницу. Помечаем честно,
 * чтобы человек не выбирал вслепую и не думал, что выбор не сработал.
 */
export const FONT_FAMILIES: {
  id: FontFamilyId; label: string; value: string; group: FontGroupId; cyrillic?: boolean;
}[] = [
  // ── Обычные ──
  { id: 'system',         label: 'Системный',       value: 'system-ui, -apple-system, sans-serif', group: 'base', cyrillic: true },
  { id: 'roboto',         label: 'Roboto',          value: '"Roboto", sans-serif',            group: 'base', cyrillic: true },
  { id: 'inter',          label: 'Inter',           value: '"Inter", sans-serif',             group: 'base', cyrillic: true },
  { id: 'noto',           label: 'Noto Sans',       value: '"Noto Sans", sans-serif',         group: 'base', cyrillic: true },
  { id: 'montserrat',     label: 'Montserrat',      value: '"Montserrat", sans-serif',        group: 'base', cyrillic: true },
  { id: 'opensans',       label: 'Open Sans',       value: '"Open Sans", sans-serif',         group: 'base', cyrillic: true },
  { id: 'ptsans',         label: 'PT Sans',         value: '"PT Sans", sans-serif',           group: 'base', cyrillic: true },
  { id: 'ptserif',        label: 'PT Serif',        value: '"PT Serif", serif',               group: 'base', cyrillic: true },
  { id: 'ubuntu',         label: 'Ubuntu',          value: '"Ubuntu", sans-serif',            group: 'base', cyrillic: true },
  { id: 'firasans',       label: 'Fira Sans',       value: '"Fira Sans", sans-serif',         group: 'base', cyrillic: true },
  { id: 'oswald',         label: 'Oswald',          value: '"Oswald", sans-serif',            group: 'base', cyrillic: true },
  { id: 'rubik',          label: 'Rubik',           value: '"Rubik", sans-serif',             group: 'base', cyrillic: true },
  { id: 'comfortaa',      label: 'Comfortaa',       value: '"Comfortaa", cursive',            group: 'base', cyrillic: true },
  { id: 'century_gothic', label: 'Century Gothic',  value: '"Century Gothic", sans-serif',    group: 'base' },

  // ── ГОСТ 2.304-81: тип А и тип Б, прямой и наклонный ──
  { id: 'gost_a',         label: 'ГОСТ тип А',            value: '"GOST Type A", sans-serif', group: 'gost', cyrillic: true },
  { id: 'gost_a_italic',  label: 'ГОСТ тип А наклонный',  value: '"GOST Type A", sans-serif', group: 'gost', cyrillic: true },
  { id: 'gost_b',         label: 'ГОСТ тип Б',            value: '"GOST Type B", sans-serif', group: 'gost', cyrillic: true },
  { id: 'gost_b_italic',  label: 'ГОСТ тип Б наклонный',  value: '"GOST Type B", sans-serif', group: 'gost', cyrillic: true },

  // ── Киберпанк и техно ──
  // Rajdhani — тот самый шрифт интерфейса Cyberpunk 2077, он открытый.
  // Русских букв в нём нет, поэтому рядом Exo 2 и Russo One — тот же
  // угловатый техно-вид, но с кириллицей.
  // Любительская кириллизация в стиле игры — с полным русским алфавитом,
  // поэтому стоит первой: остальные техно-шрифты либо без кириллицы, либо
  // не такие узнаваемые.
  { id: 'cyberpunk_rus',  label: 'Cyberpunk (рус)', value: '"Cyberpunk RUS", sans-serif',     group: 'cyber', cyrillic: true },
  { id: 'rajdhani',       label: 'Rajdhani',        value: '"Rajdhani", sans-serif',          group: 'cyber' },
  { id: 'chakra',         label: 'Chakra Petch',    value: '"Chakra Petch", sans-serif',      group: 'cyber' },
  { id: 'orbitron',       label: 'Orbitron',        value: '"Orbitron", sans-serif',          group: 'cyber' },
  { id: 'audiowide',      label: 'Audiowide',       value: '"Audiowide", sans-serif',         group: 'cyber' },
  { id: 'syncopate',      label: 'Syncopate',       value: '"Syncopate", sans-serif',         group: 'cyber' },
  { id: 'exo2',           label: 'Exo 2',           value: '"Exo 2", sans-serif',             group: 'cyber', cyrillic: true },
  { id: 'russo',          label: 'Russo One',       value: '"Russo One", sans-serif',         group: 'cyber', cyrillic: true },
  { id: 'play',           label: 'Play',            value: '"Play", sans-serif',              group: 'cyber', cyrillic: true },
  { id: 'jura',           label: 'Jura',            value: '"Jura", sans-serif',              group: 'cyber', cyrillic: true },

  // ── Готические ──
  { id: 'unifraktur',      label: 'Unifraktur Maguntia', value: '"Unifraktur Maguntia", cursive', group: 'gothic' },
  { id: 'unifraktur_cook', label: 'Unifraktur Cook',     value: '"Unifraktur Cook", cursive',     group: 'gothic' },
  { id: 'pirata',          label: 'Pirata One',          value: '"Pirata One", cursive',          group: 'gothic' },
  { id: 'ruslan',          label: 'Руслан (славянский)', value: '"Руслан", cursive',              group: 'gothic', cyrillic: true },
  { id: 'forum',           label: 'Forum (антиква)',     value: '"Forum", serif',                 group: 'gothic', cyrillic: true },

  // ── Рукописные ──
  { id: 'caveat',         label: 'Caveat',          value: '"Caveat", cursive',               group: 'hand', cyrillic: true },
  { id: 'bad_script',     label: 'Bad Script',      value: '"Bad Script", cursive',           group: 'hand', cyrillic: true },
  { id: 'marck',          label: 'Marck Script',    value: '"Marck Script", cursive',         group: 'hand', cyrillic: true },
  { id: 'pacifico',       label: 'Pacifico',        value: '"Pacifico", cursive',             group: 'hand', cyrillic: true },
  { id: 'lobster',        label: 'Lobster',         value: '"Lobster", cursive',              group: 'hand', cyrillic: true },
  { id: 'bahanscript',    label: 'Bahanscript',     value: '"Bahanscript", cursive',          group: 'hand' },

  // ── Моноширинные ──
  { id: 'sourcecode',     label: 'Source Code Pro', value: '"Source Code Pro", monospace',    group: 'mono', cyrillic: true },

  // ── Как в редакторе ──
  // Оригиналы Times New Roman, Arial и Courier New принадлежат Monotype и
  // в сборку не годятся. Эти — их метрические двойники от Google под
  // Apache-лицензией: те же ширины букв и та же длина строки, текст
  // выглядит и верстается одинаково.
  { id: 'tinos',        label: 'Times New Roman',   value: '"Times (Tinos)", serif',        group: 'office', cyrillic: true },
  { id: 'arimo',        label: 'Arial',             value: '"Arial (Arimo)", sans-serif',   group: 'office', cyrillic: true },
  { id: 'cousine',      label: 'Courier New',       value: '"Courier New (Cousine)", monospace', group: 'office', cyrillic: true },
  { id: 'gelasio',      label: 'Georgia',           value: '"Georgia (Gelasio)", serif',    group: 'office' },
  { id: 'garamond',     label: 'Garamond',          value: '"Garamond", serif',             group: 'office', cyrillic: true },
  { id: 'lora',         label: 'Lora',              value: '"Lora", serif',                 group: 'office', cyrillic: true },
  { id: 'merriweather', label: 'Merriweather',      value: '"Merriweather", serif',         group: 'office', cyrillic: true },
  { id: 'crimson',      label: 'Crimson Text',      value: '"Crimson Text", serif',         group: 'office' },
  { id: 'baskerville',  label: 'Libre Baskerville', value: '"Libre Baskerville", serif',    group: 'office' },
  { id: 'alegreya',     label: 'Alegreya',          value: '"Alegreya", serif',             group: 'office', cyrillic: true },
  { id: 'comicneue',    label: 'Comic Neue',        value: '"Comic Neue", cursive',         group: 'office' },
  { id: 'anton',        label: 'Anton (как Impact)', value: '"Anton (как Impact)", sans-serif', group: 'office' },

  // ── Машинописные ──
  { id: 'courierprime', label: 'Courier Prime',   value: '"Courier Prime", monospace',    group: 'type' },
  { id: 'specialelite', label: 'Special Elite',   value: '"Special Elite", cursive',      group: 'type' },
  { id: 'cutivemono',   label: 'Cutive Mono',     value: '"Cutive Mono", monospace',      group: 'type' },
  { id: 'xanhmono',     label: 'Xanh Mono',       value: '"Xanh Mono", monospace',        group: 'type' },
  { id: 'synemono',     label: 'Syne Mono',       value: '"Syne Mono", monospace',        group: 'type' },

  // ── Моноширинные ──
  { id: 'jetbrains',    label: 'JetBrains Mono',  value: '"JetBrains Mono", monospace',   group: 'mono', cyrillic: true },
  { id: 'plexmono',     label: 'IBM Plex Mono',   value: '"IBM Plex Mono", monospace',    group: 'mono', cyrillic: true },
  { id: 'robotomono',   label: 'Roboto Mono',     value: '"Roboto Mono", monospace',      group: 'mono', cyrillic: true },
  { id: 'ubuntumono',   label: 'Ubuntu Mono',     value: '"Ubuntu Mono", monospace',      group: 'mono', cyrillic: true },
  { id: 'firacode',     label: 'Fira Code',       value: '"Fira Code", monospace',        group: 'mono', cyrillic: true },
  { id: 'anonymouspro', label: 'Anonymous Pro',   value: '"Anonymous Pro", monospace',    group: 'mono', cyrillic: true },
  { id: 'spacemono',    label: 'Space Mono',      value: '"Space Mono", monospace',       group: 'mono' },
  { id: 'inconsolata',  label: 'Inconsolata',     value: '"Inconsolata", monospace',      group: 'mono' },

  // ── Ещё обычные ──
  { id: 'raleway',      label: 'Raleway',         value: '"Raleway", sans-serif',         group: 'base', cyrillic: true },
  { id: 'nunito',       label: 'Nunito',          value: '"Nunito", sans-serif',          group: 'base', cyrillic: true },
  { id: 'manrope',      label: 'Manrope',         value: '"Manrope", sans-serif',         group: 'base', cyrillic: true },
  { id: 'cormorant',    label: 'Cormorant',       value: '"Cormorant", serif',            group: 'base', cyrillic: true },
  { id: 'literata',     label: 'Literata',        value: '"Literata", serif',             group: 'base', cyrillic: true },
  { id: 'spectral',     label: 'Spectral',        value: '"Spectral", serif',             group: 'base', cyrillic: true },
  { id: 'vollkorn',     label: 'Vollkorn',        value: '"Vollkorn", serif',             group: 'base', cyrillic: true },
  { id: 'cuprum',       label: 'Cuprum',          value: '"Cuprum", sans-serif',          group: 'base', cyrillic: true },
  { id: 'yeseva',       label: 'Yeseva One',      value: '"Yeseva One", serif',           group: 'base', cyrillic: true },
];

// ═══ Store ═══
interface ThemeState {
  theme: ThemeId;
  resolvedTheme: 'light' | 'dark';
  customVars: CustomThemeVars;
  wallpaper: string;
  customGradient: CustomGradient;
  customImage: string;  // base64 data URL
  imageOpacity: number;  // 0..1
  fontSize: number;
  fontFamily: FontFamilyId;
  uiScale: number;  // Масштаб UI (html font-size в px)
  forceTcpRelay: boolean; // Форсировать TCP (Обход ТСПУ)
  // Когда настройки последний раз менялись НА ЭТОМ устройстве (мс).
  // Нужен, чтобы отличить свежий локальный выбор от устаревшего эха
  // с сервера. Без него любая запись настроек возвращала тему назад.
  settingsUpdatedAt: number;
  setTheme: (theme: ThemeId) => void;
  setCustomVar: <K extends keyof CustomThemeVars>(key: K, value: CustomThemeVars[K]) => void;
  setCustomVars: (vars: Partial<CustomThemeVars>) => void;
  setWallpaper: (id: string) => void;
  setCustomGradient: (g: Partial<CustomGradient>) => void;
  setCustomImage: (dataUrl: string) => void;
  setImageOpacity: (opacity: number) => void;
  setFontSize: (size: number) => void;
  setFontFamily: (family: FontFamilyId) => void;
  setUiScale: (scale: number) => void;
  setForceTcpRelay: (force: boolean) => void;
}

function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getResolvedColorScheme(theme: ThemeId, customVars: CustomThemeVars): 'light' | 'dark' {
  if (theme === 'system') return getSystemTheme();
  if (theme === 'custom') return customVars.colorScheme;
  const meta = THEMES.find(t => t.id === theme);
  return meta?.colorScheme ?? 'dark';
}

function applyFontSettings(fontSize: number, fontFamily: FontFamilyId) {
  const root = document.documentElement;
  const size = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, fontSize || FONT_SIZE_DEFAULT));
  const familyObj = FONT_FAMILIES.find(f => f.id === fontFamily) || FONT_FAMILIES[0];
  // CSS-переменные для сообщений — НЕ меняем root fontSize (это ломает Tailwind rem)
  root.style.setProperty('--msg-font-size', `${size}px`);
  root.style.setProperty('--msg-font-family', familyObj.value);
  // Наклонные начертания ГОСТ.
  //
  // По ГОСТ 2.304-81 и тип А, и тип Б бывают прямыми и наклонными — это
  // разные начертания одного стандарта, а не украшение. Отдельных файлов
  // под наклон у нас нет, поэтому наклон делает браузер.
  const slanted = fontFamily === 'gost_b_italic' || fontFamily === 'gost_a_italic';
  root.style.setProperty('--msg-font-style', slanted ? 'italic' : 'normal');
}

function applyUiScale(scale: number) {
  const root = document.documentElement;
  const s = Math.max(UI_SCALE_MIN, Math.min(UI_SCALE_MAX, scale || UI_SCALE_DEFAULT));
  root.style.fontSize = `${s}px`;
}

function applyThemeToDOM(theme: ThemeId, customVars: CustomThemeVars) {
  const root = document.documentElement;

  // Убираем все классы тем
  root.classList.remove('light', 'dark');
  root.removeAttribute('data-theme');

  if (theme === 'system') {
    const resolved = getSystemTheme();
    root.classList.add(resolved);
    root.setAttribute('data-theme', resolved);
  } else if (theme === 'custom') {
    root.setAttribute('data-theme', 'custom');
    root.classList.add(customVars.colorScheme);
    _applyCustomVars(customVars);
  } else {
    root.setAttribute('data-theme', theme);
    root.classList.add(getResolvedColorScheme(theme, customVars));
  }
}

function _applyCustomVars(vars: CustomThemeVars) {
  const root = document.documentElement;
  const bgWithAlpha = _hexToRgba(vars.bg, vars.bgOpacity);
  const sidebarWithAlpha = _hexToRgba(vars.sidebar, vars.sidebarOpacity);

  root.style.setProperty('--msg-bg', bgWithAlpha);
  root.style.setProperty('--msg-sidebar', sidebarWithAlpha);
  root.style.setProperty('--msg-chat', vars.chat);
  root.style.setProperty('--msg-input', vars.input);
  root.style.setProperty('--msg-hover', vars.hover);
  root.style.setProperty('--msg-border', vars.border);
  root.style.setProperty('--msg-divider', vars.divider);
  root.style.setProperty('--msg-text', vars.text);
  root.style.setProperty('--msg-muted', vars.muted);
  root.style.setProperty('--msg-accent', vars.accent);
  root.style.setProperty('--msg-own', vars.own);
  root.style.setProperty('--msg-other', vars.other);

  if (vars.blur > 0) {
    root.style.setProperty('--msg-blur', `${vars.blur}px`);
  } else {
    root.style.removeProperty('--msg-blur');
  }
}

function _clearCustomVars() {
  const root = document.documentElement;
  const props = ['--msg-bg','--msg-sidebar','--msg-chat','--msg-input','--msg-hover',
    '--msg-border','--msg-divider','--msg-text','--msg-muted','--msg-accent','--msg-own','--msg-other','--msg-blur'];
  props.forEach(p => root.style.removeProperty(p));
}

function _hexToRgba(hex: string, alpha: number): string {
  if (alpha >= 1) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: 'dark' as ThemeId,
      resolvedTheme: 'dark' as 'light' | 'dark',
      customVars: { ...DEFAULT_CUSTOM },
      wallpaper: 'default',
      customGradient: { ...DEFAULT_GRADIENT },
      customImage: '',
      imageOpacity: 1,
      fontSize: FONT_SIZE_DEFAULT as number,
      fontFamily: 'system' as FontFamilyId,
      uiScale: UI_SCALE_DEFAULT as number,
      forceTcpRelay: false,
      settingsUpdatedAt: 0,

      setUiScale: (scale: number) => {
        const clamped = Math.max(UI_SCALE_MIN, Math.min(UI_SCALE_MAX, scale));
        applyUiScale(clamped);
        set({ uiScale: clamped });
        // Дублируем в отдельный ключ — гарантия сохранения для inline-скрипта
        try { localStorage.setItem('ui-scale', String(clamped)); } catch {}
      },

      setForceTcpRelay: (force: boolean) => set({ forceTcpRelay: force }),

      setFontSize: (size: number) => {
        const clamped = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, size));
        applyFontSettings(clamped, get().fontFamily);
        set({ fontSize: clamped });
      },

      setFontFamily: (family: FontFamilyId) => {
        applyFontSettings(get().fontSize, family);
        set({ fontFamily: family });
      },

      setTheme: (theme: ThemeId) => {
        const { customVars } = get();
        if (theme !== 'custom') _clearCustomVars();
        applyThemeToDOM(theme, customVars);
        const resolved = getResolvedColorScheme(theme, customVars);
        set({ theme, resolvedTheme: resolved });
      },

      setCustomVar: (key, value) => {
        const newVars = { ...get().customVars, [key]: value };
        set({ customVars: newVars });
        if (get().theme === 'custom') {
          _applyCustomVars(newVars);
          set({ resolvedTheme: newVars.colorScheme });
        }
      },

      setCustomVars: (vars) => {
        const newVars = { ...get().customVars, ...vars };
        set({ customVars: newVars });
        if (get().theme === 'custom') {
          _applyCustomVars(newVars);
          set({ resolvedTheme: newVars.colorScheme });
        }
      },

      setWallpaper: (id: string) => {
        set({ wallpaper: id });
      },

      setCustomGradient: (g) => {
        const newGradient = { ...get().customGradient, ...g };
        set({ customGradient: newGradient });
      },

      setCustomImage: (dataUrl: string) => {
        set({ customImage: dataUrl });
      },

      setImageOpacity: (opacity: number) => {
        set({ imageOpacity: opacity });
      },
    }),
    {
      name: 'messenger-theme',
      merge: (persisted: any, current: any) => ({
        ...current,
        ...persisted,
        // Гарантируем дефолты для новых полей, которых может не быть в старом localStorage
        uiScale: typeof persisted?.uiScale === 'number' ? persisted.uiScale : current.uiScale,
        forceTcpRelay: typeof persisted?.forceTcpRelay === 'boolean' ? persisted.forceTcpRelay : current.forceTcpRelay,
        fontSize: typeof persisted?.fontSize === 'number' ? persisted.fontSize : current.fontSize,
        fontFamily: persisted?.fontFamily || current.fontFamily,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          const resolved = getResolvedColorScheme(state.theme, state.customVars || DEFAULT_CUSTOM);
          applyThemeToDOM(state.theme, state.customVars || DEFAULT_CUSTOM);
          applyFontSettings(typeof state.fontSize === 'number' ? state.fontSize : FONT_SIZE_DEFAULT, state.fontFamily || 'system');
          // uiScale: сначала из отдельного ключа, потом из store
          let scale = UI_SCALE_DEFAULT;
          try {
            const direct = localStorage.getItem('ui-scale');
            if (direct) { const v = parseInt(direct, 10); if (v >= UI_SCALE_MIN && v <= UI_SCALE_MAX) scale = v; }
          } catch {}
          if (typeof state.uiScale === 'number' && state.uiScale >= UI_SCALE_MIN && state.uiScale <= UI_SCALE_MAX) {
            scale = state.uiScale;
          }
          applyUiScale(scale);
          state.uiScale = scale;
          state.resolvedTheme = resolved;
        }
      },
    }
  )
);

// Listen for system theme changes
if (typeof window !== 'undefined') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const store = useThemeStore.getState();
    if (store.theme === 'system') {
      const resolved = getSystemTheme();
      applyThemeToDOM('system', store.customVars);
      useThemeStore.setState({ resolvedTheme: resolved });
    }
  });
}

// ═══════════════════════════════════════════════════════════════════
//  Применение настроек, пришедших с сервера
//
//  Единственная точка входа для удалённых настроек — и при старте
//  приложения, и при событии user:settings_updated по сокету.
//  Раньше эта логика была продублирована в App.tsx и socket.ts, и в
//  копии из socket.ts вызывался несуществующий setChatWallpaper,
//  который валил обработчик исключением на середине.
//
//  Применяем только если удалённая копия НОВЕЕ локальной. Иначе любая
//  запись настроек (например, переключение звука) заставляла сервер
//  разослать всю строку настроек вместе с ещё не обновлённым
//  settings_json — и тема откатывалась к предыдущей.
// ═══════════════════════════════════════════════════════════════════
// Было ли на этом устройстве что-то сохранено до запуска. Считывается
// один раз на этапе загрузки модуля — позже persist уже успевает
// записать состояние, и отличить свежую установку станет невозможно.
const hadLocalSettingsAtBoot = (() => {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem('messenger-theme') !== null;
  } catch {
    return false;
  }
})();

export function applyRemoteSettings(raw: string | null | undefined): boolean {
  if (!raw) return false;

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object') return false;

  const store = useThemeStore.getState();
  const remoteAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0;

  // Свежая установка или новый браузер: локального выбора нет вообще,
  // поэтому серверную копию принимаем даже без метки времени — иначе
  // пользователь на новом устройстве получит тему по умолчанию вместо
  // своей. Записи без updatedAt остались от прежней версии клиента.
  const isFirstRunHere = !hadLocalSettingsAtBoot && store.settingsUpdatedAt === 0;

  // Иначе применяем только то, что новее локального выбора. Без этой
  // проверки любая запись настроек заставляла сервер разослать всю
  // строку вместе с ещё не обновлённым settings_json, и тема
  // откатывалась к предыдущей.
  if (!isFirstRunHere && remoteAt <= store.settingsUpdatedAt) return false;

  if (parsed.customVars)     store.setCustomVars(parsed.customVars);
  if (parsed.theme)          store.setTheme(parsed.theme);
  if (parsed.wallpaper)      store.setWallpaper(parsed.wallpaper);
  if (parsed.customGradient) store.setCustomGradient(parsed.customGradient);
  if (typeof parsed.fontSize === 'number') store.setFontSize(parsed.fontSize);
  if (parsed.fontFamily)     store.setFontFamily(parsed.fontFamily);
  if (typeof parsed.uiScale === 'number')  store.setUiScale(parsed.uiScale);
  if (typeof parsed.forceTcpRelay === 'boolean') store.setForceTcpRelay(parsed.forceTcpRelay);

  // Отмечаем принятое время как своё, иначе следующее эхо той же
  // записи применится повторно.
  useThemeStore.setState({ settingsUpdatedAt: remoteAt });
  return true;
}

// Automatically sync theme settings to server
if (typeof window !== 'undefined') {
  let syncTimer: any = null;
  let pendingPush: (() => void) | null = null;

  const flushNow = () => {
    if (!pendingPush) return;
    clearTimeout(syncTimer);
    const push = pendingPush;
    pendingPush = null;
    push();
  };

  // Приложение на мобильном закрывают сразу после выбора темы, поэтому
  // отложенная отправка регулярно терялась и на сервере оставалась
  // прежняя тема. Досылаем при уходе страницы в фон.
  window.addEventListener('pagehide', flushNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushNow();
  });

  useThemeStore.subscribe((state, prevState) => {
    // Only sync if actual UI settings changed
    if (
      state.theme !== prevState.theme ||
      state.customVars !== prevState.customVars ||
      state.wallpaper !== prevState.wallpaper ||
      state.customGradient !== prevState.customGradient ||
      state.fontSize !== prevState.fontSize ||
      state.fontFamily !== prevState.fontFamily ||
      state.uiScale !== prevState.uiScale ||
      state.forceTcpRelay !== prevState.forceTcpRelay
    ) {
      const updatedAt = Date.now();
      // Метка ставится сразу, а не в момент отправки: эхо чужой записи,
      // пришедшее пока наша отправка в очереди, не должно применяться.
      useThemeStore.setState({ settingsUpdatedAt: updatedAt });

      pendingPush = () => {
        void (async () => {
          try {
            const { userApi } = await import('@/lib/api');
            const s = useThemeStore.getState();
            const settingsToSave = {
              theme: s.theme,
              customVars: s.customVars,
              wallpaper: s.wallpaper,
              customGradient: s.customGradient,
              fontSize: s.fontSize,
              fontFamily: s.fontFamily,
              uiScale: s.uiScale,
              forceTcpRelay: s.forceTcpRelay,
              updatedAt,
            };
            userApi.updateSettings({
              settings_json: JSON.stringify(settingsToSave)
            }).catch(() => {});
          } catch (e) {}
        })();
      };

      clearTimeout(syncTimer);
      // 700 мс вместо 2 с: достаточно, чтобы склеить движение слайдера,
      // и заметно меньше шансов не успеть до закрытия приложения.
      syncTimer = setTimeout(flushNow, 700);
    }
  });
}

export default useThemeStore;
