/** Offline metrics over frozen, explicitly graded note identities. No network or vault reads. */
export interface EvaluationCase {
  id: string; family: string; split: "dev" | "test";
  grades: Record<string, number>;
  rankings: Record<string, string[]>;
}
export interface RankingMetrics { ndcg: number | null; mrr: number | null; recall: number | null; oracleNdcg: number | null }
export function rankingMetrics(ranking: readonly string[], grades: Readonly<Record<string, number>>, k = 10): RankingMetrics {
  if (!Number.isSafeInteger(k) || k < 1 || new Set(ranking).size !== ranking.length
    || ranking.some(id => !Object.hasOwn(grades, id)) || Object.values(grades).some(grade => !Number.isInteger(grade) || grade < 0 || grade > 3)) throw new Error("Invalid frozen ranking or relevance grades");
  const positives = Object.values(grades).filter(grade => grade > 0).length;
  if (!positives) return { ndcg: null, mrr: null, recall: null, oracleNdcg: null };
  const dcg = (values: readonly number[]) => values.slice(0, k).reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
  const ideal = dcg(Object.values(grades).sort((a, b) => b - a));
  const actual = ranking.map(id => grades[id]!);
  const first = actual.slice(0, k).findIndex(grade => grade > 0);
  return { ndcg: dcg(actual) / ideal, mrr: first < 0 ? 0 : 1 / (first + 1),
    recall: actual.filter(grade => grade > 0).length / positives, oracleNdcg: dcg([...actual].sort((a, b) => b - a)) / ideal };
}

export function readEvaluation(raw: unknown): { kind: "synthetic" | "recorded"; cases: EvaluationCase[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid evaluation file");
  const data = raw as { kind?: unknown; cases?: unknown };
  if ((data.kind !== "synthetic" && data.kind !== "recorded") || !Array.isArray(data.cases) || !data.cases.length || data.cases.length > 10_000) throw new Error("Invalid evaluation corpus");
  const ids = new Set<string>();
  const families = new Map<string, string>();
  const cases = data.cases.map((value: unknown): EvaluationCase => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid evaluation case");
    const item = value as Partial<EvaluationCase>;
    if (typeof item.id !== "string" || !item.id || ids.has(item.id) || typeof item.family !== "string" || !item.family
      || (item.split !== "dev" && item.split !== "test") || !item.grades || Array.isArray(item.grades) || typeof item.grades !== "object"
      || !item.rankings || Array.isArray(item.rankings) || typeof item.rankings !== "object" || !Object.keys(item.rankings).length) throw new Error("Invalid evaluation case");
    if (families.has(item.family) && families.get(item.family) !== item.split) throw new Error("A query family crosses development/test splits");
    families.set(item.family, item.split); ids.add(item.id);
    for (const ranking of Object.values(item.rankings)) {
      if (!Array.isArray(ranking) || ranking.some(id => typeof id !== "string")) throw new Error("Invalid evaluation ranking");
      rankingMetrics(ranking, item.grades);
    }
    return { id: item.id, family: item.family, split: item.split, grades: item.grades, rankings: item.rankings };
  });
  return { kind: data.kind, cases };
}

/** Deterministic paired cluster bootstrap by query family; not a quality claim about synthetic data. */
export function pairedNdcg(cases: readonly EvaluationCase[], baseline: string, treatment: string): { queries: number; delta: number | null; interval95: [number, number] | null } {
  const groups = new Map<string, number[]>();
  for (const item of cases) {
    if (!Object.hasOwn(item.rankings, baseline) || !Object.hasOwn(item.rankings, treatment)) throw new Error("Missing comparison arm");
    const before = rankingMetrics(item.rankings[baseline]!, item.grades).ndcg;
    const after = rankingMetrics(item.rankings[treatment]!, item.grades).ndcg;
    if (before === null || after === null) continue;
    const group = groups.get(item.family) ?? []; group.push(after - before); groups.set(item.family, group);
  }
  const clusters = [...groups.values()], values = clusters.flat();
  if (!values.length) return { queries: 0, delta: null, interval95: null };
  const mean = (numbers: number[]) => numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
  if (clusters.length < 2) return { queries: values.length, delta: mean(values), interval95: null };
  let seed = 17;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const samples = Array.from({ length: 2000 }, () => mean(Array.from({ length: clusters.length }, () => clusters[Math.floor(random() * clusters.length)]!).flat())).sort((a, b) => a - b);
  return { queries: values.length, delta: mean(values), interval95: [samples[49]!, samples[1949]!] };
}
