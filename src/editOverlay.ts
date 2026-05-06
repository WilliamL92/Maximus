import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { SparseLineIndex } from './lineIndex';
import { safeRename } from './safeRename';

const EMPTY = Buffer.alloc(0);

/**
 * In-memory edits. For huge files we don't rewrite in place: we keep a
 * dictionary `lineNo -> new content`. On save we stream the original file
 * line by line and write to a temporary file, replacing patched lines,
 * then atomically rename.
 *
 * RAM cost: O(number of edited lines) — not the file size.
 */
export class EditOverlay {
  private patches = new Map<number, string>();
  /** Inserted lines: key = orig line index, lines are inserted just BEFORE
   *  this orig line. An entry can stay attached to a deleted orig line —
   *  surgicalRewrite emits insertions BEFORE the line at the same offset
   *  (zero-width edits sort before the line's own delete/patch). */
  private insertions = new Map<number, string[]>();
  private deletions = new Set<number>();

  /** Lazy cache of sorted union(insertions.keys, deletions). Recomputed on
   *  any mutation. Used by virtualToOrig to walk the orig→virtual mapping
   *  in O(k) where k = number of edits, instead of O(origTotal). */
  private interestingCache: number[] | null = null;
  private invalidateCache() { this.interestingCache = null; }

  private interesting(): number[] {
    if (this.interestingCache !== null) return this.interestingCache;
    const set = new Set<number>();
    for (const k of this.insertions.keys()) set.add(k);
    for (const k of this.deletions) set.add(k);
    const arr = Array.from(set).sort((a, b) => a - b);
    this.interestingCache = arr;
    return arr;
  }

  isDirty(): boolean {
    return this.patches.size > 0 || this.insertions.size > 0 || this.deletions.size > 0;
  }

  setLine(line: number, content: string) {
    this.deletions.delete(line);
    this.patches.set(line, content);
    this.invalidateCache();
  }

  deleteLine(line: number) {
    this.patches.delete(line);
    this.deletions.add(line);
    this.invalidateCache();
  }

  insertBefore(line: number, content: string[]) {
    const arr = this.insertions.get(line) ?? [];
    arr.push(...content);
    this.insertions.set(line, arr);
    this.invalidateCache();
  }

  /** Apply the overlay to raw lines read at offset `start`. */
  applyToRange(start: number, lines: string[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const idx = start + i;
      const ins = this.insertions.get(idx);
      if (ins) out.push(...ins);
      if (this.deletions.has(idx)) continue;
      const patched = this.patches.get(idx);
      out.push(patched !== undefined ? patched : lines[i]);
    }
    return out;
  }

  // ---- Virtual line API ------------------------------------------------
  // The webview talks in "virtual line indices" (i.e. line numbers AFTER
  // the overlay has been applied). The overlay maps each virtual line to
  // either:
  //   - { origLine, insertOffset: -1 }: an unmodified or patched orig line.
  //   - { origLine, insertOffset: k>=0 }: the k-th line of insertions[origLine].
  //
  // `virtualLineCount` is the total of orig lines (minus deletions, plus
  // insertions). The walk is O(k) where k = number of edited orig lines.

  virtualLineCount(origTotal: number): number {
    let n = origTotal;
    for (const arr of this.insertions.values()) n += arr.length;
    n -= this.deletions.size;
    return n;
  }

  /** Resolves a virtual line index to an (origLine, insertOffset) pair.
   *  Returns null if the index is out of range. O(k). */
  virtualToOrig(virtualLine: number, origTotal: number): { origLine: number; insertOffset: number } | null {
    if (virtualLine < 0) return null;
    let currentOrig = 0;
    let currentVirt = 0;
    for (const L of this.interesting()) {
      // Lines [currentOrig, L) are unchanged orig lines (1:1 mapping).
      const gap = L - currentOrig;
      if (virtualLine < currentVirt + gap) {
        return { origLine: currentOrig + (virtualLine - currentVirt), insertOffset: -1 };
      }
      currentVirt += gap;
      currentOrig = L;
      // Insertions BEFORE orig L.
      const ins = this.insertions.get(L);
      if (ins) {
        if (virtualLine < currentVirt + ins.length) {
          return { origLine: L, insertOffset: virtualLine - currentVirt };
        }
        currentVirt += ins.length;
      }
      // The orig line L itself (unless deleted).
      if (!this.deletions.has(L)) {
        if (virtualLine === currentVirt) {
          return { origLine: L, insertOffset: -1 };
        }
        currentVirt += 1;
      }
      currentOrig = L + 1;
    }
    // Tail: lines [currentOrig, origTotal) are unchanged.
    const gap = origTotal - currentOrig;
    if (virtualLine < currentVirt + gap) {
      return { origLine: currentOrig + (virtualLine - currentVirt), insertOffset: -1 };
    }
    return null;
  }

