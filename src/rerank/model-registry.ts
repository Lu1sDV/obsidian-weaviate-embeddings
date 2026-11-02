import { createHash } from "node:crypto";
import { request } from "node:https";
import { parseDecisionModelPage, validateDecisionModel, type DecisionModelEntry, type ValidatedDecisionModel } from "./model-catalog";
import { RerankError, type RerankAccess } from "./types";

const CATALOGUE_URL = "https://openrouter.ai/api/v1/models?output_modalities=decisions";
const VALIDATION_TTL = 24 * 60 * 60_000;
const MAX_CATALOGUE_BYTES = 4 * 1024 * 1024;

export interface ModelRegistry {
  current(access: RerankAccess): ValidatedDecisionModel | null;
  load(access: RerankAccess, signal: AbortSignal): Promise<ValidatedDecisionModel>;
  approve(access: RerankAccess, model: ValidatedDecisionModel): void;
}

export type CatalogueReader = (url: string, apiKey: string, signal: AbortSignal) => Promise<unknown>;

/** Only catalogue GETs on the fixed OpenRouter origin; redirects never receive the credential. */
export const readDecisionCatalogue: CatalogueReader = (url, apiKey, signal) => new Promise((resolve, reject) => {
  const target = new URL(url);
  if (target.origin !== "https://openrouter.ai" || target.pathname !== "/api/v1/models"
    || target.username || target.password || target.hash || !/^[\x21-\x7e]{1,4096}$/.test(apiKey)) {
    reject(new RerankError("unconfigured"));
    return;
  }
  if (signal.aborted) { reject(new RerankError("cancelled")); return; }

  let settled = false;
  const req = request(target, {
    method: "GET",
    rejectUnauthorized: true,
    minVersion: "TLSv1.2",
    maxHeaderSize: 16_384,
    signal,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "Accept-Encoding": "identity" },
  });
  const timer = setTimeout(() => finish(new RerankError("deadline")), 10_000);
  function finish(error?: RerankError, value?: unknown): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) { req.destroy(); reject(error); }
    else resolve(value);
  }
  req.on("error", () => finish(new RerankError(signal.aborted ? "cancelled" : "provider")));
  req.on("response", response => {
    const status = response.statusCode ?? 0;
    if (status !== 200) {
      response.destroy();
      finish(new RerankError(status === 401 || status === 403 ? "authentication"
        : status === 429 ? "rate-limit" : "provider"));
      return;
    }
    const length = response.headers["content-length"];
    if ((response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity")
      || (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_CATALOGUE_BYTES))) {
      response.destroy();
      finish(new RerankError("invalid-response"));
      return;
    }
    let bytes = 0;
    const chunks: Buffer[] = [];
    response.on("error", () => finish(new RerankError("provider")));
    response.on("aborted", () => finish(new RerankError("provider")));
    response.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_CATALOGUE_BYTES) {
        response.destroy();
        finish(new RerankError("invalid-response"));
      } else chunks.push(chunk);
    });
    response.on("end", () => {
      if (!response.complete) { finish(new RerankError("provider")); return; }
      try {
        finish(undefined, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown);
      } catch { finish(new RerankError("invalid-response")); }
    });
  });
  req.end();
});

function credentialIdentity(access: RerankAccess): string {
  return createHash("sha256").update(access.apiKey).digest("hex");
}

/** A catalogue lookup alone never marks a model validated: approve follows the real synthetic contract. */
export class OpenRouterModelRegistry implements ModelRegistry {
  private verified: {
    model: ValidatedDecisionModel;
    credential: string;
    credentialRevision: number;
    modelRevision: number;
    validatedAt: number;
  } | undefined;

  constructor(private readonly read: CatalogueReader = readDecisionCatalogue, private readonly now = Date.now) {}

  current(access: RerankAccess): ValidatedDecisionModel | null {
    const entry = this.verified;
    if (!entry || !access.apiKey || entry.model.requestedModel !== access.model
      || entry.credentialRevision !== access.credentialRevision || entry.modelRevision !== access.modelRevision
      || entry.credential !== credentialIdentity(access) || this.now() - entry.validatedAt >= VALIDATION_TTL) return null;
    return structuredClone(entry.model);
  }

  async load(access: RerankAccess, signal: AbortSignal): Promise<ValidatedDecisionModel> {
    if (!access.apiKey || !access.model) throw new RerankError("unconfigured");
    // Revalidation revokes the prior assertion before any lookup or synthetic request.
    this.verified = undefined;
    let url: string | null = CATALOGUE_URL;
    const visited = new Set<string>();
    const models: DecisionModelEntry[] = [];
    while (url) {
      if (signal.aborted) throw new RerankError("cancelled");
      if (visited.has(url) || visited.size >= 20) throw new RerankError("invalid-response");
      visited.add(url);
      const page = parseDecisionModelPage(await this.read(url, access.apiKey, signal));
      models.push(...page.models);
      if (models.length > 5000) throw new RerankError("invalid-response");
      url = page.next;
    }
    if (signal.aborted) throw new RerankError("cancelled");
    return validateDecisionModel(access.model, models);
  }

  approve(access: RerankAccess, model: ValidatedDecisionModel): void {
    if (access.model !== model.requestedModel || !access.apiKey) throw new RerankError("cancelled");
    this.verified = { model: structuredClone(model), credential: credentialIdentity(access),
      credentialRevision: access.credentialRevision, modelRevision: access.modelRevision, validatedAt: this.now() };
  }
}
