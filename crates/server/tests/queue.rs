//! Queue acceptance tests: physical waiting cells in the projection, waiting
//! commands, capacity limits, settlement metrics and per-agent rate limiting.

use loo_core::{map, Config};
use loo_proto::{
    BuildKind, BuildRequest, Dir, Envelope, ErrorCode, JoinRequest, JoinResponse, MoveRequest,
    MoveSpec, Placement, PlacementKind, Pos, RegisterRequest, RegisterResponse, SentBy, TargetSpec,
};
use loo_server::Server;
use std::path::PathBuf;
use std::sync::Arc;

/// One entrance and a two-cell primary lane south of it.
const LANE_MAP: &str = "\
grid
#######
#.....#
#..E..#
#..qq.#
#######
";

fn fresh_dir(name: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("queue-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn open(name: &str, mut cfg: Config) -> Arc<Server> {
    let dir = fresh_dir(name);
    let def = map::parse(LANE_MAP).expect("queue map parses");
    cfg.limits.requests_per_second = 0;
    Arc::new(Server::open(cfg, def, "test", LANE_MAP, &dir, 7).expect("server opens"))
}

fn lane_config() -> Config {
    Config {
        max_on_field: 1,
        ..Config::default()
    }
}

async fn register(server: &Arc<Server>, name: &str) -> String {
    let envelope = server
        .dev_register(RegisterRequest {
            name: Some(loo_proto::Nick::parse(name).expect("valid nick")),
            model: Some("test-model".to_string()),
            intro: Some("test agent".to_string()),
        })
        .await;
    let result: RegisterResponse = envelope.result.expect("registration succeeds");
    result.token
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

fn is_waiting(env: &Envelope<JoinResponse>) -> bool {
    matches!(
        env.result.as_ref().map(|joined| &joined.placement),
        Some(Placement::Waiting { .. })
    )
}

#[tokio::test]
async fn waiting_status_and_projection_use_the_physical_line() {
    let server = open("position", lane_config());
    let token_a = register(&server, "first-one").await;
    let token_b = register(&server, "second-one").await;
    assert!(join(&server, &token_a).await.ok);
    let queued = join(&server, &token_b).await;
    assert!(queued.ok, "join failed: {:?}", queued.error);
    assert!(is_waiting(&queued));

    let state = server
        .status(&token_b)
        .await
        .state
        .expect("waiting agent has a view");
    assert_eq!(state.placement, Some(PlacementKind::Waiting));
    assert_eq!(state.queue_ahead, Some(1), "1-based line position");
    assert_eq!(state.pos, Some(Pos::new(3, 3)), "the head queue cell");

    let projection = server.current_projection().await;
    assert_eq!(projection.counts.queued, 1);
    assert_eq!(projection.queue[0].index, 1);
    assert_eq!(projection.queue[0].pos, Pos::new(3, 3));
    assert_eq!(
        projection.counts.queue_capacity,
        lane_config().session.queue_capacity
    );
}

#[tokio::test]
async fn a_full_queue_is_a_conflict() {
    let mut cfg = lane_config();
    cfg.session.queue_capacity = 1;
    let server = open("full", cfg);
    let token_a = register(&server, "first-one").await;
    let token_b = register(&server, "second-one").await;
    let token_c = register(&server, "third-one").await;

    assert!(join(&server, &token_a).await.ok);
    assert!(is_waiting(&join(&server, &token_b).await));

    let rejected = join(&server, &token_c).await;
    assert!(!rejected.ok, "a third agent cannot join a one-seat line");
    let error = rejected.error.expect("error");
    assert_eq!(error.code, ErrorCode::QueueFull);
    assert_eq!(error.http_status(), 409);
    assert!(
        error.message.contains("queue is full"),
        "message: {}",
        error.message
    );
}

#[tokio::test]
async fn waiters_can_move_attack_and_defend_but_not_build() {
    let server = open("actions", lane_config());
    let token_a = register(&server, "first-one").await;
    let token_b = register(&server, "second-one").await;
    assert!(join(&server, &token_a).await.ok);
    assert!(join(&server, &token_b).await.ok);
    assert_eq!(
        server.status(&token_b).await.state.expect("state").pos,
        Some(Pos::new(3, 3))
    );

    // Attack the agent on the entrance, one cell north.
    let attacked = server
        .attack_cmd(&token_b, loo_proto::AttackRequest { dir: Dir::N })
        .await;
    assert!(attacked.ok, "waiting attack: {:?}", attacked.error);
    server.tick_once().await;

    // Building is still an inside-only action, and the error names the place.
    let built = server
        .build_cmd(
            &token_b,
            BuildRequest {
                kind: BuildKind::Wall,
                target: TargetSpec::Here,
            },
        )
        .await;
    assert!(!built.ok);
    let error = built.error.expect("error");
    assert_eq!(error.code, ErrorCode::RuleRejected);
    assert!(
        error.message.contains("queue position 1, 0 ahead"),
        "message: {}",
        error.message
    );

    // Moving stays inside the queue lane.
    let moved = server
        .move_cmd(
            &token_b,
            MoveRequest {
                spec: MoveSpec::Steps {
                    dir: Dir::E,
                    count: 1,
                },
            },
        )
        .await;
    assert!(moved.ok, "waiting move: {:?}", moved.error);
    server.tick_once().await;
    let state = server.status(&token_b).await.state.expect("state");
    assert_eq!(state.pos, Some(Pos::new(4, 3)), "the next queue cell");
    assert_eq!(state.placement, Some(PlacementKind::Waiting));

    let defended = server
        .defend_cmd(&token_b, loo_proto::DefendRequest { dir: Dir::N })
        .await;
    assert!(defended.ok, "waiting defend: {:?}", defended.error);
    server.tick_once().await;

    // Off-lane movement is blocked by the queue boundary, not accepted.
    let before = server.status(&token_b).await.state.expect("state").pos;
    let blocked = server
        .move_cmd(
            &token_b,
            MoveRequest {
                spec: MoveSpec::Steps {
                    dir: Dir::S,
                    count: 1,
                },
            },
        )
        .await;
    assert!(blocked.ok, "the intent is queued; core rejects the step");
    server.tick_once().await;
    assert_eq!(
        server.status(&token_b).await.state.expect("state").pos,
        before,
        "a queue boundary blocks the step"
    );
}

#[tokio::test]
async fn projection_queue_is_ordered_and_matches_replay() {
    let server = open("order", lane_config());
    let tokens = [
        register(&server, "first-one").await,
        register(&server, "second-one").await,
        register(&server, "third-one").await,
    ];
    assert!(join(&server, &tokens[0]).await.ok);
    for token in &tokens[1..] {
        assert!(is_waiting(&join(&server, token).await));
    }
    server.tick_once().await;

    let live = server.current_projection().await;
    assert_eq!(live.queue.len(), 2, "both lane cells are taken");
    assert_eq!(
        live.queue
            .iter()
            .map(|entry| entry.index)
            .collect::<Vec<_>>(),
        vec![1, 2],
        "indices are consecutive and 1-based"
    );
    assert_eq!(
        live.queue
            .iter()
            .map(|entry| entry.nick.as_str())
            .collect::<Vec<_>>(),
        vec!["second-one", "third-one"],
        "the line follows physical order, not registration or session id"
    );
    assert_eq!(live.queue[0].pos, Pos::new(3, 3));
    assert_eq!(live.queue[1].pos, Pos::new(4, 3));

    let replayed = server
        .projection_at(live.tick)
        .await
        .expect("the current tick replays");
    assert_eq!(replayed.queue, live.queue, "same queue on both paths");
    assert_eq!(replayed, live, "the whole projection agrees");
}

#[tokio::test]
async fn metrics_expose_settlement_percentiles() {
    let server = open("metrics", lane_config());
    let token = register(&server, "first-one").await;
    assert!(join(&server, &token).await.ok);
    for _ in 0..5 {
        server.tick_once().await;
    }

    let metrics = server.metrics().await;
    assert_eq!(metrics.tick, 5);
    assert!(metrics.ticks > 0, "settled ticks were sampled");
    assert!(
        metrics.settle_ms.p50 <= metrics.settle_ms.p99
            && metrics.settle_ms.p99 <= metrics.settle_ms.max,
        "percentiles ascend: {:?}",
        metrics.settle_ms
    );
    assert!(metrics.settle_ms.max >= 0.0, "durations are never negative");
    assert_eq!(metrics.inside, 1);
    assert_eq!(metrics.queued, 0);
}

#[tokio::test]
async fn rapid_commands_from_one_agent_are_rate_limited() {
    let mut cfg = Config {
        tick_seconds: 5.0,
        ..Config::default()
    };
    cfg.limits.requests_per_second = 2;
    let dir = fresh_dir("rate");
    let def = map::parse(LANE_MAP).expect("queue map parses");
    let server = Arc::new(Server::open(cfg, def, "test", LANE_MAP, &dir, 7).expect("opens"));

    let token = register(&server, "first-one").await;
    assert!(join(&server, &token).await.ok, "1st request in the window");
    assert!(server.look(&token).await.ok, "2nd request in the window");

    let limited = server.status(&token).await;
    assert!(!limited.ok, "the 3rd request in one second is refused");
    let error = limited.error.expect("error");
    assert_eq!(error.code, ErrorCode::RateLimited);
    assert_eq!(error.http_status(), 429);
    assert!(
        error.message.contains("too many requests"),
        "message: {}",
        error.message
    );
}

#[tokio::test]
async fn a_queue_touch_replays_after_reopen() {
    let dir = fresh_dir("touch-reopen");
    let cfg = lane_config();
    let def = map::parse(LANE_MAP).expect("queue map parses");
    let before;
    let touched_through_tick;
    {
        let server = Arc::new(
            Server::open(cfg.clone(), def.clone(), "test", LANE_MAP, &dir, 7).expect("opens"),
        );
        let token_a = register(&server, "first-one").await;
        let token_b = register(&server, "second-one").await;
        assert!(join(&server, &token_a).await.ok);
        assert!(is_waiting(&join(&server, &token_b).await));

        // Settle tick 1 so the touch event has a tick seed of its own.
        server.tick_once().await;
        let state = server.status(&token_b).await.state.expect("status state");
        assert_eq!(state.queue_ahead, Some(1));
        touched_through_tick = server.world_state().await.tick;
        before = server.current_projection().await.queue;
    }

    // Same data dir, new process-like open: replay must accept QueueTouched.
    let reopened = Arc::new(
        Server::open(cfg, def, "test", LANE_MAP, &dir, 7).expect("the touched log replays"),
    );
    let world = reopened.world_state().await;
    assert_eq!(world.tick, touched_through_tick);
    let after = reopened.current_projection().await.queue;
    assert_eq!(after, before, "queue id/pos/index survive the restart");
    let session = world.session_of(2).expect("second-one session");
    assert_eq!(
        world.sessions[&session.id].last_active_tick, touched_through_tick,
        "the touch tick survives the restart"
    );
}
