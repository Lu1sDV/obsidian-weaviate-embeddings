import assert from "node:assert/strict";
import test from "node:test";
import { aggregateVectors, poolTokenRange } from "../src/vectors";
import { DEFAULT_MODEL } from "../src/embedding-config";

test("segment aggregation preserves 384 dimensions and unit norm", () => {
  const first = new Array<number>(DEFAULT_MODEL.dimensions).fill(0);
  const second = new Array<number>(DEFAULT_MODEL.dimensions).fill(0);
  first[0] = 1;
  second[1] = 1;
  const aggregate = aggregateVectors([first, second]);
  assert.equal(aggregate.length, DEFAULT_MODEL.dimensions);
  assert.ok(Math.abs(Math.sqrt(aggregate.reduce((sum, value) => sum + value * value, 0)) - 1) < 1e-12);
  assert.ok(Math.abs((aggregate[0] ?? 0) - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs((aggregate[1] ?? 0) - Math.SQRT1_2) < 1e-12);
});

test("zero aggregate fails instead of fabricating a vector", () => {
  assert.throws(() => aggregateVectors([new Array<number>(DEFAULT_MODEL.dimensions).fill(0)]), /invalid aggregate/);
});

test("aggregation uses the selected dimensions without padding or discarding components", () => {
  assert.deepEqual(aggregateVectors([[1, 0], [1, 0]], 2), [1, 0]);
  assert.throws(() => aggregateVectors([[1]], 2), /dimensions/);
  assert.throws(() => aggregateVectors([[1, 0, 0]], 2), /dimensions/);
});

test("contextual pooling excludes specials and normalizes after averaging raw states", () => {
  const hidden = new Float32Array([100, 0, 3, 0, 0, 4, 0, 100]);
  assert.deepEqual(poolTokenRange(hidden, 2, 1, 3), [0.6, 0.8]);
  assert.deepEqual(poolTokenRange(hidden, 2, 1, 2), [1, 0]);
  const note = poolTokenRange(hidden, 2, 0, 4, [1, 1, 1, 1]);
  assert.ok(Math.abs(note[0]! - 103 / Math.hypot(103, 104)) < 1e-12);
  assert.ok(Math.abs(note[1]! - 104 / Math.hypot(103, 104)) < 1e-12);
  assert.deepEqual(poolTokenRange(hidden, 2, 0, 4, [0, 1, 1, 0]), [0.6, 0.8]);
  assert.throws(() => poolTokenRange(hidden, 2, 1, 1), /range/);
  assert.throws(() => poolTokenRange(hidden, 2, 0, 5), /range/);
  assert.throws(() => poolTokenRange([0, 0], 2, 0, 1), /norm/);
  assert.throws(() => poolTokenRange([NaN, 1], 2, 0, 1), /non-finite/);
});
