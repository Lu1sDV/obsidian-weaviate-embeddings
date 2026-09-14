import assert from "node:assert/strict";
import test from "node:test";
import { buildConnectionGraph, buildSimilarityGraph, cosineSimilarity, edgesAboveCutoff, visibleResults } from "../src/graph";
import type { SearchResult, StoredNoteVector } from "../src/types";

function note(noteId: string, score = 1): SearchResult {
  return { noteId, snapshotId: `snapshot-${noteId}`, path: `${noteId}.md`, title: noteId, score, scoreKind: "hybrid", passages: [] };
}
function stored(result: SearchResult, vector: number[]): StoredNoteVector {
  return { noteId: result.noteId, snapshotId: result.snapshotId, vector };
}

test("cosine is normalized, signed, and rejects unusable stored vectors", () => {
  assert.equal(cosineSimilarity([2, 0], [5, 0], 2), 1);
  assert.equal(cosineSimilarity([1, 0], [-1, 0], 2), -1);
  assert.equal(cosineSimilarity([1, 0], [0, 1], 2), 0);
  assert.ok(Math.abs(cosineSimilarity([1, 1], [1, 0], 2) - Math.SQRT1_2) < 1e-14);
  for (const bad of [[0, 0], [1], [NaN, 0], [Infinity, 0], [Number.MAX_VALUE, 1]]) {
    assert.throws(() => cosineSimilarity(bad, [1, 0], 2));
  }
});

test("connections preserve retrieval scores while search computes every stored pair", () => {
  const anchor = note("reference");
  const results = [note("first", 0.9), note("second", 0.7)];
  const graph = buildConnectionGraph(results, anchor);
  assert.deepEqual(graph.nodes.map((node) => node.noteId), ["reference", "first", "second"]);
  assert.deepEqual(graph.edges, [
    { source: "reference", target: "first", cosine: 0.9 },
    { source: "reference", target: "second", cosine: 0.7 },
  ]);
  const before = structuredClone(graph);
  assert.equal(edgesAboveCutoff(graph.edges, 0.8).length, 1);
  assert.deepEqual(graph, before);
  assert.deepEqual(results.map((result) => result.noteId), ["first", "second"]);

  const vectors = [stored(results[0]!, [1, 1]), stored(results[1]!, [0, 1])];
  assert.ok(Math.abs(buildSimilarityGraph(results, undefined, vectors, 2).edges[0]!.cosine - Math.SQRT1_2) < 1e-14);
});

test("graph membership is exactly current snapshots, never a missing-vector substitute", () => {
  const result = note("admitted");
  assert.throws(() => buildSimilarityGraph([result], undefined, [], 2), /membership/);
  assert.throws(() => buildSimilarityGraph([result], undefined, [{ ...stored(result, [1, 0]), snapshotId: "retired" }], 2), /snapshot/);
  assert.throws(() => buildSimilarityGraph([result], undefined, [stored(result, [0, 0])], 2), /norm/);
  assert.throws(() => buildSimilarityGraph([result], result, [stored(result, [1, 0])], 2), /Duplicate/);
  assert.throws(() => buildConnectionGraph([result], result), /Duplicate/);
  assert.throws(() => buildConnectionGraph([{ ...result, score: 2 }], note("reference")), /score/);
  assert.throws(() => buildSimilarityGraph([result], undefined, [stored(result, [1, 0]), stored(note("not-listed"), [0, 1])], 2), /membership/);
});

test("31 connection notes bound the constellation while 30 search notes retain 435 pairs", () => {
  const anchor = note("reference");
  const results = Array.from({ length: 30 }, (_, index) => note(`note-${index}`, 1));
  const graph = buildConnectionGraph(results, anchor);
  assert.equal(graph.nodes.length, 31);
  assert.equal(graph.edges.length, 30);
  assert.equal(graph.nodes.filter((node) => node.anchor).length, 1);
  assert.ok(graph.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y) && node.x >= 48 && node.x <= 312 && node.y >= 12 && node.y <= 268));
  const search = buildSimilarityGraph(results, undefined, results.map((result) => stored(result, [1, 0])), 2);
  assert.deepEqual(search.nodes.map((node) => node.noteId), results.map((result) => result.noteId));
  assert.equal(search.nodes.some((node) => node.anchor), false);
  assert.equal(search.edges.length, 435);
  assert.throws(() => buildConnectionGraph([...results, note("overflow")], anchor), /30/);
});

test("candidate admission preserves actual hybrid order, deduplicates, and refills to 30", () => {
  const candidates = Array.from({ length: 80 }, (_, index) => note(`note-${index}`, 100 - index));
  candidates.splice(2, 0, note("note-1", 98));
  candidates.splice(4, 0, note("invalid-score", NaN));
  const admitted = visibleResults(candidates, (result) => Number(result.noteId.slice(5)) % 2 === 1);
  assert.deepEqual(admitted.map((result) => result.noteId), Array.from({ length: 30 }, (_, index) => `note-${index * 2 + 1}`));
  assert.deepEqual(admitted.map((result) => result.score), Array.from({ length: 30 }, (_, index) => 99 - index * 2));
});
