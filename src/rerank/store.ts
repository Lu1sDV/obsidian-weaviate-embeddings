import { chmod, mkdir, open, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { validateRerankSettings } from "./policy";
import { defaultRerankSettings, type Provider, type RerankAccess, type RerankSettings } from "./types";

interface SettingsData {
  version: 1;
  writeId: string;
  settings: RerankSettings;
  consent: Record<Provider, boolean>;
}
interface CredentialData {
  version: 1;
  writeId: string;
  openrouterApiKey: string;
  typesafeApiKey: string;
}
interface LegacyData {
  version: 1;
  settings: RerankSettings;
  consent: Record<Provider, boolean>;
  keys: Record<Provider, string>;
}
interface RuntimeData {
  settings: RerankSettings;
  consent: Record<Provider, boolean>;
  keys: Record<Provider, string>;
}

function fresh(): RuntimeData {
  return {
    settings: defaultRerankSettings(),
    consent: { openrouter: false, typesafe: false },
    keys: { openrouter: "", typesafe: "" },
  };
}
function key(value: unknown): string {
  if (typeof value !== "string" || (value !== "" && !/^[\x21-\x7e]{1,4096}$/.test(value))) {
    throw new Error("Invalid JEV credential");
  }
  return value;
}
function consent(value: unknown): Record<Provider, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid JEV consent");
  const record = value as Record<string, unknown>;
  if (typeof record.openrouter !== "boolean" || typeof record.typesafe !== "boolean") throw new Error("Invalid JEV consent");
  return { openrouter: record.openrouter, typesafe: record.typesafe };
}
function writeIdentity(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) throw new Error("Invalid JEV settings snapshot identity");
  return value;
}
function missing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

/** Cloud policy and credentials are device-local and split so the credential writer never serializes nonsecret policy. */
export class RerankStore {
  private data = fresh();
  private revision = 0;
  private settingsRevision = 0;
  private cloudPolicyRevision = 0;
  private consentRevision = 0;
  private credentialRevision = 0;
  private writes = Promise.resolve();
  private readonly directory: string;

  constructor(vaultId: string, private readonly changed: () => void, directory?: string) {
    if (!/^[A-Za-z0-9-]+$/.test(vaultId)) throw new Error("Invalid vault identity");
    this.directory = directory ?? join(homedir(), ".local", "share", "obsidian-local-semantic", vaultId);
  }

  get settings(): RerankSettings {
    return structuredClone(this.data.settings);
  }

  access(): RerankAccess {
    const settings = this.settings;
    return {
      ...settings,
      revision: this.revision,
      settingsRevision: this.settingsRevision,
      cloudPolicyRevision: this.cloudPolicyRevision,
      consentRevision: this.consentRevision,
      credentialRevision: this.credentialRevision,
      consent: this.data.consent[settings.provider],
      apiKey: this.data.keys[settings.provider],
    };
  }

