//! Server-level acceptance tests: dev identity, join, look, move, wait,
//! same-tick contention, and SQLite persistence/recovery (design §13 第 0 步).

use loo_core::{map, Config, Event, EventKind, Intent, IntentKind, MapDef};
use loo_proto::{
    Dir, Envelope, ErrorCode, JoinRequest, JoinResponse, LookResponse, MoveRequest, MoveSpec, Nick,
    Placement, Pos, RegisterRequest, RegisterResponse, SentBy, Tick, WaitRequest, WaitWake,
};
use loo_server::{Server, Store};
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

const TEST_MAP: &str = "\
grid
#######
#..#..#
#..E..#
#..#..#
#######
";

fn test_dir(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("api-{name}"))
}

fn fresh_dir(name: &str) -> PathBuf {
    let dir = test_dir(name);
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn open_with_map(dir: &Path, cfg: Config, map_text: &str) -> Arc<Server> {
    let def = map::parse(map_text).expect("test map parses");
    Arc::new(Server::open(cfg, def, "test", map_text, dir, 7).expect("server opens"))
}

fn open_in(dir: &Path, cfg: Config) -> Arc<Server> {
    open_with_map(dir, cfg, TEST_MAP)
}

fn new_server(name: &str) -> Arc<Server> {
    new_server_with(name, Config::default())
}

fn new_server_with(name: &str, cfg: Config) -> Arc<Server> {
    open_in(&fresh_dir(name), cfg)
}

/// Reopens the world an earlier `new_server_with` left in `api-<name>`.
fn open_existing(name: &str, cfg: Config, def: MapDef, map_text: &str) -> Arc<Server> {
    Arc::new(
        Server::open(cfg, def, "test", map_text, &test_dir(name), 7)
            .expect("server reopens stored world"),
    )
}

fn nick(name: &str) -> Nick {
    Nick::parse(name).expect("valid nick")
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

async fn move_to(
    server: &Arc<Server>,
    token: &str,
    spec: MoveSpec,
) -> Envelope<loo_proto::ActionQueued> {
    server.move_cmd(token, MoveRequest { spec }).await
}

fn settled_ticks(events: &[Event]) -> Vec<Tick> {
    events
        .iter()
        .filter(|event| matches!(event.kind, EventKind::TickSettled))
        .map(|event| event.tick)
        .collect()
}

#[tokio::test]
async fn dev_identity_is_issued_and_checked() {
    let server = new_server("identity");
    let (token, agent_id) = register(&server, "dev-a").await;
    assert!(!token.is_empty());
    assert_eq!(agent_id, 1);

    let unauthenticated = server.look("bogus-token").await;
    assert!(!unauthenticated.ok);
    let error = unauthenticated.error.expect("error present");
    assert_eq!(error.code, ErrorCode::NotAuthenticated);
    assert_eq!(error.http_status(), 401);

    let duplicate = server
        .dev_register(RegisterRequest {
            name: Some(nick("dev-a")),
            model: None,
            intro: None,
        })
        .await;
    assert!(!duplicate.ok);
    assert_eq!(duplicate.error.expect("error").code, ErrorCode::BadRequest);

    // Generated nicknames are valid and unique.
    let second = server
        .dev_register(RegisterRequest {
            name: None,
            model: None,
            intro: None,
        })
        .await
        .result
        .expect("second registration");
    assert_eq!(second.nick, "dev-2");
    assert_ne!(second.token, token);
}

#[tokio::test]
async fn join_places_the_agent_and_look_is_9x9() {
    let server = new_server("join");
    let (token, _) = register(&server, "dev-a").await;

    let joined = join(&server, &token).await;
    assert!(joined.ok);
    let response = joined.result.expect("join result");
    let at = match &response.placement {
        Placement::Inside { at, briefing } => {
            assert_eq!((briefing.map_width, briefing.map_height), (7, 5));
            assert_eq!(briefing.entrance, *at);
            assert!(briefing.toilets.is_empty(), "test map has no toilets");
            *at
        }
        other => panic!("expected to be inside, got {other:?}"),
    };
    assert_eq!(at, Pos::new(3, 2));

    let looked = server.look(&token).await;
    assert!(looked.ok);
    let view: LookResponse = looked.result.expect("look result");
    assert_eq!((view.grid.width, view.grid.height), (9, 9));
    assert_eq!(view.grid.rows.len(), 9);
    assert!(view.grid.rows.iter().all(|row| row.chars().count() == 9));
    assert_eq!(view.grid.rows[4].chars().nth(4), Some('@'));

    let again = join(&server, &token).await;
    assert!(!again.ok, "one entry per agent in step 0");
    assert_eq!(
        again.error.expect("error").code,
        ErrorCode::RuleRejected,
        "a rule rejection is exit code 1 in the CLI"
    );
}

#[tokio::test]
async fn move_walks_one_cell_per_tick_and_stops_at_walls() {
    let server = new_server("move");
    let (token, _) = register(&server, "dev-a").await;

    let pending = move_to(
        &server,
        &token,
        MoveSpec::Steps {
            dir: Dir::W,
            count: 2,
        },
    )
    .await;
    assert!(!pending.ok, "cannot move before joining");
    assert_eq!(pending.error.expect("error").code, ErrorCode::RuleRejected);

    join(&server, &token).await;
    let queued = move_to(
        &server,
        &token,
        MoveSpec::Steps {
            dir: Dir::W,
            count: 2,
        },
    )
    .await;
    let queued = queued.result.expect("move accepted");
    assert_eq!(queued.action.remaining, 2);
    assert_eq!(queued.effective_tick, 1);

    server.tick_once().await;
    let status = server.status(&token).await;
    let state = status.state.expect("state present");
    assert_eq!(state.pos, Some(Pos::new(2, 2)));
    assert_eq!(
        status.events.iter().map(|e| e.tick).collect::<Vec<_>>(),
        vec![1],
        "the tick's event is delivered once"
    );
    assert!(status.events[0].text.contains("moved"));

    server.tick_once().await;
    let status = server.status(&token).await;
    assert_eq!(status.state.as_ref().unwrap().pos, Some(Pos::new(1, 2)));
    assert!(status.state.unwrap().action.is_none(), "path finished");
    assert!(
        status.events.iter().all(|event| event.tick == 2),
        "only the new tick's events are delivered: {:?}",
        status.events
    );

    // North twice: one step, then a wall stops the action.
    move_to(
        &server,
        &token,
        MoveSpec::Path {
            path: "NN".to_string(),
        },
    )
    .await;
    server.tick_once().await;
    server.tick_once().await;
    let status = server.status(&token).await;
    assert_eq!(status.state.as_ref().unwrap().pos, Some(Pos::new(1, 1)));
    assert!(status.state.unwrap().action.is_none());
    let texts: Vec<String> = status.events.iter().map(|e| e.text.clone()).collect();
    assert!(
        texts.iter().any(|text| text.contains("blocked by a wall")),
        "events explain the stop: {texts:?}"
    );
}

#[tokio::test]
async fn wait_timeout_is_a_normal_result() {
    let server = new_server("wait-timeout");
    let (token, _) = register(&server, "dev-a").await;
    join(&server, &token).await;

    let started = Instant::now();
    let waited = server
        .wait(
            &token,
            WaitRequest {
                timeout_seconds: Some(0.2),
            },
        )
        .await;
    let elapsed = started.elapsed();
    assert!(waited.ok, "a timeout is ok, not an error");
    let response = waited.result.expect("wait result");
    assert_eq!(response.woke, WaitWake::Timeout);
    assert!(elapsed >= Duration::from_millis(180), "waited {elapsed:?}");
    assert!(waited.events.is_empty());

    // The server clamps to the configured maximum.
    let mut cfg = Config::default();
    cfg.wait.max_seconds = 0.3;
    let capped = new_server_with("wait-clamp", cfg);
    let (token, _) = register(&capped, "dev-a").await;
    join(&capped, &token).await;
    let clamped = capped
        .wait(
            &token,
            WaitRequest {
                timeout_seconds: Some(1000.0),
            },
        )
        .await;
    assert_eq!(clamped.result.expect("wait result").timeout_seconds, 0.3);
}

#[tokio::test]
async fn wait_wakes_on_a_tick_event() {
    let server = new_server("wait-event");
    let (token, _) = register(&server, "dev-a").await;
    join(&server, &token).await;
    move_to(
        &server,
        &token,
        MoveSpec::Path {
            path: "W".to_string(),
        },
    )
    .await;

    let ticker = {
        let server = server.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            server.tick_once().await;
        })
    };
    let waited = server
        .wait(
            &token,
            WaitRequest {
                timeout_seconds: Some(3.0),
            },
        )
        .await;
    ticker.await.expect("ticker task");
    let response = waited.result.expect("wait result");
    assert_eq!(response.woke, WaitWake::Event);
    assert!(
        waited
            .events
            .iter()
            .any(|event| event.text.contains("moved")),
        "woke for the move: {:?}",
        waited.events
    );
}

