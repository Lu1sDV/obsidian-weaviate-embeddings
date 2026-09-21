import assert from "node:assert/strict";
import { test } from "node:test";
import { pairedNdcg, rankingMetrics, readEvaluation, type EvaluationCase } from "../src/rerank/evaluation";

test("ranking metrics distinguish retrieval coverage from ranking and handle no-answer cases", () => {
  const grades = { a: 3, b: 1, c: 0 };
  assert.deepEqual(rankingMetrics(["a", "b", "c"], grades), { ndcg: 1, mrr: 1, recall: 1, oracleNdcg: 1 });
  const missed = rankingMetrics(["c", "b"], grades);
  assert.equal(missed.recall, 0.5); assert.equal(missed.mrr, 0.5); assert.ok(missed.oracleNdcg! < 1);
  assert.equal(rankingMetrics(["c"], { c: 0 }).ndcg, null);
  assert.throws(() => rankingMetrics(["a", "a"], grades));
  assert.throws(() => rankingMetrics(["unknown"], grades));
});
test("evaluation rejects family leakage and computes reproducible paired cluster intervals", () => {
  const cases: EvaluationCase[] = ["a", "b", "c"].map(id => ({ id, family: id, split: "test", grades: { useful: 3, other: 0 },
    rankings: { local: ["other", "useful"], rerank: ["useful", "other"] } }));
  const result = pairedNdcg(cases, "local", "rerank");
  assert.ok(result.delta! > 0); assert.ok(result.interval95![0] > 0);
  assert.deepEqual(result, pairedNdcg(cases, "local", "rerank"));
  assert.throws(() => readEvaluation({ kind: "recorded", cases: [...cases, { ...cases[0], id: "leaked", split: "dev" }] }));
  assert.equal(readEvaluation({ kind: "synthetic", cases }).cases.length, 3);
});
