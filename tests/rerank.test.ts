import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admittedResults, buildConnectionGraph, buildSimilarityGraph, visibleResults } from "../src/graph";
import { expandSearchPool } from "../src/search/retrieval-service";
import { JudgmentCache } from "../src/rerank/cache";
import { selectEvidence } from "../src/rerank/evidence";
import { planRerank } from "../src/rerank/planner";
import { remoteNoteAllowed, validateRerankSettings } from "../src/rerank/policy";
import { rankNotes } from "../src/rerank/reduce";
import { RerankService } from "../src/rerank/service";
import { RerankStore } from "../src/rerank/store";
import { packRequests, parseJudgments, requestBatch } from "../src/rerank/systemone";
import { defaultRerankSettings, LIMITS, RerankError, type RerankAccess, type RerankInput, type ServingIdentity } from "../src/rerank/types";
import type { RemoteRequest, RemoteTransport } from "../src/rerank/remote-http";
import type { SearchResult } from "../src/types";
import type { HybridWindow, RetrievedNoteCandidate } from "../src/weaviate";

function result(index: number, passages = 1): SearchResult {
  return {
    noteId: `note-${index}`,
    snapshotId: `snapshot-${index}`,
    path: `Private-path-${index}.md`,
    title: `Title ${index}`,
    score: 1 - index / 100,
    scoreKind: "hybrid",
    passages: Array.from({ length: passages }, (_, passage) => ({
      passageId: `passage-${index}-${passage}`,
      heading: `Heading ${passage}`,
      body: `Evidence ${index}, distinct section ${passage}.`,
      startLine: passage * 10,
      endLine: passage * 10 + 5,
    })),
  };
}

function candidate(index: number, passages = 1, bodyBytes = 0): RetrievedNoteCandidate {
  const note = result(index, passages);
  const detailed = note.passages.map((passage, passageIndex) => ({
    noteId: note.noteId,
    snapshotId: note.snapshotId,
    path: note.path,
    storedTitle: note.title,
    passageId: passage.passageId,
    heading: passage.heading,
    body: bodyBytes ? `Evidence ${index} ${"x".repeat(bodyBytes)} ${passageIndex}` : passage.body,
    startLine: passage.startLine,
    endLine: passage.endLine,
    retrievalScore: note.score - passageIndex / 1000,
    retrievalRank: index + passageIndex * 60,
  }));
  note.passages = detailed.map(({ passageId, heading, body, startLine, endLine }) => ({ passageId, heading, body, startLine, endLine }));
  return { result: note, noteRank: index, passages: detailed };
}

function window(items: readonly RetrievedNoteCandidate[], limit: number): HybridWindow {
  return { limit, notes: items, passages: items.flatMap(item => item.passages) };
}

function configured(patch: Partial<RerankAccess> = {}): RerankAccess {
  return {
    ...defaultRerankSettings(),
    provider: "typesafe",
    enabled: true,
    evidencePassages: 1,
    consent: true,
    apiKey: "synthetic-test-key",
    revision: 0,
    settingsRevision: 0,
    cloudPolicyRevision: 0,
    consentRevision: 0,
    credentialRevision: 0,
    ...patch,
  };
}

function input(candidates: readonly RetrievedNoteCandidate[] = [candidate(0), candidate(1)], patch: Partial<RerankInput> = {}): RerankInput {
  return {
    vaultId: "vault",
    generation: 1,
    fingerprint: "fingerprint",
    query: "Evidence",
    candidates,
    minimumCandidateCount: Math.min(30, candidates.length),
    candidateWindow: 300,
    candidateExhausted: candidates.length < 60,
    signal: new AbortController().signal,
    isCurrent: () => true,
    isAllowed: () => true,
    ...patch,
  };
}

function response(options: RemoteRequest, score = 0.8, model = "jev-1.13.0", upstream = "TypeSafe"): string {
  const request = JSON.parse(options.body) as { questions: Record<string, unknown> };
  return JSON.stringify({
    model,
    ...(options.provider === "openrouter" ? { provider: upstream } : {}),
    answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: "noul", noul: score }])),
    usage: { input_tokens: 100, output_tokens: 4, ...(options.provider === "openrouter" ? { cost: 0.00001 } : {}) },
  });
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
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

