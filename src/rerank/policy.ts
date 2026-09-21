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
  const value = { ...defaultRerankSettings(), ...raw };
  if (typeof value.enabled !== "boolean" || typeof value.experimentalBatching !== "boolean"
    || (value.provider !== "openrouter" && value.provider !== "typesafe")) throw new Error("Invalid rerank settings");
  // Reconstruct, rather than preserving unknown fields (especially secrets).
  return { enabled: value.enabled, provider: value.provider, experimentalBatching: value.experimentalBatching,
    excludedFolders: paths(value.excludedFolders, true), excludedFiles: paths(value.excludedFiles, false) };
}

/** Local admission is still required by the caller; remote flags can only veto. */
export function remoteNoteAllowed(
  settings: RerankSettings, path: string, metadata: { frontmatter?: Record<string, unknown> } | null | undefined,
): boolean {
  if (!metadata || !path || path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:/.test(path)
    || path.split(/[\\/]/).some(part => part === "." || part === "..")) return false;
  const normalized = path.replaceAll("\\", "/");
  if (settings.excludedFiles.includes(normalized)
    || settings.excludedFolders.some(folder => !folder || normalized === folder || normalized.startsWith(`${folder}/`))) return false;
  const frontmatter = metadata.frontmatter;
  if (frontmatter === undefined) return true; // A cached note without YAML is not missing metadata.
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) return false;
  // ai_remote is canonical; honor the other RFC's ai_rerank spelling as a deny-only alias.
  // Malformed or quoted values fail closed, rather than turning "false" into truthy consent.
  return ["ai_remote", "ai_rerank"].every(key => !Object.hasOwn(frontmatter, key) || frontmatter[key] === true);
}
