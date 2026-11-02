import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash, webcrypto } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { MODEL } from "./helpers/rerank-model";
import { access } from "./helpers/adaptive-fixtures";
import type { SearchResult } from "../src/types";
import type { RemoteRequest } from "../src/rerank/remote-http";

const compiled = await build({ stdin: {
  contents: 'export { SemanticSearchView } from "./src/search-view"; export { RerankService } from "./src/rerank/service"; export { PropertyRegistry } from "./src/properties";',
  resolveDir: fileURLToPath(new URL("..", import.meta.url)), sourcefile: "view-integration.ts",
}, bundle: true, platform: "node", format: "cjs", write: false, external: ["obsidian"] });
const require = createRequire(import.meta.url);
class File {
  stat = { mtime: 1, size: 0 };
  constructor(readonly path: string, readonly basename: string, public markdown: string) { this.stat.size = Buffer.byteLength(markdown); }
  get name(): string { return this.basename + ".md"; }
}
class Control {
  text = ""; title = ""; disabled = false; hidden = false; value = "";
  children: Control[] = [];
  setText(value: string): void { this.text = value; }
  setAttribute(): void {}
  replaceChildren(): void { this.children = []; }
  createEl(_name: string, options?: { text?: string }): Control { const child = new Control(); child.text = options?.text ?? ""; this.children.push(child); return child; }
}
function deferred() { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() }; }

