//! Replay and restore: rebuild a world from a snapshot plus its event log.
//!
//! The event log is the source of truth (design §8). `restore` applies a
//! contiguous run of events to a snapshot and refuses anything inconsistent;
//! `replay` re-runs a schedule of intents from scratch, which is how a server
//! verifies that its log matches the rules.

use crate::config::Config;
use crate::event::{Event, EventKind};
use crate::map::Terrain;
use crate::state::{Agent, Object, Session, SessionStatus, WorldState};
use crate::step::{mark_all_seen, step, Intent};
use loo_proto::{AgentId, Pos, SessionId, Tick};
use std::collections::VecDeque;
use std::fmt;

/// A replay stopped because the event log does not match the rules.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplayError {
    pub tick: Tick,
    pub seq: u32,
    pub message: String,
}

impl fmt::Display for ReplayError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "replay failed at tick {} seq {}: {}",
            self.tick, self.seq, self.message
        )
    }
}

impl std::error::Error for ReplayError {}

fn fail(event: &Event, message: impl Into<String>) -> ReplayError {
    ReplayError {
        tick: event.tick,
        seq: event.seq,
        message: message.into(),
    }
}

/// Applies `events` to a clone of `snapshot` and returns the resulting world.
///
/// Every tick must start with its `TickSettled` event (`seq == 1`) and ticks
/// must be contiguous, starting at `snapshot.tick + 1`. Each tick ends with the
/// same view update `step` performs, so `Session::seen` matches an in-memory
/// world exactly.
pub fn restore(
    snapshot: &WorldState,
    events: &[Event],
    cfg: &Config,
) -> Result<WorldState, ReplayError> {
    let mut world = snapshot.clone();
    if events.is_empty() {
        return Ok(world);
    }

    let mut expected_tick = snapshot.tick + 1;
    let mut current_tick: Option<Tick> = None;
    let mut expected_seq = 1;
    let mut tick_seed = 0u64;

    for event in events {
        if current_tick != Some(event.tick) {
            if let Some(previous) = current_tick {
                if event.tick <= previous {
                    return Err(fail(
                        event,
                        format!(
                            "tick {} comes after tick {previous}; events must be ordered",
                            event.tick
                        ),
                    ));
                }
                mark_all_seen(&mut world, cfg);
                expected_tick = previous + 1;
            }
            if event.tick != expected_tick {
                return Err(fail(
                    event,
                    format!(
                        "tick {} is not contiguous: expected tick {expected_tick}",
                        event.tick
                    ),
                ));
            }
            if !matches!(event.kind, EventKind::TickSettled) {
                return Err(fail(
                    event,
                    format!(
                        "the first event of tick {} is {}, not TickSettled",
                        event.tick,
                        event.kind.name()
                    ),
                ));
            }
            if event.seq != 1 {
                return Err(fail(
                    event,
                    format!("TickSettled has seq {}, expected 1", event.seq),
                ));
            }
            current_tick = Some(event.tick);
            expected_seq = 1;
            tick_seed = event.seed;
            world.tick = event.tick;
        }

        if event.seq != expected_seq {
            return Err(fail(
                event,
                format!("seq {} where {expected_seq} was expected", event.seq),
            ));
        }
        if event.seed != tick_seed {
            return Err(fail(
                event,
                format!(
                    "seed {} does not match the tick's seed {tick_seed}",
                    event.seed
                ),
            ));
        }
        apply_event(&mut world, event)?;
        expected_seq += 1;
    }

    mark_all_seen(&mut world, cfg);
    Ok(world)
}

fn apply_event(world: &mut WorldState, event: &Event) -> Result<(), ReplayError> {
    match &event.kind {
        EventKind::TickSettled => {}
        EventKind::EnteredWorld {
            session, agent, at, ..
        } => {
            match world.entry_queue.front() {
                Some(front) if *front == *session => {}
                other => {
                    return Err(fail(
                        event,
                        format!(
                            "session {session} entered the world but the queue front is {other:?}"
                        ),
                    ))
                }
            }
            world.entry_queue.pop_front();
            let Some(entry) = world.sessions.get_mut(session) else {
                return Err(fail(event, format!("session {session} does not exist")));
            };
            entry.status = SessionStatus::Inside;
            let Some(entry) = world.agents.get_mut(agent) else {
                return Err(fail(event, format!("agent {agent} does not exist")));
            };
            entry.pos = Some(*at);
        }
        EventKind::AgentMoved {
            session: _,
            agent,
            from,
            to,
            ..
        } => {
            let Some(entry) = world.agents.get_mut(agent) else {
                return Err(fail(event, format!("agent {agent} does not exist")));
            };
            if entry.pos != Some(*from) {
                return Err(fail(
                    event,
                    format!("agent {agent} is at {:?}, not {from}", entry.pos),
                ));
            }
            entry.pos = Some(*to);
            consume_step(entry).map_err(|message| fail(event, message))?;
        }
        EventKind::AgentSwapped {
            agent,
            other_agent,
            from,
            to,
            other_from,
            other_to,
            ..
        } => {
            if world.agents.get(agent).and_then(|a| a.pos) != Some(*from) {
                return Err(fail(event, format!("agent {agent} is not at {from}")));
            }
            if world.agents.get(other_agent).and_then(|a| a.pos) != Some(*other_from) {
                return Err(fail(
                    event,
                    format!("agent {other_agent} is not at {other_from}"),
                ));
            }
            let Some(mover) = world.agents.get_mut(agent) else {
                return Err(fail(event, format!("agent {agent} does not exist")));
            };
            mover.pos = Some(*to);
            consume_step(mover).map_err(|message| fail(event, message))?;
            let Some(other) = world.agents.get_mut(other_agent) else {
                return Err(fail(event, format!("agent {other_agent} does not exist")));
            };
            other.pos = Some(*other_to);
            other.action = None;
        }
        EventKind::ActionStarted { agent, action, .. } => {
            let Some(entry) = world.agents.get_mut(agent) else {
                return Err(fail(event, format!("agent {agent} does not exist")));
            };
            entry.action = Some(action.clone());
        }
        EventKind::ActionReplaced { agent, to, .. } => {
            let Some(entry) = world.agents.get_mut(agent) else {
                return Err(fail(event, format!("agent {agent} does not exist")));
            };
            entry.action = Some(to.clone());
        }
        EventKind::ActionFinished { agent, at, .. } => {
            let Some(entry) = world.agents.get_mut(agent) else {
                return Err(fail(event, format!("agent {agent} does not exist")));
            };
            if entry.pos != Some(*at) {
                return Err(fail(
                    event,
                    format!("agent {agent} is at {:?}, not {at}", entry.pos),
                ));
            }
            entry.action = None;
        }
    }
    Ok(())
}

