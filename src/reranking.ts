import { postJevDecisions, type DecisionTransport } from "./jev-http";
import { buildJevBatches, parseJevAnswers, RerankingCancelledError, RerankingError, type RerankCandidate, type RerankingErrorCode } from "./jev-protocol";
import type { RerankingSettings } from "./reranking-config";

export interface RerankingOptions {
  signal: AbortSignal;
  /** Recheck admission/current snapshots before every outbound batch and before publication. */
  isCurrent: () => boolean;
}
export interface RerankingOutcome<T> {
  results: Array<T & { rerankScore?: number }>;
  reranked: boolean;
  warning?: string;
}

const WARNINGS: Record<RerankingErrorCode, string> = {
  configuration: "JEV reranking unavailable: save an OpenRouter API key in settings. Showing the original hybrid order.",
  input: "JEV reranking skipped: query or candidate passages exceed the supported limits or are unavailable. Showing the original hybrid order.",
  authentication: "OpenRouter rejected the API key. Showing the original hybrid order.",
  credits: "OpenRouter credits are unavailable. Showing the original hybrid order.",
  "rate-limit": "OpenRouter rate limit reached. Showing the original hybrid order.",
  http: "OpenRouter is unavailable. Showing the original hybrid order.",
  network: "Could not reach OpenRouter. Showing the original hybrid order.",
  response: "JEV returned an invalid or incomplete response. Showing the original hybrid order.",
  timeout: "JEV reranking timed out. Showing the original hybrid order.",
};

/** Even an uncooperative transport cannot hold the search queue after cancellation/deadline. */
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
    private readonly configuration: () => RerankingSettings & { apiKey: string },
    private readonly transport: DecisionTransport = postJevDecisions,
    private readonly timeoutMs = 12_000,
  ) {}

  async rerank<T extends RerankCandidate>(query: string, candidates: readonly T[], options: RerankingOptions): Promise<RerankingOutcome<T>> {
    const original: RerankingOutcome<T> = { results: [...candidates], reranked: false };
    const assertCurrent = () => {
      if (options.signal.aborted || !options.isCurrent()) throw new RerankingCancelledError();
    };
    assertCurrent();
    const config = this.configuration();
    if (!config.enabled || !query.trim() || candidates.length < 2) return original;
    if (config.provider !== "jev-openrouter" || !config.apiKey.trim()) return { ...original, warning: WARNINGS.configuration };
    const controller = new AbortController();
    const cancel = () => controller.abort();
    options.signal.addEventListener("abort", cancel, { once: true });
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    try {
      const batches = buildJevBatches(query, candidates);
      const scores = new Map<string, number>();
      for (const batch of batches) {
        assertCurrent();
        if (controller.signal.aborted) throw new RerankingCancelledError();
        const response = await abortable(this.transport(batch, config.apiKey.trim(), controller.signal), controller.signal);
        assertCurrent();
        for (const [id, score] of parseJevAnswers(response, Object.keys(batch.questions))) scores.set(id, score);
      }
      assertCurrent();
      // Commit only after every batch validates; never mix hybrid and JEV score scales.
      const ranked = candidates.map((result, index) => {
        const rerankScore = scores.get(`candidate_${index}`);
        if (rerankScore === undefined) throw new RerankingError("response");
        return { result: { ...result, rerankScore }, index };
      });
      ranked.sort((left, right) => right.result.rerankScore - left.result.rerankScore || left.index - right.index);
      return { results: ranked.map(item => item.result), reranked: true };
    } catch (error) {
      assertCurrent();
      const code = timedOut ? "timeout" : error instanceof RerankingError ? error.code : "network";
      return { ...original, warning: WARNINGS[code] };
    } finally {
      clearTimeout(deadline);
      options.signal.removeEventListener("abort", cancel);
      controller.abort();
    }
  }
}
