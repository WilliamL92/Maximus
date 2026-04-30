# Maximus

VS Code extension to **open, browse, search and edit text files of
several hundred GB** without saturating RAM or disk.

VS Code natively refuses files > ~50 MB (and would load them entirely in
memory). This extension works around the problem with **streaming +
virtual rendering + worker pool + sparse index**.

## Performance targets

On `samples/huge.csv` (2 GB, 43 M lines), 12-core machine, cache hot:

| Operation | Time |
|---|---|
| Open + parallel index | ~3 s |
| Literal search (needle 4-9 chars) | 4–6 s |
| Literal search (rare needle) | 4–5 s |
| **In-place** save (3 lines same size) | **< 50 ms** |
| **Surgical rewrite** save (3 lines, different size) | ~6 s |
| Scroll / hit navigation | perceived 60 fps |

The surgical rewrite uses a ping-pong I/O pipeline (next chunk read in
parallel with current write, two reusable 16 MB buffers). For single-line
edits that don't change the total `\n` count, the sparse index is patched
incrementally (`patchSparseIndex`) rather than rebuilt from scratch —
O(N/step) instead of O(file_size).

## Architecture

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

### Key strategies

| Concern | Solution |
|---|---|
| Don't load 500 GB in RAM | `fs.read(fd, buf, 0, n, offset)` — only read displayed lines via the index offsets |
| Know the position of every line | **`SparseLineIndex`**: 1 offset every 1000 lines (~40 MB for 5 G lines). Resolution = anchor + local scan ≤ 1000 bytes |
| Index quickly at open | **`parallelBuildIndex`**: worker pool (1 per core), Float64Array of line-starts via Transferable |
| Fast search | **`parallelSearch`**: worker pool, ranges aligned on anchors, `Buffer.indexOf` (memmem SIMD libc), linear memmem-stride scan |
| Store tens of millions of hits | **`HitStore`**: `Int32Array×2 + Int16Array` = 10 bytes/hit, binary search `hitsInRange(lo, hi)` in O(log N) |
| Lightweight webview | The webview does **not** own the full hits list; it requests `queryHitsRange` for its visible window only |
| Scrollbar for 40 M lines | Spacer compressed to `MAX_SPACER_PX = 30_000_000`; `scale = spacer/virtual`; conversions via `virtualScrollTop()` / `realScrollTopFromVirtual()` |
| Syntax highlighting | Stateless `highlight.js`, **only on visible lines** (~50). Subset bundle ~160 KB, loaded once at webview start (no per-line / per-file allocation) |
| Editing | **In-RAM overlay**: `Map<line, newContent>` + insertions/deletions. RAM = O(edited lines), not O(file) |
| Fast save | 1) **`tryInPlace()`** (fast path): if all edits are bytes-equivalent → `pwrite` at exact offsets, **no copy**. 2) **`surgicalRewrite()`**: pure binary copy with **ping-pong I/O** (read N+1 while writing N) on two reusable 16 MB buffers, zero UTF-8 decode for unchanged regions, atomic `rename` → returns a `shifts[]` list when edits are single-line so the index can be **patched in O(N/step)** via `patchSparseIndex` instead of fully rebuilt |
| UI progress | Throttle to **per-mille** or 80 ms, never one `postMessage` per chunk |

### Components

- [src/extension.ts](src/extension.ts) — entry point.
- [src/customEditor.ts](src/customEditor.ts) — `CustomEditorProvider`, webview message dispatch, drives search/save/replace/index.
- [src/lineIndex.ts](src/lineIndex.ts) — `SparseLineIndex`.
- [src/parallelIndex.ts](src/parallelIndex.ts) + [src/indexWorker.ts](src/indexWorker.ts) — parallel indexing.
- [src/parallelSearch.ts](src/parallelSearch.ts) + [src/searchWorker.ts](src/searchWorker.ts) — parallel search.
- [src/hitStore.ts](src/hitStore.ts) — compact hit storage.
- [src/editOverlay.ts](src/editOverlay.ts) — edits overlay + 2-path save.
- [src/fileReader.ts](src/fileReader.ts) — line range reads via the index.
- [media/main.js](media/main.js) — virtual scroll, hits cache, search bar, edit mode.

## Syntax highlighting choice (R&D)

Three options considered, **option 3 picked**:

