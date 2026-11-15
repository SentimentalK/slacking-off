//! Browser-player acceptance tests (contract J: player kinds, `/play` data
//! plane, and the shared command path).
//!
//! Everything here drives the same `Server` API the HTTP handlers use, so a
//! passing test means the web route and the CLI cannot diverge in rules.

use loo_core::{map, Config, WorldState};
use loo_proto::{
    DemolishRequest, Dir, Envelope, ErrorCode, JoinRequest, MoveRequest, MoveSpec, Nick,
    PlacementKind, PlayState, PlayerKind, Pos, RegisterRequest, SentBy, TargetSpec, WaitRequest,
};
use loo_server::Server;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// 21×21 open field: a 9×9 window fits whole, so origin shifting is testable.
const PLAY_MAP: &str = "\
grid
#####################
#...................#
#...................#
#...................#
#...................#
#...................#
#...................#
#...................#
#...................#
#...................#
#.........E.........#
#.........q.........#
#...................#
#...................#
#...................#
#...................#
#...................#
#...................#
#...................#
#...................#
#####################
";

/// 13×7 field with the entrance one cell from the north-west corner: the
/// window is clipped by the map on both axes.
const EDGE_MAP: &str = "\
grid
#############
#E..........#
#q..........#
#...........#
#...........#
#...........#
#############
";

const BASE: &str = "http://127.0.0.1:18085";

fn test_dir(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("play-{name}"))
}

