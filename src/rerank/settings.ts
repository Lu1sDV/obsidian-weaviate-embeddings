import { Setting } from "obsidian";
import type { RerankService } from "./service";
import type { RerankStore } from "./store";

/** All values here, including consent, are device-local rather than vault-synced. */
export function renderRerankSettings(
  root: HTMLElement,
  store: RerankStore,
  service: RerankService,
  run: (operation: () => Promise<void>) => void,
  refresh: () => void,
): void {
  const access = store.access();
  const providerName = "OpenRouter and the selected model's provider";

  root.createEl("h2", { text: "Optional System One reranking" });
  root.createEl("p", {
    text: "Search only, off by default. Embeddings and Weaviate stay local. A manual action sends the query and selected title/heading/excerpts to the chosen provider. Sent text cannot be recalled. Keys, cloud policy, and provider consent are device-local and outside the vault. File permissions are access control, not encryption.",
    cls: "setting-item-description",
  });

  new Setting(root)
    .setName("Enable manual reranking")
    .setDesc("Adds the Search action; never uploads while typing, opening a note, or using Connections. No index rebuild.")
    .addToggle(toggle => toggle.setValue(access.enabled).onChange(enabled => run(async () => {
      await store.configure({ enabled });
      refresh();
    })));

  new Setting(root)
    .setName(`Allow query and excerpt uploads to ${providerName}`)
    .setDesc("Changing the model resets this permission because its upstream processor may change. Disabling cancels future requests and clears cached judgments.")
    .addToggle(toggle => toggle.setValue(access.consent).onChange(approved => run(async () => {
      await store.setConsent(access.provider, approved);
      refresh();
    })));

  let newKey = "";
  const credential = new Setting(root)
    .setName("OpenRouter API key")
    .setDesc(access.apiKey
      ? "A key is saved outside this vault. Enter a replacement or clear it explicitly."
      : "No key saved. Credentials are isolated in device-local rerank-credentials.json, never plugin data.json.");
  credential.addText(input => {
    input.inputEl.type = "password";
    input.inputEl.autocomplete = "off";
    input.setPlaceholder("OpenRouter API key").onChange(value => { newKey = value; });
  }).addButton(button => button.setButtonText("Save key").onClick(() => run(async () => {
    if (!newKey.trim()) throw new Error("Enter a key, or use Clear key to remove the saved credential");
    await store.setKey(access.provider, newKey);
    newKey = "";
    refresh();
  }))).addButton(button => button.setButtonText("Clear key").onClick(() => run(async () => {
    await store.setKey(access.provider, "");
    refresh();
  })));

  let newModel = access.model;
  new Setting(root)
    .setName("OpenRouter decision model")
    .setDesc("Enter an exact author/model ID or ~author/alias. The model must accept text and return typed Decisions answers. Chat models are not compatible.")
    .addText(input => input.setValue(newModel).setPlaceholder("typesafe/jev-1.14").onChange(value => { newModel = value; }));

  const check = new Setting(root)
    .setName("Validate selected model")
    .setDesc(service.validationProblem
      ? `Last validation failed: ${service.validationProblem}. Save a compatible model and validate again.`
      : "Checks the available Decisions catalogue, then sends built-in arithmetic with the real reranking request shape. No vault content is sent. This small API call may incur a charge. Validate once per plugin session, after a model/key change, or after 24 hours.");
  check.addButton(button => button.setButtonText("Save & validate").setDisabled(!access.apiKey).onClick(() => run(async () => {
    button.setDisabled(true);
    try {
      if (!newModel.trim()) throw new Error("Enter an OpenRouter decision model ID first");
      await store.configure({ model: newModel });
      await service.testConnection(new AbortController().signal);
      refresh();
    } finally {
      button.setDisabled(false);
    }
  })));

  const model = service.validatedModel;
  if (model) {
    root.createEl("p", {
      text: `Validated: ${model.requestedModel} → ${model.canonicalSlug}. Catalogue context: ${model.contextTokens.toLocaleString()} tokens. Request packing also keeps the existing application limits and conservative byte headroom; this is not an exact tokenizer count. ${model.fullTextWarning ?? "The synthetic check confirms the request contract, not ranking quality or full-document coverage."}`,
      cls: "setting-item-description",
    });
  }

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
    .setDesc("One is the release default. Two is an explicit experiment with more disclosure, cost, and max-score length bias. Two-passage planning keeps the same candidate cohort chosen by the one-passage policy; if that exact cohort cannot fit the experimental budget, reranking is skipped rather than narrowed.")
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
    text: "Limits: up to 60 admitted notes, 30 displayed notes, up to 24 independent candidate-local questions per packed request, two concurrent requests, a 2.5-second remote deadline, and no retries. One-passage planning uses at most 3 batches / 64k estimated tokens. The two-passage experiment uses at most 6 batches / 128k estimated tokens and must keep the same candidate cohort chosen by one-passage planning; otherwise the exact local ranking stays visible. Publication requires complete compatible judgments. The judgment cache is RAM-only with a 15-minute TTL.",
    cls: "setting-item-description",
  });
}
