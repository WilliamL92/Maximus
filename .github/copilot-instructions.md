# Maximus — Copilot / AI Agent Instructions

> Read this file BEFORE making any change. It describes the architecture,
> the performance invariants, and the project's non-negotiable rules.

## 1. Product mission

VS Code extension that opens, browses, **edits** and **searches** text
files of **several hundred GB** without saturating RAM or disk. Every
implementation decision must be evaluated against this contract.

**Perf target**: a 2 GB / 40 M-line file must open, search, edit and save
in a few seconds max on a standard developer machine. No synchronous
**O(file_size)** operation on the main thread, **ever**.

## 2. Architecture (overview)

```
┌────────────────────────┐    postMessage     ┌────────────────────────┐
│  Webview (media/*.js)  │ ◄────────────────► │  Extension (src/*.ts)  │
│  - Virtual scroll      │                    │  - CustomEditorProvider│
│  - Hits cache visible  │                    │  - HitStore (compact)  │
│  - Render rAF          │                    │  - EditOverlay         │
└────────────────────────┘                    └───────────┬────────────┘
                                                          │ Worker pool
                                              ┌───────────▼────────────┐
                                              │ worker_threads (N=cpu) │
                                              │ - searchWorker.ts      │
                                              │ - indexWorker.ts       │
                                              │ Transferable Typed Arr │
                                              └────────────────────────┘
```

### Key components

- [src/extension.ts](src/extension.ts) — entry point, registers the custom editor.
- [src/customEditor.ts](src/customEditor.ts) — `MaximusEditorProvider`,
  webview message dispatch, drives search/save/replace/index.
- [src/lineIndex.ts](src/lineIndex.ts) — `SparseLineIndex`:
  `offsets[k] = byte at the start of line k * step` (step=1000). Memory
  O(N/step). Resolving a line = anchor + local scan ≤ step bytes.
- [src/parallelIndex.ts](src/parallelIndex.ts) +
  [src/indexWorker.ts](src/indexWorker.ts) — parallel indexing at open
  time (N workers, Float64Array of line-starts via Transferable).
- [src/parallelSearch.ts](src/parallelSearch.ts) +
  [src/searchWorker.ts](src/searchWorker.ts) — parallel search, returns
  a `HitStore`.
- [src/hitStore.ts](src/hitStore.ts) — compact hit storage:
  `Int32Array×2 + Int16Array = 10 bytes/hit`. `seal()`,
  `hitsInRange(lo, hi)` (binary search O(log N)), `firstAtOrAfter`,
  `lastAtOrBefore`, `at(i)`. **Always prefer these APIs over storing a
  `Hit[]`.**
- [src/editOverlay.ts](src/editOverlay.ts) — edits overlay
  (patches/insertions/deletions). `save()` has two paths: `tryInPlace()`
  (pwrite if bytes-equivalent) and `surgicalRewrite()` (binary copy with
  16 MB buffers, ping-pong I/O pipeline). Returns `{ inPlace, shifts }`
  so the caller can either skip reindexing (in-place) or **patch the
  index incrementally** via `patchSparseIndex` when only single-line
  `setLine`s were applied.
- [src/fileReader.ts](src/fileReader.ts) — reads line ranges via the
  index, without loading the file in memory.
- [media/main.js](media/main.js) — webview: virtual scroll, anchored
  rendering, windowed hits cache, Ctrl+F search bar.
- [media/main.css](media/main.css) — styles.

## 3. Non-negotiable rules

### Performance
- **Never** read the entire file (`readFile`, `readFileSync`) on a
  potentially huge file.
- **Never** run an O(file_size) operation on the Node main thread; use
  `worker_threads`.
- **Never** store a full hits array. Use `HitStore`.
- **Never** keep the entire file text in memory (`fileReader` reads on
  demand via the index offsets).
- Prefer **typed arrays + Transferable** to JS objects when moving
  large volumes between workers and main.
- Any UI progress: **throttle to per-mille** (`Math.floor(b/total*1000)`)
  or 80 ms — never one postMessage per chunk.
- Buffers: `Buffer.indexOf` (memmem SIMD via libc) > manual JS scan.

### RAM
- Allocate **one** reusable buffer per worker
  (`Buffer.allocUnsafe(CHUNK)`), not one per chunk. Unless required
  (content transferred to main).
