import { useState } from 'react';
import { ChevronDown, ChevronUp, HelpCircle } from 'lucide-react';
import { detectPlatform } from '@/lib/downloads';

/**
 * «Не устанавливается?» — подсказка на экране загрузок.
 *
 * Появилась по обращению от пользователя: телефон Tecno POVA 3, HiOS,
 * человек написал «версия телефона не поддерживает приложение или чё то
 * такое» и с тех пор сидит из браузера.
 *
 * Сам файл при этом в порядке — проверено разбором: минимальная версия
 * Android 7, есть все нужные наборы инструкций, подпись читается, все
 * выпуски подписаны одним ключом. То есть дело не в сборке, а в том, что
 * телефон отказывается ставить приложение не из магазина, и говорит об
 * этом невнятно. Особенно у Tecno, Infinix и itel — там своя оболочка
 * HiOS/XOS с отдельным запретом, спрятанным не там, где у всех.
 *
 * Написано словами человека, а не системы: «разрешите установку из
 * этого браузера» вместо «включите неизвестные источники».
 */

interface Props {
  /** Плотнее и без рамки — для встраивания в модальное окно. */
  compact?: boolean;
}

const ANDROID_STEPS = [
  'Откройте скачанный файл через «Загрузки» браузера, а не из шторки уведомлений — из шторки часть телефонов открывает его не тем приложением.',
  'Если телефон говорит «в целях безопасности установка запрещена» — рядом будет кнопка «Настройки». Нажмите её и разрешите установку для того браузера, из которого качали.',
  'На Tecno, Infinix и itel этот запрет живёт отдельно: Настройки → Безопасность → Установка неизвестных приложений. Ещё там же бывает «Проверка безопасности приложений» — её нужно временно выключить.',
  'Если пишет «приложение не установлено» и раньше S&M уже стоял — удалите старую копию и поставьте заново. Данные в аккаунте не пропадут, они на сервере.',
  'Не хватает места — файл около 60 МБ, плюс столько же нужно на распаковку.',
];

const WINDOWS_STEPS = [
  'Windows покажет синее окно «Система защитила ваш компьютер» — это потому, что у установщика нет платной подписи разработчика, а не потому, что с ним что-то не так. Нажмите «Подробнее» → «Выполнить в любом случае».',
  'Если браузер удалил файл сразу после загрузки — зайдите в его загрузки и выберите «Сохранить всё равно».',
];

const LINUX_STEPS = [
  'Скачанному файлу AppImage нужно разрешить запуск: правой кнопкой → Свойства → «Разрешить выполнение файла как программы». Или в терминале: chmod +x имя-файла.AppImage',
  'Если ничего не происходит при запуске — в некоторых системах не хватает FUSE: sudo apt install libfuse2',
];

export default function InstallHelp({ compact = false }: Props) {
  const [open, setOpen] = useState(false);
  const platform = detectPlatform();

  const steps = platform === 'windows' ? WINDOWS_STEPS
    : platform === 'linux' ? LINUX_STEPS
      : ANDROID_STEPS;

  const title = platform === 'android' || platform === 'unknown'
    ? 'Телефон не даёт установить?'
    : 'Не устанавливается?';

  return (
    <div className={compact ? 'pt-1' : 'pt-3 border-t border-messenger-border/50 mt-3'}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 text-[13px] text-messenger-muted hover:text-primary-500 transition-colors py-1"
      >
        <HelpCircle size={15} className="shrink-0" />
        <span className="flex-1 text-left">{title}</span>
        {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
      </button>

      {open && (
        <ol className="mt-2 space-y-2 pl-1">
          {steps.map((s, i) => (
            <li key={i} className="flex gap-2 text-[12px] text-messenger-muted leading-relaxed">
              <span className="shrink-0 w-4 h-4 rounded-full bg-messenger-hover text-[10px] flex items-center justify-center mt-0.5">
                {i + 1}
              </span>
              <span>{s}</span>
            </li>
          ))}
          <li className="text-[12px] text-messenger-muted leading-relaxed pl-6">
            Ничего не помогло — веб-версия работает в браузере целиком, без установки.
            А если хотите, чтобы разобрались: меню → «Позвать администратора».
          </li>
        </ol>
      )}
    </div>
  );
}
