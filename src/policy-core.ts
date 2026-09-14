const BLOCKED_TAGS = ["status/inbox", "type/private"] as const;

export function normalizeTag(tag: string): string {
  return tag.replace(/^#/, "").toLocaleLowerCase("en-US");
}

export function blockingTag(tags: readonly string[]): string | undefined {
  return tags.map(normalizeTag).find((tag) => BLOCKED_TAGS.some((blocked) => tag === blocked || tag.startsWith(`${blocked}/`)));
}

export function stripFrontmatter(markdown: string): string {
  const source = markdown.startsWith("\uFEFF") ? markdown.slice(1) : markdown;
  if (!source.startsWith("---\n") && !source.startsWith("---\r\n")) return source;
  const lines = source.split(/(?<=\n)/);
  for (let index = 1; index < lines.length; index += 1) {
    if (/^---[ \t]*(?:\r?\n|$)/.test(lines[index] ?? "")) return lines.slice(index + 1).join("");
  }
  throw new Error("Malformed frontmatter; admission deferred");
}
