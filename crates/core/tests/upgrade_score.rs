//! Toilet upgrades/downgrades, agent levels, cumulative score and their
//! restore contract.

use loo_core::{
    agent_level, diff_worlds, is_usable, join, map, restore, step, validate_upgrade, validate_use,
    weighted_score, Action, ActionOutcome, Config, Event, EventKind, Intent, IntentKind,
    JoinCommand, Object, ObjectCause, SessionStatus, Snapshot, WorldState,
};
use loo_proto::{Need, Nick, Pos};

/// An open floor with one level-2 toilet at (2,2) and four free neighbours.
const ARENA: &str = "\
grid
.........
.........
..2......
.........
E........
";

/// A level-2 toilet walled in on all four sides, unreachable but usable.
const ENCLOSED: &str = "\
grid
#######
#5#2#.#
#######
#E....#
#######
";

/// A level-2 toilet at (2,2) walled in on all four sides, so it counts as
/// usable once its progress is zero.
const WALLED_TOILET: &str = "\
grid
.....
.###.
.#2#.
.###.
..E..
";

const TOILET: Pos = Pos::new(2, 2);
const NORTH: Pos = Pos::new(2, 1);
const WEST: Pos = Pos::new(1, 2);

const CELL: Pos = Pos::new(3, 1);

/// Cumulative score for agent level 3.
const LEVEL_3: u32 = 3000;
/// Cumulative score for agent level 5.
const LEVEL_5: u32 = 20000;

fn build(text: &str) -> WorldState {
    WorldState::new(map::parse(text).expect("test map parses"))
}

fn nick(name: &str) -> Nick {
    Nick::parse(name).expect("valid nickname")
}

fn claim(world: &WorldState, cfg: &Config, agent: u64, score_total: u32) -> WorldState {
    let (next, ..) = join(
        world,
        &JoinCommand {
            agent,
            nick: nick(&format!("dev-{agent}")),
            session: agent * 10,
            score_total,
        },
        cfg,
        0,
        0,
    )
    .expect("join accepted");
    next
}

/// Puts an agent on a cell directly, as a scenario builder would.
fn place(world: &mut WorldState, agent: u64, at: Pos) {
    let session = world.session_of(agent).expect("agent has a session").id;
    world.agents.get_mut(&agent).expect("agent exists").pos = Some(at);
    let entry = world.sessions.get_mut(&session).expect("session exists");
    entry.status = SessionStatus::Inside;
    world.entry_queue.retain(|queued| *queued != session);
}

/// An agent with a known need and deadline; a scenario picks urine/feces.
fn armed(world: &mut WorldState, agent: u64, at: Pos, need: Need, deadline: u64) {
    place(world, agent, at);
    let session = world.session_of(agent).expect("agent has a session").id;
    let entry = world.sessions.get_mut(&session).expect("session exists");
    entry.need = Some(need);
    entry.deadline = deadline;
}

fn upgrade_intent(agent: u64, target: Pos) -> Intent {
    Intent {
        agent,
        kind: IntentKind::Upgrade { target },
    }
}

fn downgrade_intent(agent: u64, target: Pos) -> Intent {
    Intent {
        agent,
        kind: IntentKind::Downgrade { target },
    }
}

fn use_intent(agent: u64, target: Pos) -> Intent {
    Intent {
        agent,
        kind: IntentKind::Use { target },
    }
}

/// Settles `ticks` ticks, submitting `intents` on the first one only.
fn run(
    world: &WorldState,
    intents: &[Intent],
    ticks: u64,
    cfg: &Config,
) -> (WorldState, Vec<Event>) {
    let mut world = world.clone();
    let mut events = Vec::new();
    let none: Vec<Intent> = Vec::new();
    for offset in 0..ticks {
        let submitted = if offset == 0 { intents } else { &none };
        let (next, log) = step(&world, submitted, 100 + offset, cfg);
        world = next;
        events.extend(log);
    }
    (world, events)
}

