import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { DEFAULT_MODEL, EMBEDDING_MODELS, type EmbeddingProfile } from "../src/embedding-config";
import { localJson, validateLoopbackBaseUrl } from "../src/local-http";
import { PropertyRegistry } from "../src/properties";
import { WeaviateClient, type NoteObject, type PassageObject } from "../src/weaviate";

const vector = [1, ...new Array<number>(DEFAULT_MODEL.dimensions - 1).fill(0)];
const vaultId = "synthetic-vault";
const identity = { vaultId, generation: 1, modelFingerprint: DEFAULT_MODEL.modelFingerprint, noteId: "note-a", snapshotId: "snapshot-a" };

async function withBackend(handler: (request: IncomingMessage, body: Record<string, unknown>, response: ServerResponse) => unknown | Promise<unknown>, run: (url: string) => Promise<void>): Promise<void> {
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const source = Buffer.concat(chunks).toString("utf8");
      const result = await handler(request, source ? JSON.parse(source) as Record<string, unknown> : {}, response);
      if (!response.writableEnded) { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(result)); }
    } catch { response.statusCode = 500; response.end("synthetic backend failure"); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

function client(url: string): WeaviateClient { return new WeaviateClient(() => ({ baseUrl: url, apiKey: "synthetic-key" }), vaultId); }

test("local transport rejects aliases, credentials and URL decoration before sending input", async () => {
  for (const url of ["https://127.0.0.1:8080", "http://localhost:8080", "http://127.1:8080", "http://2130706433:8080", "http://127.0.0.2:8080", "http://user:secret@127.0.0.1:8080", "http://127.0.0.1:8080/private", "http://127.0.0.1:8080?key=secret", "http://127.0.0.1:8080#private", "http://127.0.0.1:0", "http://[::ffff:127.0.0.1]:8080"]) {
    await assert.rejects(localJson(url, "synthetic-key", "/embed", "POST", { input: ["synthetic note"] }));
  }
  assert.equal(validateLoopbackBaseUrl("http://[::1]:8080").hostname, "[::1]");
});

test("redirects are not followed and backend error text never escapes", async () => {
  let requests = 0;
  await withBackend((request, _body, response) => {
    requests += 1;
    response.statusCode = request.url === "/redirect" ? 307 : 500;
    response.setHeader("Location", `http://${request.headers.host}/leaked`);
    return { error: "SECRET NOTE synthetic-key" };
  }, async (url) => {
    for (const path of ["/redirect", "/failure"]) {
      await assert.rejects(localJson(url, "synthetic-key", path, "POST", { text: "SECRET NOTE" }), (error: unknown) => error instanceof Error && !error.message.includes("SECRET") && !error.message.includes("synthetic-key"));
    }
  });
  assert.equal(requests, 2);
});


test("graph vectors reject partial, foreign and malformed exact-snapshot responses", async () => {
  const second = { ...identity, noteId: "note-b", snapshotId: "snapshot-b" };
  const firstRow = { ...identity, _additional: { vectors: { content: vector } } };
  const secondRow = { ...second, _additional: { vectors: { content: vector } } };
  let stored: unknown[] = [secondRow, firstRow];
  await withBackend(() => ({ data: { Get: { LocalSemantic_synthetic_vault_NotesG1: stored } } }), async (url) => {
    const database = client(url);
    const keys = [identity, second];
    assert.deepEqual((await database.noteVectors(1, DEFAULT_MODEL.modelFingerprint, keys)).map((item) => item.noteId), ["note-a", "note-b"]);
    for (const corrupted of [
      [firstRow],
      [firstRow, firstRow],
      [firstRow, { ...secondRow, vaultId: "another-vault" }],
      [firstRow, { ...secondRow, generation: 2 }],
      [firstRow, { ...secondRow, snapshotId: "retired-snapshot" }],
      [firstRow, { ...secondRow, modelFingerprint: "foreign-model" }],
      [firstRow, { ...secondRow, _additional: { vectors: { content: vector.map(() => 0) } } }],
    ]) {
      stored = corrupted;
      await assert.rejects(database.noteVectors(1, DEFAULT_MODEL.modelFingerprint, keys));
    }
  });
});

test("model selection rejects late and foreign vectors even when both models have the same width", async () => {
  let profile: EmbeddingProfile = DEFAULT_MODEL;
  let storedFingerprint = profile.modelFingerprint;
  let received!: () => void;
  const started = new Promise<void>((resolve) => { received = resolve; });
  let release!: () => void;
  const responseReady = new Promise<void>((resolve) => { release = resolve; });
  await withBackend(async () => {
    const fingerprint = storedFingerprint;
    received();
    await responseReady;
    return { data: { Get: { LocalSemantic_synthetic_vault_NotesG1: [{ ...identity, modelFingerprint: fingerprint, _additional: { vectors: { content: vector } } }] } } };
  }, async (url) => {
    const database = new WeaviateClient(() => ({ baseUrl: url, apiKey: "synthetic-key" }), vaultId, () => profile);
    const rejected = assert.rejects(database.noteVectors(1, profile.modelFingerprint, [identity]), /model changed/);
    await started;
    profile = EMBEDDING_MODELS[1]!;
    release();
    await rejected;
    await assert.rejects(database.noteVectors(1, DEFAULT_MODEL.modelFingerprint, [identity]), /fingerprint/);
    await assert.rejects(database.noteVectors(1, profile.modelFingerprint, [identity]), /identity/);
    storedFingerprint = profile.modelFingerprint;
    assert.deepEqual(await database.noteVectors(1, profile.modelFingerprint, [identity]), [{ noteId: identity.noteId, snapshotId: identity.snapshotId, vector }]);
  });
});

test("hybrid grouping retains the best real passage score with deterministic note ties", async () => {
  const hit = (noteId: string, passageId: string, score: string) => ({ ...identity, noteId, path: `${noteId}.md`, title: noteId, passageId, heading: "", body: passageId, startLine: 0, endLine: 0, _additional: { score } });
  await withBackend(() => ({ data: { Get: { LocalSemantic_synthetic_vault_PassagesG1: [hit("note-b", "low", "0.1"), hit("note-b", "best", "0.9"), hit("note-a", "tied", "0.9")] } } }), async (url) => {
    const results = await client(url).hybrid(1, DEFAULT_MODEL.modelFingerprint, "synthetic query", vector, [], new PropertyRegistry(), 1200);
    assert.deepEqual(results.map((item) => [item.noteId, item.score]), [["note-a", 0.9], ["note-b", 0.9]]);
    assert.deepEqual(results[1]?.passages.map((item) => item.passageId), ["best", "low"]);
  });
});

test("hybridDetailed preserves flat passage provenance while legacy hybrid projection stays identical", async () => {
  const hit = (noteId: string, passageId: string, score: string) => ({
    ...identity,
    noteId,
    snapshotId: `snapshot-${noteId}`,
    path: `${noteId}.md`,
    title: `Stored ${noteId}`,
    passageId,
    heading: "Section",
    body: `Body ${passageId}`,
    startLine: 2,
    endLine: 4,
    _additional: { score },
  });
  const rows = [hit("note-b", "low", "0.1"), hit("note-b", "best", "0.9"), hit("note-a", "tied", "0.9")];
  await withBackend(() => ({ data: { Get: { LocalSemantic_synthetic_vault_PassagesG1: rows } } }), async (url) => {
    const database = client(url);
    const registry = new PropertyRegistry();
    const detailed = await database.hybridDetailed(1, DEFAULT_MODEL.modelFingerprint, "synthetic query", vector, [], registry, 300);
    const legacy = await database.hybrid(1, DEFAULT_MODEL.modelFingerprint, "synthetic query", vector, [], registry, 300);
    assert.deepEqual(detailed.notes.map(candidate => candidate.result), legacy);
    assert.deepEqual(detailed.passages.map(passage => [passage.noteId, passage.passageId, passage.retrievalScore, passage.retrievalRank]), [
      ["note-a", "tied", 0.9, 0],
      ["note-b", "best", 0.9, 1],
      ["note-b", "low", 0.1, 2],
    ]);
    assert.deepEqual(detailed.notes.map(candidate => [candidate.result.noteId, candidate.noteRank, candidate.passages.map(passage => passage.passageId)]), [
      ["note-a", 0, ["tied"]],
      ["note-b", 1, ["best", "low"]],
    ]);
  });
});

test("passage connections retain global cosine order for strongest-per-note admission", async () => {
  const hit = (noteId: string, passageId: string, distance: number) => ({
    ...identity,
    noteId,
    snapshotId: `snapshot-${noteId}`,
    path: `${noteId}.md`,
    title: noteId,
    passageId,
    heading: "Section",
    body: passageId,
    startLine: 2,
    endLine: 3,
    _additional: { distance },
  });
  let stored = [hit("note-b", "b-low", 0.8), hit("note-c", "c", 0.1), hit("note-b", "b-best", 0.1)];
  let query = "";
  await withBackend((_request, body) => {
    query = String(body.query);
    return { data: { Get: { LocalSemantic_synthetic_vault_PassagesG1: stored } } };
  }, async (url) => {
    const database = client(url);
    const results = await database.connectionsForPassage(1, DEFAULT_MODEL.modelFingerprint, identity.noteId, identity.snapshotId, "source-passage", [], new PropertyRegistry(), 90);
    assert.deepEqual(results.map((result) => [result.noteId, result.score, result.passages[0]?.passageId]), [
      ["note-b", 0.9, "b-best"],
      ["note-c", 0.9, "c"],
      ["note-b", 0.19999999999999996, "b-low"],
    ]);
    assert.match(query, /PassagesG1\(nearObject:/);
    assert.match(query, /operator:NotEqual,valueText:"note-a"/);
    stored = [hit("note-a", "same-note", 0.1)];
    await assert.rejects(database.connectionsForPassage(1, DEFAULT_MODEL.modelFingerprint, identity.noteId, identity.snapshotId, "source-passage", [], new PropertyRegistry()), /excluded reference note/);
  });
});

test("purge confirms exhaustion, rejects dishonest results and tolerates absent collections", async () => {
  const className = "LocalSemantic_synthetic_vault_NotesG1";
  let remaining = 3;
  let result: unknown;
  let present = true;
  await withBackend((request) => {
    if (request.url === "/v1/schema") return { classes: present ? [{ class: className }] : [] };
    if (request.method === "DELETE") {
      if (result !== undefined) return result;
      const matches = remaining;
      const successful = Math.min(2, remaining);
      remaining -= successful;
      return { results: { matches, successful, failed: 0 } };
    }
    return { data: { Get: { [className]: remaining ? [{ noteId: identity.noteId }] : [] } } };
  }, async (url) => {
    const database = client(url);
    await database.deleteNote(1, identity.noteId);
    assert.equal(remaining, 0);
    remaining = 1;
    result = { results: { matches: 0, successful: 0, failed: 0 } };
    await assert.rejects(database.deleteNote(1, identity.noteId), /disagrees/);
    result = { results: { matches: 1, successful: 0, failed: 1 } };
    await assert.rejects(database.deleteNote(1, identity.noteId), /purge/);
    result = {};
    await assert.rejects(database.deleteNote(1, identity.noteId), /invalid response/);
    present = false;
    await database.deleteNote(1, identity.noteId);
    assert.equal(remaining, 1);
  });
});

test("generation discovery excludes other vaults and unrelated collection names", async () => {
  await withBackend(() => ({ classes: ["LocalSemantic_synthetic_vault_NotesG1", "LocalSemantic_synthetic_vault_PassagesG2", "LocalSemantic_synthetic_vault_NotesG2", "LocalSemantic_other_vault_NotesG9", "LocalSemantic_synthetic_vault_extra_NotesG3"].map((name) => ({ class: name })) }), async (url) => {
    assert.deepEqual(await client(url).listGenerations(), [1, 2]);
  });
});

test("paired writes remain unpublished when the backend omits a passage", async () => {
  const properties = await new PropertyRegistry().normalize({ priority: 1 });
  const note: NoteObject = { noteId: identity.noteId, snapshotId: identity.snapshotId, path: "synthetic.md", title: "synthetic", noteVectorMode: "direct", vector, properties };
  const passages: PassageObject[] = Array.from({ length: 33 }, (_, index) => ({ ...note, passageId: `passage-${index}`, passageIndex: index, heading: "", body: "synthetic", start: index * 9, end: (index + 1) * 9, startLine: index, endLine: index + 1 }));
  let stored: Array<Record<string, unknown>> = [];
  await withBackend((request, body) => {
    if (request.url === "/v1/schema") return { classes: [] };
    if (request.url === "/v1/batch/objects") {
      const objects = body.objects as Array<{ class: string; id: string; properties: Record<string, unknown> }>;
      if (objects.length > 32) return [];
      stored.push(...objects.map((item) => item.properties));
      return objects.map((item) => ({ id: item.id, class: item.class, result: { status: "SUCCESS" } }));
    }
    return { data: { Get: { LocalSemantic_synthetic_vault_NotesG1: stored.filter((item) => !item.passageId), LocalSemantic_synthetic_vault_PassagesG1: stored.filter((item) => item.passageId).slice(1) } } };
  }, async (url) => {
    await assert.rejects(client(url).replaceSnapshot(1, DEFAULT_MODEL.modelFingerprint, note, passages), /incomplete/);
  });
});

test("compatible snapshot reuse preserves typed raw metadata and rejects missing manifest passages", async () => {
  const properties = await new PropertyRegistry().normalize({ priority: 42, deadline: "2026-09-09" });
  const note = { ...identity, ...properties, path: "synthetic.md", title: "synthetic", noteVectorMode: "direct", _additional: { vectors: { content: vector } } };
  const passage = { ...identity, path: note.path, title: note.title, passageId: "p0", passageIndex: 0, heading: "", body: "synthetic", start: 0, end: 9, startLine: 0, endLine: 0, _additional: note._additional };
  await withBackend((_request, body) => ({ data: { Get: String(body.query).includes("NotesG1") ? { LocalSemantic_synthetic_vault_NotesG1: [note] } : { LocalSemantic_synthetic_vault_PassagesG1: [passage] } } }), async (url) => {
    const database = client(url);
    const retained = await database.loadSnapshot(1, identity.noteId, identity.snapshotId, DEFAULT_MODEL.modelFingerprint, ["p0"]);
    assert.deepEqual(retained.note.properties, properties);
    assert.deepEqual(retained.passages[0]?.vector, vector);
    await assert.rejects(database.loadSnapshot(1, identity.noteId, identity.snapshotId, DEFAULT_MODEL.modelFingerprint, ["p0", "missing"]), /incomplete/);
  });
});
