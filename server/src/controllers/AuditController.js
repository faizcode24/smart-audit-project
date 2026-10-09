import mongoose from 'mongoose';
import { HttpError } from '../utils/errors.js';
import { cosineSimilarity, topK } from '../utils/vector.js';

/** Changing any of these invalidates AI output => re-queue. */
export const CORE_FIELDS = ['monetaryImpact', 'description', 'controlId'];
/** Changing only these never needs AI => fast track. */
export const FAST_FIELDS = ['auditorNotes', 'entityName', 'eventType', 'actorUserId'];

const REQUIRED_TEXT = new Set(['description', 'controlId', 'entityName']);

function normalize(field, value) {
  if (field === 'monetaryImpact') {
    const n = typeof value === 'string' ? Number(value.trim()) : value;
    if (value === '' || value === null || typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
      throw new HttpError(400, 'monetaryImpact must be a non-negative number');
    }
    return n;
  }
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string`);
  const s = value.trim();
  if (REQUIRED_TEXT.has(field) && !s) throw new HttpError(400, `${field} must not be empty`);
  return s;
}

const currentValue = (entry, field) => (field === 'auditorNotes' ? entry.aiMetadata?.auditorNotes ?? '' : entry[field]);

export class AuditController {
  constructor({ repository, defaultTenantId }) {
    this.repository = repository;
    this.tenantId = new mongoose.Types.ObjectId(defaultTenantId);
  }

  #requireId(id) {
    if (!mongoose.isValidObjectId(id)) throw new HttpError(400, 'Invalid entry id');
    return id;
  }

  // POST /api/audit-entries  -> saved immediately as PENDING, enriched later by the worker
  create = async (req, res) => {
    const body = req.body ?? {};
    const data = {};
    for (const f of [...CORE_FIELDS, 'entityName']) {
      if (body[f] === undefined) throw new HttpError(400, `${f} is required`);
      data[f] = normalize(f, body[f]);
    }
    for (const f of ['eventType', 'actorUserId']) if (body[f] !== undefined) data[f] = normalize(f, body[f]);

    const entry = await this.repository.create({
      ...data,
      evidenceId: body.evidenceId ? String(body.evidenceId) : `EVID-${Math.floor(100000 + Math.random() * 900000)}`,
      timestamp: body.timestamp ? new Date(body.timestamp) : new Date(),
      tenantId: this.tenantId,
      // aiMetadata intentionally NOT accepted from clients: only the worker writes AI fields.
      ...(body.auditorNotes ? { aiMetadata: { auditorNotes: String(body.auditorNotes).trim() } } : {}),
    });
    res.status(201).json(entry);
  };

  // GET /api/audit-entries
  list = async (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    res.json({ data: await this.repository.findAll(this.tenantId, limit) });
  };

  // GET /api/audit-entries/:id
  getOne = async (req, res) => {
    const entry = await this.repository.findById(this.#requireId(req.params.id));
    if (!entry) throw new HttpError(404, 'Audit entry not found');
    res.json(entry);
  };

  /**
   * PUT /api/audit-entries/:id  -- smart delta evaluation.
   * Compares incoming values with persisted values (not just "was the key sent"):
   *   core field actually changed        -> AI_REQUEUE (status PENDING, version bump)
   *   only notes / light metadata change -> FAST_TRACK (atomic $set, AI untouched)
   *   nothing changed                    -> NO_CHANGE  (no write)
   * Clients can safely PUT the whole form: unchanged core fields never trigger AI.
   */
  update = async (req, res) => {
    const id = this.#requireId(req.params.id);
    const existing = await this.repository.findById(id);
    if (!existing) throw new HttpError(404, 'Audit entry not found');

    const body = req.body ?? {};
    const coreChanges = {};
    const fastChanges = {};
    for (const f of CORE_FIELDS) {
      if (body[f] === undefined) continue;
      const v = normalize(f, body[f]);
      if (v !== existing[f]) coreChanges[f] = v;
    }
    for (const f of FAST_FIELDS) {
      if (body[f] === undefined) continue;
      const v = normalize(f, body[f]);
      if (v !== currentValue(existing, f)) fastChanges[f] = v;
    }

    const coreChanged = Object.keys(coreChanges).length > 0;
    const fastChanged = Object.keys(fastChanges).length > 0;

    let path = 'NO_CHANGE';
    let entry = existing;
    if (coreChanged) {
      path = 'AI_REQUEUE';
      entry = await this.repository.applyCoreEdit(id, coreChanges, fastChanges);
    } else if (fastChanged) {
      path = 'FAST_TRACK';
      entry = await this.repository.applyFastTrackEdit(id, fastChanges);
    }

    res.json({
      path,
      aiRecomputed: path === 'AI_REQUEUE',
      changedFields: [...Object.keys(coreChanges), ...Object.keys(fastChanges)],
      entry,
    });
  };

  // POST /api/audit-entries/:id/similar   body: { limit?: number (default 3), minRiskScore?: number }
  similar = async (req, res) => {
    const id = this.#requireId(req.params.id);
    const limit = Math.min(10, Math.max(1, Number(req.body?.limit) || 3));
    const minRiskScore = Number(req.body?.minRiskScore) || 0;

    const target = await this.repository.findById(id);
    if (!target) throw new HttpError(404, 'Audit entry not found');
    const vector = target.aiMetadata?.semanticVector ?? [];
    if (target.aiMetadata?.status !== 'COMPLETED' || vector.length === 0) {
      throw new HttpError(409, 'This entry has no semantic vector yet. Wait for AI enrichment to complete.');
    }

    // Candidates are tenant-scoped, completed, and projected to the minimum fields.
    const candidates = await this.repository.findSimilarityCandidates(target.tenantId, target._id, minRiskScore);
    const ranked = topK(candidates, limit, (c) => cosineSimilarity(vector, c.aiMetadata.semanticVector));

    res.json({
      sourceId: id,
      method: 'cosine',
      comparedAgainst: candidates.length,
      results: ranked.map(({ item: c, score }) => ({
        _id: c._id,
        evidenceId: c.evidenceId,
        entityName: c.entityName,
        description: c.description,
        monetaryImpact: c.monetaryImpact,
        controlId: c.controlId,
        riskScore: c.aiMetadata.riskScore,
        riskLevel: c.aiMetadata.riskLevel,
        aiSummary: c.aiMetadata.aiSummary,
        anomalyFlags: c.aiMetadata.anomalyFlags,
        similarity: Number(score.toFixed(4)),
      })),
    });
  };
}
