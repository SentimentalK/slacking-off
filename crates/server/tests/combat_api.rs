//! Acceptance tests for the combat and toilet-work commands added on top of
//! build/demolish: attack, defend, upgrade, downgrade, their rejections, the
//! AgentView combat fields, and the persisted cumulative agent score.

use loo_core::{map, Action, Config, Event, EventKind};
use loo_proto::{
    AgentView, AttackRequest, DefendRequest, Dir, DowngradeRequest, Envelope, ErrorCode,
    JoinRequest, JoinResponse, MoveRequest, MoveSpec, RegisterRequest, RegisterResponse, SentBy,
    TargetSpec, UpgradeRequest, WaitRequest, WaitWake,
};
use loo_server::{Server, Store};
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const ATTACK_MAP: &str = "\
grid
#########
#.......#
#.......#
#E......#
#.......#
#########
";

/// A level-1 toilet next to the entrance, with room for a second agent.
const TOILET_MAP: &str = "\
grid
#########
#.1.....#
#E......#
#.......#
#########
";

/// A level-1 toilet enclosed by walls north, west and south and an open door
/// east; the entrance is one cell south-east of the door.
const ROOM_MAP: &str = "\
grid
#######
#.#...#
##1'..#
#.#E..#
#######
";

fn test_dir(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("combat-{name}"))
}

