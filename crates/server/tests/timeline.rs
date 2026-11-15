//! Replay spans: the ticks whose settled projection still holds a session, so
//! `GET /api/timeline` can name the non-empty stretches of the log.

use loo_core::{map, Config};
use loo_proto::{
    BuildKind, BuildRequest, DemolishRequest, Dir, Envelope, JoinRequest, JoinResponse,
    LeaveResponse, Placement, RegisterRequest, SentBy, SessionOutcome, TargetSpec, Tick,
    TimelineSpan,
};
use loo_server::Server;
use std::path::PathBuf;
use std::sync::Arc;

/// One entrance and a two-cell primary lane south of it.
const TEST_MAP: &str = "\
grid
#######
#.....#
#..E..#
#..qq.#
#######
";

fn fresh_dir(name: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("timeline-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn open(name: &str, mut cfg: Config) -> Arc<Server> {
    let dir = fresh_dir(name);
    let def = map::parse(TEST_MAP).expect("test map parses");
    cfg.limits.requests_per_second = 0;
    Arc::new(Server::open(cfg, def, "test", TEST_MAP, &dir, 7).expect("server opens"))
}

async fn register(server: &Arc<Server>, name: &str) -> String {
    let env = server
        .dev_register(RegisterRequest {
            name: Some(loo_proto::Nick::parse(name).expect("valid nick")),
            model: Some("test-model".to_string()),
            intro: Some("test agent".to_string()),
        })
        .await;
    assert!(env.ok, "register {name}: {:?}", env.error);
    env.result.expect("register result").token
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

async fn leave(server: &Arc<Server>, token: &str) -> Envelope<LeaveResponse> {
    let env = server.leave_cmd(token).await;
    assert!(env.ok, "leave: {:?}", env.error);
    assert_eq!(
        env.result.as_ref().expect("leave result").outcome,
        SessionOutcome::Left
    );
    env
}

async fn tick_n(server: &Arc<Server>, ticks: u32) {
    for _ in 0..ticks {
        server.tick_once().await;
    }
}

async fn tick(server: &Arc<Server>) -> Tick {
    server.world_state().await.tick
}

async fn spans(server: &Arc<Server>, from: Tick, to: Tick) -> Vec<TimelineSpan> {
    let env = server.timeline(from, to).await;
    assert!(env.ok, "timeline {from}..={to}: {:?}", env.error);
    env.result.expect("timeline result").spans
}

#[tokio::test]
async fn one_session_covers_join_through_the_tick_before_leave() {
    let server = open("single", Config::default());
    let token = register(&server, "alpha-one").await;
    let join_tick = tick(&server).await;
    assert_eq!(join_tick, 0, "a fresh world starts at tick 0");
    let joined = join(&server, &token).await;
    assert!(joined.ok, "join: {:?}", joined.error);
    let leave_tick = tick_n_then_leave(&server, &token, 3).await;

    assert_eq!(leave_tick, join_tick + 3);
    assert_eq!(
        tick(&server).await,
        leave_tick,
        "a leave does not advance the tick"
    );
    assert_eq!(
        spans(&server, join_tick, leave_tick).await,
        vec![TimelineSpan {
            from: join_tick,
            to: leave_tick - 1,
        }],
        "the leave tick does not replay this session"
    );
    assert_eq!(
        spans(&server, 1, 2).await,
        vec![TimelineSpan { from: 1, to: 2 }],
        "the window clips both ends"
    );
}

/// Runs `ticks` settlements, then leaves, and reports the leave tick.
async fn tick_n_then_leave(server: &Arc<Server>, token: &str, ticks: u32) -> Tick {
    tick_n(server, ticks).await;
    let leave_tick = tick(server).await;
    leave(server, token).await;
    leave_tick
}

#[tokio::test]
async fn an_empty_field_splits_the_spans() {
    let server = open("gap", Config::default());
    let first = register(&server, "alpha-one").await;
    assert!(join(&server, &first).await.ok);
    tick_n(&server, 1).await;
    leave(&server, &first).await;
    // Ticks 1 and 2 have nobody in the world.
    tick_n(&server, 2).await;

    let second = register(&server, "beta-one").await;
    let second_join = tick(&server).await;
    assert_eq!(second_join, 3, "two empty ticks passed");
    assert!(join(&server, &second).await.ok);
    tick_n(&server, 1).await;
    leave(&server, &second).await;

    let now = tick(&server).await;
    let spans = spans(&server, 0, now).await;
    assert_eq!(spans.len(), 2, "spans: {spans:?}");
    assert_eq!(spans[0], TimelineSpan { from: 0, to: 0 });
    assert_eq!(
        spans[1],
        TimelineSpan {
            from: second_join,
            to: second_join,
        }
    );
    for empty in 1..second_join {
        assert!(
            spans
                .iter()
                .all(|span| empty < span.from || empty > span.to),
            "tick {empty} held nobody but a span covers it: {spans:?}"
        );
    }
}

#[tokio::test]
async fn overlapping_sessions_merge_into_one_span() {
    let server = open("overlap", Config::default());
    let first = register(&server, "alpha-one").await;
    let second = register(&server, "beta-one").await;
    assert!(join(&server, &first).await.ok);
    tick_n(&server, 1).await;
    assert!(join(&server, &second).await.ok);
    tick_n(&server, 1).await;
    leave(&server, &first).await;
    leave(&server, &second).await;

    assert_eq!(
        spans(&server, 0, tick(&server).await).await,
        vec![TimelineSpan { from: 0, to: 1 }]
    );
}

#[tokio::test]
async fn touching_spans_merge_into_one() {
    let server = open("touching", Config::default());
    let first = register(&server, "alpha-one").await;
    let second = register(&server, "beta-one").await;
    assert!(join(&server, &first).await.ok);
    tick_n(&server, 1).await;
    leave(&server, &first).await;
    assert!(join(&server, &second).await.ok);
    tick_n(&server, 1).await;
    leave(&server, &second).await;

    assert_eq!(
        spans(&server, 0, tick(&server).await).await,
        vec![TimelineSpan { from: 0, to: 1 }],
        "the second span starts the tick after the first ends"
    );
}

#[tokio::test]
async fn a_queued_session_covers_its_time_in_the_queue() {
    let server = open(
        "queue",
        Config {
            max_on_field: 1,
            ..Config::default()
        },
    );
    let inside = register(&server, "alpha-one").await;
    let queued = register(&server, "beta-one").await;
    assert!(join(&server, &inside).await.ok);
    tick_n(&server, 2).await;

    let queued_join = tick(&server).await;
    assert_eq!(queued_join, 2);
    let waiting = join(&server, &queued).await;
    assert!(waiting.ok, "queued join: {:?}", waiting.error);
    assert!(matches!(
        waiting.result.as_ref().map(|joined| &joined.placement),
        Some(Placement::Waiting { .. })
    ));

    // A body in the queue is on the map, so the join tick itself replays even
    // though this session has not entered the field yet.
    assert_eq!(
        spans(&server, queued_join, queued_join).await,
        vec![TimelineSpan {
            from: queued_join,
            to: queued_join,
        }],
        "queue time must replay from the join tick"
    );

    leave(&server, &inside).await;
    tick_n(&server, 1).await;
    let entered = tick(&server).await;
    assert_eq!(
        entered, 3,
        "the queued session takes the entrance next tick"
    );
    assert_eq!(
        spans(&server, 0, queued_join).await,
        vec![TimelineSpan {
            from: 0,
            to: queued_join,
        }],
        "the inside session's span and the queue span are contiguous"
    );

    tick_n(&server, 2).await;
    leave(&server, &queued).await;
    assert_eq!(
        spans(&server, 0, tick(&server).await).await,
        vec![TimelineSpan { from: 0, to: 4 }],
        "entering from the queue does not move the start forward"
    );
}

#[tokio::test]
async fn the_timeline_response_carries_spans() {
    let server = open("wire", Config::default());
    let token = register(&server, "alpha-one").await;
    assert!(join(&server, &token).await.ok);
    tick_n(&server, 2).await;
    leave(&server, &token).await;

    let env = server.timeline(0, tick(&server).await).await;
    assert!(env.ok, "timeline: {:?}", env.error);
    let json = serde_json::to_value(&env).expect("timeline serialises");
    let spans = json["result"]["spans"]
        .as_array()
        .expect("spans is on the wire");
    assert_eq!(
        spans,
        &vec![serde_json::json!({"from": 0, "to": 1})],
        "the closed interval keeps the `from`/`to` field names"
    );
    assert!(
        json["result"]["markers"].is_array(),
        "markers stay on the wire"
    );
}

#[tokio::test]
async fn an_open_session_starts_its_span_at_the_join_tick() {
    let server = open("open-start", Config::default());
    let token = register(&server, "alpha-one").await;
    // Four empty ticks first, so the session id (1) cannot pass for its tick.
    tick_n(&server, 4).await;
    let join_tick = tick(&server).await;
    assert_eq!(join_tick, 4);
    assert!(join(&server, &token).await.ok);

    assert_eq!(
        spans(&server, 0, join_tick).await,
        vec![TimelineSpan {
            from: join_tick,
            to: join_tick,
        }],
        "a standing session's span begins at its join tick, not at its session id"
    );
    assert!(
        spans(&server, 0, join_tick - 1).await.is_empty(),
        "the empty ticks before the join stay unreplayable"
    );

    tick_n(&server, 2).await;
    assert_eq!(
        spans(&server, 0, tick(&server).await).await,
        vec![TimelineSpan {
            from: join_tick,
            to: join_tick + 2,
        }],
        "the span runs from the join tick to the current tick"
    );
}

#[tokio::test]
async fn an_open_session_does_not_swallow_the_empty_gap_before_it() {
    let server = open("open-gap", Config::default());
    let first = register(&server, "alpha-one").await;
    assert!(join(&server, &first).await.ok);
    tick_n(&server, 1).await;
    leave(&server, &first).await;
    // Ticks 1 and 2 hold nobody.
    tick_n(&server, 2).await;

    let second = register(&server, "beta-one").await;
    let second_join = tick(&server).await;
    assert_eq!(second_join, 3, "two empty ticks passed");
    assert!(join(&server, &second).await.ok);
    tick_n(&server, 2).await;

    let now = tick(&server).await;
    let spans = spans(&server, 0, now).await;
    assert_eq!(
        spans,
        vec![
            TimelineSpan { from: 0, to: 0 },
            TimelineSpan {
                from: second_join,
                to: now,
            },
        ],
        "the open session starts at its join tick; session id {second_join} must not set it"
    );
    for empty in 1..second_join {
        assert!(
            spans
                .iter()
                .all(|span| empty < span.from || empty > span.to),
            "tick {empty} held nobody but a span covers it: {spans:?}"
        );
    }
}

#[tokio::test]
async fn an_omitted_to_reaches_the_current_tick() {
    let server = open("default-to", Config::default());
    let token = register(&server, "alpha-one").await;
    assert!(join(&server, &token).await.ok);
    assert!(
        server
            .build_cmd(
                &token,
                BuildRequest {
                    kind: BuildKind::Wall,
                    target: TargetSpec::Dir(Dir::N),
                },
            )
            .await
            .ok
    );
    tick_n(&server, 3).await;
    assert!(
        server
            .demolish_cmd(
                &token,
                DemolishRequest {
                    target: TargetSpec::Dir(Dir::N),
                },
            )
            .await
            .ok
    );
    tick_n(&server, 3).await;
    let now = tick(&server).await;

    // The HTTP layer sends `Tick::MAX` when `to` is omitted.
    let env = server.timeline(0, Tick::MAX).await;
    assert!(env.ok, "timeline: {:?}", env.error);
    let timeline = env.result.expect("timeline result");
    assert_eq!(
        timeline.to, now,
        "an omitted `to` is clamped to the current tick"
    );
    assert!(
        !timeline.spans.is_empty(),
        "spans survive the default window"
    );
    assert!(
        !timeline.markers.is_empty(),
        "markers survive the default window (the demolish produced a marker)"
    );
}
