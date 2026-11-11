//! Server-level acceptance tests: dev identity, join, look, move, wait, and
//! same-tick contention (design §13 第 0 步).

use loo_core::{map, Config};
use loo_proto::{
    Envelope, ErrorCode, JoinRequest, JoinResponse, LookResponse, MoveRequest, MoveSpec, Nick,
    Placement, RegisterRequest, RegisterResponse, SentBy, WaitRequest, WaitWake,
};
use loo_server::{Logs, Server};
use std::path::PathBuf;
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

fn new_server(name: &str) -> Arc<Server> {
    new_server_with(name, Config::default())
}

fn new_server_with(name: &str, cfg: Config) -> Arc<Server> {
    let dir: PathBuf = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("api-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    let def = map::parse(TEST_MAP).expect("test map parses");
    Arc::new(Server::new(
        cfg,
        def,
        Logs::open(&dir).expect("logs open"),
        7,
    ))
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
    assert_eq!(at, loo_proto::Pos::new(3, 2));

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
            dir: loo_proto::Dir::W,
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
            dir: loo_proto::Dir::W,
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
    assert_eq!(state.pos, Some(loo_proto::Pos::new(2, 2)));
    assert_eq!(
        status.events.iter().map(|e| e.tick).collect::<Vec<_>>(),
        vec![1],
        "the tick's event is delivered once"
    );
    assert!(status.events[0].text.contains("moved"));

    server.tick_once().await;
    let status = server.status(&token).await;
    assert_eq!(
        status.state.as_ref().unwrap().pos,
        Some(loo_proto::Pos::new(1, 2))
    );
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
    assert_eq!(
        status.state.as_ref().unwrap().pos,
        Some(loo_proto::Pos::new(1, 1))
    );
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
    async fn run(name: &str) -> (u64, Vec<String>) {
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
        let contested = loo_proto::Pos::new(2, 2);
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
        (server.config().tick_seconds as u64, texts)
    }

    let (_, first) = run("determinism-a").await;
    let (_, second) = run("determinism-b").await;
    assert_eq!(first, second, "same seed, same settlement");
    assert!(
        first.iter().any(|text| text.contains("blocked by agent")),
        "the loser is told which agent blocked it: {first:?}"
    );
}
