import type { Request, Response } from 'express';

export function registerHealthRoute(app: import('express').Express) {
  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });
}
