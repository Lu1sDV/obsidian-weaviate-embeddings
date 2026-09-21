# JEV search reranking through OpenRouter

JEV is an optional second stage after local Weaviate hybrid retrieval. It ranks **notes using selected textual evidence**, not vectors, whole vaults, or individual passage results. Connections and embedding/indexing stay local. Reranking is off by default.

## Setup and migration

In **Search reranking**, select the only supported provider, **JEV via OpenRouter (native JSON)**, save an OpenRouter key, select the evidence policy, read the cloud-processing disclosure, and enable reranking.

- **Complete matched passages only** sends up to three strongest complete retrieved passages per note. It performs no additional source reads.
- **Complete matches + bounded source context** also reads the exact indexed snapshot locally and includes fitting surrounding passages. This is the new default policy, but reranking itself remains disabled until enabled.
- **Allow whole short notes** is off by default. With contextual evidence it additionally permits choosing the complete canonical body of a sufficiently short note instead of passage windows.

Settings from the earlier prefix-only implementation have no recognized evidence policy and migrate to **disabled**. Re-enable after reviewing the changed disclosure; old consent does not silently authorize the broader evidence.

Context windows can cover all of a very short note even when the whole-short-note option is off. That option controls the separate whole-body selection strategy, not a guarantee that some text will always be withheld. Use matched-only evidence to prevent fetching surrounding source, and exclusions to keep a note out entirely.

The key remains in `~/.local/share/obsidian-local-semantic/<vaultId>/credentials.json`, outside the vault. Both API keys are redacted from `data.json`. The credential directory/file use `0700`/`0600` where supported; this is a plaintext local credential file, not an encrypted keychain. Save an empty key to remove it.

## Evidence selection

Local hybrid retrieval still groups matches by note and shortlists up to 30 admitted notes. Each note receives one Noul relevance question over its selected evidence. Original hybrid scores, original passage ordering/navigation and graph cosine weights are preserved; JEV only changes the note order and adds a separate relevance score.

The selector preserves full passage bodies: **there is no 1,200-byte prefix cut anymore**. It prioritizes the strongest match, then up to two further distinct matches. If a later match does not fit the per-note budget, it may be omitted and the result warning reports omitted lower-ranked matches. If the strongest complete match cannot fit, the entire reranking operation falls back to the original hybrid order rather than sending a misleading prefix or dropping that note.

For contextual evidence:

| Embedding mode | Surrounding text policy |
| --- | --- |
| Standard | Try the previous/next stored passage with the same heading; at most 1,536 additional body bytes |
| Late | First try a fitting contiguous same-heading section, then up to two stored passages on each side; at most 4,096 additional body bytes |

All matches are budgeted before optional context. Overlapping selections are deduplicated and returned in source order when source is available. Each span is labelled `match` or `context`, and `gapBefore` distinguishes omitted intervening text. Without source, matches retain retrieval order and disjoint spans are conservatively marked as gaps. Stored passages may combine several paragraphs: they are not guaranteed to be one paragraph each.

The Late policy restores real text from the indexed source; it **does not claim to reconstruct the original embedding window**. Exact window recovery requires additional indexed boundary metadata, which this change does not introduce.

With whole-short-note selection enabled, the entire verified canonical body can be used if it fits both the 6,000-body-byte limit and the serialized per-note limit. Frontmatter is not reintroduced. Longer notes continue to use selected evidence.

## Snapshot and privacy guarantees

Extra source comes from Weaviate's exact generation/model/note/snapshot, not a fresh read of possibly edited Markdown. Before using it the plugin checks the complete ordered passage-ID list and SHA-256 of the concatenated bodies against the current manifest. It checks source size, duplicate IDs, and consistency of retrieved matches with the source. Source-loading failure or mismatch causes safe fallback; all evidence is prepared before the first remote request.

Admission and current snapshot state are checked before/after source loading, before every outbound batch or cache hit, and before publication. Active candidate membership is tracked before source loading starts, so exclusion, edit, query/settings changes, view close or plugin unload cancel pending work. The overall deadline covers both source preparation and API calls. A local database read may finish after cancellation, but its response cannot initiate cloud work or publish results.

Enabling reranking sends query text, titles, headings and selected evidence to OpenRouter and TypeSafe and may incur charges. Separate vault paths, note/snapshot/passage IDs, offsets, vectors and frontmatter metadata are not serialized. User text can itself contain sensitive data; neither truncating metadata nor limiting payload size is redaction. Already-transmitted content and incurred charges cannot be recalled.

