import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { projectMarkdown } from "../src/rerank/markdown";
import { prepareContext, selectContext } from "../src/rerank/context";
import { verifyDocument, documentForCandidate, groupConnectionCandidates } from "../src/rerank/documents";
import { RerankError } from "../src/rerank/types";
import { note } from "./helpers/adaptive-fixtures";
import type { ManifestNote, NormalizedProperties } from "../src/types";
import type { NoteObject, PassageObject } from "../src/weaviate";

const context = (text: string, start: number, end: number) => prepareContext({ title: "Synthetic", text, anchors: [{ start, end }] });

test("outbound projection strips image destinations, embeds, HTML targets and image data", () => {
  const input = '![useful route diagram](https://secret.example/a_(b).png "title")\n\n![[private/folder/picture.png|640x480]]\n'
    + '<picture><source srcset="https://secret.example/x"><img src="secret-path" alt="A meaningful map"></picture>\n'
    + 'raw data:image/png;base64,SECRETPAYLOAD\n';
  const result = projectMarkdown(input).text;
  assert.match(result, /useful route diagram/); assert.match(result, /A meaningful map/);
  for (const value of ["secret.example", "secret-path", "private/folder", "640x480", "SECRETPAYLOAD", "srcset"]) assert.ok(!result.includes(value), value);
});

test("reference and shortcut images remove unused image definitions but preserve textual references", () => {
  const result = projectMarkdown('![Useful diagram][pic]\n![Shortcut]\n[text][link]\n\n[pic]: private.png\n[Shortcut]: hidden.svg\n[link]: https://example.test/info\n').text;
  assert.match(result, /Useful diagram/); assert.match(result, /Shortcut/);
  assert.ok(!result.includes("private.png") && !result.includes("hidden.svg"));
  assert.match(result, /https:\/\/example.test\/info/);
});

test("image-looking code and escaped Markdown remain literal, including multiline inline code", () => {
  const literal = '```md\n![Code](keep.png)\ndata:image/png;base64,EXAMPLE\n```\n\n    ![indented](keep2.png)\n'
    + '\n`![inline](keep3.png)`\n`multiline\n![example](keep4.png)`\n\\![escaped](keep5.png)\n';
  assert.equal(projectMarkdown(literal).text, literal);
});

test("cleaned source offsets locate an anchor after a removed image without shifting its meaning", () => {
  const input = '![image](a.png)\n\nBefore.\n\nEXACT ANCHOR\n\nAfter.';
  const start = input.indexOf("EXACT ANCHOR"), projection = projectMarkdown(input);
  const range = projection.range({ start, end: start + 12 });
  assert.equal(projection.text.slice(range.start, range.end), "EXACT ANCHOR");
});

test("short whole notes are sent as complete cleaned text", () => {
  const text = "# Title\n\nA short note.\n\n![image](private.png)";
  const selected = selectContext(context(text, 9, 22), { scope: "note", tokens: 512, contextTokens: 512, source: false });
  assert.equal(selected.complete, true); assert.equal(selected.wire.coverage, "full");
  assert.match(selected.text, /A short note/); assert.ok(!selected.text.includes("private.png"));
});

test("oversized whole-note candidates retain substantive opening, interior match and ending", () => {
  const opening = "Opening purpose. " + "background ".repeat(90);
  const matched = "INTERIOR MATCH: carefully documented evidence.";
  const ending = "Final conclusion. " + "closing ".repeat(50);
  const text = `# A\n\n${opening}\n\n## Interior\n\n${"filler ".repeat(2000)}\n\n${matched}\n\n${"more ".repeat(2000)}\n\n## Conclusion\n\n${ending}`;
  const start = text.indexOf(matched);
  const selected = selectContext(context(text, start, start + matched.length), { scope: "note", tokens: 1500, contextTokens: 512, source: false });
  assert.equal(selected.complete, false); assert.match(selected.text, /Opening purpose/); assert.match(selected.text, /INTERIOR MATCH/);
  assert.match(selected.text, /Final conclusion|closing/); assert.match(selected.text, /Text omitted/);
  assert.ok(selected.text.indexOf("Opening") < selected.text.indexOf("INTERIOR MATCH"));
});

