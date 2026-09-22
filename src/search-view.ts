import { ItemView, Keymap, Menu, TFile, WorkspaceLeaf } from "obsidian";
import { EmbeddingClient } from "./embeddings";
import type { PathPolicy } from "./exclusions";
import { buildConnectionGraph, buildSimilarityGraph, visibleResults, type SimilarityGraphData } from "./graph";
import { expandSearchPool } from "./search/retrieval-service";
import { remoteNoteAllowed } from "./rerank/policy";
import type { RerankService } from "./rerank/service";
import type { RerankStore } from "./rerank/store";
import { REASON_LABELS, type RerankMetrics } from "./rerank/types";
import { admissionFor, canonicalInput } from "./policy";
import { stripFrontmatter } from "./policy-core";
import { canonicalJson, PropertyRegistry } from "./properties";
import { SimilarityGraph, type GraphSelection } from "./similarity-graph";
import type { PersistedState, PropertyFilter, PropertyKind, SearchResult } from "./types";
import { WeaviateClient, type HybridWindow, type RetrievedNoteCandidate } from "./weaviate";

export const VIEW_TYPE = "local-semantic-search";
type Mode = "connections" | "search";
type Passage = SearchResult["passages"][number];
interface PassageTarget { noteId: string; snapshotId: string; passage: Passage; label: string }
interface ModeMemory { filters: PropertyFilter[]; expanded: Map<string, string>; scroll: number }
interface QueryContext { epoch: number; mode: Mode; generation: number; fingerprint: string; anchor?: SearchResult; targetPassageId?: string }
interface SearchSeed {
  context: QueryContext; query: string; filters: PropertyFilter[]; vector: number[]; window: HybridWindow;
  baseline: SearchResult[]; graph: SimilarityGraphData | undefined; graphFailed: boolean; exhausted: boolean;
}
interface PendingRanking {
  results: SearchResult[]; graph: SimilarityGraphData | undefined; graphFailed: boolean;
  metrics: RerankMetrics; current: () => boolean;
}
interface FilterControls { updateFields: () => void; updatePresets: () => void; updateChips: () => void }
const OPERATOR_LABELS: Record<PropertyFilter["operator"], string> = {
  eq: "equals", ne: "does not equal", gt: "greater than", gte: "at least", lt: "less than", lte: "at most",
  containsAny: "contains any", containsAll: "contains all", missing: "is missing", null: "is null", empty: "is an empty list",
};

