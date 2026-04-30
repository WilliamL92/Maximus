import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { SparseLineIndex } from './lineIndex';

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
  /** Inserted lines: key = line before which we insert */
  private insertions = new Map<number, string[]>();
  private deletions = new Set<number>();

  isDirty(): boolean {
    return this.patches.size > 0 || this.insertions.size > 0 || this.deletions.size > 0;
  }

  setLine(line: number, content: string) {
    this.deletions.delete(line);
    this.patches.set(line, content);
  }

  deleteLine(line: number) {
    this.patches.delete(line);
    this.deletions.add(line);
  }

  insertBefore(line: number, content: string[]) {
    const arr = this.insertions.get(line) ?? [];
    arr.push(...content);
    this.insertions.set(line, arr);
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

  reset() {
    this.patches.clear();
    this.insertions.clear();
    this.deletions.clear();
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

      await fs.promises.rename(tmp, filePath);
      return canPatchIndex ? shifts : null;
    } catch (e) {
      try { await fs.promises.unlink(tmp); } catch { /* */ }
      throw e;
    } finally {
      await srcFd.close();
    }
  }
}
