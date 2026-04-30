#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Generates several large test files, one per extension supported by
 * Maximus's colored display (highlight.js + CSV colorization).
 *
 * All generators stream their output (createWriteStream + drain): RAM
 * stays constant whatever the target volume.
 *
 *   Usage: node scripts/gen-multi.js [--out=samples] [--size=200] [--formats=json,csv,js,ts,log,ndjson]
 *           --out      output directory                       (default: samples)
 *           --size     target size per file in MB             (default: 200)
 *           --formats  comma-separated list                   (default: all)
 *
 * Example:
 *   node scripts/gen-multi.js --size=1024 --out=./bench
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ALL_FORMATS = ['log', 'json', 'ndjson', 'csv', 'tsv', 'js', 'ts', 'py', 'txt'];

function parseArgs(argv) {
  const out = { outDir: 'samples', sizeMB: 200, formats: ALL_FORMATS.slice() };
  for (const a of argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (!m) continue;
    if (m[1] === 'out') out.outDir = m[2];
    else if (m[1] === 'size') out.sizeMB = parseInt(m[2], 10) || out.sizeMB;
    else if (m[1] === 'formats') out.formats = m[2].split(',').map(s => s.trim()).filter(Boolean);
  }
  return out;
}

/**
 * Streaming write loop with backpressure awareness.
 * `nextChunk(state)` must return the next string to write or `null` to
 * signal the end (typically when `state.written >= targetBytes`).
 */
function streamWrite(filePath, targetBytes, nextChunk) {
  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(filePath);
    const state = { written: 0, line: 0, target: targetBytes };
    stream.on('error', reject);
    const pump = () => {
      while (state.written < targetBytes) {
        const chunk = nextChunk(state);
        if (chunk == null) break;
        state.written += Buffer.byteLength(chunk, 'utf8');
        if (!stream.write(chunk)) {
          stream.once('drain', pump);
          return;
        }
      }
      stream.end(() => resolve(state));
    };
    pump();
  });
}

// --- Generators per format -------------------------------------------------
// Each generator produces "realistic" text to stress the colored display
// (keywords, strings, numbers, punctuation), while staying trivial to
// produce line by line.

function genLog(state) {
  const lvls = ['INFO', 'WARN', 'ERROR', 'DEBUG'];
  const lvl = lvls[state.line % lvls.length];
  state.line++;
  const ts = new Date(1700000000000 + state.line * 137).toISOString();
  return `${ts} [${lvl}] worker#${state.line % 32} processed event id=${state.line} payload=${Math.random().toString(36).slice(2)} status=ok\n`;
}

function genNdjson(state) {
  state.line++;
  return JSON.stringify({
    id: state.line,
    ts: 1700000000 + state.line,
    user: 'user_' + (state.line % 10000),
    action: ['login', 'logout', 'click', 'view', 'buy'][state.line % 5],
    ok: state.line % 7 !== 0,
    score: Math.round(Math.random() * 10000) / 100,
    tags: ['alpha', 'beta', 'gamma'].slice(0, (state.line % 3) + 1),
  }) + '\n';
}

// Valid JSON: open an array, separate elements with commas, close at the
// end via a closure on the caller side.
function makeJsonGenerator() {
  let first = true;
  let closed = false;
  return {
    next(state) {
      if (state.line === 0) {
        state.line++;
        return '[\n';
      }
      if (state.written >= state.target * 0.99) {
        if (!closed) { closed = true; return '\n]\n'; }
        return null;
      }
      const sep = first ? '  ' : ',\n  ';
      first = false;
      state.line++;
      const obj = {
        id: state.line,
        name: 'item_' + state.line,
        active: state.line % 2 === 0,
        weight: Math.round(Math.random() * 1e6) / 1000,
        meta: { created: 1700000000 + state.line, kind: 'sample' },
      };
      return sep + JSON.stringify(obj);
    },
  };
}

function genCsv(state) {
  if (state.line === 0) {
    state.line++;
    return 'id,user,event,score,timestamp,country,ok\n';
  }
  state.line++;
  const country = ['FR', 'US', 'DE', 'JP', 'BR', 'IN'][state.line % 6];
  return `${state.line},user_${state.line % 10000},${['view', 'click', 'buy'][state.line % 3]},${(Math.random() * 100).toFixed(2)},${1700000000 + state.line},${country},${state.line % 5 !== 0}\n`;
}

