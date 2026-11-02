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

Search has a manual **Rerank with System One** action and an on/off control in the sidebar. Reranking is off by default; enabling it sends no request. In settings, save an OpenRouter key, enter a decision model ID, and use **Save & validate**. Validation checks the authenticated decision-model catalogue and makes a small, potentially billed arithmetic request with the real reranking request shape. It sends no vault content. Then allow query/excerpt uploads and enable manual reranking. **Cancel reranking** stops pending work; **Use local ranking** restores the saved local order.

OpenRouter is the only route. Model selection accepts compatible catalogue IDs and aliases, resolves concrete serving identities, and rejects chat models and known incompatible state formats. Validation is scoped to the model/key and current plugin session, expires after 24 hours, and is revoked by model/key changes or failed revalidation. Changing the model resets upload permission. Earlier experimental settings migrate to disabled, retaining only the OpenRouter key. The fixed JEV model list and direct TypeSafe adapter have been removed.

Local hybrid results appear first and remain the exact fallback. An explicit rerank may widen local retrieval to one coherent 300/600/1200-passage window to collect at most 60 current admitted notes; normalized hybrid scores from separate windows are never merged. The release evidence policy sends the strongest retrieved passage from each candidate note. A two-passage mode is available only as an explicit experiment. The complete cohort is planned before the first network write and may deterministically shrink toward the currently displayed note count if the configured evidence does not fit the bounded operation budget.

System One requests use packed, candidate-local Noul questions that share only query state. Requests are capped at 24 questions and are bounded by serialized bytes and conservative token estimates; at most two HTTPS requests run concurrently. The product remote deadline is 2.5 seconds, with no automatic retries and no silent provider failover. Every published ranking requires a complete, compatible set of judgments. Low scores such as 0.04 remain valid relevance judgments; network failures and missing answers never become relevance zero.

`ai_remote: false` (also `ai_rerank: false`) and remote file/folder exclusions veto upload without removing a note from local search. A mixed eligible/private cohort skips the whole rerank. Missing metadata, stale snapshots, revocation, changed search intent, changed embedding generation/fingerprint, or changed cloud settings fail closed. Cloud policy/consent live in device-local `rerank-settings.json`; provider secrets live separately in `rerank-credentials.json`, both under `~/.local/share/obsidian-local-semantic/<vaultId>/`. They are permission-restricted, not encrypted. Titles and excerpt text can still contain sensitive information; minimization is not anonymization.

Model relevance is stored separately from the existing hybrid score. Search graph membership can change after reranking, but graph edges are rebuilt from the final notes' stored vectors, so edge cosine remains actual cosine. Connections mode remains local-only and never interprets relevance as cosine. Model provenance records both the requested model and the approved concrete served revision; OpenRouter's upstream provider is retained when reported. A serving-revision change during one logical job rejects the whole result. Unrelated background index publications preserve current manual reranking; source changes still invalidate it immediately.

The RAM-only judgment cache stores hashes plus scalar passage scores, not raw queries or note text, and is keyed to exact query/evidence/snapshot/provider/model/policy provenance. Automatic Search reranking and both Connections reranking modes remain unimplemented. See [implemented behavior and limits](docs/jev-reranking.md) and [the whole-note/excerpt design under discussion](docs/openrouter-reranking-review.md). Catalogue context is not proof of complete-document reading; current packing retains application limits and conservative byte headroom rather than claiming exact maximum top-K.

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
