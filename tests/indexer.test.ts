import assert from "node:assert/strict";
import test from "node:test";
import type { App, CachedMetadata, TFile } from "obsidian";
import { PathPolicy } from "../src/exclusions";
import { EmbeddingClient, validateUnitVector } from "../src/embeddings";
import { DEFAULT_MODEL, EMBEDDING_MODELS, getModelProfile, type EmbeddingProfile } from "../src/embedding-config";
import { prepareInput } from "../src/embedding-preparation";
import { IndexCoordinator } from "../src/indexer";
import { PropertyRegistry } from "../src/properties";
import { mergeState } from "../src/state";
import type { PersistedState, PreparedNote } from "../src/types";
import type { NoteObject, PassageObject, WeaviateClient } from "../src/weaviate";

function state(): PersistedState {
  return {
    vaultId: "vault", embeddingModel: DEFAULT_MODEL.id, chunkingMode: "standard",
    exclusions: { respectGitignore: false, folders: [], files: [] },
    servingReady: false, knownGenerations: [1], indexingEnabled: true,
    activeGeneration: 1, schemaUpdating: false, pathToNoteId: {}, notes: {},
    pendingPurges: [], registry: { fields: [] }, presets: {},
  };
}

function prepared(input: string, profile = DEFAULT_MODEL): PreparedNote {
  let offset = 0;
  const passages = input.split("\n\n").map((text) => {
    const start = offset;
    offset += text.length + 2;
    return { text, heading: "", start, end: start + text.length, startLine: 1, endLine: 1 };
  });
  return {
    tokenCount: input.length, modelFingerprint: profile.modelFingerprint,
    inputPolicyVersion: profile.inputPolicyVersion, noteVectorMode: "direct",
    noteSegments: [{ text: input, start: 0, end: input.length }], passages,
  };
}

