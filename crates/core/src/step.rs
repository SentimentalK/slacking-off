//! The rules engine: `join` and `step`.
//!
//! `step(state, intents, seed) -> (state, events)` is the whole contract: pure,
//! deterministic, no clock, no network, no disk, no global RNG.

use crate::config::Config;
use crate::event::{ActionOutcome, Blocker, Event, EventKind, EventLog, ObjectCause};
use crate::rng::{shuffle, Rng};
use crate::rules::{session_score, validate_build, validate_demolish, validate_door, validate_use};
use crate::state::{Action, Agent, Object, Session, SessionStatus, SiteKind, WorldState};
use loo_proto::{AgentId, Dir, Need, Nick, Pos, SessionId, SessionOutcome};
use serde::{Deserialize, Serialize};

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
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Intent {
    pub agent: AgentId,
    pub kind: IntentKind,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum IntentKind {
    Move { dirs: Vec<Dir>, label: String },
    Build { kind: SiteKind, target: Pos },
    Demolish { target: Pos },
    Door { target: Pos, open: bool },
    Use { target: Pos },
    Cancel,
}

/// Places a joining agent at the entrance, or queues it outside.
///
/// This step keeps the queue as an ordered list rather than map cells (the entity
/// queue of design §4.11 is step 5), but the entrance rule is already the real
/// one: one agent at a time, no overlap, no shoving.
pub fn join(
    world: &WorldState,
    cmd: &JoinCommand,
    cfg: &Config,
    start_seq: u32,
    seed: u64,
) -> Result<(WorldState, JoinOutcome, Vec<Event>), JoinReject> {
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
    let mut log = EventLog::starting_at(world.tick, seed, start_seq + 1);
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
                stun_until: 0,
            },
        );
        next.sessions.insert(
            cmd.session,
            Session::fresh(
                cmd.session,
                cmd.agent,
                SessionStatus::Inside,
                Default::default(),
            ),
        );
        next.mark_seen(
            cmd.session,
            next.entrance,
            next.tick,
            cfg.view.width,
            cfg.view.height,
        );
        let at = next.entrance;
        log.push(EventKind::Joined {
            session: cmd.session,
            agent: cmd.agent,
            nick: cmd.nick.to_string(),
            at: Some(at),
        });
        if let Some(kind) = assign_need(&mut next, cmd.session, cfg, seed) {
            log.push(kind);
        }
        return Ok((next, JoinOutcome::Inside { at }, log.into_vec()));
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
            stun_until: 0,
        },
    );
    next.sessions.insert(
        cmd.session,
        Session::fresh(
            cmd.session,
            cmd.agent,
            SessionStatus::Waiting,
            Default::default(),
        ),
    );
    next.entry_queue.push_back(cmd.session);
    log.push(EventKind::Joined {
        session: cmd.session,
        agent: cmd.agent,
        nick: cmd.nick.to_string(),
        at: None,
    });
    Ok((next, JoinOutcome::Waiting { ahead }, log.into_vec()))
}

/// Settles one tick: the queue moves up, then every agent in seeded order
/// applies its intents and advances one step of its final action.
pub fn step(
    world: &WorldState,
    intents: &[Intent],
    seed: u64,
    cfg: &Config,
) -> (WorldState, Vec<Event>) {
    let mut next = world.clone();
    next.tick += 1;
    let mut log = EventLog::new(next.tick, seed);
    log.push(EventKind::TickSettled);

    admit_from_queue(&mut next, &mut log, cfg, seed);

    let mut order: Vec<AgentId> = next
        .agents
        .iter()
        .filter(|(_, a)| a.pos.is_some())
        .map(|(id, _)| *id)
        .collect();
    shuffle(&mut order, seed);
    for agent in &order {
        apply_intents(&mut next, &mut log, *agent, intents, cfg);
        advance_action(&mut next, &mut log, *agent, cfg);
    }

    progress_uses(&mut next, &mut log, &order, cfg);
    expire_sessions(&mut next, &mut log);
    warn_deadlines(&mut next, &mut log, cfg);
    auto_open_doors(&mut next, &mut log);
    finish_lingering(&mut next, &mut log);

    mark_all_seen(&mut next, cfg);

    (next, log.into_vec())
}