/// Records the agent's current view at the world tick, which is what a real
/// entry marks. A test that teleports an agent must do this before a snapshot so
/// `restore` sees the same `Session::seen`.
fn mark_view(world: &mut WorldState, cfg: &Config, agent: u64) {
    let session = world.session_of(agent).expect("agent has a session").id;
    let pos = world.agents[&agent].pos.expect("agent is on the field");
    let tick = world.tick;
    world.mark_seen(session, pos, tick, cfg.view.width, cfg.view.height);
}

fn toilet_at(world: &WorldState, pos: Pos) -> (u8, i32) {
    match world.object_at(pos) {
        Some(Object::Toilet { level, progress }) => (level, progress),
        other => panic!("expected a toilet at {pos}, got {other:?}"),
    }
}

fn set_toilet(world: &mut WorldState, pos: Pos, level: u8, progress: i32) {
    world.set_object(pos, Some(Object::Toilet { level, progress }));
}

fn count<F: Fn(&EventKind) -> bool>(events: &[Event], matches_kind: F) -> usize {
    events
        .iter()
        .filter(|event| matches_kind(&event.kind))
        .count()
}

fn failure_reason(events: &[Event], agent: u64) -> String {
    events
        .iter()
        .find_map(|event| match &event.kind {
            EventKind::ActionFinished {
                agent: who,
                outcome: ActionOutcome::Failed { reason },
                ..
            } if *who == agent => Some(reason.clone()),
            _ => None,
        })
        .unwrap_or_else(|| panic!("agent {agent} did not fail: {events:?}"))
}

#[test]
fn two_upgraders_add_two_per_tick() {
    let cfg = Config::default();
    let mut world = build(ARENA);
    world = claim(&world, &cfg, 1, LEVEL_3);
    world = claim(&world, &cfg, 2, LEVEL_3);
    place(&mut world, 1, NORTH);
    place(&mut world, 2, WEST);
    assert_eq!(world.agents[&1].level, 3);

    let intents = [upgrade_intent(1, TOILET), upgrade_intent(2, TOILET)];
    let (after_one, events) = run(&world, &intents, 1, &cfg);
    assert_eq!(
        toilet_at(&after_one, TOILET),
        (2, 2),
        "two workers, +2 work"
    );
    assert!(
        matches!(after_one.agents[&1].action, Some(Action::Upgrade { .. }))
            && matches!(after_one.agents[&2].action, Some(Action::Upgrade { .. })),
        "an unfinished toilet keeps both actions"
    );
    assert_eq!(
        count(&events, |kind| matches!(
            kind,
            EventKind::ObjectChanged {
                cause: ObjectCause::Upgrade,
                ..
            }
        )),
        1,
        "one net change per toilet per tick"
    );

    let (after_more, more_events) = run(&after_one, &[], 5, &cfg);
    assert_eq!(
        toilet_at(&after_more, TOILET),
        (3, 0),
        "crossing the 12 work points of level 2 reaches level 3 with empty progress"
    );
    assert!(
        after_more.agents[&1].action.is_none() && after_more.agents[&2].action.is_none(),
        "the completed upgrade clears both actions"
    );
    let crossing = more_events
        .iter()
        .find(|event| {
            matches!(
                event.kind,
                EventKind::ObjectChanged {
                    cause: ObjectCause::Upgrade,
                    object: Some(Object::Toilet {
                        level: 3,
                        progress: 0
                    }),
                    ..
                }
            )
        })
        .expect("the crossing tick reports the new level");
    let text = crossing.text();
    assert!(
        text.contains("level 3") && text.contains("progress 0"),
        "{text}"
    );
}

