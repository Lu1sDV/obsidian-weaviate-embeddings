import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planAdaptive, adaptiveLimits } from "../src/rerank/adaptive-plan";
import { RerankService, rankAdaptive } from "../src/rerank/service";
import { RerankStore } from "../src/rerank/store";
import { RerankError } from "../src/rerank/types";
import { validateRerankSettings } from "../src/rerank/policy";
import { MODEL, fakeModelRegistry } from "./helpers/rerank-model";
import { access, note, request } from "./helpers/adaptive-fixtures";
import type { RemoteRequest } from "../src/rerank/remote-http";

function wire(options: RemoteRequest): string {
  const body = JSON.parse(options.body) as { questions: Record<string, unknown> };
  return JSON.stringify({ model: MODEL.canonicalSlug, provider: "TypeSafe",
    answers: Object.fromEntries(Object.keys(body.questions).map((key, index) => [key, { type: "noul", noul: index ? 0.9 : 0.1 }])),
    usage: { input_tokens: 100, output_tokens: 2, cost: 0.0001 } });
}

test("one payload contains a shared source and one independent question per candidate without retrieval metadata", () => {
  const plan = planAdaptive(request(), MODEL, access());
  const body = JSON.parse(plan.batch.body);
  assert.deepEqual(Object.keys(body.state), ["source"]);
  assert.equal(Object.keys(body.questions).length, 2);
  const inspect = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      assert.ok(!["score", "cosine", "retrievalRank", "retrievalScore", "noteId", "snapshotId", "path"].includes(key), key); inspect(nested);
    }
  };
  inspect(body);
  assert.ok(!plan.batch.body.includes("local-only/"));
});

test("adaptive planning reduces only the candidate tail and never returns overflow batches", () => {
  const input = request(Array.from({ length: 60 }, (_, index) => note(index, "relevant words ".repeat(400))));
  const settings = access({ candidateCount: 60 }), plan = planAdaptive(input, MODEL, settings);
  assert.ok(plan.records.length > 0 && plan.records.length < 60);
  assert.equal(plan.records.length, Object.keys(JSON.parse(plan.batch.body).questions).length);
  assert.deepEqual(plan.candidates.map(item => item.result.noteId), input.candidates.slice(0, plan.records.length).map(item => item.result.noteId));
  assert.ok(Buffer.byteLength(plan.batch.body) <= adaptiveLimits(MODEL, settings).bytes);
  assert.ok(plan.batch.estimatedTokens <= plan.budget);
});

test("complete-note mode never skips an oversized first candidate or silently substitutes excerpts", () => {
  const input = request([note(0, "huge ".repeat(50_000)), note(1)]);
  assert.throws(() => planAdaptive(input, MODEL, access({ evidencePolicy: "complete" })), (error: unknown) => error instanceof RerankError && error.reason === "budget");
  const plan = planAdaptive(input, MODEL, access());
  assert.equal(plan.candidates[0]!.result.noteId, "note0"); assert.equal(plan.records[0]!.truncated, true);
});

test("complete-note mode admits a leading complete prefix under the exact serialized guards", () => {
  const input = request([note(0), note(1, "large ".repeat(20_000)), note(2)]);
  const plan = planAdaptive(input, MODEL, access({ evidencePolicy: "complete" }));
  assert.equal(plan.candidates.length, 1); assert.ok(plan.records.every(record => record.selected.complete));
});

test("known Jev default request and question limits are honored without assuming long-context routing", () => {
  const limits = adaptiveLimits(MODEL, access({ tokenBudget: 262144 }));
  assert.equal(limits.bytes, 48_000); assert.equal(limits.questionBytes, 24_000);
  const other = adaptiveLimits({ ...MODEL, modelId: "example/new-model" }, access({ tokenBudget: 262144 }));
  assert.ok(other.bytes > limits.bytes);
});

test("small-model and user budgets both constrain planning", () => {
  const small = adaptiveLimits({ ...MODEL, modelId: "example/new-model", contextTokens: 8192 }, access());
  const capped = adaptiveLimits(MODEL, access({ tokenBudget: 4096 }));
  assert.ok(small.tokens < adaptiveLimits(MODEL, access()).tokens);
  assert.ok(capped.tokens < adaptiveLimits(MODEL, access()).tokens);
  assert.throws(() => planAdaptive(request([], { kind: "search", title: "", text: "x", anchors: [] }), MODEL, access()), RerankError);
});

test("source excerpts are shared unchanged across all candidate questions", () => {
  const source = { kind: "note" as const, noteId: "source", snapshotId: "source-snap", title: "Long source", text: "# Intro\n\n" + "source ".repeat(30_000), anchors: [] };
  const plan = planAdaptive(request([note(0), note(1)], source), MODEL, access());
  const body = JSON.parse(plan.batch.body);
  assert.equal(body.state.source.coverage, "excerpt");
  assert.ok(Object.values(body.questions).every(question => !(question as Record<string, unknown>).source));
  assert.equal(plan.preview.source.shortened, true);
});

test("unfittable selected source passages stop before any request rather than redefining the target", async () => {
  const text = "focus ".repeat(10_000);
  const input = request([note(0)], { kind: "passage", title: "Source", text, anchors: [], selected: { start: 0, end: text.length } });
  let calls = 0;
  const service = new RerankService(() => access(), async options => { calls++; return wire(options); }, fakeModelRegistry());
  const outcome = await service.run(input);
  assert.equal(outcome.status === "retained" && outcome.reason, "source-too-large"); assert.equal(calls, 0);
});

