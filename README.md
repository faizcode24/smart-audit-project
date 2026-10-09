# AI-Enriched Continuous Audit Pipeline (MERN)

Audit evidence is saved instantly as `PENDING`, then a background worker enriches it with a risk score, an AI summary, anomaly flags and an 8-D semantic vector. Edits are routed by what changed: core financial fields re-run the AI, auditor notes do not.

## Quick start

Requires Node 18.18+ and a MongoDB instance.

```bash
cp .env.example .env            # MOCK_AI=true works with no API key
docker run -d -p 27017:27017 --name audit-mongo mongo:7   # or use any local/Atlas MongoDB (set MONGO_URI)
npm run install:all             # root + server + client dependencies
npm run seed                    # 5 sample entries, saved as PENDING
npm run dev                     # API on :4000, UI on http://localhost:5173
```

Run `npm --prefix server test` for the logic tests (no database needed).

## Environment (`.env.example`)

| Variable | Purpose |
|---|---|
| `MOCK_AI=true` | Local AI engine with a simulated 400ms delay. Set `false` and provide `OPENAI_API_KEY` for a live LLM. |
| `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL` | Any OpenAI-compatible API (OpenAI, Groq, ...). |
| `AI_MAX_REQUESTS_PER_MINUTE`, `AI_MAX_RETRIES`, `AI_TIMEOUT_MS` | LLM rate limit, retries, timeout. |
| `MONGO_URI`, `PORT`, `DEFAULT_TENANT_ID` | Infrastructure (auth/multi-tenancy is out of scope; a fixed tenant is used). |
| `WORKER_*` | Poll interval, concurrency, stale-claim timeout, max attempts. |

## API

| Method | Path | Behaviour |
|---|---|---|
| POST | `/api/audit-entries` | Save immediately with `aiMetadata.status = "PENDING"` |
| GET | `/api/audit-entries` | List (newest first) |
| PUT | `/api/audit-entries/:id` | Smart delta: returns `path` = `AI_REQUEUE`, `FAST_TRACK` or `NO_CHANGE` |
| POST | `/api/audit-entries/:id/similar` | Top 3 (configurable `limit`) by cosine similarity |

```bash
curl -X POST localhost:4000/api/audit-entries -H 'Content-Type: application/json' \
  -d '{"entityName":"Treasury","controlId":"CTRL-TRS-9","monetaryImpact":120000,"description":"Manual override of payment limit"}'
curl -X PUT localhost:4000/api/audit-entries/<id> -H 'Content-Type: application/json' -d '{"auditorNotes":"Reviewed"}'   # FAST_TRACK
curl -X PUT localhost:4000/api/audit-entries/<id> -H 'Content-Type: application/json' -d '{"monetaryImpact":5000}'        # AI_REQUEUE
```

## Structure

```
server/src
  controllers/AuditController.js   HTTP layer + delta evaluation + similarity endpoint
  repositories/AuditRepository.js  all Mongo access (targeted $set / $inc only)
  services/AIService.js            local evaluator, OpenAI-compatible evaluator, vector builder, fallback
  services/AIWorkerService.js      polling worker loop
client/src/AuditDashboard.jsx      React class component UI
```

## Design decisions (for the technical review)

**AI workload integration.** `AIService` picks the engine from `MOCK_AI` / `OPENAI_API_KEY`. The live path has a per-process rate limiter (even spacing, `AI_MAX_REQUESTS_PER_MINUTE`), a request timeout, exponential backoff with jitter on 429/5xx/timeouts (honouring `Retry-After`), and strict validation of the JSON response (score clamped, flags whitelisted). If the LLM still fails, it falls back to the local engine and records `aiMetadata.engine = "fallback-local"` and `lastError`, so one provider outage does not block the queue. `riskLevel` is always derived from `riskScore` on the server so they cannot disagree. The embedding is always the local deterministic 8-D vector, so vectors from different engines live in one comparable space.

**Asynchronous architecture.** The queue is MongoDB status polling: simple, durable, no extra infrastructure. Claiming is an atomic `findOneAndUpdate` (`PENDING -> PROCESSING`), so several worker instances are safe. Failures retry with backoff (`nextAttemptAt`) and end in `FAILED` after `WORKER_MAX_ATTEMPTS`; records stuck in `PROCESSING` after a crash are released after `WORKER_STALE_AFTER_MS`. Trade-off: polling adds up to one poll interval of latency and load grows with queue depth; at higher scale I would move to BullMQ/SQS with the same worker contract.

**Delta evaluation and fast-tracking.** The controller compares incoming values with the persisted values, not just which keys were sent. So the UI can PUT the whole form and unchanged core fields still skip the AI. Only a real change to `monetaryImpact`, `description` or `controlId` re-queues. Everything else (`auditorNotes`, entity name, ...) is one atomic `$set`, with no status change and no AI call. `aiMetadata.runCount` makes this visible: it only increases when the AI actually ran.

**Concurrency safety.** Each core edit bumps `aiMetadata.version`. The worker writes results only if the version it processed is still current, so an edit made mid-processing can never be overwritten by a stale AI result. AI writes touch `aiMetadata.*` only, and clients cannot write AI fields, so evidence and AI output never clobber each other.

**Vector match performance.** Vectors are unit-normalised 8-D arrays stored on the document. `/similar` fetches only completed, tenant-scoped candidates with a projection (no full documents), scores cosine similarity in-process and keeps a streaming top-k (O(n·k), O(k) memory). That is fine for thousands of records. Beyond that, swap the candidate step for MongoDB Atlas `$vectorSearch` (HNSW index on `aiMetadata.semanticVector`) behind the same repository method; the controller does not change.

## Known limitations

- The dashboard polls every 2s rather than using SSE/WebSockets.
- No authentication; one default tenant.
- Mock embeddings are keyword-theme based, not a real language model.
