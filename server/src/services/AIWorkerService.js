const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Background worker that polls MongoDB for PENDING records.
 *  - claim is an atomic PENDING -> PROCESSING transition (safe with multiple instances)
 *  - results are written with $set pinned to the claimed version (stale results are dropped)
 *  - failures retry with exponential backoff, then end in FAILED
 *  - records orphaned in PROCESSING (crash) are reclaimed after `staleAfterMs`
 */
export class AIWorkerService {
  constructor({ repository, aiService, pollIntervalMs, concurrency, staleAfterMs, maxAttempts }) {
    this.repository = repository;
    this.aiService = aiService;
    this.pollIntervalMs = pollIntervalMs;
    this.concurrency = concurrency;
    this.staleAfterMs = staleAfterMs;
    this.maxAttempts = maxAttempts;
    this.running = false;
    this.loopPromise = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.#loop();
    console.log(`[worker] started (engine=${this.aiService.engineName}, concurrency=${this.concurrency})`);
  }

  async stop() {
    this.running = false;
    await this.loopPromise;
  }

  async #loop() {
    while (this.running) {
      let processed = 0;
      try {
        const released = await this.repository.releaseStale(this.staleAfterMs);
        if (released) console.warn(`[worker] released ${released} stale record(s)`);
        processed = await this.tick();
      } catch (err) {
        console.error('[worker] tick failed:', err.message);
      }
      if (processed === 0) await sleep(this.pollIntervalMs); // busy => drain queue without waiting
    }
  }

  /** Claim and process up to `concurrency` records in parallel. Returns number claimed. */
  async tick() {
    const claimed = [];
    for (let i = 0; i < this.concurrency; i++) {
      const doc = await this.repository.claimNextPending();
      if (!doc) break;
      claimed.push(doc);
    }
    await Promise.allSettled(claimed.map((doc) => this.#process(doc)));
    return claimed.length;
  }

  async #process(doc) {
    const { _id: id } = doc;
    const { version, attempts } = doc.aiMetadata;
    try {
      const result = await this.aiService.analyze(doc);
      const applied = await this.repository.completeEnrichment(id, version, result);
      console.log(
        applied
          ? `[worker] ${doc.evidenceId} -> ${result.riskLevel} (${result.riskScore}) via ${result.engine}`
          : `[worker] ${doc.evidenceId} edited during processing; stale result discarded`
      );
    } catch (err) {
      const final = attempts >= this.maxAttempts;
      const retryAt = new Date(Date.now() + Math.min(30000, 1000 * 2 ** attempts));
      await this.repository.recordFailure(id, version, { error: err.message, final, retryAt });
      console.error(`[worker] ${doc.evidenceId} failed (attempt ${attempts}/${this.maxAttempts}): ${err.message}`);
    }
  }
}
