//! Engine-level acceptance tests for step 0 (design §13 第 0 步).

use loo_core::{
    diff_worlds, join, look, map, map_memory, replay, restore, step, ActionOutcome, Blocker,
    Config, Event, EventKind, Intent, IntentKind, JoinCommand, JoinOutcome, JoinRejectKind, Object,
    SessionStatus, SiteKind, WorldState,
};
use loo_proto::{Dir, Nick, Pos, Tick};
use std::collections::BTreeMap;

const DEFAULT_MAP: &str = include_str!("../../../maps/default.txt");

fn build(text: &str) -> WorldState {
    WorldState::new(map::parse(text).expect("test map parses"))
}

fn nick(name: &str) -> Nick {
    Nick::parse(name).expect("valid nickname")
}

fn join_agent(world: &WorldState, cfg: &Config, agent: u64, name: &str) -> WorldState {
    let (next, outcome) = join(
        world,
        &JoinCommand {
            agent,
            nick: nick(name),
            session: agent * 10,
        },
        cfg,
    )
    .expect("join accepted");
    assert!(matches!(
        outcome,
        JoinOutcome::Inside { .. } | JoinOutcome::Waiting { .. }
    ));
    next
}

fn move_intent(agent: u64, dirs: &[Dir]) -> Intent {
    labeled_move(agent, dirs, "test move")
}

fn labeled_move(agent: u64, dirs: &[Dir], label: &str) -> Intent {
    Intent {
        agent,
        kind: IntentKind::Move {
            dirs: dirs.to_vec(),
            label: label.to_string(),
        },
    }
}

/// Settles `ticks` ticks, submitting `intents` only on the first one.
fn run_ticks(
    world: &WorldState,
    intents: &[Intent],
    ticks: u64,
    seed: u64,
    cfg: &Config,
) -> (WorldState, Vec<Event>) {
    let mut world = world.clone();
    let mut events = Vec::new();
    let none: Vec<Intent> = Vec::new();
    for tick in 0..ticks {
        let submitted = if tick == 0 { intents } else { &none };
        let (next, log) = step(&world, submitted, seed + tick, cfg);
        world = next;
        events.extend(log);
    }
    (world, events)
}

fn finished_for(events: &[Event], agent: u64) -> &Event {
    find_event(
        events,
        |kind| matches!(kind, EventKind::ActionFinished { agent: a, .. } if *a == agent),
    )
}

fn moved_for(events: &[Event], agent: u64) -> &Event {
    find_event(
        events,
        |kind| matches!(kind, EventKind::AgentMoved { agent: a, .. } if *a == agent),
    )
}

fn pos_of(world: &WorldState, agent: u64) -> Pos {
    world.agents[&agent].pos.expect("agent is on the map")
}

/// The single event of a kind the test cares about; `TickSettled` and other
/// bookkeeping events must not shift indices.
fn find_event<F: Fn(&EventKind) -> bool>(events: &[Event], matches_kind: F) -> &Event {
    events
        .iter()
        .find(|e| matches_kind(&e.kind))
        .unwrap_or_else(|| panic!("no matching event in {events:?}"))
}

fn finished_event(events: &[Event]) -> &Event {
    find_event(events, |kind| {
        matches!(kind, EventKind::ActionFinished { .. })
    })
}

/// Puts an agent on a cell directly, as a scenario builder would: no join
/// ceremony, no queue.
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

/// The order `step` settles agents in for one seed.
fn settlement_order(agents: &[u64], seed: u64) -> Vec<u64> {
    let mut order = agents.to_vec();
    loo_core::rng::shuffle(&mut order, seed);
    order
}

const CORRIDOR: &str = "\
grid
.......
.E.....
.......
";

#[test]
fn one_cell_per_tick_until_path_done() {
    let cfg = Config::default();
    let world = join_agent(&build(CORRIDOR), &cfg, 1, "dev-1");
    assert_eq!(pos_of(&world, 1), Pos::new(1, 1));

    let (next, events) = step(&world, &[move_intent(1, &[Dir::E, Dir::E])], 11, &cfg);
    assert_eq!(pos_of(&next, 1), Pos::new(2, 1));
    assert_eq!(next.agents[&1].action.as_ref().unwrap().remaining(), 1);
    assert_eq!(events[0].tick, 1);
    assert_eq!(events[0].seq, 1);
    assert!(
        matches!(events[0].kind, EventKind::TickSettled),
        "every tick opens with its settlement marker"
    );
    let moved = find_event(&events, |kind| matches!(kind, EventKind::AgentMoved { .. }));
    assert_eq!(moved.seed, 11);
    assert_eq!(moved.subject(), Some(1));

    let (next, events) = step(&next, &[], 12, &cfg);
    assert_eq!(pos_of(&next, 1), Pos::new(3, 1));
    assert!(next.agents[&1].action.is_none(), "path finished");
    assert!(matches!(
        events.last().unwrap().kind,
        EventKind::ActionFinished {
            outcome: ActionOutcome::Completed,
            ..
        }
    ));
}

