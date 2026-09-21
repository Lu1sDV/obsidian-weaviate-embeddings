import assert from "node:assert/strict";
import test from "node:test";
import { CurrentRerankingCache } from "../src/reranking-cache";
import { JevReranker } from "../src/reranking";
import { RerankingCancelledError } from "../src/jev-protocol";

function fixture() {
  const store = new CurrentRerankingCache();
  const config = { enabled: true, provider: "jev-openrouter" as const, apiKey: "secret-api-key" };
  const candidates = [0, 1].map(i => ({ title: `note ${i}`, score: i, passages: [{ heading: "title", body: `secret body ${i}` }] }));
  let calls = 0;
  let fail = false;
  const reranker = new JevReranker(() => config, async body => {
    calls++;
    if (fail) throw new Error("private error");
    return { answers: Object.fromEntries(Object.keys(body.questions).map((id, i) => [id, { type: "noul", noul: i / 2 }])) };
  });
  const options = { signal: new AbortController().signal, isCurrent: () => true, cache: { store, snapshotKey: "generation-fingerprint-ordered-snapshots" } };
  return { store, config, candidates, reranker, options, calls: () => calls, fail: () => { fail = true; } };
}

test("identical wire input reuses scores, not old result objects or retrieval scores", async () => {
  const f = fixture();
  await f.reranker.rerank("private query", f.candidates, f.options);
  const current = f.candidates.map(c => ({ ...c, score: 10 }));
  const result = await f.reranker.rerank("private query", current, f.options);
  assert.equal(f.calls(), 1);
  assert.ok(result.results.every(c => c.score === 10));
  assert.ok(result.reranked);
  assert.doesNotMatch(JSON.stringify(f.store), /secret|private query|note 0/);
});

test("cache hits still require current admission and a live signal", async () => {
  const f = fixture();
  await f.reranker.rerank("q", f.candidates, f.options);
  await assert.rejects(f.reranker.rerank("q", f.candidates, { ...f.options, isCurrent: () => false }), RerankingCancelledError);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.reranker.rerank("q", f.candidates, { ...f.options, signal: controller.signal }), RerankingCancelledError);
  assert.equal(f.calls(), 1);
});

test("the cache holds one signature only and clear invalidates it", async () => {
  const f = fixture();
  await f.reranker.rerank("a", f.candidates, f.options);
  await f.reranker.rerank("b", f.candidates, f.options);
  await f.reranker.rerank("a", f.candidates, f.options);
  f.store.clear();
  await f.reranker.rerank("a", f.candidates, f.options);
  assert.equal(f.calls(), 4);
});

test("credentials, snapshots, and actual evidence participate in the signature", async () => {
  const f = fixture();
  await f.reranker.rerank("q", f.candidates, f.options);
  f.config.apiKey = "new-key";
  await f.reranker.rerank("q", f.candidates, f.options);
  f.options.cache.snapshotKey = "new-snapshot";
  await f.reranker.rerank("q", f.candidates, f.options);
  f.candidates[0]!.passages[0]!.body = "new-evidence";
  await f.reranker.rerank("q", f.candidates, f.options);
  assert.equal(f.calls(), 4);
});

test("provider failures never become successful cached results", async () => {
  const f = fixture(); f.fail();
  for (let i = 0; i < 2; i++) {
    const result = await f.reranker.rerank("q", f.candidates, f.options);
    assert.equal(result.reranked, false);
    assert.deepEqual(result.results, f.candidates);
  }
  assert.equal(f.calls(), 2);
});
