import * as fs from 'fs';
import * as readline from 'readline';
import * as crypto from 'crypto';
import { safeRename } from './safeRename';

export interface SearchHit {
  line: number; // 0-indexed
  column: number;
  length: number;
}

export interface SearchOptions {
  query: string;
  isRegex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  maxHits?: number;
  startLine?: number;
}

/**
 * Streaming search.
 *
 * Two engines:
 *   - "Literal" fast path: for non-regex queries, we work directly on byte
 *     `Buffer`s, leveraging `Buffer.indexOf` which uses `memchr` / `memmem`
 *     internally (SIMD-friendly via libc). This avoids per-line UTF-8
 *     decoding and the RegExp engine cost. On a multi-GB file the gain is
 *     typically 5–10x compared to the readline+RegExp path.
 *   - "Regex" path: for regex patterns, we keep the old line-by-line
 *     readline path.
 *
 * In both cases memory stays constant (one in-flight chunk + one carried
 * incomplete line).
 */
export async function streamSearch(
  filePath: string,
  opts: SearchOptions,
  onHit: (hit: SearchHit) => void,
  onProgress?: (bytesRead: number, totalBytes: number) => void
): Promise<void> {
  if (!opts.query) return;
  // The fast path handles ASCII queries (any combination of options is OK).
  // If the query contains non-ASCII bytes AND we are case-insensitive OR
  // whole-word, fall back to the regex engine to remain Unicode-correct.
  if (opts.isRegex) {
    return streamSearchRegex(filePath, opts, onHit, onProgress);
  }
  const needleBuf = Buffer.from(opts.query, 'utf8');
  const needleHasNonAscii = hasNonAscii(needleBuf);
  if (needleHasNonAscii && (!opts.caseSensitive || opts.wholeWord)) {
    return streamSearchRegex(filePath, opts, onHit, onProgress);
  }
  return streamSearchLiteral(filePath, opts, needleBuf, onHit, onProgress);
}

// --- Fast path: literal byte-by-byte search --------------------------------

