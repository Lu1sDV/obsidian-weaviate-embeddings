import type { RemoteTransport } from "../remote-http";
import type { RequestBatch } from "../systemone";
import type { JudgmentResponse, Provider } from "../types";

export interface RerankProvider {
  readonly route: Provider;
  readonly requestedModel: string;
  evaluate(
    batch: RequestBatch,
    apiKey: string,
    signal: AbortSignal,
    deadlineAt: number,
    beforeSend: () => void,
  ): Promise<JudgmentResponse>;
}

export type ProviderFactory = (route: Provider, transport: RemoteTransport) => RerankProvider;
