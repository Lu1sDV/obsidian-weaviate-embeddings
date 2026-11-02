import type { RemoteTransport } from "../remote-http";
import type { ValidatedDecisionModel } from "../model-catalog";
import { OpenRouterSystemOneProvider } from "./openrouter-systemone";
import type { ProviderFactory, RerankProvider } from "./provider";

export const providerFor: ProviderFactory = (model: ValidatedDecisionModel, transport: RemoteTransport): RerankProvider =>
  new OpenRouterSystemOneProvider(model, transport);

export type { ProviderFactory, RerankProvider } from "./provider";
