import { Router } from 'express';

// Express 4 doesn't catch async errors by itself.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function buildAuditRouter(controller) {
  const router = Router();
  router.post('/audit-entries', wrap(controller.create));
  router.get('/audit-entries', wrap(controller.list));
  router.get('/audit-entries/:id', wrap(controller.getOne));
  router.put('/audit-entries/:id', wrap(controller.update));
  router.post('/audit-entries/:id/similar', wrap(controller.similar));
  router.get('/health', (_req, res) => res.json({ ok: true }));
  return router;
}
