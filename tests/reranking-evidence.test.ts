import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { prepareEvidence, MAX_NOTE_EVIDENCE_BYTES, MAX_SOURCE_BYTES, type SourcePassage, type EvidenceOptions } from "../src/reranking-evidence";
import { createStoredEvidenceLoader, verifyEvidenceSource } from "../src/reranking-source";
import { JevReranker } from "../src/reranking";
import { CurrentRerankingCache } from "../src/reranking-cache";
import { buildJevBatches, measureJevRequest, readJevInputTokens, MAX_REQUEST_BYTES, type JevRequest } from "../src/jev-protocol";
import { RerankingError, RerankingCancelledError } from "../src/reranking-errors";
import { DEFAULT_RERANKING_SETTINGS, mergeRerankingSettings } from "../src/reranking-config";

const passage = (index: number, body = `Complete source paragraph ${index}.\n`, heading = "Topic"): SourcePassage => ({ passageId: `p${index}`, heading, body });
const options: EvidenceOptions = { policy: "contextual", chunkingMode: "late", allowWholeShortNotes: false };
const source = Array.from({ length: 7 }, (_, index) => passage(index));
const candidate = (indices: number[] = [3], from: readonly SourcePassage[] = source) => ({ noteId: "n", path: "private/folder/n.md", snapshotId: "s", title: "A note", score: 0.7, passages: indices.map(index => from[index]!) });
const hash = (source: readonly SourcePassage[]) => createHash("sha256").update(source.map(p => p.body).join("")).digest("hex");
const texts = (result: ReturnType<typeof prepareEvidence>) => result.document.passages.map(p => p.text);
const answers = (body: JevRequest) => ({ answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: "noul", noul: 0.7 }])) });
const current = () => ({ signal: new AbortController().signal, isCurrent: () => true });
const config = { ...DEFAULT_RERANKING_SETTINGS, enabled: true, apiKey: "test-key", chunkingMode: "late" as const };

function sourceFixture() {
  const manifest = { noteId: "n", path: "private/folder/n.md", snapshotId: "s", modelFingerprint: "fp", generation: 1, bodyHash: hash(source), passageIds: source.map(p => p.passageId), servable: true };
  const state = { indexingEnabled: true, servingReady: true, schemaUpdating: false, activeGeneration: 1, notes: { n: manifest }, pathToNoteId: { "private/folder/n.md": "n" }, pendingPurges: [] as string[] };
  let calls = 0;
  const db = { passagesForNote: async (...args: [number, string, string, string]) => {
    calls++; assert.deepEqual(args, [1, "n", "s", "fp"]); return structuredClone(source);
  } };
  return { manifest, state, db, calls: () => calls, load: createStoredEvidenceLoader(state, db, () => "fp") };
}

test("complete matched bodies retain answer-bearing tails beyond the former prefix cap", () => {
  const body = "irrelevant introduction ".repeat(180) + "The answer is at the end.😀";
  const result = prepareEvidence({ title: "title", passages: [passage(0, body)] }, { ...options, policy: "matched-passages" });
  assert.equal(result.document.passages[0]!.text, body);
  assert.equal(result.summary.matched, 1); assert.equal(result.summary.context, 0);
});

test("standard context adds only immediate same-heading source neighbours", () => {
  const result = prepareEvidence(candidate(), { ...options, chunkingMode: "standard" }, source);
  assert.deepEqual(texts(result), [source[2]!.body, source[3]!.body, source[4]!.body]);
  assert.deepEqual(result.document.passages.map(p => p.kind), ["context", "match", "context"]);
});

test("late context restores a fitting section including a non-adjacent definition", () => {
  const from = source.map(p => ({ ...p }));
  from[0]!.body = "Project Orion is the indexing service.\n";
  from[3]!.body = "It replaced the nightly batch job in 2024.\n";
  const result = prepareEvidence(candidate([3], from), options, from);
  assert.ok(texts(result).includes(from[0]!.body));
  assert.equal(result.summary.matched, 1); assert.equal(result.summary.context, 6);
});