#[tokio::test]
async fn two_agents_contesting_one_cell_settle_identically_on_both_runs() {
    async fn run(name: &str) -> Vec<String> {
        let server = new_server(name);
        let (token_a, _) = register(&server, "dev-a").await;
        let (token_b, _) = register(&server, "dev-b").await;
        join(&server, &token_a).await;
        // dev-a steps west twice, freeing the entrance for dev-b.
        move_to(
            &server,
            &token_a,
            MoveSpec::Path {
                path: "WW".to_string(),
            },
        )
        .await;
        server.tick_once().await;
        server.tick_once().await;
        join(&server, &token_b).await;

        // Both now want the cell between them.
        move_to(
            &server,
            &token_a,
            MoveSpec::Path {
                path: "E".to_string(),
            },
        )
        .await;
        move_to(
            &server,
            &token_b,
            MoveSpec::Path {
                path: "W".to_string(),
            },
        )
        .await;
        server.tick_once().await;

        let state_a = server.status(&token_a).await;
        let state_b = server.status(&token_b).await;
        let pos_a = state_a.state.unwrap().pos.expect("dev-a inside");
        let pos_b = state_b.state.unwrap().pos.expect("dev-b inside");
        assert_ne!(pos_a, pos_b, "two agents never share a cell");
        let contested = Pos::new(2, 2);
        assert_eq!(
            [pos_a, pos_b].iter().filter(|p| **p == contested).count(),
            1,
            "exactly one agent gets the contested cell"
        );
        let mut texts: Vec<String> = state_a
            .events
            .iter()
            .chain(state_b.events.iter())
            .map(|event| event.text.clone())
            .collect();
        texts.sort();
        texts
    }

    let first = run("determinism-a").await;
    let second = run("determinism-b").await;
    assert_eq!(first, second, "same seed, same settlement");
    assert!(
        first.iter().any(|text| text.contains("blocked by agent")),
        "the loser is told which agent blocked it: {first:?}"
    );
}

