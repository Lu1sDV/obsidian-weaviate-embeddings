import { createHash } from "node:crypto";
import { MAX_SOURCE_BYTES, MAX_SOURCE_PASSAGES, type RerankCandidate, type SourcePassage } from "./reranking-evidence";
import { RerankingCancelledError, RerankingError } from "./reranking-errors";

export interface EvidenceSourceOptions { signal: AbortSignal; assertCurrent: () => void }
export type EvidenceSource = (candidate: RerankCandidate, options: EvidenceSourceOptions) => Promise<readonly SourcePassage[]>;
interface EvidenceManifest {
  noteId: string; path: string; snapshotId: string; generation: number;
  modelFingerprint: string; bodyHash: string; passageIds: string[]; servable: boolean;
}
interface EvidenceState {
  indexingEnabled: boolean; servingReady: boolean; schemaUpdating: boolean; activeGeneration: number;
  notes: Record<string, EvidenceManifest>; pathToNoteId: Record<string, string>; pendingPurges: string[];
}
interface EvidenceDatabase {
  passagesForNote(generation: number, noteId: string, snapshotId: string, fingerprint: string): Promise<SourcePassage[]>;
}

/** Verify complete, ordered canonical source before selecting any extra cloud evidence. */
export function verifyEvidenceSource(source: readonly SourcePassage[], manifest: Pick<EvidenceManifest, "bodyHash" | "passageIds">): void {
  if (!source.length || source.length > MAX_SOURCE_PASSAGES || source.length !== manifest.passageIds.length) throw new RerankingError("source");
  const hash = createHash("sha256");
  const seen = new Set<string>();
  let bytes = 0;
  for (const [index, passage] of source.entries()) {
    if (!passage || typeof passage.body !== "string" || typeof passage.heading !== "string"
      || !passage.passageId || passage.passageId !== manifest.passageIds[index] || seen.has(passage.passageId)) throw new RerankingError("source");
    seen.add(passage.passageId);
    bytes += Buffer.byteLength(passage.body, "utf8");
    if (bytes > MAX_SOURCE_BYTES) throw new RerankingError("source");
    hash.update(passage.body, "utf8");
  }
  if (hash.digest("hex") !== manifest.bodyHash) throw new RerankingError("source");
}

/** Read the indexed snapshot, not live Markdown; no extra source is sent to JEV by this function. */
export function createStoredEvidenceLoader(state: EvidenceState, database: EvidenceDatabase, fingerprint: () => string): EvidenceSource {
  return async (candidate, options) => {
    const assertCurrent = () => {
      options.assertCurrent();
      if (options.signal.aborted) throw new RerankingCancelledError();
    };
    assertCurrent();
    if (!candidate.noteId || !candidate.snapshotId || !candidate.path) throw new RerankingError("source");
    const noteId = candidate.noteId, snapshotId = candidate.snapshotId, path = candidate.path;
    const note = state.notes[noteId];
    if (!note) throw new RerankingCancelledError();
    const expected = { ...note, passageIds: [...note.passageIds] };
    const valid = () => {
      assertCurrent();
      const current = state.notes[noteId];
      if (!state.indexingEnabled || !state.servingReady || state.schemaUpdating || !current?.servable
        || current.noteId !== noteId || current.path !== path || current.snapshotId !== snapshotId
        || current.generation !== state.activeGeneration || current.generation !== expected.generation
        || current.modelFingerprint !== fingerprint() || current.modelFingerprint !== expected.modelFingerprint
        || current.bodyHash !== expected.bodyHash || state.pathToNoteId[path] !== noteId || state.pendingPurges.includes(noteId)
        || current.passageIds.length !== expected.passageIds.length || current.passageIds.some((id, index) => id !== expected.passageIds[index])) throw new RerankingCancelledError();
    };
    valid();
    let source: SourcePassage[];
    try { source = await database.passagesForNote(expected.generation, noteId, snapshotId, expected.modelFingerprint); }
    catch { valid(); throw new RerankingError("source"); }
    valid();
    verifyEvidenceSource(source, expected);
    return source;
  };
}
