# Context-aware JEV evidence: implementation and evaluation

## Implemented in this PR

JEV continues to rank notes. The evidence selector now preserves complete retrieved passages, prioritizes up to three strongest distinct matches, and optionally adds bounded context from the exact indexed snapshot. Standard mode tries immediate same-heading neighbours; Late first tries a fitting contiguous same-heading section, then nearby source passages. Whole-short-note selection is separately optional and off by default. Overlaps are deduplicated, gaps and evidence roles are explicit, and stronger matches take budget priority.

Source use is checked against the ordered manifest passage IDs and canonical-body SHA-256. The source is local Weaviate data, never unverified live Markdown. Cancellation, source errors, evidence overflow and API failure retain the existing privacy/fallback behavior. Old prefix-only settings require renewed enablement after migration.

See [setup and precise limits](jev-reranking.md). These are implemented heuristics, **not benchmark-selected optimal settings**.

## Boundaries, embeddings, and evidence are separate

Paragraph/section boundaries decide what text a passage contains. Standard versus Late decides how its embedding is computed. Evidence policy decides what actual text the reranker receives. Paragraph chunking and Late chunking are not opposites: the same source spans can use either embedding strategy.

The existing chunker packs adjacent structural units within a section, so a stored passage can contain several paragraphs. Jina Late uses this plugin's 3,584-token embedding windows. Those are local-model tokens, not JEV tokens. Late enriches the vectors with surrounding information without rewriting the stored text. A passage beginning with an unresolved pronoun can therefore retrieve well yet confuse a text-only reranker unless relevant surrounding source is supplied.

The current bounded-context implementation addresses some of that evidence loss. It cannot restore information farther away than its selected windows, and does not recreate the exact original embedding context. It is preferable to claiming that a vector's context is automatically available to JEV.

## Deliberately not claimed as complete

**Exact JEV token budgeting:** The earlier OpenRouter card listed 32,000 tokens for JEV 1.13/latest. A JEV-matched tokenizer, native framing rules or supported preflight counter has not been validated. The implemented 24,000-byte serialized-JSON cap remains a conservative input limit, not an exact token count or proof of fit. Outcome diagnostics accept actual post-call usage; they do not infer tokens from bytes. Provider rejection safely falls back without truncating and retrying.

Before expanding requests further, establish official token accounting, version it against the resolved model, and budget the whole request: state, every candidate, query, questions and framing. Reserve margin rather than targeting full context. A tentative 24,000-**counted-token** target would require that validation; it is not the implemented 24,000-**byte** policy. Do not use Jina/MiniLM/Granite counts or an English characters/4 estimate.

**Exact Late embedding windows:** Persist verified segment boundaries with the index and its source snapshot before offering original-window evidence. Do not guess from line numbers or rerun a potentially different chunker. This PR deliberately avoids an index-schema migration just for heuristic context selection.

**Query-anchored subwindows for an oversized strongest passage:** The current safe behavior is a complete-query hybrid fallback. A future subwindow strategy needs explicit anchoring/evaluation rather than reinstating arbitrary prefix cuts. Lower-ranked matches can be omitted with visible counts; the strongest match is never silently discarded.

**A universal best ranking strategy:** No measured relevance improvement is claimed. One Noul question currently judges the note's combined evidence. Independent passage/window scoring with max aggregation is a useful ablation for precise lookups, but gives notes with more scoring opportunities an advantage. Means can dilute a strong match, and synthesis queries may require evidence from several passages jointly. Compare before choosing another default.

## Evaluation plan

Use two experiments:

1. Hold retrieved candidates fixed to isolate reranking evidence policy.
2. Run complete retrieval plus reranking to measure the actual Standard/Late combination.

Compare original hybrid order; the prior prefix baseline; complete matched passages; bounded-context evidence; and optional whole-short-note evidence. Evaluate original-window evidence only after verified boundaries exist. Keep per-note and total request budgets comparable and use held-out queries with note-level relevance labels.

Include targeted lookup, multi-passage synthesis, pronoun/definition dependencies, long notes, window seams and multilingual text. Measure nDCG@10, MRR, candidate recall/coverage, latency percentiles, request/token cost, omitted-evidence frequency and timeout/fallback rate. Count fallback results too instead of reporting only successful reranks. Record model/version and policy settings; do not log real note text or credentials by default.

Additional context is not automatically useful: complete matches avoid arbitrary evidence loss, but irrelevant surrounding text can dilute a decision and increase cost. The initial Standard/Late radii and byte budgets are tunable hypotheses, not recommendations supported by benchmark results.

## References

- [TypeSafe quickstart](https://docs.typesafe.ai/introduction/quickstart): state/questions and native decisions.
- [Official TypeSafe SDK types](https://github.com/typesafe-ai/typesafe-sdk-js/blob/66880ccded6cb642dc1809620c2b108c33730214/src/types.ts): post-request token usage and current request shape.
- [OpenRouter JEV 1.13 model card](https://openrouter.ai/typesafe/jev-1.13/api): source of the earlier context-limit observation; latest alias is mutable.
- [Jina Late Chunking](https://jina.ai/news/late-chunking-in-long-context-embedding-models/): contextual token representations versus pooling boundaries.
- [Repository README](../README.md): actual local embedding modes and runtime window size.
