# Context-aware JEV evidence: proposed strategy and evaluation

Status: **design proposal, not implemented evidence expansion**. The PR still sends only bounded matched-passage excerpts. Its lifecycle fixes do not widen the cloud-upload scope. Context information below was checked on 2026-09-21.

## Separate the three decisions

1. **Index boundaries** determine which raw text spans are passages (paragraphs, sections, or bounded splits).
2. **Embedding strategy** determines whether each passage is encoded independently (standard) or its token representations are pooled after processing a larger window (late).
3. **Reranking evidence** determines which actual text JEV sees for a retrieved candidate. JEV receives no vectors and cannot recover their contextual information.

Paragraph boundaries and late chunking are not opposites. The same paragraph spans can use either embedding strategy. This plugin's Jina late mode uses 3,584-token embedding windows, not arbitrary full-note context. Those token counts use the embedding tokenizer, not JEV's.

## Current behavior

Weaviate retrieves passages and groups them into notes by their best hybrid score. The UI keeps at most 30 admitted notes. For each note JEV receives its title and the **three highest-ranked matched passages**, not the first three paragraphs of the note. Bodies are prefix-truncated to 1,200 UTF-8 bytes; headings to 128 and titles to 256. It returns one relevance value for the note's combined evidence. Passages are not themselves reranked, no full note is read for JEV, and both embedding modes use this identical policy.

This is a useful baseline but can discard the text that made a hit relevant. In late mode, a passage such as "It was introduced in 2024" can have a relevant contextual embedding because an earlier paragraph names the subject, yet be ambiguous to a text-only reranker.

## Recommended next evidence policy

Keep **note-level ranking** to match the UI, but construct a bounded evidence pack anchored on retrieved passages. First preserve complete matched spans where they fit; avoid always taking an arbitrary prefix. Include title and heading ancestry. Deduplicate overlapping spans and preserve source order inside each context window. Bound the number of anchors and total evidence per note so long notes do not receive unlimited scoring opportunities.

For **standard/paragraph embeddings**, start with matched paragraphs plus their heading. Add a small adjacent window when needed for definitions, pronouns, lists, or section context. Even independently embedded paragraphs can be semantically incomplete.

For **late embeddings**, add actual surrounding text more deliberately. Prefer the matched passage with a clearly distinguished enclosing section or original embedding window when it fits. A previous/next-paragraph window is a bounded fallback, not a reconstruction of all context encoded by late chunking. Dependencies may be farther away or on either side. Exact embedding-window recovery requires persisting verified segment boundaries with the indexed snapshot; do not guess them from line numbers or rerun a possibly changed chunker.

For **short notes**, the complete canonical body may be a useful optional strategy if it fits that note's evidence budget. For long notes, use bounded anchored windows rather than uploading every note. Never include frontmatter, excluded content, or source from a different snapshot. Load expanded text only after admission, verify its identity before sending, and track it for immediate invalidation. Expanded uploads require an updated user-facing disclosure.

Retaining one note-level Noul question over that pack lets complementary passages jointly establish relevance. As an ablation, evaluate independent passage/window questions with a fixed maximum number per note and aggregate using the maximum for targeted lookups. Max aggregation can favor notes with more opportunities; means can penalize a single strong match surrounded by irrelevant text. Neither is an established universal best choice, especially for synthesis queries.

## Budget the whole request, not each note independently

OpenRouter currently advertises **32,000 context tokens** for JEV 1.13/latest. This is not 32,000 per candidate. Budget the query, titles/headings, all candidate text, questions, serialization/framing, and reserved overhead together. JEV's native Noul output is not a generated answer paragraph; do not invent a chat `max_tokens` control for this endpoint.

Before expanding evidence:

- Validate the actual JEV tokenizer or an official token-count service, and how native JSON/framing consumes context. Do not use Jina/MiniLM/Granite token counts or an English characters/4 rule.
- Establish a soft input target below the advertised limit (for example, 24,000 **counted tokens**, with the remaining capacity reserved), then dynamically pack candidates. This is a proposed token target, not the current 24,000-**byte** implementation cap.
- Allocate a bounded per-note evidence budget. When a batch would overflow, start a new request. When a note's evidence alone would overflow, shrink optional surrounding context first, then use explicit anchored subwindows or skip reranking with a visible fallback. Never silently drop a shortlisted note.
- Revalidate limits when changing the resolved model. The `~typesafe/jev-latest` alias can move; pin/record the model version for controlled experiments. Record token usage, batch count, truncation/expansion policy and timing without logging note text or keys.

The existing byte guard counts the entire escaped JSON body, which is better than counting text characters alone, but does not prove fit under an unverified tokenizer/internal framing. Keep it conservative in the meantime and retain all-or-nothing fallback for provider rejection. Full capacity is not a target: extra unrelated text adds cost and may hurt relevance.

## Evaluation before choosing a default

Use two complementary experiments. Hold retrieval candidates fixed to isolate the reranking evidence policy, then run end-to-end retrieval plus reranking to measure the actual standard-versus-late effect. Avoid attributing improved candidate recall to the reranker.

Compare: original hybrid order; current truncated matches; complete matched paragraphs; matched paragraphs plus bounded surrounding context; and whole short-note/original-window evidence where feasible. Use the same held-out queries, note-level relevance labels and per-note/request budgets. Evaluate targeted, multi-passage synthesis, pronoun/definition-dependent, long-note, window-seam and multilingual cases. Report nDCG@10, MRR, recall/coverage of the reranked shortlist, latency percentiles, request/token cost, truncation rate, and timeout/fallback rate.

No measured quality improvement or best default is claimed by this proposal. The first practical change to evaluate is preserving complete matched passages and restoring bounded source context for late-chunk hits, rather than simply raising the upload limit.

## Primary references

- [OpenRouter JEV 1.13 model card](https://openrouter.ai/typesafe/jev-1.13/api): 32,000-token context as checked on 2026-09-21.
- [OpenRouter TypeSafe family](https://openrouter.ai/typesafe): latest alias and context listing.
- [TypeSafe quickstart](https://docs.typesafe.ai/introduction/quickstart): native state/questions and typed decisions.
- [Jina: Late Chunking in Long-Context Embedding Models](https://jina.ai/news/late-chunking-in-long-context-embedding-models/): chunk boundaries versus context-conditioned representations.
- [Repository README](../README.md): actual plugin window size and implemented embedding modes.
