/**
 * Pure state + decision helpers for kv-cache bookkeeping used by
 * `completion-stream.ts`.
 *
 * This module intentionally has **no** `bare-*` imports so it can be
 * exercised directly from unit tests running under `bun` without pulling
 * in the Bare runtime (which is not available in that environment).
 * The file-system-dependent pieces (e.g. `recordCacheSaveCount`) live in
 * `completion-stream.ts` and consume the state exported here.
 */

/**
 * Number of chat messages the kv-cache file on disk is known to cover, keyed
 * by cache path. Written after a successful completion records a save, read
 * by `prepareMessagesForCache` to slice the history on the next turn.
 *
 * INVARIANT: an entry is only present if the corresponding kv-cache file is
 * considered trustworthy. On any turn where the SDK cannot prove the saved
 * count reflects the on-disk state (cancellation mid-decode, zero-token
 * reply, cache file missing after a save attempt), the entry MUST be
 * deleted; a stale entry causes the next turn to slice its history down to
 * an empty payload and the model returns zero tokens.
 */
export const cachedMessageCounts = new Map<string, number>();

/**
 * Monotonic counter of cancel requests per model. `completion()` snapshots
 * the value before running the model and compares afterward to decide
 * whether the turn was cancelled mid-decode. A counter (not a boolean) is
 * used deliberately: a cancel that lands near a turn boundary cannot bleed
 * into the next turn because we always compare snapshots, not values.
 */
const modelCancelCounters = new Map<string, number>();

/**
 * Clear bookkeeping entries. With no argument, clears the whole map. With a
 * `prefix`, removes any entry whose path is equal to it OR sits beneath it
 * as a directory (i.e. `key.startsWith(prefix + "/")`).
 *
 * Path separator is hardcoded to "/" because cache paths in the SDK are
 * always built on POSIX (Bare runs on Linux/macOS/iOS/Android). If a Windows
 * target is ever introduced, callers should pass the platform `path.sep`
 * instead.
 */
export function clearCachedMessageCounts(prefix?: string, sep = "/"): void {
  if (!prefix) {
    cachedMessageCounts.clear();
    return;
  }
  for (const key of cachedMessageCounts.keys()) {
    if (key === prefix) {
      cachedMessageCounts.delete(key);
      continue;
    }
    if (!key.startsWith(prefix + sep)) continue;
    cachedMessageCounts.delete(key);
  }
}

/**
 * Called from `server/bare/ops/cancel.ts` right before `addon.cancel()` so
 * that the in-flight `completion()` for this model can detect that its
 * current turn is being cancelled and skip poisoning `cachedMessageCounts`
 * with a `history.length + 1` entry that does not correspond to a real
 * assistant reply.
 */
export function noteCancelRequested(modelId: string): void {
  modelCancelCounters.set(
    modelId,
    (modelCancelCounters.get(modelId) ?? 0) + 1,
  );
}

export function snapshotCancelCount(modelId: string): number {
  return modelCancelCounters.get(modelId) ?? 0;
}

/** Test-only. */
export function _resetCancelCountersForTest(): void {
  modelCancelCounters.clear();
}

/**
 * A completion's `savedCount` should only be recorded when the turn ran to
 * completion AND produced at least one token. Any other outcome —
 * cancelled mid-decode, legitimate zero-token reply, or an early EOS — must
 * clear the entry instead, because there is no guarantee that the kv-cache
 * file on disk matches the `history.length + 1` boundary the SDK would
 * otherwise record.
 */
export function shouldRecordSavedCount(
  wasCancelled: boolean,
  producedTokens: boolean,
): boolean {
  return !wasCancelled && producedTokens;
}

export interface HistoryMessage {
  role: string;
  content: string;
  attachments?: { path: string }[] | undefined;
}

export interface HistorySliceDecision {
  /** Messages to send to the model on the next turn. */
  messages: HistoryMessage[];
  /**
   * True when the decision path proves the current `savedCount` is stale
   * and the caller should `cachedMessageCounts.delete(cachePath)` to avoid
   * propagating the bad count to the next turn.
   */
  clearStaleCount: boolean;
}

/**
 * Pure slice decision for `prepareMessagesForCache`.
 *
 * Mirrors the shape of the logic in `completion-stream.ts` but without
 * calling `transformMessages` (which depends on `bare-fs` for attachment
 * probing). Kept here so the decision can be unit-tested in isolation.
 *
 * The key regression guard: when a non-zero `savedCount` would slice the
 * history down to an empty array, it is treated as stale — the caller
 * falls back to sending the system-stripped full history rather than
 * handing the model an empty payload.
 */
export function decideCachedHistorySlice(
  savedCount: number,
  cacheExists: boolean,
  history: HistoryMessage[],
): HistorySliceDecision {
  if (!cacheExists || history.length === 0) {
    return {
      messages: history.filter((msg) => msg.role !== "system"),
      clearStaleCount: false,
    };
  }

  const canSlice = savedCount > 0 && savedCount <= history.length;
  const sliced = canSlice ? history.slice(savedCount) : null;

  // A non-null slice that is empty means the saved count is stale: the
  // cached turn boundary is claiming the entire current history is
  // already cached, which happens when a previous turn was cancelled
  // mid-decode and still recorded `history.length + 1`. Treat it as a
  // bad state and resend the full (system-stripped) history.
  const useSlice = sliced !== null && sliced.length > 0;
  const messages = useSlice
    ? sliced
    : history.filter((msg) => msg.role !== "system");

  return {
    messages,
    clearStaleCount: !useSlice && savedCount > 0,
  };
}
