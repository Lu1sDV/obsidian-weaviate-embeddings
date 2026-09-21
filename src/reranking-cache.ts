/** One current search only. No note text, query, credentials, or disk persistence. */
export class CurrentRerankingCache {
  private entry: { key: string; scores: number[] } | undefined;

  read(key: string): number[] | undefined {
    if (this.entry?.key !== key) this.clear();
    return this.entry ? [...this.entry.scores] : undefined;
  }

  write(key: string, scores: readonly number[]): void {
    this.entry = { key, scores: [...scores] };
  }

  clear(): void { this.entry = undefined; }
}
