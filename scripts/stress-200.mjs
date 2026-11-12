#!/usr/bin/env node
// Dev-mode load driver for the 200-agent stress run.
//
// Every agent owns one dev token and stays inside its own request budget
// (`limits.requests_per_second = 2`, enforced here as a rolling one-second
// window). Agents inside the world rotate status -> move -> wait; waiters
// rotate status -> occasional attack -> move in a queue lane -> wait. The run
// holds for the full wall-clock duration: `--duration-seconds` is never scaled
// by the server tick length.
//
// Usage:
//   node scripts/stress-200.mjs --base http://127.0.0.1:18087 \
//     --agents 200 --duration-seconds 3600 [--summary path.json]

import { writeFileSync } from "node:fs";

const PER_SECOND = 2;
const RATE_BACKOFF_MS = 300;
const RATE_RETRIES = 4;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = "true";
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const base = (args.base ?? "http://127.0.0.1:18087").replace(/\/$/, "");
const agentCount = Number(args.agents ?? 200);
const durationSeconds = Number(args["duration-seconds"] ?? 3600);
const summaryPath = args.summary ?? null;

if (!Number.isFinite(agentCount) || agentCount <= 0) {
  console.error("FAIL: --agents must be a positive number");
  process.exit(2);
}
if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
  console.error("FAIL: --duration-seconds must be a positive number");
  process.exit(2);
}

const startedAt = new Date();
const startMs = Date.now();
const deadlineMs = startMs + durationSeconds * 1000;
const DIRS = ["N", "E", "S", "W"];

const counters = {
  requests: 0,
  register_ok: 0,
  joins_ok: 0,
  joins_rejected: 0,
  joins_queue_full: 0,
  status_ok: 0,
  moves_ok: 0,
  moves_rejected: 0,
  attacks_ok: 0,
  attacks_rejected: 0,
  waits_ok: 0,
  rate_limited: 0,
  rule_rejected: 0,
  bad_request: 0,
  not_authenticated: 0,
  http_errors: 0,
  network_errors: 0,
  sessions_ended: 0,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

class ServerDown extends Error {
  constructor(cause) {
    super(`server unreachable: ${cause}`);
    this.name = "ServerDown";
  }
}

class Deadline extends Error {
  constructor() {
    super("deadline reached");
    this.name = "Deadline";
  }
}

// At most PER_SECOND requests in any trailing one-second window.
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
      const wait = this.times[0] + 1000 - now + 5;
      if (wait > 0) await sleep(wait);
    }
  }
}

async function raw(base, path, body, agent, timeoutMs) {
  await agent.pacer.acquire();
  counters.requests += 1;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (agent.token) headers.authorization = `Bearer ${agent.token}`;
  let response;
  try {
    response = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (Date.now() >= deadlineMs) throw new Deadline();
    counters.network_errors += 1;
    throw new ServerDown(error?.cause?.code ?? error?.name ?? String(error));
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    counters.http_errors += 1;
    return { status: response.status, body: null, text };
  }
  return { status: response.status, body: envelope };
}

// One logical call: paced, retried only on `rate_limited`.
async function call(agent, path, body) {
  for (let attempt = 0; ; attempt += 1) {
    if (Date.now() >= deadlineMs) throw new Deadline();
    const timeout = Math.min(30000, Math.max(5000, deadlineMs - Date.now()));
    const { status, body: envelope, text } = await raw(base, path, body, agent, timeout);
    if (!envelope) {
      if (status >= 500) counters.http_errors += 1;
      else counters.bad_request += 1;
      return { status, ok: false, code: "bad_response", message: text.slice(0, 200) };
    }
    if (envelope.ok) return { status, ok: true, result: envelope.result, state: envelope.state };
    const code = envelope.error?.code ?? "unknown";
    if (code === "rate_limited") {
      counters.rate_limited += 1;
      if (attempt >= RATE_RETRIES) return { status, ok: false, code, message: envelope.error?.message ?? "" };
      await sleep(RATE_BACKOFF_MS * (attempt + 1));
      continue;
    }
    if (code === "rule_rejected") counters.rule_rejected += 1;
    if (code === "bad_request") counters.bad_request += 1;
    if (code === "not_authenticated") counters.not_authenticated += 1;
    return { status, ok: false, code, message: envelope.error?.message ?? "" };
  }
}

const pick = (list) => list[(Math.random() * list.length) | 0];