/// Marks every inside session's view window as seen at `world.tick`. Both
/// `step` and `replay`'s `restore` end a tick with exactly this call, which is
/// what keeps `Session::seen` identical after a replay.
pub(crate) fn mark_all_seen(world: &mut WorldState, cfg: &Config) {
    let viewers: Vec<(SessionId, Pos)> = world
        .sessions
        .values()
        .filter_map(|s| match s.status {
            SessionStatus::Inside => world
                .agents
                .get(&s.agent)
                .and_then(|a| a.pos)
                .map(|p| (s.id, p)),
            SessionStatus::Waiting => None,
        })
        .collect();
    let tick = world.tick;
    for (session, pos) in viewers {
        world.mark_seen(session, pos, tick, cfg.view.width, cfg.view.height);
    }
}

fn admit_from_queue(world: &mut WorldState, log: &mut EventLog, cfg: &Config, seed: u64) {
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
        if let Some(kind) = assign_need(world, session_id, cfg, seed) {
            log.push(kind);
        }
    }
}

/// Gives a session its need and deadline, unless it already has one. The RNG is
/// seeded per session so the same join tick and seed always pick the same need.
fn assign_need(
    world: &mut WorldState,
    session: SessionId,
    cfg: &Config,
    seed: u64,
) -> Option<EventKind> {
    let agent = {
        let entry = world.sessions.get(&session)?;
        if entry.need.is_some() {
            return None;
        }
        entry.agent
    };
    let nick = world.agents.get(&agent)?.nick.to_string();
    let mut rng = Rng::new(seed ^ session.wrapping_mul(0x9E37_79B9_7F4A_7C15));
    let need = if rng.next_u64() & 1 == 0 {
        Need::Urine
    } else {
        Need::Feces
    };
    let span = cfg
        .need
        .deadline_ticks_max
        .saturating_sub(cfg.need.deadline_ticks_min)
        + 1;
    let deadline = world.tick + u64::from(cfg.need.deadline_ticks_min) + rng.below(u64::from(span));
    let entry = world.sessions.get_mut(&session)?;
    entry.need = Some(need);
    entry.deadline = deadline;
    Some(EventKind::NeedAssigned {
        session,
        agent,
        nick,
        need,
        deadline,
    })
}

/// Turns the tick's intents for one agent into its final action. A cancel with
/// no running action is a no-op; cancel with one ends it as `Cancelled`.
///
/// A `use` that cannot start ends immediately as `ActionFinished { Failed }`
/// and puts the agent back to no action, so it never enters the use phase.
fn apply_intents(
    world: &mut WorldState,
    log: &mut EventLog,
    agent_id: AgentId,
    intents: &[Intent],
    cfg: &Config,
) {
    let Some(session) = world.session_of(agent_id).map(|s| s.id) else {
        return;
    };
    let Some(pos) = world.agents.get(&agent_id).and_then(|a| a.pos) else {
        return;
    };
    let Some(nick) = world.agents.get(&agent_id).map(|a| a.nick.to_string()) else {
        return;
    };
    for intent in intents.iter().filter(|intent| intent.agent == agent_id) {
        match &intent.kind {
            IntentKind::Cancel => {
                let Some(action) = world.agents.get(&agent_id).and_then(|a| a.action.clone())
                else {
                    continue;
                };
                if matches!(action, Action::Use { .. }) {
                    interrupt_use(
                        world,
                        log,
                        agent_id,
                        session,
                        nick.clone(),
                        Some(pos),
                        "cancelled".to_string(),
                        cfg,
                    );
                } else {
                    end_action(
                        world,
                        log,
                        agent_id,
                        session,
                        nick.clone(),
                        pos,
                        None,
                        ActionOutcome::Cancelled,
                        &action,
                    );
                }
            }
            IntentKind::Use { .. } => {
                start_use(world, log, agent_id, session, nick.clone(), pos, cfg);
            }
            _ => {
                let new_action = action_for(&intent.kind);
                let old = world.agents.get(&agent_id).and_then(|a| a.action.clone());
                if matches!(old, Some(Action::Use { .. })) {
                    interrupt_use(
                        world,
                        log,
                        agent_id,
                        session,
                        nick.clone(),
                        Some(pos),
                        format!("replaced by {}", new_action.label()),
                        cfg,
                    );
                }
                match old {
                    Some(from) => log.push(EventKind::ActionReplaced {
                        session,
                        agent: agent_id,
                        nick: nick.clone(),
                        from,
                        to: new_action.clone(),
                    }),
                    None => log.push(EventKind::ActionStarted {
                        session,
                        agent: agent_id,
                        nick: nick.clone(),
                        action: new_action.clone(),
                    }),
                }
                if let Some(agent) = world.agents.get_mut(&agent_id) {
                    agent.action = Some(new_action);
                }
            }
        }
    }
}

