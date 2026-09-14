import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { EmbeddingClient } from "../src/embeddings";
import { DEFAULT_MODEL, getModelProfile } from "../src/embedding-config";

type Request = { id: number; operation: string; payload?: unknown };

const healthy = { ...DEFAULT_MODEL, ready: true, device: "wasm" };

class RpcWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  failSend = false;
  readonly sent: Request[] = [];
  onrequest: ((request: Request) => void) | undefined;
  private readonly requests: Request[] = [];
  private waiting: ((request: Request) => void) | undefined;

  constructor(readonly url: string) {}

  postMessage(value: Request): void {
    if (this.failSend) throw new Error("synthetic postMessage failure");
    const request = structuredClone(value);
    this.sent.push(request);
    if (this.onrequest) { this.onrequest(request); return; }
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve(request);
    } else this.requests.push(request);
  }

  nextRequest(): Promise<Request> {
    const request = this.requests.shift();
    if (request) return Promise.resolve(request);
    const { promise, resolve } = Promise.withResolvers<Request>();
    this.waiting = resolve;
    return promise;
  }

  respond(request: Request, result: unknown): void {
    this.onmessage?.({ data: structuredClone({ id: request.id, result }) } as MessageEvent<unknown>);
  }

  terminate(): void { this.terminated = true; }
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "native-embeddings-test-"));
  const workerPath = join(directory, "embedding-worker.js");
  await mkdir(join(directory, "runtime"));
  await Promise.all([
    writeFile(workerPath, "// synthetic local worker asset"),
    writeFile(join(directory, "runtime", "ort-wasm-simd-threaded.jsep.mjs"), "// synthetic local runtime module"),
    writeFile(join(directory, "runtime", "ort-wasm-simd-threaded.jsep.wasm"), new Uint8Array([0, 97, 115, 109])),
  ]);
  const created: RpcWorker[] = [];
  const unclaimed: RpcWorker[] = [];
  let waiting: ((worker: RpcWorker) => void) | undefined;
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: class extends RpcWorker {
      constructor(url: string) {
        super(url);
        created.push(this);
        if (waiting) {
          const resolve = waiting;
          waiting = undefined;
          resolve(this);
        } else unclaimed.push(this);
      }
    },
  });
  const statuses: string[] = [];
  const client = new EmbeddingClient({ workerPath, runtimeBaseUrl: "app://obsidian/synthetic-plugin/runtime/", onStatus: (message) => { statuses.push(message); } });
  t.after(async () => {
    client.stop();
    if (originalWorker) Object.defineProperty(globalThis, "Worker", originalWorker);
    else Reflect.deleteProperty(globalThis, "Worker");
    await rm(directory, { recursive: true, force: true });
  });
  const nextWorker = (): Promise<RpcWorker> => {
    const worker = unclaimed.shift();
    if (worker) return Promise.resolve(worker);
    const { promise, resolve } = Promise.withResolvers<RpcWorker>();
    waiting = resolve;
    return promise;
  };
  const start = async (): Promise<RpcWorker> => {
    const started = client.start();
    const worker = await nextWorker();
    worker.respond(await worker.nextRequest(), healthy);
    await started;
    return worker;
  };
  return { client, created, nextWorker, start, statuses };
}

const queryUnit = [1, ...new Array<number>(DEFAULT_MODEL.dimensions - 1).fill(0)];

function answerQuery(worker: RpcWorker, request: Request, vector = queryUnit): void {
  if (request.operation === "health") worker.respond(request, healthy);
  else if (request.operation === "prepare") worker.respond(request, { tokenCount: 4, modelFingerprint: DEFAULT_MODEL.modelFingerprint, inputPolicyVersion: DEFAULT_MODEL.inputPolicyVersion });
  else if (request.operation === "embed") worker.respond(request, { vectors: [vector], modelFingerprint: DEFAULT_MODEL.modelFingerprint });
  else assert.fail(`Unexpected query operation: ${request.operation}`);
}

