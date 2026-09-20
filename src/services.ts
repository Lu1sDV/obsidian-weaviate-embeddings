import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createConnection } from "node:net";
import { EmbeddingClient } from "./embeddings";
import { DEFAULT_MODEL, type EmbeddingProfile } from "./embedding-config";
import { WeaviateClient } from "./weaviate";
import { validateLoopbackBaseUrl } from "./local-http";

const exec = promisify(execFile);

export interface ServiceSettings {
  weaviateUrl: string;
  weaviateApiKey: string;
  openrouterApiKey?: string;
  containerBackend: "podman" | "docker";
  nativeDownloadsApproved: boolean;
  embeddingDevice?: "auto" | "webgpu" | "wasm";
  ownedContainer?: string;
  ownedContainerInstance?: string;
}

export class ServiceManager {
  private readonly runtimeDir: string;
  private readonly embeddings: EmbeddingClient;
  private starting: Promise<void> | undefined;
  private secretWrites = Promise.resolve();

  constructor(private readonly settings: ServiceSettings, private readonly vaultId: string, pluginDir: string, onStatus: (message: string) => void, profile: EmbeddingProfile = DEFAULT_MODEL) {
    this.runtimeDir = join(homedir(), ".local", "share", "obsidian-local-semantic", vaultId);
    this.embeddings = new EmbeddingClient({ workerPath: join(pluginDir, "embedding-worker.js"), runtimeBaseUrl: pathToFileURL(join(pluginDir, "runtime") + "/").href, onStatus, device: settings.embeddingDevice ?? "auto" }, profile);
  }

  clients(): { embeddings: EmbeddingClient; weaviate: WeaviateClient } {
    return { embeddings: this.embeddings, weaviate: new WeaviateClient(() => ({ baseUrl: this.settings.weaviateUrl, apiKey: this.settings.weaviateApiKey }), this.vaultId, () => this.embeddings.profile) };
  }

