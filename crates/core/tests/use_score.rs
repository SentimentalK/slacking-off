//! Needs, using toilets, deadlines, scoring, leaving and their restore contract.

use loo_core::{
    diff_worlds, is_usable, join, leave, map, restore, session_score, step, validate_use,
    weighted_score, Action, ActionOutcome, Config, Event, EventKind, Intent, IntentKind,
    JoinCommand, Object, SessionStatus, Snapshot, WorldState,
};
use loo_proto::{Dir, Need, Nick, Pos, SessionOutcome, Tick};

/// Three toilets walled in on all four sides, plus an entrance below them. The
/// tests put agents on a toilet directly, so reachability does not matter here.
const TOILETS: &str = "\
grid
#######
#5#1#5#
#######
#E....#
#######
";

/// A toilet reachable through an open door: the agent walks in and closes the
/// door behind it, which is the only way to make an enclosed toilet in game.
const REACHABLE: &str = "\
grid
#######
#5'...#
#####.#
#E....#
#######
";

const FIVE: Pos = Pos::new(1, 1);
const ONE: Pos = Pos::new(3, 1);
const WALK_IN: Pos = Pos::new(1, 1);
const WALK_IN_DOOR: Pos = Pos::new(2, 1);

fn build(text: &str) -> WorldState {
    WorldState::new(map::parse(text).expect("test map parses"))
}

fn nick(name: &str) -> Nick {
    Nick::parse(name).expect("valid nickname")
}

fn claim(world: &WorldState, cfg: &Config, agent: u64) -> (WorldState, Vec<Event>) {
    let (next, _, events) = join(
        world,
        &JoinCommand {
            agent,
            nick: nick(&format!("dev-{agent}")),
            session: agent * 10,
        },
        cfg,
        0,
        0,
    )
    .expect("join accepted");
    (next, events)
}

fn put(world: &WorldState, agent: u64, at: Pos) -> WorldState {
    let mut next = world.clone();
    next.agents.get_mut(&agent).expect("agent exists").pos = Some(at);
    next
}

/// An agent standing on `at` with a known need and deadline. The scenario
/// builder replaces the need the join rolled, so a test can pick urine/feces.
fn armed(world: &WorldState, agent: u64, at: Pos, need: Need, deadline: Tick) -> WorldState {
    let mut next = world.clone();
    let session = next.session_of(agent).expect("agent has a session").id;
    next.agents.get_mut(&agent).expect("agent exists").pos = Some(at);
    let entry = next.sessions.get_mut(&session).expect("session exists");
    entry.status = SessionStatus::Inside;
    entry.need = Some(need);
    entry.deadline = deadline;
    next.entry_queue.retain(|queued| *queued != session);
    next
}

fn use_intent(agent: u64, target: Pos) -> Intent {
    Intent {
        agent,
        kind: IntentKind::Use { target },
    }
}

fn cancel_intent(agent: u64) -> Intent {
    Intent {
        agent,
        kind: IntentKind::Cancel,
    }
}

fn demolish_intent(agent: u64, target: Pos) -> Intent {
    Intent {
        agent,
        kind: IntentKind::Demolish { target },
    }
}

fn door_intent(agent: u64, target: Pos, open: bool) -> Intent {
    Intent {
        agent,
        kind: IntentKind::Door { target, open },
    }
}