test("stopped embedding APIs never start or download a model", async (t) => {
  const { client, created } = await fixture(t);
  await assert.rejects(client.health(), /enable semantic indexing/);
  await assert.rejects(client.prepareNote("synthetic note"), /enable semantic indexing/);
  await assert.rejects(client.prepareQuery("synthetic query"), /enable semantic indexing/);
  await assert.rejects(client.embedQuery("synthetic query"), /enable semantic indexing/);
  await assert.rejects(client.embed(["synthetic note"], DEFAULT_MODEL.modelFingerprint), /enable semantic indexing/);
  assert.equal(created.length, 0);
});

test("startup is single-flight and stopping revokes all locally loaded runtime assets", async (t) => {
  const { client, created, nextWorker, statuses } = await fixture(t);
  const started = client.start();
  assert.equal(client.start(), started);
  const worker = await nextWorker();
  const load = await worker.nextRequest();
  const { wasmPaths } = load.payload as { wasmPaths: { wasm: string; mjs: string } };
  assert.equal(await (await fetch(worker.url)).text(), "// synthetic local worker asset");
  assert.equal(await (await fetch(wasmPaths.mjs)).text(), "// synthetic local runtime module");
  assert.deepEqual(new Uint8Array(await (await fetch(wasmPaths.wasm)).arrayBuffer()), new Uint8Array([0, 97, 115, 109]));
  worker.onmessage?.({ data: { type: "status", message: "WebGPU unavailable; loading the WASM backend" } } as MessageEvent<unknown>);
  assert.deepEqual(statuses, ["WebGPU unavailable; loading the WASM backend"]);
  await assert.rejects(client.health(), /wait for model loading/);
  worker.respond(load, healthy);
  assert.equal((await started).device, "wasm");
  assert.equal(created.length, 1);
  client.stop();
  assert.equal(worker.terminated, true);
  await Promise.all([worker.url, wasmPaths.mjs, wasmPaths.wasm].map((url) => assert.rejects(fetch(url))));
});

test("failed WebGPU initialization retries once in a fresh WASM worker", async (t) => {
  const { client, nextWorker } = await fixture(t);
  const started = client.start();
  const gpu = await nextWorker();
  const load = await gpu.nextRequest();
  gpu.onmessage?.({ data: { id: load.id, error: "NATIVE_WEBGPU_LOAD_FAILED: adapter unavailable" } } as MessageEvent<unknown>);
  const cpu = await nextWorker();
  assert.equal(gpu.terminated, true);
  await assert.rejects(fetch(gpu.url));
  const retry = await cpu.nextRequest();
  assert.ok(retry.payload && typeof retry.payload === "object" && "device" in retry.payload);
  assert.equal(retry.payload.device, "wasm");
  cpu.respond(retry, healthy);
  assert.equal((await started).device, "wasm");
  const prepared = client.prepareQuery("complete synthetic query");
  cpu.respond(await cpu.nextRequest(), { tokenCount: 5, modelFingerprint: DEFAULT_MODEL.modelFingerprint, inputPolicyVersion: DEFAULT_MODEL.inputPolicyVersion });
  assert.equal((await prepared).tokenCount, 5);
});

test("stop cancels both asset-loading startup and active model loading without poisoning restart", async (t) => {
  const { client, nextWorker, start, created } = await fixture(t);
  const first = client.start();
  const firstRejected = assert.rejects(first, /stopped/);
  client.stop();
  await firstRejected;
  const second = client.start();
  const secondRejected = assert.rejects(second, /stopped/);
  const loadingWorker = await nextWorker();
  await loadingWorker.nextRequest();
  client.stop();
  await secondRejected;
  assert.equal(loadingWorker.terminated, true);
  const worker = await start();
  assert.notEqual(worker, loadingWorker);
  assert.equal(created.length, 2);
});

