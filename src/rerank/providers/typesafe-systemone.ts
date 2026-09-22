import { parseJudgments } from "../systemone";
import { PROVIDERS } from "../types";
import type { RemoteTransport } from "../remote-http";
import type { RequestBatch } from "../systemone";
import type { RerankProvider } from "./provider";

export class TypeSafeSystemOneProvider implements RerankProvider {
  readonly route = "typesafe" as const;
  readonly requestedModel = PROVIDERS.typesafe.model;

  constructor(private readonly transport: RemoteTransport) {}

  async evaluate(batch: RequestBatch, apiKey: string, signal: AbortSignal, deadlineAt: number, beforeSend: () => void) {
    const text = await this.transport({
      provider: this.route,
      apiKey,
      body: batch.body,
      signal,
      deadlineAt,
      beforeSend,
    });
    return parseJudgments(text, this.route, batch.records.map(record => record.key));
  }
}
