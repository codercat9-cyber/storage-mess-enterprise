import { useState } from 'react';
import { TERMS, TERMS_CHECKS } from '@/legal/terms';

interface Props {
  value: boolean[];
  onChange: (v: boolean[]) => void;
}

/** Набор обязательных галочек правил: регистрация и подтверждение новой редакции. */
export default function TermsChecks({ value, onChange }: Props) {
  // Текст разворачивается здесь же: уход на другую страницу стёр бы
  // заполненную форму регистрации, а в APK новое окно открывает браузер.
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2">
      {open && (
        <div className="max-h-60 overflow-y-auto rounded-lg bg-messenger-hover/60 p-3 text-[12px] leading-relaxed text-messenger-text/90">
          {TERMS.map(s => (
            <div key={s.title} className="mb-2">
              <div className="font-semibold mb-0.5">{s.title}</div>
              {s.body.map((p, i) => <p key={i} className="mb-1">{p}</p>)}
            </div>
          ))}
        </div>
      )}
      {TERMS_CHECKS.map((label, i) => (
        <label key={i} className="flex items-start gap-2.5 text-[13px] leading-snug text-messenger-text cursor-pointer select-none">
          <input
            type="checkbox"
            checked={!!value[i]}
            onChange={e => {
              const next = [...value];
              next[i] = e.target.checked;
              onChange(next);
            }}
            className="mt-0.5 w-4 h-4 shrink-0 accent-primary-500"
          />
          <span>
            {label}
            {i === 0 && (
              <> — <button type="button" onClick={e => { e.preventDefault(); setOpen(o => !o); }}
                           className="text-primary-400 underline">{open ? 'скрыть' : 'читать'}</button></>
            )}
          </span>
        </label>
      ))}
    </div>
  );
}

export const allChecked = (v: boolean[]) => TERMS_CHECKS.every((_, i) => !!v[i]);