test("bounded outstanding RPCs reject on stop and an old worker cannot complete a restarted request", async (t) => {
  const { client, start } = await fixture(t);
  const worker = await start();
  const pending = Array.from({ length: 16 }, () => client.prepareQuery("synthetic query"));
  const rejected = pending.map((promise) => assert.rejects(promise, /stopped/));
  const oldRequest = await worker.nextRequest();
  const oldReceiver = worker.onmessage;
  await assert.rejects(client.health(), /busy/);
  client.stop();
  await Promise.all(rejected);
  assert.equal(worker.terminated, true);
  const restarted = await start();
  const query = client.prepareQuery("new query");
  const newRequest = await restarted.nextRequest();
  oldReceiver?.({ data: { id: oldRequest.id, result: { tokenCount: 999, modelFingerprint: DEFAULT_MODEL.modelFingerprint, inputPolicyVersion: DEFAULT_MODEL.inputPolicyVersion } } } as MessageEvent<unknown>);
  restarted.respond(newRequest, { tokenCount: 4, modelFingerprint: DEFAULT_MODEL.modelFingerprint, inputPolicyVersion: DEFAULT_MODEL.inputPolicyVersion });
  assert.equal((await query).tokenCount, 4);
});

test("startup and inference timeouts terminate hung workers and reject outstanding work", async (t) => {
  const { client, nextWorker, start } = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const started = client.start();
  const loadingRejected = assert.rejects(started, /loading timed out.*download access/);
  const loadingWorker = await nextWorker();
  await loadingWorker.nextRequest();
  t.mock.timers.tick(300_000);
  await loadingRejected;
  assert.equal(loadingWorker.terminated, true);
  const worker = await start();
  const query = client.prepareQuery("synthetic query");
  const queryRejected = assert.rejects(query, /timed out.*disable and re-enable semantic indexing/);
  await worker.nextRequest();
  t.mock.timers.tick(120_000);
  await queryRejected;
  assert.equal(worker.terminated, true);
  await assert.rejects(client.health(), /not ready/);
});

test("postMessage failures reject existing work rather than leaving a live orphan worker", async (t) => {
  const { client, start } = await fixture(t);
  const worker = await start();
  const active = client.prepareQuery("synthetic query");
  const activeRejected = assert.rejects(active, /Could not send input/);
  worker.failSend = true;
  await assert.rejects(client.health(), /Could not send input/);
  await activeRejected;
  assert.equal(worker.terminated, true);
});

for (const failure of ["worker error", "message error", "foreign id", "ambiguous envelope"] as const) {
  test(`${failure} cancels all in-flight native RPCs`, async (t) => {
    const { client, start } = await fixture(t);
    const worker = await start();
    const query = client.prepareQuery("synthetic query");
    const rejected = assert.rejects(query, /disable and re-enable semantic indexing/i);
    const request = await worker.nextRequest();
    if (failure === "worker error") worker.onerror?.({ preventDefault() {} } as ErrorEvent);
    else if (failure === "message error") worker.onmessageerror?.();
    else worker.onmessage?.({ data: failure === "foreign id" ? { id: request.id + 1, result: {} } : { id: request.id, result: {}, error: "ambiguous" } } as MessageEvent<unknown>);
    await rejected;
    assert.equal(worker.terminated, true);
    await assert.rejects(client.health(), /not ready/);
  });
}

test("incompatible model identity cannot become ready or survive a health check", async (t) => {
  const { client, nextWorker, start } = await fixture(t);
  const started = client.start();
  const rejected = assert.rejects(started, /incompatible/);
  const worker = await nextWorker();
  worker.respond(await worker.nextRequest(), { ...healthy, modelFingerprint: "python-input-policy-2" });
  await rejected;
  assert.equal(worker.terminated, true);
  const restarted = await start();
  const health = client.health();
  const unhealthy = assert.rejects(health, /incompatible/);
  restarted.respond(await restarted.nextRequest(), { ...healthy, device: "cpu" });
  await unhealthy;
  assert.equal(restarted.terminated, true);
});

