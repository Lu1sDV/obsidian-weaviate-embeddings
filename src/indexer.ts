import { App, CachedMetadata, TFile, getAllTags } from "obsidian";
import { EmbeddingClient } from "./embeddings";
import type { EmbeddingProfile } from "./embedding-config";
import { MAX_TEXT_BYTES, PASSAGE_TOKENS } from "./embedding-preparation";
import type { PathPolicy } from "./exclusions";
import { admissionFor, canonicalInput } from "./policy";
import { normalizeTag } from "./policy-core";
import { PropertyRegistry } from "./properties";
import { ManifestNote, NormalizedProperties, PersistedState } from "./types";
import { aggregateVectors } from "./vectors";
import { NoteObject, PassageObject, WeaviateClient } from "./weaviate";

const MAX_EVENT_TEXT_BYTES = 512 * 1024;
const MAX_PENDING_TEXT_BYTES = 4 * 1024 * 1024;
const EDIT_DEBOUNCE_MS = 13_000;
const MAX_EMBEDDING_BATCH_INPUTS = 32;
const encoder = new TextEncoder();

type WorkItem = {
  file: TFile;
  revision: number;
  barrier: number;
  cache?: CachedMetadata | null;
  notBefore: number;
  data?: string;
  epoch?: number;
  profile?: EmbeddingProfile;
};

type PurgeRequest = {
  noteId: string;
  forget: boolean;
  intent: Promise<void>;
};

class StaleWork extends Error {}

export class IndexCoordinator {
  private readonly epochs = new Map<string, number>();
  private readonly revisions = new Map<string, number>();
  private readonly pending = new Map<string, WorkItem>();
  private readonly purgeQueue: PurgeRequest[] = [];
  private readonly queuedPurges = new Set<string>();
  private retainedTextBytes = 0;
  private barrier = 0;
  private stopped = true;
  private runPromise: Promise<void> | undefined;
  private reconcilePromise: Promise<void> | undefined;
  private reconcileAgain = false;
  private migrationError: Error | undefined;
  private failed = false;
  private checkingSchema = false;
  private activeItem: WorkItem | undefined;
  private wakeTimer: NodeJS.Timeout | undefined;
  private readonly drainWaiters = new Set<() => void>();

  constructor(
    private readonly app: App,
    private readonly state: PersistedState,
    private readonly registry: PropertyRegistry,
    private readonly embeddings: EmbeddingClient,
    private readonly weaviate: WeaviateClient,
    private readonly persist: () => Promise<void>,
    private readonly status: (message: string) => void,
    private readonly pathPolicy: PathPolicy,
    private readonly published: () => void = () => undefined,
  ) {
    for (const note of Object.values(state.notes)) {
      note.committed ??= note.servable;
      if (note.modelFingerprint !== embeddings.profile.modelFingerprint) note.servable = false;
    }
  }

  stop(): void {
    this.stopped = true;
    this.barrier += 1;
    this.state.servingReady = false;
    this.clearTimer();
    for (const noteId of Object.keys(this.state.notes)) {
      this.bump(noteId);
      this.state.notes[noteId]!.servable = false;
    }
    for (const item of this.pending.values()) {
      delete item.data;
      delete item.cache;
    }
    this.retainedTextBytes = 0;
    this.wakeDrainers();
    void this.persist();
  }

  start(): void {
    this.failed = false;
    this.stopped = false;
    this.state.servingReady = false;
    for (const item of this.pending.values()) {
      item.barrier = this.barrier;
      const noteId = this.state.pathToNoteId[item.file.path];
      if (noteId) item.epoch = this.bump(noteId);
    }
    this.schedule();
  }

  async drain(includeQueued = false): Promise<void> {
    while (true) {
      if (this.runPromise) {
        await this.runPromise;
      } else if (includeQueued && !this.stopped && this.state.indexingEnabled && this.pending.size > 0) {
        await new Promise<void>((resolve) => this.drainWaiters.add(resolve));
      } else {
        return;
      }
    }
  }

  invalidateAll(): void {
    this.barrier += 1;
    this.state.servingReady = false;
    for (const [path, noteId] of Object.entries(this.state.pathToNoteId)) {
      this.revisions.set(path, (this.revisions.get(path) ?? 0) + 1);
      const epoch = this.bump(noteId);
      const manifest = this.state.notes[noteId];
      if (manifest) manifest.servable = false;
      const item = this.pending.get(path);
      if (item) {
        item.revision = this.revisions.get(path)!;
        item.barrier = this.barrier;
        item.epoch = epoch;
      }
    }
    for (const item of this.pending.values()) item.barrier = this.barrier;
    void this.persist();
  }

