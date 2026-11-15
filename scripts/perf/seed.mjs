#!/usr/bin/env node
/**
 * Seed N script agents and keep them alive until killed (SIGTERM/SIGINT).
 *
 * Every agent: register -> join -> walk to its own parking tile -> loop
 * `/api/wait` (timeout_seconds=1). No random move/attack: agents never get
 * stunned and never race each other out of the field. The walk is needed
 * because the entrance tile admits one agent at a time: an agent idling on it
 * blocks the whole queue (observed: inside=1 queued=49). The k-th agent seen
 * inside parks on (33 + k, 49): east along row 50 (nobody parks on row 50) then
 * one step north; a move aborted by a momentary block is re-issued from the
 * current position. If the state carried in every response shows
 * `placement == null`, the agent registers again and re-joins.
 *
 * Target: min(N, 50) inside and N - inside queued (N=100 -> 50 inside + 50
 * queued). When the target is reached the process writes `--ready-file`
 * (JSON snapshot) and keeps running; the caller kills it after measuring. On
 * exit it prints `inside=<n> queued=<n>`.
 *
 * Needs the dev config from scripts/perf.sh (deadline pushed out of the
 * measurement window, idle cleanup off, 2 req/s per agent).
 */
import { writeFileSync } from "node:fs";
import { parseArgs, sleep } from "./util.mjs";

const PER_SECOND = 2;
const RATE_BACKOFF_MS = 400;
const args = parseArgs(process.argv.slice(2));
const base = (args.base ?? "http://127.0.0.1:18111").replace(/\/$/, "");
const agentCount = Number(args.agents ?? 0);
const readyFile = args["ready-file"] ?? null;
const readyTimeoutSeconds = Number(args["ready-timeout-seconds"] ?? 240);

if (!Number.isInteger(agentCount) || agentCount < 0) {
  console.error("FAIL: --agents must be an integer >= 0");
  process.exit(2);
}

let stopping = false;

class Pacer {
  constructor() {
    this.times = [];
  }
  async acquire() {
    for (;;) {
      const now = Date.now();
      this.times = this.times.filter((at) => now - at < 1000);
      if (this.times.length < PER_SECOND) {
        this.times.push(now);
        return;
      }
      await sleep(this.times[0] + 1000 - now + 5);
    }
  }
}

async function fetchCounts() {
  const res = await fetch(`${base}/api/projection`);
  const envelope = await res.json();
  const c = envelope?.result?.counts ?? {};
  const agentsList = envelope?.result?.agents ?? [];
  return {
    signature: agentsList.map((a) => `${a.id}:${a.pos?.x},${a.pos?.y}`).join("|"),
    inside: c.inside ?? 0,
    queued: c.queued ?? 0,
    capacity: c.capacity ?? null,
    queue_capacity: c.queue_capacity ?? null,
    tick: envelope?.result?.tick ?? null,
  };
}

