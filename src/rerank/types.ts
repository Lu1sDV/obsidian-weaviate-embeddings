import type { SearchResult } from "../types";

export type Provider = "openrouter" | "typesafe";
export const PROVIDERS = Object.freeze({
  openrouter: Object.freeze({ url: "https://openrouter.ai/api/v1/systemone", model: "typesafe/jev-1.13" }),
  typesafe: Object.freeze({ url: "https://api.typesafe.ai/v1/systemone", model: "jev-1.13.0" }),
});
export const METRIC_VERSION = "search-noul-v1/excerpt-v1/max-v1";
export const LIMITS = Object.freeze({
  notes: 60, passagesPerNote: 2, questions: 16, concurrency: 2,
  queryBytes: 4096, evidenceBytes: 1536, requestBytes: 48_000, responseBytes: 64_000,
  requestTokens: 24_000, operationTokens: 64_000, deadlineMs: 2000,
  cacheEntries: 5000, cacheBytes: 1_000_000, cacheTtlMs: 15 * 60_000,
  sessionRequests: 1000, sessionTokens: 2_000_000,
});

export interface RerankSettings {
  enabled: boolean;
  provider: Provider;
  experimentalBatching: boolean;
  excludedFolders: string[];
  excludedFiles: string[];
}
export interface RerankAccess extends RerankSettings { revision: number; consent: boolean; apiKey: string }
export function defaultRerankSettings(): RerankSettings {
  return { enabled: false, provider: "openrouter", experimentalBatching: false, excludedFolders: [], excludedFiles: [] };
}
export type RerankReason = "off" | "unconfigured" | "policy" | "budget" | "circuit-open" | "deadline" | "provider" | "invalid-response" | "model-change" | "cancelled";
export class RerankError extends Error {
  constructor(readonly reason: RerankReason, readonly transient = false) { super(`JEV: ${reason}`); }
}
export const REASON_LABELS: Record<RerankReason, string> = {
  off: "reranking is disabled", unconfigured: "configure a provider key in settings",
  policy: "remote consent or a note's remote policy does not permit this pool",
  budget: "the complete candidate pool exceeds the evidence or session budget",
  "circuit-open": "the provider is temporarily unavailable", deadline: "reranker timed out",
  provider: "the provider request failed", "invalid-response": "the provider returned an invalid or incomplete response",
  "model-change": "the provider returned an unapproved or inconsistent model revision", cancelled: "reranking was cancelled",
};

/** Only this payload is serialized. Identities and source locations stay local. */
export interface Evidence { title: string; heading: string; body: string }
export interface EvidenceRecord {
  key: string; noteId: string; snapshotId: string; passageId: string;
  evidence: Evidence; hash: string; truncated: boolean;
}
export interface JudgmentResponse {
  resolvedModel: string;
  scores: Map<string, number>;
  inputTokens: number;
  outputTokens: number;
  cost?: number;
}
export interface RerankMetrics {
  provider: Provider; requestedModel: string; resolvedModel?: string; metricVersion: string;
  candidateCount: number; evidenceCount: number; truncatedCount: number; cacheHits: number;
  requests: number; estimatedTokens: number; inputTokens: number; outputTokens: number;
  cost: number; elapsedMs: number;
}
export type RerankOutcome =
  | { status: "applied"; results: SearchResult[]; metrics: RerankMetrics }
  | { status: "retained" | "cancelled"; reason: RerankReason; metrics: RerankMetrics };
export interface RerankInput {
  vaultId: string; generation: number; fingerprint: string; query: string;
  candidates: readonly SearchResult[]; signal: AbortSignal;
  isCurrent: () => boolean;
  isAllowed: (result: SearchResult) => boolean;
}
