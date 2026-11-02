import { estimatedTokens } from "./evidence";
import { projectMarkdown, type MarkdownProjection, type TextRange } from "./markdown";
import { DOCUMENT_BYTES, type RerankDocument, type RerankTarget } from "./documents";
import { RerankError } from "./types";

export interface EvidenceSegment {
  role: "text" | "focus" | "context";
  heading: string;
  format: "heading" | "prose" | "code" | "list" | "table" | "quote" | "markdown";
  text: string;
  gapBefore: boolean;
  partial: boolean;
}
export interface WireDocument {
  title: string;
  scope: "search" | "note" | "passage";
  coverage: "full" | "excerpt";
  segments: EvidenceSegment[];
}
export interface SelectedDocument {
  wire: WireDocument;
  text: string;
  ranges: TextRange[];
  complete: boolean;
  retainedAnchors: number;
  omittedAnchors: number;
}
export interface ContextDocument {
  original: RerankDocument;
  projection: MarkdownProjection;
  anchors: TextRange[];
  selected?: TextRange;
  fullTokens: number;
}

function validRange(range: TextRange, length: number): boolean {
  return Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end)
    && range.start >= 0 && range.end > range.start && range.end <= length;
}

export function prepareContext(document: RerankDocument | RerankTarget): ContextDocument {
  if (typeof document.text !== "string" || typeof document.title !== "string"
    || Buffer.byteLength(document.text) > DOCUMENT_BYTES || document.anchors.length > 4096
    || document.anchors.some(range => !validRange(range, document.text.length))) throw new RerankError("snapshot");
  const projection = projectMarkdown(document.text);
  const selected = "selected" in document ? document.selected : undefined;
  if (selected && !validRange(selected, document.text.length)) throw new RerankError("snapshot");
  const anchors = document.anchors.map(range => trimRange(projection.text, projection.range(range))).filter(range => range.end > range.start);
  return { original: document, projection, anchors, fullTokens: estimatedTokens(projection.text),
    ...(selected ? { selected: projection.range(selected) } : {}) };
}

