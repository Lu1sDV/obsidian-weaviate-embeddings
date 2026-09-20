import { request } from "node:https";
import { JEV_ENDPOINT, MAX_REQUEST_BYTES, RerankingCancelledError, RerankingError, type JevRequest } from "./jev-protocol";

export type DecisionTransport = (body: JevRequest, apiKey: string, signal: AbortSignal) => Promise<unknown>;
const MAX_RESPONSE_BYTES = 128_000;

/** Desktop-only plugin: Node HTTPS bypasses renderer CORS and supports real cancellation. */
export function createJevTransport(requestImpl: typeof request = request): DecisionTransport {
  return (body, apiKey, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new RerankingCancelledError()); return; }
    const payload = JSON.stringify(body);
    if (Buffer.byteLength(payload) > MAX_REQUEST_BYTES) { reject(new RerankingError("input")); return; }
    let settled = false;
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(result);
    };
    // There is intentionally no configurable URL and no redirect following: never forward a key to another host.
    const req = requestImpl(JEV_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    }, response => {
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        finish(new RerankingError(status === 401 || status === 403 ? "authentication" : status === 402 ? "credits" : status === 429 ? "rate-limit" : "http"));
        response.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          finish(new RerankingError("response"));
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", () => finish(new RerankingError("network")));
      response.on("aborted", () => finish(new RerankingError("network")));
      response.on("end", () => {
        if (settled) return;
        try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { finish(new RerankingError("response")); }
      });
    });
    const abort = () => {
      finish(new RerankingCancelledError());
      req.destroy();
    };
    req.on("error", () => finish(new RerankingError("network")));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else req.end(payload);
  });
}

export const postJevDecisions = createJevTransport();
