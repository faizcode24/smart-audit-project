import dns from 'dns';
dns.setServers(['8.8.8.8', '1.1.1.1']);
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Root .env first (documented location), then server/.env as optional override.
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const bool = (v, d) => (v === undefined || v === '' ? d : String(v).toLowerCase() === 'true');
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export const config = {
  port: num(process.env.PORT, 4000),
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/audit_pipeline',
  defaultTenantId: process.env.DEFAULT_TENANT_ID || '64b000000000000000000001',
  ai: {
    mock: bool(process.env.MOCK_AI, true),
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    baseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    maxRequestsPerMinute: num(process.env.AI_MAX_REQUESTS_PER_MINUTE, 30),
    maxRetries: num(process.env.AI_MAX_RETRIES, 3),
    timeoutMs: num(process.env.AI_TIMEOUT_MS, 15000),
    simulatedDelayMs: num(process.env.AI_SIMULATED_DELAY_MS, 400),
  },
  worker: {
    pollIntervalMs: num(process.env.WORKER_POLL_INTERVAL_MS, 1000),
    concurrency: num(process.env.WORKER_CONCURRENCY, 2),
    staleAfterMs: num(process.env.WORKER_STALE_AFTER_MS, 60000),
    maxAttempts: num(process.env.WORKER_MAX_ATTEMPTS, 3),
  },
};
