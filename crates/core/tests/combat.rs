//! Attack, defence, stun, immunity and cooldowns, driven through the real
//! `step` (design §5). Every scenario runs the engine, never a helper of the
//! implementation, so a broken rule shows up as a wrong world or a missing
//! event.

use loo_core::{
    diff_worlds, is_stunned, join, map, restore, step, validate_attack, validate_attack_at,
    validate_defend, validate_defend_at, Action, ActionOutcome, Config, Event, EventKind, Intent,
    IntentKind, JoinCommand, Object, SessionStatus, SiteKind, Snapshot, WorldState,
};
use loo_proto::{Dir, Need, Nick, Pos};

/// Open floor, entrance at the south-west corner.
const ARENA: &str = "\
grid
.........
.........
.........
.........
E........
";

/// A walled-in level-2 toilet at (3,1) plus a level-5 toilet at (1,1).
const ENCLOSED: &str = "\
grid
#######
#5#2#.#
#######
#E....#
#######
";

/// A level-2 toilet with four free neighbours, for the upgrade/defend test.
const TOILET_ARENA: &str = "\
grid
.........
.........
..2......
.........
E........
";

/// A wall at (2,1) between the attacker at (1,1) and the target at (3,1).
const WALL_BETWEEN: &str = "\
grid
.........
..#......
.........
E........
";

/// The same cells, but the blocker is a closed door instead of a wall.
const DOOR_BETWEEN: &str = "\
grid
.........
..+......
.........
E........
";

/// A wall at (3,1) and a level-2 toilet at (6,1), both with a free neighbour.
const DEMOLISH_ARENA: &str = "\
grid
...........
...#...2...
...........
.E.........
";

const A_POS: Pos = Pos::new(2, 1);
const B_POS: Pos = Pos::new(3, 1);
const C_POS: Pos = Pos::new(3, 2);
const NORTH_OF_A: Pos = Pos::new(2, 0);

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

/// Puts an agent on a cell directly, as a scenario builder would: no queue.
fn place(world: &mut WorldState, agent: u64, at: Pos) {
    let session = world.session_of(agent).expect("agent has a session").id;
    world.agents.get_mut(&agent).expect("agent exists").pos = Some(at);
    let entry = world.sessions.get_mut(&session).expect("session exists");
    entry.status = SessionStatus::Inside;
    world.entry_queue.retain(|queued| *queued != session);
}

/// An agent with a known need and deadline.
fn armed(world: &mut WorldState, agent: u64, at: Pos, need: Need, deadline: u64) {
    place(world, agent, at);
    let session = world.session_of(agent).expect("agent has a session").id;
    let entry = world.sessions.get_mut(&session).expect("session exists");
    entry.need = Some(need);
    entry.deadline = deadline;
}

fn attack_intent(agent: u64, target: Pos) -> Intent {
    Intent {
        agent,
        kind: IntentKind::Attack { target },
    }
}

