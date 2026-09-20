import type { ChunkingMode } from "./embedding-config";

export type PropertyKind = "text" | "number" | "boolean" | "date" | "textArray" | "numberArray" | "booleanArray" | "dateArray" | "json";

export interface RegistryField {
  logicalKey: string;
  kind: PropertyKind;
  physicalName: string;
}

export interface PropertyRegistryData {
  fields: RegistryField[];
}

export interface NormalizedProperties {
  frontmatterJson: string;
  propertyKeys: string[];
  nullPropertyKeys: string[];
  emptyListPropertyKeys: string[];
  tags: string[];
  tagAncestors: string[];
  fields: Record<string, string | number | boolean | string[] | number[] | boolean[]>;
}

export type FilterOperator = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "containsAny" | "containsAll" | "missing" | "null" | "empty";
export interface PropertyFilter {
  key: string;
  kind: PropertyKind;
  operator: FilterOperator;
  value?: string | number | boolean | string[] | number[] | boolean[];
}

export interface WorkerHealth {
  ready: boolean;
  modelId: string;
  revision: string;
  modelFingerprint: string;
  dimensions: number;
  pooling: string;
  normalization: string;
  contextLimit: number;
  device?: string;
}

export interface PreparedPassage {
  text: string;
  heading: string;
  start: number;
  end: number;
  startLine: number;
  endLine: number;
}

export interface PassageTokenRange {
  passageIndex: number;
  startToken: number;
  endToken: number;
}

export interface PreparedNote {
  tokenCount: number;
  modelFingerprint: string;
  inputPolicyVersion: number;
  noteVectorMode: "direct" | "aggregated";
  noteSegments: Array<{ text: string; start: number; end: number }>;
  passages: PreparedPassage[];
  passageRanges?: PassageTokenRange[][];
}

export interface ManifestNote {
  noteId: string;
  path: string;
  snapshotId: string;
  generation: number;
  modelFingerprint: string;
  policyEpoch: number;
  noteVectorMode: "direct" | "aggregated";
  bodyHash: string;
  passageIds: string[];
  committed?: boolean;
  servable: boolean;
}

export interface ExclusionSettings {
  respectGitignore: boolean;
  folders: string[];
  files: string[];
}

export interface StoredNoteVector {
  noteId: string;
  snapshotId: string;
  vector: number[];
}

export interface PersistedState {
  vaultId: string;
  exclusions: ExclusionSettings;
  servingReady: boolean;
  knownGenerations: number[];
  indexingEnabled: boolean;
  embeddingModel: string;
  chunkingMode: ChunkingMode;
  activeGeneration: number;
  schemaUpdating: boolean;
  pathToNoteId: Record<string, string>;
  notes: Record<string, ManifestNote>;
  pendingPurges: string[];
  registry: PropertyRegistryData;
  presets: Record<string, PropertyFilter[]>;
}

export interface SearchResult {
  noteId: string;
  path: string;
  title: string;
  snapshotId: string;
  score: number;
  scoreKind: "similarity" | "hybrid";
  /** Independent JEV relevance; the original retrieval score is never overwritten. */
  rerankScore?: number;
  passages: Array<{ passageId: string; heading: string; body: string; startLine: number; endLine: number }>;
}