## Native JSON protocol

```text
POST https://openrouter.ai/api/alpha/decisions
Authorization: Bearer <OpenRouter key>
Content-Type: application/json
```

The model remains `~typesafe/jev-latest`. The request contains `model`, `state: { query, candidates }`, and typed `questions`. Candidate IDs are locally generated `candidate_0`, etc. A shortened document is:

```json
{
  "title": "Search performance",
  "coverage": "contextual",
  "passages": [
    { "heading": "Caching", "text": "Full stored passage...", "kind": "match", "gapBefore": false },
    { "heading": "Caching", "text": "Complete surrounding passage...", "kind": "context", "gapBefore": false }
  ]
}
```

Each question explicitly names its candidate and asks whether its supplied evidence addresses the query. Native answers must be `answers[id] = { "type": "noul", "noul": 0.87 }` with exactly matching IDs and finite values in `[0,1]`. The value is a model judgment, not cosine similarity or proof of relevance. Stable ties keep the current hybrid order. No chat completions, generated-JSON parsing, alternate providers, or automatic retries are introduced.

## Context and request budgets

The prior OpenRouter model-card inspection (2026-09-21) listed a **32,000-token context** for JEV 1.13/latest. The alias can change. **No validated JEV tokenizer or native preflight token-count API has been established for this implementation.** Accordingly, the code does not invent one, substitute an embedding tokenizer, or claim bytes equal tokens.

The implemented policy keeps the conservative existing **24,000-byte entire escaped JSON request ceiling**. It is a transport/input limit, **not a proven context-window guarantee**. It includes all query, candidate and question content and JSON overhead. Dynamic packing starts another request when a candidate would exceed the cap; a note's evidence is never split into separate scoring questions.

| Limit | Value |
| --- | --- |
| Candidate notes | 30 |
| Query | 2,048 UTF-8 bytes; no silent query truncation |
| Matched anchors per note | Up to 3 |
| Complete serialized evidence per note | 12,000 bytes |
| Optional whole canonical body | 6,000 bytes, still subject to serialized limit |
| Title / heading | 256 / 512 UTF-8 bytes, Unicode-safe metadata clipping |
| Source validation | 4 MiB body text and at most 4,096 stored passages per note |
| API batch | At most 8 candidates and 24,000 serialized bytes |
| API response | 128,000 bytes |
| Overall deadline | 12 seconds, including source preparation |

The reranker outcome exposes count-only diagnostics: request attempts, attempted serialized bytes, selected/omitted evidence counts, cache status, and **actual post-request input token usage when reported**. Missing, invalid, incomplete or failed-call token usage is `null`, not an estimate. These are programmatic diagnostics, not yet a new UI or persisted telemetry. Exact preflight token packing remains outstanding. Do not raise the byte ceiling based on these post-request counts alone.

## Reuse and failure behavior

Index updates coalesce for 250 ms and do not interrupt a valid current query. A per-view single-entry cache holds only a SHA-256 fingerprint and numeric scores. Reuse requires identical provider/key, evidence policy, embedding mode, ordered snapshots/generation/fingerprint and actual serialized evidence. Current source is verified before contextual cache reuse. Explicit query/filter/settings/mode/privacy/close changes clear the cache. Failures are not cached as successes.

Authentication, credits, rate-limit, HTTP/network/protocol failures, unusable complete matches, source mismatches and deadlines preserve the complete original hybrid ranking with a safe warning. A later batch failure discards all earlier batch scores. Cancellation/stale state suppresses publication. Node HTTPS uses a fixed destination, rejects redirects and never exposes upstream bodies in warnings.

## Verification and remaining work

Run `npm run typecheck`, `npm test`, and `npm run build`. Tests cover complete evidence, Standard/Late context selection, byte/escaping limits, snapshot verification, source cancellation/deadlines, cache behavior, credentials, native protocol, transport and view lifecycle. Remote responses are mocked; the existing delayed-socket test uses loopback and synthetic data.

A live funded OpenRouter call, interactive Obsidian validation, exact JEV token accounting, and a relevance/cost benchmark remain unverified. See [context strategy and evaluation](jev-context-strategy.md).

Primary references: [OpenRouter JEV](https://openrouter.ai/~typesafe/jev-latest), [TypeSafe quickstart](https://docs.typesafe.ai/introduction/quickstart), and the [official SDK types at the inspected revision](https://github.com/typesafe-ai/typesafe-sdk-js/blob/66880ccded6cb642dc1809620c2b108c33730214/src/types.ts).
