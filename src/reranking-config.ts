/** Only the native JEV Decisions JSON protocol is supported. */
export const RERANKING_PROVIDERS = [
  { id: "jev-openrouter", label: "JEV via OpenRouter (native JSON)" },
] as const;
export type RerankingProvider = typeof RERANKING_PROVIDERS[number]["id"];
export type EvidencePolicy = "matched-passages" | "contextual";
export interface RerankingSettings {
  enabled: boolean;
  provider: RerankingProvider;
  evidencePolicy: EvidencePolicy;
  allowWholeShortNotes: boolean;
}
export const DEFAULT_RERANKING_SETTINGS: Readonly<RerankingSettings> = {
  enabled: false, provider: "jev-openrouter", evidencePolicy: "contextual", allowWholeShortNotes: false,
};

/** Older excerpt-only consent must not silently authorize broader uploads. */
export function mergeRerankingSettings(value: unknown): RerankingSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_RERANKING_SETTINGS };
  const settings = value as Record<string, unknown>;
  if (settings.provider !== DEFAULT_RERANKING_SETTINGS.provider
    || (settings.evidencePolicy !== "matched-passages" && settings.evidencePolicy !== "contextual")) return { ...DEFAULT_RERANKING_SETTINGS };
  return {
    provider: settings.provider, enabled: settings.enabled === true, evidencePolicy: settings.evidencePolicy,
    allowWholeShortNotes: settings.allowWholeShortNotes === true,
  };
}
