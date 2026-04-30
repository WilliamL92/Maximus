/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Indexing worker thread. Counts `\n` in a [startByte, endByte) range
 * of the file and returns:
 *   - count       : number of `\n` in the segment
 *   - lineStarts  : transferable Float64Array containing the byte offset
 *                   of the start of each line whose `\n` lies in the
 *                   segment (= position of \n + 1).
 *                   Entry j corresponds globally to line
 *                   sum(counts[0..i-1]) + j + 1.
 *   - lastByte    : last byte read (used to detect hasTrailingLine on
 *                   the final segment).
 *
 * Segments are NOT aligned on line boundaries — since `\n` is a single
 * non-multibyte UTF-8 character, simple byte-range counting is correct.
 */
import { parentPort, workerData } from 'worker_threads';
import * as fs from 'fs';

interface WorkerInput {
  filePath: string;
  startByte: number;
  endByte: number;
  workerId: number;
  estLines: number; // estimate for pre-allocation
}

const data = workerData as WorkerInput;
const port = parentPort!;
const CHUNK = 1 << 22; // 4 MB

(async () => {
  try {
    const fd = await fs.promises.open(data.filePath, 'r');
    try {
      // Initial allocation, doubled on demand.
      let cap = Math.max(64, data.estLines | 0);
      let lineStarts = new Float64Array(cap);
      let count = 0;
      let lastByte = 0;
      let pos = data.startByte;

      while (pos < data.endByte) {
        const want = Math.min(CHUNK, data.endByte - pos);
        const buf = Buffer.allocUnsafe(want);
        const { bytesRead } = await fd.read(buf, 0, want, pos);
        if (bytesRead === 0) break;
        const base = pos;
        for (let i = 0; i < bytesRead; i++) {
          const b = buf[i];
          lastByte = b;
          if (b === 0x0a) {
            if (count >= cap) {
              cap = cap * 2;
              const grown = new Float64Array(cap);
              grown.set(lineStarts);
              lineStarts = grown;
            }
            lineStarts[count++] = base + i + 1;
          }
        }
        pos += bytesRead;
        // Progress: 1 event per chunk (the parent throttles to 80 ms).
        port.postMessage({ type: 'progress', workerId: data.workerId, bytesProcessed: pos - data.startByte });
      }

      // Trim to the actual size to minimize the transfer.
      const trimmed = new Float64Array(count);
      trimmed.set(lineStarts.subarray(0, count));
      port.postMessage(
        { type: 'done', workerId: data.workerId, count, lastByte, lineStarts: trimmed },
        [trimmed.buffer]
      );
    } finally {
      await fd.close();
    }
  } catch (e: any) {
    port.postMessage({ type: 'error', workerId: data.workerId, message: e?.message ?? String(e) });
  }
})();
