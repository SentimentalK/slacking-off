import { execSync } from 'node:child_process';
import { mkdirSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.out || !['ui', 'look'].includes(args.set)) {
  console.error('usage: l3-compare.mjs --set ui|look --out <dir>');
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const outDir = path.resolve(args.out);
const workDir = path.join(root, '.conductor', 'l34', 'compare');
const proto = (name) => path.join(root, 'docs', 'art', 'prototype', name);
const l3 = (name) => path.join(root, 'docs', 'screenshots', 'l3', name);
const before = (name) => path.join(root, 'docs', 'screenshots', 'l', name);
const after = (name) => path.join(root, 'docs', 'screenshots', 'l3', 'look', 'after', name);

const SETS = {
  ui: [
    { name: 'ui-compare-watch.png', left: proto('ui-watch.png'), right: l3('watch-1440.png'), labels: ['原型', '实现'] },
    { name: 'ui-compare-board.png', left: proto('ui-board.png'), right: l3('board-1440.png'), labels: ['原型', '实现'] },
    { name: 'ui-compare-account.png', left: proto('ui-account.png'), right: l3('account-1440.png'), labels: ['原型', '实现'] },
    { name: 'ui-compare-play.png', left: proto('ui-play.png'), right: l3('watch-selected-1440.png'), labels: ['原型', '实现'] },
  ],
  look: [
    { name: '1-day.png', left: before('closeup-day.png'), right: after('closeup-day.png'), labels: ['之前', '之后'] },
    { name: '2-dusk.png', left: before('closeup-dusk.png'), right: after('closeup-dusk.png'), labels: ['之前', '之后'] },
    { name: '3-forest-edge.png', left: before('overview-day.png'), right: after('overview-day.png'), labels: ['之前', '之后'] },
    { name: '4-icons.png', left: before('states.png'), right: after('states-overview.png'), labels: ['之前', '之后'] },
    { name: '5-roof.png', left: before('levels.png'), right: after('levels.png'), labels: ['之前', '之后'] },
    { name: '5b-roof-north.png', left: before('shack-door-north.png'), right: after('shack-door-north.png'), labels: ['之前', '之后'] },
    { name: '6-portrait.png', left: before('low-390.png'), right: after('portrait-390.png'), labels: ['之前', '之后'] },
    { name: '7-medium.png', left: before('overview-day.png'), right: after('overview-day-medium.png'), labels: ['之前', '之后'] },
    { name: 'compare-day.png', left: proto('forest.png'), right: after('closeup-day.png'), labels: ['原型', '实现'] },
    { name: 'compare-dusk.png', left: proto('forest-dusk.png'), right: after('closeup-dusk.png'), labels: ['原型', '实现'] },
  ],
};

function pngSize(file) {
  const fd = openSync(file, 'r');
  const head = Buffer.alloc(24);
  readSync(fd, head, 0, 24, 0);
  closeSync(fd);
  if (head.toString('ascii', 1, 4) !== 'PNG') throw new Error(`${file} is not a PNG`);
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

const TITLE_H = 40;
const GAP = 0;

function pageHtml(job, leftSize, rightSize) {
  const rowH = TITLE_H + Math.max(leftSize.height, rightSize.height);
  const totalW = leftSize.width + GAP + rightSize.width;
  const col = (label, file, size) => `<div class="col" style="width:${size.width}px;height:${rowH}px">
    <div class="title" style="width:${size.width}px">${label}</div>
    <img src="${pathToFileURL(file).href}" alt="${label}" width="${size.width}" height="${size.height}"></div>`;
  return {
    totalW,
    rowH,
    html: `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; background: #10160e; }
  .row { display: flex; width: ${totalW}px; height: ${rowH}px; }
  .col { flex: none; }
  .title { height: ${TITLE_H}px; line-height: ${TITLE_H}px; color: #f4f1e8; font: 20px sans-serif; text-align: center; }
  img { display: block; }
</style>
</head>
<body>
<div class="row">${col(job.labels[0], job.left, leftSize)}${col(job.labels[1], job.right, rightSize)}</div>
</body>
</html>
`,
  };
}

const executablePath = execSync('which google-chrome', { encoding: 'utf8' }).trim();
mkdirSync(workDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});

try {
  for (const job of SETS[args.set]) {
    const leftSize = pngSize(job.left);
    const rightSize = pngSize(job.right);
    const { html, totalW, rowH } = pageHtml(job, leftSize, rightSize);
    const htmlPath = path.join(workDir, `${job.name}.html`);
    writeFileSync(htmlPath, html);
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: totalW, height: rowH, deviceScaleFactor: 1 });
      await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
      await page.evaluate(() => Promise.all([...document.images].map((img) => img.decode())));
      await page.screenshot({
        path: path.join(outDir, job.name),
        clip: { x: 0, y: 0, width: totalW, height: rowH },
      });
      console.log(JSON.stringify({ compare: job.name, width: totalW, height: rowH, left: leftSize, right: rightSize }));
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