#[tokio::test]
async fn store_uses_wal_and_has_required_tables() {
    let dir = fresh_dir("store-tables");
    let server = open_in(&dir, Config::default());
    let store = Store::open(&dir, "test", TEST_MAP, 7).expect("second handle opens");
    assert_eq!(store.journal_mode().expect("journal mode"), "wal");

    drop(server);
    let conn = Connection::open(store.path()).expect("open database file");
    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .expect("read schema");
    let names: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .expect("query schema")
        .map(|row| row.expect("table name"))
        .collect();
    for table in ["worlds", "events", "snapshots", "commands", "agents"] {
        assert!(
            names.iter().any(|name| name == table),
            "missing table {table}: {names:?}"
        );
    }
}

#[tokio::test]
async fn snapshot_plus_events_matches_live_world() {
    let name = "snapshot-events";
    let mut cfg = Config::default();
    cfg.persist.snapshot_interval_ticks = 2;
    let dir = fresh_dir(name);
    let server = open_in(&dir, cfg.clone());
    let (token, _) = register(&server, "dev-a").await;
    join(&server, &token).await;
    move_to(
        &server,
        &token,
        MoveSpec::Path {
            path: "WW".to_string(),
        },
    )
    .await;
    for _ in 0..5 {
        server.tick_once().await;
    }

    let store = Store::open(&dir, "test", TEST_MAP, 7).expect("second handle opens");
    let (tick, snapshot) = store
        .latest_snapshot()
        .expect("snapshot readable")
        .expect("snapshot written");
    assert_eq!(tick, 4, "a snapshot lands on every second tick");
    let events = store
        .events_after(tick, snapshot.last_seq)
        .expect("events readable");
    let restored =
        loo_core::restore(&snapshot, &events, &cfg).expect("snapshot plus events restore");
    let live = server.world_state().await;
    let diffs = loo_core::diff_worlds(&restored, &live);
    assert!(diffs.is_empty(), "restored world differs: {diffs:?}");
}