#[test]
fn blocked_move_stops_and_explains() {
    let cfg = Config::default();
    let walls = "\
grid
#.#
#E#
###
";
    let world = join_agent(&build(walls), &cfg, 1, "dev-1");
    // East is a door? No: (2,1) is a wall.
    let (next, events) = step(&world, &[move_intent(1, &[Dir::E, Dir::E])], 5, &cfg);
    assert_eq!(pos_of(&next, 1), Pos::new(1, 1), "did not move");
    assert!(next.agents[&1].action.is_none(), "action ended");
    let finished = finished_event(&events);
    match &finished.kind {
        EventKind::ActionFinished {
            outcome: ActionOutcome::Blocked { by },
            at,
            dir,
            ..
        } => {
            assert_eq!(*at, Pos::new(1, 1));
            assert_eq!(*dir, Some(Dir::E));
            assert_eq!(*by, Blocker::Wall);
        }
        other => panic!("expected blocked event, got {other:?}"),
    }
    assert!(
        finished.text().contains("blocked by a wall"),
        "{}",
        finished.text()
    );

    // The map edge blocks the same way.
    let edge = join_agent(&build("grid\nE#\n"), &cfg, 7, "dev-7");
    let (edge, events) = step(&edge, &[move_intent(7, &[Dir::W])], 6, &cfg);
    assert_eq!(pos_of(&edge, 7), Pos::new(0, 0));
    match &finished_event(&events).kind {
        EventKind::ActionFinished {
            outcome: ActionOutcome::Blocked { by },
            ..
        } => assert_eq!(*by, Blocker::MapEdge),
        other => panic!("expected blocked event, got {other:?}"),
    }
}

#[test]
fn closed_door_blocks_open_door_passes() {
    let cfg = Config::default();
    let world = join_agent(&build("grid\n.E+\n"), &cfg, 1, "dev-1");
    // (2,0) is a closed door → blocked.
    let (next, events) = step(&world, &[move_intent(1, &[Dir::E])], 1, &cfg);
    assert_eq!(pos_of(&next, 1), Pos::new(1, 0));
    assert!(matches!(
        &finished_event(&events).kind,
        EventKind::ActionFinished {
            outcome: ActionOutcome::Blocked {
                by: Blocker::ClosedDoor
            },
            ..
        }
    ));

    let mut open = world.clone();
    open.set_object(Pos::new(2, 0), Some(Object::Door { open: true }));
    let (next, _) = step(&open, &[move_intent(1, &[Dir::E])], 1, &cfg);
    assert_eq!(pos_of(&next, 1), Pos::new(2, 0), "open door is walkable");
}

#[test]
fn entrance_takes_one_agent_and_the_queue_moves_up() {
    let cfg = Config::default();
    let world = join_agent(&build(CORRIDOR), &cfg, 1, "dev-1");
    let world = join_agent(&world, &cfg, 2, "dev-2");
    assert_eq!(world.sessions[&20].status, SessionStatus::Waiting);
    assert_eq!(world.entry_queue.len(), 1);
    assert!(world.agents[&2].pos.is_none(), "second agent waits outside");

    // dev-1 walks one cell east; dev-2 gets the entrance on the next tick,
    // because admission runs before movement within a tick.
    let (next, _) = step(&world, &[move_intent(1, &[Dir::E])], 3, &cfg);
    assert!(
        next.agents[&2].pos.is_none(),
        "entrance was still taken at admission time"
    );
    let (next, events) = step(&next, &[], 4, &cfg);
    assert_eq!(pos_of(&next, 2), next.entrance);
    assert_eq!(next.sessions[&20].status, SessionStatus::Inside);
    assert!(next.entry_queue.is_empty());
    assert!(events
        .iter()
        .any(|e| matches!(&e.kind, EventKind::EnteredWorld { agent: 2, .. })));

    // Joining twice with the same agent is rejected.
    let err = join(
        &next,
        &JoinCommand {
            agent: 1,
            nick: nick("dev-1"),
            session: 99,
        },
        &cfg,
    )
    .unwrap_err();
    assert_eq!(err.kind, JoinRejectKind::AlreadyJoined);
}

