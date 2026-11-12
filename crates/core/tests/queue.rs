//! Physical outside-queue behaviour: FIFO admission, idle cleanup, overflow
//! shoving, `touch`, capacity rejection and replay fidelity.
//!
//! The map is deliberately tiny and hand-written so the queue geometry is
//! explicit: the entrance at `(1,1)`, the primary lane `(1,2) -> (2,2)` and the
//! overflow lane `(1,3)` below the primary mouth.

use loo_core::{
    diff_worlds, join, map, restore, step, touch, ActionOutcome, Blocker, Config, Event, EventKind,
    Intent, IntentKind, JoinCommand, JoinRejectKind, QueueLane, SessionStatus, Snapshot,
    WorldState,
};
use loo_proto::{Dir, Nick, Pos, SessionOutcome};

/// `q` at (1,2) and (2,2); `r` at (1,3). The primary mouth is (1,2).
const QUEUE_MAP: &str = "\
grid
#####
#E..#
#qq.#
#r..#
#####
";

/// One-second ticks with a short queue idle timeout.
fn fast_idle_config(idle_seconds: u32) -> Config {
    let mut cfg = Config {
        tick_seconds: 1.0,
        ..Config::default()
    };
    cfg.session.queue_idle_seconds = idle_seconds;
    cfg
}

fn build(cfg: &Config) -> WorldState {
    let _ = cfg;
    WorldState::new(map::parse(QUEUE_MAP).expect("queue map parses"))
}

fn nick(name: &str) -> Nick {
    Nick::parse(name).expect("valid nickname")
}

fn join_agent(
    world: &WorldState,
    cfg: &Config,
    agent: u64,
    start_seq: u32,
) -> (WorldState, Vec<Event>) {
    let (next, _outcome, events) = join(
        world,
        &JoinCommand {
            agent,
            nick: nick(&format!("dev-{agent}")),
            session: agent * 10,
            score_total: 0,
        },
        cfg,
        start_seq,
        0,
    )
    .expect("join accepted");
    (next, events)
}

fn move_intent(agent: u64, dirs: &[Dir]) -> Intent {
    Intent {
        agent,
        kind: IntentKind::Move {
            dirs: dirs.to_vec(),
            label: "queue move".to_string(),
        },
    }
}

fn pos_of(world: &WorldState, agent: u64) -> Pos {
    world.agents[&agent].pos.expect("agent is on the map")
}

fn entry_queue(world: &WorldState) -> Vec<u64> {
    world.entry_queue.iter().copied().collect()
}

fn session_of(world: &WorldState, agent: u64) -> u64 {
    world.session_of(agent).expect("agent has a session").id
}

#[test]
fn queue_map_orders_the_lanes_from_the_entrance() {
    let cfg = Config::default();
    let world = build(&cfg);
    assert_eq!(world.entrance, Pos::new(1, 1));
    assert_eq!(
        world.queue_primary,
        vec![Pos::new(1, 2), Pos::new(2, 2)],
        "head of the primary lane is the mouth"
    );
    assert_eq!(world.queue_overflow, vec![Pos::new(1, 3)]);
    assert_eq!(world.queue_lane(Pos::new(1, 2)), Some(QueueLane::Primary));
    assert_eq!(world.queue_rank(Pos::new(2, 2)), Some(1));
    assert_eq!(world.queue_lane(Pos::new(1, 3)), Some(QueueLane::Overflow));
    assert_eq!(
        world.queue_rank(Pos::new(1, 3)),
        Some(2),
        "overflow ranks after the whole primary lane"
    );
    assert_eq!(world.queue_lane(Pos::new(0, 0)), None);
}

