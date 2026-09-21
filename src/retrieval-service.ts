import { admittedResults } from "./graph";
import type { SearchResult } from "./types";

export const SEARCH_WINDOWS = [300, 600, 1200] as const;
export interface SearchWindow { candidates: readonly SearchResult[]; limit: number }

/** Used only by the explicit rerank action. The saved local baseline is never rewritten. */
export async function expandSearchPool(
  initial: SearchWindow,
  retrieve: (limit: number) => Promise<SearchResult[]>,
  admitted: (result: SearchResult) => boolean,
  current: () => boolean,
): Promise<SearchResult[] | undefined> {
  let window = initial;
  let index = SEARCH_WINDOWS.findIndex(limit => limit === window.limit);
  if (index < 0) throw new Error("Invalid saved Search window");
  while (current()) {
    const pool = admittedResults(window.candidates, admitted, 60);
    const hits = window.candidates.reduce((count, note) => count + note.passages.length, 0);
    if (pool.length === 60 || hits < window.limit || index === SEARCH_WINDOWS.length - 1) return structuredClone(pool);
    const limit = SEARCH_WINDOWS[++index]!;
    // Relative-fusion scores are window-local: replace, never append or merge.
    window = { limit, candidates: await retrieve(limit) };
  }
  return undefined;
}