fn fresh_dir(name: &str) -> PathBuf {
    let dir = test_dir(name);
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn open_map(dir: &Path, cfg: Config, map_text: &str) -> Arc<Server> {
    let def = map::parse(map_text).expect("test map parses");
    Arc::new(Server::open(cfg, def, "test", map_text, dir, 7).expect("server opens"))
}

fn nick(name: &str) -> loo_proto::Nick {
    loo_proto::Nick::parse(name).expect("valid nick")
}

async fn register(server: &Arc<Server>, name: &str) -> (String, u64) {
    let envelope = server
        .dev_register(RegisterRequest {
            name: Some(nick(name)),
            model: Some("test-model".to_string()),
            intro: Some("test agent".to_string()),
        })
        .await;
    let result: RegisterResponse = envelope.result.expect("registration succeeds");
    (result.token, result.agent_id)
}

async fn join(server: &Arc<Server>, token: &str) -> Envelope<JoinResponse> {
    server
        .join(
            token,
            JoinRequest {
                sent_by: SentBy::Self_,
                why: "testing".to_string(),
            },
        )
        .await
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

async fn tick_n(server: &Arc<Server>, ticks: u32) {
    for _ in 0..ticks {
        server.tick_once().await;
    }
}

async fn state(server: &Arc<Server>, token: &str) -> AgentView {
    server
        .status(token)
        .await
        .state
        .expect("authenticated status carries a view")
}

async fn all_events(server: &Arc<Server>) -> Vec<Event> {
    server
        .recorded_events(0, 0)
        .await
        .expect("the event log is readable")
}

fn event_texts(events: &[Event]) -> Vec<String> {
    events.iter().map(Event::text).collect()
}

async fn glyph_at(server: &Arc<Server>, pos: loo_proto::Pos) -> Option<char> {
    server.world_state().await.object_at(pos).map(|o| o.glyph())
}

fn use_friendly_config() -> Config {
    let mut cfg = Config::default();
    cfg.need.urine_use_ticks = 1;
    cfg.need.feces_use_ticks = 1;
    cfg.persist.snapshot_interval_ticks = 0;
    cfg
}

/// Registers two agents, stands the first at (3,3) and the second at (2,3) on
/// the open map, and returns `(token, id)` for each.
async fn adjacent_pair(server: &Arc<Server>) -> ((String, u64), (String, u64)) {
    let a = register(server, "dev-a").await;
    join(server, &a.0).await;
    move_path(server, &a.0, "EE").await;
    let b = register(server, "dev-b").await;
    join(server, &b.0).await;
    move_path(server, &b.0, "E").await;
    assert_eq!(
        state(server, &a.0).await.pos,
        Some(loo_proto::Pos::new(3, 3))
    );
    assert_eq!(
        state(server, &b.0).await.pos,
        Some(loo_proto::Pos::new(2, 3))
    );
    (a, b)
}

#[tokio::test]
async fn upgrade_downgrade_commands_queue_and_reject_clear() {
    let dir = fresh_dir("upgrade");
    let mut cfg = Config::default();
    // One work point finishes level 1, so one tick settles the whole upgrade.
    cfg.build.upgrade_work = [1, 2, 2, 2];
    let server = open_map(&dir, cfg.clone(), TOILET_MAP);

    let (token_a, _) = register(&server, "dev-a").await;
    let (token_b, id_b) = register(&server, "dev-b").await;
    drop(server);
    {
        let store = Store::open(&dir, "test", TOILET_MAP, 7).expect("store opens");
        store
            .set_agent_score(id_b, 3000)
            .expect("stored score is writable");
    }
    let server = open_map(&dir, cfg, TOILET_MAP);
    join(&server, &token_a).await;
    move_path(&server, &token_a, "E").await;
    join(&server, &token_b).await;
    move_path(&server, &token_b, "N").await;
    assert_eq!(state(&server, &token_a).await.level, 1);
    assert_eq!(state(&server, &token_b).await.level, 3);

    // A floor cell is not a toilet.
    let not_toilet = server
        .upgrade_cmd(
            &token_a,
            UpgradeRequest {
                target: TargetSpec::Dir(Dir::E),
            },
        )
        .await;
    assert!(!not_toilet.ok);
    let error = not_toilet.error.expect("error");
    assert_eq!(error.code, ErrorCode::RuleRejected);
    assert!(
        error.message.contains("toilet"),
        "non-toilet message: {}",
        error.message
    );

    // A level-1 toilet with no progress is a demolish target.
    let at_bottom = server
        .downgrade_cmd(
            &token_a,
            DowngradeRequest {
                target: TargetSpec::Dir(Dir::N),
            },
        )
        .await;
    assert!(!at_bottom.ok);
    let error = at_bottom.error.expect("error");
    assert_eq!(error.code, ErrorCode::RuleRejected);
    assert!(
        error.message.contains("level 1") && error.message.contains("demolish"),
        "level-1 downgrade message: {}",
        error.message
    );

    // Upgrading to level 2 needs an agent of level 2.
    let too_low = server
        .upgrade_cmd(
            &token_a,
            UpgradeRequest {
                target: TargetSpec::Dir(Dir::N),
            },
        )
        .await;
    assert!(!too_low.ok);
    let error = too_low.error.expect("error");
    assert_eq!(error.code, ErrorCode::RuleRejected);
    assert!(
        error.message.contains("agent level is 1"),
        "level requirement message: {}",
        error.message
    );

    let before = state(&server, &token_b).await.tick;
    let queued = server
        .upgrade_cmd(
            &token_b,
            UpgradeRequest {
                target: TargetSpec::Dir(Dir::E),
            },
        )
        .await;
    assert!(queued.ok, "upgrade rejected: {:?}", queued.error);
    let result = queued.result.expect("queued action");
    assert_eq!(result.effective_tick, before + 1);
    assert_eq!(
        result.action.description,
        format!("upgrade the toilet at {}", loo_proto::Pos::new(2, 1))
    );
    server.tick_once().await;
    assert_eq!(
        glyph_at(&server, loo_proto::Pos::new(2, 1)).await,
        Some('2')
    );
    let texts = event_texts(&all_events(&server).await);
    assert!(
        texts
            .iter()
            .any(|text| text.contains("upgraded the toilet") && text.contains("progress")),
        "upgrade event: {texts:?}"
    );

    let queued = server
        .downgrade_cmd(
            &token_b,
            DowngradeRequest {
                target: TargetSpec::Dir(Dir::E),
            },
        )
        .await;
    assert!(queued.ok, "downgrade rejected: {:?}", queued.error);
    server.tick_once().await;
    assert_eq!(
        glyph_at(&server, loo_proto::Pos::new(2, 1)).await,
        Some('1')
    );
    let texts = event_texts(&all_events(&server).await);
    assert!(
        texts
            .iter()
            .any(|text| text.contains("downgraded the toilet")),
        "downgrade event: {texts:?}"
    );
}

#[tokio::test]
async fn join_loads_persisted_score_and_level() {
    let dir = fresh_dir("join-score");
    let server = open_map(&dir, Config::default(), ATTACK_MAP);
    let (token, id) = register(&server, "dev-a").await;
    drop(server);

    {
        let store = Store::open(&dir, "test", ATTACK_MAP, 7).expect("store opens");
        store
            .set_agent_score(id, 3000)
            .expect("stored score is writable");
    }

    let server = open_map(&dir, Config::default(), ATTACK_MAP);
    join(&server, &token).await;
    let view = state(&server, &token).await;
    assert_eq!(view.score_total, 3000);
    assert_eq!(view.level, 3);
}

#[tokio::test]
async fn old_agents_table_migrates_without_data_loss() {
    let dir = fresh_dir("migrate");
    std::fs::create_dir_all(&dir).expect("test data dir");
    let path = dir.join("world.db");
    {
        let conn = Connection::open(&path).expect("old database opens");
        conn.execute_batch(
            "\
CREATE TABLE agents(
    id INTEGER PRIMARY KEY,
    world_id INTEGER NOT NULL,
    nick TEXT NOT NULL,
    model TEXT NOT NULL,
    intro TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    sent_by TEXT,
    why TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
);
INSERT INTO agents(id, world_id, nick, model, intro, token, sent_by, why, created_at_ms)
VALUES(9, 1, 'old-agent', 'old-model', 'old-intro', 'old-token', NULL, '', 1234);
",
        )
        .expect("old schema and row");
    }

    let server = open_map(&dir, Config::default(), ATTACK_MAP);
    drop(server);
    assert!(path.exists(), "the database file is reused, not replaced");

    let store = Store::open(&dir, "test", ATTACK_MAP, 7).expect("store opens");
    let agents = store.agents().expect("agents load");
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0].id, 9);
    assert_eq!(agents[0].nick, "old-agent");
    assert_eq!(agents[0].token, "old-token");
    assert_eq!(agents[0].score_total, 0);
}

