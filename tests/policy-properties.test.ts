import assert from "node:assert/strict";
import test from "node:test";
import { blockingTag, normalizeTag, stripFrontmatter } from "../src/policy-core";
import { PropertyRegistry, compileFilters } from "../src/properties";

test("privacy tag matching is hierarchical without prefix near-misses", () => {
  assert.equal(normalizeTag("#STATUS/INBOX"), "status/inbox");
  assert.equal(blockingTag(["#status/inbox/reading"]), "status/inbox/reading");
  assert.equal(blockingTag(["#type/private/medical"]), "type/private/medical");
  assert.equal(blockingTag(["#status/inboxes", "#type/privately"]), undefined);
});

test("frontmatter never enters canonical body", () => {
  assert.equal(stripFrontmatter("---\ntitle: secret\npriority: 3\n---\nPublic body"), "Public body");
  assert.equal(stripFrontmatter("\uFEFF---\r\ntitle: secret\r\n---\r\nPublic body"), "Public body");
  assert.throws(() => stripFrontmatter("---\ntitle: secret\nPublic body"), /Malformed frontmatter/);
});

test("heterogeneous properties receive separate collision-safe native fields", async () => {
  const registry = new PropertyRegistry();
  const numeric = await registry.normalize({ priority: 3, "A-b": true, A_b: false, missing: null, empty: [] });
  const textual = await registry.normalize({ priority: "high" });
  assert.equal(Object.values(numeric.fields).includes(3), true);
  assert.equal(Object.values(textual.fields).includes("high"), true);
  assert.notEqual(registry.field("A-b", "boolean")?.physicalName, registry.field("A_b", "boolean")?.physicalName);
  assert.equal(numeric.nullPropertyKeys.length, 1);
  assert.equal(numeric.emptyListPropertyKeys.length, 1);
  assert.doesNotThrow(() => compileFilters(registry, [{ key: "priority", kind: "number", operator: "gte", value: 2 }]));
});

test("invalid calendar dates remain searchable text instead of breaking metadata normalization", async () => {
  const registry = new PropertyRegistry();
  const normalized = await registry.normalize({
    invalidDay: "2026-02-30",
    invalidMonth: "2026-99-01",
    invalidTimestamp: "2026-02-30T12:00:00Z",
    mixedDates: ["2026-02-28", "2026-02-30"],
    validDate: "2024-02-29",
    validTimestamp: "2026-02-28T23:59:59+02:00",
  });
  assert.equal(registry.field("invalidDay", "text") !== undefined, true);
  assert.equal(registry.field("invalidMonth", "text") !== undefined, true);
  assert.equal(registry.field("invalidTimestamp", "text") !== undefined, true);
  assert.equal(registry.field("mixedDates", "textArray") !== undefined, true);
  assert.equal(Object.values(normalized.fields).includes("2024-02-29T00:00:00.000Z"), true);
  assert.equal(Object.values(normalized.fields).includes("2026-02-28T21:59:59.000Z"), true);
});
