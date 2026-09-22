import type { SearchResult } from "../types";
import type { RetrievedNoteCandidate } from "../weaviate";

export type Provider = "openrouter" | "typesafe";
export const PROVIDERS = Object.freeze({
  openrouter: Object.freeze({
    url: "https://openrouter.ai/api/v1/systemone",
    model: "typesafe/jev-1.13",
    servedModels: Object.freeze(["typesafe/jev-1.13", "typesafe/jev-1.13-20260917", "typesafe/jev-1.13.0", "jev-1.13.0"]),
  }),
  typesafe: Object.freeze({
    url: "https://api.typesafe.ai/v1/systemone",
    model: "jev-1.13.0",
    servedModels: Object.freeze(["jev-1.13.0"]),
  }),
});
export const PRIMITIVE_VERSION = "noul";
export const RUBRIC_VERSION = "search-relevance-noul-v1";
export const EVIDENCE_POLICY_VERSION = "passage-v1";
export const RANKING_POLICY_VERSION = "max-v1";
export const METRIC_VERSION = `${RUBRIC_VERSION}/${EVIDENCE_POLICY_VERSION}/${RANKING_POLICY_VERSION}`;
export const LIMITS = Object.freeze({
  notes: 60,
  passagesPerNote: 1,
  experimentalPassagesPerNote: 2,
  questions: 24,
  concurrency: 2,
  maxBatches: 3,
  queryBytes: 4096,
  evidenceBytes: 1536,
  requestBytes: 48_000,
  responseBytes: 64_000,
  requestTargetTokens: 20_000,
  requestTokens: 24_000,
  operationTokens: 64_000,
  deadlineMs: 2500,
  cacheEntries: 5000,
  cacheBytes: 1_000_000,
  cacheTtlMs: 15 * 60_000,
  sessionRequests: 1000,
  sessionTokens: 2_000_000,
});

export interface RerankSettings {
  enabled: boolean;
  provider: Provider;
  evidencePassages: 1 | 2;
  excludedFolders: string[];
  excludedFiles: string[];
}
export interface RerankAccess extends RerankSettings {
  revision: number;
  settingsRevision: number;
  cloudPolicyRevision: number;
  consentRevision: number;
  credentialRevision: number;
  consent: boolean;
  apiKey: string;
}
export function defaultRerankSettings(): RerankSettings {
  return { enabled: false, provider: "openrouter", evidencePassages: 1, excludedFolders: [], excludedFiles: [] };
}

export type RerankReason =
  | "off" | "unconfigured" | "policy" | "budget" | "circuit-open" | "deadline"
  | "authentication" | "contract" | "rate-limit" | "provider" | "invalid-response" | "model-change" | "cancelled";

export class RerankError extends Error {
  readonly status: number | undefined;
  constructor(readonly reason: RerankReason, readonly transient = false, status?: number) {
    super(`JEV: ${reason}`);
    this.status = status;
  }
}
export const REASON_LABELS: Record<RerankReason, string> = {
  off: "reranking is disabled",
  unconfigured: "configure a provider key in settings",
  policy: "remote consent or a note's remote policy does not permit this pool",
  budget: "the complete candidate pool exceeds the evidence or session budget",
  "circuit-open": "the provider is temporarily unavailable",
  deadline: "reranker timed out",
  authentication: "the provider rejected the configured credential",
  contract: "the provider rejected the System One request contract",
  "rate-limit": "the provider rate limit is temporarily unavailable",
  provider: "the provider request failed",
  "invalid-response": "the provider returned an invalid or incomplete response",
  "model-change": "the provider returned an unapproved or inconsistent model revision",
  cancelled: "reranking was cancelled",
};

export interface ServingIdentity {
  route: Provider;
  requestedModel: string;
  servedModel: string;
  upstreamProvider?: string;
}

export interface Evidence {
  title: string;
  heading: string;
  body: string;
}
export interface EvidenceRecord {
  key: string;
  noteId: string;
  snapshotId: string;
  passageId: string;
  retrievalRank: number;
  evidence: Evidence;
  hash: string;
  truncated: boolean;
}
export interface JudgmentResponse {
  servingIdentity: ServingIdentity;
  scores: Map<string, number>;
  inputTokens: number;
  outputTokens: number;
  cost?: number;
}
export interface RerankMetrics {
  route: Provider;
  requestedModel: string;
  servedModel?: string;
  upstreamProvider?: string;
  metricVersion: string;
  inputCandidateCount: number;
  candidateCount: number;
  candidateWindow: number;
  candidateExhausted: boolean;
  evidenceCount: number;
  truncatedCount: number;
  cacheHits: number;
  requests: number;
  estimatedTokens: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  elapsedMs: number;
}
export type RerankOutcome =
  | { status: "applied"; results: SearchResult[]; metrics: RerankMetrics }
  | { status: "retained" | "cancelled"; reason: RerankReason; metrics: RerankMetrics };
export interface RerankInput {
  vaultId: string;
  generation: number;
  fingerprint: string;
  query: string;
  candidates: readonly RetrievedNoteCandidate[];
  minimumCandidateCount: number;
  candidateWindow: number;
  candidateExhausted: boolean;
  signal: AbortSignal;
  isCurrent: () => boolean;
  isAllowed: (candidate: RetrievedNoteCandidate) => boolean;
}
