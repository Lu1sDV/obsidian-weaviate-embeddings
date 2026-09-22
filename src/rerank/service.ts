import { JudgmentCache } from "./cache";
import { hash } from "./evidence";
import { createRemoteTransport, type RemoteTransport } from "./remote-http";
import { planRerank } from "./planner";
import { providerFor } from "./providers";
import { rankNotes } from "./reduce";
import { packRequests, sameServingIdentity } from "./systemone";
import {
  EVIDENCE_POLICY_VERSION,
  LIMITS,
  PRIMITIVE_VERSION,
  PROVIDERS,
  RANKING_POLICY_VERSION,
  RUBRIC_VERSION,
  RerankError,
  type EvidenceRecord,
  type Provider,
  type RerankAccess,
  type RerankInput,
  type RerankMetrics,
  type RerankOutcome,
  type ServingIdentity,
} from "./types";
import type { RetrievedNoteCandidate } from "../weaviate";

/** One plugin-wide network lane. Queued aborts are removed before dispatch. */
class RequestQueue {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  acquire(signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const abort = () => {
        const index = this.waiting.indexOf(start);
        if (index >= 0) this.waiting.splice(index, 1);
        signal.removeEventListener("abort", abort);
        reject(signal.reason instanceof RerankError ? signal.reason : new RerankError("cancelled"));
      };
      const start = () => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) { abort(); return; }
        this.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active--;
          this.waiting.shift()?.();
        });
      };
      if (signal.aborted) { abort(); return; }
      if (this.active < LIMITS.concurrency) start();
      else if (this.waiting.length >= 128) reject(new RerankError("budget"));
      else {
        this.waiting.push(start);
        signal.addEventListener("abort", abort, { once: true });
      }
    });
  }
}

function syntheticCandidate(): RetrievedNoteCandidate {
  const result = {
    noteId: "synthetic",
    snapshotId: "synthetic",
    path: "",
    title: "Arithmetic",
    score: 1,
    scoreKind: "hybrid" as const,
    passages: [{ passageId: "synthetic", heading: "Addition", body: "Two plus two equals four.", startLine: 0, endLine: 1 }],
  };
  return {
    result,
    noteRank: 0,
    passages: [{
      noteId: "synthetic",
      snapshotId: "synthetic",
      path: "",
      storedTitle: "Arithmetic",
      passageId: "synthetic",
      heading: "Addition",
      body: "Two plus two equals four.",
      startLine: 0,
      endLine: 1,
      retrievalScore: 1,
      retrievalRank: 0,
    }],
  };
}

export class RerankService {
  private readonly cache = new JudgmentCache();
  private readonly queue = new RequestQueue();
  private readonly jobs = new Set<AbortController>();
  private readonly resolved = new Map<Provider, ServingIdentity>();
  private readonly failures = new Map<Provider, { count: number; until: number }>();
  private requests = 0;
  private tokens = 0;
  private revision = 0;
  private disposed = false;

  constructor(
    private readonly access: () => RerankAccess,
    private readonly transport: RemoteTransport = createRemoteTransport(),
  ) {}

  invalidate(): void {
    this.revision++;
    for (const job of this.jobs) job.abort(new RerankError("cancelled"));
    this.cache.clear();
    this.resolved.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.invalidate();
  }

  run(input: RerankInput): Promise<RerankOutcome> {
    return this.evaluate(input, false);
  }

  /** Explicit settings action. Built-in text only; never reads a vault candidate. */
  testConnection(signal: AbortSignal): Promise<RerankOutcome> {
    return this.evaluate({
      vaultId: "synthetic",
      generation: 0,
      fingerprint: "synthetic",
      query: "What is two plus two?",
      candidates: [syntheticCandidate()],
      minimumCandidateCount: 1,
      candidateWindow: 1,
      candidateExhausted: true,
      signal,
      isCurrent: () => true,
      isAllowed: () => true,
    }, true);
  }

  private async evaluate(original: RerankInput, synthetic: boolean): Promise<RerankOutcome> {
    const started = performance.now();
    const deadlineAt = started + LIMITS.deadlineMs;
    const access = this.access();
    const revision = this.revision;
    const input = { ...original, candidates: structuredClone(original.candidates) };
    const metrics: RerankMetrics = {
      route: access.provider,
      requestedModel: PROVIDERS[access.provider].model,
      metricVersion: `${RUBRIC_VERSION}/${EVIDENCE_POLICY_VERSION}/${RANKING_POLICY_VERSION}`,
      inputCandidateCount: input.candidates.length,
      candidateCount: 0,
      candidateWindow: input.candidateWindow,
      candidateExhausted: input.candidateExhausted,
      evidenceCount: 0,
      truncatedCount: 0,
      cacheHits: 0,
      requests: 0,
      estimatedTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      elapsedMs: 0,
    };

    const job = new AbortController();
    const cancel = () => job.abort(new RerankError("cancelled"));
    if (input.signal.aborted) cancel();
    else input.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => job.abort(new RerankError("deadline")), LIMITS.deadlineMs);
    this.jobs.add(job);

    const guard = () => {
      if (this.disposed || revision !== this.revision || !input.isCurrent()
        || this.access().revision !== access.revision) throw new RerankError("cancelled");
      if (job.signal.aborted) {
        throw job.signal.reason instanceof RerankError ? job.signal.reason : new RerankError("cancelled");
      }
      if (performance.now() >= deadlineAt) throw new RerankError("deadline");
      if (!synthetic && !access.enabled) throw new RerankError("off");
      if (!access.apiKey) throw new RerankError("unconfigured");
      if (!synthetic && (!access.consent || !input.candidates.every(input.isAllowed))) throw new RerankError("policy");
    };

