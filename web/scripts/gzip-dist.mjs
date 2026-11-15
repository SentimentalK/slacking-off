import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";

const DIST = new URL("../dist/", import.meta.url).pathname;
const COMPRESS_EXT = new Set([".js", ".mjs", ".css", ".html", ".svg", ".json"]);
const SKIP_EXT = new Set([
  ".woff",
  ".woff2",
  ".png",
  ".jpg",
  ".ico",
  ".gz",
]);

/** Gzip with a zero MTIME so repeated runs yield identical bytes. */
function gzipDeterministic(buf) {
  const out = gzipSync(buf, { level: 9 });
  // GZIP header: MTIME is bytes 4–7 (little-endian Unix time).
  if (out.length >= 10 && out[0] === 0x1f && out[1] === 0x8b) {
    out[4] = 0;
    out[5] = 0;
    out[6] = 0;
    out[7] = 0;
  }
  return out;
}

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      walk(path, files);
    } else {
      files.push(path);
    }
  }
  return files;
}

function shouldCompress(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".gz")) {
    return false;
  }
  const dot = lower.lastIndexOf(".");
  if (dot === -1) {
    return false;
  }
  const ext = lower.slice(dot);
  if (SKIP_EXT.has(ext)) {
    return false;
  }
  return COMPRESS_EXT.has(ext);
}

let rawTotal = 0;
let gzTotal = 0;
let count = 0;

const all = walk(DIST);
for (const filePath of all) {
  if (!shouldCompress(filePath)) {
    continue;
  }
  const raw = readFileSync(filePath);
  const gz = gzipDeterministic(raw);
  const gzPath = `${filePath}.gz`;
  writeFileSync(gzPath, gz);
  const rel = relative(DIST, filePath);
  console.log(`${rel}: ${raw.length} -> ${gz.length}`);
  rawTotal += raw.length;
  gzTotal += gz.length;
  count += 1;
}

console.log(
  `gzip-dist: ${count} file(s), raw ${rawTotal} B, gzip ${gzTotal} B`,
);