test("ranking is relevance-only and leaves cosine, hybrid scores and stable exact ties intact", () => {
  const input = request(), original = structuredClone(input.candidates), plan = planAdaptive(input, MODEL, access());
  const serving = { route: "openrouter" as const, requestedModel: MODEL.requestedModel, servedModel: MODEL.canonicalSlug };
  const ranked = rankAdaptive(plan, new Map([["c000", 0.1], ["c001", 0.9]]), serving);
  assert.equal(ranked[0]!.noteId, "note1"); assert.equal(ranked[0]!.score, original[1]!.result.score);
  assert.deepEqual(input.candidates, original); assert.equal(ranked[0]!.rerank!.judgments.length, 0, "note scores must not be misrepresented as per-passage judgments");
  const tied = rankAdaptive(plan, new Map([["c000", 0.5], ["c001", 0.5]]), serving);
  assert.deepEqual(tied.map(item => item.noteId), ["note0", "note1"]);
});

test("failed or incomplete inference sends exactly once and never publishes partial relevance", async () => {
  for (const failure of ["http", "partial"] as const) {
    let calls = 0;
    const service = new RerankService(() => access(), async options => {
      calls++;
      if (failure === "http") throw new RerankError("credits", false, 402);
      const response = JSON.parse(wire(options)); delete response.answers.c001; return JSON.stringify(response);
    }, fakeModelRegistry());
    const outcome = await service.run(request());
    assert.equal(outcome.status, "retained"); assert.equal(calls, 1); assert.equal(outcome.metrics.requests, 1);
  }
});

test("source permission applies even to complete cache hits", async () => {
  let calls = 0, sourceAllowed = true;
  const service = new RerankService(() => access(), async options => { calls++; return wire(options); }, fakeModelRegistry());
  const input = { ...request(), isSourceAllowed: () => sourceAllowed };
  assert.equal((await service.run(input)).status, "applied");
  assert.equal((await service.run(input)).metrics.cacheHits, 2); assert.equal(calls, 1);
  sourceAllowed = false;
  const denied = await service.run(input);
  assert.equal(denied.status === "retained" && denied.reason, "policy"); assert.equal(calls, 1);
});

test("source edits cancel pending requests, not just edits to candidates", async () => {
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const service = new RerankService(() => access(), async options => {
    entered(); await new Promise<void>((_, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
    return wire(options);
  }, fakeModelRegistry());
  const input = request(undefined, { kind: "note", title: "Source", text: "Useful source", anchors: [], noteId: "source", snapshotId: "old" });
  const running = service.run(input); await ready; service.invalidate("source");
  assert.equal((await running).status, "cancelled");
});

test("version-2 settings migrate disabled and require new full-source disclosure permission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adaptive-migrate-"));
  try {
    const writeId = "11111111-1111-1111-1111-111111111111";
    await Promise.all([
      writeFile(join(directory, "rerank-settings.json"), JSON.stringify({ version: 2, writeId, settings: access(), consent: { openrouter: true } })),
      writeFile(join(directory, "rerank-credentials.json"), JSON.stringify({ version: 2, writeId, openrouterApiKey: "synthetic-key" })),
    ]);
    const store = new RerankStore("test", () => {}, directory); await store.load();
    assert.equal(store.access().enabled, false); assert.equal(store.access().consent, false);
    assert.equal(store.access().apiKey, "synthetic-key"); assert.equal(store.access().candidateCount, 30);
    await store.setConsent("openrouter", true); await store.configure({ enabled: true, candidateCount: 12 });
    const reopened = new RerankStore("test", () => {}, directory); await reopened.load();
    assert.equal(reopened.access().enabled, true); assert.equal(reopened.access().consent, true); assert.equal(reopened.access().candidateCount, 12);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("invalid numeric controls cannot bypass request limits", () => {
  for (const patch of [{ candidateCount: 0 }, { candidateCount: 61 }, { tokenBudget: Infinity }, { contextTokens: 0 }, { contextMode: "invented" }, { evidencePolicy: "silent-truncate" }]) {
    assert.throws(() => validateRerankSettings(patch));
  }
});


test("deterministic mixed-language plans obey complete serialized request and question guards", () => {
  for (const text of ["Useful sentence. ", "漢字と仮名🙂 ", '\"quoted\" \\ escaped\n', "| key | value |\n| --- | --- |\n"]) {
    for (const count of [1, 7, 30, 60]) {
      const settings = access({ candidateCount: count });
      const input = request(Array.from({ length: count }, (_, index) => note(index, text.repeat(80 + index * 10))));
      const plan = planAdaptive(input, MODEL, settings), limits = adaptiveLimits(MODEL, settings);
      assert.ok(plan.batch.estimatedTokens <= limits.tokens); assert.ok(Buffer.byteLength(plan.batch.body) <= limits.bytes);
      const body = JSON.parse(plan.batch.body);
      for (const question of Object.values(body.questions)) {
        const single = JSON.stringify({ model: body.model, state: body.state, questions: { candidate: question } });
        assert.ok(Buffer.byteLength(single) <= limits.questionBytes);
      }
      assert.ok(!plan.batch.body.includes("\ufffd"));
      assert.deepEqual(plan.candidates.map(item => item.result.noteId), input.candidates.slice(0, plan.candidates.length).map(item => item.result.noteId));
    }
  }
});
