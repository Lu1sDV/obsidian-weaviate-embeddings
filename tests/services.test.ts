import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ServiceManager, type ServiceSettings } from "../src/services";

function fixture(url = "http://127.0.0.1:8080") {
  const vaultId = `test-${crypto.randomUUID()}`;
  const runtimeDir = join(homedir(), ".local", "share", "obsidian-local-semantic", vaultId);
  const settings: ServiceSettings = {
    weaviateUrl: url,
    weaviateApiKey: "initial",
    containerBackend: "podman",
    nativeDownloadsApproved: true,
  };
  return {
    manager: new ServiceManager(settings, vaultId, "/unused", () => undefined),
    settings,
    runtimeDir,
  };
}

test("concurrent credential saves leave the latest complete key on disk", async (t) => {
  const { manager, settings, runtimeDir } = fixture();
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  const saves: Promise<void>[] = [];
  for (let index = 0; index < 64; index += 1) {
    settings.weaviateApiKey = `key-${index}`;
    saves.push(manager.saveSecrets());
  }
  await Promise.all(saves);
  const stored = JSON.parse(await readFile(join(runtimeDir, "credentials.json"), "utf8")) as { weaviateApiKey: string };
  assert.equal(stored.weaviateApiKey, "key-63");
});

test("managed IPv6 startup fails before launching an unreachable IPv4 container", async (t) => {
  const { manager, runtimeDir } = fixture("http://[::1]:1");
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  await assert.rejects(manager.startOwned(), /managed Weaviate.*127\.0\.0\.1/i);
});
