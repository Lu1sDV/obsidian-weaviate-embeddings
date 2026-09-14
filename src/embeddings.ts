import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_MODEL, getModelProfile, type ChunkingMode, type EmbeddingProfile } from "./embedding-config";
import type { PassageTokenRange, PreparedNote, WorkerHealth } from "./types";

const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_PENDING = 16;
type Operation = "load" | "health" | "prepare" | "embed" | "embedWindow";
type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Native embedding worker returned an invalid response");
  return value as Record<string, unknown>;
}

function validateText(text: string): number {
  if (typeof text !== "string") throw new Error("Embedding input must be text");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_TEXT_BYTES) throw new Error("Input exceeds the native embedding worker's 4 MiB text limit");
  return bytes;
}

function preparedBase(value: unknown, profile: EmbeddingProfile): Record<string, unknown> {
  const result = record(value);
  if (result.modelFingerprint !== profile.modelFingerprint || result.inputPolicyVersion !== profile.inputPolicyVersion || typeof result.tokenCount !== "number" || !Number.isSafeInteger(result.tokenCount) || result.tokenCount < 1 || result.tokenCount > 16 * 1024 * 1024) {
    throw new Error("Worker preparation identity or token count is invalid");
  }
  return result;
}

function validateSpans(value: unknown, text: string, passages: boolean): number {
  if (!Array.isArray(value) || (!passages && value.length < 1) || value.length > 4096) throw new Error("Worker returned an invalid segment count");
  let offset = 0;
  let line = 0;
  let bytes = 0;
  for (const raw of value) {
    const span = record(raw);
    if (Object.keys(span).length !== (passages ? 6 : 3)) throw new Error("Worker returned an invalid segment shape");
    if (typeof span.text !== "string" || span.start !== offset || !text.startsWith(span.text, offset) || (span.text.length === 0 && text.length !== 0)) throw new Error("Worker segmentation does not match the complete input");
    const startLine = line;
    for (let index = 0; index < span.text.length; index += 1) if (span.text.charCodeAt(index) === 10) line += 1;
    offset += span.text.length;
    const previous = text.charCodeAt(offset - 1);
    const next = text.charCodeAt(offset);
    if (span.end !== offset || (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) || (passages && (typeof span.heading !== "string" || span.heading.length > text.length || span.startLine !== startLine || span.endLine !== line))) throw new Error("Worker segment location is invalid");
    bytes += Buffer.byteLength(span.text, "utf8") + (passages ? Buffer.byteLength(span.heading as string, "utf8") : 0);
    if (bytes > MAX_RESPONSE_TEXT_BYTES) throw new Error("Worker preparation exceeds the response size limit");
  }
  if (offset !== text.length || (!passages && text.length === 0 && value.length !== 1)) throw new Error("Worker segmentation omitted input");
  return bytes;
}

function validateHealth(value: unknown, profile: EmbeddingProfile): WorkerHealth {
  const health = record(value);
  const fields = Object.entries(profile);
  if (Object.keys(health).length !== fields.length + 2 || health.ready !== true || fields.some(([key, expected]) => health[key] !== expected) || (health.device !== "webgpu" && health.device !== "wasm")) throw new Error("Native worker configuration is incompatible with the selected model; restart its embedding runtime");
  return health as unknown as WorkerHealth;
}

export function validateUnitVector(value: unknown, dimensions: number = DEFAULT_MODEL.dimensions): asserts value is number[] {
  if (!Array.isArray(value) || value.length !== dimensions) throw new Error("Local service returned an invalid vector");
  let squaredNorm = 0;
  for (const component of value) {
    if (typeof component !== "number" || !Number.isFinite(component)) throw new Error("Local service returned an invalid vector");
    squaredNorm += component * component;
  }
  if (Math.abs(Math.sqrt(squaredNorm) - 1) > 1e-4) throw new Error("Local service returned an invalid vector norm");
}

export class EmbeddingClient {
  private worker: Worker | undefined;
  private readonly objectUrls: string[] = [];
  private readonly pending = new Map<number, PendingRequest>();
  private startup: Promise<WorkerHealth> | undefined;
  private cancelStartup: ((error: Error) => void) | undefined;
  private generation = 0;
  private nextId = 0;
  private ready = false;
  private selectedProfile: EmbeddingProfile;
  private currentQuery: {
    text: string;
    generation: number;
    embedding?: Promise<{ vector: number[]; modelFingerprint: string }>;
  } | undefined;