async function streamSearchLiteral(
  filePath: string,
  opts: SearchOptions,
  needle: Buffer,
  onHit: (hit: SearchHit) => void,
  onProgress?: (bytesRead: number, totalBytes: number) => void
): Promise<void> {
  const stat = await fs.promises.stat(filePath);
  const totalBytes = stat.size;
  const ci = !opts.caseSensitive;
  const ww = !!opts.wholeWord;
  const needleLower = ci ? toLowerAscii(needle) : needle;
  const needleLen = needleLower.length;
  const maxHits = opts.maxHits ?? Number.POSITIVE_INFINITY;
  const startLine = opts.startLine ?? 0;

  // 4 MB per chunk: best empirical throughput / memory tradeoff (above
  // that, Buffer.concat allocation cost dominates).
  const stream = fs.createReadStream(filePath, { highWaterMark: 1 << 22 });

  /** Bytes of the current line (always without `\n`). */
  let carry: Buffer = EMPTY;
  /** Line number (0-indexed) of the first byte of `carry`. */
  let carryLineNo = 0;
  let bytesRead = 0;
  let lastReport = 0;
  let hits = 0;
  let stopped = false;

  const stop = () => {
    if (!stopped) { stopped = true; stream.destroy(); }
  };

  for await (const chunk of stream as AsyncIterable<Buffer>) {
    if (stopped) break;
    bytesRead += chunk.length;

    // Concat as lazily as possible: if carry is empty, work directly on
    // the chunk.
    const combined = carry.length === 0 ? chunk : Buffer.concat([carry, chunk], carry.length + chunk.length);
    const lookup = ci ? toLowerAscii(combined) : combined;

    // Find the last full line end in the chunk: anything beyond that goes
    // into `carry` for the next iteration.
    const lastNl = combined.lastIndexOf(0x0a);
    const processedEnd = lastNl === -1 ? 0 : lastNl + 1;

    if (processedEnd > 0) {
      // Ultra-fast path: if the pattern doesn't appear at all in the area
      // to process, completely skip the line walk (which costs O(lines) JS
      // ↔ native calls). We just bump the line counter via a very monomorphic
      // counting loop (V8 JIT-compiles it efficiently — ~1 GB/s).
      const firstMatch = lookup.indexOf(needleLower, 0);
      if (firstMatch === -1 || firstMatch >= processedEnd) {
        let count = 0;
        for (let i = 0; i < processedEnd; i++) {
          if (combined[i] === 0x0a) count++;
        }
        carryLineNo += count;
      } else {
        // At least one match: iterate over lines to assign hits.
        let lineStart = 0;
        let lineNo = carryLineNo;
        while (lineStart < processedEnd) {
          const nl = combined.indexOf(0x0a, lineStart);
          if (nl === -1 || nl >= processedEnd) break;
          let lineEnd = nl;
          if (lineEnd > lineStart && combined[lineEnd - 1] === 0x0d) lineEnd--;

          if (lineNo >= startLine) {
            let mp = lineStart;
            while (mp + needleLen <= lineEnd) {
              const found = lookup.indexOf(needleLower, mp);
              if (found === -1 || found + needleLen > lineEnd) break;
              if (ww) {
                const before = found > lineStart ? combined[found - 1] : 0;
                const after = found + needleLen < lineEnd ? combined[found + needleLen] : 0;
                if (isWordByte(before) || isWordByte(after)) {
                  mp = found + 1;
                  continue;
                }
              }
              emitHit(combined, lineStart, lineEnd, found, needleLen, lineNo, onHit);
              hits++;
              if (hits >= maxHits) { stop(); break; }
              mp = found + needleLen;
            }
          }
          lineStart = nl + 1;
          lineNo++;
          if (stopped) break;
        }
        carryLineNo = lineNo;
      }
    }

    // Carry over the rest of the chunk (incomplete line) for next time.
    if (processedEnd < combined.length) {
      // Safeguard: if a "line" exceeds 32 MB, we still emit the matches
      // then truncate the carry. This avoids RAM blowups on malformed
      // files (logs without \n, for example).
      const leftover = combined.slice(processedEnd);
      if (leftover.length > (1 << 25)) {
        const lookupTail = ci ? toLowerAscii(leftover) : leftover;
        if (carryLineNo >= startLine) {
          let mp = 0;
          while (mp + needleLen <= leftover.length && !stopped) {
            const found = lookupTail.indexOf(needleLower, mp);
            if (found === -1) break;
            if (ww) {
              const before = found > 0 ? leftover[found - 1] : 0;
              const after = found + needleLen < leftover.length ? leftover[found + needleLen] : 0;
              if (isWordByte(before) || isWordByte(after)) { mp = found + 1; continue; }
            }
            emitHit(leftover, 0, Math.min(leftover.length, 1 << 16), found, needleLen, carryLineNo, onHit);
            hits++;
            if (hits >= maxHits) { stop(); break; }
            mp = found + needleLen;
          }
        }
        carry = EMPTY; // give up concatenating this line with the next chunk
      } else {
        carry = leftover;
      }
    } else {
      carry = EMPTY;
    }

    if (onProgress && bytesRead - lastReport > (1 << 22)) {
      lastReport = bytesRead;
      onProgress(bytesRead, totalBytes);
    }
  }

  // Trailing line without final \n.
  if (!stopped && carry.length > 0 && carryLineNo >= startLine) {
    const lookup = ci ? toLowerAscii(carry) : carry;
    let mp = 0;
    while (mp + needleLen <= carry.length) {
      const found = lookup.indexOf(needleLower, mp);
      if (found === -1) break;
      if (ww) {
        const before = found > 0 ? carry[found - 1] : 0;
        const after = found + needleLen < carry.length ? carry[found + needleLen] : 0;
        if (isWordByte(before) || isWordByte(after)) { mp = found + 1; continue; }
      }
      emitHit(carry, 0, carry.length, found, needleLen, carryLineNo, onHit);
      hits++;
      if (hits >= maxHits) break;
      mp = found + needleLen;
    }
  }
  if (onProgress) onProgress(totalBytes, totalBytes);
}

const EMPTY = Buffer.alloc(0);