test("late adjacency can cross a heading boundary; standard adjacency cannot", () => {
  const from = [passage(0, "Orion is our service.\n", "Definition"), passage(1, "It supports live updates.\n", "Behaviour")];
  assert.equal(prepareEvidence(candidate([1], from), { ...options, chunkingMode: "standard" }, from).summary.context, 0);
  assert.equal(prepareEvidence(candidate([1], from), options, from).summary.context, 1);
});

test("overlapping context selections are deduplicated and remain in source order", () => {
  const result = prepareEvidence(candidate([4, 2]), options, source);
  assert.deepEqual(texts(result), source.map(p => p.body));
  assert.equal(result.summary.matched, 2);
  assert.equal(result.document.passages.filter(p => p.kind === "match").length, 2);
});

test("omitted spans are explicitly marked instead of implying adjacency", () => {
  const from = source.map((p, i) => passage(i, i === 3 ? "x".repeat(5000) : p.body, ""));
  const result = prepareEvidence(candidate([2, 4], from), options, from);
  assert.ok(!texts(result).includes(from[3]!.body));
  const right = result.document.passages.find(p => p.text === from[4]!.body)!;
  assert.equal(right.gapBefore, true);
});

test("unfitting context cannot evict or truncate primary evidence", () => {
  const from = [passage(0, "neighbour ".repeat(1200)), passage(1, "match ".repeat(1400)), passage(2, "neighbour ".repeat(1400))];
  const result = prepareEvidence(candidate([1], from), options, from);
  assert.deepEqual(texts(result), [from[1]!.body]);
  assert.ok(result.summary.bytes <= MAX_NOTE_EVIDENCE_BYTES);
});

test("later matched passages can be omitted with counts, but the strongest one remains complete", () => {
  const from = [passage(0, "a".repeat(9000)), passage(1, "b".repeat(9000)), passage(2, "c")];
  const result = prepareEvidence(candidate([0, 1, 2], from), { ...options, policy: "matched-passages" });
  assert.deepEqual(texts(result), [from[0]!.body, from[2]!.body]);
  assert.equal(result.summary.omittedMatches, 1);
});

test("an oversized strongest passage fails rather than being prefix-cut", () => {
  assert.throws(() => prepareEvidence({ title: "title", passages: [passage(0, "a".repeat(MAX_NOTE_EVIDENCE_BYTES)), passage(1)] }, options), error => error instanceof RerankingError && error.code === "evidence-limit");
});

test("whole short notes require explicit consent and contextual policy", () => {
  const from = [passage(0, "Part one.\n", "One"), passage(1, "Part two.\n", "Two")];
  const plain = prepareEvidence(candidate([1], from), options, from);
  assert.equal(plain.summary.wholeNote, false);
  const whole = prepareEvidence(candidate([1], from), { ...options, allowWholeShortNotes: true }, from);
  assert.equal(whole.document.coverage, "whole-short-note");
  assert.deepEqual(texts(whole), [from.map(p => p.body).join("")]);
  assert.equal(prepareEvidence(candidate([1], from), { ...options, policy: "matched-passages", allowWholeShortNotes: true }, from).summary.wholeNote, false);
});

test("long notes do not become whole-note uploads when the option is enabled", () => {
  const from = [passage(0, "x".repeat(6500)), passage(1)];
  assert.equal(prepareEvidence(candidate([1], from), { ...options, allowWholeShortNotes: true }, from).summary.wholeNote, false);
});

test("source and matched-passage conflicts never enter expanded evidence", () => {
  assert.throws(() => prepareEvidence({ ...candidate(), passages: [passage(3, "forged body")] }, options, source), RerankingError);
  assert.throws(() => prepareEvidence({ ...candidate(), passages: [passage(99)] }, options, source), RerankingError);
  assert.throws(() => prepareEvidence(candidate(), options, [...source, source[0]!]), RerankingError);
});

test("body hash and exact ordered manifest membership verify canonical source", () => {
  const expected = { bodyHash: hash(source), passageIds: source.map(p => p.passageId) };
  verifyEvidenceSource(source, expected);
  assert.throws(() => verifyEvidenceSource([...source].reverse(), expected), RerankingError);
  assert.throws(() => verifyEvidenceSource(source.slice(1), expected), RerankingError);
  assert.throws(() => verifyEvidenceSource(source.map((p, i) => i ? p : { ...p, body: "unindexed text" }), expected), RerankingError);
  assert.throws(() => verifyEvidenceSource(source, { ...expected, bodyHash: "wrong" }), RerankingError);
});