- `EditOverlay` only stores edited lines (Map), **not** unchanged lines.
- Prune webview caches (`pruneCache`) outside the visible window.

### Parallelization
- Worker pool sized by `os.availableParallelism()`. Able to fall back to
  1 worker for small files (`MIN_PARALLEL_BYTES = 16 MB`).
- Range splitting **aligned on line starts** via `SparseLineIndex.offsets`
  anchors (free, no re-scan).
- On abort: `worker.terminate()` immediately, don't wait for natural end.

### Webview ↔ Extension
- IPC = JSON-serializable `postMessage`. No functions, no circular
  references.
- Every message carries a `requestId` for req/resp flows and to
  invalidate late responses.
- The webview must NEVER own the full hits array; it requests
  `queryHitsRange(lineFrom, lineTo)` for its visible window.

### Save
- Always try the **in-place** path (`pwrite`) first if the edits are
  only bytes-equivalent `setLine`s → no copy, no reindex.
- Otherwise: `surgicalRewrite` with 16 MB binary buffers and a
  **ping-pong I/O pipeline** (start the next `read` before awaiting the
  current `write`), write to `<file>.maximus-tmp-*` then atomic `rename`.
- After an in-place save, **skip the rebuild** (no byte moved).
- After a surgical rewrite that returns `shifts !== null` (only
  single-line `setLine`s, total `\n` count preserved), **patch the index
  incrementally** via `patchSparseIndex` — O(totalLines/step) instead of
  a full rebuild O(file_size). Only when `shifts === null` (insertions,
  deletions, multi-line content) must the index be fully rebuilt.

### Virtual scrollbar
- `MAX_SPACER_PX = 30_000_000` (browser limit). Beyond that the
  scrollbar is **compressed**: `scale = spacerHeight / virtualHeight < 1`.
- In compressed mode, 1 px of scrollTop = several virtual lines. Any
  "viewport bottom" detection must use `endSnapPx()` proportional to
  the compression — not a constant offset.
- The `anchored` mode (jumpToLine, hit navigation) computes
  `firstVisible` directly from `anchorLine`, not via `scrollTop`, to
  avoid precision drift.

## 4. Agent edit workflow

1. **Read** the relevant files in full before editing.
2. **Compile**: `npm run compile` (TypeScript). The `media/*.js` is not
   compiled.
3. **Bench if you touch a hot path** (search, index, save, render).
   Create a throwaway script in `/tmp/bench-*.js` that measures
   before/after on `samples/huge.{csv,log,...}`.
4. **Don't break the existing fast path** when adding a general one:
   add a `tryFastPath()` that tries, and bails to the general path on
   failure.
5. **Bump the version** in [package.json](package.json) if you rebuild
   a `.vsix` for installation (otherwise VS Code may cache the old
   webview). Bumping the version is also what triggers a Marketplace
   release on the next push to `master`.
6. **Package locally** (for ad-hoc install / smoke test):
   ```bash
   npm run compile
   npx --yes @vscode/vsce package
   code --install-extension maximus-<version>.vsix --force
   ```
7. **Release** (Marketplace): push to `master`. The
   [.github/workflows/deploy.yml](.github/workflows/deploy.yml)
   workflow packages, runs `vsce publish` against
   `maximus1.maximus` (PAT in the `VSCE_PAT` repo secret), creates the
   git tag `v<version>` and a GitHub Release. The job skips itself if
   the tag already exists, so pushes that don't bump the version are
   no-ops.

## 5. Anti-patterns to systematically reject

- ❌ `fs.readFileSync(hugeFile)` — blows up RAM.
- ❌ `text.split('\n')` on full content — V8 string + array overhead.
- ❌ `lookup.indexOf(needle, mp)` in a per-line loop without bounding
  the end (cf. O(N²) bug fixed in [src/searchWorker.ts](src/searchWorker.ts)).
- ❌ Storing `state.hits = [{line, col, len}, ...]` on the webview side.
- ❌ `postMessage` per hit / per chunk without throttling.
- ❌ `Buffer.concat([carry, slice])` on every 4 MB chunk in a tight
  loop if avoidable.
- ❌ Reindexing after an in-place save (nothing moved).
- ❌ Full reindex after a surgical rewrite that returned `shifts` — use
  `patchSparseIndex` instead.