async function join(agent) {
  const response = await call(agent, "/api/join", {
    sent_by: "self",
    why: `stress-200 agent ${agent.id}: one sentence for the queue`,
  });
  if (response.ok) {
    counters.joins_ok += 1;
    const placement = response.result?.placement;
    agent.placement = placement?.Inside ? "inside" : placement?.Waiting ? "waiting" : null;
    agent.joined = true;
    return response;
  }
  if (response.code === "queue_full") {
    counters.joins_rejected += 1;
    counters.joins_queue_full += 1;
    // The field and the line are both full: wait a full second before retrying.
    await sleep(1000);
    return response;
  }
  if (response.code === "rule_rejected") {
    // Most likely "already have session"; status tells the truth next round.
    counters.joins_rejected += 1;
    agent.joined = true;
    return response;
  }
  counters.joins_rejected += 1;
  return response;
}

async function register(agent) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await call(agent, "/api/dev/register", {
      name: null,
      model: "stress-200",
      intro: "synthetic load agent",
    });
    if (response.ok) {
      counters.register_ok += 1;
      agent.id = response.result.agent_id;
      agent.token = response.result.token;
      agent.nick = response.result.nick;
      return;
    }
    if (attempt >= 3) {
      throw new Error(`register failed: ${response.code} ${response.message}`);
    }
    await sleep(500);
  }
}

async function agentLoop(index) {
  const agent = {
    index,
    id: null,
    token: null,
    nick: null,
    joined: false,
    placement: null,
    pacer: new Pacer(),
  };
  // Smooth the registration storm so joins do not arrive all at once.
  await sleep(Math.min(index * 10, 2000));
  await register(agent);

  while (Date.now() < deadlineMs) {
    try {
      if (!agent.joined) {
        await join(agent);
        continue;
      }

      const status = await call(agent, "/api/status");
      if (status.ok) {
        counters.status_ok += 1;
        const placement = status.state?.placement ?? null;
        if (placement === null) {
          // Session ended or expired: the next round joins again.
          counters.sessions_ended += 1;
          agent.joined = false;
          agent.placement = null;
          continue;
        }
        agent.placement = placement;
      } else if (status.code === "not_authenticated") {
        await register(agent);
        continue;
      }

      const dir = pick(DIRS);
      if (agent.placement === "inside") {
        const moved = await call(agent, "/api/move", { spec: { Steps: { dir, count: 1 } } });
        if (moved.ok) counters.moves_ok += 1;
        else counters.moves_rejected += 1;
      } else {
        if (Math.random() < 0.25) {
          const attacked = await call(agent, "/api/attack", { dir });
          if (attacked.ok) counters.attacks_ok += 1;
          else counters.attacks_rejected += 1;
        }
        const moved = await call(agent, "/api/move", { spec: { Steps: { dir, count: 1 } } });
        if (moved.ok) counters.moves_ok += 1;
        else counters.moves_rejected += 1;
      }

      const remaining = (deadlineMs - Date.now()) / 1000;
      if (remaining < 0.05) break;
      const waited = await call(agent, "/api/wait", {
        timeout_seconds: Math.min(1, Math.max(0.05, remaining)),
      });
      if (waited.ok) counters.waits_ok += 1;
    } catch (error) {
      if (error instanceof Deadline) break;
      throw error;
    }
  }
  return { id: agent.id, nick: agent.nick, placement: agent.placement };
}

let failure = null;
let agentsDone = 0;
try {
  await Promise.all(
    Array.from({ length: agentCount }, async (_, index) => {
      const result = await agentLoop(index);
      agentsDone += 1;
      return result;
    }),
  );
} catch (error) {
  failure = error;
  console.log(`SERVER_DOWN: ${error?.message ?? error}`);
  console.log(`agents_started=${agentCount} agents_finished=${agentsDone}`);
}

const wallSeconds = (Date.now() - startMs) / 1000;
const summary = {
  started_at: startedAt.toISOString(),
  finished_at: new Date().toISOString(),
  duration_seconds: durationSeconds,
  wall_seconds: Number(wallSeconds.toFixed(3)),
  agents: agentCount,
  base,
  server_down: failure instanceof ServerDown,
  error: failure ? String(failure?.message ?? failure) : null,
  counters,
};
if (summaryPath) {
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
}
console.log(
  `stress-200: agents=${agentCount} wall=${wallSeconds.toFixed(1)}s requests=${counters.requests} ` +
    `joins_ok=${counters.joins_ok} joins_rejected=${counters.joins_rejected} ` +
    `queue_full=${counters.joins_queue_full} rate_limited=${counters.rate_limited} ` +
    `server_down=${summary.server_down}`,
);
if (failure) process.exitCode = 1;
