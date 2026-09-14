# Structure-aware passages and optional late chunking

Status: implemented and verified in the disposable Standard/Late WebGPU benchmark; see the experiment report outside the repository.

## Decisions and scope

- One active indexing mode per vault: `standard` or `late`. Standard is the default.
- Late is supported only for the pinned Jina v2 Small profile: `jinaai/jina-embeddings-v2-small-en`, served by `Xenova/jina-embeddings-v2-small-en` at revision `523cadcb9c2e71c7153fc46016e1fe79acb4f58f`, fp32, 512 dimensions, 8,192 model positions, and a measured 3,584-token packaged runtime window.
- Adopt Markdown-structure-aware passage boundaries, inspired by Smart Connections, without importing its application stack, minimum-character exclusion, truncation, or parent/descendant loss optimizer.
- For a given model and input-policy version, Standard and Late use identical passage boundaries. Mode changes pooling and cache compatibility, not the retrieval units.
- Keep the existing paired Notes/Passages collections and index-generation lifecycle. No persistent side-by-side Standard/Late indexes, per-folder mode selection, multi-model search, new service, or automatic model switching.
- This specification adds no dependencies. Token alignment uses the installed tokenizer and verified token-ID sequences, not an assumed offsets API.

## Invariants

Original Markdown is never modified. Existing admission checks and mandatory exclusions run before preparation. Frontmatter remains filter metadata, never embedding input. Canonical input remains the existing title plus frontmatter-stripped body.

Successful preparation covers the complete canonical input with ordered, contiguous, non-overlapping source spans. No truncation, minimum-size omission, guessed token alignment, or partial publication is allowed. Existing byte, segment, request, and vector-validation limits remain enforced.

Exclusions and deletions revoke visible results immediately and preserve offline purge intent until all known generations have been reconciled. A different chunking policy never bypasses those checks.

## Structure-aware passage policy

### Structural units

Preparation is deterministic and independent of Obsidian APIs or DOM state. Extend the existing preparation module rather than adopting Smart Connections collections or its selection engine.

Recognize these structures while retaining original UTF-16 offsets and line endings:

- ATX headings at levels 1–6, including up to three leading spaces. Track heading ancestry; do not treat heading-like text inside fenced code as a heading.
- Paragraph runs separated by blank lines.
- Top-level unordered list items (`-`, `+`, `*`) and ordered items (`.` or `)` markers), with their indented continuations and nested items attached.
- Fenced code with backtick or tilde fences of at least three characters. A closer uses the same character and at least the opening length. Preserve an unterminated fence through end of input.

This is a bounded structural scanner, not a claim of complete CommonMark parsing. Other syntax, including setext-style headings, remains preserved content rather than being discarded or assigned unsupported structural semantics.

### Packing and splitting

1. Maintain heading ancestry as metadata. Reuse the existing `heading` field for a human-readable ancestry string; no separate hierarchy collection is introduced.
2. Treat a new heading as a semantic boundary. Attach a heading and intervening whitespace to the first content unit in that section when possible. A heading with no body remains meaningful content; it is not discarded merely because it is short.
3. Greedily pack adjacent units in source order within the same section and context window. Blank lines alone do not force separate passage vectors. A list item or fenced block remains intact whenever it fits the passage budget; packing never reorders content.
4. Keep the existing passage ceiling: `min(1024, model.contextLimit)` tokens, counting a passage's standalone special tokens. This allows the same passages to be embedded in Standard mode. Jina's corresponding content-token capacity is 1022.
5. Split an oversized structural unit losslessly. Prefer line boundaries, then whitespace boundaries; only then consider Unicode-safe character boundaries. Never split a surrogate pair. Validate the resulting spans with the actual tokenizer, not a characters-per-token estimate or a monotonic-token-count assumption.
6. An ordinary passage's pooling range belongs to one context window. A context-window seam can force a split even inside a large section, list item, or code fence; structural integrity is a preference, complete coverage and context limits are hard requirements.
7. Whitespace or tokenizer-erased fragments produce no independent passage vector. Attach their source spans to adjacent meaningful passages without allocating artificial content tokens. Such source-only extensions may cross a context seam; all actual pooling tokens still belong to exactly one window. Preserve these bytes for display and coverage validation.