function harness(kind: "search" | "note" | "passage", transportHook?: (options: RemoteRequest) => Promise<void>) {
  let clockOffset = 0;
  const module = { exports: {} as Record<string, any> };
  runInNewContext(compiled.outputFiles[0]!.text, { module, exports: module.exports,
    require: (name: string) => name === "obsidian" ? { ItemView: class {}, TFile: File, WorkspaceLeaf: class {}, Keymap: {}, Menu: class {},
      getAllTags: (cache: { frontmatter?: { tags?: unknown } }) => Array.isArray(cache.frontmatter?.tags) ? cache.frontmatter.tags : [],
      // Only the fixture YAML is parsed here. Production uses Obsidian's parseYaml.
      parseYaml: (yaml: string) => Object.fromEntries(yaml.trim().split("\n").filter(Boolean).map(line => {
        const [key, value] = line.split(":"); return [key!.trim(), value?.trim() === "false" ? false : value?.trim() === "true" ? true : value?.trim()];
      })),
    } : require(name),
    window: { setTimeout, clearTimeout }, Buffer, AbortController, structuredClone, TextEncoder, TextDecoder, performance: { now: () => performance.now() + clockOffset }, crypto: webcrypto, setTimeout, clearTimeout });
  const files = [new File("Source.md", "Source", "Source introduction.\n\nSELECTED source evidence.\n\nSource conclusion."),
    new File("A.md", "A", "Candidate A evidence.\n\n![Diagram](private-image.png)"), new File("B.md", "B", "Candidate B evidence.")];
  const settings = access({ candidateCount: 2 });
  const properties = { frontmatterJson: "{}", propertyKeys: [], nullPropertyKeys: [], emptyListPropertyKeys: [], tags: [], tagAncestors: [], fields: {} };
  const stored = files.map((file, index) => {
    const noteId = `note${index}`, snapshotId = `snap${index}`, text = `# ${file.basename}\n\n${file.markdown}`;
    let offset = 0;
    const passages = text.split("\n\n").map((body, passageIndex) => {
      const start = offset; offset += body.length + 2;
      return { passageId: `${noteId}-p${passageIndex}`, passageIndex, noteId, snapshotId, path: file.path, title: file.basename,
        heading: file.basename, body, start, end: start + body.length, startLine: text.slice(0, start).split("\n").length - 1,
        endLine: text.slice(0, start + body.length).split("\n").length, vector: [1, 0], properties };
    });
    return { text, note: { noteId, snapshotId, path: file.path, title: file.basename, noteVectorMode: "direct", vector: [1, 0], properties }, passages };
  });
  const state: any = { vaultId: "vault", indexingEnabled: true, servingReady: true, schemaUpdating: false,
    activeGeneration: 1, pendingPurges: [], notes: {}, pathToNoteId: {} };
  for (const item of stored) {
    state.pathToNoteId[item.note.path] = item.note.noteId;
    state.notes[item.note.noteId] = { ...item.note, committed: true, servable: true, generation: 1, modelFingerprint: "model", policyEpoch: 1,
      bodyHash: createHash("sha256").update(item.text).digest("hex"), passageIds: item.passages.map(passage => passage.passageId) };
  }
  const sourcePassage = stored[0]!.passages[2]!;
  const anchor: SearchResult = { ...stored[0]!.note, score: 1, scoreKind: "similarity", passages: kind === "passage" ? [sourcePassage] : [] };
  const candidates: SearchResult[] = stored.slice(1).map((item, index) => ({ ...item.note, score: 0.9 - index / 10,
    scoreKind: kind === "search" ? "hybrid" : "similarity", passages: kind === "note" ? [] : [item.passages[1]!] }));
  const detailed = candidates.map((result, index) => ({ result, noteRank: index,
    passages: result.passages.map(passage => ({ ...passage, noteId: result.noteId, snapshotId: result.snapshotId, path: result.path,
      storedTitle: result.title, retrievalScore: result.score, retrievalRank: index })) }));
  const window = { limit: 300, notes: detailed, passages: detailed.flatMap(item => item.passages) };
  const mode = kind === "search" ? "search" : "connections";
  const context = { epoch: 1, mode, generation: 1, fingerprint: "model", ...(kind !== "search" ? { anchor } : {}),
    ...(kind === "passage" ? { targetPassageId: sourcePassage.passageId } : {}) };
  const seed = { context, query: kind === "search" ? "Useful evidence" : "", filters: [], baseline: structuredClone(candidates),
    graph: undefined, graphFailed: false, exhausted: true, ...(kind === "search" ? { window, vector: [1, 0] } : { candidates }) };
  const calls: RemoteRequest[] = [], publications: Array<{ results: SearchResult[]; graph: any; failed: boolean }> = [];
  const registry = { current: () => MODEL, load: async () => MODEL, approve: () => {} };
  const service = new module.exports.RerankService(() => settings, async (options: RemoteRequest) => {
    options.beforeSend(); calls.push(options); await transportHook?.(options); options.beforeSend();
    const body = JSON.parse(options.body);
    return JSON.stringify({ model: MODEL.canonicalSlug, provider: "TypeSafe",
      answers: Object.fromEntries(Object.keys(body.questions).map((key, index) => [key, { type: "noul", noul: index ? 0.9 : 0.1 }])),
      usage: { input_tokens: 100, output_tokens: 2 } });
  }, registry);
  const view: any = Object.create(module.exports.SemanticSearchView.prototype);
  Object.assign(view, { app: {
    vault: { getAbstractFileByPath: (path: string) => files.find(file => file.path === path), read: async (file: File) => file.markdown },
    metadataCache: { getFileCache: () => ({ frontmatter: {} }) },
  }, state, mode, query: kind === "search" ? "Useful evidence" : "previous unrelated Search query", context, results: structuredClone(candidates),
  reference: files[0], targetPassage: kind === "passage" ? { noteId: anchor.noteId, snapshotId: anchor.snapshotId, passage: sourcePassage } : undefined,
  pathPolicy: { check: () => ({ admitted: true }) }, embeddings: { profile: { modelFingerprint: "model", dimensions: 2 }, setCurrentQuery: () => {} },
  registry: new module.exports.PropertyRegistry(), weaviate: {
    loadSnapshot: async (_generation: number, noteId: string) => { const item = stored.find(value => value.note.noteId === noteId)!; return { note: item.note, passages: item.passages }; },
    noteVectors: async (_generation: number, _fingerprint: string, members: Array<{ noteId: string; snapshotId: string }>) => members.map(member => ({ ...member, vector: [1, 0] })),
  }, searchRetrieval: { expand: async () => ({ window, candidates: detailed, candidateExhausted: true }) },
  closed: false, requestEpoch: 1, inspectionEpoch: 0, interactionEpoch: 0, searchSeed: seed, rerankJob: undefined,
  rerankCandidates: [], pendingRanking: undefined, reranked: false, changingRerankEnabled: false,
  queryPending: false, queryActive: false, indexRefreshPending: false, indexRefreshTimer: undefined,
  memory: { search: { filters: [], expanded: new Map(), scroll: 0 }, connections: { filters: [], expanded: new Map(), scroll: 0 } },
  rerankButton: new Control(), rerankEnabledButton: new Control(), applyRerankButton: new Control(), rerankStatus: new Control(),
  rerankPreviewEl: new Control(), resultStatusEl: new Control(), statusEl: new Control(), listEl: new Control(), inspectorEl: new Control(),
  articles: new Map(), filterControls: new Map(), graph: { clear: () => {} }, updateReference: () => {},
  scrollEl: { contains: () => false, scrollTop: 0 }, contentEl: { ownerDocument: { activeElement: null } },
  reranker: service, rerankStore: { access: () => settings, get settings() { return settings; } },
  publishRanking: (results: SearchResult[], graph: unknown, failed: boolean, reranked: boolean) => {
    view.results = structuredClone(results); view.reranked = reranked; publications.push({ results: structuredClone(results), graph, failed }); return true;
  } });
  return { view, files, stored, state, settings, calls, publications, advanceClock: (milliseconds: number) => { clockOffset += milliseconds; }, cleanup: () => { service.dispose(); view.cancelRequests(); } };
}

