import { App, FileSystemAdapter, FuzzySuggestModal, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, TFolder } from "obsidian";
import { watch, type FSWatcher } from "node:fs";
import { open, rename } from "node:fs/promises";
import { join } from "node:path";
import { IndexCoordinator } from "./indexer";
import { EMBEDDING_MODELS, getModelProfile, type ChunkingMode } from "./embedding-config";
import { PathPolicy } from "./exclusions";
import { admissionFor } from "./policy";
import { PropertyRegistry } from "./properties";
import { SemanticSearchView, VIEW_TYPE } from "./search-view";
import { ServiceManager, type ServiceSettings } from "./services";
import { mergeState } from "./state";
import { JevReranker } from "./reranking";
import { mergeRerankingSettings, RERANKING_PROVIDERS, type RerankingSettings } from "./reranking-config";
import type { ExclusionSettings, PersistedState } from "./types";

interface PluginData {
  state: PersistedState;
  services: ServiceSettings;
  reranking: RerankingSettings;
  graphEdgeCutoff: number;
  sidebarWidthInitialized: boolean;
}

const defaultServices: ServiceSettings = {
  weaviateUrl: "http://127.0.0.1:8080",
  weaviateApiKey: "",
  openrouterApiKey: "",
  containerBackend: "podman",
  nativeDownloadsApproved: false,
  embeddingDevice: "auto",
};

export default class LocalSemanticSearchPlugin extends Plugin {
  state!: PersistedState;
  serviceSettings!: ServiceSettings;
  rerankingSettings!: RerankingSettings;
  reranker!: JevReranker;
  registry!: PropertyRegistry;
  services!: ServiceManager;
  pathPolicy!: PathPolicy;
  indexer!: IndexCoordinator;
  graphEdgeCutoff = 0.7;
  private sidebarWidthInitialized = false;
  private status = "Indexing is stopped";
  private pluginDir = "";
  private saving: Promise<void> | undefined;
  private saveRequested = false;
  private refreshing: Promise<void> | undefined;
  private refreshRequested = false;
  private disposed = false;
  private changingRuntime = false;

  async onload(): Promise<void> {
    const raw: unknown = await this.loadData();
    if (raw !== null && raw !== undefined && (typeof raw !== "object" || Array.isArray(raw))) throw new Error("Invalid plugin settings; restore the last valid data.json");
    const data = raw as Partial<PluginData> | null;
    this.state = mergeState(data?.state);
    if (typeof data?.graphEdgeCutoff === "number" && Number.isFinite(data.graphEdgeCutoff) && data.graphEdgeCutoff >= -1 && data.graphEdgeCutoff <= 1) this.graphEdgeCutoff = data.graphEdgeCutoff;
    this.sidebarWidthInitialized = data?.sidebarWidthInitialized === true;
    this.rerankingSettings = mergeRerankingSettings(data?.reranking);
    this.serviceSettings = { ...defaultServices, ...data?.services, weaviateApiKey: "", openrouterApiKey: "" };
    if (this.serviceSettings.embeddingDevice !== "auto" && this.serviceSettings.embeddingDevice !== "webgpu" && this.serviceSettings.embeddingDevice !== "wasm") throw new Error("Unsupported embedding device; select auto, webgpu, or wasm");
    this.registry = new PropertyRegistry(this.state.registry);
    if (!this.manifest.dir || !(this.app.vault.adapter instanceof FileSystemAdapter)) throw new Error("This plugin requires a desktop vault");
    this.pluginDir = join(this.app.vault.adapter.getBasePath(), this.manifest.dir);
    // Persist policy migration before any runtime/schema work can serve or overwrite an old generation.
    await this.persist();
    this.services = new ServiceManager(this.serviceSettings, this.state.vaultId, this.pluginDir, message => this.setStatus(message), getModelProfile(this.state.embeddingModel, this.state.chunkingMode));
    await this.services.loadSecrets();
    this.reranker = new JevReranker(() => ({ ...this.rerankingSettings, apiKey: this.serviceSettings.openrouterApiKey ?? "" }));
    this.pathPolicy = new PathPolicy(this.app, this.state);
    const clients = this.services.clients();
    this.indexer = new IndexCoordinator(this.app, this.state, this.registry, clients.embeddings, clients.weaviate, () => this.persist(), message => this.setStatus(message), this.pathPolicy, () => {
      this.views().forEach(view => view.indexChanged());
    });
    const settings = new LocalSemanticSettings(this.app, this);
    this.addSettingTab(settings);
    this.registerView(VIEW_TYPE, leaf => new SemanticSearchView(leaf, this.state, this.registry, clients.embeddings, clients.weaviate, () => this.persist(), this.pathPolicy, this.graphEdgeCutoff, this.reranker));
    this.addRibbonIcon("network", "Open semantic neighbourhood", () => this.run(() => this.activateView()));
    this.addCommand({ id: "open-local-semantic-search", name: "Open semantic neighbourhood", callback: () => this.run(() => this.activateView()) });
    this.addCommand({ id: "stop-owned-local-semantic-services", name: "Stop owned services", callback: () => this.run(() => this.stopOwnedServices()) });
    this.registerEvents();
    this.app.workspace.onLayoutReady(() => this.run(async () => {
      await this.ensureSidebarWidth();
      if (this.state.indexingEnabled) {
        await this.setSemanticIndexing(true);
      } else await this.refreshPolicy();
    }));
    // Dotfiles do not reliably emit Obsidian metadata events. Watch names only; read only .gitignore control files.
    let watcher: FSWatcher | undefined;
    try {
      watcher = watch(this.app.vault.adapter.getBasePath(), { recursive: true }, (_event, filename) => {
        if (filename && /(^|[\\/])\.gitignore$/.test(filename.toString())) this.policyChanged();
      });
      watcher.on("error", () => {
        this.pathPolicy.invalidate();
        this.indexer.invalidateAll();
        this.invalidateViews();
        this.setStatus("Ignore-file watcher unavailable. Reload the plugin before continuing.");
      });
    } catch {
      this.setStatus("Ignore-file watcher unavailable. Reload after changing .gitignore rules.");
    }
    this.register(() => watcher?.close());
  }

