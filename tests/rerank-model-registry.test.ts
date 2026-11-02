import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenRouterModelRegistry, readDecisionCatalogue } from "../src/rerank/model-registry";
import { RerankService } from "../src/rerank/service";
import { defaultRerankSettings, RerankError, type RerankAccess, type RerankInput } from "../src/rerank/types";
import type { RemoteRequest } from "../src/rerank/remote-http";
import { MODEL } from "./helpers/rerank-model";

function access(patch: Partial<RerankAccess> = {}): RerankAccess {
  return { ...defaultRerankSettings(), model: MODEL.requestedModel, apiKey: "synthetic-key",
    enabled: true, consent: true, revision: 0, modelRevision: 0, settingsRevision: 0,
    cloudPolicyRevision: 0, consentRevision: 0, credentialRevision: 0, ...patch };
}

function entry(id = MODEL.modelId) {
  return { id, canonical_slug: id === MODEL.modelId ? MODEL.canonicalSlug : `${id}-20261001`,
    architecture: { input_modalities: ["text"], output_modalities: ["decisions"], tokenizer: "Other" },
    context_length: 262144, top_provider: { context_length: 262144 }, endpoints: ["/api/alpha/decisions"] };
}

function wire(request: RemoteRequest): string {
  const body = JSON.parse(request.body) as { questions: Record<string, unknown> };
  return JSON.stringify({ model: MODEL.canonicalSlug,
    answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: "noul", noul: 0.99 }])),
    usage: { input_tokens: 20, output_tokens: 1, cost: 0.00001 } });
}

function input(): RerankInput {
  const result = { noteId: "one", snapshotId: "snap", path: "One.md", title: "One", score: 0.8,
    scoreKind: "hybrid" as const, passages: [{ passageId: "p1", heading: "", body: "Useful evidence", startLine: 0, endLine: 1 }] };
  return { source: { kind: "search", title: "", text: "Useful", anchors: [] },
    documents: [{ title: "One", text: "Useful evidence", anchors: [{ start: 0, end: 15, passageId: "p1" }] }],
    isSourceAllowed: () => true, vaultId: "test", generation: 1, fingerprint: "test", query: "Useful", queryEpoch: 0,
    filtersIdentity: "[]", minimumCandidateCount: 1, baselineWindow: 300, candidateWindow: 300,
    candidateExhausted: true, signal: new AbortController().signal, isCurrent: () => true, isAllowed: () => true,
    candidates: [{ result, noteRank: 0, passages: [{ ...result.passages[0]!, noteId: "one", snapshotId: "snap",
      path: "One.md", storedTitle: "One", retrievalScore: 0.8, retrievalRank: 0 }] }] };
}

test("catalogue pagination finds a model on a later page without approving inference", async () => {
  const urls: string[] = [];
  const registry = new OpenRouterModelRegistry(async (url, key) => {
    urls.push(url);
    assert.equal(key, "synthetic-key");
    return urls.length === 1
      ? { data: [entry("another/decision")], links: { next: "/api/v1/models?output_modalities=decisions&cursor=next" }, total_count: 2 }
      : { data: [entry()], links: { next: null }, total_count: 2 };
  });
  const model = await registry.load(access(), new AbortController().signal);
  assert.equal(model.modelId, MODEL.modelId);
  assert.equal(urls.length, 2);
  assert.match(urls[1]!, /^https:\/\/openrouter\.ai\/api\/v1\/models\?/);
  assert.equal(registry.current(access()), null);
});

test("untrusted catalogue pagination cannot forward credentials to another origin", async () => {
  let reads = 0;
  const registry = new OpenRouterModelRegistry(async () => {
    reads++;
    return { data: [entry()], links: { next: "https://example.test/steal" } };
  });
  await assert.rejects(registry.load(access(), new AbortController().signal));
  assert.equal(reads, 1);
  await assert.rejects(readDecisionCatalogue("https://example.test/steal", "synthetic-key", new AbortController().signal));
});