1. **TextMate (`vscode-textmate` + `vscode-oniguruma`)** — max VS Code fidelity, but oniguruma WASM (~250 KB), stateful per-line state (impossible to apply mid-file), heavy grammars.
2. **Shiki** — gorgeous, but JSON theme + grammars + WASM = several MB at startup.
3. **highlight.js (subset)** — stateless line-by-line, ~160 KB after tree-shaking (~35 languages), no WASM. Optimal perf/quality trade-off since we only highlight ~50 visible lines.

## Supported file formats

Maximus is registered as an **optional** custom editor for **every file**
(`filenamePattern: "*"`, `priority: "option"`). It never replaces the
default editor — it just appears in **Open With…** for any file you
right-click. Unknown extensions are rendered in plain text using the
current VS Code theme color (no highlighting, no extra cost).

Syntax-highlighted languages (subset of highlight.js bundled at build):

- **Data / config**: `.json`, `.json5`, `.jsonl`, `.ndjson`, `.geojson`, `.har`, `.yaml`, `.yml`, `.toml`, `.ini`, `.conf`, `.cfg`, `.properties`, `.env`, `.xml`, `.html`, `.htm`, `.svg`, `.xhtml`, `.xsl`, `.xsd`, `.rss`, `.atom`, `.plist`
- **Delimited (custom renderer)**: `.csv`, `.tsv`, `.psv` (pipe-separated)
- **Docs / diff**: `.md`, `.markdown`, `.diff`, `.patch`
- **Query / shell**: `.sql`, `.sh`, `.bash`, `.zsh`, `.ksh`, `.ps1`, `.psm1`
- **Web / styling**: `.css`, `.scss`, `.sass`, `.less`
- **Programming**: `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.tsx`, `.py`, `.pyw`, `.java`, `.kt`, `.kts`, `.scala`, `.go`, `.rs`, `.c`, `.h`, `.cpp`, `.cxx`, `.cc`, `.hpp`, `.hh`, `.cs`, `.swift`, `.m`, `.mm`, `.php`, `.rb`, `.pl`, `.pm`, `.lua`, `.r`, `.dart`, `.groovy`, `.gradle`
- **Build files**: `Dockerfile`, `*.dockerfile`, `Makefile`, `GNUmakefile`
- **Plain**: `.log`, `.txt`, `.text`, `.huge`

Any other extension → plain-text rendering (no `hljs.highlight` call,
no per-line allocation cost).

## Cross-platform

Works on Linux, macOS and Windows. The save path uses standard
`fs.promises.open` / `read` / `write` / `rename` (no `fallocate` or other
platform-specific syscall), and the worker pool is sized via
`os.availableParallelism()`.

## Known limitations

- Encoding: **UTF-8 only** for now (UTF-16/Latin-1 to come).
- A single line > ~64 KB may be visually truncated.
- The edit overlay stays in RAM until save — avoid editing millions of lines without saving.
- No "tail -f" mode yet (live tracking of an appended file).

## Install

