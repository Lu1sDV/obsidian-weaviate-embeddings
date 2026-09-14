import type { PreTrainedModel, PreTrainedTokenizer, Tensor } from "@huggingface/transformers";
import { DEFAULT_MODEL, getModelProfile } from "./embedding-config";
import { MAX_TEXT_BYTES, PASSAGE_TOKENS, prepareEmbeddingBatch, prepareInput, validateText } from "./embedding-preparation";
import type { PassageTokenRange } from "./types";
import { poolTokenRange } from "./vectors";

type Request = { id: number; operation: "load" | "health" | "prepare" | "embed" | "embedWindow" | "dispose"; payload?: unknown };
const scope = globalThis as unknown as {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
};
let tokenizer: PreTrainedTokenizer | undefined;
let jinaSpecialTokens: number[] | undefined;
let model: PreTrainedModel | undefined;
let device: "webgpu" | "wasm" | undefined;
let profile = DEFAULT_MODEL;
let ready = false;
let pending = 0;
let queue = Promise.resolve();

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native worker request");
  return value as Record<string, unknown>;
}
function status(message: string): void { scope.postMessage({ type: "status", message }); }
function health() { return { ...profile, ready, device }; }
function requireReady(): void {
  if (!ready || !model || !tokenizer) throw new Error("Native embedding model is not ready; disable and re-enable semantic indexing");
}
function countTokens(text: string): number {
  if (!tokenizer) throw new Error("Native tokenizer is not loaded");
  return tokenizer(text, { add_special_tokens: true, truncation: false, padding: false, return_tensor: false }).input_ids.length;
}
function encodeContent(text: string): number[] {
  if (!tokenizer) throw new Error("Native tokenizer is not loaded");
  return tokenizer(text, { add_special_tokens: false, truncation: false, padding: false, return_tensor: false }).input_ids;
}

function contextualRanges(text: string, value: unknown): PassageTokenRange[] {
  if (!Array.isArray(value) || value.length > 4096) throw new Error("Invalid contextual passage count");
  const ids = encodeContent(text);
  let cursor = 0;
  let previousIndex = -1;
  let bytes = new TextEncoder().encode(text).byteLength;
  return value.map((raw, index) => {
    const range = record(raw);
    validateText(range.text);
    bytes += new TextEncoder().encode(range.text).byteLength;
    if (bytes > MAX_TEXT_BYTES || Object.keys(range).length !== 4 || !Number.isSafeInteger(range.passageIndex) || Number(range.passageIndex) < 0 || Number(range.passageIndex) >= 4096 || (previousIndex !== -1 && range.passageIndex !== previousIndex + 1)) throw new Error("Invalid contextual passage identity or size");
    previousIndex = Number(range.passageIndex);
    const part = encodeContent(range.text);
    if (!part.length || range.startToken !== cursor + 1 || range.endToken !== cursor + part.length + 1 || countTokens(range.text) > Math.min(PASSAGE_TOKENS, profile.contextLimit)) throw new Error("Invalid contextual token range or passage budget");
    for (const id of part) if (id !== ids[cursor++]) throw new Error("Contextual passage token IDs do not match the complete window");
    if (index === value.length - 1 && cursor !== ids.length) throw new Error("Contextual passage ranges omit window tokens");
    return { passageIndex: Number(range.passageIndex), startToken: Number(range.startToken), endToken: Number(range.endToken) };
  });
}

async function forward(text: string, expectedTokens: number, ranges?: readonly PassageTokenRange[]): Promise<{ noteVector: number[]; passageVectors: Array<{ passageIndex: number; vector: number[] }> }> {
  if (!model || !tokenizer) throw new Error("Native model is not loaded");
  const inputs = tokenizer(text, { add_special_tokens: true, truncation: false, padding: false, return_tensor: true });
  let outputs: Record<string, Tensor> | undefined;
  try {
    if (inputs.input_ids.dims.length !== 2 || inputs.input_ids.dims[0] !== 1 || inputs.input_ids.dims[1] !== expectedTokens || expectedTokens > profile.contextLimit) {
      throw new Error("Tokenizer changed the complete input length; refusing truncated inference");
    }
    if (profile.id === "jinaai/jina-embeddings-v2-small-en") {
      const content = encodeContent(text);
      if (!jinaSpecialTokens || content.length + 2 !== expectedTokens || Number(inputs.input_ids.data[0]) !== jinaSpecialTokens[0] || Number(inputs.input_ids.data[expectedTokens - 1]) !== jinaSpecialTokens[1]) throw new Error("Jina tokenizer special-token template changed");
      for (let index = 0; index < content.length; index += 1) if (Number(inputs.input_ids.data[index + 1]) !== content[index]) throw new Error("Jina forward input differs from its verified content token IDs");
      if (ranges && ranges.length === 0 && content.length !== 0) throw new Error("Contextual ranges omit nonempty content");
    }
    outputs = await model(inputs) as Record<string, Tensor>;
    const hidden = outputs.last_hidden_state;
    if (!hidden || hidden.type !== "float32" || hidden.dims.length !== 3 || hidden.dims[0] !== 1 || hidden.dims[1] !== expectedTokens || hidden.dims[2] !== profile.dimensions || hidden.data.length !== expectedTokens * profile.dimensions) {
      throw new Error("Model returned an incompatible full-context hidden state");
    }
    const data = hidden.data;
    const mask = inputs.attention_mask;
    if (profile.pooling === "mean" && (!mask || mask.dims.length !== 2 || mask.dims[0] !== 1 || mask.dims[1] !== expectedTokens || mask.data.length !== expectedTokens)) throw new Error("Tokenizer returned an incompatible attention mask");
    const noteVector = poolTokenRange(data, profile.dimensions, 0, profile.pooling === "CLS" ? 1 : expectedTokens, profile.pooling === "mean" ? mask.data : undefined);
    const passageVectors = ranges ? ranges.map(range => ({ passageIndex: range.passageIndex, vector: poolTokenRange(data, profile.dimensions, range.startToken, range.endToken) })) : [];
    return { noteVector, passageVectors };
  } finally {
    const tensors = new Set<Tensor>([...Object.values(inputs), ...Object.values(outputs ?? {})]);
    for (const tensor of tensors) tensor.dispose();
  }
}