For Jina, exact boundary validation below participates in this shared planner in both modes. Other models retain Standard-only preparation with exact standalone token limits.

## Context windows and note vectors

Retain the existing complete-note segmentation at each model's context limit, including special tokens, and its direct-versus-aggregated note-vector behavior. Windows are disjoint and never cross notes. There is no contextual overlap or replication of heading breadcrumbs into each window.

Structural passages are planned within these windows. Each nonempty content window is tokenized as its original complete text. In Late mode, one forward pass supplies both:

- The existing window/note vector, using the model's current pooling semantics. For Jina this includes attention-mask-active special-token positions, as today.
- Passage vectors, each obtained by mean-pooling its exact content-token range and then L2-normalizing it. Do not normalize each token before averaging.

Aggregate window note vectors using the existing `aggregateVectors` behavior; do not substitute a mean of passage vectors or introduce token-count weighting. Consequently, changing Standard to Late does not intentionally redesign note-to-note connections or graph geometry.

A window containing only tokenizer-erased source text has no passage pooling ranges. Its note-vector handling remains the existing model path; source text is attached as described above. Empty or non-finite pooled passage vectors are errors, never zero-vector substitutes.

## Exact token alignment without an offsets dependency

The installed `@huggingface/tokenizers` 0.1.3 and Transformers.js wrapper do not expose source offsets. Counting independently tokenized substrings is not enough: equal counts can still describe different token IDs.

Let `T(s)` be tokenization without automatically inserted special tokens for a context window's text `s`.

### Fast path

Tokenize the proposed passage partition without inserted special tokens and compare the concatenated IDs, element by element, with `T(windowText)`. Only if the complete sequences match may cumulative token lengths define passage token ranges. This is sequence verification, not a token-count heuristic.

Validate the model's actual forward-input IDs as well. For the pinned Jina tokenizer, the checked single-sequence template is `[CLS] + T(windowText) + [SEP]`, so content ranges are shifted by one position in the hidden-state tensor. Validate this template at preparation/inference rather than silently assuming it for arbitrary models. Literal special-token strings in source content are not removed merely because their IDs resemble inserted tokens.

### Unsafe boundary handling

If the fast path fails, verify candidate source boundary `b` against the complete window:

`T(windowText) == T(windowText.slice(0, b)) ++ T(windowText.slice(b))`

An equality establishes an exact token boundary at the prefix's token length. Prefer moving an unsafe cut to a preceding safe structural/whitespace boundary that respects the passage ceiling and makes progress; otherwise inspect subsequent allowed boundaries within the ceiling. Revalidate every resulting passage's standalone budget and complete contextual partition. Cache candidate encodings during preparation; avoid repeated prefix scans on the normal fast path.

Do not change the contextual input by concatenating independently encoded pieces that disagree with the complete-window encoding. Do not resolve mismatches by switching to Standard embeddings or silently reducing the context to isolated chunks.

If a compliant partition cannot be established within the existing preparation limits, fail preparation for the note with an explicit alignment error before any inference or snapshot write. This is a fail-closed boundary condition, not permission to omit the note silently. Pathological-input behavior must be exercised before release; the feasibility probe is not exhaustive proof of a finished splitter.

## Worker/client/indexer responsibilities

Keep tokenization, alignment, model execution, and tensor pooling inside the native worker. Keep admission, note identity, epoch checks, persistence, and database publication in the indexer.

Extend preparation with the per-window passage indices and exact local token ranges needed by Jina. Retain source spans separately from token ranges; decoded tokenizer text must never replace source text. The client validates identity, source coverage, index/range cardinality, and response limits.

Add a contextual-window worker operation rather than a monolithic entire-vault or entire-note inference request. Its input identifies the effective profile, one complete window, and the prepared passage ranges. Revalidate the window and ranges before forwarding. Its result contains the window note vector and indexed passage vectors, not the hidden-state tensor.