fn fresh_dir(name: &str) -> PathBuf {
    let dir = test_dir(name);
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn open_named(dir: &Path, map_text: &str) -> Arc<Server> {
    let def = map::parse(map_text).expect("test map parses");
    let mut cfg = Config::default();
    // Every test issues its commands in one burst.
    cfg.limits.requests_per_second = 0;
    let server = Server::open_official(cfg, def, "test", map_text, dir, 7);
    Arc::new(server.expect("server opens"))
}

fn open(dir: &Path) -> Arc<Server> {
    open_named(dir, PLAY_MAP)
}

async fn account_token(server: &Server, username: &str) -> (u64, String) {
    let env = server.register_account(username, "password-123").await;
    assert!(env.ok, "account {username}: {:?}", env.error);
    let user_id = server
        .store()
        .user_by_username(username)
        .expect("user lookup")
        .expect("user exists")
        .0;
    let env = server.create_account_token(user_id, BASE);
    let created = expect_ok(env).expect("token created");
    (user_id, created.token)
}

fn expect_ok<T>(env: Envelope<T>) -> Option<T> {
    assert!(env.ok, "unexpected failure: {:?}", env.error);
    env.result
}

fn request(name: &str) -> RegisterRequest {
    RegisterRequest {
        name: Some(Nick::parse(name).expect("test nickname is valid")),
        model: Some("deepseek-v4".to_string()),
        intro: Some("test agent".to_string()),
    }
}

async fn register_agent(
    server: &Server,
    token: &str,
    name: &str,
) -> loo_proto::AccountRegisterResponse {
    expect_ok(server.register_official_agent(token, request(name)).await).expect("agent registered")
}

fn caller(token: &str, agent_id: u64) -> String {
    format!("{token}:{agent_id}")
}

fn join_request() -> JoinRequest {
    JoinRequest {
        sent_by: SentBy::Self_,
        why: "test join".to_string(),
    }
}

fn in_window(window: &loo_proto::PlayWindow, pos: Pos) -> bool {
    pos.x >= window.origin.x
        && pos.x < window.origin.x + window.width
        && pos.y >= window.origin.y
        && pos.y < window.origin.y + window.height
}

/// Contract §7: no CLI envelope carries a player kind as JSON.
fn assert_no_kind<T: serde::Serialize>(env: &Envelope<T>) {
    let json = serde_json::to_string(env).expect("envelope serialises");
    for needle in ["\"kind\"", "\"human\"", "\"ai\""] {
        assert!(!json.contains(needle), "leaked {needle}: {json}");
    }
}

fn expected_object_cells(world: &WorldState, state: &PlayState) -> Vec<(i32, i32)> {
    let mut cells = Vec::new();
    for y in state.window.origin.y..state.window.origin.y + state.window.height {
        for x in state.window.origin.x..state.window.origin.x + state.window.width {
            if world.object_at(Pos::new(x, y)).is_some() {
                cells.push((x, y));
            }
        }
    }
    cells.sort_unstable();
    cells
}

#[tokio::test]
async fn one_account_gets_one_human_character() {
    let dir = fresh_dir("human-create");
    let server = open(&dir);
    let (user_id, _token) = account_token(&server, "alice").await;

    let created = expect_ok(
        server
            .create_human_agent(user_id, "alice-h".to_string(), Some(3))
            .await,
    )
    .expect("human created");
    let me = created.agent.expect("an agent");
    assert_eq!(me.nick, "alice-h");
    assert_eq!(me.color, 3);

    let listed = expect_ok(server.human_agent(user_id))
        .expect("human listed")
        .agent
        .expect("an agent");
    assert_eq!(listed, me);
    assert_eq!(server.human_agent_id(user_id), Some(me.agent_id));

    let again = server
        .create_human_agent(user_id, "alice-2".to_string(), None)
        .await;
    assert!(!again.ok);
    let error = again.error.expect("error");
    assert_eq!(error.code, ErrorCode::RuleRejected);
    assert_eq!(error.message, "this account already has a human character");

    let (other_id, _other_token) = account_token(&server, "bob").await;
    let taken = server
        .create_human_agent(other_id, "alice-h".to_string(), None)
        .await;
    assert!(!taken.ok);
    let error = taken.error.expect("error");
    assert_eq!(error.code, ErrorCode::BadRequest);
    assert!(error.message.contains("already taken"), "{}", error.message);
}

#[tokio::test]
async fn the_human_character_does_not_use_an_agent_slot() {
    let dir = fresh_dir("human-limit");
    let server = open(&dir);
    let (user_id, token) = account_token(&server, "carol").await;
    for index in 0..5 {
        register_agent(&server, &token, &format!("carol-{index}")).await;
    }
    let human = expect_ok(
        server
            .create_human_agent(user_id, "carol-h".to_string(), None)
            .await,
    )
    .expect("human created");
    let human = human.agent.expect("an agent");
    // No explicit colour: the palette entry follows the id.
    assert_eq!(human.color, (human.agent_id % 12) as u8);

    let sixth = server
        .register_official_agent(&token, request("carol-6"))
        .await;
    assert!(!sixth.ok);
    let error = sixth.error.expect("error");
    assert_eq!(error.code, ErrorCode::BadRequest);
    assert!(error.message.contains("limit is 5"), "{}", error.message);
}

#[tokio::test]
async fn play_state_is_a_nine_by_nine_window_around_the_player() {
    let dir = fresh_dir("state-window");
    let server = open(&dir);
    let (user_id, _token) = account_token(&server, "dana").await;
    let me = expect_ok(
        server
            .create_human_agent(user_id, "dana-h".to_string(), Some(5))
            .await,
    )
    .expect("human created")
    .agent
    .expect("an agent");
    let joined = server.join_for_agent(me.agent_id, join_request()).await;
    assert!(joined.ok, "join: {:?}", joined.error);

    let world = server.world_state().await;
    let state = expect_ok(server.play_state(me.agent_id).await).expect("state");

    assert!(state.joined);
    assert_eq!(state.placement, Some(PlacementKind::Inside));
    assert_eq!(state.window.width, 9);
    assert_eq!(state.window.height, 9);
    assert!(state.agent.is_some());
    assert!(state.map.is_some());
    assert!(state.ms_to_next_tick <= 5_000);
    assert_eq!(state.me, me);

    // The objects are exactly the objects of window ∩ map.
    let mut actual: Vec<(i32, i32)> = state
        .objects
        .iter()
        .map(|object| (object.pos.x, object.pos.y))
        .collect();
    actual.sort_unstable();
    assert_eq!(actual, expected_object_cells(&world, &state));

    // Every drawn player stands inside the window, and the caller is drawn.
    assert!(state.agents.iter().any(|agent| agent.id == me.agent_id));
    for agent in &state.agents {
        assert!(
            in_window(&state.window, agent.pos),
            "agent {} at {}",
            agent.id,
            agent.pos
        );
    }

    // Contract §7: no player kind, score, level or entry text leaves /play.
    let forbidden = [
        "\"kind\"",
        "\"score_total\"",
        "\"level\"",
        "\"sent_by\"",
        "\"why\"",
        "\"model\"",
        "\"intro\"",
    ];
    let agents_json = serde_json::to_string(&state.agents).expect("agents serialise");
    for needle in forbidden {
        assert!(
            !agents_json.contains(needle),
            "leaked {needle}: {agents_json}"
        );
    }
    for agent in &state.agents {
        let json = serde_json::to_string(agent).expect("agent serialises");
        for needle in forbidden {
            assert!(!json.contains(needle), "leaked {needle}: {json}");
        }
    }
}

#[tokio::test]
async fn play_state_hides_players_outside_the_window() {
    let dir = fresh_dir("state-outside");
    let server = open_named(&dir, EDGE_MAP);
    let (_user_id, token) = account_token(&server, "erin").await;
    let ai = register_agent(&server, &token, "erin-ai").await;
    let joined = server
        .join(&caller(&token, ai.agent_id), join_request())
        .await;
    assert!(joined.ok, "ai join: {:?}", joined.error);

    let (user_id, _human_token) = account_token(&server, "frank").await;
    let me = expect_ok(
        server
            .create_human_agent(user_id, "frank-h".to_string(), None)
            .await,
    )
    .expect("human created")
    .agent
    .expect("an agent");
    // The entrance is taken, so the human queues at the lane mouth.
    assert!(server.join_for_agent(me.agent_id, join_request()).await.ok);

    // Walk the AI east out of the human's clipped 9×7 window.
    let moved = server
        .move_cmd(
            &caller(&token, ai.agent_id),
            MoveRequest {
                spec: MoveSpec::Steps {
                    dir: Dir::E,
                    count: 9,
                },
            },
        )
        .await;
    assert!(moved.ok, "move: {:?}", moved.error);
    for _ in 0..9 {
        server.tick_once().await;
    }

    let world = server.world_state().await;
    let ai_pos = world
        .agents
        .get(&ai.agent_id)
        .expect("ai in world")
        .pos
        .expect("ai pos");
    assert_eq!(ai_pos.x, 10, "the AI walked nine cells east");

    let state = expect_ok(server.play_state(me.agent_id).await).expect("state");
    assert_eq!((state.window.width, state.window.height), (9, 7));
    assert!(
        !in_window(&state.window, ai_pos),
        "the AI is outside the window"
    );
    assert!(state.agents.iter().any(|agent| agent.id == me.agent_id));
    assert!(
        !state.agents.iter().any(|agent| agent.id == ai.agent_id),
        "an out-of-window player must not be drawn"
    );
    for agent in &state.agents {
        assert!(in_window(&state.window, agent.pos));
    }
}

#[tokio::test]
async fn the_browser_and_the_cli_share_the_same_rules() {
    let dir = fresh_dir("same-rules");
    let server = open(&dir);
    let (_user_id, token) = account_token(&server, "gina").await;
    let ai = register_agent(&server, &token, "gina-ai").await;
    assert!(
        server
            .join(&caller(&token, ai.agent_id), join_request())
            .await
            .ok
    );

    // Demolishing an empty cell is rejected by the same validator on both paths.
    let req = || DemolishRequest {
        target: TargetSpec::Here,
    };
    let web = server.demolish_cmd_for_agent(ai.agent_id, req()).await;
    let cli = server
        .demolish_cmd(&caller(&token, ai.agent_id), req())
        .await;
    let web = web.error.expect("web rejection");
    let cli = cli.error.expect("cli rejection");
    assert_eq!(web.code, ErrorCode::RuleRejected);
    assert_eq!(web.code, cli.code);
    assert_eq!(web.message, cli.message);
}

#[tokio::test]
async fn three_ticks_without_a_command_keep_the_human_joined() {
    let dir = fresh_dir("idle");
    let server = open(&dir);
    let (user_id, _token) = account_token(&server, "hank").await;
    let me = expect_ok(
        server
            .create_human_agent(user_id, "hank-h".to_string(), None)
            .await,
    )
    .expect("human created")
    .agent
    .expect("an agent");
    assert!(server.join_for_agent(me.agent_id, join_request()).await.ok);
    let before = expect_ok(server.play_state(me.agent_id).await)
        .expect("state")
        .agent
        .expect("view")
        .pos;

    for _ in 0..3 {
        server.tick_once().await;
    }

    let state = expect_ok(server.play_state(me.agent_id).await).expect("state after idling");
    assert!(state.joined);
    assert_eq!(state.agent.expect("view").pos, before);
}

#[tokio::test]
async fn a_session_that_shared_the_world_with_another_kind_is_marked() {
    let dir = fresh_dir("mixed");
    let server = open(&dir);
    let (_user_id, token) = account_token(&server, "iris").await;
    let ai = register_agent(&server, &token, "iris-ai").await;
    assert!(
        server
            .join(&caller(&token, ai.agent_id), join_request())
            .await
            .ok
    );

    let (human_user, _human_token) = account_token(&server, "jack").await;
    let human = expect_ok(
        server
            .create_human_agent(human_user, "jack-h".to_string(), None)
            .await,
    )
    .expect("human created")
    .agent
    .expect("an agent");
    assert!(
        server
            .join_for_agent(human.agent_id, join_request())
            .await
            .ok
    );

    // Both sessions overlap at tick 0; leaving either must mark both.
    assert!(server.leave_cmd(&caller(&token, ai.agent_id)).await.ok);
    assert!(server.leave_cmd_for_agent(human.agent_id).await.ok);

    for (agent_id, kind) in [
        (ai.agent_id, PlayerKind::Ai),
        (human.agent_id, PlayerKind::Human),
    ] {
        let profile = expect_ok(server.profile(agent_id).await).expect("profile");
        assert_eq!(profile.kind, kind);
        let row = profile.sessions.first().expect("one session");
        assert!(
            row.with_other_kind,
            "agent {agent_id} shared the world with another kind"
        );
    }
}

#[tokio::test]
async fn the_cli_never_shows_a_player_kind() {
    let dir = fresh_dir("cli-kind");
    let server = open(&dir);
    let (_user_id, token) = account_token(&server, "kim").await;
    let ai = register_agent(&server, &token, "kim-ai").await;
    let caller_id = caller(&token, ai.agent_id);
    let joined = server.join(&caller_id, join_request()).await;
    assert!(joined.ok, "join: {:?}", joined.error);
    server.tick_once().await;

    let mut texts: Vec<String> = joined.events.into_iter().map(|event| event.text).collect();
    let look = server.look(&caller_id).await;
    assert!(look.ok, "look: {:?}", look.error);
    assert_no_kind(&look);
    texts.extend(look.events.into_iter().map(|event| event.text));

    let status = server.status(&caller_id).await;
    assert!(status.ok, "status: {:?}", status.error);
    assert_no_kind(&status);
    texts.extend(status.events.into_iter().map(|event| event.text));

    let waited = server
        .wait(
            &caller_id,
            WaitRequest {
                timeout_seconds: Some(0.1),
            },
        )
        .await;
    assert!(waited.ok, "wait: {:?}", waited.error);
    assert_no_kind(&waited);
    texts.extend(waited.events.into_iter().map(|event| event.text));

    for text in &texts {
        assert!(!text.contains("human"), "event text leaks the kind: {text}");
        assert!(!text.contains("kind"), "event text leaks the kind: {text}");
        assert!(
            !text
                .split_whitespace()
                .any(|word| word.eq_ignore_ascii_case("ai")),
            "event text leaks the kind: {text}"
        );
    }
}
