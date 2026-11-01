// Закрытая часть STORAGE&MESS — в открытый код не входит.
// Здесь заглушка с тем же интерфейсом: открытая сборка работает без этого механизма.
// Анализ признаков DPI во входящем трафике.
export class DpiAnalyzerService {
  init(): void { /* нет в открытой сборке */ }
  stop(): void { /* нет в открытой сборке */ }
}

export const dpiAnalyzer = new DpiAnalyzerService();
