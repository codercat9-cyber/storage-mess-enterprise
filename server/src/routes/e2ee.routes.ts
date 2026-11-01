// Закрытая часть STORAGE&MESS — в открытый код не входит.
// Здесь заглушка с тем же интерфейсом: открытая сборка работает без этого механизма.
// Сквозное шифрование. Клиент, получив 501, шлёт сообщения как есть.
import { Router, Request, Response } from 'express';

const router = Router();
router.all('*', (_req: Request, res: Response) => {
  res.status(501).json({ error: 'E2EE is not included in the open-source build' });
});

export default router;
