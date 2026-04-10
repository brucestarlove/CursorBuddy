/**
 * Observation Cache — Short-term perception memory
 *
 * Caches screen analysis results so follow-up questions about the same
 * screen state don't re-analyze. Detects when a fresh capture is needed
 * based on the query, elapsed time, or explicit user cues.
 *
 * Designed to be flushable to a remote memory pool later — each entry
 * has a stable schema matching ObservationResult from contracts.js.
 */

const log = require("../lib/session-logger.js");

// ── Cache Configuration ──────────────────────────────────────

const DEFAULT_TTL_MS = 15000;  // 15 seconds — screen state changes fast
const MAX_ENTRIES = 10;        // keep last N observations

// ── Cache Store ──────────────────────────────────────────────

/**
 * @typedef {Object} CacheEntry
 * @property {string} requestId
 * @property {import('../lib/contracts.js').ObservationResult} observation
 * @property {number} timestamp     - Date.now() when captured
 * @property {number} screenCount   - how many screens were in the capture
 * @property {string} queryHint     - the user query that triggered this analysis
 */

/** @type {CacheEntry[]} */
let cache = [];

// ── Recapture Detection ──────────────────────────────────────
// Patterns that imply the user expects fresh screen state

const RECAPTURE_PATTERNS = [
  /\bnow\b/i,
  /\bwhat changed\b/i,
  /\bwhat('s| is) different\b/i,
  /\brefresh\b/i,
  /\bupdate\b/i,
  /\bagain\b/i,
  /\blook again\b/i,
  /\bcheck again\b/i,
  /\bnew screenshot\b/i,
  /\bcurrent(ly)?\b/i,
  /\bafter\b/i,
  /\bdid (it|that) (work|change|happen)\b/i,
  /\bis it (open|closed|visible|there|gone)\b/i,
];

/**
 * Determine whether a query needs fresh screenshots or can use cached observations.
 *
 * @param {string} query - user's message
 * @param {object} [opts]
 * @param {number} [opts.ttlMs] - override TTL
 * @returns {{ useCached: boolean, reason: string }}
 */
function shouldRecapture(query, opts = {}) {
  const ttl = opts.ttlMs || DEFAULT_TTL_MS;
  const text = (query || "").trim();

  // No cache at all
  if (cache.length === 0) {
    return { useCached: false, reason: "no_cache" };
  }

  const latest = cache[cache.length - 1];
  const age = Date.now() - latest.timestamp;

  // TTL expired
  if (age > ttl) {
    return { useCached: false, reason: `stale (${Math.round(age / 1000)}s old)` };
  }

  // Query explicitly asks for fresh state
  for (const pattern of RECAPTURE_PATTERNS) {
    if (pattern.test(text)) {
      return { useCached: false, reason: `recapture_cue: ${pattern.source.slice(0, 25)}` };
    }
  }

  // Cache is fresh and no recapture cue — reuse
  return { useCached: true, reason: `cached (${Math.round(age / 1000)}s old)` };
}

// ── Cache Operations ─────────────────────────────────────────

/**
 * Store an observation result.
 */
function store(observation, query) {
  const entry = {
    requestId: observation.requestId,
    observation,
    timestamp: Date.now(),
    screenCount: observation.apps.length + observation.windows.length + observation.elements.length,
    queryHint: (query || "").slice(0, 100),
  };

  cache.push(entry);

  // Evict old entries
  if (cache.length > MAX_ENTRIES) {
    cache = cache.slice(-MAX_ENTRIES);
  }

  log.event("observation_cache:store", {
    requestId: observation.requestId,
    cacheSize: cache.length,
    confidence: observation.confidence,
  });
}

/**
 * Get the most recent cached observation, if fresh enough.
 * Returns null if cache is empty or stale.
 */
function getLatest(query, opts = {}) {
  const decision = shouldRecapture(query, opts);

  log.event("observation_cache:lookup", {
    useCached: decision.useCached,
    reason: decision.reason,
    cacheSize: cache.length,
  });

  if (!decision.useCached) return null;

  return cache[cache.length - 1].observation;
}

/**
 * Get all cached observations (for flushing to remote memory).
 * @returns {CacheEntry[]}
 */
function getAll() {
  return [...cache];
}

/**
 * Flush the cache and return all entries (for sending to remote memory pool).
 * @returns {CacheEntry[]}
 */
function flush() {
  const entries = [...cache];
  cache = [];
  log.event("observation_cache:flush", { flushedCount: entries.length });
  return entries;
}

/**
 * Clear the cache without returning entries.
 */
function clear() {
  const count = cache.length;
  cache = [];
  log.event("observation_cache:clear", { clearedCount: count });
}

/**
 * Get cache stats.
 */
function stats() {
  return {
    size: cache.length,
    oldestAge: cache.length > 0 ? Date.now() - cache[0].timestamp : null,
    newestAge: cache.length > 0 ? Date.now() - cache[cache.length - 1].timestamp : null,
  };
}

module.exports = { store, getLatest, getAll, flush, clear, stats, shouldRecapture };