  constructor(private readonly options: { workerPath: string; runtimeBaseUrl: string; onStatus?: (message: string) => void; device?: "auto" | "webgpu" | "wasm" }, profile: EmbeddingProfile = DEFAULT_MODEL) {
    this.selectedProfile = getModelProfile(profile.id, profile.chunkingMode);
    if (options.device !== undefined && options.device !== "auto" && options.device !== "webgpu" && options.device !== "wasm") throw new Error("Unsupported embedding device");
  }

  get profile(): EmbeddingProfile { return this.selectedProfile; }

  setModel(id: string, mode: ChunkingMode = this.profile.chunkingMode): void {
    const profile = getModelProfile(id, mode);
    if (profile === this.selectedProfile) return;
    this.stop();
    this.selectedProfile = profile;
  }

  setDevice(device: "auto" | "webgpu" | "wasm"): void {
    if (device !== "auto" && device !== "webgpu" && device !== "wasm") throw new Error("Unsupported embedding device");
    if (device === (this.options.device ?? "auto")) return;
    this.stop();
    this.options.device = device;
  }

  start(): Promise<WorkerHealth> {
    if (this.startup) return this.startup;
    if (this.ready) return this.health();
    const generation = ++this.generation;
    const cancelled = Promise.withResolvers<never>();
    this.cancelStartup = cancelled.reject;
    const startup = Promise.race([this.launch(generation, this.options.device === "wasm"), cancelled.promise]);
    this.startup = startup;
    void startup.then(() => {
      if (generation !== this.generation) return;
      this.startup = undefined;
      this.cancelStartup = undefined;
    }, (error: unknown) => {
      if (generation === this.generation) this.shutdown(error instanceof Error ? error : new Error("Native embedding startup failed; restart the runtime"));
    });
    return startup;
  }

  stop(): void {
    this.shutdown(new Error("Native embedding runtime stopped; enable semantic indexing before trying again"));
  }

  private shutdown(error: Error): void {
    this.generation += 1;
    this.ready = false;
    this.currentQuery = undefined;
    this.startup = undefined;
    this.cancelStartup?.(error);
    this.cancelStartup = undefined;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.releaseWorker();
  }

