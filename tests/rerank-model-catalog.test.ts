import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DecisionModelError,
  normalizeDecisionModelId,
  parseDecisionModelPage,
  validateDecisionModel,
  type DecisionModelErrorCode,
} from "../src/rerank/model-catalog";

function model(id = "typesafe/jev-1.14", changes: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    canonical_slug: `${id}-20261014`,
    architecture: { input_modalities: ["text"], output_modalities: ["decisions"], tokenizer: "Other" },
    endpoints: ["/api/alpha/decisions"],
    context_length: 262144,
    top_provider: { context_length: 262144, max_completion_tokens: 235929 },
    per_request_limits: null,
    supported_parameters: [],
    ...changes,
  };
}

function entries(...data: unknown[]) {
  return parseDecisionModelPage({ data }).models;
}

function code(expected: DecisionModelErrorCode) {
  return (error: unknown): boolean => error instanceof DecisionModelError && error.code === expected;
}

test("model IDs preserve exact namespaces, versions, variants and alias syntax", () => {
  assert.equal(normalizeDecisionModelId("  ~typesafe/jev-latest  "), "~typesafe/jev-latest");
  assert.equal(normalizeDecisionModelId("respan/span-01-lite:free"), "respan/span-01-lite:free");
  assert.equal(normalizeDecisionModelId("future-vendor/v2.1-20261102"), "future-vendor/v2.1-20261102");
  for (const invalid of [null, 1, "", "  ", "jev-latest", "https://openrouter.ai/model", "author/model/extra", "author/model?key=x", "author/model\nother", "~/bad", `author/${"x".repeat(250)}`]) {
    assert.throws(() => normalizeDecisionModelId(invalid), code("invalid-model-id"));
  }
});

test("catalogue pages support pagination and older metadata without changing identities", () => {
  const page = parseDecisionModelPage({
    data: [model()], total_count: 33,
    links: { next: "/api/v1/models?output_modalities=decisions&offset=20" },
  });
  assert.equal(page.next, "https://openrouter.ai/api/v1/models?output_modalities=decisions&offset=20");
  assert.equal(page.totalCount, 33);
  assert.equal(page.models[0]?.canonicalSlug, "typesafe/jev-1.14-20261014");
  assert.equal(page.models[0]?.maxCompletionTokens, 235929);
  assert.deepEqual(parseDecisionModelPage({ data: [] }), { models: [], next: null, totalCount: null });
});

test("catalogue pagination rejects credential-leaking origins and non-model endpoints", () => {
  for (const next of ["https://evil.example/api/v1/models", "//evil.example/api/v1/models", "http://openrouter.ai/api/v1/models", "https://user:password@openrouter.ai/api/v1/models", "/api/v1/key", "/api/v1/models#fragment", 5]) {
    assert.throws(() => parseDecisionModelPage({ data: [], links: { next } }), code("invalid-catalog"));
  }
});

test("catalogue parser rejects malformed shapes and nonfinite token metadata", () => {
  for (const raw of [null, { data: {} }, { data: [null] }, { data: [model("typesafe/jev-1.14", { context_length: Number.NaN })] }, { data: [], total_count: -1 }]) {
    assert.throws(() => parseDecisionModelPage(raw), code("invalid-catalog"));
  }
  assert.throws(() => entries(model("typesafe/jev-1.14", { architecture: { input_modalities: "text" } })), code("invalid-catalog"));
});

test("new decision models are accepted from capabilities without a hardcoded model allowlist", () => {
  const validated = validateDecisionModel(" future-maker/new-decider ", entries(model("future-maker/new-decider")));
  assert.equal(validated.requestedModel, "future-maker/new-decider");
  assert.equal(validated.modelId, "future-maker/new-decider");
  assert.equal(validated.contextTokens, 262144);
  assert.equal(validated.tokenizer, "Other");
  assert.equal(validated.fullTextWarning, null);
  assert.deepEqual(validated.acceptedServedModels, ["future-maker/new-decider", "future-maker/new-decider-20261014"]);
});

test("only exact IDs and canonical snapshots match, never arbitrary prefixes", () => {
  const catalogue = entries(model());
  assert.equal(validateDecisionModel("typesafe/jev-1.14-20261014", catalogue).requestedModel, "typesafe/jev-1.14-20261014");
  for (const id of ["typesafe/jev", "typesafe/jev-1.14-other", "other/jev-1.14", "typesafe/jev-1.14-20261101"]) {
    assert.throws(() => validateDecisionModel(id, catalogue), code("model-not-found"));
  }
});

test("aliases resolve after combining pages and allow only observed served identities", () => {
  const alias = model("~typesafe/jev-latest", {
    canonical_slug: "~typesafe/jev-latest",
    alias_target: { name: "Jev 1.14", slug: "typesafe/jev-1.14" },
    architecture: { input_modalities: ["text"], output_modalities: ["decisions"], tokenizer: "Router" },
  });
  const pageOne = entries(alias);
  assert.throws(() => validateDecisionModel("~typesafe/jev-latest", pageOne), code("unresolved-alias"));
  const validated = validateDecisionModel("~typesafe/jev-latest", [...pageOne, ...entries(model())]);
  assert.equal(validated.modelId, "typesafe/jev-1.14");
  assert.equal(validated.canonicalSlug, "typesafe/jev-1.14-20261014");
  assert.equal(validated.tokenizer, "Other");
  assert.equal(validated.requestedModel, "~typesafe/jev-latest");
  assert.deepEqual(validated.acceptedServedModels, ["typesafe/jev-1.14", "typesafe/jev-1.14-20261014"]);
  assert.ok(!validated.acceptedServedModels.includes("~typesafe/jev-latest"));
  assert.ok(!validated.acceptedServedModels.includes("typesafe/jev-1.13-20260917"));
});

