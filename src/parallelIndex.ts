import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { Worker } from 'worker_threads';
import { SparseLineIndex, IndexProgress } from './lineIndex';

/**
 * Builds the sparse index of a file in parallel. N workers split the
 * bytes into equal shares; each one returns its list of line starts
 * (one entry per `\n` encountered). The main thread consolidates by
 * picking one entry every `step` lines to populate `index.offsets`.
 *
 * Peak memory during the merge: ~8 bytes × N_lines.
 * For 21M lines ≈ 168 MB freed immediately afterwards.
 */
const MIN_PARALLEL_BYTES = 16 * 1024 * 1024;

export async function parallelBuildIndex(
  index: SparseLineIndex,
  opts: { workers?: number },
  onProgress?: (p: IndexProgress) => void
): Promise<void> {
  const filePath = index.filePath;
  const stat = await fs.promises.stat(filePath);
  index.totalBytes = stat.size;
  if (stat.size === 0) {
    index.totalLines = 0;
    if (onProgress) onProgress({ bytesRead: 0, totalBytes: 0, linesIndexed: 0 });
    return;
  }

  const cores = Math.max(1, (os as any).availableParallelism?.() ?? os.cpus().length);
  let nWorkers: number;
  if (!opts.workers || opts.workers <= 0) nWorkers = cores;
  else nWorkers = Math.min(opts.workers, cores);
  if (stat.size < MIN_PARALLEL_BYTES) nWorkers = 1;
  nWorkers = Math.max(1, Math.min(nWorkers, Math.floor(stat.size / (4 * 1024 * 1024))));
  if (nWorkers === 0) nWorkers = 1;

  // Strict byte-based splitting (no need to align on \n: a `\n` is a
  // single byte, so local counting is exact).
  const ranges: Array<{ startByte: number; endByte: number }> = [];
  const targetSize = Math.ceil(stat.size / nWorkers);
  for (let i = 0; i < nWorkers; i++) {
    const startByte = i * targetSize;
    const endByte = i === nWorkers - 1 ? stat.size : Math.min(stat.size, (i + 1) * targetSize);
    if (endByte > startByte) ranges.push({ startByte, endByte });
  }

  // Coarse estimate of lines per worker so the worker can pre-allocate
  // (we assume 80 bytes per line on average; the worker grows the buffer
  // dynamically if needed).
  const estLinesTotal = Math.max(1024, Math.ceil(stat.size / 80));
  const estLinesPerWorker = Math.ceil(estLinesTotal / ranges.length);

  const workerPath = path.join(__dirname, 'indexWorker.js');
  const workers: Worker[] = [];
  const counts = new Array<number>(ranges.length).fill(0);
  const lineStartsArr = new Array<Float64Array | null>(ranges.length).fill(null);
  let lastByte = 0;
  const perWorkerProgress = new Array<number>(ranges.length).fill(0);
  let lastReport = 0;

  const promises = ranges.map((range, i) => new Promise<void>((resolve, reject) => {
    const w = new Worker(workerPath, {
      workerData: {
        filePath,
        startByte: range.startByte,
        endByte: range.endByte,
        workerId: i,
        estLines: estLinesPerWorker,
      },
    });
    workers.push(w);
    w.on('message', (msg: any) => {
      if (msg.type === 'progress') {
        const segLen = range.endByte - range.startByte;
        perWorkerProgress[i] = Math.max(0, Math.min(segLen, msg.bytesProcessed));
        if (onProgress && Date.now() - lastReport > 80) {
          lastReport = Date.now();
          const sum = perWorkerProgress.reduce((a, b) => a + b, 0);
          // linesIndexed unknown during the race → we extrapolate from
          // the fraction of bytes processed * estimated total lines.
          const frac = sum / stat.size;
          onProgress({
            bytesRead: Math.min(stat.size, sum),
            totalBytes: stat.size,
            linesIndexed: Math.floor(frac * estLinesTotal),
          });
        }
      } else if (msg.type === 'done') {
        counts[i] = msg.count;
        lineStartsArr[i] = msg.lineStarts as Float64Array;
        if (i === ranges.length - 1) lastByte = msg.lastByte;
        perWorkerProgress[i] = range.endByte - range.startByte;
        resolve();
      } else if (msg.type === 'error') {
        reject(new Error(`IndexWorker #${i}: ${msg.message}`));
      }
    });
    w.on('error', reject);
    w.on('exit', (code) => { if (code !== 0 && code !== 1) resolve(); });
  }));

  try {
    await Promise.all(promises);
  } finally {
    await Promise.all(workers.map((w) => w.terminate().catch(() => undefined)));
  }

  // ---- Merge: build index.offsets by selecting one entry every
  //              `step` global lines.
  // index.offsets[0] = 0 is already initialized. Globally, the k-th `\n`
  // (0-indexed) marks the end of line k and the start of line k+1.
  // So global lineStarts[k] = byte offset of the start of line (k+1).
  // We want offsets[a] = byte offset of the start of line (a*step), for a >= 1.
  // So we look up the global entry at index (a*step - 1).
  const step = index.step;
  index.offsets.length = 1;
  index.offsets[0] = 0;

  let totalLines = 0;
  // Cumulative global offset to find (a*step - 1) without materializing
  // the whole global array.
  let globalIdx = 0; // index in the conceptual concatenated global array
  let nextTarget = step - 1; // next global index to capture
  for (let i = 0; i < ranges.length; i++) {
    const arr = lineStartsArr[i]!;
    const len = counts[i];
    while (nextTarget < globalIdx + len) {
      const local = nextTarget - globalIdx;
      index.offsets.push(arr[local]);
      nextTarget += step;
    }
    globalIdx += len;
    totalLines += len;
    // Free immediately (the transferred buffers are no longer used).
    lineStartsArr[i] = null;
  }

  // Trailing line without final `\n`?
  if (lastByte !== 0x0a) {
    totalLines += 1;
    index.hasTrailingLine = true;
  }
  index.totalLines = totalLines;
  index.eofOffset = stat.size;
  if (onProgress) onProgress({ bytesRead: stat.size, totalBytes: stat.size, linesIndexed: totalLines });
}