Process one window per request. This retains indexer cancellation/revision checks and opportunities for query requests between windows. Reuse the current serialized worker queue; add no inference concurrency. Dispose all input/output tensors in the existing `finally` path.

- Standard keeps the existing prepare/embed path and compatible passage-body reuse.
- Late uses the contextual-window operation and never supplies old passage-body vectors as a shortcut after a body change.
- The indexer assembles a complete paired note/passages snapshot only after all required vectors have passed validation.
- Runtime failures preserve the existing explicit failed-runtime behavior. No silent backend or strategy fallback is introduced.

Relevant boundaries: `embedding-preparation.ts`, `embedding-worker.ts`, `embeddings.ts`, `indexer.ts`, and the prepared-result types in `types.ts`.

## Compatibility, persistence, and migration

Persist `chunkingMode: "standard" | "late"`. Missing mode in existing state means Standard. Invalid mode values or an unsupported model/mode pair are explicit configuration errors. Switching away from Jina while Late is selected requires selecting Standard first; do not silently change either choice.

Derive an effective embedding profile from the model and mode. Continue using the existing `modelFingerprint` compatibility field, which already includes preprocessing policy. Its new identity must cover the model revision/dimensions/dtype, the shared structure-aware chunker version, mode, context-window policy, and note/passage pooling policies. Use the same effective identity in preparation, worker health, queries, stored vectors, manifests, cache admission, and search visibility checks. Avoid adding a second independently maintained fingerprint field.

The structure-aware policy changes Standard passage boundaries too. Existing input-v3 snapshots therefore require migration even when the user never enables Late. Detect that mismatch before schema writes or search serving; allocate a generation newer than all persisted known generations, retain purge obligations, persist migration state, and rebuild. Do not overwrite an old generation under a new fingerprint or preserve old vectors through the metadata-only shortcut.

Mode changes reuse the existing model-switch lifecycle: stop indexing, revoke visible results, drain queued work and reconciliation, allocate/persist a new generation, update the effective profile, and rebuild when indexing is enabled. A saved-but-disabled vault rebuilds when re-enabled. Changing mode does not require downloading a different model.

Search remains unavailable during this migration; zero-downtime switching is not promised. Keep old collections until every admitted note is compatible and committed and pending purges have completed. An interrupted or failed migration resumes the selected mode on restart; do not serve retained old collections as though they matched it.

Relevant boundaries: `embedding-config.ts`, `state.ts`, `types.ts`, `main.ts`, `services.ts`, and existing fingerprint checks in `weaviate.ts` and `search-view.ts`.

## Cache and retrieval behavior

| Event | Standard | Late |
| --- | --- | --- |
| Canonical text and effective policy unchanged; metadata changed | Reuse complete valid snapshot vectors | Reuse complete valid snapshot vectors |
| Canonical text changed | Preserve existing compatible independent-passage reuse | Re-embed every window of the note; surrounding context can affect unchanged passage text |
| Chunking/pooling/model policy changed | New generation and incompatible-cache rejection | New generation and incompatible-cache rejection |
| Snapshot incomplete/corrupt or pending purge | Regenerate/reconcile; never treat it as a cache | Same |

Queries remain ordinary model embeddings. Hybrid search still targets Passages, with the existing text/vector fusion and note grouping. Connections and graph edges still use Notes. Do not combine raw scores from Standard and Late generations.

## UI and operational behavior

Add one mode selector beside the existing model selector. Explain that Late is Jina-only, uses bounded context, and requires rebuilding. Show current migration/failure status through existing status surfaces. Unsupported choices must be visibly unavailable or rejected with an actionable reason.

No new overlap, target-size, per-folder policy, collection-management, or model-download settings are included. Window and passage policies are versioned implementation constants, not new user knobs.

Keep canonical-input coordinate meanings explicit. The new scanner must preserve existing prepared offsets/line conventions; do not silently relabel canonical positions as raw-file offsets. Source navigation behavior must be checked on notes with a synthetic title, frontmatter, CRLF, and Unicode before release.

