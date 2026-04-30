# Agent guide

This file is a generic mirror of the project rules for non-Copilot AI agents
(Claude Code, Cursor, Cody, Aider, etc.). The full and authoritative source
is [.github/copilot-instructions.md](.github/copilot-instructions.md).

## TL;DR

This is a VS Code extension that opens 100+ GB text files. **Performance is
the product.** Every change must respect:

1. **No O(file_size) work on the main thread, ever.** Use streaming, sparse
   indices, and `worker_threads`.
2. **No full-file allocations in RAM.** The `SparseLineIndex` stores only
   one offset per 1000 lines; the `EditOverlay` stores only edited lines;
   the webview caches only visible lines.
3. **HitStore, not Hit[].** Search results live in compact typed arrays
   (10 bytes/hit). The webview queries `queryHitsRange` for its visible
   window only.
4. **Transferable typed arrays** for worker ↔ main IPC. Reuse buffers.
5. **Throttle UI progress** to per-mille or 80 ms.
6. **Save in-place when possible** (`pwrite` if bytes-equivalent), fall
   back to surgical binary rewrite (16 MB buffers, ping-pong I/O
   pipeline, no UTF-8 decode of unchanged regions). When edits are
   single-line only, patch the sparse index incrementally via
   `patchSparseIndex` instead of a full rebuild.
7. **Virtual scrollbar is compressed** above 30 Mpx. All scroll math goes
   through `virtualScrollTop()` / `realScrollTopFromVirtual()`. Bottom
   detection uses `endSnapPx()`, not a constant.
8. **Security**: CSP nonce from `crypto.randomBytes` (never `Math.random`);
   tmp files use `<file>.maximus-tmp-<ts>-<random>` opened with `'wx'`
   (`O_EXCL`) and cleaned up on error; every webview message is type/range
   /size validated at the dispatch boundary; errors forwarded to the
   webview go through `safeErrorMessage` (first line of `e.message`, no
   stack trace). Full rules in
   [.github/copilot-instructions.md § Security](.github/copilot-instructions.md).

## Where things live

- `src/extension.ts` — entry point.
- `src/customEditor.ts` — main provider, message dispatch.
- `src/lineIndex.ts` — sparse index data structure.
- `src/parallelIndex.ts`, `src/indexWorker.ts` — parallel indexing.
- `src/parallelSearch.ts`, `src/searchWorker.ts` — parallel search.
- `src/hitStore.ts` — compact hit storage.
- `src/editOverlay.ts` — edits + save (in-place + surgical rewrite).
- `src/fileReader.ts` — random line reads via the index.
- `media/main.js` — webview: virtual scroll, search bar, edit overlay.
- `media/main.css` — styles.

## Workflow

```bash
npm run compile             # tsc → out/
# bench in /tmp/bench-*.js if you touched a hot path
# bump version in package.json
npx --yes @vscode/vsce package --allow-missing-repository
code --install-extension maximus-<version>.vsix --force
# reload VS Code window
```

## Hard rules

See [.github/copilot-instructions.md](.github/copilot-instructions.md) for
the full list, anti-patterns, review checklist, and bench targets.

The scoped rule files in `.github/instructions/` apply automatically to
matching paths in Copilot; for other agents, read them when working on the
matching files:

- [.github/instructions/backend.instructions.md](.github/instructions/backend.instructions.md) — `src/**/*.ts`
- [.github/instructions/webview.instructions.md](.github/instructions/webview.instructions.md) — `media/**`
- [.github/instructions/workers.instructions.md](.github/instructions/workers.instructions.md) — `src/{searchWorker,indexWorker}.ts`
