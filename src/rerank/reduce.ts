import type { SearchResult } from "../types";
import { METRIC_VERSION, PROVIDERS, RerankError, type EvidenceRecord, type Provider } from "./types";

/** Never mix missing judgments with relevance zero, or relevance with retrieval scores. */
export function rankNotes(candidates: readonly SearchResult[], evidence: readonly EvidenceRecord[], scores: ReadonlyMap<string, number>, provider: Provider, resolvedModel: string): SearchResult[] {
  const expected = new Set(evidence.map(record => record.key));
  if (!resolvedModel || scores.size !== expected.size || expected.size !== evidence.length
    || [...scores].some(([key, value]) => !expected.has(key) || !Number.isFinite(value) || value < 0 || value > 1)) throw new RerankError("invalid-response");
  const grouped = new Map<string, EvidenceRecord[]>();
  for (const record of evidence) {
    const group = grouped.get(record.noteId) ?? [];
    group.push(record); grouped.set(record.noteId, group);
  }
  if (grouped.size !== candidates.length) throw new RerankError("invalid-response");
  return candidates.map((candidate, rank) => {
    const records = grouped.get(candidate.noteId);
    if (!records?.length || records.some(record => record.snapshotId !== candidate.snapshotId
      || !candidate.passages.some(passage => passage.passageId === record.passageId))) throw new RerankError("invalid-response");
    const ordered = [...records].sort((left, right) => scores.get(right.key)! - scores.get(left.key)!);
    const winner = ordered[0]!;
    const judged = new Map(records.map(record => [record.passageId, scores.get(record.key)!]));
    const result = structuredClone(candidate);
    result.passages = result.passages.map(passage => {
      delete passage.rerankRelevance;
      const relevance = judged.get(passage.passageId);
      return relevance === undefined ? passage : { ...passage, rerankRelevance: relevance };
    }).sort((a, b) => Number(b.passageId === winner.passageId) - Number(a.passageId === winner.passageId));
    result.rerank = { provider, requestedModel: PROVIDERS[provider].model, resolvedModel, metricVersion: METRIC_VERSION,
      relevance: scores.get(winner.key)!, winningPassageId: winner.passageId, evidenceCount: records.length };
    return { result, rank };
  }).sort((a, b) => b.result.rerank!.relevance - a.result.rerank!.relevance || a.rank - b.rank
    || (a.result.noteId < b.result.noteId ? -1 : a.result.noteId > b.result.noteId ? 1 : 0)).slice(0, 30).map(item => item.result);
}
