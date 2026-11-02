# Single-request System One reranking

Implemented on the OpenRouter review branch, based on `c162b1e` (with a temporary CI bootstrap at `4c8fa80`). No embedding profile, vector schema, chunking policy or index-generation changes are required.

## Setup and controls

Save an OpenRouter key, enter a text-capable Decisions model ID, and select **Save & validate**. The authenticated paginated catalogue resolves aliases/canonical serving identities and rejects incompatible specialised-state models. One synthetic arithmetic inference checks the runtime source/candidate/Noul wire shape; it sends no vault content and may incur a small charge. Approval is session-local, expires after 24 hours, and is bound to model and credential revisions. A catalogue check alone never enables reranking.

Explicitly grant source/candidate upload permission and turn manual reranking on. Search and Connections share sidebar controls: on/off, Rerank/Cancel/Use local ranking, candidate count and Adaptive/Complete notes policy. Enabling, typing, opening a note and automatic local refresh never initiate inference. Settings expose Auto/manual context, per-side context and total nominal token cap. Invalid numeric values cannot bypass limits.

The model, credential and policy changes invalidate affected work and cached judgments. Changing models resets consent. Format-v1/v2 settings migrate to v3 disabled, with fresh expanded-disclosure consent required. The saved OpenRouter key is retained; direct-provider credentials are never reused for OpenRouter.

## Source and evidence contracts

A source is a typed query, a whole indexed note, or a selected indexed passage. `src/rerank/documents.ts` verifies hydrated evidence before remote work. A fresh Markdown read must reproduce the indexed canonical body SHA-256. Stored note/snapshot/path identity, ordered manifest passage IDs, offsets and exact source slices must agree. The existing `loadSnapshot()` validates generation, model fingerprint and vectors. Fresh raw frontmatter is also checked against the stored normalized metadata and disclosure policy, because Obsidian's metadata cache can lag an edit. File modification stamps and current manifest/admission checks surround asynchronous boundaries.

There is a 4 MiB source-document bound, 32 MiB aggregate hydration bound and bounded parser work/line/segment counts. Excessive or corrupt inputs retain local results rather than uploading unverified material. No text is read from linked destinations. A local database read already underway can finish after cancellation, but cannot dispatch remote work or publish results.

For whole-note Connections, the source's stored note vector is compared locally with each candidate's stored passage vectors. Selected-passage Connections uses its stored passage vector. Search preserves retrieved passage anchors. Same-note passage hits are grouped before evidence selection, rather than discarded by the ordinary display projection. No new embedding call or retrieval-score upload is needed.

### Adaptive context

Complete cleaned short notes are preserved when useful within the budget. Oversized whole-note candidates prioritize strongest distinct interior matches plus substantive introduction/final content, nominally 70/15/15 with unused/overlapping allowance redistributed. An oversized whole-note source covers representative sections; it is not redefined separately for each candidate. All questions use the exact same source representation.

Passage mode protects the complete selected source passage and labels focus versus context. Surrounding windows grow within the relevant heading scope. If that selected passage cannot fit, no inference is sent; select a smaller passage or change the model/budget. Candidate chunks may be shortened explicitly. Whole-note opening/end text is not added automatically to passage-mode evidence.

Overlapping ranges merge and remain in source order. Omitted ranges, partial fragments, headings and text format are represented explicitly. Partial tables retain header rows, nested list extracts retain relevant parents, and code indentation is preserved. The focus passage remains separate from explanatory surroundings.

### Complete notes only

The planner takes the largest leading candidate prefix that fits its conservative serialized guards without shortening whole notes. It never skips a large high-ranked candidate to admit shorter lower-ranked notes. If no complete comparison fits, local results remain. A passage target remains the selected passage plus bounded context, not an implicit change to the whole source note.

### Markdown projection

`markdown.ts` is a bounded non-rendering structural scanner, not an HTML renderer or a claim of complete CommonMark/Obsidian syntax parity. It protects fenced, indented and inline code and escaped syntax; removes real Markdown/HTML image targets, image-only reference definitions (including continuations), Obsidian embeds, SVG and data-image payloads outside code; and preserves meaningful textual descriptions. Ordinary text links retain their labels and relevant URLs. Attachments/transclusions are not expanded. Exotic unsupported syntax should be examined in the local evidence preview; provider disclosure permission still covers the supplied text.

The projection changes only outbound evidence. Stored Markdown, embedding inputs, index identities and source coordinates remain unchanged. Cleaned offsets map back to the verified source ranges.

## Exactly one runtime inference

`RerankService.run()` builds the entire plan before dispatch and contains one `provider.evaluate()` call. A request has shared `state.source` and one typed Noul question per candidate. No cosine, local score/rank, note ID, snapshot ID or path is inserted into that wire representation. Text may itself contain identifying information; minimization is not anonymization.

There are no overflow batches, automatic retry, secondary summarization call or hidden fallback model. A complete exact cached cohort can avoid inference entirely; partial cache hits do not mix judgments from different comparison contexts. All returned question IDs, Noul values, serving identity and usage must validate before publication. Zero is a valid relevance value; missing/invalid responses are not converted to zero.

