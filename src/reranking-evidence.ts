import type { EvidencePolicy } from "./reranking-config";
import { RerankingError } from "./reranking-errors";

export const MAX_MATCHED_PASSAGES = 3;
/** Serialized per-note evidence bytes, not tokens. Matches get priority over context. */
export const MAX_NOTE_EVIDENCE_BYTES = 12_000;
export const MAX_WHOLE_NOTE_BYTES = 6_000;
export const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
export const MAX_SOURCE_PASSAGES = 4096;

export interface EvidencePassage { heading: string; body: string; passageId?: string }
export interface RerankCandidate {
  title: string;
  passages: readonly EvidencePassage[];
  noteId?: string;
  snapshotId?: string;
  path?: string;
}
export interface SourcePassage extends EvidencePassage { passageId: string }
export interface EvidenceOptions {
  policy: EvidencePolicy;
  chunkingMode: "standard" | "late";
  allowWholeShortNotes: boolean;
}
export interface JevDocument {
  title: string;
  coverage: "matched-passages" | "contextual" | "whole-short-note";
  passages: Array<{ heading: string; text: string; kind: "match" | "context"; gapBefore: boolean }>;
}
export interface PreparedEvidence {
  document: JevDocument;
  /** Counts only; never retained source text, paths or credentials. */
  summary: { matched: number; context: number; omittedMatches: number; wholeNote: boolean; bytes: number };
}

/** Bound metadata without splitting a Unicode code point. Passage bodies are never prefix-cut. */
export function truncateUtf8(text: string, limit: number): string {
  let bytes = 0, end = 0;
  for (const point of text) {
    const size = Buffer.byteLength(point, "utf8");
    if (bytes + size > limit) break;
    bytes += size; end += point.length;
  }
  return text.slice(0, end);
}

function uniqueMatches(passages: readonly EvidencePassage[]): EvidencePassage[] {
  const seen = new Map<string, EvidencePassage>();
  for (const passage of passages) {
    const key = passage.passageId ?? JSON.stringify([passage.heading, passage.body]);
    const previous = seen.get(key);
    if (previous && (previous.body !== passage.body || previous.heading !== passage.heading)) throw new RerankingError("source");
    if (!previous && passage.body.trim()) seen.set(key, passage);
  }
  return [...seen.values()];
}

/** Input source, when provided, must already be verified against the indexed manifest. */
export function prepareEvidence(candidate: RerankCandidate, options: EvidenceOptions, source?: readonly SourcePassage[]): PreparedEvidence {
  const matches = uniqueMatches(candidate.passages);
  if (!matches.length) throw new RerankingError("input");
  const title = truncateUtf8(candidate.title, 256);
  const anchors = matches.slice(0, MAX_MATCHED_PASSAGES);
  let pool: readonly EvidencePassage[] = anchors;
  let positions = anchors.map((_, index) => index);
  if (source) {
    if (!source.length || source.length > MAX_SOURCE_PASSAGES) throw new RerankingError("source");
    const byId = new Map(source.map((passage, index) => [passage.passageId, index]));
    if (byId.size !== source.length) throw new RerankingError("source");
    // Check every retrieved passage, not just the three selected anchors.
    for (const passage of matches) {
      const index = passage.passageId === undefined ? undefined : byId.get(passage.passageId);
      if (index === undefined || source[index]!.body !== passage.body || source[index]!.heading !== passage.heading) throw new RerankingError("source");
    }
    positions = anchors.map(passage => byId.get(passage.passageId!)!);
    pool = source;
  }
  const selected = new Set<number>();
  const primary = new Set<number>();
  const make = (indices: ReadonlySet<number>, coverage: JevDocument["coverage"]): JevDocument => {
    let previous = -1;
    return { title, coverage, passages: [...indices].sort((a, b) => a - b).map(index => {
      const passage = pool[index]!;
      const gapBefore = previous >= 0 && (source ? index !== previous + 1 : true);
      previous = index;
      return { heading: truncateUtf8(passage.heading, 512), text: passage.body, kind: primary.has(index) ? "match" : "context", gapBefore };
    }) };
  };
  const bytes = (document: JevDocument) => Buffer.byteLength(JSON.stringify(document), "utf8");
  const fits = (indices: ReadonlySet<number>, coverage: JevDocument["coverage"]) => bytes(make(indices, coverage)) <= MAX_NOTE_EVIDENCE_BYTES;

  for (const index of positions) {
    primary.add(index); selected.add(index);
    if (!fits(selected, "matched-passages")) {
      primary.delete(index); selected.delete(index);
      // Do not substitute an arbitrary prefix or discard the strongest match.
      if (!selected.size) throw new RerankingError("evidence-limit");
    }
  }
  const finish = (document: JevDocument, wholeNote = false): PreparedEvidence => ({ document, summary: {
    matched: wholeNote ? matches.length : primary.size,
    context: wholeNote ? Math.max(0, source!.length - matches.length) : selected.size - primary.size,
    omittedMatches: wholeNote ? 0 : matches.length - primary.size, wholeNote, bytes: bytes(document),
  } });

  if (options.policy === "contextual" && source) {
    const sourceBytes = source.reduce((count, passage) => count + Buffer.byteLength(passage.body, "utf8"), 0);
    if (options.allowWholeShortNotes && sourceBytes <= MAX_WHOLE_NOTE_BYTES) {
      const whole: JevDocument = { title, coverage: "whole-short-note", passages: [
        { heading: "", text: source.map(passage => passage.body).join(""), kind: "match", gapBefore: false },
      ] };
      if (bytes(whole) <= MAX_NOTE_EVIDENCE_BYTES) return finish(whole, true);
    }
    const contextBudget = options.chunkingMode === "late" ? 4096 : 1536;
    const add = (indices: readonly number[]): boolean => {
      const proposed = new Set([...selected, ...indices]);
      let contextBytes = 0;
      for (const index of proposed) if (!primary.has(index)) contextBytes += Buffer.byteLength(pool[index]!.body, "utf8");
      if (contextBytes > contextBudget || !fits(proposed, "contextual")) return false;
      for (const index of indices) selected.add(index);
      return true;
    };
    // Late vectors can encode a larger section. Include it only when bounded;
    // stored passage adjacency is NOT claimed to be the original embedding window.
    if (options.chunkingMode === "late") for (const index of primary) {
      const heading = pool[index]!.heading;
      if (!heading) continue;
      let start = index, end = index;
      while (start > 0 && pool[start - 1]!.heading === heading) start--;
      while (end + 1 < pool.length && pool[end + 1]!.heading === heading) end++;
      add(Array.from({ length: end - start + 1 }, (_, offset) => start + offset));
    }
    const radius = options.chunkingMode === "late" ? 2 : 1;
    for (let distance = 1; distance <= radius; distance++) for (const index of primary) {
      for (const neighbour of [index - distance, index + distance]) {
        if (neighbour < 0 || neighbour >= pool.length) continue;
        if (options.chunkingMode === "standard" && pool[neighbour]!.heading !== pool[index]!.heading) continue;
        add([neighbour]);
      }
    }
  }
  return finish(make(selected, selected.size > primary.size ? "contextual" : "matched-passages"));
}