for (const kind of ["search", "note", "passage"] as const) test(`${kind} target reaches one real service request through the actual sidebar continuation`, async () => {
  const h = harness(kind);
  try {
    const original = structuredClone(h.view.results);
    await h.view.rerankSearch();
    assert.equal(h.calls.length, 1, h.view.rerankStatus.text);
    assert.equal(h.publications.length, 1, h.view.rerankStatus.text);
    const body = JSON.parse(h.calls[0]!.body);
    assert.equal(body.state.source.scope, kind);
    assert.equal(Object.keys(body.questions).length, 2);
    assert.ok(!h.calls[0]!.body.includes("private-image.png"));
    assert.equal(h.publications[0]!.results[0]!.noteId, "note2");
    assert.equal(h.publications[0]!.results[0]!.score, original[1]!.score);
    if (kind !== "search") assert.equal(h.publications[0]!.graph.edges[0].cosine, original[1]!.score);
    if (kind === "passage") assert.equal(body.state.source.segments.find((segment: { role: string }) => segment.role === "focus").text, "SELECTED source evidence.");
  } finally { h.cleanup(); }
});

test("fresh source frontmatter vetoes upload even when Obsidian metadata cache still permits it", async () => {
  const h = harness("note");
  try {
    h.files[0]!.markdown = "---\nai_remote: false\n---\n" + h.files[0]!.markdown;
    await h.view.rerankSearch(); assert.equal(h.calls.length, 0); assert.equal(h.publications.length, 0);
    assert.match(h.view.rerankStatus.text, /policy/);
  } finally { h.cleanup(); }
});

test("a changed canonical candidate body cannot become cloud evidence before reindexing", async () => {
  const h = harness("note");
  try {
    h.files[1]!.markdown += "\nNew private text";
    await h.view.rerankSearch(); assert.equal(h.calls.length, 0); assert.equal(h.publications.length, 0);
    assert.equal(h.view.results.length, 2); assert.match(h.view.rerankStatus.text, /snapshot/);
  } finally { h.cleanup(); }
});

