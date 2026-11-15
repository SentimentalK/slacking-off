#!/usr/bin/env node
/**
 * Occupancy snapshot / gate.
 *   occupancy.mjs --base URL --out FILE --scenario NAME --phase start|end
 *                 --want-inside N --want-queued N [--seed-final-file F]
 * Reads /api/projection counts, merges `{scenario: {phase: snapshot}}` into
 * FILE (occupancy.json) and exits 1 when the snapshot differs from the wanted
 * counts.
 *   occupancy.mjs --base URL --wait-tick N   waits until server tick >= N
 */
import { existsSync, readFileSync } from "node:fs";
import { parseArgs, sleep, writeJson } from "./util.mjs";

const args = parseArgs(process.argv.slice(2));
const base = (args.base ?? "http://127.0.0.1:18111").replace(/\/$/, "");

async function counts() {
  const env = await (await fetch(`${base}/api/projection`)).json();
  const p = env?.result ?? {};
  const c = p.counts ?? {};
  return {
    inside: c.inside ?? null,
    queued: c.queued ?? null,
    capacity: c.capacity ?? null,
    queue_capacity: c.queue_capacity ?? null,
    tick: p.tick ?? null,
    agents_len: Array.isArray(p.agents) ? p.agents.length : null,
    queue_len: Array.isArray(p.queue) ? p.queue.length : null,
    at: new Date().toISOString(),
  };
}

if (args["wait-tick"] !== undefined) {
  const want = Number(args["wait-tick"]);
  for (let i = 0; i < 600; i += 1) {
    try {
      const c = await counts();
      if ((c.tick ?? 0) >= want) process.exit(0);
    } catch {}
    await sleep(1000);
  }
  console.error(`FAIL: server tick did not reach ${want}`);
  process.exit(1);
}

const scenario = args.scenario;
const phase = args.phase;
const wantInside = Number(args["want-inside"]);
const wantQueued = Number(args["want-queued"]);
const snap = await counts();
const ok =
  snap.inside === wantInside &&
  snap.queued === wantQueued &&
  snap.agents_len === wantInside &&
  snap.queue_len === wantQueued;
snap.ok = ok;
snap.want = { inside: wantInside, queued: wantQueued };

let doc = {};
if (existsSync(args.out)) doc = JSON.parse(readFileSync(args.out, "utf8"));
doc[scenario] = doc[scenario] ?? {};
doc[scenario][phase] = snap;
if (args["seed-final-file"] && existsSync(args["seed-final-file"])) {
  const m = readFileSync(args["seed-final-file"], "utf8").match(/inside=(\S+) queued=(\S+)/g);
  if (m) doc[scenario].seed_final = m[m.length - 1];
}
writeJson(args.out, doc);
console.log(`occupancy ${scenario}/${phase}: inside=${snap.inside} queued=${snap.queued} (agents=${snap.agents_len} queue=${snap.queue_len}) want ${wantInside}/${wantQueued} -> ${ok ? "OK" : "FAIL"}`);
process.exit(ok ? 0 : 1);
