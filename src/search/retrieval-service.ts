import type { PropertyRegistry } from "../properties";
import type { PropertyFilter, SearchResult } from "../types";
import type { HybridWindow, RetrievedNoteCandidate, WeaviateClient } from "../weaviate";

export const SEARCH_WINDOWS = [300, 600, 1200] as const;

export interface ExpandedSearchPool {
  candidates: readonly RetrievedNoteCandidate[];
  window: HybridWindow;
  candidateExhausted: boolean;
}

export interface SearchRetrievalQuery {
  generation: number;
  fingerprint: string;
  query: string;
  vector: readonly number[];
  filters: readonly PropertyFilter[];
}

function admittedCandidates(window: HybridWindow, admitted: (result: SearchResult) => boolean, limit: number): RetrievedNoteCandidate[] {
  const seen = new Set<string>();
  const candidates: RetrievedNoteCandidate[] = [];
  for (const candidate of window.notes) {
    if (seen.has(candidate.result.noteId) || !admitted(candidate.result)) continue;
    seen.add(candidate.result.noteId);
    candidates.push(candidate);
    if (candidates.length === limit) break;
  }
  return candidates;
}

/** Manual rerank expansion only. Every widened retrieval replaces the previous relative-fusion window. */
export async function expandSearchPool(
  initial: HybridWindow,
  retrieve: (limit: number) => Promise<HybridWindow>,
  admitted: (result: SearchResult) => boolean,
  current: () => boolean,
): Promise<ExpandedSearchPool | undefined> {
  let window = initial;
  let index = SEARCH_WINDOWS.findIndex(limit => limit === window.limit);
  if (index < 0) throw new Error("Invalid saved Search window");
  while (current()) {
    const pool = admittedCandidates(window, admitted, 60);
    const exhausted = window.passages.length < window.limit || index === SEARCH_WINDOWS.length - 1;
    if (pool.length === 60 || exhausted) {
      return { candidates: structuredClone(pool), window: structuredClone(window), candidateExhausted: pool.length < 60 };
    }
    const limit = SEARCH_WINDOWS[++index]!;
    window = await retrieve(limit);
    if (window.limit !== limit) throw new Error("Expanded Search returned the wrong retrieval window");
  }
  return undefined;
}

/** Owns Search candidate retrieval so the view renders snapshots rather than defining retrieval semantics. */
export class SearchRetrievalService {
  constructor(
    private readonly database: WeaviateClient,
    private readonly registry: PropertyRegistry,
  ) {}

  retrieve(request: SearchRetrievalQuery, limit: number): Promise<HybridWindow> {
    return this.database.hybridDetailed(
      request.generation,
      request.fingerprint,
      request.query,
      [...request.vector],
      request.filters,
      this.registry,
      limit,
    );
  }

  expand(
    initial: HybridWindow,
    request: SearchRetrievalQuery,
    admitted: (result: SearchResult) => boolean,
    current: () => boolean,
  ): Promise<ExpandedSearchPool | undefined> {
    return expandSearchPool(initial, limit => this.retrieve(request, limit), admitted, current);
  }
}