test("whole-note source extraction covers representative sections instead of candidate-specific snippets", () => {
  const text = Array.from({ length: 6 }, (_, index) => `## Section ${index}\n\nTopic${index} ${"detail ".repeat(500)}`).join("\n\n");
  const source = prepareContext({ kind: "note", title: "Multi-topic", text, anchors: [] });
  const selected = selectContext(source, { scope: "note", tokens: 1500, contextTokens: 512, source: true });
  assert.match(selected.text, /Topic0/); assert.match(selected.text, /Topic3|Topic2/); assert.match(selected.text, /Topic5|detail/);
  assert.ok(new Set(selected.wire.segments.map(segment => segment.heading)).size >= 3);
});

test("selected source passage stays complete and explicitly separated from nearby context", () => {
  const focus = "SELECTED: This is the exact information need.";
  const text = `# Note\n\nUNRELATED INTRO ${"left ".repeat(1500)}\n\n## Focus\n\n${"before ".repeat(200)}\n\n${focus}\n\n${"after ".repeat(200)}\n\n## Other\nUNRELATED END`;
  const start = text.indexOf(focus);
  const document = prepareContext({ kind: "passage", title: "Note", text, anchors: [], selected: { start, end: start + focus.length } });
  const selected = selectContext(document, { scope: "passage", tokens: 1000, contextTokens: 128, source: true });
  assert.equal(selected.wire.segments.find(segment => segment.role === "focus")?.text, focus);
  assert.ok(!selected.text.includes("UNRELATED INTRO") && !selected.text.includes("UNRELATED END"));
  assert.throws(() => selectContext(document, { scope: "passage", tokens: 2, contextTokens: 512, source: true }),
    (error: unknown) => error instanceof RerankError && error.reason === "source-too-large");
});

test("overlapping candidate windows are merged and Unicode clipping never creates replacement characters", () => {
  const text = "🙂漢字 café ".repeat(1000);
  const document = prepareContext({ title: "多言語", text, anchors: [{ start: 120, end: 360 }, { start: 180, end: 400 }] });
  const selected = selectContext(document, { scope: "passage", tokens: 400, contextTokens: 512, source: false });
  assert.ok(!selected.text.includes("\ufffd"));
  for (let index = 1; index < selected.ranges.length; index++) assert.ok(selected.ranges[index - 1]!.end <= selected.ranges[index]!.start);
});

test("references and attachment lists do not automatically take the ending budget", () => {
  const text = `# Main\n\nOpening. ${"start ".repeat(300)}\n\n## Findings\n\nMAIN FINDING ${"evidence ".repeat(1500)}\n\n## References\n\n${"reference-only-entry ".repeat(2000)}`;
  const start = text.indexOf("MAIN FINDING");
  const selected = selectContext(context(text, start, start + 30), { scope: "note", tokens: 800, contextTokens: 128, source: false });
  assert.ok(!selected.text.includes("reference-only-entry"));
});

function snapshot() {
  const text = "# Candidate\n\nVerified body.";
  const properties: NormalizedProperties = { frontmatterJson: "{}", propertyKeys: [], nullPropertyKeys: [], emptyListPropertyKeys: [], tags: [], tagAncestors: [], fields: {} };
  const stored: { note: NoteObject; passages: PassageObject[] } = {
    note: { noteId: "note0", snapshotId: "snap0", path: "local-only/note0.md", title: "Candidate", noteVectorMode: "direct", vector: [1, 0], properties },
    passages: [{ noteId: "note0", snapshotId: "snap0", path: "local-only/note0.md", title: "Candidate", passageId: "p0", passageIndex: 0,
      heading: "Candidate", body: text.slice(13), start: 13, end: text.length, startLine: 2, endLine: 3, vector: [1, 0], properties }],
  };
  const manifest: ManifestNote = { noteId: "note0", snapshotId: "snap0", path: "local-only/note0.md", generation: 1, modelFingerprint: "model", policyEpoch: 1,
    noteVectorMode: "direct", bodyHash: createHash("sha256").update(text).digest("hex"), passageIds: ["p0"], committed: true, servable: true };
  return { text, stored, manifest };
}

