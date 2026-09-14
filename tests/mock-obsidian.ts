export interface CachedMetadata {
  frontmatter?: Record<string, unknown>;
  tags?: string[];
}

export interface TAbstractFile {
  path: string;
}

export class TFile implements TAbstractFile {
  path = "";
  basename = "";
  extension = "";
}

export class TFolder implements TAbstractFile {
  path = "";
}

export interface App {
  vault: {
    adapter: {
      stat(path: string): Promise<unknown>;
      read(path: string): Promise<string>;
    };
    getMarkdownFiles(): TFile[];
    getAbstractFileByPath(path: string): TAbstractFile | null;
    cachedRead(file: TFile): Promise<string>;
  };
  metadataCache: {
    getFileCache(file: TFile): CachedMetadata | null;
  };
}

export function getAllTags(cache: CachedMetadata | null | undefined): string[] {
  return cache?.tags ?? [];
}

export async function requestUrl(): Promise<never> {
  throw new Error("requestUrl is unavailable in pure coordinator tests");
}