function coordinatorFixture() {
  const current = state();
  const file = { path: "note.md", basename: "note", extension: "md" } as TFile;
  const cache = { frontmatter: {}, tags: [] } as unknown as CachedMetadata;
  const files = [file];
  const bodies = new Map([[file.path, "latest body"]]);
  const caches = new Map([[file.path, cache]]);
  const app = {
    vault: {
      getMarkdownFiles: () => files,
      getAbstractFileByPath: (path: string) => files.find((candidate) => candidate.path === path) ?? null,
      cachedRead: async (target: TFile) => bodies.get(target.path) ?? "",
      adapter: { stat: async () => null, read: async () => "" },
    },
    metadataCache: { getFileCache: (target: TFile) => caches.get(target.path) ?? null },
  } as unknown as App;
  const policy = new PathPolicy(app, current);
  const preparedInputs: string[] = [];
  const embeddedInputs: string[] = [];
  const embeddedBatches: string[][] = [];
  const replacements: string[] = [];
  const dropped: number[] = [];
  const statuses: string[] = [];
  const snapshots = new Map<string, { fingerprint: string; note: NoteObject; passages: PassageObject[] }>();
  let releaseEmbed: (() => void) | undefined;
  let rejectEmbed: ((error: Error) => void) | undefined;
  let embeddingStarted: (() => void) | undefined;
  let blockEmbedding = false;
  let deleteFails = false;
  let publicationFails = false;
  let releasePublication: (() => void) | undefined;
  let publicationStarted: (() => void) | undefined;
  let persistCalls = 0;
  let publications = 0;
  let activeEmbeddings = 0;
  let maxActiveEmbeddings = 0;
  let prepare = prepared;
  let profile: EmbeddingProfile = DEFAULT_MODEL;
  const embeddings = {
    get profile() { return profile; },
    prepareNote: async (input: string) => { preparedInputs.push(input); return prepare(input, profile); },
    embed: async (inputs: string[]) => {
      embeddedBatches.push([...inputs]);
      embeddedInputs.push(...inputs);
      activeEmbeddings += 1;
      maxActiveEmbeddings = Math.max(maxActiveEmbeddings, activeEmbeddings);
      embeddingStarted?.();
      if (blockEmbedding) await new Promise<void>((resolve, reject) => { releaseEmbed = resolve; rejectEmbed = reject; });
      activeEmbeddings -= 1;
      return inputs.map(() => {
        const vector = new Array<number>(profile.dimensions).fill(0);
        vector[profile === DEFAULT_MODEL ? 0 : 1] = 1;
        return vector;
      });
    },
    embedWindow: async (text: string, passages: Array<{ passageIndex: number }>) => {
      embeddedInputs.push(text);
      const vector = new Array<number>(profile.dimensions).fill(0);
      vector[text.includes("changed context") ? 2 : 1] = 1;
      return { noteVector: vector, passageVectors: passages.map(passage => ({ passageIndex: passage.passageIndex, vector })) };
    },
  } as unknown as EmbeddingClient;
  const weaviate = {
    ensureGeneration: async () => undefined,
    listGenerations: async () => [...new Set([1, ...[...snapshots.keys()].map((key) => Number(key.split(":")[0]))])],
    dropGeneration: async (generation: number) => {
      dropped.push(generation);
      for (const key of snapshots.keys()) if (key.startsWith(`${generation}:`)) snapshots.delete(key);
    },
    replaceSnapshot: async (generation: number, fingerprint: string, note: NoteObject, passages: PassageObject[]) => {
      if (publicationFails) {
        snapshots.delete(`${generation}:${note.noteId}`);
        throw new Error("partial publication");
      }
      snapshots.set(`${generation}:${note.noteId}`, structuredClone({ fingerprint, note, passages }));
      replacements.push(note.path);
      if (publicationStarted) {
        publicationStarted();
        await new Promise<void>((resolve) => { releasePublication = resolve; });
      }
    },
    loadSnapshot: async (generation: number, noteId: string, snapshotId: string, fingerprint: string, passageIds: string[]) => {
      const stored = snapshots.get(`${generation}:${noteId}`);
      if (!stored || stored.fingerprint !== fingerprint || stored.note.snapshotId !== snapshotId) throw new Error("missing snapshot");
      assert.deepEqual(stored.passages.map((passage) => passage.passageId), passageIds);
      validateUnitVector(stored.note.vector, profile.dimensions);
      for (const passage of stored.passages) validateUnitVector(passage.vector, profile.dimensions);
      return structuredClone(stored);
    },
    deleteNote: async (generation: number, noteId: string) => {
      if (deleteFails) throw new Error("offline");
      snapshots.delete(`${generation}:${noteId}`);
    },
  } as unknown as WeaviateClient;
  const createCoordinator = () => {
    const registry = new PropertyRegistry(current.registry);
    return new IndexCoordinator(app, current, registry, embeddings, weaviate, async () => {
      persistCalls += 1;
      current.registry = registry.data();
    }, (message) => statuses.push(message), policy, () => { publications += 1; });
  };
  let coordinator = createCoordinator();
  coordinator.start();
  return {
    app, file, cache, policy, state: current, preparedInputs, embeddedInputs, embeddedBatches,
    replacements, dropped, statuses, snapshots,
    get coordinator() { return coordinator; },
    get manifest() { return current.notes[current.pathToNoteId[file.path] ?? ""]!; },
    get stored() { return snapshots.get(`${current.activeGeneration}:${current.pathToNoteId[file.path]}`)!; },
    setBody(body: string, target = file) { bodies.set(target.path, body); },
    addFile(path: string, body: string) {
      const added = { path, basename: path.replace(/\.md$/, ""), extension: "md" } as TFile;
      files.push(added);
      bodies.set(path, body);
      caches.set(path, { frontmatter: {}, tags: [] } as unknown as CachedMetadata);
      return added;
    },
    block() {
      blockEmbedding = true;
      return new Promise<void>((resolve) => { embeddingStarted = resolve; });
    },
    blockPublication() {
      return new Promise<void>((resolve) => { publicationStarted = resolve; });
    },
    releasePublication() { publicationStarted = undefined; releasePublication?.(); },
    failPublication(fail = true) { publicationFails = fail; },
    failDeletes() { deleteFails = true; },
    persistCalls() { return persistCalls; },
    publications() { return publications; },
    maxActiveEmbeddings() { return maxActiveEmbeddings; },
    setPreparation(value: typeof prepared) { prepare = value; },
    setModel(value: EmbeddingProfile) { profile = value; current.embeddingModel = value.id; current.chunkingMode = value.chunkingMode; },
    release() { blockEmbedding = false; embeddingStarted = undefined; releaseEmbed?.(); },
    cancelEmbedding() {
      blockEmbedding = false;
      embeddingStarted = undefined;
      rejectEmbed?.(new Error("Native embedding runtime stopped; enable semantic indexing before trying again"));
    },
    restart() { coordinator.stop(); coordinator = createCoordinator(); coordinator.start(); },
  };
}