test("cancellation while source hydration is pending prevents any later network dispatch", async () => {
  const h = harness("note"), entered = deferred(), release = deferred();
  const original = h.view.weaviate.loadSnapshot;
  h.view.weaviate.loadSnapshot = async (...args: unknown[]) => { entered.resolve(); await release.promise; return original(...args); };
  try {
    const running = h.view.rerankSearch(); await entered.promise;
    assert.equal(h.view.rerankButton.text, "Cancel reranking");
    await h.view.rerankSearch(); release.resolve(); await running;
    assert.equal(h.calls.length, 0); assert.equal(h.publications.length, 0); assert.equal(h.view.results.length, 2);
  } finally { release.resolve(); h.cleanup(); }
});

test("source invalidation aborts in-flight Connections requests and cannot publish stale rankings", async () => {
  const entered = deferred();
  const h = harness("note", async options => {
    entered.resolve(); await new Promise<void>((_, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
  });
  try {
    const running = h.view.rerankSearch(); await entered.promise;
    h.state.notes.note0.servable = false;
    h.view.invalidate("note0"); await running;
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0]!.signal.aborted, true); assert.equal(h.publications.length, 0);
    assert.equal(h.view.results.length, 0, "the old source is no longer locally servable either");
  } finally { h.cleanup(); }
});

test("a graph read failure does not discard a valid reranked Search list", async () => {
  const h = harness("search");
  try {
    h.view.weaviate.noteVectors = async () => { throw new Error("synthetic graph failure"); };
    await h.view.rerankSearch();
    assert.equal(h.calls.length, 1); assert.equal(h.publications.length, 1); assert.equal(h.publications[0]!.failed, true);
    assert.equal(h.publications[0]!.results[0]!.noteId, "note2");
  } finally { h.cleanup(); }
});


test("a completed ranking awaiting Apply does not expire with the finished request deadline", async () => {
  const h = harness("note");
  try {
    h.view.scrollEl.contains = () => true;
    await h.view.rerankSearch();
    assert.equal(h.calls.length, 1); assert.ok(h.view.pendingRanking); assert.equal(h.publications.length, 0);
    h.advanceClock(60_000);
    h.view.applyPendingRanking();
    assert.equal(h.publications.length, 1, h.view.rerankStatus.text);
  } finally { h.cleanup(); }
});

test("remote settings changes clear a stale ranking when its exact local baseline cannot be restored", () => {
  const h = harness("note");
  try {
    h.view.reranked = true;
    h.view.publishRanking = () => false;
    h.view.rerankSettingsChanged();
    assert.equal(h.view.results.length, 0);
    assert.equal(h.view.searchSeed, undefined);
    assert.equal(h.view.reranked, false);
  } finally { h.cleanup(); }
});

test("Connections keeps the saved retrieval-window provenance when reranking", async () => {
  const h = harness("note");
  try {
    h.view.searchSeed.candidateWindow = 1200;
    h.view.scrollEl.contains = () => true;
    await h.view.rerankSearch();
    assert.equal(h.view.pendingRanking?.metrics.baselineWindow, 1200);
    assert.equal(h.view.pendingRanking?.metrics.candidateWindow, 1200);
  } finally { h.cleanup(); }
});


test("pending Apply rechecks source disclosure and file stamps without another request", async () => {
  for (const change of ["policy", "file"] as const) {
    const h = harness("note");
    try {
      h.view.scrollEl.contains = () => true;
      await h.view.rerankSearch(); assert.ok(h.view.pendingRanking);
      if (change === "policy") h.view.app.metadataCache.getFileCache = () => ({ frontmatter: { ai_remote: false } });
      else h.files[0]!.stat.mtime++;
      h.view.applyPendingRanking();
      assert.equal(h.publications.length, 0); assert.equal(h.calls.length, 1); assert.equal(h.view.pendingRanking, undefined);
    } finally { h.cleanup(); }
  }
});

test("Use local ranking clears invalid baseline results rather than displaying an obsolete rerank", async () => {
  const h = harness("note");
  try {
    await h.view.rerankSearch(); assert.equal(h.view.reranked, true);
    h.view.publishRanking = () => false;
    await h.view.rerankSearch();
    assert.equal(h.view.results.length, 0); assert.equal(h.view.reranked, false); assert.equal(h.calls.length, 1);
  } finally { h.cleanup(); }
});
