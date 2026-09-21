import { Setting } from "obsidian";
import type { RerankService } from "./service";
import type { RerankStore } from "./store";
import { PROVIDERS, REASON_LABELS } from "./types";

/** All values here, including consent, are device-local rather than vault-synced. */
export function renderRerankSettings(root: HTMLElement, store: RerankStore, service: RerankService,
  run: (operation: () => Promise<void>) => void, refresh: () => void): void {
  const access = store.access();
  const providerName = access.provider === "openrouter" ? "OpenRouter (routing to TypeSafe)" : "TypeSafe directly";
  root.createEl("h2", { text: "Optional JEV cloud reranking" });
  root.createEl("p", { text: "Search only, off by default. Embeddings and Weaviate stay local. A manual action sends query text and selected title/heading/excerpts to the chosen provider. Review that provider's retention controls; sent text cannot be recalled. Keys and consent are stored outside the vault on this device. File permissions are not encryption.", cls: "setting-item-description" });
  new Setting(root).setName("Enable manual JEV reranking").setDesc("Adds the Search action; never uploads while typing, opening a note, or using Connections. No index rebuild.")
    .addToggle(toggle => toggle.setValue(access.enabled).onChange(enabled => run(async () => { await store.configure({ enabled }); refresh(); })));
  new Setting(root).setName("JEV provider").setDesc("Pinned model; no automatic fallback to another processor.")
    .addDropdown(dropdown => dropdown.addOption("openrouter", "OpenRouter — typesafe/jev-1.13").addOption("typesafe", "TypeSafe — jev-1.13.0")
      .setValue(access.provider).onChange(provider => run(async () => {
        if (provider !== "openrouter" && provider !== "typesafe") return;
        await store.configure({ provider }); refresh();
      })));
  new Setting(root).setName(`Allow query and excerpt uploads to ${providerName}`)
    .setDesc("Separate consent for this provider and device. Disabling immediately cancels future requests and clears cached judgments; it cannot recall earlier uploads.")
    .addToggle(toggle => toggle.setValue(access.consent).onChange(approved => run(async () => { await store.setConsent(access.provider, approved); refresh(); })));
  let newKey = "";
  const credential = new Setting(root).setName("JEV API key").setDesc(access.apiKey ? "A key is saved outside this vault. Enter a replacement or clear it explicitly." : "No key saved. Stored in the device-local rerank-credentials.json, never plugin data.json.");
  credential.addText(input => {
    input.inputEl.type = "password";
    input.inputEl.autocomplete = "off";
    input.setPlaceholder("Provider API key").onChange(value => { newKey = value; });
  }).addButton(button => button.setButtonText("Save key").onClick(() => run(async () => {
    if (!newKey.trim()) throw new Error("Enter a key, or use Clear key to remove the saved credential");
    await store.setKey(access.provider, newKey); newKey = ""; refresh();
  }))).addButton(button => button.setButtonText("Clear key").onClick(() => run(async () => { await store.setKey(access.provider, ""); refresh(); })));
  const check = new Setting(root).setName("Synthetic connection test").setDesc(`Sends built-in arithmetic text only to ${providerName}; no query or vault content. Model: ${PROVIDERS[access.provider].model}.`);
  check.addButton(button => button.setButtonText("Test JEV").setDisabled(!access.apiKey).onClick(() => run(async () => {
    button.setDisabled(true);
    try {
      const result = await service.testConnection(new AbortController().signal);
      check.setDesc(result.status === "applied" ? `Synthetic contract passed: ${result.metrics.resolvedModel}. This does not measure vault ranking quality.`
        : `Synthetic test failed: ${REASON_LABELS[result.reason]}.`);
    } finally { button.setDisabled(false); }
  })));
  let folders = access.excludedFolders.map(path => path || "/").join("\n");
  let files = access.excludedFiles.join("\n");
  new Setting(root).setName("Remote-excluded folders").setDesc("Literal vault-relative paths, one per line; / excludes everything. Local search is unchanged.")
    .addTextArea(input => input.setValue(folders).onChange(value => { folders = value; }));
  new Setting(root).setName("Remote-excluded files").setDesc("Literal vault-relative Markdown paths, one per line. ai_remote: false (also ai_rerank: false) vetoes uploads. Missing metadata fails closed.")
    .addTextArea(input => input.setValue(files).onChange(value => { files = value; }));
  new Setting(root).setName("Apply remote exclusions").setDesc("Any restricted candidate skips the entire rerank; private notes are never hidden or demoted in local results.")
    .addButton(button => button.setButtonText("Apply remote exclusions").onClick(() => run(async () => {
      await store.configure({ excludedFolders: folders.split("\n").map(value => value.trim()).filter(Boolean),
        excludedFiles: files.split("\n").map(value => value.trim()).filter(Boolean) }); refresh();
    })));
  new Setting(root).setName("Experimental candidate-isolated batching").setDesc("Off: documented one-pair reference requests. On: up to 16 question-local candidates/request. Ranking equivalence and latency are not validated; not an automatic rollout.")
    .addToggle(toggle => toggle.setValue(access.experimentalBatching).onChange(experimentalBatching => run(async () => { await store.configure({ experimentalBatching }); refresh(); })));
  root.createEl("p", { text: "Limits: 60 notes, 1–2 distinct passages each, 30 displayed notes, two concurrent requests, two-second remote deadline, no retries. Complete result or unchanged local ranking. RAM-only cache: 15 minutes. Planning uses estimates plus hard byte bounds, not exact JEV tokenization. All views share 1,000 requests / 2 million estimated input tokens per plugin session; provider-side spending limits remain necessary.", cls: "setting-item-description" });
}
