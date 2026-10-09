import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { AIService, buildSemanticVector } from '../src/services/AIService.js';
import { AIWorkerService } from '../src/services/AIWorkerService.js';
import { AuditController } from '../src/controllers/AuditController.js';
import { cosineSimilarity } from '../src/utils/vector.js';

const aiCfg = { mock: true, openaiApiKey: '', simulatedDelayMs: 0 };
const TENANT = '64b000000000000000000001';

/** Minimal in-memory stand-in for AuditRepository (same method contract). */
class FakeRepo {
  constructor() { this.docs = new Map(); this.calls = []; }
  seed(doc) { const _id = new mongoose.Types.ObjectId().toString(); const d = { _id, tenantId: TENANT, aiMetadata: { status: 'PENDING', version: 1, attempts: 0, runCount: 0, auditorNotes: '', semanticVector: [] }, ...doc }; this.docs.set(_id, d); return d; }
  async findById(id) { return this.docs.get(String(id)) ?? null; }
  async applyFastTrackEdit(id, f) { this.calls.push('fast'); const d = this.docs.get(id); const { auditorNotes, ...rest } = f; Object.assign(d, rest); if (auditorNotes !== undefined) d.aiMetadata.auditorNotes = auditorNotes; return d; }
  async applyCoreEdit(id, c, f = {}) { this.calls.push('core'); const d = this.docs.get(id); Object.assign(d, c); if (f.auditorNotes !== undefined) d.aiMetadata.auditorNotes = f.auditorNotes; d.aiMetadata.status = 'PENDING'; d.aiMetadata.version++; return d; }
  async claimNextPending() { const d = [...this.docs.values()].find((x) => x.aiMetadata.status === 'PENDING'); if (!d) return null; d.aiMetadata.status = 'PROCESSING'; d.aiMetadata.attempts++; return structuredClone(d); }
  async releaseStale() { return 0; }
  async completeEnrichment(id, version, r) { const d = this.docs.get(String(id)); if (d.aiMetadata.version !== version || d.aiMetadata.status !== 'PROCESSING') return false; Object.assign(d.aiMetadata, { status: 'COMPLETED', riskScore: r.riskScore, riskLevel: r.riskLevel, aiSummary: r.aiSummary, anomalyFlags: r.anomalyFlags, semanticVector: r.semanticVector }); d.aiMetadata.runCount++; return true; }
  async recordFailure() { return true; }
}

const run = (controller, method, req) => new Promise((resolve, reject) => {
  const res = { status() { return this; }, json: resolve };
  controller[method](req, res).catch(reject);
});

test('local AI enrichment: high-value manual override is HIGH+ with flags and an 8-D vector', async () => {
  const ai = new AIService(aiCfg);
  const r = await ai.analyze({ monetaryImpact: 85000, controlId: 'CTRL-FIN-302', description: 'Manual approval override executed for vendor invoice payables exceeding $50k threshold' });
  assert.ok(['HIGH', 'CRITICAL'].includes(r.riskLevel));
  assert.ok(r.anomalyFlags.includes('MONETARY_THRESHOLD_EXCEEDED'));
  assert.equal(r.semanticVector.length, 8);
  assert.ok(r.aiSummary.length > 20);
});

test('semantic vectors: related descriptions are closer than unrelated ones', () => {
  const a = buildSemanticVector('Manual approval override for vendor invoice above threshold');
  const b = buildSemanticVector('Duplicate vendor invoice payment split to stay under approval limit');
  const c = buildSemanticVector('Routine office supplies purchase');
  assert.ok(cosineSimilarity(a, b) > cosineSimilarity(a, c));
});

