//! SSE object deltas: `delta_objects` correctness and the wire shape of
//! full versus delta projections.

use loo_core::{map, Config, Object, WorldState};
use loo_proto::{ObjectsMode, Pos, Projection, ProjectionObject};
use loo_server::projection::{build, delta_objects};
use std::collections::BTreeMap;

const TEST_MAP: &str = "\
grid
#########
#.......#
#.......#
qE......#
#.......#
#########
";

fn world() -> WorldState {
    let def = map::parse(TEST_MAP).expect("test map parses");
    let mut world = WorldState::new(def);
    world.set_object(
        Pos::new(3, 1),
        Some(Object::Door {
            open: false,
            damage: 0,
        }),
    );
    world.set_object(
        Pos::new(5, 2),
        Some(Object::Toilet {
            level: 1,
            progress: 0,
        }),
    );
    world
}

fn objects(cfg: &Config, world: &WorldState) -> Vec<ProjectionObject> {
    build(cfg, world, &BTreeMap::new(), &[]).objects
}

/// Applies a delta the way the client does and returns pos-sorted objects.
fn apply(
    prev: &[ProjectionObject],
    changed: &[ProjectionObject],
    removed: &[Pos],
) -> Vec<ProjectionObject> {
    let mut table: BTreeMap<Pos, ProjectionObject> =
        prev.iter().map(|o| (o.pos, o.clone())).collect();
    for pos in removed {
        table.remove(pos);
    }
    for object in changed {
        table.insert(object.pos, object.clone());
    }
    table.into_values().collect()
}

fn sorted(objects: &[ProjectionObject]) -> Vec<ProjectionObject> {
    let mut out = objects.to_vec();
    out.sort_by_key(|o| o.pos);
    out
}

fn assert_roundtrip(prev: &[ProjectionObject], next: &[ProjectionObject]) {
    let (changed, removed) = delta_objects(prev, next);
    assert_eq!(apply(prev, &changed, &removed), sorted(next));
}

#[test]
fn an_unchanged_tick_yields_an_empty_delta() {
    let cfg = Config::default();
    let w = world();
    let prev = objects(&cfg, &w);
    assert!(prev.len() > 10, "the map has walls plus two objects");
    let (changed, removed) = delta_objects(&prev, &objects(&cfg, &w));
    assert!(changed.is_empty());
    assert!(removed.is_empty());
}

#[test]
fn a_demolished_wall_is_a_removal_only() {
    let cfg = Config::default();
    let mut w = world();
    let prev = objects(&cfg, &w);
    w.set_object(Pos::new(0, 0), None);
    let next = objects(&cfg, &w);
    let (changed, removed) = delta_objects(&prev, &next);
    assert!(changed.is_empty());
    assert_eq!(removed, vec![Pos::new(0, 0)]);
    assert_roundtrip(&prev, &next);
}

#[test]
fn a_new_object_and_a_cracked_wall_are_changes() {
    let cfg = Config::default();
    let mut w = world();
    let prev = objects(&cfg, &w);
    w.set_object(Pos::new(2, 2), Some(Object::Wall { damage: 0 }));
    w.set_object(Pos::new(1, 0), Some(Object::Wall { damage: 3 }));
    let next = objects(&cfg, &w);
    let (changed, removed) = delta_objects(&prev, &next);
    assert!(removed.is_empty());
    let positions: Vec<Pos> = changed.iter().map(|o| o.pos).collect();
    // `next` order is y then x.
    assert_eq!(positions, vec![Pos::new(1, 0), Pos::new(2, 2)]);
    assert!(changed[0].crack);
    assert_roundtrip(&prev, &next);
}

#[test]
fn a_door_toggle_is_one_change() {
    let cfg = Config::default();
    let mut w = world();
    let prev = objects(&cfg, &w);
    w.set_object(
        Pos::new(3, 1),
        Some(Object::Door {
            open: true,
            damage: 0,
        }),
    );
    let next = objects(&cfg, &w);
    let (changed, removed) = delta_objects(&prev, &next);
    assert!(removed.is_empty());
    assert_eq!(changed.len(), 1);
    assert_eq!(changed[0].pos, Pos::new(3, 1));
    assert!(changed[0].open);
    assert_roundtrip(&prev, &next);
}

#[test]
fn toilet_progress_and_level_changes_are_changes() {
    let cfg = Config::default();
    let mut w = world();
    let prev = objects(&cfg, &w);
    w.set_object(
        Pos::new(5, 2),
        Some(Object::Toilet {
            level: 1,
            progress: 4,
        }),
    );
    let mid = objects(&cfg, &w);
    let (changed, removed) = delta_objects(&prev, &mid);
    assert!(removed.is_empty());
    assert_eq!(changed.len(), 1);
    assert_eq!(changed[0].progress, 4);
    assert_roundtrip(&prev, &mid);

    w.set_object(
        Pos::new(5, 2),
        Some(Object::Toilet {
            level: 2,
            progress: 0,
        }),
    );
    let next = objects(&cfg, &w);
    let (changed, _) = delta_objects(&mid, &next);
    assert_eq!(changed.len(), 1);
    assert_eq!(changed[0].level, 2);
    assert_roundtrip(&mid, &next);
}

#[test]
fn mixed_changes_apply_to_the_next_table_exactly() {
    let cfg = Config::default();
    let mut w = world();
    let prev = objects(&cfg, &w);
    w.set_object(Pos::new(0, 0), None);
    w.set_object(Pos::new(8, 5), None);
    w.set_object(
        Pos::new(3, 1),
        Some(Object::Door {
            open: true,
            damage: 1,
        }),
    );
    w.set_object(
        Pos::new(5, 2),
        Some(Object::Toilet {
            level: 1,
            progress: 2,
        }),
    );
    w.set_object(Pos::new(4, 4), Some(Object::Wall { damage: 0 }));
    let next = objects(&cfg, &w);
    let (changed, removed) = delta_objects(&prev, &next);
    assert_eq!(removed, vec![Pos::new(0, 0), Pos::new(8, 5)]);
    assert_eq!(changed.len(), 3);
    assert_roundtrip(&prev, &next);
}

#[test]
fn full_omits_the_delta_keys_and_delta_carries_them() {
    let cfg = Config::default();
    let w = world();
    let full: Projection = build(&cfg, &w, &BTreeMap::new(), &[]);
    assert_eq!(full.objects_mode, ObjectsMode::Full);
    let text = serde_json::to_string(&full).unwrap();
    assert!(!text.contains("objects_mode"), "full JSON: {text}");
    assert!(!text.contains("objects_removed"), "full JSON: {text}");
    // An old payload without the keys reads back as full.
    let back: Projection = serde_json::from_str(&text).unwrap();
    assert_eq!(back, full);

    let delta = Projection {
        objects: Vec::new(),
        objects_mode: ObjectsMode::Delta,
        objects_removed: vec![Pos::new(0, 0)],
        ..full
    };
    let value: serde_json::Value = serde_json::to_value(&delta).unwrap();
    assert_eq!(value["objects_mode"], "delta");
    assert_eq!(value["objects_removed"][0]["x"], 0);
    let back: Projection = serde_json::from_value(value).unwrap();
    assert_eq!(back, delta);
}
