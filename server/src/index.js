import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import { config } from './config.js';
import { AuditRepository } from './repositories/AuditRepository.js';
import { AIService } from './services/AIService.js';
import { AIWorkerService } from './services/AIWorkerService.js';
import { AuditController } from './controllers/AuditController.js';
import { buildAuditRouter } from './routes/auditRoutes.js';
import { HttpError } from './utils/errors.js';

async function main() {
  await mongoose.connect(config.mongoUri);
  console.log(`[db] connected: ${config.mongoUri}`);

  // Manual dependency injection keeps each class independently testable.
  const repository = new AuditRepository();
  const aiService = new AIService(config.ai);
  const worker = new AIWorkerService({ repository, aiService, ...config.worker });
  const controller = new AuditController({ repository, defaultTenantId: config.defaultTenantId });

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '100kb' }));
  app.use('/api', buildAuditRouter(controller));

  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.name === 'ValidationError' || err.name === 'CastError') return res.status(400).json({ error: err.message });
    if (err.code === 11000) return res.status(409).json({ error: 'Duplicate evidenceId' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  const server = app.listen(config.port, () => console.log(`[api] http://localhost:${config.port}/api`));
  worker.start();

  const shutdown = async () => {
    console.log('\n[shutdown] stopping...');
    server.close();
    await worker.stop();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal startup error:', err.message);
  process.exit(1);
});
