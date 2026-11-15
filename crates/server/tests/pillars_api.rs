//! The v1.6 pillars through the server: the default map's stall corners in the
//! world, projection and view, the rules text, and refusal to open a toilet
//! that has no corner pillars.

use loo_core::{map, Config, Object};
use loo_proto::{
    JoinRequest, MoveRequest, MoveSpec, Nick, ObjectKind, Pos, RegisterRequest, SentBy,
};
use loo_server::{Server, StoreError};
use std::path::PathBuf;
use std::sync::Arc;

const DEFAULT_MAP: &str = include_str!("../../../maps/default.txt");

const DEFAULT_PILLARS: [Pos; 12] = [
    Pos::new(12, 9),
    Pos::new(14, 9),
    Pos::new(12, 11),
    Pos::new(14, 11),
    Pos::new(12, 20),
    Pos::new(14, 20),
    Pos::new(12, 22),
    Pos::new(14, 22),
    Pos::new(29, 18),
    Pos::new(31, 18),
    Pos::new(29, 20),
    Pos::new(31, 20),
];

const RULE_SENTENCE: &str = "Building a toilet claims the 3x3 centred on it: its four corner cells become pillars. Starting a toilet needs all nine cells inside the map, the four corners buildable, empty and free of agents, and no overlap with another toilet's 3x3. Pillars block movement and cannot be built on, demolished or defended. They disappear in the same tick the toilet is gone. The four side cells are ordinary cells.";

const CORNERLESS: &str = "\
grid
#########
#.......#
#...1...#
qE......#
#.......#
#########
";

fn fresh_dir(name: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("pillars-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn open_map(name: &str, map_text: &str) -> Arc<Server> {
    let dir = fresh_dir(name);
    let mut cfg = Config::default();
    cfg.limits.requests_per_second = 0;
    let def = map::parse(map_text).expect("test map parses");
    Arc::new(Server::open(cfg, def, "test", map_text, &dir, 7).expect("server opens"))
}

async fn register(server: &Arc<Server>, name: &str) -> String {
    let envelope = server
        .dev_register(RegisterRequest {
            name: Some(Nick::parse(name).expect("valid nick")),
            model: Some("test-model".to_string()),
            intro: Some("test agent".to_string()),
        })
        .await;
    envelope.result.expect("registration succeeds").token
}

#[tokio::test]
async fn default_map_stalls_carry_twelve_pillars_in_world_projection_and_view() {
    let server = open_map("default", DEFAULT_MAP);
    let world = server.world_state().await;
    for pillar in DEFAULT_PILLARS {
        assert_eq!(
            world.object_at(pillar),
            Some(Object::Pillar),
            "pillar at {pillar}"
        );
    }

    let projection = server.current_projection().await;
    let mut pillars: Vec<Pos> = projection
        .objects
        .iter()
        .filter(|object| object.kind == ObjectKind::Pillar)
        .map(|object| object.pos)
        .collect();
    pillars.sort_by_key(|pos| (pos.y, pos.x));
    let mut expected = DEFAULT_PILLARS.to_vec();
    expected.sort_by_key(|pos| (pos.y, pos.x));
    assert_eq!(pillars, expected, "the projection lists the twelve pillars");

    let token = register(&server, "dev-walker").await;
    let joined = server
        .join(
            &token,
            JoinRequest {
                sent_by: SentBy::Self_,
                why: "testing".to_string(),
            },
        )
        .await;
    assert!(joined.ok, "{:?}", joined.error);
    let queued = server
        .move_cmd(
            &token,
            MoveRequest {
                spec: MoveSpec::Path {
                    path: "EEEEEEENNN".to_string(),
                },
            },
        )
        .await;
    assert!(queued.ok, "{:?}", queued.error);
    for _ in 0..10 {
        server.tick_once().await;
    }
    let state = server.status(&token).await.state.expect("state");
    assert_eq!(
        state.pos,
        Some(Pos::new(13, 12)),
        "the walker reaches (13,12)"
    );

    let look = server.look(&token).await.result.expect("look result");
    let rows = look.grid.rows.join("\n");
    assert!(rows.contains('*'), "the view shows a pillar: {rows}");
    assert!(
        look.grid
            .legend
            .iter()
            .any(|entry| entry.symbol == "*" && entry.meaning.contains("pillar")),
        "the legend names the pillar: {:?}",
        look.grid.legend
    );

    let rules = server.rules().await.result.expect("rules").text;
    assert!(
        rules.contains(RULE_SENTENCE),
        "rules text carries the pillar paragraph"
    );
}

#[test]
fn a_toilet_without_its_corner_pillars_refuses_to_open() {
    let dir = fresh_dir("cornerless");
    let mut cfg = Config::default();
    cfg.limits.requests_per_second = 0;
    let def = map::parse(CORNERLESS).expect("test map parses");
    match Server::open(cfg, def, "test", CORNERLESS, &dir, 7) {
        Ok(_) => panic!("a toilet without corner pillars must not open"),
        Err(error) => {
            let message = error.to_string();
            assert!(
                message.contains("without its four corner pillars"),
                "{message}"
            );
            assert!(matches!(error, StoreError::Corrupt(_)), "{message}");
        }
    }
}
