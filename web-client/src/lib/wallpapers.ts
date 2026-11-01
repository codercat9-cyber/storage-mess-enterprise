// Коллекция Telegram-style обоев для чата
// Каждый обой — inline SVG data URI, которая тайлится как фон

export interface WallpaperDef {
  id: string;
  name: string;
  emoji: string;
  darkBg: string;      // фон для тёмной темы
  lightBg: string;     // фон для светлой темы
  patternSvg: string;  // SVG data URI (tile-able)
  patternOpacity: number;
  group: 'none' | 'nature' | 'holiday' | 'abstract' | 'animals';
}

// ═══════════════════════════════════════════════════════
//  SVG pattern generators (encoded for CSS background)
// ═══════════════════════════════════════════════════════

function svgUri(svg: string): string {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function _hexWithAlpha(hex: string, alpha: number): string {
  if (alpha >= 1) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// 🌲 Ёлочки
const treesSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80"><g fill="currentColor" opacity="0.12"><polygon points="20,10 12,26 28,26"/><polygon points="20,18 10,34 30,34"/><rect x="18" y="34" width="4" height="5"/><polygon points="60,30 52,46 68,46"/><polygon points="60,38 50,54 70,54"/><rect x="58" y="54" width="4" height="5"/></g></svg>`;

// 🐧 Пингвинчики
const penguinsSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><g opacity="0.12"><ellipse cx="25" cy="38" rx="12" ry="16" fill="currentColor"/><ellipse cx="25" cy="38" rx="7" ry="12" fill="none" stroke="currentColor" stroke-width="1"/><circle cx="22" cy="33" r="1.5" fill="currentColor"/><circle cx="28" cy="33" r="1.5" fill="currentColor"/><polygon points="25,37 23,40 27,40" fill="currentColor"/><ellipse cx="75" cy="68" rx="12" ry="16" fill="currentColor"/><ellipse cx="75" cy="68" rx="7" ry="12" fill="none" stroke="currentColor" stroke-width="1"/><circle cx="72" cy="63" r="1.5" fill="currentColor"/><circle cx="78" cy="63" r="1.5" fill="currentColor"/><polygon points="75,67 73,70 77,70" fill="currentColor"/></g></svg>`;

// ❄️ Снежинки
const snowflakesSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80"><g fill="none" stroke="currentColor" stroke-width="1" opacity="0.1"><g transform="translate(20,20)"><line x1="0" y1="-10" x2="0" y2="10"/><line x1="-8.66" y1="-5" x2="8.66" y2="5"/><line x1="-8.66" y1="5" x2="8.66" y2="-5"/><line x1="0" y1="-10" x2="-3" y2="-7"/><line x1="0" y1="-10" x2="3" y2="-7"/><line x1="0" y1="10" x2="-3" y2="7"/><line x1="0" y1="10" x2="3" y2="7"/></g><g transform="translate(60,60)"><line x1="0" y1="-8" x2="0" y2="8"/><line x1="-6.93" y1="-4" x2="6.93" y2="4"/><line x1="-6.93" y1="4" x2="6.93" y2="-4"/><line x1="0" y1="-8" x2="-2" y2="-6"/><line x1="0" y1="-8" x2="2" y2="-6"/></g></g></svg>`;

// 💕 Сердечки
const heartsSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80"><g fill="currentColor" opacity="0.08"><path d="M20 28c0-4-3.5-7-7-7s-7 4-7 7c0 8 14 16 14 16s14-8 14-16c0-4-3.5-7-7-7s-7 4-7 7z" transform="translate(7,5) scale(0.6)"/><path d="M20 28c0-4-3.5-7-7-7s-7 4-7 7c0 8 14 16 14 16s14-8 14-16c0-4-3.5-7-7-7s-7 4-7 7z" transform="translate(47,42) scale(0.5)"/></g></svg>`;

// ⭐ Звёзды
const starsSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="90" height="90" viewBox="0 0 90 90"><g fill="currentColor" opacity="0.08"><polygon points="20,5 23,15 33,15 25,21 28,31 20,25 12,31 15,21 7,15 17,15"/><polygon points="65,45 67,51 73,51 68,55 70,61 65,57 60,61 62,55 57,51 63,51"/><circle cx="45" cy="20" r="2"/><circle cx="10" cy="60" r="1.5"/><circle cx="80" cy="80" r="1"/></g></svg>`;

// 🌸 Цветочки
const flowersSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80"><g fill="currentColor" opacity="0.09"><g transform="translate(20,20)"><circle cx="0" cy="-6" r="4"/><circle cx="5.7" cy="-1.85" r="4"/><circle cx="3.5" cy="4.85" r="4"/><circle cx="-3.5" cy="4.85" r="4"/><circle cx="-5.7" cy="-1.85" r="4"/><circle cx="0" cy="0" r="3"/></g><g transform="translate(60,60)"><circle cx="0" cy="-5" r="3"/><circle cx="4.75" cy="-1.55" r="3"/><circle cx="2.94" cy="4.04" r="3"/><circle cx="-2.94" cy="4.04" r="3"/><circle cx="-4.75" cy="-1.55" r="3"/><circle cx="0" cy="0" r="2.5"/></g></g></svg>`;

// 🐱 Котики
const catsSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><g fill="currentColor" opacity="0.1"><g transform="translate(25,30)"><ellipse cx="0" cy="5" rx="10" ry="12"/><circle cx="0" cy="-8" r="8"/><polygon points="-8,-14 -6,-4 -2,-8"/><polygon points="8,-14 6,-4 2,-8"/><circle cx="-3" cy="-10" r="1.5"/><circle cx="3" cy="-10" r="1.5"/><ellipse cx="0" cy="-7" rx="1" ry="0.7"/><path d="M-2,-6 Q0,-4 2,-6" fill="none" stroke="currentColor" stroke-width="0.7"/></g><g transform="translate(72,70)"><ellipse cx="0" cy="4" rx="8" ry="10"/><circle cx="0" cy="-6" r="6.5"/><polygon points="-6.5,-11 -5,-3 -1.5,-6.5"/><polygon points="6.5,-11 5,-3 1.5,-6.5"/><circle cx="-2.5" cy="-8" r="1.2"/><circle cx="2.5" cy="-8" r="1.2"/></g></g></svg>`;

// 🔷 Геометрия
const geometrySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80"><g fill="none" stroke="currentColor" stroke-width="1" opacity="0.07"><rect x="5" y="5" width="18" height="18" rx="2" transform="rotate(15,14,14)"/><circle cx="60" cy="25" r="10"/><polygon points="40,55 50,75 30,75"/><line x1="55" y1="55" x2="75" y2="75"/><line x1="55" y1="75" x2="75" y2="55"/></g></svg>`;

// 🌊 Волны
const wavesSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40" viewBox="0 0 120 40"><g fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.06"><path d="M0 20 Q15 5, 30 20 T60 20 T90 20 T120 20"/><path d="M0 30 Q15 15, 30 30 T60 30 T90 30 T120 30"/></g></svg>`;

// 🎄 Новогодняя
const christmasSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><g opacity="0.1"><polygon fill="currentColor" points="25,12 17,28 33,28"/><polygon fill="currentColor" points="25,20 14,36 36,36"/><polygon fill="currentColor" points="25,28 11,44 39,44"/><rect fill="currentColor" x="23" y="44" width="4" height="6"/><circle fill="currentColor" cx="25" cy="10" r="2.5"/><circle fill="currentColor" cx="70" cy="55" r="6"/><circle fill="none" stroke="currentColor" stroke-width="1" cx="70" cy="55" r="9"/><line stroke="currentColor" stroke-width="1" x1="70" y1="46" x2="70" y2="43"/><circle fill="currentColor" cx="70" cy="42" r="1.5"/><polygon fill="currentColor" points="18,80 22,76 26,80 22,84"/><polygon fill="currentColor" points="60,85 64,81 68,85 64,89"/><polygon fill="currentColor" points="82,25 86,21 90,25 86,29"/></g></svg>`;

// 🎮 Гейм
const gamingSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80" viewBox="0 0 100 80"><g fill="currentColor" opacity="0.08"><rect x="12" y="20" width="10" height="10" rx="2"/><rect x="12" y="35" width="10" height="10" rx="2"/><rect x="12" y="50" width="10" height="10" rx="2"/><circle cx="55" cy="30" r="8"/><circle cx="55" cy="30" r="3"/><polygon points="80,15 85,25 90,15"/><rect x="78" y="25" width="14" height="3" rx="1"/><rect x="78" y="50" width="14" height="18" rx="2"/><rect x="80" y="52" width="10" height="10" rx="1"/></g></svg>`;

// ✨ Блёстки
const sparklesSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80"><g fill="currentColor" opacity="0.1"><path d="M20 10 L22 18 L20 26 L18 18 Z"/><path d="M14 18 L18 20 L26 18 L18 16 Z" transform="rotate(0,20,18)"/><path d="M55 50 L56.5 55 L55 60 L53.5 55 Z"/><path d="M50 55 L55 53.5 L60 55 L55 56.5 Z"/><circle cx="40" cy="35" r="1"/><circle cx="68" cy="15" r="0.8"/><circle cx="12" cy="65" r="1.2"/><circle cx="72" cy="72" r="0.6"/></g></svg>`;

// Без фона
const noneSvg = '';

// ═══════════════════════════════════════════════════════
//  Коллекция обоев
// ═══════════════════════════════════════════════════════

export const WALLPAPERS: WallpaperDef[] = [
  {
    id: 'none',
    name: 'Без фона',
    emoji: '⬛',
    darkBg: '#0f0f0f',
    lightBg: '#e8e8e8',
    patternSvg: noneSvg,
    patternOpacity: 0,
    group: 'none',
  },
  {
    id: 'default',
    name: 'Стандарт',
    emoji: '✚',
    darkBg: '#0e1621',
    lightBg: '#dfe8ef',
    patternSvg: svgUri(`<svg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'><g fill='none' fill-rule='evenodd'><g fill='%23888888' fill-opacity='0.08'><path d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/></g></g></svg>`),
    patternOpacity: 1,
    group: 'abstract',
  },
  {
    id: 'trees',
    name: 'Ёлочки',
    emoji: '🌲',
    darkBg: '#0a1a12',
    lightBg: '#dceee4',
    patternSvg: svgUri(treesSvg),
    patternOpacity: 1,
    group: 'nature',
  },
  {
    id: 'penguins',
    name: 'Пингвинчики',
    emoji: '🐧',
    darkBg: '#0a1520',
    lightBg: '#d8e8f4',
    patternSvg: svgUri(penguinsSvg),
    patternOpacity: 1,
    group: 'animals',
  },
  {
    id: 'snowflakes',
    name: 'Снежинки',
    emoji: '❄️',
    darkBg: '#0c1824',
    lightBg: '#dae6f0',
    patternSvg: svgUri(snowflakesSvg),
    patternOpacity: 1,
    group: 'holiday',
  },
  {
    id: 'hearts',
    name: 'Сердечки',
    emoji: '💕',
    darkBg: '#1a0a14',
    lightBg: '#f4dce8',
    patternSvg: svgUri(heartsSvg),
    patternOpacity: 1,
    group: 'abstract',
  },
  {
    id: 'stars',
    name: 'Звёзды',
    emoji: '⭐',
    darkBg: '#12100a',
    lightBg: '#f0edd8',
    patternSvg: svgUri(starsSvg),
    patternOpacity: 1,
    group: 'abstract',
  },
  {
    id: 'flowers',
    name: 'Цветочки',
    emoji: '🌸',
    darkBg: '#1a0c16',
    lightBg: '#f4dce8',
    patternSvg: svgUri(flowersSvg),
    patternOpacity: 1,
    group: 'nature',
  },
  {
    id: 'cats',
    name: 'Котики',
    emoji: '🐱',
    darkBg: '#14120a',
    lightBg: '#f0eed8',
    patternSvg: svgUri(catsSvg),
    patternOpacity: 1,
    group: 'animals',
  },
  {
    id: 'geometry',
    name: 'Геометрия',
    emoji: '🔷',
    darkBg: '#0f1218',
    lightBg: '#e0e4ec',
    patternSvg: svgUri(geometrySvg),
    patternOpacity: 1,
    group: 'abstract',
  },
  {
    id: 'waves',
    name: 'Волны',
    emoji: '🌊',
    darkBg: '#0a1620',
    lightBg: '#d8eaf4',
    patternSvg: svgUri(wavesSvg),
    patternOpacity: 1,
    group: 'nature',
  },
  {
    id: 'christmas',
    name: 'Новогодняя',
    emoji: '🎄',
    darkBg: '#0c1610',
    lightBg: '#dcf0e0',
    patternSvg: svgUri(christmasSvg),
    patternOpacity: 1,
    group: 'holiday',
  },
  {
    id: 'gaming',
    name: 'Гейм',
    emoji: '🎮',
    darkBg: '#100a1a',
    lightBg: '#e4d8f4',
    patternSvg: svgUri(gamingSvg),
    patternOpacity: 1,
    group: 'abstract',
  },
  {
    id: 'sparkles',
    name: 'Блёстки',
    emoji: '✨',
    darkBg: '#141008',
    lightBg: '#f0ecd8',
    patternSvg: svgUri(sparklesSvg),
    patternOpacity: 1,
    group: 'abstract',
  },
];

export function getWallpaper(id: string): WallpaperDef {
  return WALLPAPERS.find(w => w.id === id) || WALLPAPERS[1]; // default
}

export function getWallpaperCSS(
  id: string,
  isDark: boolean,
  extra?: { gradient?: { color1: string; color2: string; angle: number; opacity: number; patternId?: string }; image?: string; imageOpacity?: number }
): { backgroundColor: string; backgroundImage?: string; backgroundAttachment?: string; backgroundSize?: string; backgroundPosition?: string } {
  // Custom gradient wallpaper
  if (id === 'custom-gradient' && extra?.gradient) {
    const { color1, color2, angle, opacity, patternId } = extra.gradient;
    const a = opacity ?? 1;
    const c1 = _hexWithAlpha(color1, a);
    const c2 = _hexWithAlpha(color2, a);
    const gradientCss = `linear-gradient(${angle}deg, ${c1}, ${c2})`;

    if (patternId) {
      const patternWp = WALLPAPERS.find(w => w.id === patternId);
      if (patternWp?.patternSvg) {
        const color = isDark ? '#ffffff' : '#000000';
        const coloredPattern = patternWp.patternSvg.replace(/currentColor/g, encodeURIComponent(color));
        return {
          backgroundColor: isDark ? '#0f172a' : '#e2e8f0',
          backgroundImage: `${coloredPattern}, ${gradientCss}`,
          backgroundAttachment: 'fixed',
        };
      }
    }

    return {
      backgroundColor: isDark ? '#0f172a' : '#e2e8f0',
      backgroundImage: gradientCss,
      backgroundAttachment: 'fixed',
    };
  }

  // Custom image wallpaper
  if (id === 'custom-image' && extra?.image) {
    const imgOpacity = extra.imageOpacity ?? 1;
    if (imgOpacity < 1) {
      // Use a gradient overlay for opacity effect
      const overlay = isDark
        ? `linear-gradient(rgba(15,23,42,${1 - imgOpacity}), rgba(15,23,42,${1 - imgOpacity}))`
        : `linear-gradient(rgba(226,232,240,${1 - imgOpacity}), rgba(226,232,240,${1 - imgOpacity}))`;
      return {
        backgroundColor: isDark ? '#0f172a' : '#e2e8f0',
        backgroundImage: `${overlay}, url(${extra.image})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundAttachment: 'fixed',
      };
    }
    return {
      backgroundColor: isDark ? '#0f172a' : '#e2e8f0',
      backgroundImage: `url(${extra.image})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      backgroundAttachment: 'fixed',
    };
  }

  const wp = getWallpaper(id);
  const bg = isDark ? wp.darkBg : wp.lightBg;
  const color = isDark ? '#ffffff' : '#000000';

  if (wp.id === 'none' || !wp.patternSvg) {
    return { backgroundColor: bg };
  }

  // Replace currentColor in the SVG pattern with actual color
  const coloredPattern = wp.patternSvg.replace(/currentColor/g, encodeURIComponent(color));

  return {
    backgroundColor: bg,
    backgroundImage: coloredPattern,
    backgroundAttachment: 'fixed',
  };
}