Synthetic model validation uses the same planner and wire shape. The optional developer command `OPENROUTER_MODEL=author/model OPENROUTER_API_KEY=... npm run test:jev-contract` performs catalogue reads and **one** synthetic multi-candidate inference with that shape. It never reads a vault. Older singleton/packing helpers remain only as regression/reference utilities; the runtime service and probe do not invoke their batch planner.

## Budgeting

Defaults: 30 requested candidates (1–60), 30 maximum displayed results, Adaptive context, nominal 64,000-token request cap, Auto context and preferred 512 tokens per side. Auto can grow to 2,048 per side, subject to a shared document/request budget; manual context is 128–8,192 per side. Whole-note source and useful candidate minimums receive allocations first, then shorter notes return unused space to other candidates. Candidate allowance is not weighted by cosine.

The complete serialized request, including all question criteria/framing and evidence labels, is checked. Each state-plus-one-question view is checked too. Known Jev 1.13/1.14 defaults are constrained to 64k request/32k question before margins; the implementation does not assume OpenRouter enables or forwards TypeSafe's optional long-context header. Other model metadata and documented text-truncation advisories constrain the plan.

**There is no validated exact tokenizer for every supported decision model.** `estimatedTokens` is UTF-8 bytes divided by two, rounded up. It is a planning estimate, not a proven token upper bound. Independent conservative byte guards cap the payload at 75% of the minimum applicable token-count value (and 512k transport bytes), with additional estimate/headroom checks. This can use substantially less than advertised capacity: a 64k Jev request typically has a 48k-byte/24k-estimated-token envelope, and individual questions a 24k-byte/12k-estimated-token envelope. The user cap constrains both planning and the byte guard. The UI displays the effective estimated budget; it does not promise exact maximum-fitting K or full model-context utilization.

No provider response is proof that omitted or silently truncated content was read. The catalogue and synthetic probe establish capabilities/protocol, not ranking quality or long-document coverage. See the current primary references below for provider caveats.

## Ranking, display and lifecycle

Each candidate receives one note-level relevance judgment from its selected evidence. Notes sort by descending relevance, with stable original input order for exact ties. Scores are not blended with cosine or hybrid retrieval scores, which remain unchanged and visible. Search graph edges are rebuilt from final membership's stored vectors. Connections graph edges retain source-to-candidate cosine. Graph read failure does not remove a valid ranked list.

The original published local list and graph are saved separately from any expanded candidate window. Failures restore/retain that exact baseline. An invalid baseline is cleared rather than leaving stale relevance visible. Hybrid expansion replaces whole 300/600/1200 windows; normalized scores from different windows are never merged. Connections similarly retains its actual saved retrieval-window provenance.

Preparation and graph work have a 30-second total deadline; service/network work has a 20-second deadline within it. These are provisional operational bounds, not measured latency guarantees. Two requests may run globally across separate views, but each action still sends at most one. Cancellation physically aborts HTTP; queue entries cancel before dispatch. Consent/key/model/settings/source/candidate/query/target changes invalidate affected work. Unrelated index publications coalesce and defer while a current manual ranking is running, pending Apply or displayed.

Interaction defers result reordering to **Apply**. A completed pending result does not expire merely because its finished request deadline passes; it still rechecks current source/candidate snapshots, disclosure, file stamps and settings. The UI reports actually judged/requested counts, full/excerpt counts, source shortening, estimated budget and omitted anchors. A volatile local preview shows the exact evidence used. Text-coverage counts are not semantic-coverage guarantees.

## Privacy, cache and diagnostics

Local admission plus `ai_remote`/`ai_rerank`, remote file/folder exclusions and model-specific consent apply to both source and all candidate notes. Any veto skips the whole operation, retaining private notes' place in local results. Settings and credentials are separate device-local permission-restricted files under the per-vault runtime directory, never vault `data.json`. Permissions are access control, not encryption.

The bounded RAM cache contains hashes/provenance and scalar scores only, with a 15-minute TTL. Identity includes exact source, cleaned/extracted candidate cohort, selected model/served revision, rubric, budget-derived wire text, embedding generation/fingerprint and policy/credential revisions. Changed K/context often changes evidence and therefore invalidates reuse. Raw queries, note bodies, paths, keys and request/response payloads are not logged or persisted by the rerank subsystem. Error messages are sanitized. Cost remains null when a dispatched response lacks trustworthy priced usage, not a misleading zero.

## Validation and remaining release gates

See [phase-2 review](phase-2-reranking-review.md) for completed checks and reproduced/fixed defects. Automated tests are offline/mocked except existing loopback transport tests. They do not establish funded OpenRouter inference, interactive Obsidian/Electron behavior, real-vault relevance gains or actual cost/latency. Those remain explicit gates; the PR stays a draft and is not merged to master.

## Primary API references (checked 2026-11-02)

- [OpenRouter Jev / Decisions guide](https://openrouter.ai/docs/guides/community/jev)
- [Decisions API](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request)
- [Decision-model catalogue](https://openrouter.ai/api/v1/models?output_modalities=decisions)
- [TypeSafe request/question and long-context limits](https://docs.typesafe.ai/models)
- [OpenRouter documented text truncation](https://openrouter.ai/docs/guides/community/multimodal-decisions#limits)
