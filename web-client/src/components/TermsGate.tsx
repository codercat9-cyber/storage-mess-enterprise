import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/store/auth';
import { legalApi } from '@/lib/api';
import { TERMS_VERSION } from '@/legal/terms';
import TermsChecks, { allChecked } from '@/components/TermsChecks';

const LOCAL_KEY = 'terms_accepted_version';

/**
 * Подтверждение правил для тех, кто зарегистрировался до них или до новой
 * редакции. Один раз на редакцию. Принятие запоминается и локально: без
 * сети окно не мешает пользоваться приложением, а на сервер согласие уйдёт
 * при следующем запуске.
 */
export default function TermsGate() {
  const isAuthenticated = useAuthStore(s => s.isAuthenticated);
  const [show, setShow] = useState(false);
  const [checks, setChecks] = useState<boolean[]>([]);
  const [saving, setSaving] = useState(false);
  const location = useLocation();

  useEffect(() => {
    if (!isAuthenticated) return;
    let local: string | null = null;
    try { local = localStorage.getItem(LOCAL_KEY); } catch { /* приватный режим */ }
    let cancelled = false;
    legalApi.status()
      .then(r => {
        if (cancelled) return;
        const server = r.data?.version;
        if (server === TERMS_VERSION) {
          try { localStorage.setItem(LOCAL_KEY, TERMS_VERSION); } catch { /* */ }
          return;
        }
        // Принял без сети — досылаем согласие
        if (local === TERMS_VERSION) { legalApi.accept(TERMS_VERSION).catch(() => {}); return; }
        setShow(true);
      })
      .catch(() => { if (!cancelled && local !== TERMS_VERSION) setShow(true); });
    return () => { cancelled = true; };
  }, [isAuthenticated]);

  // На странице правил окно не мешает читать; вернётся после неё
  if (!show || location.pathname === '/terms') return null;

  const accept = async () => {
    setSaving(true);
    try { localStorage.setItem(LOCAL_KEY, TERMS_VERSION); } catch { /* */ }
    try { await legalApi.accept(TERMS_VERSION); } catch { /* досылается при следующем запуске */ }
    setSaving(false);
    setShow(false);
  };

  return (
    <div className="fixed inset-0 z-[10000] bg-black/70 flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl bg-messenger-sidebar p-5 space-y-4 shadow-2xl">
        <h2 className="text-lg font-semibold text-messenger-text">Правила использования</h2>
        <p className="text-[13px] text-messenger-muted leading-relaxed">
          Мы обновили правила. Коротко: мессенджер не является СМИ, за размещённое отвечает тот, кто разместил,
          запрещённое удаляется по жалобам. Мы за мир и против всего, что причиняет людям вред.{' '}
          <Link to="/terms" className="text-primary-400 underline">Полный текст</Link>
        </p>
        <TermsChecks value={checks} onChange={setChecks} />
        <button
          disabled={!allChecked(checks) || saving}
          onClick={accept}
          className="w-full py-2.5 rounded-xl bg-primary-500 text-white font-medium disabled:opacity-40"
        >
          {saving ? 'Сохраняю…' : 'Принимаю'}
        </button>
      </div>
    </div>
  );
}
