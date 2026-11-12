//! Contract §2 acceptance: SSE/replay projection equality, privacy, and the
//! future-tick guard.

use loo_core::{map, Config};
use loo_proto::{JoinRequest, Projection, RegisterRequest, SentBy};
use loo_server::Server;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const TEST_MAP: &str = "\
grid
#########
#.......#
#.......#
#E......#
#.......#
#########
";

fn fresh_dir(name: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("projection-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn open_server(dir: &Path, cfg: Config) -> Arc<Server> {
    let def = map::parse(TEST_MAP).expect("test map parses");
    Arc::new(Server::open(cfg, def, "test-map", TEST_MAP, dir, 7).expect("server opens"))
}

async fn register(server: &Arc<Server>, name: &str, model: &str, intro: &str) -> String {
    let env = server
        .dev_register(RegisterRequest {
            name: Some(loo_proto::Nick::parse(name).expect("valid nick")),
            model: Some(model.to_string()),
            intro: Some(intro.to_string()),
        })
        .await;
    assert!(env.ok, "registration failed: {:?}", env.error);
    env.result.expect("register result").token
}

#[tokio::test]
async fn replay_matches_the_live_projection_field_for_field() {
    let dir = fresh_dir("replay");
    let cfg = Config::default();
    let server = open_server(&dir, cfg.clone());

    let token_a = register(
        &server,
        "agent-one",
        "model-alpha-secret",
        "intro-alpha-secret",
    )
    .await;
    let token_b = register(
        &server,
        "agent-two",
        "model-beta-secret",
        "intro-beta-secret",
    )
    .await;
    for (token, why) in [
        (&token_a, "why-alpha-secret"),
        (&token_b, "why-beta-secret"),
    ] {
        let env = server
            .join(
                token,
                JoinRequest {
                    sent_by: SentBy::Self_,
                    why: why.to_string(),
                },
            )
            .await;
        assert!(env.ok, "join failed: {:?}", env.error);
    }

    let mut recorded: Vec<Projection> = Vec::new();
    recorded.push(server.current_projection().await);
    for _ in 0..5 {
        server.tick_once().await;
        recorded.push(server.current_projection().await);
    }
    assert_eq!(recorded.len(), 6, "tick 0 plus five settled ticks");

    // Privacy: no private field name or value may reach the wire.
    let json = serde_json::to_string(recorded.last().expect("a projection")).unwrap();
    for forbidden in [
        "\"intro\"",
        "\"why\"",
        "\"model\"",
        "\"token\"",
        "intro-alpha-secret",
        "intro-beta-secret",
        "why-alpha-secret",
        "why-beta-secret",
        "model-alpha-secret",
        "model-beta-secret",
    ] {
        assert!(
            !json.contains(forbidden),
            "{forbidden} leaked into the projection"
        );
    }

    // A future tick is an error, not a panic.
    let current = recorded.last().expect("a projection").tick;
    let error = server
        .projection_at(current + 1)
        .await
        .expect_err("a future tick must be refused");
    assert!(error.contains("future"), "unexpected error: {error}");

    // Close the store and replay every tick from the same data directory.
    drop(server);
    let reopened = open_server(&dir, cfg);
    for expected in &recorded {
        let replayed = reopened
            .projection_at(expected.tick)
            .await
            .unwrap_or_else(|error| panic!("tick {} failed to replay: {error}", expected.tick));
        assert_eq!(&replayed, expected, "tick {}", expected.tick);
    }
}

#[tokio::test]
async fn queue_and_counts_agree() {
    let dir = fresh_dir("queue");
    let cfg = Config {
        max_on_field: 1,
        ..Config::default()
    };
    let server = open_server(&dir, cfg);

    let token_a = register(&server, "first-one", "m", "i").await;
    let token_b = register(&server, "second-one", "m", "i").await;
    for token in [&token_a, &token_b] {
        let env = server
            .join(
                token,
                JoinRequest {
                    sent_by: SentBy::Human,
                    why: "want the toilet".to_string(),
                },
            )
            .await;
        assert!(env.ok, "join failed: {:?}", env.error);
    }

    let projection = server.current_projection().await;
    assert_eq!(projection.counts.inside, 1, "only one agent fits");
    assert_eq!(projection.counts.queued, 1, "the second agent waits");
    assert_eq!(
        projection.queue.len(),
        projection.counts.queued,
        "queue and counts must agree"
    );
    assert_eq!(projection.queue[0].nick, "second-one");
    assert_eq!(projection.queue[0].pos, None, "core has no queue cells yet");
}
