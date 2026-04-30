/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Byte-by-byte search worker over a [startByte, endByte) range of a file.
 * The worker also receives startLine = 0-indexed number of the first line
 * contained in the range (computed by the main thread from the sparse
 * index). It returns its hits in batches via parentPort.
 *
 * Splitting is aligned by the main thread on line ends (`\n`), so the
 * worker doesn't have to handle overlap.
 *
 * Memory: a single in-flight chunk (4 MB by default), same algorithm as
 * the literal fast path of search.ts. No extra threading overhead (each
 * worker has its own fd and its own Buffer).
 */
import { parentPort, workerData } from 'worker_threads';
import * as fs from 'fs';

interface WorkerInput {
  filePath: string;
  startByte: number;
  endByte: number;       // exclusive
  startLine: number;     // 0-indexed number of the 1st complete line in the segment
  needle: Uint8Array;    // pattern (already UTF-8 encoded)
  caseInsensitive: boolean;
  wholeWord: boolean;
  isRegex: boolean;
  // For regex mode we fall back to RegExp inside the worker (JS regex stays
  // confined to the worker, no main-thread cost).
  regexSource?: string;
  regexFlags?: string;
  workerId: number;
}

const data = workerData as WorkerInput;
const port = parentPort!;

const CHUNK = 1 << 22; // 4 MB
const EMPTY = Buffer.alloc(0);

// Batch in typed arrays: zero-copy (transferable) transfer to the main thread.
// 16384 hits / batch = 192 KB. Aligned with HIT_CHUNK_SIZE in hitStore.ts.
const BATCH = 1 << 14;
let bufLines = new Int32Array(BATCH);
let bufCols = new Int32Array(BATCH);
let bufLens = new Int16Array(BATCH);
let bufCount = 0;

function flush() {
  if (bufCount === 0) return;
  // Slice = same buffer (sub-view), so we must repost a COPY to transfer.
  // → we allocate the next batch and transfer the previous one.
  const sentLines = bufLines;
  const sentCols = bufCols;
  const sentLens = bufLens;
  const sentCount = bufCount;
  bufLines = new Int32Array(BATCH);
  bufCols = new Int32Array(BATCH);
  bufLens = new Int16Array(BATCH);
  bufCount = 0;
  port.postMessage(
    { type: 'hits', workerId: data.workerId, count: sentCount, lines: sentLines, cols: sentCols, lens: sentLens },
    [sentLines.buffer, sentCols.buffer, sentLens.buffer]
  );
}

function emit(line: number, column: number, length: number) {
  bufLines[bufCount] = line;
  bufCols[bufCount] = column;
  bufLens[bufCount] = length;
  bufCount++;
  if (bufCount >= BATCH) flush();
}

function isWordByte(b: number): boolean {
  return (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) ||
         (b >= 0x61 && b <= 0x7a) || b === 0x5f;
}

function toLowerAscii(buf: Buffer): Buffer {
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    out[i] = (b >= 0x41 && b <= 0x5a) ? b + 32 : b;
  }
  return out;
}