/// Replaces whatever the agent was doing with a use, or rejects it on the spot.
/// Re-using while already using only retargets the toilet and keeps progress.
fn start_use(
    world: &mut WorldState,
    log: &mut EventLog,
    agent_id: AgentId,
    session: SessionId,
    nick: String,
    pos: Pos,
    cfg: &Config,
) {
    let new_action = Action::Use {
        target: pos,
        label: "use the toilet".to_string(),
    };
    let old = world.agents.get(&agent_id).and_then(|a| a.action.clone());
    if let Some(from @ Action::Use { .. }) = old {
        log.push(EventKind::ActionReplaced {
            session,
            agent: agent_id,
            nick,
            from,
            to: new_action.clone(),
        });
        if let Some(agent) = world.agents.get_mut(&agent_id) {
            agent.action = Some(new_action);
        }
        return;
    }
    match validate_use(world, agent_id, cfg) {
        Ok(target) => {
            match &old {
                Some(from) => log.push(EventKind::ActionReplaced {
                    session,
                    agent: agent_id,
                    nick: nick.clone(),
                    from: from.clone(),
                    to: new_action.clone(),
                }),
                None => log.push(EventKind::ActionStarted {
                    session,
                    agent: agent_id,
                    nick: nick.clone(),
                    action: new_action.clone(),
                }),
            }
            if let Some(agent) = world.agents.get_mut(&agent_id) {
                agent.action = Some(new_action);
            }
            let resumed = world
                .sessions
                .get_mut(&session)
                .and_then(|entry| entry.recovery_deadline.take());
            if resumed.is_some() {
                log.push(EventKind::UseResumed {
                    session,
                    agent: agent_id,
                    nick: nick.clone(),
                    pos: target,
                });
            }
            log.push(EventKind::UseStarted {
                session,
                agent: agent_id,
                nick,
                pos: target,
            });
        }
        Err(reason) => {
            if let Some(agent) = world.agents.get_mut(&agent_id) {
                agent.action = None;
            }
            log.push(EventKind::ActionFinished {
                session,
                agent: agent_id,
                nick,
                at: pos,
                dir: None,
                action: new_action,
                outcome: ActionOutcome::Failed { reason },
            });
        }
    }
}

/// Stops a running use without losing its progress and opens a recovery window.
#[allow(clippy::too_many_arguments)]
fn interrupt_use(
    world: &mut WorldState,
    log: &mut EventLog,
    agent_id: AgentId,
    session: SessionId,
    nick: String,
    pos: Option<Pos>,
    reason: String,
    cfg: &Config,
) {
    let Some(deadline) = world.sessions.get(&session).map(|entry| entry.deadline) else {
        return;
    };
    let recovery_deadline = recovery_deadline(world.tick, deadline, cfg);
    if let Some(agent) = world.agents.get_mut(&agent_id) {
        agent.action = None;
    }
    if let Some(entry) = world.sessions.get_mut(&session) {
        entry.recovery_deadline = Some(recovery_deadline);
    }
    log.push(EventKind::UseInterrupted {
        session,
        agent: agent_id,
        nick,
        pos,
        reason,
        recovery_deadline,
    });
}

/// The window an interrupted session has to start using again: the configured
/// recovery length, never past the session's own deadline.
fn recovery_deadline(tick: u64, deadline: u64, cfg: &Config) -> u64 {
    tick.saturating_add(u64::from(cfg.need.interrupt_recovery_ticks))
        .min(deadline)
}