  onunload(): void {
    this.disposed = true;
    this.views().forEach(view => view.invalidate());
    this.indexer.stop();
    this.pathPolicy.invalidate();
    this.services.disconnect();
  }

  run(operation: () => Promise<void>): void {
    void operation().catch(error => {
      const message = error instanceof Error ? error.message : "Local semantic operation failed";
      this.setStatus(message);
      new Notice(message, 8000);
    });
  }

  persist(): Promise<void> {
    this.saveRequested = true;
    if (!this.saving) {
      this.saving = (async () => {
        while (this.saveRequested) {
          this.saveRequested = false;
          this.state.registry = this.registry.data();
          const services = { ...this.serviceSettings, weaviateApiKey: "", openrouterApiKey: "" };
          const payload = JSON.stringify({ state: this.state, services, reranking: this.rerankingSettings, graphEdgeCutoff: this.graphEdgeCutoff, sidebarWidthInitialized: this.sidebarWidthInitialized });
          const target = join(this.pluginDir, "data.json");
          const temporary = `${target}.pending`;
          const file = await open(temporary, "w", 0o600);
          try { await file.writeFile(payload); await file.sync(); } finally { await file.close(); }
          await rename(temporary, target);
          const directory = await open(this.pluginDir, "r");
          try { await directory.sync(); } finally { await directory.close(); }
        }
      })().finally(() => { this.saving = undefined; });
    }
    return this.saving;
  }

  async activateView(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf("split", "vertical");
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    await this.ensureSidebarWidth();
  }

