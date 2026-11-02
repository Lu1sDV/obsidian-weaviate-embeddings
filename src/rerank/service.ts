import { JudgmentCache } from "./cache";
import { hash } from "./evidence";
import { planAdaptive, ADAPTIVE_VERSION, type AdaptivePlan } from "./adaptive-plan";
import { createRemoteTransport, type RemoteTransport } from "./remote-http";
import { providerFor } from "./providers";
import { sameServingIdentity } from "./systemone";
import { DecisionModelError, type ValidatedDecisionModel } from "./model-catalog";
import { OpenRouterModelRegistry, type ModelRegistry } from "./model-registry";
import { LIMITS, REASON_LABELS, RerankError, type Provider, type RerankAccess, type RerankInput,
  type RerankMetrics, type RerankOutcome, type ServingIdentity } from "./types";
import type { SearchResult } from "../types";

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

/** One note-level judgment per candidate; retrieval scores and graph cosines are never modified. */
export function rankAdaptive(plan: AdaptivePlan, scores: ReadonlyMap<string, number>, serving: ServingIdentity): SearchResult[] {
  if (scores.size !== plan.records.length || plan.records.some(record => {
    const value = scores.get(record.key); return value === undefined || !Number.isFinite(value) || value < 0 || value > 1;
  })) throw new RerankError("invalid-response");
  return plan.candidates.map((candidate, index) => {
    const record = plan.records[index]!, result = structuredClone(candidate.result);
    result.rerank = { ...serving, rubricVersion: plan.rubric, evidencePolicyVersion: ADAPTIVE_VERSION,
      rankingPolicyVersion: "note-relevance-v2", relevance: scores.get(record.key)!, bestPassageId: record.passageId,
      evidenceCount: record.selected.ranges.length, coverage: "complete", judgments: [],
      evidenceCoverage: record.selected.complete ? "full" : "excerpt",
      sourceCoverage: plan.preview.source.shortened ? "excerpt" : "full" };
    return { result, index };
  }).sort((a, b) => b.result.rerank!.relevance - a.result.rerank!.relevance || a.index - b.index)
    .slice(0, 30).map(item => item.result);
}

export class RerankService {
  private readonly cache = new JudgmentCache();
  private readonly queue = new RequestQueue();
  private readonly jobs = new Map<AbortController, ReadonlySet<string>>();
  private readonly resolved = new Map<Provider, ServingIdentity>();
  private readonly failures = new Map<string, { count: number; until: number }>();
  private requests = 0;
  private tokens = 0;
  private revision = 0;
  private disposed = false;
  validationProblem: string | null = null;

  constructor(private readonly access: () => RerankAccess,
    private readonly transport: RemoteTransport = createRemoteTransport(),
    private readonly models: ModelRegistry = new OpenRouterModelRegistry()) {}

  get validatedModel(): ValidatedDecisionModel | null { return this.models.current(this.access()); }

  invalidate(noteId?: string): void {
    if (noteId) {
      for (const [job, notes] of this.jobs) if (notes.has(noteId)) job.abort(new RerankError("cancelled"));
      return;
    }
    this.revision++;
    for (const job of this.jobs.keys()) job.abort(new RerankError("cancelled"));
    this.cache.clear(); this.resolved.clear();
  }
  dispose(): void { this.disposed = true; this.invalidate(); }
  run(input: RerankInput): Promise<RerankOutcome> { return this.evaluate(input, false); }