- ❌ Sequential `await read(…); await write(…)` in a copy loop — use the
  ping-pong pipeline so the next read overlaps the current write.
- ❌ Detecting scroll bottom with a constant threshold in real pixels
  (ignores the compression scale).
- ❌ Search/save/index running on the main thread.
- ❌ `Math.random()` for any token used in a security context (CSP
  nonce, tmp file suffix). Use `crypto.randomBytes`.
- ❌ Predictable tmp file names (`<file>.tmp`, `<file>.tmp-<ts>` alone).
  Always combine timestamp **and** random suffix, and open with
  `'wx'` (`O_EXCL`).
- ❌ Forwarding raw `err.stack` or full `String(err)` to the webview.
  Use a sanitizer that keeps only the first line of `err.message`.
- ❌ Trusting webview message fields without type/range/size validation
  at the dispatch boundary.
- ❌ Interpolating raw values into the HTML template without coercion
  (`Number(...)`, `escapeHtml(...)`, `JSON.stringify(...)`).

## Security (non-negotiable)

- **CSP**: `default-src 'none'; script-src 'nonce-${nonce}'; …`. The
  nonce MUST come from `crypto.randomBytes(>=16)`. No `'unsafe-eval'`.
- **HTML template interpolation**: every `${...}` value MUST be coerced
  to a safe type — integers via `Number`/`Math.floor` with bounds,
  strings via `escapeHtml`, JSON via `JSON.stringify`.
- **Line rendering** in the webview MUST escape its source. The three
  current paths (`escapeHtml`, `hljs.highlight().value`,
  `colorizeDelimited`) all do; any new renderer must too. Status text
  uses `textContent`, not `innerHTML`.
- **Tmp files**: name = `<file>.maximus-tmp-<ts>-<crypto-hex>`. Open
  with `'wx'` (`O_EXCL`) so a pre-existing symlink/file is rejected.
  Cleanup in `catch { unlink(tmp) }` on every error path.
- **Boundary input validation** in `onMessage`: every webview message
  must be type/range/size checked at the boundary (ints via
  `Number.isInteger`, strings via length cap). Edits capped at 8 MiB,
  query strings at 64 KiB. Validation runs once per message — never
  inside a hot per-line loop.
- **Error sanitization** for the webview: use `safeErrorMessage(e)`
  (first line of `e.message`, ≤ 500 chars). Never forward `e.stack`.
- **Worker isolation**: user-supplied regex compiles inside
  `searchWorker`. Keep cancellation paths working (`worker.terminate()`)
  so a pathological regex never freezes the extension host.

## 6. Review checklist (apply to every PR)

- [ ] No O(file_size) RAM allocation.
- [ ] If new worker: reused buffers, batches in Transferable typed
      arrays.
- [ ] If hot-path change: before/after bench committed to `/tmp` and
      result reported in the description.
- [ ] UI progress throttled (per-mille or ≥ 80 ms).
- [ ] Aborts propagated and workers terminated on cancel.
- [ ] No regression on other samples (`huge.log`, `huge.csv`,
      `huge.json`, `huge.ndjson`).
- [ ] If webview change: no full hit storage, windowed requests via
      `queryHitsRange`.
- [ ] If new tmp file: `crypto.randomBytes` suffix + `'wx'` flag +
      cleanup on error.
- [ ] If new webview message: validation at the dispatch boundary.
- [ ] If new error path forwarded to the webview: routed through
      `safeErrorMessage`.
- [ ] If new HTML template variable: coerced (`Number` /
      `escapeHtml` / `JSON.stringify`).

## 7. Bench data (reference)

On `samples/huge.csv` (2 GB, 43 M lines), cache hot, 12-core machine:

| Operation | Target |
|---|---|
| Open + parallel index | < 5 s |
| Search literal needle 4-9 chars | 4–6 s |
| Save in-place (3 lines same size) | < 50 ms |
| Save surgical rewrite (3 lines, different size) | ~6 s |
| Save reindex via `patchSparseIndex` (single-line only) | < 50 ms (vs ~9 s full rebuild) |
| Scroll / hit nav | perceived 60 fps, never blocking |

Any regression > 20 % on these targets must be justified.
