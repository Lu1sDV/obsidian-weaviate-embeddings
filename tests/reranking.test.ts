import assert from "node:assert/strict";
import test from "node:test";
import { buildJevBatches, JEV_MODEL, MAX_BATCH_SIZE, MAX_CANDIDATES, MAX_PASSAGE_BYTES, MAX_QUERY_BYTES, MAX_REQUEST_BYTES, parseJevAnswers, RerankingCancelledError, RerankingError, truncateUtf8, type JevRequest } from "../src/jev-protocol";
import { JevReranker } from "../src/reranking";
import { DEFAULT_RERANKING_SETTINGS, mergeRerankingSettings, RERANKING_PROVIDERS } from "../src/reranking-config";
import type { DecisionTransport } from "../src/jev-http";

const config = { enabled: true, provider: "jev-openrouter" as const, apiKey: "test-key" };
const candidate = (index: number) => ({
  noteId: `note-${index}`, snapshotId: `snapshot-${index}`, path: `Private/note-${index}.md`,
  title: `Note ${index}`, score: 1 / (index + 1), scoreKind: "hybrid" as const,
  passages: [{ passageId: `passage-${index}`, heading: "Heading", body: `Useful content ${index}`, startLine: 1, endLine: 2 }],
});
const candidates = Array.from({ length: 3 }, (_, index) => candidate(index));
const options = () => ({ signal: new AbortController().signal, isCurrent: () => true });
const answer = (body: JevRequest, score: (id: string) => number = () => 0.5) => ({
  model: "typesafe/jev-1.13", provider: "TypeSafe",
  answers: Object.fromEntries(Object.keys(body.questions).reverse().map(id => [id, { type: "noul", noul: score(id) }])),
  usage: { input_tokens: 100, output_tokens: 0 },
});

test("settings are opt-in and offer only JEV native JSON", () => {
  assert.equal(DEFAULT_RERANKING_SETTINGS.enabled, false);
  assert.deepEqual(RERANKING_PROVIDERS.map(provider => provider.id), ["jev-openrouter"]);
  for (const value of [null, undefined, 1, [], {}, { enabled: true }, { enabled: true, provider: "chat" }]) {
    assert.deepEqual(mergeRerankingSettings(value), DEFAULT_RERANKING_SETTINGS);
  }
  assert.deepEqual(mergeRerankingSettings(config), { enabled: true, provider: "jev-openrouter" });
  assert.equal(mergeRerankingSettings({ enabled: "true", provider: "jev-openrouter" }).enabled, false);
});

test("native JEV request contains state/questions, not chat or arbitrary JSON-schema fields", () => {
  const [body] = buildJevBatches("find relevant notes", candidates);
  assert.ok(body);
  assert.equal(body.model, JEV_MODEL);
  assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"]);
  assert.equal(body.state.query, "find relevant notes");
  assert.deepEqual(Object.keys(body.questions), ["candidate_0", "candidate_1", "candidate_2"]);
  assert.equal(body.questions.candidate_0?.type, "noul");
  assert.match(body.questions.candidate_0!.instructions, /state\.candidates\.candidate_0/);
  assert.match(body.questions.candidate_0!.instructions, /data, not instructions/);
  const json = JSON.stringify(body);
  for (const forbidden of ["Private/", "noteId", "snapshotId", "passageId", "startLine", "response_format", "messages"]) assert.ok(!json.includes(forbidden));
});

