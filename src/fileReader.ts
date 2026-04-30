import * as fs from 'fs';
import { SparseLineIndex } from './lineIndex';

/**
 * Reads a range of lines [start, end) from the file without loading more than
 * necessary. Returns decoded UTF-8 lines and properly truncates very long
 * lines to avoid blowing up RAM/the webview.
 */
export interface ReadLinesOptions {
  maxLineBytes?: number; // truncate lines beyond this size
}

export class FileReader {
  constructor(private fd: number, private index: SparseLineIndex) {}

  static async open(filePath: string, index: SparseLineIndex): Promise<FileReader> {
    const fd = await fs.promises.open(filePath, 'r');
    return new FileReader((fd as any).fd ?? (fd as unknown as number), index);
  }

  // Workaround: fs.promises.open returns a FileHandle, but we want a numeric
  // fd for fs.read. So we use fs.open with a callback.
  static openLegacy(filePath: string, index: SparseLineIndex): Promise<FileReader> {
    return new Promise((resolve, reject) => {
      fs.open(filePath, 'r', (err, fd) => {
        if (err) return reject(err);
        resolve(new FileReader(fd, index));
      });
    });
  }

  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      fs.close(this.fd, (err) => (err ? reject(err) : resolve()));
    });
  }

  /**
   * Reads lines [start, end). end is exclusive. Returns an array of strings
   * (without the trailing \n).
   */
  async readLines(start: number, end: number, opts: ReadLinesOptions = {}): Promise<string[]> {
    const maxLineBytes = opts.maxLineBytes ?? 1 << 16; // 64 KB per line by default
    if (end <= start) return [];
    if (start >= this.index.totalLines) return [];
    end = Math.min(end, this.index.totalLines);

    const startOffset = await this.index.offsetOfLine(start, this.fd);
    // Read in blocks until we have (end - start) lines.
    const lines: string[] = [];
    const wanted = end - start;
    const CHUNK = 1 << 16;
    let pos = startOffset;
    let pending = Buffer.alloc(0);

    while (lines.length < wanted) {
      const buf = Buffer.alloc(CHUNK);
      const { bytesRead } = await new Promise<{ bytesRead: number }>((resolve, reject) => {
        fs.read(this.fd, buf, 0, CHUNK, pos, (err, br) => (err ? reject(err) : resolve({ bytesRead: br })));
      });
      if (bytesRead === 0) {
        // EOF: flush any pending bytes as the final line
        if (pending.length > 0 && lines.length < wanted) {
          lines.push(decodeLine(pending, maxLineBytes));
          pending = Buffer.alloc(0);
        }
        break;
      }
      pos += bytesRead;
      const slice = buf.slice(0, bytesRead);
      const combined = pending.length === 0 ? slice : Buffer.concat([pending, slice]);
      let lineStart = 0;
      for (let i = 0; i < combined.length && lines.length < wanted; i++) {
        if (combined[i] === 0x0a) {
          let lineEnd = i;
          if (lineEnd > lineStart && combined[lineEnd - 1] === 0x0d) lineEnd--; // strip \r
          lines.push(decodeLine(combined.slice(lineStart, lineEnd), maxLineBytes));
          lineStart = i + 1;
        }
      }
      pending = combined.slice(lineStart);
      if (pending.length > maxLineBytes * 4) {
        // Safety: abnormally long line, truncate it
        lines.push(decodeLine(pending.slice(0, maxLineBytes), maxLineBytes) + ' …[line truncated]');
        pending = Buffer.alloc(0);
      }
    }
    return lines;
  }
}

function decodeLine(buf: Buffer, max: number): string {
  if (buf.length > max) {
    return buf.slice(0, max).toString('utf8') + ' …[line truncated]';
  }
  return buf.toString('utf8');
}