test('PUT delta: notes-only edit fast-tracks, core edit re-queues, identical payload is a no-op', async () => {
  const repo = new FakeRepo();
  const worker = new AIWorkerService({ repository: repo, aiService: new AIService(aiCfg), pollIntervalMs: 1, concurrency: 2, staleAfterMs: 1, maxAttempts: 3 });
  const controller = new AuditController({ repository: repo, defaultTenantId: TENANT });
  const doc = repo.seed({ description: 'Manual override of vendor payment', monetaryImpact: 85000, controlId: 'CTRL-FIN-302', entityName: 'GPS' });
  await worker.tick();
  assert.equal(doc.aiMetadata.status, 'COMPLETED');
  assert.equal(doc.aiMetadata.runCount, 1);

  // full-form PUT with only notes changed -> FAST_TRACK, no re-run
  let out = await run(controller, 'update', { params: { id: doc._id }, body: { description: doc.description, monetaryImpact: 85000, controlId: 'CTRL-FIN-302', auditorNotes: 'Reviewed with CFO' } });
  assert.equal(out.path, 'FAST_TRACK');
  assert.equal(doc.aiMetadata.status, 'COMPLETED');
  assert.equal(doc.aiMetadata.auditorNotes, 'Reviewed with CFO');
  assert.equal(await worker.tick(), 0); // nothing queued

  // identical payload -> NO_CHANGE
  out = await run(controller, 'update', { params: { id: doc._id }, body: { monetaryImpact: '85000', auditorNotes: 'Reviewed with CFO' } });
  assert.equal(out.path, 'NO_CHANGE');

  // core change -> AI_REQUEUE then worker re-runs
  out = await run(controller, 'update', { params: { id: doc._id }, body: { monetaryImpact: 5000 } });
  assert.equal(out.path, 'AI_REQUEUE');
  assert.equal(doc.aiMetadata.status, 'PENDING');
  await worker.tick();
  assert.equal(doc.aiMetadata.runCount, 2);
  assert.equal(doc.aiMetadata.riskLevel, 'LOW');
});

test('stale AI result is discarded if a core edit lands mid-processing', async () => {
  const repo = new FakeRepo();
  const ai = new AIService(aiCfg);
  const controller = new AuditController({ repository: repo, defaultTenantId: TENANT });
  const doc = repo.seed({ description: 'Routine invoice', monetaryImpact: 1000, controlId: 'C1', entityName: 'X' });
  const claimed = await repo.claimNextPending();
  const result = await ai.analyze(claimed);
  await run(controller, 'update', { params: { id: doc._id }, body: { monetaryImpact: 900000 } }); // edit during processing
  const applied = await repo.completeEnrichment(claimed._id, claimed.aiMetadata.version, result);
  assert.equal(applied, false);
  assert.equal(doc.aiMetadata.status, 'PENDING');
});

test('similar endpoint returns top-3 by cosine and rejects un-enriched entries', async () => {
  const repo = new FakeRepo();
  const ai = new AIService(aiCfg);
  const worker = new AIWorkerService({ repository: repo, aiService: ai, pollIntervalMs: 1, concurrency: 5, staleAfterMs: 1, maxAttempts: 3 });
  const descs = ['Manual approval override for vendor invoice', 'Duplicate vendor invoice split under approval limit', 'Routine office supplies', 'Emergency manual wire to new beneficiary', 'Payroll accrual adjustment journal'];
  const docs = descs.map((d, i) => repo.seed({ description: d, monetaryImpact: 10000 * (i + 1), controlId: 'C', entityName: 'E' }));
  repo.findSimilarityCandidates = async (_t, ex) => [...repo.docs.values()].filter((d) => d._id !== ex && d.aiMetadata.status === 'COMPLETED');
  const controller = new AuditController({ repository: repo, defaultTenantId: TENANT });
  await assert.rejects(run(controller, 'similar', { params: { id: docs[0]._id }, body: {} }), /no semantic vector/);
  await worker.tick();
  const out = await run(controller, 'similar', { params: { id: docs[0]._id }, body: {} });
  assert.equal(out.results.length, 3);
  assert.ok(out.results[0].similarity >= out.results[1].similarity);
  assert.ok(out.results.every((r) => r.similarity > 0 && r.similarity <= 1));
  assert.ok(!out.results.some((r) => r.description === 'Payroll accrual adjustment journal')); // least related is excluded
});