test("source verification is byte-bounded before remote evidence selection", () => {
  const big = [passage(0, "a".repeat(MAX_SOURCE_BYTES + 1))];
  assert.throws(() => verifyEvidenceSource(big, { bodyHash: hash(big), passageIds: ["p0"] }), RerankingError);
});

test("stored source is requested with exact generation, model and snapshot identity", async () => {
  const f = sourceFixture();
  assert.deepEqual(await f.load(candidate(), { signal: new AbortController().signal, assertCurrent() {} }), source);
  assert.equal(f.calls(), 1);
});

for (const event of ["purge", "snapshot", "bodyHash", "generation", "stopped", "manifest", "path"] as const) {
  test(`source-loading cancellation: ${event} change prevents use of the response`, async () => {
    const f = sourceFixture();
    let deliver!: (value: SourcePassage[]) => void;
    const db = { passagesForNote: () => new Promise<SourcePassage[]>(resolve => { deliver = resolve; }) };
    const pending = createStoredEvidenceLoader(f.state, db, () => "fp")(candidate(), { signal: new AbortController().signal, assertCurrent() {} });
    if (event === "purge") f.state.pendingPurges.push("n");
    if (event === "snapshot") f.manifest.snapshotId = "new";
    if (event === "bodyHash") f.manifest.bodyHash = "new";
    if (event === "generation") f.state.activeGeneration++;
    if (event === "stopped") f.state.indexingEnabled = false;
    if (event === "manifest") f.manifest.passageIds.reverse();
    if (event === "path") f.manifest.path = "other.md";
    deliver(source);
    await assert.rejects(pending, RerankingCancelledError);
  });
}

test("pre-aborted and excluded source requests never read the database", async () => {
  const f = sourceFixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(f.load(candidate(), { signal: controller.signal, assertCurrent() {} }), RerankingCancelledError);
  f.manifest.servable = false;
  await assert.rejects(f.load(candidate(), { signal: new AbortController().signal, assertCurrent() {} }), RerankingCancelledError);
  assert.equal(f.calls(), 0);
});

test("an aborted source promise cannot hold the queue or dispatch JEV later", async () => {
  let reads = 0, sends = 0;
  let resolve!: (value: readonly SourcePassage[]) => void;
  const reranker = new JevReranker(() => config, async body => { sends++; return answers(body); }, 5000, async () => { reads++; return new Promise(r => { resolve = r; }); });
  const controller = new AbortController();
  const pending = reranker.rerank("query", [candidate(), candidate()], { signal: controller.signal, isCurrent: () => true });
  controller.abort(); await assert.rejects(pending, RerankingCancelledError);
  resolve(source); await new Promise(r => setImmediate(r));
  assert.equal(reads, 1); assert.equal(sends, 0);
});

test("source I/O is covered by the same overall deadline as reranking", async () => {
  let sends = 0;
  const reranker = new JevReranker(() => config, async body => { sends++; return answers(body); }, 5, () => new Promise(() => undefined));
  const result = await reranker.rerank("query", [candidate(), candidate()], current());
  assert.equal(result.reranked, false); assert.equal(sends, 0); assert.match(result.warning!, /timed out/);
});

test("all evidence is prepared before the first cloud call; invalid later sources fail all-or-nothing", async () => {
  let reads = 0, sends = 0;
  const reranker = new JevReranker(() => config, async body => { sends++; return answers(body); }, 5000, async () => {
    if (++reads === 2) throw new RerankingError("source"); return source;
  });
  const items = [candidate(), candidate()];
  const result = await reranker.rerank("query", items, current());
  assert.equal(sends, 0); assert.deepEqual(result.results, items); assert.equal(result.reranked, false);
});

test("matched-only mode does not fetch additional source; disabled mode does neither", async () => {
  let reads = 0, sends = 0;
  const settings = { ...config, evidencePolicy: "matched-passages" as const };
  const reranker = new JevReranker(() => settings, async body => { sends++; return answers(body); }, 5000, async () => { reads++; return source; });
  await reranker.rerank("query", [candidate(), candidate()], current());
  settings.enabled = false;
  await reranker.rerank("query", [candidate(), candidate()], current());
  assert.equal(reads, 0); assert.equal(sends, 1);
});

