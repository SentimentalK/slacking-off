//! Server-level acceptance tests: dev identity, join, look, move, wait,
//! same-tick contention, and SQLite persistence/recovery (design §13 第 0 步).

use loo_core::{map, Config, Event, EventKind, Intent, IntentKind, MapDef};
use loo_proto::{
    ActionQueued, BuildKind, BuildRequest, DemolishRequest, Dir, DoorRequest, Envelope, ErrorCode,
    JoinRequest, JoinResponse, LeaveResponse, LookResponse, MoveRequest, MoveSpec, Need, Nick,
    Placement, Pos, RegisterRequest, RegisterResponse, SentBy, SessionOutcome, TargetSpec, Tick,
    WaitRequest, WaitWake,
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
#..q..#
#######
";

/// A wide open floor with a no-build entrance on the west side.
const BUILD_MAP: &str = "\
grid
#########
#.......#
#.......#
qE......#
#.......#
#########
";

/// A pre-built room: a level-1 toilet with walls north, west and south and an
/// open door east, next to the entrance. Closing the door makes it usable.
const ROOM_MAP: &str = "\
grid
#######
#.#...#
##1'..#
#.#Eq.#
#######
";

/// Wide enough that an agent at the entrance cannot see builds on the east side.
const WIDE_MAP: &str = "\
grid
###############
#.............#
#.............#
qE............#
#.............#
###############
";

fn test_dir(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("api-{name}"))
}

