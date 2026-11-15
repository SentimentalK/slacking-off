#!/usr/bin/env node
import { execSync } from "node:child_process";

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", shell: "/bin/bash" }).trim();
  } catch {
    return "";
  }
}

const info = {
  nproc: Number(sh("nproc") || 0),
  cpu: sh("grep 'model name' /proc/cpuinfo | head -1 | sed 's/.*: //'"),
  memTotalKb: Number(sh("grep MemTotal /proc/meminfo | awk '{print $2}'") || 0),
  kernel: sh("uname -sr"),
  uptime: sh("uptime"),
  load1m: sh("cut -d' ' -f1 /proc/loadavg"),
  loadavg: sh("cat /proc/loadavg"),
  topCpu: sh("ps -eo pcpu,comm --sort=-pcpu | head -6").split("\n").slice(1),
  agentProcs: sh("pgrep -fc 'claude|codex' || true"),
  display: process.env.DISPLAY ?? null,
  session: sh("echo ${XDG_SESSION_TYPE:-unknown}"),
  measuredAt: new Date().toISOString(),
  note: "loo-server, seed agents and Chrome share this host with whatever else is running (other agents/Masters); load average at start is recorded above",
};

process.stdout.write(JSON.stringify(info, null, 2));
