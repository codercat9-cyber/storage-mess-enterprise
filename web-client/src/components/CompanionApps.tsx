import { Download, Shield } from 'lucide-react';
import { getCompanionApps } from '@/lib/downloads';

/**
 * «Ещё наши приложения» — полка рядом с загрузкой мессенджера.
 *
 * Отдельным блоком и с отдельной подписью, потому что это НЕ части
 * мессенджера. Если показать их одним списком с установщиками, человек
 * решит, что без них связь не заработает, и либо поставит лишнее, либо
 * испугается. Поэтому у каждого честная строка о том, что он не нужен
 * для работы мессенджера.
 */
export default function CompanionApps() {
  const apps = getCompanionApps();
  if (apps.length === 0) return null;

  return (
    <div className="pt-3 mt-3 border-t border-messenger-border/50">
      <div className="text-[11px] uppercase tracking-wide text-messenger-muted mb-2">
        Ещё наши приложения
      </div>

      {apps.map(app => (
        <a
          key={app.id}
          href={app.url}
          download={app.filename}
          className="flex items-start gap-3 p-2.5 rounded-lg hover:bg-messenger-hover transition-colors group"
        >
          <span className="shrink-0 w-9 h-9 rounded-lg bg-messenger-hover flex items-center justify-center mt-0.5">
            <Shield size={17} className="text-primary-500" />
          </span>
          <span className="flex-1 min-w-0">
            <span className="flex items-center gap-2">
              <span className="text-[13px] font-medium">{app.title}</span>
              <Download
                size={13}
                className="text-messenger-muted opacity-0 group-hover:opacity-100 transition-opacity"
              />
            </span>
            <span className="block text-[12px] text-messenger-muted leading-snug">{app.hint}</span>
            <span className="block text-[11px] text-messenger-muted/70 leading-snug mt-0.5">
              {app.note}
            </span>
          </span>
        </a>
      ))}
    </div>
  );
}