/// Pops one direction off a moving agent's action.
fn consume_step(agent: &mut Agent) -> Result<(), String> {
    let Some(action) = agent.action.as_mut() else {
        return Err(format!("agent {} moved without a running action", agent.id));
    };
    if action.dirs.pop_front().is_none() {
        return Err(format!(
            "agent {} moved but its action had no steps left",
            agent.id
        ));
    }
    Ok(())
}

/// Re-runs `schedule` (seed, intents per tick) from `world` and returns the
/// final world plus every event in order.
pub fn replay(
    world: &WorldState,
    schedule: &[(u64, Vec<Intent>)],
    cfg: &Config,
) -> (WorldState, Vec<Event>) {
    let mut current = world.clone();
    let mut events = Vec::new();
    for (seed, intents) in schedule {
        let (next, tick_events) = step(&current, intents, *seed, cfg);
        current = next;
        events.extend(tick_events);
    }
    (current, events)
}

/// One difference between two worlds. `a` is the expected value, `b` the value
/// being checked.
#[derive(Clone, Debug, PartialEq)]
pub enum WorldDiff {
    Tick {
        a: Tick,
        b: Tick,
    },
    Entrance {
        a: Pos,
        b: Pos,
    },
    MapSize {
        a: (i32, i32),
        b: (i32, i32),
    },
    Terrain {
        pos: Pos,
        a: Option<Terrain>,
        b: Option<Terrain>,
    },
    Object {
        pos: Pos,
        a: Option<Object>,
        b: Option<Object>,
    },
    Agent {
        id: AgentId,
        a: Option<Agent>,
        b: Option<Agent>,
    },
    Session {
        id: SessionId,
        a: Option<Session>,
        b: Option<Session>,
    },
    Queue {
        a: VecDeque<SessionId>,
        b: VecDeque<SessionId>,
    },
}

/// Every field-level difference between two worlds; empty when they are
/// identical.
pub fn diff_worlds(a: &WorldState, b: &WorldState) -> Vec<WorldDiff> {
    let mut diffs = Vec::new();
    if a.tick != b.tick {
        diffs.push(WorldDiff::Tick {
            a: a.tick,
            b: b.tick,
        });
    }
    if a.entrance != b.entrance {
        diffs.push(WorldDiff::Entrance {
            a: a.entrance,
            b: b.entrance,
        });
    }
    let size = |w: &WorldState| (w.map.width(), w.map.height());
    if size(a) != size(b) {
        diffs.push(WorldDiff::MapSize {
            a: size(a),
            b: size(b),
        });
    }

    let max_x = a.map.width().max(b.map.width());
    let max_y = a.map.height().max(b.map.height());
    for y in 0..max_y {
        for x in 0..max_x {
            let pos = Pos::new(x, y);
            let terrain_a = a.map.terrain_at(pos);
            let terrain_b = b.map.terrain_at(pos);
            if terrain_a != terrain_b {
                diffs.push(WorldDiff::Terrain {
                    pos,
                    a: terrain_a,
                    b: terrain_b,
                });
            }
            let object_a = a.object_at(pos);
            let object_b = b.object_at(pos);
            if object_a != object_b {
                diffs.push(WorldDiff::Object {
                    pos,
                    a: object_a,
                    b: object_b,
                });
            }
        }
    }

    let agent_ids: Vec<AgentId> = a
        .agents
        .keys()
        .chain(b.agents.keys())
        .copied()
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    for id in agent_ids {
        let left = a.agents.get(&id);
        let right = b.agents.get(&id);
        if left != right {
            diffs.push(WorldDiff::Agent {
                id,
                a: left.cloned(),
                b: right.cloned(),
            });
        }
    }

    let session_ids: Vec<SessionId> = a
        .sessions
        .keys()
        .chain(b.sessions.keys())
        .copied()
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    for id in session_ids {
        let left = a.sessions.get(&id);
        let right = b.sessions.get(&id);
        if left != right {
            diffs.push(WorldDiff::Session {
                id,
                a: left.cloned(),
                b: right.cloned(),
            });
        }
    }

    if a.entry_queue != b.entry_queue {
        diffs.push(WorldDiff::Queue {
            a: a.entry_queue.clone(),
            b: b.entry_queue.clone(),
        });
    }

    diffs
}
