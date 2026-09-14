import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MODEL, getModelProfile } from "../src/embedding-config";
import { MAX_TEXT_BYTES, PASSAGE_TOKENS, prepareEmbeddingBatch, prepareInput, type TokenCounter } from "../src/embedding-preparation";

const characterTokens: TokenCounter = (text) => Array.from(text).length + 2;

function assertCoverage(text: string, spans: Array<{ text: string; start: number; end: number }>, count: TokenCounter, limit: number): void {
  assert.equal(spans.map((span) => span.text).join(""), text);
  let cursor = 0;
  for (const span of spans) {
    assert.equal(span.start, cursor);
    assert.equal(span.end, cursor + span.text.length);
    assert.equal(span.text, text.slice(span.start, span.end));
    assert.ok(count(span.text) <= limit);
    if (span.end < text.length) {
      assert.ok(!(/[\uD800-\uDBFF]/.test(text[span.end - 1]!) && /[\uDC00-\uDFFF]/.test(text[span.end]!)), "span splits a surrogate pair");
    }
    cursor = span.end;
  }
  assert.equal(cursor, text.length);
}

test("full 32768-token context is direct, not silently shortened to a pipeline's 512-token default", () => {
  const text = "x".repeat(DEFAULT_MODEL.contextLimit - 2);
  const note = prepareInput("note", text, characterTokens);
  assert.equal(note.tokenCount, DEFAULT_MODEL.contextLimit);
  assert.equal(note.noteVectorMode, "direct");
  assert.deepEqual(note.noteSegments, [{ text, start: 0, end: text.length }]);
  assertCoverage(text, note.passages, characterTokens, PASSAGE_TOKENS);
  assert.equal(prepareInput("query", text, characterTokens).tokenCount, DEFAULT_MODEL.contextLimit);
  assert.equal(note.modelFingerprint, DEFAULT_MODEL.modelFingerprint);
  assert.equal(note.inputPolicyVersion, DEFAULT_MODEL.inputPolicyVersion);
});

test("oversize notes preserve all UTF16 content and recheck boundary-sensitive tokenizer counts", () => {
  const text = "世界🪴".repeat(11_000);
  const boundaryTokens: TokenCounter = (part) => characterTokens(part) + (part.startsWith("界") ? 7 : 0);
  const note = prepareInput("note", text, boundaryTokens);
  assert.equal(note.noteVectorMode, "aggregated");
  assertCoverage(text, note.noteSegments, boundaryTokens, DEFAULT_MODEL.contextLimit);
  assertCoverage(text, note.passages, boundaryTokens, PASSAGE_TOKENS);
  assert.deepEqual(prepareInput("note", text, boundaryTokens), note);
});

test("a split next to a two-unit Unicode character advances without bisecting the character", () => {
  const count: TokenCounter = (text) => Array.from(text).length * 700 + 2;
  const text = "🪴a";
  const note = prepareInput("note", text, count);
  assert.deepEqual(note.passages.map(({ text, start, end }) => ({ text, start, end })), [
    { text: "🪴", start: 0, end: 2 }, { text: "a", start: 2, end: 3 },
  ]);
});

test("independent paragraphs retain heading context, whitespace, and exact source line locations", () => {
  const text = "# First\r\n\r\n世界🪴\r\nStill here.\r\n\r\n## Next\nSecond paragraph.\n\nFinal.";
  const note = prepareInput("note", text, characterTokens);
  assertCoverage(text, note.passages, characterTokens, PASSAGE_TOKENS);
  assert.deepEqual(note.passages.map((span) => [span.text, span.heading]), [
    ["# First\r\n\r\n世界🪴\r\nStill here.\r\n\r\n", "First"],
    ["## Next\nSecond paragraph.\n\nFinal.", "First / Next"],
  ]);
  for (const span of note.passages) {
    assert.equal(span.startLine, text.slice(0, span.start).split("\n").length - 1);
    assert.equal(span.endLine, text.slice(0, span.end).split("\n").length - 1);
  }
});

test("oversize queries fail at token admission before inference rather than returning shortened input", () => {
  const text = "x".repeat(DEFAULT_MODEL.contextLimit - 1);
  assert.throws(() => prepareInput("query", text, characterTokens), /shorten it to at most 32768.*never truncated/);
  assert.throws(() => prepareEmbeddingBatch([text], characterTokens), /maximum is 32768.*never truncated/);
  assert.deepEqual(prepareEmbeddingBatch([text.slice(1)], characterTokens), [DEFAULT_MODEL.contextLimit]);
});