fn action_for(kind: &IntentKind) -> Action {
    match kind {
        IntentKind::Move { dirs, label } => Action::Move {
            dirs: dirs.iter().copied().collect(),
            total: dirs.len() as u32,
            label: label.clone(),
        },
        IntentKind::Build { kind, target } => Action::Build {
            kind: *kind,
            target: *target,
            label: format!("build {} at {}", kind_name(*kind), target),
        },
        IntentKind::Demolish { target } => Action::Demolish {
            target: *target,
            label: format!("demolish at {target}"),
        },
        IntentKind::Door { target, open } => Action::Door {
            target: *target,
            open: *open,
            label: format!(
                "{} the door at {target}",
                if *open { "open" } else { "close" }
            ),
        },
        IntentKind::Use { target } => Action::Use {
            target: *target,
            label: "use the toilet".to_string(),
        },
        IntentKind::Cancel => unreachable!("cancel never creates an action"),
    }
}

fn kind_name(kind: SiteKind) -> &'static str {
    match kind {
        SiteKind::Wall => "wall",
        SiteKind::Door => "door",
        SiteKind::Toilet => "toilet",
    }
}

/// Advances whichever action the agent currently holds by one tick.
fn advance_action(world: &mut WorldState, log: &mut EventLog, agent_id: AgentId, cfg: &Config) {
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
    match action {
        Action::Move { .. } => advance_move(world, agent_id, log),
        Action::Build { .. } => build_tick(world, log, agent_id, session, nick, pos, &action, cfg),
        Action::Demolish { .. } => {
            demolish_tick(world, log, agent_id, session, nick, pos, &action, cfg)
        }
        Action::Door { .. } => door_tick(world, log, agent_id, session, nick, pos, &action),
        // `Use` advances in `progress_uses`, after every action has settled.
        Action::Use { .. } => {}
    }
}

#[allow(clippy::too_many_arguments)]
fn build_tick(
    world: &mut WorldState,
    log: &mut EventLog,
    agent_id: AgentId,
    session: SessionId,
    nick: String,
    pos: Pos,
    action: &Action,
    cfg: &Config,
) {
    let Action::Build { kind, target, .. } = action else {
        return;
    };
    if let Err(reason) = validate_build(world, agent_id, *kind, *target, cfg) {
        end_action(
            world,
            log,
            agent_id,
            session,
            nick,
            pos,
            None,
            ActionOutcome::Failed { reason },
            action,
        );
        return;
    }
    let required = match kind {
        SiteKind::Wall => cfg.build.wall_work,
        SiteKind::Door => cfg.build.door_work,
        SiteKind::Toilet => cfg.build.toilet_work,
    };
    let object = match world.object_at(*target) {
        Some(Object::Site {
            kind: existing,
            work,
        }) if existing == *kind => {
            let work = work.saturating_sub(1);
            if work == 0 {
                completed_object(*kind)
            } else {
                Object::Site { kind: *kind, work }
            }
        }
        _ => {
            let work = required.saturating_sub(1);
            if work == 0 {
                completed_object(*kind)
            } else {
                Object::Site { kind: *kind, work }
            }
        }
    };
    world.set_object(*target, Some(object));
    log.push(EventKind::ObjectChanged {
        session: Some(session),
        agent: Some(agent_id),
        nick: Some(nick.clone()),
        pos: *target,
        object: Some(object),
        cause: ObjectCause::Build { kind: *kind },
    });
    if !matches!(object, Object::Site { .. }) {
        end_action(
            world,
            log,
            agent_id,
            session,
            nick,
            pos,
            None,
            ActionOutcome::Completed,
            action,
        );
    }
}

fn completed_object(kind: SiteKind) -> Object {
    match kind {
        SiteKind::Wall => Object::Wall,
        SiteKind::Door => Object::Door { open: false },
        SiteKind::Toilet => Object::Toilet {
            level: 1,
            progress: 0,
        },
    }
}

