import { defaultRerankSettings, type RerankSettings } from "./types";

function paths(value: unknown, folders: boolean): string[] {
  if (!Array.isArray(value) || value.length > 1000) throw new Error("Invalid remote exclusions");
  return [...new Set(value.map((raw: unknown) => {
    if (typeof raw !== "string" || raw.length > 1024 || raw.includes("\0")) throw new Error("Invalid remote exclusion path");
    const path = raw.replaceAll("\\", "/").replace(/\/+$/, "");
    if ((!folders && !path) || path.startsWith("/") || /^[A-Za-z]:/.test(path)
      || path.split("/").some(part => part === "." || part === "..")) throw new Error("Use literal vault-relative remote exclusions");
    return path;
  }))];
}

export function validateRerankSettings(raw: unknown): RerankSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid rerank settings");
  const value = { ...defaultRerankSettings(), ...raw } as Record<string, unknown>;
  if (typeof value.enabled !== "boolean" || (value.provider !== "openrouter" && value.provider !== "typesafe")
    || (value.evidencePassages !== 1 && value.evidencePassages !== 2)) throw new Error("Invalid rerank settings");
  return {
    enabled: value.enabled,
    provider: value.provider,
    evidencePassages: value.evidencePassages,
    excludedFolders: paths(value.excludedFolders, true),
    excludedFiles: paths(value.excludedFiles, false),
  };
}

/** Local admission is still required by the caller; remote flags can only veto. */
export function remoteNoteAllowed(
  settings: RerankSettings,
  path: string,
  metadata: { frontmatter?: Record<string, unknown> } | null | undefined,
): boolean {
  if (!metadata || !path || path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:/.test(path)
    || path.split(/[\\/]/).some(part => part === "." || part === "..")) return false;
  const normalized = path.replaceAll("\\", "/");
  if (settings.excludedFiles.includes(normalized)
    || settings.excludedFolders.some(folder => !folder || normalized === folder || normalized.startsWith(`${folder}/`))) return false;
  const frontmatter = metadata.frontmatter;
  if (frontmatter === undefined) return true;
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) return false;
  return ["ai_remote", "ai_rerank"].every(key => !Object.hasOwn(frontmatter, key) || frontmatter[key] === true);
}
