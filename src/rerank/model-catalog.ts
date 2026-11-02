/** Catalogue checks are local; a successful synthetic Decisions call is still required. */
export const OPENROUTER_DECISIONS_PATH = "/api/alpha/decisions";
export const OPENROUTER_DECISION_MODELS_URL = "https://openrouter.ai/api/v1/models?output_modalities=decisions";

export type DecisionModelErrorCode =
  | "invalid-model-id" | "invalid-catalog" | "model-not-found" | "ambiguous-model"
  | "unresolved-alias" | "incompatible-model" | "unknown-context";

export class DecisionModelError extends Error {
  constructor(readonly code: DecisionModelErrorCode, message: string) {
    super(message);
    this.name = "DecisionModelError";
  }
}

export interface DecisionModelLimits {
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface DecisionModelEntry {
  id: string;
  canonicalSlug: string | null;
  aliasTarget: string | null;
  name: string | null;
  inputModalities: readonly string[];
  outputModalities: readonly string[];
  /** null means the catalogue did not supply this optional capability field. */
  endpoints: readonly string[] | null;
  contextTokens: number | null;
  providerContextTokens: number | null;
  maxCompletionTokens: number | null;
  perRequestLimits: DecisionModelLimits | null;
  tokenizer: string | null;
}

export interface DecisionModelPage {
  models: DecisionModelEntry[];
  /** Absolute URL on the OpenRouter Models API, safe for an authenticated next-page request. */
  next: string | null;
  totalCount: number | null;
}

export interface ValidatedDecisionModel {
  requestedModel: string;
  /** Concrete target after resolving any catalogue aliases. */
  modelId: string;
  canonicalSlug: string;
  acceptedServedModels: readonly string[];
  /** Conservative minimum of the catalogue, provider and per-request input limits. */
  contextTokens: number;
  catalogContextTokens: number;
  maxCompletionTokens: number | null;
  perRequestLimits: DecisionModelLimits | null;
  /** A family label from the catalogue, not necessarily an exact tokenizer identifier. */
  tokenizer: string | null;
  /** Known provider truncation advisory; null does not certify complete reading. */
  fullTextTokenLimit: number | null;
  fullTextWarning: string | null;
}

// These models require specialised state adapters; the shared note state is not supported.
// OpenRouter's Jev guide documents the Span-01 and Classify-1 exceptions:
// https://openrouter.ai/docs/guides/community/jev
const SPECIAL_STATE_MODELS = new Set([
  "respan/span-01", "respan/span-01-lite", "respan/span-01-lite:free", "scaledown/classify-1",
]);

// This is a capability advisory, separate from the advertised context window.
// https://openrouter.ai/docs/guides/community/multimodal-decisions#limits
const TRUNCATED_TEXT_MODELS = new Set(["cloudflare/clef", "cloudflare/clef-flash"]);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidCatalog(message: string): never {
  throw new DecisionModelError("invalid-catalog", `OpenRouter returned an invalid model catalogue: ${message}`);
}

/** Preserve exact case, author namespace and variant; only surrounding UI whitespace is removed. */
export function normalizeDecisionModelId(value: unknown): string {
  if (typeof value !== "string") {
    throw new DecisionModelError("invalid-model-id", "Enter an OpenRouter model ID in author/model format.");
  }
  const model = value.trim();
  if (model.length === 0 || model.length > 256 || !/^~?[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(model)) {
    throw new DecisionModelError("invalid-model-id", "Enter an OpenRouter author/model ID or ~author/alias, up to 256 characters.");
  }
  return model;
}

function catalogueModelId(value: unknown, field: string): string {
  try {
    const normalized = normalizeDecisionModelId(value);
    if (normalized !== value) invalidCatalog(`${field} contains surrounding whitespace.`);
    return normalized;
  } catch {
    return invalidCatalog(`${field} is not a model ID.`);
  }
}

function strings(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every(item => typeof item === "string" && item.length > 0)) {
    return invalidCatalog(`${field} is not a string array.`);
  }
  return [...new Set(value as string[])];
}

function tokenLimit(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalidCatalog(`${field} is not a nonnegative integer.`);
  }
  return value;
}

function parseEntry(value: unknown): DecisionModelEntry {
  if (!object(value)) return invalidCatalog("a model entry is not an object.");
  const id = catalogueModelId(value.id, "id");
  const architecture = value.architecture;
  if (architecture !== undefined && architecture !== null && !object(architecture)) {
    return invalidCatalog("architecture is not an object.");
  }
  const topProvider = value.top_provider;
  if (topProvider !== undefined && topProvider !== null && !object(topProvider)) {
    return invalidCatalog("top_provider is not an object.");
  }
  const limits = value.per_request_limits;
  if (limits !== undefined && limits !== null && !object(limits)) {
    return invalidCatalog("per_request_limits is not an object.");
  }
  const alias = value.alias_target;
  if (alias !== undefined && alias !== null && !object(alias)) {
    return invalidCatalog("alias_target is not an object.");
  }
  return {
    id,
    canonicalSlug: value.canonical_slug == null ? null : catalogueModelId(value.canonical_slug, "canonical_slug"),
    aliasTarget: alias == null ? null : catalogueModelId(alias.slug, "alias_target.slug"),
    name: typeof value.name === "string" ? value.name : null,
    inputModalities: strings(architecture?.input_modalities, "architecture.input_modalities"),
    outputModalities: strings(architecture?.output_modalities, "architecture.output_modalities"),
    endpoints: value.endpoints == null ? null : strings(value.endpoints, "endpoints"),
    contextTokens: tokenLimit(value.context_length, "context_length"),
    providerContextTokens: tokenLimit(topProvider?.context_length, "top_provider.context_length"),
    maxCompletionTokens: tokenLimit(topProvider?.max_completion_tokens, "top_provider.max_completion_tokens"),
    perRequestLimits: limits == null ? null : {
      promptTokens: tokenLimit(limits.prompt_tokens, "per_request_limits.prompt_tokens"),
      completionTokens: tokenLimit(limits.completion_tokens, "per_request_limits.completion_tokens"),
    },
    tokenizer: typeof architecture?.tokenizer === "string" ? architecture.tokenizer : null,
  };
}

