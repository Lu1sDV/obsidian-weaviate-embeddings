import assert from "node:assert/strict";
import test from "node:test";
import { JevReranker } from "../src/reranking";
import { CurrentRerankingCache } from "../src/reranking-cache";

const config = { enabled: true, provider: "jev-openrouter" as const, apiKey: "test-key" };
const candidate = (body: string) => ({ title: "Note", passages: [{ heading: "Topic", body }] });
const reranker = () => new JevReranker(() => config, async body => ({
  answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: "noul", noul: 0.5 }])),
}));
const options = () => ({ signal: new AbortController().signal, isCurrent: () => true,
  cache: { store: new CurrentRerankingCache(), snapshotKey: "current" } });

test("successful and cached outcomes omit an absent warning property", async () => {
  const ranker = reranker(), opts = options(), candidates = [candidate("one"), candidate("two")];
  const first = await ranker.rerank("query", candidates, opts);
  const cached = await ranker.rerank("query", candidates, opts);
  for (const result of [first, cached]) {
    assert.equal(result.reranked, true);
    assert.equal(Object.hasOwn(result, "warning"), false);
  }
  assert.equal(cached.diagnostics?.cacheHit, true);
});

test("omitted lower-ranked evidence retains its warning on a cache hit", async () => {
  const ranker = reranker(), opts = options();
  const first = candidate("a".repeat(9000));
  first.passages.push({ heading: "Topic", body: "b".repeat(9000) });
  const candidates = [first, candidate("two")];
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await ranker.rerank("query", candidates, opts);
    assert.equal(result.reranked, true);
    assert.match(result.warning!, /1 lower-ranked matched passage/);
  }
});
