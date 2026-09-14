import type { SearchResult, StoredNoteVector } from "./types";

export interface GraphNode {
  noteId: string;
  title: string;
  rank: number;
  anchor: boolean;
  x: number;
  y: number;
}

export interface GraphEdge { source: string; target: string; cosine: number }
export interface SimilarityGraphData { nodes: GraphNode[]; edges: GraphEdge[] }

function vectorNorm(vector: readonly number[], dimensions: number): number {
  if (!Number.isInteger(dimensions) || dimensions < 1 || vector.length !== dimensions) throw new Error("Wrong vector dimensions");
  let squaredNorm = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new Error("Nonfinite note vector");
    squaredNorm += value * value;
  }
  if (!(squaredNorm > 0) || !Number.isFinite(squaredNorm)) throw new Error("Invalid note vector norm");
  return Math.sqrt(squaredNorm);
}

export function cosineSimilarity(left: readonly number[], right: readonly number[], dimensions: number): number {
  const leftNorm = vectorNorm(left, dimensions), rightNorm = vectorNorm(right, dimensions);
  let dot = 0;
  for (let index = 0; index < dimensions; index++) dot += left[index]! * right[index]!;
  const similarity = dot / leftNorm / rightNorm;
  if (!Number.isFinite(similarity)) throw new Error("Invalid cosine similarity");
  return Math.max(-1, Math.min(1, similarity));
}

/** Preserve the retrieval ranking; admission removes entries, never changes scores. */
export function visibleResults(candidates: readonly SearchResult[], admitted: (result: SearchResult) => boolean): SearchResult[] {
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const result of candidates) {
    if (!Number.isFinite(result.score) || seen.has(result.noteId) || !admitted(result)) continue;
    seen.add(result.noteId);
    results.push(result);
    if (results.length === 30) break;
  }
  return results;
}

function graphNodes(
  results: readonly SearchResult[],
  anchor: Pick<SearchResult, "noteId" | "snapshotId" | "title"> | undefined,
): GraphNode[] {
  if (results.length > 30) throw new Error("Graph exceeds 30 listed notes");
  const members = anchor ? [anchor, ...results] : [...results];
  if (new Set(members.map((note) => note.noteId)).size !== members.length) throw new Error("Duplicate graph note");
  return members.map((member, index) => {
    const isAnchor = Boolean(anchor && index === 0);
    const rank = isAnchor ? 0 : index + (anchor ? 0 : 1);
    const position = rank - 1;
    const inner = position < 10;
    const ringIndex = inner ? position : position - 10;
    const count = inner ? Math.min(results.length, 10) : Math.max(1, results.length - 10);
    const angle = -Math.PI / 2 + ringIndex * 2 * Math.PI / count;
    const radius = results.length <= 10 ? 105 : inner ? 60 : 116;
    // ponytail: at most 31 nodes; rank rings are schematic, never a metric projection.
    return { noteId: member.noteId, title: member.title, rank, anchor: isAnchor,
      x: isAnchor ? 180 : 180 + Math.cos(angle) * radius,
      y: isAnchor ? 140 : 140 + Math.sin(angle) * radius };
  });
}

export function buildConnectionGraph(
  results: readonly SearchResult[],
  anchor: Pick<SearchResult, "noteId" | "snapshotId" | "title">,
): SimilarityGraphData {
  const nodes = graphNodes(results, anchor);
  const edges = results.map((result): GraphEdge => {
    if (!Number.isFinite(result.score) || result.score < -1 || result.score > 1) throw new Error("Invalid connection score");
    return { source: anchor.noteId, target: result.noteId, cosine: result.score };
  });
  return { nodes, edges };
}

export function buildSimilarityGraph(
  results: readonly SearchResult[],
  anchor: Pick<SearchResult, "noteId" | "snapshotId" | "title"> | undefined,
  stored: readonly StoredNoteVector[],
  dimensions: number,
): SimilarityGraphData {
  const nodes = graphNodes(results, anchor);
  const members = anchor ? [anchor, ...results] : [...results];
  const vectors = new Map<string, StoredNoteVector>();
  for (const item of stored) {
    if (vectors.has(item.noteId)) throw new Error("Duplicate stored vector");
    vectors.set(item.noteId, item);
  }
  if (vectors.size !== members.length) throw new Error("Graph vector membership mismatch");
  const validated = members.map((member) => {
    const item = vectors.get(member.noteId);
    if (!item || item.snapshotId !== member.snapshotId) throw new Error("Graph snapshot mismatch");
    return { vector: item.vector, norm: vectorNorm(item.vector, dimensions) };
  });
  const edges: GraphEdge[] = [];
  for (let left = 0; left < (anchor ? 1 : members.length); left++) {
    for (let right = left + 1; right < members.length; right++) {
      let dot = 0;
      const a = validated[left]!, b = validated[right]!;
      for (let index = 0; index < dimensions; index++) dot += a.vector[index]! * b.vector[index]!;
      edges.push({ source: members[left]!.noteId, target: members[right]!.noteId, cosine: Math.max(-1, Math.min(1, dot / a.norm / b.norm)) });
    }
  }
  return { nodes, edges };
}

export function edgesAboveCutoff(edges: readonly GraphEdge[], cutoff: number): GraphEdge[] {
  if (!Number.isFinite(cutoff) || cutoff < -1 || cutoff > 1) throw new Error("Invalid edge cutoff");
  return edges.filter((edge) => edge.cosine >= cutoff);
}
