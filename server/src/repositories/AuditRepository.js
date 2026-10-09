import { AuditEntry, AI_STATUS } from '../models/AuditEntry.js';

// API field -> Mongo path for "fast track" (non-AI) fields.
const FAST_PATHS = {
  auditorNotes: 'aiMetadata.auditorNotes',
  entityName: 'entityName',
  eventType: 'eventType',
  actorUserId: 'actorUserId',
};

const toFastSet = (fields) =>
  Object.fromEntries(Object.entries(fields).map(([k, v]) => [FAST_PATHS[k] ?? k, v]));

/**
 * All persistence lives here. Every mutation after creation is a targeted
 * $set/$inc so baseline evidence is never overwritten by AI writes (and vice versa).
 */
export class AuditRepository {
  async create(data) {
    const doc = await AuditEntry.create(data); // aiMetadata defaults => status PENDING
    return doc.toObject();
  }

  findAll(tenantId, limit = 100) {
    return AuditEntry.find({ tenantId }).sort({ created: -1 }).limit(limit).lean();
  }

  findById(id) {
    return AuditEntry.findById(id).lean();
  }

  /** Completed entries with vectors, projected to only what similarity needs. */
  findSimilarityCandidates(tenantId, excludeId, minRiskScore = 0) {
    return AuditEntry.find(
      {
        tenantId,
        _id: { $ne: excludeId },
        'aiMetadata.status': AI_STATUS.COMPLETED,
        'aiMetadata.riskScore': { $gte: minRiskScore },
        'aiMetadata.semanticVector.0': { $exists: true },
      },
      {
        evidenceId: 1, entityName: 1, description: 1, monetaryImpact: 1, controlId: 1, timestamp: 1,
        'aiMetadata.semanticVector': 1, 'aiMetadata.riskScore': 1, 'aiMetadata.riskLevel': 1,
        'aiMetadata.aiSummary': 1, 'aiMetadata.anomalyFlags': 1,
      }
    ).lean();
  }

  /** Fast track: direct atomic $set. No status change, no version bump, no AI. */
  applyFastTrackEdit(id, fields) {
    return AuditEntry.findByIdAndUpdate(id, { $set: toFastSet(fields) }, { new: true }).lean();
  }

  /**
   * Core edit: $set the changed fields AND re-queue AI (status PENDING).
   * version is bumped so any in-flight worker result for the old content is discarded.
   */
  applyCoreEdit(id, coreFields, fastFields = {}) {
    return AuditEntry.findByIdAndUpdate(
      id,
      {
        $set: {
          ...coreFields,
          ...toFastSet(fastFields),
          'aiMetadata.status': AI_STATUS.PENDING,
          'aiMetadata.attempts': 0,
          'aiMetadata.lastError': null,
          'aiMetadata.nextAttemptAt': null,
          'aiMetadata.processingStartedAt': null,
        },
        $inc: { 'aiMetadata.version': 1 },
      },
      { new: true }
    ).lean();
  }

  // ------------------------- queue operations (worker) -------------------------

  /**
   * Atomically claim the oldest eligible PENDING record (PENDING -> PROCESSING).
   * findOneAndUpdate is atomic per document, so multiple worker instances are safe.
   */
  claimNextPending(now = new Date()) {
    return AuditEntry.findOneAndUpdate(
      {
        'aiMetadata.status': AI_STATUS.PENDING,
        'aiMetadata.nextAttemptAt': { $not: { $gt: now } }, // null, missing, or due
      },
      {
        $set: { 'aiMetadata.status': AI_STATUS.PROCESSING, 'aiMetadata.processingStartedAt': now },
        $inc: { 'aiMetadata.attempts': 1 },
      },
      { new: true, sort: { created: 1 } }
    ).lean();
  }

  /** Crash recovery: records stuck in PROCESSING too long go back to PENDING. */
  async releaseStale(olderThanMs) {
    const cutoff = new Date(Date.now() - olderThanMs);
    const res = await AuditEntry.updateMany(
      { 'aiMetadata.status': AI_STATUS.PROCESSING, 'aiMetadata.processingStartedAt': { $lt: cutoff } },
      { $set: { 'aiMetadata.status': AI_STATUS.PENDING } }
    );
    return res.modifiedCount;
  }

  /**
   * Write AI results with $set on aiMetadata.* only. The filter pins the version we
   * processed; if a core edit landed meanwhile the filter misses and result is dropped.
   * Returns true if the result was applied.
   */
  async completeEnrichment(id, version, r) {
    const res = await AuditEntry.updateOne(
      { _id: id, 'aiMetadata.version': version, 'aiMetadata.status': AI_STATUS.PROCESSING },
      {
        $set: {
          'aiMetadata.status': AI_STATUS.COMPLETED,
          'aiMetadata.riskScore': r.riskScore,
          'aiMetadata.riskLevel': r.riskLevel,
          'aiMetadata.aiSummary': r.aiSummary,
          'aiMetadata.anomalyFlags': r.anomalyFlags,
          'aiMetadata.semanticVector': r.semanticVector,
          'aiMetadata.engine': r.engine,
          'aiMetadata.lastError': r.warning ?? null,
          'aiMetadata.completedAt': new Date(),
          'aiMetadata.processingStartedAt': null,
          'aiMetadata.nextAttemptAt': null,
        },
        $inc: { 'aiMetadata.runCount': 1 },
      }
    );
    return res.modifiedCount === 1;
  }

  /** Retry with backoff (back to PENDING) or give up (FAILED). */
  async recordFailure(id, version, { error, final, retryAt }) {
    const res = await AuditEntry.updateOne(
      { _id: id, 'aiMetadata.version': version, 'aiMetadata.status': AI_STATUS.PROCESSING },
      {
        $set: {
          'aiMetadata.status': final ? AI_STATUS.FAILED : AI_STATUS.PENDING,
          'aiMetadata.lastError': error,
          'aiMetadata.nextAttemptAt': final ? null : retryAt,
          'aiMetadata.processingStartedAt': null,
        },
      }
    );
    return res.modifiedCount === 1;
  }
}
