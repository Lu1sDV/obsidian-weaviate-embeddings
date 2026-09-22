import type { RemoteTransport } from "../remote-http";
import type { Provider } from "../types";
import { OpenRouterSystemOneProvider } from "./openrouter-systemone";
import type { ProviderFactory, RerankProvider } from "./provider";
import { TypeSafeSystemOneProvider } from "./typesafe-systemone";

export const providerFor: ProviderFactory = (route: Provider, transport: RemoteTransport): RerankProvider =>
  route === "openrouter" ? new OpenRouterSystemOneProvider(transport) : new TypeSafeSystemOneProvider(transport);

export type { ProviderFactory, RerankProvider } from "./provider";