test("event storms coalesce to the latest paired content", async () => {
  const fixture = coordinatorFixture();
  await fixture.policy.reload([fixture.file.path]);
  fixture.coordinator.enqueue(fixture.file, fixture.cache, "old body");
  fixture.coordinator.enqueue(fixture.file, fixture.cache, "new body");
  await fixture.coordinator.drain();
  assert.deepEqual(fixture.preparedInputs, ["# note\n\nnew body"]);
  assert.deepEqual(fixture.replacements, [fixture.file.path]);
  assert.equal(fixture.manifest.servable, true);
});

test("policy cancellation during embedding prevents publication", async () => {
  const fixture = coordinatorFixture();
  const started = fixture.block();
  fixture.coordinator.enqueue(fixture.file, fixture.cache, "body");
  await started;
  fixture.policy.invalidate();
  fixture.coordinator.invalidateAll();
  fixture.release();
  await fixture.coordinator.drain();
  assert.deepEqual(fixture.replacements, []);
  assert.equal(fixture.state.servingReady, false);
});

test("queued work survives a stop and restarts without fabricated success", async () => {
  const fixture = coordinatorFixture();
  await fixture.policy.reload([fixture.file.path]);
  fixture.coordinator.stop();
  fixture.coordinator.enqueue(fixture.file, fixture.cache, "body");
  fixture.coordinator.start();
  await fixture.coordinator.drain();
  assert.deepEqual(fixture.replacements, [fixture.file.path]);
});

test("stopping cancelled inference preserves the last committed snapshot", async () => {
  const fixture = coordinatorFixture();
  await fixture.coordinator.reconcile();
  const snapshotId = fixture.manifest.snapshotId;
  const started = fixture.block();
  fixture.coordinator.enqueue(fixture.file, fixture.cache, "replacement", false);
  await started;
  fixture.state.indexingEnabled = false;
  fixture.coordinator.stop();
  fixture.cancelEmbedding();
  await fixture.coordinator.drain();
  assert.equal(fixture.manifest.snapshotId, snapshotId);
  assert.equal(fixture.manifest.committed, true);
  assert.deepEqual(fixture.state.pendingPurges, []);
  assert.equal(fixture.snapshots.size, 1);
});

test("offline purges retain tombstones and keep their failure visible instead of reporting idle", async () => {
  const fixture = coordinatorFixture();
  await fixture.coordinator.reconcile();
  const noteId = fixture.manifest.noteId;
  fixture.failDeletes();
  fixture.coordinator.enqueuePurge(noteId);
  await fixture.coordinator.drain();
  assert.deepEqual(fixture.state.pendingPurges, [noteId]);
  assert.equal(fixture.manifest.servable, false);
  assert.equal(fixture.manifest.committed, false);
  assert.ok(fixture.persistCalls() > 0);
  assert.equal(fixture.statuses.at(-1), "offline");
});

test("privacy purges continue while stopped and discard queued private text", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const fixture = coordinatorFixture();
  t.after(() => fixture.coordinator.stop());
  await fixture.coordinator.reconcile();
  const inferenceCount = fixture.embeddedInputs.length;
  fixture.coordinator.enqueue(fixture.file, fixture.cache, "private draft");
  fixture.state.indexingEnabled = false;
  fixture.coordinator.stop();
  fixture.cache.frontmatter = { ai_index: false };
  fixture.coordinator.enqueuePurge(fixture.manifest.noteId);
  await fixture.coordinator.drain();
  t.mock.timers.tick(13_000);
  await fixture.coordinator.drain();
  assert.deepEqual(fixture.state.pendingPurges, []);
  assert.equal(fixture.snapshots.size, 0);
  assert.equal(fixture.manifest.servable, false);
  assert.equal(fixture.embeddedInputs.length, inferenceCount);
  fixture.state.indexingEnabled = true;
  fixture.coordinator.start();
  await fixture.coordinator.reconcile();
  assert.equal(fixture.snapshots.size, 0);
  assert.equal(fixture.embeddedInputs.length, inferenceCount);
});