#[test]
fn one_upgrade_and_one_downgrade_net_minus_one() {
    let cfg = Config::default();
    let mut world = build(ARENA);
    world = claim(&world, &cfg, 1, LEVEL_3);
    world = claim(&world, &cfg, 2, 0);
    place(&mut world, 1, NORTH);
    place(&mut world, 2, WEST);

    let intents = [upgrade_intent(1, TOILET), downgrade_intent(2, TOILET)];
    let (next, events) = run(&world, &intents, 1, &cfg);
    assert_eq!(
        toilet_at(&next, TOILET),
        (1, 5),
        "-1 net crosses down to level 1 and keeps the rest of the interval"
    );
    assert!(
        !matches!(toilet_at(&next, TOILET), (_, p) if p < 0),
        "never negative"
    );
    assert_eq!(
        count(&events, |kind| matches!(
            kind,
            EventKind::ObjectChanged {
                cause: ObjectCause::Downgrade,
                ..
            }
        )),
        1
    );
    assert!(
        next.agents[&1].action.is_some() && next.agents[&2].action.is_some(),
        "neither worker finished"
    );
    let downgrade = events
        .iter()
        .find(|event| {
            matches!(
                event.kind,
                EventKind::ObjectChanged {
                    cause: ObjectCause::Downgrade,
                    ..
                }
            )
        })
        .expect("the net change is reported");
    let text = downgrade.text();
    assert!(
        text.contains("downgraded the toilet")
            && text.contains("level 1")
            && text.contains("progress 5"),
        "{text}"
    );

    for seed in 1..=8u64 {
        let (next, _) = step(&world, &intents, seed, &cfg);
        assert_eq!(
            toilet_at(&next, TOILET),
            (1, 5),
            "the net change cannot depend on the shuffle order (seed {seed})"
        );
    }
}

#[test]
fn net_change_is_applied_once_not_per_worker() {
    let cfg = Config::default();
    let mut world = build(WALLED_TOILET);
    world = claim(&world, &cfg, 1, LEVEL_3);
    world = claim(&world, &cfg, 2, LEVEL_3);
    // The toilet is walled in on all four sides, which is what makes a finished
    // toilet usable; the two workers are placed on two of those wall cells
    // because a usable toilet has no free neighbour to stand on.
    place(&mut world, 1, NORTH);
    place(&mut world, 2, WEST);
    set_toilet(&mut world, TOILET, 2, 11);
    assert!(
        !is_usable(&world, TOILET),
        "a toilet under construction is not usable"
    );

    let intents = [upgrade_intent(1, TOILET), upgrade_intent(2, TOILET)];
    let (next, events) = run(&world, &intents, 1, &cfg);
    assert_eq!(
        toilet_at(&next, TOILET),
        (3, 0),
        "11 + 2 = 13 crosses to level 3 and the new level starts at zero"
    );
    assert!(
        is_usable(&next, TOILET),
        "the crossed toilet is finished and usable"
    );
    for agent in [1u64, 2] {
        assert!(
            next.agents[&agent].action.is_none(),
            "agent {agent} finished its upgrade"
        );
        let completed = count(&events, |kind| {
            matches!(
                kind,
                EventKind::ActionFinished {
                    agent: who,
                    outcome: ActionOutcome::Completed,
                    ..
                } if *who == agent
            )
        });
        assert_eq!(completed, 1, "agent {agent} reports one completed upgrade");
    }
    assert_eq!(
        count(&events, |kind| matches!(
            kind,
            EventKind::ObjectChanged { .. }
        )),
        1
    );
}

