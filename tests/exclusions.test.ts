import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "obsidian";
import { TFile } from "obsidian";
import { PathPolicy, normalizePolicyPath } from "../src/exclusions";
import { DEFAULT_MODEL } from "../src/embedding-config";
import { admissionFor } from "../src/policy";
import { mergeState } from "../src/state";
import type { PersistedState } from "../src/types";

function state(overrides: Partial<PersistedState> = {}): PersistedState {
  return {
    vaultId: "vault",
    exclusions: { respectGitignore: true, folders: [], files: [] },
    servingReady: false,
    knownGenerations: [1],
    indexingEnabled: true,
    embeddingModel: DEFAULT_MODEL.id,
    chunkingMode: "standard",
    activeGeneration: 1,
    schemaUpdating: false,
    pathToNoteId: {},
    notes: {},
    pendingPurges: [],
    registry: { fields: [] },
    presets: {},
    ...overrides,
  };
}

function fixture(files: Record<string, string>, overrides: Partial<PersistedState> = {}): { policy: PathPolicy; reads: string[] } {
  const reads: string[] = [];
  const app = {
    vault: {
      adapter: {
        async stat(path: string): Promise<{ type: "file"; size: number } | null> {
          return Object.hasOwn(files, path) ? { type: "file", size: files[path]?.length ?? 0 } : null;
        },
        async read(path: string): Promise<string> {
          reads.push(path);
          const value = files[path];
          if (value === undefined) throw new Error("unreadable");
          return value;
        },
      },
    },
  } as unknown as App;
  return { policy: new PathPolicy(app, state(overrides)), reads };
}

test("manual exclusions are normalized literals and cannot be traversed", async () => {
  const { policy } = fixture({}, { exclusions: { respectGitignore: false, folders: ["private/"], files: ["draft.md"] } });
  await policy.reload(["private/note.md", "draft.md"]);
  assert.equal(policy.check("private/note.md").admitted, false);
  assert.equal(policy.check("private/../public.md").admitted, false);
  assert.equal(policy.check("draft.md").admitted, false);
  assert.equal(policy.check("image.png").admitted, false);
  assert.equal(normalizePolicyPath("private//note.md"), "private/note.md");
  const root = fixture({}, { exclusions: { respectGitignore: false, folders: [""], files: [] } });
  await root.policy.reload(["note.md"]);
  assert.equal(root.policy.check("note.md").admitted, false);
});


test("admission defaults to the full vault and retains blacklist precedence", async () => {
  const { policy } = fixture({}, { exclusions: { respectGitignore: false, folders: [], files: [] } });
  await policy.reload(["notes/public.md"]);
  const file = new TFile();
  file.path = "notes/public.md";
  file.basename = "public";
  file.extension = "md";
  assert.equal(admissionFor(file, {}, policy).admitted, true);
  assert.equal(admissionFor(file, { frontmatter: { ai_index: false } }, policy).admitted, false);

  const migrated = mergeState({ ...state(), authorizedRoots: [] } as PersistedState & { authorizedRoots: string[] });
  assert.equal(Object.hasOwn(migrated, "authorizedRoots"), false);
});
test("nested gitignore rules are case-sensitive and ignored parents cannot be negated", async () => {
  const { policy, reads } = fixture({
    ".gitignore": "ignored/\nCase.md\n\\!literal.md\n\\#hash.md\n",
    "ignored/.gitignore": "!keep.md\n",
    "docs/.gitignore": "*.md\n!public.md\n",
  });
  await policy.reload(["ignored/keep.md", "docs/private.md", "docs/public.md", "Case.md", "case.md", "!literal.md"]);
  assert.equal(policy.check("ignored/keep.md").admitted, false);
  assert.equal(policy.check("docs/private.md").admitted, false);
  assert.equal(policy.check("docs/public.md").admitted, true);
  assert.equal(policy.check("Case.md").admitted, false);
  assert.equal(policy.check("case.md").admitted, true);
  assert.equal(policy.check("#hash.md").admitted, false);
  assert.deepEqual(reads, [".gitignore", "docs/.gitignore", "ignored/.gitignore"]);
});

test("invalidation fails closed and unreadable controls deny descendants", async () => {
  const { policy } = fixture({ ".gitignore": "" });
  await policy.reload(["note.md"]);
  assert.equal(policy.check("note.md").admitted, true);
  const app = {
    vault: {
      adapter: {
        async stat(): Promise<{ type: "file"; size: number }> { return { type: "file", size: 1 }; },
        async read(): Promise<string> { throw new Error("permission denied"); },
      },
    },
  } as unknown as App;
  const failing = new PathPolicy(app, state());
  await failing.reload(["note.md"]);
  assert.equal(failing.check("note.md").admitted, false);
});
