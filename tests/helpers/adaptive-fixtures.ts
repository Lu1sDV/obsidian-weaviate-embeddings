import type { RerankDocument, RerankTarget } from "../../src/rerank/documents";
import { defaultRerankSettings, type RerankAccess, type RerankInput } from "../../src/rerank/types";
import type { RetrievedNoteCandidate } from "../../src/weaviate";
import { MODEL } from "./rerank-model";

export function access(patch: Partial<RerankAccess> = {}): RerankAccess {
  return { ...defaultRerankSettings(), model: MODEL.requestedModel, apiKey: "synthetic-key", enabled: true, consent: true,
    revision: 0, modelRevision: 0, settingsRevision: 0, cloudPolicyRevision: 0, consentRevision: 0, credentialRevision: 0, ...patch };
}
export function note(index: number, text = `Useful evidence ${index}.`): { candidate: RetrievedNoteCandidate; document: RerankDocument } {
  const passageId = `p${index}`, noteId = `note${index}`, snapshotId = `snap${index}`, path = `local-only/${noteId}.md`, title = `Candidate ${index}`;
  const passage = { passageId, heading: "", body: text, startLine: 0, endLine: 1 };
  return { candidate: { noteRank: index, result: { noteId, snapshotId, path, title, score: 0.9 - index / 100,
    scoreKind: "similarity", passages: [passage] }, passages: [{ ...passage, noteId, snapshotId, path, storedTitle: title,
    retrievalScore: 0.9 - index / 100, retrievalRank: index }] },
  document: { title, text, anchors: [{ start: 0, end: text.length, passageId }] } };
}
export function request(items = [note(0), note(1)], source?: RerankTarget): RerankInput {
  return { source: source ?? { kind: "search", title: "", text: "Useful evidence", anchors: [] },
    documents: items.map(item => item.document), candidates: items.map(item => item.candidate),
    isSourceAllowed: () => true, vaultId: "test-vault", generation: 1, fingerprint: "model", query: "Useful evidence",
    queryEpoch: 0, filtersIdentity: "[]", minimumCandidateCount: 1, baselineWindow: 90, candidateWindow: 90,
    candidateExhausted: false, signal: new AbortController().signal, isCurrent: () => true, isAllowed: () => true };
}