fn fresh_dir(name: &str) -> PathBuf {
    let dir = test_dir(name);
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn open_with_map(dir: &Path, mut cfg: Config, map_text: &str) -> Arc<Server> {
    // Command-rate limiting is exercised by its own test; other acceptance
    // tests issue many commands within the same real second.
    cfg.limits.requests_per_second = 0;
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

/// Moves one cell per path character and settles every step.
async fn move_path(server: &Arc<Server>, token: &str, path: &str) {
    let queued = move_to(
        server,
        token,
        MoveSpec::Path {
            path: path.to_string(),
        },
    )
    .await;
    assert!(queued.ok, "move {path} was rejected: {:?}", queued.error);
    for _ in 0..path.chars().count() {
        server.tick_once().await;
    }
}

async fn build_at(
    server: &Arc<Server>,
    token: &str,
    kind: BuildKind,
    target: TargetSpec,
) -> Envelope<ActionQueued> {
    server.build_cmd(token, BuildRequest { kind, target }).await
}

async fn demolish_at(
    server: &Arc<Server>,
    token: &str,
    target: TargetSpec,
) -> Envelope<ActionQueued> {
    server.demolish_cmd(token, DemolishRequest { target }).await
}

async fn door_at(
    server: &Arc<Server>,
    token: &str,
    dir: Dir,
    open: bool,
) -> Envelope<ActionQueued> {
    server
        .door_cmd(token, DoorRequest { target: dir, open })
        .await
}

async fn tick_n(server: &Arc<Server>, ticks: u32) {
    for _ in 0..ticks {
        server.tick_once().await;
    }
}

fn build_ticks(kind: BuildKind) -> u32 {
    match kind {
        BuildKind::Wall | BuildKind::Door => 2,
        BuildKind::Toilet => 3,
    }
}

/// Queues one build and settles exactly the work it needs.
async fn build_and_settle(
    server: &Arc<Server>,
    token: &str,
    kind: BuildKind,
    target: TargetSpec,
    at: Pos,
    glyph: char,
) {
    let queued = build_at(server, token, kind, target).await;
    assert!(queued.ok, "build {kind:?} at {at}: {:?}", queued.error);
    tick_n(server, build_ticks(kind)).await;
    assert_eq!(glyph_at(server, at).await, Some(glyph), "{kind:?} at {at}");
}

/// Current glyph of a cell, independent of the `Object` variant shape.
async fn glyph_at(server: &Arc<Server>, pos: Pos) -> Option<char> {
    server.world_state().await.object_at(pos).map(|o| o.glyph())
}

fn event_texts(events: &[loo_proto::EventView]) -> Vec<String> {
    events.iter().map(|event| event.text.clone()).collect()
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
    text.push('q');
    text.push_str(&".".repeat(width - 1));
    text.push('\n');
    text.push_str(&".".repeat(width));
    text.push('\n');
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
    assert_eq!(world.agents[&2].pos, Some(Pos::new(3, 3)));
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
    assert_eq!(world.agents[&2].pos, Some(Pos::new(3, 3)));
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

#[tokio::test]
async fn build_a_toilet_room_and_use_it() {
    let server = open_with_map(&fresh_dir("build-use"), Config::default(), BUILD_MAP);
    let (token, _) = register(&server, "dev-a").await;
    join(&server, &token).await;
    move_path(&server, &token, "EE").await;
    assert_eq!(
        server.status(&token).await.state.expect("state").pos,
        Some(Pos::new(3, 3))
    );

    build_and_settle(
        &server,
        &token,
        BuildKind::Toilet,
        TargetSpec::Here,
        Pos::new(3, 3),
        '1',
    )
    .await;
    build_and_settle(
        &server,
        &token,
        BuildKind::Wall,
        TargetSpec::Dir(Dir::N),
        Pos::new(3, 2),
        '#',
    )
    .await;
    build_and_settle(
        &server,
        &token,
        BuildKind::Wall,
        TargetSpec::Dir(Dir::E),
        Pos::new(4, 3),
        '#',
    )
    .await;
    build_and_settle(
        &server,
        &token,
        BuildKind::Wall,
        TargetSpec::Dir(Dir::S),
        Pos::new(3, 4),
        '#',
    )
    .await;
    build_and_settle(
        &server,
        &token,
        BuildKind::Door,
        TargetSpec::Dir(Dir::W),
        Pos::new(2, 3),
        '+',
    )
    .await;

    let before = server.status(&token).await.state.expect("state");
    assert!(before.need.is_some(), "join assigns a need");
    assert!(before.use_ticks_total == 4 || before.use_ticks_total == 8);

    let queued = server.use_cmd(&token).await;
    assert!(queued.ok, "use was rejected: {:?}", queued.error);

    let mut progressed = 0;
    let mut succeeded = false;
    let mut score = 0;
    let mut state = None;
    for _ in 0..10 {
        server.tick_once().await;
        let status = server.status(&token).await;
        for event in &status.events {
            if event.text.contains("is using the level 1 toilet") {
                progressed += 1;
            }
            if event.text.contains("finished at") && event.text.contains("scored") {
                succeeded = true;
                score = status.state.as_ref().map(|s| s.score).unwrap_or(0);
            }
        }
        state = status.state;
        if succeeded {
            break;
        }
    }
    let state = state.expect("state");
    assert!(progressed >= 1, "use progress events are delivered");
    assert!(succeeded, "use succeeds");
    assert_eq!(state.outcome, Some(SessionOutcome::Success));
    assert!(score > 0, "success scores: {score}");
    assert_eq!(state.score, score);
    assert_eq!(state.use_ticks_done, state.use_ticks_total);

    let left = server.leave_cmd(&token).await;
    let left = left.result.expect("leave result");
    assert_eq!(left.outcome, SessionOutcome::Success);
    assert_eq!(left.score, score);
}

#[tokio::test]
async fn use_is_rejected_with_the_missing_part() {
    let server = open_with_map(&fresh_dir("use-reject"), Config::default(), BUILD_MAP);
    let (token, _) = register(&server, "dev-a").await;
    join(&server, &token).await;
    move_path(&server, &token, "EE").await;

    build_and_settle(
        &server,
        &token,
        BuildKind::Toilet,
        TargetSpec::Here,
        Pos::new(3, 3),
        '1',
    )
    .await;
    build_and_settle(
        &server,
        &token,
        BuildKind::Wall,
        TargetSpec::Dir(Dir::N),
        Pos::new(3, 2),
        '#',
    )
    .await;
    build_and_settle(
        &server,
        &token,
        BuildKind::Wall,
        TargetSpec::Dir(Dir::E),
        Pos::new(4, 3),
        '#',
    )
    .await;
    build_and_settle(
        &server,
        &token,
        BuildKind::Wall,
        TargetSpec::Dir(Dir::S),
        Pos::new(3, 4),
        '#',
    )
    .await;
    build_and_settle(
        &server,
        &token,
        BuildKind::Door,
        TargetSpec::Dir(Dir::W),
        Pos::new(2, 3),
        '+',
    )
    .await;

    // Missing wall: the east side is gone.
    let queued = demolish_at(&server, &token, TargetSpec::Dir(Dir::E)).await;
    assert!(queued.ok, "{:?}", queued.error);
    tick_n(&server, 2).await;
    assert_eq!(glyph_at(&server, Pos::new(4, 3)).await, None);
    let rejected = server.use_cmd(&token).await;
    assert!(!rejected.ok);
    let error = rejected.error.expect("error");
    assert_eq!(error.code, ErrorCode::RuleRejected);
    assert!(
        error.message.contains("east") && error.message.contains("enclosed"),
        "missing wall is named: {}",
        error.message
    );

    // Open door: the west side is open.
    build_and_settle(
        &server,
        &token,
        BuildKind::Wall,
        TargetSpec::Dir(Dir::E),
        Pos::new(4, 3),
        '#',
    )
    .await;
    let opened = door_at(&server, &token, Dir::W, true).await;
    assert!(opened.ok, "{:?}", opened.error);
    tick_n(&server, 1).await;
    assert_eq!(glyph_at(&server, Pos::new(2, 3)).await, Some('\''));
    let rejected = server.use_cmd(&token).await;
    assert!(!rejected.ok);
    let error = rejected.error.expect("error");
    assert_eq!(error.code, ErrorCode::RuleRejected);
    assert!(
        error.message.contains("west door is open"),
        "open door is named: {}",
        error.message
    );

    // Toilet under construction: demolition progress makes it unusable.
    let closed = door_at(&server, &token, Dir::W, false).await;
    assert!(closed.ok, "{:?}", closed.error);
    tick_n(&server, 1).await;
    let queued = demolish_at(&server, &token, TargetSpec::Here).await;
    assert!(queued.ok, "{:?}", queued.error);
    tick_n(&server, 1).await;
    let rejected = server.use_cmd(&token).await;
    assert!(!rejected.ok);
    let error = rejected.error.expect("error");
    assert_eq!(error.code, ErrorCode::RuleRejected);
    assert!(
        error.message.contains("under construction") && error.message.contains("progress"),
        "construction progress is named: {}",
        error.message
    );
}

#[tokio::test]
async fn door_permissions_and_auto_open() {
    let server = open_with_map(&fresh_dir("door-perm"), Config::default(), ROOM_MAP);
    let (token_a, _) = register(&server, "dev-a").await;
    let (token_b, _) = register(&server, "dev-b").await;
    join(&server, &token_a).await;
    move_path(&server, &token_a, "NW").await;
    assert_eq!(
        server.status(&token_a).await.state.expect("state").pos,
        Some(Pos::new(2, 2)),
        "dev-a stands on the toilet"
    );
    join(&server, &token_b).await;
    assert_eq!(
        server.status(&token_b).await.state.expect("state").pos,
        Some(Pos::new(3, 3))
    );

    // dev-b is next to the door but not on a toilet cell.
    let denied = door_at(&server, &token_b, Dir::N, false).await;
    assert!(!denied.ok);
    let error = denied.error.expect("error");
    assert_eq!(error.code, ErrorCode::RuleRejected);
    assert!(
        error.message.contains("adjacent toilet cell"),
        "permission message: {}",
        error.message
    );

    // dev-a is on the toilet cell next to the door and may close it.
    let closed = door_at(&server, &token_a, Dir::E, false).await;
    assert!(closed.ok, "{:?}", closed.error);
    tick_n(&server, 1).await;
    assert_eq!(glyph_at(&server, Pos::new(3, 2)).await, Some('+'));

    // dev-a leaves: the closed door has nobody on its toilet any more and opens
    // by itself in the next tick.
    let left = server.leave_cmd(&token_a).await;
    assert!(left.ok, "{:?}", left.error);
    assert_eq!(left.result.expect("leave").outcome, SessionOutcome::Left);
    server.tick_once().await;
    assert_eq!(glyph_at(&server, Pos::new(3, 2)).await, Some('\''));
    let status_b = server.status(&token_b).await;
    let texts = event_texts(&status_b.events);
    assert!(
        texts
            .iter()
            .any(|text| text.contains("opened automatically")),
        "dev-b sees the automatic open: {texts:?}"
    );
}

#[tokio::test]
async fn wait_wakes_on_use_progress_and_door_change() {
    let server = open_with_map(&fresh_dir("wait-use"), Config::default(), ROOM_MAP);
    let (token, _) = register(&server, "dev-a").await;
    join(&server, &token).await;
    move_path(&server, &token, "NW").await;
    let closed = door_at(&server, &token, Dir::E, false).await;
    assert!(closed.ok, "{:?}", closed.error);
    tick_n(&server, 1).await;

    let queued = server.use_cmd(&token).await;
    assert!(queued.ok, "{:?}", queued.error);
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
    assert_eq!(waited.result.expect("wait result").woke, WaitWake::Event);
    let texts = event_texts(&waited.events);
    assert!(
        texts
            .iter()
            .any(|text| text.contains("is using the level 1 toilet")),
        "woke on use progress: {texts:?}"
    );

    let opened = door_at(&server, &token, Dir::E, true).await;
    assert!(opened.ok, "{:?}", opened.error);
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
    assert_eq!(waited.result.expect("wait result").woke, WaitWake::Event);
    let texts = event_texts(&waited.events);
    assert!(
        texts.iter().any(|text| text.contains("opened the door")),
        "woke on the door change: {texts:?}"
    );
}

#[tokio::test]
async fn leave_and_cancel_are_ok_for_waiting_and_inside_agents() {
    let server = open_with_map(&fresh_dir("leave-cancel"), Config::default(), ROOM_MAP);
    let (token_a, _) = register(&server, "dev-a").await;
    let (token_b, _) = register(&server, "dev-b").await;
    let (token_c, _) = register(&server, "dev-c").await;

    join(&server, &token_a).await;
    let queued_join = join(&server, &token_b).await;
    assert!(matches!(
        queued_join.result.expect("join").placement,
        Placement::Waiting { ahead: 0 }
    ));

    let waiting_leave: Envelope<LeaveResponse> = server.leave_cmd(&token_b).await;
    assert!(waiting_leave.ok, "{:?}", waiting_leave.error);
    let result = waiting_leave.result.expect("leave result");
    assert_eq!(result.outcome, SessionOutcome::Left);
    assert_eq!(result.score, 0);
    assert!(
        server
            .status(&token_b)
            .await
            .state
            .expect("state")
            .session_id
            .is_none(),
        "the waiting session is gone"
    );

    let no_action = server.cancel_cmd(&token_a).await;
    assert!(no_action.ok, "{:?}", no_action.error);
    let action = no_action.result.expect("cancel result").action;
    assert_eq!(action.description, "cancel");
    assert_eq!(action.remaining, 0);

    let outside: Envelope<ActionQueued> = server.cancel_cmd(&token_c).await;
    assert!(outside.ok, "cancel needs no session");

    let outside_build = server
        .build_cmd(
            &token_c,
            BuildRequest {
                kind: BuildKind::Wall,
                target: TargetSpec::Here,
            },
        )
        .await;
    assert!(!outside_build.ok, "building requires an inside session");
    let error = outside_build.error.expect("error");
    assert_eq!(error.code, ErrorCode::RuleRejected);
    assert!(
        error.message.contains("not in the world"),
        "{}",
        error.message
    );

    let rejected: Envelope<LeaveResponse> = server.leave_cmd(&token_c).await;
    assert!(!rejected.ok);
    let error = rejected.error.expect("error");
    assert_eq!(error.code, ErrorCode::RuleRejected);
    assert!(
        error.message.contains("not in the world"),
        "message: {}",
        error.message
    );
}

#[tokio::test]
async fn restart_restores_need_deadline_use_and_recovery_without_snapshot() {
    let name = "restart-need";
    let mut cfg = Config::default();
    cfg.persist.snapshot_interval_ticks = 1000;
    let dir = fresh_dir(name);
    let server = open_with_map(&dir, cfg.clone(), ROOM_MAP);
    let (token, _) = register(&server, "dev-a").await;
    join(&server, &token).await;
    move_path(&server, &token, "NW").await;
    let closed = door_at(&server, &token, Dir::E, false).await;
    assert!(closed.ok, "{:?}", closed.error);
    tick_n(&server, 1).await;
    let queued = server.use_cmd(&token).await;
    assert!(queued.ok, "{:?}", queued.error);
    tick_n(&server, 2).await;
    let cancelled = server.cancel_cmd(&token).await;
    assert!(cancelled.ok, "{:?}", cancelled.error);
    tick_n(&server, 1).await;

    let before = server.status(&token).await.state.expect("state");
    assert!(before.need.is_some(), "a need was assigned at join");
    assert_eq!(before.use_ticks_done, 2);
    assert!(
        before.recovery_deadline.is_some(),
        "cancel opens a recovery window"
    );

    let store = Store::open(&dir, "test", ROOM_MAP, 7).expect("second handle opens");
    assert!(
        store
            .latest_snapshot()
            .expect("snapshots readable")
            .is_none(),
        "the state must come from the event log alone"
    );
    drop(store);
    drop(server);

    let def = map::parse(ROOM_MAP).expect("test map parses");
    let server = open_existing(name, cfg, def, ROOM_MAP);
    let after = server.status(&token).await.state.expect("state");
    assert_eq!(after.need, before.need);
    assert_eq!(after.deadline_tick, before.deadline_tick);
    assert_eq!(after.use_ticks_done, before.use_ticks_done);
    assert_eq!(after.use_ticks_total, before.use_ticks_total);
    assert_eq!(after.recovery_deadline, before.recovery_deadline);
    assert_eq!(after.score, before.score);
    assert_eq!(after.outcome, before.outcome);
}

#[tokio::test]
async fn state_exposes_need_deadline_use_and_score() {
    let server = open_with_map(&fresh_dir("state-fields"), Config::default(), ROOM_MAP);
    let (token, _) = register(&server, "dev-a").await;
    join(&server, &token).await;
    move_path(&server, &token, "NW").await;
    let closed = door_at(&server, &token, Dir::E, false).await;
    assert!(closed.ok, "{:?}", closed.error);
    tick_n(&server, 1).await;

    let before = server.status(&token).await.state.expect("state");
    let need = before.need.expect("need");
    let expected_total = match need {
        Need::Urine => 4,
        Need::Feces => 8,
    };
    assert_eq!(before.use_ticks_total, expected_total);
    assert_eq!(before.use_ticks_done, 0);
    assert!(before.deadline_tick > before.tick);
    assert_eq!(before.score, 0);
    assert_eq!(before.outcome, None);

    let queued = server.use_cmd(&token).await;
    assert!(queued.ok, "{:?}", queued.error);
    tick_n(&server, 2).await;
    let during = server.status(&token).await.state.expect("state");
    assert_eq!(during.need, Some(need));
    assert_eq!(during.use_ticks_done, 2);
    assert_eq!(during.use_ticks_total, expected_total);
    assert_eq!(during.recovery_deadline, None);

    let mut state = during;
    for _ in 0..expected_total {
        server.tick_once().await;
        state = server.status(&token).await.state.expect("state");
        if state.outcome.is_some() {
            break;
        }
    }
    assert_eq!(state.outcome, Some(SessionOutcome::Success));
    assert!(state.score > 0, "score after success: {}", state.score);
    assert_eq!(state.use_ticks_done, expected_total);
}

#[tokio::test]
async fn look_and_map_show_built_object_glyphs() {
    let server = open_with_map(&fresh_dir("glyphs"), Config::default(), WIDE_MAP);
    let (token_a, _) = register(&server, "dev-a").await;
    let (token_b, _) = register(&server, "dev-b").await;
    join(&server, &token_a).await;

    let queued = move_to(
        &server,
        &token_a,
        MoveSpec::Steps {
            dir: Dir::E,
            count: 6,
        },
    )
    .await;
    assert!(queued.ok, "{:?}", queued.error);
    server.tick_once().await;
    join(&server, &token_b).await;
    tick_n(&server, 5).await;
    assert_eq!(
        server.status(&token_a).await.state.expect("state").pos,
        Some(Pos::new(7, 3))
    );
    assert_eq!(
        server.status(&token_b).await.state.expect("state").pos,
        Some(Pos::new(1, 3))
    );

    build_and_settle(
        &server,
        &token_a,
        BuildKind::Toilet,
        TargetSpec::Here,
        Pos::new(7, 3),
        '1',
    )
    .await;
    build_and_settle(
        &server,
        &token_a,
        BuildKind::Wall,
        TargetSpec::Dir(Dir::N),
        Pos::new(7, 2),
        '#',
    )
    .await;
    build_and_settle(
        &server,
        &token_a,
        BuildKind::Wall,
        TargetSpec::Dir(Dir::E),
        Pos::new(8, 3),
        '#',
    )
    .await;
    build_and_settle(
        &server,
        &token_a,
        BuildKind::Door,
        TargetSpec::Dir(Dir::W),
        Pos::new(6, 3),
        '+',
    )
    .await;

    // dev-b walks east while dev-a starts a second toilet: dev-b first sees that
    // cell while it is still a site, so its remembered map keeps the `x`.
    let built = build_at(
        &server,
        &token_a,
        BuildKind::Toilet,
        TargetSpec::Dir(Dir::S),
    )
    .await;
    assert!(built.ok, "{:?}", built.error);
    let walked = move_to(
        &server,
        &token_b,
        MoveSpec::Steps {
            dir: Dir::E,
            count: 2,
        },
    )
    .await;
    assert!(walked.ok, "{:?}", walked.error);
    server.tick_once().await;
    server.tick_once().await;

    let look = server.look(&token_a).await.result.expect("look result");
    let rows = look.grid.rows.join("\n");
    for glyph in ['#', '+', 'x'] {
        assert!(rows.contains(glyph), "look is missing {glyph:?}: {rows}");
    }

    let map = server.map_view(&token_b).await.result.expect("map result");
    let rows = map.grid.rows.join("\n");
    for glyph in ['#', '+', '1', 'x'] {
        assert!(rows.contains(glyph), "map is missing {glyph:?}: {rows}");
    }

    // The second toilet completes on the next tick and shows up in the view.
    server.tick_once().await;
    let look = server.look(&token_a).await.result.expect("look result");
    let rows = look.grid.rows.join("\n");
    assert!(
        rows.contains('1'),
        "look is missing the finished toilet: {rows}"
    );
}

#[tokio::test]
async fn wait_delivers_session_ended_after_failure_and_success() {
    // Failure: the deadline is two ticks after the join.
    let mut cfg = Config::default();
    cfg.need.deadline_ticks_min = 2;
    cfg.need.deadline_ticks_max = 2;
    let server = open_with_map(&fresh_dir("end-failed"), cfg, ROOM_MAP);
    let (token, _) = register(&server, "dev-a").await;
    join(&server, &token).await;
    tick_n(&server, 2).await;
    let waited = server
        .wait(
            &token,
            WaitRequest {
                timeout_seconds: Some(1.0),
            },
        )
        .await;
    assert_eq!(waited.result.expect("wait result").woke, WaitWake::Event);
    let texts = event_texts(&waited.events);
    assert!(
        texts
            .iter()
            .any(|text| text.contains("failed: failed_deadline")),
        "the failure is delivered: {texts:?}"
    );
    assert!(
        texts
            .iter()
            .any(|text| text.contains("left the world: failed_deadline")),
        "the session end is delivered: {texts:?}"
    );
    assert!(
        waited.state.expect("state").session_id.is_none(),
        "the session is gone"
    );

    // Success: the session lingers, then ends, and wait still reaches the agent.
    let server = open_with_map(&fresh_dir("end-success"), Config::default(), ROOM_MAP);
    let (token, _) = register(&server, "dev-a").await;
    join(&server, &token).await;
    move_path(&server, &token, "NW").await;
    let closed = door_at(&server, &token, Dir::E, false).await;
    assert!(closed.ok, "{:?}", closed.error);
    tick_n(&server, 1).await;
    let queued = server.use_cmd(&token).await;
    assert!(queued.ok, "{:?}", queued.error);
    for _ in 0..12 {
        server.tick_once().await;
        let state = server.status(&token).await.state.expect("state");
        if state.outcome == Some(SessionOutcome::Success) {
            break;
        }
    }
    // Let the linger expire without draining the outbox.
    tick_n(&server, 40).await;
    let waited = server
        .wait(
            &token,
            WaitRequest {
                timeout_seconds: Some(1.0),
            },
        )
        .await;
    assert_eq!(waited.result.expect("wait result").woke, WaitWake::Event);
    let texts = event_texts(&waited.events);
    assert!(
        texts
            .iter()
            .any(|text| text.contains("left the world: success")),
        "the success session end is delivered: {texts:?}"
    );
    assert!(waited.state.expect("state").session_id.is_none());
}