  /** Resolves a virtual line range to the orig line range that covers it.
   *  Used by applyToVirtualRange to read the right slice from the file. */
  private origCoverage(virtualStart: number, virtualEnd: number, origTotal: number): { origStart: number; origEndExclusive: number } | null {
    if (virtualEnd <= virtualStart) return null;
    const startPos = this.virtualToOrig(virtualStart, origTotal);
    const endPos = this.virtualToOrig(virtualEnd - 1, origTotal);
    if (!startPos && !endPos) return null;
    const origMin = startPos?.origLine ?? 0;
    const origMax = endPos?.origLine ?? Math.max(origTotal - 1, 0);
    return { origStart: origMin, origEndExclusive: Math.min(origTotal, origMax + 1) };
  }

  /** Reads a virtual line, fetching the underlying orig content via the
   *  callback when the line is unmodified. Used by single-line edits in
   *  customEditor (edit / editRange handlers). */
  async readVirtualLine(
    virtualLine: number,
    origTotal: number,
    readOrig: (origLine: number) => Promise<string>
  ): Promise<string> {
    const pos = this.virtualToOrig(virtualLine, origTotal);
    if (!pos) throw new Error(`virtual line ${virtualLine} out of range`);
    if (pos.insertOffset >= 0) {
      const arr = this.insertions.get(pos.origLine);
      if (!arr || pos.insertOffset >= arr.length) throw new Error('inconsistent overlay');
      return arr[pos.insertOffset];
    }
    if (this.patches.has(pos.origLine)) return this.patches.get(pos.origLine)!;
    return readOrig(pos.origLine);
  }

  /** Builds an array of virtual line strings for [virtualStart, virtualEnd).
   *  `readOrigRange(start, count)` reads `count` orig lines starting at
   *  `start` from the file. This is called at most once. */
  async applyToVirtualRange(
    virtualStart: number,
    virtualEnd: number,
    origTotal: number,
    readOrigRange: (origStart: number, count: number) => Promise<string[]>
  ): Promise<string[]> {
    if (virtualEnd <= virtualStart) return [];
    const cov = this.origCoverage(virtualStart, virtualEnd, origTotal);
    let origLines: string[] = [];
    let origBase = 0;
    if (cov && cov.origEndExclusive > cov.origStart) {
      origBase = cov.origStart;
      origLines = await readOrigRange(cov.origStart, cov.origEndExclusive - cov.origStart);
    }
    const getOrig = (origLine: number): string => {
      const idx = origLine - origBase;
      if (idx < 0 || idx >= origLines.length) return '';
      return origLines[idx];
    };
    const out: string[] = [];
    for (let v = virtualStart; v < virtualEnd; v++) {
      const pos = this.virtualToOrig(v, origTotal);
      if (!pos) break;
      if (pos.insertOffset >= 0) {
        const arr = this.insertions.get(pos.origLine);
        out.push((arr && arr[pos.insertOffset]) ?? '');
      } else if (this.patches.has(pos.origLine)) {
        out.push(this.patches.get(pos.origLine)!);
      } else {
        out.push(getOrig(pos.origLine));
      }
    }
    return out;
  }

