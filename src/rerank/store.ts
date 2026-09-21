import { chmod, mkdir, open, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { validateRerankSettings } from "./policy";
import { defaultRerankSettings, type Provider, type RerankAccess, type RerankSettings } from "./types";

interface DeviceData {
  version: 1;
  settings: RerankSettings;
  consent: Record<Provider, boolean>;
  keys: Record<Provider, string>;
}
function defaults(): DeviceData {
  return { version: 1, settings: defaultRerankSettings(), consent: { openrouter: false, typesafe: false }, keys: { openrouter: "", typesafe: "" } };
}
function key(value: unknown): string {
  if (typeof value !== "string" || (value !== "" && !/^[\x21-\x7e]{1,4096}$/.test(value))) throw new Error("Invalid JEV credential");
  return value;
}
function decode(raw: unknown): DeviceData {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid device-local JEV settings");
  const data = raw as Partial<DeviceData>;
  if (data.version !== 1 || !data.consent || !data.keys
    || typeof data.consent.openrouter !== "boolean" || typeof data.consent.typesafe !== "boolean") throw new Error("Invalid device-local JEV settings");
  return { version: 1, settings: validateRerankSettings(data.settings),
    consent: { openrouter: data.consent.openrouter, typesafe: data.consent.typesafe },
    keys: { openrouter: key(data.keys.openrouter), typesafe: key(data.keys.typesafe) } };
}

/** Never included in plugin data.json. File modes are access control, not encryption. */
export class RerankStore {
  private data = defaults();
  private revision = 0;
  private writes = Promise.resolve();
  private readonly directory: string;
  constructor(vaultId: string, private readonly changed: () => void, directory?: string) {
    if (!/^[A-Za-z0-9-]+$/.test(vaultId)) throw new Error("Invalid vault identity");
    this.directory = directory ?? join(homedir(), ".local", "share", "obsidian-local-semantic", vaultId);
  }
  get settings(): RerankSettings { return structuredClone(this.data.settings); }
  access(): RerankAccess {
    const settings = this.settings;
    return { ...settings, revision: this.revision, consent: this.data.consent[settings.provider], apiKey: this.data.keys[settings.provider] };
  }
  async load(): Promise<void> {
    try {
      const filename = join(this.directory, "rerank-credentials.json");
      const file = await open(filename, "r");
      let text: string;
      try {
        if ((await file.stat()).size > 256_000) throw new Error("JEV settings exceed the device-local size limit");
        text = await file.readFile("utf8");
      } finally { await file.close(); }
      this.data = decode(JSON.parse(text));
    } catch (error) {
      this.data = defaults();
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw new Error("Could not load device-local JEV settings; reranking remains disabled");
    }
  }
  configure(patch: Partial<RerankSettings>): Promise<void> {
    this.data.settings = validateRerankSettings({ ...this.data.settings, ...patch });
    return this.save();
  }
  setConsent(provider: Provider, approved: boolean): Promise<void> {
    if (provider !== "openrouter" && provider !== "typesafe") throw new Error("Invalid JEV provider");
    this.data.consent[provider] = approved === true;
    return this.save();
  }
  setKey(provider: Provider, value: string): Promise<void> {
    if (provider !== "openrouter" && provider !== "typesafe") throw new Error("Invalid JEV provider");
    this.data.keys[provider] = key(value.trim());
    return this.save();
  }
  private save(): Promise<void> {
    this.revision++;
    this.changed(); // Abort and revoke in memory before waiting for any filesystem work.
    const write = this.writes.then(async () => {
      // Serialize current state so an earlier failed write cannot later restore stale consent.
      const payload = JSON.stringify(this.data);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await chmod(this.directory, 0o700);
      const target = join(this.directory, "rerank-credentials.json");
      const file = await open(`${target}.pending`, "w", 0o600);
      try { await file.chmod(0o600); await file.writeFile(payload); await file.sync(); }
      finally { await file.close(); }
      await rename(`${target}.pending`, target);
    }).catch(() => {
      this.data.settings.enabled = false;
      this.data.consent = { openrouter: false, typesafe: false };
      this.revision++;
      this.changed();
      throw new Error("Could not save JEV settings; reranking is disabled in this session. Previous disk consent may remain after restart. Check device-local file permissions.");
    });
    this.writes = write.catch(() => undefined);
    return write;
  }
}