#[test]
fn two_agents_racing_for_one_cell_settle_deterministically() {
    let cfg = Config::default();
    let mut world = join_agent(&build(CORRIDOR), &cfg, 1, "dev-1");
    // dev-1 walks to (3,1) so dev-2 can enter the now-free entrance.
    for seed in [1, 2] {
        let (next, _) = step(&world, &[move_intent(1, &[Dir::E, Dir::E])], seed, &cfg);
        world = next;
    }
    assert_eq!(pos_of(&world, 1), Pos::new(3, 1));
    let world = join_agent(&world, &cfg, 2, "dev-2");
    assert_eq!(pos_of(&world, 2), Pos::new(1, 1));

    let intents = [move_intent(1, &[Dir::W]), move_intent(2, &[Dir::E])];
    let (first, events) = step(&world, &intents, 777, &cfg);
    let (second, events_again) = step(&world, &intents, 777, &cfg);
    assert_eq!(first, second, "same seed, same world");
    assert_eq!(events, events_again, "same seed, same events");

    let occupant = [pos_of(&first, 1), pos_of(&first, 2)]
        .iter()
        .filter(|p| **p == Pos::new(2, 1))
        .count();
    assert_eq!(occupant, 1, "exactly one agent wins the contested cell");
    assert!(events.iter().any(|e| matches!(
        &e.kind,
        EventKind::ActionFinished {
            outcome: ActionOutcome::Blocked {
                by: Blocker::Agent { .. }
            },
            ..
        }
    )));

    // Across seeds either agent may win, but never both.
    let mut winners = Vec::new();
    for seed in 0..16 {
        let (next, _) = step(&world, &intents, seed, &cfg);
        let at = if pos_of(&next, 1) == Pos::new(2, 1) {
            1
        } else {
            2
        };
        winners.push(at);
    }
    assert!(
        winners.contains(&1) && winners.contains(&2),
        "seed decides the order"
    );
}

#[test]
fn agents_cannot_swap_positions() {
    let cfg = Config::default();
    let mut world = join_agent(&build(CORRIDOR), &cfg, 1, "dev-1");
    let (next, _) = step(&world, &[move_intent(1, &[Dir::E])], 1, &cfg);
    world = next;
    let world = join_agent(&world, &cfg, 2, "dev-2");
    assert_eq!(pos_of(&world, 1), Pos::new(2, 1));
    assert_eq!(pos_of(&world, 2), Pos::new(1, 1));

    let (next, _) = step(
        &world,
        &[move_intent(1, &[Dir::W]), move_intent(2, &[Dir::E])],
        4,
        &cfg,
    );
    assert_eq!(pos_of(&next, 1), Pos::new(2, 1), "no swap");
    assert_eq!(pos_of(&next, 2), Pos::new(1, 1), "no swap");
}

#[test]
fn look_is_a_centered_9x9_window() {
    let cfg = Config::default();
    let world = join_agent(&build(DEFAULT_MAP), &cfg, 1, "dev-1");
    let view = look(&world, 1, &cfg).expect("agent is inside");
    assert_eq!((view.grid.width, view.grid.height), (9, 9));
    assert_eq!(view.grid.rows.len(), 9);
    assert!(view.grid.rows.iter().all(|r| r.chars().count() == 9));
    let center_row: Vec<char> = view.grid.rows[4].chars().collect();
    assert_eq!(center_row[4], '@', "you are in the middle of your view");
    assert_eq!(view.pos, world.entrance);
    assert_eq!(view.grid.origin, Pos::new(view.pos.x - 4, view.pos.y - 4));
    assert!(
        view.grid.rows.iter().any(|r| r.contains('?')),
        "cells outside the map are unknown"
    );
}

#[test]
fn default_map_has_the_eight_starting_toilets() {
    let def = map::parse(DEFAULT_MAP).expect("default map parses");
    assert_eq!((def.map.width(), def.map.height()), (100, 100));
    let cfg = Config::default();
    let world = WorldState::new(def);
    let briefing = loo_core::briefing(&world, &cfg);
    assert_eq!(briefing.toilets.len(), 8, "6 level-1 and 2 level-2 toilets");
    let level1 = briefing.toilets.iter().filter(|t| t.level == 1).count();
    let level2 = briefing.toilets.iter().filter(|t| t.level == 2).count();
    assert_eq!((level1, level2), (6, 2));
    assert!(
        briefing.toilets.iter().all(|t| t.usable),
        "each starting toilet is enclosed by walls and a closed door"
    );
    assert!(
        !briefing.no_build.is_empty(),
        "the cross corridor is no-build"
    );
}