#[tokio::test]
async fn restart_resumes_tick_and_log_without_gap() {
    let name = "restart";
    // The default snapshot interval is 120 ticks, so nothing is snapshotted.
    let cfg = Config::default();
    let dir = fresh_dir(name);
    let server = open_in(&dir, cfg.clone());
    let (token, _) = register(&server, "dev-a").await;
    join(&server, &token).await;
    for _ in 0..3 {
        server.tick_once().await;
    }
    // Submitted at tick 3 and still unsettled when the process dies.
    move_to(
        &server,
        &token,
        MoveSpec::Path {
            path: "W".to_string(),
        },
    )
    .await;
    drop(server);

    let def = map::parse(TEST_MAP).expect("test map parses");
    let server = open_existing(name, cfg, def, TEST_MAP);
    assert_eq!(
        server.world_state().await.tick,
        3,
        "the tick does not go backwards"
    );

    let looked = server.look(&token).await;
    assert!(
        looked.ok,
        "the stored token still authenticates: {:?}",
        looked.error
    );
    assert_eq!(looked.state.expect("state").pos, Some(Pos::new(3, 2)));

    let before = settled_ticks(&server.recorded_events(0, 0).await.expect("events readable"));
    assert_eq!(before, vec![1, 2, 3]);

    server.tick_once().await;
    let after = settled_ticks(&server.recorded_events(0, 0).await.expect("events readable"));
    assert_eq!(after, vec![1, 2, 3, 4], "the log resumes without a gap");
    assert!(after.windows(2).all(|pair| pair[1] == pair[0] + 1));

    let status = server.status(&token).await;
    assert_eq!(
        status.state.expect("state").pos,
        Some(Pos::new(2, 2)),
        "the unsettled move survived the restart"
    );
}

#[tokio::test]
async fn recorded_seed_replays_the_tick_events_exactly() {
    let name = "replay-seed";
    let cfg = Config::default();
    let server = open_in(&fresh_dir(name), cfg.clone());
    let (token_a, _) = register(&server, "dev-a").await;
    let (token_b, _) = register(&server, "dev-b").await;
    join(&server, &token_a).await;
    move_to(
        &server,
        &token_a,
        MoveSpec::Path {
            path: "WW".to_string(),
        },
    )
    .await;
    server.tick_once().await;
    server.tick_once().await;
    join(&server, &token_b).await;

    // Both agents want the contested cell.
    move_to(
        &server,
        &token_a,
        MoveSpec::Path {
            path: "E".to_string(),
        },
    )
    .await;
    move_to(
        &server,
        &token_b,
        MoveSpec::Path {
            path: "W".to_string(),
        },
    )
    .await;

    let before = server.world_state().await;
    let (_, before_seq) = server.event_cursor().await;
    let intents = vec![
        Intent {
            agent: 1,
            kind: IntentKind::Move {
                dirs: vec![Dir::E],
                label: "move E".to_string(),
            },
        },
        Intent {
            agent: 2,
            kind: IntentKind::Move {
                dirs: vec![Dir::W],
                label: "move W".to_string(),
            },
        },
    ];
    server.tick_once().await;

    let recorded = server
        .recorded_events(before.tick, before_seq)
        .await
        .expect("events readable");
    let seed = recorded
        .iter()
        .find(|event| matches!(event.kind, EventKind::TickSettled))
        .map(|event| event.seed)
        .expect("the tick's seed is recorded");
    let (world, events) = loo_core::step(&before, &intents, seed, &cfg);
    assert_eq!(
        events, recorded,
        "the recorded seed reproduces the tick's events exactly"
    );
    assert!(
        loo_core::diff_worlds(&world, &server.world_state().await).is_empty(),
        "the recorded events reproduce the live world"
    );
}

/// 31 wide, 3 tall, no walls: enough room to walk out of another agent's view.
fn open_map(width: usize) -> String {
    let mut text = String::from("grid\n");
    text.push('E');
    text.push_str(&".".repeat(width - 1));
    text.push('\n');
    for _ in 0..2 {
        text.push_str(&".".repeat(width));
        text.push('\n');
    }
    text
}

