import { JudgmentCache } from "./cache";
import { hash, selectEvidence } from "./evidence";
import { createRemoteTransport, type RemoteTransport } from "./http";
import { rankNotes } from "./reduce";
import { packRequests, parseJudgments } from "./systemone";
import { LIMITS, METRIC_VERSION, PROVIDERS, RerankError, type EvidenceRecord, type Provider, type RerankAccess, type RerankInput, type RerankMetrics, type RerankOutcome } from "./types";

/** A plugin-wide queue, not one concurrency limit per view. Aborted waiters never dispatch. */
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
          released = true; this.active--;
          this.waiting.shift()?.();
        });
      };
      if (signal.aborted) { abort(); return; }
      if (this.active < LIMITS.concurrency) start();
      else if (this.waiting.length >= 128) reject(new RerankError("budget"));
      else { this.waiting.push(start); signal.addEventListener("abort", abort, { once: true }); }
    });
  }
}

export class RerankService {
  private readonly cache = new JudgmentCache();
  private readonly queue = new RequestQueue();
  private readonly jobs = new Set<AbortController>();
  private readonly resolved = new Map<Provider, string>();
  private readonly failures = new Map<Provider, { count: number; until: number }>();
  private requests = 0;
  private tokens = 0;
  private revision = 0;
  private disposed = false;
  constructor(private readonly access: () => RerankAccess, private readonly transport: RemoteTransport = createRemoteTransport()) {}

  invalidate(): void {
    this.revision++;
    for (const job of this.jobs) job.abort(new RerankError("cancelled"));
    this.cache.clear(); this.resolved.clear();
  }
  dispose(): void { this.disposed = true; this.invalidate(); }
  run(input: RerankInput): Promise<RerankOutcome> { return this.evaluate(input, false); }

  /** Explicit settings action: only this built-in text can bypass vault-excerpt consent. */
  testConnection(signal: AbortSignal): Promise<RerankOutcome> {
    return this.evaluate({ vaultId: "synthetic", generation: 0, fingerprint: "synthetic", query: "What is two plus two?",
      candidates: [{ noteId: "synthetic", snapshotId: "synthetic", path: "", title: "Arithmetic", score: 1, scoreKind: "hybrid",
        passages: [{ passageId: "synthetic", heading: "Addition", body: "Two plus two equals four.", startLine: 0, endLine: 1 }] }],
      signal, isCurrent: () => true, isAllowed: () => true }, true);
  }

