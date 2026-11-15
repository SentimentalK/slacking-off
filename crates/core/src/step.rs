//! The rules engine: `join` and `step`.
//!
//! `step(state, intents, seed) -> (state, events)` is the whole contract: pure,
//! deterministic, no clock, no network, no disk, no global RNG.

use crate::config::Config;
use crate::event::{ActionOutcome, Blocker, Event, EventKind, EventLog, ObjectCause};
use crate::rng::{shuffle, Rng};
use crate::rules::{
    agent_level, session_score, validate_attack, validate_build, validate_defend,
    validate_demolish, validate_door, validate_downgrade, validate_upgrade, validate_use,
};
use crate::state::{
    is_stunned, toilet_corners, Action, Agent, Object, QueueLane, Session, SessionStatus, SiteKind,
    WorldState,
};
use loo_proto::{AgentId, Dir, Need, Nick, Pos, SessionId, SessionOutcome};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A join request as the server understands it: one persistent agent id, one
/// nickname, one session id per entry.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct JoinCommand {
    pub agent: AgentId,
    pub nick: Nick,
    pub session: SessionId,
    /// Cumulative score the agent brings from earlier sessions; it picks the
    /// agent's level at join time.
    #[serde(default)]
    pub score_total: u32,
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

/// `IntentKind::Defend` shields one adjacent cell for the tick it is settled in;
/// `IntentKind::Attack` commits a windup against the agent on `target`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum IntentKind {
    Move { dirs: Vec<Dir>, label: String },
    Build { kind: SiteKind, target: Pos },
    Demolish { target: Pos },
    Door { target: Pos, open: bool },
    Use { target: Pos },
    Upgrade { target: Pos },
    Downgrade { target: Pos },
    Defend { target: Pos },
    Attack { target: Pos },
    Cancel,
}

/// Places a joining agent at the entrance, or on the last free queue cell.
///
/// The entrance takes one agent at a time: when it is occupied (or the world is
/// full) the session waits on a physical queue cell, primary lane first, then
/// the overflow lane. A world with no free queue cell (or a capacity of zero)
/// rejects the join with `QueueFull`.
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
        next.agents
            .insert(cmd.agent, new_agent(cmd, cfg, Some(next.entrance)));
        let mut session = Session::fresh(
            cmd.session,
            cmd.agent,
            SessionStatus::Inside,
            Default::default(),
        );
        session.last_active_tick = next.tick;
        next.sessions.insert(cmd.session, session);
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
            score_total: cmd.score_total,
            inside: true,
            ahead: 0,
        });
        if let Some(kind) = assign_need(&mut next, cmd.session, cfg, seed) {
            log.push(kind);
        }
        return Ok((next, JoinOutcome::Inside { at }, log.into_vec()));
    }

    let capacity = cfg.session.queue_capacity;
    let waiting_count = next
        .sessions
        .values()
        .filter(|session| session.status == SessionStatus::Waiting)
        .count();
    if waiting_count >= capacity {
        return Err(queue_full(capacity));
    }
    // The first free cell in global queue order; `ahead` counts the waiters
    // standing between the queue head and that cell.
    let mut ahead = 0;
    let mut chosen = None;
    for cell in next
        .queue_primary
        .iter()
        .chain(next.queue_overflow.iter())
        .take(capacity)
    {
        if next.agent_at(*cell).is_some() {
            ahead += 1;
        } else {
            chosen = Some(*cell);
            break;
        }
    }
    let Some(cell) = chosen else {
        return Err(queue_full(capacity));
    };

    next.agents
        .insert(cmd.agent, new_agent(cmd, cfg, Some(cell)));
    let mut session = Session::fresh(
        cmd.session,
        cmd.agent,
        SessionStatus::Waiting,
        Default::default(),
    );
    session.last_active_tick = next.tick;
    next.sessions.insert(cmd.session, session);
    next.entry_queue.push_back(cmd.session);
    log.push(EventKind::Joined {
        session: cmd.session,
        agent: cmd.agent,
        nick: cmd.nick.to_string(),
        at: Some(cell),
        score_total: cmd.score_total,
        inside: false,
        ahead,
    });
    Ok((next, JoinOutcome::Waiting { ahead }, log.into_vec()))
}

fn queue_full(capacity: usize) -> JoinReject {
    JoinReject {
        kind: JoinRejectKind::QueueFull,
        message: format!("queue is full ({capacity} waiting); try again later"),
    }
}

fn new_agent(cmd: &JoinCommand, cfg: &Config, pos: Option<Pos>) -> Agent {
    Agent {
        id: cmd.agent,
        nick: cmd.nick.clone(),
        pos,
        action: None,
        stun_until: 0,
        immunity_until: 0,
        attack_cooldown_until: 0,
        defend_cooldown_until: 0,
        defending: None,
        defend_until: 0,
        score_total: cmd.score_total,
        level: agent_level(cmd.score_total, cfg),
    }
}