## Evidence obtained during architecture

Only pinned tokenizer JSON/config assets were loaded; no embedding model was loaded and no GPU inference was run.

Using the installed JavaScript tokenizer with the pinned Jina assets:

- Checked ten partition examples covering paragraphs, CRLF, accents, combining characters, Greek/Turkish text, CJK, emoji, lists, fenced code, literal special-token strings, whitespace, and intentionally unsafe seams.
- Of fifteen proposed internal boundaries, twelve passed complete-ID equality and three were rejected.
- Splitting `embedding` as `embed` plus `ding` produced the same total token count but different token IDs. The equality check rejected it.
- Additional boundary examples rejected cuts inside literal `[MASK]` and across text joined by normalization of a control character; cuts after the complete lexical unit passed.
- Confirmed 1022 repeated content words yield 1024 tokens including inserted specials; 8190 yield 8192; 8191 yield 8193.

This establishes the feasibility of verified boundary mapping with the existing tokenizer. It does not prove retrieval quality, the complete structural planner, browser/worker integration, runtime memory use, or full-context inference performance.

The implementation benchmark later established a lower practical inference window than the tokenizer/model capacity: WebGPU succeeded at 3,584 tokens, failed at an exact 3,841-token boundary, and a real 3,822-token contextual input also failed; WASM failed by 5,000. The shipped effective profile therefore uses lossless 3,584-token windows and encodes that policy in its fingerprint.

## Required implementation verification

1. Structural coverage: headings/ancestry, multiple paragraphs, nested lists, both fence kinds, fence-contained apparent headings, empty sections, CRLF, Unicode, and oversized units. Preserve all source bytes and obey exact token limits.
2. Real-tokenizer alignment: equal-count/different-ID seams, special-token literals, normalization, empty-token fragments, exact passage/context limits, and unsafe-boundary repair or explicit failure. Ensure Standard/Late share boundaries for Jina.
3. Pooling: compare window and passage outputs against direct reductions of a known hidden-state tensor; verify range ownership, exclusion of inserted specials for passages, L2 normalization, and zero/non-finite errors.
4. Observable cache/migration behavior: surrounding-text change invalidates Late passage reuse; metadata-only changes do not; changed policy cannot reuse input-v3 snapshots; interrupted migration restarts safely; exclusions during inference prevent publication and preserve purges.
5. Actual packaged plugin in the disposable Obsidian vault: CPU/WASM Jina inference, multi-window notes, search, graph, mode switch, restart persistence, failed-switch recovery, and navigation. Do not run GPU smoke checks on this workstation without addressing the earlier user-reported crash.
6. Retrieval comparison using identical structure-aware chunks in Standard and Late: measure labeled passage retrieval, inspect contextual-reference queries, and report regressions as well as improvements. No guaranteed quality improvement is claimed.
7. Follow repository completion checks: typecheck and full test suite; production build for worker changes; package and exercise the real plugin for UI/runtime verification. Update affected existing tests and README behavior descriptions during implementation. Change manifest version only as a deliberate release decision.

## References and reuse boundary

- Smart Connections dependency manifest: https://github.com/brianpetro/obsidian-smart-connections/blob/main/package.json
- Shared Markdown parser: https://github.com/brianpetro/jsbrains/blob/ba80525b083cf515555cedbdc6294a2d0aa5da68/smart-blocks/parsers/markdown.js
- Current Obsidian selection policy: https://github.com/brianpetro/obsidian-smart-env/blob/9a49585fdd3f772873032979800011ea64994240/src/items/smart_source.js
- Obsidian integration license: https://github.com/brianpetro/obsidian-smart-env/blob/9a49585fdd3f772873032979800011ea64994240/LICENSE
- Late chunking reference: https://github.com/jina-ai/late-chunking

Borrow structural concepts, not the restricted integration implementation. The shared parser package declares MIT licensing, but that does not make the separate Obsidian selection layer MIT. No upstream code has been copied into this repository as part of this architecture task.