#[test]
fn multiple_downgraders_apply_four_per_tick() {
    let cfg = Config::default();
    let mut world = build(ARENA);
    world = claim(&world, &cfg, 1, 0);
    world = claim(&world, &cfg, 2, 0);
    place(&mut world, 1, NORTH);
    place(&mut world, 2, WEST);
    set_toilet(&mut world, TOILET, 3, 10);

    let intents = [downgrade_intent(1, TOILET), downgrade_intent(2, TOILET)];
    let (next, events) = run(&world, &intents, 1, &cfg);
    assert_eq!(
        toilet_at(&next, TOILET),
        (3, 6),
        "two downgraders remove 2 each once for the tick, not one after the other"
    );
    assert_eq!(
        count(&events, |kind| matches!(
            kind,
            EventKind::ObjectChanged {
                cause: ObjectCause::Downgrade,
                ..
            }
        )),
        1,
        "one net change per toilet per tick"
    );
    for seed in 0..8u64 {
        let (seeded, _) = step(&world, &intents, seed, &cfg);
        assert_eq!(
            toilet_at(&seeded, TOILET),
            (3, 6),
            "the net change cannot depend on the shuffle order (seed {seed})"
        );
    }
}

#[test]
fn level_five_upgrade_is_rejected() {
    let cfg = Config::default();
    let mut world = build(ARENA);
    world = claim(&world, &cfg, 1, LEVEL_5);
    place(&mut world, 1, NORTH);
    set_toilet(&mut world, TOILET, 5, 0);
    assert_eq!(world.agents[&1].level, 5, "the agent is high enough");

    let (next, events) = run(&world, &[upgrade_intent(1, TOILET)], 1, &cfg);
    assert!(next.agents[&1].action.is_none(), "no upgrade was started");
    let reason = failure_reason(&events, 1);
    assert!(reason.contains("already level 5"), "{reason}");
    assert_eq!(toilet_at(&next, TOILET), (5, 0), "the toilet is untouched");
    assert_eq!(
        count(&events, |kind| matches!(
            kind,
            EventKind::ObjectChanged { .. }
        )),
        0
    );
}

#[test]
fn insufficient_level_work_is_not_counted_and_is_rejected() {
    let cfg = Config::default();
    let mut world = build(ARENA);
    world = claim(&world, &cfg, 1, 0);
    world = claim(&world, &cfg, 2, LEVEL_3);
    place(&mut world, 1, NORTH);
    place(&mut world, 2, WEST);
    assert_eq!(world.agents[&1].level, 1);

    let intents = [upgrade_intent(1, TOILET), upgrade_intent(2, TOILET)];
    let (next, events) = run(&world, &intents, 1, &cfg);
    assert_eq!(
        toilet_at(&next, TOILET),
        (2, 1),
        "only the level 3 worker contributes"
    );
    assert!(next.agents[&1].action.is_none(), "the rejected action ends");
    let reason = failure_reason(&events, 1);
    assert!(reason.contains("level"), "{reason}");
    assert!(reason.contains("not counted"), "{reason}");
    assert_eq!(next.agents[&1].score_total, 0, "failed work scores nothing");
}

#[test]
fn upgrade_stops_at_next_level_zero() {
    let cfg = Config::default();
    let mut world = build(ARENA);
    world = claim(&world, &cfg, 1, LEVEL_3);
    place(&mut world, 1, NORTH);
    set_toilet(&mut world, TOILET, 2, 11);

    let (next, _) = run(&world, &[upgrade_intent(1, TOILET)], 1, &cfg);
    assert_eq!(toilet_at(&next, TOILET), (3, 0));
    assert!(next.agents[&1].action.is_none(), "the upgrade finished");
}

#[test]
fn downgrade_stops_at_lower_level_zero() {
    let cfg = Config::default();
    let mut world = build(ARENA);
    world = claim(&world, &cfg, 1, 0);
    place(&mut world, 1, NORTH);

    let (next, _) = run(&world, &[downgrade_intent(1, TOILET)], 1, &cfg);
    assert_eq!(toilet_at(&next, TOILET), (1, 4));
    assert!(next.agents[&1].action.is_some());

    let (next, _) = run(&next, &[], 1, &cfg);
    assert_eq!(toilet_at(&next, TOILET), (1, 2));
    assert!(next.agents[&1].action.is_some());

    let (next, _) = run(&next, &[], 1, &cfg);
    assert_eq!(toilet_at(&next, TOILET), (1, 0));
    assert!(
        next.agents[&1].action.is_none(),
        "level 1 progress 0 ends it"
    );

    let (next, _) = run(&next, &[], 1, &cfg);
    assert_eq!(toilet_at(&next, TOILET), (1, 0), "the toilet stays put");
}

