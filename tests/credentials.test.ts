import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ServiceManager, type ServiceSettings } from "../src/services";

async function fixture(t: TestContext) {
  const runtimeDir = await mkdtemp(join(tmpdir(), "jev-credentials-"));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  const settings: ServiceSettings = { weaviateUrl: "http://127.0.0.1:8080", weaviateApiKey: "weaviate-key", openrouterApiKey: "openrouter-key", containerBackend: "podman", nativeDownloadsApproved: false };
  const manager = new ServiceManager(settings, "test-vault", "/unused", () => undefined);
  Object.defineProperty(manager, "runtimeDir", { value: runtimeDir });
  return { manager, settings, runtimeDir, file: join(runtimeDir, "credentials.json") };
}

test("legacy credentials load without an OpenRouter key", async t => {
  const f = await fixture(t);
  await writeFile(f.file, JSON.stringify({ weaviateApiKey: "legacy" }));
  await f.manager.loadSecrets();
  assert.equal(f.settings.weaviateApiKey, "legacy");
  assert.equal(f.settings.openrouterApiKey, "");
});

test("both credentials round-trip and an empty OpenRouter key stays removed", async t => {
  const f = await fixture(t);
  await f.manager.saveSecrets();
  f.settings.openrouterApiKey = ""; f.settings.weaviateApiKey = "";
  await f.manager.loadSecrets();
  assert.equal(f.settings.openrouterApiKey, "openrouter-key");
  assert.equal(f.settings.weaviateApiKey, "weaviate-key");
  f.settings.openrouterApiKey = "";
  await f.manager.saveSecrets();
  f.settings.openrouterApiKey = "stale-memory";
  await f.manager.loadSecrets();
  assert.equal(f.settings.openrouterApiKey, "");
  assert.equal(f.settings.weaviateApiKey, "weaviate-key");
  if (process.platform !== "win32") {
    assert.equal((await stat(f.file)).mode & 0o777, 0o600);
    assert.equal((await stat(f.runtimeDir)).mode & 0o777, 0o700);
  }
});

test("concurrent saves keep both latest credentials in one complete record", async t => {
  const f = await fixture(t);
  const saves: Promise<void>[] = [];
  for (let i = 0; i < 20; i++) {
    f.settings.weaviateApiKey = `local-${i}`;
    f.settings.openrouterApiKey = `remote-${i}`;
    saves.push(f.manager.saveSecrets());
  }
  await Promise.all(saves);
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")), { weaviateApiKey: "local-19", openrouterApiKey: "remote-19" });
});

test("malformed OpenRouter credentials fail with a content-free error", async t => {
  const f = await fixture(t);
  await writeFile(f.file, JSON.stringify({ weaviateApiKey: "valid", openrouterApiKey: { secret: "do not expose" } }));
  await assert.rejects(f.manager.loadSecrets(), { message: "Invalid local credential file" });
});
