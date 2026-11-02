import { RerankError } from "./types";

/** Local, non-rendering Markdown projection. It never resolves links or fetches attachments. */
export interface TextRange { start: number; end: number }
interface Piece extends TextRange { value: string; literal: boolean; offset: number }
export interface TextBlock extends TextRange {
  heading: string;
  kind: "heading" | "prose" | "code" | "list" | "table" | "quote";
  boundary: boolean;
}
export interface MarkdownProjection {
  text: string;
  blocks: readonly TextBlock[];
  range(source: TextRange): TextRange;
}

const normalizeReference = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
const FOOTER = /(?:^|\s|\/)(?:references|bibliography|attachments|backlinks|bibliografia|allegati|riferimenti)(?:$|\s)/i;

function description(value: string): string {
  const text = value.replace(/\\([\[\]!*_`])/g, "$1").replace(/<[^>]*>/g, "").trim();
  if (!text || /^(?:\d+(?:x\d+)?|image\d*|img\d*|screenshot|photo|picture|attachment)$/i.test(text)
    || /(?:^data:|^https?:|[/\\]|\.(?:png|jpe?g|gif|svg|webp|avif|bmp|tiff?|heic|pdf)$)/i.test(text)) return "";
  return text.slice(0, 512);
}

/** Finds a balanced delimiter, respecting escapes and nested Markdown image labels/URLs. */
function balanced(text: string, start: number, open: string, close: string, spend: () => void): number {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    spend();
    if (text[index] === "\\") { index++; continue; }
    if (text[index] === open) depth++;
    if (text[index] === close && --depth === 0) return index + 1;
  }
  return -1;
}

function tagEnd(text: string, start: number, spend: () => void): number {
  let quote = "";
  for (let index = start; index < text.length; index++) {
    spend();
    const char = text[index]!;
    if (quote) { if (char === quote) quote = ""; }
    else if (char === '"' || char === "'") quote = char;
    else if (char === ">") return index + 1;
  }
  return -1;
}

export function projectMarkdown(source: string): MarkdownProjection {
  if (Buffer.byteLength(source) > 4 * 1024 * 1024) throw new RerankError("budget");
  let work = 0;
  const spend = (amount = 1) => { if ((work += amount) > source.length * 12 + 4096) throw new RerankError("budget"); };
  const pieces: Piece[] = [];
  const imageReferences = new Set<string>();
  const textReferences = new Set<string>();
  const definitions = new Map<number, { key: string; end: number; imageData: boolean }>();
  const refs = new Set<string>();
  // Reference definitions are recognized only outside code, using the same block pass below.
  const lines: RegExpMatchArray[] = [];
  for (const line of source.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (line[0].length) lines.push(line);
    if (lines.length > 50_000) throw new RerankError("budget");
  }
  let fence = "", fenceLength = 0, indented = false, previousBlank = true;
  const codeLines = new Set<number>();
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!;
    const value = line[0], position = line.index!;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(value);
    if (fence) {
      codeLines.add(position);
      if (new RegExp(`^ {0,3}${fence}{${fenceLength},}[ \\t]*\\r?\\n?$`).test(value)) fence = "";
    } else if (marker) {
      fence = marker[1]![0]!; fenceLength = marker[1]!.length; codeLines.add(position);
    } else if (/^(?: {4}|\t)/.test(value) && (previousBlank || indented)) {
      indented = true; codeLines.add(position);
    } else {
      indented = false;
      const definition = /^ {0,3}\[([^\]\n]+)\]:([^\n]*)(?:\n|$)$/.exec(value);
      if (definition) {
        const key = normalizeReference(definition[1]!);
        let last = lineIndex, definitionEnd = position + value.length;
        // A reference destination and optional title can continue on following lines. Treat the
        // whole definition as one source range, rather than leaving its URL behind after cleanup.
        const needsDestination = !definition[2]!.trim();
        while (last + 1 < lines.length) {
          const next = lines[last + 1]![0];
          if (!next.trim() || /^ {0,3}\[[^\]]+\]:/.test(next)) break;
          const destination = needsDestination && last === lineIndex && !/^\s*(?:#|`{3}|~{3})/.test(next);
          if (!destination && !/^(?:[ \t]+|["'])/.test(next)) break;
          definitionEnd += next.length;
          last++;
          if (definitionEnd - position > 16_384) throw new RerankError("budget");
        }
        definitions.set(position, { key, end: definitionEnd,
          imageData: /data:image\//i.test(source.slice(position, definitionEnd)) });
        refs.add(key); lineIndex = last;
      }
    }
    previousBlank = !value.trim();
  }
  const emit = (start: number, end: number, value = source.slice(start, end), literal = true) => {
    if (pieces.length > 50_000) throw new RerankError("budget");
    if (end > start) pieces.push({ start, end, value, literal, offset: 0 });
  };
  // Scan a run outside fenced/indented code. Inline-code runs can cross line boundaries.
  const inline = (start: number, end: number) => {
    let index = start, pending = start;
    const replace = (last: number, value: string) => {
      emit(pending, index); emit(index, last, value, false); index = last; pending = last;
    };
    while (index < end) {
      spend();
      if (source[index] === "\\") { index += 2; continue; }
      if (source[index] === "`") {
        let last = index + 1;
        while (source[last] === "`") last++;
        const marker = source.slice(index, last);
        let close = source.indexOf(marker, last);
        spend((close >= 0 && close < end ? close : end) - last);
        while (close >= 0 && close < end && (source[close - 1] === "`" || source[close + marker.length] === "`")) {
          const previous = close; close = source.indexOf(marker, close + marker.length);
          spend((close >= 0 && close < end ? close : end) - previous);
        }
        if (close >= 0 && close + marker.length <= end) { index = close + marker.length; continue; }
        index = last; continue;
      }
      if (source.startsWith("<!--", index)) {
        const close = source.indexOf("-->", index + 4);
        replace(close >= 0 && close + 3 <= end ? close + 3 : end, ""); continue;
      }
      if (source.startsWith("![[", index)) {
        const close = source.indexOf("]]", index + 3);
        spend((close >= 0 && close < end ? close : end) - index);
        if (close >= 0 && close + 2 <= end) {
          const inner = source.slice(index + 3, close);
          const alias = inner.includes("|") ? inner.slice(inner.lastIndexOf("|") + 1) : "";
          const label = description(alias);
          replace(close + 2, label ? `[Embedded content description: ${label}; content not read]` : ""); continue;
        }
      }
      if (source.startsWith("![", index)) {
        const labelEnd = balanced(source, index + 1, "[", "]", spend);
        if (labelEnd > 0 && labelEnd <= end) {
          const label = source.slice(index + 2, labelEnd - 1);
          let last = labelEnd, found = false;
          if (source[labelEnd] === "(") {
            const destinationEnd = balanced(source, labelEnd, "(", ")", spend);
            if (destinationEnd > 0 && destinationEnd <= end) { last = destinationEnd; found = true; }
          } else if (source[labelEnd] === "[") {
            const refEnd = balanced(source, labelEnd, "[", "]", spend);
            if (refEnd > 0 && refEnd <= end) {
              const key = normalizeReference(source.slice(labelEnd + 1, refEnd - 1) || label);
              if (refs.has(key)) { imageReferences.add(key); last = refEnd; found = true; }
            }
          } else if (refs.has(normalizeReference(label))) {
            imageReferences.add(normalizeReference(label)); found = true;
          }
          if (found) { const alt = description(label); replace(last, alt ? `[Image description: ${alt}; image not read]` : ""); continue; }
        }
      }
      if (source[index] === "[" && source[index - 1] !== "!") {
        const labelEnd = balanced(source, index, "[", "]", spend);
        if (labelEnd > 0 && labelEnd <= end) {
          const label = source.slice(index + 1, labelEnd - 1);
          if (source[labelEnd] === "[") {
            const last = balanced(source, labelEnd, "[", "]", spend);
            if (last > 0 && last <= end) textReferences.add(normalizeReference(source.slice(labelEnd + 1, last - 1) || label));
          } else if (source[labelEnd] !== "(" && refs.has(normalizeReference(label))) textReferences.add(normalizeReference(label));
        }
      }
      if (source[index] === "<" && /^<\/?(?:img|picture|source)\b/i.test(source.slice(index, index + 20))) {
        const last = tagEnd(source, index, spend);
        if (last > 0 && last <= end) {
          const tag = source.slice(index, last);
          const alt = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
          const label = description(alt?.[1] ?? alt?.[2] ?? alt?.[3] ?? "");
          replace(last, label ? `[Image description: ${label}; image not read]` : ""); continue;
        }
      }
      if (source[index] === "<" && /^<svg\b/i.test(source.slice(index, index + 8))) {
        const close = /<\/svg\s*>/gi; close.lastIndex = index;
        const found = close.exec(source);
        spend(found && close.lastIndex <= end ? close.lastIndex - index : end - index);
        replace(found && close.lastIndex <= end ? close.lastIndex : end, ""); continue;
      }
      if (source.startsWith("data:image/", index)) {
        let last = index + 11;
        while (last < end && !/[\s"'<>)]/.test(source[last]!)) last++;
        replace(last, ""); continue;
      }
      index++;
    }
    emit(pending, end);
  };
  let pending = 0;
  for (const line of lines) {
    const start = line.index!, end = start + line[0].length;
    if (start < pending) continue;
    const definition = definitions.get(start);
    if (codeLines.has(start) || definition) {
      inline(pending, start); emit(start, definition?.end ?? end); pending = definition?.end ?? end;
    }
  }
  inline(pending, source.length);
  // Remove definitions only when used exclusively by images. Ordinary reference links survive.
  for (const piece of pieces) {
    const definition = definitions.get(piece.start);
    if (definition && (definition.imageData || imageReferences.has(definition.key) && !textReferences.has(definition.key))) {
      piece.value = ""; piece.literal = false;
    }
  }
  let text = "";
  for (const piece of pieces) { piece.offset = text.length; text += piece.value; }
  const map = (position: number, after: boolean): number => {
    let lo = 0, hi = pieces.length;
    while (lo < hi) { const middle = (lo + hi) >>> 1; if (pieces[middle]!.end <= position) lo = middle + 1; else hi = middle; }
    const piece = pieces[lo];
    if (!piece) return text.length;
    return piece.offset + (piece.literal ? Math.max(0, position - piece.start) : after && position > piece.start ? piece.value.length : 0);
  };
  return { text, blocks: blocksOf(text), range: range => ({ start: map(range.start, false), end: map(range.end, true) }) };
}

function blocksOf(text: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  const headings: string[] = [];
  let start = 0, end = 0, currentKind: TextBlock["kind"] = "prose", fence = "";
  const heading = () => headings.filter(Boolean).join(" / ");
  const flush = () => {
    if (end <= start || !text.slice(start, end).trim()) return;
    const value = text.slice(start, end);
    const toc = value.split("\n").filter(line => line.trim()).every(line => /^\s*[-*+]\s+\[[^\]]+\]\(#/.test(line));
    blocks.push({ start, end, kind: currentKind, heading: heading(), boundary: currentKind !== "heading" && !toc && !FOOTER.test(heading()) });
  };
  for (const match of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    const line = match[0], offset = match.index!;
    if (!line.length) continue;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      end = offset + line.length;
      if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \t]*\r?\n?$`).test(line)) { fence = ""; flush(); start = end; currentKind = "prose"; }
      continue;
    }
    if (marker) { flush(); start = offset; end = offset + line.length; currentKind = "code"; fence = marker[1]!; continue; }
    const title = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.trimEnd());
    if (title) {
      flush(); headings.length = title[1]!.length; headings[title[1]!.length - 1] = title[2]!;
      start = offset; end = offset + line.length; currentKind = "heading"; flush(); start = end; currentKind = "prose"; continue;
    }
    if (!line.trim()) { flush(); start = offset + line.length; end = start; currentKind = "prose"; continue; }
    if (end === start) currentKind = /^(?: {4}|\t)/.test(line) ? "code" : /^\s*(?:[-*+]|\d+[.)])\s+/.test(line) ? "list" : /^ {0,3}>/.test(line) ? "quote" : line.includes("|") ? "table" : "prose";
    end = offset + line.length;
  }
  flush();
  return blocks;
}