test("hydration verifies exact body hash, ordered manifest IDs and source-span consistency", () => {
  const fixture = snapshot();
  assert.equal(verifyDocument(fixture.manifest, fixture.text, fixture.stored).text, fixture.text);
  for (const mutate of [
    (f: ReturnType<typeof snapshot>) => { f.text += " edited"; },
    (f: ReturnType<typeof snapshot>) => { f.manifest.servable = false; },
    (f: ReturnType<typeof snapshot>) => { f.manifest.committed = false; },
    (f: ReturnType<typeof snapshot>) => { f.manifest.passageIds = ["wrong"]; },
    (f: ReturnType<typeof snapshot>) => { f.stored.passages[0]!.start++; },
    (f: ReturnType<typeof snapshot>) => { f.stored.passages[0]!.body += " fabricated"; },
  ]) {
    const changed = snapshot(); mutate(changed);
    assert.throws(() => verifyDocument(changed.manifest, changed.text, changed.stored), RerankError);
  }
});

test("whole-note candidates find local passage anchors from stored vectors", () => {
  const fixture = snapshot(), verified = verifyDocument(fixture.manifest, fixture.text, fixture.stored);
  const item = note(0); item.candidate.passages = []; item.candidate.result.passages = [];
  const selected = documentForCandidate(verified, item.candidate, [1, 0]);
  assert.equal(selected.anchors[0]?.passageId, "p0");
  assert.throws(() => documentForCandidate(verified, note(0).candidate, [1, 0]), RerankError);
});

test("Connections grouping preserves later hits for an already-admitted note", () => {
  const a = note(0).candidate.result, b = note(1).candidate.result;
  const later = structuredClone(a); later.passages[0]!.passageId = "another";
  const grouped = groupConnectionCandidates([a, b, later], 1);
  assert.equal(grouped.length, 1); assert.equal(grouped[0]!.passages.length, 2);
  assert.equal(grouped[0]!.result.score, a.score);
});

test("image reference continuations and orphan image-data definitions cannot leak payloads", () => {
  const text = '![Useful][diagram]\n\n[diagram]:\n  https://private.example/image.png\n  "private title"\n\n[unused]: data:image/png;base64,SECRET_BASE64';
  const result = projectMarkdown(text).text;
  assert.ok(!result.includes("private.example"), result);
  assert.ok(!result.includes("SECRET_BASE64"), result);
  assert.match(result, /Useful/);
});

test("pathological unbalanced delimiters are bounded instead of causing quadratic parser work", () => {
  assert.throws(() => projectMarkdown("[".repeat(3000)), (error: unknown) => error instanceof RerankError && error.reason === "budget");
});

test("partial table extracts retain column headers", () => {
  const header = "| Name | Value |\n| --- | --- |\n";
  const text = "# Measurements\n\n" + header + Array.from({ length: 1000 }, (_, index) => `| row${index} | ${index} |`).join("\n");
  const start = text.indexOf("| row800");
  const selected = selectContext(context(text, start, start + "| row800 | 800 |".length), { scope: "passage", tokens: 300, contextTokens: 64, source: false });
  assert.ok(selected.text.includes("| Name | Value |"), selected.text);
});

test("selected indented code preserves meaningful indentation", () => {
  const focus = "    if enabled:\n        run()";
  const text = "# Program\n\nBefore.\n\n" + focus + "\n\nAfter.";
  const start = text.indexOf(focus);
  const prepared = prepareContext({ kind: "passage", title: "Program", text, anchors: [], selected: { start, end: start + focus.length } });
  const selected = selectContext(prepared, { scope: "passage", tokens: 100, contextTokens: 20, source: true });
  assert.equal(selected.wire.segments.find(segment => segment.role === "focus")?.text, focus);
});