async function runLiteral(): Promise<number> {
  const fd = await fs.promises.open(data.filePath, 'r');
  try {
    const ci = data.caseInsensitive;
    const ww = data.wholeWord;
    const needleBuf = Buffer.from(data.needle);
    const needle = ci ? toLowerAscii(needleBuf) : needleBuf;
    const needleLen = needle.length;

    let pos = data.startByte;
    let carry: Buffer = EMPTY;
    let lineNo = data.startLine;
    let totalHits = 0;

    while (pos < data.endByte) {
      const want = Math.min(CHUNK, data.endByte - pos);
      const buf = Buffer.allocUnsafe(want);
      const { bytesRead } = await fd.read(buf, 0, want, pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
      const slice = bytesRead === buf.length ? buf : buf.subarray(0, bytesRead);

      const combined = carry.length === 0 ? slice : Buffer.concat([carry, slice], carry.length + slice.length);
      const lookup = ci ? toLowerAscii(combined) : combined;

      const lastNl = combined.lastIndexOf(0x0a);
      // If we're on the last chunk of the segment, process EVERYTHING (the
      // trailing "line" without \n is valid).
      const isLastChunk = pos >= data.endByte;
      const processedEnd = isLastChunk ? combined.length : (lastNl === -1 ? 0 : lastNl + 1);

      if (processedEnd > 0) {
        // Ultra-fast path: no match at all in the chunk -> just count \n.
        const firstMatch = lookup.indexOf(needle, 0);
        if (firstMatch === -1 || firstMatch >= processedEnd) {
          let count = 0;
          for (let i = 0; i < processedEnd; i++) {
            if (combined[i] === 0x0a) count++;
          }
          lineNo += count;
        } else {
          // Linear scan of the chunk: jump from match to match (memmem
          // SIMD via Buffer.indexOf), and between matches catch up the line
          // counter by scanning \n. Complexity = O(chunk size), independent
          // of the number of lines or pattern rarity.
          let curLine = lineNo;
          let curLineStart = 0;          // start of the current line (byte)
          let scanFrom = 0;              // search position for the next match
          let nlCounted = 0;             // upper bound already counted for \n
          let found = firstMatch;
          // eslint-disable-next-line no-constant-condition
          while (true) {
            if (found === -1 || found >= processedEnd) {
              // No more match in the processed area: catch up the remaining
              // \n to sync lineNo with processedEnd.
              for (let i = nlCounted; i < processedEnd; i++) {
                if (combined[i] === 0x0a) {
                  curLine++;
                  curLineStart = i + 1;
                }
              }
              nlCounted = processedEnd;
              break;
            }
            // Count \n between nlCounted and found to position curLine.
            for (let i = nlCounted; i < found; i++) {
              if (combined[i] === 0x0a) {
                curLine++;
                curLineStart = i + 1;
              }
            }
            nlCounted = found;
            // Verify the match doesn't cross a \n (otherwise it spans two
            // lines: we ignore it).
            let crossesNl = false;
            for (let i = found; i < found + needleLen; i++) {
              if (combined[i] === 0x0a) { crossesNl = true; break; }
            }
            if (!crossesNl) {
              let accept = true;
              if (ww) {
                const before = found > curLineStart ? combined[found - 1] : 0;
                const afterIdx = found + needleLen;
                const afterByte = afterIdx < processedEnd && combined[afterIdx] !== 0x0a
                  ? combined[afterIdx] : 0;
                if (isWordByte(before) || isWordByte(afterByte)) accept = false;
              }
              if (accept) {
                // Decode only the prefix and the match
                let prefixEnd = found;
                if (prefixEnd > curLineStart && combined[prefixEnd - 1] === 0x0d) {
                  // \r right before the match: ignored for the column (rare)
                }
                const prefix = combined.slice(curLineStart, prefixEnd).toString('utf8');
                const matchStr = combined.slice(found, found + needleLen).toString('utf8');
                emit(curLine, prefix.length, matchStr.length);
                totalHits++;
              }
            }
            scanFrom = found + (needleLen > 0 ? needleLen : 1);
            if (scanFrom >= processedEnd) {
              // Final catch-up of \n
              for (let i = nlCounted; i < processedEnd; i++) {
                if (combined[i] === 0x0a) {
                  curLine++;
                  curLineStart = i + 1;
                }
              }
              nlCounted = processedEnd;
              break;
            }
            found = lookup.indexOf(needle, scanFrom);
          }
          lineNo = curLine;
        }
      }

      carry = processedEnd < combined.length ? combined.slice(processedEnd) : EMPTY;
      // Progress emitted on every chunk: no throttling here (the parent
      // already throttles to 80 ms on the main thread). On a hot cache,
      // chunks can take <1 ms and worker-side throttling would lose 100%
      // of events.
      port.postMessage({ type: 'progress', workerId: data.workerId, bytesProcessed: pos - data.startByte });
    }
    return totalHits;
  } finally {
    await fd.close();
  }
}

async function runRegex(): Promise<number> {
  // Regex path: read lines via UTF-8 streaming line-by-line.
  // Slower, but preserves standard RegExp semantics.
  const fd = await fs.promises.open(data.filePath, 'r');
  try {
    const re = new RegExp(data.regexSource!, data.regexFlags!);
    let pos = data.startByte;
    let carry = '';
    let lineNo = data.startLine;
    let totalHits = 0;

    while (pos < data.endByte) {
      const want = Math.min(CHUNK, data.endByte - pos);
      const buf = Buffer.allocUnsafe(want);
      const { bytesRead } = await fd.read(buf, 0, want, pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
      const text = carry + buf.slice(0, bytesRead).toString('utf8');
      const isLastChunk = pos >= data.endByte;
      // Locate the last line ending to defer the incomplete tail.
      let lastNl = text.lastIndexOf('\n');
      if (isLastChunk) lastNl = text.length - 1;
      const processed = lastNl >= 0 ? text.slice(0, lastNl + 1) : '';
      carry = lastNl >= 0 ? text.slice(lastNl + 1) : text;

      let lineStart = 0;
      while (lineStart <= processed.length) {
        const nl = processed.indexOf('\n', lineStart);
        if (nl === -1 && lineStart >= processed.length) break;
        const lineRawEnd = nl === -1 ? processed.length : nl;
        let lineEnd = lineRawEnd;
        if (lineEnd > lineStart && processed[lineEnd - 1] === '\r') lineEnd--;
        const line = processed.slice(lineStart, lineEnd);
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) {
          emit(lineNo, m.index, m[0].length);
          totalHits++;
          if (m.index === re.lastIndex) re.lastIndex++;
        }
        lineNo++;
        if (nl === -1) break;
        lineStart = nl + 1;
      }
      port.postMessage({ type: 'progress', workerId: data.workerId, bytesProcessed: pos - data.startByte });
    }
    return totalHits;
  } finally {
    await fd.close();
  }
}

(async () => {
  try {
    const total = data.isRegex ? await runRegex() : await runLiteral();
    flush();
    port.postMessage({ type: 'done', workerId: data.workerId, total });
  } catch (e: any) {
    port.postMessage({ type: 'error', workerId: data.workerId, message: e?.message ?? String(e) });
  }
})();
