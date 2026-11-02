# Local Semantic Search

I made this to study chunking, late chunking, and embeddings. It ended up as a desktop Obsidian plugin. Models run locally through Transformers.js; Weaviate stores the vectors and handles retrieval.

Personal experiment. Not a polished product.

## What it does

- **Standard chunking:** split Markdown around its structure, then embed each passage separately.
- **Late chunking:** encode a larger context window first, then pool each passage's token embeddings. Same passage boundaries, different context. Jina only.
- **Connections:** related notes using cosine similarity, from the whole note or a selected passage.
- **Search:** Weaviate hybrid retrieval — keyword search plus vectors.

Models: Granite 97M R2 (default), MiniLM L6 v2, and Jina Embeddings v2 Small. Standard is the default mode. Jina uses 3,584-token runtime windows here, not its advertised 8,192 positions. Longer notes are split across windows; changing model or chunking mode rebuilds the index. Used Jina for late chunking due to its mean pooling, Granite R2 does CLS chunking and it's not suited to late chunking.


## In Obsidian

Connections keeps the current note visible beside related notes and their cosine scores.

![Connections view beside a flood-response note](docs/images/connections.png)

The connection target can be the whole note or a specific Markdown passage.

![Passage target picker](docs/images/passage-targets.png)
## Try it

You need desktop Obsidian, Node.js 22+, and working Podman or Docker.

```sh
npm install
npm run package
```

Copy `release/local-semantic-search` into a test vault's `.obsidian/plugins/`, then enable the plugin. In its settings, select your container backend, model, and chunking mode, then enable semantic indexing. For Late, select Jina first. Missing model files and the Weaviate image are downloaded on first use.

Original Markdown files are not modified. Frontmatter is filter metadata, not embedding input. `#status/inbox`, `#type/private`, their subtags, and `ai_index: false` are excluded. Weaviate is authenticated and loopback-only; managed data and credentials live outside the vault. Unloading the plugin leaves Weaviate running.

## Optional System One reranking through OpenRouter

Manual reranking is available in **Search** and **Connections**, for either the whole reference note or a selected passage. It is off by default. OpenRouter is the only route: save a key, enter a compatible decision-model ID, and click **Save & validate**. Validation checks the Decisions catalogue and makes one potentially billed synthetic arithmetic request with the runtime request shape. It sends no vault text. Then explicitly allow source/candidate uploads and enable reranking.

Both sidebar modes expose **Reranking on/off**, **Rerank / Cancel / Use local ranking**, desired candidate count, and **Adaptive context / Complete notes only**. Enabling alone sends nothing. Local results remain visible until a complete valid answer arrives; failures retain the exact saved local order. Interaction defers reordering until you click Apply. The evidence preview shows the cleaned text actually used.

**One inference request at most per manual action.** All candidate-local relevance questions share the same source. If the input is too large, the plugin adjusts extracts locally or reduces the leading candidate prefix before sending. There are no overflow batches, automatic retries, summarization calls, or hidden fallback models. A complete cached cohort requires no inference request. Defaults: 30 requested candidates, at most 60 considered and 30 displayed, a nominal 64,000-token request cap, Auto context, and 512 preferred surrounding tokens per side (Auto can expand up to 2,048). Smaller model/provider limits and conservative byte safeguards can reduce the usable budget substantially; the UI reports estimates, not exact tokenizer counts.

**Adaptive context** preserves complete short notes. Oversized whole notes use substantive beginning/end material and relevant interior passages with their surroundings. The shared whole-note source instead covers representative sections. Passage targets preserve the complete selected passage and label its surrounding context. Image destinations, embeds and image data are removed outside code; meaningful captions can remain. Linked notes, attachments and media are never fetched or expanded. Gaps and partial fragments are identified. **Complete notes only** reduces candidate count rather than silently shortening complete notes; a selected passage remains that passage plus bounded surroundings.