test("unchanged edits and restart reconciliation reuse persisted vectors without preparation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const fixture = coordinatorFixture();
  t.after(() => fixture.coordinator.stop());
  await fixture.coordinator.reconcile();
  const inferenceCount = fixture.embeddedInputs.length;
  fixture.coordinator.enqueue(fixture.file, fixture.cache, "latest body");
  assert.equal(fixture.manifest.servable, false);
  t.mock.timers.tick(13_000);
  await fixture.coordinator.drain();
  assert.equal(fixture.manifest.servable, true);
  await fixture.coordinator.reconcile();
  fixture.restart();
  await fixture.coordinator.reconcile();
  assert.equal(fixture.preparedInputs.length, 1);
  assert.equal(fixture.embeddedInputs.length, inferenceCount);
  assert.equal(fixture.replacements.length, 1);
  assert.equal(fixture.state.servingReady, true);
});

test("changing one passage recomputes the full note but reuses exact sibling inputs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const fixture = coordinatorFixture();
  t.after(() => fixture.coordinator.stop());
  fixture.setBody("alpha\n\nbeta\n\ngamma");
  await fixture.coordinator.reconcile();
  fixture.embeddedInputs.length = 0;
  fixture.coordinator.enqueue(fixture.file, fixture.cache, "alpha\n\nBETA LONGER\n\ngamma");
  t.mock.timers.tick(13_000);
  await fixture.coordinator.drain();
  assert.deepEqual(fixture.embeddedInputs, ["# note\n\nalpha\n\nBETA LONGER\n\ngamma", "BETA LONGER"]);
  assert.deepEqual(fixture.stored.passages.map((passage) => passage.body), ["# note", "alpha", "BETA LONGER", "gamma"]);
  assert.equal(fixture.stored.passages.at(-1)?.start, "# note\n\nalpha\n\nBETA LONGER\n\n".length);
});

test("new passage inputs are deduplicated and embedded in bounded batches", async () => {
  const fixture = coordinatorFixture();
  const unique = Array.from({ length: 33 }, (_, index) => `passage ${index}`);
  fixture.setBody([...unique, unique[0]!].join("\n\n"));
  await fixture.coordinator.reconcile();
  assert.deepEqual(fixture.embeddedBatches.map((batch) => batch.length), [1, 32, 2]);
  assert.deepEqual(fixture.embeddedInputs, [`# note\n\n${[...unique, unique[0]!].join("\n\n")}`, "# note", ...unique]);
});

test("same-width model changes regenerate retained snapshots with the new context and passage batch limit", async (t) => {
  const fixture = coordinatorFixture();
  t.after(() => fixture.coordinator.stop());
  fixture.setPreparation((input, profile = DEFAULT_MODEL) => prepareInput("note", input, (text) => Array.from(text).length + 2, profile));
  fixture.setBody(`${"a".repeat(180)}\n\n${"b".repeat(180)}`);
  await fixture.coordinator.reconcile();
  assert.equal(fixture.stored.note.vector[0], 1);
  assert.equal(fixture.manifest.noteVectorMode, "direct");
  const mini = EMBEDDING_MODELS[1]!;
  fixture.coordinator.stop();
  await fixture.coordinator.drain();
  fixture.setModel(mini);
  fixture.state.activeGeneration = 2;
  fixture.state.knownGenerations.push(2);
  fixture.state.schemaUpdating = true;
  fixture.embeddedBatches.length = 0;
  fixture.coordinator.start();
  await fixture.coordinator.reconcile();
  assert.equal(fixture.manifest.modelFingerprint, mini.modelFingerprint);
  assert.equal(fixture.manifest.noteVectorMode, "aggregated");
  assert.equal(fixture.stored.note.vector[0], 0);
  assert.equal(fixture.stored.note.vector[1], 1);
  assert.ok(fixture.stored.passages.every((passage) => passage.vector[0] === 0 && passage.vector[1] === 1));
  assert.ok(fixture.embeddedBatches.every((batch) => batch.reduce((tokens, text) => tokens + Array.from(text).length + 2, 0) <= mini.contextLimit));
  assert.equal(fixture.manifest.generation, 2);
  assert.equal(fixture.manifest.servable, true);
  assert.deepEqual(fixture.dropped, [1]);
});

