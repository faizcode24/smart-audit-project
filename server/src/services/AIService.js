const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export const levelFor = (score) =>
  score >= 75 ? 'CRITICAL' : score >= 50 ? 'HIGH' : score >= 25 ? 'MEDIUM' : 'LOW';

export const ALLOWED_FLAGS = [
  'MONETARY_THRESHOLD_EXCEEDED',
  'LARGE_VALUE_TRANSACTION',
  'MANUAL_OVERRIDE_DETECTED',
  'UNUSUAL_DESCRIPTION_PATTERN',
  'ROUND_AMOUNT_PATTERN',
  'POSSIBLE_THRESHOLD_AVOIDANCE',
  'SEGREGATION_OF_DUTIES_RISK',
  'OFF_CYCLE_ACTIVITY',
];

// ----------------------------------------------------------------------------
// Mock semantic embedding (8-D, deterministic, L2-normalised)
// Each axis is an audit "theme"; a small hashed-token component keeps similar but
// not identical descriptions distinguishable. Always computed locally (even with a
// live LLM) so all vectors share one space and remain comparable.
// ----------------------------------------------------------------------------
export const VECTOR_DIM = 8;
const THEMES = [
  ['override', 'overrid', 'bypass', 'waive', 'exception'], // 0 control circumvention
  ['approval', 'approve', 'authoriz', 'authoris', 'sign-off', 'signoff'], // 1 authorisation
  ['vendor', 'invoice', 'payable', 'supplier', 'payment', 'payee', 'wire'], // 2 payables
  ['threshold', 'limit', 'exceed', 'above', 'under'], // 3 limits
  ['manual', 'ad-hoc', 'adhoc', 'off-cycle', 'outside'], // 4 manual / off-process
  ['duplicate', 'split', 'repeat', 'multiple', 'backdat'], // 5 structuring / duplication
  ['urgent', 'emergency', 'rush', 'expedite', 'immediate'], // 6 urgency
  ['adjust', 'reversal', 'reverse', 'write-off', 'journal', 'correction', 'accrual'], // 7 ledger adjustments
];

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function buildSemanticVector(text = '') {
  const t = String(text).toLowerCase();
  const v = THEMES.map((words) => Math.min(1, words.filter((w) => t.includes(w)).length / 2) * 0.85);
  for (const tok of t.split(/[^a-z0-9$]+/).filter(Boolean)) v[fnv1a(tok) % VECTOR_DIM] += 0.02;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (norm === 0) return new Array(VECTOR_DIM).fill(Number((1 / Math.sqrt(VECTOR_DIM)).toFixed(4)));
  return v.map((x) => Number((x / norm).toFixed(4)));
}

// ----------------------------------------------------------------------------
// Local AI evaluator: deterministic rules + simulated latency. Also acts as the
// baseline signal source for the live LLM and as its fallback.
// ----------------------------------------------------------------------------
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export class LocalAIEvaluator {
  constructor(delayMs = 400) {
    this.delayMs = delayMs;
  }

  /** Synchronous rule evaluation (no delay). */
  assess(entry) {
    const amount = Number(entry.monetaryImpact) || 0;
    const desc = String(entry.description || '');
    const text = desc.toLowerCase();
    const flags = [];

    let score = amount >= 250000 ? 50 : amount >= 100000 ? 42 : amount >= 50000 ? 35 : amount >= 10000 ? 20 : 5;
    if (amount >= 50000) flags.push('MONETARY_THRESHOLD_EXCEEDED');
    if (amount >= 250000) flags.push('LARGE_VALUE_TRANSACTION');

    if (/manual|overrid|bypass|waive/.test(text)) {
      flags.push('MANUAL_OVERRIDE_DETECTED');
      score += 15;
    }
    if (/split|duplicate|backdat|off-cycle|urgent|emergency|write-off|after period close|new beneficiary|outside/.test(text) || desc.trim().length < 20) {
      flags.push('UNUSUAL_DESCRIPTION_PATTERN');
      score += 15;
    }
    if (amount >= 10000 && amount % 1000 === 0) {
      flags.push('ROUND_AMOUNT_PATTERN');
      score += 5;
    }

    const riskScore = clamp(score, 0, 100);
    const riskLevel = levelFor(riskScore);
    return { riskScore, riskLevel, anomalyFlags: flags, aiSummary: this.#summarise(entry, amount, riskLevel, flags) };
  }

  /** Same as assess() but with the simulated LLM processing delay. */
  async evaluate(entry) {
    await sleep(this.delayMs);
    return this.assess(entry);
  }

  #summarise(entry, amount, level, flags) {
    const reasons = [];
    if (flags.includes('MANUAL_OVERRIDE_DETECTED')) reasons.push('a manual override of the standard control path');
    if (flags.includes('MONETARY_THRESHOLD_EXCEEDED')) reasons.push('a value above the $50,000 approval threshold');
    if (flags.includes('UNUSUAL_DESCRIPTION_PATTERN')) reasons.push('an unusual description pattern');
    if (flags.includes('ROUND_AMOUNT_PATTERN') && reasons.length < 3) reasons.push('a round-figure amount');
    const first = `${level} risk: ${usd.format(amount)} recorded against ${entry.controlId}${
      reasons.length ? ` with ${reasons.join(', ')}` : ' with no notable anomaly signals'
    }.`;
    const second =
      level === 'CRITICAL' || level === 'HIGH'
        ? 'Independent re-approval and supporting documentation should be verified.'
        : level === 'MEDIUM'
          ? 'Include in the next periodic sample review.'
          : 'Within normal operating parameters.';
    return `${first} ${second}`;
  }
}

