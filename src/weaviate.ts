import { localJson, LocalHttpError } from "./local-http";
import { DEFAULT_MODEL, type EmbeddingProfile } from "./embedding-config";
import { validateUnitVector } from "./embeddings";
import { PropertyRegistry, compileFilters } from "./properties";
import { NormalizedProperties, PropertyFilter, RegistryField, SearchResult, StoredNoteVector } from "./types";

export interface NoteObject {
  noteId: string;
  snapshotId: string;
  path: string;
  title: string;
  noteVectorMode: "direct" | "aggregated";
  vector: number[];
  properties: NormalizedProperties;
}

export interface PassageObject {
  passageId: string;
  passageIndex: number;
  noteId: string;
  snapshotId: string;
  path: string;
  title: string;
  heading: string;
  body: string;
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  vector: number[];
  properties: NormalizedProperties;
}

const graphqlEnumFields: Record<string, true> = { operator: true, fusionType: true, order: true };

function gql(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(gql).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.entries(record).map(([key, item]) => `${key}:${graphqlEnumFields[key] && typeof item === "string" ? item : gql(item)}`).join(",")}}`;
  }
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

function dataType(field: RegistryField): string[] {
  if (field.kind === "number") return ["number"];
  if (field.kind === "boolean") return ["boolean"];
  if (field.kind === "date") return ["date"];
  if (field.kind === "numberArray") return ["number[]"];
  if (field.kind === "booleanArray") return ["boolean[]"];
  if (field.kind === "dateArray") return ["date[]"];
  return field.kind === "textArray" ? ["text[]"] : ["text"];
}

function registryProperty(field: RegistryField): Record<string, unknown> {
  const property: Record<string, unknown> = { name: field.physicalName, dataType: dataType(field), indexFilterable: true, indexSearchable: false };
  if (field.kind === "text" || field.kind === "textArray" || field.kind === "json") property.tokenization = "field";
  return property;
}

const sharedProperties = [
  { name: "vaultId", dataType: ["text"], tokenization: "field", indexFilterable: true, indexSearchable: false },
  { name: "noteId", dataType: ["text"], tokenization: "field", indexFilterable: true, indexSearchable: false },
  { name: "snapshotId", dataType: ["text"], tokenization: "field", indexFilterable: true, indexSearchable: false },
  { name: "generation", dataType: ["int"], indexFilterable: true, indexSearchable: false },
  { name: "modelFingerprint", dataType: ["text"], tokenization: "field", indexFilterable: true, indexSearchable: false },
  { name: "path", dataType: ["text"], tokenization: "field", indexFilterable: true, indexSearchable: false },
  { name: "title", dataType: ["text"], tokenization: "word", indexFilterable: false, indexSearchable: true },
  { name: "tags", dataType: ["text[]"], tokenization: "field", indexFilterable: true, indexSearchable: false },
  { name: "tagAncestors", dataType: ["text[]"], tokenization: "field", indexFilterable: true, indexSearchable: false },
  { name: "frontmatterJson", dataType: ["text"], indexFilterable: false, indexSearchable: false },
  { name: "propertyKeys", dataType: ["text[]"], tokenization: "field", indexFilterable: true, indexSearchable: false },
  { name: "nullPropertyKeys", dataType: ["text[]"], tokenization: "field", indexFilterable: true, indexSearchable: false },
  { name: "emptyListPropertyKeys", dataType: ["text[]"], tokenization: "field", indexFilterable: true, indexSearchable: false },
];

export class WeaviateClient {
  constructor(private readonly config: () => { baseUrl: string; apiKey: string }, private readonly vaultId: string, private readonly getProfile: () => EmbeddingProfile = () => DEFAULT_MODEL) {
    if (!/^[A-Za-z0-9-]+$/.test(vaultId)) throw new Error("Invalid vault identity");
  }

  get profile(): EmbeddingProfile { return this.getProfile(); }

  private checkProfile(profile: EmbeddingProfile): void {
    if (profile !== this.profile) throw new Error("Embedding model changed during the local request");
  }

  private request<T>(path: string, method: "GET" | "POST" | "DELETE", body?: unknown): Promise<T> {
    const { baseUrl, apiKey } = this.config();
    return localJson<T>(baseUrl, apiKey, path, method, body);
  }

  async ready(): Promise<void> {
    await this.request("/v1/.well-known/ready", "GET");
  }

  classNames(generation: number): { notes: string; passages: string } {
    if (!Number.isSafeInteger(generation) || generation < 0) throw new Error("Invalid index generation");
    const vaultScope = this.vaultId.replace(/[^A-Za-z0-9]/g, "_");
    return { notes: `LocalSemantic_${vaultScope}_NotesG${generation}`, passages: `LocalSemantic_${vaultScope}_PassagesG${generation}` };
  }

  async ensureGeneration(generation: number, registry: PropertyRegistry): Promise<void> {
    const names = this.classNames(generation);
    const existing = new Map((await this.schema()).map((item) => [item.class, item]));
    const vectorConfig = { content: { vectorizer: { none: {} }, vectorIndexType: "hnsw", vectorIndexConfig: { distance: "cosine" } } };
    const noteProperties = [...sharedProperties, { name: "noteVectorMode", dataType: ["text"], tokenization: "field", indexFilterable: true, indexSearchable: false }, ...registry.all().map(registryProperty)];
    const passageProperties = [...sharedProperties, { name: "passageId", dataType: ["text"], tokenization: "field", indexFilterable: true, indexSearchable: false }, { name: "passageIndex", dataType: ["int"], indexFilterable: true, indexSearchable: false }, { name: "heading", dataType: ["text"], tokenization: "word", indexSearchable: true }, { name: "body", dataType: ["text"], tokenization: "word", indexSearchable: true }, ...["start", "end", "startLine", "endLine"].map((name) => ({ name, dataType: ["int"], indexFilterable: false, indexSearchable: false })), ...registry.all().map(registryProperty)];
    for (const [className, properties] of [[names.notes, noteProperties], [names.passages, passageProperties]] as const) {
      const current = existing.get(className);
      if (!current) {
        await this.request("/v1/schema", "POST", { class: className, vectorConfig, properties });
        continue;
      }
      const currentNames = new Set(current.properties?.map((property) => property.name) ?? []);
      for (const property of properties) {
        if (typeof property.name !== "string") throw new Error("Invalid generated property schema");
        if (!currentNames.has(property.name)) await this.request(`/v1/schema/${className}/properties`, "POST", property);
      }
    }
  }

  private async schema(): Promise<Array<{ class: string; properties?: Array<{ name: string }> }>> {
    const response = record(await this.request<unknown>("/v1/schema", "GET"));
    if (!Array.isArray(response.classes)) throw new Error("Weaviate returned an invalid schema");
    for (const raw of response.classes) {
      const item = record(raw);
      if (typeof item.class !== "string" || (item.properties !== undefined && !Array.isArray(item.properties))) throw new Error("Weaviate returned an invalid schema");
      if (Array.isArray(item.properties)) for (const property of item.properties) if (typeof record(property).name !== "string") throw new Error("Weaviate returned an invalid schema");
    }
    return response.classes;
  }

  async listGenerations(): Promise<number[]> {
    const prefix = `LocalSemantic_${this.vaultId.replace(/-/g, "_")}_`;
    const generations = new Set<number>();
    for (const item of await this.schema()) {
      if (!item.class.startsWith(prefix)) continue;
      const match = /^(?:Notes|Passages)G(0|[1-9][0-9]*)$/.exec(item.class.slice(prefix.length));
      if (match && Number.isSafeInteger(Number(match[1]))) generations.add(Number(match[1]));
    }
    return [...generations].sort((left, right) => left - right);
  }

  private baseProperties(noteId: string, snapshotId: string, generation: number, modelFingerprint: string, path: string, title: string, properties: NormalizedProperties): Record<string, unknown> {
    return { ...properties.fields, vaultId: this.vaultId, noteId, snapshotId, generation, modelFingerprint, path, title, tags: properties.tags, tagAncestors: properties.tagAncestors, frontmatterJson: properties.frontmatterJson, propertyKeys: properties.propertyKeys, nullPropertyKeys: properties.nullPropertyKeys, emptyListPropertyKeys: properties.emptyListPropertyKeys };
  }

  async replaceSnapshot(generation: number, modelFingerprint: string, note: NoteObject, passages: readonly PassageObject[]): Promise<void> {
    const profile = this.profile;
    const names = this.classNames(generation);
    knownFingerprint(modelFingerprint, profile);
    identity(note.noteId); identity(note.snapshotId);
    validateUnitVector(note.vector, profile.dimensions);
    text(note.path); text(note.title);
    validateProperties(note.properties);
    if (!Array.isArray(passages) || passages.length < 1 || passages.length > 4096 || !["direct", "aggregated"].includes(note.noteVectorMode)) throw new Error("Invalid paired snapshot");
    const passageIds = new Set<string>();
    const validatedProperties = new Set([note.properties]);
    for (const [index, passage] of passages.entries()) {
      identity(passage.passageId);
      if (passage.noteId !== note.noteId || passage.snapshotId !== note.snapshotId || passage.path !== note.path || passage.title !== note.title || passage.passageIndex !== index || passageIds.has(passage.passageId)) throw new Error("Passage identity does not match the note snapshot");
      validateUnitVector(passage.vector, profile.dimensions);
      if (!validatedProperties.has(passage.properties)) { validateProperties(passage.properties); validatedProperties.add(passage.properties); }
      passageFields(passage as unknown as Record<string, unknown>);
      if (![passage.start, passage.end].every((value) => Number.isSafeInteger(value) && value >= 0) || passage.end < passage.start) throw new Error("Invalid passage location");
      passageIds.add(passage.passageId);
    }
    await this.deleteNote(generation, note.noteId);
    this.checkProfile(profile);
    type BatchObject = { class: string; id: string; properties: Record<string, unknown>; vectors: { content: number[] } };
    let objects: BatchObject[] = [];
    let bytes = 0;
    const flush = async (): Promise<void> => {
      if (objects.length === 0) return;
      this.checkProfile(profile);
      const response = await this.request<unknown>("/v1/batch/objects", "POST", { objects });
      this.checkProfile(profile);
      if (!Array.isArray(response) || response.length !== objects.length) throw new Error("Weaviate rejected part of the paired snapshot");
      const expected = new Map(objects.map((item) => [item.id, item.class]));
      for (const raw of response) {
        const item = record(raw);
        const result = record(item.result);
        if (typeof item.id !== "string" || expected.get(item.id) !== item.class || result.status !== "SUCCESS" || result.errors) throw new Error("Weaviate rejected part of the paired snapshot");
        expected.delete(item.id);
      }
      if (expected.size) throw new Error("Weaviate omitted a snapshot write");
      objects = []; bytes = 0;
    };
    const append = async (object: BatchObject): Promise<void> => {
      const size = Buffer.byteLength(JSON.stringify(object));
      if (size > 6 * 1024 * 1024) throw new Error("Snapshot object exceeds the local write limit");
      if (objects.length >= 32 || bytes + size > 6 * 1024 * 1024) await flush();
      objects.push(object); bytes += size;
    };
    await append({ class: names.notes, id: await deterministicId(`${this.vaultId}\0${note.noteId}\0${note.snapshotId}\0note`), properties: { ...this.baseProperties(note.noteId, note.snapshotId, generation, modelFingerprint, note.path, note.title, note.properties), noteVectorMode: note.noteVectorMode }, vectors: { content: note.vector } });
    for (const passage of passages) {
      await append({ class: names.passages, id: await deterministicId(`${this.vaultId}\0${note.noteId}\0${note.snapshotId}\0${passage.passageId}`), properties: { ...this.baseProperties(note.noteId, note.snapshotId, generation, modelFingerprint, note.path, note.title, passage.properties), passageId: passage.passageId, passageIndex: passage.passageIndex, heading: passage.heading, body: passage.body, start: passage.start, end: passage.end, startLine: passage.startLine, endLine: passage.endLine }, vectors: { content: passage.vector } });
    }
    await flush();
    const where = this.noteWhere(generation, note.noteId);
    const fields = "vaultId generation modelFingerprint noteId snapshotId";
    const data = await this.graphql(`{Get{${names.notes}(where:${gql(where)},limit:2){${fields}} ${names.passages}(where:${gql(where)},limit:4097){${fields} passageId passageIndex}}}`);
    this.checkProfile(profile);
    const notes = rows(data, names.notes, 2);
    const stored = rows(data, names.passages, 4097);
    if (notes.length !== 1 || stored.length !== passages.length) throw new Error("Paired snapshot is incomplete after writing");
    this.checkIdentity(notes[0]!, generation, modelFingerprint, note.noteId, note.snapshotId);
    const found = new Set<string>();
    for (const item of stored) {
      this.checkIdentity(item, generation, modelFingerprint, note.noteId, note.snapshotId);
      const id = text(item.passageId);
      if (!passageIds.has(id) || found.has(id) || !Number.isSafeInteger(item.passageIndex) || passages[Number(item.passageIndex)]?.passageId !== id) throw new Error("Paired passage snapshot is inconsistent");
      found.add(id);
    }
  }

  async deleteNote(generation: number, noteId: string): Promise<void> {
    identity(noteId);
    const names = this.classNames(generation);
    const existing = new Set((await this.schema()).map((item) => item.class));
    const where = { operator: "And", operands: [{ path: ["vaultId"], operator: "Equal", valueText: this.vaultId }, { path: ["noteId"], operator: "Equal", valueText: noteId }] };
    for (const className of [names.notes, names.passages]) {
      if (!existing.has(className)) continue;
      let empty = false;
      for (let batch = 0; batch < 128; batch += 1) {
        const response = record(await this.request<unknown>("/v1/batch/objects", "DELETE", { match: { class: className, where }, output: "minimal", dryRun: false }));
        const result = record(response.results);
        const { matches, successful, failed } = result;
        if (![matches, successful, failed].every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0) || Number(failed) !== 0 || Number(successful) > Number(matches) || (Number(matches) > 0 && Number(successful) === 0)) throw new Error("Weaviate failed to purge a note completely");
        const data = await this.graphql(`{Get{${className}(where:${gql(where)},limit:1){noteId}}}`);
        if (rows(data, className, 1).length === 0) { empty = true; break; }
        if (Number(matches) === 0) throw new Error("Weaviate purge result disagrees with stored objects");
      }
      if (!empty) throw new Error("Weaviate purge did not converge");
    }
  }

  async dropGeneration(generation: number): Promise<void> {
    const names = this.classNames(generation);
    const existing = new Set((await this.schema()).map((item) => item.class));
    for (const className of [names.notes, names.passages]) {
      if (!existing.has(className)) continue;
      try { await this.request(`/v1/schema/${className}`, "DELETE"); }
      catch (error) { if (!(error instanceof LocalHttpError && error.status === 404)) throw error; }
    }
  }

  private noteWhere(generation: number, noteId: string, snapshotId?: string, fingerprint?: string): Record<string, unknown> {
    const operands: Record<string, unknown>[] = [
      { path: ["vaultId"], operator: "Equal", valueText: this.vaultId },
      { path: ["generation"], operator: "Equal", valueInt: generation },
      { path: ["noteId"], operator: "Equal", valueText: noteId },
    ];
    if (snapshotId !== undefined) operands.push({ path: ["snapshotId"], operator: "Equal", valueText: snapshotId });
    if (fingerprint !== undefined) operands.push({ path: ["modelFingerprint"], operator: "Equal", valueText: fingerprint });
    return { operator: "And", operands };
  }

  private checkIdentity(item: Record<string, unknown>, generation: number, fingerprint: string, noteId?: string, snapshotId?: string): void {
    if (item.vaultId !== this.vaultId || item.generation !== generation || item.modelFingerprint !== fingerprint || (noteId !== undefined && item.noteId !== noteId) || (snapshotId !== undefined && item.snapshotId !== snapshotId)) throw new Error("Weaviate returned a mismatched snapshot identity");
    identity(item.noteId); identity(item.snapshotId);
  }

  async noteVectors(generation: number, fingerprint: string, snapshots: readonly { noteId: string; snapshotId: string }[]): Promise<StoredNoteVector[]> {
    const profile = this.profile;
    const className = this.classNames(generation).notes;
    knownFingerprint(fingerprint, profile);
    if (!Array.isArray(snapshots) || snapshots.length < 1 || snapshots.length > 31) throw new Error("Graph retrieval requires 1 to 31 snapshot keys");
    const expected = new Map<string, string>();
    const operands = snapshots.map((snapshot) => {
      identity(snapshot.noteId); identity(snapshot.snapshotId);
      if (expected.has(snapshot.noteId)) throw new Error("Graph snapshot keys must identify distinct notes");
      expected.set(snapshot.noteId, snapshot.snapshotId);
      return { operator: "And", operands: [{ path: ["noteId"], operator: "Equal", valueText: snapshot.noteId }, { path: ["snapshotId"], operator: "Equal", valueText: snapshot.snapshotId }] };
    });
    const base = this.where(generation, fingerprint, [], new PropertyRegistry());
    (base.operands as Record<string, unknown>[]).push(operands.length === 1 ? operands[0]! : { operator: "Or", operands });
    const data = await this.graphql(`{Get{${className}(where:${gql(base)},limit:${snapshots.length}){vaultId generation modelFingerprint noteId snapshotId _additional{vectors{content}}}}}`);
    this.checkProfile(profile);
    const items = rows(data, className, snapshots.length);
    if (items.length !== snapshots.length) throw new Error("Graph note vector set is incomplete");
    const vectors = new Map<string, StoredNoteVector>();
    for (const item of items) {
      this.checkIdentity(item, generation, fingerprint);
      const noteId = text(item.noteId);
      const snapshotId = text(item.snapshotId);
      if (expected.get(noteId) !== snapshotId || vectors.has(noteId)) throw new Error("Graph note vector identity is inconsistent");
      vectors.set(noteId, { noteId, snapshotId, vector: contentVector(item, profile.dimensions) });
    }
    return snapshots.map((snapshot) => vectors.get(snapshot.noteId)!);
  }

  async loadSnapshot(generation: number, noteId: string, snapshotId: string, fingerprint = this.profile.modelFingerprint, expectedPassageIds?: readonly string[]): Promise<{ note: NoteObject; passages: PassageObject[] }> {
    const profile = this.profile;
    const names = this.classNames(generation);
    knownFingerprint(fingerprint, profile); identity(noteId); identity(snapshotId);
    const where = this.noteWhere(generation, noteId, snapshotId, fingerprint);
    const fields = "vaultId generation modelFingerprint noteId snapshotId path title tags tagAncestors frontmatterJson propertyKeys nullPropertyKeys emptyListPropertyKeys";
    const notesData = await this.graphql(`{Get{${names.notes}(where:${gql(where)},limit:2){${fields} noteVectorMode _additional{vectors{content}}}}}`);
    this.checkProfile(profile);
    const storedNotes = rows(notesData, names.notes, 2);
    if (storedNotes.length !== 1) throw new Error("Published note vector is unavailable for metadata reuse");
    const rawNote = storedNotes[0]!;
    this.checkIdentity(rawNote, generation, fingerprint, noteId, snapshotId);
    if (rawNote.noteVectorMode !== "direct" && rawNote.noteVectorMode !== "aggregated") throw new Error("Stored note vector mode is invalid");
    const properties = await storedProperties(rawNote);
    this.checkProfile(profile);
    const note: NoteObject = { noteId, snapshotId, path: text(rawNote.path), title: text(rawNote.title), noteVectorMode: rawNote.noteVectorMode, vector: contentVector(rawNote, profile.dimensions), properties };
    const passages: PassageObject[] = [];
    const ids = new Set<string>();
    for (let offset = 0; offset <= 4096; offset += 64) {
      const data = await this.graphql(`{Get{${names.passages}(where:${gql(where)},limit:64,offset:${offset},sort:[{path:["passageIndex"],order:asc}]){vaultId generation modelFingerprint noteId snapshotId path title passageId passageIndex heading body start end startLine endLine _additional{vectors{content}}}}}`);
      this.checkProfile(profile);
      const page = rows(data, names.passages, 64);
      for (const item of page) {
        this.checkIdentity(item, generation, fingerprint, noteId, snapshotId);
        const passage = passageFields(item);
        if (ids.has(passage.passageId) || item.passageIndex !== passages.length || item.path !== note.path || item.title !== note.title || !Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end) || Number(item.start) < 0 || Number(item.end) < Number(item.start) || (expectedPassageIds && expectedPassageIds[passages.length] !== passage.passageId)) throw new Error("Stored passage snapshot is inconsistent");
        ids.add(passage.passageId);
        passages.push({ ...passage, passageIndex: Number(item.passageIndex), noteId, snapshotId, path: note.path, title: note.title, start: Number(item.start), end: Number(item.end), vector: contentVector(item, profile.dimensions), properties });
      }
      if (passages.length > 4096) throw new Error("Stored snapshot exceeds the passage limit");
      if (page.length < 64) break;
    }
    if (passages.length === 0 || (expectedPassageIds && passages.length !== expectedPassageIds.length)) throw new Error("Stored passage snapshot is incomplete");
    return { note, passages };
  }

  async passagesForNote(generation: number, noteId: string, snapshotId: string, fingerprint = this.profile.modelFingerprint): Promise<SearchResult["passages"]> {
    const profile = this.profile;
    const className = this.classNames(generation).passages;
    knownFingerprint(fingerprint, profile); identity(noteId); identity(snapshotId);
    const where = this.noteWhere(generation, noteId, snapshotId, fingerprint);
    const data = await this.graphql(`{Get{${className}(where:${gql(where)},limit:4097,sort:[{path:["passageIndex"],order:asc}]){vaultId generation modelFingerprint noteId snapshotId passageIndex passageId heading body startLine endLine}}}`);
    this.checkProfile(profile);
    const items = rows(data, className, 4096);
    const ids = new Set<string>();
    return items.map((item, index) => {
      this.checkIdentity(item, generation, fingerprint, noteId, snapshotId);
      const passage = passageFields(item);
      if (item.passageIndex !== index || ids.has(passage.passageId)) throw new Error("Stored passage order is invalid");
      ids.add(passage.passageId);
      return passage;
    });
  }

  private where(generation: number, fingerprint: string, filters: readonly PropertyFilter[], registry: PropertyRegistry, excludeNoteId?: string): Record<string, unknown> {
    const operands: Record<string, unknown>[] = [
      { path: ["vaultId"], operator: "Equal", valueText: this.vaultId },
      { path: ["generation"], operator: "Equal", valueInt: generation },
      { path: ["modelFingerprint"], operator: "Equal", valueText: fingerprint },
    ];
    if (excludeNoteId) operands.push({ path: ["noteId"], operator: "NotEqual", valueText: excludeNoteId });
    const compiled = compileFilters(registry, filters);
    if (compiled) operands.push(compiled);
    return { operator: "And", operands };
  }

  async connections(generation: number, fingerprint: string, vector: number[], referenceNoteId: string, filters: readonly PropertyFilter[], registry: PropertyRegistry, limit = 90): Promise<SearchResult[]> {
    validateUnitVector(vector, this.profile.dimensions);
    return this.connectionCandidates(generation, fingerprint, `nearVector:${gql({ vector, targetVectors: ["content"] })}`, referenceNoteId, filters, registry, limit);
  }

  async connectionsForNote(generation: number, fingerprint: string, noteId: string, snapshotId: string, filters: readonly PropertyFilter[], registry: PropertyRegistry, limit = 90): Promise<SearchResult[]> {
    const profile = this.profile;
    knownFingerprint(fingerprint, profile);
    identity(noteId); identity(snapshotId);
    const id = await deterministicId(`${this.vaultId}\0${noteId}\0${snapshotId}\0note`);
    this.checkProfile(profile);
    return this.connectionCandidates(generation, fingerprint, `nearObject:${gql({ id, targetVectors: ["content"] })}`, noteId, filters, registry, limit);
  }

  async connectionsForPassage(generation: number, fingerprint: string, noteId: string, snapshotId: string, passageId: string, filters: readonly PropertyFilter[], registry: PropertyRegistry, limit = 90): Promise<SearchResult[]> {
    const profile = this.profile;
    knownFingerprint(fingerprint, profile);
    identity(noteId); identity(snapshotId); identity(passageId);
    const className = this.classNames(generation).passages;
    const id = await deterministicId(`${this.vaultId}\0${noteId}\0${snapshotId}\0${passageId}`);
    this.checkProfile(profile);
    const window = candidateLimit(limit);
    const near = `nearObject:${gql({ id, targetVectors: ["content"] })}`;
    const data = await this.graphql(`{Get{${className}(${near},where:${gql(this.where(generation, fingerprint, filters, registry, noteId))},limit:${window}){vaultId generation modelFingerprint noteId path title snapshotId passageId heading body startLine endLine _additional{distance}}}}`);
    this.checkProfile(profile);
    const snapshots = new Map<string, string>();
    const passages = new Set<string>();
    return rows(data, className, window).map((item): SearchResult => {
      this.checkIdentity(item, generation, fingerprint);
      const candidateNoteId = text(item.noteId);
      if (candidateNoteId === noteId) throw new Error("Weaviate returned the excluded reference note");
      const candidateSnapshotId = text(item.snapshotId);
      const previousSnapshot = snapshots.get(candidateNoteId);
      if (previousSnapshot && previousSnapshot !== candidateSnapshotId) throw new Error("Weaviate returned competing passage snapshots");
      snapshots.set(candidateNoteId, candidateSnapshotId);
      const passage = passageFields(item);
      const key = `${candidateNoteId}\0${passage.passageId}`;
      if (passages.has(key)) throw new Error("Weaviate returned a duplicate passage");
      passages.add(key);
      const rawScore = 1 - additionalNumber(item, "distance");
      if (rawScore < -1.0001 || rawScore > 1.0001) throw new Error("Weaviate returned an invalid similarity");
      const score = Math.max(-1, Math.min(1, rawScore));
      return { noteId: candidateNoteId, path: text(item.path), title: text(item.title), snapshotId: candidateSnapshotId, score, scoreKind: "similarity", passages: [passage] };
    }).sort(rank);
  }

  private async connectionCandidates(generation: number, fingerprint: string, near: string, referenceNoteId: string, filters: readonly PropertyFilter[], registry: PropertyRegistry, limit: number): Promise<SearchResult[]> {
    const profile = this.profile;
    const className = this.classNames(generation).notes;
    knownFingerprint(fingerprint, profile); identity(referenceNoteId);
    const window = candidateLimit(limit);
    const data = await this.graphql(`{Get{${className}(${near},where:${gql(this.where(generation, fingerprint, filters, registry, referenceNoteId))},limit:${window}){vaultId generation modelFingerprint noteId path title snapshotId _additional{distance}}}}`);
    this.checkProfile(profile);
    const grouped = new Map<string, SearchResult>();
    for (const item of rows(data, className, window)) {
      this.checkIdentity(item, generation, fingerprint);
      const noteId = text(item.noteId);
      if (noteId === referenceNoteId) throw new Error("Weaviate returned the excluded reference note");
      const rawScore = 1 - additionalNumber(item, "distance");
      if (rawScore < -1.0001 || rawScore > 1.0001) throw new Error("Weaviate returned an invalid similarity");
      const score = Math.max(-1, Math.min(1, rawScore));
      const result: SearchResult = { noteId, path: text(item.path), title: text(item.title), snapshotId: text(item.snapshotId), score, scoreKind: "similarity", passages: [] };
      const existing = grouped.get(noteId);
      if (existing && existing.snapshotId !== result.snapshotId) throw new Error("Weaviate returned competing note snapshots");
      if (!existing || result.score > existing.score) grouped.set(noteId, result);
    }
    return [...grouped.values()].sort(rank);
  }

  async hybrid(generation: number, fingerprint: string, textQuery: string, vector: number[], filters: readonly PropertyFilter[], registry: PropertyRegistry, limit = 300): Promise<SearchResult[]> {
    const profile = this.profile;
    const className = this.classNames(generation).passages;
    knownFingerprint(fingerprint, profile); validateUnitVector(vector, profile.dimensions);
    if (typeof textQuery !== "string" || Buffer.byteLength(textQuery) > 4 * 1024 * 1024) throw new Error("Invalid hybrid query");
    const window = candidateLimit(limit);
    const hybrid = { query: textQuery, vector, alpha: 0.5, fusionType: "relativeScoreFusion", targetVectors: ["content"], properties: ["title^2", "heading", "body"] };
    // Recompute the whole bounded window: relative fusion scores from different windows cannot be merged.
    const data = await this.graphql(`{Get{${className}(hybrid:${gql(hybrid)},where:${gql(this.where(generation, fingerprint, filters, registry))},limit:${window}){vaultId generation modelFingerprint noteId path title snapshotId passageId heading body startLine endLine _additional{score}}}}`);
    this.checkProfile(profile);
    const items = rows(data, className, window).map((item) => {
      this.checkIdentity(item, generation, fingerprint);
      return { item, score: additionalNumber(item, "score"), passage: passageFields(item) };
    }).sort((left, right) => right.score - left.score || compare(text(left.item.noteId), text(right.item.noteId)) || compare(left.passage.passageId, right.passage.passageId));
    const grouped = new Map<string, SearchResult>();
    const ids = new Set<string>();
    for (const [retrievalRank, { item, score, passage }] of items.entries()) {
      passage.retrievalScore = score;
      passage.retrievalRank = retrievalRank;
      const noteId = text(item.noteId);
      const key = `${noteId}\0${passage.passageId}`;
      if (ids.has(key)) throw new Error("Weaviate returned a duplicate passage");
      ids.add(key);
      const existing = grouped.get(noteId);
      if (existing) {
        if (existing.snapshotId !== item.snapshotId || existing.path !== item.path || existing.title !== item.title) throw new Error("Weaviate returned competing passage snapshots");
        existing.passages.push(passage);
      } else grouped.set(noteId, { noteId, path: text(item.path), title: text(item.title), snapshotId: text(item.snapshotId), score, scoreKind: "hybrid", passages: [passage] });
    }
    return [...grouped.values()].sort(rank);
  }

  private async graphql(query: string): Promise<Record<string, unknown>> {
    const response = record(await this.request<unknown>("/v1/graphql", "POST", { query }));
    if (response.errors !== undefined && (!Array.isArray(response.errors) || response.errors.length > 0)) throw new Error("Weaviate rejected the local query");
    return record(record(response.data).Get);
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Weaviate returned an invalid response");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Weaviate returned an invalid text field");
  return value;
}
function identity(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.length > 512 || value.includes("\0")) throw new Error("Invalid snapshot identity");
}
function knownFingerprint(value: string, profile: EmbeddingProfile): void {
  if (value !== profile.modelFingerprint) throw new Error("Incompatible stored model fingerprint");
}
function rows(data: Record<string, unknown>, className: string, limit: number): Array<Record<string, unknown>> {
  const value = data[className];
  if (!Array.isArray(value) || value.length > limit) throw new Error("Weaviate returned invalid query rows");
  for (const item of value) record(item);
  return value;
}
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("Weaviate returned invalid metadata");
  return value;
}
async function storedProperties(item: Record<string, unknown>): Promise<NormalizedProperties> {
  const frontmatterJson = text(item.frontmatterJson);
  let normalized: NormalizedProperties;
  try { normalized = await new PropertyRegistry().normalize(record(JSON.parse(frontmatterJson))); }
  catch { throw new Error("Stored note metadata is invalid"); }
  return { ...normalized, frontmatterJson, propertyKeys: stringArray(item.propertyKeys), nullPropertyKeys: stringArray(item.nullPropertyKeys), emptyListPropertyKeys: stringArray(item.emptyListPropertyKeys), tags: stringArray(item.tags), tagAncestors: stringArray(item.tagAncestors) };
}
function validateProperties(properties: NormalizedProperties): void {
  text(properties.frontmatterJson);
  try { record(JSON.parse(properties.frontmatterJson)); }
  catch { throw new Error("Invalid snapshot metadata"); }
  for (const values of [properties.propertyKeys, properties.nullPropertyKeys, properties.emptyListPropertyKeys, properties.tags, properties.tagAncestors]) stringArray(values);
  for (const [name, value] of Object.entries(record(properties.fields))) {
    if (!/^p_[a-z0-9_]+$/.test(name)) throw new Error("Invalid snapshot property field");
    const values = Array.isArray(value) ? value : [value];
    if (values.some((item) => !["string", "number", "boolean"].includes(typeof item) || (typeof item === "number" && !Number.isFinite(item)))) throw new Error("Invalid snapshot property value");
  }
  if (Buffer.byteLength(JSON.stringify(properties)) > 4 * 1024 * 1024) throw new Error("Snapshot metadata exceeds the local write limit");
}
function passageFields(item: Record<string, unknown>): SearchResult["passages"][number] {
  identity(item.passageId);
  if (!Number.isSafeInteger(item.startLine) || !Number.isSafeInteger(item.endLine) || Number(item.startLine) < 0 || Number(item.endLine) < Number(item.startLine)) throw new Error("Weaviate returned an invalid passage location");
  return { passageId: item.passageId, heading: text(item.heading), body: text(item.body), startLine: Number(item.startLine), endLine: Number(item.endLine) };
}
function additionalNumber(item: Record<string, unknown>, key: string): number {
  const value = record(item._additional)[key];
  if ((typeof value !== "number" && (typeof value !== "string" || !value.trim())) || !Number.isFinite(Number(value))) throw new Error("Weaviate returned an invalid score");
  return Number(value);
}
function contentVector(item: Record<string, unknown>, dimensions: number): number[] {
  const vector = record(record(item._additional).vectors).content;
  validateUnitVector(vector, dimensions);
  return vector;
}
function candidateLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid search candidate limit");
  return Math.min(limit, 1200);
}
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function rank(left: SearchResult, right: SearchResult): number { return right.score - left.score || compare(left.noteId, right.noteId); }

async function deterministicId(value: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  const text = Array.from(hash.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}
