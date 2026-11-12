//! Contract §3 acceptance: session rows, leaderboards, stats, profiles,
//! timeline markers and the free-text isolation rule.

use loo_core::{map, Config, Event, EventKind, ObjectCause};
use loo_proto::{
    Envelope, EventTag, JoinRequest, MoveRequest, MoveSpec, Need, Pos, RegisterRequest, SentBy,
    SessionOutcome, Tick,
};
use loo_server::Server;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const TEST_MAP: &str = "\
grid
#######
#.....#
#..E..#
#..q..#
#######
";

const BASE: &str = "http://127.0.0.1:18086";

fn fresh_dir(name: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("boards-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn open_official(dir: &Path) -> Arc<Server> {
    let def = map::parse(TEST_MAP).expect("test map parses");
    let mut cfg = Config::default();
    cfg.limits.requests_per_second = 0;
    Arc::new(Server::open_official(cfg, def, "test", TEST_MAP, dir, 7).expect("server opens"))
}

fn open_dev(dir: &Path) -> Arc<Server> {
    let def = map::parse(TEST_MAP).expect("test map parses");
    let mut cfg = Config::default();
    cfg.limits.requests_per_second = 0;
    Arc::new(Server::open(cfg, def, "test", TEST_MAP, dir, 7).expect("server opens"))
}

async fn account(server: &Server, username: &str) -> (u64, String) {
    let env = server.register_account(username, "password-123").await;
    assert!(env.ok, "account {username}: {:?}", env.error);
    let user_id = server
        .store()
        .user_by_username(username)
        .expect("user lookup")
        .expect("user exists")
        .0;
    let created = expect_ok(server.create_account_token(user_id, BASE)).expect("token created");
    (user_id, created.token)
}

async fn register_account_agent(
    server: &Server,
    token: &str,
    nick: &str,
    model: &str,
    intro: &str,
) -> u64 {
    let env = server
        .register_official_agent(
            token,
            RegisterRequest {
                name: Some(loo_proto::Nick::parse(nick).expect("valid nick")),
                model: Some(model.to_string()),
                intro: Some(intro.to_string()),
            },
        )
        .await;
    expect_ok(env).expect("agent registered").agent_id
}

fn expect_ok<T>(env: Envelope<T>) -> Option<T> {
    assert!(env.ok, "unexpected failure: {:?}", env.error);
    env.result
}

/// Inserts a finished session row directly, the way the server would after a
/// full session. Tests may use store insertion methods (task step 7).
#[allow(clippy::too_many_arguments)]
fn add_session(
    server: &Server,
    id: u64,
    agent: u64,
    started_tick: Tick,
    score: u32,
    outcome: SessionOutcome,
    sent_by: Option<SentBy>,
    why: &str,
) {
    server
        .store()
        .insert_session(id, 1, agent, started_tick, Some(Need::Urine), sent_by, why)
        .expect("session row inserted");
    server
        .store()
        .finish_session(id, started_tick + 1, outcome, score)
        .expect("session row finished");
}

fn ids(rows: &[loo_proto::LeaderRow]) -> Vec<u64> {
    rows.iter().map(|row| row.agent_id).collect()
}

#[tokio::test]
async fn leaderboards_rank_by_each_metric_and_respect_the_limit() {
    let dir = fresh_dir("metrics");
    let server = open_official(&dir);
    let (_, alice) = account(&server, "alice").await;
    let (_, bob) = account(&server, "bob").await;
    let alpha = register_account_agent(&server, &alice, "alpha-one", "alpha", "intro").await;
    let beta = register_account_agent(&server, &bob, "beta-one", "beta", "intro").await;

    server.store().set_agent_score(alpha, 300).unwrap();
    server.store().set_agent_score(beta, 200).unwrap();
    // alpha: two successes, best 100. beta: one success, best 250.
    add_session(
        &server,
        1,
        alpha,
        10,
        100,
        SessionOutcome::Success,
        Some(SentBy::Self_),
        "why",
    );
    add_session(
        &server,
        2,
        alpha,
        20,
        60,
        SessionOutcome::Success,
        Some(SentBy::Human),
        "why",
    );
    add_session(
        &server,
        3,
        beta,
        30,
        250,
        SessionOutcome::Success,
        Some(SentBy::Self_),
        "why",
    );
    add_session(
        &server,
        4,
        beta,
        40,
        10,
        SessionOutcome::FailedDeadline,
        None,
        "why",
    );

    let score = expect_ok(server.leaderboard("score", None, 50).await).expect("rows");
    assert_eq!(ids(&score), vec![alpha, beta], "score_total descending");
    assert_eq!((score[0].rank, score[1].rank), (1, 2));
    assert_eq!((score[0].score_total, score[1].score_total), (300, 200));

    let best = expect_ok(server.leaderboard("best", None, 50).await).expect("rows");
    assert_eq!(ids(&best), vec![beta, alpha], "best score descending");
    assert_eq!((best[0].best_score, best[1].best_score), (250, 100));

    let successes = expect_ok(server.leaderboard("successes", None, 50).await).expect("rows");
    assert_eq!(
        ids(&successes),
        vec![alpha, beta],
        "success count descending"
    );
    assert_eq!((successes[0].successes, successes[1].successes), (2, 1));

    let limited = expect_ok(server.leaderboard("score", None, 1).await).expect("rows");
    assert_eq!(limited.len(), 1, "limit is enforced");
    assert_eq!(limited[0].agent_id, alpha);
    assert_eq!(limited[0].rank, 1);

    let clamped = expect_ok(server.leaderboard("score", None, 0).await).expect("rows");
    assert_eq!(clamped.len(), 1, "limit clamps to at least one row");
}

#[tokio::test]
async fn leaderboard_model_filter_is_exact() {
    let dir = fresh_dir("model");
    let server = open_official(&dir);
    let (_, alice) = account(&server, "alice").await;
    let (_, bob) = account(&server, "bob").await;
    let alpha = register_account_agent(&server, &alice, "alpha-one", "alpha", "intro").await;
    let beta = register_account_agent(&server, &bob, "beta-one", "beta", "intro").await;

    let filtered = expect_ok(server.leaderboard("score", Some("alpha"), 50).await).expect("rows");
    assert_eq!(ids(&filtered), vec![alpha], "only the alpha model");

    let partial = expect_ok(server.leaderboard("score", Some("alp"), 50).await).expect("rows");
    assert!(partial.is_empty(), "matching is exact, not a prefix");

    let empty = expect_ok(server.leaderboard("score", Some(""), 50).await).expect("rows");
    assert_eq!(
        ids(&empty),
        vec![alpha, beta],
        "empty model means no filter"
    );

    assert!(
        !server.leaderboard("points", None, 50).await.ok,
        "unknown metric is refused"
    );
}

#[tokio::test]
async fn a_dev_world_feeds_no_boards() {
    let dir = fresh_dir("dev");
    let server = open_dev(&dir);
    let env = server
        .dev_register(RegisterRequest {
            name: Some(loo_proto::Nick::parse("dev-one").expect("valid nick")),
            model: Some("dev-model".to_string()),
            intro: Some("dev intro".to_string()),
        })
        .await;
    let agent_id = expect_ok(env).expect("registered").agent_id;
    add_session(
        &server,
        1,
        agent_id,
        5,
        100,
        SessionOutcome::Success,
        Some(SentBy::Self_),
        "dev why",
    );

    let rows = expect_ok(server.leaderboard("score", None, 50).await).expect("rows");
    assert!(rows.is_empty(), "official = 0 feeds no leaderboard");
    let stats = expect_ok(server.stats().await).expect("stats");
    assert_eq!(stats.total_sessions, 0);
    assert_eq!(stats.self_sessions, 0);
    assert_eq!(stats.human_sessions, 0);
    assert_eq!(stats.success_rate, 0.0);
    assert!(stats.models.is_empty(), "no models in a dev world");

    // A dev agent is still queryable by id; its owner is empty.
    let profile = expect_ok(server.profile(agent_id).await).expect("profile");
    assert_eq!(profile.owner, "");
    assert_eq!(profile.visits, 1);
}

#[tokio::test]
async fn stats_count_senders_and_group_models() {
    let dir = fresh_dir("stats");
    let server = open_official(&dir);
    let (_, alice) = account(&server, "alice").await;
    let (_, bob) = account(&server, "bob").await;
    let alpha = register_account_agent(&server, &alice, "alpha-one", "alpha", "intro").await;
    let beta = register_account_agent(&server, &bob, "beta-one", "beta", "intro").await;
    server.store().set_agent_score(alpha, 300).unwrap();
    server.store().set_agent_score(beta, 200).unwrap();

    add_session(
        &server,
        1,
        alpha,
        10,
        100,
        SessionOutcome::Success,
        Some(SentBy::Self_),
        "why",
    );
    add_session(
        &server,
        2,
        alpha,
        20,
        0,
        SessionOutcome::Left,
        Some(SentBy::Human),
        "why",
    );
    add_session(
        &server,
        3,
        beta,
        30,
        50,
        SessionOutcome::Success,
        None,
        "why",
    );
    add_session(
        &server,
        4,
        beta,
        40,
        30,
        SessionOutcome::Success,
        Some(SentBy::Self_),
        "why",
    );

    let stats = expect_ok(server.stats().await).expect("stats");
    assert_eq!(stats.total_sessions, 4);
    assert_eq!(stats.self_sessions, 2);
    assert_eq!(stats.human_sessions, 1, "NULL sent_by counts in total only");
    assert_eq!(stats.success_rate, 0.75, "3 successes out of 4 ended");

    let models: Vec<(&str, u64, u64, u64, u64, f64)> = stats
        .models
        .iter()
        .map(|model| {
            (
                model.model.as_str(),
                model.agents,
                model.sessions,
                model.successes,
                model.total_score,
                model.success_rate,
            )
        })
        .collect();
    assert_eq!(
        models,
        vec![("alpha", 1, 2, 1, 300, 0.5), ("beta", 1, 2, 2, 200, 1.0),],
        "models sort by total_score descending"
    );
}

#[tokio::test]
async fn profile_agrees_with_session_rows_and_hides_nothing_from_the_owner() {
    let dir = fresh_dir("profile");
    let server = open_official(&dir);
    let (_, alice) = account(&server, "alice").await;
    let agent = register_account_agent(&server, &alice, "alpha-one", "alpha", "the intro").await;
    server.store().set_agent_score(agent, 300).unwrap();

    add_session(
        &server,
        1,
        agent,
        30,
        100,
        SessionOutcome::Success,
        Some(SentBy::Self_),
        "the newest why",
    );
    add_session(
        &server,
        2,
        agent,
        10,
        0,
        SessionOutcome::FailedDeadline,
        Some(SentBy::Human),
        "the oldest why",
    );
    add_session(
        &server,
        3,
        agent,
        20,
        5,
        SessionOutcome::Left,
        None,
        "the middle why",
    );

    let profile = expect_ok(server.profile(agent).await).expect("profile");
    assert_eq!(profile.owner, "alice");
    assert_eq!(profile.nick, "alpha-one");
    assert_eq!(profile.model, "alpha");
    assert_eq!(profile.intro, "the intro");
    assert_eq!(profile.score_total, 300);
    assert_eq!(profile.visits, 3);
    assert_eq!(profile.successes, 1);
    assert_eq!(profile.success_rate, 1.0 / 3.0);
    assert_eq!(profile.self_sessions, 1);
    assert_eq!(profile.human_sessions, 1);
    let started: Vec<Tick> = profile.sessions.iter().map(|s| s.started_tick).collect();
    assert_eq!(started, vec![30, 20, 10], "newest session first");
    assert_eq!(profile.sessions[0].why, "the newest why");
    assert_eq!(profile.sessions[0].outcome, Some(SessionOutcome::Success));
    assert_eq!(profile.sessions[0].score, 100);
    assert_eq!(profile.sessions[1].outcome, Some(SessionOutcome::Left));

    assert!(server.store().profile(9999).expect("lookup").is_none());
    assert!(!server.profile(9999).await.ok, "unknown agent is an error");
}

#[tokio::test]
async fn timeline_keeps_only_marker_kinds_in_tick_order() {
    let dir = fresh_dir("timeline");
    let server = open_official(&dir);
    let events = vec![
        Event {
            tick: 3,
            seq: 1,
            seed: 0,
            kind: EventKind::Joined {
                session: 1,
                agent: 1,
                nick: "alpha-one".to_string(),
                at: Some(Pos::new(1, 1)),
                inside: true,
                ahead: 0,
                score_total: 0,
            },
        },
        Event {
            tick: 12,
            seq: 1,
            seed: 0,
            kind: EventKind::UseSucceeded {
                session: 1,
                agent: 1,
                nick: "alpha-one".to_string(),
                pos: Pos::new(1, 1),
                score: 10,
                success_tick: 12,
                linger_until: 13,
            },
        },
        Event {
            tick: 20,
            seq: 1,
            seed: 0,
            kind: EventKind::AttackLanded {
                session: 1,
                agent: 1,
                nick: "alpha-one".to_string(),
                target_session: 2,
                target_agent: 2,
                target_nick: "beta-one".to_string(),
                at: Pos::new(2, 2),
                penalty: 1,
                deadline: 30,
                stun_until: 22,
                immunity_until: 30,
            },
        },
        Event {
            tick: 30,
            seq: 1,
            seed: 0,
            kind: EventKind::ObjectChanged {
                session: Some(1),
                agent: Some(1),
                nick: Some("alpha-one".to_string()),
                pos: Pos::new(1, 1),
                object: None,
                cause: ObjectCause::Demolish,
            },
        },
        Event {
            tick: 40,
            seq: 1,
            seed: 0,
            kind: EventKind::DemolishBlocked {
                session: 1,
                agent: 1,
                nick: "alpha-one".to_string(),
                target: Pos::new(2, 2),
                defender_session: 2,
                defender_agent: 2,
                defender_nick: "beta-one".to_string(),
                stun_until: 45,
            },
        },
    ];
    server
        .store()
        .append_tick(40, &events)
        .expect("events stored");

    let timeline = expect_ok(server.timeline(0, 999_999).await).expect("timeline");
    let kinds: Vec<EventTag> = timeline.markers.iter().map(|marker| marker.kind).collect();
    assert_eq!(
        kinds,
        vec![
            EventTag::Success,
            EventTag::Attack,
            EventTag::Demolish,
            EventTag::Defend,
        ]
    );
    let ticks: Vec<Tick> = timeline.markers.iter().map(|marker| marker.tick).collect();
    assert_eq!(ticks, vec![12, 20, 30, 40], "ascending by tick");
    assert!(timeline
        .markers
        .iter()
        .all(|marker| !marker.text.is_empty()));

    let window = expect_ok(server.timeline(25, 35).await).expect("timeline");
    assert_eq!(window.from, 25);
    assert_eq!(window.to, 35);
    assert_eq!(window.markers.len(), 1, "only the tick 30 marker is inside");
    assert_eq!(window.markers[0].kind, EventTag::Demolish);
}

#[tokio::test]
async fn another_agent_never_sees_free_text() {
    const WHY: &str = "WHY-SECRET-ALPHA";
    const INTRO: &str = "INTRO-SECRET-ALPHA";
    const MODEL: &str = "MODEL-SECRET-ALPHA";

    let dir = fresh_dir("privacy");
    let server = open_dev(&dir);
    let register = |name: &str, model: &str, intro: &str| RegisterRequest {
        name: Some(loo_proto::Nick::parse(name).expect("valid nick")),
        model: Some(model.to_string()),
        intro: Some(intro.to_string()),
    };
    let alpha = expect_ok(
        server
            .dev_register(register("alpha-one", MODEL, INTRO))
            .await,
    )
    .expect("alpha registered");
    let beta = expect_ok(
        server
            .dev_register(register("beta-one", "model-b", "intro-b"))
            .await,
    )
    .expect("beta registered");

    let joined = server
        .join(
            &alpha.token,
            JoinRequest {
                sent_by: SentBy::Self_,
                why: WHY.to_string(),
            },
        )
        .await;
    assert!(joined.ok, "alpha join: {:?}", joined.error);
    let moved = server
        .move_cmd(
            &alpha.token,
            MoveRequest {
                spec: MoveSpec::Steps {
                    dir: loo_proto::Dir::N,
                    count: 1,
                },
            },
        )
        .await;
    assert!(moved.ok, "alpha move: {:?}", moved.error);
    server.tick_once().await;
    let joined = server
        .join(
            &beta.token,
            JoinRequest {
                sent_by: SentBy::Human,
                why: "why-b".to_string(),
            },
        )
        .await;
    assert!(joined.ok, "beta join: {:?}", joined.error);

    let projection = serde_json::to_string(&server.current_projection().await).expect("projection");
    assert!(
        projection.contains("alpha-one"),
        "the nickname is the only free text other agents can see: {projection}"
    );
    let responses = [
        serde_json::to_string(&server.look(&beta.token).await).expect("look json"),
        serde_json::to_string(&server.status(&beta.token).await).expect("status json"),
        serde_json::to_string(&server.map_view(&beta.token).await).expect("map json"),
        serde_json::to_string(
            &server
                .wait(
                    &beta.token,
                    loo_proto::WaitRequest {
                        timeout_seconds: Some(0.05),
                    },
                )
                .await,
        )
        .expect("wait json"),
        projection,
    ];
    for json in &responses {
        for secret in [WHY, INTRO, MODEL] {
            assert!(
                !json.contains(secret),
                "{secret} leaked into another agent's response: {json}"
            );
        }
    }
}