#[test]
fn map_memory_only_grows_inside_the_view() {
    let cfg = Config::default();
    let world = join_agent(&build(DEFAULT_MAP), &cfg, 1, "dev-1");
    let memory = map_memory(&world, 1).expect("session exists");
    // The entrance is 1 cell from the west edge, so the 9x9 window is clipped.
    assert_eq!((memory.grid.width, memory.grid.height), (6, 9));
    assert!(memory.seen_at.iter().flatten().all(|t| *t == 0));

    let mut next = world;
    for seed in 0..5 {
        let (stepped, _) = step(
            &next,
            &[move_intent(1, &[Dir::E, Dir::E, Dir::E, Dir::E, Dir::E])],
            9 + seed,
            &cfg,
        );
        next = stepped;
    }
    assert_eq!(pos_of(&next, 1), Pos::new(6, 50));
    let memory = map_memory(&next, 1).expect("session exists");
    assert!(memory.grid.width > 9, "walking east widens the memory");
    assert!(memory.seen_at.iter().flatten().any(|t| *t == 1));
}

#[test]
fn same_tick_contention_is_unique_and_replay_matches() {
    let cfg = Config::default();
    let mut world = join_agent(&build(CORRIDOR), &cfg, 1, "dev-1");
    for seed in [1, 2] {
        world = step(&world, &[move_intent(1, &[Dir::E, Dir::E])], seed, &cfg).0;
    }
    let start = join_agent(&world, &cfg, 2, "dev-2");
    assert_eq!(pos_of(&start, 1), Pos::new(3, 1));
    assert_eq!(pos_of(&start, 2), Pos::new(1, 1), "dev-2 took the entrance");

    let schedule = vec![
        (
            777u64,
            vec![move_intent(1, &[Dir::W]), move_intent(2, &[Dir::E])],
        ),
        (778u64, Vec::new()),
    ];
    let (first, first_events) = replay(&start, &schedule, &cfg);
    let (again, again_events) = replay(&start, &schedule, &cfg);
    assert_eq!(first, again, "same seed, same world");
    assert_eq!(first_events, again_events, "same seed, same events");

    let occupants = [pos_of(&first, 1), pos_of(&first, 2)]
        .iter()
        .filter(|p| **p == Pos::new(2, 1))
        .count();
    assert_eq!(occupants, 1, "exactly one agent holds the contested cell");

    let tick_seeds: BTreeMap<Tick, u64> = first_events
        .iter()
        .filter(|e| matches!(e.kind, EventKind::TickSettled))
        .map(|e| (e.tick, e.seed))
        .collect();
    assert_eq!(tick_seeds.len(), 2, "every tick logs its settlement");
    let logged_ticks: Vec<Tick> = tick_seeds.keys().copied().collect();
    assert_eq!(
        logged_ticks,
        vec![start.tick + 1, start.tick + 2],
        "replay advances one tick per schedule entry"
    );
    for (index, tick) in logged_ticks.iter().enumerate() {
        assert_eq!(
            tick_seeds[tick], schedule[index].0,
            "tick {tick} logs its seed"
        );
    }

    let from_log: Vec<(u64, Vec<Intent>)> = logged_ticks
        .iter()
        .enumerate()
        .map(|(index, tick)| (tick_seeds[tick], schedule[index].1.clone()))
        .collect();
    let (from_log_world, from_log_events) = replay(&start, &from_log, &cfg);
    assert_eq!(from_log_events.len(), first_events.len());
    for (expected, actual) in first_events.iter().zip(&from_log_events) {
        assert_eq!(expected, actual, "event-by-event replay equality");
    }
    let diffs = diff_worlds(&first, &from_log_world);
    assert!(diffs.is_empty(), "replayed world differs: {diffs:?}");
}

