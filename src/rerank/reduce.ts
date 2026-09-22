import type { SearchResult } from "../types";
import type { RetrievedNoteCandidate } from "../weaviate";
import {
  EVIDENCE_POLICY_VERSION,
  RANKING_POLICY_VERSION,
  RUBRIC_VERSION,
  RerankError,
  type EvidenceRecord,
  type ServingIdentity,
} from "./types";

/** Never mix missing judgments with relevance zero, or JEV relevance with local retrieval scores. */
export function rankNotes(
  candidates: readonly RetrievedNoteCandidate[],
  evidence: readonly EvidenceRecord[],
  scores: ReadonlyMap<string, number>,
  serving: ServingIdentity,
): SearchResult[] {
  const expected = new Set(evidence.map(record => record.key));
  if (scores.size !== expected.size || expected.size !== evidence.length
    || [...scores].some(([key, value]) => !expected.has(key) || !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new RerankError("invalid-response");
  }

  const grouped = new Map<string, EvidenceRecord[]>();
  for (const record of evidence) {
    const group = grouped.get(record.noteId) ?? [];
    group.push(record);
    grouped.set(record.noteId, group);
  }
  if (grouped.size !== candidates.length) throw new RerankError("invalid-response");

  return candidates.map(candidate => {
    const note = candidate.result;
    const records = grouped.get(note.noteId);
    const passageIds = new Set(candidate.passages.map(passage => passage.passageId));
    if (!records?.length || records.some(record => record.snapshotId !== note.snapshotId || !passageIds.has(record.passageId))) {
      throw new RerankError("invalid-response");
    }

    const judgments = records.map(record => ({
      passageId: record.passageId,
      evidenceHash: record.hash,
      retrievalRank: record.retrievalRank,
      relevance: scores.get(record.key)!,
    })).sort((left, right) => right.relevance - left.relevance
      || left.retrievalRank - right.retrievalRank
      || left.passageId.localeCompare(right.passageId));
    const winner = judgments[0]!;
    const retrievalRank = new Map(candidate.passages.map(passage => [passage.passageId, passage.retrievalRank]));

    const result = structuredClone(note);
    result.passages.sort((left, right) => Number(right.passageId === winner.passageId) - Number(left.passageId === winner.passageId)
      || (retrievalRank.get(left.passageId) ?? Number.MAX_SAFE_INTEGER) - (retrievalRank.get(right.passageId) ?? Number.MAX_SAFE_INTEGER)
      || left.passageId.localeCompare(right.passageId));
    result.rerank = {
      route: serving.route,
      requestedModel: serving.requestedModel,
      servedModel: serving.servedModel,
      ...(serving.upstreamProvider === undefined ? {} : { upstreamProvider: serving.upstreamProvider }),
      rubricVersion: RUBRIC_VERSION,
      evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
      rankingPolicyVersion: RANKING_POLICY_VERSION,
      relevance: winner.relevance,
      bestPassageId: winner.passageId,
      evidenceCount: records.length,
      coverage: "complete",
      judgments,
    };
    return { result, noteRank: candidate.noteRank };
  }).sort((left, right) => right.result.rerank!.relevance - left.result.rerank!.relevance
    || left.noteRank - right.noteRank
    || left.result.noteId.localeCompare(right.result.noteId))
    .slice(0, 30)
    .map(item => item.result);
}
