import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ClientRequest, RequestOptions } from "node:http";
import type { request } from "node:https";
import test from "node:test";
import { createJevTransport } from "../src/jev-http";
import { buildJevBatches, JEV_ENDPOINT, RerankingCancelledError, RerankingError } from "../src/jev-protocol";

const body = buildJevBatches("query", [{ title: "Note", passages: [{ heading: "Heading", body: "Text" }] }])[0]!;
function fakeRequest(status: number, payload: string, hang = false) {
  let destroyed = false;
  let calls = 0;
  let sent = "";
  let url: unknown;
  let headers: RequestOptions["headers"];
  const impl = ((target: unknown, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    calls++;
    url = target;
    headers = options.headers;
    const req = new EventEmitter() as EventEmitter & { end: (data: string) => void; destroy: () => void };
    req.destroy = () => { destroyed = true; };
    req.end = data => {
      sent = data;
      if (hang) return;
      queueMicrotask(() => {
        const response = new EventEmitter() as EventEmitter & { statusCode: number; destroy: () => void };
        response.statusCode = status;
        response.destroy = () => { destroyed = true; };
        callback(response as unknown as IncomingMessage);
        if (!destroyed) {
          response.emit("data", Buffer.from(payload));
          response.emit("end");
        }
      });
    };
    return req as unknown as ClientRequest;
  }) as typeof request;
  return { impl, state: () => ({ destroyed, calls, sent, url, headers }) };
}

test("HTTPS transport sends native JSON to the fixed OpenRouter endpoint with bearer authentication", async () => {
  const wire = { answers: { candidate_0: { type: "noul", noul: 0.8 } } };
  const fake = fakeRequest(200, JSON.stringify(wire));
  const result = await createJevTransport(fake.impl)(body, "test-key", new AbortController().signal);
  assert.deepEqual(result, wire);
  assert.equal(fake.state().url, JEV_ENDPOINT);
  assert.deepEqual(JSON.parse(fake.state().sent), body);
  assert.equal((fake.state().headers as Record<string, unknown>).Authorization, "Bearer test-key");
  assert.equal((fake.state().headers as Record<string, unknown>)["Content-Length"], Buffer.byteLength(fake.state().sent));
});

for (const [status, code] of [[401, "authentication"], [403, "authentication"], [402, "credits"], [429, "rate-limit"], [500, "http"], [302, "http"]] as const) {
  test(`HTTP ${status} produces a safe error and never follows redirects`, async () => {
    const fake = fakeRequest(status, "SECRET NOTE test-key");
    await assert.rejects(createJevTransport(fake.impl)(body, "test-key", new AbortController().signal), error => {
      assert.ok(error instanceof RerankingError);
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /SECRET|test-key/);
      return true;
    });
    assert.equal(fake.state().calls, 1);
    assert.equal(fake.state().destroyed, true);
  });
}

test("malformed and oversized response bodies are rejected", async () => {
  for (const payload of ["```json\n{}\n```", "x".repeat(128_001)]) {
    const fake = fakeRequest(200, payload);
    await assert.rejects(createJevTransport(fake.impl)(body, "test-key", new AbortController().signal), error => error instanceof RerankingError && error.code === "response");
  }
});

test("aborting destroys the active HTTPS request", async () => {
  const fake = fakeRequest(200, "", true);
  const controller = new AbortController();
  const result = createJevTransport(fake.impl)(body, "test-key", controller.signal);
  controller.abort();
  await assert.rejects(result, RerankingCancelledError);
  assert.equal(fake.state().destroyed, true);
});

test("a pre-aborted transport makes no request", async () => {
  const fake = fakeRequest(200, "{}");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createJevTransport(fake.impl)(body, "test-key", controller.signal), RerankingCancelledError);
  assert.equal(fake.state().calls, 0);
});
