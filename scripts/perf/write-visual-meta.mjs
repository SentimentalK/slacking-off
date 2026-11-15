#!/usr/bin/env node
import { writeFileSync, readFileSync } from "node:fs";
import { parseArgs } from "./util.mjs";

const args = parseArgs(process.argv.slice(2));
const ticks = JSON.parse(args.ticks ?? "[]");
const config = args.config ? JSON.parse(readFileSync(args.config, "utf8")) : null;
writeFileSync(
  args.out,
  `${JSON.stringify(
    {
      tick_seconds: Number(args["tick-seconds"] ?? 1),
      visual_tick_seconds: 120,
      ticks,
      chrome_version: args["chrome-version"] ?? "unknown",
      viewport: { width: 1440, height: 900, dpr: 1 },
      reduced_motion: "reduce",
      config,
      note: "data.tar = full world (50 inside + 50 queued) captured after the full measurement; replay at the last highlight tick",
    },
    null,
    2,
  )}\n`,
);