  /** Explicit synthetic validation uses the same source/candidate/typed-question wire contract. */
  testConnection(signal: AbortSignal): Promise<RerankOutcome> {
    this.invalidate(); this.validationProblem = null;
    const body = "Two plus two equals four.";
    const passage = { passageId: "synthetic", heading: "Addition", body, startLine: 0, endLine: 1 };
    return this.evaluate({
      source: { kind: "search", title: "", text: "What is two plus two?", anchors: [] },
      documents: [{ title: "Arithmetic", text: body, anchors: [{ start: 0, end: body.length, passageId: "synthetic" }] }],
      isSourceAllowed: () => true,
      vaultId: "synthetic", generation: 0, fingerprint: "synthetic", query: "What is two plus two?", queryEpoch: 0,
      filtersIdentity: "[]", minimumCandidateCount: 1, baselineWindow: 1, candidateWindow: 1, candidateExhausted: true,
      candidates: [{ noteRank: 0,
        result: { noteId: "synthetic", snapshotId: "synthetic", path: "", title: "Arithmetic", score: 1, scoreKind: "hybrid", passages: [passage] },
        passages: [{ ...passage, noteId: "synthetic", snapshotId: "synthetic", path: "", storedTitle: "Arithmetic", retrievalScore: 1, retrievalRank: 0 }] }],
      signal, isCurrent: () => true, isAllowed: () => true,
    }, true);
  }

