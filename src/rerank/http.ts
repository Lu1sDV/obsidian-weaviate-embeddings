import { request, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { LIMITS, PROVIDERS, RerankError, type Provider } from "./types";

export interface RemoteRequest {
  provider: Provider; apiKey: string; body: string; signal: AbortSignal;
  deadlineAt: number; beforeSend: () => void;
}
export type RemoteTransport = (options: RemoteRequest) => Promise<string>;
type RequestFactory = (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;

/** Separate from loopback HTTP. Fixed HTTPS destinations, no redirects, no provider body in errors. */
export function createRemoteTransport(makeRequest: RequestFactory = request): RemoteTransport {
  return ({ provider, apiKey, body, signal, deadlineAt, beforeSend }) => new Promise((resolve, reject) => {
    let req: ClientRequest | undefined, response: IncomingMessage | undefined;
    let done = false, timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: RerankError, text?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) { response?.destroy(); req?.destroy(); reject(error); }
      else resolve(text!);
    };
    const abort = () => finish(signal.reason instanceof RerankError ? signal.reason : new RerankError("cancelled"));
    try {
      if (signal.aborted) { abort(); return; }
      const remaining = deadlineAt - performance.now();
      if (!(remaining > 0)) throw new RerankError("deadline");
      if (!Object.hasOwn(PROVIDERS, provider) || !/^[\x21-\x7e]{1,4096}$/.test(apiKey)) throw new RerankError("unconfigured");
      if (Buffer.byteLength(body) > LIMITS.requestBytes) throw new RerankError("budget");
      beforeSend();
      timer = setTimeout(() => finish(new RerankError("deadline")), remaining);
      signal.addEventListener("abort", abort, { once: true });
      req = makeRequest(new URL(PROVIDERS[provider].url), {
        method: "POST", agent: false, rejectUnauthorized: true, minVersion: "TLSv1.2",
        maxHeaderSize: 16_384,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json",
          "Accept-Encoding": "identity", "Content-Length": Buffer.byteLength(body) },
      }, incoming => {
        response = incoming;
        incoming.on("error", () => finish(new RerankError("provider", true)));
        if (done) { incoming.destroy(); return; }
        const status = incoming.statusCode ?? 0;
        if (status !== 200) {
          finish(new RerankError("provider", status === 429 || status >= 500)); return;
        }
        const encoding = incoming.headers["content-encoding"];
        const length = incoming.headers["content-length"];
        if ((encoding && encoding !== "identity") || (length !== undefined && (!/^\d+$/.test(length) || Number(length) > LIMITS.responseBytes))) {
          finish(new RerankError("invalid-response")); return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        incoming.on("data", (chunk: Buffer) => {
          if (done) return;
          bytes += chunk.length;
          if (bytes > LIMITS.responseBytes) { finish(new RerankError("invalid-response")); return; }
          chunks.push(chunk);
        });
        incoming.on("aborted", () => finish(new RerankError("provider", true)));
        incoming.on("end", () => {
          if (!incoming.complete) { finish(new RerankError("provider", true)); return; }
          try {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
            finish(undefined, text);
          } catch { finish(new RerankError("invalid-response")); }
        });
      });
      req.on("error", () => finish(new RerankError("provider", true)));
      if (done) { req.destroy(); return; }
      // The application queue and this last synchronous guard both precede transmission.
      if (signal.aborted) { abort(); return; }
      beforeSend();
      req.end(body);
    } catch (error) { finish(error instanceof RerankError ? error : new RerankError("provider")); }
  });
}
