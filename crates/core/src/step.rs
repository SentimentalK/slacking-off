//! The rules engine: `join` and `step`.
//!
//! `step(state, intents, seed) -> (state, events)` is the whole contract: pure,
//! deterministic, no clock, no network, no disk, no global RNG.

use crate::config::Config;
use crate::event::{ActionOutcome, Blocker, Event, EventKind, EventLog};
use crate::rng::shuffle;
use crate::state::{Action, Agent, Object, Session, SessionStatus, WorldState};
use loo_proto::{AgentId, Dir, Nick, Pos, SessionId};

/// A join request as the server understands it: one persistent agent id, one
/// nickname, one session id per entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JoinCommand {
    pub agent: AgentId,
    pub nick: Nick,
    pub session: SessionId,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JoinOutcome {
    Inside { at: Pos },
    Waiting { ahead: usize },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JoinRejectKind {
    AlreadyJoined,
    QueueFull,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JoinReject {
    pub kind: JoinRejectKind,
    pub message: String,
}

/// An action submitted between ticks. A second intent for the same agent in the
/// same window replaces the first (design §3).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Intent {
    pub agent: AgentId,
    pub kind: IntentKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IntentKind {
    Move { dirs: Vec<Dir>, label: String },
}

/// Places a joining agent at the entrance, or queues it outside.
///
/// Step 0 keeps the queue as an ordered list rather than map cells (the entity
/// queue of design §4.11 is step 5), but the entrance rule is already the real
/// one: one agent at a time, no overlap, no shoving.
pub fn join(
    world: &WorldState,
    cmd: &JoinCommand,
    cfg: &Config,
) -> Result<(WorldState, JoinOutcome), JoinReject> {
    if world.agents.contains_key(&cmd.agent) {
        return Err(JoinReject {
            kind: JoinRejectKind::AlreadyJoined,
            message: format!(
                "agent {} already has a session in this world; one entry per agent",
                cmd.agent
            ),
        });
    }
    if world.sessions.contains_key(&cmd.session) {
        return Err(JoinReject {
            kind: JoinRejectKind::AlreadyJoined,
            message: format!("session {} already exists", cmd.session),
        });
    }

    let mut next = world.clone();
    let entrance_free = next.agent_at(next.entrance).is_none();
    let room = next.inside_count() < cfg.max_on_field;

    if room && entrance_free {
        next.agents.insert(
            cmd.agent,
            Agent {
                id: cmd.agent,
                nick: cmd.nick.clone(),
                pos: Some(next.entrance),
                action: None,
            },
        );
        next.sessions.insert(
            cmd.session,
            Session {
                id: cmd.session,
                agent: cmd.agent,
                status: SessionStatus::Inside,
                seen: Default::default(),
            },
        );
        next.mark_seen(
            cmd.session,
            next.entrance,
            next.tick,
            cfg.view.width,
            cfg.view.height,
        );
        let at = next.entrance;
        return Ok((next, JoinOutcome::Inside { at }));
    }

    if next.entry_queue.len() >= cfg.session.queue_capacity {
        return Err(JoinReject {
            kind: JoinRejectKind::QueueFull,
            message: format!(
                "queue is full ({} already waiting); try again later",
                cfg.session.queue_capacity
            ),
        });
    }
    let ahead = next.entry_queue.len();
    next.agents.insert(
        cmd.agent,
        Agent {
            id: cmd.agent,
            nick: cmd.nick.clone(),
            pos: None,
            action: None,
        },
    );
    next.sessions.insert(
        cmd.session,
        Session {
            id: cmd.session,
            agent: cmd.agent,
            status: SessionStatus::Waiting,
            seen: Default::default(),
        },
    );
    next.entry_queue.push_back(cmd.session);
    Ok((next, JoinOutcome::Waiting { ahead }))
}

/// Settles one tick: verbs submitted earlier take effect now, the queue moves
/// up, and every running action advances one step in seeded order.
pub fn step(
    world: &WorldState,
    intents: &[Intent],
    seed: u64,
    cfg: &Config,
) -> (WorldState, Vec<Event>) {
    let mut next = world.clone();
    next.tick += 1;
    let mut log = EventLog::new(next.tick, seed);

    for intent in intents {
        let Some(agent) = next.agents.get_mut(&intent.agent) else {
            continue;
        };
        if agent.pos.is_none() {
            continue;
        }
        let IntentKind::Move { dirs, label } = &intent.kind;
        agent.action = Some(Action {
            dirs: dirs.iter().copied().collect(),
            total: dirs.len() as u32,
            label: label.clone(),
        });
    }

    admit_from_queue(&mut next, &mut log, cfg);

    let mut order: Vec<AgentId> = next
        .agents
        .iter()
        .filter(|(_, a)| a.pos.is_some())
        .map(|(id, _)| *id)
        .collect();
    shuffle(&mut order, seed);
    for agent in order {
        advance_move(&mut next, agent, &mut log);
    }

    let viewers: Vec<(SessionId, Pos)> = next
        .sessions
        .values()
        .filter_map(|s| match s.status {
            SessionStatus::Inside => next
                .agents
                .get(&s.agent)
                .and_then(|a| a.pos)
                .map(|p| (s.id, p)),
            SessionStatus::Waiting => None,
        })
        .collect();
    let tick = next.tick;
    for (session, pos) in viewers {
        next.mark_seen(session, pos, tick, cfg.view.width, cfg.view.height);
    }

    (next, log.into_vec())
}

fn admit_from_queue(world: &mut WorldState, log: &mut EventLog, cfg: &Config) {
    loop {
        if world.inside_count() >= cfg.max_on_field {
            return;
        }
        let Some(&session_id) = world.entry_queue.front() else {
            return;
        };
        let entrance = world.entrance;
        if world.agent_at(entrance).is_some() {
            return;
        }
        world.entry_queue.pop_front();
        let Some(session) = world.sessions.get_mut(&session_id) else {
            continue;
        };
        session.status = SessionStatus::Inside;
        let agent_id = session.agent;
        let Some(agent) = world.agents.get_mut(&agent_id) else {
            continue;
        };
        agent.pos = Some(entrance);
        let nick = agent.nick.to_string();
        log.push(EventKind::EnteredWorld {
            session: session_id,
            agent: agent_id,
            nick,
            at: entrance,
        });
    }
}

fn advance_move(world: &mut WorldState, agent_id: AgentId, log: &mut EventLog) {
    let Some(agent) = world.agents.get(&agent_id) else {
        return;
    };
    let Some(pos) = agent.pos else {
        return;
    };
    let Some(action) = agent.action.clone() else {
        return;
    };
    let Some(session) = world.session_of(agent_id).map(|s| s.id) else {
        return;
    };
    let nick = agent.nick.to_string();

    let mut dirs = action.dirs.clone();
    let Some(dir) = dirs.pop_front() else {
        if let Some(agent) = world.agents.get_mut(&agent_id) {
            agent.action = None;
        }
        log.push(EventKind::ActionFinished {
            session,
            agent: agent_id,
            nick,
            at: pos,
            dir: None,
            outcome: ActionOutcome::Completed,
        });
        return;
    };

    let target = pos.step(dir);
    let blocker = if !world.map.in_bounds(target) {
        Some(Blocker::MapEdge)
    } else if let Some(object) = world.object_at(target).filter(|o| o.blocks_movement()) {
        Some(match object {
            Object::Door { .. } => Blocker::ClosedDoor,
            _ => Blocker::Wall,
        })
    } else {
        world.agent_at(target).map(|other| Blocker::Agent {
            nick: other.nick.to_string(),
        })
    };

    if let Some(by) = blocker {
        if let Some(agent) = world.agents.get_mut(&agent_id) {
            agent.action = None;
        }
        log.push(EventKind::ActionFinished {
            session,
            agent: agent_id,
            nick,
            at: pos,
            dir: Some(dir),
            outcome: ActionOutcome::Blocked { by },
        });
        return;
    }

    if let Some(agent) = world.agents.get_mut(&agent_id) {
        agent.pos = Some(target);
    }
    log.push(EventKind::AgentMoved {
        session,
        agent: agent_id,
        nick: nick.clone(),
        from: pos,
        to: target,
    });

    if dirs.is_empty() {
        if let Some(agent) = world.agents.get_mut(&agent_id) {
            agent.action = None;
        }
        log.push(EventKind::ActionFinished {
            session,
            agent: agent_id,
            nick,
            at: target,
            dir: None,
            outcome: ActionOutcome::Completed,
        });
    } else if let Some(agent) = world.agents.get_mut(&agent_id) {
        agent.action = Some(Action {
            dirs,
            total: action.total,
            label: action.label,
        });
    }
}