#[test]
fn blockers_stop_at_the_correct_cell() {
    let cfg = Config::default();

    // A wall halfway along the path.
    let world = join_agent(&build("grid\n.E.#\n"), &cfg, 1, "dev-1");
    let (next, events) = run_ticks(&world, &[move_intent(1, &[Dir::E, Dir::E])], 2, 1, &cfg);
    assert_eq!(pos_of(&next, 1), Pos::new(2, 0), "stopped before the wall");
    assert!(
        next.agents[&1].action.is_none(),
        "the blocked action is dropped"
    );
    let finished = finished_for(&events, 1);
    match &finished.kind {
        EventKind::ActionFinished {
            outcome: ActionOutcome::Blocked { by },
            at,
            dir,
            ..
        } => {
            assert_eq!(*by, Blocker::Wall);
            assert_eq!(*at, Pos::new(2, 0));
            assert_eq!(*dir, Some(Dir::E));
        }
        other => panic!("expected a blocked event, got {other:?}"),
    }
    assert!(
        finished.text().contains("blocked by a wall"),
        "{}",
        finished.text()
    );

    // A closed door.
    let world = join_agent(&build("grid\n.E.+\n"), &cfg, 1, "dev-1");
    let (next, events) = run_ticks(&world, &[move_intent(1, &[Dir::E, Dir::E])], 2, 3, &cfg);
    assert_eq!(pos_of(&next, 1), Pos::new(2, 0), "stopped before the door");
    assert!(matches!(
        &finished_for(&events, 1).kind,
        EventKind::ActionFinished {
            outcome: ActionOutcome::Blocked {
                by: Blocker::ClosedDoor
            },
            ..
        }
    ));
    assert!(
        finished_for(&events, 1).text().contains("a closed door"),
        "{}",
        finished_for(&events, 1).text()
    );

    // Another agent.
    let mut world = join_agent(&build(CORRIDOR), &cfg, 1, "dev-1");
    world = join_agent(&world, &cfg, 2, "dev-2");
    place(&mut world, 2, Pos::new(3, 1));
    let (next, events) = run_ticks(&world, &[move_intent(1, &[Dir::E, Dir::E])], 2, 5, &cfg);
    assert_eq!(pos_of(&next, 1), Pos::new(2, 1), "stopped beside dev-2");
    assert_eq!(pos_of(&next, 2), Pos::new(3, 1), "dev-2 stayed put");
    match &finished_for(&events, 1).kind {
        EventKind::ActionFinished {
            outcome:
                ActionOutcome::Blocked {
                    by: Blocker::Agent { nick },
                },
            ..
        } => assert_eq!(nick, "dev-2"),
        other => panic!("expected a blocked event, got {other:?}"),
    }
    assert!(
        finished_for(&events, 1)
            .text()
            .contains("blocked by agent dev-2"),
        "{}",
        finished_for(&events, 1).text()
    );

    // The map edge.
    let world = join_agent(&build("grid\nE#\n"), &cfg, 1, "dev-1");
    let (next, events) = run_ticks(&world, &[move_intent(1, &[Dir::W])], 1, 7, &cfg);
    assert_eq!(pos_of(&next, 1), Pos::new(0, 0));
    match &finished_for(&events, 1).kind {
        EventKind::ActionFinished {
            outcome: ActionOutcome::Blocked {
                by: Blocker::MapEdge,
            },
            ..
        } => {}
        other => panic!("expected a map edge block, got {other:?}"),
    }
    assert!(
        finished_for(&events, 1).text().contains("the map edge"),
        "{}",
        finished_for(&events, 1).text()
    );

    // An unfinished wall build site blocks; its glyph is `x`.
    let world = build("grid\n.E.x\n");
    assert_eq!(
        world.object_at(Pos::new(3, 0)),
        Some(Object::Site {
            kind: SiteKind::Wall
        }),
        "`x` is a wall site"
    );
    assert_eq!(
        world.object_at(Pos::new(3, 0)).map(Object::glyph),
        Some('x')
    );
    let world = join_agent(&world, &cfg, 1, "dev-1");
    let (next, events) = run_ticks(&world, &[move_intent(1, &[Dir::E, Dir::E])], 2, 9, &cfg);
    assert_eq!(pos_of(&next, 1), Pos::new(2, 0), "stopped before the site");
    assert!(matches!(
        &finished_for(&events, 1).kind,
        EventKind::ActionFinished {
            outcome: ActionOutcome::Blocked { by: Blocker::Site },
            ..
        }
    ));
    assert!(
        finished_for(&events, 1)
            .text()
            .contains("an unfinished build site"),
        "{}",
        finished_for(&events, 1).text()
    );

    // A toilet site does not block.
    let mut open = build("grid\n.E.x\n");
    open.set_object(
        Pos::new(3, 0),
        Some(Object::Site {
            kind: SiteKind::Toilet,
        }),
    );
    let open = join_agent(&open, &cfg, 1, "dev-1");
    let (next, events) = run_ticks(&open, &[move_intent(1, &[Dir::E, Dir::E])], 2, 11, &cfg);
    assert_eq!(
        pos_of(&next, 1),
        Pos::new(3, 0),
        "toilet sites are walkable"
    );
    assert!(next.agents[&1].action.is_none(), "the path completed");
    assert!(
        !events.iter().any(|e| matches!(
            e.kind,
            EventKind::ActionFinished {
                outcome: ActionOutcome::Blocked { .. },
                ..
            }
        )),
        "nothing blocked the toilet-site path"
    );
}

