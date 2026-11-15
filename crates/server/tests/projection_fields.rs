use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use loo_core::{join, map, step, Config, Intent, IntentKind, JoinCommand, WorldState};
use loo_proto::{
    AgentPose, AttackRequest, BuildKind, BuildRequest, Dir, JoinRequest, MoveRequest, MoveSpec,
    Nick, Pos, Projection, ProjectionAgent, RegisterRequest, SentBy, TargetSpec,
};
use loo_server::projection::{build, AgentPublic};
use loo_server::Server;

const ARENA: &str = "\
grid
#########
#.......#
#.......#
qE......#
#.......#
#########
";

const TOILET_ROOM: &str = "\
grid
#######
###1###
#######
#qE...#
#######
";

const DEFAULT_MAP: &str = include_str!("../../../maps/default.txt");

const RENDER_ONLY_KEYS: [&str; 4] = [
    "action_target",
    "attack_land_tick",
    "recovery_deadline",
    "urgent",
];

fn fresh_dir(name: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("render-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn open_map(dir: &Path, mut cfg: Config, map_text: &str) -> Arc<Server> {
    cfg.limits.requests_per_second = 0;
    let def = map::parse(map_text).expect("test map parses");
    Arc::new(Server::open(cfg, def, "test", map_text, dir, 7).expect("server opens"))
}

async fn register(server: &Arc<Server>, name: &str) -> (String, u64) {
    let envelope = server
        .dev_register(RegisterRequest {
            name: Some(Nick::parse(name).expect("valid nick")),
            model: Some("test-model".to_string()),
            intro: Some("test agent".to_string()),
        })
        .await;
    let result = envelope.result.expect("registration succeeds");
    (result.token, result.agent_id)
}

async fn join_agent(server: &Arc<Server>, token: &str) {
    let envelope = server
        .join(
            token,
            JoinRequest {
                sent_by: SentBy::Self_,
                why: "testing".to_string(),
            },
        )
        .await;
    assert!(envelope.ok, "join failed: {:?}", envelope.error);
}

async fn move_path(server: &Arc<Server>, token: &str, path: &str) {
    let queued = server
        .move_cmd(
            token,
            MoveRequest {
                spec: MoveSpec::Path {
                    path: path.to_string(),
                },
            },
        )
        .await;
    assert!(queued.ok, "move {path} was rejected: {:?}", queued.error);
    for _ in 0..path.chars().count() {
        server.tick_once().await;
    }
}

async fn adjacent_pair(server: &Arc<Server>) -> ((String, u64), (String, u64)) {
    let a = register(server, "dev-a").await;
    join_agent(server, &a.0).await;
    move_path(server, &a.0, "EE").await;
    let b = register(server, "dev-b").await;
    join_agent(server, &b.0).await;
    move_path(server, &b.0, "E").await;
    (a, b)
}

fn agent_in(projection: &Projection, id: u64) -> &ProjectionAgent {
    projection
        .agents
        .iter()
        .find(|agent| agent.id == id)
        .expect("agent is on the projection")
}

fn collect_render_keys(value: &serde_json::Value, found: &mut Vec<String>) {
    match value {
        serde_json::Value::Object(fields) => {
            for (key, child) in fields {
                if RENDER_ONLY_KEYS.contains(&key.as_str()) {
                    found.push(key.clone());
                }
                collect_render_keys(child, found);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_render_keys(item, found);
            }
        }
        _ => {}
    }
}

#[tokio::test]
async fn attack_projects_its_target_and_landing_tick() {
    let dir = fresh_dir("attack");
    let cfg = Config::default();
    let server = open_map(&dir, cfg.clone(), ARENA);
    let (a, _b) = adjacent_pair(&server).await;

    let queued = server.attack_cmd(&a.0, AttackRequest { dir: Dir::W }).await;
    assert!(queued.ok, "attack rejected: {:?}", queued.error);
    let effective = queued.result.expect("queued attack").effective_tick;
    server.tick_once().await;

    let projection = server.current_projection().await;
    let attacker = agent_in(&projection, a.1);
    assert_eq!(attacker.pose, AgentPose::Attacking);
    assert_eq!(attacker.action_target, Some(Pos::new(2, 3)));
    assert_eq!(
        attacker.attack_land_tick,
        Some(effective + u64::from(cfg.combat.windup_ticks))
    );
}

#[tokio::test]
async fn building_projects_its_site_and_walking_has_no_target() {
    let dir = fresh_dir("build-walk");
    let server = open_map(&dir, Config::default(), ARENA);
    let (a, _) = adjacent_pair(&server).await;
    let walker = register(&server, "dev-c").await;
    join_agent(&server, &walker.0).await;

    let built = server
        .build_cmd(
            &a.0,
            BuildRequest {
                kind: BuildKind::Wall,
                target: TargetSpec::Dir(Dir::S),
            },
        )
        .await;
    assert!(built.ok, "build rejected: {:?}", built.error);
    let moved = server
        .move_cmd(
            &walker.0,
            MoveRequest {
                spec: MoveSpec::Path {
                    path: "NNN".to_string(),
                },
            },
        )
        .await;
    assert!(moved.ok, "move rejected: {:?}", moved.error);
    server.tick_once().await;

    let projection = server.current_projection().await;
    let builder = agent_in(&projection, a.1);
    assert_eq!(builder.pose, AgentPose::Working);
    assert_eq!(builder.action_target, Some(Pos::new(3, 4)));
    assert_eq!(builder.attack_land_tick, None);
    let walking = agent_in(&projection, walker.1);
    assert_eq!(walking.pose, AgentPose::Walking);
    assert_eq!(walking.action_target, None);
    assert_eq!(walking.attack_land_tick, None);
}

#[test]
fn urgent_turns_on_exactly_at_the_warning_window() {
    let cfg = Config::default();
    let warning = u64::from(cfg.need.deadline_warning_ticks);
    let arena = map::parse(ARENA).expect("arena parses");
    let cmd = JoinCommand {
        agent: 1,
        nick: Nick::parse("dev-1").expect("valid nick"),
        session: 1,
        score_total: 0,
    };
    let (joined, _, _) = join(&WorldState::new(arena), &cmd, &cfg, 0, 9).expect("join");
    let (mut world, _) = step(&joined, &[], 9, &cfg);
    let urgent = |world: &WorldState| {
        let projection = build(&cfg, world, &BTreeMap::<u64, AgentPublic>::new(), &[]);
        agent_in(&projection, 1).urgent
    };

    world.sessions.get_mut(&1).expect("session").deadline = world.tick + warning;
    assert!(urgent(&world), "urgent at the warning edge");
    world.sessions.get_mut(&1).expect("session").deadline = world.tick + warning + 1;
    assert!(!urgent(&world), "not urgent one tick before the edge");
}

#[test]
fn an_interrupted_use_projects_its_recovery_deadline() {
    let cfg = Config::default();
    let toilet = Pos::new(3, 1);
    let room = map::parse(TOILET_ROOM).expect("room parses");
    let cmd = JoinCommand {
        agent: 1,
        nick: Nick::parse("dev-1").expect("valid nick"),
        session: 1,
        score_total: 0,
    };
    let (mut joined, _, _) = join(&WorldState::new(room), &cmd, &cfg, 0, 9).expect("join");
    joined.agents.get_mut(&1).expect("agent").pos = Some(toilet);

    let (using, _) = step(
        &joined,
        &[Intent {
            agent: 1,
            kind: IntentKind::Use { target: toilet },
        }],
        10,
        &cfg,
    );
    let (interrupted, events) = step(
        &using,
        &[Intent {
            agent: 1,
            kind: IntentKind::Move {
                dirs: vec![Dir::E],
                label: "step out".to_string(),
            },
        }],
        11,
        &cfg,
    );
    let projection = build(
        &cfg,
        &interrupted,
        &BTreeMap::<u64, AgentPublic>::new(),
        &events,
    );
    assert!(
        agent_in(&projection, 1).recovery_deadline.is_some(),
        "an interrupted use carries a recovery deadline"
    );
}

#[tokio::test]
async fn terrain_marks_the_outer_walls_as_wilderness() {
    let dir = fresh_dir("terrain");
    let def = map::parse(DEFAULT_MAP).expect("default map parses");
    let server = Arc::new(
        Server::open(Config::default(), def, "default", DEFAULT_MAP, &dir, 7)
            .expect("server opens"),
    );
    let terrain = server.terrain().await;
    let glyph = |x: usize, y: usize| terrain.rows[y].as_bytes()[x] as char;
    assert_eq!(glyph(0, 0), '~', "outer corner is wilderness");
    assert_eq!(glyph(6, 16), '~', "the wall that closes the overflow lane");
    assert_ne!(
        glyph(13, 9),
        '~',
        "a preset toilet's wall is not wilderness"
    );
    assert_eq!(glyph(7, 1), '.', "open buildable ground");
}

#[tokio::test]
async fn look_json_keeps_the_cli_shape() {
    let dir = fresh_dir("look");
    let server = open_map(&dir, Config::default(), ARENA);
    let (a, _b) = adjacent_pair(&server).await;
    let queued = server.attack_cmd(&a.0, AttackRequest { dir: Dir::W }).await;
    assert!(queued.ok, "attack rejected: {:?}", queued.error);
    server.tick_once().await;

    let look = server.look(&a.0).await;
    assert!(look.ok, "look failed: {:?}", look.error);
    let json = serde_json::to_value(&look.result).expect("look response serialises");
    let mut found = Vec::new();
    collect_render_keys(&json, &mut found);
    assert!(found.is_empty(), "look carries render-only keys: {found:?}");
}
