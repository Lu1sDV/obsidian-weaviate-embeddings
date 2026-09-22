# JEV Search reranking: implemented architecture

Baseline: `master` at `3c4e3173e514679806a44e7d2708602facd9f6d2`. JEV remains an optional application-layer Search feature. It does not change embedding models, chunking, index generations, vector dimensions, Weaviate schema, local admission, source identity, or graph cosine semantics.

## Shipping scope

- Search only.
- Manual **Rerank with JEV** action; disabled by default.
- OpenRouter (`typesafe/jev-1.13`) or direct TypeSafe (`jev-1.13.0`), selected explicitly.
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

The production policy selects exactly one strongest retrieved passage per candidate. The setting `2 — experimental` permits a second distinct non-overlapping passage. There is no neighboring-context hydration in the shipping path; a future `passage-neighbors-v1` experiment must be separately versioned because it changes disclosure and late-chunking evidence.

Remote disclosure is independent of local indexing admission. A note must still be current and locally admitted, provider consent must be active, the selected route must be configured, remote folder/file exclusions must allow the path, and `ai_remote: false` / `ai_rerank: false` must not veto it. If any note required by the selected cohort is remote-ineligible, the whole rerank is skipped and the local baseline remains.

## Planning and request representation

`planRerank()` plans a complete cohort before any network write. It attempts the available candidate count, then deterministic smaller cohorts (including 48, 40, 30 and the current display floor) until the complete evidence/request plan fits. If the current displayed note count itself cannot fit, the rerank is bypassed.

Planning uses both serialized-byte bounds and a conservative token estimate. The estimate is not presented as the JEV tokenizer. Provider-reported usage is retained separately in content-free operation metrics.

Each System One request has shared `state.query`; each opaque question contains one candidate evidence object plus the fixed `search-relevance-noul-v1` rubric. Packed questions are independent candidate-local judgments. A singleton request mode remains in the developer contract probe as the comparison oracle for packing experiments.

## Ranking and provenance

Each passage receives a validated Noul relevance in `[0,1]`. For a note, relevance is `max(passage relevance)` over the selected evidence. Notes sort by relevance descending, then their rank in the single expanded retrieval window, then deterministic note identity. Passages within a note sort by relevance, original retrieval rank, then identity.

`SearchResult.score` is never overwritten. JEV metadata stores the route, requested model, served model, optional OpenRouter upstream provider, rubric/evidence/ranking versions, winning passage, complete coverage marker, and every passage judgment with evidence hash and original retrieval rank. A network failure or missing judgment is never converted to relevance zero.

Search graph vectors are fetched only for the final reranked membership. Edges are rebuilt from stored note vectors, so cosine remains cosine. A graph reconstruction failure keeps the valid ranked list and marks the graph unavailable.

## Serving identity

The provider adapters are explicit:

- `OpenRouterSystemOneProvider` → fixed `https://openrouter.ai/api/v1/systemone`
- `TypeSafeSystemOneProvider` → fixed `https://api.typesafe.ai/v1/systemone`

The request model and response serving identity are separate. The implementation accepts only explicitly approved serving identities. OpenRouter additionally records its response `provider`. Every batch in one logical rerank must report the same compatible serving identity; a change rejects the complete job, clears incompatible cache assumptions, and retains local results.

The synthetic connection test sends built-in arithmetic only. It is a protocol/provenance probe, not evidence of ranking quality or a release benchmark.

## Lease, cancellation, and publication

Every remote job is bound to an immutable `RerankLease`: session ID, Search epoch, query hash, filters hash, generation, embedding fingerprint, cloud/settings/consent/credential revisions, baseline/candidate windows, deadline, and AbortSignal. The view also keeps the exact query/filter/current-snapshot closure.

Currentness and authorization are checked before planning/cache use, before queue entry/dispatch, synchronously immediately before the network write, after responses, before reduction/cache insertion, after final graph retrieval, and before publication. Editing, deleting, renaming, reindexing, changing filters/query/mode/settings/consent/provider/credential, closing a view, or unloading the plugin aborts and invalidates obsolete work.

Remote work is outside the serialized local `runQueries()` lane. The plugin owns one global two-request semaphore; each view owns its active AbortController. Publication is atomic: only complete compatible judgments can replace the display. Partial cohorts never publish.

## Transport and failure behavior

`src/local-http.ts` is unchanged. Cloud traffic uses `src/rerank/remote-http.ts`: HTTPS only, fixed origins/paths, TLS verification, no redirects, bounded headers/request/response bodies, identity encoding, AbortSignal cancellation, and an absolute 2.5-second remote-operation deadline. Provider response bodies, note text, queries, paths, and credentials are not included in thrown errors.

Failure classes are explicit: 401/403 authentication, 400/422 contract/configuration, 429 rate limit/cooldown, transient 5xx/529/provider failures, invalid JSON/schema, oversized response, deadline, cancellation, and model change. Interactive retries are zero. Repeated transient failures open a short route circuit; 429 immediately cools the route.

## Device-local settings and secrets

JEV state is never written to the vault's `data.json` and never appended to the existing Weaviate credential writer.

- `rerank-settings.json`: nonsecret rerank settings plus provider-scoped consent.
- `rerank-credentials.json`: OpenRouter/TypeSafe keys only.

Both live under the existing per-vault device runtime directory, are atomically replaced with restrictive file permissions, and carry a matching write snapshot ID so a torn two-file update fails closed. The loader migrates the earlier unmerged experimental combined-file format. Filesystem permissions are access control, not encryption.

## Cache and observability

The cache contains only scalar passage judgments keyed by hashes/provenance; it never stores raw query/evidence text. Keys bind vault scope, route, requested/served model, upstream provider, primitive/rubric/evidence/ranking versions, query/filter identity, generation/fingerprint, note/snapshot/passage identity, exact evidence hash, and cloud/settings/consent/credential revisions. It is memory-only, vault-scoped, LRU/byte bounded, and expires after 15 minutes.

Operation metrics are content-free: retrieval windows, candidate/exhaustion counts, evidence/truncation counts, request count, estimated/provider-reported tokens, cost when supplied, cache hits, elapsed time, served model, and upstream provider. Raw queries, bodies, paths, frontmatter, API keys, request bodies, and response bodies are not logged by the rerank subsystem.

## Validation

CI runs `npm ci`, `npm run typecheck`, `npm test`, `npm run eval:rerank`, and `npm run package`. The test matrix covers legacy retrieval projection, flat passage rank provenance, window replacement, policy vetoes, split settings/secrets, one/two-passage evidence, UTF-8/byte bounds, packed query-only state, deterministic cohort shrink, strict response parsing, dated OpenRouter serving provenance, max aggregation, score/cosine separation, cache invalidation, partial-batch failure, serving-identity drift, stale snapshot suppression, global concurrency, physical cancellation, deadlines, budget rejection, circuit breaking, and synthetic connection isolation.

The included evaluation corpus is intentionally synthetic and exists only to exercise metrics/reporting. It is not evidence that JEV improves the vault. A real release decision still requires the RFC's frozen-candidate and end-to-end human-reviewed evaluation, including current local, widened local, current-30+JEV, widened+JEV, one/two-passage, singleton/packed, language, chunking, latency, fallback, cost, and regression arms.

## Deferred

Automatic Search reranking remains disabled. Neighbor-context evidence, graded Score, retrieval/JEV fusion, selected-passage Connections, and whole-note Connections remain separate experiments. Whole-note Connections must not upload complete long notes merely to make reranking convenient.