  private async ensureSidebarWidth(): Promise<void> {
    if (this.sidebarWidthInitialized) return;
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) return;
    const split = leaf.view.containerEl.closest(".workspace-split.mod-right-split");
    if (!(split instanceof HTMLElement)) return;
    if (split.getBoundingClientRect().width < 520) split.style.width = "520px";
    this.sidebarWidthInitialized = true;
    await this.persist();
    await this.app.workspace.requestSaveLayout();
  }


  async setSemanticIndexing(enabled: boolean): Promise<void> {
    if (this.changingRuntime) throw new Error("An embedding runtime change is already in progress");
    this.changingRuntime = true;
    try { await this.applySemanticIndexing(enabled); }
    finally { this.changingRuntime = false; }
  }

  private async applySemanticIndexing(enabled: boolean): Promise<void> {
    if (enabled) {
      this.serviceSettings.nativeDownloadsApproved = true;
      await this.persist();
      this.setStatus("Starting semantic indexing. Initial model loading may take several minutes.");
      await this.services.startOwned();
      if (this.disposed) { this.services.disconnect(); return; }
      this.state.indexingEnabled = true;
      this.indexer.start();
      this.invalidateViews();
      await this.persist();
      this.run(() => this.refreshPolicy());
      return;
    }
    this.state.indexingEnabled = false;
    this.state.servingReady = false;
    this.indexer.stop();
    this.invalidateViews();
    this.services.disconnect();
    await this.indexer.drain();
    await this.persist();
    this.setStatus("Semantic indexing is disabled");
  }

  async setEmbeddingModel(id: string): Promise<void> {
    await this.setEmbeddingProfile(id, this.state.chunkingMode);
  }

  async setChunkingMode(mode: ChunkingMode): Promise<void> {
    await this.setEmbeddingProfile(this.state.embeddingModel, mode);
  }

  private async setEmbeddingProfile(id: string, mode: ChunkingMode): Promise<void> {
    const profile = getModelProfile(id, mode);
    if (this.changingRuntime) throw new Error("An embedding runtime change is already in progress");
    if (id === this.state.embeddingModel && mode === this.state.chunkingMode) return;
    this.changingRuntime = true;
    const resume = this.state.indexingEnabled;
    try {
      await this.applySemanticIndexing(false);
      // Reconciliation may still be finishing a schema operation after the index queue drains.
      await this.refreshing;
      await this.indexer.drain();
      if (this.disposed) return;
      const generations = new Set(this.state.knownGenerations);
      generations.add(this.state.activeGeneration);
      for (const note of Object.values(this.state.notes)) generations.add(note.generation);
      let generation = this.state.activeGeneration;
      for (const known of generations) generation = Math.max(generation, known);
      generation += 1;
      if (!Number.isSafeInteger(generation)) throw new Error("Index generation limit reached");
      this.state.activeGeneration = generation;
      this.state.knownGenerations = [...generations, generation];
      this.state.schemaUpdating = true;
      this.state.embeddingModel = profile.id;
      this.state.chunkingMode = profile.chunkingMode;
      this.services.clients().embeddings.setModel(profile.id, profile.chunkingMode);
      await this.persist();
      this.setStatus(`${profile.label} · ${profile.chunkingMode} selected; ${resume ? "loading model and rebuilding index" : "enable semantic indexing to load the model and rebuild"}`);
      if (resume) await this.applySemanticIndexing(true);
    } finally {
      this.changingRuntime = false;
    }
  }

  async setEmbeddingDevice(device: "auto" | "webgpu" | "wasm"): Promise<void> {
    if (device !== "auto" && device !== "webgpu" && device !== "wasm") throw new Error("Unsupported embedding device");
    if (this.changingRuntime) throw new Error("An embedding runtime change is already in progress");
    if (device === this.serviceSettings.embeddingDevice) return;
    this.changingRuntime = true;
    const resume = this.state.indexingEnabled;
    try {
      await this.applySemanticIndexing(false);
      await this.refreshing;
      await this.indexer.drain();
      if (this.disposed) return;
      this.serviceSettings.embeddingDevice = device;
      this.services.clients().embeddings.setDevice(device);
      await this.persist();
      if (resume) await this.applySemanticIndexing(true);
    } finally {
      this.changingRuntime = false;
    }
  }

  async stopOwnedServices(): Promise<void> {
    if (this.changingRuntime) throw new Error("An embedding runtime change is already in progress");
    this.changingRuntime = true;
    try {
      await this.applySemanticIndexing(false);
      await this.refreshing;
      await this.indexer.drain();
      await this.services.stopOwned();
      await this.persist();
      this.setStatus("Owned services stopped; borrowed services left running");
    } finally {
      this.changingRuntime = false;
    }
  }

  async applyScope(exclusions: ExclusionSettings): Promise<void> {
    this.state.exclusions = exclusions;
    this.pathPolicy.invalidate();
    this.indexer.invalidateAll();
    this.invalidateViews();
    await this.persist();
    await this.refreshPolicy();
  }

  private policyChanged(): void {
    if (this.disposed) return;
    this.pathPolicy.invalidate();
    this.indexer.invalidateAll();
    this.invalidateViews();
    this.run(() => this.refreshPolicy());
  }

  private refreshPolicy(): Promise<void> {
    this.refreshRequested = true;
    if (!this.refreshing) {
      this.refreshing = (async () => {
        while (this.refreshRequested && !this.disposed) {
          this.refreshRequested = false;
          this.state.servingReady = false;
          await this.pathPolicy.reload(this.app.vault.getMarkdownFiles().map(file => file.path));
          if (this.disposed) return;
          // Reconciliation must record exclusions/deletions even when services are unavailable or indexing is stopped.
          await this.indexer.reconcile();
        }
      })().finally(() => { this.refreshing = undefined; });
    }
    return this.refreshing;
  }

  private registerEvents(): void {
    this.registerEvent(this.app.vault.on("modify", file => {
      if (file instanceof TFile) {
        this.indexer.markDirty(file);
        const noteId = this.state.pathToNoteId[file.path];
        if (noteId) this.invalidateViews(noteId);
      }
    }));
    this.registerEvent(this.app.metadataCache.on("changed", (file, data, cache) => {
      const noteId = this.state.pathToNoteId[file.path];
      const admission = admissionFor(file, cache, this.pathPolicy);
      if (!admission.admitted && !admission.deferred && noteId) {
        this.indexer.enqueuePurge(noteId);
        this.invalidateViews(noteId);
      } else {
        if (admission.admitted) this.indexer.enqueue(file, cache, data);
        if (noteId) this.invalidateViews(noteId);
      }
    }));
    this.registerEvent(this.app.metadataCache.on("resolved", () => this.run(() => this.refreshPolicy())));
    this.registerEvent(this.app.vault.on("create", file => {
      if (file instanceof TFile && file.extension.toLowerCase() === "md") this.policyChanged();
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof TFile) this.indexer.rename(file, oldPath);
      this.policyChanged();
    }));
    this.registerEvent(this.app.vault.on("delete", file => {
      const noteId = this.state.pathToNoteId[file.path];
      this.indexer.delete(file.path);
      if (noteId) this.invalidateViews(noteId);
      if (file instanceof TFolder) this.policyChanged();
    }));
    this.registerEvent(this.app.workspace.on("file-open", file => this.views().forEach(view => view.follow(file))));
  }

  private views(): SemanticSearchView[] {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE).map(leaf => leaf.view).filter((view): view is SemanticSearchView => view instanceof SemanticSearchView);
  }

  private invalidateViews(noteId?: string): void {
    this.views().forEach(view => view.invalidate(noteId));
  }

  private setStatus(message: string): void {
    this.status = message;
    this.views().forEach(view => view.setStatus(message));
  }

  async setRerankingSettings(settings: RerankingSettings): Promise<void> {
    this.rerankingSettings = mergeRerankingSettings(settings);
    this.views().forEach(view => view.rerankingChanged());
    await this.persist();
  }

  async setOpenRouterApiKey(value: string): Promise<void> {
    this.serviceSettings.openrouterApiKey = value.trim();
    this.views().forEach(view => view.rerankingChanged());
    await this.services.saveSecrets();
  }

  getStatus(): string { return this.status; }

  async checkWeaviate(): Promise<void> {
    await this.services.clients().weaviate.ready();
    this.setStatus("Weaviate is connected and ready");
    new Notice("Weaviate is connected and ready");
  }

  async setGraphEdgeCutoff(cutoff: number): Promise<void> {
    if (!Number.isFinite(cutoff) || cutoff < -1 || cutoff > 1) throw new Error("Edge cutoff must be between -1 and 1");
    this.graphEdgeCutoff = cutoff;
    this.views().forEach(view => view.setEdgeCutoff(cutoff));
    await this.persist();
  }
}