  markDirty(file: TFile): void {
    if (file.extension !== "md") return;
    this.enqueue(file);
  }

  enqueue(file: TFile, cache?: CachedMetadata | null, data?: string, edit = true): void {
    if (file.extension !== "md") return;
    const prior = this.pending.get(file.path);
    if (!edit && (prior || (this.activeItem?.file.path === file.path && this.activeItem.barrier === this.barrier && this.activeItem.revision === this.revisions.get(file.path)))) return;
    const noteId = this.state.pathToNoteId[file.path];
    const admission = admissionFor(file, cache ?? this.app.metadataCache.getFileCache(file), this.pathPolicy);
    if (!admission.admitted && !admission.deferred) {
      if (noteId) this.schedulePurge(noteId, false);
      return;
    }
    const revision = (this.revisions.get(file.path) ?? 0) + 1;
    this.revisions.set(file.path, revision);
    const notBefore = edit && (prior?.notBefore || (noteId && this.state.notes[noteId])) ? Date.now() + EDIT_DEBOUNCE_MS : 0;
    const item: WorkItem = { file, revision, barrier: this.barrier, notBefore };
    if (!this.stopped && this.state.indexingEnabled && cache !== undefined) item.cache = cache;
    this.removePending(file.path);
    if (!this.stopped && this.state.indexingEnabled && data !== undefined && data.length <= MAX_EVENT_TEXT_BYTES && this.retainedTextBytes + data.length <= MAX_PENDING_TEXT_BYTES) {
      item.data = data;
      this.retainedTextBytes += data.length;
    }
    if (noteId) {
      item.epoch = this.bump(noteId);
      const manifest = this.state.notes[noteId];
      if (manifest) manifest.servable = false;
    }
    this.pending.set(file.path, item);
    void this.persist();
    this.schedule();
  }

  enqueuePurge(noteId: string): void {
    this.failed = false;
    this.schedulePurge(noteId, false);
  }

  async reconcile(): Promise<void> {
    if (this.reconcilePromise) {
      this.reconcileAgain = true;
      return this.reconcilePromise;
    }
    this.reconcilePromise = this.performReconcile().finally(() => {
      this.reconcilePromise = undefined;
      this.checkingSchema = false;
      this.schedule();
    });
    return this.reconcilePromise;
  }

  rename(file: TFile, oldPath: string): void {
    const noteId = this.state.pathToNoteId[oldPath];
    this.revisions.set(oldPath, (this.revisions.get(oldPath) ?? 0) + 1);
    this.removePending(oldPath);
    if (!noteId) {
      this.enqueue(file);
      return;
    }
    delete this.state.pathToNoteId[oldPath];
    this.state.pathToNoteId[file.path] = noteId;
    const manifest = this.state.notes[noteId];
    if (manifest) {
      manifest.path = file.path;
      manifest.servable = false;
    }
    this.enqueue(file);
  }

  delete(path: string): void {
    this.removePending(path);
    const noteId = this.state.pathToNoteId[path];
    if (noteId) this.schedulePurge(noteId, true);
  }

  private removePending(path: string): void {
    const item = this.pending.get(path);
    if (item?.data) this.retainedTextBytes -= item.data.length;
    this.pending.delete(path);
  }

  private clearTimer(): void {
    if (this.wakeTimer !== undefined) clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
  }

  private wakeDrainers(): void {
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }

  private schedule(): void {
    this.clearTimer();
    if (this.runPromise) return;
    if (this.purgeQueue.length === 0) {
      if (this.stopped || !this.state.indexingEnabled || this.checkingSchema) return;
      if (this.pending.size === 0) {
        if (!this.failed && !this.state.schemaUpdating) this.status(this.state.servingReady ? "Ready — idle" : "Idle");
        this.wakeDrainers();
        return;
      }
      let nextDeadline = Infinity;
      for (const item of this.pending.values()) nextDeadline = Math.min(nextDeadline, item.notBefore);
      const delay = nextDeadline - Date.now();
      if (delay > 0) {
        this.status(`Queued ${this.pending.size} note${this.pending.size === 1 ? "" : "s"} — waiting for edits`);
        this.wakeTimer = setTimeout(() => {
          this.wakeTimer = undefined;
          this.schedule();
          this.wakeDrainers();
        }, delay);
        return;
      }
    }
    this.runPromise = this.run().finally(() => {
      this.runPromise = undefined;
      this.schedule();
      this.wakeDrainers();
    });
  }

