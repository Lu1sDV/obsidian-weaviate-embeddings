# JEV Search reranking: implementation and validation

This implements the common Search-first scope of the four supplied architecture documents against `3c4e3173e514679806a44e7d2708602facd9f6d2`. Those documents were proposals, not prior implementations or live benchmark evidence. No embedding worker, profile, index generation, vector schema, or loopback transport change is required.

## Decisions where the proposals differ

| Question | Chosen behavior | Reason |
| --- | --- | --- |
| Fallback window | Preserve the original first window that produced the ordinary display; keep the expanded pool separate | The later RFC's widened-window baseline can change normalized hybrid ranking even without JEV. Failure must not silently change local order. |
| Activation | Search-only manual action, default off | No background or typing-triggered disclosure; the serialized local query loop never waits for cloud work. |
| Requests | Single query/candidate reference; question-local batching explicitly experimental, cap 16 | Structured instructions support the shape, but do not prove ranking equivalence. |
| Deadline and retries | Two-second remote operation; no retries | Smaller failure surface; no budget multiplication. This is a product limit, not measured provider latency. |
| Privacy flag | `ai_remote: false`, honoring `ai_rerank: false` as a deny-only alias | Both proposed spellings protect notes. Invalid/quoted values fail closed. A true flag cannot grant provider consent or override local exclusions. |
| Consent/settings storage | All reranker configuration, per-provider consent and keys in a separate device-local file | Never append keys to the existing Weaviate-only secret writer. Never sync cloud consent in vault settings. |
| Evidence allocation | One distinct passage per candidate; all eligible second passages or none if the complete plan exceeds budget | No arbitrary prefix of partly judged notes; no early-note advantage from optional second-passage allocation. |
| Cache | Only completed, fully validated cohorts populate bounded scalar caches | Simpler cancellation ownership; a failed operation intentionally does not warm a partial cache. |
| Future modes | No automatic reranking, Connections rubric, neighboring-context hydration, graded Score, or rank fusion | The proposals explicitly gate these on separate evidence and evaluation. |

## Ownership and invariants

`retrieval-service.ts` expands only after the manual action and replaces complete windows of 300/600/1200 hits. `visibleResults()` retains its 30-note contract; `admittedResults()` is the wider collector. Hybrid passages retain their individual score and deterministic rank. The saved baseline is never modified by expansion or reduction.

`rerank/policy.ts` handles remote-only vetoes. The view reuses `resultCurrent()` and `contextCurrent()` rather than inventing a weaker snapshot/admission definition. It binds the job to the exact query, filters, generation, fingerprint, source snapshots and remote-settings revision. Hidden candidates are invalidated too. The plugin conservatively aborts work and clears scalar caches on source or policy invalidation.

`rerank/service.ts` owns the global two-request queue, deadline, circuit breaker, session budgets and cache. View jobs own cancellation and publication. Obsolete queued requests are removed before dispatch. All selected sources and consent are checked before evidence/cache use, immediately before every HTTP send, after response, and before cache insertion. The view checks again after graph retrieval and when applying a deferred ranking. Stale work cannot restore its old baseline over a new intent.

`rerank/http.ts` uses Node HTTPS with fixed origins/paths, TLS verification, no redirects, no automatic SDK retries, no connection-agent queue, hard byte caps and absolute cancellation. The service queue limits plugin-wide concurrency; using `agent: false` avoids a second hidden request queue after the policy check. Errors never include provider bodies, queries, excerpts, paths, or credentials. The existing `local-http.ts` is unchanged.

`rerank/systemone.ts` serializes only query and bounded title/heading/body evidence. IDs, paths, line anchors, frontmatter, vectors, retrieval scores and provider credentials never enter model input. The response must contain exactly the expected opaque keys, `type: "noul"`, finite `noul` values in [0,1], approved model provenance and valid usage. Duplicate JSON keys, including escaped equivalents, are rejected before they can be silently overwritten. Model output cannot introduce a candidate or destination.

`rerank/reduce.ts` uses maximum passage relevance per note, then original candidate order and stable identity. It preserves base `score` and `scoreKind`, stores separate provenance, places the winning passage first and keeps original navigation lines. All-low scores are valid. No confidence field, hard cutoff, percentage-correct claim or arithmetic blending is invented. Search graph vectors are fetched for the final 30 only; Connections cosines are unchanged.

`rerank/store.ts` follows the existing per-vault runtime directory, but uses its own file. Revocation changes memory and aborts work before disk IO. Writes are serialized and atomically renamed; directory/file modes are 0700/0600. Permissions are not encryption and require desktop-platform verification. A disk-write failure disables reranking for the running session and warns that previous disk consent may remain after restart. No program can guarantee durable revocation when the filesystem refuses the write.

## Operating bounds

The complete operation is planned before its first transmission. Limits are 60 notes, at most two distinct non-overlapping passages each, 16 questions per experimental batch, two concurrent requests, 4,096 query bytes, 1,536 serialized bytes per evidence record, 48,000 request bytes, and 64,000 response bytes. A long passage uses a query-matching region where possible, not automatically its opening. Oversized escaped metadata fails closed. No live Markdown, neighboring notes, transclusions or full-note hydration is used.

Planning estimates UTF-8 bytes/2, independently of the local embedding tokenizer. The 24,000-token request and 64,000-token operation budgets are estimates, not guarantees about JEV tokenization. Provider-reported usage is recorded separately. All requests count against 1,000 requests / 2 million estimated input tokens per plugin session across all views; larger actual reported usage also debits the shared budget. These are session guards, not durable daily/account spending limits. Configure provider-side spending controls independently. No provider price is hardcoded.