class ExclusionPicker extends FuzzySuggestModal<TAbstractFile> {
  constructor(app: App, private readonly folder: boolean, private readonly choose: (path: string) => void) {
    super(app);
    this.setPlaceholder(folder ? "Choose a folder to exclude" : "Choose a Markdown file to exclude");
  }
  getItems(): TAbstractFile[] {
    return this.app.vault.getAllLoadedFiles().filter(file => this.folder ? file instanceof TFolder : file instanceof TFile && file.extension.toLowerCase() === "md");
  }
  getItemText(file: TAbstractFile): string { return file.path || "/"; }
  onChooseItem(file: TAbstractFile): void { this.choose(file.path); }
}

function parsePaths(value: string, rootAllowed: boolean): string[] {
  const paths = value.split("\n").map(path => path.trim()).filter(Boolean).map(path => {
    if (path === "/" && rootAllowed) return "";
    if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.split(/[\\/]/).some(part => part === ".." || part === ".")) throw new Error("Use vault-relative paths without . or ..");
    return path.replaceAll("\\", "/").replace(/\/+$/, "");
  });
  return [...new Set(paths)];
}

class LocalSemanticSettings extends PluginSettingTab {
  constructor(app: App, private readonly plugin: LocalSemanticSearchPlugin) { super(app, plugin); }
  display(): void {
    const root = this.containerEl;
    root.empty();
    root.addClass("local-semantic-settings");
    root.createEl("h2", { text: "Local services" });
    new Setting(root).setName("Container backend").addDropdown(dropdown => dropdown.addOption("podman", "Podman").addOption("docker", "Docker").setValue(this.plugin.serviceSettings.containerBackend).onChange(value => {
      if (value !== "podman" && value !== "docker") return;
      this.plugin.serviceSettings.containerBackend = value;
      this.plugin.run(() => this.plugin.persist());
    }));
    new Setting(root).setName("Weaviate URL").setDesc("Explicit loopback HTTP only; no remote hosts.").addText(input => input.setValue(this.plugin.serviceSettings.weaviateUrl).onChange(value => {
      this.plugin.serviceSettings.weaviateUrl = value;
      this.plugin.run(() => this.plugin.persist());
    }));
    new Setting(root).setName("Weaviate API key").setDesc("For a borrowed compatible service. Stored outside the vault.").addText(input => {
      input.inputEl.type = "password";
      input.setValue(this.plugin.serviceSettings.weaviateApiKey).onChange(value => {
        this.plugin.serviceSettings.weaviateApiKey = value;
        this.plugin.run(() => this.plugin.services.saveSecrets());
      });
    });
    const connectionSetting = new Setting(root).setName("Check Weaviate connection").setDesc("Calls Weaviate's authenticated readiness endpoint.");
    connectionSetting.addButton(button => button.setButtonText("Check connection").onClick(() => this.plugin.run(async () => {
      button.setDisabled(true).setButtonText("Checking…");
      try {
        await this.plugin.checkWeaviate();
        connectionSetting.setDesc("Weaviate is connected and ready.");
        button.setButtonText("Connected");
      } catch (error) {
        connectionSetting.setDesc("Weaviate is unavailable. See the reported status for details.");
        button.setButtonText("Retry");
        throw error;
      } finally {
        button.setDisabled(false);
      }
    })));
    new Setting(root).setName("Embedding model").setDesc("Runs locally. Changing models downloads missing model files and rebuilds the index; old-model results are hidden immediately.").addDropdown(dropdown => {
      dropdown.selectEl.setAttribute("aria-label", "Embedding model");
      for (const profile of EMBEDDING_MODELS) dropdown.addOption(profile.id, `${profile.label} — ${profile.contextLimit.toLocaleString()} tokens`);
      if (this.plugin.state.chunkingMode === "late") {
        for (const option of dropdown.selectEl.options) option.disabled = option.value !== "jinaai/jina-embeddings-v2-small-en";
      }
      dropdown.setValue(this.plugin.state.embeddingModel).onChange(value => this.plugin.run(async () => {
        dropdown.setDisabled(true);
        try { await this.plugin.setEmbeddingModel(value); }
        finally { this.display(); }
      }));
    });
    new Setting(root).setName("Chunking mode").setDesc("Standard embeds structure-aware passages independently. Late pools passages from their full context (Jina only). Changing mode rebuilds the index.").addDropdown(dropdown => {
      dropdown.selectEl.setAttribute("aria-label", "Chunking mode");
      dropdown.addOption("standard", "Standard").addOption("late", "Late — Jina contextual pooling");
      dropdown.selectEl.options[1]!.disabled = this.plugin.state.embeddingModel !== "jinaai/jina-embeddings-v2-small-en";
      dropdown.setValue(this.plugin.state.chunkingMode).onChange(value => this.plugin.run(async () => {
        if (value !== "standard" && value !== "late") throw new Error("Unsupported chunking mode");
        dropdown.setDisabled(true);
        try { await this.plugin.setChunkingMode(value); }
        finally { this.display(); }
      }));
    });
    new Setting(root).setName("Embedding device").setDesc("Explicit WebGPU and CPU choices fail closed. Automatic tries WebGPU, then CPU if initialization fails.").addDropdown(dropdown => {
      dropdown.selectEl.setAttribute("aria-label", "Embedding device");
      dropdown.addOption("auto", "Automatic").addOption("webgpu", "WebGPU").addOption("wasm", "CPU — WASM");
      dropdown.setValue(this.plugin.serviceSettings.embeddingDevice ?? "auto").onChange(value => this.plugin.run(async () => {
        if (value !== "auto" && value !== "webgpu" && value !== "wasm") throw new Error("Unsupported embedding device");
        dropdown.setDisabled(true);
        try { await this.plugin.setEmbeddingDevice(value); }
        finally { this.display(); }
      }));
    });
    new Setting(root).setName("Enable semantic indexing").setDesc("Enabling consents to downloading the selected local ONNX model if missing. Services start on launch. Edited notes wait for 13 seconds of quiet; unchanged compatible vectors are reused. Exclusions apply immediately.").addToggle(toggle => {
      toggle.setValue(this.plugin.state.indexingEnabled).onChange(value => this.plugin.run(async () => {
        try { await this.plugin.setSemanticIndexing(value); }
        finally { toggle.setValue(this.plugin.state.indexingEnabled); }
      }));
    });
    new Setting(root).setName("Stop owned services").setDesc("Stops indexing first and waits for outstanding work. Borrowed services survive.").addButton(button => button.setButtonText("Stop owned services").setWarning().onClick(() => this.plugin.run(() => this.plugin.stopOwnedServices())));
    root.createEl("p", { text: `Status: ${this.plugin.getStatus()}`, cls: "setting-item-description" });
    root.createEl("h2", { text: "Search reranking" });
    root.createEl("p", { text: "Optional cloud processing. When enabled, Search queries, candidate note titles, and bounded matched-passage excerpts are sent to OpenRouter and TypeSafe. Connections and embedding/indexing remain local. Requests may incur OpenRouter charges. Content already sent cannot be recalled by disabling this option.", cls: "setting-item-description" });
    new Setting(root).setName("Reranking provider").setDesc("Only JEV and its native Decisions JSON format are supported.").addDropdown(dropdown => {
      dropdown.selectEl.setAttribute("aria-label", "Reranking provider");
      for (const provider of RERANKING_PROVIDERS) dropdown.addOption(provider.id, provider.label);
      dropdown.setValue(this.plugin.rerankingSettings.provider).onChange(value => {
        const provider = RERANKING_PROVIDERS.find(item => item.id === value);
        if (provider) this.plugin.run(() => this.plugin.setRerankingSettings({ ...this.plugin.rerankingSettings, provider: provider.id }));
      });
    });
    new Setting(root).setName("Enable search reranking").setDesc("Off by default. Enabling permits the cloud processing described above. API failures preserve the original hybrid ranking.").addToggle(toggle => {
      toggle.setValue(this.plugin.rerankingSettings.enabled).onChange(enabled => this.plugin.run(async () => {
        try { await this.plugin.setRerankingSettings({ ...this.plugin.rerankingSettings, enabled }); }
        finally { toggle.setValue(this.plugin.rerankingSettings.enabled); }
      }));
    });
    let openrouterApiKey = this.plugin.serviceSettings.openrouterApiKey ?? "";
    const keySetting = new Setting(root).setName("OpenRouter API key").setDesc("Stored in the local credential file outside the vault, not in data.json. Save an empty value to remove it.");
    keySetting.addText(input => {
      input.inputEl.type = "password";
      input.inputEl.autocomplete = "off";
      input.setValue(openrouterApiKey).onChange(value => { openrouterApiKey = value; });
    });
    keySetting.addButton(button => button.setButtonText("Save key").onClick(() => this.plugin.run(async () => {
      button.setDisabled(true);
      try {
        await this.plugin.setOpenRouterApiKey(openrouterApiKey);
        new Notice(openrouterApiKey.trim() ? "OpenRouter API key saved" : "OpenRouter API key removed");
      } finally { button.setDisabled(false); }
    })));
    root.createEl("h2", { text: "Similarity graph" });
    new Setting(root).setName("Edge cutoff").setDesc("Minimum cosine similarity for a visible Search-mode edge. Connections always shows one labelled edge from the current note to each result. Rankings never change.").addDropdown(dropdown => {
      dropdown.addOption("-1", "Show all edges");
      for (let step = 0; step <= 20; step += 1) {
        const value = step / 20;
        dropdown.addOption(String(value), value.toFixed(2));
      }
      const current = this.plugin.graphEdgeCutoff;
      if (current !== -1 && !Number.isInteger(current * 20)) dropdown.addOption(String(current), current.toFixed(2));
      dropdown.setValue(String(current)).onChange(value => this.plugin.run(() => this.plugin.setGraphEdgeCutoff(Number(value))));
    });
    root.createEl("h2", { text: "Index scope & exclusions" });
    root.createEl("p", { text: "Only Markdown notes are indexed. Canvas, images, PDFs, attachments, .git and plugin internals stay out. Privacy tags and ai_index: false always take precedence.", cls: "setting-item-description" });
    const settings = this.plugin.state;
    let folders = settings.exclusions.folders.join("\n");
    let files = settings.exclusions.files.join("\n");
    let respectGitignore = settings.exclusions.respectGitignore;
    new Setting(root).setName("Respect .gitignore").setDesc("Honor root and nested Git ignore rules. Ignore files are policy input, never embedded.").addToggle(toggle => toggle.setValue(respectGitignore).onChange(value => { respectGitignore = value; }));
    const folderSetting = new Setting(root).setName("Excluded folders").setDesc("Literal paths, one per line. All descendants are excluded.");
    folderSetting.addTextArea(input => {
      input.setValue(folders).onChange(value => { folders = value; });
      folderSetting.addButton(button => button.setButtonText("Choose folder").onClick(() => new ExclusionPicker(this.app, true, path => { folders = [folders, path || "/"].filter(Boolean).join("\n"); input.setValue(folders); }).open()));
    });
    const fileSetting = new Setting(root).setName("Excluded files").setDesc("Literal vault-relative paths, one per line.");
    fileSetting.addTextArea(input => {
      input.setValue(files).onChange(value => { files = value; });
      fileSetting.addButton(button => button.setButtonText("Choose file").onClick(() => new ExclusionPicker(this.app, false, path => { files = [files, path].filter(Boolean).join("\n"); input.setValue(files); }).open()));
    });
    new Setting(root).setName("Apply exclusion changes").setDesc("Changes apply immediately. When semantic indexing is enabled, eligible notes are reindexed automatically. Offline deletions remain pending.").addButton(button => button.setButtonText("Apply exclusions").setCta().onClick(() => this.plugin.run(async () => {
      await this.plugin.applyScope({ respectGitignore, folders: parsePaths(folders, true), files: parsePaths(files, false) });
      new Notice("Exclusions updated");
    })));
    const explanation = root.createEl("p", { cls: "local-semantic-path-reason", attr: { role: "status" }, text: "Enter a path to inspect the applied exclusion rules." });
    new Setting(root).setName("Check a path").addText(input => input.setPlaceholder("Notes/Example.md").onChange(value => {
      const decision = this.plugin.pathPolicy.check(value);
      explanation.setText(decision.admitted ? "Path passes scope rules. Metadata and privacy tags are checked before indexing." : decision.reason ?? "Path is excluded");
    }));
  }
}