#[tokio::test]
async fn success_persists_score_across_restart_without_snapshot() {
    let dir = fresh_dir("restart-score");
    let cfg = use_friendly_config();
    let server = open_map(&dir, cfg.clone(), ROOM_MAP);
    let (token, id) = register(&server, "dev-a").await;
    drop(server);
    {
        let store = Store::open(&dir, "test", ROOM_MAP, 7).expect("store opens");
        store.set_agent_score(id, 990).expect("score is writable");
    }

    let server = open_map(&dir, cfg.clone(), ROOM_MAP);
    join(&server, &token).await;
    move_path(&server, &token, "NW").await;
    let closed = server
        .door_cmd(
            &token,
            loo_proto::DoorRequest {
                target: Dir::E,
                open: false,
            },
        )
        .await;
    assert!(closed.ok, "close door: {:?}", closed.error);
    server.tick_once().await;
    let use_queued = server.use_cmd(&token).await;
    assert!(use_queued.ok, "use rejected: {:?}", use_queued.error);
    server.tick_once().await;

    let view = state(&server, &token).await;
    assert!(
        view.score_total >= 1090,
        "score_total after one success: {}",
        view.score_total
    );
    assert!(view.level >= 2, "level after one success: {}", view.level);
    let events = all_events(&server).await;
    let successes = events
        .iter()
        .filter(|event| matches!(event.kind, EventKind::UseSucceeded { .. }))
        .count();
    assert_eq!(successes, 1, "exactly one UseSucceeded");

    drop(server);
    let server = open_map(&dir, cfg, ROOM_MAP);
    let after = state(&server, &token).await;
    assert_eq!(after.score_total, view.score_total);
    assert_eq!(after.level, view.level);
}