/// Settles one tick: defences whose window ended lapse, the queue moves up, then every
/// agent in seeded order applies its last intent and advances one step of its
/// final action.
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

    // Last tick's defence lapses before anything else settles.
    expire_defends(&mut next, &mut log);

    // Queue housekeeping: abandon idle waiters, let at most one in, then close
    // the gap the admission left behind. All of it happens before anyone acts,
    // and every position change is an event, so a replay is exact.
    cleanup_idle_queue(&mut next, &mut log, cfg);
    admit_one_from_queue(&mut next, &mut log, cfg, seed);
    compress_primary(&mut next, &mut log);

    let mut order: Vec<AgentId> = next
        .agents
        .iter()
        .filter(|(_, a)| a.pos.is_some())
        .map(|(id, _)| *id)
        .collect();
    shuffle(&mut order, seed);
    // Defences are a whole-window posture: they must be in place before any
    // agent settles, so an attack or a demolition sees them whatever the
    // shuffle order.
    collect_defends(&mut next, &mut log, &order, intents, cfg);
    let mut toilet_work: BTreeMap<Pos, Vec<ToiletWorker>> = BTreeMap::new();
    for agent in &order {
        apply_intents(&mut next, &mut log, *agent, intents, cfg);
        advance_action(&mut next, &mut log, *agent, cfg, &mut toilet_work);
    }

    apply_toilet_work(&mut next, &mut log, toilet_work, cfg);
    progress_uses(&mut next, &mut log, &order, cfg);
    expire_sessions(&mut next, &mut log);
    warn_deadlines(&mut next, &mut log, cfg);
    finish_lingering(&mut next, &mut log);
    auto_open_doors(&mut next, &mut log);

    mark_all_seen(&mut next, cfg);
    // `entry_queue` is only a cache for readers like the projection; the
    // physical queue cells decide the order.
    next.rebuild_entry_queue();

    (next, log.into_vec())
}

/// Settles every defence intent of this tick before any agent acts, so a
/// defence is in force from this tick whatever the shuffle order. Only an
/// agent whose *last* intent is a defence defends; that is also the only place
/// a defence is rejected.
///
/// A defence is a posture, not an action: it cancels whatever the agent was
/// doing (except a `use`, which is only paused) and stores itself on the agent.
fn collect_defends(
    world: &mut WorldState,
    log: &mut EventLog,
    order: &[AgentId],
    intents: &[Intent],
    cfg: &Config,
) {
    for agent_id in order {
        // Only the agent's last intent counts (design §3); a defence followed
        // by another command is not a defence at all.
        let Some(target) = intents
            .iter()
            .rfind(|intent| intent.agent == *agent_id)
            .and_then(|intent| match &intent.kind {
                IntentKind::Defend { target } => Some(*target),
                _ => None,
            })
        else {
            continue;
        };
        let Some(session) = world.session_of(*agent_id).map(|entry| entry.id) else {
            continue;
        };
        let Some(pos) = world.agents.get(agent_id).and_then(|agent| agent.pos) else {
            continue;
        };
        let Some(nick) = world.agents.get(agent_id).map(|a| a.nick.to_string()) else {
            continue;
        };
        let stun_until = world
            .agents
            .get(agent_id)
            .map_or(0, |agent| agent.stun_until);
        if world
            .agents
            .get(agent_id)
            .is_some_and(|agent| is_stunned(agent, world.tick))
        {
            log.push(EventKind::ActionRejected {
                session,
                agent: *agent_id,
                nick,
                at: target,
                action: "defend".to_string(),
                reason: format!("you are stunned until tick {stun_until}; you cannot defend"),
            });
            continue;
        }
        if let Err(reason) = validate_defend(world, *agent_id, target) {
            log.push(EventKind::ActionRejected {
                session,
                agent: *agent_id,
                nick,
                at: target,
                action: "defend".to_string(),
                reason,
            });
            continue;
        }
        let cooldown_until = world.tick + 1 + u64::from(cfg.combat.defend_cooldown_ticks);
        match world.agents.get(agent_id).and_then(|a| a.action.clone()) {
            // A use is paused for this tick, never interrupted.
            Some(Action::Use { .. }) => {}
            Some(Action::Attack {
                target_agent: victim,
                target_pos: victim_pos,
                ..
            }) => {
                log.push(EventKind::AttackCancelled {
                    session,
                    agent: *agent_id,
                    nick: nick.clone(),
                    target_agent: victim,
                    target_nick: world
                        .agents
                        .get(&victim)
                        .map(|agent| agent.nick.to_string())
                        .unwrap_or_default(),
                    at: victim_pos,
                    reason: "replaced by defend".to_string(),
                });
                end_attack(world, *agent_id);
            }
            Some(other) => end_action(
                world,
                log,
                *agent_id,
                session,
                nick.clone(),
                pos,
                None,
                ActionOutcome::Cancelled,
                &other,
            ),
            None => {}
        }
        let until = world.tick + u64::from(cfg.combat.defend_ticks);
        if let Some(agent) = world.agents.get_mut(agent_id) {
            agent.defending = Some(target);
            agent.defend_until = until;
            agent.defend_cooldown_until = cooldown_until;
        }
        log.push(EventKind::DefendStarted {
            session,
            agent: *agent_id,
            nick,
            target,
            until,
            cooldown_until,
        });
    }
}