#[tokio::test]
async fn agents_never_see_outside_their_view() {
    let name = "visibility";
    let text = open_map(31);
    let dir = fresh_dir(name);
    let server = open_with_map(&dir, Config::default(), &text);

    let (token_a, _) = register(&server, "dev-a").await;
    join(&server, &token_a).await;
    move_to(
        &server,
        &token_a,
        MoveSpec::Steps {
            dir: Dir::E,
            count: 20,
        },
    )
    .await;
    for _ in 0..20 {
        server.tick_once().await;
        // Drain dev-a's own events so only another agent's events can show up.
        server.status(&token_a).await;
    }

    let (token_b, _) = register(&server, "dev-b").await;
    join(&server, &token_b).await;
    move_to(
        &server,
        &token_b,
        MoveSpec::Steps {
            dir: Dir::E,
            count: 1,
        },
    )
    .await;
    server.tick_once().await;

    let state_a = server.status(&token_a).await;
    assert_eq!(state_a.state.expect("state").pos, Some(Pos::new(20, 0)));
    assert!(
        state_a.events.is_empty(),
        "dev-b is 19 cells away: {:?}",
        state_a.events
    );
    let looked = server.look(&token_a).await;
    let view = looked.result.expect("look result");
    assert_eq!((view.grid.width, view.grid.height), (9, 9));
    assert_eq!(view.grid.rows.len(), 9);
    assert!(view.grid.rows.iter().all(|row| row.chars().count() == 9));
    assert!(
        !view.grid.rows.iter().any(|row| row.contains('a')),
        "dev-b is outside the view: {:?}",
        view.grid.rows
    );
    let remembered = server.map_view(&token_a).await;
    let remembered = remembered.result.expect("map result");
    assert!(!remembered.grid.rows.iter().any(|row| row.contains('a')));

    // dev-b walks into the view window.
    move_to(
        &server,
        &token_b,
        MoveSpec::Steps {
            dir: Dir::E,
            count: 15,
        },
    )
    .await;
    for _ in 0..15 {
        server.tick_once().await;
    }
    let state_b = server.status(&token_b).await;
    assert_eq!(state_b.state.expect("state").pos, Some(Pos::new(16, 0)));

    let state_a = server.status(&token_a).await;
    let texts: Vec<String> = state_a
        .events
        .iter()
        .map(|event| event.text.clone())
        .collect();
    assert!(
        texts
            .iter()
            .any(|text| text.contains("dev-b") && text.contains("moved")),
        "a visible move is delivered: {texts:?}"
    );
    let looked = server.look(&token_a).await;
    let view = looked.result.expect("look result");
    assert_eq!((view.grid.width, view.grid.height), (9, 9));
    assert!(
        view.grid.rows.iter().any(|row| row.contains('a')),
        "dev-b is now inside the view: {:?}",
        view.grid.rows
    );
}

#[tokio::test]
async fn wait_default_comes_from_config() {
    let cfg = Config {
        tick_seconds: 0.2,
        wait: loo_core::config::WaitConfig {
            default_seconds: 0.05,
            max_seconds: 2.0,
        },
        ..Config::default()
    };
    let server = new_server_with("wait-default", cfg);
    let (token, _) = register(&server, "dev-a").await;
    join(&server, &token).await;

    assert_eq!(
        server.default_wait_seconds(),
        0.2,
        "the default covers one tick"
    );
    let waited = server
        .wait(
            &token,
            WaitRequest {
                timeout_seconds: None,
            },
        )
        .await;
    let response = waited.result.expect("wait result");
    assert_eq!(response.timeout_seconds, 0.2);
    assert_eq!(response.woke, WaitWake::Timeout);
}

#[tokio::test]
async fn every_command_is_logged_including_rejections() {
    let name = "command-log";
    let dir = fresh_dir(name);
    let server = open_in(&dir, Config::default());
    let (token, _) = register(&server, "dev-a").await;

    let rejected = move_to(
        &server,
        &token,
        MoveSpec::Path {
            path: "W".to_string(),
        },
    )
    .await;
    assert!(!rejected.ok, "a move before joining is rejected");

    let conn = Connection::open(server.store_path()).expect("open command log");
    let rejected_moves: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM commands WHERE command = 'move' AND ok = 0",
            [],
            |row| row.get(0),
        )
        .expect("count rejected moves");
    assert!(rejected_moves >= 1, "the rejected move is logged");

    join(&server, &token).await;
    move_to(
        &server,
        &token,
        MoveSpec::Steps {
            dir: Dir::W,
            count: 1,
        },
    )
    .await;
    let accepted_moves: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM commands WHERE command = 'move' AND ok = 1 AND intent IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .expect("count accepted moves");
    assert_eq!(accepted_moves, 1, "the accepted move keeps its intent");
}

