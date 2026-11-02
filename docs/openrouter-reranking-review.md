# OpenRouter reranking: review and proposed next stage

Review date: 2026-11-02. **The integration/settings/sidebar changes below are implemented in this review branch. Whole-note and passage Connections reranking, including the two proposed evidence modes, remain unimplemented.**

## Baseline and findings

The audit starts from `feat/jev-reranking-hardening` at [`46bdfdb`](https://github.com/Lu1sDV/obsidian-weaviate-embeddings/commit/46bdfdbfd84027fe81f27e795c7fe40412483781). The inspected `master` at `3c4e317` has no JEV implementation; [PR #1](https://github.com/Lu1sDV/obsidian-weaviate-embeddings/pull/1) and [PR #2](https://github.com/Lu1sDV/obsidian-weaviate-embeddings/pull/2) were unmerged. Their different implementations should not be mistaken for the current hardened branch.

The baseline supports manual Search reranking with one bounded passage per candidate, or two experimentally. It does not send the whole source note, hydrate full candidate notes, or transmit cosine values. Its model choices were pinned to Jev 1.13 through OpenRouter or direct TypeSafe. See [`evidence.ts`](../src/rerank/evidence.ts), [`systemone.ts`](../src/rerank/systemone.ts), and [`search-view.ts`](../src/search-view.ts).

## Changes implemented

- **OpenRouter only, with a user-entered model.** The request uses `POST /api/alpha/decisions`. Validation loads the Decisions catalogue, resolves aliases, checks text/decision capabilities and reported limits, then tests the real request shape with synthetic arithmetic. Catalogue presence alone does not validate the integration. Incompatible specialised-state models are rejected. Validation expires after model/key changes, a new plugin session, or 24 hours. See [`model-catalog.ts`](../src/rerank/model-catalog.ts), [`model-registry.ts`](../src/rerank/model-registry.ts), and [`settings.ts`](../src/rerank/settings.ts).
- **Response compatibility.** The parser accepts supported serving identities from validation, optional upstream-provider metadata, and additional answer metadata while still requiring complete matching question IDs and finite Noul values in `[0,1]`. Duplicate JSON keys, invalid usage, and incompatible serving changes remain failures. See [`systemone.ts`](../src/rerank/systemone.ts).
- **Sidebar controls.** Search has on/off, manual Rerank, Cancel while running, and restoration of local order. Enabling sends nothing. Missing model validation gives setup guidance.
- **Index-update bug fixed.** Unrelated publications previously aborted even a current request. They now coalesce and wait while a valid manual ranking is running, ready, or displayed. Candidate edits and query changes still invalidate immediately. Eight actual-view regressions cover this behavior in [`search-rerank-view.test.ts`](../tests/search-rerank-view.test.ts).

The [Models API](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties) defaults to text output; use `output_modalities=decisions`. The [Decisions reference](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request) and [Jev guide](https://openrouter.ai/docs/guides/community/jev) establish the typed request contract. These are decision models, so a generic chat-model ID is insufficient.

Offline tests establish implementation behavior. They do not establish live account availability, interactive Obsidian behavior, ranking quality, or complete-document reading.

## Proposed target and score contracts

Represent the source explicitly:

```ts
type QueryTarget =
  | { kind: "search"; text: string }
  | { kind: "note"; snapshot: SnapshotIdentity; text: string }
  | { kind: "passage"; snapshot: SnapshotIdentity; passageId: string; text: string };
```

`SnapshotIdentity` is proposed local provenance, not an outbound path. Source text and candidate text must come from the verified indexed snapshot. Authorize the source as well as candidates, and bind cancellation/cache identity to both.

Keep these values separate:

| Value | Meaning |
| --- | --- |
| Retrieval score and rank | Original local ordering; Search currently uses hybrid relative-score fusion |
| Source-to-candidate cosine | Genuine similarity from compatible embeddings, with the compared note/passage scope recorded |
| Graph-edge cosine | Candidate-to-candidate note similarity in Search; not query similarity |
| Reranker relevance | Model judgment under a versioned relevance rubric |

Cosine is used for local candidate retrieval and remains visible in the results. **Do not include cosine values or retrieval ranks in the judge's input, and do not blend them with reranker relevance.** Sort by the returned relevance; exact ties retain stable input order. Hybrid score, source cosine and graph-edge cosine keep their separate labels. See [`weaviate.ts`](../src/weaviate.ts), [`graph.ts`](../src/graph.ts), and [`types.ts`](../src/types.ts).

## Decisions clarified on 2026-11-02

- One reranking API request per user action. If the payload is too large, shorten evidence locally or reduce the candidate prefix before dispatch. No overflow batches or automatic second inference attempt.
- Ranking uses model relevance alone; original cosine remains visible and stays outside model input.
- Oversized whole notes may lose context deliberately. Prefer substantive beginning/end material and relevant or representative interior windows, with visible shortening information.
- Passage targets use the selected/matched chunk and its surrounding context.
- Remove image destinations/embeds from outbound text while preserving useful textual descriptions where available.
- Context should be larger than the earlier 256-token suggestion and may adapt to available request space. Numerical defaults below remain recommendations to evaluate.

## Recommended evidence policies

**Adaptive context should be the default.** Send complete cleaned text when it fits; otherwise select extracts locally. Keep an optional **Complete text only** policy for cases where omission is unacceptable. Both policies use one request. The scope of the source (whole note or selected passage) is independent of the evidence policy.

In Complete text only, reduce the leading candidate prefix until source, candidates and request structure fit. If even one complete comparison does not fit, retain local results and explain the limitation. Do not silently switch to excerpts.

In Adaptive context, preserve candidate breadth until meaningful evidence no longer fits, then reduce K from the tail and replan. Do not skip long high-ranked notes merely to admit smaller lower-ranked notes. A minimum token allowance is a planning heuristic, not a guarantee that an excerpt is informative.

### Whole-note source

Preserve the full source when affordable alongside useful evidence for the candidates. Otherwise select a common source excerpt containing the title, substantive introduction/conclusion and representative interior sections. Freeze that source representation before judging candidates: every question must use the same source.

Candidate-specific excerpts must not redefine the source. Selecting all source content solely because it resembles the first-stage hits could erase other topics the whole-note search is intended to cover. Prefer source anchors when reliable retrieval provenance exists and otherwise cover distinct headings/sections. A literal middle window is a fallback for unstructured notes, not the meaning of “central.”

### Whole-note candidates

For an oversized candidate, allocate most text to relevant interior matches with surrounding context, plus smaller opening and ending extracts. Use complete short notes whenever possible.

“Beginning” means substantive introductory content, after frontmatter, banners or a table of contents. “End” means substantive final material, not automatically a bibliography or attachment list. Such sections remain eligible when they contain the relevant match.

The whole-note Connections query currently returns note-level hits without matched passages. It therefore needs a local passage-evidence retrieval step inside each candidate. Selected-passage Connections likewise needs grouped evidence instead of its current strongest-per-note display projection.

### Passage targets and evidence

Prioritize the complete selected source passage, then nearby context under its heading. Mark the selected passage separately from contextual text. If even the selected source passage cannot fit, ask the user to narrow that selection instead of silently substituting another target.

For candidate evidence, prioritize the matched chunk and grow the surrounding window. The note's opening/ending should not consume this budget unless relevant. An oversized candidate chunk may be shortened to a relevant internal span in Adaptive context; mark that explicitly.

### Extract construction

1. Parse Markdown structure and remove image payloads/destinations before token planning.
2. Identify protected anchors and substantive boundary paragraphs.
3. Allocate the strongest distinct matching or representative windows first; expand into neighboring paragraphs while budget remains.
4. Merge overlaps, deduplicate reused introductory/final text, and restore original source order.
5. Retain heading ancestry, essential table headers, list parents and quotation boundaries. Prefer paragraph/sentence cuts; preserve Unicode and label unavoidable cuts.
6. Mark omitted ranges. Do not present concatenated disjoint text as an uninterrupted quotation.

Selection priority and presentation order are different. An interior match may receive most of the budget but still appears after the introduction in the payload.

## Markdown and image handling

Use a structure-aware projection, not a broad regular expression over raw Markdown.

- Remove actual Markdown image destinations, reference-image definitions no longer used, Obsidian image embeds and HTML image targets. Retain meaningful alt text/captions; omit generic filenames, dimensions and base64/data payloads.
- Preserve image-looking syntax inside code or escaped Markdown as literal note content.
- Ordinary links/wikilinks may retain readable labels; no destination fetching is required. Do not indiscriminately delete ordinary URLs that are themselves relevant information.
- Do not expand note transclusions, linked notes, attachments, OCR or remote media. A retained reference label must not imply the referenced content was read.
- Leave stored notes, embedding text and index generations unchanged. This projection is for outbound reranking evidence; keep provenance back to the indexed source spans.

## One request and a model-aware total budget

Let B be the smaller of the user's total request cap and a conservative usable model limit. Reserve instructions, question framing, applicable output/framing allowance and safety headroom. Check both per-request and per-question limits where applicable.

Budget the exact proposed payload, including all question rubrics and serialized structure. With an established tokenizer/accounting contract, enforce the token cap directly. Without one, display an estimate and retain conservative byte/provider guards; do not promise exact maximum-fitting K or universal full-text coverage.

OpenRouter documents that **Clef and Clef Flash silently drop state text after roughly 2,000 tokens**, despite larger advertised contexts. Jev also has distinct long-context behavior. See [provider limits](https://openrouter.ai/docs/guides/community/multimodal-decisions#limits), the [Jev guide](https://openrouter.ai/docs/guides/community/jev), and [TypeSafe context limits](https://docs.typesafe.ai/models).

### Allocation procedure

1. Start with the desired candidate prefix in local retrieval order.
2. Protect a useful evidence minimum per candidate and enough source context to define the task.
3. Preserve the entire source if it fits alongside those minimums; otherwise construct the common source excerpt.
4. Allocate remaining capacity approximately evenly across candidates, returning unused allocations from short notes to the pool. Do not give higher-cosine candidates systematically more text.
5. Expand context toward complete content where possible. Reduce optional surroundings before losing strong anchors or coherent source coverage.
6. If useful comparisons still do not fit, reduce K from the tail and recompute allocations locally.
7. Serialize, verify limits, and dispatch once. An API rejection/failure retains the local ranking; it does not trigger a hidden smaller request.

Dynamic context depends on the usable model limit, user cap, source length, candidate count and actual note lengths. Model context alone is insufficient. Multiple anchors must share a total per-candidate budget so per-side settings cannot multiply request size unexpectedly.

### Proposed initial defaults, not measured optimums

| Setting | Recommendation |
| --- | --- |
| Context allocation | Auto |
| Total request cap | 64,000 tokens, further reduced by model/provider limits and headroom |
| Desired candidates | 30; larger user values remain bounded by the same single-request budget |
| Preferred surrounding context | 512 tokens per side, up from the earlier 256 suggestion |
| Auto expansion ceiling | 2,048 tokens per side, still sharing the per-candidate and total budgets |
| Candidate evidence floor | About 512 tokens when the note is long enough, adjusted for a useful anchor |
| Preferred whole-note evidence | About 2,000 tokens per candidate; complete short notes use less |
| Oversized source starting allocation | About 20–25% of available evidence space; redistribute according to actual lengths |

Opening/end/interior ratios are flexible. As a starting policy for an oversized candidate, spend roughly 15% on the beginning, 15% on the ending and 70% on relevant interior evidence. Overlap and short/missing sections return space to other useful spans. Source notes require section coverage rather than mechanically applying candidate relevance selection.

## Independent judgments in a single request

Recommend **one shared source plus one independent Noul question per candidate, all inside the same API request**. Independent judging does not require separate network requests. Each candidate's evidence is attached to its question; cosine/rank are excluded from the payload. Use a fixed rubric for useful related material, including complementary evidence or substantive contradictions, rather than only duplicate subject coverage.

A joint comparative list remains a different design: adding/removing a candidate can change the context for every judgment. It is unnecessary for the clarified single-request requirement. No additional summarization model call is needed; extraction is local and uses original text.

Cache reuse must bind the exact cleaned/shortened source, candidate evidence, model, rubric and policy. Changing K or budget may change extracts and therefore invalidate cached judgments. Singleton/packed equivalence across models still needs measurement; an API request containing multiple questions is not itself a guarantee of statistically independent outputs.

## Controls and observable coverage

Keep the normal controls small: manual on/off, Rerank/Cancel/Use local ranking, desired candidates, and Context: Auto. Put total request cap, custom per-side context and Complete text only in advanced settings.

Show factual outcome counts, for example: “30 notes reranked in one request; source shortened; 18 complete candidate texts and 12 excerpts.” Display actual selected source/anchor counts and an expandable evidence preview. A text-coverage percentage is not a percentage of meaning preserved. Keep original cosine visible alongside model relevance without blending them.

The existing 2.5-second deadline needs a measured replacement for longer inputs. Preserve cancellation, atomic publication and the local fallback. Evaluate long sources, answer-bearing endings/interiors, multilingual notes, large code/tables, many short candidates and a few very long candidates. These recommendations specify the next implementation; this branch's runtime still implements the earlier bounded Search reranker.
