import type { RemoteTransport } from "../remote-http";
import type { RequestBatch } from "../systemone";
import type { JudgmentResponse, Provider } from "../types";
import type { ValidatedDecisionModel } from "../model-catalog";

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

export type ProviderFactory = (model: ValidatedDecisionModel, transport: RemoteTransport) => RerankProvider;
