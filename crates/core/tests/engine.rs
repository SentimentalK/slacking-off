//! Engine-level acceptance tests for step 0 (design §13 第 0 步).

use loo_core::{
    join, look, map, map_memory, step, ActionOutcome, Blocker, Config, EventKind, Intent,
    IntentKind, JoinCommand, JoinOutcome, JoinRejectKind, Object, SessionStatus, WorldState,
};
use loo_proto::{Dir, Nick, Pos};

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
    Intent {
        agent,
        kind: IntentKind::Move {
            dirs: dirs.to_vec(),
            label: "test move".to_string(),
        },
    }
}

fn pos_of(world: &WorldState, agent: u64) -> Pos {
    world.agents[&agent].pos.expect("agent is on the map")
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
    assert!(matches!(events[0].kind, EventKind::AgentMoved { .. }));
    assert_eq!(events[0].seed, 11);

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
    match &events[0].kind {
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
        events[0].text().contains("blocked by a wall"),
        "{}",
        events[0].text()
    );

    // The map edge blocks the same way.
    let edge = join_agent(&build("grid\nE#\n"), &cfg, 7, "dev-7");
    let (edge, events) = step(&edge, &[move_intent(7, &[Dir::W])], 6, &cfg);
    assert_eq!(pos_of(&edge, 7), Pos::new(0, 0));
    match &events[0].kind {
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
        &events[0].kind,
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