  /** Replaces the virtual range [(fromLine, fromCol), (toLine, toCol)]
   *  (closed range, i.e. the chars from fromCol up to and including toCol-1
   *  on toLine) by `replacement`, which may itself contain newlines.
   *
   *  Returns the new caret position (where the inserted text ends).
   *  Mutates patches/insertions/deletions accordingly so a subsequent
   *  save() emits the right bytes. */
  async replaceVirtualRange(
    origTotal: number,
    fromLine: number, fromCol: number,
    toLine: number, toCol: number,
    replacement: string,
    readOrig: (origLine: number) => Promise<string>
  ): Promise<{ caretLine: number; caretCol: number }> {
    if (toLine < fromLine || (toLine === fromLine && toCol < fromCol)) {
      throw new Error('invalid range');
    }
    const fromText = await this.readVirtualLine(fromLine, origTotal, readOrig);
    const toText = (fromLine === toLine) ? fromText : await this.readVirtualLine(toLine, origTotal, readOrig);
    const before = fromText.slice(0, Math.min(fromCol, fromText.length));
    const after = toText.slice(Math.min(toCol, toText.length));
    const newLines = (before + replacement + after).split('\n');

    // Snapshot all virtual positions in [fromLine, toLine] in one pass,
    // BEFORE any mutation — afterwards the overlay state changes and the
    // mapping shifts.
    type Pos = { origLine: number; insertOffset: number };
    const positions: Pos[] = [];
    for (let v = fromLine; v <= toLine; v++) {
      const p = this.virtualToOrig(v, origTotal);
      if (!p) break;
      positions.push(p);
    }
    if (positions.length === 0) throw new Error('range out of bounds');
    const firstPos = positions[0];

    // Step 1: replace the from line content with newLines[0].
    if (firstPos.insertOffset === -1) {
      this.deletions.delete(firstPos.origLine);
      this.patches.set(firstPos.origLine, newLines[0]);
    } else {
      const arr = this.insertions.get(firstPos.origLine);
      if (arr) arr[firstPos.insertOffset] = newLines[0];
    }

    // Step 2: drop the trailing positions (positions[1..]) — those are
    // virtual lines fully inside the replaced range.
    const insertedToDrop = new Map<number, number[]>();
    for (let i = 1; i < positions.length; i++) {
      const p = positions[i];
      if (p.insertOffset === -1) {
        this.deletions.add(p.origLine);
        this.patches.delete(p.origLine);
      } else {
        const list = insertedToDrop.get(p.origLine) ?? [];
        list.push(p.insertOffset);
        insertedToDrop.set(p.origLine, list);
      }
    }
    for (const [origLine, offsets] of insertedToDrop) {
      offsets.sort((a, b) => b - a); // splice from the tail to keep earlier offsets valid
      const arr = this.insertions.get(origLine);
      if (!arr) continue;
      for (const off of offsets) {
        if (off >= 0 && off < arr.length) arr.splice(off, 1);
      }
      if (arr.length === 0) this.insertions.delete(origLine);
    }

    // Step 3: insert newLines[1..] right after the from line in virtual
    // order. The anchor depends on whether the from line was an orig line
    // or an inserted line:
    //   - orig line L → push the new lines at the FRONT of insertions[L+1]
    //     so they precede whatever was already inserted before orig L+1.
    //   - inserted line at insertions[L][offset] → splice them at offset+1
    //     inside the same array (they appear immediately after the from
    //     line in virtual order).
    if (newLines.length > 1) {
      const tail = newLines.slice(1);
      if (firstPos.insertOffset === -1) {
        const target = firstPos.origLine + 1;
        const existing = this.insertions.get(target) ?? [];
        existing.unshift(...tail);
        this.insertions.set(target, existing);
      } else {
        const arr = this.insertions.get(firstPos.origLine);
        if (arr) {
          arr.splice(firstPos.insertOffset + 1, 0, ...tail);
        } else {
          // Should not happen — firstPos pointed at an inserted line.
          this.insertions.set(firstPos.origLine, tail);
        }
      }
    }

    this.invalidateCache();

    const caretLine = fromLine + (newLines.length - 1);
    const caretCol = newLines[newLines.length - 1].length - after.length;
    return { caretLine, caretCol };
  }

  reset() {
    this.patches.clear();
    this.insertions.clear();
    this.deletions.clear();
    this.invalidateCache();
  }