test("ordinary display remains 30 while manual rerank can widen to 60", async () => {
  const initial = Array.from({ length: 30 }, (_, index) => candidate(index, 10));
  const baseline = structuredClone(visibleResults(initial.map(item => item.result), () => true));
  const expanded = Array.from({ length: 60 }, (_, index) => {
    const item = candidate(index);
    item.result.score = 0.1;
    return item;
  });
  const calls: number[] = [];
  const pool = await expandSearchPool(window(initial, 300), async limit => {
    calls.push(limit);
    return window(expanded, limit);
  }, () => true, () => true);
  assert.deepEqual(calls, [600]);
  assert.equal(pool?.candidates.length, 60);
  assert.ok(pool?.candidates.every(item => item.result.score === 0.1));
  assert.deepEqual(visibleResults(initial.map(item => item.result), () => true), baseline);
  assert.equal(admittedResults(expanded.map(item => item.result), () => true, 60).length, 60);
});

test("widening replaces the complete relative-fusion window and stale work is discarded", async () => {
  const initial = Array.from({ length: 30 }, (_, index) => candidate(index, 10));
  let current = true;
  const stale = await expandSearchPool(window(initial, 300), async limit => {
    current = false;
    return window([candidate(40)], limit);
  }, () => true, () => current);
  assert.equal(stale, undefined);
  const exhausted = await expandSearchPool(window([candidate(0)], 300), async () => { throw new Error("unexpected fetch"); }, () => true, () => true);
  assert.equal(exhausted?.candidateExhausted, true);
});

test("remote policy is a veto only and requires current metadata", () => {
  const settings = validateRerankSettings({ excludedFolders: ["Secret"], excludedFiles: ["One.md"] });
  assert.equal(settings.enabled, false);
  assert.equal(settings.evidencePassages, 1);
  assert.equal(remoteNoteAllowed(settings, "Public.md", undefined), false);
  assert.equal(remoteNoteAllowed(settings, "Public.md", {}), true);
  for (const value of [false, "false", "true", null, 0]) {
    assert.equal(remoteNoteAllowed(settings, "Public.md", { frontmatter: { ai_remote: value } }), false);
  }
  assert.equal(remoteNoteAllowed(settings, "Public.md", { frontmatter: { ai_remote: true, ai_rerank: false } }), false);
  assert.equal(remoteNoteAllowed(settings, "Secret/A.md", { frontmatter: { ai_remote: true } }), false);
  assert.equal(remoteNoteAllowed(settings, "Secrets/A.md", {}), true);
  assert.equal(remoteNoteAllowed(settings, "One.md", {}), false);
  assert.throws(() => validateRerankSettings({ evidencePassages: 3 }));
  assert.equal("apiKey" in validateRerankSettings({ apiKey: "never-save-here" }), false);
});

