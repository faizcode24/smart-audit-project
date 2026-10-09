import mongoose from 'mongoose';

const { Schema } = mongoose;

export const AI_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
});

/**
 * Baseline evidence is kept decoupled from AI intelligence (aiMetadata).
 * Operational fields (version, attempts, runCount, ...) live inside aiMetadata so
 * every AI write is a targeted $set on aiMetadata.* and never touches evidence.
 */
const AuditEntrySchema = new Schema(
  {
    timestamp: { type: Date, default: Date.now },
    eventType: { type: String, default: 'Control Execution' },
    evidenceId: { type: String, required: true, unique: true },
    entityName: { type: String, required: true },
    description: { type: String, required: true },
    monetaryImpact: { type: Number, required: true, min: 0 },
    controlId: { type: String, required: true },
    actorUserId: { type: String, default: 'unknown' },
    tenantId: { type: Schema.Types.ObjectId, required: true, index: true },

    aiMetadata: {
      status: { type: String, enum: Object.values(AI_STATUS), default: AI_STATUS.PENDING },
      riskScore: { type: Number, default: null },
      riskLevel: { type: String, default: null },
      aiSummary: { type: String, default: null },
      anomalyFlags: { type: [String], default: [] },
      semanticVector: { type: [Number], default: [] },
      auditorNotes: { type: String, default: '' },

      // --- queue / observability fields ---
      version: { type: Number, default: 1 }, // bumped on each core edit (optimistic concurrency token)
      attempts: { type: Number, default: 0 }, // claim attempts for the current version
      runCount: { type: Number, default: 0 }, // successful AI enrichments, ever
      engine: { type: String, default: null }, // which engine produced the result
      lastError: { type: String, default: null },
      processingStartedAt: { type: Date, default: null },
      nextAttemptAt: { type: Date, default: null }, // retry backoff
      completedAt: { type: Date, default: null },
    },
  },
  { timestamps: { createdAt: 'created', updatedAt: 'updated' }, minimize: false }
);

// Worker claim query: status + backoff + FIFO ordering.
AuditEntrySchema.index({ 'aiMetadata.status': 1, 'aiMetadata.nextAttemptAt': 1, created: 1 });
AuditEntrySchema.index({ tenantId: 1, created: -1 });

export const AuditEntry = mongoose.model('AuditEntry', AuditEntrySchema);
