import { createHash } from "node:crypto";
import type { RetrievedNoteCandidate, RetrievedPassageCandidate } from "../weaviate";
import { EVIDENCE_POLICY_VERSION, LIMITS, RerankError, type Evidence, type EvidenceRecord } from "./types";

export function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** A conservative planning estimate, not a JEV tokenizer. Hard byte caps are independent. */
export function estimatedTokens(json: string): number {
  return Math.ceil(Buffer.byteLength(json, "utf8") / 2);
}

function clip(text: string, bytes: number): string {
  let size = 0, end = 0;
  for (const point of text) {
    const next = Buffer.byteLength(point);
    if (size + next > bytes) break;
    size += next;
    end += point.length;
  }
  return text.slice(0, end);
}

function excerpt(text: string, query: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  const terms = [...new Set(query.match(/[\p{L}\p{N}_-]{3,}/gu) ?? [])].sort((a, b) => b.length - a.length);
  const lower = text.toLowerCase();
  const position = terms.map(term => lower.indexOf(term.toLowerCase())).find(index => index >= 0) ?? 0;
  const roughStart = Math.max(0, position - Math.floor(bytes / 4));
  const lineStart = text.lastIndexOf("\n", roughStart) + 1;
  let start = roughStart - lineStart < 160 ? lineStart : roughStart;
  if (start && /[\uDC00-\uDFFF]/.test(text[start]!)) start--;
  const content = clip(text.slice(start), bytes - 8);
  return `${start ? "…\n" : ""}${content}${start + content.length < text.length ? "\n…" : ""}`;
}

function overlaps(left: RetrievedPassageCandidate, right: RetrievedPassageCandidate): boolean {
  if (left.body.trim() === right.body.trim()) return true;
  const overlap = Math.max(0, Math.min(left.endLine, right.endLine) - Math.max(left.startLine, right.startLine));
  return overlap > 0 && overlap / Math.max(1, Math.min(left.endLine - left.startLine, right.endLine - right.startLine)) >= 0.5;
}

function evidenceFor(candidate: RetrievedNoteCandidate, passage: RetrievedPassageCandidate, query: string, key: string): EvidenceRecord {
  const title = clip(passage.storedTitle, 160);
  const heading = clip(passage.heading, 240);
  const body = excerpt(passage.body, query,
    LIMITS.evidenceBytes - Buffer.byteLength(JSON.stringify({ title, heading, body: "" })) - 64);
  const evidence: Evidence = { title, heading, body };
  while (Buffer.byteLength(JSON.stringify(evidence)) > LIMITS.evidenceBytes) {
    if (!evidence.body) throw new RerankError("budget");
    evidence.body = clip(evidence.body, Math.max(0, Buffer.byteLength(evidence.body) - 128));
  }
  if (!evidence.body.trim()) throw new RerankError("budget");
  return {
    key,
    noteId: candidate.result.noteId,
    snapshotId: candidate.result.snapshotId,
    passageId: passage.passageId,
    retrievalRank: passage.retrievalRank,
    evidence,
    hash: hash([EVIDENCE_POLICY_VERSION, evidence]),
    truncated: title !== passage.storedTitle || heading !== passage.heading || evidence.body !== passage.body,
  };
}

/** One passage/note is the release policy; two is an explicit experiment. */
export function selectEvidence(
  candidates: readonly RetrievedNoteCandidate[],
  query: string,
  passagesPerNote: 1 | 2 = 1,
): EvidenceRecord[] {
  if (!query.trim() || Buffer.byteLength(query) > LIMITS.queryBytes || candidates.length < 1 || candidates.length > LIMITS.notes) {
    throw new RerankError("budget");
  }
  const records: EvidenceRecord[] = [];
  const notes = new Set<string>();
  for (const candidate of candidates) {
    const note = candidate.result;
    if (!note.noteId || !note.snapshotId || notes.has(note.noteId) || note.scoreKind !== "hybrid" || !Number.isFinite(note.score)) {
      throw new RerankError("invalid-response");
    }
    notes.add(note.noteId);
    const ids = new Set<string>();
    const passages = [...candidate.passages]
      .sort((a, b) => a.retrievalRank - b.retrievalRank || a.passageId.localeCompare(b.passageId));
    for (const passage of passages) {
      if (passage.noteId !== note.noteId || passage.snapshotId !== note.snapshotId || passage.path !== note.path
        || !passage.passageId || ids.has(passage.passageId) || !Number.isFinite(passage.retrievalScore)
        || !Number.isSafeInteger(passage.retrievalRank) || passage.retrievalRank < 0) {
        throw new RerankError("invalid-response");
      }
      ids.add(passage.passageId);
    }
    const first = passages.find(passage => passage.body.trim());
    if (!first) throw new RerankError("budget");
    records.push(evidenceFor(candidate, first, query, `p${String(records.length).padStart(3, "0")}`));
    if (passagesPerNote === 2) {
      const second = passages.find(passage => passage !== first && passage.body.trim() && !overlaps(first, passage));
      if (second) records.push(evidenceFor(candidate, second, query, `p${String(records.length).padStart(3, "0")}`));
    }
  }
  return records;
}
