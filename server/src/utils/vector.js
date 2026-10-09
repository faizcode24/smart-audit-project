/** Cosine similarity of two equal-length numeric vectors (0 when undefined). */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Streaming top-k selection: O(n * k) time, O(k) memory,
 * so we never sort or hold the full scored candidate list.
 */
export function topK(items, k, scoreFn) {
  const best = [];
  for (const item of items) {
    const score = scoreFn(item);
    if (best.length < k || score > best[best.length - 1].score) {
      best.push({ item, score });
      best.sort((x, y) => y.score - x.score);
      if (best.length > k) best.pop();
    }
  }
  return best;
}
