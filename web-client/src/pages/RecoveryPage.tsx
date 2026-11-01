import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { authApi } from '@/lib/api';
import { Eye, EyeOff, Loader2, KeyRound, Mail, ArrowLeft } from 'lucide-react';

export default function RecoveryPage() {
  const [mode, setMode] = useState<'key' | 'email'>('key');
  const [step, setStep] = useState<'input' | 'done' | 'email-sent'>('input');
  const [username, setUsername] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [emailAvailable, setEmailAvailable] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    authApi.emailResetAvailable()
      .then(res => setEmailAvailable(res.data.available))
      .catch(() => {});
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (newPassword.length < 6) {
      setError('Пароль должен быть не менее 6 символов');
      return;
    }

    setLoading(true);
    try {
      await authApi.recover({
        username,
        recovery_key: recoveryKey,
        new_password: newPassword,
      });
      setStep('done');
    } catch (err: any) {
      setError(err.response?.data?.error === 'Invalid username or recovery key'
        ? 'Неверное имя пользователя или ключ восстановления'
        : err.response?.data?.error || 'Ошибка восстановления');
    } finally {
      setLoading(false);
    }
  };

  const handleEmailReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) return;
    setError('');
    setLoading(true);
    try {
      await authApi.requestReset(username);
      setStep('email-sent');
    } catch (err: any) {
      setError(err.response?.data?.error === 'Email service not configured'
        ? 'Email-сброс не настроен на сервере'
        : 'Ошибка отправки. Попробуйте позже.');
    } finally {
      setLoading(false);
    }
  };

  if (step === 'done') {
    return (
      <div className="h-full flex flex-col items-center justify-center overflow-y-auto p-4 bg-messenger-bg">
        <div className="w-full max-w-sm text-center animate-fadeIn">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-green-500/10 mb-6">
            <KeyRound className="w-10 h-10 text-green-500" />
          </div>
          <h1 className="text-2xl font-medium text-messenger-text mb-2">Пароль изменён</h1>
          <p className="text-messenger-muted mb-8">Теперь вы можете войти с новым паролем</p>
          <button
            onClick={() => navigate('/login')}
            className="w-full py-3.5 rounded-xl bg-primary-500 hover:bg-primary-600 text-white font-medium text-[16px] transition-colors shadow-md"
          >
            Войти
          </button>
        </div>
      </div>
    );
  }

  if (step === 'email-sent') {
    return (
      <div className="h-full flex flex-col items-center justify-center overflow-y-auto p-4 bg-messenger-bg">
        <div className="w-full max-w-sm text-center animate-fadeIn">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-blue-500/10 mb-6">
            <Mail className="w-10 h-10 text-blue-500" />
          </div>
          <h1 className="text-2xl font-medium text-messenger-text mb-2">Проверьте почту</h1>
          <p className="text-messenger-muted text-[15px] mb-8 leading-relaxed">
            Если аккаунт <b>@{username}</b> существует и к нему привязан email,
            мы отправили ссылку для сброса пароля.
            <br /><br />
            Ссылка действительна <b>30 минут</b>.
          </p>
          <button
            onClick={() => navigate('/login')}
            className="w-full py-3.5 rounded-xl bg-primary-500 hover:bg-primary-600 text-white font-medium text-[16px] transition-colors shadow-md"
          >
            Вернуться к входу
          </button>
          <button
            onClick={() => { setStep('input'); setError(''); }}
            className="w-full py-3 mt-3 rounded-xl bg-messenger-hover hover:bg-messenger-border text-messenger-text font-medium text-[15px] transition-colors"
          >
            Попробовать снова
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col items-center justify-center overflow-y-auto p-4 bg-messenger-bg py-8">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8 animate-fadeIn">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-primary-500/10 mb-6">
            {mode === 'key' ? <KeyRound className="w-10 h-10 text-primary-500" /> : <Mail className="w-10 h-10 text-primary-500" />}
          </div>
          <h1 className="text-2xl font-medium text-messenger-text mb-2">Восстановление</h1>
          <p className="text-messenger-muted text-[15px]">
            {mode === 'key'
              ? <>Введите ваш ключ восстановления,<br />который вы получили при регистрации</>
              : <>Мы отправим ссылку для сброса<br />на email, привязанный к аккаунту</>
            }
          </p>
        </div>

        {/* Переключатель режимов */}
        {emailAvailable && (
          <div className="flex rounded-xl bg-messenger-hover p-1 mb-6 animate-fadeIn">
            <button
              onClick={() => { setMode('key'); setError(''); }}
              className={`flex-1 py-2.5 rounded-lg text-[14px] font-medium transition-all flex items-center justify-center gap-1.5 ${
                mode === 'key' ? 'bg-white dark:bg-[#333] text-messenger-text shadow-sm' : 'text-messenger-muted hover:text-messenger-text'
              }`}
            >
              <KeyRound className="w-4 h-4" /> По ключу
            </button>
            <button
              onClick={() => { setMode('email'); setError(''); }}
              className={`flex-1 py-2.5 rounded-lg text-[14px] font-medium transition-all flex items-center justify-center gap-1.5 ${
                mode === 'email' ? 'bg-white dark:bg-[#333] text-messenger-text shadow-sm' : 'text-messenger-muted hover:text-messenger-text'
              }`}
            >
              <Mail className="w-4 h-4" /> По email
            </button>
          </div>
        )}

        {mode === 'key' ? (
          <form onSubmit={handleSubmit} className="space-y-5 animate-slideUp">
            {error && (
              <div className="p-3 rounded-lg bg-red-500/10 text-red-500 text-sm text-center">{error}</div>
            )}

            <div className="space-y-4">
              <div className="relative group">
                <input type="text" value={username} onChange={(e) => setUsername(e.target.value)}
                  className="w-full bg-transparent border border-messenger-border rounded-xl px-4 py-3.5 text-[16px] text-messenger-text focus:outline-none focus:border-primary-500 transition-colors peer"
                  placeholder=" " required autoComplete="username" />
                <label className="absolute left-4 top-3.5 text-messenger-muted text-[16px] transition-all peer-focus:-top-2.5 peer-focus:text-xs peer-focus:text-primary-500 peer-focus:bg-messenger-bg peer-focus:px-1 peer-[:not(:placeholder-shown)]:-top-2.5 peer-[:not(:placeholder-shown)]:text-xs peer-[:not(:placeholder-shown)]:bg-messenger-bg peer-[:not(:placeholder-shown)]:px-1 cursor-text pointer-events-none">
                  Имя пользователя
                </label>
              </div>

              <div className="relative group">
                <input type="text" value={recoveryKey} onChange={(e) => setRecoveryKey(e.target.value)}
                  className="w-full bg-transparent border border-messenger-border rounded-xl px-4 py-3.5 text-[16px] text-messenger-text focus:outline-none focus:border-primary-500 transition-colors peer font-mono tracking-wider"
                  placeholder=" " required autoComplete="off" />
                <label className="absolute left-4 top-3.5 text-messenger-muted text-[16px] transition-all peer-focus:-top-2.5 peer-focus:text-xs peer-focus:text-primary-500 peer-focus:bg-messenger-bg peer-focus:px-1 peer-[:not(:placeholder-shown)]:-top-2.5 peer-[:not(:placeholder-shown)]:text-xs peer-[:not(:placeholder-shown)]:bg-messenger-bg peer-[:not(:placeholder-shown)]:px-1 cursor-text pointer-events-none">
                  Ключ восстановления
                </label>
              </div>

              <div className="relative group">
                <input type={showPassword ? 'text' : 'password'} value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full bg-transparent border border-messenger-border rounded-xl px-4 py-3.5 pr-12 text-[16px] text-messenger-text focus:outline-none focus:border-primary-500 transition-colors peer"
                  placeholder=" " required minLength={6} autoComplete="new-password" />
                <label className="absolute left-4 top-3.5 text-messenger-muted text-[16px] transition-all peer-focus:-top-2.5 peer-focus:text-xs peer-focus:text-primary-500 peer-focus:bg-messenger-bg peer-focus:px-1 peer-[:not(:placeholder-shown)]:-top-2.5 peer-[:not(:placeholder-shown)]:text-xs peer-[:not(:placeholder-shown)]:bg-messenger-bg peer-[:not(:placeholder-shown)]:px-1 cursor-text pointer-events-none">
                  Новый пароль
                </label>
                <button type="button" onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-messenger-muted hover:text-primary-500 transition-colors p-1" tabIndex={-1}>
                  {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              </div>
            </div>

            <button type="submit" disabled={loading || !username || !recoveryKey || newPassword.length < 6}
              className="w-full py-3.5 rounded-xl bg-primary-500 hover:bg-primary-600 text-white font-medium text-[16px] transition-colors flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed shadow-md">
              {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Сбросить пароль'}
            </button>

            {emailAvailable && (
              <p className="text-center text-messenger-muted text-[13px]">
                Нет ключа?{' '}
                <button type="button" onClick={() => setMode('email')} className="text-primary-500 hover:text-primary-600 font-medium">
                  Сбросить через email
                </button>
              </p>
            )}
          </form>
        ) : (
          <form onSubmit={handleEmailReset} className="space-y-5 animate-slideUp">
            {error && (
              <div className="p-3 rounded-lg bg-red-500/10 text-red-500 text-sm text-center">{error}</div>
            )}

            <div className="relative group">
              <input type="text" value={username} onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-transparent border border-messenger-border rounded-xl px-4 py-3.5 text-[16px] text-messenger-text focus:outline-none focus:border-primary-500 transition-colors peer"
                placeholder=" " required autoComplete="username" autoFocus />
              <label className="absolute left-4 top-3.5 text-messenger-muted text-[16px] transition-all peer-focus:-top-2.5 peer-focus:text-xs peer-focus:text-primary-500 peer-focus:bg-messenger-bg peer-focus:px-1 peer-[:not(:placeholder-shown)]:-top-2.5 peer-[:not(:placeholder-shown)]:text-xs peer-[:not(:placeholder-shown)]:bg-messenger-bg peer-[:not(:placeholder-shown)]:px-1 cursor-text pointer-events-none">
                Имя пользователя
              </label>
            </div>

            <p className="text-messenger-muted text-[13px] text-center leading-relaxed">
              Мы отправим ссылку для сброса пароля на email,<br />
              который вы указали при регистрации
            </p>

            <button type="submit" disabled={loading || !username.trim()}
              className="w-full py-3.5 rounded-xl bg-primary-500 hover:bg-primary-600 text-white font-medium text-[16px] transition-colors flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed shadow-md">
              {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <><Mail className="w-5 h-5" /> Отправить ссылку</>}
            </button>

            <p className="text-center text-messenger-muted text-[13px]">
              Помните ключ?{' '}
              <button type="button" onClick={() => setMode('key')} className="text-primary-500 hover:text-primary-600 font-medium">
                Сбросить по ключу
              </button>
            </p>
          </form>
        )}

        <div className="text-center mt-8 animate-fadeIn">
          <Link to="/login" className="text-primary-500 hover:text-primary-600 font-medium transition-colors text-[15px]">
            Вернуться к входу
          </Link>
        </div>
      </div>
    </div>
  );
}