#[tokio::test]
async fn attack_defend_status_fields_round_trip() {
    let server = open_map(&fresh_dir("attack-fields"), Config::default(), ATTACK_MAP);
    let ((token_a, _), (token_b, _)) = adjacent_pair(&server).await;

    let queued = server
        .attack_cmd(&token_b, AttackRequest { dir: Dir::E })
        .await;
    assert!(queued.ok, "attack rejected: {:?}", queued.error);
    let result = queued.result.expect("queued action");
    assert_eq!(
        result.action.description,
        format!("attack the agent at {}", loo_proto::Pos::new(3, 3))
    );
    assert_eq!(result.action.remaining, 0);

    server.tick_once().await;
    let events = all_events(&server).await;
    let (land_tick, cooldown_until) = events
        .iter()
        .find_map(|event| match &event.kind {
            EventKind::AttackStarted {
                land_tick,
                cooldown_until,
                ..
            } => Some((*land_tick, *cooldown_until)),
            _ => None,
        })
        .expect("AttackStarted");
    let view = state(&server, &token_b).await;
    assert_eq!(view.attack_cooldown_until, cooldown_until);
    assert!(view.attack_cooldown_until > view.tick);
    assert_eq!(
        view.action.map(|action| action.description),
        Some(format!("attack the agent at {}", loo_proto::Pos::new(3, 3)))
    );

    tick_n(&server, 3).await;
    let events = all_events(&server).await;
    let (stun_until, immunity_until, deadline) = events
        .iter()
        .find_map(|event| match &event.kind {
            EventKind::AttackLanded {
                stun_until,
                immunity_until,
                deadline,
                ..
            } => Some((*stun_until, *immunity_until, *deadline)),
            _ => None,
        })
        .expect("AttackLanded");
    let target = state(&server, &token_a).await;
    assert_eq!(target.tick, land_tick);
    assert_eq!(target.stun_until, stun_until);
    assert_eq!(target.immunity_until, immunity_until);
    assert!(deadline > 0);

    // Wait out the stun, then defend the attacker's cell and observe the event.
    tick_n(&server, 4).await;
    let defended = server
        .defend_cmd(&token_a, DefendRequest { dir: Dir::W })
        .await;
    assert!(defended.ok, "defend rejected: {:?}", defended.error);
    assert_eq!(
        defended.result.expect("queued defend").action.description,
        format!("defend {} this tick", loo_proto::Pos::new(2, 3))
    );
    server.tick_once().await;
    let events = all_events(&server).await;
    assert!(
        events.iter().any(|event| matches!(
            &event.kind,
            EventKind::DefendStarted { target, .. } if *target == loo_proto::Pos::new(2, 3)
        )),
        "DefendStarted at the attacker cell"
    );

    let again = server
        .defend_cmd(&token_a, DefendRequest { dir: Dir::W })
        .await;
    assert!(!again.ok);
    let error = again.error.expect("error");
    assert_eq!(error.code, ErrorCode::RuleRejected);
    assert!(
        error.message.contains("cooldown"),
        "defend cooldown message: {}",
        error.message
    );
}