test("preparation accepts complete UTF16 locations and rejects foreign identity or damaged coverage", async (t) => {
  const { client, start } = await fixture(t);
  const worker = await start();
  const text = "A😀\nB";
  const prepared = {
    tokenCount: 5, modelFingerprint: DEFAULT_MODEL.modelFingerprint, inputPolicyVersion: DEFAULT_MODEL.inputPolicyVersion, noteVectorMode: "direct",
    noteSegments: [{ text, start: 0, end: 5 }],
    passages: [{ text: "A😀\n", heading: "", start: 0, end: 4, startLine: 0, endLine: 1 }, { text: "B", heading: "", start: 4, end: 5, startLine: 1, endLine: 1 }],
  };
  const complete = client.prepareNote(text);
  worker.respond(await worker.nextRequest(), prepared);
  const accepted = await complete;
  assert.equal(text.slice(accepted.passages[1]!.start, accepted.passages[1]!.end), "B");
  for (const [payload, error] of [
    [{ ...prepared, modelFingerprint: "foreign-model" }, /identity/],
    [{ ...prepared, inputPolicyVersion: 2 }, /identity/],
    [{ ...prepared, passages: prepared.passages.slice(0, 1) }, /omitted/],
    [{ ...prepared, noteSegments: [{ text, start: 0, end: 4 }] }, /location/],
    [{ ...prepared, passages: [{ ...prepared.passages[0], endLine: 0 }, prepared.passages[1]] }, /location/],
    [{ ...prepared, noteVectorMode: "aggregated" }, /inconsistent/],
    [{ ...prepared, passages: [{ text: "A\ud83d", heading: "", start: 0, end: 2, startLine: 0, endLine: 0 }, { text: "\ude00\nB", heading: "", start: 2, end: 5, startLine: 0, endLine: 1 }] }, /location/],
  ] as const) {
    const result = client.prepareNote(text);
    const rejected = assert.rejects(result, error);
    worker.respond(await worker.nextRequest(), payload);
    await rejected;
  }
});

test("embedding responses reject cardinality, fingerprint and malformed vector norms", async (t) => {
  const { client, start } = await fixture(t);
  const worker = await start();
  const unit = [1, ...new Array<number>(DEFAULT_MODEL.dimensions - 1).fill(0)];
  for (const [payload, error] of [
    [{ vectors: [], modelFingerprint: DEFAULT_MODEL.modelFingerprint }, /cardinality/],
    [{ vectors: [unit], modelFingerprint: "foreign-model" }, /identity/],
    [{ vectors: [[1]], modelFingerprint: DEFAULT_MODEL.modelFingerprint }, /invalid vector/],
    [{ vectors: [unit.map((value) => value * 2)], modelFingerprint: DEFAULT_MODEL.modelFingerprint }, /norm/],
    [{ vectors: [[NaN, ...unit.slice(1)]], modelFingerprint: DEFAULT_MODEL.modelFingerprint }, /invalid vector/],
  ] as const) {
    const result = client.embed(["synthetic note"], DEFAULT_MODEL.modelFingerprint);
    const rejected = assert.rejects(result, error);
    worker.respond(await worker.nextRequest(), payload);
    await rejected;
  }
});

test("oversize queries are rejected with an actionable error instead of accepted truncation", async (t) => {
  const { client, start } = await fixture(t);
  const worker = await start();
  const query = client.prepareQuery("synthetic oversize query");
  const rejected = assert.rejects(query, /32768-token.*shorten/);
  worker.respond(await worker.nextRequest(), { tokenCount: DEFAULT_MODEL.contextLimit + 1, modelFingerprint: DEFAULT_MODEL.modelFingerprint, inputPolicyVersion: DEFAULT_MODEL.inputPolicyVersion });
  await rejected;
});

