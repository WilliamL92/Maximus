import * as fs from 'fs';

/**
 * Sparse line index.
 *
 * For a file of N lines, we only store one offset (in bytes) every `step`
 * lines. The index therefore stays at O(N/step). To resolve the exact offset
 * of a line L, we jump to the nearest anchor then scan forward until we reach
 * the requested line. Cost: <= step character reads.
 */
export interface IndexProgress {
  bytesRead: number;
  totalBytes: number;
  linesIndexed: number;
}

export class SparseLineIndex {
  /** offsets[k] = byte offset of the start of line k * step */
  public readonly offsets: number[] = [0];
  public totalLines = 0;
  public totalBytes = 0;
  /** offset (exclusive) of the end of the last line (= file size minus trailing EOL) */
  public eofOffset = 0;
  /** true if the file does not end with a \n (trailing line without newline) */
  public hasTrailingLine = false;

  constructor(public readonly filePath: string, public readonly step: number = 1000) {}

  async build(onProgress?: (p: IndexProgress) => void): Promise<void> {
    const stat = await fs.promises.stat(this.filePath);
    this.totalBytes = stat.size;
    if (stat.size === 0) {
      this.totalLines = 0;
      return;
    }

    return new Promise((resolve, reject) => {
      const stream = fs.createReadStream(this.filePath, { highWaterMark: 1 << 20 });
      let offset = 0; // absolute file position of the next byte to read
      let lineCount = 0;
      let lastByte = 0;
      let lastReport = 0;

      stream.on('data', (chunkRaw: Buffer | string) => {
        const chunk = typeof chunkRaw === 'string' ? Buffer.from(chunkRaw) : chunkRaw;
        for (let i = 0; i < chunk.length; i++) {
          const b = chunk[i];
          lastByte = b;
          if (b === 0x0a /* \n */) {
            lineCount++;
            const nextLineOffset = offset + i + 1;
            if (lineCount % this.step === 0) {
              this.offsets.push(nextLineOffset);
            }
          }
        }
        offset += chunk.length;
        if (onProgress && offset - lastReport > (1 << 18) /* 256 KB */) {
          lastReport = offset;
          onProgress({ bytesRead: offset, totalBytes: stat.size, linesIndexed: lineCount });
        }
      });
      stream.on('error', reject);
      stream.on('end', () => {
        // If the file does not end with \n, there is one extra "trailing line".
        if (lastByte !== 0x0a) {
          lineCount++;
          this.hasTrailingLine = true;
        }
        this.totalLines = lineCount;
        this.eofOffset = offset;
        if (onProgress) {
          onProgress({ bytesRead: offset, totalBytes: stat.size, linesIndexed: lineCount });
        }
        resolve();
      });
    });
  }

  /** Returns the byte offset of the start of line `line` (0-indexed). */
  async offsetOfLine(line: number, fd: number): Promise<number> {
    if (line <= 0) return 0;
    if (line >= this.totalLines) return this.eofOffset;
    const anchor = Math.floor(line / this.step);
    let pos = this.offsets[anchor];
    let remaining = line - anchor * this.step;
    if (remaining === 0) return pos;

    const buf = Buffer.alloc(64 * 1024);
    while (remaining > 0) {
      const { bytesRead } = await new Promise<{ bytesRead: number }>((resolve, reject) => {
        fs.read(fd, buf, 0, buf.length, pos, (err, br) => (err ? reject(err) : resolve({ bytesRead: br })));
      });
      if (bytesRead === 0) return pos;
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === 0x0a) {
          remaining--;
          if (remaining === 0) {
            return pos + i + 1;
          }
        }
      }
      pos += bytesRead;
    }
    return pos;
  }
}