The two-second deadline covers evidence planning, queueing and all remote request waves; widening and the final local graph fetch are outside that remote budget. No retry occurs, including on 401/422/429/529. Three transient operation failures open a 30-second circuit; cancellations do not count as outages. Partial replies never reorder notes. A failed remote job leaves the saved local display in place. A valid rerank with a failed graph fetch keeps the list and marks the graph unavailable.

The default single-pair shape can require many request waves and may fail this budget for a cold 60-note pool. Do not call a fast timeout a successful low-latency reranker. Measure completed-operation coverage; keeping an explicit reference mode and an experimental batched mode is intentional until authenticated evaluation is available.

Cache entries are hashes plus scalar judgments only: at most 5,000 entries / one million accounted key-and-value bytes, LRU, 15-minute TTL, RAM only. Keys bind vault, generation, embedding fingerprint, provider, requested/served model, metric/evidence version, request layout, privacy revision, exact query, note/snapshot/passage IDs and complete evidence hash. JavaScript object overhead is additional; this is not a heap-size guarantee. Changing only the reranker does not rebuild vectors. No cross-view in-flight sharing is used.

## Protocol verification

Direct TypeSafe API documentation was rechecked on 21 September 2026:

- https://docs.typesafe.ai/api
- https://docs.typesafe.ai/models

The implementation uses `POST /v1/systemone`, not chat completions. Direct requests pin `jev-1.13.0`; OpenRouter requests pin `typesafe/jev-1.13` at `https://openrouter.ai/api/v1/systemone`, as specified in the supplied plans. The linked OpenRouter integration guide could not be independently retrieved during implementation. OpenRouter's model listing was available, but is not a substitute for a live endpoint contract test:

- https://openrouter.ai/docs/guides/community/typesafe-sdk
- https://openrouter.ai/typesafe

Only explicit 1.13.0 serving identities are accepted (`jev-1.13.0`, and on the router also `typesafe/jev-1.13.0`). Unknown revisions or an unresolved alias fail closed. The connection test exposes this incompatibility rather than silently treating an alias as immutable provenance. All answers assembled into a ranking must use the same raw served-model identity. Extending the approved mapping requires a synthetic contract test and cache-version review, not a permissive regex.

No authenticated request, real-vault upload, provider latency benchmark, or desktop Obsidian/Electron verification was performed during implementation. Synthetic tests are not proof of quality, privacy-account configuration, or packed-request equivalence.

## Reproducible checks and experiments

Run the existing repository checks:

```sh
npm ci
npm run typecheck
npm test
npm run package
```

New offline suites cover response contracts, payload inspection, duplicate/overlapping evidence, ties and all-low scores, exact-window fallback, promotion below rank 30, source/consent races, queued and in-flight cancellation, cache identity, graph score preservation, circuit breaking, bounded HTTPS, redirects, authentication/overload failures, UTF-8 and size limits. No provider credential or live model is used by ordinary tests.

Run the offline metrics smoke fixture:

```sh
npm run eval:rerank
npm run eval:rerank -- /path/to/frozen-ranked-results.json
```

The included fixture is explicitly **synthetic** and its rankings are invented. It tests nDCG@10, MRR@10, supplied-pool recall, oracle ranking ceilings, and deterministic paired query-family bootstrap intervals. It does not claim JEV improved anything. Grades must cover every supplied note ID. Include complete candidate pools to interpret recall and oracle values; query families may not cross development/test splits. No-answer queries are counted separately rather than assigned arbitrary nDCG values.

For a real study, freeze roughly 150–300 consented intents, note snapshots, human-reviewed 0–3 grades and supporting passage IDs. Record current-window local, widened-window local, and JEV rankings separately. Keep the test split out of prompt tuning. Compare 30/60 candidates, one/two passages, reference/packed shape (positions, opaque IDs and distractors), standard/late chunking and actual vault languages. Neighbor context and graded Score remain unimplemented experiment arms. Inspect critical lookup/code/false-premise/no-answer regressions; report completed-operation p50/p95/p99, fallback rate, tokens/cost and cancellation waste as well as ranking metrics. Passage usefulness needs its own annotations; note-level metrics alone do not establish it.

An explicit developer-only live probe uses **built-in synthetic text only**, with no file/vault input:

```sh
JEV_PROVIDER=typesafe JEV_API_KEY='your-key' npm run test:jev-contract
# or JEV_PROVIDER=openrouter, with that provider's separately authorized key
```

Use shell secret handling appropriate for the environment; do not commit or record keys. This command compares reference and packed requests, reversed order and an adversarial synthetic neighbor. It prints only counts, serving provenance, timing and drift. It has its own bounded developer deadline; it does not relax the product's interactive deadline. It is not invoked by `npm test`, packaging, startup, or CI.

Before broader rollout, verify the packaged plugin in desktop Obsidian: type/change filters during every await, edit/delete/rename a hidden candidate, revoke consent while queued/in flight, switch modes, close the view and unload. Confirm scroll/expansion/focus behavior and Apply deferral, synthetic connection behavior on both routes, TLS/abort support, unchanged graph cosines, and zero vault upload in Connections/off mode. Automatic reranking and Connections require separate evaluation, consent and activation design; they are not silently implemented ahead of those gates.