function genTsv(state) {
  if (state.line === 0) {
    state.line++;
    return 'id\tuser\tevent\tscore\ttimestamp\tcountry\n';
  }
  state.line++;
  return `${state.line}\tuser_${state.line % 10000}\t${['view', 'click', 'buy'][state.line % 3]}\t${(Math.random() * 100).toFixed(2)}\t${1700000000 + state.line}\tFR\n`;
}

function genJs(state) {
  state.line++;
  // Token variation to stress highlight.js.
  const variants = [
    `function handler${state.line}(req, res) { return res.json({ ok: true, id: ${state.line} }); }`,
    `const value${state.line} = { name: "item_${state.line}", price: ${(Math.random() * 1000).toFixed(2)}, active: true };`,
    `// TODO(${state.line}): refactor this branch once API v${state.line % 10} ships.`,
    `if (${state.line} % 7 === 0) { console.log("multiple of 7:", ${state.line}); } else { /* skip */ }`,
    `class Widget${state.line} extends BaseWidget { render() { return \`<div id="w-${state.line}">${state.line}</div>\`; } }`,
  ];
  return variants[state.line % variants.length] + '\n';
}

function genTs(state) {
  state.line++;
  const variants = [
    `interface User${state.line} { id: number; name: string; active?: boolean; tags: ReadonlyArray<string>; }`,
    `export const compute${state.line} = <T extends number>(x: T): T => (x * ${state.line}) as T;`,
    `type Result${state.line}<T> = { ok: true; value: T } | { ok: false; error: string };`,
    `async function fetchItem${state.line}(id: number): Promise<User${state.line} | null> { return null; }`,
    `// @ts-ignore intentional in line ${state.line}`,
  ];
  return variants[state.line % variants.length] + '\n';
}

function genPy(state) {
  state.line++;
  const variants = [
    `def handler_${state.line}(request, response):\n    return {"ok": True, "id": ${state.line}}\n`,
    `class Widget${state.line}(BaseWidget):\n    name = "widget_${state.line}"\n    def render(self):\n        return f"<div>{self.name}</div>"\n`,
    `# TODO(${state.line}): tune the threshold for batch ${state.line % 100}\n`,
    `value_${state.line} = [${state.line}, ${state.line + 1}, ${state.line * 2}]  # generated\n`,
  ];
  return variants[state.line % variants.length];
}

function genTxt(state) {
  state.line++;
  return `Lorem ipsum dolor sit amet ${state.line} ${Math.random().toString(36).slice(2)} consectetur adipiscing elit.\n`;
}

const GENERATORS = {
  log:    { ext: 'log',    next: genLog },
  ndjson: { ext: 'ndjson', next: genNdjson },
  csv:    { ext: 'csv',    next: genCsv },
  tsv:    { ext: 'tsv',    next: genTsv },
  js:     { ext: 'js',     next: genJs },
  ts:     { ext: 'ts',     next: genTs },
  py:     { ext: 'py',     next: genPy },
  txt:    { ext: 'txt',    next: genTxt },
  json:   { ext: 'json',   makeNext: () => makeJsonGenerator().next },
};

async function main() {
  const args = parseArgs(process.argv);
  const targetBytes = args.sizeMB * 1024 * 1024;
  await fs.promises.mkdir(args.outDir, { recursive: true });

  console.log(`Generating in "${args.outDir}" (~${args.sizeMB} MB per file)\n`);
  for (const fmt of args.formats) {
    const def = GENERATORS[fmt];
    if (!def) { console.warn(`  - unknown format: ${fmt} (skipped)`); continue; }
    const out = path.join(args.outDir, `huge.${def.ext}`);
    const next = def.makeNext ? def.makeNext() : def.next;
    const t0 = Date.now();
    process.stdout.write(`  - ${fmt.padEnd(7)} -> ${out} ... `);
    const state = await streamWrite(out, targetBytes, next);
    const mb = (state.written / 1024 / 1024).toFixed(1);
    console.log(`${mb} MB, ${state.line.toLocaleString()} lines, ${(Date.now() - t0)} ms`);
  }
  console.log('\nDone.');
}

main().catch((e) => { console.error(e); process.exit(1); });
