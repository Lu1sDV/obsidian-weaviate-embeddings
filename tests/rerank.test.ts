import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admittedResults, buildConnectionGraph, buildSimilarityGraph, visibleResults } from "../src/graph";
import { expandSearchPool } from "../src/retrieval-service";
import { JudgmentCache } from "../src/rerank/cache";
import { selectEvidence } from "../src/rerank/evidence";
import { remoteNoteAllowed, validateRerankSettings } from "../src/rerank/policy";
import { rankNotes } from "../src/rerank/reduce";
import { RerankService } from "../src/rerank/service";
import { RerankStore } from "../src/rerank/store";
import { packRequests, parseJudgments, requestBatch } from "../src/rerank/systemone";
import { defaultRerankSettings, LIMITS, RerankError, type RerankAccess, type RerankInput } from "../src/rerank/types";
import type { RemoteRequest, RemoteTransport } from "../src/rerank/http";
import type { SearchResult } from "../src/types";

function note(index: number, passages = 1): SearchResult {
  return { noteId: `note-${index}`, snapshotId: `snapshot-${index}`, path: `Private-path-${index}.md`, title: `Title ${index}`,
    score: 1 - index / 100, scoreKind: "hybrid", passages: Array.from({ length: passages }, (_, passage) => ({
      passageId: `passage-${index}-${passage}`, heading: `Heading ${passage}`, body: `Evidence ${index}, distinct section ${passage}.`,
      startLine: passage * 10, endLine: passage * 10 + 5, retrievalScore: 1 - index / 100 - passage / 1000, retrievalRank: index + passage * 60,
    })) };
}
function configured(patch: Partial<RerankAccess> = {}): RerankAccess {
  return { ...defaultRerankSettings(), provider: "typesafe", enabled: true, consent: true, apiKey: "synthetic-test-key", revision: 0, ...patch };
}
function input(candidates = [note(0), note(1)], patch: Partial<RerankInput> = {}): RerankInput {
  return { vaultId: "vault", generation: 1, fingerprint: "fingerprint", query: "Evidence", candidates,
    signal: new AbortController().signal, isCurrent: () => true, isAllowed: () => true, ...patch };
}
function response(options: RemoteRequest, score = 0.8, model = "jev-1.13.0"): string {
  const request = JSON.parse(options.body) as { questions: Record<string, unknown> };
  return JSON.stringify({ model, answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: "noul", noul: score }])),
    usage: { input_tokens: 100, output_tokens: 4 } });
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function wait(signal: AbortSignal, milliseconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}

// Candidate contracts: same disabled cap, independent expansion, no normalized-score merging.
test("admission preserves the old 30-note display and exposes a separate 60-note pool", () => {
  const candidates = Array.from({ length: 65 }, (_, index) => note(index));
  candidates.splice(2, 0, note(0));
  assert.equal(visibleResults(candidates, () => true).length, 30);
  assert.equal(admittedResults(candidates, () => true, 60).length, 60);
  assert.deepEqual(visibleResults(candidates, result => result.noteId !== "note-0").map(result => result.noteId), Array.from({ length: 30 }, (_, index) => `note-${index + 1}`));
});
test("widening replaces the entire window and never rewrites the original baseline", async () => {
  const original = Array.from({ length: 30 }, (_, index) => note(index, 10));
  const baseline = structuredClone(visibleResults(original, () => true));
  const expanded = Array.from({ length: 60 }, (_, index) => ({ ...note(index), score: 0.1 }));
  const calls: number[] = [];
  const pool = await expandSearchPool({ candidates: original, limit: 300 }, async limit => { calls.push(limit); return expanded; }, () => true, () => true);
  assert.deepEqual(calls, [600]); assert.equal(pool!.length, 60);
  assert.ok(pool!.every(result => result.score === 0.1));
  assert.deepEqual(original.slice(0, 30), baseline);
});
test("sufficient or exhausted windows do not make extra local calls; stale expansion is discarded", async () => {
  const fail = async (): Promise<SearchResult[]> => { throw new Error("unexpected fetch"); };
  assert.equal((await expandSearchPool({ candidates: [note(0)], limit: 300 }, fail, () => true, () => true))!.length, 1);
  assert.equal((await expandSearchPool({ candidates: Array.from({ length: 60 }, (_, i) => note(i)), limit: 300 }, fail, () => true, () => true))!.length, 60);
  let current = true;
  assert.equal(await expandSearchPool({ candidates: Array.from({ length: 30 }, (_, i) => note(i, 10)), limit: 300 }, async () => { current = false; return [note(40)]; }, () => true, () => current), undefined);
});

