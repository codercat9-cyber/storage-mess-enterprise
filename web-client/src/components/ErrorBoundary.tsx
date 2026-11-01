import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Ловушка для сбоев в отрисовке.
 *
 * До неё в приложении не было ни одной. А правило у React простое: если
 * при отрисовке вылетела ошибка и её некому поймать — снимается ВСЁ
 * дерево. Не тот кусок, где сломалось, а целиком. Снаружи это выглядит
 * как «приложение упало с белым экраном»: окно живое, скрипт работает,
 * но рисовать в нём уже нечего.
 *
 * Так и пришла жалоба про воспроизведение музыки и видео: одна ошибка
 * внутри плеера гасила весь мессенджер, и понять по такому экрану было
 * решительно нечего.
 *
 * Теперь на месте белизны — что именно сломалось и кнопка вернуться.
 * Ошибка при этом уходит в консоль полностью: она нужна для разбора.
 */

interface Props {
  children: ReactNode;
  /** Что показать вместо упавшего куска. По умолчанию — общий экран. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Подпись места в интерфейсе — попадает в журнал. */
  where?: string;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      `[СБОЙ ОТРИСОВКИ]${this.props.where ? ' ' + this.props.where : ''}`,
      error,
      info.componentStack,
    );
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div className="h-full w-full flex items-center justify-center p-6 bg-messenger-bg">
        <div className="max-w-md text-center">
          <p className="text-messenger-text text-[17px] font-medium mb-2">Что-то сломалось</p>
          <p className="text-messenger-muted text-[14px] mb-4">
            {this.props.where ? `Не удалось показать: ${this.props.where}.` : 'Не удалось показать эту часть приложения.'}
            {' '}Остальное работает — можно вернуться и продолжить.
          </p>
          <pre className="text-[11px] text-left text-messenger-muted bg-black/20 rounded-lg p-3 mb-4 overflow-auto max-h-32 whitespace-pre-wrap">
            {error.message || String(error)}
          </pre>
          <div className="flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={this.reset}
              className="px-4 py-2 rounded-xl bg-primary-500 hover:bg-primary-600 text-white text-[15px] font-medium transition-colors"
            >
              Попробовать снова
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-xl border border-messenger-border text-messenger-text text-[15px] hover:bg-messenger-hover transition-colors"
            >
              Перезапустить
            </button>
          </div>
        </div>
      </div>
    );
  }
}