/** One HTTP call as `agent`; returns the envelope or null on transport trouble. */
async function raw(agent, path, body, timeoutMs) {
  await agent.pacer.acquire();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (agent.token) headers.authorization = `Bearer ${agent.token}`;
  try {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function register(agent) {
  while (!stopping) {
    const env = await raw(
      agent,
      "/api/dev/register",
      { name: null, model: "perf-harness", intro: "perf seed agent" },
      10000,
    );
    if (env?.ok) {
      agent.token = env.result.token;
      agent.id = env.result.agent_id;
      agent.placement = env.state?.placement ?? null;
      return true;
    }
    await sleep(RATE_BACKOFF_MS);
  }
  return false;
}

/** Join until the server accepts (or says we already joined). */
async function join(agent) {
  while (!stopping) {
    const env = await raw(agent, "/api/join", { sent_by: "self", why: "perf harness join" }, 15000);
    if (env?.ok) {
      agent.placement = env.state?.placement ?? null;
      agent.state = env.state ?? null;
      return true;
    }
    const code = env?.error?.code;
    if (code === "not_authenticated") {
      await register(agent);
      continue;
    }
    if (code === "rule_rejected") {
      // Already in a session or in the queue: the next wait tells us where.
      return true;
    }
    // rate_limited / queue_full / transport error: back off and retry.
    await sleep(code === "queue_full" ? 800 : RATE_BACKOFF_MS);
  }
  return false;
}

let nextSlot = 0;

/**
 * Walk to this agent's own parking tile (33 + slot, 49) once inside. A move is
 * aborted when the next tile is momentarily occupied, so whenever the agent is
 * inside, has no action running and is not on its tile, the path is recomputed
 * from its current position and sent again.
 */
async function maybeMove(agent, state) {
  if (state?.placement !== "inside" || !state.pos) return;
  if (state.action) return; // still walking
  // The slot comes from a process-wide counter handed out the first time an
  // agent is seen inside (entering order is not index order: queue_full
  // retries reshuffle who gets in first), so no two agents share a tile.
  if (agent.slot === null) {
    agent.slot = nextSlot;
    nextSlot += 1;
  }
  const tx = 33 + (agent.slot % 50);
  const { x, y } = state.pos;
  if (x === tx && y === 49) return; // parked
  let path = "";
  if (y === 50) path = `${"E".repeat(Math.max(0, tx - x))}N`;
  else if (y === 49) path = "E".repeat(Math.max(0, tx - x)) || "N";
  else return;
  agent.moveAttempts += 1;
  await raw(agent, "/api/move", { spec: { Path: { path } } }, 10000);
}

async function run(agent) {
  if (!(await register(agent))) return;
  if (!(await join(agent))) return;
  while (!stopping) {
    await maybeMove(agent, agent.state);
    const env = await raw(agent, "/api/wait", { timeout_seconds: 1 }, 15000);
    if (!env) {
      await sleep(RATE_BACKOFF_MS);
      continue;
    }
    if (!env.ok) {
      if (env.error?.code === "not_authenticated") {
        agent.reseeds += 1;
        await register(agent);
        await join(agent);
      } else {
        await sleep(RATE_BACKOFF_MS);
      }
      continue;
    }
    agent.placement = env.state?.placement ?? null;
    agent.state = env.state ?? null;
    if (agent.placement === null) {
      // Session ended / dropped from the queue: register fresh and join again.
      agent.reseeds += 1;
      agent.slot = null;
      await register(agent);
      await join(agent);
    }
  }
}

async function shutdown(code) {
  stopping = true;
  try {
    const c = await fetchCounts();
    console.log(`inside=${c.inside} queued=${c.queued}`);
  } catch {
    console.log("inside=? queued=?");
  }
  process.exit(code);
}
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

if (agentCount === 0) {
  await shutdown(0);
}

const wantInside = Math.min(agentCount, 50);
const wantQueued = agentCount - wantInside;
const agents = Array.from({ length: agentCount }, (_, index) => ({
  index,
  token: null,
  id: null,
  placement: null,
  state: null,
  slot: null,
  moveAttempts: 0,
  reseeds: 0,
  pacer: new Pacer(),
}));

// Stagger the starts so the first joins land in order (inside first).
const workers = agents.map(async (agent, i) => {
  await sleep(i * 40);
  await run(agent);
});

const startedAt = Date.now();
let ready = false;
let lastSig = null;
let stableSince = 0;
const poll = (async () => {
  while (!stopping) {
    await sleep(500);
    try {
      const c = await fetchCounts();
      if (c.signature !== lastSig) {
        lastSig = c.signature;
        stableSince = Date.now();
      }
      // full counts AND nobody has moved for 3 s (everyone parked)
      if (!ready && c.inside === wantInside && c.queued === wantQueued && Date.now() - stableSince >= 3000) {
        ready = true;
        const { signature, ...rest } = c;
        const snap = { ...rest, agents: agentCount, reseeds: agents.reduce((s, a) => s + a.reseeds, 0), at: new Date().toISOString() };
        if (readyFile) writeFileSync(readyFile, `${JSON.stringify(snap, null, 2)}\n`);
        console.log(`READY inside=${c.inside} queued=${c.queued} after ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
      }
    } catch {
      // server hiccup; keep polling
    }
    if (!ready && Date.now() - startedAt > readyTimeoutSeconds * 1000) {
      const c = await fetchCounts().catch(() => ({ inside: "?", queued: "?" }));
      console.error(`FAIL: not full after ${readyTimeoutSeconds}s (inside=${c.inside} queued=${c.queued}, want ${wantInside}/${wantQueued})`);
      await shutdown(1);
    }
  }
})();

await Promise.all([...workers, poll]);
