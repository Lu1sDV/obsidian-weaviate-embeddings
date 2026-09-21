import { createHash } from "node:crypto";
import type { SearchResult } from "../types";
import { LIMITS, METRIC_VERSION, RerankError, type Evidence, type EvidenceRecord } from "./types";

type Passage = SearchResult["passages"][number];
export function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

/** A conservative planning estimate, NOT a JEV tokenizer. Hard byte caps are independent. */
export function estimatedTokens(json: string): number { return Math.ceil(Buffer.byteLength(json, "utf8") / 2); }
function clip(text: string, bytes: number): string {
  let size = 0, end = 0;
  for (const point of text) {
    const next = Buffer.byteLength(point);
    if (size + next > bytes) break;
    size += next; end += point.length;
  }
  return text.slice(0, end);
}
function excerpt(text: string, query: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  // Keep a matching region instead of always taking the opening of a long passage.
  const terms = [...new Set(query.match(/[\p{L}\p{N}_-]{3,}/gu) ?? [])].sort((a, b) => b.length - a.length);
  const lower = text.toLowerCase();
  const position = terms.map(term => lower.indexOf(term.toLowerCase())).find(index => index >= 0) ?? 0;
  const roughStart = Math.max(0, position - Math.floor(bytes / 4));
  const lineStart = text.lastIndexOf("\n", roughStart) + 1;
  let start = roughStart - lineStart < 160 ? lineStart : roughStart;
  // Do not split a UTF-16 surrogate pair before applying the UTF-8 byte cap.
  if (start && /[\uDC00-\uDFFF]/.test(text[start]!)) start--;
  const content = clip(text.slice(start), bytes - 8);
  return `${start ? "…\n" : ""}${content}${start + content.length < text.length ? "\n…" : ""}`;
}
function overlaps(left: Passage, right: Passage): boolean {
  if (left.body.trim() === right.body.trim()) return true;
  const overlap = Math.max(0, Math.min(left.endLine, right.endLine) - Math.max(left.startLine, right.startLine));
  return overlap > 0 && overlap / Math.max(1, Math.min(left.endLine - left.startLine, right.endLine - right.startLine)) >= 0.5;
}
function evidenceFor(note: SearchResult, passage: Passage, query: string, key: string): EvidenceRecord {
  const title = clip(note.title, 160), heading = clip(passage.heading, 240);
  const body = excerpt(passage.body, query, LIMITS.evidenceBytes - Buffer.byteLength(JSON.stringify({ title, heading, body: "" })) - 64);
  // JSON escaping can expand code and controls. Clip again until the serialized evidence fits.
  const evidence: Evidence = { title, heading, body };
  while (Buffer.byteLength(JSON.stringify(evidence)) > LIMITS.evidenceBytes) {
    if (!evidence.body) throw new RerankError("budget");
    evidence.body = clip(evidence.body, Math.max(0, Buffer.byteLength(evidence.body) - 128));
  }
  if (!evidence.body.trim()) throw new RerankError("budget");
  return { key, noteId: note.noteId, snapshotId: note.snapshotId, passageId: passage.passageId, evidence,
    hash: hash([METRIC_VERSION, evidence]), truncated: title !== note.title || heading !== passage.heading || evidence.body !== passage.body };
}

/** One per note first. Optional seconds are allocated later against the whole-operation budget. */
export function selectEvidence(candidates: readonly SearchResult[], query: string): { required: EvidenceRecord[]; optional: EvidenceRecord[] } {
  if (!query.trim() || Buffer.byteLength(query) > LIMITS.queryBytes || candidates.length < 1 || candidates.length > LIMITS.notes) throw new RerankError("budget");
  const required: EvidenceRecord[] = [], optional: EvidenceRecord[] = [];
  const notes = new Set<string>();
  for (const [index, note] of candidates.entries()) {
    if (!note.noteId || !note.snapshotId || notes.has(note.noteId) || note.scoreKind !== "hybrid" || !Number.isFinite(note.score)) throw new RerankError("invalid-response");
    notes.add(note.noteId);
    const ids = new Set<string>();
    const passages = [...note.passages].sort((a, b) => (a.retrievalRank ?? 0) - (b.retrievalRank ?? 0));
    for (const passage of passages) {
      if (!passage.passageId || ids.has(passage.passageId)) throw new RerankError("invalid-response");
      ids.add(passage.passageId);
    }
    const first = passages.find(passage => passage.body.trim());
    if (!first) throw new RerankError("budget");
    required.push(evidenceFor(note, first, query, `p${String(index).padStart(3, "0")}`));
    const second = passages.find(passage => passage !== first && passage.body.trim() && !overlaps(first, passage));
    if (second) optional.push(evidenceFor(note, second, query, `p${String(index + LIMITS.notes).padStart(3, "0")}`));
  }
  return { required, optional };
}
