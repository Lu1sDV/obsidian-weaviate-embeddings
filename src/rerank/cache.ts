import { LIMITS } from "./types";

/** Completed scalar judgments only; neither evidence nor queries are retained. */
export class JudgmentCache {
  private readonly entries = new Map<string, { score: number; expires: number; bytes: number }>();
  private bytes = 0;
  constructor(private readonly now: () => number = Date.now,
    private readonly capacity: number = LIMITS.cacheEntries, private readonly byteLimit: number = LIMITS.cacheBytes,
    private readonly ttl: number = LIMITS.cacheTtlMs) {}
  get(key: string): number | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.remove(key);
    if (entry.expires <= this.now()) return undefined;
    this.entries.set(key, entry); this.bytes += entry.bytes;
    return entry.score;
  }
  set(key: string, score: number): void {
    this.remove(key);
    if (!Number.isFinite(score) || score < 0 || score > 1) return;
    const bytes = Buffer.byteLength(key) + 32;
    if (bytes > this.byteLimit || this.capacity < 1) return;
    this.entries.set(key, { score, expires: this.now() + this.ttl, bytes }); this.bytes += bytes;
    while (this.entries.size > this.capacity || this.bytes > this.byteLimit) this.remove(this.entries.keys().next().value!);
  }
  clear(): void { this.entries.clear(); this.bytes = 0; }
  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry) { this.entries.delete(key); this.bytes -= entry.bytes; }
  }
}