  /** Deep snapshot used by editRange's undo/redo. Contains a frozen view
   *  of the three internal collections at the time of the call. Cost is
   *  O(edited lines), not O(file size). */
  _snapshot(): { patches: Array<[number, string]>; insertions: Array<[number, string[]]>; deletions: number[] } {
    return {
      patches: Array.from(this.patches.entries()),
      insertions: Array.from(this.insertions.entries()).map(([k, v]) => [k, v.slice()] as [number, string[]]),
      deletions: Array.from(this.deletions),
    };
  }

  _restore(snap: { patches: Array<[number, string]>; insertions: Array<[number, string[]]>; deletions: number[] }) {
    this.patches.clear();
    this.insertions.clear();
    this.deletions.clear();
    for (const [k, v] of snap.patches) this.patches.set(k, v);
    for (const [k, v] of snap.insertions) this.insertions.set(k, v.slice());
    for (const k of snap.deletions) this.deletions.add(k);
    this.invalidateCache();
  }

  /**
   * Optimized file rewrite.
   *
   * Two paths are tried in order:
   *
   *  1. **"In-place" fast path (pwrite)**: if all edits are `setLine` AND
   *     each new line has exactly the same number of bytes as the original,
   *     we only write the changed bytes in place (`pwrite`). No file copy,
   *     no inode change → the caller can skip reindexing. Cost ≈ O(size of
   *     edits), often a few ms even for 2 GB.
   *
   *  2. **General "surgical binary rewrite"**: we compute the exact byte
   *     ranges of each edit via `SparseLineIndex.offsetOfLine`. We then
   *     copy the file in pure binary (16 MB Buffers, `fs.read`/`fs.write`)
   *     substituting only the modified zones. No UTF-8 decoding, no JS
   *     string splitting, no concat — typically 3–10x faster than the
   *     old line-by-line streaming.
   *
   * Returns:
   *  - `inPlace`: true → the index is rigorously valid (no byte moved).
   *    The caller can skip reindexing entirely.
   *  - `shifts`: if non-null → list of shifts to apply to the index to
   *    patch it in O(size of edits) instead of a full rebuild
   *    (O(file size)). Each shift = `(fromOffset, deltaBytes)`: "all
   *    offsets >= fromOffset must be shifted by deltaBytes". Covered case:
   *    only single-line `setLine` (no \\n in the new content, no insertion
   *    or deletion of a line) → the total number of \\n is preserved, so
   *    line numbering doesn't change, only offsets shift.
   *  - `shifts === null`: edits too complex (deletions/insertions or
   *    multi-line content); the caller must fully rebuild the index.
   */
  async save(
    filePath: string,
    index: SparseLineIndex,
    onProgress?: (bytesProcessed: number, totalBytes: number) => void
  ): Promise<{ inPlace: boolean; shifts: Array<{ fromOffset: number; deltaBytes: number }> | null }> {
    if (!this.isDirty()) return { inPlace: false, shifts: [] };

    // Fast path: try in-place writing.
    if (await this.tryInPlace(filePath, index, onProgress)) {
      return { inPlace: true, shifts: [] };
    }
    // General path.
    const shifts = await this.surgicalRewrite(filePath, index, onProgress);
    return { inPlace: false, shifts };
  }

  /**
   * Fast path: edits are only `setLine` + byte-equivalent → `pwrite`
   * each line at the right offset, without copying the file.
   * Returns `false` (and writes nothing) if any condition isn't met.
   */
  private async tryInPlace(
    filePath: string,
    index: SparseLineIndex,
    onProgress?: (bytesProcessed: number, totalBytes: number) => void
  ): Promise<boolean> {
    if (this.insertions.size > 0 || this.deletions.size > 0) return false;
    if (this.patches.size === 0) return false;

    const fd = await fs.promises.open(filePath, 'r');
    type Patch = { offset: number; bytes: Buffer };
    const planned: Patch[] = [];
    try {
      for (const [lineNo, newContent] of this.patches) {
        if (lineNo < 0 || lineNo >= index.totalLines) return false;
        const lineStart = await index.offsetOfLine(lineNo, fd.fd);
        const nextLine = lineNo + 1 >= index.totalLines ? index.eofOffset : await index.offsetOfLine(lineNo + 1, fd.fd);
        // Length in bytes of the line content (without trailing \n / \r\n).
        const isLast = lineNo + 1 >= index.totalLines;
        let contentEnd = nextLine;
        if (!isLast) contentEnd--; // strip the \n
        // Detect \r\n
        if (contentEnd > lineStart) {
          const probe = Buffer.alloc(1);
          await fd.read(probe, 0, 1, contentEnd - 1);
          if (probe[0] === 0x0d) contentEnd--;
        }
        const oldLen = contentEnd - lineStart;
        const newBytes = Buffer.from(newContent, 'utf8');
        if (newBytes.length !== oldLen) return false; // bail to general path
        planned.push({ offset: lineStart, bytes: newBytes });
      }
    } finally {
      await fd.close();
    }

    // All conditions met: write in place.
    const rw = await fs.promises.open(filePath, 'r+');
    try {
      let written = 0;
      for (const p of planned) {
        await rw.write(p.bytes, 0, p.bytes.length, p.offset);
        written += p.bytes.length;
      }
      await rw.sync();
      // Progress: fast path → we report 100% directly.
      if (onProgress) onProgress(index.totalBytes, index.totalBytes);
      void written;
    } finally {
      await rw.close();
    }
    return true;
  }

