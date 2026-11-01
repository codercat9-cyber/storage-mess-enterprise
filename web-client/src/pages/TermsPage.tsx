import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { TERMS, TERMS_VERSION } from '@/legal/terms';

/** Правила использования — открыты всем, без входа. */
export default function TermsPage() {
  const navigate = useNavigate();
  return (
    <div className="min-h-screen bg-messenger-bg text-messenger-text overflow-y-auto">
      <div className="max-w-2xl mx-auto px-4 py-6">
        <button
          onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/'))}
          className="flex items-center gap-2 text-sm text-primary-400 mb-4"
        >
          <ArrowLeft size={16} /> Назад
        </button>
        <h1 className="text-2xl font-semibold mb-1">Правила использования</h1>
        <div className="text-xs text-messenger-muted mb-6">Редакция от {TERMS_VERSION}</div>
        {TERMS.map(s => (
          <section key={s.title} className="mb-5">
            <h2 className="text-base font-semibold mb-2">{s.title}</h2>
            {s.body.map((p, i) => (
              <p key={i} className="text-[14px] leading-relaxed text-messenger-text/90 mb-2">{p}</p>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