#[tokio::test]
async fn attack_defend_rejections_are_clear() {
    let server = open_map(&fresh_dir("attack-rejects"), Config::default(), ATTACK_MAP);
    let ((token_a, id_a), (token_b, _)) = adjacent_pair(&server).await;

    // Empty direction.
    let empty = server
        .attack_cmd(&token_b, AttackRequest { dir: Dir::W })
        .await;
    assert!(!empty.ok);
    let error = empty.error.expect("error");
    assert_eq!(error.code, ErrorCode::RuleRejected);
    assert!(
        error.message.contains("agent"),
        "empty attack message: {}",
        error.message
    );

    // Own cell: `DefendRequest` carries only a direction, so the own-cell rule
    // is asserted on the same world the server validates against.
    let world = server.world_state().await;
    let pos = world
        .agents
        .get(&id_a)
        .and_then(|agent| agent.pos)
        .expect("agent position");
    let own_cell = loo_core::validate_defend(&world, id_a, pos).expect_err("own cell rejected");
    assert!(
        own_cell.contains("own cell"),
        "own-cell message: {own_cell}"
    );
    drop(world);

    let queued = server
        .attack_cmd(&token_b, AttackRequest { dir: Dir::E })
        .await;
    assert!(queued.ok, "attack rejected: {:?}", queued.error);
    server.tick_once().await;

    // Cooldown starts at the commit.
    let again = server
        .attack_cmd(&token_b, AttackRequest { dir: Dir::E })
        .await;
    assert!(!again.ok);
    let error = again.error.expect("error");
    assert_eq!(error.code, ErrorCode::RuleRejected);
    assert!(
        error.message.contains("cooldown"),
        "attack cooldown message: {}",
        error.message
    );

    // A successful defence starts its own cooldown.
    let defended = server
        .defend_cmd(&token_a, DefendRequest { dir: Dir::N })
        .await;
    assert!(defended.ok, "defend rejected: {:?}", defended.error);
    server.tick_once().await;
    let again = server
        .defend_cmd(&token_a, DefendRequest { dir: Dir::N })
        .await;
    assert!(!again.ok);
    let error = again.error.expect("error");
    assert_eq!(error.code, ErrorCode::RuleRejected);
    assert!(
        error.message.contains("cooldown"),
        "defend cooldown message: {}",
        error.message
    );

    // Settle the windup so the target is stunned, then try to attack.
    tick_n(&server, 2).await;
    let stunned = server
        .attack_cmd(&token_a, AttackRequest { dir: Dir::E })
        .await;
    assert!(!stunned.ok);
    let error = stunned.error.expect("error");
    assert_eq!(error.code, ErrorCode::RuleRejected);
    assert!(
        error.message.contains("stunned"),
        "stunned message: {}",
        error.message
    );
}

#[tokio::test]
async fn wait_wakes_on_attack_and_upgrade() {
    let mut cfg = Config::default();
    cfg.build.upgrade_work = [1, 2, 2, 2];
    cfg.agent.level_thresholds = [0, 0, 0, 0, 0];
    let server = open_map(&fresh_dir("wait-combat"), cfg, TOILET_MAP);
    let (token_a, _) = register(&server, "dev-a").await;
    join(&server, &token_a).await;
    move_path(&server, &token_a, "E").await;
    let (token_b, _) = register(&server, "dev-b").await;
    join(&server, &token_b).await;

    let queued = server
        .upgrade_cmd(
            &token_a,
            UpgradeRequest {
                target: TargetSpec::Dir(Dir::N),
            },
        )
        .await;
    assert!(queued.ok, "upgrade rejected: {:?}", queued.error);
    let ticker = {
        let server = server.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            server.tick_once().await;
        })
    };
    let waited = server
        .wait(
            &token_a,
            WaitRequest {
                timeout_seconds: Some(3.0),
            },
        )
        .await;
    ticker.await.expect("ticker task");
    assert_eq!(
        waited.result.as_ref().expect("wait result").woke,
        WaitWake::Event
    );
    let texts: Vec<String> = waited
        .events
        .iter()
        .map(|event| event.text.clone())
        .collect();
    assert!(!texts.is_empty());
    assert!(
        texts
            .iter()
            .any(|text| text.contains("upgraded the toilet")),
        "upgrade wake: {texts:?}"
    );

    // Second wait: the target of an attack wakes on AttackStarted. Drain the
    // target's earlier view events first so the wait cannot return them.
    let drained = server.status(&token_b).await;
    assert!(
        drained
            .events
            .iter()
            .any(|event| event.text.contains("upgraded the toilet")),
        "the target saw the upgrade in its view"
    );
    let queued = server
        .attack_cmd(&token_a, AttackRequest { dir: Dir::W })
        .await;
    assert!(queued.ok, "attack rejected: {:?}", queued.error);
    let ticker = {
        let server = server.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            server.tick_once().await;
        })
    };
    let waited = server
        .wait(
            &token_b,
            WaitRequest {
                timeout_seconds: Some(3.0),
            },
        )
        .await;
    ticker.await.expect("ticker task");
    assert_eq!(
        waited.result.as_ref().expect("wait result").woke,
        WaitWake::Event
    );
    let texts: Vec<String> = waited
        .events
        .iter()
        .map(|event| event.text.clone())
        .collect();
    assert!(!texts.is_empty());
    assert!(
        texts.iter().any(|text| text.contains("attacks")),
        "attack wake: {texts:?}"
    );
}

