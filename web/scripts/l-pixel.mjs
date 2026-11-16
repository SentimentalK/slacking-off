import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const BASE = 'http://127.0.0.1:18136';
const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '../../docs/screenshots/l');

const executablePath = execSync('which google-chrome', { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const decodePng = (dataUrl) => Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');

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
    '--window-size=1440,900',
  ],
});

try {
  const live = await browser.newPage();
  await live.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await live.goto(`${BASE}/?still=1&quality=high`, { waitUntil: 'domcontentloaded' });
  await live.waitForFunction(
    () => Array.from(document.querySelectorAll('.ui-clock .live')).some((element) => element.textContent.includes('LIVE')),
    { timeout: 30000 },
  );
  await live.waitForFunction(() => window.__looView && window.__looView.tick() >= 5, { timeout: 60000 });
  const captured = await live.evaluate(() => window.__looView.capture());
  const tick = captured.tick;
  await live.close();

  const replay = await browser.newPage();
  replay.on('pageerror', (error) => console.error(`replay pageerror: ${error.message}`));
  replay.on('console', (message) => {
    if (message.type() === 'error') console.error(`replay console: ${message.text()}`);
  });
  await replay.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await replay.goto(`${BASE}/replay?tick=${tick}&still=1&quality=high&ui=0`, { waitUntil: 'domcontentloaded' });
  await replay.waitForFunction((target) => window.__looView && window.__looView.tick() === target, { timeout: 120000 }, tick);
  await sleep(1000);
  const rendered = await replay.evaluate(() => window.__looView.capture());
  await replay.close();

  const check = await browser.newPage();
  const result = await check.evaluate(
    async (aUrl, bUrl) => {
      const load = (src) =>
        new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error('png decode failed'));
          img.src = src;
        });
      const [a, b] = await Promise.all([load(aUrl), load(bUrl)]);
      if (a.width !== b.width || a.height !== b.height) {
        throw new Error(`size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`);
      }
      const width = a.width;
      const height = a.height;
      const pixels = (img) => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(img, 0, 0);
        return context.getImageData(0, 0, width, height);
      };
      const da = pixels(a);
      const db = pixels(b);
      const out = new ImageData(new Uint8ClampedArray(da.data), width, height);
      let count = 0;
      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;
      for (let p = 0; p < width * height; p += 1) {
        const i = p * 4;
        if (da.data[i] !== db.data[i] || da.data[i + 1] !== db.data[i + 1] || da.data[i + 2] !== db.data[i + 2] || da.data[i + 3] !== db.data[i + 3]) {
          count += 1;
          const x = p % width;
          const y = Math.floor(p / width);
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
          out.data[i] = 255;
          out.data[i + 1] = 0;
          out.data[i + 2] = 0;
          out.data[i + 3] = 255;
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').putImageData(out, 0, 0);
      return {
        width,
        height,
        diff_pixels: count,
        diff_ratio: count / (width * height),
        bbox: count === 0 ? null : { x0: minX, y0: minY, x1: maxX, y1: maxY },
        diffPng: canvas.toDataURL('image/png'),
      };
    },
    captured.png,
    rendered.png,
  );
  await check.close();

  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'pixel-live.png'), decodePng(captured.png));
  writeFileSync(path.join(outDir, 'pixel-replay.png'), decodePng(rendered.png));
  writeFileSync(path.join(outDir, 'pixel-diff.png'), decodePng(result.diffPng));
  writeFileSync(
    path.join(outDir, 'pixel.json'),
    `${JSON.stringify(
      { tick, width: result.width, height: result.height, diff_pixels: result.diff_pixels, diff_ratio: result.diff_ratio },
      null,
      2,
    )}\n`,
  );
  console.log(JSON.stringify({ tick, width: result.width, height: result.height, diff_pixels: result.diff_pixels, diff_ratio: result.diff_ratio, bbox: result.bbox }));
} finally {
  await browser.close();
}