#[test]
fn entrance_admits_one_at_a_time_in_fifo_order() {
    let cfg = Config::default();
    let mut world = build(&cfg);
    world = join_agent(&world, &cfg, 1, 0).0;
    let (joined, events) = join_agent(&world, &cfg, 2, 0);
    assert!(matches!(
        events.last().map(|event| &event.kind),
        Some(EventKind::Joined {
            at: Some(Pos { x: 1, y: 2 }),
            inside: false,
            ahead: 0,
            ..
        })
    ));
    world = joined;
    let (joined, _) = join_agent(&world, &cfg, 3, 0);
    world = joined;

    assert_eq!(pos_of(&world, 2), Pos::new(1, 2));
    assert_eq!(pos_of(&world, 3), Pos::new(2, 2));
    assert_eq!(entry_queue(&world), vec![20, 30]);

    // The entrance is occupied: nobody is admitted, the head stays put.
    let (next, events) = step(&world, &[], 1, &cfg);
    assert_eq!(pos_of(&next, 2), Pos::new(1, 2), "head waits for the door");
    assert!(!events
        .iter()
        .any(|event| matches!(event.kind, EventKind::EnteredWorld { .. })));
    world = next;

    // dev-1 steps east; admission had already run, so the head still waits.
    let (next, _) = step(&world, &[move_intent(1, &[Dir::E])], 2, &cfg);
    assert_eq!(pos_of(&next, 1), Pos::new(2, 1));
    assert_eq!(pos_of(&next, 2), Pos::new(1, 2), "one tick behind");
    world = next;

    // Now the entrance is free: exactly one waiter enters and the lane packs.
    let (next, events) = step(&world, &[], 3, &cfg);
    assert_eq!(pos_of(&next, 2), next.entrance);
    assert_eq!(next.sessions[&20].status, SessionStatus::Inside);
    assert_eq!(pos_of(&next, 3), Pos::new(1, 2), "the next waiter advanced");
    assert_eq!(entry_queue(&next), vec![30]);
    let entered = events
        .iter()
        .find(|event| matches!(event.kind, EventKind::EnteredWorld { .. }))
        .expect("one admission");
    assert!(matches!(
        entered.kind,
        EventKind::EnteredWorld {
            agent: 2,
            at: Pos { x: 1, y: 1 },
            from: Some(Pos { x: 1, y: 2 }),
            ..
        }
    ));
    assert!(
        events.iter().any(|event| matches!(
            event.kind,
            EventKind::QueueAdvanced {
                agent: 3,
                from: Pos { x: 2, y: 2 },
                to: Pos { x: 1, y: 2 },
                ..
            }
        )),
        "compression is an event: {events:?}"
    );

    // dev-2 still blocks the entrance, so dev-3 keeps waiting.
    let (next, events) = step(&next, &[], 4, &cfg);
    assert_eq!(next.sessions[&30].status, SessionStatus::Waiting);
    assert!(next.agents[&3].pos.is_some());
    assert!(!events
        .iter()
        .any(|event| matches!(event.kind, EventKind::EnteredWorld { .. })));
}

#[test]
fn idle_queue_sessions_are_abandoned_and_the_line_moves_up() {
    let cfg = fast_idle_config(2);
    assert_eq!(cfg.queue_idle_ticks(), 2);

    let mut world = build(&cfg);
    world = join_agent(&world, &cfg, 1, 0).0;
    world = join_agent(&world, &cfg, 2, 0).0;
    assert_eq!(world.sessions[&20].last_active_tick, 0);

    // One idle tick is not enough.
    let (next, _) = step(&world, &[], 1, &cfg);
    assert_eq!(next.sessions[&20].status, SessionStatus::Waiting);
    world = next;

    // A fresh joiner is active at tick 1, so it survives the cleanup at tick 2.
    world = join_agent(&world, &cfg, 3, 0).0;
    assert_eq!(world.sessions[&30].last_active_tick, 1);
    assert_eq!(pos_of(&world, 3), Pos::new(2, 2));

    let (next, events) = step(&world, &[], 2, &cfg);
    assert!(!next.sessions.contains_key(&20), "the idle waiter is gone");
    assert!(!next.agents.contains_key(&2));
    let ended = events
        .iter()
        .find(|event| matches!(event.kind, EventKind::SessionEnded { .. }))
        .expect("the abandonment is logged");
    assert!(matches!(
        ended.kind,
        EventKind::SessionEnded {
            session: 20,
            outcome: SessionOutcome::Abandoned,
            pos: Some(Pos { x: 1, y: 2 }),
            ..
        }
    ));
    assert_eq!(
        pos_of(&next, 3),
        Pos::new(1, 2),
        "the survivor moved up to the mouth"
    );
    assert_eq!(entry_queue(&next), vec![30]);
}

#[test]
fn full_queue_rejects_a_join() {
    let cfg = Config {
        session: loo_core::config::SessionConfig {
            queue_capacity: 2,
            ..Default::default()
        },
        ..Config::default()
    };
    let mut world = build(&cfg);
    world = join_agent(&world, &cfg, 1, 0).0;
    world = join_agent(&world, &cfg, 2, 0).0;
    world = join_agent(&world, &cfg, 3, 0).0;
    assert_eq!(world.entry_queue.len(), 2);

    let err = join(
        &world,
        &JoinCommand {
            agent: 4,
            nick: nick("dev-4"),
            session: 40,
            score_total: 0,
        },
        &cfg,
        0,
        0,
    )
    .expect_err("the queue is at capacity");
    assert_eq!(err.kind, JoinRejectKind::QueueFull);
    assert!(
        err.message.contains("queue is full"),
        "message: {}",
        err.message
    );
    assert!(
        !world.agents.contains_key(&4),
        "a rejected join changes nothing"
    );
}