export function prefix(text: string, bytes: number): string {
  if (bytes <= 0) return "";
  const buffer = Buffer.from(text);
  let end = Math.min(Math.floor(bytes), buffer.length);
  while (end > 0 && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}
function suffix(text: string, bytes: number): string {
  if (bytes <= 0) return "";
  const buffer = Buffer.from(text);
  let start = Math.max(0, buffer.length - Math.floor(bytes));
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString("utf8");
}

function merge(ranges: readonly TextRange[]): TextRange[] {
  const result: TextRange[] = [];
  for (const range of [...ranges].filter(range => range.end > range.start).sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = result.at(-1);
    if (previous && range.start <= previous.end + 2) previous.end = Math.max(previous.end, range.end);
    else result.push({ ...range });
  }
  return result;
}
function totalTokens(text: string, ranges: readonly TextRange[]): number {
  return merge(ranges).reduce((total, range) => total + estimatedTokens(text.slice(range.start, range.end)), 0);
}
function trimRange(text: string, range: TextRange): TextRange {
  const raw = text.slice(range.start, range.end);
  // Remove only empty boundary lines. Indentation carries meaning in code, nested lists and quotes.
  const left = /^(?:[ \t]*\r?\n)+/.exec(raw)?.[0].length ?? 0;
  const right = /(?:\r?\n[ \t]*)+$/.exec(raw)?.[0].length ?? 0;
  return { start: range.start + left, end: Math.max(range.start + left, range.end - right) };
}
function clipRange(text: string, range: TextRange, tokens: number, fromEnd = false): TextRange {
  const raw = text.slice(range.start, range.end);
  const clipped = fromEnd ? suffix(raw, tokens * 2) : prefix(raw, tokens * 2);
  let next = fromEnd ? { start: range.end - clipped.length, end: range.end } : { start: range.start, end: range.start + clipped.length };
  if (clipped.length < raw.length && clipped.length > 160) {
    // Prefer coherent sentence/line cuts, but never exceed the assigned byte/token estimate.
    if (!fromEnd) {
      const boundary = [...clipped.matchAll(/[.!?](?:\s+)|\n/g)].at(-1);
      if (boundary && boundary.index! > clipped.length * 0.65) next.end = range.start + boundary.index! + boundary[0].length;
    } else {
      const boundary = /[.!?](?:\s+)|\n/.exec(clipped);
      if (boundary && boundary.index < clipped.length * 0.35) next.start += boundary.index + boundary[0].length;
    }
  }
  return trimRange(text, next);
}

function representativeRanges(document: ContextDocument): TextRange[] {
  const usable = document.projection.blocks.filter(block => block.kind !== "heading" && block.boundary);
  const blocks = usable.length ? usable : document.projection.blocks.filter(block => block.kind !== "heading");
  const sections = new Map<string, TextRange[]>();
  for (const block of blocks) { const list = sections.get(block.heading) ?? []; list.push(block); sections.set(block.heading, list); }
  // Representative interior windows cover distinct sections rather than just the midpoint.
  const groups = [...sections.values()];
  const count = Math.min(5, groups.length || blocks.length);
  if (!count) return [];
  if (groups.length > 1) return Array.from({ length: count }, (_, index) => {
    const group = groups[Math.round(index * (groups.length - 1) / Math.max(1, count - 1))]!;
    return group[Math.floor((group.length - 1) / 2)]!;
  });
  return Array.from({ length: Math.min(5, blocks.length) }, (_, index) =>
    blocks[Math.round(index * (blocks.length - 1) / Math.max(1, Math.min(5, blocks.length) - 1))]!);
}

function around(document: ContextDocument, anchor: TextRange, before: number, after: number): TextRange {
  const { text, blocks } = document.projection;
  const preceding = [...blocks].reverse().find(block => block.kind === "heading" && block.end <= anchor.start);
  const following = blocks.find(block => block.kind === "heading" && block.start >= anchor.end);
  const left = preceding?.end ?? 0, right = following?.start ?? text.length;
  return { start: anchor.start - suffix(text.slice(left, anchor.start), before * 2).length,
    end: anchor.end + prefix(text.slice(anchor.end, right), after * 2).length };
}

function render(document: ContextDocument, ranges: readonly TextRange[], scope: WireDocument["scope"]): SelectedDocument {
  const { text, blocks } = document.projection;
  const structural: TextRange[] = [];
  for (const range of ranges) {
    const block = blocks.find(block => block.start <= range.start && block.end > range.start);
    if (!block || range.start <= block.start) continue;
    const original = text.slice(block.start, block.end);
    if (block.kind === "table") {
      const header = /^[^\n]*\n[ \t]*\|?[ \t]*:?-{3,}[^\n]*(?:\n|$)/.exec(original);
      if (header) structural.push({ start: block.start, end: block.start + header[0].length });
    } else if (block.kind === "list") {
      const prefix = text.slice(block.start, range.start);
      // Preserve the closest preceding list item at each shallower indentation level.
      let depth = Infinity;
      for (const line of [...prefix.matchAll(/^( *)((?:[-*+]|\d+[.)])\s+[^\n]*)(?:\n|$)/gm)].reverse()) {
        if (line[1]!.length < depth) {
          structural.push({ start: block.start + line.index!, end: block.start + line.index! + line[0].length });
          depth = line[1]!.length;
        }
        if (depth === 0) break;
      }
    } else if (block.kind === "code") {
      const opening = /^ {0,3}(?:`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(original);
      if (opening) structural.push({ start: block.start, end: block.start + opening[0].length });
    }
  }
  let selected = merge([...ranges, ...structural]).map(range => {
    const trimmed = trimRange(text, range), focus = document.selected;
    if (focus && range.start <= focus.start && range.end >= focus.end) {
      trimmed.start = Math.min(trimmed.start, focus.start); trimmed.end = Math.max(trimmed.end, focus.end);
    }
    return trimmed;
  }).filter(range => range.end > range.start);
  if (!selected.length) throw new RerankError("budget");
  // Keep the explicitly selected passage structurally separate from its context.
  if (scope === "passage" && document.selected) {
    const focus = document.selected;
    selected = selected.flatMap(range => {
      if (range.end <= focus.start || range.start >= focus.end) return [range];
      return [
        ...(range.start < focus.start ? [{ start: range.start, end: focus.start }] : []),
        { start: Math.max(range.start, focus.start), end: Math.min(range.end, focus.end) },
        ...(range.end > focus.end ? [{ start: focus.end, end: range.end }] : []),
      ];
    }).filter(range => range.end > range.start && text.slice(range.start, range.end).trim());
  }
  const complete = merge(selected).length === 1 && text.slice(0, selected[0]!.start).trim() === ""
    && text.slice(selected.at(-1)!.end).trim() === "";
  const retainedAnchors = document.anchors.filter(anchor => merge(selected).some(range => range.start <= anchor.start && range.end >= anchor.end)).length;
  const segments = selected.map((range, index): EvidenceSegment => {
    const block = blocks.find(block => block.end > range.start && block.start <= range.start);
    const lastBlock = [...blocks].reverse().find(item => item.start < range.end && item.end >= range.end);
    const focus = document.selected;
    return { role: scope === "passage" && focus
      ? range.start >= focus.start && range.end <= focus.end ? "focus" : "context" : "text",
    heading: prefix(block?.heading ?? "", 512), format: block && range.end <= block.end ? block.kind : "markdown", text: text.slice(range.start, range.end),
    gapBefore: Boolean(text.slice(index ? selected[index - 1]!.end : 0, range.start).trim()),
    partial: Boolean(block && range.start > block.start || lastBlock && range.end < lastBlock.end) };
  });
  return { wire: { title: prefix(projectMarkdown(document.original.title).text, 256), scope,
    coverage: complete ? "full" : "excerpt", segments },
  text: segments.map(segment => `${segment.gapBefore ? "[Text omitted]\n" : ""}${segment.role === "focus" ? "[Selected passage]\n" : ""}${segment.text}`).join("\n\n")
    + (text.slice(selected.at(-1)!.end).trim() ? "\n[Text omitted]" : ""),
  ranges: selected, complete, retainedAnchors, omittedAnchors: document.anchors.length - retainedAnchors };
}

export interface ContextOptions {
  scope: WireDocument["scope"];
  tokens: number;
  contextTokens: number;
  source: boolean;
  completeOnly?: boolean;
}

/** Deterministic original-text extraction. Selection priority never changes presentation order. */
export function selectContext(document: ContextDocument, options: ContextOptions): SelectedDocument {
  const { text, blocks } = document.projection;
  const budget = Math.max(1, Math.floor(options.tokens));
  if (options.scope === "search") {
    if (document.fullTokens > budget || !text.trim()) throw new RerankError("source-too-large");
    return render(document, [{ start: 0, end: text.length }], options.scope);
  }
  if ((options.scope === "note" || options.completeOnly && !document.selected) && document.fullTokens <= budget) {
    return render(document, [{ start: 0, end: text.length }], options.scope);
  }
  if (options.completeOnly && !document.selected) throw new RerankError("budget");
  const focus = document.selected;
  if (options.source && options.scope === "passage" && (!focus || !text.slice(focus.start, focus.end).trim()
    || estimatedTokens(text.slice(focus.start, focus.end)) > budget)) throw new RerankError("source-too-large");

  let anchors = focus ? [focus] : document.anchors.length ? document.anchors : representativeRanges(document);
  const distinct: TextRange[] = [];
  for (const anchor of anchors) {
    if (!distinct.some(range => Math.min(range.end, anchor.end) > Math.max(range.start, anchor.start))) distinct.push(anchor);
    if (distinct.length === (options.source && options.scope === "note" ? 5 : 3)) break;
  }
  anchors = distinct;
  if (!anchors.length) anchors = [{ start: 0, end: text.length }];
  const ranges: TextRange[] = [];
  const wholeNote = options.scope === "note";
  const anchorBudget = wholeNote ? Math.floor(budget * 0.7) : budget;
  // First pass protects complete anchors where possible before allocating surrounding text.
  for (const anchor of anchors) {
    const remaining = (wholeNote && ranges.length ? anchorBudget : budget) - totalTokens(text, ranges);
    if (remaining <= 0) break;
    const perAnchor = options.source && wholeNote ? Math.max(64, Math.floor(anchorBudget / anchors.length)) : remaining;
    ranges.push(options.source && focus ? { ...anchor } : clipRange(text, anchor, Math.min(remaining, perAnchor)));
  }
  if (wholeNote) {
    const substantive = blocks.filter(block => block.boundary);
    const first = substantive[0] ?? blocks[0], last = substantive.at(-1) ?? blocks.at(-1);
    for (const [block, fromEnd] of [[first, false], [last, true]] as const) {
      if (!block) continue;
      const remaining = budget - totalTokens(text, ranges);
      if (remaining > 0) ranges.push(clipRange(text, block, Math.min(remaining, Math.floor(budget * 0.15)), fromEnd));
    }
  }
  // Expand windows fairly. Several anchors share the same document allowance.
  let remaining = budget - totalTokens(text, ranges);
  for (const anchor of anchors) {
    if (remaining <= 0) break;
    const perSide = Math.min(options.contextTokens, Math.floor(remaining / Math.max(2, anchors.length * 2)));
    if (perSide <= 0) break;
    const selectedAnchor = ranges.find(range => range.start <= anchor.start && range.end >= anchor.end);
    if (!selectedAnchor) continue;
    const window = around(document, anchor, perSide, perSide);
    ranges.push(window);
    remaining = budget - totalTokens(text, ranges);
  }
  const result = render(document, ranges, options.scope);
  if (options.source && focus && !merge(result.ranges).some(range => range.start <= focus.start && range.end >= focus.end)) {
    throw new RerankError("source-too-large");
  }
  return result;
}