test("evidence selection does not change original retrieval passages, scores or jump targets", async () => {
  const items = [candidate([4, 2]), candidate([1])], before = structuredClone(items);
  const reranker = new JevReranker(() => config, async body => answers(body), 5000, async () => source);
  const result = await reranker.rerank("query", items, current());
  assert.ok(result.reranked); assert.deepEqual(items, before);
  assert.deepEqual(result.results[0]!.passages, before[0]!.passages);
  assert.equal(result.results[0]!.score, before[0]!.score);
});

test("changing surrounding evidence invalidates the current-search score cache", async () => {
  let sends = 0;
  const from = structuredClone(source), store = new CurrentRerankingCache();
  const reranker = new JevReranker(() => config, async body => { sends++; return answers(body); }, 5000, async () => from);
  const opts = { ...current(), cache: { store, snapshotKey: "same" } };
  await reranker.rerank("query", [candidate(), candidate()], opts);
  const cached = await reranker.rerank("query", [candidate(), candidate()], opts);
  assert.equal(cached.diagnostics!.cacheHit, true); assert.equal(sends, 1);
  from[0]!.body = "Changed surrounding context.\n";
  await reranker.rerank("query", [candidate(), candidate()], opts);
  assert.equal(sends, 2);
});

test("packing accounts for escaped JSON overhead, queries and every question without splitting notes", () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ title: `Note ${i}`, passages: [passage(i, "\u0000😀".repeat(900))] }));
  const batches = buildJevBatches("🧪".repeat(300), items);
  assert.ok(batches.length > 1);
  const seen: string[] = [];
  for (const body of batches) {
    const budget = measureJevRequest(body);
    assert.ok(budget.bytes <= MAX_REQUEST_BYTES);
    assert.equal(budget.tokens, null); assert.equal(budget.mode, "serialized-utf8");
    assert.equal(budget.bytes, Buffer.byteLength(JSON.stringify(body)));
    for (const [id, doc] of Object.entries(body.state.candidates)) {
      seen.push(id);
      assert.equal(doc.passages[0]!.text, items[Number(id.split("_")[1])]!.passages[0]!.body);
    }
  }
  assert.equal(seen.length, 30); assert.equal(new Set(seen).size, 30);
});

test("reported token usage is actual post-request metadata, not a byte-to-token estimate", async () => {
  assert.equal(readJevInputTokens({ usage: { input_tokens: 123 } }), 123);
  for (const value of [{}, { usage: { input_tokens: "123" } }, { usage: { input_tokens: -1 } }]) assert.equal(readJevInputTokens(value), null);
  const reranker = new JevReranker(() => ({ ...config, evidencePolicy: "matched-passages" }), async body => ({ ...answers(body), usage: { input_tokens: 321 } }));
  const result = await reranker.rerank("query", [candidate(), candidate()], current());
  assert.equal(result.diagnostics!.reportedInputTokens, 321);
  assert.equal(result.diagnostics!.budgetMode, "serialized-utf8");
});

test("old excerpt-only consent is disabled instead of silently widening cloud uploads", () => {
  assert.equal(mergeRerankingSettings({ enabled: true, provider: "jev-openrouter" }).enabled, false);
  assert.equal(mergeRerankingSettings({ ...DEFAULT_RERANKING_SETTINGS, enabled: true }).enabled, true);
  assert.equal(mergeRerankingSettings({ ...DEFAULT_RERANKING_SETTINGS, enabled: true, evidencePolicy: "arbitrary" }).enabled, false);
  assert.equal(DEFAULT_RERANKING_SETTINGS.allowWholeShortNotes, false);
});

test("the outbound evidence contains no local identity or frontmatter fields", () => {
  const prepared = prepareEvidence(candidate(), options, source);
  const text = JSON.stringify(buildJevBatches("q", [candidate()], [prepared.document]));
  for (const term of ["noteId", "snapshotId", "passageId", "private/folder", "bodyHash", "frontmatterJson", "startLine"]) assert.ok(!text.includes(term));
});