  private releaseWorker(): void {
    const worker = this.worker;
    this.worker = undefined;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    }
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls.length = 0;
  }

  private async launch(generation: number, forceWasm = false): Promise<WorkerHealth> {
    const runtimePath = join(dirname(this.options.workerPath), "runtime");
    const assets = await Promise.all([
      readFile(this.options.workerPath),
      readFile(join(runtimePath, "ort-wasm-simd-threaded.jsep.mjs")),
      readFile(join(runtimePath, "ort-wasm-simd-threaded.jsep.wasm")),
    ]).catch(() => { throw new Error("Native embedding runtime assets are missing or unreadable; reinstall the complete plugin package"); });
    if (generation !== this.generation) throw new Error("Native embedding startup was cancelled");
    const [source, moduleAsset, wasmAsset] = assets;
    if (!source.length || !moduleAsset.length || !wasmAsset.length) throw new Error("Native embedding runtime assets are empty; reinstall the complete plugin package");
    const assetUrl = (bytes: Uint8Array<ArrayBuffer>, type: string): string => {
      const url = URL.createObjectURL(new Blob([bytes], { type }));
      this.objectUrls.push(url);
      return url;
    };
    const workerUrl = assetUrl(source, "text/javascript");
    const wasmPaths = { mjs: assetUrl(moduleAsset, "application/javascript"), wasm: assetUrl(wasmAsset, "application/wasm") };
    let worker: Worker;
    try { worker = new Worker(workerUrl, { type: "module", name: "local-embeddings" }); }
    catch { throw new Error("Could not create the native embedding worker; restart Obsidian or reinstall the complete plugin package"); }
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<unknown>) => {
      if (generation !== this.generation || this.worker !== worker) return;
      this.receive(event.data);
    };
    worker.onerror = (event: ErrorEvent) => {
      if (generation !== this.generation || this.worker !== worker) return;
      event.preventDefault();
      this.shutdown(new Error("Native embedding worker failed; disable and re-enable semantic indexing, or reinstall the plugin if this persists"));
    };
    worker.onmessageerror = () => {
      if (generation === this.generation && this.worker === worker) this.shutdown(new Error("Native embedding worker could not transfer a response; disable and re-enable semantic indexing"));
    };
    let health: WorkerHealth;
    try {
      const requestedDevice = forceWasm ? "wasm" : this.options.device === "webgpu" ? "webgpu" : undefined;
      health = validateHealth(await this.request("load", { modelId: this.profile.id, chunkingMode: this.profile.chunkingMode, runtimeBaseUrl: this.options.runtimeBaseUrl, wasmPaths, ...(requestedDevice ? { device: requestedDevice } : {}) }), this.profile);
      if (requestedDevice && health.device !== requestedDevice) throw new Error(`Native worker did not honor explicit ${requestedDevice === "wasm" ? "CPU / WASM" : "WebGPU"} selection`);
    } catch (error) {
      if (!forceWasm && this.options.device !== "webgpu" && generation === this.generation && error instanceof Error && error.message.startsWith("Native embedding worker: NATIVE_WEBGPU_LOAD_FAILED:")) {
        this.releaseWorker();
        this.options.onStatus?.("WebGPU could not initialize; restarting the native worker on CPU / WASM");
        return this.launch(generation, true);
      }
      throw error;
    }
    if (generation !== this.generation) throw new Error("Native embedding startup was cancelled");
    this.ready = true;
    return health;
  }

  private receive(value: unknown): void {
    try {
      const message = record(value);
      if (message.type === "status") {
        if (Object.keys(message).length !== 2 || typeof message.message !== "string" || message.message.length > 2048) throw new Error("Invalid native worker status response");
        try { this.options.onStatus?.(message.message); } catch { /* Status rendering must not interrupt inference. */ }
        return;
      }
      const hasResult = Object.hasOwn(message, "result");
      const hasError = Object.hasOwn(message, "error");
      if (Object.keys(message).length !== 2 || !Number.isSafeInteger(message.id) || typeof message.id !== "number" || message.id < 1 || hasResult === hasError || (hasError && (typeof message.error !== "string" || message.error.length < 1 || message.error.length > 2048))) throw new Error("Invalid native worker RPC response");
      const request = this.pending.get(message.id);
      if (!request) throw new Error("Native worker response has an unknown request identity");
      clearTimeout(request.timer);
      this.pending.delete(message.id);
      if (hasError) request.reject(new Error(`Native embedding worker: ${message.error as string}`));
      else request.resolve(message.result);
    } catch {
      this.shutdown(new Error("Native embedding worker returned an invalid protocol response; disable and re-enable semantic indexing"));
    }
  }

  private request(operation: Operation, payload?: unknown): Promise<unknown> {
    const worker = this.worker;
    if (!worker || (operation !== "load" && !this.ready)) return Promise.reject(new Error("Native embedding runtime is not ready; enable semantic indexing and wait for model loading to finish"));
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new Error("Native embedding runtime is busy (16 pending requests); wait for indexing to finish and try again"));
    const id = ++this.nextId;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      this.shutdown(new Error(operation === "load" ? "Native embedding model loading timed out after 5 minutes; check model download access, then disable and re-enable semantic indexing" : "Native embedding request timed out after 120 seconds; disable and re-enable semantic indexing"));
    }, operation === "load" ? 300_000 : 120_000);
    this.pending.set(id, { resolve, reject, timer });
    try { worker.postMessage(payload === undefined ? { id, operation } : { id, operation, payload }); }
    catch { this.shutdown(new Error("Could not send input to the native embedding worker; disable and re-enable semantic indexing")); }
    return promise;
  }

  async health(): Promise<WorkerHealth> {
    const generation = this.generation;
    const health = await this.request("health");
    if (generation !== this.generation) throw new Error("Native embedding runtime stopped during its health check; enable semantic indexing again");
    try { return validateHealth(health, this.profile); }
    catch (error) {
      this.shutdown(error instanceof Error ? error : new Error("Native embedding health is invalid"));
      throw error;
    }
  }

  async prepareNote(text: string): Promise<PreparedNote> {
    validateText(text);
    const generation = this.generation;
    const response = await this.request("prepare", { kind: "note", text });
    if (generation !== this.generation) throw new Error("Native embedding runtime stopped during note preparation");
    const prepared = preparedBase(response, this.profile);
    const aligned = this.profile.id === "jinaai/jina-embeddings-v2-small-en";
    if (Object.keys(prepared).length !== (aligned ? 7 : 6)) throw new Error("Worker returned an invalid note preparation shape");
    const passages = prepared.passages;
    if (!Array.isArray(passages)) throw new Error("Worker returned invalid passages");
    // Tokenizer-erased input has no retrieval units. The worker verifies that it encodes no content tokens.
    const bytes = validateSpans(prepared.noteSegments, text, false) + (passages.length ? validateSpans(passages, text, true) : 0);
    if (passages.length === 0 && (aligned ? Number(prepared.tokenCount) !== 2 : Boolean(text.trim()))) throw new Error("Worker segmentation omitted input");
    if (bytes > MAX_RESPONSE_TEXT_BYTES) throw new Error("Worker preparation exceeds the response size limit");
    const segments = prepared.noteSegments as unknown[];
    if ((segments.length === 1 ? prepared.noteVectorMode !== "direct" : prepared.noteVectorMode !== "aggregated") || (Number(prepared.tokenCount) <= this.profile.contextLimit ? segments.length !== 1 : segments.length < 2)) throw new Error("Worker note-vector segmentation is inconsistent");
    if (aligned) {
      if (!Array.isArray(prepared.passageRanges) || prepared.passageRanges.length !== segments.length) throw new Error("Worker returned invalid contextual window ranges");
      let nextPassage = 0;
      for (const ranges of prepared.passageRanges) {
        if (!Array.isArray(ranges)) throw new Error("Worker returned invalid passage ranges");
        let nextToken = 1;
        for (const raw of ranges) {
          const range = record(raw);
          if (Object.keys(range).length !== 3 || range.passageIndex !== nextPassage || range.startToken !== nextToken || !Number.isSafeInteger(range.endToken) || Number(range.endToken) <= nextToken || Number(range.endToken) >= this.profile.contextLimit) throw new Error("Worker returned invalid contextual token ownership");
          nextToken = Number(range.endToken);
          nextPassage += 1;
        }
      }
      if (nextPassage !== passages.length) throw new Error("Worker contextual ranges omitted passages");
    }
    return prepared as unknown as PreparedNote;
  }

  async prepareQuery(text: string): Promise<{ tokenCount: number; modelFingerprint: string }> {
    validateText(text);
    const generation = this.generation;
    const response = await this.request("prepare", { kind: "query", text });
    if (generation !== this.generation) throw new Error("Native embedding runtime stopped during query preparation");
    const prepared = preparedBase(response, this.profile);
    if (Object.keys(prepared).length !== 3) throw new Error("Worker returned an invalid query preparation shape");
    if (Number(prepared.tokenCount) > this.profile.contextLimit) throw new Error(`Query exceeds the ${this.profile.contextLimit}-token model context; shorten the query without truncating a source note`);
    return { tokenCount: Number(prepared.tokenCount), modelFingerprint: this.profile.modelFingerprint };
  }

  /** Revoke the previous query before the view's input debounce expires. */
  setCurrentQuery(text: string): void {
    if (this.currentQuery?.text === text && this.currentQuery.generation === this.generation) return;
    this.currentQuery = text.trim() ? { text, generation: this.generation } : undefined;
  }

  async embedQuery(text: string): Promise<{ vector: number[]; modelFingerprint: string }> {
    this.setCurrentQuery(typeof text === "string" ? text : "");
    validateText(text);
    const current = this.currentQuery;
    if (!current) throw new Error("Enter a non-empty query to search indexed passages");
    const assertCurrent = () => {
      if (this.currentQuery !== current || current.generation !== this.generation) throw new Error("Query changed or its embedding runtime stopped");
    };
    try {
      // A cached vector never substitutes for a live, compatible runtime.
      const health = await this.health();
      assertCurrent();
      current.embedding ??= (async () => {
        const prepared = await this.prepareQuery(text);
        assertCurrent();
        if (prepared.modelFingerprint !== health.modelFingerprint) throw new Error("Query model changed");
        const [vector] = await this.embed([text], health.modelFingerprint);
        assertCurrent();
        if (!vector) throw new Error("Worker returned no query vector");
        return { vector, modelFingerprint: health.modelFingerprint };
      })();
      const result = await current.embedding;
      assertCurrent();
      if (result.modelFingerprint !== health.modelFingerprint) throw new Error("Query model changed");
      return result;
    } catch (error) {
      if (this.currentQuery === current) this.currentQuery = undefined;
      throw error;
    }
  }

  private async requestInference(operation: "embed" | "embedWindow", payload: unknown): Promise<{ value: unknown; generation: number }> {
    try {
      return { value: await this.request(operation, payload), generation: this.generation };
    } catch (error) {
      if (this.options.device !== "webgpu" || !(error instanceof Error) || !error.message.startsWith("Native embedding worker: NATIVE_WEBGPU_INFERENCE_FAILED:")) throw error;
      const expectedProfile = this.profile;
      this.options.onStatus?.("WebGPU inference failed; releasing GPU resources before one fresh WebGPU retry");
      this.shutdown(error);
      const retryGeneration = this.generation;
      // WebGPU destruction is asynchronous; an immediate worker replacement can inherit invalid buffers.
      await delay(1000);
      if (this.generation !== retryGeneration || this.options.device !== "webgpu" || this.profile !== expectedProfile) throw new Error("Native WebGPU retry was cancelled by an embedding runtime change");
      const health = await this.start();
      if (health.device !== "webgpu" || this.profile !== expectedProfile) throw new Error("Native WebGPU retry changed embedding backend or profile");
      try {
        return { value: await this.request(operation, payload), generation: this.generation };
      } catch (retryError) {
        const failure = retryError instanceof Error ? retryError : new Error("Native WebGPU inference retry failed");
        this.shutdown(failure);
        throw failure;
      }
    }
  }

  async embedWindow(text: string, passages: readonly (PassageTokenRange & { text: string })[], expectedFingerprint: string): Promise<{ noteVector: number[]; passageVectors: Array<{ passageIndex: number; vector: number[] }> }> {
    if (this.profile.chunkingMode !== "late" || expectedFingerprint !== this.profile.modelFingerprint || !Array.isArray(passages) || passages.length > 4096) throw new Error("Invalid contextual embedding identity or passage count");
    let bytes = validateText(text);
    for (const passage of passages) bytes += validateText(passage.text);
    if (bytes > MAX_TEXT_BYTES) throw new Error("Contextual embedding exceeds the 4 MiB request limit");
    const result = await this.requestInference("embedWindow", { text, passages, modelFingerprint: expectedFingerprint });
    const response = record(result.value);
    if (result.generation !== this.generation) throw new Error("Native embedding runtime stopped during contextual inference");
    if (Object.keys(response).length !== 3 || response.modelFingerprint !== expectedFingerprint || !Array.isArray(response.passageVectors) || response.passageVectors.length !== passages.length) throw new Error("Contextual response identity/cardinality mismatch");
    validateUnitVector(response.noteVector, this.profile.dimensions);
    for (let index = 0; index < passages.length; index += 1) {
      const result = record(response.passageVectors[index]);
      if (Object.keys(result).length !== 2 || result.passageIndex !== passages[index]!.passageIndex) throw new Error("Contextual response changed passage ownership");
      validateUnitVector(result.vector, this.profile.dimensions);
    }
    return response as unknown as { noteVector: number[]; passageVectors: Array<{ passageIndex: number; vector: number[] }> };
  }

  async embed(inputs: readonly string[], expectedFingerprint: string): Promise<number[][]> {
    if (expectedFingerprint !== this.profile.modelFingerprint || !Array.isArray(inputs) || inputs.length < 1 || inputs.length > 32) throw new Error("Invalid embedding identity or batch size");
    let bytes = 0;
    for (const input of inputs) bytes += validateText(input);
    if (bytes > MAX_TEXT_BYTES) throw new Error("Embedding batch exceeds the native worker's 4 MiB text limit; use smaller batches");
    const batches: readonly (readonly string[])[] = this.options.device === "webgpu" ? inputs.map(input => [input]) : [inputs];
    const vectors: number[][] = [];
    for (const batch of batches) {
      const result = await this.requestInference("embed", { input: batch });
      const response = record(result.value);
      if (result.generation !== this.generation) throw new Error("Native embedding runtime stopped during inference");
      if (Object.keys(response).length !== 2 || response.modelFingerprint !== this.profile.modelFingerprint || !Array.isArray(response.vectors) || response.vectors.length !== batch.length) throw new Error("Worker response identity/cardinality mismatch");
      for (const vector of response.vectors) {
        validateUnitVector(vector, this.profile.dimensions);
        vectors.push(vector);
      }
    }
    return vectors;
  }
}