test("metadata-only changes republish filters without preparing or embedding", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const fixture = coordinatorFixture();
  t.after(() => fixture.coordinator.stop());
  fixture.cache.frontmatter = { score: 1 };
  await fixture.coordinator.reconcile();
  const inferenceCount = fixture.embeddedInputs.length;
  fixture.cache.frontmatter = { score: 2 };
  fixture.coordinator.enqueue(fixture.file, fixture.cache, "---\nscore: 2\n---\nlatest body");
  t.mock.timers.tick(13_000);
  await fixture.coordinator.drain();
  assert.equal(fixture.preparedInputs.length, 1);
  assert.equal(fixture.embeddedInputs.length, inferenceCount);
  assert.equal(JSON.parse(fixture.stored.note.properties.frontmatterJson).score, 2);
});

test("per-note trailing debounce uses the latest edit without starving another note", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const fixture = coordinatorFixture();
  t.after(() => fixture.coordinator.stop());
  const other = fixture.addFile("other.md", "other body");
  await fixture.coordinator.reconcile();
  fixture.preparedInputs.length = 0;
  fixture.coordinator.markDirty(fixture.file);
  fixture.coordinator.enqueue(other, undefined, "other changed");
  t.mock.timers.tick(12_000);
  fixture.coordinator.enqueue(fixture.file, fixture.cache, "latest edit");
  t.mock.timers.tick(1_000);
  await fixture.coordinator.drain();
  assert.deepEqual(fixture.preparedInputs, ["# other\n\nother changed"]);
  t.mock.timers.tick(11_999);
  await fixture.coordinator.drain();
  assert.equal(fixture.preparedInputs.length, 1);
  t.mock.timers.tick(1);
  await fixture.coordinator.drain();
  assert.deepEqual(fixture.preparedInputs, ["# other\n\nother changed", "# note\n\nlatest edit"]);
  assert.equal(fixture.maxActiveEmbeddings(), 1);
});

test("reconciliation preserves pending event text and its quiet-period deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const fixture = coordinatorFixture();
  t.after(() => fixture.coordinator.stop());
  await fixture.coordinator.reconcile();
  fixture.preparedInputs.length = 0;
  fixture.coordinator.enqueue(fixture.file, fixture.cache, "paired latest body");
  t.mock.timers.tick(6_000);
  await fixture.coordinator.reconcile();
  t.mock.timers.tick(6_999);
  await fixture.coordinator.drain();
  assert.deepEqual(fixture.preparedInputs, []);
  assert.equal(fixture.manifest.servable, false);
  t.mock.timers.tick(1);
  await fixture.coordinator.drain();
  assert.deepEqual(fixture.preparedInputs, ["# note\n\npaired latest body"]);
  assert.equal(fixture.manifest.servable, true);
});

test("an interrupted edit preserves the committed identity for a later unchanged revision", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const fixture = coordinatorFixture();
  t.after(() => fixture.coordinator.stop());
  await fixture.coordinator.reconcile();
  const snapshotId = fixture.manifest.snapshotId;
  const started = fixture.block();
  fixture.coordinator.enqueue(fixture.file, fixture.cache, "intermediate draft");
  t.mock.timers.tick(13_000);
  await started;
  fixture.coordinator.enqueue(fixture.file, fixture.cache, "latest body");
  fixture.release();
  await fixture.coordinator.drain();
  const inferenceCount = fixture.embeddedInputs.length;
  assert.equal(fixture.manifest.snapshotId, snapshotId);
  assert.equal(fixture.manifest.committed, true);
  assert.equal(fixture.manifest.servable, false);
  t.mock.timers.tick(13_000);
  await fixture.coordinator.drain();
  assert.equal(fixture.embeddedInputs.length, inferenceCount);
  assert.equal(fixture.manifest.snapshotId, snapshotId);
  assert.equal(fixture.manifest.servable, true);
});

