import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { SparseLineIndex } from './lineIndex';
import { parallelBuildIndex } from './parallelIndex';
import { FileReader } from './fileReader';
import { EditOverlay } from './editOverlay';
import { streamReplaceAll } from './search';
import { parallelSearch } from './parallelSearch';
import { HitStore } from './hitStore';

class MaximusDocument implements vscode.CustomDocument {
  readonly index: SparseLineIndex;
  readonly overlay = new EditOverlay();
  reader?: FileReader;
  searchAbort?: { aborted: boolean };
  /** Results of the last search (compact typed arrays). */
  hits?: HitStore;
  private _onDidChange = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<MaximusDocument>>();
  readonly onDidChange = this._onDidChange.event;

  constructor(public readonly uri: vscode.Uri, step: number) {
    this.index = new SparseLineIndex(uri.fsPath, step);
  }

  notifyEdit(undo: () => void, redo: () => void, label: string) {
    this._onDidChange.fire({ document: this, undo, redo, label });
  }

  dispose(): void {
    this._onDidChange.dispose();
    if (this.reader) this.reader.close().catch(() => undefined);
  }
}

export class MaximusEditorProvider implements vscode.CustomEditorProvider<MaximusDocument> {
  public static readonly viewType = 'maximus.editor';

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      MaximusEditorProvider.viewType,
      new MaximusEditorProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    );
  }

  private readonly _onDidChangeCustomDocument =
    new vscode.EventEmitter<vscode.CustomDocumentEditEvent<MaximusDocument>>();
  readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

  /** Tracks panel <-> document so save() can post messages back. */
  private readonly _panels = new Map<MaximusDocument, vscode.WebviewPanel>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  async openCustomDocument(
    uri: vscode.Uri,
    _ctx: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): Promise<MaximusDocument> {
    const step = vscode.workspace.getConfiguration('maximus').get<number>('indexEveryNLines', 1000);
    const doc = new MaximusDocument(uri, step);
    doc.onDidChange((e) => this._onDidChangeCustomDocument.fire(e));
    return doc;
  }

  async resolveCustomEditor(
    document: MaximusDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const filePath = document.uri.fsPath;
    const cfg = vscode.workspace.getConfiguration('maximus');
    const buffer = cfg.get<number>('bufferLines', 20);

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };

    // Handshake: wait for the webview to be ready before sending progress
    // messages, otherwise they may be lost if the script hasn't loaded yet.
    let webviewReadyResolve: (() => void) | undefined;
    const webviewReady = new Promise<void>((res) => { webviewReadyResolve = res; });

    const sub = panel.webview.onDidReceiveMessage((msg) => {
      if (msg && msg.type === 'webviewReady') {
        if (webviewReadyResolve) { webviewReadyResolve(); webviewReadyResolve = undefined; }
        return;
      }
      this.onMessage(document, panel, msg);
    });
    this._panels.set(document, panel);
    panel.onDidDispose(() => { sub.dispose(); this._panels.delete(document); });

    panel.webview.html = this.renderHtml(panel.webview, filePath, buffer);

    // IMPORTANT: launch indexing in the background and return immediately.
    // If we awaited here, VS Code wouldn't display the webview (black screen
    // + small default loading bar) until indexing finishes, which can take
    // a long time for large files.
    void this.bootstrapDocument(document, panel, filePath, webviewReady);
  }

  private async bootstrapDocument(
    document: MaximusDocument,
    panel: vscode.WebviewPanel,
    filePath: string,
    webviewReady: Promise<void>
  ): Promise<void> {
    try {
      // Cleanup of temp files left over from any previously interrupted save.
      void this.cleanupOrphanTmp(filePath);

      // Wait for the handshake (3s safety timeout) so we don't lose the
      // first progress messages.
      await Promise.race([webviewReady, new Promise<void>((r) => setTimeout(r, 3000))]);

      panel.webview.postMessage({ type: 'indexing', state: 'start' });
      let lastIdxPermille = -1;
      const idxWorkers = vscode.workspace
        .getConfiguration('maximus')
        .get<number>('searchWorkers', 0);
      await parallelBuildIndex(document.index, { workers: idxWorkers }, (p) => {
        const permille = p.totalBytes > 0 ? Math.floor((p.bytesRead / p.totalBytes) * 1000) : 0;
        if (permille === lastIdxPermille && p.bytesRead < p.totalBytes) return;
        lastIdxPermille = permille;
        panel.webview.postMessage({
          type: 'indexing',
          state: 'progress',
          bytesRead: p.bytesRead,
          totalBytes: p.totalBytes,
          linesIndexed: p.linesIndexed,
        });
      });

      document.reader = await FileReader.openLegacy(filePath, document.index);

      panel.webview.postMessage({
        type: 'ready',
        totalLines: document.index.totalLines,
        totalBytes: document.index.totalBytes,
        fileName: path.basename(filePath),
        language: detectLanguage(filePath),
      });
    } catch (err: any) {
      panel.webview.postMessage({ type: 'error', message: 'Open failed: ' + safeErrorMessage(err) });
    }
  }

  private async onMessage(doc: MaximusDocument, panel: vscode.WebviewPanel, msg: any): Promise<void> {
    const wv = panel.webview;
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    // Defense-in-depth: validate untrusted webview input at the boundary.
    // The webview is our own code under a strict CSP, but a compromised
    // renderer or buggy message must never crash the extension host or
    // trigger huge allocations. All checks here are O(1).
    const total = doc.index.totalLines || 0;
    const virtTotal = doc.overlay.virtualLineCount(total);
    const isVirtLine = (n: any) => Number.isInteger(n) && n >= 0 && n < Math.max(virtTotal + 1, 1 << 30);
    const isIdx = (n: any) => Number.isInteger(n) && n >= 0;
    const isStr = (s: any, max: number) => typeof s === 'string' && s.length <= max;
    // Cap a single edited line at 8 MiB. Beyond that the surgical-rewrite
    // bytes-aligned path stops being meaningful and a hostile sender could
    // cause the overlay Map to balloon RAM.
    const MAX_EDIT_LEN = 8 * 1024 * 1024;
    // Cap query/replacement strings; any real search needle is small.
    const MAX_QUERY_LEN = 64 * 1024;
    // A single editRange replacement (Enter on a huge selection, paste of
    // a multi-line string) — same cap as a line edit, but applied on the
    // raw replacement string before splitting.
    const MAX_REPLACEMENT_LEN = MAX_EDIT_LEN;
    switch (msg.type) {
      case 'requestLines': {
        // `start`/`end` are VIRTUAL line indices (post-overlay numbering).
        // We translate them through the overlay to fetch the right slice
        // of the underlying file, then build the patched / inserted lines.
        const { start, end, requestId } = msg;
        if (!isIdx(start) || !isIdx(end) || end < start || end - start > 1 << 20) return;
        if (!doc.reader) return;
        const lines = await doc.overlay.applyToVirtualRange(
          start, end, total,
          (origStart, count) => doc.reader!.readLines(origStart, origStart + count)
        );
        wv.postMessage({ type: 'lines', requestId, start, lines });
        break;
      }
      case 'edit': {
        // Single-line edit. `line` is VIRTUAL. Routes to setLine for orig
        // lines (legacy fast path) or in-place mutation of an inserted
        // line in the overlay.
        const { line, content } = msg;
        if (!isVirtLine(line) || !isStr(content, MAX_EDIT_LEN)) return;
        const pos = doc.overlay.virtualToOrig(line, total);
        if (!pos) return;
        if (pos.insertOffset === -1) {
          // Modifying an orig line: classic patch with undo support.
          const prev = await this.peekOrigLine(doc, pos.origLine);
          doc.overlay.setLine(pos.origLine, content);
          const origLine = pos.origLine;
          doc.notifyEdit(
            () => {
              if (prev === null) doc.overlay.deleteLine(origLine);
              else doc.overlay.setLine(origLine, prev);
              wv.postMessage({ type: 'invalidate', line });
            },
            () => {
              doc.overlay.setLine(origLine, content);
              wv.postMessage({ type: 'invalidate', line });
            },
            'Edit line ' + (line + 1)
          );
        } else {
          // Modifying an inserted line in place: no undo metadata path
          // for now (the line was created in the same overlay session,
          // user can still revert via reset / discard).
          const arr = (doc.overlay as any).insertions.get(pos.origLine) as string[] | undefined;
          if (arr && pos.insertOffset < arr.length) {
            const prev = arr[pos.insertOffset];
            arr[pos.insertOffset] = content;
            const origLine = pos.origLine;
            const offset = pos.insertOffset;
            doc.notifyEdit(
              () => {
                const a = (doc.overlay as any).insertions.get(origLine) as string[] | undefined;
                if (a && offset < a.length) a[offset] = prev;
                wv.postMessage({ type: 'invalidate', line });
              },
              () => {
                const a = (doc.overlay as any).insertions.get(origLine) as string[] | undefined;
                if (a && offset < a.length) a[offset] = content;
                wv.postMessage({ type: 'invalidate', line });
              },
              'Edit line ' + (line + 1)
            );
          }
        }
        wv.postMessage({ type: 'dirty', dirty: true });
        break;
      }
      case 'editRange': {
        // Multi-line edit: replaces a virtual range by `replacement` (which
        // may itself contain newlines). Used for Enter (split), Backspace
        // at start of line / Delete at end (join), and Backspace / Delete
        // on a multi-line selection (full replace + line-count change).
        const { fromLine, fromCol, toLine, toCol, replacement, requestId } = msg;
        if (!isVirtLine(fromLine) || !isVirtLine(toLine)) return;
        if (!isIdx(fromCol) || !isIdx(toCol)) return;
        if (!isStr(replacement, MAX_REPLACEMENT_LEN)) return;
        if (toLine < fromLine || (toLine === fromLine && toCol < fromCol)) return;
        // Snapshot the overlay so undo can revert to the exact prior state.
        // This is heavier than a per-line undo but is still O(edited lines)
        // and handles the multi-line case correctly.
        const snapshot = (doc.overlay as any)._snapshot();
        try {
          const result = await doc.overlay.replaceVirtualRange(
            total, fromLine, fromCol, toLine, toCol, replacement,
            (origLine) => this.readOrigLine(doc, origLine)
          );
          const undo = () => {
            (doc.overlay as any)._restore(snapshot);
            wv.postMessage({ type: 'editRangeApplied', requestId, undone: true,
              totalLines: doc.overlay.virtualLineCount(total) });
          };
          const after = (doc.overlay as any)._snapshot();
          const redo = () => {
            (doc.overlay as any)._restore(after);
            wv.postMessage({ type: 'editRangeApplied', requestId, undone: false,
              totalLines: doc.overlay.virtualLineCount(total),
              caretLine: result.caretLine, caretCol: result.caretCol });
          };
          doc.notifyEdit(undo, redo, 'Edit range');
          wv.postMessage({
            type: 'editRangeApplied',
            requestId,
            undone: false,
            totalLines: doc.overlay.virtualLineCount(total),
            caretLine: result.caretLine,
            caretCol: result.caretCol,
            fromLine,
          });
          wv.postMessage({ type: 'dirty', dirty: true });
        } catch (e: any) {
          (doc.overlay as any)._restore(snapshot);
          wv.postMessage({ type: 'error', message: 'Edit failed: ' + safeErrorMessage(e) });
        }
        break;
      }
      case 'search': {
        const { query, isRegex, caseSensitive, wholeWord, requestId } = msg;
        if (!isStr(query, MAX_QUERY_LEN)) return;
        if (doc.searchAbort) doc.searchAbort.aborted = true;
        const abort = { aborted: false };
        doc.searchAbort = abort;
        doc.hits = undefined; // free the previous store

        let lastSearchPermille = -1;
        let lastCountReport = 0;

        try {
          const cfgWorkers = vscode.workspace
            .getConfiguration('maximus')
            .get<number>('searchWorkers', 0);
          const store = await parallelSearch(
            doc.uri.fsPath,
            doc.index,
            { query, isRegex, caseSensitive, wholeWord, workers: cfgWorkers },
            (totalSoFar) => {
              if (abort.aborted) return;
              // Stream only the counter (hits live extension-side and are
              // queried on demand by the webview).
              const now = Date.now();
              if (now - lastCountReport < 80) return;
              lastCountReport = now;
              wv.postMessage({ type: 'searchCount', requestId, count: totalSoFar });
            },
            (br, total) => {
              if (abort.aborted) return;
              const permille = total > 0 ? Math.floor((br / total) * 1000) : 0;
              if (permille === lastSearchPermille && br < total) return;
              lastSearchPermille = permille;
              wv.postMessage({ type: 'searchProgress', requestId, bytesRead: br, totalBytes: total });
            },
            abort
          );
          if (!abort.aborted) {
            doc.hits = store;
            wv.postMessage({
              type: 'searchDone',
              requestId,
              totalHits: store.count,
            });
          }
        } catch (e: any) {
          wv.postMessage({ type: 'error', message: 'Search failed: ' + e.message });
        }
        break;
      }
      case 'queryHitsRange': {
        const { lineFrom, lineTo, requestId } = msg;
        if (!isIdx(lineFrom) || !isIdx(lineTo) || lineTo < lineFrom) {
          wv.postMessage({ type: 'hitsRange', requestId, hits: [] });
          break;
        }
        const hits = doc.hits ? doc.hits.hitsInRange(lineFrom, lineTo) : [];
        wv.postMessage({ type: 'hitsRange', requestId, lineFrom, lineTo, hits });
        break;
      }
      case 'queryHitNav': {
        // direction: 'first'|'last'|'next'|'prev'|'index'|'atOrAfter'
        const { requestId, direction, currentIndex, line, column } = msg;
        const s = doc.hits;
        if (!s || s.count === 0) {
          wv.postMessage({ type: 'hitNav', requestId, hit: null, total: 0 });
          break;
        }
        let idx = -1;
        switch (direction) {
          case 'first': idx = 0; break;
          case 'last': idx = s.count - 1; break;
          case 'next':
            idx = (typeof currentIndex === 'number' && currentIndex >= 0)
              ? (currentIndex + 1) % s.count
              : 0;
            break;
          case 'prev':
            idx = (typeof currentIndex === 'number' && currentIndex >= 0)
              ? (currentIndex - 1 + s.count) % s.count
              : s.count - 1;
            break;
          case 'index':
            idx = Math.max(0, Math.min(s.count - 1, currentIndex | 0));
            break;
          case 'atOrAfter':
            idx = s.firstAtOrAfter(line | 0, column | 0);
            if (idx < 0) idx = 0;
            break;
          default: idx = 0;
        }
        const hit = s.at(idx);
        wv.postMessage({ type: 'hitNav', requestId, hit, total: s.count });
        break;
      }
      case 'cancelSearch': {
        if (doc.searchAbort) doc.searchAbort.aborted = true;
        break;
      }
      case 'confirmReplaceAll': {
        // Native VS Code confirmation (window.confirm is disabled in
        // webviews). On refusal, re-enable the button webview-side;
        // otherwise relay the message to the 'replaceAll' handler below.
        const { query, replacement } = msg;
        if (!isStr(query, MAX_QUERY_LEN) || !isStr(replacement, MAX_QUERY_LEN)) {
          wv.postMessage({ type: 'replaceCancelled' });
          break;
        }
        const choice = await vscode.window.showWarningMessage(
          `Replace all occurrences of “${query}” with “${replacement}” in the entire file?`,
          { modal: true, detail: 'The operation rewrites the file on disk (streaming, low RAM).' },
          'Replace All'
        );
        if (choice !== 'Replace All') {
          wv.postMessage({ type: 'replaceCancelled' });
          break;
        }
        // Forward a synthetic 'replaceAll' message to the same dispatcher.
        await this.onMessage(doc, panel, { ...msg, type: 'replaceAll' });
        break;
      }
      case 'replaceAll': {
        const { query, replacement, isRegex, caseSensitive, wholeWord } = msg;
        if (!isStr(query, MAX_QUERY_LEN) || !isStr(replacement, MAX_QUERY_LEN)) {
          wv.postMessage({ type: 'replaceError', message: 'Invalid query or replacement.' });
          break;
        }
        try {
          // Any unsaved edit in the overlay would be overwritten by the
          // file rewrite on disk. We reject to avoid losing user changes.
          if (doc.overlay.isDirty()) {
            wv.postMessage({
              type: 'replaceError',
              message: 'Save your pending changes (Ctrl+S) before running Replace All.',
            });
            break;
          }
          // The reader stays open during streamReplaceAll: the rewrite
          // happens in a .maximus-tmp-* file (the original is not modified
          // until the rename happens). This lets requestLines arriving
          // during the operation keep serving lines (stale views, but
          // displayed) — otherwise the webview would show "..." everywhere
          // as soon as the user scrolls.
          let lastReplacePermille = -1;
          let lastReplaceCount = -1;
          const result = await streamReplaceAll(
            doc.uri.fsPath,
            { query, replacement, isRegex, caseSensitive, wholeWord },
            (br, total, repl) => {
              const permille = total > 0 ? Math.floor((br / total) * 1000) : 0;
              if (permille === lastReplacePermille && repl === lastReplaceCount && br < total) return;
              lastReplacePermille = permille;
              lastReplaceCount = repl;
              wv.postMessage({
                type: 'replaceProgress',
                bytesProcessed: br,
                totalBytes: total,
                replacements: repl,
              });
            }
          );
          // After the atomic rename done by streamReplaceAll: the current
          // fd points to the old (unlinked) inode. We close it and reindex
          // on the new file.
          if (doc.reader) {
            try { await doc.reader.close(); } catch { /* */ }
            doc.reader = undefined;
          }
          // Full reindex (the size and line numbering may have changed).
          // We report progress on the same webview-side bar ("Reindexing"
          // phase) so the user doesn't think the replace is stuck.
          doc.index.offsets.length = 1;
          doc.index.offsets[0] = 0;
          doc.index.totalLines = 0;
          doc.index.totalBytes = 0;
          doc.index.eofOffset = 0;
          doc.index.hasTrailingLine = false;
          wv.postMessage({ type: 'replaceStage', stage: 'reindex' });
          let lastReindexPermille = -1;
          await parallelBuildIndex(
            doc.index,
            { workers: vscode.workspace.getConfiguration('maximus').get<number>('searchWorkers', 0) },
            (p) => {
              const permille = p.totalBytes > 0 ? Math.floor((p.bytesRead / p.totalBytes) * 1000) : 0;
              if (permille === lastReindexPermille && p.bytesRead < p.totalBytes) return;
              lastReindexPermille = permille;
              wv.postMessage({
                type: 'replaceProgress',
                stage: 'reindex',
                bytesProcessed: p.bytesRead,
                totalBytes: p.totalBytes,
              });
            }
          );
          doc.reader = await FileReader.openLegacy(doc.uri.fsPath, doc.index);
          wv.postMessage({
            type: 'replaceDone',
            replacements: result.replacements,
            totalLines: doc.index.totalLines,
            totalBytes: doc.index.totalBytes,
          });
        } catch (e: any) {
          wv.postMessage({ type: 'replaceError', message: safeErrorMessage(e) });
          // Try to reopen the fd even on error so the editor stays usable.
          if (!doc.reader) {
            try { doc.reader = await FileReader.openLegacy(doc.uri.fsPath, doc.index); } catch { /* */ }
          }
        }
        break;
      }
      case 'save': {
        // Delegate to VS Code: the standard command will call our
        // saveCustomDocument() then clear the white "modified" dot.
        try {
          await vscode.commands.executeCommand('workbench.action.files.save');
        } catch (e: any) {
          wv.postMessage({ type: 'error', message: 'Save failed: ' + safeErrorMessage(e) });
        }
        break;
      }
    }
  }

  /** Reads the orig line content as it would appear AFTER the overlay is
   *  applied (i.e. patched if a patch exists, raw otherwise). Used to
   *  capture an undo snapshot before modifying. */
  private async peekOrigLine(doc: MaximusDocument, origLine: number): Promise<string | null> {
    if (!doc.reader) return null;
    const raw = await doc.reader.readLines(origLine, origLine + 1);
    if (raw.length === 0) return null;
    const applied = doc.overlay.applyToRange(origLine, raw);
    return applied[0] ?? null;
  }

  /** Raw orig line content (no overlay), used by replaceVirtualRange when
   *  it needs the source-of-truth content for an unmodified line. */
  private async readOrigLine(doc: MaximusDocument, origLine: number): Promise<string> {
    if (!doc.reader) return '';
    const raw = await doc.reader.readLines(origLine, origLine + 1);
    return raw[0] ?? '';
  }

  // ---- Save / Backup / Revert ------------------------------------------
  async saveCustomDocument(doc: MaximusDocument, _token: vscode.CancellationToken): Promise<void> {
    if (!doc.overlay.isDirty()) return;
    const panel = this._panels.get(doc);
    panel?.webview.postMessage({ type: 'saveStart', totalBytes: doc.index.totalBytes });
    try {
      // We must close the fd before the rewrite/rename, otherwise we'd
      // keep reading the old inode after the save.
      if (doc.reader) {
        try { await doc.reader.close(); } catch { /* */ }
        doc.reader = undefined;
      }
      const saveResult = await doc.overlay.save(doc.uri.fsPath, doc.index, (br, total) => {
        this.broadcastSaveProgress(doc, br, total);
      });
      doc.overlay.reset();
      if (saveResult.inPlace) {
        // Fast path: no byte changed → the index is still valid, skip
        // reindexing. Just reopen the fd for reading.
        doc.reader = await FileReader.openLegacy(doc.uri.fsPath, doc.index);
        panel?.webview.postMessage({
          type: 'saved',
          totalLines: doc.index.totalLines,
          totalBytes: doc.index.totalBytes,
        });
        return;
      }
      if (saveResult.shifts !== null) {
        // Surgical "single-line" path: patch the index in-place rather
        // than reindexing everything (saves several seconds on 30 GB).
        // No line is added/removed, only offsets after the modified zone
        // are shifted by the cumulative delta.
        patchSparseIndex(doc.index, saveResult.shifts);
        const stat = await fs.promises.stat(doc.uri.fsPath);
        doc.index.totalBytes = stat.size;
        doc.reader = await FileReader.openLegacy(doc.uri.fsPath, doc.index);
        panel?.webview.postMessage({
          type: 'saved',
          totalLines: doc.index.totalLines,
          totalBytes: doc.index.totalBytes,
        });
        return;
      }
      // Reset the index then rebuild it on the new file
      doc.index.offsets.length = 1;
      doc.index.offsets[0] = 0;
      doc.index.totalLines = 0;
      doc.index.totalBytes = 0;
      doc.index.eofOffset = 0;
      doc.index.hasTrailingLine = false;
      panel?.webview.postMessage({ type: 'saveStage', stage: 'reindex' });
      await parallelBuildIndex(doc.index, {
        workers: vscode.workspace.getConfiguration('maximus').get<number>('searchWorkers', 0),
      });
      doc.reader = await FileReader.openLegacy(doc.uri.fsPath, doc.index);
      panel?.webview.postMessage({
        type: 'saved',
        totalLines: doc.index.totalLines,
        totalBytes: doc.index.totalBytes,
      });
    } catch (e: any) {
      panel?.webview.postMessage({
        type: 'saveError',
        message: safeErrorMessage(e),
      });
      throw e;
    }
  }

  private _saveProgressGate = new WeakMap<MaximusDocument, number>();
  private broadcastSaveProgress(doc: MaximusDocument, bytesProcessed: number, totalBytes: number) {
    const panel = this._panels.get(doc);
    if (!panel) return;
    const permille = totalBytes > 0 ? Math.floor((bytesProcessed / totalBytes) * 1000) : 0;
    const last = this._saveProgressGate.get(doc) ?? -1;
    if (permille === last && bytesProcessed < totalBytes) return;
    this._saveProgressGate.set(doc, bytesProcessed >= totalBytes ? -1 : permille);
    panel.webview.postMessage({ type: 'saveProgress', bytesProcessed, totalBytes });
  }

  private async cleanupOrphanTmp(filePath: string): Promise<void> {
    try {
      const dir = path.dirname(filePath);
      const base = path.basename(filePath) + '.maximus-tmp-';
      const entries = await fs.promises.readdir(dir);
      await Promise.all(
        entries
          .filter((e) => e.startsWith(base))
          .map((e) => fs.promises.unlink(path.join(dir, e)).catch(() => undefined))
      );
    } catch { /* */ }
  }

  async saveCustomDocumentAs(
    doc: MaximusDocument,
    destination: vscode.Uri,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const tmp = makeTmpPath(destination.fsPath);
    // 'wx' = O_CREAT | O_EXCL: refuses to follow a pre-existing symlink or
    // overwrite an existing file at that path (defense-in-depth).
    const out = fs.createWriteStream(tmp, { flags: 'wx' });
    const input = fs.createReadStream(doc.uri.fsPath, { encoding: 'utf8', highWaterMark: 1 << 20 });
    let buffer = '';
    let lineNo = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        out.on('error', reject);
        input.on('data', (chunk: string | Buffer) => {
          buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
          let nl: number;
          while ((nl = buffer.indexOf('\n')) !== -1) {
            let line = buffer.slice(0, nl);
            if (line.endsWith('\r')) line = line.slice(0, -1);
            buffer = buffer.slice(nl + 1);
            const out2 = doc.overlay.applyToRange(lineNo, [line]);
            for (const l of out2) out.write(l + '\n');
            lineNo++;
          }
        });
        input.on('end', () => {
          if (buffer.length > 0) {
            const out2 = doc.overlay.applyToRange(lineNo, [buffer]);
            for (const l of out2) out.write(l + '\n');
          }
          out.end(() => resolve());
        });
        input.on('error', reject);
      });
      await fs.promises.rename(tmp, destination.fsPath);
    } catch (e) {
      try { await fs.promises.unlink(tmp); } catch { /* */ }
      throw e;
    }
  }

  async revertCustomDocument(doc: MaximusDocument, _token: vscode.CancellationToken): Promise<void> {
    doc.overlay.reset();
  }

  async backupCustomDocument(
    doc: MaximusDocument,
    context: vscode.CustomDocumentBackupContext,
    _token: vscode.CancellationToken
  ): Promise<vscode.CustomDocumentBackup> {
    const data = JSON.stringify({
      patches: Array.from((doc.overlay as any).patches.entries()),
      insertions: Array.from((doc.overlay as any).insertions.entries()),
      deletions: Array.from((doc.overlay as any).deletions.values()),
    });
    await fs.promises.writeFile(context.destination.fsPath, data, 'utf8');
    return {
      id: context.destination.toString(),
      delete: async () => {
        try { await fs.promises.unlink(context.destination.fsPath); } catch { /* */ }
      },
    };
  }

  private renderHtml(webview: vscode.Webview, filePath: string, bufferLines: number): string {
    const mediaUri = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'main.css'));
    const hljsCss = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'highlight.css'));
    const hljsJs = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'highlight.min.js'));
    const nonce = getNonce();
    const csp =
      `default-src 'none'; ` +
      `style-src ${webview.cspSource} 'unsafe-inline'; ` +
      `script-src 'nonce-${nonce}'; ` +
      `font-src ${webview.cspSource};`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${styleUri}" />
  <link rel="stylesheet" href="${hljsCss}" />
  <title>${escapeHtml(path.basename(filePath))}</title>
