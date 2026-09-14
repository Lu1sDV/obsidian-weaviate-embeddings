import { DEFAULT_MODEL, type EmbeddingProfile } from "./embedding-config";
import type { PassageTokenRange, PreparedNote, PreparedPassage } from "./types";

export const MAX_TEXT_BYTES = 4 * 1024 * 1024;
export const MAX_SEGMENTS = 4096;
export const PASSAGE_TOKENS = 1024;
export type TokenCounter = (text: string) => number;
export type ContentEncoder = (text: string) => number[];
type Span = PreparedNote["noteSegments"][number];
type Unit = { start: number; end: number; heading: string; section: number };
const encoder = new TextEncoder();

export function validateText(text: unknown): asserts text is string {
  if (typeof text !== "string" || text.length > MAX_TEXT_BYTES || encoder.encode(text).byteLength > MAX_TEXT_BYTES) {
    throw new Error("Input exceeds the 4 MiB native embedding limit; split it into smaller notes");
  }
}

function tokenCount(text: string, countTokens: TokenCounter): number {
  const count = countTokens(text);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("Tokenizer returned an invalid token count including special tokens");
  return count;
}

function splitComplete(text: string, limit: number, countTokens: TokenCounter, knownCount?: number, structural = false): Span[] {
  const spans: Span[] = [];
  function split(start: number, end: number, count?: number): void {
    const part = text.slice(start, end);
    if ((count ?? tokenCount(part, countTokens)) <= limit) {
      if (spans.length >= MAX_SEGMENTS) throw new Error("Note needs more than 4096 segments; split it into smaller notes");
      spans.push({ text: part, start, end });
      return;
    }
    let middle = start + Math.floor((end - start) / 2);
    if (structural) {
      const newline = text.lastIndexOf("\n", middle - 1) + 1;
      if (newline > start) middle = newline;
      else {
        for (let cut = middle; cut > start; cut -= 1) {
          if (/\s/u.test(text[cut - 1]!)) { middle = cut; break; }
        }
      }
    }
    if (middle > start && /[\uD800-\uDBFF]/.test(text[middle - 1]!) && /[\uDC00-\uDFFF]/.test(text[middle]!)) {
      middle -= 1;
      if (middle === start) middle += 2;
    }
    if (middle <= start || middle >= end) throw new Error(`A single Unicode character exceeds the ${limit}-token limit`);
    // Preserve the existing note-window policy. Passage splits prefer structure, but
    // every child is tokenized independently: token counts need not be monotonic.
    split(start, middle);
    split(middle, end);
  }
  split(0, text.length, knownCount);
  return spans;
}

