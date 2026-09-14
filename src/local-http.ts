import { request } from "node:http";

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export class LocalHttpError extends Error {
  constructor(readonly status: number) { super(`Local service request failed (${status})`); }
}

export function validateLoopbackBaseUrl(baseUrl: string): URL {
  if (typeof baseUrl !== "string" || !/^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?\/?$/.test(baseUrl)) {
    throw new Error("Local service URL must use explicit HTTP loopback without credentials or a path");
  }
  const url = new URL(baseUrl);
  if (url.port && (Number(url.port) < 1 || Number(url.port) > 65535)) throw new Error("Invalid local service port");
  return url;
}

export async function localJson<T>(baseUrl: string, credential: string, path: string, method: "GET" | "POST" | "DELETE", body?: unknown): Promise<T> {
  const url = validateLoopbackBaseUrl(baseUrl);
  if (!/^\/[A-Za-z0-9/._-]+$/.test(path) || path.includes("..") || path.startsWith("//")) throw new Error("Invalid local service request path");
  if (typeof credential !== "string" || !credential || /[^\x21-\x7e]/.test(credential)) throw new Error("Invalid local service credential");
  const payload = body === undefined ? undefined : JSON.stringify(body);
  if (payload !== undefined && Buffer.byteLength(payload) > MAX_REQUEST_BYTES) throw new Error("Local service request exceeds the size limit");
  return new Promise<T>((resolve, reject) => {
    const req = request({
      hostname: url.hostname === "[::1]" ? "::1" : url.hostname,
      port: url.port || 80,
      path,
      method,
      headers: { Authorization: `Bearer ${credential}`, ...(payload === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }) },
      agent: false,
    }, (response) => {
      const status = response.statusCode ?? 0;
      // Node HTTP never follows redirects, so neither credentials nor note payloads can escape loopback.
      if (status < 200 || status >= 300) { response.destroy(); reject(new LocalHttpError(status)); return; }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) { response.destroy(); reject(new Error("Local service response exceeds the size limit")); }
        else chunks.push(chunk);
      });
      response.on("error", () => reject(new Error("Local service response failed")));
      response.on("end", () => {
        try { resolve((bytes === 0 ? undefined : JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"))) as T); }
        catch { reject(new Error("Local service returned invalid JSON")); }
      });
    });
    const deadline = setTimeout(() => req.destroy(new Error("timeout")), 120_000);
    req.on("close", () => clearTimeout(deadline));
    req.on("error", () => reject(new Error("Local service connection failed")));
    req.end(payload);
  });
}
