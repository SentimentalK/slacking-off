import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.out) {
  console.error('missing --out');
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const outDir = path.resolve(args.out);
const workDir = path.join(root, '.conductor', 'l');
const prototypeDir = path.join(root, 'docs', 'art', 'prototype');
const PAIRS = [
  { name: 'compare-day.png', proto: 'forest.png', impl: 'closeup-day.png' },
  { name: 'compare-dusk.png', proto: 'forest-dusk.png', impl: 'closeup-dusk.png' },
];

const WIDTH = 1440;
const HEIGHT = 900;
const TITLE_H = 40;

function pageHtml(pair) {
  const proto = pathToFileURL(path.join(prototypeDir, pair.proto)).href;
  const impl = pathToFileURL(path.join(outDir, pair.impl)).href;
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; background: #10160e; }
  .row { display: flex; width: ${WIDTH * 2}px; height: ${TITLE_H + HEIGHT}px; }
  .col { width: ${WIDTH}px; height: ${TITLE_H + HEIGHT}px; }
  .title { height: ${TITLE_H}px; line-height: ${TITLE_H}px; color: #f4f1e8; font: 20px sans-serif; text-align: center; }
  img { display: block; width: ${WIDTH}px; height: ${HEIGHT}px; }
</style>
</head>
<body>
<div class="row">
  <div class="col"><div class="title">原型</div><img src="${proto}" alt="原型"></div>
  <div class="col"><div class="title">实现</div><img src="${impl}" alt="实现"></div>
</div>
</body>
</html>
`;
}

const executablePath = execSync('which google-chrome', { encoding: 'utf8' }).trim();
mkdirSync(workDir, { recursive: true });
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: [
    '--headless=new',
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--hide-scrollbars',
    `--window-size=${WIDTH * 2},${TITLE_H + HEIGHT}`,
  ],
});

try {
  for (const pair of PAIRS) {
    const htmlPath = path.join(workDir, 'compare.html');
    writeFileSync(htmlPath, pageHtml(pair));
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: WIDTH * 2, height: TITLE_H + HEIGHT, deviceScaleFactor: 1 });
      await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
      await page.evaluate(() => Promise.all([...document.images].map((img) => img.decode())));
      await page.screenshot({
        path: path.join(outDir, pair.name),
        clip: { x: 0, y: 0, width: WIDTH * 2, height: TITLE_H + HEIGHT },
      });
      console.log(JSON.stringify({ compare: pair.name, width: WIDTH * 2, height: TITLE_H + HEIGHT }));
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
