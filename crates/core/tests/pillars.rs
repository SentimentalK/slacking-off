//! The 3x3 toilet rule (design §20): corner pillars, the start checks, what a
//! pillar blocks, and the events that raise and clear them.

use loo_core::map;
use loo_core::state::toilet_corners;
use loo_core::{
    diff_worlds, join, restore, step, validate_build, validate_defend, validate_demolish,
    validate_use, ActionOutcome, Blocker, Config, Event, EventKind, Intent, IntentKind,
    JoinCommand, Object, ObjectCause, SessionStatus, SiteKind, Snapshot, WorldState,
};
use loo_proto::{Dir, Nick, Pos};

const FIELD: &str = "\
grid
..........
..........
..........
E.........
..........
..........
";

const NORTH_WEST: Pos = Pos::new(3, 1);
const NORTH_EAST: Pos = Pos::new(5, 1);
const SOUTH_WEST: Pos = Pos::new(3, 3);
const SOUTH_EAST: Pos = Pos::new(5, 3);
const TOILET: Pos = Pos::new(4, 2);
const CORNERS: [Pos; 4] = [NORTH_WEST, NORTH_EAST, SOUTH_WEST, SOUTH_EAST];

/// Test maps describe the field only; a map that declares no queue cells gets
/// two lanes under the entrance row, as in `build_doors.rs`.
fn with_queue(text: &str) -> String {
    let mut lines = text.lines();
    let mut prefix: Vec<&str> = Vec::new();
    let mut rows: Vec<String> = Vec::new();
    let mut seen_grid = false;
    for line in lines.by_ref() {
        if !seen_grid {
            if line.trim() == "grid" {
                seen_grid = true;
            } else {
                prefix.push(line);
            }
            continue;
        }
        if !line.trim().is_empty() {
            rows.push(line.to_string());
        }
    }
    if rows
        .iter()
        .any(|row| row.contains('q') || row.contains('r'))
    {
        return text.to_string();
    }
    let width = rows.first().map_or(0, |row| row.chars().count());
    let (ex, ey) = rows
        .iter()
        .enumerate()
        .find_map(|(y, row)| row.chars().position(|ch| ch == 'E').map(|x| (x, y)))
        .expect("test map has an entrance");
    let lane = |ch: char| format!("{}{}", "#".repeat(ex), ch.to_string().repeat(width - ex));
    rows.insert(ey + 1, lane('q'));
    rows.insert(ey + 2, lane('r'));
    let mut out = prefix.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    out.push_str("grid\n");
    out.push_str(&rows.join("\n"));
    out.push('\n');
    out
}

fn build(text: &str) -> WorldState {
    let text = with_queue(text);
    WorldState::new(map::parse(&text).expect("test map parses"))
}

fn nick(name: &str) -> Nick {
    Nick::parse(name).expect("valid nickname")
}

