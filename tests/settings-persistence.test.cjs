const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Load the full production plugin with Obsidian/service constructors mocked.
// Only persist() is exercised; real filesystem operations run in a temporary directory.
const file = path.join(__dirname, '..', 'src', 'main.ts');
const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, fileName: file,
}).outputText;
const loaded = { exports: {} };
vm.runInNewContext(output, {
  module: loaded, exports: loaded.exports,
  require: id => id === 'obsidian' ? { Plugin: class {}, PluginSettingTab: class {}, FuzzySuggestModal: class {} } : id.startsWith('.') ? {} : require(id),
  console,
}, { filename: file });

test('persisted plugin data excludes both credentials while retaining provider settings', async t => {
  const dir = await fsp.mkdtemp(path.join(tmpdir(), 'jev-settings-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const plugin = Object.create(loaded.exports.default.prototype);
  Object.assign(plugin, {
    pluginDir: dir, state: {}, registry: { data: () => ({ fields: [] }) },
    serviceSettings: { weaviateApiKey: 'local-secret', openrouterApiKey: 'remote-secret' },
    rerankingSettings: { enabled: true, provider: 'jev-openrouter' }, graphEdgeCutoff: 0.7,
  });
  await plugin.persist();
  const text = await fsp.readFile(path.join(dir, 'data.json'), 'utf8');
  assert.doesNotMatch(text, /local-secret|remote-secret/);
  const data = JSON.parse(text);
  assert.deepEqual(data.services, { weaviateApiKey: '', openrouterApiKey: '' });
  assert.deepEqual(data.reranking, { enabled: true, provider: 'jev-openrouter' });
});