export class SemanticSearchView extends ItemView {
  private mode: Mode = "connections";
  private reference: TFile | null = null;
  private paused = false;
  private targetPassage: PassageTarget | undefined;
  private query = "";
  private results: SearchResult[] = [];
  private context: QueryContext | undefined;
  private requestEpoch = 0;
  private searchTimer: number | undefined;
  private queryActive = false;
  private activeQueryEpoch: number | undefined;
  private queryPending = false;
  private closed = false;
  private needsRefresh = true;
  private serviceStatus = "Indexing is stopped";
  private inspectionEpoch = 0;
  private inspectionActive = false;
  private pendingInspection: { selection: GraphSelection; context: QueryContext; epoch: number } | undefined;
  private searchSeed: SearchSeed | undefined;
  private rerankJob: AbortController | undefined;
  private rerankCandidates: readonly RetrievedNoteCandidate[] = [];
  private pendingRanking: PendingRanking | undefined;
  private reranked = false;
  private interactionEpoch = 0;
  private rerankButton!: HTMLButtonElement;
  private applyRerankButton!: HTMLButtonElement;
  private rerankStatus!: HTMLElement;
  private readonly passageRequests = new Map<string, Promise<SearchResult["passages"]>>();
  private readonly memory: Record<Mode, ModeMemory> = {
    connections: { filters: [], expanded: new Map(), scroll: 0 },
    search: { filters: [], expanded: new Map(), scroll: 0 },
  };
  private readonly panels = new Map<Mode, HTMLElement>();
  private readonly tabs = new Map<Mode, HTMLButtonElement>();
  private readonly filterControls = new Map<Mode, FilterControls>();
  private readonly articles = new Map<string, HTMLElement>();
  private referenceLabel!: HTMLElement;
  private targetButton!: HTMLButtonElement;
  private pauseButton!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private resultStatusEl!: HTMLElement;
  private scrollEl!: HTMLElement;
  private listEl!: HTMLElement;
  private inspectorEl!: HTMLElement;
  private graph!: SimilarityGraph;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly state: PersistedState,
    private readonly registry: PropertyRegistry,
    private readonly embeddings: EmbeddingClient,
    private readonly weaviate: WeaviateClient,
    private readonly persist: () => Promise<void>,
    private readonly pathPolicy: PathPolicy,
    private edgeCutoff: number,
    private readonly reranker?: RerankService,
    private readonly rerankStore?: RerankStore,
  ) { super(leaf); }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return "Local semantic search"; }
  getIcon(): string { return "network"; }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.reference = this.app.workspace.getActiveFile();
    this.buildControls();
    this.requestRefresh();
  }

  async onClose(): Promise<void> {
    this.closed = true;
    this.embeddings.setCurrentQuery("");
    this.cancelRequests();
    this.clearVisible();
  }

  follow(file: TFile | null): void {
    if (this.paused || this.reference === file) return;
    this.reference = file;
    this.targetPassage = undefined;
    this.updateReference();
    if (this.mode === "connections") this.requestRefresh();
  }

  invalidate(noteId?: string): void {
    if (!noteId || this.rerankCandidates.some(candidate => candidate.result.noteId === noteId)
      || this.searchSeed?.window.notes.some(candidate => candidate.result.noteId === noteId)) {
      if (this.reranked && this.searchSeed) this.publishRanking(this.searchSeed.baseline, this.searchSeed.graph, this.searchSeed.graphFailed, false);
      this.cancelRerank();
      this.searchSeed = undefined;
      this.updateRerankControls();
      this.rerankStatus?.setText("Local results retained — candidate snapshots changed");
    }
    if (noteId && this.targetPassage?.noteId === noteId) this.targetPassage = undefined;
    if (!noteId || this.context?.anchor?.noteId === noteId || this.results.some((result) => result.noteId === noteId)
      || (this.reference && this.state.pathToNoteId[this.reference.path] === noteId)) {
      this.cancelRequests();
      this.clearVisible();
      this.needsRefresh = true;
      this.updateReference();
      this.resultStatusEl?.setText("Waiting for a current admitted snapshot");
    }
  }

  /** Progress updates touch text only, never graph, result DOM, or input controls. */
  setStatus(message: string): void {
    this.serviceStatus = message;
    this.statusEl?.setText(message);
  }

  indexChanged(): void {
    if (this.closed || !this.statusEl) return;
    if (this.context && !this.displayCurrent(this.context)) this.invalidate();
    this.updateReference();
    for (const controls of this.filterControls.values()) controls.updateFields();
    this.needsRefresh = true;
    if (this.state.servingReady && !this.queryPending && this.searchTimer === undefined) this.requestRefresh();
  }

  setEdgeCutoff(cutoff: number): void {
    this.edgeCutoff = cutoff;
    this.graph?.setCutoff(cutoff);
  }

  private buildControls(): void {
    const root = this.contentEl;
    root.replaceChildren();
    root.addClass("local-semantic-search");
    const tabs = root.createDiv({ cls: "local-semantic-tabs", attr: { role: "tablist", "aria-label": "Discovery mode" } });
    for (const mode of ["connections", "search"] as const) {
      const button = tabs.createEl("button", { text: mode === "connections" ? "Connections" : "Search", attr: { role: "tab" } });
      this.tabs.set(mode, button);
      button.addEventListener("click", () => this.switchMode(mode));
      button.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const next = mode === "connections" ? "search" : "connections";
        this.switchMode(next);
        this.tabs.get(next)?.focus();
      });
    }
    for (const mode of ["connections", "search"] as const) {
      const panel = root.createDiv({ cls: "local-semantic-mode", attr: { role: "tabpanel", "aria-label": mode === "connections" ? "Connections controls" : "Search controls" } });
      this.panels.set(mode, panel);
      const controls = panel.createDiv({ cls: "local-semantic-controls" });
      if (mode === "connections") {
        this.referenceLabel = controls.createSpan({ cls: "local-semantic-reference" });
        this.targetButton = controls.createEl("button", { text: "Target…", attr: { "aria-label": "Change Connections target" } });
        this.targetButton.addEventListener("click", (event) => void this.openTargetMenu(event));
        this.pauseButton = controls.createEl("button");
        this.pauseButton.addEventListener("click", () => {
          this.paused = !this.paused;
          if (!this.paused) {
            this.targetPassage = undefined;
            this.reference = this.app.workspace.getActiveFile();
          }
          this.updateReference();
          this.requestRefresh();
        });
      } else {
        const input = controls.createEl("input", { type: "search", value: this.query, placeholder: "Search passages", attr: { "aria-label": "Search passages" } });
        input.addEventListener("input", () => {
          this.query = input.value;
          this.embeddings.setCurrentQuery(this.query);
          // Cancel publication now, not when the debounce expires.
          this.requestRefresh(250);
        });
        this.rerankButton = controls.createEl("button", { text: "Rerank with JEV", attr: { "aria-label": "Rerank Search with the configured cloud provider" } });
        this.rerankButton.addEventListener("click", () => void this.rerankSearch());
        this.applyRerankButton = controls.createEl("button", { text: "Apply JEV ranking" });
        this.applyRerankButton.hidden = true;
        this.applyRerankButton.addEventListener("click", () => this.applyPendingRanking());
        this.rerankStatus = panel.createDiv({ cls: "local-semantic-muted", attr: { role: "status" } });
        this.updateRerankControls();
      }
      this.filterControls.set(mode, this.buildFilters(panel, mode));
    }
    this.statusEl = root.createDiv({ cls: "local-semantic-status", text: this.serviceStatus, attr: { role: "status" } });
    this.resultStatusEl = root.createDiv({ cls: "local-semantic-result-status", attr: { role: "status" } });
    this.scrollEl = root.createDiv({ cls: "local-semantic-surface" });
    for (const event of ["pointerdown", "keydown", "scroll"] as const) this.scrollEl.addEventListener(event, () => { this.interactionEpoch++; });
    this.graph = new SimilarityGraph(this.scrollEl.createDiv(), (selection) => this.selectGraph(selection), () => {
      if (this.context && this.displayCurrent(this.context)) return true;
      this.invalidate();
      return false;
    }, this.edgeCutoff);
    this.inspectorEl = this.scrollEl.createDiv({ cls: "local-semantic-inspector" });
    this.inspectorEl.hidden = true;
    this.scrollEl.createEl("h3", { text: "Ranked notes", cls: "local-semantic-list-heading" });
    this.listEl = this.scrollEl.createDiv({ cls: "local-semantic-results" });
    this.updateMode();
  }

  private switchMode(mode: Mode): void {
    if (mode === this.mode) return;
    this.memory[this.mode].scroll = this.scrollEl.scrollTop;
    this.cancelRequests();
    this.clearVisible(false);
    this.mode = mode;
    this.updateMode();
    this.requestRefresh();
  }

  private updateMode(): void {
    for (const [mode, panel] of this.panels) panel.hidden = mode !== this.mode;
    for (const [mode, button] of this.tabs) {
      button.toggleClass("is-active", mode === this.mode);
      button.setAttribute("aria-selected", String(mode === this.mode));
      button.tabIndex = mode === this.mode ? 0 : -1;
    }
    this.updateReference();
  }

  private updateReference(): void {
    if (!this.referenceLabel) return;
    const note = this.reference ? this.state.notes[this.state.pathToNoteId[this.reference.path] ?? ""] : undefined;
    const current = note && this.resultCurrent(
      { noteId: note.noteId, snapshotId: note.snapshotId, path: note.path, title: "", score: 1, scoreKind: "similarity", passages: [] },
      { epoch: this.requestEpoch, mode: this.mode, generation: this.state.activeGeneration, fingerprint: note.modelFingerprint },
    );
    if (this.targetPassage && (!note || this.targetPassage.noteId !== note.noteId || this.targetPassage.snapshotId !== note.snapshotId)) this.targetPassage = undefined;
    const label = current ? this.targetPassage?.label ?? this.reference!.basename : this.reference ? "Reference excluded or waiting for a current snapshot" : "Open a Markdown note";
    this.referenceLabel.setText(label);
    this.referenceLabel.setAttribute("title", label);
    this.targetButton.disabled = !current;
    this.pauseButton.setText(this.paused ? "Resume" : "Pause");
    this.pauseButton.setAttribute("aria-pressed", String(this.paused));
    this.pauseButton.setAttribute("aria-label", this.paused ? "Resume following the active note" : "Pause following; keep this reference");
  }

  private async openTargetMenu(event: MouseEvent): Promise<void> {
    event.preventDefault();
    const file = this.reference;
    const note = file ? this.state.notes[this.state.pathToNoteId[file.path] ?? ""] : undefined;
    if (!file || !note) return;
    this.targetButton.disabled = true;
    try {
      const [passages, markdown] = await Promise.all([
        this.weaviate.passagesForNote(note.generation, note.noteId, note.snapshotId, note.modelFingerprint),
        this.app.vault.cachedRead(file),
      ]);
      if (this.reference !== file || this.state.notes[note.noteId]?.snapshotId !== note.snapshotId || !this.resultCurrent(
        { noteId: note.noteId, snapshotId: note.snapshotId, path: note.path, title: file.basename, score: 1, scoreKind: "similarity", passages: [] },
        { epoch: this.requestEpoch, mode: this.mode, generation: note.generation, fingerprint: note.modelFingerprint },
      )) return;
      const body = stripFrontmatter(markdown);
      const frontmatterLines = markdown.slice(0, markdown.length - body.length).split("\n").length - 1;
      const titleLines = canonicalInput(file, "").split("\n").length - 1;
      const menu = new Menu();
      menu.addItem((item) => item.setTitle("Whole note").setIcon("file-text").setChecked(this.targetPassage === undefined).onClick(() => {
        if (this.reference !== file || this.state.notes[note.noteId]?.snapshotId !== note.snapshotId) return;
        this.targetPassage = undefined;
        this.paused = true;
        this.updateReference();
        this.requestRefresh();
      }));
      if (passages.length) menu.addSeparator();
      for (const passage of passages) {
        const startLine = frontmatterLines + Math.max(0, passage.startLine - titleLines) + 1;
        const endLine = Math.max(startLine, frontmatterLines + Math.max(0, passage.endLine - titleLines));
        const heading = passage.heading ? passage.heading.replaceAll(" / ", " > ") : "Content";
        const label = `${file.name} > ${heading} > Lines ${startLine}-${endLine}`;
        menu.addItem((item) => item.setTitle(label).setIcon("text").setChecked(this.targetPassage?.snapshotId === note.snapshotId && this.targetPassage.passage.passageId === passage.passageId).onClick(() => {
          if (this.reference !== file || this.state.notes[note.noteId]?.snapshotId !== note.snapshotId) return;
          this.targetPassage = { noteId: note.noteId, snapshotId: note.snapshotId, passage, label };
          this.paused = true;
          this.updateReference();
          this.requestRefresh();
        }));
      }
      menu.showAtMouseEvent(event);
    } catch {
      if (this.reference === file) this.resultStatusEl.setText("Current passage targets are unavailable");
    } finally {
      this.updateReference();
    }
  }

  private buildFilters(parent: HTMLElement, mode: Mode): FilterControls {
    const memory = this.memory[mode];
    const section = parent.createEl("details", { cls: "local-semantic-filters" });
    const summary = section.createEl("summary", { text: "Property filters" });
    const chips = section.createDiv({ cls: "local-semantic-chips" });
    const row = section.createDiv({ cls: "local-semantic-filter-row" });
    const field = row.createEl("select", { attr: { "aria-label": "Property and type" } });
    const operator = row.createEl("select", { attr: { "aria-label": "Filter operator" } });
    const value = row.createEl("input", { type: "text", attr: { "aria-label": "Filter value" } });
    const boolean = row.createEl("select", { attr: { "aria-label": "Boolean filter value" } });
    boolean.createEl("option", { text: "true", value: "true" });
    boolean.createEl("option", { text: "false", value: "false" });
    const help = row.createDiv({ cls: "local-semantic-muted" });
    const error = row.createDiv({ cls: "local-semantic-filter-error", attr: { role: "status" } });
    const add = row.createEl("button", { text: "Add filter" });
    const selectedKind = () => (field.value.split("\0")[1] ?? "text") as PropertyKind;
    const updateValue = () => {
      const kind = selectedKind();
      const noValue = ["missing", "null", "empty"].includes(operator.value);
      value.hidden = noValue || kind === "boolean";
      boolean.hidden = noValue || kind !== "boolean";
      value.type = kind === "number" ? "number" : "text";
      value.step = "any";
      value.placeholder = kind.endsWith("Array") ? 'JSON array, e.g. ["one", "two"]' : kind === "date" ? "YYYY-MM-DD or RFC3339" : kind === "json" ? "JSON value" : "Text (empty string is allowed)";
      help.setText(noValue ? "This operator does not take a value." : kind.endsWith("Array") ? "Use a JSON array to preserve spaces, commas, and empty strings." : kind === "text" ? "Text is exact: leading/trailing spaces and empty strings are kept." : "");
    };
    const updateOperators = () => {
      const previous = operator.value;
      operator.replaceChildren();
      for (const key of operatorsFor(selectedKind())) operator.createEl("option", { text: OPERATOR_LABELS[key], value: key });
      if (operatorsFor(selectedKind()).includes(previous as PropertyFilter["operator"])) operator.value = previous;
      updateValue();
    };
    let fieldSignature = "";
    const updateFields = () => {
      const fields = this.registry.all();
      const signature = fields.map((item) => `${item.logicalKey}\0${item.kind}`).join("\n");
      if (signature === fieldSignature && field.options.length) return;
      fieldSignature = signature;
      const previous = field.value;
      field.replaceChildren();
      if (!fields.length) field.createEl("option", { text: "No indexed properties", value: "" });
      for (const item of fields) field.createEl("option", { text: `${item.logicalKey} (${item.kind})`, value: `${item.logicalKey}\0${item.kind}` });
      if (fields.some((item) => `${item.logicalKey}\0${item.kind}` === previous)) field.value = previous;
      add.disabled = !fields.length;
      updateOperators();
    };
    field.addEventListener("change", updateOperators);
    operator.addEventListener("change", updateValue);
    const updateChips = () => {
      summary.setText(`Property filters${memory.filters.length ? ` (${memory.filters.length})` : ""}`);
      chips.replaceChildren();
      memory.filters.forEach((filter, index) => {
        const chip = chips.createEl("button", { text: `${filter.key} ${OPERATOR_LABELS[filter.operator]}${filter.value === undefined ? "" : ` ${JSON.stringify(filter.value)}`} ×`, attr: { "aria-label": `Remove ${filter.key} ${OPERATOR_LABELS[filter.operator]} filter` } });
        chip.addEventListener("click", () => { memory.filters.splice(index, 1); updateChips(); this.requestRefresh(); });
      });
    };
    add.addEventListener("click", () => {
      try {
        const [key = "", kind = "text"] = field.value.split("\0");
        if (!field.value) return;
        const filter: PropertyFilter = { key, kind: kind as PropertyKind, operator: operator.value as PropertyFilter["operator"] };
        if (!["missing", "null", "empty"].includes(filter.operator)) filter.value = parseValue(kind === "boolean" ? boolean.value : value.value, filter.kind);
        memory.filters.push(filter);
        error.setText("");
        updateChips();
        this.requestRefresh();
      } catch (problem) { error.setText(problem instanceof Error ? problem.message : "Invalid filter value"); }
    });
    section.createEl("button", { text: "Clear filters" }).addEventListener("click", () => {
      memory.filters.length = 0;
      field.selectedIndex = 0;
      updateOperators();
      operator.selectedIndex = 0;
      updateValue();
      value.value = "";
      boolean.value = "true";
      error.setText("");
      preset.value = "";
      updateChips();
      this.requestRefresh();
    });
    const presets = section.createDiv({ cls: "local-semantic-presets" });
    const name = presets.createEl("input", { type: "text", placeholder: "Preset name", attr: { "aria-label": "Preset name" } });
    const save = presets.createEl("button", { text: "Save preset" });
    const preset = presets.createEl("select", { attr: { "aria-label": "Saved filter preset" } });
    const updatePresets = () => {
      const previous = preset.value;
      preset.replaceChildren();
      preset.createEl("option", { text: "Load preset…", value: "" });
      for (const key of Object.keys(this.state.presets).sort()) preset.createEl("option", { text: key, value: key });
      if (Object.hasOwn(this.state.presets, previous)) preset.value = previous;
    };
    save.addEventListener("click", () => {
      if (!name.value.trim()) { error.setText("Enter a preset name"); return; }
      Object.defineProperty(this.state.presets, name.value, { value: structuredClone(memory.filters), enumerable: true, writable: true, configurable: true });
      void this.persist().catch(() => error.setText("Could not save preset"));
      for (const controls of this.filterControls.values()) controls.updatePresets();
      preset.value = name.value;
    });
    preset.addEventListener("change", () => {
      if (!Object.hasOwn(this.state.presets, preset.value)) return;
      memory.filters = structuredClone(this.state.presets[preset.value]!);
      updateChips();
      this.requestRefresh();
    });
    updateFields();
    updatePresets();
    updateChips();
    return { updateFields, updatePresets, updateChips };
  }

  private cancelRequests(): void {
    this.cancelRerank();
    this.searchSeed = undefined;
    this.reranked = false;
    this.updateRerankControls();
    this.rerankStatus?.setText("");
    this.requestEpoch++;
    this.inspectionEpoch++;
    this.pendingInspection = undefined;
    this.queryPending = false;
    window.clearTimeout(this.searchTimer);
    this.searchTimer = undefined;
  }

  private clearVisible(saveScroll = true): void {
    if (saveScroll && this.scrollEl && (this.results.length || this.context)) this.memory[this.mode].scroll = this.scrollEl.scrollTop;
    this.results = [];
    this.context = undefined;
    this.articles.clear();
    this.listEl?.replaceChildren();
    this.inspectorEl?.replaceChildren();
    if (this.inspectorEl) this.inspectorEl.hidden = true;
    this.graph?.clear();
  }

  private requestRefresh(delay = 0): void {
    if (this.closed || !this.statusEl) return;
    this.cancelRequests();
    this.clearVisible();
    this.needsRefresh = true;
    this.resultStatusEl.setText(this.mode === "search" && !this.query.trim() ? "Type a query to search indexed passages" : "Updating current results…");
    const queue = () => {
      this.searchTimer = undefined;
      this.queryPending = true;
      void this.runQueries();
    };
    if (delay) this.searchTimer = window.setTimeout(queue, delay);
    else queue();
  }

  private async runQueries(): Promise<void> {
    if (this.queryActive) return;
    this.queryActive = true;
    try {
      // One request pipeline plus the latest pending intent, including GPU work.
      while (this.queryPending && !this.closed) {
        this.queryPending = false;
        this.activeQueryEpoch = this.requestEpoch;
        await this.refresh(this.activeQueryEpoch);
      }
    } finally { this.queryActive = false; this.activeQueryEpoch = undefined; }
  }

  private ready(): boolean { return !this.closed && this.state.indexingEnabled && this.state.servingReady && !this.state.schemaUpdating; }

  private resultCurrent(result: SearchResult, context: QueryContext): boolean {
    if (!this.ready() || context.generation !== this.state.activeGeneration || context.fingerprint !== this.embeddings.profile.modelFingerprint) return false;
    const note = this.state.notes[result.noteId];
    if (!note?.servable || note.noteId !== result.noteId || note.path !== result.path || note.snapshotId !== result.snapshotId
      || note.generation !== context.generation || note.modelFingerprint !== context.fingerprint
      || this.state.pathToNoteId[result.path] !== result.noteId || this.state.pendingPurges.includes(result.noteId)) return false;
    const file = this.app.vault.getAbstractFileByPath(result.path);
    return file instanceof TFile && admissionFor(file, this.app.metadataCache.getFileCache(file), this.pathPolicy).admitted;
  }

  private contextCurrent(context: QueryContext): boolean {
    return context.epoch === this.requestEpoch && context.mode === this.mode && this.ready() && context.generation === this.state.activeGeneration && context.fingerprint === this.embeddings.profile.modelFingerprint
      && (context.mode !== "connections" || context.targetPassageId === this.targetPassage?.passage.passageId)
      && (!context.anchor || (this.reference?.path === context.anchor.path && this.resultCurrent(context.anchor, context)));
  }

  private displayCurrent(context: QueryContext): boolean {
    return this.contextCurrent(context) && this.results.every((result) => this.resultCurrent(result, context));
  }

  private async refresh(epoch: number): Promise<void> {
    const mode = this.mode;
    if (!this.ready()) {
      this.resultStatusEl.setText(!this.state.indexingEnabled ? "Indexing is stopped" : this.state.schemaUpdating ? "Property schema updating" : "Reconciling privacy and current snapshots before serving");
      return;
    }
    if (mode === "search" && !this.query.trim()) { this.needsRefresh = false; return; }
    const generation = this.state.activeGeneration;
    const profile = this.embeddings.profile;
    const filters = structuredClone(this.memory[mode].filters);
    const query = this.query;
    const stillCurrent = () => epoch === this.requestEpoch && this.ready() && mode === this.mode && generation === this.state.activeGeneration && profile === this.embeddings.profile;
    try {
      let context: QueryContext;
      let queryVector: number[] | undefined;
      if (mode === "connections") {
        const file = this.reference;
        if (!file) { this.resultStatusEl.setText("Open a Markdown note to see connections"); return; }
        const admission = admissionFor(file, this.app.metadataCache.getFileCache(file), this.pathPolicy);
        if (!admission.admitted) { this.resultStatusEl.setText(admission.reason ?? "Reference note is excluded"); return; }
        const note = this.state.notes[this.state.pathToNoteId[file.path] ?? ""];
        if (!note) { this.resultStatusEl.setText("Reference note is waiting for indexing"); return; }
        if (this.targetPassage && (this.targetPassage.noteId !== note.noteId || this.targetPassage.snapshotId !== note.snapshotId)) this.targetPassage = undefined;
        const target = this.targetPassage;
        const anchor: SearchResult = { noteId: note.noteId, snapshotId: note.snapshotId, path: note.path, title: file.basename, score: 1, scoreKind: "similarity", passages: target ? [target.passage] : [] };
        context = { epoch, mode, generation, fingerprint: note.modelFingerprint, anchor, ...(target ? { targetPassageId: target.passage.passageId } : {}) };
        if (!this.contextCurrent(context)) { this.resultStatusEl.setText("Reference note is waiting for a current admitted snapshot"); return; }
      } else {
        const embedded = await this.embeddings.embedQuery(query);
        if (!stillCurrent()) return;
        context = { epoch, mode, generation, fingerprint: embedded.modelFingerprint };
        queryVector = embedded.vector;
      }
      let candidates: SearchResult[] = [];
      let results: SearchResult[] = [];
      let exhausted = false;
      let searchWindow: HybridWindow | undefined;
      // Each window replaces the prior hybrid ranking: fusion scores are window-local.
      const budgets = mode === "connections" ? [90, 300, 1200] : [300, 600, 1200];
      for (const limit of budgets) {
        if (!this.contextCurrent(context)) return;
        if (context.anchor) {
          candidates = context.targetPassageId
            ? await this.weaviate.connectionsForPassage(generation, context.fingerprint, context.anchor.noteId, context.anchor.snapshotId, context.targetPassageId, filters, this.registry, limit)
            : await this.weaviate.connectionsForNote(generation, context.fingerprint, context.anchor.noteId, context.anchor.snapshotId, filters, this.registry, limit);
        } else {
          const detailed = await this.weaviate.hybridDetailed(generation, context.fingerprint, query, queryVector!, filters, this.registry, limit);
          searchWindow = detailed;
          candidates = detailed.notes.map(candidate => candidate.result);
        }
        if (!this.contextCurrent(context)) return;
        results = visibleResults(candidates, (result) => result.noteId !== context.anchor?.noteId && this.resultCurrent(result, context));
        if (results.length === 30) break;
        const candidateCount = mode === "connections" ? candidates.length : searchWindow?.passages.length ?? 0;
        if (candidateCount < limit) break;
        exhausted = limit === 1200;
      }
      if (!this.contextCurrent(context) || !results.every((result) => this.resultCurrent(result, context))) return;
      // Only final listed notes (plus a real reference) enter the graph fetch.
      const members = context.anchor ? [context.anchor, ...results] : results;
      for (const result of results) {
        const file = this.app.vault.getAbstractFileByPath(result.path);
        if (file instanceof TFile) result.title = file.basename;
      }
      let graphData;
      let graphFailed = false;
      if (members.length) {
        try {
          if (context.anchor) graphData = buildConnectionGraph(results, context.anchor);
          else {
            const vectors = await this.weaviate.noteVectors(generation, context.fingerprint, members.map(({ noteId, snapshotId }) => ({ noteId, snapshotId })));
            if (!this.contextCurrent(context) || !members.every((result) => this.resultCurrent(result, context))) return;
            graphData = buildSimilarityGraph(results, undefined, vectors, profile.dimensions);
          }
        } catch { graphFailed = true; }
      }
      if (!this.contextCurrent(context) || !members.every((result) => this.resultCurrent(result, context))) return;
      this.context = context;
      this.results = results;
      this.needsRefresh = false;
      this.resultStatusEl.replaceChildren();
      this.resultStatusEl.createEl("strong", { text: `${results.length} notes`, cls: "local-semantic-result-count" });
      this.resultStatusEl.createEl("strong", { text: mode === "connections" ? context.targetPassageId ? "Passage similarity" : "Note similarity" : "Hybrid search", cls: "local-semantic-result-mode" });
      if (exhausted) this.resultStatusEl.createDiv({ text: "Candidate limit reached; additional admitted matches may exist.", cls: "local-semantic-result-warning" });
      if (graphData) this.graph.setData(graphData);
      else {
        this.graph.clear();
        if (graphFailed) this.resultStatusEl.createDiv({ text: "Graph unavailable: stored vectors could not be validated.", cls: "local-semantic-result-warning" });
      }
      this.renderResults(context);
      if (mode === "search" && searchWindow && queryVector) {
        this.searchSeed = { context, query, filters, vector: queryVector, window: searchWindow,
          baseline: structuredClone(results), graph: graphData, graphFailed, exhausted };
        this.rerankStatus.setText("Local hybrid results");
        this.updateRerankControls();
      }
    } catch {
      if (!stillCurrent()) return;
      this.clearVisible();
      this.needsRefresh = false;
      this.resultStatusEl.setText("Could not retrieve current results. Check local services and indexing status.");
    }
  }

  /** Configuration changes revoke remote work, not the local index or its fingerprints. */
  rerankSettingsChanged(): void {
    this.cancelRerank();
    if (this.reranked && this.searchSeed) this.publishRanking(this.searchSeed.baseline, this.searchSeed.graph, this.searchSeed.graphFailed, false);
    this.rerankStatus?.setText("Local results retained — remote settings changed");
    this.updateRerankControls();
  }

  private cancelRerank(): void {
    this.rerankJob?.abort();
    this.rerankJob = undefined;
    this.rerankCandidates = [];
    this.pendingRanking = undefined;
    if (this.applyRerankButton) this.applyRerankButton.hidden = true;
  }

  private updateRerankControls(): void {
    if (!this.rerankButton) return;
    const access = this.rerankStore?.access();
    this.rerankButton.setText(this.pendingRanking ? "Keep local ranking" : this.reranked ? "Use local ranking" : "Rerank with JEV");
    this.rerankButton.disabled = !this.searchSeed || !!this.rerankJob || (!this.pendingRanking && !this.reranked && !access?.enabled);
    this.rerankButton.title = access?.enabled ? "Query text and bounded, permitted excerpts will be sent to the configured provider" : "Enable optional JEV reranking in plugin settings first";
  }

  private remoteAllowed(result: SearchResult, context: QueryContext): boolean {
    if (!this.rerankStore || !this.resultCurrent(result, context)) return false;
    const file = this.app.vault.getAbstractFileByPath(result.path);
    return file instanceof TFile && remoteNoteAllowed(this.rerankStore.settings, result.path, this.app.metadataCache.getFileCache(file));
  }

  /** Deliberately outside runQueries(): obsolete cloud work cannot block a new local query. */
  private async rerankSearch(): Promise<void> {
    const seed = this.searchSeed;
    if (!seed || !this.reranker || !this.rerankStore || !this.displayCurrent(seed.context)) return;
    if (this.pendingRanking) {
      this.cancelRerank(); this.updateRerankControls(); this.rerankStatus.setText("Local hybrid results"); return;
    }
    if (this.reranked) {
      this.publishRanking(seed.baseline, seed.graph, seed.graphFailed, false);
      this.rerankStatus.setText("Local hybrid results"); return;
    }
    if (this.rerankJob) return;
    const access = this.rerankStore.access();
    const unavailable = !access.enabled ? "off" : !access.apiKey ? "unconfigured" : !access.consent ? "policy" : undefined;
    if (unavailable) { this.rerankStatus.setText(`Local results retained — ${REASON_LABELS[unavailable]}`); return; }
    const job = new AbortController();
    this.rerankJob = job;
    this.rerankCandidates = seed.window.notes;
    const interaction = this.interactionEpoch;
    const current = () => !job.signal.aborted && this.searchSeed === seed && this.contextCurrent(seed.context)
      && this.query === seed.query && canonicalJson(this.memory.search.filters) === canonicalJson(seed.filters)
      && this.rerankStore!.access().revision === access.revision
      && seed.baseline.every(result => this.resultCurrent(result, seed.context));
    this.updateRerankControls();
    this.rerankStatus.setText("Preparing bounded JEV evidence; local results remain available…");
    try {
      const expansion = await expandSearchPool(seed.window, limit => this.weaviate.hybridDetailed(seed.context.generation, seed.context.fingerprint,
        seed.query, seed.vector, seed.filters, this.registry, limit), result => this.resultCurrent(result, seed.context), current);
      if (!expansion || !current()) return;
      const pool = expansion.candidates;
      this.rerankCandidates = pool;
      const snapshotsCurrent = () => current() && pool.every(candidate => this.resultCurrent(candidate.result, seed.context));
      const allowed = () => snapshotsCurrent() && pool.every(candidate => this.remoteAllowed(candidate.result, seed.context));
      this.rerankStatus.setText("Reranking with JEV; local results remain available…");
      const outcome = await this.reranker.run({
        vaultId: this.state.vaultId,
        generation: seed.context.generation,
        fingerprint: seed.context.fingerprint,
        query: seed.query,
        candidates: pool,
        minimumCandidateCount: Math.max(1, seed.baseline.length),
        candidateWindow: expansion.window.limit,
        candidateExhausted: expansion.candidateExhausted,
        signal: job.signal,
        isCurrent: snapshotsCurrent,
        isAllowed: candidate => this.remoteAllowed(candidate.result, seed.context),
      });
      if (!current()) return;
      if (outcome.status !== "applied") {
        this.rerankStatus.setText(`Local results retained — ${REASON_LABELS[outcome.reason]}`); return;
      }
      if (!allowed()) { this.rerankStatus.setText("Local results retained — candidate snapshots or permissions changed"); return; }
      let graph: SimilarityGraphData | undefined, graphFailed = false;
      try {
        const vectors = await this.weaviate.noteVectors(seed.context.generation, seed.context.fingerprint,
          outcome.results.map(({ noteId, snapshotId }) => ({ noteId, snapshotId })));
        if (!allowed()) return;
        graph = buildSimilarityGraph(outcome.results, undefined, vectors, this.embeddings.profile.dimensions);
      } catch { graphFailed = true; }
      if (!allowed()) return;
      this.pendingRanking = { results: outcome.results, graph, graphFailed, metrics: outcome.metrics, current: allowed };
      if (interaction !== this.interactionEpoch || this.scrollEl.contains(this.contentEl.ownerDocument.activeElement)) {
        this.applyRerankButton.hidden = false;
        this.rerankStatus.setText("JEV ranking ready — apply when you have finished inspecting local results");
      } else this.applyPendingRanking();
    } catch {
      if (current()) this.rerankStatus.setText("Local results retained — reranking could not be completed");
    } finally {
      if (this.rerankJob === job) { this.rerankJob = undefined; this.updateRerankControls(); }
    }
  }

  private applyPendingRanking(): void {
    const pending = this.pendingRanking;
    if (!pending) return;
    if (!pending.current()) {
      this.cancelRerank(); this.updateRerankControls();
      this.rerankStatus.setText("Local results retained — candidate snapshots or permissions changed"); return;
    }
    this.pendingRanking = undefined;
    this.applyRerankButton.hidden = true;
    this.publishRanking(pending.results, pending.graph, pending.graphFailed, true);
    const metrics = pending.metrics;
    this.rerankStatus.setText(`JEV relevance · ${metrics.servedModel ?? metrics.requestedModel} · ${metrics.evidenceCount} passages · ${metrics.cacheHits} cached${metrics.truncatedCount ? ` · ${metrics.truncatedCount} bounded excerpts` : ""}`);
  }

  private publishRanking(results: readonly SearchResult[], graph: SimilarityGraphData | undefined, graphFailed: boolean, reranked: boolean): void {
    const seed = this.searchSeed;
    if (!seed || !this.contextCurrent(seed.context) || !results.every(result => this.resultCurrent(result, seed.context))) return;
    this.memory.search.scroll = this.scrollEl.scrollTop;
    this.results = structuredClone([...results]);
    this.reranked = reranked;
    this.inspectionEpoch++;
    this.pendingInspection = undefined;
    this.inspectorEl.replaceChildren(); this.inspectorEl.hidden = true;
    this.resultStatusEl.replaceChildren();
    this.resultStatusEl.createEl("strong", { text: `${results.length} notes`, cls: "local-semantic-result-count" });
    this.resultStatusEl.createEl("strong", { text: reranked ? "JEV reranked search" : "Hybrid search", cls: "local-semantic-result-mode" });
    if (!reranked && seed.exhausted) this.resultStatusEl.createDiv({ text: "Candidate limit reached; additional admitted matches may exist.", cls: "local-semantic-result-warning" });
    if (graph) this.graph.setData(graph); else this.graph.clear();
    if (graphFailed) this.resultStatusEl.createDiv({ text: "Graph unavailable: stored vectors could not be validated.", cls: "local-semantic-result-warning" });
    this.renderResults(seed.context);
    this.updateRerankControls();
  }

  private renderResults(context: QueryContext): void {
    if (!this.displayCurrent(context)) { this.invalidate(); return; }
    this.listEl.replaceChildren();
    this.articles.clear();
    const restoring: Promise<void>[] = [];
    for (const [index, result] of this.results.entries()) {
      const article = this.listEl.createEl("article", { cls: "local-semantic-result" });
      this.articles.set(result.noteId, article);
      const heading = article.createDiv({ cls: "local-semantic-result-heading" });
      const expand = heading.createEl("button", { text: "+", cls: "local-semantic-expand", attr: { "aria-label": `Inspect passages for ${result.title}`, "aria-expanded": "false" } });
      const title = heading.createEl("button", { text: `${index + 1}. ${result.title}`, cls: "local-semantic-result-title" });
      title.addEventListener("click", (event) => void this.openResult(result, context, event));
      title.addEventListener("auxclick", (event) => { if (event.button === 1) void this.openResult(result, context, event); });
      article.createDiv({ text: result.path, cls: "local-semantic-result-path" });
      article.createDiv({ text: result.scoreKind === "similarity" ? `${context.targetPassageId ? "Passage" : "Note"} cosine ${result.score.toFixed(6)}` : `Hybrid rank score ${result.score.toFixed(6)}`, cls: "local-semantic-score" });
      if (result.rerank) article.createDiv({ text: `JEV relevance ${result.rerank.relevance.toFixed(6)}`, cls: "local-semantic-score",
        attr: { title: `${result.rerank.route} · ${result.rerank.servedModel} · ${result.rerank.rubricVersion} · ${result.rerank.evidencePolicyVersion} · ${result.rerank.rankingPolicyVersion}` } });
      const passages = article.createDiv({ cls: "local-semantic-passages" });
      passages.hidden = true;
      const show = async () => {
        if (!this.displayCurrent(context) || !this.resultCurrent(result, context)) { this.invalidate(); return; }
        passages.hidden = false;
        expand.setText("−");
        expand.setAttribute("aria-expanded", "true");
        this.memory[context.mode].expanded.set(result.noteId, result.snapshotId);
        this.inspectionEpoch++;
        this.pendingInspection = undefined;
        this.inspectorEl.hidden = true;
        this.inspectorEl.replaceChildren();
        this.graph.highlight(result.noteId);
        this.highlightArticles([result.noteId]);
        passages.setText("Loading current passages…");
        try {
          const items = await this.loadPassages(result, context);
          if (!this.displayCurrent(context) || passages.hidden || !passages.isConnected) return;
          this.renderPassages(passages, items);
        } catch {
          if (this.displayCurrent(context) && passages.isConnected) passages.setText("Current passages are unavailable");
        }
      };
      expand.addEventListener("click", () => {
        if (passages.hidden) void show();
        else {
          passages.hidden = true;
          passages.replaceChildren();
          expand.setText("+");
          expand.setAttribute("aria-expanded", "false");
          this.memory[context.mode].expanded.delete(result.noteId);
        }
      });
      if (this.memory[context.mode].expanded.get(result.noteId) === result.snapshotId) restoring.push(show());
    }
    this.scrollEl.scrollTop = this.memory[context.mode].scroll;
    const initialScroll = this.scrollEl.scrollTop;
    if (restoring.length) void Promise.allSettled(restoring).then(() => {
      if (this.displayCurrent(context) && this.scrollEl.scrollTop === initialScroll) this.scrollEl.scrollTop = this.memory[context.mode].scroll;
    });
  }

  private async loadPassages(result: SearchResult, context: QueryContext): Promise<SearchResult["passages"]> {
    if (!this.displayCurrent(context) || !this.resultCurrent(result, context)) throw new Error("Snapshot no longer admitted");
    if (result.passages.length) return result.passages;
    const key = `${context.generation}\0${context.fingerprint}\0${result.noteId}\0${result.snapshotId}`;
    let pending = this.passageRequests.get(key);
    if (!pending) {
      pending = this.weaviate.passagesForNote(context.generation, result.noteId, result.snapshotId, context.fingerprint);
      this.passageRequests.set(key, pending);
    }
    try {
      const passages = await pending;
      if (!this.displayCurrent(context) || !this.resultCurrent(result, context)) throw new Error("Snapshot no longer admitted");
      result.passages = passages;
      return passages;
    } finally { if (this.passageRequests.get(key) === pending) this.passageRequests.delete(key); }
  }

  private renderPassages(parent: HTMLElement, passages: SearchResult["passages"]): void {
    parent.replaceChildren();
    if (!passages.length) parent.createDiv({ text: "No stored passages for this snapshot", cls: "local-semantic-muted" });
    for (const passage of passages) parent.createEl("pre", { text: `${passage.heading ? `${passage.heading}\n` : ""}${passage.body}` });
  }

  private highlightArticles(ids: string[]): void {
    for (const [id, article] of this.articles) article.toggleClass("is-selected", ids.includes(id));
  }

  private selectGraph(selection: GraphSelection): void {
    const context = this.context;
    this.inspectionEpoch++;
    this.pendingInspection = undefined;
    this.inspectorEl.replaceChildren();
    this.inspectorEl.hidden = !selection.noteIds.length;
    if (!context || !this.displayCurrent(context)) { this.invalidate(); return; }
    this.highlightArticles(selection.noteIds);
    if (!selection.noteIds.length) return;
    this.pendingInspection = { selection, context, epoch: this.inspectionEpoch };
    void this.runInspections();
  }

  private async runInspections(): Promise<void> {
    if (this.inspectionActive) return;
    this.inspectionActive = true;
    try {
      while (this.pendingInspection) {
        const { selection, context, epoch } = this.pendingInspection;
        this.pendingInspection = undefined;
        if (!this.displayCurrent(context) || epoch !== this.inspectionEpoch) continue;
        const members = context.anchor ? [context.anchor, ...this.results] : this.results;
        const selected = selection.noteIds.map((id) => members.find((result) => result.noteId === id));
        if (selected.some((result) => !result || !this.resultCurrent(result, context))) { this.invalidate(); continue; }
        this.inspectorEl.replaceChildren();
        this.inspectorEl.createEl("h3", { text: selection.cosine === undefined ? "Selected note · no other note to compare" : `Exact computed cosine: ${selection.cosine}` });
        if (selection.comparison) this.inspectorEl.createDiv({ text: selection.comparison, cls: "local-semantic-muted" });
        for (const result of selected) {
          if (!result || !this.displayCurrent(context) || epoch !== this.inspectionEpoch) break;
          const title = this.inspectorEl.createEl("button", { text: result.title, cls: "local-semantic-inspector-title" });
          title.addEventListener("click", (event) => void this.openResult(result, context, event));
          const content = this.inspectorEl.createDiv({ cls: "local-semantic-passages", text: "Loading current passages…" });
          try {
            const passages = await this.loadPassages(result, context);
            if (!this.displayCurrent(context) || epoch !== this.inspectionEpoch) break;
            this.renderPassages(content, passages);
          } catch {
            if (this.displayCurrent(context) && epoch === this.inspectionEpoch) content.setText("Current passages are unavailable");
          }
        }
      }
    } finally { this.inspectionActive = false; }
  }

  private async openResult(result: SearchResult, context: QueryContext, event: MouseEvent): Promise<void> {
    event.preventDefault();
    if (!this.displayCurrent(context) || !this.resultCurrent(result, context)) { this.invalidate(); return; }
    const file = this.app.vault.getAbstractFileByPath(result.path);
    if (!(file instanceof TFile)) return;
    let line: number | undefined;
    if (result.passages[0]) {
      const markdown = await this.app.vault.cachedRead(file);
      const body = stripFrontmatter(markdown);
      const frontmatterLines = markdown.slice(0, markdown.length - body.length).split("\n").length - 1;
      const titleLines = canonicalInput(file, "").split("\n").length - 1;
      line = frontmatterLines + Math.max(0, result.passages[0].startLine - titleLines);
    }
    const newLeaf = Keymap.isModEvent(event) || event.button === 1;
    const leaf = this.app.workspace.getLeaf(newLeaf ? event.altKey ? "split" : "tab" : false);
    if (!this.displayCurrent(context) || !this.resultCurrent(result, context)) return;
    await leaf.openFile(file, line === undefined ? undefined : { eState: { line } });
    if (!this.resultCurrent(result, context)) this.invalidate(result.noteId);
  }
}

