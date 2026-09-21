const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const ROOT = path.resolve(__dirname, '..');
// Exercise the complete production class, not copied lifecycle methods.
const VIEW = path.join(ROOT, 'src/search-view.ts');

class TFile { constructor(path) { this.path = path; this.basename = path.replace(/\.md$/, ''); this.extension = 'md'; this.admitted = true; } }
const graph = {
  visibleResults(candidates, admitted) {
    const seen = new Set();
    const results = [];
    for (const result of candidates) {
      if (!Number.isFinite(result.score) || seen.has(result.noteId) || !admitted(result)) continue;
      seen.add(result.noteId); results.push(result);
      if (results.length === 30) break;
    }
    return results;
  },
  buildConnectionGraph(results, anchor) { return { results, anchor }; },
  buildSimilarityGraph(results) { return { results }; },
};
const aliases = {
  obsidian: { TFile, ItemView: class {} },
  './graph': graph,
  './policy': { admissionFor: file => ({ admitted: file.admitted }) },
  './policy-core': {}, './properties': {}, './similarity-graph': {},
  './embeddings': {}, './weaviate': {},
};
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file).exports;
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }, fileName: file,
  }).outputText;
  const module = { exports: {} }; cache.set(file, module);
  const sandbox = {
    module, exports: module.exports,
    require: id => Object.hasOwn(aliases, id) ? aliases[id] : id.startsWith('.') ? load(path.resolve(path.dirname(file), id + '.ts')) : require(id),
    AbortController, Buffer, structuredClone, setTimeout, clearTimeout, console,
    window: { setTimeout, clearTimeout },
  };
  vm.runInNewContext(output, sandbox, { filename: file });
  return module.exports;
}
const { SemanticSearchView } = load(VIEW);
const { JevReranker } = load(path.join(ROOT, 'src/reranking.ts'));
const { CurrentRerankingCache } = load(path.join(ROOT, 'src/reranking-cache.ts'));
const settleIndex = () => new Promise(resolve => setTimeout(resolve, 275));
const flush = () => new Promise(resolve => setImmediate(resolve));
function element() { return { text: '', hidden: false, replaceChildren() { this.text = ''; }, setText(value) { this.text = value; }, createEl(_tag, options) { this.text += options.text; return this; }, createDiv(options) { this.text += options?.text || ''; return this; } }; }
function fixture({ deferred = false, size = 3, transportError = false, transportOverride } = {}) {
  const config = { enabled: true, provider: 'jev-openrouter', apiKey: 'test-key' };
  const files = new Map();
  const state = { indexingEnabled: true, servingReady: true, schemaUpdating: false, activeGeneration: 1, notes: {}, pathToNoteId: {}, pendingPurges: [] };
  const candidates = Array.from({ length: size }, (_, i) => {
    const file = new TFile(`note-${i}.md`); files.set(file.path, file);
    const result = { noteId: `n${i}`, path: file.path, title: file.basename, snapshotId: `s${i}`, score: 1/(i+1), scoreKind: 'hybrid', passages: [{ passageId: `p${i}`, heading: 'Title', body: `Text ${i}`, startLine: 0, endLine: 1 }] };
    state.notes[result.noteId] = { ...result, servable: true, modelFingerprint: 'f', generation: 1 };
    state.pathToNoteId[file.path] = result.noteId;
    return result;
  });
  const requests = []; const sent = []; const published = [];
  const transport = (body, _key, signal) => {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    const wire = { answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'noul', noul: 0.5 }])) };
    const request = { body, signal, dispatch() { if (!signal.aborted) sent.push(body); }, complete() { resolve(wire); } };
    requests.push(request);
    if (transportError) return Promise.reject(new Error('upstream secret detail'));
    if (!deferred) { request.dispatch(); request.complete(); }
    return promise;
  };
  const view = Object.create(SemanticSearchView.prototype);
  Object.assign(view, {
    mode: 'search', reference: null, query: 'query', results: [], context: undefined, requestEpoch: 0,
    rerankController: undefined, activeRerank: undefined, rerankCache: new CurrentRerankingCache(),
    indexRefreshPending: false, indexRefreshTimer: undefined, searchTimer: undefined, queryActive: false, activeQueryEpoch: undefined,
    queryPending: false, closed: false, needsRefresh: true, inspectionEpoch: 0, pendingInspection: undefined,
    filterControls: new Map(), articles: new Map(), state, registry: {}, pathPolicy: {},
    memory: { search: { filters: [], scroll: 0 }, connections: { filters: [], scroll: 0 } },
    app: { vault: { getAbstractFileByPath: p => files.get(p) }, metadataCache: { getFileCache: () => ({}) } },
    embeddings: { setCurrentQuery() {}, profile: { modelFingerprint: 'f', dimensions: 2 }, embedQuery: async () => ({ modelFingerprint: 'f', vector: [1,0] }) },
    weaviate: { hybrid: async () => structuredClone(candidates), noteVectors: async () => [], connectionsForNote: async () => structuredClone(candidates) },
    reranker: new JevReranker(() => config, transportOverride || transport, 5000),
    statusEl: element(), resultStatusEl: element(), listEl: element(), inspectorEl: element(), scrollEl: { scrollTop: 0 },
    graph: { clear() {}, setData() {} },
    updateReference() {}, renderResults() { published.push(this.results); },
  });
  const close = () => { view.closed = true; view.cancelRequests(); };
  return { view, requests, sent, published, files, state, candidates, config, close };
}

