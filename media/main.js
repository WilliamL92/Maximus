/* global acquireVsCodeApi, hljs */
(() => {
  const vscode = acquireVsCodeApi();
  const cfg = window.HFV_CONFIG || { bufferLines: 20 };

  const viewport = document.getElementById('viewport');
  const spacer = document.getElementById('spacer');
  const rendered = document.getElementById('rendered');
  const statusEl = document.getElementById('status');
  const dirtyEl = document.getElementById('dirty');
  const saveBtn = document.getElementById('saveBtn');
  const saveIndicator = document.getElementById('saveIndicator');
  const saveLabel = document.getElementById('saveLabel');
  const progressBar = document.getElementById('progressBar');
  const progressFill = document.getElementById('progressFill');
  const progressLabel = document.getElementById('progressLabel');
  const searchBar = document.getElementById('searchBar');
  const searchInput = document.getElementById('searchInput');
  const searchCount = document.getElementById('searchCount');
  const csCheck = document.getElementById('caseSensitive');
  const wwCheck = document.getElementById('wholeWord');
  const reCheck = document.getElementById('isRegex');
  const replaceRow = document.getElementById('replaceRow');
  const replaceInput = document.getElementById('replaceInput');
  const replaceAllBtn = document.getElementById('replaceAllBtn');
  const replaceProgress = document.getElementById('replaceProgress');
  const searchProgressBar = document.getElementById('searchProgressBar');
  const searchProgressFill = searchProgressBar.querySelector('.mxs-mini-fill');
  const searchProgressLabel = searchProgressBar.querySelector('.mxs-mini-label');
  const replaceProgressBar = document.getElementById('replaceProgressBar');
  const replaceProgressFill = replaceProgressBar.querySelector('.mxs-mini-fill');
  const replaceProgressLabel = replaceProgressBar.querySelector('.mxs-mini-label');
  const gotoBar = document.getElementById('gotoBar');
  const gotoInput = document.getElementById('gotoInput');
  const gotoHint = document.getElementById('gotoHint');

  const state = {
    totalLines: 0,
    lineHeight: 18,
    language: 'plaintext',
    cache: new Map(),       // line -> string
    pending: new Map(),     // requestId -> {start,end}
    inFlight: new Set(),    // line numbers currently requested (dedupe across renders)
    nextReqId: 1,
    visibleStart: 0,
    visibleEnd: 0,
    dirty: false,
    // --- Search ---
    // No more local hit storage: the source of truth is the extension
    // (compact typed arrays in HitStore). The webview only loads visible
    // hits via a `queryHitsRange` request per scroll window, and the
    // current hits via `queryHitNav`. Webview RAM: O(visible).
    totalHits: 0,
    searchActive: false,         // search in progress (streaming counter)
    currentHit: null,            // current {line, column, length, index}
    currentHitIndex: -1,         // -1 = none selected
    /** Cache of hits per line for the window covering the visible area. */
    hitsByLine: new Map(),       // line -> [{column, length, index}]
    /** Range [from,to] covered by the current cache (-1 = empty / invalid). */
    cachedFrom: -1,
    cachedTo: -1,
    /** requestId of the last queryHitsRange sent (anti-late-response). */
    rangeReqId: 0,
    /** Throttle of range requests during scrolling. */
    rangeReqDebounce: null,
    /** requestId of the last queryHitNav sent. */
    navReqId: 0,
    searchReqId: 0,
    currentEditing: null,   // line number being edited
    // Navigation anchor: when we jump to a specific line (gotoHit, jump-to),
    // we store here the line number to display in the center of the
    // viewport. render() honors this anchoring in priority over the
    // calculation derived from scrollTop, which suffers from precision
    // loss when the virtual scrollbar is compressed (files of several
    // million lines).
    anchorLine: -1,
    /** Pin the FIRST visible line directly, bypassing scrollTop math.
     *  Used by the scrollbar arrow snap path: in compressed mode the
     *  ratio scrollTop/maxScroll has < 1 line of resolution, so writing
     *  a new scrollTop is a no-op. Setting this field makes render()
     *  display exactly that line at the top, regardless of scrollTop.
     *  Cleared on any user wheel/key/drag/click. -1 = inactive. */
    topAnchorLine: -1,
    programmaticScroll: false,
    // Indexing state: search and replace are queued as long as `indexReady`
    // is false, and a clear message is shown to the user. The progress
    // bars for indexing, search and replace display a percentage rounded
    // to one decimal (toFixed(1)).
    indexReady: false,
    pendingSearch: false,   // Ctrl+F request issued before the index finished
    /** True during a Replace All: editing is blocked to avoid a local
     *  setLine being overwritten by the file rewrite on disk. */
    replaceLocked: false,
    pendingReplace: null,   // {query, replacement, ...} if requested too early
    // Virtual scrollbar: browsers cap an element's height at ~33.5M px.
    // For files of millions of lines we have to "compress" the scrollbar
    // and remap scrollTop.
    virtualHeight: 0,       // totalLines * lineHeight (logical space)
    spacerHeight: 0,        // actual spacer height (≤ MAX_SPACER_PX)
    scale: 1,               // spacerHeight / virtualHeight (≤1)
    // ---- Navigation caret + selection -------------------------------
    // Real text-editor-style caret that exists outside contenteditable.
    // - `caret` = current head position {line, col}.
    // - `selAnchor` = anchor of an active selection, or null.
    // - `preferCol` = column kept across vertical moves (Up/Down) so
    //   crossing short lines doesn't permanently shrink the column.
    // - `charWidth` = monospace char width measured at init; used to map
    //   col ↔ x without DOM measurement on every render (O(1) per row).
    caret: null,            // { line, col } | null until first interaction
    selAnchor: null,        // { line, col } | null
    preferCol: 0,
    charWidth: 0,
    // Mouse drag-select. We keep the pointerId and a periodic auto-scroll
    // timer that steps ±1 line every ~50 ms when the mouse is past the
    // viewport edge — explicit precision over the default browser
    // burst-scroll.
    dragSelecting: false,
    dragPointerId: -1,
    autoScrollTimer: 0,
    autoScrollDir: 0,
    lastMouseClientX: 0,
    // Scrollbar arrow snap: track scrollTop deltas. When a small
    // user-initiated scroll happens (no preceding wheel/key/programmatic),
    // we snap to ±1 line — matches what clicking the native scrollbar
    // arrow buttons does.
    lastScrollTop: 0,
    lastWheelAt: 0,
    lastKeyScrollAt: 0,
    snapEnabled: true,
  };
  const MAX_SPACER_PX = 30_000_000;

  // Tells the extension that the webview is ready to receive messages.
  vscode.postMessage({ type: 'webviewReady' });

  function setStatus(s) { statusEl.textContent = s; }
  function setProgress(pct, label) {
    if (pct == null) {
      progressBar.classList.add('indeterminate');
      progressFill.style.width = '';
    } else {
      progressBar.classList.remove('indeterminate');
      progressFill.style.width = Math.max(0, Math.min(100, pct)) + '%';
    }
    if (label !== undefined) progressLabel.textContent = label;
  }
  function hideProgress() { progressBar.classList.add('hidden'); }
  function showProgress() { progressBar.classList.remove('hidden'); }
  function setDirty(d) {
    state.dirty = d;
    dirtyEl.textContent = d ? '● modified' : '';
  }

  /** Updates a mini-bar (search/replace). pct: 0..100 or null to hide. */
  function setMiniProgress(barEl, fillEl, labelEl, pct, prefix) {
    if (pct == null) {
      barEl.classList.add('hidden');
      fillEl.style.width = '0%';
      return;
    }
    barEl.classList.remove('hidden');
    const clamped = Math.max(0, Math.min(100, pct));
    fillEl.style.width = clamped + '%';
    labelEl.textContent = `${prefix} ${clamped.toFixed(1)}%`;
  }
  function setSearchProgress(pct) {
    setMiniProgress(searchProgressBar, searchProgressFill, searchProgressLabel, pct, 'Searching…');
  }
  function setReplaceProgress(pct, replacements, stage) {
    if (pct == null) {
      setMiniProgress(replaceProgressBar, replaceProgressFill, replaceProgressLabel, null, '');
      return;
    }
    const clamped = Math.max(0, Math.min(100, pct));
    replaceProgressBar.classList.remove('hidden');
    replaceProgressFill.style.width = clamped + '%';
    const prefix = stage === 'reindex' ? 'Reindexing' : 'Replacing';
    const suffix = (stage !== 'reindex' && replacements != null)
      ? ` (${replacements.toLocaleString()})`
      : '';
    replaceProgressLabel.textContent = `${prefix}… ${clamped.toFixed(1)}%${suffix}`;
  }

  // ---- Layout ------------------------------------------------------------
  function measureLineHeight() {
    const probe = document.createElement('div');
    probe.className = 'row';
    probe.innerHTML = '<span class="gutter">1</span><span class="content">M</span>';
    rendered.appendChild(probe);
    const h = probe.getBoundingClientRect().height || 18;
    rendered.removeChild(probe);
    state.lineHeight = h;
    document.documentElement.style.setProperty('--line-height', h + 'px');
  }

  /**
   * Measures the width of a monospace character, in CSS pixels. Called
   * once after measureLineHeight(). Result cached on `state.charWidth`
   * so caret/selection rendering stays O(1) per row instead of doing a
   * DOM measurement per click.
   *
   * Note: `.content` uses `flex: 1` which would stretch its bounding
   * rect to the full row width, completely defeating any measurement.
   * We instead append an *inline-block* probe span with `white-space:pre`
   * and the editor font, outside the flex layout, so its width reflects
   * the actual rendered text width.
   */
  function measureCharWidth() {
    const probe = document.createElement('span');
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.display = 'inline-block';
    probe.style.whiteSpace = 'pre';
    probe.style.fontFamily = getComputedStyle(document.body).fontFamily;
    probe.style.fontSize = getComputedStyle(document.body).fontSize;
    probe.textContent = 'M'.repeat(200);
    document.body.appendChild(probe);
    const w = probe.getBoundingClientRect().width / 200;
    document.body.removeChild(probe);
    state.charWidth = w > 0 ? w : 8;
  }

  /** Returns the gutter+padding offset (left of the very first column). */
  function contentLeftOffset() {
    const css = getComputedStyle(document.documentElement);
    const gutter = parseFloat(css.getPropertyValue('--gutter-width')) || 70;
    // .gutter is content-box: real width = 70 + padding-right(12).
    // .content adds its own padding-left: 12. So text starts at 70+12+12.
    return gutter + 12 + 12;
  }

  // ---- Rendering ---------------------------------------------------------
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function highlight(line) {
    if (state.language === 'csv') return colorizeDelimited(line, ',');
    if (state.language === 'tsv') return colorizeDelimited(line, '\t');
    if (state.language === 'psv') return colorizeDelimited(line, '|');
    if (state.language === 'plaintext' || !window.hljs) {
      return escapeHtml(line);
    }
    // Resolved once: avoids a per-line getLanguage lookup and allows us to
    // bail early to plaintext if the language wasn't bundled.
    if (state.hljsLang === undefined) {
      state.hljsLang = hljs.getLanguage(state.language) ? state.language : null;
    }
    if (!state.hljsLang) return escapeHtml(line);
    try {
      return hljs.highlight(line, { language: state.hljsLang, ignoreIllegals: true }).value;
    } catch {
      return escapeHtml(line);
    }
  }

  function colorizeDelimited(line, sep) {
    // Very lightweight: alternate columns by color. Avoids depending on a
    // heavy parser; for real CSV tokenization we'd handle quoting.
    const cols = line.split(sep);
    const sepHtml = sep === '\t'
      ? '<span class="hljs-comment">\u2192</span>'  // → visible for tabs
      : `<span class="hljs-comment">${escapeHtml(sep)}</span>`;
    return cols
      .map((c, i) => `<span class="hljs-${i % 2 ? 'string' : 'number'}">${escapeHtml(c)}</span>`)
      .join(sepHtml);
  }

  function applyHitsToHtml(htmlHighlighted, plainLine, lineNo) {
    // Highlights SEARCH matches on top of the HTML produced by highlight.js,
    // without losing syntax coloring.
    //
    // Strategy: parse the HTML in a temporary container then walk the text
    // nodes (which contain decoded text, not HTML entities). For each hit
    // whose range [col, col+len) overlaps a text node, we split the text
    // node into (before, <mark>match</mark>, after). The <span
    // class="hljs-*"> are not touched: coloring is preserved, even when
    // the hit crosses several tokens.
    const lineHits = state.hitsByLine.get(lineNo);
    if (!lineHits || lineHits.length === 0) return htmlHighlighted;

    const container = document.createElement('span');
    container.innerHTML = htmlHighlighted;

    // Build the flat list of text nodes with their plain-text offsets.
    // (depth-first traversal, document order.)
    const textNodes = [];
    let totalLen = 0;
    const walk = (node) => {
      for (let i = 0; i < node.childNodes.length; i++) {
        const c = node.childNodes[i];
        if (c.nodeType === Node.TEXT_NODE) {
          textNodes.push({ node: c, start: totalLen, end: totalLen + c.nodeValue.length });
          totalLen += c.nodeValue.length;
        } else if (c.nodeType === Node.ELEMENT_NODE) {
          walk(c);
        }
      }
    };
    walk(container);

    // Safety: if the decoded length doesn't match the plain line, bail to
    // safe raw mode (avoids any highlight offset).
    if (totalLen !== plainLine.length) {
      let out = '';
      let pos = 0;
      for (const h of lineHits) {
        out += escapeHtml(plainLine.slice(pos, h.column));
        const isCurrent = state.currentHit !== null && state.currentHit.index === h.index;
        out += `<mark class="hit${isCurrent ? ' current' : ''}">${escapeHtml(plainLine.slice(h.column, h.column + h.length))}</mark>`;
        pos = h.column + h.length;
      }
      out += escapeHtml(plainLine.slice(pos));
      return out;
    }

    // Build the list of ranges to highlight (col, end, isCurrent).
    // Sorted by ascending col (hits already arrive sorted).
    const ranges = lineHits.map((h) => ({
      from: h.column,
      to: h.column + h.length,
      isCurrent: state.currentHit !== null && state.currentHit.index === h.index,
    }));

    // For each text node, apply the ranges that intersect it. Since we
    // replace nodes as we go, we operate back to front so we don't
    // invalidate offsets of earlier nodes.
    for (let n = textNodes.length - 1; n >= 0; n--) {
      const tn = textNodes[n];
      // Find ranges that touch this node.
      const localCuts = [];
      for (const r of ranges) {
        const a = Math.max(r.from, tn.start);
        const b = Math.min(r.to, tn.end);
        if (a < b) localCuts.push({ from: a - tn.start, to: b - tn.start, isCurrent: r.isCurrent });
      }
      if (localCuts.length === 0) continue;
      // Sort by 'from' (just in case). Build the fragments.
      localCuts.sort((x, y) => x.from - y.from);
      const text = tn.node.nodeValue;
      const parent = tn.node.parentNode;
      if (!parent) continue;
      const frag = document.createDocumentFragment();
      let pos = 0;
      for (const c of localCuts) {
        if (c.from > pos) frag.appendChild(document.createTextNode(text.slice(pos, c.from)));
        const mark = document.createElement('mark');
        mark.className = c.isCurrent ? 'hit current' : 'hit';
        mark.textContent = text.slice(c.from, c.to);
        frag.appendChild(mark);
        pos = c.to;
      }
      if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
      parent.replaceChild(frag, tn.node);
    }

    return container.innerHTML;
  }

  function recomputeVirtualGeometry() {
    state.virtualHeight = state.totalLines * state.lineHeight;
    state.spacerHeight = Math.min(state.virtualHeight, MAX_SPACER_PX);
    state.scale = state.virtualHeight > 0 ? state.spacerHeight / state.virtualHeight : 1;
    spacer.style.height = state.spacerHeight + 'px';
  }

  /**
   * Tolerance (in real scrollbar pixels) to consider we're "at the
   * bottom". In compressed scrollbar mode, 1 px of scrollTop maps to
   * several virtual lines: a fast mouse scroll can land at maxScroll - 2
   * and miss the last lines. We compensate with a tolerance proportional
   * to the compression factor (at least 1 line).
   */
  function endSnapPx() {
    if (state.scale >= 1) return 1;
    // 1 virtual line = lineHeight * scale in real pixels.
    return Math.max(2, Math.ceil(state.lineHeight * state.scale));
  }

  /** real scrollTop -> virtual position (in px) in the logical space. */
  function virtualScrollTop() {
    if (state.scale >= 1) return viewport.scrollTop;
    // When at the very bottom, we must be able to reach the last line.
    const maxScroll = Math.max(0, state.spacerHeight - viewport.clientHeight);
    if (maxScroll === 0) return 0;
    const maxVirtual = Math.max(0, state.virtualHeight - viewport.clientHeight);
    // Snap to end: if we're a few px from the real max, consider we've
    // reached the virtual bottom, otherwise the ratio leaves us stuck at
    // ~13 px below the end (in compressed mode) and we miss the last lines.
    if (viewport.scrollTop >= maxScroll - endSnapPx()) return maxVirtual;
    const ratio = viewport.scrollTop / maxScroll;
    return ratio * maxVirtual;
  }

  /** Inverse: virtual position -> real scrollTop to apply. */
  function realScrollTopFromVirtual(virtual) {
    if (state.scale >= 1) return virtual;
    const maxVirtual = Math.max(1, state.virtualHeight - viewport.clientHeight);
    const maxScroll = Math.max(0, state.spacerHeight - viewport.clientHeight);
    return (virtual / maxVirtual) * maxScroll;
  }

  /** Convert any real scrollTop value -> virtual position. Pure (does not
   *  read viewport.scrollTop), so it's safe to call on a saved value. */
  function virtualFromReal(real) {
    if (state.scale >= 1) return real;
    const maxScroll = Math.max(0, state.spacerHeight - viewport.clientHeight);
    if (maxScroll === 0) return 0;
    const maxVirtual = Math.max(0, state.virtualHeight - viewport.clientHeight);
    return (real / maxScroll) * maxVirtual;
  }

  function render() {
    if (!state.totalLines) {
      rendered.innerHTML = '';
      return;
    }
    const scrollTop = viewport.scrollTop;
    const viewportH = viewport.clientHeight;
    const lh = state.lineHeight;
    const visibleCount = Math.ceil(viewportH / lh);

    // Anchor mode: line `anchorLine` must appear centered in the viewport.
    // We compute firstVisible directly from it to avoid any precision drift
    // tied to the compressed scrollbar.
    let firstVisible;
    let anchored = false;
    let atEnd = false;
    if (state.topAnchorLine >= 0 && state.topAnchorLine < state.totalLines) {
      // Hard-pinned first visible line (scrollbar arrow snap). Bypasses
      // scrollTop entirely so it works even at extreme compression where
      // scrollTop has sub-line resolution.
      const maxFirstVisible = Math.max(0, state.totalLines - visibleCount);
      firstVisible = Math.min(state.topAnchorLine, maxFirstVisible);
      if (firstVisible >= maxFirstVisible) atEnd = true;
      else anchored = true;
    } else if (state.anchorLine >= 0 && state.anchorLine < state.totalLines) {
      anchored = true;
      // Center by default, but clamped so we NEVER fall outside the file:
      // - at the top, anchor near the start => firstVisible stays at 0
      //   (the 1st line sticks to the top, no black above)
      // - at the bottom, anchor near the end => switch to atEnd mode to
      //   stick the last line to the bottom of the viewport (no black below).
      const half = Math.floor(visibleCount / 2);
      const maxFirstForCenter = Math.max(0, state.totalLines - visibleCount);
      firstVisible = Math.max(0, Math.min(maxFirstForCenter, state.anchorLine - half));
      if (firstVisible >= maxFirstForCenter && state.anchorLine > maxFirstForCenter + half) {
        anchored = false;
        atEnd = true;
      }
    } else {
      const vTop = virtualScrollTop();
      firstVisible = Math.floor(vTop / lh);
    }
    // Detect if we're (pixel-perfect) at the bottom of the scroll. Due to
    // the compressed virtual scrollbar and float rounding, vTop may
    // overflow slightly, which would render "phantom" lines below the last
    // line. We clamp firstVisible and align the last line to the bottom of
    // the viewport, like a classic editor.
    // In compressed mode, we tolerate several px of scrollTop below the
    // max (a fast scroll doesn't stop right on the final pixel).
    const maxScroll = Math.max(0, viewport.scrollHeight - viewportH);
    const isScrollBottom = !anchored && maxScroll > 0 && scrollTop >= maxScroll - endSnapPx();
    const maxFirstVisible = Math.max(0, state.totalLines - visibleCount);
    if (!anchored && (firstVisible >= maxFirstVisible || isScrollBottom)) {
      firstVisible = maxFirstVisible;
      // Only switch to bottom-aligned mode when the file is actually
      // taller than the viewport. For empty/short files (totalLines <=
      // visibleCount), there is no scrolling and the first line must
      // stay anchored to the top of the viewport — like any normal
      // text editor — instead of being pushed to the bottom.
      if (state.totalLines > visibleCount) atEnd = true;
    }
    const start = Math.max(0, firstVisible - cfg.bufferLines);
    const end = Math.min(state.totalLines, firstVisible + visibleCount + cfg.bufferLines);

    state.visibleStart = start;
    state.visibleEnd = end;

    // Load visible hits (internal debounce, no-op if already cached).
    if (state.totalHits > 0 || state.searchActive) requestVisibleHits(false);

    // Identify missing lines (skipping those already requested — during
    // fast keyboard nav at ~30 Hz, each render would otherwise re-emit
    // requestLines for lines already in flight, saturating the extension
    // queue and causing visible "…" placeholders that only resolve once
    // the user releases the key).
    const missing = [];
    for (let i = start; i < end; i++) {
      if (!state.cache.has(i) && !state.inFlight.has(i)) missing.push(i);
    }
    if (missing.length > 0) {
      // Group into contiguous ranges
      let s = missing[0], prev = missing[0];
      for (let k = 1; k <= missing.length; k++) {
        if (k === missing.length || missing[k] !== prev + 1) {
          requestRange(s, prev + 1);
          if (k < missing.length) { s = missing[k]; prev = missing[k]; }
        } else {
          prev = missing[k];
        }
      }
    }

    // Build the DOM
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const row = document.createElement('div');
      row.className = 'row';
      row.dataset.line = i;
      const gutter = document.createElement('span');
      gutter.className = 'gutter';
      gutter.textContent = (i + 1).toString();
      const content = document.createElement('span');
      content.className = 'content';
      const text = state.cache.get(i);
      if (text === undefined) {
        content.textContent = '…';
      } else {
        let html = highlight(text);
        // If the line has hits, replace with a highlighted version
        // (without hljs, but safe).
        if (state.hitsByLine.has(i)) {
          html = applyHitsToHtml(html, text, i);
        }
        content.innerHTML = html;
      }
      row.appendChild(gutter);
      row.appendChild(content);
      frag.appendChild(row);
    }
    rendered.innerHTML = '';
    rendered.appendChild(frag);
    // rendered is positioned absolutely in the viewport and scrolls with
    // scrollTop. We compensate to align the 1st rendered line with its
    // virtual position in the visible viewport.
    let translateY;
    if (state.topAnchorLine >= 0 && !atEnd) {
      // Top-pinned mode: place firstVisible exactly at the viewport top
      // (linesFromStartToFirst * lh below the rendered start). Bypass
      // any scrollTop alignment.
      const linesFromStartToFirst = firstVisible - start;
      translateY = scrollTop - linesFromStartToFirst * lh;
    } else if (anchored) {
      const half = Math.floor(visibleCount / 2);
      // If the anchor is in the start zone (clamped to firstVisible=0),
      // align the 1st line at the top of the viewport. Otherwise normal
      // centering.
      if (start === 0 && state.anchorLine < half) {
        translateY = scrollTop;
      } else {
        const linesAboveAnchor = state.anchorLine - start;
        const anchorYInViewport = Math.floor(viewportH / 2) - Math.floor(lh / 2);
        translateY = scrollTop + anchorYInViewport - linesAboveAnchor * lh;
      }
    } else if (atEnd) {
      // At the end of the file: align the last line (totalLines-1) to the
      // bottom of the viewport, exactly, regardless of scrollTop's fuzzy
      // position in the compressed virtual scrollbar. Avoids rendering
      // "truncated lines" beyond the end.
      const linesFromStartToLast = state.totalLines - 1 - start;
      const lastLineYInViewport = viewportH - lh;
      translateY = scrollTop + lastLineYInViewport - linesFromStartToLast * lh;
    } else if (state.scale < 1) {
      // Compressed scrollbar mode (huge file): vTop is reconstructed from
      // scrollTop * (maxVirtual / maxScroll) and inherits float-point drift
      // up to several lines. Using the precise formula
      // `start*lh - vTop + scrollTop` can leave a visible gap at the top
      // because `vTop mod lh` is not bounded to 0..lh in the presence of
      // that drift. Snap `firstVisible` to screen_y = 0 instead — no
      // sub-pixel alignment (meaningless when 1 px of scroll = many lines).
      translateY = scrollTop - cfg.bufferLines * lh;
    } else {
      const vTop = virtualScrollTop();
      translateY = start * lh - vTop + scrollTop;
    }
    rendered.style.transform = `translateY(${translateY}px)`;

    // Caret + selection overlays. Drawn last (on top of rows) so the
    // caret blink and selection highlight stay visible. O(visible).
    renderCaretAndSelection(start, end, lh);

    // Evict cache lines too far from view (simplistic LRU)
    pruneCache(start, end);
  }

  function pruneCache(start, end) {
    const KEEP = 2000;
    if (state.cache.size <= KEEP) return;
    // keep only [start - KEEP/2, end + KEEP/2]
    const lo = Math.max(0, start - KEEP / 2);
    const hi = end + KEEP / 2;
    for (const k of state.cache.keys()) {
      if (k < lo || k > hi) state.cache.delete(k);
    }
  }

  // Coalesce render via requestAnimationFrame: called on every batch of
  // hits arrival, guarantees at most one render per frame (~16 ms).
  let renderRaf = 0;
  function scheduleRender() {
    if (renderRaf) return;
    renderRaf = requestAnimationFrame(() => {
      renderRaf = 0;
      render();
    });
  }

  function requestRange(start, end) {
    const requestId = state.nextReqId++;
    state.pending.set(requestId, { start, end });
    for (let i = start; i < end; i++) state.inFlight.add(i);
    vscode.postMessage({ type: 'requestLines', start, end, requestId });
  }

  // ---- Edition -----------------------------------------------------------
  function enterEdit(row, line, clickEvent) {
    if (state.currentEditing !== null) commitEdit();
    state.currentEditing = line;
    const content = row.querySelector('.content');
    // We do NOT rewrite textContent: it would erase the syntax coloring
    // (HTML produced by highlight.js). contenteditable mode accepts
    // existing HTML perfectly fine; on commit we re-read via innerText to
    // get the plain value.
    content.contentEditable = 'true';
    content.focus();

    // Place the cursor at the click location (not always at the end).
    const sel = window.getSelection();
    sel.removeAllRanges();
    let placed = false;
    if (clickEvent && typeof document.caretPositionFromPoint === 'function') {
      const pos = document.caretPositionFromPoint(clickEvent.clientX, clickEvent.clientY);
      if (pos && content.contains(pos.offsetNode)) {
        const r = document.createRange();
        r.setStart(pos.offsetNode, pos.offset);
        r.collapse(true);
        sel.addRange(r);
        placed = true;
      }
    } else if (clickEvent && typeof document.caretRangeFromPoint === 'function') {
      // WebKit/Chromium : caretRangeFromPoint
      const r = document.caretRangeFromPoint(clickEvent.clientX, clickEvent.clientY);
      if (r && content.contains(r.startContainer)) {
        r.collapse(true);
        sel.addRange(r);
        placed = true;
      }
    }
    if (!placed) {
      // Fallback: end of line
      const r = document.createRange();
      r.selectNodeContents(content);
      r.collapse(false);
      sel.addRange(r);
    }

    content.addEventListener('blur', commitEdit, { once: true });
    content.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { content.blur(); }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); content.blur(); }
    });
  }

  function commitEdit() {
    if (state.currentEditing === null) return;
    const line = state.currentEditing;
    state.currentEditing = null;
    const row = rendered.querySelector(`[data-line="${line}"]`);
    if (!row) return;
    const content = row.querySelector('.content');
    const newText = content.innerText.replace(/\n/g, '');
    content.contentEditable = 'false';
    if (newText !== state.cache.get(line)) {
      state.cache.set(line, newText);
      vscode.postMessage({ type: 'edit', line, content: newText });
      content.innerHTML = highlight(newText);
    }
  }

  // ---- Search ------------------------------------------------------------
  function openSearch(withReplace) {
    searchBar.classList.remove('hidden');
    if (withReplace) replaceRow.classList.remove('hidden');
    searchInput.focus();
    searchInput.select();
  }
  function closeSearch() {
    searchBar.classList.add('hidden');
    replaceRow.classList.add('hidden');
    resetSearchState();
    searchCount.textContent = '';
    setSearchProgress(null);
    vscode.postMessage({ type: 'cancelSearch' });
    render();
    viewport.focus();
  }

  // ---- Go to Line (Ctrl+G) -----------------------------------------------
  // Mirrors VS Code's built-in "Go to Line / Column…" command. Accepts a
  // 1-based line number, optionally followed by `:col` (1-based column).
  // The caret jumps to that exact position and the viewport is centered
  // on the target line via the existing `jumpToLine()` (anchorLine model).
  function openGoto() {
    if (!state.indexReady) return;
    gotoBar.classList.remove('hidden');
    gotoInput.value = state.caret ? String(state.caret.line + 1) : '';
    gotoInput.placeholder = `Go to line (1 - ${state.totalLines.toLocaleString()})`;
    gotoHint.textContent = '';
    gotoInput.focus();
    gotoInput.select();
  }
  function closeGoto() {
    gotoBar.classList.add('hidden');
    gotoHint.textContent = '';
    viewport.focus();
  }
  function applyGoto() {
    const raw = gotoInput.value.trim();
    if (!raw) return;
    // Accept "123" or "123:45" (line:column, both 1-based).
    const m = /^(\d+)(?::(\d+))?$/.exec(raw);
    if (!m) {
      gotoHint.textContent = 'invalid';
      return;
    }
    const line = Math.max(0, Math.min(state.totalLines - 1, parseInt(m[1], 10) - 1));
    const col = m[2] ? Math.max(0, parseInt(m[2], 10) - 1) : 0;
    closeGoto();
    // jumpToLine centers the line in the viewport via the anchored mode
    // (precision-safe even at extreme compression). Then we move the
    // caret without scrolling so it lands exactly on the requested
    // {line, col} without re-aligning the viewport.
    jumpToLine(line);
    setCaret({ line, col }, false, false, false);
  }

  /** Resets the local search state (not the bar). */
  function resetSearchState() {
    state.totalHits = 0;
    state.currentHit = null;
    state.currentHitIndex = -1;
    state.hitsByLine.clear();
    state.cachedFrom = -1;
    state.cachedTo = -1;
    state.searchActive = false;
  }

  function runReplaceAll() {
    const query = searchInput.value;
    if (!query) return;
    if (replaceAllBtn.disabled) return;
    const replacement = replaceInput.value;
    const payload = {
      query, replacement,
      isRegex: reCheck.checked,
      caseSensitive: csCheck.checked,
      wholeWord: wwCheck.checked,
    };
    if (!state.indexReady) {
      // Queue: we'll execute it automatically when indexing finishes.
      state.pendingReplace = payload;
      replaceProgress.textContent = 'Waiting for indexing…';
      return;
    }
    // window.confirm() is disabled in VS Code webviews (sandbox).
    // We delegate the confirmation to the extension via showWarningMessage.
    replaceAllBtn.disabled = true;
    replaceProgress.textContent = 'Confirming…';
    vscode.postMessage({ type: 'confirmReplaceAll', ...payload });
  }

  function sendReplace(payload) {
    replaceAllBtn.disabled = true;
    replaceProgress.textContent = '';
    setReplaceProgress(0, 0);
    setReplaceLock(true);
    vscode.postMessage({ type: 'replaceAll', ...payload });
  }

  /**
   * Toggles the editing lock during a Replace All.
   * - Shows an info banner at the top.
   * - Exits any current edit (commit) so we don't lose the typing.
   * - The click handler checks state.replaceLocked before launching enterEdit.
   */
  function setReplaceLock(locked) {
    state.replaceLocked = locked;
    document.body.classList.toggle('replace-locked', locked);
    if (locked && state.currentEditing !== null) commitEdit();
  }

  function runSearch() {
    resetSearchState();
    if (!searchInput.value) {
      searchCount.textContent = '';
      setSearchProgress(null);
      state.pendingSearch = false;
      render();
      return;
    }
    if (!state.indexReady) {
      // Queue until the 'ready' message is received. This avoids any
      // inconsistency if numbering/totalLines change before indexing
      // finishes.
      state.pendingSearch = true;
      searchCount.textContent = 'Waiting for indexing…';
      setSearchProgress(null);
      return;
    }
    state.pendingSearch = false;
    state.searchActive = true;
    searchCount.textContent = '…';
    setSearchProgress(0);
    state.searchReqId = state.nextReqId++;
    vscode.postMessage({
      type: 'search',
      requestId: state.searchReqId,
      query: searchInput.value,
      isRegex: reCheck.checked,
      caseSensitive: csCheck.checked,
      wholeWord: wwCheck.checked,
    });
  }

  /** Asks the extension for hits in the visible line range. */
  function requestVisibleHits(immediate) {
    if (!state.searchActive && state.totalHits === 0) return;
    const PAD = 100;
    const from = Math.max(0, state.visibleStart - PAD);
    const to = Math.min(state.totalLines - 1, state.visibleEnd + PAD);
    // If the requested range is already within the cache, nothing to do.
    if (state.cachedFrom <= from && to <= state.cachedTo) return;
    if (state.rangeReqDebounce) clearTimeout(state.rangeReqDebounce);
    const fire = () => {
      state.rangeReqId = state.nextReqId++;
      vscode.postMessage({ type: 'queryHitsRange', requestId: state.rangeReqId, lineFrom: from, lineTo: to });
    };
    if (immediate) fire(); else state.rangeReqDebounce = setTimeout(fire, 60);
  }

  /** Navigation: direction = 'next'|'prev'|'first'|'last'|'index'. */
  function navigateHit(direction, currentIndex) {
    if (state.totalHits === 0) return;
    state.navReqId = state.nextReqId++;
    vscode.postMessage({
      type: 'queryHitNav',
      requestId: state.navReqId,
      direction,
      currentIndex: currentIndex !== undefined ? currentIndex : state.currentHitIndex,
    });
  }

  function gotoHit(idx) {
    navigateHit('index', idx);
  }

  /**
   * Jumps to a precise line: adjusts scrollTop (best effort given the
   * compressed virtual scrollbar) AND sets an anchorLine so render() shows
   * exactly that line, with no precision drift.
   */
  function jumpToLine(line) {
    state.anchorLine = line;
    state.topAnchorLine = -1;
    const virtualTarget = Math.max(0, line * state.lineHeight - viewport.clientHeight / 2);
    state.programmaticScroll = true;
    viewport.scrollTop = Math.max(0, realScrollTopFromVirtual(virtualTarget));
    // In case the browser doesn't fire 'scroll' (already at the same
    // position), render explicitly.
    render();
    // The previous programmatic 'scroll' will arrive asynchronously: we
    // release the flag on the next tick, after it's processed.
    setTimeout(() => { state.programmaticScroll = false; }, 0);
  }

  // ---- Caret + selection -------------------------------------------------
  // The webview exposes a real text-editor caret (vertical bar + arrow
  // navigation + selection) on top of the virtualized line view. The
  // contenteditable per-row remains the actual editing path; the caret
  // model only handles navigation/selection and triggers an enterEdit on
  // double-click, F2 or first printable keystroke.
  //
  // Memory: caret = { line, col }, selAnchor = { line, col } | null.
  // Rendering = 1 absolutely-positioned div for the caret + ≤ visibleCount
  // sel-line divs (one rectangle per visible selected line). Both are
  // appended inside #rendered so they share the same translateY transform
  // and stay aligned during scroll.

  /** Returns the cached length of `line` if known, else null. */
  function cachedLineLength(line) {
    const text = state.cache.get(line);
    return text === undefined ? null : text.length;
  }

  /** Clamps a {line, col} to the file bounds and the line length when known. */
  function clampPos(p) {
    let line = Math.max(0, Math.min(state.totalLines - 1, p.line));
    let col = Math.max(0, p.col);
    const len = cachedLineLength(line);
    if (len !== null) col = Math.min(col, len);
    return { line, col };
  }

  /**
   * Sets the caret. extend=true keeps/initializes selAnchor; otherwise
   * collapses the selection. keepPrefer=true preserves preferCol (for
   * vertical motions). Schedules a render and ensures the caret is in
   * view.
   */
  function setCaret(pos, extend, keepPrefer, scrollIntoView) {
    if (state.totalLines === 0) return;
    pos = clampPos(pos);
    if (extend) {
      if (state.selAnchor == null) {
        state.selAnchor = state.caret
          ? { line: state.caret.line, col: state.caret.col }
          : { line: pos.line, col: pos.col };
      }
    } else {
      state.selAnchor = null;
    }
    state.caret = pos;
    if (!keepPrefer) state.preferCol = pos.col;
    // Only scroll the viewport for keyboard moves. Mouse clicks set the
    // caret to a position that is already on screen by definition; the
    // viewport must NOT shift to "re-center" on it.
    if (scrollIntoView) ensureCaretVisible();
    scheduleRender();
  }

  /**
   * Scrolls so the caret line sits inside the visible viewport (the
   * actual visible window, NOT including the off-screen buffer rows).
   * `state.visibleStart` includes `cfg.bufferLines` lines above the
   * viewport top — using it directly here would mark half the viewport
   * as "out of view" and trigger spurious scrolls on every click in the
   * lower half.
   */
  function ensureCaretVisible() {
    if (!state.caret) return;
    const lh = state.lineHeight;
    const visibleCount = Math.max(1, Math.floor(viewport.clientHeight / lh));
    const firstFully = state.visibleStart + cfg.bufferLines;
    const lastFully = firstFully + visibleCount - 1;
    const cl = state.caret.line;
    let target = null;
    if (cl < firstFully) {
      target = cl * lh;
    } else if (cl > lastFully) {
      target = (cl - visibleCount + 1) * lh;
    }
    if (target !== null) {
      state.programmaticScroll = true;
      state.anchorLine = -1;
      viewport.scrollTop = Math.max(0, realScrollTopFromVirtual(target));
      setTimeout(() => { state.programmaticScroll = false; }, 0);
    }
  }

  /** Moves the caret vertically by `delta` lines, preserving preferCol. */
  function moveCaretLine(delta, extend) {
    if (!state.caret) state.caret = { line: 0, col: 0 };
    const line = Math.max(0, Math.min(state.totalLines - 1, state.caret.line + delta));
    let col = state.preferCol;
    const len = cachedLineLength(line);
    if (len !== null) col = Math.min(col, len);
    setCaret({ line, col }, extend, /*keepPrefer*/ true, /*scrollIntoView*/ true);
  }

  /** Moves the caret horizontally by `delta` chars, wrapping across lines. */
  function moveCaretChar(delta, extend) {
    if (!state.caret) state.caret = { line: 0, col: 0 };
    let { line, col } = state.caret;
    col += delta;
    if (col < 0) {
      if (line > 0) {
        line--;
        const len = cachedLineLength(line);
        col = len !== null ? len : 0;
      } else {
        col = 0;
      }
    } else {
      const len = cachedLineLength(line);
      if (len !== null && col > len) {
        if (line < state.totalLines - 1) { line++; col = 0; }
        else col = len;
      }
    }
    setCaret({ line, col }, extend, /*keepPrefer*/ false, /*scrollIntoView*/ true);
  }

  /**
   * Maps a mouse event to a {line, col} position. Robust against any
   * float drift in `state.lineHeight` accumulating over thousands of
   * scrolled lines: instead of computing `floor(y / lineHeight)`, we ask
   * the browser which `.row` is under the pointer and read its
   * `data-line` directly. The column uses the real `.content` rect so
   * gutter/padding offsets are reflected exactly. Falls back to null
   * when the click lands outside any rendered row.
   *
   * `elementFromPoint` performs an O(log n) hit-test on the rendered DOM
   * (~50 rows). Caret/selection overlays are pointer-events:none, so
   * they're transparent to this lookup.
   */
  function posFromEvent(e) {
    if (!state.totalLines) return null;
    const target = document.elementFromPoint(e.clientX, e.clientY);
    if (!target) return null;
    const row = target.closest && target.closest('.row');
    if (!row || row.parentElement !== rendered) return null;
    const line = parseInt(row.dataset.line, 10);
    if (Number.isNaN(line)) return null;
    const content = row.querySelector('.content');
    if (!content) return { line, col: 0 };
    const cRect = content.getBoundingClientRect();
    // .content has padding-left:12, no border. cRect.left is the padding
    // edge; text starts 12 px in.
    const innerLeft = cRect.left + 12;
    const cw = state.charWidth || 8;
    let col = Math.max(0, Math.round((e.clientX - innerLeft) / cw));
    const len = cachedLineLength(line);
    if (len !== null) col = Math.min(col, len);
    return { line, col };
  }

  /**
   * Renders the caret bar and the selection rectangles inside #rendered.
   * Coordinates are relative to #rendered (which already has the
   * translateY of the visible window applied by the parent render()).
   */
  function renderCaretAndSelection(start, end, lh) {
    // Wipe any previous overlay nodes (they live as siblings of .row).
    for (const el of rendered.querySelectorAll('.caret, .sel-line')) el.remove();
    if (!state.caret) return;
    const offset = contentLeftOffset();
    const cw = state.charWidth || 8;

    // Build line → row lookup so we can read each row's actual offsetTop
    // (pixel-rounded by the browser) instead of computing
    // `(line - start) * lh` which drifts when `lineHeight` is fractional.
    // O(visibleCount) ≈ ≤ 60 entries.
    const rowMap = new Map();
    for (const r of rendered.querySelectorAll('.row')) {
      rowMap.set(parseInt(r.dataset.line, 10), r);
    }
    const yOf = (line) => {
      const r = rowMap.get(line);
      return r ? r.offsetTop : (line - start) * lh;
    };
    const hOf = (line) => {
      const r = rowMap.get(line);
      return r ? r.offsetHeight : lh;
    };

    // Selection: at most one rectangle per visible selected line.
    if (state.selAnchor) {
      let a = state.selAnchor, b = state.caret;
      if (a.line > b.line || (a.line === b.line && a.col > b.col)) {
        const tmp = a; a = b; b = tmp;
      }
      const visStart = Math.max(start, a.line);
      const visEnd = Math.min(end - 1, b.line);
      const frag = document.createDocumentFragment();
      for (let l = visStart; l <= visEnd; l++) {
        const fromCol = (l === a.line) ? a.col : 0;
        let toCol;
        if (l === b.line) {
          toCol = b.col;
        } else {
          const len = cachedLineLength(l);
          toCol = (len !== null ? len : 0) + 2; // +2 chars to hint the line break is selected
        }
        if (toCol <= fromCol && l !== b.line) continue;
        const div = document.createElement('div');
        div.className = 'sel-line';
        div.style.left = (offset + fromCol * cw) + 'px';
        div.style.width = Math.max(2, (toCol - fromCol) * cw) + 'px';
        div.style.top = yOf(l) + 'px';
        div.style.height = hOf(l) + 'px';
        frag.appendChild(div);
      }
      rendered.appendChild(frag);
    }

    // Caret: only when the head line is in the rendered window.
    const cl = state.caret.line;
    if (cl >= start && cl < end) {
      const cEl = document.createElement('div');
      cEl.className = 'caret';
      cEl.style.left = (offset + state.caret.col * cw) + 'px';
      cEl.style.top = yOf(cl) + 'px';
      cEl.style.height = hOf(cl) + 'px';
      rendered.appendChild(cEl);
    }
  }

  // ---- Mouse drag-select with line-by-line auto-scroll -------------------
  function startAutoScroll(dir) {
    if (state.autoScrollTimer && state.autoScrollDir === dir) return;
    stopAutoScroll();
    state.autoScrollDir = dir;
    // 1 line per ~50 ms = 20 lines/sec. Predictable & precise, matching
    // the user's request for "ligne par ligne".
    state.autoScrollTimer = setInterval(() => {
      if (!state.dragSelecting) { stopAutoScroll(); return; }
      const lh = state.lineHeight;
      state.programmaticScroll = true;
      state.anchorLine = -1;
      viewport.scrollTop = Math.max(0, viewport.scrollTop + state.autoScrollDir * lh);
      setTimeout(() => { state.programmaticScroll = false; }, 0);
      // Extend selection by 1 line in the scroll direction, keeping
      // preferCol (so a diagonal drag keeps the column intent).
      let line = (state.caret ? state.caret.line : 0) + state.autoScrollDir;
      line = Math.max(0, Math.min(state.totalLines - 1, line));
      let col = state.preferCol;
      const len = cachedLineLength(line);
      if (len !== null) col = Math.min(col, len);
      setCaret({ line, col }, true, true, false);
    }, 50);
  }
  function stopAutoScroll() {
    if (state.autoScrollTimer) {
      clearInterval(state.autoScrollTimer);
      state.autoScrollTimer = 0;
      state.autoScrollDir = 0;
    }
  }

  // ---- Events ------------------------------------------------------------
  // Scrollbar arrow snap: clicking the native ▲ / ▼ buttons scrolls
  // ~40 real px on Chromium. In a compressed huge file, 1 real px maps
  // to many virtual lines, so 40 px = hundreds. We detect such a small
  // user scroll (no recent wheel/key) and snap to ±1 virtual line via
  // `realScrollTopFromVirtual()`, regardless of the compression scale.
  // The caret is NOT touched.
  //
  // The browser fires a *new* scroll event for our own programmatic
  // re-positioning. We can't predict its delivery time vs. setTimeout(0)
  // — on some Chromium builds the scroll event lands BEFORE the timeout,
  // re-entering the snap branch and bouncing back to the original
  // position. We avoid this by recording a snap timestamp and ignoring
  // any scroll within ~80 ms of the last snap (longer than one rAF, but
  // shorter than the browser's scrollbar autorepeat ~100-150 ms — so
  // hold-to-scroll still ticks line by line).
  let lastSnapAt = 0;
  viewport.addEventListener('scroll', () => {
    const now = performance.now();
    if (state.programmaticScroll || now - lastSnapAt < 80) {
      state.lastScrollTop = viewport.scrollTop;
      render();
      return;
    }
    const delta = viewport.scrollTop - state.lastScrollTop;
    const lh = state.lineHeight || 18;
    if (delta !== 0) {
      const sinceWheel = now - state.lastWheelAt;
      const sinceKey = now - state.lastKeyScrollAt;
      const small = Math.abs(delta) > 0 && Math.abs(delta) < 60;
      if (small && sinceWheel > 80 && sinceKey > 80) {
        const dir = delta > 0 ? 1 : -1;
        // We compute the new "first visible line" relative to the line
        // currently at the top — NOT to where the browser jumped to.
        // The browser arrow click jumps ~40 real px, which in compressed
        // mode (huge files) maps to dozens or hundreds of virtual lines.
        // We override that by hard-pinning the new first-visible line
        // via `state.topAnchorLine`, which bypasses scrollTop math
        // entirely (writing scrollTop wouldn't even register a change in
        // sub-pixel-per-line compressed mode).
        const lineHeight = state.lineHeight || 18;
        const visibleCount = Math.max(1, Math.floor(viewport.clientHeight / lineHeight));
        const maxFirstVisible = Math.max(0, state.totalLines - visibleCount);
        // Base = the line currently displayed at the top of the viewport
        // BEFORE the browser jumped. If a previous snap is still active,
        // we step from there; otherwise from the rendered visible start.
        const baseLine = state.topAnchorLine >= 0
          ? state.topAnchorLine
          : (state.visibleStart + cfg.bufferLines);
        const newTopLine = Math.max(0, Math.min(maxFirstVisible, baseLine + dir));
        state.topAnchorLine = newTopLine;
        lastSnapAt = now;
        // Park scrollTop somewhere consistent so future small-delta
        // detection still works for the next click. Don't go to the very
        // edges (would pin atEnd / start prematurely).
        const target = realScrollTopFromVirtual(newTopLine * lineHeight);
        viewport.scrollTop = target;
        state.lastScrollTop = viewport.scrollTop;
        render();
        return;
      }
    }
    state.lastScrollTop = viewport.scrollTop;
    state.anchorLine = -1;
    render();
  });
  viewport.addEventListener('wheel', () => {
    state.lastWheelAt = performance.now();
    state.topAnchorLine = -1;
  }, { passive: true });
  window.addEventListener('resize', () => { recomputeVirtualGeometry(); render(); });

  // ---- Mouse: click places caret, drag selects, double-click edits ------
  viewport.addEventListener('mousedown', (e) => {
    if (state.replaceLocked) return;
    if (e.button !== 0) return;
    // Ignore clicks on the scrollbar (right of viewport content).
    if (e.clientX > viewport.getBoundingClientRect().right - 16) return;
    // If we click outside the currently edited row, commit it.
    if (state.currentEditing !== null) {
      const row = e.target.closest && e.target.closest('.row');
      if (!row || parseInt(row.dataset.line, 10) !== state.currentEditing) {
        commitEdit();
      } else {
        return; // click inside edited row: let contenteditable handle it
      }
    }
    const pos = posFromEvent(e);
    if (!pos) return;
    setCaret(pos, e.shiftKey, false, false);
    if (!e.shiftKey) {
      state.dragSelecting = true;
      state.dragPointerId = e.pointerId != null ? e.pointerId : 1;
    }
    viewport.focus();
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!state.dragSelecting) return;
    state.lastMouseClientX = e.clientX;
    const r = viewport.getBoundingClientRect();
    if (e.clientY < r.top + 4) {
      startAutoScroll(-1);
    } else if (e.clientY > r.bottom - 4) {
      startAutoScroll(+1);
    } else {
      stopAutoScroll();
      const pos = posFromEvent(e);
      if (pos) setCaret(pos, true, false, false);
    }
  });
  window.addEventListener('mouseup', () => {
    state.dragSelecting = false;
    stopAutoScroll();
  });

  // Double-click on a row enters edit at the click position.
  rendered.addEventListener('dblclick', (e) => {
    if (state.replaceLocked) return;
    const row = e.target.closest('.row');
    if (!row) return;
    const line = parseInt(row.dataset.line, 10);
    enterEdit(row, line, e);
  });

  saveBtn.addEventListener('click', () => {
    if (state.currentEditing !== null) commitEdit();
    vscode.postMessage({ type: 'save' });
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'F' || e.key === 'f' || e.key === 'H' || e.key === 'h')) {
      // Ctrl+Shift+F (and Ctrl+Shift+H): open the bar with the replace
      // panel expanded, like VS Code's "Find & Replace".
      e.preventDefault();
      openSearch(true);
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'h' || e.key === 'H')) {
      e.preventDefault();
      openSearch(true);
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      openSearch(false);
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'g' || e.key === 'G')) {
      // Ctrl+G — Go to Line, like VS Code.
      e.preventDefault();
      openGoto();
    } else if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (state.currentEditing !== null) commitEdit();
      vscode.postMessage({ type: 'save' });
    } else if (e.key === 'Escape' && !searchBar.classList.contains('hidden')) {
      closeSearch();
    } else if (e.key === 'Escape' && !gotoBar.classList.contains('hidden')) {
      closeGoto();
    } else {
      handleNavKey(e);
    }
  });

  /**
   * Caret/scroll keyboard navigation. Handles Up/Down/Left/Right,
   * PageUp/PageDown, Home/End, with Shift to extend selection and Ctrl
   * to jump to file boundaries. Skipped when an input/contenteditable
   * is focused so it never steals focus from the search bar or an
   * editable row. F2 / printable keystroke / Enter on the caret line
   * starts editing at the caret position.
   */
  function handleNavKey(e) {
    if (!state.indexReady) return;
    const ae = document.activeElement;
    if (ae) {
      if (ae === searchInput || ae === replaceInput) return;
      if (ae.isContentEditable) return; // editing in progress, native cursor wins
      const tag = ae.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    }
    state.lastKeyScrollAt = performance.now();
    state.topAnchorLine = -1;
    const lh = state.lineHeight || 18;
    const visibleCount = Math.max(1, Math.floor(viewport.clientHeight / lh) - 1);
    const ext = e.shiftKey;
    const ctrl = e.ctrlKey || e.metaKey;
    if (!state.caret) state.caret = { line: state.visibleStart, col: 0 };
    let handled = true;
    switch (e.key) {
      case 'ArrowDown': moveCaretLine(+1, ext); break;
      case 'ArrowUp': moveCaretLine(-1, ext); break;
      case 'ArrowLeft': moveCaretChar(-1, ext); break;
      case 'ArrowRight': moveCaretChar(+1, ext); break;
      case 'PageDown': moveCaretLine(+visibleCount, ext); break;
      case 'PageUp': moveCaretLine(-visibleCount, ext); break;
      case 'Home':
        if (ctrl) setCaret({ line: 0, col: 0 }, ext, false, true);
        else setCaret({ line: state.caret.line, col: 0 }, ext, false, true);
        break;
      case 'End': {
        const targetLine = ctrl ? state.totalLines - 1 : state.caret.line;
        const len = cachedLineLength(targetLine);
        // If the line isn't loaded yet, jump to a large col; clampPos
        // will tighten it once the line arrives via the requestRange
        // round-trip.
        setCaret({ line: targetLine, col: len !== null ? len : 1e9 }, ext, false, true);
        break;
      }
      case 'F2': {
        if (state.caret) {
          // Ensure the row is rendered and enter edit.
          const row = rendered.querySelector('[data-line="' + state.caret.line + '"]');
          if (row) enterEdit(row, state.caret.line, null);
        }
        break;
      }
      case 'Enter': {
        if (state.caret) {
          const row = rendered.querySelector('[data-line="' + state.caret.line + '"]');
          if (row) enterEdit(row, state.caret.line, null);
        }
        break;
      }
      default:
        // Printable single-character keystroke at caret -> enter edit on
        // the caret line (do NOT preventDefault, the keypress will land
        // in the contenteditable on the next tick).
        if (!ctrl && !e.altKey && e.key.length === 1 && state.caret) {
          const row = rendered.querySelector('[data-line="' + state.caret.line + '"]');
          if (row) {
            enterEdit(row, state.caret.line, null);
            // Delegate the keystroke: contenteditable now has focus and
            // will receive the next keydown for the same character if
            // the user repeats. We don't preventDefault here so the
            // current event lands inside the editable (single keypress
            // semantics).
          }
        }
        handled = false;
    }
    if (handled) e.preventDefault();
  }

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (state.totalHits === 0) {
        runSearch();
      } else {
        navigateHit(e.shiftKey ? 'prev' : 'next');
      }
    } else if (e.key === 'Escape') {
      closeSearch();
    }
  });
  let searchDebounce;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(runSearch, 250);
  });
  document.getElementById('nextHit').addEventListener('click', () => navigateHit('next'));
  document.getElementById('prevHit').addEventListener('click', () => navigateHit('prev'));
  document.getElementById('closeSearch').addEventListener('click', closeSearch);
  [csCheck, wwCheck, reCheck].forEach(el => el.addEventListener('change', runSearch));
  replaceAllBtn.addEventListener('click', runReplaceAll);
  replaceInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runReplaceAll(); }
    else if (e.key === 'Escape') { closeSearch(); }
  });

  // Go-to-line bar wiring.
  gotoInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); applyGoto(); }
    else if (e.key === 'Escape') { closeGoto(); }
  });
  gotoInput.addEventListener('input', () => {
    const raw = gotoInput.value.trim();
    if (!raw) { gotoHint.textContent = ''; return; }
    const m = /^(\d+)(?::(\d+))?$/.exec(raw);
    if (!m) { gotoHint.textContent = 'invalid'; return; }
    const n = parseInt(m[1], 10);
    if (n < 1 || n > state.totalLines) {
      gotoHint.textContent = `out of range`;
    } else {
      gotoHint.textContent = m[2] ? `→ line ${n}, col ${m[2]}` : `→ line ${n}`;
    }
  });
  document.getElementById('closeGoto').addEventListener('click', closeGoto);

  // ---- Messages from extension ------------------------------------------
  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'indexing':
        showProgress();
        if (msg.state === 'start') {
          setProgress(0, 'Indexing… 0.0%');
          setStatus('Indexing…');
        } else if (msg.state === 'progress') {
          const ratio = msg.totalBytes ? (msg.bytesRead / msg.totalBytes) : 0;
          const pct = ratio * 100;
          setProgress(pct, `Indexing… ${pct.toFixed(1)}%`);
        }
        break;
      case 'ready':
        state.totalLines = msg.totalLines;
        state.language = msg.language;
        state.hljsLang = undefined; // reset cached resolver
        measureLineHeight();
        measureCharWidth();
        recomputeVirtualGeometry();
        setProgress(100, 'Done');
        setTimeout(hideProgress, 600);
        setStatus(`${msg.fileName} — ${(msg.totalBytes / 1024 / 1024).toFixed(1)} MB`);
        state.indexReady = true;
        render();
        // Release operations queued during indexing.
        if (state.pendingSearch) {
          state.pendingSearch = false;
          runSearch();
        }
        if (state.pendingReplace) {
          const p = state.pendingReplace;
          state.pendingReplace = null;
          sendReplace(p);
        }
        break;
      case 'lines': {
        const { start, lines, requestId } = msg;
        for (let i = 0; i < lines.length; i++) {
          state.cache.set(start + i, lines[i]);
          state.inFlight.delete(start + i);
        }
        if (requestId !== undefined) state.pending.delete(requestId);
        // Render only if we're still in the visible zone
        if (start < state.visibleEnd && start + lines.length > state.visibleStart) render();
        break;
      }
      case 'dirty': setDirty(msg.dirty); break;
      case 'invalidate':
        state.cache.delete(msg.line);
        state.inFlight.delete(msg.line);
        render();
        break;
      case 'saved':
        setDirty(false);
        saveIndicator.classList.add('hidden');
        saveBtn.disabled = false;
        state.totalLines = msg.totalLines;
        recomputeVirtualGeometry();
        state.cache.clear();
        state.inFlight.clear();
        render();
        setStatus(`Saved — ${(msg.totalBytes / 1024 / 1024).toFixed(1)} MB`);
        break;
      case 'searchCount':
        // Emitted during the search to display the progressive counter.
        if (msg.requestId !== state.searchReqId) break;
        searchCount.textContent = `${msg.count.toLocaleString()}+ found…`;
        break;
      case 'hitsRange': {
        // Response to queryHitsRange: replace the cache entirely.
        if (msg.requestId !== state.rangeReqId) break;
        state.hitsByLine.clear();
        state.cachedFrom = msg.lineFrom;
        state.cachedTo = msg.lineTo;
        for (const h of msg.hits) {
          let arr = state.hitsByLine.get(h.line);
          if (!arr) { arr = []; state.hitsByLine.set(h.line, arr); }
          arr.push({ column: h.column, length: h.length, index: h.index });
        }
        scheduleRender();
        break;
      }
      case 'hitNav': {
        if (msg.requestId !== state.navReqId) break;
        if (!msg.hit) {
          state.currentHit = null;
          state.currentHitIndex = -1;
          searchCount.textContent = 'No results';
          break;
        }
        state.currentHit = msg.hit;
        state.currentHitIndex = msg.hit.index;
        searchCount.textContent =
          `${(msg.hit.index + 1).toLocaleString()} / ${msg.total.toLocaleString()}`;
        searchCount.title = '';
        jumpToLine(msg.hit.line);
        // Make sure the target window's hits are loaded so the current
        // selection is visualized.
        requestVisibleHits(true);
        break;
      }
      case 'searchProgress':
        if (msg.requestId !== state.searchReqId) break;
        {
          const pct = msg.totalBytes ? ((msg.bytesRead / msg.totalBytes) * 100) : 0;
          setSearchProgress(pct);
        }
        break;
      case 'saveStart':
        saveIndicator.classList.remove('hidden');
        saveLabel.textContent = 'Saving…';
        saveBtn.disabled = true;
        setStatus('Saving…');
        break;
      case 'saveProgress': {
        const pct = msg.totalBytes ? ((msg.bytesProcessed / msg.totalBytes) * 100) : 0;
        saveLabel.textContent = `Saving… ${pct.toFixed(1)}%`;
        break;
      }
      case 'saveStage':
        if (msg.stage === 'reindex') saveLabel.textContent = 'Reindexing…';
        break;
      case 'saveError':
        saveIndicator.classList.add('hidden');
        saveBtn.disabled = false;
        setStatus('Save error: ' + msg.message);
        break;
      case 'searchDone':
        if (msg.requestId !== state.searchReqId) break;
        state.searchActive = false;
        state.totalHits = msg.totalHits || 0;
        if (state.totalHits === 0) {
          searchCount.textContent = 'No results';
          state.currentHit = null;
          state.currentHitIndex = -1;
        } else {
          // Show “0 / N” immediately then jump to the first hit.
          searchCount.textContent = `${state.totalHits.toLocaleString()} found`;
          searchCount.title = '';
          // Select the first hit (equivalent to the old gotoHit(0) fired
          // when the first hits arrived, but now the extension answers in
          // the next message).
          navigateHit('first');
          // In parallel, load the visible hits right now to show
          // highlights where the user is looking.
          requestVisibleHits(true);
        }
        setSearchProgress(null);
        scheduleRender();
        break;
      case 'replaceProgress': {
        const pct = msg.totalBytes ? ((msg.bytesProcessed / msg.totalBytes) * 100) : 0;
        setReplaceProgress(pct, msg.replacements, msg.stage);
        replaceProgress.textContent = '';
        break;
      }
      case 'replaceStage':
        // Write phase -> reindex phase transition: reset the bar to 0%
        // to start over for the new phase, without flickering.
        if (msg.stage === 'reindex') setReplaceProgress(0, undefined, 'reindex');
        break;
      case 'replaceDone': {
        replaceAllBtn.disabled = false;
        setReplaceLock(false);
        setReplaceProgress(null);
        replaceProgress.textContent = `${msg.replacements.toLocaleString()} replacement(s)`;
        // The file was rewritten extension-side: clear the cache and
        // re-run the search with the new contents.
        state.totalLines = msg.totalLines;
        recomputeVirtualGeometry();
        state.cache.clear();
        state.inFlight.clear();
        resetSearchState();
        setDirty(false);
        setStatus(`Saved after replacement — ${(msg.totalBytes / 1024 / 1024).toFixed(1)} MB`);
        render();
        if (searchInput.value) runSearch();
        break;
      }
      case 'replaceError': {
        replaceAllBtn.disabled = false;
        setReplaceLock(false);
        setReplaceProgress(null);
        replaceProgress.textContent = '';
        setStatus('Replace error: ' + msg.message);
        break;
      }
      case 'replaceCancelled':
        // The user cancelled the modal confirmation extension-side.
        replaceAllBtn.disabled = false;
        setReplaceLock(false);
        replaceProgress.textContent = '';
        setReplaceProgress(null);
        break;
      case 'error':
        setStatus('Error: ' + msg.message);
        break;
    }
  });
})();