  async loadSecrets(): Promise<void> {
    try {
      const raw: unknown = JSON.parse(await readFile(join(this.runtimeDir, "credentials.json"), "utf8"));
      if (!raw || typeof raw !== "object" || !("weaviateApiKey" in raw) || typeof raw.weaviateApiKey !== "string") throw new Error("Invalid local credential file");
      if ("openrouterApiKey" in raw && typeof raw.openrouterApiKey !== "string") throw new Error("Invalid local credential file");
      this.settings.weaviateApiKey = raw.weaviateApiKey;
      this.settings.openrouterApiKey = "openrouterApiKey" in raw ? raw.openrouterApiKey as string : "";
    } catch (error) { if (!missingFile(error)) throw error; }
    try {
      const raw: unknown = JSON.parse(await readFile(join(this.runtimeDir, "ownership.json"), "utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid service ownership record");
      for (const key of ["ownedContainer", "ownedContainerInstance"] as const) {
        if (key in raw) {
          const value = Reflect.get(raw, key);
          if (typeof value !== "string") throw new Error("Invalid service ownership identity");
          this.settings[key] = value;
        }
      }
    } catch (error) { if (!missingFile(error)) throw error; }
  }

  saveSecrets(): Promise<void> {
    const write = this.secretWrites.then(async () => {
      await mkdir(this.runtimeDir, { recursive: true, mode: 0o700 });
      await chmod(this.runtimeDir, 0o700);
      const credentials = join(this.runtimeDir, "credentials.json");
      await writeFile(`${credentials}.pending`, JSON.stringify({ weaviateApiKey: this.settings.weaviateApiKey, openrouterApiKey: this.settings.openrouterApiKey ?? "" }), { mode: 0o600 });
      await chmod(`${credentials}.pending`, 0o600);
      await rename(`${credentials}.pending`, credentials);
    });
    this.secretWrites = write.catch(() => undefined);
    return write;
  }

  async verify(): Promise<void> {
    validateLoopbackBaseUrl(this.settings.weaviateUrl);
    await this.embeddings.health();
    await this.clients().weaviate.ready();
  }

  startOwned(): Promise<void> {
    if (!this.starting) this.starting = this.start().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async start(): Promise<void> {
    if (!this.settings.nativeDownloadsApproved) throw new Error("Enable semantic indexing in settings to approve the initial native model download");
    const base = validateLoopbackBaseUrl(this.settings.weaviateUrl);
    if (this.settings.containerBackend !== "podman" && this.settings.containerBackend !== "docker") throw new Error("Select Podman or Docker in settings");
    const listening = await portOpen(this.settings.weaviateUrl);
    if (!listening && base.hostname === "[::1]") throw new Error("Starting managed Weaviate requires a 127.0.0.1 URL; IPv6 loopback is supported only for an already-running service");
    if (!this.settings.weaviateApiKey && !listening) this.settings.weaviateApiKey = randomSecret();
    await this.saveSecrets();
    const database = this.clients().weaviate;
    if (listening) await database.ready();
    else {
      await this.startWeaviate();
      let ready = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        try { await database.ready(); ready = true; break; } catch { await delay(1000); }
      }
      if (!ready) throw new Error("Local Weaviate did not become ready; check its credentials and container status");
    }
    await this.embeddings.start();
  }

  disconnect(): void {
    this.embeddings.stop();
  }

  async stopOwned(): Promise<void> {
    if (this.starting) await this.starting.catch(() => undefined);
    this.embeddings.stop();
    const id = this.settings.ownedContainer;
    if (id) {
      const result = await exec(this.settings.containerBackend, ["inspect", "--format", "{{ index .Config.Labels \"io.local-semantic.instance\" }}", id]);
      if (!this.settings.ownedContainerInstance || result.stdout.trim() !== this.settings.ownedContainerInstance) throw new Error("Container identity no longer matches; refusing to stop it");
      await exec(this.settings.containerBackend, ["stop", id]);
      await this.saveOwnership();
    }
  }

  private async saveOwnership(): Promise<void> {
    await mkdir(this.runtimeDir, { recursive: true, mode: 0o700 });
    const file = join(this.runtimeDir, "ownership.json");
    await writeFile(`${file}.pending`, JSON.stringify({ ownedContainer: this.settings.ownedContainer, ownedContainerInstance: this.settings.ownedContainerInstance }), { mode: 0o600 });
    await rename(`${file}.pending`, file);
  }

  private async startWeaviate(): Promise<void> {
    if (this.settings.ownedContainer) {
      const result = await exec(this.settings.containerBackend, ["inspect", "--format", "{{ index .Config.Labels \"io.local-semantic.instance\" }}", this.settings.ownedContainer]);
      if (!this.settings.ownedContainerInstance || result.stdout.trim() !== this.settings.ownedContainerInstance) throw new Error("Existing container ownership does not match");
      await exec(this.settings.containerBackend, ["start", this.settings.ownedContainer]);
      return;
    }
    const port = new URL(this.settings.weaviateUrl).port || "80";
    const instance = crypto.randomUUID();
    const dataDir = join(this.runtimeDir, "weaviate");
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const envPath = join(this.runtimeDir, "weaviate.env");
    if (/[\r\n,]/.test(this.settings.weaviateApiKey)) throw new Error("Weaviate API key contains invalid characters");
    await writeFile(envPath, `AUTHENTICATION_APIKEY_ALLOWED_KEYS=${this.settings.weaviateApiKey}\n`, { mode: 0o600 });
    const result = await exec(this.settings.containerBackend, [
      "run", "-d", "--name", `local-semantic-${this.vaultId.slice(0, 12)}`,
      "--label", `io.local-semantic.vault=${this.vaultId}`, "--label", `io.local-semantic.instance=${instance}`,
      "--env-file", envPath, "-p", `127.0.0.1:${port}:8080`, "-v", `${dataDir}:/var/lib/weaviate:Z`,
      "-e", "AUTHENTICATION_ANONYMOUS_ACCESS_ENABLED=false", "-e", "AUTHENTICATION_APIKEY_ENABLED=true",
      "-e", "AUTHENTICATION_APIKEY_USERS=local-semantic-search", "-e", "AUTHORIZATION_ENABLE_RBAC=false",
      "-e", "AUTHORIZATION_ADMINLIST_ENABLED=true", "-e", "AUTHORIZATION_ADMINLIST_USERS=local-semantic-search",
      "-e", "AUTOSCHEMA_ENABLED=false", "-e", "DEFAULT_VECTORIZER_MODULE=none", "-e", "DISABLE_TELEMETRY=true",
      "-e", "PERSISTENCE_DATA_PATH=/var/lib/weaviate", "-e", "CLUSTER_HOSTNAME=local-semantic-search",
      "cr.weaviate.io/semitechnologies/weaviate:1.39.3", "--host", "0.0.0.0", "--port", "8080", "--scheme", "http",
    ], { timeout: 600_000 });
    const id = result.stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Container backend did not return an immutable container identity");
    this.settings.ownedContainer = id;
    this.settings.ownedContainerInstance = instance;
    await this.saveOwnership();
  }
}

function randomSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
}
function missingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
async function portOpen(base: string): Promise<boolean> {
  const url = validateLoopbackBaseUrl(base);
  const pending = Promise.withResolvers<boolean>();
  const socket = createConnection({ host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || "80") });
  socket.setTimeout(1500);
  socket.once("connect", () => { socket.destroy(); pending.resolve(true); });
  socket.once("error", () => { socket.destroy(); pending.resolve(false); });
  socket.once("timeout", () => { socket.destroy(); pending.resolve(false); });
  return pending.promise;
}