  private async run(): Promise<void> {
    while (true) {
      const purge = this.purgeQueue.shift();
      if (purge) {
        this.queuedPurges.delete(purge.noteId);
        try {
          await this.purge(purge);
        } catch (error) {
          const manifest = this.state.notes[purge.noteId];
          if (manifest) manifest.servable = false;
          this.state.servingReady = false;
          await this.persist();
          this.failed = true;
          this.status(error instanceof Error ? error.message : "Purge failed");
        }
        continue;
      }
      if (this.stopped || !this.state.indexingEnabled || this.checkingSchema) return;
      let item: WorkItem | undefined;
      const now = Date.now();
      for (const candidate of this.pending.values()) {
        if (candidate.notBefore <= now) { item = candidate; break; }
      }
      if (item) {
        this.removePending(item.file.path);
        this.activeItem = item;
        try {
          await this.index(item);
        } catch (error) {
          if (error instanceof StaleWork || this.stopped || !this.state.indexingEnabled || item.barrier !== this.barrier) {
            if (this.stopped && !this.pending.has(item.file.path) && !this.state.pendingPurges.includes(this.state.pathToNoteId[item.file.path] ?? "")) {
              this.pending.set(item.file.path, { file: item.file, revision: item.revision, barrier: this.barrier, notBefore: item.notBefore });
            }
            continue;
          }
          const failure = error instanceof Error ? error : new Error("Indexing failed");
          if (this.state.schemaUpdating) this.migrationError = failure;
          this.failed = true;
          this.status(failure.message);
          const noteId = this.state.pathToNoteId[item.file.path];
          if (noteId && this.revisions.get(item.file.path) === item.revision) this.schedulePurge(noteId, false, item.revision);
        } finally {
          this.activeItem = undefined;
        }
        continue;
      }
      return;
    }
  }

