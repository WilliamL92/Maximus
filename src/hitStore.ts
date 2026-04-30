/**
 * HitStore: compact storage of search results in typed arrays.
 *
 * For 17M hits:
 *   - 17M × 4 bytes (lines)   = 68 MB
 *   - 17M × 4 bytes (columns) = 68 MB
 *   - 17M × 2 bytes (length)  = 34 MB
 *   Total ≈ 170 MB (vs ~1.4 GB with classic JS objects).
 *
 * Hits are globally SORTED by (line, column) because the search workers
 * process disjoint, ordered byte ranges of the file.
 *
 * Internal storage:
 *   - During streaming, we accumulate per-worker a list of fixed-size chunks
 *     (Int32Array). No reallocation/copy.
 *   - On `seal()`, we consolidate into 3 large typed arrays so we can use
 *     binary search in O(log N).
 */
const CHUNK_HITS = 1 << 14; // 16384 hits / chunk = 192 KB

export interface HitChunk {
  lines: Int32Array;
  cols: Int32Array;
  lens: Int16Array;
  count: number; // number of hits filled in this chunk
}

export class HitStore {
  /** chunks per workerId, in arrival order for each worker */
  private perWorker: HitChunk[][] = [];
  private _count = 0;

  /** After seal(): global arrays sorted by (line, col). */
  public lines: Int32Array | null = null;
  public cols: Int32Array | null = null;
  public lens: Int16Array | null = null;
  private _sealed = false;

  get count(): number { return this._count; }
  get sealed(): boolean { return this._sealed; }

  /**
   * Receives a batch already encoded as typed arrays from a worker.
   * No copy: we keep the transferred buffers as-is.
   */
  appendBatch(workerId: number, chunk: HitChunk): void {
    if (!this.perWorker[workerId]) this.perWorker[workerId] = [];
    this.perWorker[workerId].push(chunk);
    this._count += chunk.count;
  }

  /**
   * Consolidates per-worker chunks into 3 large global typed arrays.
   * Call once the search is finished. Workers are assumed to be indexed
   * 0..N-1 in the order of their byte ranges (and therefore line numbers).
   */
  seal(): void {
    if (this._sealed) return;
    const total = this._count;
    const lines = new Int32Array(total);
    const cols = new Int32Array(total);
    const lens = new Int16Array(total);
    let off = 0;
    for (let w = 0; w < this.perWorker.length; w++) {
      const chunks = this.perWorker[w];
      if (!chunks) continue;
      for (const c of chunks) {
        if (c.count === 0) continue;
        lines.set(c.lines.subarray(0, c.count), off);
        cols.set(c.cols.subarray(0, c.count), off);
        lens.set(c.lens.subarray(0, c.count), off);
        off += c.count;
      }
    }
    this.lines = lines;
    this.cols = cols;
    this.lens = lens;
    // Free the intermediate chunks to reclaim ~50% of the RAM.
    this.perWorker = [];
    this._sealed = true;
  }

  /**
   * Indices [first, last] (inclusive) of hits within the line range
   * [lineFrom, lineTo] (inclusive). Returns [-1,-1] if empty.
   */
  rangeIndices(lineFrom: number, lineTo: number): [number, number] {
    if (!this._sealed || !this.lines) return [-1, -1];
    const arr = this.lines;
    const n = arr.length;
    if (n === 0) return [-1, -1];
    // first index with line >= lineFrom
    let lo = 0, hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid] < lineFrom) lo = mid + 1; else hi = mid;
    }
    const first = lo;
    if (first >= n || arr[first] > lineTo) return [-1, -1];
    // first index with line > lineTo
    lo = first; hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid] <= lineTo) lo = mid + 1; else hi = mid;
    }
    return [first, lo - 1];
  }

  /** Hits within a line range, in JSON-friendly form. */
  hitsInRange(lineFrom: number, lineTo: number): Array<{ line: number; column: number; length: number; index: number }> {
    const [a, b] = this.rangeIndices(lineFrom, lineTo);
    if (a < 0) return [];
    const out = new Array(b - a + 1);
    for (let i = a; i <= b; i++) {
      out[i - a] = { line: this.lines![i], column: this.cols![i], length: this.lens![i], index: i };
    }
    return out;
  }

  at(index: number): { line: number; column: number; length: number; index: number } | null {
    if (!this._sealed || index < 0 || index >= this._count) return null;
    return { line: this.lines![index], column: this.cols![index], length: this.lens![index], index };
  }

  /** First hit with line >= fromLine (or column >= fromCol if same line). */
  firstAtOrAfter(fromLine: number, fromCol: number): number {
    if (!this._sealed || !this.lines || !this.cols) return -1;
    const lines = this.lines;
    const cols = this.cols;
    const n = lines.length;
    let lo = 0, hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const l = lines[mid];
      if (l < fromLine || (l === fromLine && cols[mid] < fromCol)) lo = mid + 1;
      else hi = mid;
    }
    return lo < n ? lo : -1;
  }

  /** Last hit with line <= toLine (and col <= toCol if same line). */
  lastAtOrBefore(toLine: number, toCol: number): number {
    if (!this._sealed || !this.lines || !this.cols) return -1;
    const lines = this.lines;
    const cols = this.cols;
    const n = lines.length;
    let lo = 0, hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const l = lines[mid];
      if (l < toLine || (l === toLine && cols[mid] <= toCol)) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  }
}

export const HIT_CHUNK_SIZE = CHUNK_HITS;