#[test]
fn downgrade_at_level_one_is_rejected() {
    let cfg = Config::default();
    let mut world = build(ARENA);
    world = claim(&world, &cfg, 1, 0);
    place(&mut world, 1, NORTH);
    set_toilet(&mut world, TOILET, 1, 0);

    let (next, events) = run(&world, &[downgrade_intent(1, TOILET)], 1, &cfg);
    assert!(next.agents[&1].action.is_none(), "no downgrade was started");
    let reason = failure_reason(&events, 1);
    assert!(reason.contains("demolish"), "{reason}");
    assert_eq!(toilet_at(&next, TOILET), (1, 0));
}

#[test]
fn sixth_worker_is_rejected() {
    let cfg = Config::default();
    let mut world = build(ARENA);
    for agent in 1..=5u64 {
        world = claim(&world, &cfg, agent, 0);
    }
    // Five agents that already work this toilet but cannot act this tick.
    for agent in 1..=5u64 {
        let action = Action::Upgrade {
            target: TOILET,
            label: format!("upgrade the toilet at {TOILET}"),
        };
        let entry = world.agents.get_mut(&agent).expect("agent exists");
        entry.pos = None;
        entry.action = Some(action);
        let session = world.session_of(agent).expect("session").id;
        world.sessions.get_mut(&session).expect("session").status = SessionStatus::Waiting;
    }
    world.entry_queue.clear();

    world = claim(&world, &cfg, 6, LEVEL_5);
    place(&mut world, 6, NORTH);
    assert_eq!(world.agents[&6].level, 5);

    assert!(
        validate_upgrade(&world, 6, TOILET, &cfg)
            .unwrap_err()
            .contains('5'),
        "five workers already own the toilet"
    );

    let (next, events) = run(&world, &[upgrade_intent(6, TOILET)], 1, &cfg);
    let reason = failure_reason(&events, 6);
    assert!(reason.contains('5'), "{reason}");
    assert_eq!(toilet_at(&next, TOILET), (2, 0), "nothing changed");
}

#[test]
fn nonzero_progress_toilet_is_not_usable_and_finished_level_has_multiplier() {
    let cfg = Config::default();
    let world = build(ENCLOSED);
    let mut world = claim(&world, &cfg, 1, 0);
    place(&mut world, 1, CELL);

    set_toilet(&mut world, CELL, 2, 1);
    let err = validate_use(&world, 1, &cfg).expect_err("under construction");
    assert!(err.contains("under construction"), "{err}");
    assert!(!is_usable(&world, CELL));

    set_toilet(&mut world, CELL, 5, 0);
    assert!(is_usable(&world, CELL));
    assert!(validate_use(&world, 1, &cfg).is_ok());
    assert_eq!(weighted_score(100, &[5, 5], &cfg), 1000);
}

#[test]
fn success_adds_score_total_once_and_updates_level() {
    let mut cfg = Config::default();
    cfg.need.urine_use_ticks = 1;
    let world = build(ENCLOSED);
    let mut world = claim(&world, &cfg, 1, 900);
    armed(&mut world, 1, CELL, Need::Urine, 120);
    assert_eq!(
        (world.agents[&1].score_total, world.agents[&1].level),
        (900, 1)
    );

    let (next, events) = run(&world, &[use_intent(1, CELL)], 1, &cfg);
    let score = events
        .iter()
        .find_map(|event| match event.kind {
            EventKind::UseSucceeded { score, .. } => Some(score),
            _ => None,
        })
        .expect("the one-tick use succeeded");
    assert!(score > 100, "base plus time bonus: {score}");
    assert_eq!(next.agents[&1].score_total, 900 + score);
    assert_eq!(next.agents[&1].level, 2, "crossing 1000 raises the level");

    let (later, later_events) = run(&next, &[], 3, &cfg);
    assert_eq!(later.agents[&1].score_total, 900 + score, "scored once");
    assert_eq!(
        count(&later_events, |kind| matches!(
            kind,
            EventKind::UseSucceeded { .. }
        )),
        0
    );
    assert_eq!(
        count(&events, |kind| matches!(
            kind,
            EventKind::UseSucceeded { .. }
        )),
        1
    );
}