  /**
   * General path: surgical binary copy.
   *
   * Steps:
   *  - Compute `(origStart, origEnd, replacement)` for every edit
   *    (patches/deletions/insertions) via `offsetOfLine`.
   *  - Sort by offset and apply zero-width insertions before patches at
   *    the same offset (secondary sort by width).
   *  - **I/O pipeline**: ping-pong of two 16 MB buffers. While we write
   *    buffer A, we read the next chunk into buffer B. On disk this is
   *    ~1.5–2x faster than a sequential read→write loop.
   *  - No UTF-8 decoding, no string concatenation.
   *
   * Returns the list of shifts to apply to the index if all patches are
   * single-line (no \\n in the new content, no insertion or deletion).
   * Otherwise returns `null` → a full rebuild is needed.
   */
  private async surgicalRewrite(
    filePath: string,
    index: SparseLineIndex,
    onProgress?: (bytesProcessed: number, totalBytes: number) => void
  ): Promise<Array<{ fromOffset: number; deltaBytes: number }> | null> {
    const stat = await fs.promises.stat(filePath);
    const totalBytes = stat.size;
    const tmp = filePath + '.maximus-tmp-' + Date.now() + '-' + crypto.randomBytes(8).toString('hex');

    const srcFd = await fs.promises.open(filePath, 'r');
    let srcClosed = false;
    type Edit = { origStart: number; origEnd: number; replacement: Buffer; multilineReplacement: boolean };
    const edits: Edit[] = [];
    let canPatchIndex =
      this.deletions.size === 0 && this.insertions.size === 0;
    try {
      // Patches
      const patchLines = [...this.patches.keys()].sort((a, b) => a - b);
      for (const lineNo of patchLines) {
        if (this.deletions.has(lineNo)) continue; // deletion takes precedence
        const lineStart = lineNo >= index.totalLines ? index.eofOffset : await index.offsetOfLine(lineNo, srcFd.fd);
        const nextStart = lineNo + 1 >= index.totalLines ? index.eofOffset : await index.offsetOfLine(lineNo + 1, srcFd.fd);
        const isBareLast = lineNo === index.totalLines - 1 && index.hasTrailingLine;
        const content = this.patches.get(lineNo)!;
        const contentBuf = Buffer.from(content, 'utf8');
        // The patch stays single-line as long as `content` doesn't contain a \\n.
        const multiline = contentBuf.indexOf(0x0a) !== -1;
        if (multiline) canPatchIndex = false;
        const replacement = isBareLast
          ? contentBuf
          : Buffer.concat([contentBuf, Buffer.from([0x0a])]);
        edits.push({ origStart: lineStart, origEnd: nextStart, replacement, multilineReplacement: multiline });
      }
      // Deletions
      const delLines = [...this.deletions].sort((a, b) => a - b);
      for (const lineNo of delLines) {
        if (lineNo < 0 || lineNo >= index.totalLines) continue;
        const lineStart = await index.offsetOfLine(lineNo, srcFd.fd);
        const nextStart = lineNo + 1 >= index.totalLines ? index.eofOffset : await index.offsetOfLine(lineNo + 1, srcFd.fd);
        edits.push({ origStart: lineStart, origEnd: nextStart, replacement: EMPTY, multilineReplacement: false });
      }
      // Insertions (before line N, at the start of N)
      const insLines = [...this.insertions.keys()].sort((a, b) => a - b);
      for (const lineNo of insLines) {
        const offset = lineNo >= index.totalLines ? index.eofOffset : await index.offsetOfLine(lineNo, srcFd.fd);
        const lines = this.insertions.get(lineNo)!;
        const buf = Buffer.from(lines.map((l) => l + '\n').join(''), 'utf8');
        edits.push({ origStart: offset, origEnd: offset, replacement: buf, multilineReplacement: false });
      }

      // Primary sort by offset, secondary: zero-width (insertions) before
      // patch/delete at the same offset → the insertion is written before
      // the line.
      edits.sort((a, b) => a.origStart - b.origStart || (a.origEnd - a.origStart) - (b.origEnd - b.origStart));

      // Build the shifts list by walking the edits in order.
      // Each edit (origStart, origEnd) → (newLen): delta = newLen - (origEnd-origStart).
      // The shift applies to every offset >= origEnd in the source file.
      const shifts: Array<{ fromOffset: number; deltaBytes: number }> = [];
      let cumulativeDelta = 0;
      for (const e of edits) {
        const delta = e.replacement.length - (e.origEnd - e.origStart);
        if (delta !== 0) {
          cumulativeDelta += delta;
          shifts.push({ fromOffset: e.origEnd, deltaBytes: delta });
        }
      }
      void cumulativeDelta;

      const dstFd = await fs.promises.open(tmp, 'wx');
      try {
        const CHUNK = 16 * 1024 * 1024;
        const bufA = Buffer.allocUnsafe(CHUNK);
        const bufB = Buffer.allocUnsafe(CHUNK);
        let lastReport = 0;

        // I/O pipeline: read into `bufNext` while writing `bufCurrent`.
        // On disk this is ~1.5–2x faster than a sequential read→write.
        const copyRange = async (from: number, to: number) => {
          let pos = from;
          let useA = true;
          // Pre-read the first chunk
          let curBuf = useA ? bufA : bufB;
          let curLen = Math.min(CHUNK, to - pos);
          let curRead: Promise<{ bytesRead: number }> = srcFd.read(curBuf, 0, curLen, pos);
          while (pos < to) {
            const { bytesRead } = await curRead;
            if (bytesRead === 0) break;
            const writeBuf = curBuf;
            const writeLen = bytesRead;
            pos += bytesRead;
            // Start the next read BEFORE the current write → I/O in parallel.
            useA = !useA;
            const nextBuf = useA ? bufA : bufB;
            const nextLen = pos < to ? Math.min(CHUNK, to - pos) : 0;
            const nextRead = nextLen > 0
              ? srcFd.read(nextBuf, 0, nextLen, pos)
              : Promise.resolve({ bytesRead: 0 });
            await dstFd.write(writeBuf, 0, writeLen);
            curBuf = nextBuf;
            curRead = nextRead;
            if (onProgress && pos - lastReport > (1 << 20)) {
              lastReport = pos;
              onProgress(pos, totalBytes);
            }
          }
        };

        let srcCursor = 0;
        for (const e of edits) {
          if (e.origStart > srcCursor) {
            await copyRange(srcCursor, e.origStart);
          }
          if (e.replacement.length > 0) {
            await dstFd.write(e.replacement);
          }
          if (e.origEnd > srcCursor) srcCursor = e.origEnd;
        }
        if (srcCursor < totalBytes) {
          await copyRange(srcCursor, totalBytes);
        }
        if (onProgress) onProgress(totalBytes, totalBytes);
      } finally {
        await dstFd.close();
      }

      // Close the source file before renaming. On Windows, `rename` over
      // an open file fails with EPERM (POSIX is fine, but we need to be
      // portable).
      await srcFd.close();
      srcClosed = true;
      await safeRename(tmp, filePath);
      return canPatchIndex ? shifts : null;
    } catch (e) {
      try { await fs.promises.unlink(tmp); } catch { /* */ }
      throw e;
    } finally {
      if (!srcClosed) await srcFd.close();
    }
  }
}