#[test]
fn overflow_waiter_shoves_a_stunned_blocker_into_the_primary_lane() {
    let cfg = Config::default();
    let mut world = build(&cfg);
    world = join_agent(&world, &cfg, 1, 0).0;
    world = join_agent(&world, &cfg, 2, 0).0;
    world = join_agent(&world, &cfg, 3, 0).0;
    world = join_agent(&world, &cfg, 4, 0).0;
    assert_eq!(pos_of(&world, 4), Pos::new(1, 3), "overflow lane");
    assert_eq!(world.queue_position(session_of(&world, 4)), Some(3));

    // The primary mouth is held by a conscious agent: the shove is blocked.
    let (next, events) = step(&world, &[move_intent(4, &[Dir::N])], 1, &cfg);
    assert_eq!(pos_of(&next, 4), Pos::new(1, 3), "no shove without a stun");
    assert!(matches!(
        &events
            .iter()
            .find(|event| matches!(event.kind, EventKind::ActionFinished { agent: 4, .. }))
            .expect("the move ended")
            .kind,
        EventKind::ActionFinished {
            outcome: ActionOutcome::Blocked {
                by: Blocker::Agent { .. }
            },
            ..
        }
    ));
    world = next;

    // Stun the blocker; the same move now swaps the two agents.
    world.agents.get_mut(&2).expect("agent 2").stun_until = 10;
    let (next, events) = step(&world, &[move_intent(4, &[Dir::N])], 2, &cfg);
    assert_eq!(
        pos_of(&next, 4),
        Pos::new(1, 2),
        "the shover takes the mouth"
    );
    assert_eq!(
        pos_of(&next, 2),
        Pos::new(1, 3),
        "the stunned agent is pushed"
    );
    assert!(events
        .iter()
        .any(|event| matches!(event.kind, EventKind::AgentSwapped { agent: 4, .. })));
    let session_4 = session_of(&next, 4);
    assert_eq!(next.queue_position(session_4), Some(1), "head of the line");
    assert_eq!(
        pos_of(&next, 3),
        Pos::new(2, 2),
        "the other primary waiter is untouched"
    );
    world = next;

    // The entrance is still occupied by dev-1, so the new head waits one tick.
    let (next, _) = step(&world, &[], 3, &cfg);
    assert_eq!(next.sessions[&40].status, SessionStatus::Waiting);
    world = next;

    // dev-1 steps aside; the overflow shover enters from the primary mouth.
    let (next, _) = step(&world, &[move_intent(1, &[Dir::E])], 4, &cfg);
    world = next;
    let (next, events) = step(&world, &[], 5, &cfg);
    assert_eq!(next.sessions[&40].status, SessionStatus::Inside);
    assert_eq!(pos_of(&next, 4), next.entrance);
    assert!(events.iter().any(|event| matches!(
        event.kind,
        EventKind::EnteredWorld {
            agent: 4,
            from: Some(Pos { x: 1, y: 2 }),
            ..
        }
    )));
    assert_eq!(
        pos_of(&next, 3),
        Pos::new(1, 2),
        "the follower compresses behind the entrant"
    );
}

#[test]
fn touch_logs_activity_and_defers_the_idle_cleanup() {
    let cfg = fast_idle_config(2);

    let mut world = build(&cfg);
    world = join_agent(&world, &cfg, 1, 0).0;
    world = join_agent(&world, &cfg, 2, 0).0;
    let session = session_of(&world, 2);

    assert!(
        touch(&world, 2, 0, 0).is_none(),
        "the join already counts as activity for tick 0"
    );
    let event = touch(&world, 2, 1, 7).expect("a new tick is activity");
    assert!(matches!(
        event.kind,
        EventKind::QueueTouched {
            session: 20,
            agent: 2,
            tick: 1,
            ..
        }
    ));
    assert_eq!(
        event.text(),
        "dev-2 checked in from the queue",
        "agent-facing text"
    );
    assert_eq!(
        world.sessions[&session].last_active_tick, 0,
        "touch only produces the record; applying it is the caller's job"
    );

    // The server writes the event into tick 1's log; a replay applies it.
    let settled = Event {
        tick: 1,
        seq: 1,
        seed: 7,
        kind: EventKind::TickSettled,
    };
    let mut touched = event;
    touched.seq = 2;
    touched.seed = 7;
    let restored = restore(&Snapshot::at(world.clone(), 0), &[settled, touched], &cfg)
        .expect("the touch replays");
    assert_eq!(restored.sessions[&session].last_active_tick, 1);
    assert_eq!(restored.entry_queue, world.entry_queue);

    // Without the touch the waiter is cleaned at tick 2.
    let (tick1, _) = step(&world, &[], 1, &cfg);
    let (tick2, _) = step(&tick1, &[], 2, &cfg);
    assert!(!tick2.sessions.contains_key(&session), "idle is abandoned");

    // With the touch it survives tick 2 and only goes at tick 3.
    let (tick2, _) = step(&restored, &[], 2, &cfg);
    assert!(
        tick2.sessions.contains_key(&session),
        "the check-in defers the cleanup"
    );
    let (tick3, _) = step(&tick2, &[], 3, &cfg);
    assert!(!tick3.sessions.contains_key(&session));
}

