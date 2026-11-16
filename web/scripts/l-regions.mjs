import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

function parseArgs(argv) {
  const out = { png: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (key === 'png') out.png.push(argv[i + 1]);
    else out[key] = argv[i + 1];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.regions || args.png.length === 0) {
  console.error('usage: l-regions.mjs --regions <regions.json> --png <a.png> [--png <b.png> ...]');
  process.exit(2);
}

const regions = JSON.parse(readFileSync(args.regions, 'utf8'));
const executablePath = execSync('which google-chrome', { encoding: 'utf8' }).trim();
const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'] });
const result = {};
try {
  const page = await browser.newPage();
  for (const file of args.png) {
    const dataUrl = `data:image/png;base64,${readFileSync(path.resolve(file)).toString('base64')}`;
    const stats = await page.evaluate(
      async (src, regionMap) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        const out = {};
        for (const [name, rects] of Object.entries(regionMap)) {
          let n = 0;
          let ySum = 0;
          let sSum = 0;
          for (const [x, y, w, h] of rects) {
            const d = g.getImageData(x, y, w, h).data;
            for (let i = 0; i < d.length; i += 4) {
              const r = d[i];
              const gg = d[i + 1];
              const b = d[i + 2];
              const mx = Math.max(r, gg, b);
              const mn = Math.min(r, gg, b);
              ySum += 0.2126 * r + 0.7152 * gg + 0.0722 * b;
              sSum += mx === 0 ? 0 : (mx - mn) / mx;
              n++;
            }
          }
          out[name] = { Y: +(ySum / n).toFixed(3), S: +(sSum / n).toFixed(4), px: n };
        }
        return { width: img.naturalWidth, height: img.naturalHeight, regions: out };
      },
      dataUrl,
      regions,
    );
    result[path.resolve(file)] = stats;
  }
} finally {
  await browser.close();
}
console.log(JSON.stringify(result, null, 2));
