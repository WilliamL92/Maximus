---
applyTo: "src/{searchWorker,indexWorker}.ts"
description: "Rules specific to worker_threads (CPU-bound, isolated)"
---

# Workers (CPU-bound)

## Context
Code that runs in a `worker_threads`. Isolated from main: no access to
`vscode.*`, no DOM, no `console.log` (will be silent). Communication
exclusively via `parentPort.postMessage`.

## Rules
- **Reuse buffers**: a single `Buffer.allocUnsafe(CHUNK)` per worker,
  never one per read chunk. For buffers transferred to main, allocate
  the next batch fresh.
- **Transferables**: post typed arrays via `[arr.buffer]` as the 2nd
  argument of `postMessage`. **Never reuse a buffer after transferring
  it** (it is neutered).
- **Batch size** = 16,384 hits (192 KB in `Int32×2 + Int16`). Aligned
  with `HIT_CHUNK_SIZE` in [hitStore.ts](../../src/hitStore.ts).
- **Range boundaries**: received from main, **aligned on line starts**
  via `SparseLineIndex.offsets`. Do not re-align.
- **Counting `\n`**: use `Buffer.indexOf(0x0a, from)` or a tight
  byte-by-byte loop. Never `toString` then split.
- **No regex on the literal path**. The regex path is separate
  (`runRegex`), much slower, and should only be used if `opts.isRegex`
  is true.
- **Literal scan algorithm** (cf. O(N²) bug fix): linear traversal of
  the chunk jumping match-to-match via `Buffer.indexOf`. Count `\n`s
  between matches to keep `lineNo` up to date. **Never** look up the
  pattern bounded by "end of line" via a search through the entire
  remaining chunk — that's O(chunk × lines).
- Whole-word: check `before` and `after` bytes directly, no string
  conversion.
- Case-insensitive: precompute `lookup = toLowerAscii(combined)` once
  per chunk. Not per line.

## Anti-patterns
- ❌ `parentPort.postMessage({hits: bigArray})` without transferable.
- ❌ `Buffer.allocUnsafe(CHUNK)` on every iteration of the read loop
  (unless transferred).
- ❌ `chunk.toString('utf8')` to scan (UTF-8 decode is expensive; stay
  in bytes via `Buffer.indexOf`).
- ❌ `JSON.stringify` in the worker for transfer.
- ❌ `console.log` (will be silent).
- ❌ Scan loop without any yield if the segment is huge (depends on
  usage — currently OK since main throttles the UI).

## Minimal UTF-8 decoding
To compute the **column** of a hit (= number of Unicode chars before the
match on the line), we must decode the prefix to a string:
```ts
const prefix = combined.slice(lineStart, found).toString('utf8');
emit(curLine, prefix.length, matchStr.length);
```
This is the only place we accept a UTF-8 cost — and it is bounded to the
width of a line, not the chunk.