test("many ordinary inline-code spans and embeds remain within linear parsing bounds", () => {
  const text = Array.from({ length: 1000 }, (_, index) => `Example ${index}: \`![literal](keep.png)\` ![[image.png|300]]`).join("\n");
  const cleaned = projectMarkdown(text).text;
  assert.equal((cleaned.match(/keep.png/g) ?? []).length, 1000);
  assert.ok(!cleaned.includes("image.png|300"));
});

test("selected code and quotations carry their structural type, not anonymous fragments", () => {
  const text = "# Quote\n\n> A quoted claim.\n> Its supporting explanation.\n\nNext paragraph.";
  const start = text.indexOf("> A quoted");
  const selected = selectContext(context(text, start, start + 17), { scope: "passage", tokens: 24, contextTokens: 0, source: false });
  assert.equal(selected.wire.segments[0]?.format, "quote");
  assert.match(selected.wire.segments[0]!.text, /^>/);
});

test("an extracted nested list retains its parent item", () => {
  const text = "# Procedure\n\n- Parent requirement\n" + Array.from({ length: 150 }, (_, index) => `    - Step ${index}: relevant detail`).join("\n");
  const start = text.indexOf("    - Step 120");
  const selected = selectContext(context(text, start, start + 31), { scope: "passage", tokens: 100, contextTokens: 16, source: false });
  assert.match(selected.text, /Parent requirement/); assert.match(selected.text, /Step 120/);
});

test("very high line counts are bounded before allocating an unbounded projection", () => {
  assert.throws(() => projectMarkdown("\n".repeat(50_001)), (error: unknown) => error instanceof RerankError && error.reason === "budget");
});

test("surrounding evidence admits complete Markdown paragraphs, not arbitrary byte tails", () => {
  const first = "FIRST BEFORE paragraph is short enough to retain in full.\nIts soft-wrapped line remains in the same paragraph.";
  const near = "NEAR BEFORE paragraph stays whole, not clipped in half.";
  const focus = "FOCUS: the selected claim.";
  const after = "NEAR AFTER paragraph stays whole, even when multiple candidates compete.";
  const text = `## Previous\n\nPRIVATE OLD SECTION ${"old ".repeat(500)}\n\n## Relevant\n\n${first}\n\n${near}\n\n${focus}\n\n${after}\n\n## Next\n\nPRIVATE NEXT SECTION ${"next ".repeat(500)}`;
  const start = text.indexOf(focus);
  const selected = selectContext(prepareContext({ kind: "passage", title: "Paragraphs", text,
    anchors: [], selected: { start, end: start + focus.length } }),
  { scope: "passage", tokens: 500, contextTokens: 150, source: true });
  assert.equal(selected.wire.segments.find(part => part.role === "focus")?.text, focus);
  assert.ok(selected.text.includes(first), selected.text);
  assert.ok(selected.text.includes(near), selected.text);
  assert.ok(selected.text.includes(after), selected.text);
  assert.ok(!selected.text.includes("PRIVATE OLD SECTION") && !selected.text.includes("PRIVATE NEXT SECTION"));
  assert.ok(selected.wire.segments.filter(part => part.role === "context").every(part => !part.partial));
});

test("a too-long neighboring paragraph falls back to fixed-length text nearest the focus", () => {
  const focus = "FOCUS claim";
  const text = `# Relevant\n\nDISTANT START ${"earlier ".repeat(200)}\nNEAR BEFORE TERMINUS\n\n${focus}\n\nNEAR AFTER ORIGIN ${"later ".repeat(200)} DISTANT END\n\n## Other\n\nNEVER CROSS HEADING`;
  const start = text.indexOf(focus);
  const selected = selectContext(prepareContext({ kind: "passage", title: "Long paragraphs", text,
    anchors: [], selected: { start, end: start + focus.length } }),
  { scope: "passage", tokens: 250, contextTokens: 60, source: true });
  assert.match(selected.text, /NEAR BEFORE TERMINUS/);
  assert.match(selected.text, /NEAR AFTER ORIGIN/);
  assert.ok(!selected.text.includes("DISTANT START") && !selected.text.includes("DISTANT END"), selected.text);
  assert.ok(!selected.text.includes("NEVER CROSS HEADING"), selected.text);
  assert.ok(selected.wire.segments.some(part => part.role === "context" && part.partial));
  assert.ok(!selected.text.includes("\ufffd"));
});