test("current queries share inference but always check runtime health and never retain query history", async (t) => {
  const { client, start } = await fixture(t);
  const worker = await start();
  let vector = queryUnit;
  worker.onrequest = (request) => answerQuery(worker, request, vector);
  const [first, concurrent] = await Promise.all([client.embedQuery("first query"), client.embedQuery("first query")]);
  assert.deepEqual(first.vector, queryUnit);
  assert.deepEqual(concurrent.vector, queryUnit);
  assert.deepEqual((await client.embedQuery("first query")).vector, queryUnit);
  assert.equal(worker.sent.filter(({ operation }) => operation === "health").length, 3);
  assert.equal(worker.sent.filter(({ operation }) => operation === "prepare").length, 1);
  assert.equal(worker.sent.filter(({ operation }) => operation === "embed").length, 1);

  vector = queryUnit.map((component) => -component);
  assert.deepEqual((await client.embedQuery("changed query")).vector, vector);
  assert.deepEqual((await client.embedQuery("first query")).vector, vector);
  assert.equal(worker.sent.filter(({ operation }) => operation === "prepare").length, 3);
  assert.equal(worker.sent.filter(({ operation }) => operation === "embed").length, 3);
});

test("stop and worker failure discard cached query vectors across runtime restarts", async (t) => {
  const { client, start } = await fixture(t);
  const worker = await start();
  worker.onrequest = (request) => answerQuery(worker, request);
  await client.embedQuery("synthetic query");
  client.stop();
  await assert.rejects(client.embedQuery("synthetic query"), /not ready/);

  const restarted = await start();
  const nextVector = queryUnit.map((component) => -component);
  restarted.onrequest = (request) => answerQuery(restarted, request, nextVector);
  assert.deepEqual((await client.embedQuery("synthetic query")).vector, nextVector);
  assert.equal(restarted.sent.filter(({ operation }) => operation === "embed").length, 1);
  restarted.onerror?.({ preventDefault() {} } as ErrorEvent);
  await assert.rejects(client.embedQuery("synthetic query"), /not ready/);

  const recovered = await start();
  recovered.onrequest = (request) => answerQuery(recovered, request);
  assert.deepEqual((await client.embedQuery("synthetic query")).vector, queryUnit);
  assert.equal(recovered.sent.filter(({ operation }) => operation === "embed").length, 1);
});

test("a query changed during debounce cannot repopulate the cache even when its text returns", async (t) => {
  const { client, start } = await fixture(t);
  const worker = await start();
  const held = Promise.withResolvers<Request>();
  worker.onrequest = (request) => {
    if (request.operation === "embed") held.resolve(request);
    else answerQuery(worker, request);
  };
  const stale = client.embedQuery("same query");
  const rejected = assert.rejects(stale, /Query changed/);
  const oldRequest = await held.promise;
  client.setCurrentQuery("edited but still debounced");
  const nextVector = queryUnit.map((component) => -component);
  worker.onrequest = (request) => answerQuery(worker, request, nextVector);
  assert.deepEqual((await client.embedQuery("same query")).vector, nextVector);
  worker.respond(oldRequest, { vectors: [queryUnit], modelFingerprint: DEFAULT_MODEL.modelFingerprint });
  await rejected;
  assert.deepEqual((await client.embedQuery("same query")).vector, nextVector);
  assert.equal(worker.sent.filter(({ operation }) => operation === "embed").length, 2);
});

test("failed superseded queries cannot evict the latest successfully validated vector", async (t) => {
  const { client, start } = await fixture(t);
  const worker = await start();
  const held = Promise.withResolvers<Request>();
  worker.onrequest = (request) => {
    if (request.operation === "embed") held.resolve(request);
    else answerQuery(worker, request);
  };
  const stale = client.embedQuery("failing old query");
  const rejected = assert.rejects(stale, /synthetic inference failure/);
  const oldRequest = await held.promise;
  worker.onrequest = (request) => answerQuery(worker, request);
  await client.embedQuery("latest query");
  worker.onmessage?.({ data: { id: oldRequest.id, error: "synthetic inference failure" } } as MessageEvent<unknown>);
  await rejected;
  assert.deepEqual((await client.embedQuery("latest query")).vector, queryUnit);
  assert.equal(worker.sent.filter(({ operation }) => operation === "embed").length, 2);
});