  private async evaluate(original: RerankInput, synthetic: boolean): Promise<RerankOutcome> {
    const started = performance.now(), timeout = synthetic ? 10_000 : LIMITS.deadlineMs;
    const deadlineAt = Math.min(started + timeout, original.deadlineAt ?? Infinity);
    const access = this.access(), routeKey = hash([access.provider, access.model, access.apiKey]), revision = this.revision;
    const input: RerankInput = { ...original, source: structuredClone(original.source),
      documents: structuredClone(original.documents), candidates: structuredClone(original.candidates) };
    const metrics: RerankMetrics = {
      route: access.provider, requestedModel: access.model, metricVersion: ADAPTIVE_VERSION,
      inputCandidateCount: input.candidates.length, candidateCount: 0, baselineWindow: input.baselineWindow,
      candidateWindow: input.candidateWindow, candidateExhausted: input.candidateExhausted,
      evidenceCount: 0, truncatedCount: 0, cacheHits: 0, requests: 0, estimatedTokens: 0,
      inputTokens: 0, outputTokens: 0, cost: 0, elapsedMs: 0, tokenAccounting: "estimated",
    };
    const job = new AbortController();
    const cancel = () => job.abort(input.signal.reason instanceof RerankError ? input.signal.reason : new RerankError("cancelled"));
    if (input.signal.aborted) cancel(); else input.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => job.abort(new RerankError("deadline")), Math.max(0, deadlineAt - performance.now()));
    this.jobs.set(job, new Set([...input.candidates.map(candidate => candidate.result.noteId), ...(input.source.noteId ? [input.source.noteId] : [])]));
    const guard = () => {
      const current = this.access();
      if (this.disposed || revision !== this.revision || !input.isCurrent() || current.model !== access.model
        || current.apiKey !== access.apiKey || current.revision !== access.revision
        || current.settingsRevision !== access.settingsRevision || current.cloudPolicyRevision !== access.cloudPolicyRevision
        || current.consentRevision !== access.consentRevision || current.credentialRevision !== access.credentialRevision) throw new RerankError("cancelled");
      if (job.signal.aborted) throw job.signal.reason instanceof RerankError ? job.signal.reason : new RerankError("cancelled");
      if (performance.now() >= deadlineAt) throw new RerankError("deadline");
      if (!synthetic && !access.enabled) throw new RerankError("off");
      if (!access.apiKey || !access.model) throw new RerankError("unconfigured");
      if (!synthetic && (!access.consent || !input.isSourceAllowed() || !input.candidates.every(input.isAllowed))) throw new RerankError("policy");
    };
    try {
      guard();
      if ((this.failures.get(routeKey)?.until ?? 0) > performance.now()) throw new RerankError("circuit-open");
      const model = synthetic ? await this.models.load(access, job.signal) : this.models.current(access);
      guard();
      if (!model) throw new RerankError("model-unverified");
      const plan = planAdaptive(input, model, synthetic ? { ...access, candidateCount: 1, evidencePolicy: "adaptive" } : access);
      guard();
      metrics.candidateCount = plan.candidates.length;
      metrics.evidenceCount = plan.records.reduce((sum, record) => sum + record.selected.ranges.length, 0);
      metrics.truncatedCount = plan.records.filter(record => record.truncated).length;
      metrics.completeCandidateCount = plan.records.length - metrics.truncatedCount;
      metrics.omittedCandidateCount = input.candidates.length - plan.candidates.length;
      metrics.omittedAnchorCount = plan.records.reduce((sum, record) => sum + record.selected.omittedAnchors, 0);
      metrics.sourceTruncated = plan.preview.source.shortened;
      metrics.inputTokenBudget = plan.budget;
      metrics.estimatedTokens = plan.batch.estimatedTokens;
      const key = (question: string, serving: ServingIdentity) => hash([
        input.vaultId, input.generation, input.fingerprint, input.filtersIdentity, input.query, input.source,
        plan.fingerprint, serving, access.settingsRevision, access.cloudPolicyRevision, access.consentRevision, access.credentialRevision, question,
      ]);
      const known = synthetic ? undefined : this.resolved.get(access.provider);
      let scores = new Map<string, number>(), serving = known;
      if (known) for (const record of plan.records) {
        const value = this.cache.get(key(record.key, known));
        if (value !== undefined) scores.set(record.key, value);
      }
      // Reuse only a complete cohort. Partial cache hits never create mixed comparison contexts.
      if (scores.size === plan.records.length) metrics.cacheHits = scores.size;
      else {
        scores = new Map();
        const release = await this.queue.acquire(job.signal);
        try {
          const beforeSend = () => {
            guard();
            if (!synthetic && !this.models.current(this.access())) throw new RerankError("model-unverified");
          };
          beforeSend();
          if (this.requests + 1 > LIMITS.sessionRequests || this.tokens + plan.batch.estimatedTokens > LIMITS.sessionTokens) throw new RerankError("budget");
          this.requests++; this.tokens += plan.batch.estimatedTokens;
          metrics.requests = 1; metrics.cost = null;
          // This is the only inference call in the entire operation. No loops, retries or overflow batches.
          const response = await providerFor(model, this.transport).evaluate(plan.batch, access.apiKey, job.signal, deadlineAt, beforeSend);
          metrics.inputTokens = response.inputTokens; metrics.outputTokens = response.outputTokens; metrics.cost = response.cost ?? null;
          this.tokens += Math.max(0, response.inputTokens - plan.batch.estimatedTokens);
          guard();
          if (known && !sameServingIdentity(known, response.servingIdentity)) throw new RerankError("model-change");
          serving = response.servingIdentity; scores = response.scores;
        } finally { release(); }
      }
      guard();
      if (!serving) throw new RerankError("invalid-response");
      const results = rankAdaptive(plan, scores, serving);
      guard();
      if (synthetic) { this.models.approve(access, model); this.resolved.clear(); this.cache.clear(); }
      else {
        this.resolved.set(access.provider, serving);
        for (const record of plan.records) this.cache.set(key(record.key, serving), scores.get(record.key)!);
      }
      metrics.servedModel = serving.servedModel;
      if (serving.upstreamProvider !== undefined) metrics.upstreamProvider = serving.upstreamProvider;
      this.failures.delete(routeKey);
      return { status: "applied", results, metrics, preview: plan.preview };
    } catch (problem) {
      const error = problem instanceof RerankError ? problem : new RerankError(problem instanceof DecisionModelError ? "model-invalid" : "provider");
      if (synthetic) this.validationProblem = problem instanceof DecisionModelError ? problem.message : REASON_LABELS[error.reason];
      job.abort(error);
      if (error.reason === "model-change") { this.cache.clear(); this.resolved.clear(); }
      if (error.reason === "rate-limit") this.failures.set(routeKey, { count: 3, until: performance.now() + 30_000 });
      else if (error.transient || error.reason === "deadline" && metrics.requests > 0) {
        const count = (this.failures.get(routeKey)?.count ?? 0) + 1;
        this.failures.set(routeKey, { count, until: count >= 3 ? performance.now() + 30_000 : 0 });
      }
      return { status: error.reason === "cancelled" ? "cancelled" : "retained", reason: error.reason, metrics };
    } finally {
      clearTimeout(timer); input.signal.removeEventListener("abort", cancel); this.jobs.delete(job);
      metrics.elapsedMs = performance.now() - started;
    }
  }
}
