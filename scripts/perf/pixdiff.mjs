#!/usr/bin/env node
import { readFileSync } from "node:fs";
import puppeteer from "./puppeteer.mjs";

const aPath = process.argv[2];
const bPath = process.argv[3];
if (!aPath || !bPath) {
  console.error("Usage: pixdiff.mjs <a.png> <b.png>");
  process.exit(2);
}

const CHROME = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});

const page = await browser.newPage();
const aB64 = readFileSync(aPath).toString("base64");
const bB64 = readFileSync(bPath).toString("base64");

const result = await page.evaluate(
  async (a, b) => {
    function load(b64) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement("canvas");
          c.width = img.width;
          c.height = img.height;
          const ctx = c.getContext("2d");
          ctx.drawImage(img, 0, 0);
          resolve({ w: img.width, h: img.height, data: ctx.getImageData(0, 0, c.width, c.height).data });
        };
        img.onerror = reject;
        img.src = `data:image/png;base64,${b64}`;
      });
    }
    const [imgA, imgB] = await Promise.all([load(a), load(b)]);
    if (imgA.w !== imgB.w || imgA.h !== imgB.h) {
      return { error: "size mismatch", w: imgA.w, h: imgA.h };
    }
    let diff = 0;
    let minX = imgA.w;
    let minY = imgA.h;
    let maxX = 0;
    let maxY = 0;
    const total = imgA.w * imgA.h;
    for (let i = 0; i < imgA.data.length; i += 4) {
      if (
        imgA.data[i] !== imgB.data[i] ||
        imgA.data[i + 1] !== imgB.data[i + 1] ||
        imgA.data[i + 2] !== imgB.data[i + 2] ||
        imgA.data[i + 3] !== imgB.data[i + 3]
      ) {
        diff += 1;
        const p = i / 4;
        const x = p % imgA.w;
        const y = (p / imgA.w) | 0;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    return {
      diffPixels: diff,
      totalPixels: total,
      bbox: diff ? { minX, minY, maxX, maxY } : null,
    };
  },
  aB64,
  bB64,
);

await browser.close();

if (result.error) {
  console.error(`FAIL: ${result.error}`);
  process.exit(1);
}
console.log(
  `diff_pixels=${result.diffPixels} total_pixels=${result.totalPixels} bbox=${JSON.stringify(result.bbox)}`,
);
if (result.diffPixels !== 0 && aPath === bPath) process.exit(1);