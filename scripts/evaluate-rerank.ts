import { readFile, stat } from "node:fs/promises";
import { pairedNdcg, rankingMetrics, readEvaluation } from "../src/rerank/evaluation";

async function main(): Promise<void> {
  const filename = process.argv[2] ?? "tests/fixtures/rerank-evaluation.json";
  if ((await stat(filename)).size > 10_000_000) throw new Error("Evaluation file exceeds the offline size limit");
  const corpus = readEvaluation(JSON.parse(await readFile(filename, "utf8")));
  const average = (values: Array<number | null>) => {
    const known = values.filter((value): value is number => value !== null);
    return known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : null;
  };
  const report = ["dev", "test"].map(split => {
    const cases = corpus.cases.filter(item => item.split === split);
    const arms = [...new Set(cases.flatMap(item => Object.keys(item.rankings)))];
    const metrics = Object.fromEntries(arms.map(arm => {
      const matched = cases.filter(item => Object.hasOwn(item.rankings, arm));
      const values = matched.map(item => rankingMetrics(item.rankings[arm]!, item.grades));
      return [arm, { queries: matched.length, noAnswerQueries: values.filter(value => value.ndcg === null).length,
        ndcg10: average(values.map(value => value.ndcg)), mrr10: average(values.map(value => value.mrr)),
        suppliedPoolRecall: average(values.map(value => value.recall)), oracleNdcg10: average(values.map(value => value.oracleNdcg)) }];
    }));
    const comparisons = arms.slice(1).map(arm => ({ baseline: arms[0], treatment: arm,
      ...pairedNdcg(cases.filter(item => Object.hasOwn(item.rankings, arms[0]!) && Object.hasOwn(item.rankings, arm)), arms[0]!, arm) }));
    return { split, metrics, comparisons };
  });
  console.log(JSON.stringify({ kind: corpus.kind, warning: corpus.kind === "synthetic" ? "Smoke fixtures only: rankings are invented, not observed JEV gains." : "Recorded inputs: verify human labels, provenance and frozen splits separately.",
    note: "Recall/oracle use every ID supplied for an arm; provide the full candidate pool, not just the displayed top 30. No-answer queries are counted separately.", report }, null, 2));
}
void main().catch(() => { console.error("Offline rerank evaluation failed: check the file, grades, identities and split/arm coverage."); process.exitCode = 1; });
