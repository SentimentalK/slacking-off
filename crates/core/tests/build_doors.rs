//! Building, demolishing, doors and their memory/restore contracts.

use loo_core::{
    diff_worlds, is_usable, join, look, map, map_memory, restore, step, validate_build,
    validate_door, Action, ActionOutcome, Config, Event, EventKind, Intent, IntentKind,
    JoinCommand, Object, ObjectCause, SessionStatus, SiteKind, Snapshot, WorldState,
};
use loo_proto::{Need, Nick, Pos};

const FLOOR: &str = "\
grid
E.........
..........
..........
..........
";

fn build(text: &str) -> WorldState {
    WorldState::new(map::parse(text).expect("test map parses"))
}

fn nick(name: &str) -> Nick {
    Nick::parse(name).expect("valid nickname")
}

fn join_agent(world: &WorldState, cfg: &Config, agent: u64, name: &str) -> WorldState {
    let (next, ..) = join(
        world,
        &JoinCommand {
            agent,
            nick: nick(name),
            session: agent * 10,
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

fn door_intent(agent: u64, target: Pos, open: bool) -> Intent {
    Intent {
        agent,
        kind: IntentKind::Door { target, open },
    }
}

fn use_intent(agent: u64, target: Pos) -> Intent {
    Intent {
        agent,
        kind: IntentKind::Use { target },
    }
}

/// One enclosed toilet: walls north/west/south and a closed door east.
const STALL: &str = "\
grid
########
#.#....#
##1+...#
###..E.#
########
";

fn site_of(events: &[Event]) -> Vec<(Option<Object>, ObjectCause)> {
    events
        .iter()
        .filter_map(|event| match &event.kind {
            EventKind::ObjectChanged { object, cause, .. } => Some((*object, *cause)),
            _ => None,
        })
        .collect()
}

const STALL_TOILET: Pos = Pos::new(2, 2);
const STALL_DOOR: Pos = Pos::new(3, 2);
const STALL_NORTH_WALL: Pos = Pos::new(2, 1);

/// A user on the enclosed toilet and a demolisher at `demolisher_at`.
fn stalled_user(cfg: &Config, demolisher_at: Pos) -> WorldState {
    let mut world = build(STALL);
    world = claim(&world, cfg, 1, "dev-1");
    place(&mut world, 1, STALL_TOILET);
    world = claim(&world, cfg, 2, "dev-2");
    place(&mut world, 2, demolisher_at);
    let session = world.session_of(1).expect("session").id;
    let entry = world.sessions.get_mut(&session).expect("session");
    entry.need = Some(Need::Feces);
    entry.deadline = 1000;
    world
}

fn claim(world: &WorldState, cfg: &Config, agent: u64, name: &str) -> WorldState {
    join_agent(world, cfg, agent, name)
}

#[test]
fn wall_takes_two_ticks_and_blocks_as_a_site() {
    let cfg = Config::default();
    let mut world = build(FLOOR);
    world = claim(&world, &cfg, 1, "dev-1");
    place(&mut world, 1, Pos::new(1, 1));

    let (first, events) = step(
        &world,
        &[build_intent(1, SiteKind::Wall, Pos::new(2, 1))],
        1,
        &cfg,
    );
    let site = Object::Site {
        kind: SiteKind::Wall,
        work: 1,
    };
    assert_eq!(first.object_at(Pos::new(2, 1)), Some(site));
    assert_eq!(site.glyph(), 'x');
    assert!(site.blocks_movement(), "a wall site blocks movement");
    assert!(first.agents[&1].action.is_some(), "the build continues");
    assert_eq!(
        site_of(&events),
        vec![(
            Some(site),
            ObjectCause::Build {
                kind: SiteKind::Wall
            }
        )]
    );

    let (second, events) = step(&first, &[], 2, &cfg);
    assert_eq!(
        second.object_at(Pos::new(2, 1)),
        Some(Object::Wall { damage: 0 }),
        "the second tick finishes the wall"
    );
    assert_eq!(Object::Wall { damage: 0 }.glyph(), '#');
    assert!(second.agents[&1].action.is_none(), "the build finished");
    assert!(events.iter().any(|event| matches!(
        event.kind,
        EventKind::ActionFinished {
            outcome: ActionOutcome::Completed,
            ..
        }
    )));
}

#[test]
fn door_build_finishes_closed_and_look_shows_plus() {
    let cfg = Config::default();
    let mut world = build(FLOOR);
    world = claim(&world, &cfg, 1, "dev-1");
    place(&mut world, 1, Pos::new(1, 1));
    world = claim(&world, &cfg, 2, "dev-2");
    place(&mut world, 2, Pos::new(2, 0));
    // A holder on the adjacent toilet cell keeps the new door from auto-opening.
    world.set_object(
        Pos::new(2, 0),
        Some(Object::Toilet {
            level: 1,
            progress: 0,
        }),
    );

    let (first, _) = step(
        &world,
        &[build_intent(1, SiteKind::Door, Pos::new(2, 1))],
        1,
        &cfg,
    );
    assert_eq!(
        first.object_at(Pos::new(2, 1)),
        Some(Object::Site {
            kind: SiteKind::Door,
            work: 1
        })
    );
    let (second, _) = step(&first, &[], 2, &cfg);
    assert_eq!(
        second.object_at(Pos::new(2, 1)),
        Some(Object::Door {
            open: false,
            damage: 0,
        }),
        "a new door starts closed"
    );
    let view = look(&second, 1, &cfg).expect("agent 1 is inside");
    assert_eq!(
        view.grid.rows[4].chars().nth(5),
        Some('+'),
        "look shows a closed door: {:?}",
        view.grid.rows
    );
}

#[test]
fn two_builders_stack_on_one_toilet_site() {
    let cfg = Config::default();
    let mut world = build(FLOOR);
    world = claim(&world, &cfg, 1, "dev-1");
    place(&mut world, 1, Pos::new(1, 1));
    world = claim(&world, &cfg, 2, "dev-2");
    place(&mut world, 2, Pos::new(2, 2));

    let intents = [
        build_intent(1, SiteKind::Toilet, Pos::new(2, 1)),
        build_intent(2, SiteKind::Toilet, Pos::new(2, 1)),
    ];
    let (first, _) = step(&world, &intents, 1, &cfg);
    assert_eq!(
        first.object_at(Pos::new(2, 1)),
        Some(Object::Site {
            kind: SiteKind::Toilet,
            work: 1
        }),
        "toilet_work 3 minus two contributions"
    );

    let (second, _) = step(&first, &[], 2, &cfg);
    assert_eq!(
        second.object_at(Pos::new(2, 1)),
        Some(Object::Toilet {
            level: 1,
            progress: 0
        }),
        "both actions keep working and the site completes on tick 2"
    );
}

#[test]
fn build_validation_rejects_occupied_targets_and_distances() {
    let cfg = Config::default();
    let mut world = build(FLOOR);
    world = claim(&world, &cfg, 1, "dev-1");
    place(&mut world, 1, Pos::new(1, 1));

    world.set_object(
        Pos::new(2, 1),
        Some(Object::Site {
            kind: SiteKind::Toilet,
            work: 2,
        }),
    );
    let error = validate_build(&world, 1, SiteKind::Wall, Pos::new(2, 1), &cfg)
        .expect_err("a different site is in the way");
    assert!(error.contains("demolish"), "{error}");

    world.set_object(Pos::new(2, 1), Some(Object::Wall { damage: 1 }));
    let error = validate_build(&world, 1, SiteKind::Wall, Pos::new(2, 1), &cfg)
        .expect_err("a damaged wall is still in the way");
    assert!(error.contains("demolish"), "{error}");

    world.set_object(
        Pos::new(2, 1),
        Some(Object::Door {
            open: false,
            damage: 1,
        }),
    );
    let error = validate_build(&world, 1, SiteKind::Door, Pos::new(2, 1), &cfg)
        .expect_err("a damaged door is still in the way");
    assert!(error.contains("demolish"), "{error}");

    assert!(
        validate_build(&world, 1, SiteKind::Wall, Pos::new(3, 1), &cfg).is_err(),
        "a cell two steps away is out of reach"
    );
}

#[test]
fn build_rejects_no_build_terrain_agent_cells_and_distance() {
    let cfg = Config::default();
    let mut world = build("grid\nE:..\n....\n");
    world = claim(&world, &cfg, 1, "dev-1");
    place(&mut world, 1, Pos::new(2, 0));

    let error = validate_build(&world, 1, SiteKind::Wall, Pos::new(1, 0), &cfg)
        .expect_err("no-build terrain");
    assert!(error.contains("no-build"), "{error}");

    let error =
        validate_build(&world, 1, SiteKind::Wall, Pos::new(0, 1), &cfg).expect_err("too far away");
    assert!(error.contains("out of reach"), "{error}");

    let error = validate_build(&world, 1, SiteKind::Wall, Pos::new(2, 0), &cfg)
        .expect_err("the builder's own cell has an agent");
    assert!(error.contains("cell with an agent"), "{error}");

    let error = validate_build(&world, 1, SiteKind::Door, Pos::new(2, 0), &cfg)
        .expect_err("a door on the builder's own cell");
    assert!(error.contains("cell with an agent"), "{error}");
}

#[test]
fn demolishing_damages_wall_and_door_then_removes_them() {
    let cfg = Config::default();

    let mut world = build("grid\nE........\n..#......\n.........\n");
    world = claim(&world, &cfg, 1, "dev-1");
    place(&mut world, 1, Pos::new(1, 1));
    let (first, events) = step(&world, &[demolish_intent(1, Pos::new(2, 1))], 1, &cfg);
    let damaged = Object::Wall { damage: 1 };
    assert_eq!(first.object_at(Pos::new(2, 1)), Some(damaged));
    assert_eq!(damaged.glyph(), '#');
    assert!(damaged.blocks_movement(), "a damaged wall still blocks");
    assert_eq!(
        site_of(&events),
        vec![(Some(damaged), ObjectCause::Demolish)]
    );
    let text = events
        .iter()
        .find(|event| matches!(event.kind, EventKind::ObjectChanged { .. }))
        .expect("damage is announced")
        .text();
    assert!(text.contains("damage 1"), "{text}");
    let (second, _) = step(&first, &[], 2, &cfg);
    assert_eq!(second.object_at(Pos::new(2, 1)), None);
    assert!(second.agents[&1].action.is_none(), "the wall is gone");

    let mut world = build("grid\nE........\n.+1......\n.........\n");
    world = claim(&world, &cfg, 1, "dev-1");
    place(&mut world, 1, Pos::new(0, 1));
    world = claim(&world, &cfg, 2, "dev-2");
    place(&mut world, 2, Pos::new(2, 1));
    let (first, _) = step(&world, &[demolish_intent(1, Pos::new(1, 1))], 1, &cfg);
    let damaged = Object::Door {
        open: false,
        damage: 1,
    };
    assert_eq!(first.object_at(Pos::new(1, 1)), Some(damaged));
    assert_eq!(damaged.glyph(), '+');
    let (second, _) = step(&first, &[], 2, &cfg);
    assert_eq!(second.object_at(Pos::new(1, 1)), None);
}

#[test]
fn damaged_wall_keeps_enclosing_until_it_disappears() {
    let cfg = Config::default();
    let world = stalled_user(&cfg, Pos::new(3, 1));
    let (first, events) = step(
        &world,
        &[
            use_intent(1, STALL_TOILET),
            demolish_intent(2, STALL_NORTH_WALL),
        ],
        1,
        &cfg,
    );
    assert_eq!(
        first.object_at(STALL_NORTH_WALL),
        Some(Object::Wall { damage: 1 }),
        "the first hit leaves a damaged wall"
    );
    assert_eq!(
        first.object_at(STALL_NORTH_WALL).map(Object::glyph),
        Some('#')
    );
    assert!(
        is_usable(&first, STALL_TOILET),
        "damage does not break the enclosure"
    );
    assert!(
        events
            .iter()
            .any(|event| matches!(event.kind, EventKind::UseProgressed { .. })),
        "the use still progresses on the first hit"
    );

    let (second, events) = step(&first, &[], 2, &cfg);
    assert_eq!(second.object_at(STALL_NORTH_WALL), None);
    assert!(!is_usable(&second, STALL_TOILET), "the cell is open now");
    let session = second.session_of(1).expect("session survives");
    assert_eq!(
        session.use_ticks_done, 1,
        "the interrupted tick adds no progress"
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event.kind, EventKind::UseProgressed { .. }))
            .count(),
        0
    );
    assert!(
        events
            .iter()
            .any(|event| matches!(event.kind, EventKind::UseInterrupted { .. })),
        "losing the wall interrupts on the removal tick"
    );
    assert!(second.agents[&1].action.is_none());
}

#[test]
fn damaged_door_keeps_enclosing_and_can_still_be_worked() {
    let cfg = Config::default();
    let world = stalled_user(&cfg, Pos::new(4, 2));
    let (first, events) = step(
        &world,
        &[use_intent(1, STALL_TOILET), demolish_intent(2, STALL_DOOR)],
        1,
        &cfg,
    );
    assert_eq!(
        first.object_at(STALL_DOOR),
        Some(Object::Door {
            open: false,
            damage: 1
        })
    );
    assert!(
        is_usable(&first, STALL_TOILET),
        "a damaged closed door still encloses"
    );
    assert!(
        validate_door(&first, 1, STALL_DOOR, true).is_ok(),
        "damage does not remove the door's permissions"
    );
    assert!(
        events
            .iter()
            .any(|event| matches!(event.kind, EventKind::UseProgressed { .. })),
        "the first door hit does not interrupt"
    );

    let (second, events) = step(&first, &[], 2, &cfg);
    assert_eq!(second.object_at(STALL_DOOR), None);
    assert!(!is_usable(&second, STALL_TOILET));
    assert_eq!(
        second.session_of(1).expect("session").use_ticks_done,
        1,
        "the removal tick adds no progress"
    );
    assert!(
        events
            .iter()
            .any(|event| matches!(event.kind, EventKind::UseInterrupted { .. })),
        "the door disappearing interrupts the use"
    );
}

#[test]
fn demolishing_a_site_takes_one_tick() {
    let cfg = Config::default();
    let mut world = build(FLOOR);
    world = claim(&world, &cfg, 1, "dev-1");
    place(&mut world, 1, Pos::new(1, 1));
    world.set_object(
        Pos::new(2, 1),
        Some(Object::Site {
            kind: SiteKind::Toilet,
            work: 2,
        }),
    );
    let (next, _) = step(&world, &[demolish_intent(1, Pos::new(2, 1))], 1, &cfg);
    assert_eq!(next.object_at(Pos::new(2, 1)), None);
    assert!(next.agents[&1].action.is_none());
}

fn toilet_under_demolition(level: u8, progress: i32) -> (Config, WorldState) {
    let cfg = Config::default();
    let mut world = build("grid\nE........\n.1.......\n.........\n");
    world = claim(&world, &cfg, 1, "dev-1");
    place(&mut world, 1, Pos::new(1, 0));
    world.set_object(Pos::new(1, 1), Some(Object::Toilet { level, progress }));
    (cfg, world)
}

#[test]
fn demoting_a_toilet_walks_every_level_and_is_slower_than_level_one() {
    // Level 1: two ticks to empty, with a non-zero progress in between.
    let (cfg, world) = toilet_under_demolition(1, 0);
    let (first, _) = step(&world, &[demolish_intent(1, Pos::new(1, 1))], 1, &cfg);
    match first.object_at(Pos::new(1, 1)) {
        Some(Object::Toilet { level, progress }) => {
            assert_eq!(level, 1);
            assert_ne!(progress, 0, "demolition leaves a half-progress toilet");
        }
        other => panic!("expected a toilet, got {other:?}"),
    }
    let (second, _) = step(&first, &[], 2, &cfg);
    assert_eq!(second.object_at(Pos::new(1, 1)), None);
    let level_one_ticks = 2;

    // Level 2: it drops one level, then must spend the whole interval before it
    // is a complete level-1 toilet, and finally level 1 demolition work.
    let (cfg, world) = toilet_under_demolition(2, 0);
    let mut current = world;
    let mut snapshots = Vec::new();
    for seed in 1..=8 {
        if current.object_at(Pos::new(1, 1)).is_none() {
            break;
        }
        let intents: Vec<Intent> = if snapshots.is_empty() {
            vec![demolish_intent(1, Pos::new(1, 1))]
        } else {
            Vec::new()
        };
        let (next, _) = step(&current, &intents, seed, &cfg);
        snapshots.push(next.clone());
        current = next;
    }
    assert!(snapshots.len() > level_one_ticks, "level 2 takes longer");
    match snapshots[0].object_at(Pos::new(1, 1)) {
        Some(Object::Toilet { level, progress }) => {
            assert_eq!(level, 1, "one level per crossing");
            assert_ne!(progress, 0, "not a complete level 1 yet");
        }
        other => panic!("expected a toilet, got {other:?}"),
    }
    match snapshots[2].object_at(Pos::new(1, 1)) {
        Some(Object::Toilet { level, progress }) => {
            assert_eq!((level, progress), (1, 0), "three ticks to a stable level 1")
        }
        other => panic!("expected a toilet, got {other:?}"),
    }
    assert_eq!(current.object_at(Pos::new(1, 1)), None);
}

#[test]
fn only_an_agent_on_an_adjacent_toilet_cell_may_work_the_door() {
    let cfg = Config::default();
    let mut world = build("grid\nE........\n.1'......\n.........\n");
    world = claim(&world, &cfg, 1, "dev-1");
    place(&mut world, 1, Pos::new(1, 1));
    assert!(validate_door(&world, 1, Pos::new(2, 1), false).is_ok());

    let (closed, events) = step(&world, &[door_intent(1, Pos::new(2, 1), false)], 1, &cfg);
    assert_eq!(
        closed.object_at(Pos::new(2, 1)),
        Some(Object::Door {
            open: false,
            damage: 0,
        })
    );
    assert!(site_of(&events).contains(&(
        Some(Object::Door {
            open: false,
            damage: 0,
        }),
        ObjectCause::DoorClosed
    )));
    assert!(closed.agents[&1].action.is_none());

    world = claim(&world, &cfg, 2, "dev-2");
    place(&mut world, 2, Pos::new(3, 1));
    let error = validate_door(&world, 2, Pos::new(2, 1), true)
        .expect_err("an agent outside the stall cannot work its door");
    assert!(error.contains("adjacent toilet cell"), "{error}");

    let (after, events) = step(&world, &[door_intent(2, Pos::new(2, 1), true)], 2, &cfg);
    assert_eq!(
        after.object_at(Pos::new(2, 1)),
        Some(Object::Door {
            open: true,
            damage: 0,
        }),
        "the rejected attempt changes nothing"
    );
    let finished = events
        .iter()
        .find_map(|event| match &event.kind {
            EventKind::ActionFinished {
                outcome: ActionOutcome::Failed { reason },
                ..
            } => Some(reason.clone()),
            _ => None,
        })
        .expect("the rejected door action ends as failed");
    assert!(finished.contains("adjacent toilet cell"), "{finished}");
}

#[test]
fn doors_auto_open_unless_an_agent_sits_on_an_adjacent_toilet() {
    let cfg = Config::default();
    let mut world = build("grid\nE........\n.1+......\n.........\n");
    world = claim(&world, &cfg, 1, "dev-1");

    let (opened, events) = step(&world, &[], 1, &cfg);
    assert_eq!(
        opened.object_at(Pos::new(2, 1)),
        Some(Object::Door {
            open: true,
            damage: 0,
        }),
        "a door with no toilet visitor opens at the end of the tick"
    );
    let auto = events
        .iter()
        .find(|event| {
            matches!(
                event.kind,
                EventKind::ObjectChanged {
                    cause: ObjectCause::AutoOpened,
                    ..
                }
            )
        })
        .expect("the auto-open is announced");
    assert_eq!(auto.subject(), None, "nobody owns an automatic door change");

    let mut attended = world.clone();
    place(&mut attended, 1, Pos::new(1, 1));
    attended.set_object(
        Pos::new(2, 1),
        Some(Object::Door {
            open: false,
            damage: 0,
        }),
    );
    let (still_closed, _) = step(&attended, &[], 2, &cfg);
    assert_eq!(
        still_closed.object_at(Pos::new(2, 1)),
        Some(Object::Door {
            open: false,
            damage: 0,
        }),
        "an agent on the toilet cell holds the door closed"
    );

    let mut left = still_closed;
    place(&mut left, 1, Pos::new(5, 1));
    let (opened_late, events) = step(&left, &[], 3, &cfg);
    assert_eq!(
        opened_late.object_at(Pos::new(2, 1)),
        Some(Object::Door {
            open: true,
            damage: 0,
        })
    );
    assert!(events.iter().any(|event| matches!(
        event.kind,
        EventKind::ObjectChanged {
            cause: ObjectCause::AutoOpened,
            ..
        }
    )));
}

#[test]
fn closing_a_door_with_someone_in_the_doorway_is_rejected() {
    let cfg = Config::default();
    let mut world = build("grid\nE........\n.1'......\n.........\n");
    world = claim(&world, &cfg, 1, "dev-1");
    place(&mut world, 1, Pos::new(1, 1));
    world = claim(&world, &cfg, 2, "dev-2");
    place(&mut world, 2, Pos::new(2, 1));

    let (after, events) = step(&world, &[door_intent(1, Pos::new(2, 1), false)], 1, &cfg);
    assert_eq!(
        after.object_at(Pos::new(2, 1)),
        Some(Object::Door {
            open: true,
            damage: 0,
        }),
        "the door stays open"
    );
    let reason = events
        .iter()
        .find_map(|event| match &event.kind {
            EventKind::ActionFinished {
                outcome: ActionOutcome::Failed { reason },
                ..
            } => Some(reason.clone()),
            _ => None,
        })
        .expect("the close attempt fails");
    assert!(reason.contains("doorway"), "{reason}");
}

#[test]
fn restore_rebuilds_objects_and_first_seen_glyphs() {
    let cfg = Config::default();
    let mut world = build("grid\nE.........\n..........\n.1+.......\n..........\n");
    world = claim(&world, &cfg, 1, "dev-1");
    place(&mut world, 1, Pos::new(4, 0));
    world = claim(&world, &cfg, 2, "dev-2");
    place(&mut world, 2, Pos::new(1, 2));
    // A scenario builder that moves agents outside `step` must also mark their
    // views at the current tick, or restore's tick-boundary marking differs.
    for (agent, at) in [(1u64, Pos::new(4, 0)), (2, Pos::new(1, 2))] {
        let session = world.session_of(agent).expect("agent has a session").id;
        world.mark_seen(session, at, world.tick, cfg.view.width, cfg.view.height);
    }
    let initial = world.clone();

    let mut events = Vec::new();
    let mut current = world;
    let run = |current: &mut WorldState, intents: &[Intent], seed: u64, events: &mut Vec<Event>| {
        let (next, tick_events) = step(current, intents, seed, &cfg);
        *current = next;
        events.extend(tick_events);
    };
    run(
        &mut current,
        &[build_intent(1, SiteKind::Wall, Pos::new(4, 1))],
        1,
        &mut events,
    );
    run(&mut current, &[], 2, &mut events);
    run(
        &mut current,
        &[demolish_intent(1, Pos::new(4, 1))],
        3,
        &mut events,
    );
    run(&mut current, &[], 4, &mut events);
    run(
        &mut current,
        &[build_intent(1, SiteKind::Door, Pos::new(5, 0))],
        5,
        &mut events,
    );
    run(&mut current, &[], 6, &mut events);
    run(
        &mut current,
        &[door_intent(2, Pos::new(2, 2), true)],
        7,
        &mut events,
    );
    run(
        &mut current,
        &[door_intent(2, Pos::new(2, 2), false)],
        8,
        &mut events,
    );

    for cause in [
        ObjectCause::Build {
            kind: SiteKind::Wall,
        },
        ObjectCause::Demolish,
        ObjectCause::DoorOpened,
        ObjectCause::DoorClosed,
        ObjectCause::AutoOpened,
    ] {
        assert!(
            site_of(&events).iter().any(|(_, seen)| *seen == cause),
            "the run must cover {cause:?}"
        );
    }

    let restored = restore(&Snapshot::new(initial), &events, &cfg).expect("the log restores");
    let diffs = diff_worlds(&current, &restored);
    assert!(diffs.is_empty(), "restored world differs: {diffs:?}");
    assert_eq!(
        map_memory(&current, 1).map(|memory| memory.seen_at),
        map_memory(&restored, 1).map(|memory| memory.seen_at),
        "map memory ticks match"
    );
    let current_glyphs = &current.sessions[&10].seen_glyph;
    let restored_glyphs = &restored.sessions[&10].seen_glyph;
    assert_eq!(current_glyphs, restored_glyphs, "first-seen glyphs match");
}

#[test]
fn restore_keeps_partial_wall_damage() {
    let cfg = Config::default();
    let initial_world = build("grid\nE#\n");
    let world = claim(&initial_world, &cfg, 1, "dev-1");
    let start = world.clone();
    let (current, events) = step(&world, &[demolish_intent(1, Pos::new(1, 0))], 1, &cfg);
    assert_eq!(
        current.object_at(Pos::new(1, 0)),
        Some(Object::Wall { damage: 1 })
    );

    let restored = restore(&Snapshot::new(start), &events, &cfg).expect("damage restores");
    assert_eq!(
        restored.object_at(Pos::new(1, 0)),
        Some(Object::Wall { damage: 1 }),
        "the restored cell keeps its damage"
    );
    let diffs = diff_worlds(&current, &restored);
    assert!(diffs.is_empty(), "restored world differs: {diffs:?}");
}

#[test]
fn usable_toilets_reject_missing_walls_open_doors_and_unfinished_work() {
    let world = build("grid\n#####\n#1+.#\n###E#\n#####\n");
    let toilet = Pos::new(1, 1);
    assert!(
        is_usable(&world, toilet),
        "a fully enclosed toilet is usable"
    );

    let mut missing_wall = world.clone();
    missing_wall.set_object(Pos::new(1, 0), None);
    assert!(!is_usable(&missing_wall, toilet), "a missing wall");

    let mut open_door = world.clone();
    open_door.set_object(
        Pos::new(2, 1),
        Some(Object::Door {
            open: true,
            damage: 0,
        }),
    );
    assert!(!is_usable(&open_door, toilet), "an open door");

    let mut under_construction = world.clone();
    under_construction.set_object(
        toilet,
        Some(Object::Site {
            kind: SiteKind::Toilet,
            work: 1,
        }),
    );
    assert!(!is_usable(&under_construction, toilet), "a toilet site");

    let mut half_progress = world.clone();
    half_progress.set_object(
        toilet,
        Some(Object::Toilet {
            level: 1,
            progress: 2,
        }),
    );
    assert!(!is_usable(&half_progress, toilet), "a non-zero progress");
}

#[test]
fn cancel_stops_an_action_without_changing_the_world() {
    let cfg = Config::default();
    let mut world = build(FLOOR);
    world = claim(&world, &cfg, 1, "dev-1");
    place(&mut world, 1, Pos::new(1, 1));
    world.set_object(
        Pos::new(2, 1),
        Some(Object::Site {
            kind: SiteKind::Wall,
            work: 2,
        }),
    );
    let (building, _) = step(
        &world,
        &[build_intent(1, SiteKind::Wall, Pos::new(2, 1))],
        1,
        &cfg,
    );
    assert!(matches!(
        building.agents[&1].action,
        Some(Action::Build { .. })
    ));
    let (cancelled, events) = step(
        &building,
        &[Intent {
            agent: 1,
            kind: IntentKind::Cancel,
        }],
        2,
        &cfg,
    );
    assert!(cancelled.agents[&1].action.is_none());
    assert_eq!(
        cancelled.object_at(Pos::new(2, 1)),
        Some(Object::Site {
            kind: SiteKind::Wall,
            work: 1
        }),
        "the cancelled tick still did no work"
    );
    assert!(events.iter().any(|event| matches!(
        event.kind,
        EventKind::ActionFinished {
            outcome: ActionOutcome::Cancelled,
            ..
        }
    )));
}

#[test]
fn a_deadline_failure_opens_the_stall_door_in_the_same_tick() {
    let cfg = Config::default();
    let mut world = build(STALL);
    world = claim(&world, &cfg, 1, "dev-1");
    place(&mut world, 1, STALL_TOILET);
    let session = world.session_of(1).expect("session").id;
    let entry = world.sessions.get_mut(&session).expect("session");
    entry.need = Some(Need::Feces);
    entry.deadline = 1;
    assert_eq!(
        world.object_at(STALL_DOOR),
        Some(Object::Door {
            open: false,
            damage: 0
        })
    );

    let (end, events) = step(&world, &[], 1, &cfg);
    assert!(end.sessions.is_empty(), "the deadline ends the session");
    assert!(end.agents.is_empty());
    assert_eq!(
        end.object_at(STALL_DOOR),
        Some(Object::Door {
            open: true,
            damage: 0
        }),
        "the door opens in the same tick the person disappears"
    );
    let failed_seq = events
        .iter()
        .find(|event| matches!(event.kind, EventKind::UseFailed { .. }))
        .expect("the failure is recorded")
        .seq;
    let door_seq = events
        .iter()
        .find(|event| {
            matches!(
                event.kind,
                EventKind::ObjectChanged {
                    cause: ObjectCause::AutoOpened,
                    ..
                }
            )
        })
        .expect("the automatic open is recorded")
        .seq;
    assert!(
        failed_seq < door_seq,
        "the person goes before the door opens"
    );
}
