export type ChunkingMode = "standard" | "late";

export interface EmbeddingProfile {
  readonly id: string;
  readonly label: string;
  readonly modelId: string;
  readonly revision: string;
  readonly dimensions: number;
  readonly pooling: "CLS" | "mean";
  readonly normalization: "L2";
  readonly contextLimit: number;
  readonly modelType: string;
  readonly maxPositionEmbeddings: number;
  readonly dtype: "fp32";
  readonly inputPolicyVersion: number;
  readonly modelFingerprint: string;
  readonly chunkingMode: ChunkingMode;
}

export const EMBEDDING_MODELS: readonly EmbeddingProfile[] = Object.freeze([
  Object.freeze({
    id: "onnx-community/granite-embedding-97m-multilingual-r2-ONNX",
    label: "Granite 97M R2 (Multilingual)",
    modelId: "onnx-community/granite-embedding-97m-multilingual-r2-ONNX",
    revision: "536a9f241cb3f02a9c5995a1e708c784bd274859",
    dimensions: 384,
    pooling: "CLS",
    normalization: "L2",
    contextLimit: 32768,
    modelType: "modernbert",
    maxPositionEmbeddings: 32768,
    dtype: "fp32",
    inputPolicyVersion: 4,
    chunkingMode: "standard",
    modelFingerprint: "granite97m-r2:onnx-536a9f241cb3f02a9c5995a1e708c784bd274859:fp32:cls:l2:d384:t32768:input-v4:structure-v1:windows-bisect-v1:standard:passage-standalone",
  }),
  Object.freeze({
    id: "Xenova/all-MiniLM-L6-v2",
    label: "MiniLM L6 v2 (English)",
    modelId: "Xenova/all-MiniLM-L6-v2",
    revision: "751bff37182d3f1213fa05d7196b954e230abad9",
    dimensions: 384,
    pooling: "mean",
    normalization: "L2",
    // The sentence-transformers model card limits use to 256 tokens, despite BERT's 512 positions.
    contextLimit: 256,
    modelType: "bert",
    maxPositionEmbeddings: 512,
    dtype: "fp32",
    inputPolicyVersion: 4,
    chunkingMode: "standard",
    modelFingerprint: "minilm-l6-v2:onnx-751bff37182d3f1213fa05d7196b954e230abad9:fp32:mean:l2:d384:t256:input-v4:structure-v1:windows-bisect-v1:standard:passage-standalone",
  }),
  Object.freeze({
    id: "jinaai/jina-embeddings-v2-small-en",
    label: "Jina Embeddings v2 Small (English)",
    modelId: "Xenova/jina-embeddings-v2-small-en",
    revision: "523cadcb9c2e71c7153fc46016e1fe79acb4f58f",
    dimensions: 512,
    pooling: "mean",
    normalization: "L2",
    // The model has 8,192 positions. Packaged WebGPU succeeds at 3,584, while
    // real 3,822-token context and the exact 3,841-token boundary fail in ONNX Runtime.
    contextLimit: 3584,
    modelType: "bert",
    maxPositionEmbeddings: 8192,
    dtype: "fp32",
    inputPolicyVersion: 4,
    chunkingMode: "standard",
    modelFingerprint: "jina-v2-small-en:onnx-523cadcb9c2e71c7153fc46016e1fe79acb4f58f:fp32:mean:l2:d512:t3584:positions8192:input-v4:structure-v1:windows-bisect-v1:standard:passage-standalone",
  }),
]);

export const DEFAULT_MODEL: EmbeddingProfile = EMBEDDING_MODELS[0]!;
const JINA_STANDARD = EMBEDDING_MODELS[2]!;
const JINA_LATE: EmbeddingProfile = Object.freeze({
  ...JINA_STANDARD,
  chunkingMode: "late",
  modelFingerprint: JINA_STANDARD.modelFingerprint.replace(":standard:passage-standalone", ":late:passage-mean-content"),
});

export function getModelProfile(id: string, mode: ChunkingMode = "standard"): EmbeddingProfile {
  if (mode !== "standard" && mode !== "late") throw new Error(`Unsupported chunking mode: ${mode}`);
  const profile = EMBEDDING_MODELS.find((candidate) => candidate.id === id);
  if (!profile) throw new Error(`Unsupported local embedding model: ${id}`);
  if (mode === "late") {
    if (profile !== JINA_STANDARD) throw new Error("Late chunking requires Jina v2 Small; select Standard before changing models");
    return JINA_LATE;
  }
  return profile;
}