test("device-local settings split policy from credentials and preserve restrictive permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-store-"));
  try {
    let changes = 0;
    const store = new RerankStore("vault", () => { changes++; }, directory);
    await store.load();
    assert.equal(store.access().enabled, false);
    await store.setConsent("typesafe", true);
    await store.setKey("typesafe", "not-a-real-key");
    await store.configure({ enabled: true, provider: "typesafe", evidencePassages: 2 });
    assert.ok(changes >= 3);

    const reopened = new RerankStore("vault", () => {}, directory);
    await reopened.load();
    assert.equal(reopened.access().apiKey, "not-a-real-key");
    assert.equal(reopened.access().evidencePassages, 2);

    const settingsFile = join(directory, "rerank-settings.json");
    const credentialFile = join(directory, "rerank-credentials.json");
    const settingsText = await readFile(settingsFile, "utf8");
    const credentialText = await readFile(credentialFile, "utf8");
    assert.ok(!settingsText.includes("not-a-real-key"));
    assert.ok(!credentialText.includes("excludedFolders"));
    if (process.platform !== "win32") {
      assert.equal((await stat(settingsFile)).mode & 0o777, 0o600);
      assert.equal((await stat(credentialFile)).mode & 0o777, 0o600);
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
    }
    await writeFile(settingsFile, "{broken");
    await assert.rejects(reopened.load());
    assert.equal(reopened.access().enabled, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("one passage is the production evidence policy and two passages is an explicit experiment", () => {
  const items = [candidate(0, 3), candidate(1, 2)];
  items[0]!.passages[1]!.body = items[0]!.passages[0]!.body;
  const one = selectEvidence(items, "Evidence", 1);
  assert.deepEqual(one.map(record => record.noteId), ["note-0", "note-1"]);
  const two = selectEvidence(items, "Evidence", 2);
  assert.equal(two.length, 4);
  assert.equal(two[1]!.passageId, "passage-0-2");
  assert.deepEqual(Object.keys(one[0]!.evidence), ["title", "heading", "body"]);
});

test("long multilingual evidence stays byte-bounded and source identities remain local", () => {
  for (const body of ["漢字🙂 codice ".repeat(2000), "\u0000\\\"\n".repeat(2000)]) {
    const item = candidate(0);
    item.passages[0]!.body = body;
    item.result.passages[0]!.body = body;
    const record = selectEvidence([item], "codice")[0]!;
    assert.ok(Buffer.byteLength(JSON.stringify(record.evidence)) <= LIMITS.evidenceBytes);
    assert.equal(record.truncated, true);
    assert.equal(record.snapshotId, item.result.snapshotId);
  }
});

test("packed requests use query-only state, opaque keys, and at most 24 independent questions", () => {
  const records = selectEvidence(Array.from({ length: 40 }, (_, index) => candidate(index)), "query");
  const singleton = JSON.parse(requestBatch("typesafe", "query", records.slice(0, 1), "singleton").body);
  assert.deepEqual(singleton.state, { query: "query" });
  const batches = packRequests("openrouter", "query", records);
  assert.ok(batches.length >= 2);
  assert.equal(batches.reduce((sum, batch) => sum + batch.records.length, 0), 40);
  for (const batch of batches) {
    assert.ok(batch.records.length <= 24);
    const parsed = JSON.parse(batch.body);
    assert.deepEqual(parsed.state, { query: "query" });
    assert.ok(!batch.body.includes("Private-path") && !batch.body.includes("snapshot-") && !batch.body.includes("passage-"));
  }
});

test("planner deterministically shrinks two-passage cohorts rather than scoring a prefix", () => {
  const items = Array.from({ length: 60 }, (_, index) => candidate(index, 2, 800));
  const plan = planRerank(items, 30, "Evidence", "typesafe", 2);
  assert.equal(plan.candidates.length, 30);
  assert.equal(plan.records.length, 60);
  assert.ok(plan.batches.length <= LIMITS.maxBatches);
});

const validWire = () => ({
  model: "jev-1.13.0",
  answers: { p000: { type: "noul", noul: 0.8 } },
  usage: { input_tokens: 10, output_tokens: 1 },
});

test("strict wire validation accepts real zeros and rejects malformed or unapproved responses", () => {
  for (const value of [0, 0.8, 1]) {
    const body = validWire();
    body.answers.p000.noul = value;
    assert.equal(parseJudgments(JSON.stringify(body), "typesafe", ["p000"]).scores.get("p000"), value);
  }
  for (const body of [
    '{"model":"jev-1.13.0","model":"jev-1.13.0"}',
    JSON.stringify(validWire()).replace('"noul":0.8', '"noul":1e999'),
    JSON.stringify({ ...validWire(), model: "jev-latest" }),
    "{broken",
  ]) {
    assert.throws(() => parseJudgments(body, "typesafe", ["p000"]), RerankError);
  }
});

test("OpenRouter serving provenance records an approved dated model and upstream provider", () => {
  const body = JSON.stringify({
    model: "typesafe/jev-1.13-20260917",
    provider: "TypeSafe",
    answers: { p000: { type: "noul", noul: 0.7 } },
    usage: { input_tokens: 11, output_tokens: 1, cost: 0.00001 },
  });
  const parsed = parseJudgments(body, "openrouter", ["p000"]);
  assert.deepEqual(parsed.servingIdentity, {
    route: "openrouter",
    requestedModel: "typesafe/jev-1.13",
    servedModel: "typesafe/jev-1.13-20260917",
    upstreamProvider: "TypeSafe",
  });
});

test("max passage aggregation preserves local score semantics and graph cosine", () => {
  const items = Array.from({ length: 60 }, (_, index) => candidate(index, 2));
  const before = structuredClone(items);
  const records = selectEvidence(items, "Evidence", 2);
  const scores = new Map(records.map(record => [record.key, record.passageId === "passage-59-1" ? 0.99 : 0.01]));
  const serving: ServingIdentity = { route: "typesafe", requestedModel: "jev-1.13.0", servedModel: "jev-1.13.0" };
  const ranked = rankNotes(items, records, scores, serving);
  assert.equal(ranked.length, 30);
  assert.equal(ranked[0]!.noteId, "note-59");
  assert.equal(ranked[0]!.score, items[59]!.result.score);
  assert.equal(ranked[0]!.scoreKind, "hybrid");
  assert.equal(ranked[0]!.passages[0]!.passageId, "passage-59-1");
  assert.equal(ranked[0]!.rerank?.coverage, "complete");
  assert.deepEqual(items, before);

  const graph = buildSimilarityGraph(ranked, undefined,
    ranked.map(note => ({ noteId: note.noteId, snapshotId: note.snapshotId, vector: [1, 0] })), 2);
  assert.ok(graph.edges.every(edge => edge.cosine === 1));
  const connection = { ...ranked[0]!, score: 0.2, scoreKind: "similarity" as const };
  assert.equal(buildConnectionGraph([connection], { noteId: "anchor", snapshotId: "anchor", title: "Anchor" }).edges[0]!.cosine, 0.2);
});

test("RAM cache enforces TTL, LRU count, bytes and explicit clearing", () => {
  let now = 0;
  const cache = new JudgmentCache(() => now, 2, 100, 10);
  cache.set("a", 0.1);
  cache.set("b", 0.2);
  assert.equal(cache.get("a"), 0.1);
  cache.set("c", 0.3);
  assert.equal(cache.get("b"), undefined);
  now = 11;
  assert.equal(cache.get("a"), undefined);
  cache.set("x".repeat(200), 0.1);
  assert.equal(cache.get("x".repeat(200)), undefined);
  cache.clear();
});

for (const [name, access, allowed] of [
  ["off", configured({ enabled: false }), true],
  ["unconfigured", configured({ apiKey: "" }), true],
  ["policy", configured({ consent: false }), true],
  ["policy", configured(), false],
] as const) {
  test(`service bypasses ${name}/${allowed} without transmission`, async () => {
    let calls = 0;
    const service = new RerankService(() => access, async options => { calls++; return response(options); });
    const outcome = await service.run(input(undefined, {
      isAllowed: item => allowed || item.result.noteId === "note-0",
    }));
    assert.equal(outcome.status, "retained");
    assert.equal(outcome.reason, name);
    assert.equal(calls, 0);
  });
}

test("complete cached jobs still recheck policy and exact provenance", async () => {
  let access = configured();
  let calls = 0;
  const service = new RerankService(() => access, async options => {
    calls++;
    options.beforeSend();
    return response(options);
  });
  const request = input([candidate(0)]);
  assert.equal((await service.run(request)).status, "applied");
  assert.equal(calls, 1);
  const cached = await service.run(request);
  assert.equal(cached.status, "applied");
  assert.equal(cached.metrics.cacheHits, 1);
  assert.equal(calls, 1);
  assert.equal((await service.run({ ...request, isAllowed: () => false })).status, "retained");
  assert.equal(calls, 1);

  for (const patch of [
    { query: "Evidence?" },
    { vaultId: "other-vault" },
    { generation: 2 },
    { fingerprint: "new-profile" },
  ]) await service.run({ ...request, ...patch });
  assert.equal(calls, 5);

  const edited = candidate(0);
  edited.passages[0]!.body += " Changed.";
  edited.result.passages[0]!.body += " Changed.";
  await service.run({ ...request, candidates: [edited] });
  assert.equal(calls, 6);

  access = { ...access, settingsRevision: 1, revision: 1 };
  service.invalidate();
  await service.run(request);
  assert.equal(calls, 7);
});

test("one failed batch cancels peers and never publishes or caches a partial cohort", async () => {
  let calls = 0;
  let fail = true;
  const items = Array.from({ length: 50 }, (_, index) => candidate(index, 1, 1200));
  const transport: RemoteTransport = async options => {
    const call = ++calls;
    await wait(options.signal, call % 2 ? 1 : 5);
    if (fail && call === 2) throw new RerankError("provider", true);
    return response(options);
  };
  const service = new RerankService(() => configured(), transport);
  const original = input(items, { minimumCandidateCount: 30 });
  const before = structuredClone(original.candidates);
  const first = await service.run(original);
  assert.equal(first.status, "retained");
  assert.deepEqual(original.candidates, before);
  fail = false;
  const second = await service.run(original);
  assert.equal(second.status, "applied");
  assert.equal(second.metrics.cacheHits, 0);
});

test("mixed serving identities reject the complete job", async () => {
  let count = 0;
  const items = Array.from({ length: 50 }, (_, index) => candidate(index, 1, 1200));
  const service = new RerankService(() => configured({ provider: "openrouter" }), async options =>
    response(options, 0.8, ++count === 1 ? "typesafe/jev-1.13-20260917" : "typesafe/jev-1.13.0"));
  const outcome = await service.run(input(items, { minimumCandidateCount: 30 }));
  assert.equal(outcome.status, "retained");
  assert.equal(outcome.reason, "model-change");
});

test("snapshot invalidation prevents cache insertion and publication", async () => {
  let current = true;
  let calls = 0;
  const service = new RerankService(() => configured(), async options => {
    calls++;
    current = false;
    return response(options);
  });
  assert.equal((await service.run(input([candidate(0)], { isCurrent: () => current }))).status, "cancelled");
  current = true;
  const next = await service.run(input([candidate(0)]));
  assert.equal(next.status, "applied");
  assert.equal(next.metrics.cacheHits, 0);
});

test("global concurrency is two across views and revocation cancels queued work", async () => {
  const entered = deferred<void>();
  let active = 0;
  let peak = 0;
  let access = configured();
  const service = new RerankService(() => access, async options => {
    options.beforeSend();
    active++;
    peak = Math.max(peak, active);
    if (active === 2) entered.resolve();
    try {
      await wait(options.signal, 1000);
      return response(options);
    } finally {
      active--;
    }
  });

  const first = service.run(input([candidate(0)]));
  const second = service.run(input([candidate(1)]));
  const queued = service.run(input([candidate(2)]));
  await entered.promise;
  access = { ...access, revision: 1, consent: false, consentRevision: 1, cloudPolicyRevision: 1 };
  service.invalidate();
  const outcomes = await Promise.all([first, second, queued]);
  assert.equal(peak, 2);
  assert.ok(outcomes.every(outcome => outcome.status === "cancelled"));
});

test("query cancellation stops remote work without blocking a new local intent", async () => {
  const entered = deferred<void>();
  const controller = new AbortController();
  let calls = 0;
  const service = new RerankService(() => configured(), async options => {
    if (++calls === 1) {
      entered.resolve();
      await wait(options.signal, 60_000);
    }
    return response(options);
  });
  const old = service.run(input([candidate(0)], { signal: controller.signal }));
  await entered.promise;
  controller.abort();
  const latest = await service.run(input([candidate(1)], { query: "New intent" }));
  assert.equal(latest.status, "applied");
  assert.equal((await old).status, "cancelled");
});

test("absolute deadline and preflight budget failures retain local results", async () => {
  const slow = new RerankService(() => configured(), async options => {
    await wait(options.signal, 60_000);
    return response(options);
  });
  const timed = await slow.run(input([candidate(0)]));
  assert.equal(timed.status, "retained");
  assert.equal(timed.reason, "deadline");
  assert.ok(timed.metrics.elapsedMs < LIMITS.deadlineMs + 500);

  let calls = 0;
  const budgeted = new RerankService(() => configured(), async options => {
    calls++;
    return response(options);
  });
  const rejected = await budgeted.run(input(Array.from({ length: 60 }, (_, index) => candidate(index)), {
    query: "q".repeat(LIMITS.queryBytes + 1),
    minimumCandidateCount: 30,
  }));
  assert.equal(rejected.status, "retained");
  assert.equal(rejected.reason, "budget");
  assert.equal(calls, 0);
});

test("three transient outages open the route circuit; cancellation does not", async () => {
  let calls = 0;
  const service = new RerankService(() => configured(), async () => {
    calls++;
    throw new RerankError("provider", true);
  });
  for (let index = 0; index < 3; index++) await service.run(input([candidate(index)]));
  const outcome = await service.run(input([candidate(4)]));
  assert.equal(outcome.status, "retained");
  assert.equal(outcome.reason, "circuit-open");
  assert.equal(calls, 3);
});

test("synthetic connection test uses built-in text even when vault reranking is disabled", async () => {
  let payload = "";
  const service = new RerankService(() => configured({ enabled: false, consent: false }), async options => {
    payload = options.body;
    return response(options);
  });
  const outcome = await service.testConnection(new AbortController().signal);
  assert.equal(outcome.status, "applied");
  assert.ok(payload.includes("Two plus two equals four."));
  assert.ok(!payload.includes("Private-path"));
  service.dispose();
  assert.equal((await service.run(input())).status, "cancelled");
});
