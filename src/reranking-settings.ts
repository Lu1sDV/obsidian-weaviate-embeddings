import { Setting } from "obsidian";
import type { RerankingSettings } from "./reranking-config";
interface SettingsHost {
  rerankingSettings: RerankingSettings;
  run(operation: () => Promise<void>): void;
  setRerankingSettings(settings: RerankingSettings): Promise<void>;
}
export function addRerankingEvidenceSettings(root: HTMLElement, plugin: SettingsHost): void {
  new Setting(root).setName("Reranking evidence").setDesc("Complete matched passages, or bounded source context: Standard adds small same-heading neighbours; Late prefers a fitting section and nearby passages. Additional text is sent to OpenRouter when enabled.").addDropdown(dropdown => {
    dropdown.selectEl.setAttribute("aria-label", "Reranking evidence");
    dropdown.addOption("matched-passages", "Complete matched passages only").addOption("contextual", "Complete matches + bounded source context");
    dropdown.setValue(plugin.rerankingSettings.evidencePolicy).onChange(value => {
      if (value !== "matched-passages" && value !== "contextual") return;
      plugin.run(() => plugin.setRerankingSettings({ ...plugin.rerankingSettings, evidencePolicy: value }));
    });
  });
  new Setting(root).setName("Allow whole short notes").setDesc("Off by default. With contextual evidence, permits the complete indexed body of notes up to 6,000 UTF-8 bytes when it fits the per-note budget. Frontmatter is never added.").addToggle(toggle => {
    toggle.setValue(plugin.rerankingSettings.allowWholeShortNotes).onChange(allowWholeShortNotes => plugin.run(async () => {
      try { await plugin.setRerankingSettings({ ...plugin.rerankingSettings, allowWholeShortNotes }); }
      finally { toggle.setValue(plugin.rerankingSettings.allowWholeShortNotes); }
    }));
  });
  root.createEl("p", { text: "Input safety: 12,000 serialized bytes per note and 24,000 per request. These are byte guards, not exact JEV token counts. A passage that cannot fit intact causes local-ranking fallback. Upgrading from the old excerpt-only policy disables reranking until you review this disclosure and re-enable it.", cls: "setting-item-description" });
}
