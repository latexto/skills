#!/usr/bin/env node
// Development runner: the same CLI, pointed at a local build of the site.
// Usage: node scripts/dev.js <http(s) url> <latexto arguments...>
//   node scripts/dev.js http://localhost:8002 pdf paper.tex
// Not part of the published package (see "files" in package.json).
import { main } from '../src/cli.js';

const [url, ...rest] = process.argv.slice(2);
let parsed;
try {
  parsed = new URL(url);
} catch {}

if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
  process.stderr.write('Usage: node scripts/dev.js <http(s) url> <latexto arguments...>\n');
  process.exitCode = 2;
} else {
  await main(rest, { url });
}
