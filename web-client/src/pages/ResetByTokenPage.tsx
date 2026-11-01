import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { authApi } from '@/lib/api';
import { Eye, EyeOff, Loader2, KeyRound, AlertTriangle } from 'lucide-react';

export default function ResetByTokenPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';
  const navigate = useNavigate();

  const [valid, setValid] = useState<boolean | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) {
      setValid(false);
      return;
    }
    authApi.validateResetToken(token)
      .then(res => setValid(res.data.valid))
      .catch(() => setValid(false));
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 6) {
      setError('Пароль должен быть не менее 6 символов');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await authApi.resetByToken({ token, new_password: newPassword });
      setDone(true);
    } catch (err: any) {
      setError(err.response?.data?.error === 'Invalid or expired token'
        ? 'Ссылка устарела или уже использована'
        : 'Ошибка сброса пароля');
    } finally {
      setLoading(false);
    }
  };

  if (done) {
    return (
      <div className="h-full flex flex-col items-center justify-center overflow-y-auto p-4 bg-messenger-bg">
        <div className="w-full max-w-sm text-center animate-fadeIn">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-green-500/10 mb-6">
            <KeyRound className="w-10 h-10 text-green-500" />
          </div>
          <h1 className="text-2xl font-medium text-messenger-text mb-2">Пароль изменён!</h1>
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

  if (valid === null) {
    return (
      <div className="h-full flex items-center justify-center bg-messenger-bg">
        <Loader2 className="w-8 h-8 animate-spin text-primary-500" />
      </div>
    );
  }

  if (!valid) {
    return (
      <div className="h-full flex flex-col items-center justify-center overflow-y-auto p-4 bg-messenger-bg">
        <div className="w-full max-w-sm text-center animate-fadeIn">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-red-500/10 mb-6">
            <AlertTriangle className="w-10 h-10 text-red-500" />
          </div>
          <h1 className="text-2xl font-medium text-messenger-text mb-2">Ссылка недействительна</h1>
          <p className="text-messenger-muted mb-8">Токен устарел или уже был использован. Запросите сброс повторно.</p>
          <button
            onClick={() => navigate('/recovery')}
            className="w-full py-3.5 rounded-xl bg-primary-500 hover:bg-primary-600 text-white font-medium text-[16px] transition-colors shadow-md"
          >
            Восстановление
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col items-center justify-center overflow-y-auto p-4 bg-messenger-bg">
      <div className="w-full max-w-sm animate-fadeIn">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-primary-500/10 mb-6">
            <KeyRound className="w-10 h-10 text-primary-500" />
          </div>
          <h1 className="text-2xl font-medium text-messenger-text mb-2">Новый пароль</h1>
          <p className="text-messenger-muted text-[15px]">Введите новый пароль для вашего аккаунта</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 text-red-500 text-sm text-center">{error}</div>
          )}

          <div className="relative group">
            <input
              type={showPassword ? 'text' : 'password'}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full bg-transparent border border-messenger-border rounded-xl px-4 py-3.5 pr-12 text-[16px] text-messenger-text focus:outline-none focus:border-primary-500 transition-colors peer"
              placeholder=" "
              required
              minLength={6}
              autoComplete="new-password"
              autoFocus
            />
            <label className="absolute left-4 top-3.5 text-messenger-muted text-[16px] transition-all peer-focus:-top-2.5 peer-focus:text-xs peer-focus:text-primary-500 peer-focus:bg-messenger-bg peer-focus:px-1 peer-[:not(:placeholder-shown)]:-top-2.5 peer-[:not(:placeholder-shown)]:text-xs peer-[:not(:placeholder-shown)]:bg-messenger-bg peer-[:not(:placeholder-shown)]:px-1 cursor-text pointer-events-none">
              Новый пароль
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

          <button
            type="submit"
            disabled={loading || newPassword.length < 6}
            className="w-full py-3.5 rounded-xl bg-primary-500 hover:bg-primary-600 text-white font-medium text-[16px] transition-colors flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed shadow-md"
          >
            {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Сохранить пароль'}
          </button>
        </form>
      </div>
    </div>
  );
}
