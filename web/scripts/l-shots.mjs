import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  return args;
}

const args = parseArgs(process.argv.slice(2));
for (const key of ['base', 'scenes', 'out']) {
  if (!args[key]) {
    console.error(`missing --${key}`);
    process.exit(2);
  }
}

const SHOTS = [
  { name: 'shack-door-south', fixture: 'shacks.json', query: 'focus=13,10&zoom=0.4', w: 1440, h: 900 },
  { name: 'shack-door-north', fixture: 'shacks.json', query: 'focus=13,21&zoom=0.4', w: 1440, h: 900 },
  { name: 'missing-wall', fixture: 'missing-wall.json', query: 'focus=30,19&zoom=0.4', w: 1440, h: 900 },
  { name: 'wall-half', fixture: 'wall-half.json', query: 'focus=38,9&zoom=0.45', w: 1440, h: 900 },
  { name: 'upgrading', fixture: 'upgrading.json', query: 'focus=13,10&zoom=0.4', w: 1440, h: 900 },
  { name: 'using', fixture: 'using.json', query: 'focus=13,10&zoom=0.4', w: 1440, h: 900 },
  { name: 'windup', fixture: 'windup.json', query: 'focus=18,12&zoom=0.35', w: 1440, h: 900 },
  { name: 'queue', fixture: 'crowd.json', query: 'focus=6,15&zoom=0.45', w: 1440, h: 900 },
  { name: 'states', fixture: 'states.json', query: '', w: 1440, h: 900 },
  { name: 'overview-day', fixture: 'crowd.json', query: '', w: 1440, h: 900 },
  { name: 'overview-dusk', fixture: 'crowd.json', query: 'dusk=1', w: 1440, h: 900 },
  { name: 'closeup-day', fixture: 'crowd.json', query: 'focus=16,14&zoom=0.5', w: 1440, h: 900 },
  { name: 'closeup-dusk', fixture: 'crowd.json', query: 'focus=16,14&zoom=0.5&dusk=1', w: 1440, h: 900 },
  { name: 'low-390', fixture: 'crowd.json', query: 'quality=low', w: 390, h: 844 },
];

const executablePath = execSync('which google-chrome', { encoding: 'utf8' }).trim();
mkdirSync(args.out, { recursive: true });
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

let failed = false;
try {
  for (const shot of SHOTS) {
    const fixturePath = path.join(args.scenes, shot.fixture);
    const query = ['still=1', `fixture=/@fs${fixturePath}`, shot.w === 1440 ? 'quality=high' : '', shot.query].filter(Boolean).join('&');
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.setViewport({ width: shot.w, height: shot.h, deviceScaleFactor: 1 });
      await page.goto(`${args.base}/scene.html?${query}`, { waitUntil: 'load' });
      await page.waitForFunction('window.__looReady === true', { timeout: 120000 });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const result = await page.evaluate(() => window.__looCapture());
      const png = result.png.replace(/^data:image\/png;base64,/, '');
      writeFileSync(path.join(args.out, `${shot.name}.png`), Buffer.from(png, 'base64'));
      writeFileSync(
        path.join(args.out, `${shot.name}.json`),
        `${JSON.stringify({ tick: result.tick, calls: result.calls, triangles: result.triangles }, null, 2)}\n`,
      );
      console.log(JSON.stringify({ shot: shot.name, tick: result.tick, calls: result.calls, triangles: result.triangles }));
    } catch (error) {
      failed = true;
      console.error(`${shot.name}: ${error.message}`);
    } finally {
      for (const message of errors) console.error(`${shot.name} pageerror: ${message}`);
      if (errors.length > 0) failed = true;
      await page.close();
    }
  }
} finally {
  await browser.close();
}
if (failed) process.exit(1);