#[test]
fn restore_rebuilds_score_and_upgrade_action() {
    let mut cfg = Config::default();
    let mut world = build(ARENA);
    world = claim(&world, &cfg, 1, LEVEL_3);
    world = claim(&world, &cfg, 2, LEVEL_3);
    place(&mut world, 1, NORTH);
    place(&mut world, 2, WEST);
    mark_view(&mut world, &cfg, 1);
    mark_view(&mut world, &cfg, 2);
    let snapshot = Snapshot::new(world.clone());

    let intents = [upgrade_intent(1, TOILET), upgrade_intent(2, TOILET)];
    let (live, events) = run(&world, &intents, 2, &cfg);
    assert_eq!(toilet_at(&live, TOILET), (2, 4));
    assert!(live.agents[&1].action.is_some(), "the upgrade is running");

    let restored = restore(&snapshot, &events, &cfg).expect("the upgrade log restores");
    let diffs = diff_worlds(&live, &restored);
    assert!(diffs.is_empty(), "restore differs: {diffs:?}");

    // The score path: a finished use restores score_total and level too.
    cfg.need.urine_use_ticks = 1;
    let mut scoring = build(ENCLOSED);
    scoring = claim(&scoring, &cfg, 1, 900);
    armed(&mut scoring, 1, CELL, Need::Urine, 120);
    mark_view(&mut scoring, &cfg, 1);
    let snapshot = Snapshot::new(scoring.clone());
    let (scored, score_events) = run(&scoring, &[use_intent(1, CELL)], 2, &cfg);
    assert_eq!(scored.agents[&1].level, 2);
    let restored = restore(&snapshot, &score_events, &cfg).expect("the score log restores");
    assert_eq!(
        (restored.agents[&1].score_total, restored.agents[&1].level),
        (scored.agents[&1].score_total, scored.agents[&1].level)
    );
    let diffs = diff_worlds(&scored, &restored);
    assert!(diffs.is_empty(), "score restore differs: {diffs:?}");
}

#[test]
fn old_agent_json_defaults_and_new_actions_round_trip() {
    let old = r#"{"id": 7, "nick": "dev-7", "pos": null, "action": null, "stun_until": 0}"#;
    let agent: loo_core::Agent =
        serde_json::from_str(old).expect("a snapshot from before levels still loads");
    assert_eq!((agent.score_total, agent.level), (0, 1));

    for action in [
        Action::Upgrade {
            target: TOILET,
            label: "upgrade the toilet".to_string(),
        },
        Action::Downgrade {
            target: TOILET,
            label: "downgrade the toilet".to_string(),
        },
    ] {
        let json = serde_json::to_string(&action).expect("the action serializes");
        let back: Action = serde_json::from_str(&json).expect("the action deserializes");
        assert_eq!(back, action);
    }
}

#[test]
fn agent_level_uses_the_highest_reached_threshold() {
    let cfg = Config::default();
    assert_eq!(agent_level(0, &cfg), 1);
    assert_eq!(agent_level(999, &cfg), 1);
    assert_eq!(agent_level(1000, &cfg), 2);
    assert_eq!(agent_level(2999, &cfg), 2);
    assert_eq!(agent_level(3000, &cfg), 3);
    assert_eq!(agent_level(20000, &cfg), 5);
    assert_eq!(agent_level(u32::MAX, &cfg), 5);
}