test("Markdown fenced code with blank lines stays a whole neighboring block when affordable", () => {
  const code = "```ts\nconst first = 1;\n\nconst second = 2;\n```";
  const focus = "SELECTED FOCUS";
  const text = `# Relevant\n\n${code}\n\n${focus}\n\n## Other\n\n${"unrelated ".repeat(300)}`;
  const start = text.indexOf(focus);
  const selected = selectContext(prepareContext({ kind: "passage", title: "Code", text,
    anchors: [], selected: { start, end: start + focus.length } }),
  { scope: "passage", tokens: 160, contextTokens: 70, source: true });
  assert.ok(selected.wire.segments.some(part => part.role === "context" && part.text.includes(code) && part.format === "code"), selected.text);
  assert.ok(!selected.text.includes("unrelated"), selected.text);
});

test("neighbor context stops on the first oversized paragraph without skipping ahead for smaller ones", () => {
  const focus = "FOCUS";
  const text = `# Topic\n\nSHOULD NOT SKIP HERE\n\n${"very large neighbor ".repeat(200)} NEAR ANCHOR\n\n${focus}\n\n${"also large ".repeat(200)}\n\nSHOULD NOT JUMP AHEAD`;
  const start = text.indexOf(focus);
  const selected = selectContext(prepareContext({ kind: "passage", title: "Stop", text,
    anchors: [], selected: { start, end: start + focus.length } }),
  { scope: "passage", tokens: 250, contextTokens: 45, source: true });
  assert.ok(selected.text.includes("NEAR ANCHOR"));
  assert.ok(!selected.text.includes("SHOULD NOT SKIP HERE") && !selected.text.includes("SHOULD NOT JUMP AHEAD"), selected.text);
});

test("complete paragraph coverage does not treat blank-line separators as omitted content", () => {
  const text = "FIRST PARAGRAPH.\n\nFOCUS.\n\nLAST PARAGRAPH.";
  const start = text.indexOf("FOCUS");
  const selected = selectContext(prepareContext({ kind: "passage", title: "Coverage", text,
    anchors: [], selected: { start, end: start + 6 } }),
  { scope: "passage", tokens: 140, contextTokens: 50, source: true });
  assert.equal(selected.complete, true);
  assert.equal(selected.wire.coverage, "full");
  assert.ok(!selected.text.includes("[Text omitted]"), selected.text);
  assert.ok(selected.wire.segments.every(segment => !segment.partial));
});

test("many tiny paragraph neighbors remain bounded by the shared evidence allowance", () => {
  const before = Array.from({ length: 800 }, (_, index) => `Paragraph before ${index}.`).join("\n\n");
  const after = Array.from({ length: 800 }, (_, index) => `Paragraph after ${index}.`).join("\n\n");
  const text = `# Relevant\n\n${before}\n\nEXACT FOCUS\n\n${after}`;
  const start = text.indexOf("EXACT FOCUS");
  const selected = selectContext(prepareContext({ kind: "passage", title: "Many short paragraphs", text,
    anchors: [], selected: { start, end: start + "EXACT FOCUS".length } }),
  { scope: "passage", tokens: 600, contextTokens: 300, source: true });
  assert.ok(selected.text.includes("Paragraph before 799."));
  assert.ok(selected.text.includes("Paragraph after 0."));
  assert.ok(!selected.text.includes("Paragraph before 0."));
  assert.ok(!selected.text.includes("Paragraph after 799."));
  assert.equal(selected.wire.segments.find(part => part.role === "focus")?.text, "EXACT FOCUS");
  assert.ok(selected.wire.segments.length <= 5, "same-format neighboring paragraphs should not multiply wire segment overhead");
  assert.ok(selected.wire.segments.some(part => part.role === "context" && /Paragraph before 79\d\.\n\nParagraph before/.test(part.text)),
    "compacted evidence must preserve original Markdown paragraph boundaries");
  assert.ok(selected.wire.segments.every(segment => segment.text && !segment.text.includes("\ufffd")));
});
