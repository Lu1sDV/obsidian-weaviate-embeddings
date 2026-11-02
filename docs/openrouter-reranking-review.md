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

Never relabel a hybrid score as cosine or overwrite cosine with relevance. Send source-to-candidate cosine only under an explicit field, retain it for display, and evaluate whether exposing it to the judge merely reinforces the first-stage ranking. An all-pairs graph matrix is a separate, quadratic input. See [`weaviate.ts`](../src/weaviate.ts), [`graph.ts`](../src/graph.ts), and [`types.ts`](../src/types.ts).

## Proposed evidence modes

**Recommendation: preserve the complete source target in both modes; shorten candidate notes only.** A passage target means exactly that selected passage. A note target means the complete canonical indexed note, with the existing frontmatter policy.

### Full candidate notes

Retrieve a ranked candidate pool, hydrate verified complete notes, and admit the largest leading prefix that fits the chosen model and operation limits. Do not silently skip an oversized high-ranked candidate to admit shorter lower-ranked notes.

If the source alone cannot fit, keep local results and offer a passage target or another model. If one source/candidate pair cannot fit, stop the full-note prefix there and report the effective K; offer excerpt mode. If no candidate fits, send nothing. Multiple requests can extend the prefix when the judging design allows them.

### Candidate excerpts

For each candidate:

1. Include its first substantive paragraph when it fits `introTokens`; otherwise use the first `introTokens` of canonical content.
2. Preserve matched chunks and add up to `contextTokens` **before and after each chunk**. This proposed setting is per side, not a total shared allowance.
3. Merge overlapping ranges, deduplicate the introduction, restore source order, and mark gaps. Include headings where useful.
4. Enforce a total per-note budget. Prioritize strongest complete matches, then introduction/context; disclose omitted anchors and shortened spans. If the strongest match cannot fit, report the limitation instead of disguising an arbitrary prefix as complete evidence.

The whole-note Connections query currently returns note-level hits without matched passages. It therefore needs additional passage retrieval inside each candidate before “surrounding our chunks” has a defined meaning. Selected-passage Connections also needs grouped evidence: its current display deduplicates flat hits to the first passage per note.

## Context accounting and maximum K

For a joint request, define:

`Kfit = max k ≤ Krequested such that tokens(serialize(source, candidates[0:k], questions, metadata)) + outputReserve + margin ≤ effectiveContext`.

Count all serialized fields, escaping/framing, repeated source text, rubrics, headings, and score metadata. Effective capacity must respect applicable model, serving-provider, input, output, transport, and full-text limits. A catalogue context size is not proof that a provider processes every submitted token.

There is currently **no validated exact tokenizer/accounting path for every supported model**. Existing estimates and byte caps remain guards, not an exact maximum-K guarantee. Use a supported tokenizer/preflight counter when established; otherwise label planning estimates and keep conservative margins.

For example, OpenRouter documents that **Clef and Clef Flash silently drop state text after roughly 2,000 tokens**, despite larger advertised contexts. They cannot support a claim of full-note coverage beyond that boundary. Jev's larger-context processing also has documented accuracy/latency tradeoffs. See [multimodal limits](https://openrouter.ai/docs/guides/community/multimodal-decisions#limits) and the [Jev guide](https://openrouter.ai/docs/guides/community/jev).

## Independent judgments or a joint list?

**Recommend independent Noul judgments per candidate**, sharing the complete source and fixed rubric. This preserves stable candidate evidence across batches and fits the current architecture. Each batch must fit; total K is then also bounded by cost, request count, and elapsed time. Equivalent singleton/packed behavior still needs measurement.

A joint list exposes every candidate and cosine to every judgment. In that design the formula above bounds the entire list; splitting it changes comparison context and requires a separate strategy for comparable scores. These approaches are not interchangeable, and Noul is a probability of satisfying a condition, not a calibrated cosine or universal relevance scale.

The existing 2.5-second remote deadline is unsuitable as an unmeasured promise for larger-note workloads. Before enabling either mode, measure completion coverage, latency, cost, and ranking quality; then select a bounded, cancellable latency policy. Preserve atomic publication and the local fallback.

## Proposed controls and three decisions

Expose source scope, Full notes / Excerpts, requested K, `introTokens`, and `contextTokens`, alongside on/off, manual Rerank, Cancel, and Use local ranking. Show requested/retrieved/actually judged/displayed counts separately, effective K, omitted candidates, truncated spans, estimated budget, reported usage, and served model. Never present the current 30-note display cap as the number judged.

1. **Should excerpt mode truncate candidates only, keeping the entire source note/passage intact?** Recommended: yes.
2. **Should each candidate be judged independently against the source, or should the model compare one joint list of candidates and cosines?** Recommended: independent judgments, with measured batching equivalence.
3. **For note-to-note relevance, should the judge favor useful related material, including complementary/contradictory notes, or mainly notes closely covering the same topic?** Recommended: useful related material, with a distinct rubric from question-answer retrieval.