#[tokio::test]
async fn restart_restores_immediate_and_queued_joins_without_a_snapshot() {
    let name = "join-restart";
    let cfg = Config::default();
    let dir = fresh_dir(name);
    let server = open_in(&dir, cfg.clone());

    let (token_a, _) = register(&server, "dev-a").await;
    let (token_b, _) = register(&server, "dev-b").await;
    join(&server, &token_a).await;
    let queued = join(&server, &token_b).await;
    assert!(matches!(
        queued.result.expect("join result").placement,
        Placement::Waiting { ahead: 0 }
    ));

    // Joins are persisted as events; no snapshot is written for them.
    let store = Store::open(&dir, "test", TEST_MAP, 7).expect("second handle opens");
    assert!(
        store
            .latest_snapshot()
            .expect("snapshots readable")
            .is_none(),
        "join must not create a fallback snapshot"
    );
    let joins: Vec<(Tick, String)> = store
        .events_after(0, 0)
        .expect("events readable")
        .into_iter()
        .map(|event| (event.tick, event.kind.name().to_string()))
        .collect();
    assert_eq!(
        joins,
        vec![
            (0, "Joined".into()),
            (0, "NeedAssigned".into()),
            (0, "Joined".into()),
        ],
        "an immediate join also rolls its need; a queued join does not"
    );
    drop(server);
    drop(store);

    let def = map::parse(TEST_MAP).expect("test map parses");
    let server = open_existing(name, cfg, def, TEST_MAP);
    let world = server.world_state().await;
    assert_eq!(world.tick, 0, "joins do not move the tick");
    assert_eq!(world.agents.len(), 2);
    assert_eq!(world.sessions.len(), 2);
    assert_eq!(world.agents[&1].pos, Some(Pos::new(3, 2)));
    assert_eq!(world.agents[&2].pos, None);
    assert_eq!(world.entry_queue.len(), 1);

    let state_b = server.status(&token_b).await.state.expect("state");
    assert_eq!(state_b.placement, Some(loo_proto::PlacementKind::Waiting));
    assert_eq!(state_b.queue_ahead, Some(1));

    // The entrance is still taken, so a tick must not admit dev-b twice or move
    // it into the world early.
    server.tick_once().await;
    let world = server.world_state().await;
    assert_eq!(world.tick, 1);
    assert_eq!(world.entry_queue.len(), 1);
    assert_eq!(world.agents[&2].pos, None);
    assert_eq!(world.sessions[&2].status, loo_core::SessionStatus::Waiting);

    // After dev-a moves away, dev-b is admitted exactly once.
    move_to(
        &server,
        &token_a,
        MoveSpec::Steps {
            dir: Dir::W,
            count: 1,
        },
    )
    .await;
    server.tick_once().await;
    server.tick_once().await;
    let world = server.world_state().await;
    assert!(world.entry_queue.is_empty());
    assert_eq!(world.agents[&2].pos, Some(Pos::new(3, 2)));
    assert_eq!(world.sessions[&2].status, loo_core::SessionStatus::Inside);
}

#[tokio::test]
async fn config_reports_the_live_wait_settings() {
    let cfg = Config {
        tick_seconds: 5.0,
        wait: loo_core::config::WaitConfig {
            default_seconds: 2.0,
            max_seconds: 7.0,
        },
        ..Config::default()
    };
    let server = new_server_with("config-endpoint", cfg);
    let envelope = server.config_response().await;
    let config = envelope.result.expect("config result");
    assert_eq!(config.tick_seconds, 5.0);
    assert_eq!(config.wait_default_seconds, 2.0, "the raw config value");
    assert_eq!(
        config.wait_effective_default_seconds, 5.0,
        "the effective default covers one tick"
    );
    assert_eq!(
        config.wait_max_seconds, 7.0,
        "a non-55 max is reported unchanged so the CLI can follow it"
    );
    assert_eq!(config.snapshot_interval_ticks, 120);
}