#[allow(clippy::too_many_arguments)]
fn demolish_tick(
    world: &mut WorldState,
    log: &mut EventLog,
    agent_id: AgentId,
    session: SessionId,
    nick: String,
    pos: Pos,
    action: &Action,
    cfg: &Config,
) {
    let Action::Demolish { target, .. } = action else {
        return;
    };
    if let Err(reason) = validate_demolish(world, agent_id, *target) {
        end_action(
            world,
            log,
            agent_id,
            session,
            nick,
            pos,
            None,
            ActionOutcome::Failed { reason },
            action,
        );
        return;
    }
    let Some(existing) = world.object_at(*target) else {
        return;
    };
    let (object, finished) = match existing {
        Object::Site { .. } => (None, true),
        Object::Wall => {
            let work = cfg
                .build
                .wall_work
                .saturating_sub(cfg.build.wall_door_demolish_per_tick);
            site_after_demolish(SiteKind::Wall, work)
        }
        Object::Door { .. } => {
            let work = cfg
                .build
                .door_work
                .saturating_sub(cfg.build.wall_door_demolish_per_tick);
            site_after_demolish(SiteKind::Door, work)
        }
        Object::Toilet { level, progress } => toilet_after_demolish(level, progress, cfg),
    };
    world.set_object(*target, object);
    log.push(EventKind::ObjectChanged {
        session: Some(session),
        agent: Some(agent_id),
        nick: Some(nick.clone()),
        pos: *target,
        object,
        cause: ObjectCause::Demolish,
    });
    if finished {
        end_action(
            world,
            log,
            agent_id,
            session,
            nick,
            pos,
            None,
            ActionOutcome::Completed,
            action,
        );
    }
}

fn site_after_demolish(kind: SiteKind, work: u32) -> (Option<Object>, bool) {
    if work == 0 {
        (None, true)
    } else {
        (Some(Object::Site { kind, work }), false)
    }
}

/// Design §4.7: demolishing a toilet is continuous downgrade at
/// `toilet_demolish_per_tick` per tick. Crossing a level boundary sets the
/// progress to that interval's maximum and keeps subtracting; level 1 becomes
/// empty after `toilet_level1_demolish_work`.
fn toilet_after_demolish(level: u8, progress: i32, cfg: &Config) -> (Option<Object>, bool) {
    let mut level = level;
    let mut progress = progress - cfg.build.toilet_demolish_per_tick as i32;
    while progress < 0 && level > 1 {
        let old_level = level;
        level -= 1;
        progress += cfg.build.upgrade_work[(old_level - 2) as usize] as i32;
    }
    if level == 1 && progress <= -(cfg.build.toilet_level1_demolish_work as i32) {
        (None, true)
    } else {
        (Some(Object::Toilet { level, progress }), false)
    }
}

#[allow(clippy::too_many_arguments)]
fn door_tick(
    world: &mut WorldState,
    log: &mut EventLog,
    agent_id: AgentId,
    session: SessionId,
    nick: String,
    pos: Pos,
    action: &Action,
) {
    let Action::Door { target, open, .. } = action else {
        return;
    };
    if let Err(reason) = validate_door(world, agent_id, *target, *open) {
        end_action(
            world,
            log,
            agent_id,
            session,
            nick,
            pos,
            None,
            ActionOutcome::Failed { reason },
            action,
        );
        return;
    }
    world.set_object(*target, Some(Object::Door { open: *open }));
    log.push(EventKind::ObjectChanged {
        session: Some(session),
        agent: Some(agent_id),
        nick: Some(nick.clone()),
        pos: *target,
        object: Some(Object::Door { open: *open }),
        cause: if *open {
            ObjectCause::DoorOpened
        } else {
            ObjectCause::DoorClosed
        },
    });
    end_action(
        world,
        log,
        agent_id,
        session,
        nick,
        pos,
        None,
        ActionOutcome::Completed,
        action,
    );
}