function operatorsFor(kind: PropertyKind): PropertyFilter["operator"][] {
  if (kind === "number" || kind === "date") return ["eq", "ne", "gt", "gte", "lt", "lte", "missing", "null"];
  if (kind.endsWith("Array")) return ["containsAny", "containsAll", "missing", "null", "empty"];
  return ["eq", "ne", "missing", "null"];
}

function parseValue(value: string, kind: PropertyKind): NonNullable<PropertyFilter["value"]> {
  if (kind === "text") return value;
  if (kind === "number") {
    if (!value.trim() || !Number.isFinite(Number(value))) throw new Error("Enter a finite number");
    return Number(value);
  }
  if (kind === "boolean") {
    if (value !== "true" && value !== "false") throw new Error("Choose true or false");
    return value === "true";
  }
  if (kind === "date") {
    if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) throw new Error("Use YYYY-MM-DD or an RFC3339 timestamp");
    const date = new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value);
    const calendarDate = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
    if (!Number.isFinite(date.valueOf()) || !Number.isFinite(calendarDate.valueOf()) || calendarDate.toISOString().slice(0, 10) !== value.slice(0, 10)) throw new Error("Enter a valid date");
    return date.toISOString();
  }
  if (kind.endsWith("Array")) {
    let values: unknown;
    try { values = JSON.parse(value); } catch { throw new Error("Enter a JSON array"); }
    if (!Array.isArray(values)) throw new Error("Enter a JSON array");
    if (kind === "numberArray" && values.every((item) => typeof item === "number" && Number.isFinite(item))) return values as number[];
    if (kind === "booleanArray" && values.every((item) => typeof item === "boolean")) return values as boolean[];
    if (kind === "textArray" && values.every((item) => typeof item === "string")) return values as string[];
    if (kind === "dateArray" && values.every((item) => typeof item === "string")) return values.map((item) => parseValue(item as string, "date") as string);
    throw new Error(`Every array element must match ${kind}`);
  }
  try { return canonicalJson(JSON.parse(value)); } catch { throw new Error("Enter valid JSON"); }
}