test("cancellation during publication purges the uncommitted result before the newest revision", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const fixture = coordinatorFixture();
  t.after(() => fixture.coordinator.stop());
  await fixture.coordinator.reconcile();
  const publishing = fixture.blockPublication();
  fixture.coordinator.enqueue(fixture.file, fixture.cache, "first edit");
  t.mock.timers.tick(13_000);
  await publishing;
  fixture.coordinator.enqueue(fixture.file, fixture.cache, "final edit");
  fixture.releasePublication();
  await fixture.coordinator.drain();
  assert.equal(fixture.snapshots.size, 0);
  assert.equal(fixture.manifest.servable, false);
  t.mock.timers.tick(13_000);
  await fixture.coordinator.drain();
  assert.equal(fixture.manifest.servable, true);
  assert.equal(fixture.stored.passages.at(-1)?.body, "final edit");
});

test("schema migration waits for pending edits and reuses unchanged vectors", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const fixture = coordinatorFixture();
  t.after(() => fixture.coordinator.stop());
  await fixture.coordinator.reconcile();
  const inferenceCount = fixture.embeddedInputs.length;
  fixture.cache.frontmatter = { newField: "value" };
  fixture.coordinator.enqueue(fixture.file, fixture.cache, "latest body");
  let migrationStarted!: () => void;
  const started = new Promise<void>((resolve) => { migrationStarted = resolve; });
  const originalNormalize = fixture.app.metadataCache.getFileCache.bind(fixture.app.metadataCache);
  fixture.app.metadataCache.getFileCache = (target) => { migrationStarted(); return originalNormalize(target); };
  const reconciliation = fixture.coordinator.reconcile();
  await started;
  await fixture.coordinator.drain();
  assert.deepEqual(fixture.dropped, []);
  assert.equal(fixture.state.servingReady, false);
  t.mock.timers.tick(13_000);
  await reconciliation;
  assert.deepEqual(fixture.dropped, [1]);
  assert.equal(fixture.state.activeGeneration, 2);
  assert.equal(fixture.manifest.generation, 2);
  assert.equal(fixture.manifest.servable, true);
  assert.equal(fixture.embeddedInputs.length, inferenceCount);
});

test("stopping a migration releases reconciliation without dropping the previous generation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const fixture = coordinatorFixture();
  t.after(() => fixture.coordinator.stop());
  await fixture.coordinator.reconcile();
  fixture.cache.frontmatter = { anotherField: "value" };
  fixture.coordinator.enqueue(fixture.file, fixture.cache, "latest body");
  const reconciliation = fixture.coordinator.reconcile();
  fixture.coordinator.stop();
  await reconciliation;
  await fixture.coordinator.drain();
  assert.deepEqual(fixture.dropped, []);
  assert.equal(fixture.state.servingReady, false);
});

for (const corrupt of ["fingerprint", "missing", "vector", "uncommitted"] as const) {
  test(`${corrupt} persisted snapshots never supply reusable vectors`, async () => {
    const fixture = coordinatorFixture();
    await fixture.coordinator.reconcile();
    const inferenceCount = fixture.embeddedInputs.length;
    if (corrupt === "fingerprint") fixture.manifest.modelFingerprint = "incompatible-input-policy";
    if (corrupt === "missing") fixture.snapshots.clear();
    if (corrupt === "vector") fixture.stored.passages[0]!.vector = [NaN];
    if (corrupt === "uncommitted") fixture.manifest.committed = false;
    await fixture.coordinator.reconcile();
    assert.equal(fixture.preparedInputs.length, 2);
    assert.equal(fixture.embeddedInputs.length, inferenceCount * 2);
    assert.equal(fixture.manifest.servable, true);
  });
}

test("failed publication cannot become a persisted-vector cache", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const fixture = coordinatorFixture();
  t.after(() => fixture.coordinator.stop());
  await fixture.coordinator.reconcile();
  fixture.failPublication();
  fixture.coordinator.enqueue(fixture.file, fixture.cache, "replacement");
  t.mock.timers.tick(13_000);
  await fixture.coordinator.drain();
  assert.equal(fixture.manifest.committed, false);
  assert.equal(fixture.manifest.servable, false);
  assert.equal(fixture.statuses.at(-1), "partial publication");
  fixture.failPublication(false);
  const inferenceCount = fixture.embeddedInputs.length;
  await fixture.coordinator.reconcile();
  assert.ok(fixture.embeddedInputs.length > inferenceCount);
  assert.equal(fixture.statuses.at(-1), "Ready — idle");
  assert.equal(fixture.manifest.servable, true);
});