test("empty input revokes both cached vectors and in-flight query preparation", async (t) => {
  const { client, start } = await fixture(t);
  const worker = await start();
  worker.onrequest = (request) => answerQuery(worker, request);
  await client.embedQuery("synthetic query");
  await assert.rejects(client.embedQuery(""), /non-empty query/);
  await client.embedQuery("synthetic query");
  assert.equal(worker.sent.filter(({ operation }) => operation === "embed").length, 2);

  const held = Promise.withResolvers<Request>();
  worker.onrequest = (request) => {
    if (request.operation === "prepare") held.resolve(request);
    else answerQuery(worker, request);
  };
  const stale = client.embedQuery("pending query");
  const rejected = assert.rejects(stale, /Query changed/);
  const preparation = await held.promise;
  client.setCurrentQuery(" \n");
  answerQuery(worker, preparation);
  await rejected;
  assert.equal(worker.sent.filter(({ operation }) => operation === "embed").length, 2);
  worker.onrequest = (request) => answerQuery(worker, request);
  await client.embedQuery("pending query");
  assert.equal(worker.sent.filter(({ operation }) => operation === "embed").length, 3);
});

test("query reuse rejects incompatible health and never caches failed vector validation", async (t) => {
  const { client, start } = await fixture(t);
  const worker = await start();
  worker.onrequest = (request) => answerQuery(worker, request, [1]);
  await assert.rejects(client.embedQuery("synthetic query"), /invalid vector/);
  worker.onrequest = (request) => answerQuery(worker, request);
  assert.deepEqual((await client.embedQuery("synthetic query")).vector, queryUnit);
  assert.equal(worker.sent.filter(({ operation }) => operation === "embed").length, 2);
  worker.onrequest = (request) => worker.respond(request, { ...healthy, modelFingerprint: "foreign-model" });
  await assert.rejects(client.embedQuery("synthetic query"), /incompatible/);
  assert.equal(worker.terminated, true);
  await assert.rejects(client.embedQuery("synthetic query"), /not ready/);
});

test("model switching cancels work, discards cached queries, and rejects the previous model's identity", async (t) => {
  const { client, start, nextWorker, created } = await fixture(t);
  const worker = await start();
  worker.onrequest = (request) => answerQuery(worker, request);
  await client.embedQuery("same query");
  worker.onrequest = undefined;
  const pending = client.prepareQuery("pending query");
  const cancelled = assert.rejects(pending, /stopped/);
  const oldRequest = await worker.nextRequest();
  const oldReceiver = worker.onmessage;
  const profile = getModelProfile("Xenova/all-MiniLM-L6-v2");
  client.setModel(profile.id);
  await cancelled;
  assert.equal(worker.terminated, true);
  await assert.rejects(client.embedQuery("same query"), /not ready/);
  assert.equal(created.length, 1);

  const starting = client.start();
  const next = await nextWorker();
  next.respond(await next.nextRequest(), { ...profile, ready: true, device: "wasm" });
  assert.equal((await starting).modelFingerprint, profile.modelFingerprint);
  const query = client.prepareQuery("same query");
  const request = await next.nextRequest();
  oldReceiver?.({ data: { id: oldRequest.id, result: { tokenCount: 999, modelFingerprint: DEFAULT_MODEL.modelFingerprint, inputPolicyVersion: DEFAULT_MODEL.inputPolicyVersion } } } as MessageEvent<unknown>);
  next.respond(request, { tokenCount: 4, modelFingerprint: profile.modelFingerprint, inputPolicyVersion: profile.inputPolicyVersion });
  assert.equal((await query).modelFingerprint, profile.modelFingerprint);

  const foreign = client.embed(["same query"], profile.modelFingerprint);
  const rejected = assert.rejects(foreign, /identity/);
  next.respond(await next.nextRequest(), { vectors: [queryUnit], modelFingerprint: DEFAULT_MODEL.modelFingerprint });
  await rejected;
  await assert.rejects(client.embed(["same query"], DEFAULT_MODEL.modelFingerprint), /identity/);
  next.onrequest = (request) => {
    if (request.operation === "health") next.respond(request, { ...profile, ready: true, device: "wasm" });
    else if (request.operation === "prepare") next.respond(request, { tokenCount: 4, modelFingerprint: profile.modelFingerprint, inputPolicyVersion: profile.inputPolicyVersion });
    else next.respond(request, { vectors: [queryUnit.map((value) => -value)], modelFingerprint: profile.modelFingerprint });
  };
  assert.deepEqual((await client.embedQuery("same query")).vector, queryUnit.map((value) => -value));
  assert.throws(() => client.setModel("unsupported/model"), /Unsupported/);
  assert.equal(client.profile.id, profile.id);
  assert.deepEqual((await client.embedQuery("same query")).vector, queryUnit.map((value) => -value));
});