test('[P1 regression] invalidating an in-flight candidate must abort the pending cloud request', async t => {
  const f = fixture({ deferred: true }); t.after(f.close);
  f.view.requestRefresh(); await flush();
  assert.equal(f.requests.length, 1);
  assert.equal(f.view.results.length, 0); assert.equal(f.view.context, undefined);
  f.state.notes.n0.servable = false;
  f.state.pendingPurges.push('n0');
  f.files.get('note-0.md').admitted = false;
  f.view.invalidate('n0');
  const aborted = f.requests[0].signal.aborted;
  // Simulate pending DNS/TLS/transport dispatch occurring after the privacy change.
  f.requests[0].dispatch(); f.requests[0].complete(); await flush();
  t.diagnostic(JSON.stringify({ abortedImmediately: aborted, requestsSentAfterInvalidation: f.sent.length, published: f.published.length, status: f.view.resultStatusEl.text }));
  assert.equal(aborted, true, 'candidate invalidation failed to abort its in-flight request');
});

test('[P2 regression] an unchanged shortlist after an unrelated index publication must not rebill reranking', async t => {
  const f = fixture(); t.after(f.close);
  f.view.requestRefresh(); await flush();
  assert.equal(f.requests.length, 1); assert.equal(f.published.length, 1);
  // Emulates on-index-published after an unrelated note, with same query/snapshots/passages.
  f.view.indexChanged(); await settleIndex();
  t.diagnostic(JSON.stringify({ cloudRequests: f.requests.length, identicalPayload: JSON.stringify(f.requests[0].body) === JSON.stringify(f.requests[1]?.body), publications: f.published.length }));
  assert.equal(f.requests.length, 1, 'identical query + shortlisted snapshots were sent again');
});

test('[P2 regression] unrelated index publications must not repeatedly cancel and restart the same slow rerank', async t => {
  const f = fixture({ deferred: true }); t.after(f.close);
  f.view.requestRefresh(); await flush();
  for (let i = 0; i < 4; i++) { f.view.indexChanged(); await flush(); }
  t.diagnostic(JSON.stringify({ requests: f.requests.length, aborted: f.requests.filter(r => r.signal.aborted).length, publications: f.published.length }));
  assert.equal(f.requests.length, 1, 'background publications repeatedly restart unchanged reranking');
  assert.equal(f.requests[0].signal.aborted, false);
  f.requests[0].complete(); await flush();
  assert.equal(f.published.length, 1, 'index callbacks starved first publication');
  await settleIndex();
  assert.equal(f.requests.length, 1, 'coalesced follow-up must reuse identical scores');
  assert.equal(f.published.length, 2);

});

test('control: generic invalidation aborts requests and suppresses late responses', async t => {
  const f = fixture({ deferred: true }); t.after(f.close);
  f.view.requestRefresh(); await flush();
  f.view.invalidate(); assert.equal(f.requests[0].signal.aborted, true);
  f.requests[0].complete(); await flush();
  assert.equal(f.published.length, 0);
});

test('control: settings change to disabled aborts remote work and publishes local order', async t => {
  const f = fixture({ deferred: true }); t.after(f.close);
  f.view.requestRefresh(); await flush();
  f.config.enabled = false; f.view.rerankingChanged(); await flush();
  assert.equal(f.requests[0].signal.aborted, true);
  assert.equal(f.requests.length, 1); assert.equal(f.published.length, 1);
  assert.equal(f.view.results[0].noteId, 'n0');
  assert.equal(f.view.results[0].rerankScore, undefined);
});

test('control: provider failure publishes the full original ranking and safe warning', async t => {
  const f = fixture({ transportError: true }); t.after(f.close);
  f.view.requestRefresh(); await flush();
  assert.equal(f.published.length, 1); assert.equal(f.view.results.length, 3);
  assert.equal(f.view.results[0].score, 1); assert.equal(f.view.results[1].score, 0.5);
  assert.match(f.view.resultStatusEl.text, /original hybrid order/);
  assert.doesNotMatch(f.view.resultStatusEl.text, /secret/);
});

test('control: stale candidate is not published and prevents later outbound batches', async t => {
  const f = fixture({ deferred: true, size: 12 }); t.after(f.close);
  f.view.requestRefresh(); await flush();
  f.state.notes.n0.servable = false;
  f.requests[0].complete(); await flush();
  assert.equal(f.requests.length, 1); assert.equal(f.published.length, 0);
});

