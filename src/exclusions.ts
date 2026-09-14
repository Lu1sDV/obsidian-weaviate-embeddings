import type { App } from "obsidian";
import ignore from "ignore";
import type { Admission } from "./policy";
import type { PersistedState } from "./types";

type Ignore = {
  checkIgnore(path: string): { ignored: boolean; unignored: boolean; rule?: { pattern?: string } };
};


const MAX_CONTROL_BYTES = 256 * 1024;
const MAX_CONTROL_TOTAL_BYTES = 2 * 1024 * 1024;

type Control = {
  directory: string;
  source: string;
  matcher: Ignore;
};

type RuleMatch = {
  path: string;
  source: string;
  pattern?: string;
};

/**
 * The path gate is deliberately synchronous after reload. A caller can invalidate it
 * before any asynchronous service operation and every subsequent check fails closed.
 */
export class PathPolicy {
  private controls: readonly Control[] = [];
  private failedDirectories: readonly string[] = [];
  private valid: boolean;
  private reloadGeneration = 0;

  constructor(private readonly app: App, private readonly state: PersistedState) {
    this.valid = !this.settings().respectGitignore;
  }

  invalidate(): void {
    this.valid = false;
    this.reloadGeneration += 1;
  }

  async reload(paths: readonly string[]): Promise<void> {
    const generation = ++this.reloadGeneration;
    this.valid = false;
    const normalizedPaths = [...new Set(paths.map(normalizePolicyPath).filter((path): path is string => path !== undefined))];
    const settings = this.settings();
    if (!settings.respectGitignore) {
      if (generation === this.reloadGeneration) {
        this.controls = [];
        this.failedDirectories = [];
        this.valid = true;
      }
      return;
    }

    const directories = new Set<string>();
    for (const path of normalizedPaths) {
      for (const directory of ancestorDirectories(path)) directories.add(directory);
    }
    const orderedDirectories = [...directories].sort((left, right) => left.length - right.length || left.localeCompare(right));
    const controls: Control[] = [];
    const failedDirectories: string[] = [];
    let bytesRead = 0;
    for (const directory of orderedDirectories) {
      const controlPath = directory ? `${directory}/.gitignore` : ".gitignore";
      let stat;
      try {
        stat = await this.app.vault.adapter.stat(controlPath);
      } catch {
        failedDirectories.push(directory);
        continue;
      }
      if (!stat) continue;
      if (stat.type !== "file") {
        failedDirectories.push(directory);
        continue;
      }
      let contents: string;
      try {
        contents = await this.app.vault.adapter.read(controlPath);
      } catch {
        failedDirectories.push(directory);
        continue;
      }
      if (contents.length > MAX_CONTROL_BYTES || bytesRead + contents.length > MAX_CONTROL_TOTAL_BYTES) {
        failedDirectories.push(directory);
        continue;
      }
      bytesRead += contents.length;
      try {
        controls.push({ directory, source: controlPath, matcher: ignore({ ignorecase: false, allowRelativePaths: true }).add(contents) });
      } catch {
        failedDirectories.push(directory);
      }
    }
    if (generation !== this.reloadGeneration) return;
    this.controls = controls;
    this.failedDirectories = failedDirectories;
    this.valid = true;
  }

  check(path: string): Admission {
    const normalized = normalizePolicyPath(path);
    if (!normalized) return { admitted: false, reason: "Invalid vault path" };
    if (!this.valid) return { admitted: false, reason: "Path policy is unavailable" };
    if (!normalized.endsWith(".md")) return { admitted: false, reason: "Only Markdown notes are admitted" };

    const settings = this.settings();
    const manual = manualMatch(normalized, settings.folders, settings.files);
    if (manual) return { admitted: false, reason: `Excluded by ${manual}` };
    for (const directory of this.failedDirectories) {
      if (directory === "" || normalized === directory || normalized.startsWith(`${directory}/`)) {
        return { admitted: false, reason: `Gitignore unavailable for ${directory || "vault root"}` };
      }
    }

    let ignored = false;
    let parentIgnored = false;
    let match: RuleMatch | undefined;
    for (const control of this.controls) {
      const relative = relativePath(control.directory, normalized);
      if (!relative) continue;
      const parent = ignoredParent(control.matcher, relative);
      if (parent) {
        parentIgnored = true;
        ignored = true;
        match = { path: relative, source: control.source, pattern: parent };
        continue;
      }
      const result = control.matcher.checkIgnore(relative);
      if (result.ignored) {
        ignored = true;
        match = { path: relative, source: control.source, ...(result.rule ? { pattern: result.rule.pattern } : {}) };
      } else if (result.unignored && !parentIgnored) {
        ignored = false;
        match = undefined;
      }
    }
    return ignored
      ? { admitted: false, reason: `Excluded by ${match?.source ?? ".gitignore"}${match?.pattern ? ` (${match.pattern})` : ""}` }
      : { admitted: true };
  }

  private settings(): { respectGitignore: boolean; folders: readonly string[]; files: readonly string[] } {
    return this.state.exclusions ?? { respectGitignore: true, folders: [], files: [] };
  }
}

export function normalizePolicyPath(path: string): string | undefined {
  if (typeof path !== "string") return undefined;
  const slashPath = path.replaceAll("\\", "/");
  if (slashPath.startsWith("/") || slashPath.includes("\0")) return undefined;
  const parts = slashPath.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.some((part) => part === "..")) return undefined;
  return parts.join("/");
}
export function manualMatch(path: string, folders: readonly string[], files: readonly string[]): string | undefined {
  for (const raw of files) {
    const normalized = normalizePolicyPath(raw);
    if (normalized !== undefined && normalized !== "" && path === normalized) return `file exclusion ${normalized}`;
  }
  for (const raw of folders) {
    const normalized = normalizePolicyPath(raw);
    if (normalized !== undefined && (normalized === "" || path === normalized || path.startsWith(`${normalized}/`))) return `folder exclusion ${normalized || "vault root"}`;
  }
  return undefined;
}

function ancestorDirectories(path: string): string[] {
  const parts = path.split("/");
  const directories = [""];
  for (let index = 1; index < parts.length; index += 1) directories.push(parts.slice(0, index).join("/"));
  return directories;
}

function relativePath(directory: string, path: string): string | undefined {
  if (!directory) return path;
  if (path === directory || !path.startsWith(`${directory}/`)) return undefined;
  return path.slice(directory.length + 1);
}

function ignoredParent(matcher: Ignore, relative: string): string | undefined {
  const parts = relative.split("/");
  if (parts.length < 2) return undefined;
  for (let index = 1; index < parts.length; index += 1) {
    const candidate = parts.slice(0, index).join("/");
    const result = matcher.checkIgnore(candidate);
    const directoryResult = matcher.checkIgnore(`${candidate}/`);
    if (result.ignored || directoryResult.ignored) return result.rule?.pattern ?? directoryResult.rule?.pattern ?? candidate;
  }
  return undefined;
}