- **From the VS Code Marketplace**: search `maximus1.maximus` (or `Maximus`) in the Extensions panel, or [open in Marketplace](https://marketplace.visualstudio.com/items?itemName=maximus1.maximus).
- **From a GitHub Release**: download `maximus-<version>.vsix` from [Releases](https://github.com/WilliamL92/Maximus/releases) and run `Extensions: Install from VSIX…` in VS Code.

## Usage

1. Right-click on a file → **Open With…** → **Maximus**, or run the command `Maximus: Open current file`
2. `Ctrl+F` to search, `Ctrl+H` to replace, `Ctrl+G` to **go to line**, `Ctrl+S` to save, double-click on a line to edit

### Local development

```bash
npm install                 # installs + bundles highlight.js
# F5 in VS Code → "Extension Development Host"
# or build + install a local .vsix:
npm run compile
npx --yes @vscode/vsce package
code --install-extension maximus-<version>.vsix --force
```

## Release

Pushes to `master` trigger [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) which:

1. reads `version` from `package.json`
2. skips if the tag `v<version>` already exists (idempotent — bump the version to release)
3. packages the `.vsix`, publishes it to the VS Code Marketplace (uses the `VSCE_PAT` repo secret)
4. creates the git tag `v<version>` and a GitHub Release with the `.vsix` attached

To cut a release: bump `version` in `package.json`, commit, push to `master`.

### Keyboard & mouse navigation

Maximus exposes a real text-editor caret (vertical bar + arrow-key
navigation + selection) on top of the virtualized line view. Caret state
is 2 ints (`{line, col}`); selection is rendered as ≤ 1 `<div>` per
visible line — O(visible), no extension round-trip.

| Action | Behavior |
|---|---|
| **Click** | Place caret at exact char position, clear selection |
| **Shift+Click** | Extend selection from caret to click position |
| **Drag** (mouse held) | Free selection. Past the viewport edge: auto-scroll **1 line every 50 ms** for precise selection |
| **↑ / ↓** | Move caret 1 line. The viewport stays still — only auto-scrolls by 1 line if the caret would leave the visible window |
| **← / →** | Move caret 1 char, wraps across line breaks |
| **Shift+arrows** | Extend selection |
| **PageUp / PageDown** | Move caret one viewport-height |
| **Home / End** | Start / end of current line |
| **Ctrl+Home / Ctrl+End** | Top / bottom of file |
| **Double-click**, **F2**, **Enter**, or any printable key | Enter edit mode at caret line |
| **Esc** in edit mode | Commit and return to navigation mode |
| **Native scrollbar ▲ / ▼ click** | Scrolls **exactly 1 virtual line** — even at extreme compression where 1 real px ≈ many lines. The caret is not touched |
| **Ctrl+G** | Open the **Go to Line** bar. Accepts `123` or `123:45` (line:column, 1-based). Enter to jump, Esc to cancel. The viewport is centered on the target line and the caret is placed at the requested position |

## Configuration

| Key | Default | Description |
|---|---|---|
| `maximus.indexEveryNLines` | 1000 | Sparse index step |
| `maximus.bufferLines` | 20 | Lines pre-loaded off-screen |
| `maximus.searchWorkers` | 0 (= auto via `os.availableParallelism()`) | Number of workers for search/index |
| `maximus.autoOpenThresholdMB` | 50 | (placeholder for automatic suggestion) |
| `maximus.maxHitsInWebview` | 100000 | Max search hits sent to the webview for navigation/highlighting |

## Security

Hardening that applies to every release (see
[.github/copilot-instructions.md](.github/copilot-instructions.md) §
*Security* for the rules an agent must follow):

- **Strict CSP** in the webview: `default-src 'none'`, scripts only via
  per-load nonce, no `'unsafe-eval'`. Inline values interpolated into the
  HTML template are coerced to safe types (`Number`, `escapeHtml`).
- **Cryptographic CSP nonce** generated via `crypto.randomBytes(24)`
  (never `Math.random`).
- **Webview line rendering** always escapes the source line before
  injection (`escapeHtml` for plain text, `hljs.highlight().value` /
  `colorizeDelimited` for highlighted modes — both escape internally).
  Status / error labels use `textContent`, never `innerHTML`.
- **Atomic save with safe tmp files**: `<file>.maximus-tmp-<ts>-<rand>`
  (8 random bytes from `crypto.randomBytes`) opened with `O_EXCL`
  (`'wx'`) so a pre-existing symlink/file is rejected. Tmp is unlinked
  on any error path; orphans from a previous crash are cleaned up at
  open.
- **Boundary input validation** on every webview → extension message
  (range / type / size checks). Edited line content is capped at
  8 MiB; search and replacement strings at 64 KiB.
- **Sanitized error reporting**: errors forwarded to the webview keep
  only the first line of `e.message`, capped at 500 chars (no stack
  traces, no full filesystem paths).
- **Worker isolation**: search and indexing run in `worker_threads`. A
  pathological user-supplied regex hangs only the worker, never the
  extension host; the user can cancel via the search bar
  (`cancelSearch` terminates the workers immediately).

## For contributors / AI agents

Architecture rules, anti-patterns and bench targets are documented in:

- [.github/copilot-instructions.md](.github/copilot-instructions.md) — global rules (auto-loaded by Copilot)
- [.github/instructions/backend.instructions.md](.github/instructions/backend.instructions.md) — `src/**/*.ts`
- [.github/instructions/webview.instructions.md](.github/instructions/webview.instructions.md) — `media/**`
- [.github/instructions/workers.instructions.md](.github/instructions/workers.instructions.md) — workers
- [AGENTS.md](AGENTS.md) — generic mirror for Claude Code / Cursor / Aider / Cody
