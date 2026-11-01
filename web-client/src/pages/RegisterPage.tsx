import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/store/auth';
import { authApi } from '@/lib/api';
import { Eye, EyeOff, Loader2, KeyRound, Copy, Check } from 'lucide-react';
import TermsChecks, { allChecked } from '@/components/TermsChecks';
import { TERMS_VERSION } from '@/legal/terms';

export default function RegisterPage() {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState('');
  const [copied, setCopied] = useState(false);

  const login = useAuthStore((state) => state.login);
  const navigate = useNavigate();

  const [terms, setTerms] = useState<boolean[]>([]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (password.length < 6) {
      setError('Пароль должен быть не менее 6 символов');
      return;
    }
    if (!allChecked(terms)) {
      setError('Отметьте все пункты правил');
      return;
    }

    setLoading(true);

    try {
      const response = await authApi.register({
        username,
        email: email || undefined,
        password,
        display_name: displayName || undefined,
        terms_version: TERMS_VERSION,
      });
      try { localStorage.setItem('terms_accepted_version', TERMS_VERSION); } catch { /* */ }
      
      const { user, accessToken, refreshToken, recoveryKey: rk } = response.data;
      login(user, accessToken, refreshToken);
      setRecoveryKey(rk);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Ошибка регистрации');
    } finally {
      setLoading(false);
    }
  };

  const handleCopyKey = async () => {
    await navigator.clipboard.writeText(recoveryKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Модалка с ключом восстановления
  if (recoveryKey) {
    return (
      <div className="h-full flex flex-col items-center justify-center overflow-y-auto p-4 bg-messenger-bg">
        <div className="w-full max-w-sm animate-fadeIn">
          <div className="text-center mb-6">
            <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-amber-500/10 mb-4">
              <KeyRound className="w-10 h-10 text-amber-500" />
            </div>
            <h1 className="text-2xl font-medium text-messenger-text mb-2">Ключ восстановления</h1>
            <p className="text-messenger-muted text-[14px] leading-relaxed">
              Сохраните этот ключ в надёжном месте. Он понадобится
              для восстановления доступа, если вы забудете пароль.
            </p>
          </div>

          <div className="bg-messenger-input rounded-xl p-4 mb-4">
            <p className="text-center font-mono text-[15px] text-messenger-text tracking-wider select-all break-all leading-relaxed">
              {recoveryKey}
            </p>
          </div>

          <button
            onClick={handleCopyKey}
            className="w-full py-3 rounded-xl bg-messenger-hover hover:bg-messenger-border text-messenger-text font-medium text-[15px] transition-colors flex items-center justify-center gap-2 mb-3"
          >
            {copied ? <><Check className="w-4 h-4 text-green-500" /> Скопировано</> : <><Copy className="w-4 h-4" /> Скопировать ключ</>}
          </button>

          <button
            onClick={() => navigate('/')}
            className="w-full py-3.5 rounded-xl bg-primary-500 hover:bg-primary-600 text-white font-medium text-[16px] transition-colors shadow-md"
          >
            Продолжить
          </button>

          <p className="text-center text-amber-500/80 text-[12px] mt-4">
            ⚠️ Этот ключ показывается только один раз!
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col items-center justify-center overflow-y-auto p-4 bg-messenger-bg py-8">
      <div className="w-full max-w-sm">
        {/* Логотип */}
        <div className="text-center mb-8 animate-fadeIn">
          <div className="inline-flex items-center justify-center w-24 h-24 rounded-full overflow-hidden mb-6 shadow-xl border-4 border-messenger-border">
            <img src="/icon-192.png" alt="Logo" className="w-full h-full object-cover" />
          </div>
          <h1 className="text-3xl font-medium text-messenger-text mb-2">Регистрация</h1>
          <p className="text-messenger-muted text-[16px]">Создайте новый аккаунт</p>
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
                minLength={3}
                maxLength={30}
                autoComplete="username"
              />
              <label className="absolute left-4 top-3.5 text-messenger-muted text-[16px] transition-all peer-focus:-top-2.5 peer-focus:text-xs peer-focus:text-primary-500 peer-focus:bg-messenger-bg peer-focus:px-1 peer-[:not(:placeholder-shown)]:-top-2.5 peer-[:not(:placeholder-shown)]:text-xs peer-[:not(:placeholder-shown)]:bg-messenger-bg peer-[:not(:placeholder-shown)]:px-1 cursor-text pointer-events-none">
                Имя пользователя *
              </label>
            </div>

            <div className="relative group">
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full bg-transparent border border-messenger-border rounded-xl px-4 py-3.5 text-[16px] text-messenger-text focus:outline-none focus:border-primary-500 transition-colors peer"
                placeholder=" "
                autoComplete="name"
              />
              <label className="absolute left-4 top-3.5 text-messenger-muted text-[16px] transition-all peer-focus:-top-2.5 peer-focus:text-xs peer-focus:text-primary-500 peer-focus:bg-messenger-bg peer-focus:px-1 peer-[:not(:placeholder-shown)]:-top-2.5 peer-[:not(:placeholder-shown)]:text-xs peer-[:not(:placeholder-shown)]:bg-messenger-bg peer-[:not(:placeholder-shown)]:px-1 cursor-text pointer-events-none">
                Отображаемое имя
              </label>
            </div>

            <div className="relative group">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-transparent border border-messenger-border rounded-xl px-4 py-3.5 text-[16px] text-messenger-text focus:outline-none focus:border-primary-500 transition-colors peer"
                placeholder=" "
                autoComplete="email"
              />
              <label className="absolute left-4 top-3.5 text-messenger-muted text-[16px] transition-all peer-focus:-top-2.5 peer-focus:text-xs peer-focus:text-primary-500 peer-focus:bg-messenger-bg peer-focus:px-1 peer-[:not(:placeholder-shown)]:-top-2.5 peer-[:not(:placeholder-shown)]:text-xs peer-[:not(:placeholder-shown)]:bg-messenger-bg peer-[:not(:placeholder-shown)]:px-1 cursor-text pointer-events-none">
                Email
              </label>
            </div>

            <div className="relative group">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-transparent border border-messenger-border rounded-xl px-4 py-3.5 pr-12 text-[16px] text-messenger-text focus:outline-none focus:border-primary-500 transition-colors peer"
                placeholder=" "
                required
                minLength={6}
                autoComplete="new-password"
              />
              <label className="absolute left-4 top-3.5 text-messenger-muted text-[16px] transition-all peer-focus:-top-2.5 peer-focus:text-xs peer-focus:text-primary-500 peer-focus:bg-messenger-bg peer-focus:px-1 peer-[:not(:placeholder-shown)]:-top-2.5 peer-[:not(:placeholder-shown)]:text-xs peer-[:not(:placeholder-shown)]:bg-messenger-bg peer-[:not(:placeholder-shown)]:px-1 cursor-text pointer-events-none">
                Пароль *
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

          <TermsChecks value={terms} onChange={setTerms} />

          <button
            type="submit"
            disabled={loading || !username || password.length < 6 || !allChecked(terms)}
            className="w-full py-3.5 rounded-xl bg-primary-500 hover:bg-primary-600 text-white font-medium text-[16px] transition-colors flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed shadow-md"
          >
            {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'ЗАРЕГИСТРИРОВАТЬСЯ'}
          </button>
        </form>

        <div className="text-center mt-8 animate-fadeIn">
          <p className="text-messenger-muted text-[15px]">
            Уже есть аккаунт?{' '}
            <Link to="/login" className="text-primary-500 hover:text-primary-600 font-medium transition-colors">
              Войти
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
