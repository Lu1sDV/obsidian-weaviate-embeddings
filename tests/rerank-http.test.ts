import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { createRemoteTransport, type RemoteRequest } from "../src/rerank/http";
import { LIMITS, PROVIDERS, RerankError, type Provider } from "../src/rerank/types";

function options(patch: Partial<RemoteRequest> = {}): RemoteRequest {
  return { provider: "typesafe", apiKey: "synthetic-key", body: "{}", signal: new AbortController().signal,
    deadlineAt: performance.now() + 1000, beforeSend: () => {}, ...patch };
}
function harness(status = 200, body: Buffer | null = Buffer.from("{}"), headers: Record<string, string> = {}) {
  let calls = 0, ended = false, destroyed = false;
  let captured: { url: URL; options: RequestOptions } | undefined;
  const makeRequest: NonNullable<Parameters<typeof createRemoteTransport>[0]> = (url, config, callback) => {
    calls++; captured = { url, options: config };
    const request = new EventEmitter() as EventEmitter & { end: (body: string) => void; destroy: () => void };
    request.destroy = () => { destroyed = true; };
    request.end = () => {
      ended = true;
      queueMicrotask(() => {
        const stream = new PassThrough();
        const incoming = Object.assign(stream, { statusCode: status, headers, complete: body !== null });
        callback(incoming as unknown as IncomingMessage);
        if (!stream.destroyed && body !== null) stream.end(body);
      });
    };
    return request as unknown as ClientRequest;
  };
  return { transport: createRemoteTransport(makeRequest), state: () => ({ calls, ended, destroyed, captured }) };
}
function reason(expected: string, transient?: boolean): (error: unknown) => boolean {
  return error => error instanceof RerankError && error.reason === expected && (transient === undefined || error.transient === transient);
}

test("remote transport uses only the pinned HTTPS origin/path and verified TLS", async () => {
  for (const provider of ["typesafe", "openrouter"] as const) {
    const mock = harness(); assert.equal(await mock.transport(options({ provider })), "{}");
    const captured = mock.state().captured!;
    assert.equal(captured.url.href, PROVIDERS[provider].url);
    assert.equal(captured.options.rejectUnauthorized, true); assert.equal(captured.options.minVersion, "TLSv1.2");
    assert.equal(captured.options.agent, false); assert.equal(captured.options.method, "POST");
    assert.equal((captured.options.headers as Record<string, string>).Authorization, "Bearer synthetic-key");
  }
});
test("disallowed destinations, header injection, oversized requests and expired deadlines never create HTTP", async () => {
  for (const patch of [{ provider: "arbitrary" as Provider }, { apiKey: "secret\r\nHost: attacker" },
    { body: "x".repeat(LIMITS.requestBytes + 1) }, { deadlineAt: performance.now() - 1 }]) {
    const mock = harness(); await assert.rejects(mock.transport(options(patch)), RerankError); assert.equal(mock.state().calls, 0);
  }
});
test("the final policy check occurs before end sends any payload", async () => {
  const mock = harness(); let checks = 0;
  await assert.rejects(mock.transport(options({ beforeSend: () => { if (++checks === 2) throw new RerankError("policy"); } })), reason("policy"));
  assert.equal(mock.state().calls, 1); assert.equal(mock.state().ended, false); assert.equal(mock.state().destroyed, true);
});
for (const status of [301, 302, 307, 401, 422, 429, 529]) test(`HTTP ${status} is sanitized, never redirected or retried`, async () => {
  const mock = harness(status, Buffer.from("secret provider error body"));
  await assert.rejects(mock.transport(options()), reason("provider", status === 429 || status >= 500));
  assert.equal(mock.state().calls, 1); assert.equal(mock.state().destroyed, true);
});
test("compressed, declared oversized, streamed oversized and invalid UTF-8 responses are rejected", async () => {
  for (const mock of [harness(200, Buffer.from("{}"), { "content-encoding": "gzip" }),
    harness(200, Buffer.from("{}"), { "content-length": String(LIMITS.responseBytes + 1) }),
    harness(200, Buffer.alloc(LIMITS.responseBytes + 1)), harness(200, Buffer.from([0xff, 0xfe]))]) {
    await assert.rejects(mock.transport(options()), reason("invalid-response")); assert.equal(mock.state().destroyed, true);
  }
});
test("pre-aborted and in-flight requests are physically cancelled", async () => {
  const controller = new AbortController(); controller.abort();
  const before = harness(); await assert.rejects(before.transport(options({ signal: controller.signal })), reason("cancelled")); assert.equal(before.state().calls, 0);
  const active = new AbortController(), during = harness(200, null);
  const pending = during.transport(options({ signal: active.signal })); active.abort();
  await assert.rejects(pending, reason("cancelled")); assert.equal(during.state().destroyed, true);
});
test("the absolute deadline terminates a response that never completes", async () => {
  const mock = harness(200, null);
  await assert.rejects(mock.transport(options({ deadlineAt: performance.now() + 20 })), reason("deadline"));
  assert.equal(mock.state().destroyed, true);
});
