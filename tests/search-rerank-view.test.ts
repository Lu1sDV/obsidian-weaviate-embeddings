import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

// Exercise the real view methods without an Obsidian process or a network connection.
// Pure service tests cannot catch publication events that cancel work in the sidebar.
const compiled = await build({
  entryPoints: [fileURLToPath(new URL("../src/search-view.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  external: ["obsidian"],
});
const nativeRequire = createRequire(import.meta.url);

class Control {
  text = "";
  title = "";
  disabled = false;
  hidden = false;
  readonly attributes = new Map<string, string>();
  setText(value: string): void { this.text = value; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
}

interface HarnessView {
  indexChanged(): void;
  invalidate(noteId?: string): void;
  rerankSettingsChanged(): void;
  updateRerankControls(): void;
  rerankSearch(): Promise<void>;
  toggleReranking(): Promise<void>;
  requestRefresh(delay?: number): void;
  searchSeed: { context: object; baseline: object[]; graph: undefined; graphFailed: boolean } | undefined;
  rerankJob: AbortController | undefined;
  rerankCandidates: Array<{ result: { noteId: string } }>;
  pendingRanking: object | undefined;
  reranked: boolean;
  indexRefreshPending: boolean;
  indexRefreshTimer: number | undefined;
  requestEpoch: number;
  context: object | undefined;
  results: Array<{ noteId: string }>;
  queryPending: boolean;
  queryActive: boolean;
  rerankButton: Control;
  rerankEnabledButton: Control;
  rerankStatus: Control;
  reranker: { validatedModel: object | null };
  publishRanking(results: object[], graph: undefined, failed: boolean, reranked: boolean): boolean;
}

function harness() {
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const window = {
    setTimeout(callback: () => void): number { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id?: number): void { if (id !== undefined) timers.delete(id); },
  };
  const module = { exports: {} as { SemanticSearchView: { prototype: object } } };
  runInNewContext(compiled.outputFiles[0]!.text, {
    module,
    exports: module.exports,
    require: (name: string) => name === "obsidian"
      ? { ItemView: class {}, TFile: class {}, WorkspaceLeaf: class {}, Keymap: {}, Menu: class {} }
      : nativeRequire(name),
    window,
    Buffer,
    AbortController,
    structuredClone,
    TextEncoder,
    TextDecoder,
  });
  const view = Object.create(module.exports.SemanticSearchView.prototype) as HarnessView;
  const access = { enabled: true, consent: true, apiKey: "synthetic-key", model: "typesafe/jev-test" };
  const writes: boolean[] = [];
  let localQueries = 0;
  let remoteCalls = 0;
  Object.assign(view, {
    closed: false,
    statusEl: new Control(),
    mode: "search",
    query: "an unchanged query",
    state: { indexingEnabled: true, servingReady: true, schemaUpdating: false, pathToNoteId: {} },
    context: {},
    results: [],
    reference: null,
    displayCurrent: () => true,
    updateReference: () => {},
    filterControls: new Map(),
    queryPending: false,
    queryActive: false,
    searchTimer: undefined,
    indexRefreshPending: false,
    indexRefreshTimer: undefined,
    rerankJob: undefined,
    rerankCandidates: [],
    pendingRanking: undefined,
    searchSeed: { context: {}, baseline: [], graph: undefined, graphFailed: false },
    reranked: false,
    requestEpoch: 7,
    inspectionEpoch: 0,
    rerankButton: new Control(),
    rerankEnabledButton: new Control(),
    applyRerankButton: new Control(),
    rerankStatus: new Control(),
    resultStatusEl: new Control(),
    changingRerankEnabled: false,
    reranker: { validatedModel: {}, run: async () => { remoteCalls++; } },
    rerankStore: {
      access: () => access,
      configure: async (patch: { enabled: boolean }) => {
        access.enabled = patch.enabled;
        writes.push(patch.enabled);
        view.rerankSettingsChanged();
      },
    },
    clearVisible: () => { view.results = []; view.context = undefined; },
    runQueries: async () => { localQueries++; view.queryPending = false; },
  });
  return {
    view,
    access,
    writes,
    timers,
    counts: () => ({ localQueries, remoteCalls }),
    flushTimers: () => {
      const pending = [...timers.values()];
      timers.clear();
      for (const callback of pending) callback();
    },
  };
}

test("unrelated index publications preserve in-flight, pending, and applied manual rankings", () => {
  for (const phase of ["running", "pending", "applied"] as const) {
    const { view, timers } = harness();
    const controller = new AbortController();
    const seed = view.searchSeed;
    if (phase === "running") view.rerankJob = controller;
    if (phase === "pending") view.pendingRanking = {};
    if (phase === "applied") view.reranked = true;
    view.indexChanged();
    view.indexChanged();
    assert.equal(controller.signal.aborted, false);
    assert.equal(view.searchSeed, seed);
    assert.equal(view.requestEpoch, 7);
    assert.equal(view.indexRefreshPending, true);
    assert.equal(timers.size, 0);
  }
});

test("a queued index refresh rechecks manual work at dispatch and resumes after cancellation", async () => {
  const { view, timers, flushTimers, counts } = harness();
  const seed = view.searchSeed;
  view.indexChanged();
  view.indexChanged();
  assert.equal(timers.size, 1, "index publications coalesce");
  const controller = new AbortController();
  view.rerankJob = controller;
  flushTimers();
  assert.equal(controller.signal.aborted, false);
  assert.equal(view.searchSeed, seed);
  assert.equal(view.indexRefreshPending, true);
  assert.equal(counts().localQueries, 0);
  await view.rerankSearch();
  assert.equal(controller.signal.aborted, true);
  assert.equal(view.searchSeed, seed, "cancellation retains the local baseline before refresh");
  assert.equal(timers.size, 1);
  flushTimers();
  assert.equal(counts().localQueries, 1);
  assert.equal(view.requestEpoch, 8);
  assert.equal(view.searchSeed, undefined);
});

test("in-flight reranking exposes an accessible working Cancel action", async () => {
  const { view, counts } = harness();
  const seed = view.searchSeed;
  const controller = new AbortController();
  view.rerankJob = controller;
  view.updateRerankControls();
  assert.equal(view.rerankButton.disabled, false);
  assert.equal(view.rerankButton.text, "Cancel reranking");
  assert.equal(view.rerankButton.attributes.get("aria-label"), "Cancel reranking");
  await view.rerankSearch();
  assert.equal(controller.signal.aborted, true);
  assert.equal(view.searchSeed, seed);
  assert.equal(view.rerankJob, undefined);
  assert.match(view.rerankStatus.text, /cancelled/);
  assert.equal(counts().remoteCalls, 0);
});

test("sidebar disable cancels work and enable requires a separate manual action", async () => {
  const { view, access, writes, counts } = harness();
  const controller = new AbortController();
  view.rerankJob = controller;
  await view.toggleReranking();
  assert.deepEqual(writes, [false]);
  assert.equal(controller.signal.aborted, true);
  assert.equal(access.enabled, false);
  assert.equal(view.rerankEnabledButton.text, "Reranking off");
  assert.equal(view.rerankEnabledButton.attributes.get("aria-pressed"), "false");
  assert.equal(view.rerankButton.disabled, true);
  access.apiKey = "";
  await view.toggleReranking();
  assert.deepEqual(writes, [false, true]);
  assert.equal(view.rerankEnabledButton.text, "Reranking on");
  assert.equal(view.rerankEnabledButton.attributes.get("aria-pressed"), "true");
  assert.match(view.rerankStatus.text, /configure the model, key, and upload permission/);
  assert.equal(counts().remoteCalls, 0);
});

test("candidate edits still invalidate immediately when unrelated refreshes were deferred", () => {
  const { view, timers } = harness();
  const controller = new AbortController();
  view.rerankJob = controller;
  view.rerankCandidates = [{ result: { noteId: "changed-note" } }];
  view.results = [{ noteId: "changed-note" }];
  view.indexChanged();
  assert.equal(controller.signal.aborted, false);
  view.invalidate("changed-note");
  assert.equal(controller.signal.aborted, true);
  assert.equal(view.searchSeed, undefined);
  assert.equal(view.context, undefined);
  assert.deepEqual(view.results, []);
  assert.equal(view.indexRefreshPending, false);
  assert.equal(timers.size, 0);
});

test("an unvalidated model shows setup guidance without retrieval or remote work", async () => {
  const { view, counts } = harness();
  view.reranker.validatedModel = null;
  view.updateRerankControls();
  assert.match(view.rerankButton.title, /Validate the selected OpenRouter model/);
  await view.rerankSearch();
  assert.match(view.rerankStatus.text, /validate the selected OpenRouter model/);
  assert.equal(view.rerankJob, undefined);
  assert.deepEqual(counts(), { localQueries: 0, remoteCalls: 0 });
});

test("returning to local ranking releases deferred index updates", async () => {
  const { view, timers, flushTimers, counts } = harness();
  const baseline = view.searchSeed!.baseline;
  let restored: object[] | undefined;
  view.reranked = true;
  view.publishRanking = (results, _graph, _failed, reranked) => {
    restored = results;
    view.reranked = reranked;
    return true;
  };
  view.indexChanged();
  assert.equal(timers.size, 0);
  await view.rerankSearch();
  assert.equal(restored, baseline);
  assert.equal(view.reranked, false);
  assert.equal(timers.size, 1);
  flushTimers();
  assert.equal(counts().localQueries, 1);
});

test("new local query intent still aborts manual work and cancels deferred refresh", () => {
  const { view, timers, counts } = harness();
  const controller = new AbortController();
  view.rerankJob = controller;
  view.indexChanged();
  view.requestRefresh();
  assert.equal(controller.signal.aborted, true);
  assert.equal(view.searchSeed, undefined);
  assert.equal(view.requestEpoch, 8);
  assert.equal(view.indexRefreshPending, false);
  assert.equal(timers.size, 0);
  assert.equal(counts().localQueries, 1);
});
