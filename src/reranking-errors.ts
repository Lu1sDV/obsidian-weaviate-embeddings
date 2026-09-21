export type RerankingErrorCode = "configuration" | "input" | "evidence-limit" | "source" | "authentication" | "credits" | "rate-limit" | "http" | "network" | "response" | "timeout";

export class RerankingError extends Error {
  constructor(readonly code: RerankingErrorCode) {
    // Never include upstream bodies, source text or credentials in an error.
    super(`JEV reranking failed (${code})`);
    this.name = "RerankingError";
  }
}

export class RerankingCancelledError extends Error {
  constructor() {
    super("Reranking request is no longer current");
    this.name = "AbortError";
  }
}
