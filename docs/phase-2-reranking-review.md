# Phase 2: implementation review

Date: 2026-11-02. Scope: single-request adaptive Search, whole-note Connections and selected-passage Connections, on top of PR #3's OpenRouter/model-validation work. This is a second-pass self-review with adversarial regression tests, not an independent human audit.

## Findings reproduced and fixed

| Finding | Fix and regression |
| --- | --- |
| Multiline image-reference definitions left destination/title text behind; orphan image-data definitions leaked their payload. | Treat a definition and continuation lines as one mapped source range, remove image-only definitions and image-data definitions, preserve ordinary textual references. |
| Repeated unmatched brackets could cause quadratic scanner work. | Bound scan work, document bytes, line count and piece count; reject pathological input before any cloud request. Many normal inline code/embedded-image runs remain supported. |
| Extracting a relevant table row omitted the column headers. | Retain original table header and separator ranges, account for them in the serialized request, and label gaps/partial extracts. |
| Generic whitespace trimming removed meaningful selected-code indentation. | Trim only blank boundary lines, preserve protected source selection, and retain format metadata and nested-list/code context. |
| A completed ranking awaiting Apply incorrectly expired when the finished request's deadline elapsed. | Separate active-operation deadline checks from pending snapshot/consent checks; clock-advance regression applies a still-current result after the network deadline. |
| Settings changes or Use local ranking could leave an obsolete reranked list visible when exact baseline restoration failed. | Clear invalid results/seed and require a new local snapshot rather than ignoring restore failure. |
| Connections rerank provenance assumed a 90-hit baseline even after local retrieval widened. | Store and reuse the actual retrieval window; do not refetch smaller windows. |
| The nominal user cap constrained the estimate but not the independent byte guard. | Bind both to the user/model minimum. Serialize/check complete requests and each state-plus-question view. |
| The old developer probe exercised the obsolete batching/request shape. | Replace it with one synthetic inference using the same adaptive planner/source/question shape as runtime. |

The four content regressions and three lifecycle/provenance regressions were first executed against the initial implementation and failed, then passed after the corresponding fixes. Additional tests cover mixed languages/escaping, normal inline-code workloads, nested list parents, source disclosure while awaiting Apply, and stale local restoration.

## Completed offline checks

- TypeScript application check (`npm run typecheck`).
- Full automated suite: **228 passed, 0 failed, 0 skipped** at the reviewed implementation before final documentation/probe changes; final CI reruns the entire suite.
- Actual bundled view methods connected to the real rerank service under mocked Obsidian/network for typed Search, whole-note Connections and selected-passage Connections.
- One-inference/no-retry behavior on failure; complete-answer validation; no score/cosine/rank/path/identity fields in the outgoing evidence schema; original cosine/hybrid values preserved.
- Source/candidate canonical hash and passage-span validation; fresh raw frontmatter veto despite stale metadata cache; source edits/cancellation during hydration and network work; policy rechecks on cached/pending results.
- Adaptive and complete-note prefix selection; protected selected source; common source representation; overlap and Unicode handling; serialized whole-request and per-question budget checks.
- Consent migration from the old smaller-excerpt disclosure; model/key/session validation and existing transport/policy regressions remain covered.
- Synthetic evaluation harness and production build. The evaluation fixture only checks metric plumbing, not real relevance improvement.

The isolated workspace bootstrapped dependencies from CI without the large ONNX runtime binaries. Local packaging therefore needs the wasm runtime restored; the normal CI `npm ci`/`npm run package` is the authoritative complete package check. The workflow uploads the packaged plugin, not that temporary bootstrap workspace.

## Remaining limitations and release checks

No funded inference or real-vault text upload was performed in this review. Validate the selected model with the in-app synthetic action, then check packaged desktop Obsidian/Electron controls, cancellation, save/restart and visual behavior. Run a held-out relevance/coverage/latency/cost evaluation before promoting this draft as a quality improvement.

Exact per-model tokenization and provider framing remain unverified. The conservative estimate/byte envelope deliberately underuses some advertised context and cannot certify complete provider reading. The Markdown scanner supports the tested structural subset, not every extension; inspect the local evidence preview for unusual syntax. The 20-second network/30-second total deadlines are provisional and need measurement.

No unresolved defect from the reproduced regression set remains. That is not a claim that further defects are impossible. Existing embedding/indexing behavior and schema were intentionally left unchanged.
