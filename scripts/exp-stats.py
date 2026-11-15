#!/usr/bin/env python3
"""Recompute every PROJECT-126-I report number from one group's raw logs.

Usage:
    scripts/exp-stats.py <a|b|c>

Reads only the group's run directory (`.conductor/exp-i/group-<g>/`):
`data/events.jsonl`, `data/commands.jsonl`, `agent-*/sessions/**/*.jsonl`,
`load.log`, `metrics.log`, `meta.txt`, `start-epoch.txt`, `end-epoch.txt`. When
the JSONL logs are absent it falls back to the same records in `data/world.db`,
which is where the server persists them; it prints a `note=` line when it does
that.

Nothing here carries an expected value: every number is a count, a sum or a
percentile of those files.
"""

import json
import math
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path

GROUPS = ("a", "b", "c")
ROOT = Path(__file__).resolve().parent.parent
EXP = ROOT / ".conductor" / "exp-i"


def die(message):
    print(f"FAIL: {message}", file=sys.stderr)
    sys.exit(2)


def read_meta(group_dir):
    meta = {}
    path = group_dir / "meta.txt"
    if not path.exists():
        return meta
    for line in path.read_text(encoding="utf-8").splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            meta[key.strip()] = value.strip()
    return meta


def read_epoch(path):
    try:
        return int(path.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return 0


def read_jsonl(path):
    rows = []
    if not path.exists():
        return rows
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def db_events(path):
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        for (payload,) in con.execute(
            "SELECT payload FROM events WHERE world_id = 1 ORDER BY id"
        ):
            try:
                yield json.loads(payload)
            except json.JSONDecodeError:
                continue
    finally:
        con.close()


def db_commands(path):
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        query = (
            "SELECT ts_ms, tick, agent, command, ok, summary, duration_ms, intent "
            "FROM commands WHERE world_id = 1 ORDER BY id"
        )
        for ts_ms, tick, agent, command, ok, summary, duration_ms, intent in con.execute(query):
            row = {
                "ts_ms": ts_ms,
                "tick": tick,
                "agent": agent,
                "command": command,
                "ok": bool(ok),
                "summary": summary,
                "duration_ms": duration_ms,
            }
            if intent is not None:
                try:
                    row["intent"] = json.loads(intent)
                except json.JSONDecodeError:
                    row["intent"] = intent
            yield row
    finally:
        con.close()


def load_sources(group_dir):
    """Return (events, commands, note) with JSONL preferred over world.db."""
    data = group_dir / "data"
    events_path = data / "events.jsonl"
    commands_path = data / "commands.jsonl"
    db_path = data / "world.db"
    note = ""

    events = read_jsonl(events_path)
    commands = read_jsonl(commands_path)
    if (not events and not commands) and db_path.exists():
        events = list(db_events(db_path))
        commands = list(db_commands(db_path))
        note = "read_from=world.db (JSONL logs absent)"
    return events, commands, note


def split_event(event):
    """`{"tick": t, "kind": {"Joined": {...}}}` -> (tick, "Joined", {...})."""
    tick = event.get("tick", 0)
    kind = event.get("kind")
    if isinstance(kind, dict) and len(kind) == 1:
        name, body = next(iter(kind.items()))
        return tick, name, body if isinstance(body, dict) else {}
    if isinstance(kind, str):
        return tick, kind, event
    return tick, "", {}


def action_name(action):
    if isinstance(action, dict) and len(action) == 1:
        return next(iter(action))
    if isinstance(action, str):
        return action
    return ""


def percentile(values, share):
    if not values:
        return 0
    ordered = sorted(values)
    index = max(0, math.ceil(share * len(ordered)) - 1)
    return ordered[index]


def transcript_stats(group_dir):
    per_agent = {}
    messages = 0
    files = 0
    for path in sorted(group_dir.glob("agent-*/sessions/**/*.jsonl")):
        files += 1
        agent = path.relative_to(group_dir).parts[0]
        cost = per_agent.setdefault(agent, 0.0)
        with path.open(encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if entry.get("type") != "message":
                    continue
                messages += 1
                message = entry.get("message") or {}
                usage = message.get("usage") or entry.get("usage") or {}
                total = (usage.get("cost") or {}).get("total")
                if isinstance(total, (int, float)):
                    per_agent[agent] += float(total)
    return messages, per_agent, files


def load_samples(path):
    samples = []
    if not path.exists():
        return samples
    for line in path.read_text(encoding="utf-8").splitlines():
        fields = line.split()
        if len(fields) < 3:
            continue
        try:
            samples.append((int(fields[0]), float(fields[1]), int(fields[2])))
        except ValueError:
            continue
    return samples


def load_settle(path):
    """`/api/metrics` samples: one envelope JSON per line, from `metrics.log`."""
    samples = []
    if not path.exists():
        return samples
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            sample = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(sample, dict):
            continue
        settle = sample.get("settle_ms")
        if not isinstance(settle, dict):
            result = sample.get("result")
            settle = result.get("settle_ms") if isinstance(result, dict) else None
        if not isinstance(settle, dict):
            continue
        p99 = settle.get("p99")
        maximum = settle.get("max")
        if isinstance(p99, (int, float)) and isinstance(maximum, (int, float)):
            samples.append((float(p99), float(maximum)))
    return samples


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in GROUPS:
        die("usage: scripts/exp-stats.py <a|b|c>")
    group = sys.argv[1]
    group_dir = EXP / f"group-{group}"
    if not group_dir.is_dir():
        die(f"missing run directory {group_dir}")
    if not (group_dir / "data").is_dir():
        die(f"missing data directory {group_dir / 'data'}")

    meta = read_meta(group_dir)
    events_raw, commands, note = load_sources(group_dir)
    events = [split_event(raw) for raw in events_raw]

    start = read_epoch(group_dir / "start-epoch.txt")
    end = read_epoch(group_dir / "end-epoch.txt")
    wall = end - start if start and end else 0

    # 1. provenance and wall clock.
    print(f"group={group}")
    print(f"git_head={meta.get('git_head', '')}")
    print(f"map_sha256={meta.get('map_sha256', '')}")
    print(f"binary_sha256={meta.get('server_sha256', '')}")
    print(f"wall_start_epoch={start}")
    print(f"wall_end_epoch={end}")
    print(f"wall_seconds={wall}")
    if note:
        print(f"note={note}")
    print()

    kinds = Counter(name for _, name, _ in events)
    bodies = [(name, body) for _, name, body in events]

    # 2. sessions.
    joined = [body for name, body in bodies if name == "Joined"]
    joined_inside = sum(1 for body in joined if body.get("inside"))
    joined_waiting = len(joined) - joined_inside
    entered_from_queue = kinds["EnteredWorld"]
    entered = joined_inside + entered_from_queue
    ended = [body for name, body in bodies if name == "SessionEnded"]
    outcomes = Counter(str(body.get("outcome", "")) for body in ended)
    success = outcomes.get("success", 0)
    success_rate = success / entered if entered else 0.0
    print(f"sessions_joined={len(joined)}")
    print(f"sessions_joined_inside={joined_inside}")
    print(f"sessions_joined_waiting={joined_waiting}")
    print(f"sessions_entered={entered}")
    print(f"sessions_entered_from_queue={entered_from_queue}")
    print(f"sessions_success={success}")
    print(f"sessions_use_succeeded={kinds['UseSucceeded']}")
    print(f"success_rate={success_rate:.3f}")
    print()

    # 3. how sessions ended. The five known outcomes are always printed so a
    # zero is explicit; anything unexpected is printed after them.
    known = ("success", "failed_deadline", "failed_recovery", "left", "abandoned")
    for outcome in known:
        print(f"session_outcome.{outcome}={outcomes.get(outcome, 0)}")
    for outcome, count in sorted(outcomes.items()):
        if outcome not in known:
            print(f"session_outcome.{outcome}={count}")
    print(f"use_failed={kinds['UseFailed']}")
    print()

    # 4. attacks.
    attack_started = kinds["AttackStarted"]
    attack_landed = kinds["AttackLanded"]
    attack_missed = kinds["AttackMissed"]
    attack_blocked = kinds["AttackBlocked"]
    attack_cancelled = kinds["AttackCancelled"]
    resolved = attack_landed + attack_missed + attack_blocked
    hit_rate = attack_landed / resolved if resolved else 0.0
    print(f"attack_started={attack_started}")
    print(f"attack_landed={attack_landed}")
    print(f"attack_missed={attack_missed}")
    print(f"attack_blocked={attack_blocked}")
    print(f"attack_cancelled={attack_cancelled}")
    print(f"attack_hit_rate={hit_rate:.3f}")
    print()

    # 5. defence.
    print(f"defend_started={kinds['DefendStarted']}")
    print(f"defend_ended={kinds['DefendEnded']}")
    print(f"defend_attack_blocked={attack_blocked}")
    print(f"demolish_blocked={kinds['DemolishBlocked']}")
    print()

    # 6. interruptions and demolitions.
    interrupted = [(tick, body) for tick, name, body in events if name == "UseInterrupted"]
    reasons = Counter(str(body.get("reason", "")) for _, body in interrupted)
    demolish_actions = [
        action_name(body.get("action"))
        for name, body in bodies
        if name == "ActionStarted"
    ]
    demolish_actions = [name for name in demolish_actions if name.lower().startswith("demolish")]

    # `ObjectChanged` with `cause: Demolish` is the authoritative world fact: it
    # names the object that was hit (or `object: null` when the object is gone).
    # A removal is classified by the object the same cell carried just before.
    demolish_events = Counter()
    demolish_agents = defaultdict(set)
    demolish_removed = 0
    demolished_at = set()
    last_type = {}
    for tick, name, body in events:
        if name != "ObjectChanged":
            continue
        pos = body.get("pos") or {}
        key = (pos.get("x"), pos.get("y"))
        obj = body.get("object")
        obj_type = next(iter(obj)) if isinstance(obj, dict) and len(obj) == 1 else None
        if obj_type:
            last_type[key] = obj_type.lower()
        cause = body.get("cause")
        if isinstance(cause, dict) and len(cause) == 1:
            cause = next(iter(cause))
        if cause != "Demolish":
            continue
        kind = obj_type.lower() if obj_type else last_type.get(key, "other")
        demolish_events[kind] += 1
        if obj is None:
            demolish_removed += 1
        agent = body.get("agent")
        if agent is not None:
            demolish_agents[kind].add(agent)
        demolished_at.add((tick, key))
    use_interrupted_by_demolish = 0
    for tick, body in interrupted:
        pos = body.get("pos") or {}
        x, y = pos.get("x"), pos.get("y")
        cells = [(x, y), (x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)]
        if any((tick, cell) in demolished_at for cell in cells):
            use_interrupted_by_demolish += 1

    print(f"use_interrupted={len(interrupted)}")
    print("use_interrupted_by_reason:")
    for reason, count in sorted(reasons.items()):
        print(f"  {reason} {count}")
    print(f"use_interrupted_by_demolish={use_interrupted_by_demolish}")
    print(f"demolish_actions_total={len(demolish_actions)}")
    for kind in ("toilet", "wall", "door", "site"):
        print(f"demolish_events_{kind}={demolish_events.get(kind, 0)}")
    print(f"demolish_events_other={demolish_events.get('other', 0)}")
    print(f"demolish_object_removed={demolish_removed}")
    print(f"demolish_agents_toilet={len(demolish_agents.get('toilet', ()))}")
    print("demolish_note=world objects have no owner; this counts Demolish ObjectChanged events, "
          "not a strictly attributable 'someone else's stall'")
    print()

    # 7. queue waiting, in ticks.
    waiting_joins = {
        body.get("session"): tick
        for tick, name, body in events
        if name == "Joined" and not body.get("inside")
    }
    entered_ticks = {
        body.get("session"): tick
        for tick, name, body in events
        if name == "EnteredWorld"
    }
    waits = [
        entered_ticks[session] - tick
        for session, tick in waiting_joins.items()
        if session in entered_ticks
    ]
    never_entered = len(waiting_joins) - len(waits)
    bins = Counter()
    for wait in waits:
        if wait <= 5:
            bins["0-5"] += 1
        elif wait <= 10:
            bins["6-10"] += 1
        elif wait <= 20:
            bins["11-20"] += 1
        elif wait <= 40:
            bins["21-40"] += 1
        else:
            bins[">40"] += 1
    print(f"queue_wait_n={len(waits)}")
    print(f"queue_wait_p50={percentile(waits, 0.50)}")
    print(f"queue_wait_p90={percentile(waits, 0.90)}")
    print(f"queue_wait_max={max(waits) if waits else 0}")
    print(f"queue_wait_never_entered={never_entered}")
    print("queue_wait_histogram:")
    for label in ("0-5", "6-10", "11-20", "21-40", ">40"):
        print(f"  {label} {bins[label]}")
    print()

    # 8. commands.
    ok = sum(1 for row in commands if row.get("ok"))
    total = len(commands)
    by_name = Counter(str(row.get("command", "")) for row in commands)
    by_agent = Counter(
        str(row.get("agent")) for row in commands if row.get("agent") is not None
    )
    print(f"commands_total={total}")
    print(f"commands_ok={ok}")
    print(f"commands_failed={total - ok}")
    print(f"agent_commands_total={total - by_name.get('config', 0)}")
    print("commands_by_name:")
    for name, count in sorted(by_name.items()):
        print(f"  {name} {count}")
    failed_by_name = Counter(
        str(row.get("command", "")) for row in commands if not row.get("ok")
    )
    print("commands_failed_by_name:")
    for name, count in sorted(failed_by_name.items()):
        print(f"  {name} {count}")
    print("commands_by_agent:")
    for agent, count in sorted(by_agent.items(), key=lambda item: int(item[0])):
        print(f"  {agent} {count}")
    print()

    # 9. transcript cost and message count.
    messages, per_agent_cost, files = transcript_stats(group_dir)
    cost_total = sum(per_agent_cost.values())
    print(f"cost_usd_total={cost_total:.6f}")
    print(f"transcript_messages={messages}")
    print(f"transcript_files={files}")
    if files == 0:
        print("cost_note=no transcripts under agent-*/sessions; cost is 0")
    for agent, cost in sorted(per_agent_cost.items()):
        print(f"cost_usd.{agent}={cost:.6f}")
    print()

    # 10. machine load and tick settlement latency.
    samples = load_samples(group_dir / "load.log")
    max_load = max((sample[1] for sample in samples), default=0.0)
    min_mem = min((sample[2] for sample in samples), default=0)
    print(f"max_loadavg_1m={max_load:.2f}")
    print(f"min_mem_available_mb={min_mem}")
    print(f"load_samples={len(samples)}")

    settle = load_settle(group_dir / "metrics.log")
    if settle:
        print(f"settle_ms_p99_max={max(sample[0] for sample in settle):.3f}")
        print(f"settle_ms_max={max(sample[1] for sample in settle):.3f}")
    else:
        print("settle_ms_p99_max=0")
        print("settle_ms_max=0")


if __name__ == "__main__":
    main()
