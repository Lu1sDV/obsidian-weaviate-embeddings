import { createHash } from "node:crypto";
import { cosineSimilarity } from "../graph";
import type { ManifestNote, SearchResult } from "../types";
import type { NoteObject, PassageObject, RetrievedNoteCandidate } from "../weaviate";
import { RerankError } from "./types";

export interface SourceRange { start: number; end: number; passageId?: string; heading?: string }
export interface RerankDocument {
  title: string;
  text: string;
  /** Ordered strongest first; positions refer to original canonical text, not cleaned text. */
  anchors: readonly SourceRange[];
}
export interface RerankTarget extends RerankDocument {
  kind: "search" | "note" | "passage";
  noteId?: string;
  snapshotId?: string;
  selected?: SourceRange;
}
export interface VerifiedDocument extends RerankDocument {
  noteId: string;
  snapshotId: string;
  vector: readonly number[];
  passages: readonly PassageObject[];
}
export const DOCUMENT_BYTES = 4 * 1024 * 1024;
export const HYDRATION_BYTES = 32 * 1024 * 1024;

/** A live read is usable only when it exactly reproduces the indexed canonical snapshot. */
export function verifyDocument(
  manifest: ManifestNote,
  canonical: string,
  stored: { note: NoteObject; passages: readonly PassageObject[] },
): VerifiedDocument {
  const { note, passages } = stored;
  if (!manifest.servable || manifest.committed !== true || Buffer.byteLength(canonical) > DOCUMENT_BYTES
    || createHash("sha256").update(canonical).digest("hex") !== manifest.bodyHash
    || note.noteId !== manifest.noteId || note.snapshotId !== manifest.snapshotId || note.path !== manifest.path
    || !passages.length || passages.length !== manifest.passageIds.length || passages.length > 4096) {
    throw new RerankError("snapshot");
  }
  let previousStart = -1;
  const seen = new Set<string>();
  for (const [index, passage] of passages.entries()) {
    if (passage.noteId !== note.noteId || passage.snapshotId !== note.snapshotId || passage.path !== note.path
      || passage.title !== note.title || passage.passageId !== manifest.passageIds[index] || seen.has(passage.passageId)
      || passage.passageIndex !== index || !Number.isSafeInteger(passage.start) || !Number.isSafeInteger(passage.end)
      || passage.start < 0 || passage.start < previousStart || passage.end <= passage.start || passage.end > canonical.length
      || canonical.slice(passage.start, passage.end) !== passage.body) throw new RerankError("snapshot");
    previousStart = passage.start;
    seen.add(passage.passageId);
  }
  return { title: note.title, text: canonical, anchors: [], noteId: note.noteId,
    snapshotId: note.snapshotId, vector: note.vector, passages };
}

/** Note-level Connections gets passage anchors from stored vectors, with no extra embedding call. */
export function documentForCandidate(
  source: VerifiedDocument,
  candidate: RetrievedNoteCandidate,
  queryVector?: readonly number[],
): RerankDocument {
  if (candidate.result.noteId !== source.noteId || candidate.result.snapshotId !== source.snapshotId) {
    throw new RerankError("snapshot");
  }
  const byId = new Map(source.passages.map(passage => [passage.passageId, passage]));
  const matched = [...candidate.passages].sort((a, b) => a.retrievalRank - b.retrievalRank);
  for (const passage of matched) {
    const stored = byId.get(passage.passageId);
    if (!stored || stored.body !== passage.body || stored.startLine !== passage.startLine
      || stored.endLine !== passage.endLine || stored.heading !== passage.heading) throw new RerankError("snapshot");
  }
  const ordered = matched.length
    ? matched.map(passage => byId.get(passage.passageId)!)
    : queryVector
      ? source.passages.map(passage => ({ passage,
        score: cosineSimilarity(queryVector, passage.vector, queryVector.length) }))
        .sort((a, b) => b.score - a.score || a.passage.passageIndex - b.passage.passageIndex).map(item => item.passage)
      : [];
  return { title: source.title, text: source.text,
    anchors: ordered.map(({ start, end, passageId, heading }) => ({ start, end, passageId, heading })) };
}

/** Keep all same-note passage hits; the ordinary local display's deduplication is unchanged. */
export function groupConnectionCandidates(results: readonly SearchResult[], limit: number): RetrievedNoteCandidate[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 60) throw new RerankError("budget");
  const grouped = new Map<string, RetrievedNoteCandidate & { passages: Array<RetrievedNoteCandidate["passages"][number]> }>();
  for (const [rank, result] of results.entries()) {
    let entry = grouped.get(result.noteId);
    if (!entry) {
      if (grouped.size === limit) continue;
      entry = { result: structuredClone(result), noteRank: grouped.size, passages: [] };
      entry.result.passages = [];
      grouped.set(result.noteId, entry);
    }
    if (entry.result.snapshotId !== result.snapshotId || entry.result.path !== result.path) throw new RerankError("snapshot");
    for (const passage of result.passages) {
      if (entry.passages.some(found => found.passageId === passage.passageId)) continue;
      entry.result.passages.push(structuredClone(passage));
      entry.passages.push({ ...passage, noteId: result.noteId, snapshotId: result.snapshotId, path: result.path,
        storedTitle: result.title, retrievalRank: rank, retrievalScore: result.score });
    }
  }
  return [...grouped.values()];
}