fn move_intent(agent: u64, dirs: &[Dir]) -> Intent {
    Intent {
        agent,
        kind: IntentKind::Move {
            dirs: dirs.to_vec(),
            label: "test move".to_string(),
        },
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

fn count<F: Fn(&EventKind) -> bool>(events: &[Event], matches_kind: F) -> usize {
    events
        .iter()
        .filter(|event| matches_kind(&event.kind))
        .count()
}

fn find<F: Fn(&EventKind) -> bool>(events: &[Event], matches_kind: F) -> &Event {
    events
        .iter()
        .find(|event| matches_kind(&event.kind))
        .unwrap_or_else(|| panic!("no matching event in {events:?}"))
}

fn progress_ticks(events: &[Event]) -> Vec<u32> {
    events
        .iter()
        .filter_map(|event| match &event.kind {
            EventKind::UseProgressed { ticks_done, .. } => Some(*ticks_done),
            _ => None,
        })
        .collect()
}

#[test]
fn validate_use_requires_a_finished_enclosed_toilet() {
    let cfg = Config::default();
    let (world, _) = claim(&build(TOILETS), &cfg, 1);
    let world = put(&world, 1, FIVE);
    assert_eq!(validate_use(&world, 1, &cfg), Ok(FIVE));
    assert!(is_usable(&world, FIVE), "four walls enclose the toilet");

    let off = put(&world, 1, Pos::new(1, 3));
    let error = validate_use(&off, 1, &cfg).expect_err("not on a toilet");
    assert!(error.contains("stand on a toilet"), "{error}");

    let mut missing = world.clone();
    missing.set_object(Pos::new(1, 0), None);
    let error = validate_use(&missing, 1, &cfg).expect_err("a missing north wall");
    assert!(error.contains("north"), "{error}");
    assert!(error.contains("not enclosed"), "{error}");
    assert!(!is_usable(&missing, FIVE));

    let mut ajar = world.clone();
    ajar.set_object(Pos::new(2, 1), Some(Object::Door { open: true }));
    let error = validate_use(&ajar, 1, &cfg).expect_err("an open east door");
    assert!(error.contains("east door is open"), "{error}");
    assert!(!is_usable(&ajar, FIVE));

    let mut building = world.clone();
    building.set_object(
        FIVE,
        Some(Object::Toilet {
            level: 1,
            progress: 1,
        }),
    );
    let error = validate_use(&building, 1, &cfg).expect_err("unfinished toilet");
    assert!(error.contains("progress 1"), "{error}");
    assert!(!is_usable(&building, FIVE));

    let mut wall = world.clone();
    wall.set_object(FIVE, Some(Object::Wall));
    let error = validate_use(&wall, 1, &cfg).expect_err("a wall is not a toilet");
    assert!(error.contains("stand on a toilet"), "{error}");
}

#[test]
fn needs_are_assigned_at_join_and_at_admission_inside_the_configured_window() {
    let cfg = Config::default();
    let initial = build(TOILETS);
    let min = u64::from(cfg.need.deadline_ticks_min);
    let max = u64::from(cfg.need.deadline_ticks_max);

    let (after_a, a_events) = claim(&initial, &cfg, 1);
    let session_a = after_a.session_of(1).expect("session a").id;
    let need_a = after_a.sessions[&session_a].need.expect("immediate need");
    let deadline_a = after_a.sessions[&session_a].deadline;
    assert!(
        (min..=max).contains(&deadline_a),
        "deadline {deadline_a} is inside {min}..={max}"
    );
    assert!(matches!(need_a, Need::Urine | Need::Feces));
    let assigned = find(&a_events, |kind| {
        matches!(kind, EventKind::NeedAssigned { .. })
    });
    assert_eq!(assigned.tick, 0, "assigned in the join tick");
    assert!(matches!(
        assigned.kind,
        EventKind::NeedAssigned {
            session: 10,
            need: assigned_need,
            deadline: assigned_deadline,
            ..
        } if assigned_need == need_a && assigned_deadline == deadline_a
    ));

    // The same seed and session pick the same need and deadline again.
    let (again, _) = claim(&initial, &cfg, 1);
    assert_eq!(again.sessions[&session_a].need, Some(need_a));
    assert_eq!(again.sessions[&session_a].deadline, deadline_a);

    // A queued session has neither until it is admitted.
    let (queued, _) = claim(&after_a, &cfg, 2);
    let session_b = queued.session_of(2).expect("session b").id;
    assert_eq!(queued.sessions[&session_b].need, None);
    assert_eq!(queued.sessions[&session_b].deadline, 0);

    // The entrance is taken, so the queue only moves at tick 2, after agent 1
    // stepped east.
    let (world, _) = run(&queued, &[move_intent(1, &[Dir::E])], 1, &cfg);
    let (admitted, events) = run(&world, &[], 1, &cfg);
    let entry = &admitted.sessions[&session_b];
    assert_eq!(entry.status, SessionStatus::Inside);
    assert!(entry.need.is_some(), "admission assigns the need");
    assert!(
        (2 + min..=2 + max).contains(&entry.deadline),
        "admission at tick 2 assigns inside the window: {}",
        entry.deadline
    );
    let assigned = find(&events, |kind| {
        matches!(kind, EventKind::NeedAssigned { session: 20, .. })
    });
    assert_eq!(assigned.tick, 2);
}

#[test]
fn a_use_takes_four_ticks_for_urine_and_eight_for_feces() {
    for (need, ticks) in [(Need::Urine, 4u32), (Need::Feces, 8u32)] {
        let cfg = Config::default();
        let (world, _) = claim(&build(TOILETS), &cfg, 1);
        let world = armed(&world, 1, FIVE, need, 1000);
        let (end, events) = run(&world, &[use_intent(1, FIVE)], u64::from(ticks), &cfg);
        assert_eq!(
            progress_ticks(&events),
            (1..=ticks).collect::<Vec<_>>(),
            "one UseProgressed per tick for {need:?}"
        );
        assert_eq!(
            count(&events, |kind| matches!(
                kind,
                EventKind::UseProgressed { .. }
            )),
            ticks as usize
        );
        let succeeded = count(&events, |kind| {
            matches!(kind, EventKind::UseSucceeded { .. })
        });
        assert_eq!(succeeded, 1, "success is announced once");
        let session = end.session_of(1).expect("session survives");
        assert_eq!(session.outcome, Some(SessionOutcome::Success));
        assert_eq!(session.use_ticks_done, ticks);
        assert_eq!(
            session.linger_until,
            Some(u64::from(ticks) + u64::from(cfg.need.linger_ticks))
        );
        let event = find(&events, |kind| {
            matches!(kind, EventKind::UseSucceeded { .. })
        });
        assert_eq!(event.tick, u64::from(ticks));
        assert!(matches!(
            event.kind,
            EventKind::UseSucceeded { score, success_tick, .. }
                if score == session.score && success_tick == u64::from(ticks)
        ));
    }
}

#[test]
fn a_toilet_that_stops_being_usable_interrupts_the_use() {
    let cfg = Config::default();
    let (world, _) = claim(&build(TOILETS), &cfg, 1);
    let world = armed(&world, 1, FIVE, Need::Feces, 1000);
    let (world, events) = run(&world, &[use_intent(1, FIVE)], 3, &cfg);
    assert_eq!(progress_ticks(&events), vec![1, 2, 3]);

    // The north wall is demolished by something else: no progress, one window.
    let mut broken = world.clone();
    broken.set_object(Pos::new(1, 0), None);
    let (after, events) = run(&broken, &[], 1, &cfg);
    let session = after.session_of(1).expect("session survives");
    assert_eq!(session.use_ticks_done, 3, "the broken tick adds nothing");
    assert_eq!(session.recovery_deadline, Some(4 + 12));
    assert_eq!(
        count(&events, |kind| matches!(
            kind,
            EventKind::UseProgressed { .. }
        )),
        0
    );
    let interrupted = find(&events, |kind| {
        matches!(kind, EventKind::UseInterrupted { .. })
    });
    assert!(matches!(
        interrupted.kind,
        EventKind::UseInterrupted { recovery_deadline: 16, pos: Some(pos), .. } if pos == FIVE
    ));
    let reason = match &interrupted.kind {
        EventKind::UseInterrupted { reason, .. } => reason.clone(),
        _ => unreachable!(),
    };
    assert!(reason.contains("north"), "{reason}");
    assert!(after.agents[&1].action.is_none(), "no use action is left");

    let mut ajar = world.clone();
    ajar.set_object(Pos::new(2, 1), Some(Object::Door { open: true }));
    let (_, events) = run(&ajar, &[], 1, &cfg);
    let reason = match &find(&events, |kind| {
        matches!(kind, EventKind::UseInterrupted { .. })
    })
    .kind
    {
        EventKind::UseInterrupted { reason, .. } => reason.clone(),
        _ => unreachable!(),
    };
    assert!(reason.contains("east door is open"), "{reason}");

    let mut building = world.clone();
    building.set_object(
        FIVE,
        Some(Object::Toilet {
            level: 1,
            progress: 2,
        }),
    );
    let (_, events) = run(&building, &[], 1, &cfg);
    let reason = match &find(&events, |kind| {
        matches!(kind, EventKind::UseInterrupted { .. })
    })
    .kind
    {
        EventKind::UseInterrupted { reason, .. } => reason.clone(),
        _ => unreachable!(),
    };
    assert!(reason.contains("progress 2"), "{reason}");
}

#[test]
fn an_interrupted_use_resumes_on_another_toilet_with_its_progress() {
    let cfg = Config::default();
    let (world, _) = claim(&build(TOILETS), &cfg, 1);
    let world = armed(&world, 1, FIVE, Need::Feces, 1000);
    let (world, events) = run(&world, &[use_intent(1, FIVE)], 3, &cfg);
    assert_eq!(progress_ticks(&events), vec![1, 2, 3]);

    let (world, events) = run(&world, &[cancel_intent(1)], 1, &cfg);
    assert_eq!(
        count(&events, |kind| matches!(
            kind,
            EventKind::UseInterrupted { .. }
        )),
        1
    );
    let world = put(&world, 1, ONE);
    let (end, events) = run(&world, &[use_intent(1, ONE)], 5, &cfg);
    assert_eq!(
        count(&events, |kind| matches!(kind, EventKind::UseResumed { .. })),
        1,
        "the resume is announced"
    );
    assert_eq!(progress_ticks(&events), vec![4, 5, 6, 7, 8]);
    let session = end.session_of(1).expect("session");
    assert_eq!(session.outcome, Some(SessionOutcome::Success));
    assert_eq!(
        session.use_levels,
        vec![5, 5, 5, 1, 1, 1, 1, 1],
        "progress survives the interruption"
    );
    assert_eq!(session.score, session_score(session, &cfg, 9));
}

#[test]
fn score_weights_each_tick_by_its_toilet_level_and_pays_the_time_bonus() {
    let cfg = Config::default();
    assert_eq!(weighted_score(200, &[5, 5, 5, 5, 5, 5, 1, 1], &cfg), 1550);
    assert_eq!(weighted_score(200, &[], &cfg), 0, "no levels, no score");
    assert_eq!(weighted_score(200, &[0], &cfg), 0, "level 0 is invalid");
    assert_eq!(weighted_score(200, &[6], &cfg), 0, "level 6 is invalid");
    assert_eq!(
        weighted_score(201, &[2, 1], &cfg),
        302,
        "301.5 rounds half-up"
    );

    let (world, _) = claim(&build(TOILETS), &cfg, 1);
    let world = armed(&world, 1, FIVE, Need::Feces, 1000);
    let (world, _) = run(&world, &[use_intent(1, FIVE)], 6, &cfg);
    let (world, _) = run(&world, &[cancel_intent(1)], 1, &cfg);
    let world = put(&world, 1, ONE);
    let (end, events) = run(&world, &[use_intent(1, ONE)], 2, &cfg);
    let session = end.session_of(1).expect("session");
    assert_eq!(session.use_levels, vec![5, 5, 5, 5, 5, 5, 1, 1]);
    assert_eq!(session.outcome, Some(SessionOutcome::Success));
    assert_eq!(session.score, 1550 + (1000 - 9));
    assert_eq!(session.score, session_score(session, &cfg, 9));
    assert!(matches!(
        find(&events, |kind| matches!(
            kind,
            EventKind::UseSucceeded { .. }
        ))
        .kind,
        EventKind::UseSucceeded {
            score: 2541,
            success_tick: 9,
            linger_until: 45,
            ..
        }
    ));
}

#[test]
fn running_out_of_recovery_time_ends_the_session_as_failed_recovery() {
    let cfg = Config::default();
    let (world, _) = claim(&build(TOILETS), &cfg, 1);
    let world = armed(&world, 1, FIVE, Need::Feces, 1000);
    let (world, _) = run(&world, &[use_intent(1, FIVE)], 2, &cfg);
    let (world, _) = run(&world, &[cancel_intent(1)], 1, &cfg);
    assert_eq!(
        world.session_of(1).expect("session").recovery_deadline,
        Some(15),
        "cancel at tick 3 opens a 12 tick window"
    );

    let (world, _) = run(&world, &[], 11, &cfg);
    assert_eq!(world.tick, 14);
    assert_eq!(world.sessions.len(), 1, "the window is still open at 14");

    let (end, events) = run(&world, &[], 1, &cfg);
    assert_eq!(end.tick, 15);
    assert!(end.sessions.is_empty(), "the session is gone");
    assert!(end.agents.is_empty());
    assert_eq!(
        count(&events, |kind| matches!(
            kind,
            EventKind::SessionEnded { .. }
        )),
        1
    );
    assert!(matches!(
        find(&events, |kind| matches!(kind, EventKind::UseFailed { .. })).kind,
        EventKind::UseFailed {
            outcome: SessionOutcome::FailedRecovery,
            pos: Some(pos),
            ..
        } if pos == FIVE
    ));
}

#[test]
fn the_deadline_kills_a_use_that_is_one_tick_short_but_not_one_that_finishes() {
    let cfg = Config::default();
    let (world, _) = claim(&build(TOILETS), &cfg, 1);

    // Feces needs 8 ticks; a deadline of tick 8 lets the last tick finish.
    let on_time = armed(&world, 1, FIVE, Need::Feces, 8);
    let (end, events) = run(&on_time, &[use_intent(1, FIVE)], 8, &cfg);
    assert_eq!(
        end.session_of(1).expect("session").outcome,
        Some(SessionOutcome::Success),
        "a success on the deadline tick counts"
    );
    assert_eq!(
        count(&events, |kind| matches!(kind, EventKind::UseFailed { .. })),
        0
    );

    // A deadline of tick 7 kills the session before its eighth tick.
    let too_late = armed(&world, 1, FIVE, Need::Feces, 7);
    let (end, events) = run(&too_late, &[use_intent(1, FIVE)], 8, &cfg);
    assert!(end.sessions.is_empty());
    assert_eq!(progress_ticks(&events), vec![1, 2, 3, 4, 5, 6, 7]);
    assert!(matches!(
        find(&events, |kind| matches!(kind, EventKind::UseFailed { .. })).kind,
        EventKind::UseFailed {
            outcome: SessionOutcome::FailedDeadline,
            ..
        }
    ));
}

#[test]
fn the_deadline_wins_when_it_coincides_with_the_recovery_window() {
    let cfg = Config::default();
    let (world, _) = claim(&build(TOILETS), &cfg, 1);
    let world = armed(&world, 1, FIVE, Need::Feces, 15);
    let (world, _) = run(&world, &[use_intent(1, FIVE)], 2, &cfg);
    let (world, _) = run(&world, &[cancel_intent(1)], 1, &cfg);
    assert_eq!(
        world.session_of(1).expect("session").recovery_deadline,
        Some(15),
        "the window is capped by the deadline"
    );

    let (end, events) = run(&world, &[], 13, &cfg);
    assert!(end.sessions.is_empty());
    assert!(matches!(
        find(&events, |kind| matches!(kind, EventKind::UseFailed { .. })).kind,
        EventKind::UseFailed {
            outcome: SessionOutcome::FailedDeadline,
            ..
        }
    ));
}

#[test]
fn another_action_and_cancel_interrupt_a_use_without_losing_progress() {
    let cfg = Config::default();
    let (world, _) = claim(&build(TOILETS), &cfg, 1);
    let world = armed(&world, 1, FIVE, Need::Feces, 1000);
    let (world, _) = run(&world, &[use_intent(1, FIVE)], 2, &cfg);

    // A demolish replaces the use: announce the interruption before the replace.
    let (world, events) = run(&world, &[demolish_intent(1, Pos::new(1, 0))], 1, &cfg);
    let interrupted = find(&events, |kind| {
        matches!(kind, EventKind::UseInterrupted { .. })
    });
    let reason = match &interrupted.kind {
        EventKind::UseInterrupted {
            reason,
            recovery_deadline: 15,
            ..
        } => reason.clone(),
        other => panic!("expected an interruption with a 12 tick window, got {other:?}"),
    };
    assert!(reason.contains("replaced by"), "{reason}");
    assert!(reason.contains("demolish"), "{reason}");
    assert!(
        interrupted.seq
            < find(&events, |kind| matches!(
                kind,
                EventKind::ActionReplaced { .. }
            ))
            .seq,
        "the interruption comes before the replacement"
    );
    let session = world.session_of(1).expect("session");
    assert_eq!(session.use_ticks_done, 2, "the replaced tick adds nothing");
    assert!(matches!(
        world.agents[&1].action,
        Some(Action::Demolish { .. })
    ));

    // Cancel ends the running demolish normally.
    let (world, events) = run(&world, &[cancel_intent(1)], 1, &cfg);
    assert!(matches!(
        find(&events, |kind| matches!(
            kind,
            EventKind::ActionFinished { .. }
        ))
        .kind,
        EventKind::ActionFinished {
            outcome: ActionOutcome::Cancelled,
            ..
        }
    ));
    assert_eq!(
        world.session_of(1).expect("session").use_ticks_done,
        2,
        "cancel keeps the use progress"
    );

    // Cancel with nothing running changes nothing.
    let idle: Vec<Intent> = Vec::new();
    let (_, events) = run(&world, &[cancel_intent(1)], 1, &cfg);
    let quiet = build(TOILETS);
    let (_, baseline) = run(&quiet, &idle, 1, &cfg);
    assert_eq!(
        events.len(),
        baseline.len(),
        "an idle cancel is silent: {events:?}"
    );
}

#[test]
fn leave_ends_a_session_with_its_score_and_frees_the_slot() {
    let cfg = Config::default();
    let (world, _) = claim(&build(TOILETS), &cfg, 1);
    let tick = world.tick;
    let (end, outcome, score, events) = leave(&world, 1, 7, 3, &cfg).expect("leave accepted");
    assert_eq!(outcome, SessionOutcome::Left);
    assert_eq!(score, 0);
    assert_eq!(end.tick, tick, "leave does not move the tick");
    assert!(end.agents.is_empty());
    assert!(end.sessions.is_empty());
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].seq, 8);
    assert!(matches!(
        events[0].kind,
        EventKind::SessionEnded {
            outcome: SessionOutcome::Left,
            score: 0,
            ..
        }
    ));

    // A succeeded session leaves as a success with its score.
    let world = armed(&world, 1, FIVE, Need::Feces, 1000);
    let (world, _) = run(&world, &[use_intent(1, FIVE)], 8, &cfg);
    let expected = world.session_of(1).expect("session").score;
    let (end, outcome, score, events) = leave(&world, 1, 0, 0, &cfg).expect("leave accepted");
    assert_eq!(outcome, SessionOutcome::Success);
    assert_eq!(score, expected);
    assert!(matches!(
        events[0].kind,
        EventKind::SessionEnded {
            outcome: SessionOutcome::Success,
            score: leaked,
            ..
        } if leaked == expected
    ));
    assert!(end.sessions.is_empty());

    // A queued session can leave too, and drops out of the queue.
    let (inside, _) = claim(&end, &cfg, 2);
    let (waiting, _) = claim(&inside, &cfg, 3);
    assert_eq!(waiting.entry_queue.len(), 1);
    let (left, outcome, _, events) = leave(&waiting, 3, 0, 0, &cfg).expect("queued leave");
    assert_eq!(outcome, SessionOutcome::Left);
    assert_eq!(left.sessions.len(), 1, "only the inside session is left");
    assert!(left.sessions.contains_key(&20));
    assert_eq!(left.agents.get(&3), None);
    assert!(left.entry_queue.is_empty());
    assert!(matches!(
        events[0].kind,
        EventKind::SessionEnded { pos: None, .. }
    ));

    assert!(
        leave(&left, 99, 0, 0, &cfg).is_err(),
        "an unknown agent cannot leave"
    );
}

