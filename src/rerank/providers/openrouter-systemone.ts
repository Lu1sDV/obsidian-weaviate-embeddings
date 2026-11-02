import { parseJudgments } from "../systemone";
import type { ValidatedDecisionModel } from "../model-catalog";
import type { RemoteTransport } from "../remote-http";
import type { RequestBatch } from "../systemone";
import type { RerankProvider } from "./provider";

export class OpenRouterSystemOneProvider implements RerankProvider {
  readonly route = "openrouter" as const;
  readonly requestedModel: string;

  constructor(private readonly model: ValidatedDecisionModel, private readonly transport: RemoteTransport) {
    this.requestedModel = model.requestedModel;
  }

  async evaluate(batch: RequestBatch, apiKey: string, signal: AbortSignal, deadlineAt: number, beforeSend: () => void) {
    const text = await this.transport({
      provider: this.route,
      apiKey,
      body: batch.body,
      signal,
      deadlineAt,
      beforeSend,
    });
    return parseJudgments(text, this.model, batch.records.map(record => record.key));
  }
}
