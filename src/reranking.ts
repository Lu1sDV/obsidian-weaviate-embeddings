import { createHash } from "node:crypto";
import type { CurrentRerankingCache } from "./reranking-cache";
import { postJevDecisions, type DecisionTransport } from "./jev-http";
import { buildJevBatches, measureJevRequest, parseJevAnswers, readJevInputTokens, validateRerankingInput, RerankingCancelledError, RerankingError, type RerankCandidate, type RerankingErrorCode } from "./jev-protocol";
import { prepareEvidence, type PreparedEvidence } from "./reranking-evidence";
import type { EvidenceSource } from "./reranking-source";
import type { RerankingSettings } from "./reranking-config";

export interface RerankingOptions {
  signal: AbortSignal;
  /** Recheck admission/current snapshots before every outbound batch and publication. */
  isCurrent: () => boolean;
  cache?: { store: CurrentRerankingCache; snapshotKey: string };
}
export interface RerankingDiagnostics {
  requests: number;
  /** Serialized bytes handed to the transport, not proof of network delivery. */
  attemptedBytes: number;
  /** Actual reported usage after calls, NOT a preflight context count. */
  reportedInputTokens: number | null;
  budgetMode: "serialized-utf8";
  cacheHit: boolean;
  evidence: PreparedEvidence["summary"][];
}
export interface RerankingOutcome<T> {
  results: Array<T & { rerankScore?: number }>;
  reranked: boolean;
  warning?: string;
  diagnostics?: RerankingDiagnostics;
}
type Configuration = Pick<RerankingSettings, "enabled" | "provider"> & Partial<Pick<RerankingSettings, "evidencePolicy" | "allowWholeShortNotes">> & {
  apiKey: string; chunkingMode?: "standard" | "late";
};
const WARNINGS: Record<RerankingErrorCode, string> = {
  configuration: "JEV reranking unavailable: save an OpenRouter API key in settings. Showing the original hybrid order.",
  input: "JEV reranking skipped: query or candidate evidence exceeds the supported request limits or is unavailable. Showing the original hybrid order.",
  "evidence-limit": "A complete strongest passage exceeds the JEV evidence budget. No passage was silently cut. Showing the original hybrid order.",
  source: "JEV source context could not be verified against the current index. Showing the original hybrid order.",
  authentication: "OpenRouter rejected the API key. Showing the original hybrid order.",
  credits: "OpenRouter credits are unavailable. Showing the original hybrid order.",
  "rate-limit": "OpenRouter rate limit reached. Showing the original hybrid order.",
  http: "OpenRouter is unavailable or rejected the request. Showing the original hybrid order.",
  network: "Could not reach OpenRouter. Showing the original hybrid order.",
  response: "JEV returned an invalid or incomplete response. Showing the original hybrid order.",
  timeout: "JEV reranking timed out. Showing the original hybrid order.",
};
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new RerankingCancelledError()); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    work.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export class JevReranker {
  constructor(
    private readonly configuration: () => Configuration,
    private readonly transport: DecisionTransport = postJevDecisions,
    private readonly timeoutMs = 12_000,
    private readonly loadSource?: EvidenceSource,
  ) {}

  async rerank<T extends RerankCandidate>(query: string, candidates: readonly T[], options: RerankingOptions): Promise<RerankingOutcome<T>> {
    const original: RerankingOutcome<T> = { results: [...candidates], reranked: false };
    const assertCurrent = () => {
      if (options.signal.aborted || !options.isCurrent()) throw new RerankingCancelledError();
    };
    assertCurrent();
    const config = this.configuration();
    if (!config.enabled || !query.trim() || candidates.length < 2) { options.cache?.store.clear(); return original; }
    if (config.provider !== "jev-openrouter" || !config.apiKey.trim()) { options.cache?.store.clear(); return { ...original, warning: WARNINGS.configuration }; }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    options.signal.addEventListener("abort", cancel, { once: true });
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    const current = () => { assertCurrent(); if (controller.signal.aborted) throw new RerankingCancelledError(); };
    const diagnostics: RerankingDiagnostics = { requests: 0, attemptedBytes: 0, reportedInputTokens: 0, budgetMode: "serialized-utf8", cacheHit: false, evidence: [] };
    try {
      validateRerankingInput(query, candidates.length);
      const policy = config.evidencePolicy ?? "matched-passages";
      if (policy !== "matched-passages" && policy !== "contextual") throw new RerankingError("configuration");
      const evidence: PreparedEvidence[] = [];
      for (const candidate of candidates) {
        current();
        // Validate that a strongest complete match fits before doing local source I/O.
        prepareEvidence(candidate, { policy: "matched-passages", chunkingMode: "standard", allowWholeShortNotes: false });
        if (policy === "contextual" && !this.loadSource) throw new RerankingError("source");
        const source = policy === "contextual" ? await abortable(this.loadSource!(candidate, { signal: controller.signal, assertCurrent: current }), controller.signal) : undefined;
        current();
        evidence.push(prepareEvidence(candidate, { policy, chunkingMode: config.chunkingMode ?? "standard", allowWholeShortNotes: config.allowWholeShortNotes === true }, source));
      }
      diagnostics.evidence = evidence.map(item => item.summary);
      const batches = buildJevBatches(query, candidates, evidence.map(item => item.document));
      const cacheKey = options.cache ? createHash("sha256").update(JSON.stringify([
        "complete-evidence-v1", config.provider, config.apiKey, policy, config.chunkingMode, config.allowWholeShortNotes,
        options.cache.snapshotKey, batches,
      ])).digest("hex") : undefined;
      const cached = cacheKey ? options.cache?.store.read(cacheKey) : undefined;
      const omitted = evidence.reduce((count, item) => count + item.summary.omittedMatches, 0);
      const warning = omitted ? `JEV used complete passages; ${omitted} lower-ranked matched passage(s) were omitted by the per-note evidence limits.` : undefined;
      if (cached) {
        current(); diagnostics.cacheHit = true;
        return { results: rankCandidates(candidates, cached), reranked: true, warning, diagnostics };
      }
      const scores = new Map<string, number>();
      for (const batch of batches) {
        current();
        diagnostics.requests++; diagnostics.attemptedBytes += measureJevRequest(batch).bytes;
        const response = await abortable(this.transport(batch, config.apiKey.trim(), controller.signal), controller.signal);
        current();
        for (const [id, score] of parseJevAnswers(response, Object.keys(batch.questions))) scores.set(id, score);
        const tokens = readJevInputTokens(response);
        const total = tokens === null || diagnostics.reportedInputTokens === null ? null : diagnostics.reportedInputTokens + tokens;
        diagnostics.reportedInputTokens = total !== null && Number.isSafeInteger(total) ? total : null;
      }
      current();
      const values = candidates.map((_, index) => {
        const score = scores.get(`candidate_${index}`);
        if (score === undefined) throw new RerankingError("response");
        return score;
      });
      const results = rankCandidates(candidates, values);
      if (cacheKey) options.cache?.store.write(cacheKey, values);
      return { results, reranked: true, warning, diagnostics };
    } catch (error) {
      assertCurrent();
      options.cache?.store.clear();
      // Failed requests may have consumed tokens; do not report incomplete usage as a total.
      if (diagnostics.requests) diagnostics.reportedInputTokens = null;
      const code = timedOut ? "timeout" : error instanceof RerankingError ? error.code : "network";
      return { ...original, warning: WARNINGS[code], diagnostics };
    } finally {
      clearTimeout(deadline);
      options.signal.removeEventListener("abort", cancel);
      controller.abort();
    }
  }
}
function rankCandidates<T>(candidates: readonly T[], scores: readonly number[]): Array<T & { rerankScore: number }> {
  if (scores.length !== candidates.length) throw new RerankingError("response");
  return candidates.map((result, index) => {
    const rerankScore = scores[index];
    if (rerankScore === undefined || !Number.isFinite(rerankScore) || rerankScore < 0 || rerankScore > 1) throw new RerankingError("response");
    return { result: { ...result, rerankScore }, index };
  }).sort((left, right) => right.result.rerankScore - left.result.rerankScore || left.index - right.index).map(item => item.result);
}
