import { adaptiveLimits } from "./adaptive-plan";
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
    text: "Off by default. Embeddings and Weaviate stay local. Manual Search or Connections reranking may send the source note or selected passage and complete or extracted candidate notes to the chosen provider. Image destinations are removed; meaningful captions can remain. Linked notes and attachments are never expanded. Sent text cannot be recalled. Keys, cloud policy, and provider consent are device-local and outside the vault. File permissions are access control, not encryption.",
    cls: "setting-item-description",
  });

  new Setting(root)
    .setName("Enable manual reranking")
    .setDesc("Adds manual actions in Search and Connections. Enabling, typing and opening notes send nothing. No index rebuild.")
    .addToggle(toggle => toggle.setValue(access.enabled).onChange(enabled => run(async () => {
      await store.configure({ enabled });
      refresh();
    })));

  new Setting(root)
    .setName(`Allow source and candidate text uploads to ${providerName}`)
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
      text: `Validated: ${model.requestedModel} → ${model.canonicalSlug}. Catalogue context: ${model.contextTokens.toLocaleString()} tokens. One-request planning uses ~${adaptiveLimits(model, access).tokens.toLocaleString()} input tokens under conservative byte guards and applicable per-question limits. This is an estimate, not an exact tokenizer count. ${model.fullTextWarning ?? "The synthetic check confirms the request contract, not ranking quality or full-document coverage."}`,
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
    .setDesc("Any restricted source or requested candidate skips the entire rerank; private notes are never hidden or demoted in local results.")
    .addButton(button => button.setButtonText("Apply remote exclusions").onClick(() => run(async () => {
      await store.configure({
        excludedFolders: folders.split("\n").map(value => value.trim()).filter(Boolean),
        excludedFiles: files.split("\n").map(value => value.trim()).filter(Boolean),
      });
      refresh();
    })));

  let candidateCount = String(access.candidateCount), tokenBudget = String(access.tokenBudget);
  let contextTokens = String(access.contextTokens), contextMode = access.contextMode, policy = access.evidencePolicy;
  new Setting(root).setName("Desired candidates").setDesc("1–60. The largest leading candidate set that fits useful evidence in one request is judged; at most 30 are displayed.")
    .addText(input => input.setValue(candidateCount).onChange(value => { candidateCount = value; }));
  new Setting(root).setName("Evidence policy").setDesc("Auto uses full cleaned text when affordable, otherwise opening/ending and relevant interior extracts. Complete notes only reduces candidate count without shortening candidate notes.")
    .addDropdown(input => input.addOption("adaptive", "Auto excerpts").addOption("complete", "Complete notes only").setValue(policy)
      .onChange(value => { if (value === "adaptive" || value === "complete") policy = value; }));
  new Setting(root).setName("Total request token cap").setDesc("2,048–262,144; default 64,000. Includes source, all candidates and framing. Model limits and conservative byte guards may lower the usable budget substantially. Planning is estimated, not exact tokenization.")
    .addText(input => input.setValue(tokenBudget).onChange(value => { tokenBudget = value; }));
  new Setting(root).setName("Surrounding context").setDesc("Auto expands toward 2,048 tokens per side as space permits. Manual uses the preferred per-side ceiling. Multiple anchors share each note's total allowance.")
    .addDropdown(input => input.addOption("auto", "Auto").addOption("manual", "Manual ceiling").setValue(contextMode)
      .onChange(value => { if (value === "auto" || value === "manual") contextMode = value; }));
  new Setting(root).setName("Preferred tokens per side").setDesc("128–8,192; default 512. Context may shrink under the total budget. A selected source passage itself is never silently shortened.")
    .addText(input => input.setValue(contextTokens).onChange(value => { contextTokens = value; }));
  new Setting(root).setName("Apply context settings").addButton(button => button.setButtonText("Apply").onClick(() => run(async () => {
    await store.configure({ candidateCount: Number(candidateCount), tokenBudget: Number(tokenBudget),
      contextTokens: Number(contextTokens), contextMode, evidencePolicy: policy });
    refresh();
  })));
  root.createEl("p", {
    text: "At most one inference request per rerank; no overflow batches, automatic retry, or client-side provider fallback. Preparation and publication have a 30-second action deadline; remote work has at most 20 seconds within it. All judgments must validate before publication. Original cosine/hybrid scores stay visible, but are neither sent to the judge nor blended with relevance. The RAM-only scalar cache expires after 15 minutes. Evidence previews are local and cleared on source/settings changes.",
    cls: "setting-item-description",
  });
}
