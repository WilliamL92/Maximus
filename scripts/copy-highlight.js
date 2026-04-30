// Bundle highlight.js (subset of common large-file-friendly languages) into
// an IIFE file that exposes window.hljs. Also copies the CSS theme.
//
// Selection rationale (RAM-friendly): every language registered here is
// stateless line-by-line in highlight.js, so the per-line highlight cost
// stays O(line length) regardless of file size. The bundle is loaded once
// at webview start; growing the language set has zero per-file or
// per-line memory impact.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const mediaDir = path.join(root, 'media');
if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });

const hlRoot = path.join(root, 'node_modules', 'highlight.js');
if (!fs.existsSync(hlRoot)) {
  console.warn('[prepare-media] highlight.js missing — run `npm install` first.');
  fs.writeFileSync(path.join(mediaDir, 'highlight.min.js'), 'window.hljs = null;');
  fs.writeFileSync(path.join(mediaDir, 'highlight.css'), '');
  process.exit(0);
}

let esbuild;
try {
  esbuild = require('esbuild');
} catch {
  console.warn('[prepare-media] esbuild missing — syntax coloring disabled.');
  fs.writeFileSync(path.join(mediaDir, 'highlight.min.js'), 'window.hljs = null;');
  fs.writeFileSync(path.join(mediaDir, 'highlight.css'), '');
  process.exit(0);
}

// Languages registered. Each maps to highlight.js/lib/languages/<name>.
// Aliases are handled in src/customEditor.ts:detectLanguage().
const LANGUAGES = [
  // Data / config
  'json', 'yaml', 'xml', 'ini', 'properties', 'markdown', 'diff',
  // Query / shell
  'sql', 'bash', 'powershell', 'dockerfile', 'makefile',
  // Web
  'css', 'scss', 'less',
  // General-purpose programming
  'javascript', 'typescript', 'python', 'java', 'kotlin', 'scala',
  'go', 'rust', 'c', 'cpp', 'csharp', 'swift', 'objectivec',
  'php', 'ruby', 'perl', 'lua', 'r', 'dart', 'groovy',
];

const entryPath = path.join(__dirname, '_hljs-entry.js');
const lines = ["const hljs = require('highlight.js/lib/core');"];
for (const lang of LANGUAGES) {
  // Skip silently any language missing from the installed highlight.js
  // version (forward-compat / partial installs).
  const langFile = path.join(hlRoot, 'lib', 'languages', lang + '.js');
  if (!fs.existsSync(langFile)) continue;
  lines.push(`hljs.registerLanguage(${JSON.stringify(lang)}, require(${JSON.stringify('highlight.js/lib/languages/' + lang)}));`);
}
lines.push('window.hljs = hljs;', '');
fs.writeFileSync(entryPath, lines.join('\n'));

try {
  esbuild.buildSync({
    entryPoints: [entryPath],
    bundle: true,
    minify: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    outfile: path.join(mediaDir, 'highlight.min.js'),
    logLevel: 'warning',
  });
} finally {
  try { fs.unlinkSync(entryPath); } catch { /* ignore */ }
}

const themeCandidates = ['github-dark.min.css', 'github-dark.css', 'default.min.css'];
let css = '';
for (const c of themeCandidates) {
  const p = path.join(hlRoot, 'styles', c);
  if (fs.existsSync(p)) { css = fs.readFileSync(p, 'utf8'); break; }
}
fs.writeFileSync(path.join(mediaDir, 'highlight.css'), css);

console.log('[prepare-media] OK.');
