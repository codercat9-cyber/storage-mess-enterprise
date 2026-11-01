import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/store/auth';
import { authApi, updateApiBaseUrl } from '@/lib/api';
import { getApiUrl, recheckConnection } from '@/lib/connection';
import { Eye, EyeOff, Loader2, Send } from 'lucide-react';
import LanServerPicker from '@/components/LanServerPicker';
import { useEnterprise, refreshEnterpriseInfo } from '@/lib/enterprise';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const login = useAuthStore((state) => state.login);
  const navigate = useNavigate();

  // Корпоративный контур: учётки создаёт каталог (AD), пароль проверяет
  // домен. Ответ /enterprise/info запомнен — экран верный и без связи.
  const ent = useEnterprise().info;
  const corp = !!ent?.enabled;
  useEffect(() => {
    refreshEnterpriseInfo().catch(() => {});
    // Выкинуло блокировкой (админ или каталог) — говорим прямо, почему
    try {
      const why = sessionStorage.getItem('smess_blocked_reason');
      if (why !== null) {
        sessionStorage.removeItem('smess_blocked_reason');
        setError(`Учётная запись заблокирована${why ? `: ${why}` : ''}. Сессии на всех устройствах закрыты.`);
      }
    } catch { /* */ }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      // Перед входом убеждаемся, что адрес сервера действительно рабочий.
      //
      // При запуске приложение подставляет запомненный адрес сразу, а
      // проверяет его фоном — так задумано, иначе на плохой связи ждать
      // пришлось бы каждый раз. Но если адрес успел устареть, нажатие
      // «Войти» в эти секунды уходит в никуда, и человек видит «не удалось
      // связаться» на ровном месте. Вход — операция редкая, полсекунды
      // проверки тут никому не мешают, зато он больше не стреляет вслепую.
      await recheckConnection().catch(() => { /* не вышло — пробуем как есть */ });
      updateApiBaseUrl();

      const response = await authApi.login({ username: username.trim(), password });
      const { user, accessToken, refreshToken } = response.data;
      
      login(user, accessToken, refreshToken);
      navigate('/');
    } catch (err: any) {
      // Раньше здесь было `err.response?.data?.error || 'Ошибка входа'`.
      //
      // Из-за этого два совершенно разных случая выглядели одинаково:
      // сервер ответил «неверный пароль» — и сервер вообще НЕ ОТВЕТИЛ.
      // Во втором случае в журнале сервера пусто, потому что запрос до него
      // не долетел, а человек видит «Ошибка входа» и уверен, что перепутал
      // пароль. Так и искали втроём несколько дней.
      //
      // Теперь эти случаи различимы, и видно, куда именно приложение
      // стучалось — без этого причину «не долетело» не найти.
      if (err?.response) {
        const serverText = err.response.data?.error;
        // Вход доменом: причину отказа знает только сервер (учётка
        // отключена в AD, заблокирована, срок истёк, нет в группе, RADIUS
        // не ответил) — показываем как прислано.
        if (corp && serverText && serverText !== 'Invalid credentials') setError(String(serverText));
        else setError(
          err.response.status === 401
            ? 'Неверное имя пользователя или пароль'
            : `Сервер ответил ошибкой ${err.response.status}${serverText ? `: ${serverText}` : ''}`
        );
      } else {
        const where = getApiUrl();
        const why = err?.code === 'ECONNABORTED' ? 'сервер не ответил вовремя' : (err?.message || 'нет связи');
        setError(`Не удалось связаться с сервером (${why}). Адрес: ${where}`);
        console.error('[ВХОД] запрос не дошёл до сервера:', where, err);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-full flex flex-col items-center justify-center overflow-y-auto p-4 bg-messenger-bg">
      <div className="w-full max-w-sm">
        {/* Логотип */}
        <div className="text-center mb-8 animate-fadeIn">
          <div className="inline-flex items-center justify-center w-32 h-32 rounded-full overflow-hidden mb-6 shadow-xl border-4 border-messenger-border">
            <img src="/icon-192.png" alt="Logo" className="w-full h-full object-cover" />
          </div>
          <h1 className="text-3xl font-medium text-messenger-text mb-2">STORAGE&MESS</h1>
          <p className="text-messenger-muted text-[16px]">
            {corp ? `Вход учётной записью домена${ent?.domain ? ` ${ent.domain}` : ''}` : 'Пожалуйста, войдите в свой аккаунт.'}
          </p>
        </div>

        {/* Форма */}
        <form onSubmit={handleSubmit} className="space-y-5 animate-slideUp">
          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 text-red-500 text-sm text-center">
              {error}
            </div>
          )}

          <div className="space-y-4">
            <div className="relative group">
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-transparent border border-messenger-border rounded-xl px-4 py-3.5 text-[16px] text-messenger-text focus:outline-none focus:border-primary-500 transition-colors peer"
                placeholder=" "
                required
                autoComplete="username"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                inputMode="text"
                enterKeyHint="next"
              />
              <label className="absolute left-4 top-3.5 text-messenger-muted text-[16px] transition-all peer-focus:-top-2.5 peer-focus:text-xs peer-focus:text-primary-500 peer-focus:bg-messenger-bg peer-focus:px-1 peer-[:not(:placeholder-shown)]:-top-2.5 peer-[:not(:placeholder-shown)]:text-xs peer-[:not(:placeholder-shown)]:bg-messenger-bg peer-[:not(:placeholder-shown)]:px-1 cursor-text pointer-events-none">
                {corp ? 'Логин домена' : 'Имя пользователя'}
              </label>
              {corp && (
                <p className="mt-1 px-1 text-[12px] text-messenger-muted">{ent?.login_hint || 'логин или логин@домен'}</p>
              )}
            </div>

            <div className="relative group">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-transparent border border-messenger-border rounded-xl px-4 py-3.5 pr-12 text-[16px] text-messenger-text focus:outline-none focus:border-primary-500 transition-colors peer"
                placeholder=" "
                required
                autoComplete="current-password"
                enterKeyHint="go"
              />
              <label className="absolute left-4 top-3.5 text-messenger-muted text-[16px] transition-all peer-focus:-top-2.5 peer-focus:text-xs peer-focus:text-primary-500 peer-focus:bg-messenger-bg peer-focus:px-1 peer-[:not(:placeholder-shown)]:-top-2.5 peer-[:not(:placeholder-shown)]:text-xs peer-[:not(:placeholder-shown)]:bg-messenger-bg peer-[:not(:placeholder-shown)]:px-1 cursor-text pointer-events-none">
                Пароль
              </label>
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-messenger-muted hover:text-primary-500 transition-colors p-1"
                tabIndex={-1}
              >
                {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading || !username || !password}
            className="w-full py-3.5 rounded-xl bg-primary-500 hover:bg-primary-600 text-white font-medium text-[16px] transition-colors flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed shadow-md"
          >
            {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'ВОЙТИ'}
          </button>
          <p className="text-[12px] text-messenger-muted text-center leading-snug">
            Входя, вы принимаете <Link to="/terms" className="text-primary-400 underline">Правила использования</Link>.
            Мессенджер не является СМИ; за размещённое отвечает пользователь.
          </p>
          <details className="text-messenger-muted">
            <summary className="text-[12px] text-center cursor-pointer">Свой сервер / без интернета</summary>
            <div className="pt-2"><LanServerPicker compact /></div>
          </details>
        </form>

        <div className="text-center mt-6 animate-fadeIn space-y-3">
          <Link to="/recover" className="block text-messenger-muted hover:text-primary-500 transition-colors text-[14px]">
            Забыли пароль?
          </Link>
          {/* Учётки сотрудников создаёт каталог — регистрироваться самому негде */}
          {corp ? (
            <p className="text-messenger-muted text-[13px] leading-snug">
              Учётные записи создаются из каталога компании. Пароль домена меняет ИТ-служба.
            </p>
          ) : (
            <Link to="/register" className="block text-primary-500 hover:text-primary-600 font-medium transition-colors text-[15px]">
              Создать аккаунт
            </Link>
          )}
          <Link to="/qr-login" className="block text-white hover:text-gray-300 font-medium transition-colors text-[15px] mt-2">
            Вход по QR-коду
          </Link>
        </div>

        {/* Ссылки на приложения */}
        <div className="mt-10 pt-6 border-t border-messenger-border text-center animate-fadeIn">
          <p className="text-messenger-muted text-sm mb-3">Скачать приложение</p>
          <div className="flex items-center justify-center gap-4">
            <button onClick={() => window.open(window.location.origin + '/api/updates/download/apk', '_blank')} className="text-messenger-muted hover:text-green-500 transition-colors text-sm flex flex-col items-center gap-1">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 14v4a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-4"/><polyline points="12 15 12 3 12 15"/><polyline points="9 12 12 15 15 12"/></svg>
              <span>Android</span>
            </button>
            <button onClick={() => window.open(window.location.origin + '/api/updates/download/desktop/windows', '_blank')} className="text-messenger-muted hover:text-blue-500 transition-colors text-sm flex flex-col items-center gap-1">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
              <span>Windows</span>
            </button>
            <button onClick={() => window.open(window.location.origin + '/api/updates/download/desktop/linux', '_blank')} className="text-messenger-muted hover:text-orange-500 transition-colors text-sm flex flex-col items-center gap-1">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
              <span>Linux</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