#[test]
fn a_successful_session_lingers_then_leaves_with_its_score() {
    let cfg = Config::default();
    let (world, _) = claim(&build(TOILETS), &cfg, 1);
    let world = armed(&world, 1, FIVE, Need::Feces, 1000);
    let (world, _) = run(&world, &[use_intent(1, FIVE)], 8, &cfg);
    let session = world.session_of(1).expect("session");
    let linger_until = session.linger_until.expect("success lingers");
    let score = session.score;
    assert_eq!(linger_until, 8 + u64::from(cfg.need.linger_ticks));

    let (world, _) = run(&world, &[], linger_until - 1 - world.tick, &cfg);
    assert_eq!(world.tick, linger_until - 1);
    assert_eq!(world.sessions.len(), 1, "still lingering one tick before");

    let (end, events) = run(&world, &[], 1, &cfg);
    assert!(end.sessions.is_empty(), "the linger ends the session");
    assert!(matches!(
        find(&events, |kind| matches!(kind, EventKind::SessionEnded { .. })).kind,
        EventKind::SessionEnded {
            outcome: SessionOutcome::Success,
            score: leaked,
            ..
        } if leaked == score
    ));
}

#[test]
fn the_deadline_warning_is_sent_once_ten_ticks_before_the_deadline() {
    let cfg = Config::default();
    let (world, _) = claim(&build(TOILETS), &cfg, 1);
    let world = armed(&world, 1, FIVE, Need::Feces, 20);
    let (world, events) = run(&world, &[], 12, &cfg);
    let remaining: Vec<u32> = events
        .iter()
        .filter_map(|event| match &event.kind {
            EventKind::DeadlineWarning { remaining, .. } => Some(*remaining),
            _ => None,
        })
        .collect();
    assert_eq!(remaining, vec![10], "warned once at ten ticks left");
    assert_eq!(world.tick, 12);

    let (_, events) = run(&world, &[], 3, &cfg);
    assert_eq!(
        count(&events, |kind| matches!(
            kind,
            EventKind::DeadlineWarning { .. }
        )),
        0,
        "the warning never repeats"
    );
}

