/**
 * A stale reranked list may remain visible only when the exact saved local baseline was restored.
 * If restoration fails, clear immediately even when the changed note is no longer in the reranked top 30.
 */
export function shouldClearAfterRerankInvalidation(
  visibleAffected: boolean,
  baselineRestoreRequired: boolean,
  baselineRestored: boolean,
): boolean {
  return visibleAffected || (baselineRestoreRequired && !baselineRestored);
}