function emitHit(
  buf: Buffer,
  lineStart: number,
  _lineEnd: number,
  matchStart: number,
  matchByteLen: number,
  lineNo: number,
  onHit: (h: SearchHit) => void,
) {
  // Decode only the line prefix and the match — not the rest. This cuts
  // per-hit cost ~3x compared to decoding the full line. The legacy
  // `preview` field has been removed: it was computed for every hit but
  // never read by the webview (highlights use line/column/length on the
  // already-displayed content).
  const linePrefix = buf.slice(lineStart, matchStart).toString('utf8');
  const matchStr = buf.slice(matchStart, matchStart + matchByteLen).toString('utf8');
  onHit({
    line: lineNo,
    column: linePrefix.length,                 // column in UTF-16 code units
    length: matchStr.length,
  });
}

function isWordByte(b: number): boolean {
  return (b >= 0x30 && b <= 0x39)         // 0-9
      || (b >= 0x41 && b <= 0x5a)         // A-Z
      || (b >= 0x61 && b <= 0x7a)         // a-z
      || b === 0x5f;                      // _
}

function hasNonAscii(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; i++) if (buf[i] >= 0x80) return true;
  return false;
}

/**
 * Returns a copy of the buffer with ASCII A-Z letters lowercased. Non-ASCII
 * bytes (>= 0x80) are preserved as-is: for a purely ASCII query (the common
 * case for case-insensitive search), `Buffer.indexOf` therefore stays
 * perfectly correct on the result.
 */
function toLowerAscii(buf: Buffer): Buffer {
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    out[i] = (b >= 0x41 && b <= 0x5a) ? b + 32 : b;
  }
  return out;
}

// --- Regex path (fallback) -------------------------------------------------

async function streamSearchRegex(
  filePath: string,
  opts: SearchOptions,
  onHit: (hit: SearchHit) => void,
  onProgress?: (bytesRead: number, totalBytes: number) => void
): Promise<void> {
  const stat = await fs.promises.stat(filePath);
  const matcher = buildMatcher(opts);
  if (!matcher) return;

  const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1 << 20 });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lineNo = -1;
  let bytesReported = 0;
  let hits = 0;
  const max = opts.maxHits ?? Number.POSITIVE_INFINITY;
  const startLine = opts.startLine ?? 0;

  for await (const line of rl) {
    lineNo++;
    if (lineNo < startLine) continue;
    let m: RegExpExecArray | null;
    matcher.lastIndex = 0;
    while ((m = matcher.exec(line)) !== null) {
      onHit({
        line: lineNo,
        column: m.index,
        length: m[0].length,
      });
      if (++hits >= max) {
        rl.close();
        stream.destroy();
        return;
      }
      if (m.index === matcher.lastIndex) matcher.lastIndex++;
    }
    if (onProgress && (stream.bytesRead - bytesReported) > (1 << 22)) {
      bytesReported = stream.bytesRead;
      onProgress(stream.bytesRead, stat.size);
    }
  }
  if (onProgress) onProgress(stat.size, stat.size);
}

function buildMatcher(opts: SearchOptions): RegExp | null {
  let q = opts.query;
  if (!q) return null;
  if (!opts.isRegex) q = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (opts.wholeWord) q = `\\b(?:${q})\\b`;
  const flags = 'g' + (opts.caseSensitive ? '' : 'i');
  try {
    return new RegExp(q, flags);
  } catch {
    return null;
  }
}

export interface ReplaceOptions extends SearchOptions {
  replacement: string;
}

export interface ReplaceResult {
  replacements: number;
  totalLines: number;
  totalBytes: number;
}

/**
 * Streaming replace-all. Reads the file line by line and writes to
 * <file>.maximus-tmp-<ts>, replacing occurrences. At the end we atomically
 * rename to the original file. RAM cost: O(longest line size), not the
 * file size.
 *
 * If the user enabled `isRegex`, the `replacement` can reference groups
 * via $1, $2, etc. (standard String.prototype.replace semantics).
 * Otherwise the replacement is treated as a literal (the $ aren't special
 * because we build the regex from the query, but we still neutralize $
 * in the replacement string to avoid surprises).
 */