test("unresolved and cyclic aliases cannot provide false validation", () => {
  assert.throws(() => validateDecisionModel("~vendor/latest", entries(model("~vendor/latest"))), code("unresolved-alias"));
  const catalogue = entries(
    model("~vendor/first", { alias_target: { slug: "~vendor/second" } }),
    model("~vendor/second", { alias_target: { slug: "~vendor/first" } }),
  );
  assert.throws(() => validateDecisionModel("~vendor/first", catalogue), code("unresolved-alias"));
});

test("text input, decisions output and supplied endpoint capabilities are mandatory", () => {
  for (const changes of [
    { architecture: { input_modalities: ["image"], output_modalities: ["decisions"] } },
    { architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
    { architecture: {} },
    { endpoints: ["/api/v1/chat/completions"] },
    { endpoints: [] },
  ]) {
    assert.throws(() => validateDecisionModel("typesafe/jev-1.14", entries(model("typesafe/jev-1.14", changes))), code("incompatible-model"));
  }
  assert.equal(validateDecisionModel("typesafe/jev-1.14", entries(model("typesafe/jev-1.14", { endpoints: undefined }))).contextTokens, 262144);
});

test("a compatible alias cannot conceal an incompatible target", () => {
  const catalogue = entries(
    model("~vendor/latest", { alias_target: { slug: "vendor/chat-only" } }),
    model("vendor/chat-only", { architecture: { input_modalities: ["text"], output_modalities: ["text"] } }),
  );
  assert.throws(() => validateDecisionModel("~vendor/latest", catalogue), code("incompatible-model"));
});

test("effective context uses the smallest advertised, provider and per-request input limits", () => {
  const validated = validateDecisionModel("~vendor/latest", entries(
    model("~vendor/latest", { alias_target: { slug: "vendor/model" }, context_length: 64000 }),
    model("vendor/model", {
      context_length: 65000,
      top_provider: { context_length: 32000, max_completion_tokens: 1000 },
      per_request_limits: { prompt_tokens: 24000, completion_tokens: 500 },
    }),
  ));
  assert.equal(validated.catalogContextTokens, 64000);
  assert.equal(validated.contextTokens, 24000);
  assert.equal(validated.maxCompletionTokens, 500);
  assert.deepEqual(validated.perRequestLimits, { promptTokens: 24000, completionTokens: 500 });
});

test("zero or unknown input context is rejected instead of inventing a budget", () => {
  for (const changes of [
    { context_length: 0 }, { context_length: undefined }, { context_length: null },
    { top_provider: { context_length: 0 } }, { per_request_limits: { prompt_tokens: 0, completion_tokens: 0 } },
  ]) {
    assert.throws(() => validateDecisionModel("typesafe/jev-1.14", entries(model("typesafe/jev-1.14", changes))), code("unknown-context"));
  }
});

test("known special-state models are rejected by exact ID and canonical identity", () => {
  for (const id of ["respan/span-01", "respan/span-01-lite", "respan/span-01-lite:free", "scaledown/classify-1"]) {
    const catalogue = entries(model(id));
    assert.throws(() => validateDecisionModel(id, catalogue), code("incompatible-model"));
    assert.throws(() => validateDecisionModel(`${id}-20261014`, catalogue), code("incompatible-model"));
  }
  assert.equal(validateDecisionModel("respan/span-02", entries(model("respan/span-02"))).modelId, "respan/span-02");
});

test("Clef truncation is exposed separately from its advertised context, including aliases", () => {
  for (const id of ["cloudflare/clef", "cloudflare/clef-flash"]) {
    const validated = validateDecisionModel("~cloudflare/latest", entries(
      model("~cloudflare/latest", { alias_target: { slug: id } }),
      model(id, { context_length: 24576 }),
    ));
    assert.equal(validated.contextTokens, 24576);
    assert.equal(validated.fullTextTokenLimit, 2000);
    assert.match(validated.fullTextWarning!, /silently omit/);
  }
  assert.equal(validateDecisionModel("cloudflare/clef-omni", entries(model("cloudflare/clef-omni"))).fullTextTokenLimit, null);
});

test("ambiguous catalogue snapshots cannot silently choose a different variant", () => {
  const catalogue = entries(model("vendor/model"), model("vendor/model:free", { canonical_slug: "vendor/model-20261014" }));
  assert.equal(validateDecisionModel("vendor/model", catalogue).requestedModel, "vendor/model");
  assert.throws(() => validateDecisionModel("vendor/model-20261014", catalogue), code("ambiguous-model"));
  assert.throws(() => validateDecisionModel("vendor/model", entries(model("vendor/model"), model("vendor/model"))), code("ambiguous-model"));
});