/// A defence covers `defend_ticks` ticks, starting with the tick it settled in.
/// It is cleared at the start of the first tick at or after `defend_until`, so
/// a snapshot can carry it and `loo status` shows it until the window closes.
fn expire_defends(world: &mut WorldState, log: &mut EventLog) {
    for agent in world.agents.values_mut() {
        if agent.defending.is_some() && world.tick >= agent.defend_until {
            agent.defending = None;
            agent.defend_until = 0;
            log.push(EventKind::DefendEnded {
                agent: agent.id,
                nick: agent.nick.to_string(),
            });
        }
    }
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

/// Abandons queued sessions that have not sent a command for the configured
/// idle time. Several may expire in one tick, in queue order. Each one ends as
/// `Abandoned` at the cell it occupied, and the primary lane is compressed
/// afterwards.
fn cleanup_idle_queue(world: &mut WorldState, log: &mut EventLog, cfg: &Config) {
    let idle = cfg.queue_idle_ticks();
    let tick = world.tick;
    let expired: Vec<SessionId> = world
        .waiting_sessions()
        .into_iter()
        .filter(|session_id| {
            world
                .sessions
                .get(session_id)
                .is_some_and(|session| tick.saturating_sub(session.last_active_tick) >= idle)
        })
        .collect();
    for session_id in expired {
        let Some(session) = world.sessions.get(&session_id) else {
            continue;
        };
        let agent_id = session.agent;
        let score = session.score;
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
            outcome: SessionOutcome::Abandoned,
            score,
        });
        remove_session(world, session_id);
    }
}

/// Lets at most one queued session in per tick. The candidate is the head of
/// the global queue: primary lane first, overflow only once the primary lane is
/// empty. A stunned head keeps the queue still.
fn admit_one_from_queue(world: &mut WorldState, log: &mut EventLog, cfg: &Config, seed: u64) {
    if world.inside_count() >= cfg.max_on_field {
        return;
    }
    let entrance = world.entrance;
    if world.agent_at(entrance).is_some() {
        return;
    }
    let Some(&session_id) = world.waiting_sessions().first() else {
        return;
    };
    let Some(session) = world.sessions.get(&session_id) else {
        return;
    };
    let agent_id = session.agent;
    let Some(agent) = world.agents.get(&agent_id) else {
        return;
    };
    let Some(from) = agent.pos else {
        return;
    };
    let lane = world.queue_lane(from);
    let primary_waiters = world.waiting_sessions().iter().any(|queued| {
        world
            .sessions
            .get(queued)
            .and_then(|session| world.agents.get(&session.agent))
            .and_then(|agent| agent.pos)
            .and_then(|pos| world.queue_lane(pos))
            == Some(QueueLane::Primary)
    });
    match lane {
        Some(QueueLane::Primary) => {}
        Some(QueueLane::Overflow) => {
            if primary_waiters {
                return;
            }
        }
        None => return,
    }
    if is_stunned(agent, world.tick) {
        return;
    }
    let nick = agent.nick.to_string();
    if let Some(session) = world.sessions.get_mut(&session_id) {
        session.status = SessionStatus::Inside;
    }
    if let Some(agent) = world.agents.get_mut(&agent_id) {
        agent.pos = Some(entrance);
    }
    log.push(EventKind::EnteredWorld {
        session: session_id,
        agent: agent_id,
        nick,
        at: entrance,
        from: Some(from),
    });
    if let Some(kind) = assign_need(world, session_id, cfg, seed) {
        log.push(kind);
    }
}

