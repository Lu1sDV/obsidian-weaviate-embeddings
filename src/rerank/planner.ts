import type { RetrievedNoteCandidate } from "../weaviate";
import { selectEvidence } from "./evidence";
import { packRequests, type RequestBatch } from "./systemone";
import { LIMITS, operationBudget, RerankError, type EvidenceRecord, type Provider } from "./types";

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

function planCount(
  candidates: readonly RetrievedNoteCandidate[],
  count: number,
  query: string,
  provider: Provider,
  passagesPerNote: 1 | 2,
): RerankPlan {
  const selected = candidates.slice(0, count);
  const records = selectEvidence(selected, query, passagesPerNote);
  const batches = packRequests(provider, query, records);
  const tokens = batches.reduce((sum, batch) => sum + batch.estimatedTokens, 0);
  const budget = operationBudget(passagesPerNote);
  if (batches.length > budget.maxBatches || tokens > budget.operationTokens) throw new RerankError("budget");
  return { candidates: selected, records, batches };
}

/**
 * Pick candidate breadth using the release one-passage policy first. The two-passage experiment must
 * either score that exact cohort under its larger experimental budget or bypass; it never narrows
 * candidate breadth merely because more evidence was requested.
 */
export function planRerank(
  candidates: readonly RetrievedNoteCandidate[],
  minimumCandidateCount: number,
  query: string,
  provider: Provider,
  passagesPerNote: 1 | 2,
): RerankPlan {
  let baselinePlan: RerankPlan | undefined;
  for (const count of cohortSizes(candidates.length, minimumCandidateCount)) {
    try {
      baselinePlan = planCount(candidates, count, query, provider, 1);
      break;
    } catch (error) {
      if (!(error instanceof RerankError && error.reason === "budget")) throw error;
    }
  }
  if (!baselinePlan) throw new RerankError("budget");
  if (passagesPerNote === 1) return baselinePlan;

  // Never continue shrinking here: doing so would confound evidence breadth with candidate breadth.
  return planCount(candidates, baselinePlan.candidates.length, query, provider, 2);
}