test('control: Connections does not invoke JEV', async t => {
  const f = fixture(); t.after(f.close);
  f.view.mode = 'connections'; f.view.reference = f.files.get('note-0.md');
  f.view.requestRefresh(); await flush();
  assert.equal(f.requests.length, 0); assert.equal(f.published.length, 1);
});

test('[P1 regression, real socket] privacy invalidation must stop buffered request before delayed connection', async t => {
  const http = require('node:http');
  const net = require('node:net');
  const { createJevTransport } = load(path.join(ROOT, 'src/jev-http.ts'));
  const received = [];
  const server = http.createServer((req, res) => {
    let text = '';
    req.on('data', chunk => { text += chunk; });
    req.on('end', () => {
      const body = JSON.parse(text); received.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'noul', noul: 0.5 }])) }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const agent = new http.Agent();
  let releaseSocket;
  agent.createConnection = (_options, callback) => {
    releaseSocket = () => callback(null, net.createConnection({ host: '127.0.0.1', port }));
    return undefined;
  };
  // Use Node's actual HTTP request/stream machinery over loopback, not a fake EventEmitter.
  // Only the destination/agent are substituted; production uses the same request pattern via HTTPS.
  const requestImpl = (_url, options, callback) => http.request({ ...options, host: '127.0.0.1', port, path: '/', agent }, callback);
  const f = fixture({ transportOverride: createJevTransport(requestImpl) });
  t.after(async () => { f.close(); agent.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  f.view.requestRefresh(); await flush();
  assert.equal(typeof releaseSocket, 'function'); assert.equal(received.length, 0);
  f.state.notes.n0.servable = false; f.state.pendingPurges.push('n0');
  f.files.get('note-0.md').admitted = false;
  const signal = f.view.rerankController.signal;
  f.view.invalidate('n0');
  releaseSocket();
  // A short local-only settling interval lets the loopback request finish.
  await new Promise(resolve => setTimeout(resolve, 75));
  t.diagnostic(JSON.stringify({ signalAbortedByInvalidation: signal.aborted, actualBufferedRequestsReceivedAfterExclusion: received.length, includedExcludedCandidate: Boolean(received[0]?.state.candidates.candidate_0), rendered: f.published.length }));
  assert.equal(received.length, 0, 'a buffered request containing the excluded candidate was still transmitted');
});

for (const change of ['query', 'key', 'filter', 'snapshot', 'excerpt', 'order']) {
  test(`cache invalidation: ${change} must not reuse obsolete scores`, async t => {
    const f = fixture(); t.after(f.close);
    f.view.requestRefresh(); await flush();
    assert.equal(f.requests.length, 1);
    if (change === 'query') { f.view.query = 'other'; f.view.requestRefresh(); }
    if (change === 'key') { f.config.apiKey = 'other-key'; f.view.rerankingChanged(); }
    if (change === 'filter') { f.view.memory.search.filters.push({ key: 'tag', value: 'new' }); f.view.requestRefresh(); }
    if (change === 'snapshot') { f.candidates[0].snapshotId = 'new'; f.state.notes.n0.snapshotId = 'new'; f.view.indexChanged(); }
    if (change === 'excerpt') { f.candidates[0].passages[0].body = 'changed evidence'; f.view.indexChanged(); }
    if (change === 'order') { f.candidates.reverse(); f.view.indexChanged(); }
    await settleIndex();
    assert.equal(f.requests.length, 2);
  });
}

test('closing the actual view aborts work and clears the current-search cache', async t => {
  const f = fixture({ deferred: true }); t.after(f.close);
  f.view.requestRefresh(); await flush();
  await f.view.onClose();
  assert.equal(f.requests[0].signal.aborted, true);
  f.requests[0].complete(); await flush();
  assert.equal(f.published.length, 0);
});

test('an index publication detecting a stale active candidate also aborts immediately', async t => {
  const f = fixture({ deferred: true }); t.after(f.close);
  f.view.requestRefresh(); await flush();
  f.state.notes.n0.servable = false;
  f.view.indexChanged();
  assert.equal(f.requests[0].signal.aborted, true);
});

test('scores cached by one view cannot contaminate another view', async t => {
  const a = fixture(), b = fixture(); t.after(a.close); t.after(b.close);
  a.view.requestRefresh(); b.view.requestRefresh(); await flush();
  assert.equal(a.requests.length, 1); assert.equal(b.requests.length, 1);
  a.view.indexChanged(); b.view.indexChanged(); await settleIndex();
  assert.equal(a.requests.length, 1); assert.equal(b.requests.length, 1);
});

test('burst index updates coalesce into one local refresh without retransmission', async t => {
  const f = fixture(); t.after(f.close);
  f.view.requestRefresh(); await flush();
  for (let i = 0; i < 20; i++) f.view.indexChanged();
  await settleIndex();
  assert.equal(f.published.length, 2);
  assert.equal(f.requests.length, 1);
});