// Privacy never changes local eligibility.
test("remote policy requires metadata, honors both veto spellings, and enforces literal folder boundaries", () => {
  const settings = validateRerankSettings({ excludedFolders: ["Secret"], excludedFiles: ["One.md"] });
  assert.equal(settings.enabled, false);
  assert.equal(remoteNoteAllowed(settings, "Public.md", undefined), false);
  assert.equal(remoteNoteAllowed(settings, "Public.md", {}), true);
  for (const value of [false, "false", "true", null, 0]) assert.equal(remoteNoteAllowed(settings, "Public.md", { frontmatter: { ai_remote: value } }), false);
  assert.equal(remoteNoteAllowed(settings, "Public.md", { frontmatter: { ai_remote: true, ai_rerank: false } }), false);
  assert.equal(remoteNoteAllowed(settings, "Secret/A.md", { frontmatter: { ai_remote: true } }), false);
  assert.equal(remoteNoteAllowed(settings, "Secrets/A.md", {}), true);
  assert.equal(remoteNoteAllowed(settings, "One.md", {}), false);
  assert.equal(remoteNoteAllowed(settings, "../Public.md", {}), false);
  assert.equal(remoteNoteAllowed(validateRerankSettings({ excludedFolders: ["/"] }), "Public.md", {}), false);
  assert.throws(() => validateRerankSettings({ excludedFolders: ["../Secret"] }));
  assert.throws(() => validateRerankSettings({ provider: "unapproved" }));
  assert.equal("apiKey" in validateRerankSettings({ apiKey: "never-save-here" }), false);
});
test("device-local store defaults off, isolates provider consent, persists atomically, and keeps restrictive modes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-store-"));
  try {
    let changes = 0;
    const store = new RerankStore("vault", () => { changes++; }, directory);
    await store.load(); assert.equal(store.access().enabled, false); assert.equal(store.access().consent, false);
    const saving = store.setConsent("typesafe", true);
    assert.equal(changes, 1); // Revocation/invalidation happens synchronously, not after filesystem work.
    await saving; await store.setKey("typesafe", "not-a-real-key"); await store.configure({ enabled: true, provider: "typesafe" });
    assert.equal(store.access().consent, true);
    await store.configure({ provider: "openrouter" }); assert.equal(store.access().consent, false); assert.equal(store.access().apiKey, "");
    const reopened = new RerankStore("vault", () => {}, directory); await reopened.load();
    await reopened.configure({ provider: "typesafe" }); assert.equal(reopened.access().apiKey, "not-a-real-key");
    const filename = join(directory, "rerank-credentials.json");
    if (process.platform !== "win32") { assert.equal((await stat(filename)).mode & 0o777, 0o600); assert.equal((await stat(directory)).mode & 0o777, 0o700); }
    const raw = await readFile(filename, "utf8"); assert.ok(!raw.includes("query"));
    await writeFile(filename, "{broken");
    await assert.rejects(reopened.load()); assert.equal(reopened.access().enabled, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// Payload minimization and bounded evidence, with no live-note hydration.
test("evidence provides every note one passage before distinct second passages", () => {
  const candidates = [note(0, 3), note(1, 2)];
  candidates[0]!.passages[1]!.body = candidates[0]!.passages[0]!.body;
  const selected = selectEvidence(candidates, "Evidence");
  assert.deepEqual(selected.required.map(record => record.noteId), ["note-0", "note-1"]);
  assert.equal(selected.optional[0]!.passageId, "passage-0-2");
  assert.equal(selected.optional.length, 2);
  assert.deepEqual(Object.keys(selected.required[0]!.evidence), ["title", "heading", "body"]);
  assert.throws(() => selectEvidence([note(0), note(0)], "Evidence"));
});
test("long multilingual and escaped evidence stays byte-bounded and identity/source anchors stay local", () => {
  for (const body of ["漢字🙂 codice ".repeat(2000), "\u0000\\\"\n".repeat(2000)]) {
    const candidate = note(0); candidate.passages[0]!.body = body;
    const record = selectEvidence([candidate], "codice").required[0]!;
    assert.ok(Buffer.byteLength(JSON.stringify(record.evidence)) <= LIMITS.evidenceBytes);
    assert.equal(record.truncated, true); assert.equal(record.snapshotId, candidate.snapshotId);
    assert.equal(candidate.passages[0]!.body, body);
  }
  const candidate = note(0); candidate.title = "\u0000".repeat(200); candidate.passages[0]!.heading = "\u0000".repeat(300);
  assert.throws(() => selectEvidence([candidate], "Evidence"), RerankError); // Termination even when metadata alone is oversized.
});
test("reference and experimental serializers contain only approved payload fields and bounded batches", () => {
  const candidates = Array.from({ length: 40 }, (_, index) => note(index));
  const records = selectEvidence(candidates, "query").required;
  const reference = JSON.parse(requestBatch("typesafe", "query", records.slice(0, 1), false).body);
  assert.deepEqual(Object.keys(reference.state), ["query", "candidate"]);
  const batches = packRequests("openrouter", "query", records, true);
  assert.deepEqual(batches.map(batch => batch.records.length), [16, 16, 8]);
  for (const batch of batches) {
    const parsed = JSON.parse(batch.body);
    assert.deepEqual(parsed.state, { query: "query" });
    assert.ok(!batch.body.includes("Private-path") && !batch.body.includes("snapshot-") && !batch.body.includes("passage-"));
    assert.ok(!batch.body.includes("retrievalScore") && !batch.body.includes("synthetic-test-key"));
    for (const [key, question] of Object.entries(parsed.questions) as [string, { instructions: { candidate: { body: string } } }][]) {
      assert.equal(question.instructions.candidate.body, batch.records.find(record => record.key === key)!.evidence.body);
    }
  }
});

// Wire contract, including duplicate JSON keys (JSON.parse would otherwise overwrite them).
const validWire = () => ({ model: "jev-1.13.0", answers: { p000: { type: "noul", noul: 0.8 } }, usage: { input_tokens: 10, output_tokens: 1 } });
test("valid zero and one Nouls are accepted, with no fabricated confidence", () => {
  for (const value of [0, 0.8, 1]) {
    const body = validWire(); body.answers.p000.noul = value;
    assert.equal(parseJudgments(JSON.stringify(body), "typesafe", ["p000"]).scores.get("p000"), value);
  }
});
type MutableWire = { model: unknown; answers: Record<string, Record<string, unknown>>; usage: Record<string, unknown> };
const malformed: Record<string, (body: MutableWire) => void> = {
  missing: body => { delete body.answers.p000; }, extra: body => { body.answers.p001 = body.answers.p000!; },
  type: body => { body.answers.p000!.type = "score"; }, string: body => { body.answers.p000!.noul = "0.8"; },
  high: body => { body.answers.p000!.noul = 1.1; }, low: body => { body.answers.p000!.noul = -0.1; },
  null: body => { body.answers.p000!.noul = null; }, confidence: body => { body.answers.p000!.confidence = 0.9; },
  usage: body => { body.usage.input_tokens = -1; }, model: body => { body.model = "jev-latest"; },
  cost: body => { body.usage.cost = "free"; },
};
for (const [name, mutate] of Object.entries(malformed)) {
  test(`wire rejects ${name}`, () => { const body = validWire(); mutate(body); assert.throws(() => parseJudgments(JSON.stringify(body), "typesafe", ["p000"]), RerankError); });
}
test("duplicate keys, malformed JSON, nonfinite scores and oversized bodies fail closed", () => {
  for (const body of ['{"model":"jev-1.13.0","model":"jev-1.13.0"}',
    JSON.stringify(validWire()).replace('"noul":0.8', '"noul":0.8,"n\\u006ful":0.7'),
    JSON.stringify(validWire()).replace('"noul":0.8', '"noul":1e999'), "{broken", " ".repeat(LIMITS.responseBytes + 1)]) {
    assert.throws(() => parseJudgments(body, "typesafe", ["p000"]), RerankError);
  }
});

// Pure reducer and original graph contracts.
test("max aggregation promotes a note below rank 30, preserves scores and original passage anchors", () => {
  const candidates = Array.from({ length: 60 }, (_, index) => note(index, 2));
  const before = structuredClone(candidates);
  const selected = selectEvidence(candidates, "Evidence"), records = [...selected.required, ...selected.optional];
  const scores = new Map(records.map(record => [record.key, record.passageId === "passage-59-1" ? 0.99 : 0.01]));
  const ranked = rankNotes(candidates, records, scores, "typesafe", "jev-1.13.0");
  assert.equal(ranked.length, 30); assert.equal(ranked[0]!.noteId, "note-59");
  assert.equal(ranked[0]!.score, candidates[59]!.score); assert.equal(ranked[0]!.scoreKind, "hybrid");
  assert.equal(ranked[0]!.passages[0]!.passageId, "passage-59-1"); assert.equal(ranked[0]!.passages[0]!.startLine, 10);
  assert.deepEqual(candidates, before); assert.equal(ranked[1]!.noteId, "note-0");
  const graph = buildSimilarityGraph(ranked, undefined, ranked.map(result => ({ noteId: result.noteId, snapshotId: result.snapshotId, vector: [1, 0] })), 2);
  assert.equal(graph.nodes.length, 30); assert.ok(graph.edges.every(edge => edge.cosine === 1));
  const connection = { ...ranked[0]!, score: 0.2, scoreKind: "similarity" as const };
  assert.equal(buildConnectionGraph([connection], { noteId: "anchor", snapshotId: "anchor", title: "Anchor" }).edges[0]!.cosine, 0.2);
  scores.delete(records[0]!.key); assert.throws(() => rankNotes(candidates, records, scores, "typesafe", "jev-1.13.0"));
});
test("RAM cache enforces TTL, LRU count, bytes and explicit clearing", () => {
  let now = 0;
  const cache = new JudgmentCache(() => now, 2, 100, 10);
  cache.set("a", 0.1); cache.set("b", 0.2); assert.equal(cache.get("a"), 0.1);
  cache.set("c", 0.3); assert.equal(cache.get("b"), undefined);
  now = 11; assert.equal(cache.get("a"), undefined);
  cache.set("x".repeat(200), 0.1); assert.equal(cache.get("x".repeat(200)), undefined);
  cache.set("d", 0.4); cache.clear(); assert.equal(cache.get("d"), undefined);
});

for (const [name, access, allowed] of [
  ["off", configured({ enabled: false }), true], ["unconfigured", configured({ apiKey: "" }), true],
  ["policy", configured({ consent: false }), true], ["policy", configured(), false],
] as const) test(`service bypasses ${name}/${allowed} without a single transmission`, async () => {
  let calls = 0;
  const service = new RerankService(() => access, async options => { calls++; return response(options); });
  const outcome = await service.run(input(undefined, { isAllowed: result => allowed || result.noteId === "note-0" }));
  assert.equal(outcome.status, "retained"); assert.equal(outcome.reason, name); assert.equal(calls, 0);
});
test("complete cached jobs still check policy; query, snapshot, evidence, layout and vault identities miss", async () => {
  let access = configured(), calls = 0;
  const service = new RerankService(() => access, async options => { calls++; options.beforeSend(); return response(options); });
  const request = input([note(0)]);
  assert.equal((await service.run(request)).status, "applied"); assert.equal(calls, 1);
  const cached = await service.run(request); assert.equal(cached.status, "applied"); assert.equal(cached.metrics.cacheHits, 1); assert.equal(calls, 1);
  assert.equal((await service.run({ ...request, isAllowed: () => false })).status, "retained"); assert.equal(calls, 1);
  for (const patch of [{ query: "Evidence?" }, { vaultId: "other-vault" }, { generation: 2 }, { fingerprint: "new-profile" }]) await service.run({ ...request, ...patch });
  assert.equal(calls, 5);
  const edited = note(0); edited.passages[0]!.body += " Changed."; await service.run({ ...request, candidates: [edited] }); assert.equal(calls, 6);
  access = { ...access, experimentalBatching: true }; await service.run(request); assert.equal(calls, 7);
  service.invalidate(); await service.run(request); assert.equal(calls, 8);
});
test("one failed batch cancels its peers and publishes no partial ranking or cache", async () => {
  let calls = 0, fail = true;
  const transport: RemoteTransport = async options => {
    const call = ++calls;
    await wait(options.signal, call % 2 ? 1 : 5);
    if (fail && call === 2) throw new RerankError("provider", true);
    return response(options);
  };
  const service = new RerankService(() => configured(), transport);
  const original = input([note(0), note(1), note(2)]), before = structuredClone(original.candidates);
  const result = await service.run(original); assert.equal(result.status, "retained"); assert.deepEqual(original.candidates, before);
  fail = false;
  const retry = await service.run(original); assert.equal(retry.status, "applied"); assert.equal(retry.metrics.cacheHits, 0);
});
test("inconsistent serving revisions cannot be combined", async () => {
  let count = 0;
  const service = new RerankService(() => configured({ provider: "openrouter" }), async options => response(options, 0.8, ++count === 1 ? "jev-1.13.0" : "typesafe/jev-1.13.0"));
  const result = await service.run(input()); assert.equal(result.status, "retained"); assert.equal(result.reason, "model-change");
});
test("snapshot invalidation during a response prevents cache insertion and publication", async () => {
  let current = true, calls = 0;
  const service = new RerankService(() => configured(), async options => { calls++; if (calls === 1) current = false; return response(options); });
  assert.equal((await service.run(input([note(0)], { isCurrent: () => current }))).status, "cancelled");
  current = true;
  const next = await service.run(input([note(0)])); assert.equal(next.status, "applied"); assert.equal(next.metrics.cacheHits, 0);
});
test("global concurrency is two across views and revoked queued work never sends", async () => {
  const entered = deferred<void>();
  let active = 0, peak = 0, calls = 0, access = configured();
  const service = new RerankService(() => access, async options => {
    options.beforeSend(); calls++; active++; peak = Math.max(peak, active);
    if (active === 2) entered.resolve();
    try { await wait(options.signal, 1000); return response(options); } finally { active--; }
  });
  const first = service.run(input([note(0), note(1), note(2)]));
  await entered.promise;
  const queued = service.run(input([note(10), note(11)]));
  access = { ...access, revision: 1, consent: false }; service.invalidate();
  const results = await Promise.all([first, queued]);
  assert.equal(peak, 2); assert.equal(calls, 2); assert.ok(results.every(result => result.status === "cancelled"));
});
test("query cancellation stops HTTP and a new query does not wait for the old operation", async () => {
  const entered = deferred<void>(), controller = new AbortController();
  let calls = 0;
  const service = new RerankService(() => configured(), async options => {
    if (++calls === 1) { entered.resolve(); await wait(options.signal, 60_000); }
    return response(options);
  });
  const old = service.run(input([note(0)], { signal: controller.signal })); await entered.promise; controller.abort();
  const latest = await service.run(input([note(1)], { query: "New intent" }));
  assert.equal(latest.status, "applied"); assert.equal((await old).status, "cancelled");
});
test("absolute deadline cancels slow bodies and returns a nonfatal baseline outcome", async () => {
  const service = new RerankService(() => configured(), async options => { await wait(options.signal, 60_000); return response(options); });
  const result = await service.run(input([note(0)]));
  assert.equal(result.status, "retained"); assert.equal(result.reason, "deadline");
  assert.ok(result.metrics.elapsedMs < LIMITS.deadlineMs + 500);
});
test("whole-operation budget is checked before the first request, not after a prefix was scored", async () => {
  let calls = 0;
  const service = new RerankService(() => configured(), async options => { calls++; return response(options); });
  const result = await service.run(input(Array.from({ length: 60 }, (_, index) => note(index)), { query: "q".repeat(4000) }));
  assert.equal(result.status, "retained"); assert.equal(result.reason, "budget"); assert.equal(calls, 0);
});
test("three transient outages open the circuit, but explicit cancellation does not", async () => {
  let calls = 0;
  const service = new RerankService(() => configured(), async () => { calls++; throw new RerankError("provider", true); });
  for (let index = 0; index < 3; index++) await service.run(input([note(index)]));
  const result = await service.run(input([note(4)])); assert.equal(result.status !== "applied" && result.reason, "circuit-open"); assert.equal(calls, 3);
});
test("synthetic connection tests are explicit and never take vault text, even while reranking is disabled", async () => {
  let payload = "";
  const service = new RerankService(() => configured({ enabled: false, consent: false }), async options => { payload = options.body; return response(options); });
  const result = await service.testConnection(new AbortController().signal); assert.equal(result.status, "applied");
  assert.ok(payload.includes("Two plus two equals four.")); assert.ok(!payload.includes("Private-path"));
  service.dispose(); assert.equal((await service.run(input())).status, "cancelled");
});