#[test]
fn vision_never_leaks_outside_the_window() {
    let cfg = Config::default();
    let dots = ".".repeat(28);
    let long = format!("grid\n{}\n.E{dots}\n{}\n", ".".repeat(30), ".".repeat(30));
    let mut world = join_agent(&build(&long), &cfg, 1, "dev-1");
    world = join_agent(&world, &cfg, 2, "dev-2");
    place(&mut world, 2, Pos::new(20, 1));

    let (mut next, events) = step(
        &world,
        &[move_intent(2, &[Dir::E, Dir::E, Dir::E])],
        1,
        &cfg,
    );
    assert_eq!(pos_of(&next, 2), Pos::new(21, 1));

    let view = look(&next, 1, &cfg).expect("agent 1 is inside");
    assert_eq!((view.grid.width, view.grid.height), (9, 9));
    assert!(view.grid.rows.iter().all(|row| row.chars().count() == 9));
    assert_eq!(view.grid.rows[4].chars().nth(4), Some('@'));
    assert!(
        view.grid.rows.iter().all(|row| !row.contains('a')),
        "the far agent's letter never enters the window: {:?}",
        view.grid.rows
    );

    let seen = &next.sessions[&10].seen;
    assert!(!seen.is_empty());
    assert!(
        seen.keys().all(|pos| pos.x <= 5),
        "no cell beyond the window was remembered: {:?}",
        seen.keys().collect::<Vec<_>>()
    );
    assert!(
        !seen.contains_key(&Pos::new(20, 1)),
        "the far agent's cell was never seen"
    );
    let memory = map_memory(&next, 1).expect("session exists");
    assert_eq!(
        memory.grid.width, 6,
        "the window is clipped at the west edge"
    );
    assert_eq!(memory.grid.height, 3, "the map is only three rows tall");
    assert!(memory
        .seen_at
        .iter()
        .flatten()
        .all(|tick| *tick <= next.tick));

    let far_move = moved_for(&events, 2);
    assert!(
        !far_move.visible_to(1, Some(Pos::new(1, 1)), &cfg),
        "far movement stays private"
    );
    assert!(
        far_move.visible_to(2, Some(Pos::new(21, 1)), &cfg),
        "your own movement is always visible"
    );

    // One cell inside the window is visible.
    place(&mut next, 2, Pos::new(4, 1));
    let (_, events) = step(&next, &[move_intent(2, &[Dir::E])], 2, &cfg);
    let near_move = moved_for(&events, 2);
    assert_eq!(near_move.at(), Some(Pos::new(5, 1)));
    assert!(
        near_move.visible_to(1, Some(Pos::new(1, 1)), &cfg),
        "adjacent movement is visible"
    );
}

#[test]
fn action_replaced_is_announced_and_new_action_wins() {
    let cfg = Config::default();
    let world = join_agent(
        &build("grid\n.......\n.E.....\n.......\n.......\n"),
        &cfg,
        1,
        "dev-1",
    );

    let (world, events) = step(
        &world,
        &[labeled_move(1, &[Dir::E, Dir::E, Dir::E], "east three")],
        1,
        &cfg,
    );
    assert_eq!(pos_of(&world, 1), Pos::new(2, 1));
    let started = find_event(&events, |kind| {
        matches!(kind, EventKind::ActionStarted { .. })
    });
    assert!(
        matches!(started.kind, EventKind::ActionStarted { .. }),
        "the first intent starts an action"
    );
    assert_eq!(started.subject(), Some(1));
    assert!(
        !started.visible_to(1, Some(pos_of(&world, 1)), &cfg),
        "ActionStarted is log-only and never reaches its own agent"
    );
    assert!(
        !events
            .iter()
            .any(|e| matches!(e.kind, EventKind::ActionReplaced { .. })),
        "nothing to replace yet"
    );

    let (world, events) = step(
        &world,
        &[labeled_move(1, &[Dir::S, Dir::S], "south two")],
        2,
        &cfg,
    );
    let replaced = find_event(&events, |kind| {
        matches!(kind, EventKind::ActionReplaced { .. })
    });
    match &replaced.kind {
        EventKind::ActionReplaced { from, to, .. } => {
            assert_eq!(from.label, "east three");
            assert_eq!(to.label, "south two");
            assert_eq!(from.remaining(), 2, "the east path still had two steps");
            assert_eq!(to.remaining(), 2);
        }
        other => panic!("expected an ActionReplaced event, got {other:?}"),
    }
    assert_eq!(
        replaced.text(),
        "dev-1's action east three was replaced by south two"
    );
    assert!(
        replaced.visible_to(1, Some(pos_of(&world, 1)), &cfg),
        "ActionReplaced is announced to its own agent"
    );
    assert_eq!(
        pos_of(&world, 1),
        Pos::new(2, 2),
        "the new path moves, not the old one"
    );

    let (world, _) = step(&world, &[], 3, &cfg);
    assert_eq!(pos_of(&world, 1), Pos::new(2, 3));
    assert!(world.agents[&1].action.is_none(), "the south path finished");
}