test("progress does not publish availability before a note commits", async () => {
  const fixture = coordinatorFixture();
  const started = fixture.block();
  const reconciliation = fixture.coordinator.reconcile();
  await started;
  assert.equal(fixture.publications(), 0);
  assert.ok(fixture.statuses.some((status) => status.startsWith("Checking")));
  assert.ok(fixture.statuses.some((status) => status.startsWith("Embedding")));
  fixture.release();
  await reconciliation;
  assert.equal(fixture.publications(), 1);
  assert.equal(fixture.statuses.at(-1), "Ready — idle");
});

test("long-note aggregation retains every note segment while reusing unchanged passages", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const fixture = coordinatorFixture();
  t.after(() => fixture.coordinator.stop());
  fixture.setPreparation((input) => {
    const result = prepared(input);
    result.noteVectorMode = "aggregated";
    result.noteSegments = result.passages.map((passage) => ({ text: passage.text, start: passage.start, end: passage.end }));
    return result;
  });
  fixture.setBody("first\n\nlast");
  await fixture.coordinator.reconcile();
  fixture.embeddedInputs.length = 0;
  fixture.coordinator.enqueue(fixture.file, fixture.cache, "first\n\nchanged last");
  t.mock.timers.tick(13_000);
  await fixture.coordinator.drain();
  assert.deepEqual(fixture.embeddedInputs, ["# note", "first", "changed last", "changed last"]);
  assert.equal(fixture.manifest.noteVectorMode, "aggregated");
  validateUnitVector(fixture.stored.note.vector);
});

test("Late re-embeds unchanged passage text when its context changes but reuses metadata-only snapshots", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const fixture = coordinatorFixture();
  t.after(() => fixture.coordinator.stop());
  fixture.setModel(getModelProfile("jinaai/jina-embeddings-v2-small-en", "late"));
  fixture.setPreparation((input, profile) => {
    const result = prepared(input, profile);
    result.passageRanges = [result.passages.map((_, index) => ({ passageIndex: index, startToken: index + 1, endToken: index + 2 }))];
    return result;
  });
  fixture.setBody("unchanged passage\n\noriginal context");
  await fixture.coordinator.reconcile();
  const previous = structuredClone(fixture.stored.passages[0]!);
  fixture.setBody("unchanged passage\n\nchanged context");
  fixture.coordinator.enqueue(fixture.file, fixture.cache, "unchanged passage\n\nchanged context");
  t.mock.timers.tick(13_000);
  await fixture.coordinator.drain();
  assert.equal(fixture.stored.passages[0]!.body, previous.body);
  assert.notDeepEqual(fixture.stored.passages[0]!.vector, previous.vector);
  assert.equal(fixture.stored.passages[0]!.vector[2], 1);
  const inferenceCount = fixture.embeddedInputs.length;
  fixture.cache.frontmatter = { description: "metadata only" };
  await fixture.coordinator.reconcile();
  assert.equal(fixture.embeddedInputs.length, inferenceCount);
  assert.equal(fixture.stored.passages[0]!.vector[2], 1);
  assert.equal(fixture.manifest.servable, true);
});

test("policy upgrades reserve a fresh generation once and retain old purge obligations across restart", async (t) => {
  const fixture = coordinatorFixture();
  t.after(() => fixture.coordinator.stop());
  await fixture.coordinator.reconcile();
  fixture.manifest.modelFingerprint = "previous-input-v3";
  fixture.state.pendingPurges.push(fixture.manifest.noteId);
  fixture.state.knownGenerations.push(6);
  const restored = mergeState(fixture.state);
  assert.equal(restored.activeGeneration, 7);
  assert.equal(restored.schemaUpdating, true);
  assert.equal(restored.servingReady, false);
  assert.equal(restored.notes[fixture.manifest.noteId]!.servable, false);
  assert.equal(restored.notes[fixture.manifest.noteId]!.committed, true);
  assert.deepEqual(restored.pendingPurges, [fixture.manifest.noteId]);
  assert.deepEqual(restored.knownGenerations, [1, 6, 7]);
  assert.equal(mergeState(restored).activeGeneration, 7);
  assert.throws(() => mergeState({ ...state(), chunkingMode: "late" }), /Jina/);
});
