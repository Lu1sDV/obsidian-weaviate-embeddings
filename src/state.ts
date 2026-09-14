import { DEFAULT_MODEL, getModelProfile } from "./embedding-config";
import { PersistedState } from "./types";

export function newState(): PersistedState {
  return {
    vaultId: crypto.randomUUID(),
    exclusions: { respectGitignore: true, folders: [], files: [] },
    embeddingModel: DEFAULT_MODEL.id,
    chunkingMode: "standard",
    servingReady: false,
    knownGenerations: [1],
    indexingEnabled: false,
    activeGeneration: 1,
    schemaUpdating: false,
    pathToNoteId: {},
    notes: {},
    pendingPurges: [],
    registry: { fields: [] },
    presets: {},
  };
}

export function mergeState(raw: Partial<PersistedState> | null | undefined): PersistedState {
  const base = newState();
  const persisted = { ...raw };
  Reflect.deleteProperty(persisted, "authorizedRoots");
  const mode = raw?.chunkingMode === undefined ? "standard" : raw.chunkingMode;
  const profile = getModelProfile(raw?.embeddingModel ?? DEFAULT_MODEL.id, mode);
  const state: PersistedState = {
    ...base,
    ...persisted,
    embeddingModel: profile.id,
    chunkingMode: profile.chunkingMode,
    exclusions: {
      respectGitignore: raw?.exclusions?.respectGitignore !== false,
      folders: Array.isArray(raw?.exclusions?.folders) ? raw.exclusions.folders.filter((path): path is string => typeof path === "string") : [],
      files: Array.isArray(raw?.exclusions?.files) ? raw.exclusions.files.filter((path): path is string => typeof path === "string") : [],
    },
    servingReady: false,
    knownGenerations: [...new Set([raw?.activeGeneration ?? 1, ...(raw?.knownGenerations ?? [])])].filter((value) => Number.isSafeInteger(value) && value > 0),
    pathToNoteId: raw?.pathToNoteId ?? base.pathToNoteId,
    notes: raw?.notes ?? base.notes,
    pendingPurges: raw?.pendingPurges ?? base.pendingPurges,
    registry: raw?.registry ?? base.registry,
    presets: raw?.presets ?? base.presets,
  };
  const generations = new Set(state.knownGenerations);
  generations.add(state.activeGeneration);
  let incompatibleActive = false;
  for (const note of Object.values(state.notes)) {
    generations.add(note.generation);
    if (note.modelFingerprint !== profile.modelFingerprint) {
      note.servable = false;
      if (note.generation === state.activeGeneration) incompatibleActive = true;
    }
  }
  if ([...generations].some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error("Invalid persisted index generation");
  if (incompatibleActive) {
    let generation = state.activeGeneration;
    for (const known of generations) generation = Math.max(generation, known);
    generation += 1;
    if (!Number.isSafeInteger(generation)) throw new Error("Index generation limit reached");
    state.activeGeneration = generation;
    generations.add(generation);
    state.schemaUpdating = true;
  }
  state.knownGenerations = [...generations];
  return state;
}