</head>
<body>
  <div id="toolbar">
    <span id="status">Indexing…</span>
    <span id="dirty"></span>
    <span id="saveIndicator" class="hidden"><span class="spinner"></span><span id="saveLabel">Saving…</span></span>
    <button id="saveBtn" title="Ctrl+S">Save</button>
  </div>
  <div id="progressBar" class="indeterminate">
    <div id="progressFill"></div>
    <div id="progressLabel">Indexing…</div>
  </div>
  <div id="searchBar" class="hidden">
    <div id="searchRow">
      <input id="searchInput" type="text" placeholder="Search…" />
      <label><input type="checkbox" id="caseSensitive" /> Aa</label>
      <label><input type="checkbox" id="wholeWord" /> &#10214;W&#10215;</label>
      <label><input type="checkbox" id="isRegex" /> .*</label>
      <span id="searchCount"></span>
      <button id="prevHit" title="Shift+Enter">&#9650;</button>
      <button id="nextHit" title="Enter">&#9660;</button>
      <button id="closeSearch" title="Esc">&#10005;</button>
    </div>
    <div id="searchProgressBar" class="mxs-mini-bar hidden">
      <div class="mxs-mini-fill"></div>
      <div class="mxs-mini-label">Searching… 0.0%</div>
    </div>
    <div id="replaceRow" class="hidden">
      <input id="replaceInput" type="text" placeholder="Replace with…" />
      <button id="replaceAllBtn" title="Replace All">Replace All</button>
      <span id="replaceProgress"></span>
    </div>
    <div id="replaceProgressBar" class="mxs-mini-bar hidden">
      <div class="mxs-mini-fill"></div>
      <div class="mxs-mini-label">Replacing… 0.0%</div>
    </div>
  </div>
  <div id="gotoBar" class="hidden">
    <input id="gotoInput" type="text" inputmode="numeric" placeholder="Go to line (1 - …)" />
    <span id="gotoHint"></span>
    <button id="closeGoto" title="Esc">&#10005;</button>
  </div>
  <div id="replaceLockBanner">
    <span class="spinner"></span>
    <span>Replace in progress&nbsp;— editing temporarily disabled to avoid conflicts. Search, navigation and scrolling remain available.</span>
  </div>
  <div id="viewport" tabindex="0">
    <div id="spacer"></div>
    <div id="rendered"></div>
  </div>
  <script nonce="${nonce}">window.HFV_CONFIG = { bufferLines: ${Number.isFinite(bufferLines) ? Math.max(0, Math.min(10000, Math.floor(bufferLines))) : 20} };</script>
  <script nonce="${nonce}" src="${hljsJs}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function detectLanguage(filePath: string): string {
  const base = path.basename(filePath).toLowerCase();
  // Filename-only matches (no extension).
  if (base === 'dockerfile' || base.endsWith('.dockerfile')) return 'dockerfile';
  if (base === 'makefile' || base === 'gnumakefile') return 'makefile';
  if (base === 'cmakelists.txt') return 'cmake';

  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    // Delimited (custom renderer in media/main.js)
    '.csv': 'csv',
    '.tsv': 'tsv',
    '.psv': 'psv',
    // Data / config
    '.json': 'json',
    '.json5': 'json',
    '.jsonl': 'json',
    '.ndjson': 'json',
    '.geojson': 'json',
    '.har': 'json',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.toml': 'ini',
    '.ini': 'ini',
    '.conf': 'ini',
    '.cfg': 'ini',
    '.properties': 'properties',
    '.env': 'properties',
    '.xml': 'xml',
    '.html': 'xml',
    '.htm': 'xml',
    '.svg': 'xml',
    '.xhtml': 'xml',
    '.xsl': 'xml',
    '.xsd': 'xml',
    '.rss': 'xml',
    '.atom': 'xml',
    '.plist': 'xml',
    '.md': 'markdown',
    '.markdown': 'markdown',
    '.diff': 'diff',
    '.patch': 'diff',
    // Query / shell
    '.sql': 'sql',
    '.sh': 'bash',
    '.bash': 'bash',
    '.zsh': 'bash',
    '.ksh': 'bash',
    '.ps1': 'powershell',
    '.psm1': 'powershell',
    // Web / styling
    '.css': 'css',
    '.scss': 'scss',
    '.sass': 'scss',
    '.less': 'less',
    // Programming
    '.js': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.jsx': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.py': 'python',
    '.pyw': 'python',
    '.java': 'java',
    '.kt': 'kotlin',
    '.kts': 'kotlin',
    '.scala': 'scala',
    '.go': 'go',
    '.rs': 'rust',
    '.c': 'c',
    '.h': 'c',
    '.cpp': 'cpp',
    '.cxx': 'cpp',
    '.cc': 'cpp',
    '.hpp': 'cpp',
    '.hh': 'cpp',
    '.cs': 'csharp',
    '.swift': 'swift',
    '.m': 'objectivec',
    '.mm': 'objectivec',
    '.php': 'php',
    '.rb': 'ruby',
    '.pl': 'perl',
    '.pm': 'perl',
    '.lua': 'lua',
    '.r': 'r',
    '.dart': 'dart',
    '.groovy': 'groovy',
    '.gradle': 'groovy',
    // Plain
    '.log': 'plaintext',
    '.txt': 'plaintext',
    '.text': 'plaintext',
    '.huge': 'plaintext',
  };
  return map[ext] ?? 'plaintext';
}