/// A closed door with nobody on an adjacent toilet cell opens by itself at the
/// end of the tick. Standing in the doorway does not keep it closed.
fn auto_open_doors(world: &mut WorldState, log: &mut EventLog) {
    let mut closed: Vec<Pos> = Vec::new();
    for y in 0..world.map.height() {
        for x in 0..world.map.width() {
            let pos = Pos::new(x, y);
            if world.object_at(pos).is_some_and(Object::is_closed_door) {
                closed.push(pos);
            }
        }
    }
    for pos in closed {
        let attended = Dir::ALL.iter().any(|dir| {
            let cell = pos.step(*dir);
            matches!(world.object_at(cell), Some(Object::Toilet { .. }))
                && world.agent_at(cell).is_some()
        });
        if attended {
            continue;
        }
        world.set_object(pos, Some(Object::Door { open: true }));
        log.push(EventKind::ObjectChanged {
            session: None,
            agent: None,
            nick: None,
            pos,
            object: Some(Object::Door { open: true }),
            cause: ObjectCause::AutoOpened,
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
    let Some(Action::Move {
        mut dirs,
        total,
        label,
        ..
    }) = agent.action.clone()
    else {
        return;
    };
    let Some(session) = world.session_of(agent_id).map(|s| s.id) else {
        return;
    };
    let nick = agent.nick.to_string();
    let action = Action::Move {
        dirs: dirs.clone(),
        total,
        label: label.clone(),
    };

    let Some(dir) = dirs.pop_front() else {
        end_action(
            world,
            log,
            agent_id,
            session,
            nick,
            pos,
            None,
            ActionOutcome::Completed,
            &action,
        );
        return;
    };

    let target = pos.step(dir);
    let object_blocker = if !world.map.in_bounds(target) {
        Some(Blocker::MapEdge)
    } else {
        world
            .object_at(target)
            .filter(|o| o.blocks_movement())
            .map(|object| match object {
                Object::Door { .. } => Blocker::ClosedDoor,
                Object::Site { .. } => Blocker::Site,
                _ => Blocker::Wall,
            })
    };
    if let Some(by) = object_blocker {
        end_action(
            world,
            log,
            agent_id,
            session,
            nick,
            pos,
            Some(dir),
            ActionOutcome::Blocked { by },
            &action,
        );
        return;
    }

    if let Some(other) = world.agent_at(target) {
        let other_id = other.id;
        let other_nick = other.nick.to_string();
        let other_session = world.session_of(other_id).map(|s| s.id);
        let stunned = other.stun_until > world.tick;
        if let (true, Some(other_session)) = (stunned, other_session) {
            // A stunned agent is shoved backwards into the mover's cell; the
            // mover still spends the step it just used.
            if let Some(other) = world.agents.get_mut(&other_id) {
                other.pos = Some(pos);
                other.action = None;
            }
            if let Some(me) = world.agents.get_mut(&agent_id) {
                me.pos = Some(target);
            }
            log.push(EventKind::AgentSwapped {
                session,
                agent: agent_id,
                nick: nick.clone(),
                other_session,
                other_agent: other_id,
                other_nick,
                from: pos,
                to: target,
                other_from: target,
                other_to: pos,
            });
            if dirs.is_empty() {
                end_action(
                    world,
                    log,
                    agent_id,
                    session,
                    nick,
                    target,
                    None,
                    ActionOutcome::Completed,
                    &action,
                );
            } else if let Some(me) = world.agents.get_mut(&agent_id) {
                me.action = Some(Action::Move { dirs, total, label });
            }
            return;
        }
        end_action(
            world,
            log,
            agent_id,
            session,
            nick,
            pos,
            Some(dir),
            ActionOutcome::Blocked {
                by: Blocker::Agent { nick: other_nick },
            },
            &action,
        );
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
        end_action(
            world,
            log,
            agent_id,
            session,
            nick,
            target,
            None,
            ActionOutcome::Completed,
            &action,
        );
    } else if let Some(agent) = world.agents.get_mut(&agent_id) {
        agent.action = Some(Action::Move { dirs, total, label });
    }
}

/// Clears the agent's action and records how it ended.
#[allow(clippy::too_many_arguments)]
fn end_action(
    world: &mut WorldState,
    log: &mut EventLog,
    agent_id: AgentId,
    session: SessionId,
    nick: String,
    at: Pos,
    dir: Option<Dir>,
    outcome: ActionOutcome,
    action: &Action,
) {
    if let Some(agent) = world.agents.get_mut(&agent_id) {
        agent.action = None;
    }
    log.push(EventKind::ActionFinished {
        session,
        agent: agent_id,
        nick,
        at,
        dir,
        action: action.clone(),
        outcome,
    });
}

/// One tick of use for every agent still holding a `use` action, in the tick's
/// settlement order. The rules are re-checked against the current world: a
/// toilet that lost a wall, gained an open door or went back under construction
/// interrupts the use instead of advancing it.
fn progress_uses(world: &mut WorldState, log: &mut EventLog, order: &[AgentId], cfg: &Config) {
    for agent_id in order {
        let Some(agent) = world.agents.get(agent_id) else {
            continue;
        };
        if !matches!(agent.action, Some(Action::Use { .. })) {
            continue;
        }
        let Some(pos) = agent.pos else {
            continue;
        };
        let nick = agent.nick.to_string();
        let Some(session_id) = world.session_of(*agent_id).map(|entry| entry.id) else {
            continue;
        };
        let tick = world.tick;
        let use_ticks = match world.sessions.get(&session_id).and_then(|entry| entry.need) {
            Some(Need::Urine) => cfg.need.urine_use_ticks,
            Some(Need::Feces) => cfg.need.feces_use_ticks,
            None => continue,
        };
        match validate_use(world, *agent_id, cfg) {
            Ok(_) => {
                let level = match world.object_at(pos) {
                    Some(Object::Toilet { level, .. }) => level,
                    _ => continue,
                };
                let ticks_done = {
                    let Some(entry) = world.sessions.get_mut(&session_id) else {
                        continue;
                    };
                    entry.use_ticks_done += 1;
                    entry.use_levels.push(level);
                    entry.use_ticks_done
                };
                log.push(EventKind::UseProgressed {
                    session: session_id,
                    agent: *agent_id,
                    nick: nick.clone(),
                    pos,
                    level,
                    ticks_done,
                    use_ticks,
                });
                if ticks_done < use_ticks {
                    continue;
                }
                let score = match world.sessions.get(&session_id) {
                    Some(entry) => session_score(entry, cfg, tick),
                    None => continue,
                };
                let linger_until = tick + u64::from(cfg.need.linger_ticks);
                if let Some(entry) = world.sessions.get_mut(&session_id) {
                    entry.score = score;
                    entry.outcome = Some(SessionOutcome::Success);
                    entry.linger_until = Some(linger_until);
                }
                if let Some(agent) = world.agents.get_mut(agent_id) {
                    agent.action = None;
                }
                log.push(EventKind::UseSucceeded {
                    session: session_id,
                    agent: *agent_id,
                    nick,
                    pos,
                    score,
                    success_tick: tick,
                    linger_until,
                });
            }
            Err(reason) => {
                let Some(deadline) = world.sessions.get(&session_id).map(|entry| entry.deadline)
                else {
                    continue;
                };
                let recovery = recovery_deadline(tick, deadline, cfg);
                if let Some(entry) = world.sessions.get_mut(&session_id) {
                    entry.recovery_deadline = Some(recovery);
                }
                if let Some(agent) = world.agents.get_mut(agent_id) {
                    agent.action = None;
                }
                log.push(EventKind::UseInterrupted {
                    session: session_id,
                    agent: *agent_id,
                    nick,
                    pos: Some(pos),
                    reason,
                    recovery_deadline: recovery,
                });
            }
        }
    }
}

/// Deadline first, then the recovery window. A session that misses either ends
/// on the spot and leaves the world.
fn expire_sessions(world: &mut WorldState, log: &mut EventLog) {
    let tick = world.tick;
    let candidates: Vec<SessionId> = world
        .sessions
        .values()
        .filter(|entry| entry.status == SessionStatus::Inside && entry.outcome.is_none())
        .map(|entry| entry.id)
        .collect();
    for session_id in candidates {
        let Some(entry) = world.sessions.get(&session_id) else {
            continue;
        };
        let agent_id = entry.agent;
        let deadline_hit = entry.need.is_some() && tick >= entry.deadline;
        let using = matches!(
            world
                .agents
                .get(&agent_id)
                .and_then(|agent| agent.action.as_ref()),
            Some(Action::Use { .. })
        );
        let recovery_hit = !using && entry.recovery_deadline.is_some_and(|at| tick >= at);
        let outcome = if deadline_hit {
            SessionOutcome::FailedDeadline
        } else if recovery_hit {
            SessionOutcome::FailedRecovery
        } else {
            continue;
        };
        let score = entry.score;
        let pos = world.agents.get(&agent_id).and_then(|agent| agent.pos);
        let nick = world
            .agents
            .get(&agent_id)
            .map(|agent| agent.nick.to_string())
            .unwrap_or_default();
        log.push(EventKind::UseFailed {
            session: session_id,
            agent: agent_id,
            nick: nick.clone(),
            pos,
            outcome,
        });
        log.push(EventKind::SessionEnded {
            session: session_id,
            agent: agent_id,
            nick,
            pos,
            outcome,
            score,
        });
        remove_session(world, session_id);
    }
}

/// One warning per session, in its last `deadline_warning_ticks` ticks.
fn warn_deadlines(world: &mut WorldState, log: &mut EventLog, cfg: &Config) {
    let tick = world.tick;
    let ids: Vec<SessionId> = world.sessions.keys().copied().collect();
    for session_id in ids {
        let Some(entry) = world.sessions.get(&session_id) else {
            continue;
        };
        if entry.need.is_none() || entry.outcome.is_some() || entry.warned_deadline {
            continue;
        }
        let deadline = entry.deadline;
        let agent_id = entry.agent;
        let remaining = deadline.saturating_sub(tick);
        if remaining == 0 || remaining > u64::from(cfg.need.deadline_warning_ticks) {
            continue;
        }
        let nick = world
            .agents
            .get(&agent_id)
            .map(|agent| agent.nick.to_string())
            .unwrap_or_default();
        if let Some(entry) = world.sessions.get_mut(&session_id) {
            entry.warned_deadline = true;
        }
        log.push(EventKind::DeadlineWarning {
            session: session_id,
            agent: agent_id,
            nick,
            remaining: remaining as u32,
        });
    }
}

/// A successful session stays a while, then leaves with its score.
fn finish_lingering(world: &mut WorldState, log: &mut EventLog) {
    let tick = world.tick;
    let candidates: Vec<SessionId> = world
        .sessions
        .values()
        .filter(|entry| {
            entry.outcome == Some(SessionOutcome::Success)
                && entry.linger_until.is_some_and(|until| until <= tick)
        })
        .map(|entry| entry.id)
        .collect();
    for session_id in candidates {
        let Some(entry) = world.sessions.get(&session_id) else {
            continue;
        };
        let agent_id = entry.agent;
        let score = entry.score;
        let pos = world.agents.get(&agent_id).and_then(|agent| agent.pos);
        let nick = world
            .agents
            .get(&agent_id)
            .map(|agent| agent.nick.to_string())
            .unwrap_or_default();
        log.push(EventKind::SessionEnded {
            session: session_id,
            agent: agent_id,
            nick,
            pos,
            outcome: SessionOutcome::Success,
            score,
        });
        remove_session(world, session_id);
    }
}

fn remove_session(world: &mut WorldState, session_id: SessionId) {
    if let Some(agent_id) = world.sessions.remove(&session_id).map(|entry| entry.agent) {
        world.agents.remove(&agent_id);
    }
    world.entry_queue.retain(|queued| *queued != session_id);
}

/// Design §4.8: a session ends early on request (`loo leave`), keeping whatever
/// score it had. A session that already succeeded still ends as a success.
pub fn leave(
    world: &WorldState,
    agent: AgentId,
    start_seq: u32,
    seed: u64,
    _cfg: &Config,
) -> Result<(WorldState, SessionOutcome, u32, Vec<Event>), String> {
    let Some(entry) = world.session_of(agent) else {
        return Err("you are not in the world".to_string());
    };
    let session_id = entry.id;
    let outcome = if entry.outcome == Some(SessionOutcome::Success) {
        SessionOutcome::Success
    } else {
        SessionOutcome::Left
    };
    let score = entry.score;
    let nick = world
        .agents
        .get(&agent)
        .map(|agent| agent.nick.to_string())
        .unwrap_or_default();
    let pos = world.agents.get(&agent).and_then(|agent| agent.pos);

    let mut next = world.clone();
    let mut log = EventLog::starting_at(next.tick, seed, start_seq + 1);
    log.push(EventKind::SessionEnded {
        session: session_id,
        agent,
        nick,
        pos,
        outcome,
        score,
    });
    remove_session(&mut next, session_id);
    Ok((next, outcome, score, log.into_vec()))
}
