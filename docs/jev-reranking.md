# System One Search reranking: implemented architecture

Original baseline: `master` at `3c4e3173e514679806a44e7d2708602facd9f6d2`. This update builds on `feat/jev-reranking-hardening` at `46bdfdbfd84027fe81f27e795c7fe40412483781`. Reranking remains an optional application-layer Search feature. It does not change embedding models, chunking, index generations, vector dimensions, Weaviate schema, local admission, source identity, or graph cosine semantics.

## Shipping scope

- Search only.
- Manual **Rerank with System One** action; disabled by default, with sidebar on/off and Cancel controls.
- OpenRouter only, with a user-entered decision model ID and mandatory catalogue/synthetic validation.
- Exact already-published local Search results remain visible and are the failure fallback.
- Wider local retrieval exists only to build the rerank pool.
- Up to 60 admitted candidate notes; final display remains at most 30.
- One evidence passage per note by default; two is an explicit experiment.
- Candidate-local Noul questions are packed with query-only shared state, up to 24 questions/request.
- No relevance threshold, no retrieval/JEV arithmetic fusion, no generative explanation stage.
- No automatic retries and no silent provider failover.
- RAM-only scalar judgment cache.
- Connections remains local-only.

## Retrieval contracts

`WeaviateClient.hybridDetailed()` is the migration seam. It returns one `HybridWindow` containing both the legacy-compatible grouped note results and the flat retrieved passages with their actual window-local `retrievalScore` and deterministic `retrievalRank`. Existing `hybrid()` delegates to `hybridDetailed()` and projects the grouped results, so disabled/local-only Search keeps the old score and ordering contract.

`SearchRetrievalService` owns Search window retrieval. Ordinary Search still follows 300 → 600 → 1200 passage windows until 30 current visible notes are available or the retrieval window is exhausted. The manual JEV continuation reuses the saved final local window, then widens only if necessary. A later window replaces the earlier one; relative-score-fusion values from different windows are never merged.

The saved local baseline and the rerank pool are separate immutable concepts. Rerank failure cannot silently substitute a widened local ranking for what the user had already seen.

## Evidence and cloud policy

Evidence comes only from the retrieved indexed snapshot, never newly edited live Markdown. `passage-v1` sends `title + heading + bounded passage body`. Paths, note IDs, snapshot IDs, passage IDs, vectors, retrieval scores, frontmatter objects, generation IDs, and purge state stay local. Evidence truncation is UTF-8 bounded and query-aware; minimization is not anonymization.

The production policy selects exactly one strongest retrieved passage per candidate. The setting `2 — experimental` permits a second distinct non-overlapping passage. Candidate breadth is planned under the one-passage policy first; the two-passage arm must score that exact cohort under its larger experimental operation budget or bypass entirely, so evidence breadth cannot silently change candidate breadth. There is no neighboring-context hydration in the shipping path; a future `passage-neighbors-v1` experiment must be separately versioned because it changes disclosure and late-chunking evidence.

Remote disclosure is independent of local indexing admission. A note must still be current and locally admitted, provider consent must be active, the selected route must be configured, remote folder/file exclusions must allow the path, and `ai_remote: false` / `ai_rerank: false` must not veto it. If any note required by the selected cohort is remote-ineligible, the whole rerank is skipped and the local baseline remains.

## Planning and request representation

`planRerank()` plans a complete cohort before any network write. Candidate breadth is chosen once using the release one-passage policy: it attempts the available candidate count, then deterministic smaller cohorts (including 48, 40, 30 and the current display floor) until that complete plan fits. If the current displayed note count itself cannot fit, the rerank is bypassed.

The two-passage experiment then reuses exactly that candidate cohort. It receives a larger bounded operation budget (up to six packed requests and 128k conservative estimated tokens across the operation, versus three / 64k for one passage). Each individual request remains under the existing 24k conservative estimate. If the exact cohort still cannot fit, the rerank is bypassed instead of shrinking to a different candidate set.

Planning uses both serialized-byte bounds and the existing token estimate, which is not a model tokenizer or a proven token upper bound. The request byte limit is additionally capped at 75% of the selected model's effective catalogue context, including known text truncation advisories. This is deliberately conservative headroom, not an exact-token or complete-reading guarantee. Provider-reported usage is retained separately. The existing application cohort and operation limits remain; this patch does not implement maximum-fitting whole-note top-K.

Each System One request has shared `state.query`; each opaque question contains one candidate evidence object plus the fixed `search-relevance-noul-v1` rubric. The structured question explicitly refers to `query` and `candidate` by their actual field names. Packed questions are independent candidate-local judgments. A singleton request mode remains in the developer contract probe as the comparison oracle for packing experiments.

