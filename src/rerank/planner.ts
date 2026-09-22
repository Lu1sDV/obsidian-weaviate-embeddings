import type { RetrievedNoteCandidate } from "../weaviate";
import { selectEvidence } from "./evidence";
import { packRequests, type RequestBatch } from "./systemone";
import { LIMITS, RerankError, type EvidenceRecord, type Provider } from "./types";

export interface RerankPlan {
  candidates: readonly RetrievedNoteCandidate[];
  records: readonly EvidenceRecord[];
  batches: readonly RequestBatch[];
}

function cohortSizes(total: number, minimum: number): number[] {
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(minimum)
    || total < 1 || total > LIMITS.notes || minimum < 1 || minimum > total) {
    throw new RerankError("budget");
  }
  return [...new Set([total, 48, 40, 30, minimum].filter(value => value <= total && value >= minimum))]
    .sort((a, b) => b - a);
}

/** Plan the complete cohort before the first network write; deterministic shrinkage never publishes a scored prefix. */
export function planRerank(
  candidates: readonly RetrievedNoteCandidate[],
  minimumCandidateCount: number,
  query: string,
  provider: Provider,
  passagesPerNote: 1 | 2,
): RerankPlan {
  for (const count of cohortSizes(candidates.length, minimumCandidateCount)) {
    try {
      const selected = candidates.slice(0, count);
      const records = selectEvidence(selected, query, passagesPerNote);
      const batches = packRequests(provider, query, records);
      const tokens = batches.reduce((sum, batch) => sum + batch.estimatedTokens, 0);
      if (batches.length <= LIMITS.maxBatches && tokens <= LIMITS.operationTokens) {
        return { candidates: selected, records, batches };
      }
    } catch (error) {
      if (!(error instanceof RerankError && error.reason === "budget")) throw error;
    }
  }
  throw new RerankError("budget");
}