/**
 * Patches a SparseLineIndex in place after a "single-line" save.
 * No \\n changed, so `totalLines` and `step` stay identical; only the
 * offsets after each modified zone need to be shifted by the cumulative
 * `deltaBytes`. `eofOffset` is shifted by the total sum.
 *
 * Cost: O(number of anchors = totalLines/step) — for 30 GB / 600M lines
 * with step=1000, that's 600K in-memory operations ⇒ a few ms,
 * vs ~60 s for a full rebuild via parallelBuildIndex.
 */
function patchSparseIndex(
  index: SparseLineIndex,
  shifts: Array<{ fromOffset: number; deltaBytes: number }>
): void {
  if (shifts.length === 0) return;
  const sorted = [...shifts].sort((a, b) => a.fromOffset - b.fromOffset);
  const offsets = index.offsets;
  let shiftIdx = 0;
  let cumulative = 0;
  // Assumption: offsets are sorted (by construction). We advance shiftIdx
  // in parallel, accumulating `cumulative` whenever we cross a
  // shift.fromOffset.
  for (let k = 0; k < offsets.length; k++) {
    const orig = offsets[k];
    while (shiftIdx < sorted.length && sorted[shiftIdx].fromOffset <= orig) {
      cumulative += sorted[shiftIdx].deltaBytes;
      shiftIdx++;
    }
    offsets[k] = orig + cumulative;
  }
  // Apply the remaining delta to eofOffset.
  while (shiftIdx < sorted.length) {
    cumulative += sorted[shiftIdx].deltaBytes;
    shiftIdx++;
  }
  index.eofOffset += cumulative;
}

function safeErrorMessage(e: any): string {
  // Only forward the first line of the message and cap length: full stack
  // traces or filesystem paths in errors must not leak through the webview
  // boundary (defense-in-depth: webview is sandboxed but messages may be
  // surfaced to the user verbatim).
  const raw = (e && typeof e.message === 'string') ? e.message : String(e ?? 'Unknown error');
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? '';
  return firstLine.length > 500 ? firstLine.slice(0, 500) + '…' : firstLine;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function getNonce(): string {
  // Cryptographically secure nonce for the CSP. Math.random() is not
  // suitable here: a predictable nonce would defeat the script-src policy
  // since an attacker who could inject HTML could also guess the nonce.
  return crypto.randomBytes(24).toString('base64');
}

/**
 * Builds an `<orig>.maximus-tmp-<ts>-<rand>` path. The random suffix
 * (16 hex chars from `crypto.randomBytes`) makes the name unguessable so
 * a local attacker cannot pre-create a symlink on it (the open call below
 * uses `wx`/`O_EXCL` to refuse an existing target as a defense-in-depth).
 */
function makeTmpPath(filePath: string): string {
  return filePath + '.maximus-tmp-' + Date.now() + '-' + crypto.randomBytes(8).toString('hex');
}
