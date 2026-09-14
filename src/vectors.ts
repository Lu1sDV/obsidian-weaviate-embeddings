import { DEFAULT_MODEL } from "./embedding-config";

export function aggregateVectors(vectors: readonly number[][], dimensions = DEFAULT_MODEL.dimensions): number[] {
  if (vectors.length === 0) throw new Error("Cannot aggregate zero vectors");
  const sum = new Array<number>(dimensions).fill(0);
  for (const vector of vectors) {
    if (vector.length !== dimensions) throw new Error("Segment vector dimensions do not match the active model");
    for (let index = 0; index < dimensions; index += 1) sum[index] = sum[index]! + vector[index]!;
  }
  const norm = Math.sqrt(sum.reduce((total, value) => total + value * value, 0));
  if (!Number.isFinite(norm) || norm === 0) throw new Error("Segment vectors have an invalid aggregate");
  return sum.map((value) => value / norm);
}

/** Mean-pool raw token states, then normalize once; never normalize individual tokens. */
export function poolTokenRange(data: ArrayLike<number | bigint>, dimensions: number, start: number, end: number, mask?: ArrayLike<number | bigint>): number[] {
  const tokens = data.length / dimensions;
  if (!Number.isSafeInteger(dimensions) || dimensions < 1 || !Number.isSafeInteger(tokens) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > tokens || (mask && mask.length !== tokens)) throw new Error("Invalid hidden-state pooling range");
  const vector = new Array<number>(dimensions).fill(0);
  let weight = 0;
  for (let token = start; token < end; token += 1) {
    const active = mask ? Number(mask[token]) : 1;
    if (active !== 0 && active !== 1) throw new Error("Tokenizer returned an invalid attention mask");
    if (!active) continue;
    weight += 1;
    const offset = token * dimensions;
    for (let index = 0; index < dimensions; index += 1) vector[index] = vector[index]! + Number(data[offset + index]);
  }
  if (weight === 0) throw new Error("Cannot pool an empty token range");
  let squaredNorm = 0;
  for (let index = 0; index < dimensions; index += 1) {
    const value = vector[index]! / weight;
    if (!Number.isFinite(value)) throw new Error("Model returned a non-finite pooled vector");
    vector[index] = value;
    squaredNorm += value * value;
  }
  const norm = Math.sqrt(squaredNorm);
  if (!Number.isFinite(norm) || norm === 0) throw new Error("Model returned an invalid pooled vector norm");
  for (let index = 0; index < dimensions; index += 1) vector[index] = vector[index]! / norm;
  return vector;
}