#[tokio::test]
async fn restart_restores_combat_cooldowns_and_windup() {
    let dir = fresh_dir("restart-combat");
    let mut cfg = Config::default();
    cfg.persist.snapshot_interval_ticks = 0;
    let server = open_map(&dir, cfg.clone(), ATTACK_MAP);
    let ((_, _), (token_b, id_b)) = adjacent_pair(&server).await;

    let queued = server
        .attack_cmd(&token_b, AttackRequest { dir: Dir::E })
        .await;
    assert!(queued.ok, "attack rejected: {:?}", queued.error);
    server.tick_once().await;
    let events = all_events(&server).await;
    let (land_tick, cooldown_until) = events
        .iter()
        .find_map(|event| match &event.kind {
            EventKind::AttackStarted {
                land_tick,
                cooldown_until,
                ..
            } => Some((*land_tick, *cooldown_until)),
            _ => None,
        })
        .expect("AttackStarted");
    let before = state(&server, &token_b).await;
    assert_eq!(before.attack_cooldown_until, cooldown_until);
    drop(server);

    let server = open_map(&dir, cfg, ATTACK_MAP);
    let after = state(&server, &token_b).await;
    assert_eq!(after.attack_cooldown_until, cooldown_until);
    assert!(
        after.attack_cooldown_until > after.tick,
        "cooldown survives the restart: {} > {}",
        after.attack_cooldown_until,
        after.tick
    );
    let world = server.world_state().await;
    match world
        .agents
        .get(&id_b)
        .and_then(|agent| agent.action.clone())
    {
        Some(Action::Attack {
            land_tick: restored,
            ..
        }) => assert_eq!(restored, land_tick, "the windup keeps its landing tick"),
        other => panic!("restored action is not the attack: {other:?}"),
    }
}

#[tokio::test]
async fn store_score_is_atomic_with_tick_events() {
    let dir = fresh_dir("atomic-score");
    let cfg = use_friendly_config();
    let server = open_map(&dir, cfg.clone(), ROOM_MAP);
    let (token, _) = register(&server, "dev-a").await;
    join(&server, &token).await;
    move_path(&server, &token, "NW").await;
    let closed = server
        .door_cmd(
            &token,
            loo_proto::DoorRequest {
                target: Dir::E,
                open: false,
            },
        )
        .await;
    assert!(closed.ok, "close door: {:?}", closed.error);
    server.tick_once().await;
    let queued = server.use_cmd(&token).await;
    assert!(queued.ok, "use rejected: {:?}", queued.error);
    server.tick_once().await;
    let view = state(&server, &token).await;
    drop(server);

    let store = Store::open(&dir, "test", ROOM_MAP, 7).expect("store opens");
    let events = store.events_after(0, 0).expect("events load");
    let successes: Vec<&Event> = events
        .iter()
        .filter(|event| matches!(event.kind, EventKind::UseSucceeded { .. }))
        .collect();
    assert_eq!(successes.len(), 1);
    let mut sum = 0u32;
    for event in &successes {
        if let EventKind::UseSucceeded { score, .. } = &event.kind {
            sum = sum.saturating_add(*score);
        }
    }
    let agents = store.agents().expect("agents load");
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0].score_total, sum);
    assert_eq!(agents[0].score_total, view.score_total);
    drop(store);

    // Two restarts keep the same total; the events are never applied twice.
    let server = open_map(&dir, cfg.clone(), ROOM_MAP);
    assert_eq!(state(&server, &token).await.score_total, view.score_total);
    drop(server);
    let server = open_map(&dir, cfg, ROOM_MAP);
    assert_eq!(state(&server, &token).await.score_total, view.score_total);
}
