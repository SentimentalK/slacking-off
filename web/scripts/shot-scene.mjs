import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";

function parseArgs(argv) {
  const args = { headed: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--headed") args.headed = true;
    else if (a.startsWith("--")) args[a.slice(2)] = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
for (const k of ["url", "out", "width", "height"]) {
  if (!args[k]) {
    console.error(`missing --${k}`);
    process.exit(2);
  }
}

const executablePath = execSync("which google-chrome", { encoding: "utf8" }).trim();
const browser = await puppeteer.launch({
  executablePath,
  headless: !args.headed,
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("pageerror:", e.message));
  await page.setViewport({ width: Number(args.width), height: Number(args.height), deviceScaleFactor: 1 });
  await page.goto(args.url, { waitUntil: "load" });
  await page.waitForFunction("window.__looReady === true", { timeout: 120000 });
  await new Promise((r) => setTimeout(r, 1000));
  const result = await page.evaluate(() => window.__looCapture());
  const b64 = result.png.replace(/^data:image\/png;base64,/, "");
  writeFileSync(args.out, Buffer.from(b64, "base64"));
  console.log(JSON.stringify({ tick: result.tick, calls: result.calls, triangles: result.triangles }));
} finally {
  await browser.close();
}
