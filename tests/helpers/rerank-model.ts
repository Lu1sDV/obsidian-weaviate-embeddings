import type { ValidatedDecisionModel } from "../../src/rerank/model-catalog";
import type { ModelRegistry } from "../../src/rerank/model-registry";

/** Synthetic catalogue profile; these tests never fetch a model or make a paid request. */
export const MODEL: ValidatedDecisionModel = {
  requestedModel: "typesafe/jev-1.13",
  modelId: "typesafe/jev-1.13",
  canonicalSlug: "typesafe/jev-1.13-20260917",
  acceptedServedModels: ["typesafe/jev-1.13", "typesafe/jev-1.13-20260917"],
  contextTokens: 262_144,
  catalogContextTokens: 262_144,
  maxCompletionTokens: null,
  perRequestLimits: null,
  tokenizer: "Other",
  fullTextTokenLimit: null,
  fullTextWarning: null,
};

export function fakeModelRegistry(model: ValidatedDecisionModel = MODEL): ModelRegistry {
  return {
    current: () => model,
    load: async () => model,
    approve: () => {},
  };
}
