import { CachedMetadata, TFile, getAllTags } from "obsidian";
import type { PathPolicy } from "./exclusions";
import { blockingTag, stripFrontmatter } from "./policy-core";


 

export interface Admission {
  admitted: boolean;
  deferred?: boolean;
  reason?: string;
}


export function admissionFor(file: TFile, cache: CachedMetadata | null | undefined, pathPolicy: PathPolicy): Admission {
  const pathAdmission = pathPolicy.check(file.path);
  if (!pathAdmission.admitted) return pathAdmission;
  if (!cache) return { admitted: false, deferred: true, reason: "Metadata is not ready" };
  if (cache.frontmatter?.ai_index === false) return { admitted: false, reason: "Excluded by ai_index: false" };
  const blocked = blockingTag(getAllTags(cache) ?? []);
  if (blocked) return { admitted: false, reason: `Excluded by #${blocked}` };
  return { admitted: true };
}


export function canonicalInput(file: TFile, markdown: string): string {
  const body = stripFrontmatter(markdown);
  return `# ${file.basename}\n\n${body}`;
}