#[test]
fn a_full_need_and_use_log_restores_the_world_exactly() {
    let cfg = Config::default();
    let initial = build(REACHABLE);
    let (mut world, join_events) = claim(&initial, &cfg, 1);
    let session = world.session_of(1).expect("session").id;
    let use_ticks = match world.sessions[&session].need {
        Some(Need::Urine) => 4u64,
        Some(Need::Feces) => 8u64,
        None => panic!("a join assigns a need"),
    };

    let path = [
        Dir::E,
        Dir::E,
        Dir::E,
        Dir::E,
        Dir::N,
        Dir::N,
        Dir::W,
        Dir::W,
        Dir::W,
        Dir::W,
    ];
    let mut events = join_events;
    let mut snapshots: Vec<(Tick, WorldState, u32)> = Vec::new();
    let none: Vec<Intent> = Vec::new();
    for tick in 1..=60u64 {
        let submitted = match tick {
            1 => vec![move_intent(1, &path)],
            11 => vec![door_intent(1, WALK_IN_DOOR, false)],
            12 | 16 => vec![use_intent(1, WALK_IN)],
            15 => vec![cancel_intent(1)],
            _ => none.clone(),
        };
        let (next, log) = step(&world, &submitted, 700 + tick, &cfg);
        world = next;
        events.extend(log);
        if tick == 15 || tick == 40 {
            let last_seq = events
                .iter()
                .filter(|event| event.tick <= tick)
                .map(|event| event.seq)
                .max()
                .unwrap_or(0);
            snapshots.push((tick, world.clone(), last_seq));
        }
    }

    for kind in [
        "NeedAssigned",
        "UseStarted",
        "UseProgressed",
        "UseInterrupted",
        "UseResumed",
        "UseSucceeded",
        "SessionEnded",
    ] {
        assert!(
            events.iter().any(|event| event.kind.name() == kind),
            "the run must cover {kind}"
        );
    }
    assert!(
        events.iter().any(|event| matches!(
            event.kind,
            EventKind::UseProgressed { ticks_done, .. } if ticks_done == 3
        )),
        "three ticks of progress happened before the interruption"
    );
    assert!(world.sessions.is_empty(), "the lingering session ended");
    assert_eq!(
        progress_ticks(&events).len() as u64,
        use_ticks,
        "the interrupted and resumed use adds up to one full use"
    );

    let from_zero = restore(&Snapshot::new(initial), &events, &cfg).expect("full log restores");
    let diffs = diff_worlds(&world, &from_zero);
    assert!(diffs.is_empty(), "restore from tick 0 differs: {diffs:?}");

    for (tick, snapshot_world, last_seq) in snapshots {
        let late: Vec<Event> = events
            .iter()
            .filter(|event| event.tick > tick)
            .cloned()
            .collect();
        let restored = restore(&Snapshot::at(snapshot_world, last_seq), &late, &cfg)
            .expect("snapshot plus events restores");
        let diffs = diff_worlds(&world, &restored);
        assert!(
            diffs.is_empty(),
            "restore from tick {tick} differs: {diffs:?}"
        );
    }
}
