import type { RerankDocument, RerankTarget } from "./documents";
import type { SearchResult } from "../types";
import type { RetrievedNoteCandidate } from "../weaviate";

export type Provider = "openrouter";
export const PROVIDERS = Object.freeze({
  openrouter: Object.freeze({
    url: "https://openrouter.ai/api/alpha/decisions",
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
  twoPassageMaxBatches: 6,
  queryBytes: 4096,
  evidenceBytes: 1536,
  requestBytes: 512_000,
  responseBytes: 64_000,
  requestTargetTokens: 20_000,
  requestTokens: 24_000,
  operationTokens: 64_000,
  twoPassageOperationTokens: 128_000,
  deadlineMs: 20_000,
  cacheEntries: 5000,
  cacheBytes: 1_000_000,
  cacheTtlMs: 15 * 60_000,
  sessionRequests: 1000,
  sessionTokens: 2_000_000,
});

export function operationBudget(passagesPerNote: 1 | 2): { maxBatches: number; operationTokens: number } {
  return passagesPerNote === 2
    ? { maxBatches: LIMITS.twoPassageMaxBatches, operationTokens: LIMITS.twoPassageOperationTokens }
    : { maxBatches: LIMITS.maxBatches, operationTokens: LIMITS.operationTokens };
}

export interface RerankSettings {
  enabled: boolean;
  provider: Provider;
  model: string;
  /** Legacy setting retained for migration; no longer controls runtime evidence. */
  evidencePassages: 1 | 2;
  candidateCount: number;
  tokenBudget: number;
  evidencePolicy: "adaptive" | "complete";
  contextMode: "auto" | "manual";
  contextTokens: number;
  excludedFolders: string[];
  excludedFiles: string[];
}
export interface RerankAccess extends RerankSettings {
  revision: number;
  modelRevision: number;
  settingsRevision: number;
  cloudPolicyRevision: number;
  consentRevision: number;
  credentialRevision: number;
  consent: boolean;
  apiKey: string;
}
export function defaultRerankSettings(): RerankSettings {
  return { enabled: false, provider: "openrouter", model: "", evidencePassages: 1, candidateCount: 30, tokenBudget: 64_000, evidencePolicy: "adaptive", contextMode: "auto", contextTokens: 512, excludedFolders: [], excludedFiles: [] };
}

export type RerankReason =
  | "off" | "unconfigured" | "policy" | "budget" | "circuit-open" | "deadline"
  | "authentication" | "contract" | "rate-limit" | "provider" | "invalid-response" | "model-change" | "cancelled"
  | "model-unverified" | "model-invalid" | "credits" | "snapshot" | "source-too-large";

export class RerankError extends Error {
  readonly status: number | undefined;
  constructor(readonly reason: RerankReason, readonly transient = false, status?: number) {
    super(`Reranking: ${reason}`);
    this.status = status;
  }
}
export const REASON_LABELS: Record<RerankReason, string> = {
  snapshot: "the source no longer matches its indexed snapshot",
  "source-too-large": "the selected source cannot fit; select a shorter passage or change the budget/model",
  off: "reranking is disabled",
  unconfigured: "configure an OpenRouter key and model in settings",
  "model-unverified": "validate the selected OpenRouter model in settings for this session",
  "model-invalid": "the selected model is incompatible with this reranking request",
  credits: "OpenRouter requires additional credits or budget",
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
  baselineWindow: number;
  candidateWindow: number;
  candidateExhausted: boolean;
  evidenceCount: number;
  truncatedCount: number;
  cacheHits: number;
  requests: number;
  estimatedTokens: number;
  inputTokens: number;
  outputTokens: number;
  cost: number | null;
  elapsedMs: number;
  sourceTruncated?: boolean;
  completeCandidateCount?: number;
  omittedCandidateCount?: number;
  omittedAnchorCount?: number;
  inputTokenBudget?: number;
  tokenAccounting?: "estimated";
}
export interface RerankPreview {
  source: { title: string; text: string; shortened: boolean };
  candidates: Array<{ noteId: string; title: string; text: string; shortened: boolean }>;
}
export type RerankOutcome =
  | { status: "applied"; results: SearchResult[]; metrics: RerankMetrics; preview?: RerankPreview }
  | { status: "retained" | "cancelled"; reason: RerankReason; metrics: RerankMetrics };
export interface RerankLease {
  sessionId: string;
  queryEpoch: number;
  mode: "search" | "note" | "passage";
  queryHash: string;
  filtersHash: string;
  generation: number;
  embeddingFingerprint: string;
  settingsRevision: number;
  cloudPolicyRevision: number;
  consentRevision: number;
  credentialRevision: number;
  baselineWindow: number;
  candidateWindow: number;
  deadlineAt: number;
  signal: AbortSignal;
}

export interface RerankInput {
  deadlineAt?: number;
  source: RerankTarget;
  documents: readonly RerankDocument[];
  isSourceAllowed: () => boolean;
  vaultId: string;
  generation: number;
  fingerprint: string;
  query: string;
  queryEpoch: number;
  filtersIdentity: string;
  candidates: readonly RetrievedNoteCandidate[];
  minimumCandidateCount: number;
  baselineWindow: number;
  candidateWindow: number;
  candidateExhausted: boolean;
  signal: AbortSignal;
  isCurrent: () => boolean;
  isAllowed: (candidate: RetrievedNoteCandidate) => boolean;
}