/// Packs the primary lane: every waiter still on it lands on cells
/// `0..k-1` in its current order, and every move is a `QueueAdvanced` event.
/// The overflow lane is never compressed.
fn compress_primary(world: &mut WorldState, log: &mut EventLog) {
    let mut index = 0;
    for session_id in world.waiting_sessions() {
        let Some(session) = world.sessions.get(&session_id) else {
            continue;
        };
        let agent_id = session.agent;
        let Some(agent) = world.agents.get(&agent_id) else {
            continue;
        };
        let Some(from) = agent.pos else {
            continue;
        };
        if world.queue_lane(from) != Some(QueueLane::Primary) {
            continue;
        }
        let Some(&to) = world.queue_primary.get(index) else {
            break;
        };
        index += 1;
        if from == to {
            continue;
        }
        let nick = agent.nick.to_string();
        if let Some(agent) = world.agents.get_mut(&agent_id) {
            agent.pos = Some(to);
        }
        log.push(EventKind::QueueAdvanced {
            session: session_id,
            agent: agent_id,
            nick,
            from,
            to,
        });
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
    entry.deadline_span = deadline - world.tick;
    Some(EventKind::NeedAssigned {
        session,
        agent,
        nick,
        need,
        deadline,
    })
}

/// Turns the agent's last intent of the tick into its final action. A second
/// intent in the same window replaces the first (design §3), so only the last
/// one is read. A cancel with no running action is a no-op; cancel with one ends
/// it as `Cancelled`.
///
/// A stunned agent keeps whatever it already had: its intent is answered with
/// `ActionRejected` and changes nothing.
///
/// A `use` that cannot start ends immediately as `ActionFinished { Failed }`
/// and puts the agent back to no action, so it never enters the use phase.
///
/// `Defend` never reaches this function: `collect_defends` already settled it,
/// rejection included.
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
    let stun_until = world.agents.get(&agent_id).map_or(0, |a| a.stun_until);
    let stunned = world
        .agents
        .get(&agent_id)
        .is_some_and(|agent| is_stunned(agent, world.tick));
    // Design §3: one intent per agent per window; a later one replaces the
    // earlier. The agent's last submitted intent is the only one that counts.
    let Some(intent) = intents.iter().rfind(|intent| intent.agent == agent_id) else {
        return;
    };
    // A defence is a whole-window posture, settled by `collect_defends` before
    // anyone acts — including its own rejection. Skipping it here keeps a
    // stunned defender from being rejected twice.
    if matches!(intent.kind, IntentKind::Defend { .. }) {
        return;
    }
    if stunned && !matches!(intent.kind, IntentKind::Cancel) {
        log.push(EventKind::ActionRejected {
            session,
            agent: agent_id,
            nick,
            at: intent_target(&intent.kind).unwrap_or(pos),
            action: intent_action_name(&intent.kind).to_string(),
            reason: format!("you are stunned until tick {stun_until}; no action was taken"),
        });
        return;
    }
    // Outside the entrance only shoving and fighting make sense; everything
    // else needs the world's walls and objects.
    let waiting = world
        .sessions
        .get(&session)
        .is_some_and(|entry| entry.status == SessionStatus::Waiting);
    let allowed_in_queue = matches!(
        intent.kind,
        IntentKind::Move { .. }
            | IntentKind::Attack { .. }
            | IntentKind::Defend { .. }
            | IntentKind::Cancel
    );
    if waiting && !allowed_in_queue {
        log.push(EventKind::ActionRejected {
            session,
            agent: agent_id,
            nick,
            at: intent_target(&intent.kind).unwrap_or(pos),
            action: intent_action_name(&intent.kind).to_string(),
            reason: "排队中只能移动、攻击、防御或取消".to_string(),
        });
        return;
    }
    match &intent.kind {
        IntentKind::Cancel => {
            let Some(action) = world.agents.get(&agent_id).and_then(|a| a.action.clone()) else {
                return;
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
        // Handled by `collect_defends`; kept for an exhaustive match.
        IntentKind::Defend { .. } => {}
        IntentKind::Use { .. } => {
            start_use(world, log, agent_id, session, nick.clone(), pos, cfg);
        }
        IntentKind::Attack { target } => {
            start_attack(
                world,
                log,
                agent_id,
                session,
                nick.clone(),
                pos,
                *target,
                cfg,
            );
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

/// The cell an intent names, if it names one at all.
fn intent_target(kind: &IntentKind) -> Option<Pos> {
    match kind {
        IntentKind::Build { target, .. }
        | IntentKind::Demolish { target }
        | IntentKind::Door { target, .. }
        | IntentKind::Use { target }
        | IntentKind::Upgrade { target }
        | IntentKind::Downgrade { target }
        | IntentKind::Defend { target }
        | IntentKind::Attack { target } => Some(*target),
        IntentKind::Move { .. } | IntentKind::Cancel => None,
    }
}

/// The verb name used in `ActionRejected`.
fn intent_action_name(kind: &IntentKind) -> &'static str {
    match kind {
        IntentKind::Move { .. } => "move",
        IntentKind::Build { .. } => "build",
        IntentKind::Demolish { .. } => "demolish",
        IntentKind::Door { .. } => "door",
        IntentKind::Use { .. } => "use",
        IntentKind::Upgrade { .. } => "upgrade",
        IntentKind::Downgrade { .. } => "downgrade",
        IntentKind::Defend { .. } => "defend",
        IntentKind::Attack { .. } => "attack",
        IntentKind::Cancel => "cancel",
    }
}

/// Commits an attack: an action that does nothing until `land_tick`, plus the
/// cooldown that starts now and runs past the landing tick.
#[allow(clippy::too_many_arguments)]
fn start_attack(
    world: &mut WorldState,
    log: &mut EventLog,
    agent_id: AgentId,
    session: SessionId,
    nick: String,
    pos: Pos,
    target: Pos,
    cfg: &Config,
) {
    let target_agent = match validate_attack(world, agent_id, target, cfg) {
        Ok(target_agent) => target_agent,
        Err(reason) => {
            log.push(EventKind::ActionRejected {
                session,
                agent: agent_id,
                nick,
                at: target,
                action: "attack".to_string(),
                reason,
            });
            return;
        }
    };
    let Some(target_session) = world.session_of(target_agent).map(|entry| entry.id) else {
        log.push(EventKind::ActionRejected {
            session,
            agent: agent_id,
            nick,
            at: target,
            action: "attack".to_string(),
            reason: "there is no unstunned agent next to you in that direction".to_string(),
        });
        return;
    };
    let target_nick = world
        .agents
        .get(&target_agent)
        .map(|agent| agent.nick.to_string())
        .unwrap_or_default();
    // Design §5: `windup_ticks` delay, then the landing tick, then the rest of
    // the cooldown; the timer starts when the attack is committed.
    let cooldown_until = world.tick
        + 1
        + u64::from(cfg.combat.windup_ticks)
        + u64::from(cfg.combat.attack_cooldown_ticks);
    let land_tick = world.tick + u64::from(cfg.combat.windup_ticks);
    let action = Action::Attack {
        target_agent,
        target_pos: target,
        land_tick,
        label: format!("attack the agent at {target}"),
    };
    let old = world.agents.get(&agent_id).and_then(|a| a.action.clone());
    if matches!(old, Some(Action::Use { .. })) {
        interrupt_use(
            world,
            log,
            agent_id,
            session,
            nick.clone(),
            Some(pos),
            format!("replaced by {}", action.label()),
            cfg,
        );
    }
    match old {
        Some(from) => log.push(EventKind::ActionReplaced {
            session,
            agent: agent_id,
            nick: nick.clone(),
            from,
            to: action.clone(),
        }),
        None => log.push(EventKind::ActionStarted {
            session,
            agent: agent_id,
            nick: nick.clone(),
            action: action.clone(),
        }),
    }
    if let Some(agent) = world.agents.get_mut(&agent_id) {
        agent.action = Some(action);
        agent.attack_cooldown_until = cooldown_until;
    }
    log.push(EventKind::AttackStarted {
        session,
        agent: agent_id,
        nick,
        target_session,
        target_agent,
        target_nick,
        at: target,
        land_tick,
        cooldown_until,
    });
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
        IntentKind::Upgrade { target } => Action::Upgrade {
            target: *target,
            label: format!("upgrade the toilet at {target}"),
        },
        IntentKind::Downgrade { target } => Action::Downgrade {
            target: *target,
            label: format!("downgrade the toilet at {target}"),
        },
        IntentKind::Cancel => unreachable!("cancel never creates an action"),
        IntentKind::Attack { .. } | IntentKind::Defend { .. } => {
            unreachable!("combat intents never go through the generic action builder")
        }
    }
}

fn kind_name(kind: SiteKind) -> &'static str {
    match kind {
        SiteKind::Wall => "wall",
        SiteKind::Door => "door",
        SiteKind::Toilet => "toilet",
    }
}

/// One agent's contribution to a toilet's work this tick. Toilets settle as a
/// net change per cell, never per worker and never in shuffle order.
struct ToiletWorker {
    agent: AgentId,
    session: SessionId,
    nick: String,
    up: bool,
    /// The level the agent saw when it started this tick.
    start_level: u8,
}

/// Advances whichever action the agent currently holds by one tick.
fn advance_action(
    world: &mut WorldState,
    log: &mut EventLog,
    agent_id: AgentId,
    cfg: &Config,
    toilet_work: &mut BTreeMap<Pos, Vec<ToiletWorker>>,
) {
    let Some(agent) = world.agents.get(&agent_id) else {
        return;
    };
    // A stunned agent does not act at all; the stun itself already cleared or
    // at least froze whatever it was doing.
    if is_stunned(agent, world.tick) {
        return;
    }
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
        Action::Attack { .. } => {
            land_attack(world, log, agent_id, session, nick, pos, &action, cfg)
        }
        // `Upgrade`/`Downgrade` only register work; it settles once for the
        // whole tick in `apply_toilet_work`.
        Action::Upgrade { .. } | Action::Downgrade { .. } => collect_toilet_work(
            world,
            log,
            agent_id,
            session,
            nick,
            pos,
            &action,
            toilet_work,
            cfg,
        ),
        // `Use` advances in `progress_uses`, after every action has settled.
        Action::Use { .. } => {}
    }
}

/// The agent shielding `pos` while its window is active. `BTreeMap` order makes the lowest
/// `AgentId` win when two agents shield the same cell.
fn defender_at(world: &WorldState, pos: Pos) -> Option<AgentId> {
    world
        .agents
        .values()
        .find(|agent| agent.defending == Some(pos))
        .map(|agent| agent.id)
}

/// Clears the attacker's action without ending it as a finished action; the
/// attack's own event already says how it ended.
fn end_attack(world: &mut WorldState, agent_id: AgentId) {
    if let Some(agent) = world.agents.get_mut(&agent_id) {
        agent.action = None;
    }
}

/// Resolves an attack on its landing tick: a miss when the target left or moved
/// out of reach, a block when its cell is defended, a miss while it is immune,
/// and otherwise the hit itself.
#[allow(clippy::too_many_arguments)]
fn land_attack(
    world: &mut WorldState,
    log: &mut EventLog,
    agent_id: AgentId,
    session: SessionId,
    nick: String,
    pos: Pos,
    action: &Action,
    cfg: &Config,
) {
    let Action::Attack {
        target_agent,
        target_pos,
        land_tick,
        ..
    } = action
    else {
        return;
    };
    let target_agent = *target_agent;
    let target_pos = *target_pos;
    let target_now = world.agents.get(&target_agent);
    let target_label = target_now
        .map(|agent| agent.nick.to_string())
        .unwrap_or_else(|| format!("agent {target_agent}"));
    if world.tick < *land_tick {
        return;
    }
    if world.tick > *land_tick {
        // The windup was frozen by a stun that ended late; a hit must not fire
        // after its landing tick.
        log.push(EventKind::AttackCancelled {
            session,
            agent: agent_id,
            nick,
            target_agent,
            target_nick: target_label,
            at: target_pos,
            reason: "the windup was lost while you were stunned".to_string(),
        });
        end_attack(world, agent_id);
        return;
    }
    let miss = |log: &mut EventLog, reason: &str, target_nick: &str| {
        log.push(EventKind::AttackMissed {
            session,
            agent: agent_id,
            nick: nick.clone(),
            target_agent,
            target_nick: target_nick.to_string(),
            at: target_pos,
            reason: reason.to_string(),
        });
    };
    let Some(now) = target_now.and_then(|agent| agent.pos) else {
        miss(log, "target left the world", &target_label);
        end_attack(world, agent_id);
        return;
    };
    if pos.manhattan(now) != 1 {
        miss(log, "target moved out of reach", &target_label);
        end_attack(world, agent_id);
        return;
    }
    let Some(target_session) = world.session_of(target_agent).map(|entry| entry.id) else {
        miss(log, "target left the world", &target_label);
        end_attack(world, agent_id);
        return;
    };
    if let Some(defender) = defender_at(world, now) {
        let stun_until = world.tick + 1 + u64::from(cfg.combat.stun_ticks);
        log.push(EventKind::AttackBlocked {
            session,
            agent: agent_id,
            nick: nick.clone(),
            target_session,
            target_agent,
            target_nick: target_label.clone(),
            at: now,
            defender_session: world.session_of(defender).map_or(0, |entry| entry.id),
            defender_agent: defender,
            defender_nick: world
                .agents
                .get(&defender)
                .map(|agent| agent.nick.to_string())
                .unwrap_or_default(),
            stun_until,
        });
        if let Some(me) = world.agents.get_mut(&agent_id) {
            me.stun_until = stun_until;
        }
        log.push(EventKind::Stunned {
            session,
            agent: agent_id,
            nick: nick.clone(),
            until: stun_until,
            reason: "attack was blocked by a defender".to_string(),
        });
        end_attack(world, agent_id);
        return;
    }
    let immune_until = world
        .agents
        .get(&target_agent)
        .map_or(0, |agent| agent.immunity_until);
    if world.tick < immune_until {
        miss(log, "target is immune", &target_label);
        end_attack(world, agent_id);
        return;
    }

    let penalty = cfg.combat.penalty_ticks;
    let stun_until = world.tick + 1 + u64::from(cfg.combat.stun_ticks);
    let immunity_until = world.tick + 1 + u64::from(cfg.combat.immunity_ticks);
    // Being hit ends whatever the target was doing; a use keeps its progress
    // and gets the usual recovery window.
    match world
        .agents
        .get(&target_agent)
        .and_then(|a| a.action.clone())
    {
        Some(Action::Use { .. }) => interrupt_use(
            world,
            log,
            target_agent,
            target_session,
            target_label.clone(),
            Some(now),
            "hit by an attack".to_string(),
            cfg,
        ),
        Some(Action::Attack {
            target_agent: victim,
            target_pos: victim_pos,
            ..
        }) => {
            log.push(EventKind::AttackCancelled {
                session: target_session,
                agent: target_agent,
                nick: target_label.clone(),
                target_agent: victim,
                target_nick: world
                    .agents
                    .get(&victim)
                    .map(|agent| agent.nick.to_string())
                    .unwrap_or_default(),
                at: victim_pos,
                reason: "stunned by an attack".to_string(),
            });
            end_attack(world, target_agent);
        }
        Some(other) => end_action(
            world,
            log,
            target_agent,
            target_session,
            target_label.clone(),
            now,
            None,
            ActionOutcome::Cancelled,
            &other,
        ),
        None => {}
    }
    let deadline = world
        .sessions
        .get(&target_session)
        .map_or(0, |entry| entry.deadline)
        .saturating_sub(u64::from(penalty));
    if let Some(entry) = world.sessions.get_mut(&target_session) {
        entry.deadline = deadline;
    }
    if let Some(target) = world.agents.get_mut(&target_agent) {
        target.stun_until = stun_until;
        target.immunity_until = immunity_until;
    }
    log.push(EventKind::AttackLanded {
        session,
        agent: agent_id,
        nick,
        target_session,
        target_agent,
        target_nick: target_label.clone(),
        at: now,
        penalty,
        deadline,
        stun_until,
        immunity_until,
    });
    log.push(EventKind::Stunned {
        session: target_session,
        agent: target_agent,
        nick: target_label,
        until: stun_until,
        reason: "hit by an attack".to_string(),
    });
    end_attack(world, agent_id);
}

/// Re-checks a toilet action against the live world and queues its contribution.
/// An action that no longer validates ends on the spot and adds no work.
#[allow(clippy::too_many_arguments)]
fn collect_toilet_work(
    world: &mut WorldState,
    log: &mut EventLog,
    agent_id: AgentId,
    session: SessionId,
    nick: String,
    pos: Pos,
    action: &Action,
    toilet_work: &mut BTreeMap<Pos, Vec<ToiletWorker>>,
    cfg: &Config,
) {
    let (target, up) = match action {
        Action::Upgrade { target, .. } => (*target, true),
        Action::Downgrade { target, .. } => (*target, false),
        _ => return,
    };
    let checked = if up {
        validate_upgrade(world, agent_id, target, cfg)
    } else {
        validate_downgrade(world, agent_id, target, cfg)
    };
    if let Err(reason) = checked {
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
    let Some(Object::Toilet { level, .. }) = world.object_at(target) else {
        // The toilet vanished between the check and the read; nothing to do.
        return;
    };
    toilet_work.entry(target).or_default().push(ToiletWorker {
        agent: agent_id,
        session,
        nick,
        up,
        start_level: level,
    });
}

/// Settles every toilet that had workers this tick. One net change per cell:
/// `+1` per upgrader and `-2` per downgrader, so a mixed group cannot climb and
/// fall at once and the result never depends on the shuffle order.
fn apply_toilet_work(
    world: &mut WorldState,
    log: &mut EventLog,
    toilet_work: BTreeMap<Pos, Vec<ToiletWorker>>,
    cfg: &Config,
) {
    for (pos, workers) in toilet_work {
        let Some(Object::Toilet {
            level: start_level,
            progress: start_progress,
        }) = world.object_at(pos)
        else {
            continue;
        };
        let ups = workers.iter().filter(|worker| worker.up).count() as i32;
        let downs = workers.len() as i32 - ups;
        let net = ups - downs * 2;
        let mut level = start_level;
        let mut progress = start_progress + net;
        if net > 0 {
            // Design §4.7: reaching the work total lifts the toilet one level
            // and the new level starts at zero; the excess never carries over.
            // One level per tick is enough: the largest net is +5 and the
            // smallest total is 6.
            if level < 5 && progress >= cfg.build.upgrade_work[usize::from(level) - 1] as i32 {
                level += 1;
                progress = 0;
            }
            if level == 5 {
                progress = 0;
            }
        } else if net < 0 {
            while progress < 0 && level > 1 {
                level -= 1;
                progress += cfg.build.upgrade_work[usize::from(level) - 1] as i32;
            }
            if level == 1 {
                progress = progress.max(0);
            }
        }
        if net != 0 && (level, progress) != (start_level, start_progress) {
            let object = Object::Toilet { level, progress };
            world.set_object(pos, Some(object));
            let first = &workers[0];
            log.push(EventKind::ObjectChanged {
                session: Some(first.session),
                agent: Some(first.agent),
                nick: Some(first.nick.clone()),
                pos,
                object: Some(object),
                cause: if net > 0 {
                    ObjectCause::Upgrade
                } else {
                    ObjectCause::Downgrade
                },
            });
        }
        for worker in &workers {
            // A downgrade is done once the toilet sits at level 1 with no
            // progress left, even when the level already dropped on an earlier
            // tick; an upgrade is done only on the tick it crosses a level.
            let wanted = if worker.up {
                level > worker.start_level
            } else {
                level <= worker.start_level
            };
            if progress != 0 || !wanted {
                continue;
            }
            let Some(running) = world
                .agents
                .get(&worker.agent)
                .and_then(|agent| agent.action.clone())
            else {
                continue;
            };
            let still_working = match &running {
                Action::Upgrade { target, .. } if worker.up => *target == pos,
                Action::Downgrade { target, .. } if !worker.up => *target == pos,
                _ => false,
            };
            if !still_working {
                continue;
            }
            let at = world
                .agents
                .get(&worker.agent)
                .and_then(|agent| agent.pos)
                .unwrap_or(pos);
            end_action(
                world,
                log,
                worker.agent,
                worker.session,
                worker.nick.clone(),
                at,
                None,
                ActionOutcome::Completed,
                &running,
            );
        }
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
    let starting_toilet = *kind == SiteKind::Toilet
        && !matches!(
            world.object_at(*target),
            Some(Object::Site {
                kind: SiteKind::Toilet,
                ..
            })
        );
    world.set_object(*target, Some(object));
    log.push(EventKind::ObjectChanged {
        session: Some(session),
        agent: Some(agent_id),
        nick: Some(nick.clone()),
        pos: *target,
        object: Some(object),
        cause: ObjectCause::Build { kind: *kind },
    });
    if starting_toilet {
        raise_pillars(world, log, agent_id, session, &nick, *target);
    }
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

/// A toilet claims the 3x3 around it: its four corners become pillars.
fn raise_pillars(
    world: &mut WorldState,
    log: &mut EventLog,
    agent_id: AgentId,
    session: SessionId,
    nick: &str,
    toilet: Pos,
) {
    for corner in toilet_corners(toilet) {
        world.set_object(corner, Some(Object::Pillar));
        log.push(EventKind::ObjectChanged {
            session: Some(session),
            agent: Some(agent_id),
            nick: Some(nick.to_string()),
            pos: corner,
            object: Some(Object::Pillar),
            cause: ObjectCause::Build {
                kind: SiteKind::Toilet,
            },
        });
    }
}

/// The corners of a toilet's 3x3 that are still pillars go with the toilet.
fn clear_pillars(
    world: &mut WorldState,
    log: &mut EventLog,
    agent_id: AgentId,
    session: SessionId,
    nick: &str,
    toilet: Pos,
) {
    for corner in toilet_corners(toilet) {
        if world.object_at(corner) != Some(Object::Pillar) {
            continue;
        }
        world.set_object(corner, None);
        log.push(EventKind::ObjectChanged {
            session: Some(session),
            agent: Some(agent_id),
            nick: Some(nick.to_string()),
            pos: corner,
            object: None,
            cause: ObjectCause::Demolish,
        });
    }
}

fn completed_object(kind: SiteKind) -> Object {
    match kind {
        SiteKind::Wall => Object::Wall { damage: 0 },
        SiteKind::Door => Object::Door {
            open: false,
            damage: 0,
        },
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
    // A defender makes the demolition fail before anything is touched: no
    // damage, no progress, no `ObjectChanged`.
    if let Some(defender) = defender_at(world, *target) {
        let stun_until = world.tick + 1 + u64::from(cfg.combat.stun_ticks);
        log.push(EventKind::DemolishBlocked {
            session,
            agent: agent_id,
            nick: nick.clone(),
            target: *target,
            defender_session: world.session_of(defender).map_or(0, |entry| entry.id),
            defender_agent: defender,
            defender_nick: world
                .agents
                .get(&defender)
                .map(|agent| agent.nick.to_string())
                .unwrap_or_default(),
            stun_until,
        });
        if let Some(me) = world.agents.get_mut(&agent_id) {
            me.stun_until = stun_until;
            me.action = None;
        }
        log.push(EventKind::Stunned {
            session,
            agent: agent_id,
            nick,
            until: stun_until,
            reason: "demolition was blocked by a defender".to_string(),
        });
        return;
    }
    let Some(existing) = world.object_at(*target) else {
        return;
    };
    let (object, finished) = match existing {
        Object::Site { .. } => (None, true),
        Object::Wall { damage } => {
            let damage = damage.saturating_add(cfg.build.wall_door_demolish_per_tick);
            if damage >= cfg.build.wall_work {
                (None, true)
            } else {
                (Some(Object::Wall { damage }), false)
            }
        }
        Object::Door { open, damage } => {
            let damage = damage.saturating_add(cfg.build.wall_door_demolish_per_tick);
            if damage >= cfg.build.door_work {
                (None, true)
            } else {
                (Some(Object::Door { open, damage }), false)
            }
        }
        Object::Toilet { level, progress } => toilet_after_demolish(level, progress, cfg),
        Object::Pillar => (Some(Object::Pillar), true),
    };
    let took_toilet = object.is_none()
        && matches!(
            existing,
            Object::Toilet { .. }
                | Object::Site {
                    kind: SiteKind::Toilet,
                    ..
                }
        );
    world.set_object(*target, object);
    log.push(EventKind::ObjectChanged {
        session: Some(session),
        agent: Some(agent_id),
        nick: Some(nick.clone()),
        pos: *target,
        object,
        cause: ObjectCause::Demolish,
    });
    if took_toilet {
        clear_pillars(world, log, agent_id, session, &nick, *target);
    }
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
    let damage = match world.object_at(*target) {
        Some(Object::Door { damage, .. }) => damage,
        _ => 0,
    };
    let object = Object::Door {
        open: *open,
        damage,
    };
    world.set_object(*target, Some(object));
    log.push(EventKind::ObjectChanged {
        session: Some(session),
        agent: Some(agent_id),
        nick: Some(nick.clone()),
        pos: *target,
        object: Some(object),
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
    let mut closed: Vec<(Pos, u32)> = Vec::new();
    for y in 0..world.map.height() {
        for x in 0..world.map.width() {
            let pos = Pos::new(x, y);
            if let Some(Object::Door {
                open: false,
                damage,
            }) = world.object_at(pos)
            {
                closed.push((pos, damage));
            }
        }
    }
    for (pos, damage) in closed {
        let attended = Dir::ALL.iter().any(|dir| {
            let cell = pos.step(*dir);
            matches!(world.object_at(cell), Some(Object::Toilet { .. }))
                && world.agent_at(cell).is_some()
        });
        if attended {
            continue;
        }
        let object = Object::Door { open: true, damage };
        world.set_object(pos, Some(object));
        log.push(EventKind::ObjectChanged {
            session: None,
            agent: None,
            nick: None,
            pos,
            object: Some(object),
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
    // A queued agent lives on the queue cells: one step off them is blocked
    // like a wall, so nobody walks out of the line into the map.
    let waiting = world
        .session_of(agent_id)
        .is_some_and(|session| session.status == SessionStatus::Waiting);
    if waiting && world.queue_lane(target).is_none() {
        end_action(
            world,
            log,
            agent_id,
            session,
            nick,
            pos,
            Some(dir),
            ActionOutcome::Blocked {
                by: Blocker::QueueBoundary,
            },
            &action,
        );
        return;
    }
    let object_blocker = if !world.map.in_bounds(target) {
        Some(Blocker::MapEdge)
    } else {
        world
            .object_at(target)
            .filter(|o| o.blocks_movement())
            .map(|object| match object {
                Object::Door { .. } => Blocker::ClosedDoor,
                Object::Site { .. } => Blocker::Site,
                Object::Pillar => Blocker::Pillar,
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
        let stunned = is_stunned(other, world.tick);
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
        // A defending agent is busy while the shield holds: the use neither progresses nor
        // breaks, it simply waits.
        if agent.defending.is_some() {
            continue;
        }
        let Some(pos) = agent.pos else {
            continue;
        };
        let nick = agent.nick.to_string();
        let Some(session_id) = world.session_of(*agent_id).map(|entry| entry.id) else {
            continue;
        };
        if world
            .sessions
            .get(&session_id)
            .is_some_and(|entry| entry.outcome.is_some())
        {
            // Already scored: a finished session never adds progress or score.
            continue;
        }
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
                    agent.score_total = agent.score_total.saturating_add(score);
                    agent.level = agent_level(agent.score_total, cfg);
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
    // A waiter that leaves closes the gap it left behind.
    compress_primary(&mut next, &mut log);
    next.rebuild_entry_queue();
    Ok((next, outcome, score, log.into_vec()))
}