async function dispose(): Promise<void> {
  ready = false;
  if (model) await model.dispose();
  model = undefined;
  tokenizer = undefined;
  jinaSpecialTokens = undefined;
  device = undefined;
}

async function load(payload: unknown) {
  const options = record(payload);
  if (typeof options.modelId !== "string") throw new Error("A supported local embedding model ID is required");
  const mode = options.chunkingMode;
  if (mode !== undefined && mode !== "standard" && mode !== "late") throw new Error("Unsupported native chunking mode");
  const selected = getModelProfile(options.modelId, mode);
  if (options.device !== undefined && options.device !== "wasm" && options.device !== "webgpu") throw new Error("Unsupported native embedding device request");
  if (ready) {
    if (selected !== profile) throw new Error("Changing embedding models requires a fresh worker");
    return health();
  }
  if (typeof options.runtimeBaseUrl !== "string" || !options.runtimeBaseUrl) throw new Error("Native ONNX runtime asset path is missing; reinstall the packaged plugin");
  const wasmPaths = options.wasmPaths === undefined ? undefined : record(options.wasmPaths);
  let packagedWasmPaths: { wasm: string; mjs: string } | undefined;
  if (wasmPaths) {
    const wasmFile = wasmPaths.wasm;
    const mjsFile = wasmPaths.mjs;
    if (typeof wasmFile !== "string" || typeof mjsFile !== "string" || !wasmFile || !mjsFile) throw new Error("Native ONNX runtime asset URLs are invalid");
    packagedWasmPaths = { wasm: wasmFile, mjs: mjsFile };
  }
  await dispose();
  profile = selected;
  // Electron may expose Node globals even to a worker. The browser bundle must also
  // resolve the browser package export; hiding process alone cannot remove Node imports.
  Object.defineProperty(globalThis, "process", { value: undefined, configurable: true, writable: true });
  const { AutoTokenizer, AutoModel, env } = await import("@huggingface/transformers");
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.remoteHost = "https://huggingface.co/";
  env.remotePathTemplate = "{model}/resolve/{revision}/";
  env.useFS = false;
  env.useFSCache = false;
  env.useBrowserCache = typeof caches !== "undefined";
  env.useWasmCache = false;
  const wasm = env.backends.onnx.wasm;
  if (!wasm) throw new Error("Packaged Transformers.js did not select browser ONNX Runtime");
  wasm.numThreads = 1;
  wasm.proxy = false;
  if (options.device !== "webgpu") wasm.wasmPaths = packagedWasmPaths ?? options.runtimeBaseUrl;
  status(`Loading pinned ${profile.label} tokenizer and fp32 ONNX model; model downloads are cached locally when browser caching is available`);
  let lastProgress = "";
  const progress_callback = (progress: { status: string; file?: string }) => {
    if (progress.status !== "initiate" && progress.status !== "done") return;
    const message = `${progress.status === "done" ? "Cached/loaded" : "Loading"} ${profile.label} ${progress.file ?? "model asset"}`;
    if (message !== lastProgress) { status(message); lastProgress = message; }
  };
  tokenizer = await AutoTokenizer.from_pretrained(profile.modelId, { revision: profile.revision, progress_callback });
  if (profile.id === "jinaai/jina-embeddings-v2-small-en") {
    jinaSpecialTokens = tokenizer("", { add_special_tokens: true, truncation: false, padding: false, return_tensor: false }).input_ids;
    const cls = encodeContent("[CLS]");
    const sep = encodeContent("[SEP]");
    if (jinaSpecialTokens?.length !== 2 || cls.length !== 1 || sep.length !== 1 || jinaSpecialTokens[0] !== cls[0] || jinaSpecialTokens[1] !== sep[0]) throw new Error("Jina tokenizer does not use the expected CLS/content/SEP template");
  }
  async function loadOn(target: "webgpu" | "wasm"): Promise<void> {
    status(`Loading native ${profile.label} on ${target === "webgpu" ? "WebGPU" : "CPU / WASM"}`);
    model = await AutoModel.from_pretrained(profile.modelId, {
      revision: profile.revision,
      dtype: profile.dtype,
      device: target,
      progress_callback,
      session_options: { preferredOutputLocation: "cpu" },
    });
    if (record(model.config).hidden_size !== profile.dimensions || model.config.max_position_embeddings !== profile.maxPositionEmbeddings || model.config.model_type !== profile.modelType) {
      throw new Error("Downloaded model does not match the pinned dimensions, architecture, and position limit");
    }
    const probe = "Native embedding readiness check.";
    const counts = prepareEmbeddingBatch([probe], countTokens, profile);
    await forward(probe, counts[0]!);
    device = target;
    ready = true;
    status(`${profile.label} ready: ${target === "webgpu" ? "WebGPU" : "CPU / WASM"}, fp32, ${profile.contextLimit}-token context`);
  }
  try {
    if (options.device !== "wasm" && typeof navigator !== "undefined" && "gpu" in navigator) {
      try { await loadOn("webgpu"); }
      catch (error) {
        ready = false;
        if (model) await model.dispose();
        model = undefined;
        // Transformers.js retains a rejected initialization/inference chain. A CPU
        // retry must use a fresh worker, not another session in this realm.
        throw new Error(`NATIVE_WEBGPU_LOAD_FAILED: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    } else if (options.device === "webgpu") {
      throw new Error("NATIVE_WEBGPU_LOAD_FAILED: WebGPU is unavailable in this Obsidian worker");
    } else {
      status(options.device === "wasm" ? "CPU / WASM explicitly selected" : "WebGPU is unavailable in this Obsidian worker; using CPU / WASM");
      await loadOn("wasm");
    }
    return health();
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function dispatch(request: Request): Promise<unknown> {
  switch (request.operation) {
    case "load": return load(request.payload);
    case "health": return health();
    case "dispose": await dispose(); return { disposed: true };
    case "prepare": {
      requireReady();
      const { kind, text } = record(request.payload);
      if (typeof text !== "string") throw new Error("Preparation input must be text");
      if (kind === "note") return prepareInput("note", text, countTokens, profile, encodeContent);
      if (kind === "query") return prepareInput("query", text, countTokens, profile);
      throw new Error("Preparation kind must be note or query");
    }
    case "embed": {
      requireReady();
      const { input } = record(request.payload);
      const counts = prepareEmbeddingBatch(input, countTokens, profile);
      const inputs = input as string[];
      const vectors: number[][] = [];
      try {
        // One forward input at a time avoids padding long notes up to a whole batch.
        for (let i = 0; i < inputs.length; i += 1) vectors.push((await forward(inputs[i]!, counts[i]!)).noteVector);
      } catch (error) {
        ready = false;
        status("Native embedding inference failed. A fresh same-backend retry may run; the backend is never silently changed.");
        const message = error instanceof Error ? error.message : "unknown error";
        throw new Error(`${device === "webgpu" ? "NATIVE_WEBGPU_INFERENCE_FAILED: " : ""}${message}`);
      }
      return { modelFingerprint: profile.modelFingerprint, vectors };
    }
    case "embedWindow": {
      requireReady();
      const payload = record(request.payload);
      if (profile.chunkingMode !== "late" || payload.modelFingerprint !== profile.modelFingerprint) throw new Error("Incompatible contextual embedding mode or identity");
      validateText(payload.text);
      const [count] = prepareEmbeddingBatch([payload.text], countTokens, profile);
      const ranges = contextualRanges(payload.text, payload.passages);
      try {
        return { modelFingerprint: profile.modelFingerprint, ...await forward(payload.text, count!, ranges) };
      } catch (error) {
        ready = false;
        status("Native contextual inference failed. A fresh same-backend retry may run; the mode and backend are never silently changed.");
        const message = error instanceof Error ? error.message : "unknown error";
        throw new Error(`${device === "webgpu" ? "NATIVE_WEBGPU_INFERENCE_FAILED: " : ""}${message}`);
      }
    }
    default: throw new Error("Unknown native worker operation");
  }
}

scope.onmessage = (event): void => {
  const value = event.data;
  if (!value || typeof value !== "object" || !Number.isSafeInteger((value as Request).id)) return;
  const request = value as Request;
  if (pending >= 16) {
    scope.postMessage({ id: request.id, error: "Native embedding worker is busy; wait for the current requests to finish" });
    return;
  }
  pending += 1;
  queue = queue.then(async () => {
    try { scope.postMessage({ id: request.id, result: await dispatch(request) }); }
    catch (error) { scope.postMessage({ id: request.id, error: error instanceof Error ? error.message : "Native embedding request failed" }); }
    finally { pending -= 1; }
  });
};