test("switching away and back rejects an already-delivered response from the old runtime", async (t) => {
  const { client, start } = await fixture(t);
  const worker = await start();
  const prepared = client.prepareQuery("old query");
  const rejected = assert.rejects(prepared, /stopped/);
  worker.respond(await worker.nextRequest(), { tokenCount: 4, modelFingerprint: DEFAULT_MODEL.modelFingerprint, inputPolicyVersion: DEFAULT_MODEL.inputPolicyVersion });
  client.setModel("Xenova/all-MiniLM-L6-v2");
  client.setModel(DEFAULT_MODEL.id);
  await rejected;
});

test("explicit CPU selection refuses a GPU runtime and cancels work on device changes", async (t) => {
  const { client, nextWorker } = await fixture(t);
  client.setDevice("wasm");
  const started = client.start();
  const rejected = assert.rejects(started, /CPU.*WASM/);
  const worker = await nextWorker();
  worker.respond(await worker.nextRequest(), { ...healthy, device: "webgpu" });
  await rejected;
  assert.equal(worker.terminated, true);
  const restarting = client.start();
  const cpu = await nextWorker();
  cpu.respond(await cpu.nextRequest(), healthy);
  assert.equal((await restarting).device, "wasm");
  const query = client.prepareQuery("pending query");
  const cancelled = assert.rejects(query, /stopped/);
  await cpu.nextRequest();
  client.setDevice("auto");
  await cancelled;
  assert.equal(cpu.terminated, true);
});

test("explicit WebGPU selection is verified and never falls back to WASM", async (t) => {
  const { client, nextWorker } = await fixture(t);
  client.setDevice("webgpu");
  const started = client.start();
  const rejected = assert.rejects(started, /NATIVE_WEBGPU_LOAD_FAILED/);
  const first = await nextWorker();
  const load = await first.nextRequest();
  assert.ok(load.payload && typeof load.payload === "object" && "device" in load.payload);
  assert.equal(load.payload.device, "webgpu");
  first.onmessage?.({ data: { id: load.id, error: "NATIVE_WEBGPU_LOAD_FAILED: adapter unavailable" } } as MessageEvent<unknown>);
  await rejected;
  assert.equal(first.terminated, true);
  const retry = client.start();
  const second = await nextWorker();
  second.respond(await second.nextRequest(), { ...healthy, device: "webgpu" });
  assert.equal((await retry).device, "webgpu");
  const retryPayload = second.sent[0]?.payload;
  assert.ok(retryPayload && typeof retryPayload === "object" && "device" in retryPayload);
  assert.equal(retryPayload.device, "webgpu");
});