#[test]
fn stunned_agent_is_swapped_and_a_second_contender_is_blocked() {
    let cfg = Config::default();
    let mut world = join_agent(&build("grid\nE.....\n"), &cfg, 1, "dev-1");
    world = join_agent(&world, &cfg, 2, "dev-2");
    world = join_agent(&world, &cfg, 3, "dev-3");
    place(&mut world, 1, Pos::new(2, 0));
    place(&mut world, 2, Pos::new(1, 0));
    place(&mut world, 3, Pos::new(3, 0));
    world.agents.get_mut(&2).expect("stunned agent").stun_until = 10;
    world.agents.get_mut(&2).expect("stunned agent").action = Some(loo_core::Action {
        dirs: [Dir::E].into(),
        total: 1,
        label: "stunned walk".to_string(),
    });
    assert!(world.entry_queue.is_empty(), "no one is waiting to enter");

    // Pick a seed where the mover settles before the stunned agent, so the
    // swap really is what clears the stunned agent's action.
    let seed = (0..64u64)
        .find(|seed| {
            let order = settlement_order(&[1, 2, 3], *seed);
            let rank = |id: u64| order.iter().position(|a| *a == id).unwrap_or(usize::MAX);
            rank(1) < rank(2)
        })
        .expect("some seed settles agent 1 before agent 2");

    let (next, events) = step(
        &world,
        &[move_intent(1, &[Dir::W]), move_intent(3, &[Dir::W])],
        seed,
        &cfg,
    );
    assert_eq!(
        pos_of(&next, 1),
        Pos::new(1, 0),
        "mover takes the stunned cell"
    );
    assert_eq!(
        pos_of(&next, 2),
        Pos::new(2, 0),
        "stunned agent is pushed back"
    );
    assert_eq!(
        pos_of(&next, 3),
        Pos::new(3, 0),
        "the second contender is stuck"
    );
    assert!(
        next.agents[&2].action.is_none(),
        "the push cancels the stunned agent's action"
    );

    let swapped = find_event(&events, |kind| {
        matches!(kind, EventKind::AgentSwapped { .. })
    });
    match &swapped.kind {
        EventKind::AgentSwapped {
            agent,
            nick,
            other_agent,
            other_nick,
            from,
            to,
            other_from,
            other_to,
            ..
        } => {
            assert_eq!(*agent, 1);
            assert_eq!(nick, "dev-1");
            assert_eq!(*other_agent, 2);
            assert_eq!(other_nick, "dev-2");
            assert_eq!((*from, *to), (Pos::new(2, 0), Pos::new(1, 0)));
            assert_eq!((*other_from, *other_to), (Pos::new(1, 0), Pos::new(2, 0)));
        }
        other => panic!("expected an AgentSwapped event, got {other:?}"),
    }
    assert_eq!(
        swapped.text(),
        "dev-1 moved (2,0) -> (1,0); dev-2 was pushed (1,0) -> (2,0)"
    );
    assert_eq!(swapped.at(), Some(Pos::new(1, 0)));

    assert_eq!(
        finished_for(&events, 1).text(),
        "dev-1's move finished at (1,0)"
    );
    assert!(
        !events.iter().any(|e| e.subject() == Some(2)),
        "the swapped agent never got a turn: {events:?}"
    );
    match &finished_for(&events, 3).kind {
        EventKind::ActionFinished {
            outcome:
                ActionOutcome::Blocked {
                    by: Blocker::Agent { .. },
                },
            at,
            ..
        } => assert_eq!(*at, Pos::new(3, 0)),
        other => panic!("expected agent 3 to be blocked, got {other:?}"),
    }
}