Whole-note Connections obtains local passage anchors from the source and candidates' stored vectors. Hydration reads current Markdown and stored snapshots, then verifies the canonical body hash, raw frontmatter, ordered passage identities and exact text spans. A stale source, candidate or privacy setting prevents upload/publication. This does not rebuild or modify the embedding index.

**Relevance alone determines the reranked order.** Cosine, hybrid scores and retrieval ranks are not sent to the judge or blended with its answer. Existing local scores remain visible. Connections edges retain their original source cosine; Search graph edges are rebuilt from the final notes' stored vectors. Graph failure does not discard a valid ranked list.

`ai_remote: false`, `ai_rerank: false`, remote exclusions and ordinary indexing admission apply to **both the source and all candidate notes**. A mixed allowed/private pool skips the entire rerank. Earlier settings migrate to disabled with fresh full-source disclosure permission required; the OpenRouter key/model are retained where applicable. Settings and secrets are separate, permission-restricted files under `~/.local/share/obsidian-local-semantic/<vaultId>/`, not vault-synced `data.json`. File permissions are not encryption. Text minimization is not anonymization.

The network budget is 20 seconds within a 30-second overall preparation/graph deadline; cancellation and local search remain available. These are provisional operational limits, not measured service guarantees. The RAM-only cache stores hashes and scalar judgments for exact source/evidence/model/policy identity. No raw query or note text is logged or persisted by the reranker; the local preview stays in memory until cleared.

See [implementation and setup](docs/jev-reranking.md), [design decisions](docs/openrouter-reranking-review.md), and [phase-2 review](docs/phase-2-reranking-review.md). Offline tests cover implementation behavior. Authenticated live inference, interactive desktop behavior, exact per-model tokenization and held-out relevance/latency/cost remain separate release checks.

## Poorly explained benchmarks

Local Jina v2 Small runs, fp32, 3,584-token windows. The main retrieval benchmarks use LLM relevance labels, not human ground truth. nDCG@10 roughly means “did the relevant notes end up near the top?” Higher is better.

### Actual Obsidian Search

These used the packaged plugin's Search UI and Weaviate hybrid ranking.

| Experiment | Result | Rough reading |
| --- | --- | --- |
| Broad corpus: 125 notes, 40 queries | Standard nDCG **0.7993**, Late **0.8053**. Both **97.5%** relevant at rank 1. | Basically a tie. The nDCG difference's 95% interval crosses zero. |
| Context-dependent queries: 175 notes, 152 queries | Late **+0.0073 nDCG** overall; 95% interval **[+0.0008, +0.0153]**. Same-window medium notes: **+0.0125**. | Small gain on this deliberately constructed dataset. Across-window cases were slightly worse. |

### Offline experiments

These are cosine-ranking experiments, not more runs of the hybrid Search UI. Different setups; don't compare scores across rows as if they were one leaderboard.

| Experiment | Result | Rough reading |
| --- | --- | --- |
| Selected passage vs whole-note Connections: 102 cases | Late selected passage **0.7081 nDCG**, whole note **0.6577**. Standard selected passage **0.6642**. | Picking a passage helped Late here. An LLM picked the passages, not real users. |
| Smaller paragraph chunks: 120 notes | **469 → 1,717** passages; Late nDCG **0.8476 → 0.8484**. | 3.66× as many vectors, no reliable retrieval gain. |
| Less context around each passage | ±128 tokens: **0.7331** Connections nDCG vs full-window Late **0.7081**; **2.03×** encoded tokens. | Promising, but recomputing overlapping context isn't free. |
| Controlled window seams: 20 synthetic cases | Late nDCG: same window **0.9124**, split windows **0.6138**, 512-token overlap **0.9309**. | Overlap recovered context in this tiny controlled setup. Not proof it helps a real vault. |

My takeaway: late chunking can help when a passage needs nearby context. More context, smaller chunks, and overlap are not automatic upgrades. Standard stays the default; context-radius and overlap variants above are not implemented in the plugin.

The benchmark scripts, datasets, and raw results are **not included in this repo**, so these are notes from local runs, not a reproducible benchmark release.

## Checks

```sh
npm run typecheck
npm test
npm run package
```