fn claim(world: &WorldState, cfg: &Config, agent: u64, name: &str) -> WorldState {
    let (next, ..) = join(
        world,
        &JoinCommand {
            agent,
            nick: nick(name),
            session: agent * 10,
            score_total: 0,
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
    world
        .sessions
        .get_mut(&session)
        .expect("session exists")
        .status = SessionStatus::Inside;
    world.entry_queue.retain(|queued| *queued != session);
}

fn build_intent(agent: u64, kind: SiteKind, target: Pos) -> Intent {
    Intent {
        agent,
        kind: IntentKind::Build { kind, target },
    }
}

fn demolish_intent(agent: u64, target: Pos) -> Intent {
    Intent {
        agent,
        kind: IntentKind::Demolish { target },
    }
}

/// A builder at (3,2), the west side of the toilet cell (4,2).
fn builder_world(cfg: &Config) -> WorldState {
    let mut world = claim(&build(FIELD), cfg, 1, "dev-1");
    place(&mut world, 1, Pos::new(3, 2));
    world
}

/// The toilet at (4,2) with its four corners already pillars.
fn toilet_with_pillars(world: &mut WorldState, object: Object) {
    world.set_object(TOILET, Some(object));
    for corner in CORNERS {
        world.set_object(corner, Some(Object::Pillar));
    }
}

/// Asserts the toilet at `toilet` leaves in this tick and that its four corner
/// pillars leave right after it, NW NE SW SE, with the demolisher's identity.
fn assert_pillars_cleared(events: &[Event], toilet: Pos, agent: u64) {
    let at = events
        .iter()
        .position(|event| {
            matches!(
                &event.kind,
                EventKind::ObjectChanged { pos, object: None, .. } if *pos == toilet
            )
        })
        .expect("the toilet is removed");
    for (offset, corner) in toilet_corners(toilet).iter().enumerate() {
        match events.get(at + 1 + offset).map(|event| &event.kind) {
            Some(EventKind::ObjectChanged {
                agent: event_agent,
                pos,
                object: None,
                cause: ObjectCause::Demolish,
                ..
            }) if pos == corner => {
                assert_eq!(
                    *event_agent,
                    Some(agent),
                    "the pillar removal names the demolisher"
                );
            }
            other => panic!("expected pillar removal at {corner}, got {other:?}"),
        }
    }
}

#[test]
fn starting_a_toilet_raises_its_corner_pillars_right_after_the_site() {
    let cfg = Config::default();
    let world = builder_world(&cfg);

    let (next, events) = step(
        &world,
        &[build_intent(1, SiteKind::Toilet, TOILET)],
        1,
        &cfg,
    );
    let site_at = events
        .iter()
        .position(|event| {
            matches!(
                &event.kind,
                EventKind::ObjectChanged { pos, object: Some(Object::Site { .. }), .. }
                    if *pos == TOILET
            )
        })
        .expect("the toilet site is announced");
    for (offset, corner) in CORNERS.iter().enumerate() {
        match &events[site_at + 1 + offset].kind {
            EventKind::ObjectChanged {
                session,
                agent,
                nick,
                pos,
                object,
                cause,
            } => {
                assert_eq!(pos, corner, "pillars come NW NE SW SE");
                assert_eq!(*object, Some(Object::Pillar));
                assert_eq!(
                    *cause,
                    ObjectCause::Build {
                        kind: SiteKind::Toilet
                    }
                );
                assert_eq!(*session, Some(10));
                assert_eq!(*agent, Some(1));
                assert_eq!(nick.as_deref(), Some("dev-1"));
            }
            other => panic!("expected a pillar event, got {other:?}"),
        }
    }
    for corner in CORNERS {
        assert_eq!(next.object_at(corner), Some(Object::Pillar));
    }
    assert_eq!(
        next.object_at(TOILET),
        Some(Object::Site {
            kind: SiteKind::Toilet,
            work: 2
        })
    );
}

#[test]
fn demolishing_a_level_one_toilet_to_nothing_clears_its_pillars_in_that_tick() {
    let cfg = Config::default();
    let mut world = builder_world(&cfg);
    toilet_with_pillars(
        &mut world,
        Object::Toilet {
            level: 1,
            progress: 0,
        },
    );

    let mut current = world;
    let mut intents = vec![demolish_intent(1, TOILET)];
    for seed in 1..=10u64 {
        let (next, events) = step(&current, &intents, seed, &cfg);
        intents.clear();
        if next.object_at(TOILET).is_none() {
            assert_pillars_cleared(&events, TOILET, 1);
            for corner in CORNERS {
                assert_eq!(next.object_at(corner), None, "pillar at {corner} is gone");
            }
            return;
        }
        current = next;
    }
    panic!("the toilet was never removed");
}

#[test]
fn demolishing_a_toilet_site_clears_its_pillars_in_the_same_tick() {
    let cfg = Config::default();
    let mut world = builder_world(&cfg);
    toilet_with_pillars(
        &mut world,
        Object::Site {
            kind: SiteKind::Toilet,
            work: 2,
        },
    );

    let (next, events) = step(&world, &[demolish_intent(1, TOILET)], 1, &cfg);
    assert_eq!(next.object_at(TOILET), None);
    assert_pillars_cleared(&events, TOILET, 1);
    for corner in CORNERS {
        assert_eq!(next.object_at(corner), None);
    }
}

#[test]
fn a_wall_on_a_corner_refuses_the_toilet() {
    let cfg = Config::default();
    let mut world = builder_world(&cfg);
    world.set_object(NORTH_WEST, Some(Object::Wall { damage: 0 }));
    let error = validate_build(&world, 1, SiteKind::Toilet, TOILET, &cfg)
        .expect_err("a wall sits on a corner");
    assert!(
        error.contains("corner (3,1) of the toilet's 3x3 has a wall"),
        "{error}"
    );
}

#[test]
fn an_agent_on_a_corner_refuses_the_toilet() {
    let cfg = Config::default();
    let mut world = builder_world(&cfg);
    let mut bystander = claim(&world, &cfg, 2, "dev-2");
    place(&mut bystander, 2, SOUTH_EAST);
    world = bystander;
    let error = validate_build(&world, 1, SiteKind::Toilet, TOILET, &cfg)
        .expect_err("an agent stands on a corner");
    assert!(
        error.contains("corner (5,3) of the toilet's 3x3 has an agent on it"),
        "{error}"
    );
}

#[test]
fn a_no_build_corner_refuses_the_toilet() {
    let cfg = Config::default();
    let text = "grid\n..........\n.....:....\n..........\nE.........\n";
    let mut world = claim(&build(text), &cfg, 1, "dev-1");
    place(&mut world, 1, Pos::new(3, 2));
    let error = validate_build(&world, 1, SiteKind::Toilet, TOILET, &cfg)
        .expect_err("a corner is no-build ground");
    assert!(
        error.contains("corner (5,1) of the toilet's 3x3 is no-build ground"),
        "{error}"
    );
}

#[test]
fn a_toilet_whose_3x3_leaves_the_map_is_refused() {
    let cfg = Config::default();
    let mut world = claim(&build(FIELD), &cfg, 1, "dev-1");
    place(&mut world, 1, Pos::new(1, 2));
    let error = validate_build(&world, 1, SiteKind::Toilet, Pos::new(0, 2), &cfg)
        .expect_err("the west column is outside the map");
    assert!(
        error.contains("a toilet needs its whole 3x3 inside the map"),
        "{error}"
    );
}

#[test]
fn a_toilet_two_cells_from_another_overlaps_it_but_three_cells_do_not() {
    let cfg = Config::default();
    let mut world = builder_world(&cfg);
    world.set_object(
        Pos::new(6, 2),
        Some(Object::Toilet {
            level: 1,
            progress: 0,
        }),
    );
    let error = validate_build(&world, 1, SiteKind::Toilet, TOILET, &cfg)
        .expect_err("the other toilet's 3x3 overlaps");
    assert!(
        error.contains("this toilet's 3x3 overlaps the 3x3 of the toilet at (6,2)"),
        "{error}"
    );

    let mut far = builder_world(&cfg);
    far.set_object(
        Pos::new(7, 2),
        Some(Object::Toilet {
            level: 1,
            progress: 0,
        }),
    );
    assert!(
        validate_build(&far, 1, SiteKind::Toilet, TOILET, &cfg).is_ok(),
        "a toilet three cells away may start"
    );
}

#[test]
fn a_pillar_stops_a_walker_and_says_so() {
    let cfg = Config::default();
    let mut world = claim(&build(FIELD), &cfg, 1, "dev-1");
    place(&mut world, 1, Pos::new(2, 3));
    toilet_with_pillars(
        &mut world,
        Object::Toilet {
            level: 1,
            progress: 0,
        },
    );

    let intents = [Intent {
        agent: 1,
        kind: IntentKind::Move {
            dirs: vec![Dir::E],
            label: "walk".to_string(),
        },
    }];
    let (next, events) = step(&world, &intents, 1, &cfg);
    assert_eq!(
        next.agents[&1].pos,
        Some(Pos::new(2, 3)),
        "the walker stays put"
    );
    let blocked = events.iter().find_map(|event| match &event.kind {
        EventKind::ActionFinished {
            outcome: ActionOutcome::Blocked { by },
            ..
        } => Some(by.clone()),
        _ => None,
    });
    assert_eq!(blocked, Some(Blocker::Pillar));
    assert_eq!(Blocker::Pillar.describe(), "a pillar");
}

#[test]
fn a_pillar_cannot_be_demolished_built_on_or_defended() {
    let cfg = Config::default();
    let mut world = builder_world(&cfg);
    toilet_with_pillars(
        &mut world,
        Object::Toilet {
            level: 1,
            progress: 0,
        },
    );

    let error = validate_demolish(&world, 1, NORTH_WEST).expect_err("a pillar stays");
    assert!(
        error.contains("a pillar cannot be demolished; it goes when the toilet at (4,2) is gone"),
        "{error}"
    );

    let error = validate_build(&world, 1, SiteKind::Wall, NORTH_WEST, &cfg)
        .expect_err("a pillar cannot be built on");
    assert!(
        error.contains(
            "a pillar is there; it belongs to the toilet next to it and cannot be built on"
        ),
        "{error}"
    );

    let error = validate_defend(&world, 1, NORTH_WEST).expect_err("a pillar cannot be defended");
    assert!(error.contains("a pillar cannot be defended"), "{error}");
}

/// A toilet at (4,2) enclosed by walls north, west and south and a closed door
/// east; `corners` decides whether its four corner cells are pillars.
fn enclosed_toilet(corners: bool) -> WorldState {
    let cfg = Config::default();
    let mut world = claim(&build(FIELD), &cfg, 1, "dev-1");
    world.set_object(
        TOILET,
        Some(Object::Toilet {
            level: 1,
            progress: 0,
        }),
    );
    world.set_object(Pos::new(4, 1), Some(Object::Wall { damage: 0 }));
    world.set_object(Pos::new(3, 2), Some(Object::Wall { damage: 0 }));
    world.set_object(Pos::new(4, 3), Some(Object::Wall { damage: 0 }));
    world.set_object(
        Pos::new(5, 2),
        Some(Object::Door {
            open: false,
            damage: 0,
        }),
    );
    if corners {
        for corner in CORNERS {
            world.set_object(corner, Some(Object::Pillar));
        }
    }
    place(&mut world, 1, TOILET);
    world
}

#[test]
fn enclosure_is_checked_the_same_with_or_without_corner_pillars() {
    let cfg = Config::default();
    let with = enclosed_toilet(true);
    let without = enclosed_toilet(false);
    assert_eq!(validate_use(&with, 1, &cfg), Ok(TOILET));
    assert_eq!(validate_use(&without, 1, &cfg), Ok(TOILET));
}

#[test]
fn a_missing_side_is_still_named_with_corner_pillars_present() {
    let cfg = Config::default();
    let mut world = enclosed_toilet(true);
    world.set_object(Pos::new(4, 1), None);
    let error = validate_use(&world, 1, &cfg).expect_err("the north side is open");
    assert!(
        error.contains("the north side is not enclosed by a wall or a closed door"),
        "{error}"
    );
}

#[test]
fn replay_rebuilds_the_pillars_appearing_and_disappearing() {
    let cfg = Config::default();
    let (start, idle) = step(&builder_world(&cfg), &[], 99, &cfg);
    let snapshot = Snapshot {
        world: start.clone(),
        last_seq: idle.last().map_or(0, |event| event.seq),
        seed: 99,
    };

    let mut current = start;
    let mut events: Vec<Event> = Vec::new();
    for seed in 1..=10u64 {
        let mut intents = Vec::new();
        if seed == 1 {
            intents.push(build_intent(1, SiteKind::Toilet, TOILET));
        }
        if seed == 4 {
            intents.push(demolish_intent(1, TOILET));
        }
        let (next, tick_events) = step(&current, &intents, seed, &cfg);
        events.extend(tick_events);
        current = next;
    }
    assert_eq!(current.object_at(TOILET), None, "the toilet came down");
    for corner in CORNERS {
        assert_eq!(
            current.object_at(corner),
            None,
            "pillar at {corner} came down"
        );
    }
    let raised = events
        .iter()
        .filter(|event| {
            matches!(
                &event.kind,
                EventKind::ObjectChanged {
                    object: Some(Object::Pillar),
                    ..
                }
            )
        })
        .count();
    assert_eq!(raised, 4, "four pillars were raised");

    let rebuilt = restore(&snapshot, &events, &cfg).expect("the event log replays");
    let diffs = diff_worlds(&rebuilt, &current);
    assert!(diffs.is_empty(), "replay diverged: {diffs:?}");
}