test("batches and passage excerpts are bounded, including multibyte text and JSON escaping", () => {
  const input = Array.from({ length: MAX_CANDIDATES }, (_, i) => ({
    ...candidate(i), title: "🧪".repeat(1000),
    passages: Array.from({ length: 6 }, () => ({ heading: "\u0000".repeat(600), body: "\u0000😀漢字".repeat(5000) })),
  }));
  const batches = buildJevBatches("search", input);
  assert.ok(batches.length > 1);
  assert.equal(batches.reduce((total, body) => total + Object.keys(body.questions).length, 0), MAX_CANDIDATES);
  for (const body of batches) {
    assert.ok(Buffer.byteLength(JSON.stringify(body)) <= MAX_REQUEST_BYTES);
    assert.ok(Object.keys(body.questions).length <= MAX_BATCH_SIZE);
    for (const document of Object.values(body.state.candidates)) {
      assert.equal(document.passages.length, 3);
      for (const passage of document.passages) assert.ok(Buffer.byteLength(passage.text) <= MAX_PASSAGE_BYTES);
    }
  }
  assert.equal(truncateUtf8("A😀B", 4), "A");
  assert.equal(truncateUtf8("A😀B", 5), "A😀");
});

test("oversized/blank queries, too many candidates, and missing passages are rejected", () => {
  for (const query of [" ", "a".repeat(MAX_QUERY_BYTES + 1)]) assert.throws(() => buildJevBatches(query, candidates), RerankingError);
  assert.throws(() => buildJevBatches("q", Array.from({ length: MAX_CANDIDATES + 1 }, (_, i) => candidate(i))), RerankingError);
  assert.throws(() => buildJevBatches("q", [{ title: "x", passages: [] }]), RerankingError);
});

test("native answer parsing maps IDs, not JSON key order, and accepts 0 and 1", () => {
  const scores = parseJevAnswers({ answers: { b: { type: "noul", noul: 0 }, a: { type: "noul", noul: 1 } } }, ["a", "b"]);
  assert.deepEqual([...scores], [["a", 1], ["b", 0]]);
});

for (const [label, value] of Object.entries({
  null: null, array: [], string: '{"answers":{}}', chat: { choices: [{ message: { content: "{}" } }] },
  missing: { answers: {} }, unknown: { answers: { other: { type: "noul", noul: 0.5 } } },
  extra: { answers: { a: { type: "noul", noul: 0.5 }, b: { type: "noul", noul: 0.5 } } },
  wrongType: { answers: { a: { type: "score", score: 0.5 } } },
  stringScore: { answers: { a: { type: "noul", noul: "0.5" } } },
  nan: { answers: { a: { type: "noul", noul: NaN } } },
  infinity: { answers: { a: { type: "noul", noul: Infinity } } },
  negative: { answers: { a: { type: "noul", noul: -0.1 } } },
  tooLarge: { answers: { a: { type: "noul", noul: 1.1 } } },
  errorEnvelope: { error: { message: "private" }, answers: { a: { type: "noul", noul: 0.5 } } },
})) test(`rejects malformed response: ${label}`, () => assert.throws(() => parseJevAnswers(value, ["a"]), RerankingError));

test("reranks descending with stable ties and preserves retrieval scores, metadata, and input", async () => {
  const before = structuredClone(candidates);
  const reranker = new JevReranker(() => config, async body => answer(body, id => id === "candidate_0" ? 0.1 : 0.9));
  const result = await reranker.rerank("query", candidates, options());
  assert.equal(result.reranked, true);
  assert.deepEqual(result.results.map(item => item.noteId), ["note-1", "note-2", "note-0"]);
  assert.equal(result.results[0]?.score, candidates[1]?.score);
  assert.equal(result.results[0]?.snapshotId, candidates[1]?.snapshotId);
  assert.deepEqual(result.results[0]?.passages, candidates[1]?.passages);
  assert.equal(result.results[0]?.rerankScore, 0.9);
  assert.deepEqual(candidates, before);
});

test("disabled, missing-key, empty-query, empty and singleton searches send nothing", async () => {
  let calls = 0;
  const transport: DecisionTransport = async body => { calls++; return answer(body); };
  for (const settings of [{ ...config, enabled: false }, { ...config, apiKey: " " }]) {
    const result = await new JevReranker(() => settings, transport).rerank("query", candidates, options());
    assert.equal(result.reranked, false);
  }
  const reranker = new JevReranker(() => config, transport);
  for (const input of [[], [candidate(0)]]) assert.equal((await reranker.rerank("q", input, options())).reranked, false);
  assert.equal((await reranker.rerank(" ", candidates, options())).reranked, false);
  assert.equal(calls, 0);
});