  private async performReconcile(): Promise<void> {
    do {
      this.reconcileAgain = false;
      this.failed = false;
      this.state.servingReady = false;
      this.status("Checking vault");
      await this.persist();
      const files = this.app.vault.getMarkdownFiles();
      await this.pathPolicy.reload(files.map((file) => file.path));
      this.checkingSchema = true;
      for (const noteId of this.state.pendingPurges) {
        if (this.queuedPurges.has(noteId)) continue;
        const path = Object.entries(this.state.pathToNoteId).find(([, mappedId]) => mappedId === noteId)?.[0];
        this.queuedPurges.add(noteId);
        this.purgeQueue.push({ noteId, forget: !path || !this.app.vault.getAbstractFileByPath(path), intent: Promise.resolve() });
      }
      this.schedule();
      await this.drain();
      const current = new Set<string>();
      const admitted: TFile[] = [];
      const registrySize = this.registry.all().length;
      for (const file of files) {
        const cache = this.app.metadataCache.getFileCache(file);
        const admission = admissionFor(file, cache, this.pathPolicy);
        const noteId = this.state.pathToNoteId[file.path];
        if (admission.admitted) {
          current.add(noteId ?? file.path);
          admitted.push(file);
          await this.registry.normalize(cache?.frontmatter);
        } else if (admission.deferred) {
          if (noteId) {
            current.add(noteId);
            const manifest = this.state.notes[noteId];
            if (manifest) manifest.servable = false;
          }
        } else if (noteId) {
          this.schedulePurge(noteId, false);
        }
      }
      for (const [path, noteId] of Object.entries(this.state.pathToNoteId)) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!file || !current.has(noteId)) this.schedulePurge(noteId, !file);
      }
      const needsGenerationMigration = this.state.schemaUpdating || this.registry.all().length !== registrySize;
      if (needsGenerationMigration && this.state.indexingEnabled && !this.stopped) {
        if (!this.state.schemaUpdating && Object.values(this.state.notes).some((note) => note.committed)) this.state.activeGeneration += 1;
        this.state.schemaUpdating = true;
        this.migrationError = undefined;
        this.rememberGeneration(this.state.activeGeneration);
        this.state.registry = this.registry.data();
        await this.persist();
        this.status("Checking property schema");
        await this.weaviate.ensureGeneration(this.state.activeGeneration, this.registry);
      }
      this.checkingSchema = false;
      for (const file of admitted) this.enqueue(file, undefined, undefined, false);
      this.schedule();
      await this.drain(needsGenerationMigration);
      if (this.migrationError) throw this.migrationError;
      if (needsGenerationMigration) {
        const complete = this.state.indexingEnabled && !this.stopped && this.state.pendingPurges.length === 0 && admitted.every((file) => {
          const manifest = this.state.notes[this.state.pathToNoteId[file.path] ?? ""];
          return manifest?.servable && manifest.generation === this.state.activeGeneration && manifest.modelFingerprint === this.embeddings.profile.modelFingerprint;
        });
        if (!complete) {
          await this.persist();
          return;
        }
        for (const generation of [...this.state.knownGenerations]) {
          if (generation === this.state.activeGeneration) continue;
          await this.weaviate.dropGeneration(generation);
          this.state.knownGenerations = this.state.knownGenerations.filter((known) => known !== generation);
        }
        this.state.schemaUpdating = false;
      }
      if (this.state.indexingEnabled && !this.stopped && this.state.pendingPurges.length === 0) this.state.servingReady = true;
      await this.persist();
    } while (this.reconcileAgain);
    if (this.state.servingReady) this.published();
    else if (!this.failed && (this.stopped || !this.state.indexingEnabled)) this.status("Semantic indexing is disabled");
    this.schedule();
  }

  private async index(item: WorkItem): Promise<void> {
    const profile = this.embeddings.profile;
    item.profile = profile;
    const file = item.file;
    const existingId = this.state.pathToNoteId[file.path];
    const noteId = existingId ?? crypto.randomUUID();
    const cache = item.cache ?? this.app.metadataCache.getFileCache(file);
    const admission = admissionFor(file, cache, this.pathPolicy);
    if (!admission.admitted) {
      if (!admission.deferred && existingId) this.schedulePurge(existingId, false, item.revision);
      return;
    }
    if (!cache) return;
    const epoch = item.epoch ?? this.bump(noteId);
    if (!this.current(item, noteId, epoch)) throw new StaleWork();
    this.failed = false;
    this.status(`Checking ${file.path}`);
    this.state.pathToNoteId[file.path] = noteId;
    const markdown = item.data ?? await this.app.vault.cachedRead(file);
    if (!this.current(item, noteId, epoch)) throw new StaleWork();
    const input = canonicalInput(file, markdown);
    const bodyHash = await digest(input);
    if (!this.current(item, noteId, epoch)) throw new StaleWork();
    const properties = await this.registry.normalize(cache.frontmatter);
    if (!this.current(item, noteId, epoch)) throw new StaleWork();
    const tags = (getAllTags(cache) ?? []).map(normalizeTag);
    properties.tags = [...new Set(tags)];
    properties.tagAncestors = [...new Set(tags.flatMap((tag) => tag.split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/"))))];
    const snapshotId = await digest(`${bodyHash}\0${properties.frontmatterJson}\0${JSON.stringify(properties.tags)}\0${file.path}\0${this.state.activeGeneration}`);
    if (!this.current(item, noteId, epoch)) throw new StaleWork();
    const old = this.state.notes[noteId];
    let retained: { note: NoteObject; passages: PassageObject[] } | undefined;
    if (old?.committed && old.modelFingerprint === profile.modelFingerprint && !this.state.pendingPurges.includes(noteId)) {
      try {
        retained = await this.weaviate.loadSnapshot(old.generation, noteId, old.snapshotId, profile.modelFingerprint, old.passageIds);
      } catch {
        // An incomplete or corrupt database snapshot is never an embedding cache.
      }
      if (!this.current(item, noteId, epoch)) throw new StaleWork();
    }
    if (retained && old?.snapshotId === snapshotId) {
      this.state.notes[noteId] = { ...old, policyEpoch: epoch, servable: true };
      await this.persist();
      if (!this.current(item, noteId, epoch)) throw new StaleWork();
      if (this.state.servingReady && !this.state.schemaUpdating) this.published();
      return;
    }
    this.state.registry = this.registry.data();
    await this.weaviate.ensureGeneration(this.state.activeGeneration, this.registry);
    if (!this.current(item, noteId, epoch)) throw new StaleWork();
    let note: NoteObject;
    let passages: PassageObject[];
    if (retained && old?.bodyHash === bodyHash) {
      note = { ...retained.note, snapshotId, path: file.path, title: file.basename, properties };
      passages = retained.passages.map((passage) => ({ ...passage, snapshotId, path: file.path, title: file.basename, properties }));
    } else {
      ({ note, passages } = await this.prepareAndEmbed(item, noteId, epoch, file, input, properties, retained?.passages));
      note.snapshotId = snapshotId;
      for (const passage of passages) passage.snapshotId = snapshotId;
    }
    if (!this.current(item, noteId, epoch)) throw new StaleWork();
    const pending: ManifestNote = { noteId, path: file.path, snapshotId, generation: this.state.activeGeneration, modelFingerprint: profile.modelFingerprint, policyEpoch: epoch, noteVectorMode: note.noteVectorMode, bodyHash, passageIds: passages.map((passage) => passage.passageId), committed: false, servable: false };
    this.state.notes[noteId] = pending;
    await this.persist();
    if (!this.current(item, noteId, epoch)) {
      if (old?.committed && this.state.notes[noteId] === pending && !this.state.pendingPurges.includes(noteId)) {
        this.state.notes[noteId] = { ...old, servable: false };
        await this.persist();
      }
      throw new StaleWork();
    }
    await this.weaviate.replaceSnapshot(this.state.activeGeneration, profile.modelFingerprint, note, passages);
    if (!this.current(item, noteId, epoch) || !admissionFor(file, cache, this.pathPolicy).admitted) {
      this.schedulePurge(noteId, false, item.revision);
      throw new StaleWork();
    }
    this.state.notes[noteId] = { ...pending, committed: true, servable: true };
    await this.persist();
    if (!this.current(item, noteId, epoch)) throw new StaleWork();
    if (this.state.servingReady && !this.state.schemaUpdating) this.published();
  }

  private async prepareAndEmbed(item: WorkItem, noteId: string, epoch: number, file: TFile, input: string, properties: NormalizedProperties, retained: readonly PassageObject[] = []): Promise<{ note: NoteObject; passages: PassageObject[] }> {
    if (!this.current(item, noteId, epoch)) throw new StaleWork();
    const profile = item.profile!;
    const prepared = await this.embeddings.prepareNote(input);
    if (!this.current(item, noteId, epoch)) throw new StaleWork();
    if (prepared.modelFingerprint !== profile.modelFingerprint) throw new Error("Incompatible prepared model fingerprint");
    const segmentVectors: number[][] = [];
    const passageVectors: number[][] = [];
    if (profile.chunkingMode === "late") {
      if (!prepared.passageRanges || prepared.passageRanges.length !== prepared.noteSegments.length) throw new Error("Late preparation has no verified context ranges");
      for (let index = 0; index < prepared.noteSegments.length; index += 1) {
        if (!this.current(item, noteId, epoch)) throw new StaleWork();
        this.status(`Embedding context ${index + 1}/${prepared.noteSegments.length}: ${file.path}`);
        const ranges = prepared.passageRanges[index]!.map(range => {
          const passage = prepared.passages[range.passageIndex];
          if (!passage) throw new Error("Context range references a missing passage");
          return { ...range, text: passage.text };
        });
        const result = await this.embeddings.embedWindow(prepared.noteSegments[index]!.text, ranges, profile.modelFingerprint);
        if (!this.current(item, noteId, epoch)) throw new StaleWork();
        segmentVectors.push(result.noteVector);
        for (const passage of result.passageVectors) passageVectors[passage.passageIndex] = passage.vector;
      }
      if (prepared.passages.some((_, index) => !passageVectors[index])) throw new Error("Contextual inference omitted a passage vector");
    } else {
      segmentVectors.push(...await this.embedBatches(prepared.noteSegments.map((segment) => segment.text), profile.modelFingerprint, item, noteId, epoch, 1));
      const reusable = new Map(retained.map((passage) => [passage.body, passage.vector]));
      const missing = [...new Set(prepared.passages.map((passage) => passage.text).filter((text) => !reusable.has(text)))];
      const maxPassages = Math.min(MAX_EMBEDDING_BATCH_INPUTS, Math.floor(profile.contextLimit / Math.min(PASSAGE_TOKENS, profile.contextLimit)));
      const missingVectors = await this.embedBatches(missing, profile.modelFingerprint, item, noteId, epoch, maxPassages);
      for (const [index, text] of missing.entries()) reusable.set(text, missingVectors[index]!);
      for (const passage of prepared.passages) passageVectors.push(reusable.get(passage.text)!);
    }
    const noteVector = prepared.noteVectorMode === "direct" ? segmentVectors[0] : aggregateVectors(segmentVectors, profile.dimensions);
    if (!noteVector) throw new Error("Worker returned no note vector");
    const note: NoteObject = { noteId, snapshotId: "", path: file.path, title: file.basename, noteVectorMode: prepared.noteVectorMode, vector: noteVector, properties };
    const passages: PassageObject[] = prepared.passages.map((passage, index) => ({ passageId: `${index}:${passage.start}:${passage.end}`, passageIndex: index, noteId, snapshotId: "", path: file.path, title: file.basename, heading: passage.heading, body: passage.text, start: passage.start, end: passage.end, startLine: passage.startLine, endLine: passage.endLine, vector: passageVectors[index] ?? [], properties }));
    return { note, passages };
  }

  private async embedBatches(inputs: string[], fingerprint: string, item: WorkItem, noteId: string, epoch: number, maxInputs: number): Promise<number[][]> {
    const output: number[][] = [];
    for (let start = 0; start < inputs.length;) {
      let end = start;
      let bytes = 0;
      while (end < inputs.length && end - start < maxInputs) {
        const inputBytes = encoder.encode(inputs[end]!).byteLength;
        if (end > start && bytes + inputBytes > MAX_TEXT_BYTES) break;
        bytes += inputBytes;
        end += 1;
      }
      if (!this.current(item, noteId, epoch)) throw new StaleWork();
      this.status(`Embedding ${item.file.path}`);
      const vectors = await this.embeddings.embed(inputs.slice(start, end), fingerprint);
      if (!this.current(item, noteId, epoch)) throw new StaleWork();
      output.push(...vectors);
      start = end;
    }
    return output;
  }

  private current(item: WorkItem, noteId: string, epoch: number): boolean {
    return !this.stopped && this.state.indexingEnabled && (!item.profile || item.profile === this.embeddings.profile) && item.barrier === this.barrier && this.revisions.get(item.file.path) === item.revision && this.epochs.get(noteId) === epoch && this.pathPolicy.check(item.file.path).admitted;
  }

  private bump(noteId: string): number {
    const next = (this.epochs.get(noteId) ?? 0) + 1;
    this.epochs.set(noteId, next);
    return next;
  }

  private schedulePurge(noteId: string, forget: boolean, expectedRevision?: number): void {
    const manifest = this.state.notes[noteId];
    if (manifest) {
      manifest.servable = false;
      manifest.committed = false;
    }
    if (!this.state.pendingPurges.includes(noteId)) this.state.pendingPurges.push(noteId);
    const path = Object.entries(this.state.pathToNoteId).find(([, mappedId]) => mappedId === noteId)?.[0];
    const epoch = this.bump(noteId);
    if (path) {
      const pending = this.pending.get(path);
      if (expectedRevision !== undefined && pending && pending.revision !== expectedRevision) {
        pending.epoch = epoch;
      } else {
        this.revisions.set(path, (this.revisions.get(path) ?? 0) + 1);
        this.removePending(path);
      }
    }
    if (this.queuedPurges.has(noteId)) {
      const request = this.purgeQueue.find((request) => request.noteId === noteId);
      if (request) request.forget ||= forget;
      void this.persist();
      return;
    }
    this.queuedPurges.add(noteId);
    const intent = Promise.resolve(this.persist());
    this.purgeQueue.push({ noteId, forget, intent });
    this.schedule();
  }

  private async purge(request: PurgeRequest): Promise<void> {
    await request.intent;
    const generations = new Set<number>([this.state.activeGeneration, ...(this.state.knownGenerations ?? []), ...Object.values(this.state.notes).map((note) => note.generation)]);
    for (const generation of await this.weaviate.listGenerations()) {
      generations.add(generation);
      this.rememberGeneration(generation);
    }
    await this.persist();
    for (const generation of generations) await this.weaviate.deleteNote(generation, request.noteId);
    if (request.forget) {
      for (const [mappedPath, mappedId] of Object.entries(this.state.pathToNoteId)) if (mappedId === request.noteId) delete this.state.pathToNoteId[mappedPath];
      delete this.state.notes[request.noteId];
    } else {
      const manifest = this.state.notes[request.noteId];
      if (manifest) manifest.servable = false;
      if (manifest) manifest.committed = false;
    }
    this.state.pendingPurges = this.state.pendingPurges.filter((id) => id !== request.noteId);
    await this.persist();
    if (!this.failed) this.status("Purge complete");
  }

  private rememberGeneration(generation: number): void {
    if (!this.state.knownGenerations.includes(generation)) this.state.knownGenerations.push(generation);
  }
}


async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