#[test]
fn restore_rebuilds_queue_positions_activity_and_entry_queue() {
    let cfg = Config::default();
    let initial = build(&cfg);
    let (mut world, mut events) = join_agent(&initial, &cfg, 1, 0);
    for agent in 2..=4 {
        let start_seq = events.last().map_or(0, |event| event.seq);
        let (next, more) = join_agent(&world, &cfg, agent, start_seq);
        world = next;
        events.extend(more);
    }
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event.kind, EventKind::Joined { .. }))
            .count(),
        4,
        "one Joined per session"
    );
    assert_eq!(entry_queue(&world), vec![20, 30, 40]);

    // Tick 1: dev-1 frees the entrance. Tick 2: dev-2 enters and the lane
    // compresses, moving dev-3 and dev-4 up.
    for (tick, intents) in [
        (1u64, vec![move_intent(1, &[Dir::E])]),
        (2, Vec::new()),
        (3, Vec::new()),
        (4, Vec::new()),
    ] {
        let (next, log) = step(&world, &intents, 100 + tick, &cfg);
        world = next;
        events.extend(log);
    }

    let restored = restore(&Snapshot::new(initial), &events, &cfg)
        .expect("joins, admissions and queue advances replay");
    let diffs = diff_worlds(&restored, &world);
    assert!(diffs.is_empty(), "queue replay differs: {diffs:?}");

    assert_eq!(restored.entry_queue, world.entry_queue);
    assert_eq!(
        restored.sessions[&20].last_active_tick,
        world.sessions[&20].last_active_tick
    );
    assert_eq!(restored.sessions[&20].status, SessionStatus::Inside);
    for agent in 1..=4 {
        assert_eq!(
            restored.agents[&agent].pos, world.agents[&agent].pos,
            "agent {agent} position"
        );
    }
    let waiting = restored.waiting_sessions();
    assert_eq!(
        restored.entry_queue.iter().copied().collect::<Vec<_>>(),
        waiting
    );
}

#[test]
fn queue_touch_carries_the_tick_seed_and_replays() {
    let cfg = Config::default();
    let mut world = join_agent(&build(&cfg), &cfg, 1, 0).0;
    world = join_agent(&world, &cfg, 2, 0).0;
    let session = session_of(&world, 2);

    let tick_seed = 7_654_321_098;
    let mut touched = touch(&world, 2, 1, tick_seed).expect("a new tick is activity");
    assert_eq!(
        touched.seed, tick_seed,
        "a QueueTouched must carry the tick's seed or restart replay rejects it"
    );
    touched.seq = 2;

    let settled = Event {
        tick: 1,
        seq: 1,
        seed: tick_seed,
        kind: EventKind::TickSettled,
    };
    let restored = restore(
        &Snapshot::at(world.clone(), 0).with_seed(tick_seed),
        &[settled, touched],
        &cfg,
    )
    .expect("the touch replays when it carries the tick seed");
    assert_eq!(restored.sessions[&session].last_active_tick, 1);

    let bad = Event {
        tick: 1,
        seq: 2,
        seed: 0,
        kind: EventKind::QueueTouched {
            session,
            agent: 2,
            nick: "dev-2".to_string(),
            tick: 1,
        },
    };
    let settled = Event {
        tick: 1,
        seq: 1,
        seed: tick_seed,
        kind: EventKind::TickSettled,
    };
    let error = restore(
        &Snapshot::at(world.clone(), 0).with_seed(tick_seed),
        &[settled, bad],
        &cfg,
    )
    .expect_err("a seed 0 touch is a corrupt log");
    assert!(
        error.message.contains("seed 0 does not match"),
        "unexpected error: {error}"
    );
}
