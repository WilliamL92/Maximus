// Generates a large test file without saturating RAM.
// Usage: node scripts/gen-huge.js <path> <size-in-MB>
const fs = require('fs');
const out = process.argv[2] || 'huge-test.log';
const sizeMB = parseInt(process.argv[3] || '500', 10);
const targetBytes = sizeMB * 1024 * 1024;

const stream = fs.createWriteStream(out);
let written = 0;
let lineNo = 0;
function writeBatch() {
  while (written < targetBytes) {
    const lines = [];
    for (let i = 0; i < 1000; i++) {
      lineNo++;
      lines.push(`${String(lineNo).padStart(10, '0')}  lorem ipsum dolor sit amet ${Math.random().toString(36).slice(2)} log entry id=${lineNo}`);
    }
    const chunk = lines.join('\n') + '\n';
    if (!stream.write(chunk)) {
      written += chunk.length;
      stream.once('drain', writeBatch);
      return;
    }
    written += chunk.length;
  }
  stream.end(() => {
    console.log(`Wrote ${out}: ${(written/1024/1024).toFixed(1)} MB, ${lineNo.toLocaleString()} lines.`);
  });
}
writeBatch();