export async function streamReplaceAll(
  filePath: string,
  opts: ReplaceOptions,
  onProgress?: (bytesProcessed: number, totalBytes: number, replacements: number) => void
): Promise<ReplaceResult> {
  const matcher = buildMatcher(opts);
  if (!matcher) {
    return { replacements: 0, totalLines: 0, totalBytes: (await fs.promises.stat(filePath)).size };
  }
  // In "literal" mode (non-regex), neutralize the $ in the replacement so
  // we don't trigger String#replace's group semantics.
  const replacement = opts.isRegex ? opts.replacement : opts.replacement.replace(/\$/g, '$$$$');

  const stat = await fs.promises.stat(filePath);
  const totalBytes = stat.size;
  const tmp = filePath + '.maximus-tmp-' + Date.now() + '-' + crypto.randomBytes(8).toString('hex');
  // 'wx' = O_CREAT | O_EXCL: refuses to follow a pre-existing symlink/file.
  const out = fs.createWriteStream(tmp, { flags: 'wx' });
  const input = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1 << 20 });

  let buffer = '';
  let lineNo = 0;
  let bytesProcessed = 0;
  let lastReport = 0;
  let replacements = 0;

  const processLine = (line: string) => {
    matcher.lastIndex = 0;
    if (matcher.test(line)) {
      matcher.lastIndex = 0;
      // Precisely count occurrences replaced on this line
      let count = 0;
      const replaced = line.replace(matcher, (...args) => {
        count++;
        // Delegate to String#replace to handle $1..$9 and $& correctly.
        // We rebuild by taking the match argument and applying it via a
        // mini regex-replace on the replacement string.
        return expandReplacement(replacement, args);
      });
      replacements += count;
      out.write(replaced + '\n');
    } else {
      out.write(line + '\n');
    }
  };

  try {
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const fail = (e: any) => { if (!finished) { finished = true; reject(e); } };
      const done = () => { if (!finished) { finished = true; resolve(); } };

      input.on('error', fail);
      out.on('error', fail);
      out.on('finish', done);

      input.on('data', (chunk: string | Buffer) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        bytesProcessed += Buffer.byteLength(text, 'utf8');
        buffer += text;
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          let line = buffer.slice(0, nl);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          buffer = buffer.slice(nl + 1);
          processLine(line);
          lineNo++;
        }
        if (onProgress && bytesProcessed - lastReport > (1 << 20)) {
          lastReport = bytesProcessed;
          onProgress(bytesProcessed, totalBytes, replacements);
        }
      });
      input.on('end', () => {
        if (buffer.length > 0) {
          processLine(buffer);
          lineNo++;
        }
        out.end();
      });
    });

    if (onProgress) onProgress(totalBytes, totalBytes, replacements);
    await safeRename(tmp, filePath);
    const newStat = await fs.promises.stat(filePath);
    return { replacements, totalLines: lineNo, totalBytes: newStat.size };
  } catch (e) {
    try { await fs.promises.unlink(tmp); } catch { /* */ }
    throw e;
  }
}

/**
 * Reproduces standard String#replace semantics for the replacement template:
 * $$ -> $, $& -> full match, $1..$9 -> groups. Also supports $<name> if
 * named groups are present.
 */
function expandReplacement(template: string, args: any[]): string {
  // args: [match, p1, p2, ..., offset, string, groups?]
  const match = args[0];
  // Locate groups: Node passes named groups as the last object argument.
  let groups: Record<string, string> | undefined;
  if (typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null) {
    groups = args[args.length - 1];
  }
  // p1..pn = args[1 .. args.length - (groups?3:2) -1]
  const tailOffset = groups ? 3 : 2;
  const captures = args.slice(1, args.length - tailOffset);

  return template.replace(/\$(\$|&|\d{1,2}|<([^>]+)>)/g, (_m, what, named) => {
    if (what === '$') return '$';
    if (what === '&') return match;
    if (named) return (groups && groups[named]) ?? '';
    const n = parseInt(what, 10);
    if (n > 0 && n <= captures.length) return captures[n - 1] ?? '';
    return _m;
  });
}
