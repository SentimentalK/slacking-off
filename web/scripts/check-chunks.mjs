import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import process from 'node:process';

const DIST = new URL('../dist/', import.meta.url).pathname;
const ASSETS = join(DIST, 'assets');
const MARK = 'WebGLRenderer';

const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const entryMatch = html.match(/<script[^>]*type="module"[^>]*src="\/?(assets\/[^"]+\.js)"/);
if (!entryMatch) {
  console.error('FAIL: no module entry script in dist/index.html');
  process.exit(1);
}
const entry = entryMatch[1];

const blocks = readdirSync(ASSETS)
  .filter((name) => name.endsWith('.js') || name.endsWith('.css'))
  .map((name) => {
    const buf = readFileSync(join(ASSETS, name));
    return { name: `assets/${name}`, raw: buf.length, gzip: gzipSync(buf, { level: 9 }).length, text: buf.toString('utf8') };
  });

for (const b of blocks) {
  const role = b.name === entry ? ' (entry)' : b.text.includes(MARK) ? ' (three)' : '';
  console.log(`${b.name}${role}\traw ${b.raw}\tgzip ${b.gzip}`);
}

const entryBlock = blocks.find((b) => b.name === entry);
const failures = [];
if (!entryBlock) failures.push(`entry ${entry} missing from dist/assets`);
if (entryBlock && entryBlock.text.includes(MARK)) failures.push(`entry block ${entry} contains ${MARK}`);
const threeBlocks = blocks.filter((b) => b.name !== entry && b.name.endsWith('.js') && b.text.includes(MARK));
if (threeBlocks.length === 0) failures.push(`no separate block contains ${MARK}`);

const entryGzip = entryBlock?.gzip ?? 0;
const threeGzip = threeBlocks.reduce((sum, b) => sum + b.gzip, 0);
console.log(`entry gzip ${entryGzip}\tthree gzip ${threeGzip}`);

if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL: ${f}`);
  process.exit(1);
}
console.log('OK: entry block is free of WebGLRenderer; three.js renderer lives in a separate block');