test("repeated pages and cancelled catalogue loads stop before further reads", async () => {
  let calls = 0;
  const registry = new OpenRouterModelRegistry(async url => { calls++; return { data: [], links: { next: url } }; });
  await assert.rejects(registry.load(access(), new AbortController().signal), RerankError);
  assert.equal(calls, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(registry.load(access(), controller.signal), RerankError);
  assert.equal(calls, 1);
});

test("approval binds model, credential revisions and TTL, while ordinary toggles preserve it", () => {
  let now = 1000;
  const registry = new OpenRouterModelRegistry(async () => ({ data: [entry()] }), () => now);
  const original = access();
  registry.approve(original, MODEL);
  assert.ok(registry.current(original));
  assert.ok(registry.current({ ...original, enabled: false, revision: 1, settingsRevision: 1 }));
  assert.ok(registry.current({ ...original, consent: false, consentRevision: 1 }));
  assert.equal(registry.current({ ...original, apiKey: "another-key" }), null);
  assert.equal(registry.current({ ...original, credentialRevision: 2 }), null, "restoring an old key must not revive approval");
  assert.equal(registry.current({ ...original, modelRevision: 2 }), null, "restoring an old model must not revive approval");
  assert.equal(registry.current({ ...original, model: "another/decision" }), null);
  const copy = registry.current(original)!;
  copy.acceptedServedModels = ["attacker/model"];
  assert.ok(!registry.current(original)!.acceptedServedModels.includes("attacker/model"));
  now += 24 * 60 * 60_000;
  assert.equal(registry.current(original), null);
});

test("a failed revalidation revokes the previous approval", async () => {
  const registry = new OpenRouterModelRegistry(async () => { throw new RerankError("authentication"); });
  registry.approve(access(), MODEL);
  await assert.rejects(registry.load(access(), new AbortController().signal));
  assert.equal(registry.current(access()), null);
});

test("only a successful synthetic inference enables a catalogue-checked model", async () => {
  let calls = 0;
  const registry = new OpenRouterModelRegistry(async () => ({ data: [entry()] }));
  const service = new RerankService(() => access(), async request => {
    calls++;
    const body = JSON.parse(request.body) as { state: { source: { segments: Array<{ text: string }> } } };
    assert.equal(body.state.source.segments[0]?.text, "What is two plus two?");
    assert.ok(!request.body.includes("Useful evidence"));
    return wire(request);
  }, registry);
  const skipped = await service.run(input());
  assert.equal(skipped.status, "retained");
  assert.equal(skipped.status === "retained" && skipped.reason, "model-unverified");
  assert.equal(calls, 0);
  const tested = await service.testConnection(new AbortController().signal);
  assert.equal(tested.status, "applied");
  assert.equal(calls, 1);
  assert.ok(service.validatedModel);
});

test("bad inference and changed credentials never approve a model", async () => {
  const badRegistry = new OpenRouterModelRegistry(async () => ({ data: [entry()] }));
  const bad = new RerankService(() => access(), async () => "{}", badRegistry);
  const failed = await bad.testConnection(new AbortController().signal);
  assert.equal(failed.status, "retained");
  assert.equal(bad.validatedModel, null);

  let current = access();
  const changedRegistry = new OpenRouterModelRegistry(async () => {
    current = access({ apiKey: "new-key", credentialRevision: 1 });
    return { data: [entry()] };
  });
  let calls = 0;
  const changed = new RerankService(() => current, async request => { calls++; return wire(request); }, changedRegistry);
  const cancelled = await changed.testConnection(new AbortController().signal);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(calls, 0);
  assert.equal(changed.validatedModel, null);
});

test("another model or credential does not inherit a previous selection's rate-limit circuit", async () => {
  let current = access();
  let loads = 0;
  const registry = new OpenRouterModelRegistry(async () => { loads++; return { data: [entry()] }; });
  registry.approve(current, MODEL);
  let reject = true;
  const service = new RerankService(() => current, async request => {
    if (reject) throw new RerankError("rate-limit", true, 429);
    return wire(request);
  }, registry);
  const limited = await service.run(input());
  assert.equal(limited.status === "retained" && limited.reason, "rate-limit");
  current = access({ apiKey: "replacement-key", credentialRevision: 1 });
  reject = false;
  const validated = await service.testConnection(new AbortController().signal);
  assert.equal(validated.status, "applied");
  assert.equal(loads, 1);
});

test("dispatched failures and missing price data leave total cost unknown", async () => {
  for (const fail of [true, false]) {
    const registry = new OpenRouterModelRegistry(async () => ({ data: [entry()] }));
    registry.approve(access(), MODEL);
    const service = new RerankService(() => access(), async request => {
      if (fail) throw new RerankError("provider", true);
      const body = JSON.parse(wire(request)) as { usage: Record<string, unknown> };
      delete body.usage.cost;
      return JSON.stringify(body);
    }, registry);
    const outcome = await service.run(input());
    assert.equal(outcome.status, fail ? "retained" : "applied");
    assert.equal(outcome.metrics.requests, 1);
    assert.equal(outcome.metrics.cost, null);
  }
});