#[test]
fn snapshot_plus_events_restores_grid_identical() {
    let cfg = Config::default();
    let map_text = "\
grid
............
.....E......
............
............
............
............
";
    let mut world = join_agent(&build(map_text), &cfg, 1, "dev-1");
    world = join_agent(&world, &cfg, 2, "dev-2");
    world = join_agent(&world, &cfg, 3, "dev-3");
    world.agents.get_mut(&2).expect("agent 2").stun_until = 10;
    let initial = world.clone();
    assert_eq!(initial.entry_queue.len(), 2, "two agents wait outside");

    let mut schedule: Vec<(u64, Vec<Intent>)> = (0..36u64).map(|t| (500 + t, Vec::new())).collect();
    schedule[0].1 = vec![labeled_move(1, &[Dir::W, Dir::W, Dir::W], "west three")];
    schedule[1].1 = vec![labeled_move(1, &[Dir::E, Dir::E], "east two")];
    schedule[4].1 = vec![labeled_move(3, &[Dir::S, Dir::S, Dir::S], "south three")];
    schedule[8].1 = vec![labeled_move(1, &[Dir::N, Dir::N, Dir::N], "north three")];
    schedule[12].1 = vec![labeled_move(2, &[Dir::W, Dir::W], "west two")];
    schedule[20].1 = vec![labeled_move(1, &[Dir::E, Dir::E], "east again")];
    schedule[25].1 = vec![labeled_move(3, &[Dir::N], "back north")];

    let mut world = initial.clone();
    let mut events = Vec::new();
    let mut midpoint: Option<WorldState> = None;
    for (seed, intents) in &schedule {
        let (next, tick_events) = step(&world, intents, *seed, &cfg);
        world = next;
        events.extend(tick_events);
        if world.tick == 15 {
            midpoint = Some(world.clone());
        }
    }
    assert_eq!(world.tick, 36);
    let midpoint = midpoint.expect("tick 15 was reached");

    for kind in [
        "EnteredWorld",
        "AgentMoved",
        "ActionStarted",
        "ActionReplaced",
        "ActionFinished",
    ] {
        assert!(
            events.iter().any(|e| e.kind.name() == kind),
            "the run must cover {kind}"
        );
    }
    assert!(
        events
            .iter()
            .any(|e| matches!(e.kind, EventKind::AgentSwapped { .. })),
        "the run must cover a stun swap"
    );

    // A snapshot taken from the log is grid-identical to the memory world.
    let json = serde_json::to_string(&midpoint).expect("world serialises");
    let snapshot: WorldState = serde_json::from_str(&json).expect("world deserialises");
    assert_eq!(snapshot, midpoint, "JSON round-trip is lossless");

    let (_, late_events): (Vec<Event>, Vec<Event>) =
        events.iter().cloned().partition(|e| e.tick <= 15);
    let restored = restore(&snapshot, &late_events, &cfg).expect("snapshot + events restores");
    let diffs = diff_worlds(&world, &restored);
    assert!(diffs.is_empty(), "restore from tick 15 differs: {diffs:?}");

    let from_zero = restore(&initial, &events, &cfg).expect("full log restores");
    let diffs = diff_worlds(&world, &from_zero);
    assert!(diffs.is_empty(), "restore from tick 0 differs: {diffs:?}");
    assert_eq!(from_zero.tick, 36);
}

#[test]
fn restore_rejects_a_gap_or_out_of_order_event() {
    let cfg = Config::default();
    let world = join_agent(&build(CORRIDOR), &cfg, 1, "dev-1");
    let start = world.clone();
    let mut world = world;
    let mut events = Vec::new();
    for tick in 0..4u64 {
        let (next, tick_events) = step(
            &world,
            &[move_intent(1, &[Dir::E, Dir::E])],
            40 + tick,
            &cfg,
        );
        world = next;
        events.extend(tick_events);
    }
    assert!(
        restore(&start, &events, &cfg).is_ok(),
        "the clean log restores"
    );

    // A dropped TickSettled breaks the tick boundary.
    let hole_at = events
        .iter()
        .position(|e| e.tick == 2 && matches!(e.kind, EventKind::TickSettled))
        .expect("tick 2 settled");
    let mut holed = events.clone();
    holed.remove(hole_at);
    let err = restore(&start, &holed, &cfg).expect_err("a missing TickSettled is rejected");
    assert_eq!(err.tick, 2);
    assert!(err.to_string().contains("not TickSettled"), "{err}");

    // Swapped sequence numbers are rejected.
    let mut shuffled = events.clone();
    shuffled.swap(1, 2);
    let err = restore(&start, &shuffled, &cfg).expect_err("out-of-order events are rejected");
    assert_eq!(err.tick, 1);
    assert!(err.to_string().contains("seq"), "{err}");

    // A whole missing tick is a gap.
    let gapped: Vec<Event> = events.iter().filter(|e| e.tick != 3).cloned().collect();
    let err = restore(&start, &gapped, &cfg).expect_err("a tick gap is rejected");
    assert_eq!(err.tick, 4);
    assert!(err.to_string().contains("contiguous"), "{err}");
}