    try {
      guard();
      if ((this.failures.get(access.provider)?.until ?? 0) > performance.now()) throw new RerankError("circuit-open");

      const provider = providerFor(access.provider, this.transport);
      if (provider.requestedModel !== PROVIDERS[access.provider].model) throw new RerankError("model-change");
      const plan = planRerank(
        input.candidates,
        input.minimumCandidateCount,
        input.query,
        access.provider,
        synthetic ? 1 : access.evidencePassages,
      );
      metrics.candidateCount = plan.candidates.length;
      metrics.evidenceCount = plan.records.length;
      metrics.truncatedCount = plan.records.filter(record => record.truncated).length;

      const queryHash = hash(input.query);
      const known = this.resolved.get(access.provider);
      const key = (record: EvidenceRecord, serving: ServingIdentity) => hash([
        input.vaultId,
        serving.route,
        serving.requestedModel,
        serving.servedModel,
        serving.upstreamProvider ?? "",
        PRIMITIVE_VERSION,
        RUBRIC_VERSION,
        EVIDENCE_POLICY_VERSION,
        RANKING_POLICY_VERSION,
        queryHash,
        "search",
        input.generation,
        input.fingerprint,
        record.noteId,
        record.snapshotId,
        record.passageId,
        record.hash,
        access.settingsRevision,
        access.cloudPolicyRevision,
        access.consentRevision,
        access.credentialRevision,
      ]);

      const scores = new Map<string, number>();
      if (known) {
        for (const record of plan.records) {
          guard();
          const score = this.cache.get(key(record, known));
          if (score !== undefined) scores.set(record.key, score);
        }
      }
      metrics.cacheHits = scores.size;

      // The full cohort was admitted by planRerank before cache use. Repack only current misses.
      const missing = plan.records.filter(record => !scores.has(record.key));
      const batches = packRequests(access.provider, input.query, missing);
      metrics.estimatedTokens = batches.reduce((sum, batch) => sum + batch.estimatedTokens, 0);
      if (batches.length > LIMITS.maxBatches || metrics.estimatedTokens > LIMITS.operationTokens) {
        throw new RerankError("budget");
      }
      if (this.requests + batches.length > LIMITS.sessionRequests
        || this.tokens + metrics.estimatedTokens > LIMITS.sessionTokens) {
        throw new RerankError("budget");
      }

      let serving = scores.size ? known : undefined;
      let next = 0;
      const worker = async () => {
        while (next < batches.length) {
          const batch = batches[next++]!;
          const release = await this.queue.acquire(job.signal);
          try {
            guard();
            if (this.requests + 1 > LIMITS.sessionRequests
              || this.tokens + batch.estimatedTokens > LIMITS.sessionTokens) throw new RerankError("budget");
            this.requests++;
            this.tokens += batch.estimatedTokens;
            metrics.requests++;

            const response = await provider.evaluate(batch, access.apiKey, job.signal, deadlineAt, guard);
            metrics.inputTokens += response.inputTokens;
            metrics.outputTokens += response.outputTokens;
            metrics.cost += response.cost ?? 0;
            this.tokens += Math.max(0, response.inputTokens - batch.estimatedTokens);
            guard();

            if ((known && !sameServingIdentity(known, response.servingIdentity))
              || (serving && !sameServingIdentity(serving, response.servingIdentity))) {
              throw new RerankError("model-change");
            }
            serving = response.servingIdentity;
            for (const [candidate, score] of response.scores) scores.set(candidate, score);
          } catch (error) {
            job.abort(error instanceof RerankError ? error : new RerankError("provider", true));
            throw error;
          } finally {
            release();
          }
        }
      };

      const work = await Promise.allSettled(
        Array.from({ length: Math.min(LIMITS.concurrency, batches.length) }, () => worker()),
      );
      const failed = work.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed) throw job.signal.reason ?? failed.reason;

      guard();
      if (!serving || scores.size !== plan.records.length) throw new RerankError("invalid-response");
      const results = rankNotes(plan.candidates, plan.records, scores, serving);
      guard();

      if (!synthetic) {
        this.resolved.set(access.provider, serving);
        for (const record of plan.records) this.cache.set(key(record, serving), scores.get(record.key)!);
      }
      metrics.servedModel = serving.servedModel;
      if (serving.upstreamProvider !== undefined) metrics.upstreamProvider = serving.upstreamProvider;
      this.failures.delete(access.provider);
      return { status: "applied", results, metrics };
    } catch (problem) {
      const error = problem instanceof RerankError ? problem : new RerankError("provider");
      job.abort(error);

      if (error.reason === "model-change") {
        this.cache.clear();
        this.resolved.delete(access.provider);
      }
      if (error.reason === "rate-limit") {
        this.failures.set(access.provider, { count: 3, until: performance.now() + 30_000 });
      } else if (error.transient || (error.reason === "deadline" && metrics.requests > 0)) {
        const count = (this.failures.get(access.provider)?.count ?? 0) + 1;
        this.failures.set(access.provider, {
          count,
          until: count >= 3 ? performance.now() + 30_000 : 0,
        });
      }
      return {
        status: error.reason === "cancelled" ? "cancelled" : "retained",
        reason: error.reason,
        metrics,
      };
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", cancel);
      this.jobs.delete(job);
      metrics.elapsedMs = performance.now() - started;
    }
  }
}
