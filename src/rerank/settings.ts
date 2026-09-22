import { Setting } from "obsidian";
import type { RerankService } from "./service";
import type { RerankStore } from "./store";
import { PROVIDERS, REASON_LABELS } from "./types";

/** All values here, including consent, are device-local rather than vault-synced. */
export function renderRerankSettings(
  root: HTMLElement,
  store: RerankStore,
  service: RerankService,
  run: (operation: () => Promise<void>) => void,
  refresh: () => void,
): void {
  const access = store.access();
  const providerName = access.provider === "openrouter" ? "OpenRouter (routing to TypeSafe)" : "TypeSafe directly";

  root.createEl("h2", { text: "Optional JEV cloud reranking" });
  root.createEl("p", {
    text: "Search only, off by default. Embeddings and Weaviate stay local. A manual action sends the query and selected title/heading/excerpts to the chosen provider. Sent text cannot be recalled. Keys, cloud policy, and provider consent are device-local and outside the vault. File permissions are access control, not encryption.",
    cls: "setting-item-description",
  });

  new Setting(root)
    .setName("Enable manual JEV reranking")
    .setDesc("Adds the Search action; never uploads while typing, opening a note, or using Connections. No index rebuild.")
    .addToggle(toggle => toggle.setValue(access.enabled).onChange(enabled => run(async () => {
      await store.configure({ enabled });
      refresh();
    })));

  new Setting(root)
    .setName("JEV provider")
    .setDesc("Pinned requested model; no silent failover to another processor.")
    .addDropdown(dropdown => dropdown
      .addOption("openrouter", "OpenRouter — typesafe/jev-1.13")
      .addOption("typesafe", "TypeSafe — jev-1.13.0")
      .setValue(access.provider)
      .onChange(provider => run(async () => {
        if (provider !== "openrouter" && provider !== "typesafe") return;
        await store.configure({ provider });
        refresh();
      })));

  new Setting(root)
    .setName(`Allow query and excerpt uploads to ${providerName}`)
    .setDesc("Separate consent for this provider and device. Disabling immediately cancels future requests and clears cached judgments; it cannot recall earlier uploads.")
    .addToggle(toggle => toggle.setValue(access.consent).onChange(approved => run(async () => {
      await store.setConsent(access.provider, approved);
      refresh();
    })));

  let newKey = "";
  const credential = new Setting(root)
    .setName("JEV API key")
    .setDesc(access.apiKey
      ? "A key is saved outside this vault. Enter a replacement or clear it explicitly."
      : "No key saved. Credentials are isolated in device-local rerank-credentials.json, never plugin data.json.");
  credential.addText(input => {
    input.inputEl.type = "password";
    input.inputEl.autocomplete = "off";
    input.setPlaceholder("Provider API key").onChange(value => { newKey = value; });
  }).addButton(button => button.setButtonText("Save key").onClick(() => run(async () => {
    if (!newKey.trim()) throw new Error("Enter a key, or use Clear key to remove the saved credential");
    await store.setKey(access.provider, newKey);
    newKey = "";
    refresh();
  }))).addButton(button => button.setButtonText("Clear key").onClick(() => run(async () => {
    await store.setKey(access.provider, "");
    refresh();
  })));

  const check = new Setting(root)
    .setName("Synthetic connection test")
    .setDesc(`Sends built-in arithmetic text only to ${providerName}; no query or vault content. Requested model: ${PROVIDERS[access.provider].model}.`);
  check.addButton(button => button.setButtonText("Test JEV").setDisabled(!access.apiKey).onClick(() => run(async () => {
    button.setDisabled(true);
    try {
      const result = await service.testConnection(new AbortController().signal);
      check.setDesc(result.status === "applied"
        ? `Synthetic contract passed: ${result.metrics.servedModel ?? "unknown serving revision"}. This does not measure vault ranking quality.`
        : `Synthetic test failed: ${REASON_LABELS[result.reason]}.`);
    } finally {
      button.setDisabled(false);
    }
  })));

  let folders = access.excludedFolders.map(path => path || "/").join("\n");
  let files = access.excludedFiles.join("\n");
  new Setting(root)
    .setName("Remote-excluded folders")
    .setDesc("Literal vault-relative paths, one per line; / excludes everything. Local search is unchanged.")
    .addTextArea(input => input.setValue(folders).onChange(value => { folders = value; }));
  new Setting(root)
    .setName("Remote-excluded files")
    .setDesc("Literal vault-relative Markdown paths, one per line. ai_remote: false (also ai_rerank: false) vetoes uploads. Missing metadata fails closed.")
    .addTextArea(input => input.setValue(files).onChange(value => { files = value; }));
  new Setting(root)
    .setName("Apply remote exclusions")
    .setDesc("Any restricted candidate skips the entire rerank; private notes are never hidden or demoted in local results.")
    .addButton(button => button.setButtonText("Apply remote exclusions").onClick(() => run(async () => {
      await store.configure({
        excludedFolders: folders.split("\n").map(value => value.trim()).filter(Boolean),
        excludedFiles: files.split("\n").map(value => value.trim()).filter(Boolean),
      });
      refresh();
    })));

  new Setting(root)
    .setName("Evidence passages per note")
    .setDesc("One is the release default. Two is an explicit experiment with more disclosure, cost, and max-score length bias.")
    .addDropdown(dropdown => dropdown
      .addOption("1", "1 — release default")
      .addOption("2", "2 — experimental")
      .setValue(String(access.evidencePassages))
      .onChange(value => run(async () => {
        if (value !== "1" && value !== "2") return;
        await store.configure({ evidencePassages: Number(value) as 1 | 2 });
        refresh();
      })));

  root.createEl("p", {
    text: "Limits: up to 60 admitted notes, 30 displayed notes, up to 24 independent candidate-local questions per packed request, two concurrent requests, a 2.5-second remote deadline, and no retries. The whole cohort is planned before the first send and can deterministically shrink toward the currently displayed count. Publication requires complete compatible judgments; otherwise the exact local ranking stays visible. The judgment cache is RAM-only with a 15-minute TTL.",
    cls: "setting-item-description",
  });
}