test("Late responses cannot assign a passage another range's vector or reuse a Standard identity", async (t) => {
  const { client, nextWorker } = await fixture(t);

  const profile = getModelProfile("jinaai/jina-embeddings-v2-small-en", "late");
  client.setModel(profile.id, "late");
  const started = client.start();
  const worker = await nextWorker();
  worker.respond(await worker.nextRequest(), { ...profile, ready: true, device: "wasm" });
  await started;
  const vector = [1, ...Array<number>(511).fill(0)];
  const passages = [{ passageIndex: 4, text: "body", startToken: 1, endToken: 2 }];
  const operation = client.embedWindow("body", passages, profile.modelFingerprint);
  const rejected = assert.rejects(operation, /ownership/);
  worker.respond(await worker.nextRequest(), { modelFingerprint: profile.modelFingerprint, noteVector: vector, passageVectors: [{ passageIndex: 3, vector }] });
  await rejected;
  await assert.rejects(client.embedWindow("body", passages, getModelProfile(profile.id).modelFingerprint), /identity/);
  const result = client.embedWindow("body", passages, profile.modelFingerprint);
  worker.respond(await worker.nextRequest(), { modelFingerprint: profile.modelFingerprint, noteVector: vector, passageVectors: [{ passageIndex: 4, vector }] });
  assert.deepEqual((await result).passageVectors, [{ passageIndex: 4, vector }]);
  assert.throws(() => client.setModel(DEFAULT_MODEL.id), /Jina/);
  assert.equal(client.profile, profile);
});

test("WebGPU inference retries once in a fresh WebGPU worker without changing backend", async (t) => {
  const { client, nextWorker, statuses } = await fixture(t);
  client.setDevice("webgpu");
  const started = client.start();
  const first = await nextWorker();
  first.respond(await first.nextRequest(), { ...healthy, device: "webgpu" });
  await started;
  const embedding = client.embed(["recover this batch"], DEFAULT_MODEL.modelFingerprint);
  const failed = await first.nextRequest();
  first.onmessage?.({ data: { id: failed.id, error: "NATIVE_WEBGPU_INFERENCE_FAILED: invalid buffer" } } as MessageEvent<unknown>);
  const second = await nextWorker();
  const load = await second.nextRequest();
  assert.ok(load.payload && typeof load.payload === "object" && "device" in load.payload);
  assert.equal(load.payload.device, "webgpu");
  second.respond(load, { ...healthy, device: "webgpu" });
  const retry = await second.nextRequest();
  assert.equal(retry.operation, "embed");
  second.respond(retry, { modelFingerprint: DEFAULT_MODEL.modelFingerprint, vectors: [queryUnit] });
  assert.deepEqual(await embedding, [queryUnit]);
  assert.equal(first.terminated, true);
  assert.ok(statuses.includes("WebGPU inference failed; releasing GPU resources before one fresh WebGPU retry"));
});

test("a device change during WebGPU cooldown cancels the stale retry", async (t) => {
  const { client, nextWorker, created } = await fixture(t);
  client.setDevice("webgpu");
  const started = client.start();
  const worker = await nextWorker();
  worker.respond(await worker.nextRequest(), { ...healthy, device: "webgpu" });
  await started;
  const embedding = client.embed(["stale batch"], DEFAULT_MODEL.modelFingerprint);
  const rejected = assert.rejects(embedding, /retry was cancelled/);
  const failed = await worker.nextRequest();
  worker.onmessage?.({ data: { id: failed.id, error: "NATIVE_WEBGPU_INFERENCE_FAILED: invalid buffer" } } as MessageEvent<unknown>);
  await Promise.resolve();
  client.setDevice("wasm");
  await rejected;
  assert.equal(created.length, 1);
  assert.equal(client.profile, DEFAULT_MODEL);
});

test("explicit WebGPU isolates independently embedded inputs into separate RPCs", async (t) => {
  const { client, nextWorker } = await fixture(t);
  client.setDevice("webgpu");
  const started = client.start();
  const worker = await nextWorker();
  worker.respond(await worker.nextRequest(), { ...healthy, device: "webgpu" });
  await started;
  const embedding = client.embed(["first", "second"], DEFAULT_MODEL.modelFingerprint);
  for (const expected of ["first", "second"]) {
    const request = await worker.nextRequest();
    assert.ok(request.payload && typeof request.payload === "object" && "input" in request.payload);
    assert.deepEqual(request.payload.input, [expected]);
    worker.respond(request, { modelFingerprint: DEFAULT_MODEL.modelFingerprint, vectors: [queryUnit] });
  }
  assert.deepEqual(await embedding, [queryUnit, queryUnit]);
});
