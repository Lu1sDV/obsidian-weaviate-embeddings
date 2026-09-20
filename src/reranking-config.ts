/** Only the native JEV Decisions JSON protocol is supported. */
export const RERANKING_PROVIDERS = [
  { id: "jev-openrouter", label: "JEV via OpenRouter (native JSON)" },
] as const;

export type RerankingProvider = typeof RERANKING_PROVIDERS[number]["id"];

export interface RerankingSettings {
  enabled: boolean;
  provider: RerankingProvider;
}

export const DEFAULT_RERANKING_SETTINGS: Readonly<RerankingSettings> = {
  enabled: false,
  provider: "jev-openrouter",
};

/** Old installations stay local. Unknown providers fail closed rather than being substituted. */
export function mergeRerankingSettings(value: unknown): RerankingSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_RERANKING_SETTINGS };
  const settings = value as Record<string, unknown>;
  if (settings.provider !== DEFAULT_RERANKING_SETTINGS.provider) return { ...DEFAULT_RERANKING_SETTINGS };
  return { provider: settings.provider, enabled: settings.enabled === true };
}
