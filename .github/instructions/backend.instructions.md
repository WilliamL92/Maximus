---
applyTo: "src/**/*.ts"
description: "Backend rules (Node extension + worker_threads)"
---

# Backend extension (TypeScript / Node)

## Context
Code that runs in VS Code's Extension Host process. Targets Node 18+.
Any expensive operation must be delegated to `worker_threads` or bounded by
streamed chunks.

## Rules
- **No `*Sync`** filesystem calls (`readFileSync`, `statSync`, etc.) on the
  main thread.
- **No `await fs.promises.readFile(path)` without an explicit cap** on a
  potentially huge file. Use `createReadStream` or a `fd.read` loop.
- To traverse the file: go through `SparseLineIndex.offsets` to get exact
  boundaries aligned on line starts. Do not re-scan to align.
- Workers: `new Worker(path.join(__dirname, 'xxxWorker.js'))`. Always
  capture `error` and `exit`. On abort, `worker.terminate()` immediately.
- Worker → main messages: use **Transferable** for typed arrays
  (`postMessage(msg, [buf.buffer])`) for zero-copy. Allocate a fresh
  buffer for the next batch.
- Progress: throttle to **per-mille** or **80 ms** on the main side
  before postMessage to the webview. On the worker side, emitting on
  every chunk is fine (the main aggregates and throttles).
- No JS regex on the main thread for large volumes: confine to the
  worker (cf. `searchWorker.ts:runRegex`).
- `Buffer.indexOf(needle)` (memmem SIMD) > any byte-by-byte JS loop.
- HitStore: store, not a `Hit[]`. Read via `hitsInRange / at /
  firstAtOrAfter / lastAtOrBefore`.
- Save: try `EditOverlay.tryInPlace()` (pwrite, bytes-equivalent edits)
  before `surgicalRewrite()`. The latter uses a ping-pong I/O pipeline
  (next read started before awaiting current write) on two 16 MB
  reusable buffers. When `save()` returns `shifts !== null`, patch the
  sparse index in O(N/step) via `patchSparseIndex` rather than rebuild.

## Anti-patterns
- ❌ `JSON.stringify(hits)` or `postMessage(hits)` with hits = millions
  of entries — explodes serialization cost.
- ❌ `Buffer.concat([a, b])` in a hot loop when a small carry across two
  buffers would do.
- ❌ `Promise.all(allWorkers)` without abort propagation → zombie workers.
- ❌ Blocking on a useless `await` in a loop that could run in parallel.

## Security
- **Tmp files**: build via `<file>.maximus-tmp-<Date.now()>-<crypto.randomBytes(8).hex>`,
  open with `'wx'` (`O_EXCL`) so a pre-existing symlink/file fails the
  open. Always `unlink(tmp)` in a `catch` on every error path. Never
  use predictable names (`<file>.tmp`, `<file>.tmp-<ts>` alone).
- **Webview message dispatch**: every `case` in `onMessage` validates
  `msg` fields at the boundary — `Number.isInteger` for indices,
  `typeof === 'string'` + length cap for strings. Edits ≤ 8 MiB,
  query/replacement ≤ 64 KiB. **Validation runs once per message**
  (cheap, never inside a per-line loop).
- **Errors → webview**: route every forwarded error through
  `safeErrorMessage(e)` (first line of `e.message`, ≤ 500 chars). Never
  postMessage an `err.stack` or full `String(err)`.
- **CSP nonce**: `crypto.randomBytes(>=16)`. **Never** `Math.random`.
- **Template interpolation**: any `${x}` in the HTML template is coerced
  (integers via `Number`/bounded `Math.floor`, strings via `escapeHtml`,
  JSON via `JSON.stringify`).

## Tests / bench
No test framework installed for now. To validate a hot-path change:
1. `npm run compile`
2. Ad-hoc Node script in `/tmp/bench-*.js` requiring
   `out/parallelSearch.js` etc.
3. Measure 2-3 cache-hot runs, take the min/median.