// ----------------------------------------------------------------------------
// Live LLM evaluator (OpenAI-compatible: OpenAI, Groq, Azure-compatible gateways)
// ----------------------------------------------------------------------------
class RateLimiter {
  /** Spaces calls evenly: at most `rpm` calls per minute per process. */
  constructor(rpm) {
    this.gap = 60000 / Math.max(1, rpm);
    this.nextSlot = 0;
  }
  async acquire() {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.gap;
    if (slot > now) await sleep(slot - now);
  }
}

class LLMError extends Error {
  constructor(message, { retryable = false, retryAfterMs = 0 } = {}) {
    super(message);
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

export class OpenAIEvaluator {
  constructor({ openaiApiKey, baseUrl, model, maxRequestsPerMinute, maxRetries, timeoutMs }) {
    this.apiKey = openaiApiKey;
    this.baseUrl = baseUrl;
    this.model = model;
    this.maxRetries = maxRetries;
    this.timeoutMs = timeoutMs;
    this.limiter = new RateLimiter(maxRequestsPerMinute);
  }

  async assess(entry) {
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        await this.limiter.acquire();
        return await this.#callOnce(entry);
      } catch (err) {
        lastError = err;
        if (!err.retryable || attempt === this.maxRetries) break;
        const backoff = Math.min(8000, 500 * 2 ** attempt) + Math.random() * 250;
        await sleep(Math.max(backoff, err.retryAfterMs || 0));
      }
    }
    throw lastError;
  }

  async #callOnce(entry) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'You are a senior internal-audit risk analyst. Assess ONE audit evidence record. ' +
                'Respond with JSON only: {"riskScore": integer 0-100, "aiSummary": string (1-2 sentences on why this is or is not an audit risk), ' +
                `"anomalyFlags": array chosen only from ${JSON.stringify(ALLOWED_FLAGS)}}.`,
            },
            {
              role: 'user',
              content: JSON.stringify({
                monetaryImpact: entry.monetaryImpact,
                description: entry.description,
                controlId: entry.controlId,
                entityName: entry.entityName,
                eventType: entry.eventType,
              }),
            },
          ],
        }),
      });

      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get('retry-after'));
        throw new LLMError(`LLM HTTP ${res.status}`, { retryable: true, retryAfterMs: Number.isFinite(ra) ? ra * 1000 : 0 });
      }
      if (!res.ok) throw new LLMError(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

      const data = await res.json();
      let parsed;
      try {
        parsed = JSON.parse(data.choices?.[0]?.message?.content ?? '');
      } catch {
        throw new LLMError('LLM returned non-JSON content', { retryable: true });
      }
      const score = Number(parsed.riskScore);
      if (!Number.isFinite(score) || typeof parsed.aiSummary !== 'string') {
        throw new LLMError('LLM JSON missing riskScore/aiSummary', { retryable: true });
      }
      return {
        riskScore: clamp(Math.round(score), 0, 100),
        aiSummary: parsed.aiSummary.trim().slice(0, 500),
        anomalyFlags: (Array.isArray(parsed.anomalyFlags) ? parsed.anomalyFlags : []).filter((f) => ALLOWED_FLAGS.includes(f)),
      };
    } catch (err) {
      if (err instanceof LLMError) throw err;
      // network error / abort (timeout) -> retryable
      throw new LLMError(err.name === 'AbortError' ? 'LLM request timed out' : `LLM network error: ${err.message}`, { retryable: true });
    } finally {
      clearTimeout(timer);
    }
  }
}

// ----------------------------------------------------------------------------
// Facade used by the worker
// ----------------------------------------------------------------------------
export class AIService {
  constructor(aiConfig) {
    this.config = aiConfig;
    this.useMock = aiConfig.mock || !aiConfig.openaiApiKey;
    this.local = new LocalAIEvaluator(aiConfig.simulatedDelayMs);
    this.llm = this.useMock ? null : new OpenAIEvaluator(aiConfig);
  }

  get engineName() {
    return this.useMock ? 'mock-local' : `openai-compatible:${this.config.model}`;
  }

  /**
   * Full enrichment: { riskScore, riskLevel, aiSummary, anomalyFlags, semanticVector, engine, warning }.
   * Never throws for LLM trouble: falls back to the local evaluator and reports a warning.
   */
  async analyze(entry) {
    const semanticVector = buildSemanticVector(entry.description);

    if (this.useMock) {
      const r = await this.local.evaluate(entry);
      return { ...r, semanticVector, engine: 'mock-local', warning: null };
    }

    const baseline = this.local.assess(entry);
    try {
      const llm = await this.llm.assess(entry);
      const flags = [...new Set([...llm.anomalyFlags, ...baseline.anomalyFlags.filter((f) => f === 'MONETARY_THRESHOLD_EXCEEDED')])];
      return {
        riskScore: llm.riskScore,
        riskLevel: levelFor(llm.riskScore), // derived server-side so score and level never disagree
        aiSummary: llm.aiSummary,
        anomalyFlags: flags,
        semanticVector,
        engine: this.engineName,
        warning: null,
      };
    } catch (err) {
      console.warn(`[AIService] LLM failed, using local fallback: ${err.message}`);
      return { ...baseline, semanticVector, engine: 'fallback-local', warning: `LLM fallback: ${err.message}` };
    }
  }
}