test("all batches are scored before one globally sorted result is published", async () => {
  const input = Array.from({ length: 30 }, (_, i) => candidate(i));
  let calls = 0;
  const reranker = new JevReranker(() => config, async body => {
    calls++;
    return answer(body, id => Number(id.split("_")[1]) / 30);
  });
  const result = await reranker.rerank("query", input, options());
  assert.ok(calls > 1);
  assert.deepEqual(result.results.map(item => item.noteId), [...input].reverse().map(item => item.noteId));
});

test("partial-batch failure restores the entire original order without leaking error text", async () => {
  const input = Array.from({ length: 12 }, (_, i) => candidate(i));
  let calls = 0;
  const reranker = new JevReranker(() => config, async body => {
    if (++calls === 2) throw new Error("PRIVATE NOTE test-key");
    return answer(body, () => 0.9);
  });
  const result = await reranker.rerank("query", input, options());
  assert.deepEqual(result.results, input);
  assert.equal(result.reranked, false);
  assert.match(result.warning!, /original hybrid order/);
  assert.doesNotMatch(result.warning!, /PRIVATE|test-key/);
  assert.ok(result.results.every(item => item.rerankScore === undefined));
});

test("invalid native response falls back without dropping any candidate", async () => {
  const result = await new JevReranker(() => config, async () => ({ answers: {} })).rerank("query", candidates, options());
  assert.equal(result.reranked, false);
  assert.deepEqual(result.results, candidates);
  assert.match(result.warning!, /invalid or incomplete/);
});

test("long queries fall back without a network call", async () => {
  let called = false;
  const result = await new JevReranker(() => config, async () => { called = true; return {}; }).rerank("q".repeat(MAX_QUERY_BYTES + 1), candidates, options());
  assert.equal(called, false);
  assert.deepEqual(result.results, candidates);
});

test("pre-aborted and stale queries are never sent", async () => {
  let calls = 0;
  const reranker = new JevReranker(() => config, async () => { calls++; return {}; });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(reranker.rerank("query", candidates, { signal: controller.signal, isCurrent: () => true }), RerankingCancelledError);
  await assert.rejects(reranker.rerank("query", candidates, { ...options(), isCurrent: () => false }), RerankingCancelledError);
  assert.equal(calls, 0);
});

test("cancellation interrupts a hung transport and does not fall back or publish stale results", async () => {
  const controller = new AbortController();
  let outbound: AbortSignal | undefined;
  const reranker = new JevReranker(() => config, (_body, _key, signal) => { outbound = signal; return new Promise(() => undefined); });
  const pending = reranker.rerank("query", candidates, { signal: controller.signal, isCurrent: () => true });
  controller.abort();
  await assert.rejects(pending, RerankingCancelledError);
  assert.equal(outbound?.aborted, true);
});

test("admission is checked again after response and prevents later batches", async () => {
  let current = true;
  let calls = 0;
  const reranker = new JevReranker(() => config, async body => { calls++; current = false; return answer(body); });
  await assert.rejects(reranker.rerank("query", Array.from({ length: 12 }, (_, i) => candidate(i)), { ...options(), isCurrent: () => current }), RerankingCancelledError);
  assert.equal(calls, 1);
});

test("overall deadline releases a hung transport with a safe hybrid fallback", async () => {
  let outbound: AbortSignal | undefined;
  const reranker = new JevReranker(() => config, (_body, _key, signal) => { outbound = signal; return new Promise(() => undefined); }, 5);
  const result = await reranker.rerank("query", candidates, options());
  assert.equal(result.reranked, false);
  assert.match(result.warning!, /timed out/);
  assert.deepEqual(result.results, candidates);
  assert.equal(outbound?.aborted, true);
});