test("batch token admission includes each input's special tokens and rejects over-budget batches", () => {
  const half = "x".repeat(DEFAULT_MODEL.contextLimit / 2 - 2);
  assert.deepEqual(prepareEmbeddingBatch([half, half], characterTokens), [16384, 16384]);
  assert.throws(() => prepareEmbeddingBatch([half, `${half}x`], characterTokens), /split it into smaller batches/);
  assert.throws(() => prepareEmbeddingBatch(Array(33).fill(""), characterTokens), /between 1 and 32/);
});

test("empty content remains covered while byte, segment, and impossible-token boundaries fail explicitly", () => {
  const empty = prepareInput("note", "", characterTokens);
  assert.deepEqual(empty.noteSegments, [{ text: "", start: 0, end: 0 }]);
  assert.deepEqual(empty.passages, []);
  assert.throws(() => prepareInput("note", "🪴".repeat(MAX_TEXT_BYTES / 4 + 1), characterTokens), /4 MiB/);
  assert.throws(() => prepareInput("note", "🪴", () => PASSAGE_TOKENS + 1), /single Unicode character/);
  assert.throws(() => prepareInput("query", "x", () => NaN), /invalid token count/);
});

test("MiniLM preserves complete long notes while every inference input respects its 256-token context", () => {
  const profile = getModelProfile("Xenova/all-MiniLM-L6-v2");
  const text = `# Heading\n${"世界🪴".repeat(400)}`;
  const count: TokenCounter = (part) => characterTokens(part) + (part.startsWith("界") ? 7 : 0);
  const note = prepareInput("note", text, count, profile);
  assert.equal(note.noteVectorMode, "aggregated");
  assertCoverage(text, note.noteSegments, count, 256);
  assertCoverage(text, note.passages, count, 256);
  for (const span of [...note.noteSegments, ...note.passages]) {
    assert.deepEqual(prepareEmbeddingBatch([span.text], count, profile), [count(span.text)]);
  }
  assert.equal(note.modelFingerprint, profile.modelFingerprint);
  assert.notEqual(note.modelFingerprint, DEFAULT_MODEL.modelFingerprint);
  assert.equal(prepareInput("query", "x".repeat(254), characterTokens, profile).tokenCount, 256);
  assert.throws(() => prepareInput("query", "x".repeat(255), characterTokens, profile), /shorten/);
  assert.throws(() => prepareEmbeddingBatch(["x".repeat(255)], characterTokens, profile), /never truncated/);
  assert.deepEqual(prepareEmbeddingBatch(["x".repeat(126), "x".repeat(126)], characterTokens, profile), [128, 128]);
  assert.throws(() => prepareEmbeddingBatch(["x".repeat(126), "x".repeat(127)], characterTokens, profile), /smaller batches/);
});

test("structure scanner preserves fenced headings and heading ancestry", () => {
  const text = "## Parent\n\n```md\n# not a heading\n```\n\n### Child\nbody";
  const note = prepareInput("note", text, characterTokens);
  assertCoverage(text, note.passages, characterTokens, PASSAGE_TOKENS);
  assert.deepEqual(note.passages.map((passage) => passage.heading), ["Parent", "Parent / Child"]);
  assert.ok(note.passages.every((passage) => !passage.heading.includes("not a heading")));
});

test("Jina preparation exposes exact per-window content-token ranges", () => {
  const profile = getModelProfile("jinaai/jina-embeddings-v2-small-en");
  const encodeContent = (text: string) => Array.from(text, (char) => char.codePointAt(0)!);
  const note = prepareInput("note", "alpha\n\nbeta", characterTokens, profile, encodeContent);
  assert.deepEqual(note.passageRanges, [[{ passageIndex: 0, startToken: 1, endToken: 12 }]]);
});

test("Jina alignment rejects equal-count but different-ID boundary seams", () => {
  const profile = getModelProfile("jinaai/jina-embeddings-v2-small-en");
  const count: TokenCounter = (text) => Array.from(text).length * 700 + 2;
  const encodeContent = (text: string) => Array.from(text, (char) => char.codePointAt(0)! + text.length);
  assert.equal(prepareInput("query", "aa", count, profile).tokenCount, 1402);
  assert.throws(() => prepareInput("note", "aa", count, profile, encodeContent), Error);
});