## Ranking and provenance

Each passage receives a validated Noul relevance in `[0,1]`. For a note, relevance is `max(passage relevance)` over the selected evidence. Notes sort by relevance descending, then their rank in the single expanded retrieval window, then deterministic note identity. Passages within a note sort by relevance, original retrieval rank, then identity.

`SearchResult.score` is never overwritten. JEV metadata stores the route, requested model, served model, optional OpenRouter upstream provider, rubric/evidence/ranking versions, winning passage, complete coverage marker, and every passage judgment with evidence hash and original retrieval rank. A network failure or missing judgment is never converted to relevance zero.

Search graph vectors are fetched only for the final reranked membership. Edges are rebuilt from stored note vectors, so cosine remains cosine. A graph reconstruction failure keeps the valid ranked list and marks the graph unavailable.

## Model validation and serving identity

The only provider adapter is `OpenRouterSystemOneProvider`, using fixed `https://openrouter.ai/api/alpha/decisions`. The former direct TypeSafe route has been removed. OpenRouter still documents `/api/v1/systemone` for SDK compatibility; this change does not assume that endpoint was removed.

Enter an exact OpenRouter model ID or alias and click **Save & validate**. The plugin loads the authenticated Models API with `output_modalities=decisions`, follows bounded same-origin pagination, and checks text input, Decisions output, the supported endpoint, usable context, and alias/canonical identities. Chat `supported_parameters` such as `structured_outputs` are not required. Known special-state Span-01 and Classify-1 models are rejected. Clef/Clef Flash expose their documented approximately 2,000-token text-state truncation advisory separately from their larger catalogue context.

Catalogue membership alone cannot enable reranking. A synthetic arithmetic call must return complete valid Noul answers using the actual request shape. Approval is in memory, bound to the exact model and credential revisions, and expires after 24 hours. Restarting the plugin, changing the model/key, or failed revalidation requires another check. Enabling/disabling the feature or changing upload permission does not itself revoke an unchanged model contract. The model field is saved before validation; a failed check leaves reranking unavailable and the settings UI shows the failure.

The request model and response serving identity are separate. Accepted response identities come only from the catalogue's concrete target ID and canonical snapshot; an echoed mutable alias is rejected. OpenRouter's optional `provider` is validated when present. Noul answer extensions are tolerated, while exact answer IDs, required type, finite values in `[0,1]`, usage and duplicate-key validation remain strict. Every batch in one logical rerank must report the same compatible serving identity; a change rejects the complete job and retains local results.

Validation can incur a small API charge and sends built-in arithmetic only. It establishes protocol/provenance compatibility, not ranking quality, exact tokenization or complete long-document reading. Public catalogue parsing was also checked against all 33 entries returned on 2026-11-02: 29 passed metadata checks; four known special-state variants were excluded. No authenticated production inference was performed during this code review.

## Lease, cancellation, and publication

Every remote job is bound to an immutable `RerankLease`: session ID, Search epoch, query hash, filters hash, generation, embedding fingerprint, cloud/settings/consent/credential revisions, baseline/candidate windows, deadline, and AbortSignal. The view also keeps the exact query/filter/current-snapshot closure.

Currentness and authorization are checked before planning/cache use, before queue entry/dispatch, synchronously immediately before the network write, after responses, before reduction/cache insertion, after final graph retrieval, and before publication. A note-scoped edit/delete invalidation aborts only jobs whose candidate cohort contains that note; unrelated jobs and snapshot-bound cached judgments remain usable. Global query/mode/runtime/settings/consent/provider/credential changes still invalidate all affected work. If an already-published JEV view cannot restore its exact saved local baseline after a snapshot change, it clears immediately rather than leaving the stale reranked list visible.

Ordinary index publications coalesce and defer refresh while current manual work is running, awaiting Apply, or already displayed. Returning to local order, cancellation or failure releases deferred refresh. Source edits and changed user intent still invalidate immediately. Sidebar enable sends no request; Cancel aborts outstanding work.

Remote work is outside the serialized local `runQueries()` lane. The plugin owns one global two-request semaphore; each view owns its active AbortController. Publication is atomic: only complete compatible judgments can replace the display. Partial cohorts never publish.

## Transport and failure behavior