function parseNext(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0) return invalidCatalog("links.next is not a URL.");
  let url: URL;
  try {
    url = new URL(value, "https://openrouter.ai");
  } catch {
    return invalidCatalog("links.next is not a URL.");
  }
  if (url.origin !== "https://openrouter.ai" || url.pathname !== "/api/v1/models" || url.username || url.password || url.hash) {
    return invalidCatalog("links.next does not point to the OpenRouter Models API.");
  }
  return url.href;
}

/** Parses one page. Callers collect every page before validating aliases or reporting a missing ID. */
export function parseDecisionModelPage(raw: unknown): DecisionModelPage {
  if (!object(raw) || !Array.isArray(raw.data)) return invalidCatalog("data is not an array.");
  const links = raw.links;
  if (links !== undefined && links !== null && !object(links)) return invalidCatalog("links is not an object.");
  return {
    models: raw.data.map(parseEntry),
    next: parseNext(links?.next),
    totalCount: tokenLimit(raw.total_count, "total_count"),
  };
}

function findEntry(id: string, models: readonly DecisionModelEntry[]): DecisionModelEntry | undefined {
  const direct = models.filter(model => model.id === id);
  const matches = direct.length ? direct : models.filter(model => model.canonicalSlug === id);
  if (matches.length > 1) {
    throw new DecisionModelError("ambiguous-model", "The model catalogue contains conflicting identities. Refresh it and choose an exact model ID.");
  }
  return matches[0];
}

function requireCompatible(entry: DecisionModelEntry): void {
  if (SPECIAL_STATE_MODELS.has(entry.id)) {
    throw new DecisionModelError("incompatible-model", `${entry.id} requires a specialised state format that this note reranker does not support.`);
  }
  if (!entry.inputModalities.includes("text") || !entry.outputModalities.includes("decisions")) {
    throw new DecisionModelError("incompatible-model", "Choose a model that accepts text and returns Decisions answers.");
  }
  if (entry.endpoints !== null && !entry.endpoints.includes(OPENROUTER_DECISIONS_PATH)) {
    throw new DecisionModelError("incompatible-model", "This model is not available through the OpenRouter Decisions endpoint.");
  }
  if (entry.contextTokens === null || entry.contextTokens <= 0 || entry.providerContextTokens === 0 || entry.perRequestLimits?.promptTokens === 0) {
    throw new DecisionModelError("unknown-context", "OpenRouter does not report a usable input context limit for this model.");
  }
}

/**
 * Validates catalogue capabilities, not model accuracy or complete-context reading.
 * The caller must also run its real request shape against a synthetic fixture.
 */
export function validateDecisionModel(requestedModel: string, models: readonly DecisionModelEntry[]): ValidatedDecisionModel {
  const requested = normalizeDecisionModelId(requestedModel);
  const first = findEntry(requested, models);
  if (!first) {
    throw new DecisionModelError("model-not-found", "This model ID is not in the available OpenRouter Decisions catalogue. Check the ID and refresh the catalogue.");
  }
  const chain: DecisionModelEntry[] = [];
  let current = first;
  while (true) {
    if (chain.some(entry => entry.id === current.id)) {
      throw new DecisionModelError("unresolved-alias", "The model catalogue contains a cyclic alias. Choose a versioned model ID.");
    }
    requireCompatible(current);
    chain.push(current);
    if (!current.aliasTarget) {
      if (current.id.startsWith("~")) {
        throw new DecisionModelError("unresolved-alias", "The catalogue does not identify this alias's target. Refresh it or choose a versioned model ID.");
      }
      break;
    }
    const target = findEntry(current.aliasTarget, models);
    if (!target) {
      throw new DecisionModelError("unresolved-alias", "The alias target is missing from the catalogue. Load all pages or choose a versioned model ID.");
    }
    current = target;
  }

  const contexts = chain.flatMap(entry => [entry.contextTokens, entry.providerContextTokens, entry.perRequestLimits?.promptTokens ?? null])
    .filter((limit): limit is number => limit !== null);
  const completions = chain.flatMap(entry => [entry.maxCompletionTokens, entry.perRequestLimits?.completionTokens ?? null])
    .filter((limit): limit is number => limit !== null);
  const truncatedText = chain.some(entry => TRUNCATED_TEXT_MODELS.has(entry.id));
  return {
    requestedModel: requested,
    modelId: current.id,
    canonicalSlug: current.canonicalSlug ?? current.id,
    // A mutable alias is valid for dispatch, but not evidence of which model served it.
    // Requiring the concrete target prevents an alias echo from hiding serving drift.
    acceptedServedModels: [...new Set([current.id, current.canonicalSlug ?? current.id])],
    contextTokens: Math.min(...contexts),
    catalogContextTokens: first.contextTokens!,
    maxCompletionTokens: completions.length ? Math.min(...completions) : null,
    perRequestLimits: current.perRequestLimits ? { ...current.perRequestLimits } : null,
    tokenizer: current.tokenizer,
    fullTextTokenLimit: truncatedText ? 2000 : null,
    fullTextWarning: truncatedText
      ? "OpenRouter reports that this model reads roughly the first 2,000 tokens of text state and may silently omit the rest. Its advertised context does not guarantee full-note reading."
      : null,
  };
}