  private async evaluate(original: RerankInput, synthetic: boolean): Promise<RerankOutcome> {
    const started = performance.now(), deadlineAt = started + LIMITS.deadlineMs;
    const access = this.access(), revision = this.revision;
    const input = { ...original, candidates: structuredClone(original.candidates) };
    const metrics: RerankMetrics = { provider: access.provider, requestedModel: PROVIDERS[access.provider].model, metricVersion: METRIC_VERSION,
      candidateCount: input.candidates.length, evidenceCount: 0, truncatedCount: 0, cacheHits: 0,
      requests: 0, estimatedTokens: 0, inputTokens: 0, outputTokens: 0, cost: 0, elapsedMs: 0 };
    const job = new AbortController();
    const cancel = () => job.abort(new RerankError("cancelled"));
    if (input.signal.aborted) cancel();
    else input.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => job.abort(new RerankError("deadline")), LIMITS.deadlineMs);
    this.jobs.add(job);
    const guard = () => {
      if (this.disposed || revision !== this.revision || !input.isCurrent() || this.access().revision !== access.revision) throw new RerankError("cancelled");
      if (job.signal.aborted) throw job.signal.reason instanceof RerankError ? job.signal.reason : new RerankError("cancelled");
      if (performance.now() >= deadlineAt) throw new RerankError("deadline");
      if (!synthetic && !access.enabled) throw new RerankError("off");
      if (!access.apiKey) throw new RerankError("unconfigured");
      if (!synthetic && (!access.consent || !input.candidates.every(input.isAllowed))) throw new RerankError("policy");
    };
    try {
      guard();
      if ((this.failures.get(access.provider)?.until ?? 0) > performance.now()) throw new RerankError("circuit-open");
      const { required, optional } = selectEvidence(input.candidates, input.query);
      const knownModel = this.resolved.get(access.provider);
      const key = (record: EvidenceRecord, model: string) => hash([input.vaultId, input.generation, input.fingerprint,
        access.provider, PROVIDERS[access.provider].model, model, METRIC_VERSION, access.experimentalBatching, access.revision,
        input.query, record.noteId, record.snapshotId, record.passageId, record.hash]);
      const cached = new Map<string, number>();
      if (knownModel) for (const record of [...required, ...optional]) {
        guard();
        const score = this.cache.get(key(record, knownModel));
        if (score !== undefined) cached.set(record.key, score);
      }
      const plan = (records: EvidenceRecord[]) => packRequests(access.provider, input.query,
        records.filter(record => !cached.has(record.key)), access.experimentalBatching && !synthetic);
      let selected = required, batches = plan(required);
      const total = (items: typeof batches) => items.reduce((sum, batch) => sum + batch.estimatedTokens, 0);
      if (total(batches) > LIMITS.operationTokens) throw new RerankError("budget");
      // Use all useful second passages or none: do not grant arbitrary early notes extra chances.
      if (optional.length) {
        const expanded = [...required, ...optional], expandedBatches = plan(expanded);
        if (total(expandedBatches) <= LIMITS.operationTokens) { selected = expanded; batches = expandedBatches; }
      }
      metrics.evidenceCount = selected.length;
      metrics.truncatedCount = selected.filter(record => record.truncated).length;
      metrics.estimatedTokens = total(batches);
      if (this.requests + batches.length > LIMITS.sessionRequests || this.tokens + metrics.estimatedTokens > LIMITS.sessionTokens) throw new RerankError("budget");
      const scores = new Map(selected.filter(record => cached.has(record.key)).map(record => [record.key, cached.get(record.key)!]));
      metrics.cacheHits = scores.size;
      let resolvedModel = scores.size ? knownModel : undefined;
      let next = 0;
      const worker = async () => {
        while (next < batches.length) {
          const batch = batches[next++]!;
          const release = await this.queue.acquire(job.signal);
          try {
            guard();
            // Reserve globally at actual dispatch. Aborted/billed requests are never refunded.
            if (this.requests + 1 > LIMITS.sessionRequests || this.tokens + batch.estimatedTokens > LIMITS.sessionTokens) throw new RerankError("budget");
            this.requests++; this.tokens += batch.estimatedTokens; metrics.requests++;
            const text = await this.transport({ provider: access.provider, apiKey: access.apiKey, body: batch.body,
              signal: job.signal, deadlineAt, beforeSend: guard });
            const response = parseJudgments(text, access.provider, batch.records.map(record => record.key));
            metrics.inputTokens += response.inputTokens; metrics.outputTokens += response.outputTokens; metrics.cost += response.cost ?? 0;
            this.tokens += Math.max(0, response.inputTokens - batch.estimatedTokens);
            guard();
            if (resolvedModel && resolvedModel !== response.resolvedModel) throw new RerankError("model-change");
            resolvedModel = response.resolvedModel;
            for (const [candidate, score] of response.scores) scores.set(candidate, score);
          } catch (error) {
            job.abort(error instanceof RerankError ? error : new RerankError("provider", true));
            throw error;
          } finally { release(); }
        }
      };
      const work = await Promise.allSettled(Array.from({ length: Math.min(LIMITS.concurrency, batches.length) }, () => worker()));
      const failed = work.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed) throw job.signal.reason ?? failed.reason;
      guard();
      if (!resolvedModel) throw new RerankError("invalid-response");
      const results = rankNotes(input.candidates, selected, scores, access.provider, resolvedModel);
      guard(); // Same checks protect cache insertion and complete-cohort publication.
      if (!synthetic) {
        this.resolved.set(access.provider, resolvedModel);
        for (const record of selected) this.cache.set(key(record, resolvedModel), scores.get(record.key)!);
      }
      metrics.resolvedModel = resolvedModel;
      this.failures.delete(access.provider);
      return { status: "applied", results, metrics };
    } catch (problem) {
      const error = problem instanceof RerankError ? problem : new RerankError("provider");
      job.abort(error);
      if (error.reason === "model-change") { this.cache.clear(); this.resolved.delete(access.provider); }
      if (error.transient || (error.reason === "deadline" && metrics.requests > 0)) {
        const count = (this.failures.get(access.provider)?.count ?? 0) + 1;
        this.failures.set(access.provider, { count, until: count >= 3 ? performance.now() + 30_000 : 0 });
      }
      return { status: error.reason === "cancelled" ? "cancelled" : "retained", reason: error.reason, metrics };
    } finally {
      clearTimeout(timer); input.signal.removeEventListener("abort", cancel); this.jobs.delete(job);
      metrics.elapsedMs = performance.now() - started;
    }
  }
}