fn defend_intent(agent: u64, target: Pos) -> Intent {
    Intent {
        agent,
        kind: IntentKind::Defend { target },
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

fn use_intent(agent: u64, target: Pos) -> Intent {
    Intent {
        agent,
        kind: IntentKind::Use { target },
    }
}

fn upgrade_intent(agent: u64, target: Pos) -> Intent {
    Intent {
        agent,
        kind: IntentKind::Upgrade { target },
    }
}

fn demolish_intent(agent: u64, target: Pos) -> Intent {
    Intent {
        agent,
        kind: IntentKind::Demolish { target },
    }
}

fn pos_of(world: &WorldState, agent: u64) -> Pos {
    world.agents[&agent].pos.expect("agent is on the map")
}

fn deadline_of(world: &WorldState, agent: u64) -> u64 {
    world
        .sessions
        .values()
        .find(|session| session.agent == agent)
        .expect("agent has a session")
        .deadline
}

fn find_event<F: Fn(&EventKind) -> bool>(events: &[Event], matches_kind: F) -> &Event {
    events
        .iter()
        .find(|event| matches_kind(&event.kind))
        .unwrap_or_else(|| panic!("no matching event in {events:?}"))
}

fn count<F: Fn(&EventKind) -> bool>(events: &[Event], matches_kind: F) -> usize {
    events
        .iter()
        .filter(|event| matches_kind(&event.kind))
        .count()
}

/// The rejection reason for one agent's refused command.
fn rejection_reason(events: &[Event], agent: u64) -> String {
    events
        .iter()
        .find_map(|event| match &event.kind {
            EventKind::ActionRejected {
                agent: who, reason, ..
            } if *who == agent => Some(reason.clone()),
            _ => None,
        })
        .unwrap_or_else(|| panic!("agent {agent} was not rejected: {events:?}"))
}

/// The order `step` settles agents in for one seed.
fn settlement_order(agents: &[u64], seed: u64) -> Vec<u64> {
    let mut order = agents.to_vec();
    loo_core::rng::shuffle(&mut order, seed);
    order
}

fn rank(order: &[u64], agent: u64) -> usize {
    order
        .iter()
        .position(|id| *id == agent)
        .unwrap_or(usize::MAX)
}

/// One attacker at `A_POS`, one armed target at `B_POS`, one bystander at
/// `C_POS`, all on the open arena.
fn duel() -> WorldState {
    let cfg = Config::default();
    let mut world = build(ARENA);
    world = claim(&world, &cfg, 1, 0);
    world = claim(&world, &cfg, 2, 0);
    world = claim(&world, &cfg, 3, 0);
    place(&mut world, 1, A_POS);
    armed(&mut world, 2, B_POS, Need::Urine, 200);
    place(&mut world, 3, C_POS);
    world
}

/// Ticks 1 to `last` with only the first tick's intents, returning the final
/// world and every tick's events separately.
fn run_until(
    world: &WorldState,
    intents: &[Intent],
    last: u64,
    seed: u64,
    cfg: &Config,
) -> (WorldState, Vec<Vec<Event>>) {
    let mut world = world.clone();
    let mut per_tick = Vec::new();
    let none: Vec<Intent> = Vec::new();
    for tick in 1..=last {
        let submitted = if tick == 1 { intents } else { &none };
        let (next, events) = step(&world, submitted, seed, cfg);
        world = next;
        per_tick.push(events);
    }
    (world, per_tick)
}

#[test]
fn attack_windup_three_ticks_and_target_is_notified() {
    let cfg = Config::default();
    let world = duel();

    let (w1, e1) = step(&world, &[attack_intent(1, B_POS)], 7, &cfg);
    let started = find_event(&e1, |kind| matches!(kind, EventKind::AttackStarted { .. }));
    match &started.kind {
        EventKind::AttackStarted {
            agent,
            target_agent,
            at,
            land_tick,
            cooldown_until,
            ..
        } => {
            assert_eq!(*agent, 1);
            assert_eq!(*target_agent, 2);
            assert_eq!(*at, B_POS);
            assert_eq!(*land_tick, 4, "three ticks of windup from tick 1");
            assert_eq!(*cooldown_until, 7);
        }
        other => panic!("expected AttackStarted, got {other:?}"),
    }
    assert_eq!(started.at(), Some(B_POS));
    assert_eq!(
        started.text(),
        "dev-1 attacks dev-2 at (3,1); the hit lands at tick 4"
    );
    assert!(
        started.visible_to(2, Some(B_POS), &cfg),
        "the target must be told it is being attacked"
    );
    assert_eq!(
        w1.agents[&1].action,
        Some(Action::Attack {
            target_agent: 2,
            target_pos: B_POS,
            land_tick: 4,
            label: "attack the agent at (3,1)".to_string(),
        })
    );

    let (w2, e2) = step(&w1, &[], 7, &cfg);
    assert_eq!(
        count(&e2, |kind| matches!(kind, EventKind::AttackLanded { .. })),
        0
    );
    let (w3, e3) = step(&w2, &[], 7, &cfg);
    assert_eq!(
        count(&e3, |kind| matches!(kind, EventKind::AttackLanded { .. })),
        0
    );
    assert_eq!(deadline_of(&w3, 2), 200, "the windup costs nothing yet");

    let (w4, e4) = step(&w3, &[], 7, &cfg);
    assert_eq!(
        count(&e4, |kind| matches!(kind, EventKind::AttackLanded { .. })),
        1,
        "the hit lands on tick 4: {e4:?}"
    );
    assert!(w4.agents[&1].action.is_none(), "the attack is spent");
}

#[test]
fn target_walking_away_misses() {
    let cfg = Config::default();
    let world = duel();

    let (w1, _) = step(&world, &[attack_intent(1, B_POS)], 3, &cfg);
    let (w2, _) = step(&w1, &[move_intent(2, &[Dir::E, Dir::E])], 3, &cfg);
    let (w3, _) = step(&w2, &[], 3, &cfg);
    assert_eq!(pos_of(&w3, 2), Pos::new(5, 1), "the target walked away");

    let (w4, e4) = step(&w3, &[], 3, &cfg);
    let missed = find_event(&e4, |kind| matches!(kind, EventKind::AttackMissed { .. }));
    match &missed.kind {
        EventKind::AttackMissed {
            reason,
            target_agent,
            at,
            ..
        } => {
            assert_eq!(*target_agent, 2);
            assert_eq!(*at, B_POS, "the event names the cell that was attacked");
            assert!(
                reason.contains("out of reach"),
                "unexpected reason {reason}"
            );
        }
        other => panic!("expected AttackMissed, got {other:?}"),
    }
    assert_eq!(deadline_of(&w4, 2), 200, "a miss costs no deadline");
    assert_eq!(w4.agents[&2].stun_until, 0, "a miss does not stun");
    assert_eq!(
        count(&e4, |kind| matches!(kind, EventKind::AttackLanded { .. })),
        0
    );
    assert!(w4.agents[&1].action.is_none(), "the attack is spent");

    let restored = restore(&Snapshot::new(w3.clone()), &e4, &cfg).expect("the miss restores");
    let diffs = diff_worlds(&w4, &restored);
    assert!(diffs.is_empty(), "miss restore differs: {diffs:?}");
}

#[test]
fn hit_costs_deadline_stuns_and_immunizes() {
    let cfg = Config::default();
    let world = duel();
    let (world, per_tick) = run_until(&world, &[attack_intent(1, B_POS)], 4, 5, &cfg);
    assert_eq!(world.tick, 4);

    let landed = find_event(&per_tick[3], |kind| {
        matches!(kind, EventKind::AttackLanded { .. })
    });
    match &landed.kind {
        EventKind::AttackLanded {
            penalty,
            deadline,
            stun_until,
            immunity_until,
            at,
            ..
        } => {
            assert_eq!(*penalty, 6);
            assert_eq!(*deadline, 194);
            assert_eq!(*at, B_POS);
            assert_eq!(*stun_until, 8);
            assert_eq!(*immunity_until, 11);
        }
        other => panic!("expected AttackLanded, got {other:?}"),
    }
    assert_eq!(deadline_of(&world, 2), 194);
    assert_eq!(world.agents[&2].stun_until, 8);
    assert_eq!(world.agents[&2].immunity_until, 11);
    assert_eq!(
        landed.text(),
        "dev-1 hit dev-2 at (3,1): deadline -6 to 194, stunned until 8, immune until 11"
    );
    assert!(world.agents[&2].action.is_none());
    assert!(is_stunned(&world.agents[&2], 5));
    assert!(
        !is_stunned(&world.agents[&2], 8),
        "the stun ends at its tick"
    );

    // Tick 5: the stunned target cannot act at all.
    let (w5, e5) = step(&world, &[move_intent(2, &[Dir::E])], 5, &cfg);
    assert_eq!(pos_of(&w5, 2), B_POS, "a stunned agent does not move");
    assert_eq!(
        count(&e5, |kind| matches!(kind, EventKind::ActionRejected { .. })),
        1
    );
    assert!(
        rejection_reason(&e5, 2).contains("stunned until tick 8"),
        "the rejection names the stun: {e5:?}"
    );
    assert_eq!(w5.agents[&2].action, None);
}

#[test]
fn immunity_blocks_a_second_hit() {
    // The default cooldown plus windup already covers the default immunity, so
    // this scenario widens immunity and shortens the stun to keep the second
    // attack legal and still inside the immune window.
    let mut cfg = Config::default();
    cfg.combat.stun_ticks = 1;
    cfg.combat.immunity_ticks = 12;
    let world = duel();

    let (w4, per_tick) = run_until(&world, &[attack_intent(1, B_POS)], 4, 9, &cfg);
    assert_eq!(
        count(&per_tick[3], |kind| matches!(
            kind,
            EventKind::AttackLanded { .. }
        )),
        1
    );
    assert_eq!(deadline_of(&w4, 2), 194);
    assert_eq!(w4.agents[&2].stun_until, 6);
    assert_eq!(w4.agents[&2].immunity_until, 17);

    let (w5, _) = step(&w4, &[], 9, &cfg);
    let (w6, _) = step(&w5, &[], 9, &cfg);
    let (w7, e7) = step(&w6, &[attack_intent(1, B_POS)], 9, &cfg);
    assert_eq!(
        count(&e7, |kind| matches!(kind, EventKind::AttackStarted { .. })),
        1,
        "the cooldown allows the next attack at tick 7: {e7:?}"
    );

    let mut world = w7;
    let mut last = Vec::new();
    for _ in 8..=10 {
        let (next, events) = step(&world, &[], 9, &cfg);
        world = next;
        last = events;
    }
    let missed = find_event(&last, |kind| matches!(kind, EventKind::AttackMissed { .. }));
    match &missed.kind {
        EventKind::AttackMissed { reason, .. } => {
            assert!(reason.contains("immune"), "unexpected reason {reason}");
        }
        other => panic!("expected AttackMissed, got {other:?}"),
    }
    assert_eq!(
        deadline_of(&world, 2),
        194,
        "the immune target loses nothing"
    );
    assert_eq!(world.agents[&2].stun_until, 6, "no second stun");
    assert_eq!(
        count(&last, |kind| matches!(kind, EventKind::AttackLanded { .. })),
        0
    );
    assert!(world.agents[&1].action.is_none());
}

#[test]
fn stunned_attacker_loses_the_windup() {
    let cfg = Config::default();
    let mut base = build(ARENA);
    base = claim(&base, &cfg, 1, 0);
    base = claim(&base, &cfg, 2, 0);
    base = claim(&base, &cfg, 3, 0);
    place(&mut base, 1, A_POS);
    armed(&mut base, 2, B_POS, Need::Urine, 200);
    // Agent 3 stands north of the attacker and can only reach agent 1.
    place(&mut base, 3, NORTH_OF_A);

    let seed = (0..64u64)
        .find(|seed| {
            rank(&settlement_order(&[1, 2, 3], *seed), 3)
                < rank(&settlement_order(&[1, 2, 3], *seed), 1)
        })
        .expect("some seed settles the third agent before the attacker");

    // Both attacks are committed on tick 1 and would land on tick 4; the third
    // agent resolves first, so the first attack dies in its windup.
    let (w1, _) = step(
        &base,
        &[attack_intent(1, B_POS), attack_intent(3, A_POS)],
        seed,
        &cfg,
    );
    let (w2, _) = step(&w1, &[], seed, &cfg);
    let (w3, _) = step(&w2, &[], seed, &cfg);
    let (w4, e4) = step(&w3, &[], seed, &cfg);

    assert_eq!(
        count(&e4, |kind| matches!(
            kind,
            EventKind::AttackLanded { agent, .. } if *agent == 1
        )),
        0,
        "the first attack never lands: {e4:?}"
    );
    assert!(w4.agents[&1].action.is_none(), "the windup was cleared");
    assert_eq!(deadline_of(&w4, 2), 200, "the target was never hit");
    assert_eq!(w4.agents[&2].stun_until, 0);
    assert_eq!(w4.agents[&1].stun_until, 8, "the third agent stunned it");
    let cancelled = find_event(
        &e4,
        |kind| matches!(kind, EventKind::AttackCancelled { agent, .. } if *agent == 1),
    );
    match &cancelled.kind {
        EventKind::AttackCancelled { reason, at, .. } => {
            assert_eq!(*at, B_POS);
            assert!(
                reason.contains("stunned"),
                "the cancellation must explain the stun: {reason}"
            );
        }
        other => panic!("expected AttackCancelled, got {other:?}"),
    }
}

#[test]
fn stunned_agent_cannot_move_build_attack() {
    let cfg = Config::default();
    let mut world = duel();
    // Agent 2 is stunned through tick 4.
    world.agents.get_mut(&2).expect("target").stun_until = 5;
    let objects_before = world.objects.clone();

    let (w1, e1) = step(&world, &[move_intent(2, &[Dir::E])], 2, &cfg);
    assert_eq!(pos_of(&w1, 2), B_POS, "a stunned agent stays put");
    assert!(
        rejection_reason(&e1, 2).contains("stunned"),
        "the move was rejected for the stun"
    );
    assert_eq!(
        count(&e1, |kind| matches!(kind, EventKind::AgentMoved { .. })),
        0
    );

    let (w2, e2) = step(&w1, &[attack_intent(2, A_POS)], 2, &cfg);
    assert_eq!(pos_of(&w2, 2), B_POS);
    assert_eq!(
        count(&e2, |kind| matches!(kind, EventKind::AttackStarted { .. })),
        0
    );
    let rejected = find_event(&e2, |kind| matches!(kind, EventKind::ActionRejected { .. }));
    match &rejected.kind {
        EventKind::ActionRejected { action, reason, .. } => {
            assert_eq!(action, "attack");
            assert!(reason.contains("stunned until tick 5"), "reason {reason}");
        }
        other => panic!("expected ActionRejected, got {other:?}"),
    }
    assert_eq!(w2.agents[&2].action, None);
    assert_eq!(w2.objects, objects_before, "nothing was built");
}

#[test]
fn defend_blocks_attack_and_stuns_attacker_in_any_order() {
    let cfg = Config::default();
    let mut saw_attacker_first = false;
    let mut saw_defender_first = false;

    for seed in 0..64u64 {
        let world = duel();
        let (w1, _) = step(&world, &[attack_intent(1, B_POS)], seed, &cfg);
        let (w2, _) = step(&w1, &[], seed, &cfg);
        let (w3, _) = step(&w2, &[], seed, &cfg);
        // The defender commits on the landing tick.
        let (w4, e4) = step(&w3, &[defend_intent(3, B_POS)], seed, &cfg);

        let blocked = find_event(&e4, |kind| matches!(kind, EventKind::AttackBlocked { .. }));
        match &blocked.kind {
            EventKind::AttackBlocked {
                agent,
                target_agent,
                at,
                defender_agent,
                stun_until,
                ..
            } => {
                assert_eq!(*agent, 1);
                assert_eq!(*target_agent, 2);
                assert_eq!(*at, B_POS);
                assert_eq!(*defender_agent, 3);
                assert_eq!(*stun_until, 8);
            }
            other => panic!("expected AttackBlocked, got {other:?}"),
        }
        assert_eq!(
            count(&e4, |kind| matches!(kind, EventKind::AttackLanded { .. })),
            0
        );
        assert_eq!(w4.agents[&1].stun_until, 8, "the attacker pays the stun");
        assert!(w4.agents[&1].action.is_none());
        assert_eq!(deadline_of(&w4, 2), 200, "the defended target is untouched");
        assert_eq!(w4.agents[&2].stun_until, 0);
        assert!(
            blocked.visible_to(3, Some(C_POS), &cfg),
            "the defender must see its own block"
        );
        assert_eq!(
            blocked.text(),
            "dev-3 blocked dev-1's attack on dev-2 at (3,1); dev-1 is stunned until 8"
        );

        let restored = restore(&Snapshot::new(w3.clone()), &e4, &cfg).expect("the block restores");
        let diffs = diff_worlds(&w4, &restored);
        assert!(diffs.is_empty(), "block restore differs: {diffs:?}");

        let order = settlement_order(&[1, 2, 3], seed);
        if rank(&order, 1) < rank(&order, 3) {
            saw_attacker_first = true;
        } else {
            saw_defender_first = true;
        }
        if saw_attacker_first && saw_defender_first {
            break;
        }
    }

    assert!(
        saw_attacker_first && saw_defender_first,
        "the block must not depend on the shuffle order"
    );
}

#[test]
fn defend_blocks_every_demolition_and_stuns_demolisher() {
    let cfg = Config::default();
    let mut world = build(DEMOLISH_ARENA);
    for agent in 1..=5u64 {
        world = claim(&world, &cfg, agent, 0);
    }
    let wall = Pos::new(3, 1);
    let toilet = Pos::new(7, 1);
    place(&mut world, 1, Pos::new(2, 1)); // demolishes the wall
    place(&mut world, 2, Pos::new(3, 2)); // defends the wall
    place(&mut world, 3, Pos::new(6, 1)); // demolishes the toilet
    place(&mut world, 4, Pos::new(7, 2)); // defends the toilet
    place(&mut world, 5, Pos::new(0, 2)); // idle
    let objects_before = world.objects.clone();

    let (next, events) = step(
        &world,
        &[
            demolish_intent(1, wall),
            defend_intent(2, wall),
            demolish_intent(3, toilet),
            defend_intent(4, toilet),
        ],
        6,
        &cfg,
    );

    assert_eq!(next.objects, objects_before, "nothing was touched");
    assert_eq!(next.object_at(wall), Some(Object::Wall { damage: 0 }));
    assert_eq!(
        next.object_at(toilet),
        Some(Object::Toilet {
            level: 2,
            progress: 0
        })
    );
    assert_eq!(
        count(&events, |kind| matches!(
            kind,
            EventKind::ObjectChanged { .. }
        )),
        0,
        "no damage, no progress, no ObjectChanged: {events:?}"
    );
    assert_eq!(
        count(&events, |kind| matches!(
            kind,
            EventKind::DemolishBlocked { .. }
        )),
        2
    );
    for agent in [1u64, 3] {
        assert_eq!(
            next.agents[&agent].stun_until, 5,
            "agent {agent} is stunned"
        );
        assert_eq!(next.agents[&agent].action, None);
    }
    let blocked = find_event(
        &events,
        |kind| matches!(kind, EventKind::DemolishBlocked { agent, .. } if *agent == 1),
    );
    match &blocked.kind {
        EventKind::DemolishBlocked {
            target,
            defender_agent,
            stun_until,
            ..
        } => {
            assert_eq!(*target, wall);
            assert_eq!(*defender_agent, 2);
            assert_eq!(*stun_until, 5);
        }
        other => panic!("expected DemolishBlocked, got {other:?}"),
    }
    assert_eq!(
        blocked.text(),
        "dev-2 blocked dev-1's demolition at (3,1); dev-1 is stunned until 5"
    );
    assert_eq!(
        count(&events, |kind| matches!(kind, EventKind::Stunned { .. })),
        2
    );
}

#[test]
fn defend_tick_pauses_use_without_interrupting_it() {
    let cfg = Config::default();
    let mut world = build(ENCLOSED);
    world = claim(&world, &cfg, 1, 0);
    let cell = Pos::new(3, 1);
    armed(&mut world, 1, cell, Need::Urine, 200);

    let (w1, e1) = step(&world, &[use_intent(1, cell)], 4, &cfg);
    assert_eq!(
        count(&e1, |kind| matches!(kind, EventKind::UseProgressed { .. })),
        1
    );
    let session = w1.session_of(1).expect("session").id;
    assert_eq!(w1.sessions[&session].use_ticks_done, 1);

    // A defence on the next tick must not advance, break or recover the use.
    let (w2, e2) = step(&w1, &[defend_intent(1, Pos::new(3, 0))], 4, &cfg);
    assert_eq!(w2.sessions[&session].use_ticks_done, 1, "the use paused");
    assert!(
        matches!(w2.agents[&1].action, Some(Action::Use { .. })),
        "the use action survives"
    );
    assert_eq!(w2.sessions[&session].recovery_deadline, None);
    assert_eq!(
        count(&e2, |kind| matches!(kind, EventKind::UseInterrupted { .. })),
        0
    );
    assert_eq!(
        count(&e2, |kind| matches!(kind, EventKind::UseProgressed { .. })),
        0
    );
    assert_eq!(
        count(&e2, |kind| matches!(kind, EventKind::DefendStarted { .. })),
        1
    );
    assert_eq!(
        w2.agents[&1].defending,
        Some(Pos::new(3, 0)),
        "the defence stays observable until the next tick starts"
    );
    assert_eq!(
        count(&e2, |kind| matches!(kind, EventKind::DefendEnded { .. })),
        0,
        "nothing ends a defence inside its own tick"
    );

    let (w3, e3) = step(&w2, &[], 4, &cfg);
    assert_eq!(w3.sessions[&session].use_ticks_done, 2, "the use resumes");
    assert_eq!(
        count(&e3, |kind| matches!(kind, EventKind::UseProgressed { .. })),
        1
    );
    assert_eq!(
        w3.agents[&1].defending, None,
        "the next tick expires the defence"
    );
    let ended = find_event(&e3, |kind| matches!(kind, EventKind::DefendEnded { .. }));
    assert_eq!(ended.text(), "dev-1 stopped defending");
    assert_eq!(ended.at(), None);
}

#[test]
fn defend_cooldown_two_ticks() {
    let cfg = Config::default();
    let mut world = build(ARENA);
    world = claim(&world, &cfg, 1, 0);
    place(&mut world, 1, A_POS);
    let target = NORTH_OF_A;

    let (w1, e1) = step(&world, &[defend_intent(1, target)], 8, &cfg);
    let started = find_event(&e1, |kind| matches!(kind, EventKind::DefendStarted { .. }));
    match &started.kind {
        EventKind::DefendStarted {
            target: at,
            until,
            cooldown_until,
            ..
        } => {
            assert_eq!(*at, target);
            assert_eq!(*until, 2, "the shield covers this tick only");
            assert_eq!(*cooldown_until, 4);
        }
        other => panic!("expected DefendStarted, got {other:?}"),
    }
    assert_eq!(
        started.text(),
        "dev-1 defends (2,0) this tick; defend cooldown until tick 4"
    );
    assert_eq!(
        count(&e1, |kind| matches!(kind, EventKind::DefendEnded { .. })),
        0,
        "the defence lapses at the start of the next tick, not inside its own"
    );

    let (w2, e2) = step(&w1, &[defend_intent(1, target)], 8, &cfg);
    let ended = find_event(&e2, |kind| matches!(kind, EventKind::DefendEnded { .. }));
    assert_eq!(ended.text(), "dev-1 stopped defending");
    assert_eq!(ended.at(), None);
    assert_eq!(w2.agents[&1].defending, None);
    assert_eq!(
        count(&e2, |kind| matches!(kind, EventKind::DefendStarted { .. })),
        0,
        "tick 2 is still on cooldown"
    );
    let reason = rejection_reason(&e2, 1);
    assert!(reason.contains("cooldown"), "tick 2: {reason}");
    assert!(reason.contains("until tick 4"), "tick 2: {reason}");

    let (w3, e3) = step(&w2, &[defend_intent(1, target)], 8, &cfg);
    assert_eq!(
        count(&e3, |kind| matches!(kind, EventKind::DefendStarted { .. })),
        0
    );
    let reason = rejection_reason(&e3, 1);
    assert!(reason.contains("cooldown"), "tick 3: {reason}");

    let (w4, e4) = step(&w3, &[defend_intent(1, target)], 8, &cfg);
    assert_eq!(
        count(&e4, |kind| matches!(kind, EventKind::DefendStarted { .. })),
        1,
        "tick 4 is off cooldown again"
    );
    assert_eq!(w4.agents[&1].defend_cooldown_until, 7);
}

#[test]
fn cannot_defend_own_cell() {
    let cfg = Config::default();
    let mut world = build(ARENA);
    world = claim(&world, &cfg, 1, 0);
    place(&mut world, 1, A_POS);

    let message = validate_defend(&world, 1, A_POS).expect_err("own cell is not defensible");
    assert!(message.contains("own cell"), "unexpected message {message}");

    let (next, events) = step(&world, &[defend_intent(1, A_POS)], 1, &cfg);
    assert_eq!(
        count(&events, |kind| matches!(
            kind,
            EventKind::DefendStarted { .. }
        )),
        0
    );
    let reason = rejection_reason(&events, 1);
    assert!(reason.contains("own cell"), "unexpected reason {reason}");
    assert!(next.agents[&1].defending.is_none());

    // The four-neighbour rule is separate from the own-cell rule.
    let far = validate_defend(&world, 1, Pos::new(5, 4)).expect_err("a far cell is not defensible");
    assert!(far.contains("out of reach"), "unexpected message {far}");
}

#[test]
fn defender_cannot_build_move_or_attack_that_tick() {
    let cfg = Config::default();
    let mut world = build(ARENA);
    world = claim(&world, &cfg, 1, 0);
    world = claim(&world, &cfg, 2, 0);
    place(&mut world, 1, A_POS);
    place(&mut world, 2, Pos::new(4, 1));
    world.agents.get_mut(&1).expect("mover").action = Some(Action::Move {
        dirs: [Dir::E].into(),
        total: 1,
        label: "old walk".to_string(),
    });
    let build_target = Pos::new(4, 0);
    world.agents.get_mut(&2).expect("builder").action = Some(Action::Build {
        kind: SiteKind::Wall,
        target: build_target,
        label: "build wall at (4,0)".to_string(),
    });

    let (next, events) = step(
        &world,
        &[
            defend_intent(1, NORTH_OF_A),
            defend_intent(2, Pos::new(5, 1)),
        ],
        2,
        &cfg,
    );

    for agent in [1u64, 2] {
        let finished = find_event(&events, |kind| {
            matches!(
                kind,
                EventKind::ActionFinished {
                    agent: who,
                    outcome: ActionOutcome::Cancelled,
                    ..
                } if *who == agent
            )
        });
        assert_eq!(finished.subject(), Some(agent));
    }
    assert_eq!(pos_of(&next, 1), A_POS, "the defending mover stayed");
    assert_eq!(
        count(&events, |kind| matches!(kind, EventKind::AgentMoved { .. })),
        0
    );
    assert_eq!(
        count(&events, |kind| matches!(
            kind,
            EventKind::ObjectChanged { .. }
        )),
        0
    );
    assert_eq!(next.object_at(build_target), None, "no site was started");
    assert_eq!(
        count(&events, |kind| matches!(
            kind,
            EventKind::DefendStarted { .. }
        )),
        2
    );
}

#[test]
fn attack_cooldown_until_after_windup() {
    let cfg = Config::default();
    let mut world = duel();
    // A second, never-stunned neighbour keeps the target rule out of the way.
    world = claim(&world, &cfg, 4, 0);
    place(&mut world, 4, NORTH_OF_A);

    let (w1, _) = step(&world, &[attack_intent(1, B_POS)], 11, &cfg);
    assert_eq!(w1.agents[&1].attack_cooldown_until, 7);
    let (w2, _) = step(&w1, &[], 11, &cfg);
    let (w3, _) = step(&w2, &[], 11, &cfg);
    let (w4, e4) = step(&w3, &[], 11, &cfg);
    assert_eq!(
        count(&e4, |kind| matches!(kind, EventKind::AttackLanded { .. })),
        1
    );
    assert_eq!(deadline_of(&w4, 2), 194);

    let (w5, e5) = step(&w4, &[attack_intent(1, NORTH_OF_A)], 11, &cfg);
    assert_eq!(
        count(&e5, |kind| matches!(kind, EventKind::AttackStarted { .. })),
        0
    );
    assert!(rejection_reason(&e5, 1).contains("cooldown"));
    assert!(rejection_reason(&e5, 1).contains("until tick 7"));

    let (w6, e6) = step(&w5, &[attack_intent(1, NORTH_OF_A)], 11, &cfg);
    assert_eq!(
        count(&e6, |kind| matches!(kind, EventKind::AttackStarted { .. })),
        0
    );
    assert!(rejection_reason(&e6, 1).contains("cooldown"));

    let (w7, e7) = step(&w6, &[attack_intent(1, NORTH_OF_A)], 11, &cfg);
    assert_eq!(
        count(&e7, |kind| matches!(kind, EventKind::AttackStarted { .. })),
        1,
        "tick 7 is off cooldown: {e7:?}"
    );
    match w7.agents[&1].action.clone() {
        Some(Action::Attack {
            target_agent,
            target_pos,
            land_tick,
            ..
        }) => {
            assert_eq!(target_agent, 4);
            assert_eq!(target_pos, NORTH_OF_A);
            assert_eq!(land_tick, 10);
        }
        other => panic!("expected a fresh attack, got {other:?}"),
    }
}

#[test]
fn stunned_agent_can_be_swapped() {
    let cfg = Config::default();
    let mut base = build(ARENA);
    base = claim(&base, &cfg, 1, 0);
    base = claim(&base, &cfg, 2, 0);
    base = claim(&base, &cfg, 3, 0);
    place(&mut base, 1, A_POS);
    armed(&mut base, 2, B_POS, Need::Urine, 200);
    place(&mut base, 3, Pos::new(4, 1));

    let (world, _) = run_until(&base, &[attack_intent(1, B_POS)], 4, 12, &cfg);
    assert!(is_stunned(&world.agents[&2], 5));

    let (next, events) = step(&world, &[move_intent(3, &[Dir::W])], 12, &cfg);
    let swapped = find_event(&events, |kind| {
        matches!(kind, EventKind::AgentSwapped { .. })
    });
    match &swapped.kind {
        EventKind::AgentSwapped {
            agent,
            other_agent,
            from,
            to,
            other_from,
            other_to,
            ..
        } => {
            assert_eq!(*agent, 3);
            assert_eq!(*other_agent, 2);
            assert_eq!((*from, *to), (Pos::new(4, 1), B_POS));
            assert_eq!((*other_from, *other_to), (B_POS, Pos::new(4, 1)));
        }
        other => panic!("expected AgentSwapped, got {other:?}"),
    }
    assert_eq!(next.agent_at(B_POS).expect("cell taken").id, 3);
    assert_eq!(next.agent_at(Pos::new(4, 1)).expect("cell taken").id, 2);
    assert!(next.agents[&2].action.is_none());
    assert_eq!(deadline_of(&next, 2), 194, "the swap costs no deadline");
}

#[test]
fn restore_keeps_windup_stun_immunity_and_cooldowns() {
    let cfg = Config::default();
    let world = duel();

    // The windup: a snapshot in the middle of it must rebuild the same world.
    let (w1, _) = step(&world, &[attack_intent(1, B_POS)], 15, &cfg);
    let snapshot = Snapshot::new(w1.clone());
    let mut live = w1.clone();
    let mut windup_events = Vec::new();
    for _ in 0..2 {
        let (next, events) = step(&live, &[], 15, &cfg);
        live = next;
        windup_events.extend(events);
    }
    assert_eq!(live.tick, 3);
    let restored = restore(&snapshot, &windup_events, &cfg).expect("windup log restores");
    let diffs = diff_worlds(&live, &restored);
    assert!(diffs.is_empty(), "windup restore differs: {diffs:?}");
    match restored.agents[&1].action.clone() {
        Some(Action::Attack {
            target_agent,
            land_tick,
            ..
        }) => {
            assert_eq!(target_agent, 2);
            assert_eq!(land_tick, 4);
        }
        other => panic!("the restored windup is {other:?}"),
    }

    // The landing plus a defence: every combat field must come back.
    let (landed, land_events) = step(&live, &[], 15, &cfg);
    assert_eq!(
        count(&land_events, |kind| matches!(
            kind,
            EventKind::AttackLanded { .. }
        )),
        1
    );
    let snapshot = Snapshot::new(landed.clone());
    let (after, after_events) = step(&landed, &[defend_intent(3, B_POS)], 15, &cfg);
    let restored = restore(&snapshot, &after_events, &cfg).expect("combat log restores");
    let diffs = diff_worlds(&after, &restored);
    assert!(diffs.is_empty(), "combat restore differs: {diffs:?}");

    assert_eq!(deadline_of(&restored, 2), 194);
    assert_eq!(restored.agents[&2].stun_until, 8);
    assert_eq!(restored.agents[&2].immunity_until, 11);
    assert_eq!(restored.agents[&1].attack_cooldown_until, 7);
    assert_eq!(restored.agents[&3].defend_cooldown_until, 8);
    assert_eq!(
        restored.agents[&3].defending,
        Some(B_POS),
        "a defence stays observable until the next tick starts"
    );
    assert_eq!(after.agents[&3].defending, Some(B_POS));

    // The new serde shapes survive a round trip, including the action.
    for action in [
        Action::Attack {
            target_agent: 2,
            target_pos: B_POS,
            land_tick: 4,
            label: "attack the agent at (3,1)".to_string(),
        },
        Action::Use {
            target: B_POS,
            label: "use the toilet".to_string(),
        },
    ] {
        let json = serde_json::to_string(&action).expect("the action serializes");
        let back: Action = serde_json::from_str(&json).expect("the action deserializes");
        assert_eq!(back, action);
    }
    for kind in [
        IntentKind::Attack { target: B_POS },
        IntentKind::Defend { target: B_POS },
    ] {
        let json = serde_json::to_string(&kind).expect("the intent serializes");
        let back: IntentKind = serde_json::from_str(&json).expect("the intent deserializes");
        assert_eq!(back, kind);
    }
}

#[test]
fn attack_cannot_reach_through_wall_or_closed_door() {
    let cfg = Config::default();
    for text in [WALL_BETWEEN, DOOR_BETWEEN] {
        let mut world = build(text);
        world = claim(&world, &cfg, 1, 0);
        world = claim(&world, &cfg, 2, 0);
        place(&mut world, 1, Pos::new(1, 1));
        place(&mut world, 2, B_POS);

        let message =
            validate_attack(&world, 1, B_POS, &cfg).expect_err("the target is one cell too far");
        assert!(
            message.contains("no unstunned agent"),
            "unexpected message {message}"
        );

        let (next, events) = step(&world, &[attack_intent(1, B_POS)], 1, &cfg);
        assert_eq!(
            count(&events, |kind| matches!(
                kind,
                EventKind::AttackStarted { .. }
            )),
            0
        );
        let reason = rejection_reason(&events, 1);
        assert!(
            reason.contains("no unstunned agent"),
            "unexpected reason {reason}"
        );
        assert!(next.agents[&1].action.is_none());
        assert_eq!(next.agents[&1].attack_cooldown_until, 0);
    }
}

#[test]
fn defend_does_not_block_upgrade() {
    let cfg = Config::default();
    let mut world = build(TOILET_ARENA);
    world = claim(&world, &cfg, 1, 3000); // level 3, enough for a level-2 toilet
    world = claim(&world, &cfg, 2, 0);
    place(&mut world, 1, Pos::new(2, 1));
    place(&mut world, 2, Pos::new(1, 2));
    let toilet = Pos::new(2, 2);

    let (next, events) = step(
        &world,
        &[upgrade_intent(1, toilet), defend_intent(2, toilet)],
        5,
        &cfg,
    );

    assert_eq!(
        next.object_at(toilet),
        Some(Object::Toilet {
            level: 2,
            progress: 1
        }),
        "the upgrade applies under a defence"
    );
    assert_eq!(
        count(&events, |kind| matches!(
            kind,
            EventKind::ObjectChanged {
                cause: loo_core::ObjectCause::Upgrade,
                ..
            }
        )),
        1
    );
    assert_eq!(
        count(&events, |kind| matches!(
            kind,
            EventKind::DefendStarted { .. }
        )),
        1
    );
    assert_eq!(
        count(&events, |kind| matches!(
            kind,
            EventKind::DemolishBlocked { .. }
        )),
        0
    );
    assert!(matches!(
        next.agents[&1].action,
        Some(Action::Upgrade { .. })
    ));
}

#[test]
fn defend_replaces_a_windup_attack() {
    let cfg = Config::default();
    let world = duel();

    let (w1, _) = step(&world, &[attack_intent(1, B_POS)], 3, &cfg);
    assert!(matches!(w1.agents[&1].action, Some(Action::Attack { .. })));
    let (w2, e2) = step(&w1, &[defend_intent(1, NORTH_OF_A)], 3, &cfg);

    let cancelled = find_event(
        &e2,
        |kind| matches!(kind, EventKind::AttackCancelled { agent, .. } if *agent == 1),
    );
    match &cancelled.kind {
        EventKind::AttackCancelled { at, reason, .. } => {
            assert_eq!(*at, B_POS, "the event names the abandoned target cell");
            assert!(reason.contains("replaced by defend"), "reason {reason}");
        }
        other => panic!("expected AttackCancelled, got {other:?}"),
    }
    assert!(w2.agents[&1].action.is_none(), "the windup is gone");
    assert_eq!(
        count(&e2, |kind| matches!(kind, EventKind::DefendStarted { .. })),
        1
    );

    // The abandoned attack never lands.
    let (w3, _) = step(&w2, &[], 3, &cfg);
    let (w4, e4) = step(&w3, &[], 3, &cfg);
    assert_eq!(
        count(&e4, |kind| matches!(kind, EventKind::AttackLanded { .. })),
        0
    );
    assert_eq!(deadline_of(&w4, 2), 200);
    assert_eq!(w4.agents[&2].stun_until, 0);
}

#[test]
fn stunned_cancel_still_stops_a_use() {
    let cfg = Config::default();
    let mut world = build(ENCLOSED);
    world = claim(&world, &cfg, 1, 0);
    let cell = Pos::new(3, 1);
    armed(&mut world, 1, cell, Need::Urine, 200);
    let session = world.session_of(1).expect("session").id;
    world
        .sessions
        .get_mut(&session)
        .expect("session")
        .use_ticks_done = 2;
    world.agents.get_mut(&1).expect("agent").action = Some(Action::Use {
        target: cell,
        label: "use the toilet".to_string(),
    });
    world.agents.get_mut(&1).expect("agent").stun_until = 5;

    let (next, events) = step(
        &world,
        &[Intent {
            agent: 1,
            kind: IntentKind::Cancel,
        }],
        1,
        &cfg,
    );
    let interrupted = find_event(&events, |kind| {
        matches!(kind, EventKind::UseInterrupted { .. })
    });
    match &interrupted.kind {
        EventKind::UseInterrupted {
            reason,
            recovery_deadline,
            ..
        } => {
            assert_eq!(reason, "cancelled");
            assert_eq!(*recovery_deadline, 13);
        }
        other => panic!("expected UseInterrupted, got {other:?}"),
    }
    assert!(next.agents[&1].action.is_none());
    assert_eq!(
        next.sessions[&session].use_ticks_done, 2,
        "progress is kept"
    );
    assert_eq!(next.sessions[&session].recovery_deadline, Some(13));
    assert_eq!(
        count(&events, |kind| matches!(
            kind,
            EventKind::ActionRejected { .. }
        )),
        0,
        "a cancel is never rejected for a stun"
    );
}

#[test]
fn validation_at_tick_uses_the_settlement_tick() {
    let cfg = Config::default();
    let mut world = build(ARENA);
    world = claim(&world, &cfg, 1, 0);
    world = claim(&world, &cfg, 2, 0);
    place(&mut world, 1, A_POS);
    place(&mut world, 2, NORTH_OF_A);

    // An attack started on tick 1 is off cooldown from tick 7.
    let (w1, _) = step(&world, &[attack_intent(1, NORTH_OF_A)], 6, &cfg);
    assert_eq!(w1.agents[&1].attack_cooldown_until, 7);
    assert!(
        validate_attack_at(&w1, 1, NORTH_OF_A, &cfg, 7).is_ok(),
        "the cooldown is over on its own tick, so a command for tick 7 is legal"
    );
    let err =
        validate_attack_at(&w1, 1, NORTH_OF_A, &cfg, 6).expect_err("tick 6 is one tick too early");
    assert!(
        err.contains("cooldown") && err.contains("until tick 7"),
        "{err}"
    );
    assert!(
        validate_attack(&w1, 1, NORTH_OF_A, &cfg).is_err(),
        "the wrapper asks about the current tick and is still on cooldown"
    );

    // A defence settled on tick 1 is off cooldown from tick 4.
    let (d1, _) = step(&world, &[defend_intent(2, A_POS)], 6, &cfg);
    assert_eq!(d1.agents[&2].defend_cooldown_until, 4);
    assert!(
        validate_defend_at(&d1, 2, A_POS, 4).is_ok(),
        "the defend cooldown is over on tick 4"
    );
    let err = validate_defend_at(&d1, 2, A_POS, 3).expect_err("tick 3 is one tick too early");
    assert!(
        err.contains("cooldown") && err.contains("until tick 4"),
        "{err}"
    );
    assert!(validate_defend(&d1, 2, A_POS).is_err());
}

#[test]
fn last_intent_wins_and_defend_is_not_double_rejected() {
    let cfg = Config::default();
    let mut world = build(ARENA);
    world = claim(&world, &cfg, 1, 0);
    place(&mut world, 1, A_POS);

    // [Move, Defend]: the defence is the last word, so the move never runs.
    let (w1, e1) = step(
        &world,
        &[move_intent(1, &[Dir::E]), defend_intent(1, NORTH_OF_A)],
        4,
        &cfg,
    );
    assert_eq!(pos_of(&w1, 1), A_POS, "the overwritten move never ran");
    assert_eq!(
        count(&e1, |kind| matches!(kind, EventKind::AgentMoved { .. })),
        0
    );
    assert_eq!(
        count(&e1, |kind| matches!(kind, EventKind::DefendStarted { .. })),
        1
    );
    assert_eq!(w1.agents[&1].defending, Some(NORTH_OF_A));

    // [Defend, Move]: the move is the last word, so there is no defence.
    let (w2, e2) = step(
        &w1,
        &[defend_intent(1, NORTH_OF_A), move_intent(1, &[Dir::E])],
        4,
        &cfg,
    );
    assert_eq!(
        count(&e2, |kind| matches!(kind, EventKind::DefendStarted { .. })),
        0,
        "a later move replaces the defence"
    );
    assert_eq!(pos_of(&w2, 1), Pos::new(3, 1), "the move ran one cell east");
    assert_eq!(w2.agents[&1].defending, None);

    // A stunned defender is rejected once: by the defence pass, not twice.
    let mut stunned = build(ARENA);
    stunned = claim(&stunned, &cfg, 1, 0);
    place(&mut stunned, 1, A_POS);
    stunned.agents.get_mut(&1).expect("agent").stun_until = 5;
    let (w3, e3) = step(&stunned, &[defend_intent(1, NORTH_OF_A)], 4, &cfg);
    assert_eq!(
        count(&e3, |kind| matches!(kind, EventKind::ActionRejected { .. })),
        1,
        "exactly one rejection: {e3:?}"
    );
    assert!(rejection_reason(&e3, 1).contains("stunned"));
    assert_eq!(w3.agents[&1].defending, None);
}

#[test]
fn defending_is_visible_between_ticks_and_cleared_on_the_next() {
    let cfg = Config::default();
    let mut world = build(ARENA);
    world = claim(&world, &cfg, 1, 0);
    place(&mut world, 1, A_POS);

    let (w1, e1) = step(&world, &[defend_intent(1, NORTH_OF_A)], 1, &cfg);
    assert_eq!(
        w1.agents[&1].defending,
        Some(NORTH_OF_A),
        "a status read between ticks sees the shield"
    );
    assert_eq!(
        count(&e1, |kind| matches!(kind, EventKind::DefendEnded { .. })),
        0
    );

    let snapshot = Snapshot::new(w1.clone());
    let (w2, e2) = step(&w1, &[], 1, &cfg);
    assert_eq!(w2.agents[&1].defending, None, "the next tick clears it");
    assert_eq!(
        count(&e2, |kind| matches!(kind, EventKind::DefendEnded { .. })),
        1
    );
    assert!(matches!(e2[0].kind, EventKind::TickSettled));
    assert!(
        matches!(e2[1].kind, EventKind::DefendEnded { .. }),
        "the lapse is the first thing the tick does: {e2:?}"
    );

    let restored = restore(&snapshot, &e2, &cfg).expect("the lapse restores");
    let diffs = diff_worlds(&w2, &restored);
    assert!(diffs.is_empty(), "defence restore differs: {diffs:?}");
}