`src/local-http.ts` is unchanged. Cloud traffic uses `src/rerank/remote-http.ts`: HTTPS only, fixed origins/paths, TLS verification, no redirects, bounded headers/request/response bodies, identity encoding, AbortSignal cancellation, and an absolute 2.5-second remote-operation deadline. Provider response bodies, note text, queries, paths, and credentials are not included in thrown errors.

Failure classes are explicit: 401/403 authentication, 402 credits/budget, 400/422 contract/configuration, 429 rate limit/cooldown, transient 5xx/529/provider failures, invalid JSON/schema, oversized response, deadline, cancellation, and model change. Interactive retries are zero. Repeated transient failures open a short circuit; 429 immediately cools that model/credential selection. The synthetic validation operation has a separate 10-second deadline for catalogue loading and inference.

## Device-local settings and secrets

JEV state is never written to the vault's `data.json` and never appended to the existing Weaviate credential writer.

- `rerank-settings.json`: nonsecret rerank settings plus provider-scoped consent.
- `rerank-credentials.json`: OpenRouter key only.

Both live under the existing per-vault device runtime directory, are atomically replaced with restrictive file permissions, and carry a matching write snapshot ID so a torn two-file update fails closed. Version-1 files and the earlier combined format migrate to disabled OpenRouter settings with fresh upload permission required. The OpenRouter key is retained; a direct TypeSafe key is never reused as an OpenRouter key and is omitted on the next save. Changing the selected model resets upload permission. Filesystem permissions are access control, not encryption.

## Cache and observability

The cache contains only scalar passage judgments keyed by hashes/provenance; it never stores raw query/evidence text. Keys bind vault scope, route, requested/served model, upstream provider, primitive/rubric/evidence/ranking versions, query/filter identity, generation/fingerprint, note/snapshot/passage identity, exact evidence hash, and cloud/settings/consent/credential revisions. It is memory-only, vault-scoped, LRU/byte bounded, and expires after 15 minutes.

Operation metrics are content-free: retrieval windows, candidate/exhaustion counts, evidence/truncation counts, request count, estimated/provider-reported tokens, cost when supplied, cache hits, elapsed time, served model, and upstream provider. Raw queries, bodies, paths, frontmatter, API keys, request bodies, and response bodies are not logged by the rerank subsystem.

Cost is `null` while any attempted inference lacks a priced response, including timeouts or failed response validation. Zero means no inference was attempted or every response explicitly reported zero. Partial known charges are never shown as a complete total.

## Validation

CI runs `npm ci`, `npm run typecheck`, `npm test`, `npm run eval:rerank`, and `npm run package`. The test matrix covers legacy retrieval projection, flat passage rank provenance, window replacement, policy vetoes, split settings/secrets, one/two-passage evidence, UTF-8/byte bounds, explicit structured-field references, packed query-only state, candidate-cohort parity across one/two-passage planning, strict response parsing, dated OpenRouter serving provenance, max aggregation, score/cosine separation, note-scoped versus global invalidation, stale-baseline clearing, partial-batch failure, serving-identity drift, stale snapshot suppression, global concurrency, physical cancellation, deadlines, budget rejection, circuit breaking, and synthetic connection isolation.

The included evaluation corpus is intentionally synthetic and exists only to exercise metrics/reporting. It is not evidence that JEV improves the vault. A real release decision still requires the RFC's frozen-candidate and end-to-end human-reviewed evaluation, including current local, widened local, current-30+JEV, widened+JEV, one/two-passage, singleton/packed, language, chunking, latency, fallback, cost, and regression arms.

## Deferred

Automatic Search reranking, neighbor-context evidence, graded Score, selected-passage Connections, and whole-note Connections are not implemented. The requested full-content and excerpt modes are specified for discussion in [the design review](openrouter-reranking-review.md); they will require explicit source-target contracts, verified source hydration, passage-anchor retrieval, context accounting and quality/latency validation.

## Current primary API references

- [OpenRouter Jev / Decisions guide](https://openrouter.ai/docs/guides/community/jev)
- [Decision-model catalogue](https://openrouter.ai/api/v1/models?output_modalities=decisions)
- [Decisions API reference](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request)
- [OpenAPI schema](https://openrouter.ai/openapi.json)
- [Provider text limits](https://openrouter.ai/docs/guides/community/multimodal-decisions#limits)
- [TypeSafe SDK compatibility route](https://openrouter.ai/docs/guides/community/typesafe-sdk)

The optional developer probe is `OPENROUTER_MODEL=author/model OPENROUTER_API_KEY=... npm run test:jev-contract`. Supply secrets through your normal environment mechanism, not committed files. It compares synthetic singleton and packed calls and is not a relevance benchmark.
