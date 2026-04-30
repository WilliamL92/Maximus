import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { Worker } from 'worker_threads';
import { SparseLineIndex } from './lineIndex';
import { SearchOptions } from './search';
import { HitStore } from './hitStore';

/**
 * Parallel search across N workers. Each worker processes a byte range
 * [startByte, endByte) aligned on line ends, and receives `startLine`
 * (computed by the main thread from the sparse index) so it can emit hits
 * with absolute line numbers.
 *
 * Workers return their hits in file order (within their range): since
 * ranges are disjoint and ordered, the global hit order by line number is
 * preserved as long as we consume workers in order. We choose to simply
 * forward hits to the `onHit` callback as they arrive (the user mostly
 * wants to see results quickly, and the final line-sorting is done
 * webview-side anyway when populating `hitsByLine`).
 *
 * Worker count selection:
 *   - 0 (default) or < 0  -> auto = os.availableParallelism()
 *   - >= 1                -> capped at os.availableParallelism()
 * For small files (< 16 MB) we fall back to a single worker to avoid the
 * spawn cost.
 */
export interface ParallelSearchOptions extends SearchOptions {
  workers?: number;
}

const MIN_PARALLEL_BYTES = 16 * 1024 * 1024;

export async function parallelSearch(
  filePath: string,
  index: SparseLineIndex,
  opts: ParallelSearchOptions,
  onCount?: (totalSoFar: number) => void,
  onProgress?: (bytesRead: number, totalBytes: number) => void,
  abort?: { aborted: boolean }
): Promise<HitStore> {
  const store = new HitStore();
  if (!opts.query) return store;
  const stat = await fs.promises.stat(filePath);
  const totalBytes = stat.size;
  if (totalBytes === 0) { store.seal(); return store; }

  const cores = Math.max(1, (os as any).availableParallelism?.() ?? os.cpus().length);
  let nWorkers: number;
  if (!opts.workers || opts.workers <= 0) nWorkers = cores;
  else nWorkers = Math.min(opts.workers, cores);
  if (totalBytes < MIN_PARALLEL_BYTES) nWorkers = 1;
  // No more than one worker per useful slice (at least 4 MB / worker).
  nWorkers = Math.max(1, Math.min(nWorkers, Math.floor(totalBytes / (4 * 1024 * 1024))));
  if (nWorkers === 0) nWorkers = 1;

  const ranges = await splitFileIntoRanges(filePath, index, totalBytes, nWorkers);

  // Encode the pattern and precompile the regex once on the main thread.
  const needle = Buffer.from(opts.query, 'utf8');
  let regexSource: string | undefined;
  let regexFlags: string | undefined;
  if (opts.isRegex) {
    let q = opts.query;
    if (opts.wholeWord) q = `\\b(?:${q})\\b`;
    regexSource = q;
    regexFlags = 'g' + (opts.caseSensitive ? '' : 'i');
    // Validation: if the regex is invalid, fail early.
    try { new RegExp(regexSource, regexFlags); }
    catch (e: any) { throw new Error('Invalid regex: ' + e.message); }
  }

  const workerPath = path.join(__dirname, 'searchWorker.js');
  const workers: Worker[] = [];
  const perWorkerProgress = new Array(ranges.length).fill(0);
  let lastReport = 0;

  const workerPromises = ranges.map((range, i) => new Promise<void>((resolve, reject) => {
    const w = new Worker(workerPath, {
      workerData: {
        filePath,
        startByte: range.startByte,
        endByte: range.endByte,
        startLine: range.startLine,
        needle,
        caseInsensitive: !opts.caseSensitive,
        wholeWord: !!opts.wholeWord && !opts.isRegex,
        isRegex: !!opts.isRegex,
        regexSource,
        regexFlags,
        workerId: i,
      },
    });
    workers.push(w);
    w.on('message', (msg: any) => {
      if (abort?.aborted) {
        w.terminate().catch(() => undefined);
        return;
      }
      if (msg.type === 'hits') {
        store.appendBatch(msg.workerId, {
          lines: msg.lines,
          cols: msg.cols,
          lens: msg.lens,
          count: msg.count,
        });
        if (onCount) onCount(store.count);
      } else if (msg.type === 'progress') {
        // The worker sends us the absolute number of bytes processed in its
        // range. We clamp and aggregate.
        const segLen = range.endByte - range.startByte;
        perWorkerProgress[i] = Math.max(0, Math.min(segLen, msg.bytesProcessed));
        if (onProgress && Date.now() - lastReport > 80) {
          lastReport = Date.now();
          const sum = perWorkerProgress.reduce((a, b) => a + b, 0);
          onProgress(Math.min(totalBytes, sum), totalBytes);
        }
      } else if (msg.type === 'done') {
        perWorkerProgress[i] = range.endByte - range.startByte;
        if (onProgress) {
          const sum = perWorkerProgress.reduce((a, b) => a + b, 0);
          onProgress(Math.min(totalBytes, sum), totalBytes);
        }
        resolve();
      } else if (msg.type === 'error') {
        reject(new Error(`Worker #${i}: ${msg.message}`));
      }
    });
    w.on('error', reject);
    w.on('exit', (code) => { if (code !== 0 && code !== 1) resolve(); });
  }));

  try {
    await Promise.all(workerPromises);
    if (onProgress) onProgress(totalBytes, totalBytes);
  } finally {
    // Defensive cleanup: terminate any worker still alive (in case of abort).
    await Promise.all(workers.map((w) => w.terminate().catch(() => undefined)));
  }
  store.seal();
  return store;
}

/**
 * Splits the file into N [startByte, endByte) ranges using the sparse
 * index anchors directly. Since `index.offsets[k]` is by construction the
 * starting byte of line `k * index.step`, we get line-aligned boundaries
 * with EXACT line numbers for free — no need to re-scan to align.
 */
async function splitFileIntoRanges(
  _filePath: string,
  index: SparseLineIndex,
  totalBytes: number,
  n: number
): Promise<Array<{ startByte: number; endByte: number; startLine: number }>> {
  const offsets = index.offsets;
  // If the index is not ready or has only one anchor, fall back to 1 range.
  if (n <= 1 || offsets.length <= 1) {
    return [{ startByte: 0, endByte: totalBytes, startLine: 0 }];
  }
  // Pick n+1 ~equidistant anchor indices (by index, which approximates
  // "equidistant by bytes" as long as line density is homogeneous — good
  // enough for load balancing).
  const lastAnchor = offsets.length - 1;
  const step = index.step;
  const ranges: Array<{ startByte: number; endByte: number; startLine: number }> = [];
  let prevAnchorIdx = 0;
  for (let i = 1; i <= n; i++) {
    const isLast = i === n;
    const anchorIdx = isLast ? lastAnchor : Math.floor((i * lastAnchor) / n);
    if (anchorIdx <= prevAnchorIdx) continue; // safety: avoid empty ranges
    const startByte = offsets[prevAnchorIdx];
    const endByte = isLast ? totalBytes : offsets[anchorIdx];
    const startLine = prevAnchorIdx * step;
    if (endByte > startByte) {
      ranges.push({ startByte, endByte, startLine });
    }
    prevAnchorIdx = anchorIdx;
  }
  return ranges;
}
