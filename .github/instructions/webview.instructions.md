---
applyTo: "media/**"
description: "Webview / front rules (vanilla JS, virtual scroll)"
---

# Webview / front (vanilla JS)

## Context
Code that runs in a VS Code webview iframe. No bundler, no framework,
no TypeScript. Vanilla JS loaded via `<script>` from the extension.

## Rules
- **Render via rAF**. No DOM manipulation in a synchronous loop outside a
  `requestAnimationFrame`.
- **Virtual scroll mandatory**: NEVER render every line of the file in
  the DOM. The visible window (`visibleStart`/`visibleEnd`) plus a buffer
  (`cfg.bufferLines`) is the only thing in `rendered`.
- **Hits**: the webview does NOT own `state.hits[]`. It requests
  `queryHitsRange(lineFrom, lineTo)` for its visible window (60 ms
  debounce via `requestVisibleHits`). Inter-hit navigation goes through
  `queryHitNav` (next/prev/first/last/index/atOrAfter).
- **Virtual scrollbar**: `MAX_SPACER_PX = 30_000_000`. If
  `virtualHeight > MAX_SPACER_PX`, compress via `scale`. Every
  scrollTop ↔ virtualPos conversion must go through `virtualScrollTop()`
  / `realScrollTopFromVirtual()`. **Never use raw `scrollTop` without
  going through these helpers.**
- **"At bottom" detection**: use `endSnapPx()` proportional to
  `scale * lineHeight`, never a constant in px.
- **Anchored mode**: `state.anchorLine >= 0` ⇒ render computes
  `firstVisible` directly from the anchor, ignores `scrollTop`. The flag
  `state.programmaticScroll` distinguishes user scroll (releases the
  anchor) from programmatic scroll (preserves it).
- **Line cache**: `state.cache` (Map). Prune with `pruneCache` on every
  render to stay around 2000 entries max.
- Search input: **250 ms** debounce on `input`. Enter is immediate.
- Syntax highlight: highlight.js but **per line only** (no global
  highlight). Cache via `state.highlightCache` if relevant.
- **Caret + selection model**: a real text-editor caret lives outside
  any contenteditable. State = `state.caret = {line, col}` and
  `state.selAnchor = {line, col} | null` — **2 ints + 2 ints, O(1)**.
  Selection rendering = ≤ 1 absolutely-positioned `.sel-line` div per
  visible selected line + 1 `.caret` div, all wiped and rebuilt every
  `render()` (O(visibleCount) ≈ ≤ 60 nodes). Never store per-char
  selection state.
- **Char/line geometry**: `state.charWidth` is measured ONCE at file
  open via an inline-block probe span (NOT inside `.row` — `.content`
  is `flex:1` and would return the stretched width). `posFromEvent`
  uses `document.elementFromPoint` and reads the row's `data-line`
  directly, NOT `floor(y / lineHeight)` — float drift on `lineHeight`
  accumulates over thousands of scrolled lines and would put the caret
  several lines off. Caret/selection rendering reads each row's
  `offsetTop` for the same reason.
- **Drag-select auto-scroll**: when the mouse exits the viewport during
  a drag, scroll **exactly 1 line every 50 ms** (`startAutoScroll`).
  Predictable & precise; do NOT rely on the browser's burst-scroll.
- **Scrollbar arrow snap**: a small user-initiated scroll delta
  (< 60 real px, no recent wheel/key) is snapped to **±1 *virtual*
  line** via `realScrollTopFromVirtual((firstVisible±1) * lh)` — NOT
  via `lastScrollTop ± lh` real px, which in compressed mode (huge
  files) would still scroll many virtual lines. The caret is left
  untouched. Track via `lastWheelAt` / `lastKeyScrollAt` to avoid
  interfering with wheel/drag.

## Anti-patterns
- ❌ `state.hits = [...allHits]`.
- ❌ `rendered.innerHTML = '<div class="row">...</div>'.repeat(totalLines)`.
- ❌ `viewport.scrollTop = anyVirtualPx` — go through `realScrollTopFromVirtual`.
- ❌ Repeated `setTimeout(render, 0)` — use rAF.
- ❌ `scroll` listeners doing heavy work directly (no debounce/rAF).
- ❌ Storing the entire file text in `state` (read lines = windowed
  cache only).
- ❌ Storing per-character selection state, or one DOM node per selected
  character. Selection = anchor+head only.
- ❌ Measuring `charWidth` from `.content` (flex-stretched) — use an
  out-of-flex inline-block probe.
- ❌ Calling `posFromEvent` via `caretRangeFromPoint`/DOM walk on
  `mousemove` — use the geometry-only formula.

## Communication with the extension
- `vscode = acquireVsCodeApi()` at the very start.
- Every `postMessage` that expects a response carries a `requestId`.
  Late responses must be ignored if `requestId !== state.xxxReqId`.
- Known messages (extension → webview): `init`, `lines`, `searchCount`,
  `searchProgress`, `searchDone`, `hitsRange`, `hitNav`, `saveStart`,
  `saveProgress`, `saveStage`, `saved`, `saveError`, `replaceProgress`,
  `replaceStage`, `replaceCancelled`, `error`.- **Go to Line (Ctrl+G)** is fully webview-side: parse `\d+(?::\d+)?`,
  `jumpToLine(line)` to center via the anchored mode, then
  `setCaret({line, col}, false, false, /*scrollIntoView*/false)` so the
  caret lands at the exact position without re-scrolling. No extension
  round-trip required — the line index resolution happens lazily on the
  next render through the existing `requestRange` path.