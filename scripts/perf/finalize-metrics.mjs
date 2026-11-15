#!/usr/bin/env node
/** Merge partial per-scenario blocks + machine + occupancy into metrics.json. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, writeJson } from "./util.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const args = parseArgs(process.argv.slice(2));
const tag = args.tag ?? "before";
const PERF = join(ROOT, `.conductor/perf/${tag}`);
const partial = JSON.parse(readFileSync(args.partial, "utf8"));
const machine = JSON.parse(readFileSync(args.machine, "utf8"));
const occ = existsSync(args.occupancy) ? JSON.parse(readFileSync(args.occupancy, "utf8")) : {};
const cfg = existsSync(join(PERF, "config.json")) ? JSON.parse(readFileSync(join(PERF, "config.json"), "utf8")) : null;

// seed's own final `inside= queued=` line (printed on SIGTERM)
for (const name of Object.keys(occ)) {
  const logPath = join(PERF, `seed-${name}.log`);
  if (!existsSync(logPath)) continue;
  const lines = readFileSync(logPath, "utf8").split("\n").filter((l) => /^inside=/.test(l));
  if (lines.length) occ[name].seed_final = lines[lines.length - 1];
}
writeJson(args.occupancyOut ?? join(PERF, "occupancy.json"), occ);

const full = occ.full ?? {};
const snap = full.start ?? {};
const occupancy = {
  inside: snap.inside ?? null,
  queued: snap.queued ?? null,
  capacity: snap.capacity ?? null,
  queue_capacity: snap.queue_capacity ?? null,
  start: full.start ?? null,
  end: full.end ?? null,
  seed_final: full.seed_final ?? null,
  ok: Boolean(full.start?.ok && full.end?.ok),
  scenarios: occ,
};

for (const name of ["empty", "ten", "full"]) {
  if (partial[name]) partial[name].occupancyCheck = occ[name] ?? null;
}

writeJson(args.out, {
  tag,
  started_at: args["started-at"],
  finished_at: new Date().toISOString(),
  chrome_version: args["chrome-version"],
  machine,
  devConfig: cfg,
  occupancy,
  empty: partial.empty,
  ten: partial.ten,
  full: partial.full,
});
if (!occupancy.ok) {
  console.error("FAIL: full occupancy was not 50/50 at both measurement start and end");
  process.exit(1);
}