  private async read(name: string): Promise<unknown | undefined> {
    try {
      const file = await open(join(this.directory, name), "r");
      try {
        if ((await file.stat()).size > 256_000) throw new Error("Device-local JEV file exceeds the size limit");
        return JSON.parse(await file.readFile("utf8")) as unknown;
      } finally {
        await file.close();
      }
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }

  async load(): Promise<void> {
    try {
      const [settingsRaw, credentialsRaw] = await Promise.all([
        this.read("rerank-settings.json"),
        this.read("rerank-credentials.json"),
      ]);
      if (settingsRaw === undefined && credentialsRaw === undefined) {
        this.data = fresh();
        return;
      }

      // Migrate the previous unmerged experimental format, which combined settings/consent/keys.
      if (settingsRaw === undefined && credentialsRaw && typeof credentialsRaw === "object"
        && !Array.isArray(credentialsRaw) && "settings" in credentialsRaw && "consent" in credentialsRaw && "keys" in credentialsRaw) {
        const legacy = credentialsRaw as Partial<LegacyData>;
        if (legacy.version !== 1 || !legacy.keys || typeof legacy.keys !== "object") throw new Error("Invalid legacy JEV settings");
        this.data = {
          settings: validateRerankSettings(legacy.settings),
          consent: consent(legacy.consent),
          keys: { openrouter: key(legacy.keys.openrouter), typesafe: key(legacy.keys.typesafe) },
        };
        await this.persistFiles(false);
        return;
      }

      const next = fresh();
      let settingsWrite: string | undefined;
      let credentialsWrite: string | undefined;

      if (settingsRaw !== undefined) {
        if (!settingsRaw || typeof settingsRaw !== "object" || Array.isArray(settingsRaw)) throw new Error("Invalid JEV settings file");
        const value = settingsRaw as Partial<SettingsData>;
        if (value.version !== 1) throw new Error("Invalid JEV settings file");
        settingsWrite = writeIdentity(value.writeId);
        next.settings = validateRerankSettings(value.settings);
        next.consent = consent(value.consent);
      }

      if (credentialsRaw !== undefined) {
        if (!credentialsRaw || typeof credentialsRaw !== "object" || Array.isArray(credentialsRaw)) throw new Error("Invalid JEV credential file");
        const value = credentialsRaw as Partial<CredentialData>;
        if (value.version !== 1) throw new Error("Invalid JEV credential file");
        credentialsWrite = writeIdentity(value.writeId);
        next.keys = {
          openrouter: key(value.openrouterApiKey),
          typesafe: key(value.typesafeApiKey),
        };
      }

      if (settingsWrite && credentialsWrite && settingsWrite !== credentialsWrite) {
        throw new Error("JEV settings files are from different atomic snapshots");
      }
      this.data = next;
    } catch {
      this.data = fresh();
      throw new Error("Could not load device-local JEV settings; reranking remains disabled");
    }
  }

  configure(patch: Partial<RerankSettings>): Promise<void> {
    const previous = this.data.settings;
    const next = validateRerankSettings({ ...previous, ...patch });
    if (JSON.stringify(previous) === JSON.stringify(next)) return Promise.resolve();
    this.data.settings = next;
    this.settingsRevision++;
    if (previous.provider !== next.provider
      || JSON.stringify(previous.excludedFolders) !== JSON.stringify(next.excludedFolders)
      || JSON.stringify(previous.excludedFiles) !== JSON.stringify(next.excludedFiles)) {
      this.cloudPolicyRevision++;
    }
    return this.save();
  }

  setConsent(provider: Provider, approved: boolean): Promise<void> {
    if (provider !== "openrouter" && provider !== "typesafe") throw new Error("Invalid JEV provider");
    const next = approved === true;
    if (this.data.consent[provider] === next) return Promise.resolve();
    this.data.consent[provider] = next;
    this.consentRevision++;
    this.cloudPolicyRevision++;
    return this.save();
  }

  setKey(provider: Provider, value: string): Promise<void> {
    if (provider !== "openrouter" && provider !== "typesafe") throw new Error("Invalid JEV provider");
    const next = key(value.trim());
    if (this.data.keys[provider] === next) return Promise.resolve();
    this.data.keys[provider] = next;
    this.credentialRevision++;
    return this.save();
  }

  private save(): Promise<void> {
    this.revision++;
    this.changed();
    return this.persistFiles(true);
  }

  private persistFiles(failClosed: boolean): Promise<void> {
    const write = this.writes.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await chmod(this.directory, 0o700);
      const writeId = crypto.randomUUID();
      const settings: SettingsData = {
        version: 1,
        writeId,
        settings: this.data.settings,
        consent: this.data.consent,
      };
      const credentials: CredentialData = {
        version: 1,
        writeId,
        openrouterApiKey: this.data.keys.openrouter,
        typesafeApiKey: this.data.keys.typesafe,
      };
      const pairs = [
        ["rerank-settings.json", settings],
        ["rerank-credentials.json", credentials],
      ] as const;

      for (const [name, payload] of pairs) {
        const target = join(this.directory, name);
        const file = await open(`${target}.pending`, "w", 0o600);
        try {
          await file.chmod(0o600);
          await file.writeFile(JSON.stringify(payload));
          await file.sync();
        } finally {
          await file.close();
        }
      }
      for (const [name] of pairs) {
        await rename(join(this.directory, `${name}.pending`), join(this.directory, name));
      }
    }).catch(() => {
      if (failClosed) {
        this.data.settings.enabled = false;
        this.data.consent = { openrouter: false, typesafe: false };
        this.revision++;
        this.settingsRevision++;
        this.cloudPolicyRevision++;
        this.consentRevision++;
        this.changed();
      }
      throw new Error("Could not save JEV settings; reranking is disabled in this session. Check device-local file permissions.");
    });
    this.writes = write.catch(() => undefined);
    return write;
  }
}