/** Bounded Markdown structure, not a full CommonMark parser. No source rewriting. */
function structure(text: string): Unit[] {
  const units: Unit[] = [];
  const ancestry: string[] = [];
  let start = 0;
  let section = 0;
  let heading = "";
  let kind: "paragraph" | "list" | "fence" | undefined;
  let listIndent = 0;
  let blankInList = false;
  let fence: { char: string; length: number } | undefined;
  const flush = (end: number): void => {
    if (end > start) units.push({ start, end, heading, section });
    start = end;
    kind = undefined;
    blankInList = false;
  };
  for (let cursor = 0; cursor < text.length;) {
    const newline = text.indexOf("\n", cursor);
    const end = newline < 0 ? text.length : newline + 1;
    const line = text.slice(cursor, end).replace(/[\r\n]+$/, "");
    if (fence) {
      const closer = /^ {0,3}(`{3,}|~{3,})[\t ]*$/.exec(line);
      if (closer && closer[1]![0] === fence.char && closer[1]!.length >= fence.length) {
        fence = undefined;
        flush(end);
      }
      cursor = end;
      continue;
    }
    const title = /^ {0,3}(#{1,6})(?:[\t ]+(.*)|)$/.exec(line);
    const opener = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const list = /^( {0,3})(?:[-+*][\t ]+|\d{1,9}[.)][\t ]+)/.exec(line);
    if (title) {
      if (kind) flush(cursor);
      const level = title[1]!.length;
      ancestry.length = level - 1;
      ancestry[level - 1] = (title[2] ?? "").replace(/[\t ]+#+[\t ]*$/, "").trim();
      heading = ancestry.filter(Boolean).join(" / ");
      section += 1;
    } else if (opener && !(opener[1]![0] === "`" && opener[2]!.includes("`"))) {
      if (kind) flush(cursor);
      kind = "fence";
      fence = { char: opener[1]![0]!, length: opener[1]!.length };
    } else if (!line.trim()) {
      if (kind === "paragraph") flush(end);
      else if (kind === "list") blankInList = true;
    } else if (list) {
      const indent = list[1]!.length;
      if (kind === "paragraph" || (kind === "list" && indent <= listIndent)) flush(cursor);
      if (!kind) { kind = "list"; listIndent = indent; }
      blankInList = false;
    } else {
      if (kind === "list" && blankInList && !/^[\t ]/.test(line)) flush(cursor);
      kind ??= "paragraph";
      blankInList = false;
    }
    cursor = end;
  }
  flush(text.length);
  return units;
}

function packWindow(text: string, window: Span, units: readonly Unit[], countTokens: TokenCounter, limit: number): Unit[] {
  const packed: Unit[] = [];
  for (const unit of units) {
    if (unit.end <= window.start) continue;
    if (unit.start >= window.end) break;
    const start = Math.max(unit.start, window.start);
    const end = Math.min(unit.end, window.end);
    for (const span of splitComplete(text.slice(start, end), limit, countTokens, undefined, true)) {
      const next = { start: start + span.start, end: start + span.end, heading: unit.heading, section: unit.section };
      const previous = packed[packed.length - 1];
      if (previous && previous.section === next.section && tokenCount(text.slice(previous.start, next.end), countTokens) <= limit) previous.end = next.end;
      else packed.push(next);
      if (packed.length > MAX_SEGMENTS) throw new Error("Note needs more than 4096 passages; split it into smaller notes");
    }
  }
  return packed;
}

function sameIds(left: readonly number[], right: readonly number[], offset = 0): boolean {
  if (offset + left.length > right.length) return false;
  return left.every((id, index) => id === right[offset + index]);
}

function alignWindow(text: string, window: Span, proposed: Unit[], countTokens: TokenCounter, encodeContent: ContentEncoder, limit: number): Array<Unit & { ids: number[] }> {
  const expected = encodeContent(window.text);
  const encoded = proposed.map(unit => ({ ...unit, ids: encodeContent(text.slice(unit.start, unit.end)) }));
  let offset = 0;
  const exact = encoded.every(unit => {
    const matches = sameIds(unit.ids, expected, offset);
    offset += unit.ids.length;
    return matches;
  });
  if (exact && offset === expected.length) return encoded;

  // Only unsafe seams pay for complete-prefix/suffix verification. Cache offsets,
  // not full token arrays; bound failed repair work using the preparation limit.
  const safe = new Map<number, number | null>([[window.start, 0], [window.end, expected.length]]);
  let checks = 0;
  const safeOffset = (cut: number): number | null => {
    if (safe.has(cut)) return safe.get(cut)!;
    if (++checks > MAX_SEGMENTS) throw new Error("Jina token alignment exceeds the preparation limit; split the note");
    const prefix = encodeContent(text.slice(window.start, cut));
    const suffix = encodeContent(text.slice(cut, window.end));
    const value = prefix.length + suffix.length === expected.length && sameIds(prefix, expected) && sameIds(suffix, expected, prefix.length) ? prefix.length : null;
    safe.set(cut, value);
    return value;
  };
  const result: Array<Unit & { ids: number[] }> = [];
  let start = window.start;
  let token = 0;
  while (start < window.end) {
    const source = proposed.find(unit => unit.end > start);
    if (!source) throw new Error("Jina alignment lost a source span");
    const target = source.end;
    let found: (Unit & { ids: number[] }) | undefined;
    const tryCut = (end: number): boolean => {
      if (end <= start || end > window.end) return false;
      if (/[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)) return false;
      const next = safeOffset(end);
      if (next === null || next <= token) return false;
      const part = text.slice(start, end);
      if (tokenCount(part, countTokens) > limit) return false;
      const ids = encodeContent(part);
      if (ids.length !== next - token || !sameIds(ids, expected, token)) return false;
      found = { ...source, start, end, ids };
      return true;
    };
    if (!tryCut(target)) {
      for (let cut = target - 1; cut > start && !found; cut -= 1) if (/\s/u.test(text[cut - 1]!)) tryCut(cut);
      for (let cut = target + 1; cut <= window.end && !found; cut += 1) if (cut === window.end || /\s/u.test(text[cut - 1]!)) tryCut(cut);
      for (let cut = target - 1; cut > start && !found; cut -= 1) tryCut(cut);
      for (let cut = target + 1; cut <= window.end && !found; cut += 1) tryCut(cut);
    }
    if (!found) throw new Error("Unable to align Jina passage token IDs to complete contextual input");
    result.push(found);
    start = found.end;
    token += found.ids.length;
    if (result.length > MAX_SEGMENTS) throw new Error("Note needs more than 4096 passages; split it into smaller notes");
  }
  if (token !== expected.length) throw new Error("Jina contextual partition omitted tokens");
  return result;
}

function preparePassages(text: string, windows: Span[], countTokens: TokenCounter, profile: EmbeddingProfile, encodeContent?: ContentEncoder): Pick<PreparedNote, "passages" | "passageRanges"> {
  const jina = profile.id === "jinaai/jina-embeddings-v2-small-en";
  if (jina && !encodeContent) throw new Error("Jina note preparation requires a content tokenizer");
  const limit = Math.min(PASSAGE_TOKENS, profile.contextLimit);
  const units = structure(text);
  const planned: Array<Unit & { ids?: number[]; window: number }> = [];
  for (let index = 0; index < windows.length; index += 1) {
    const packed = packWindow(text, windows[index]!, units, countTokens, limit);
    const aligned = jina ? alignWindow(text, windows[index]!, packed, countTokens, encodeContent!, limit) : packed;
    for (const unit of aligned) planned.push({ ...unit, window: index });
  }
  const passages: PreparedPassage[] = [];
  const passageRanges: PassageTokenRange[][] = windows.map(() => []);
  let sourceStart = 0;
  let sourceLine = 0;
  const tokenOffsets = windows.map(() => 1);
  for (const unit of planned) {
    const body = text.slice(unit.start, unit.end);
    const meaningful = unit.ids ? unit.ids.length > 0 : encodeContent ? encodeContent(body).length > 0 : Boolean(body.trim());
    if (!meaningful) continue;
    const passageText = text.slice(sourceStart, unit.end);
    if (sourceStart !== unit.start) {
      const extendedIds = unit.ids ? encodeContent!(passageText) : undefined;
      if (tokenCount(passageText, countTokens) > limit || (unit.ids && extendedIds && (extendedIds.length !== unit.ids.length || !sameIds(extendedIds, unit.ids)))) throw new Error("Source-only passage extension changed its token budget or alignment");
    }
    let endLine = sourceLine;
    for (let index = sourceStart; index < unit.end; index += 1) if (text.charCodeAt(index) === 10) endLine += 1;
    const passageIndex = passages.length;
    if (passageIndex >= MAX_SEGMENTS) throw new Error("Note needs more than 4096 passages; split it into smaller notes");
    passages.push({ text: passageText, heading: unit.heading, start: sourceStart, end: unit.end, startLine: sourceLine, endLine });
    if (unit.ids) {
      const startToken = tokenOffsets[unit.window]!;
      passageRanges[unit.window]!.push({ passageIndex, startToken, endToken: startToken + unit.ids.length });
      tokenOffsets[unit.window] = startToken + unit.ids.length;
    }
    sourceStart = unit.end;
    sourceLine = endLine;
  }
  const last = passages[passages.length - 1];
  if (last && sourceStart < text.length) {
    const extended = text.slice(last.start);
    if (tokenCount(extended, countTokens) > limit) throw new Error("Trailing source-only text exceeds the passage budget");
    if (encodeContent) {
      const before = encodeContent(last.text); const after = encodeContent(extended);
      if (before.length !== after.length || !sameIds(before, after)) throw new Error("Trailing source-only text changed token alignment");
    }
    last.text = extended;
    last.end = text.length;
    for (let index = sourceStart; index < text.length; index += 1) if (text.charCodeAt(index) === 10) last.endLine += 1;
  }
  return { passages, ...(jina ? { passageRanges } : {}) };
}

export function prepareInput(kind: "note", text: string, countTokens: TokenCounter, profile?: EmbeddingProfile, encodeContent?: ContentEncoder): PreparedNote;
export function prepareInput(kind: "query", text: string, countTokens: TokenCounter, profile?: EmbeddingProfile, encodeContent?: ContentEncoder): Pick<PreparedNote, "tokenCount" | "modelFingerprint" | "inputPolicyVersion">;
export function prepareInput(kind: "note" | "query", text: string, countTokens: TokenCounter, profile: EmbeddingProfile = DEFAULT_MODEL, encodeContent?: ContentEncoder): PreparedNote | Pick<PreparedNote, "tokenCount" | "modelFingerprint" | "inputPolicyVersion"> {
  validateText(text);
  const count = tokenCount(text, countTokens);
  const base = { tokenCount: count, modelFingerprint: profile.modelFingerprint, inputPolicyVersion: profile.inputPolicyVersion };
  if (kind === "query") {
    if (count > profile.contextLimit) throw new Error(`Query is ${count} tokens; shorten it to at most ${profile.contextLimit} tokens including special tokens. Queries are never truncated.`);
    return base;
  }
  if (kind !== "note") throw new Error("Preparation kind must be note or query");
  const noteSegments = splitComplete(text, profile.contextLimit, countTokens, count);
  return { ...base, noteVectorMode: noteSegments.length === 1 ? "direct" : "aggregated", noteSegments, ...preparePassages(text, noteSegments, countTokens, profile, encodeContent) };
}

/** Validate the entire batch before any model forward pass allocates inference tensors. */
export function prepareEmbeddingBatch(inputs: unknown, countTokens: TokenCounter, profile: EmbeddingProfile = DEFAULT_MODEL): number[] {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 32) throw new Error("Embedding batches must contain between 1 and 32 inputs");
  let bytes = 0;
  for (const input of inputs) {
    validateText(input);
    bytes += encoder.encode(input).byteLength;
    if (bytes > MAX_TEXT_BYTES) throw new Error("Embedding batch exceeds 4 MiB; split it into smaller batches");
  }
  let total = 0;
  return inputs.map((text: string) => {
    const count = tokenCount(text, countTokens);
    if (count > profile.contextLimit) throw new Error(`Input is ${count} tokens; maximum is ${profile.contextLimit}. Prepare note segments or shorten the query; inputs are never truncated.`);
    total += count;
    if (total > profile.contextLimit) throw new Error(`Batch is over ${profile.contextLimit} tokens; split it into smaller batches`);
    return count;
  });
}
