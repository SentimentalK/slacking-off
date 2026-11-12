//! Official-mode acceptance tests (contract §1): hashed account tokens,
//! per-account agents, the 5-agent limit, nickname ownership and migration of
//! an old dev database.

use loo_core::{map, Config};
use loo_proto::{Envelope, ErrorCode, Nick, RegisterRequest, Tick};
use loo_server::{Server, Store};
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const TEST_MAP: &str = "\
grid
#######
#..#..#
#..E..#
#..#..#
#######
";

const BASE: &str = "http://127.0.0.1:18085";

fn test_dir(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("official-{name}"))
}

fn fresh_dir(name: &str) -> PathBuf {
    let dir = test_dir(name);
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn open(dir: &Path, official: bool) -> Arc<Server> {
    let def = map::parse(TEST_MAP).expect("test map parses");
    let server = if official {
        Server::open_official(Config::default(), def, "test", TEST_MAP, dir, 7)
    } else {
        Server::open(Config::default(), def, "test", TEST_MAP, dir, 7)
    };
    Arc::new(server.expect("server opens"))
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
    assert!(created.install.sh.contains(&created.token));
    (user_id, created.token)
}

fn expect_ok<T>(env: Envelope<T>) -> Option<T> {
    assert!(env.ok, "unexpected failure: {:?}", env.error);
    env.result
}

fn request(name: &str, model: &str, intro: &str) -> RegisterRequest {
    RegisterRequest {
        name: Some(Nick::parse(name).expect("test nickname is valid")),
        model: Some(model.to_string()),
        intro: Some(intro.to_string()),
    }
}

async fn register_agent(
    server: &Server,
    token: &str,
    name: &str,
) -> loo_proto::AccountRegisterResponse {
    expect_ok(
        server
            .register_official_agent(token, request(name, "deepseek-v4", "intro"))
            .await,
    )
    .expect("agent registered")
}

fn caller(token: &str, agent_id: u64) -> String {
    format!("{token}:{agent_id}")
}

#[tokio::test]
async fn database_stores_only_the_sha256_of_the_token() {
    let dir = fresh_dir("hash");
    let server = open(&dir, true);
    let (_user_id, token) = account_token(&server, "alice").await;
    assert_eq!(token.len(), 64, "32 random bytes as hex");

    let conn = Connection::open(server.store_path()).expect("open the database");
    let stored: String = conn
        .query_row("SELECT token_hash FROM auth_tokens", [], |row| row.get(0))
        .expect("token row");
    assert_eq!(stored, loo_server::auth::sha256_hex(&token));
    assert_ne!(stored, token);
    assert!(
        !table_contains(&conn, &token),
        "the plaintext token must not appear in any table"
    );

    let password_hash: String = conn
        .query_row("SELECT password_hash FROM users", [], |row| row.get(0))
        .expect("user row");
    assert!(password_hash.starts_with("$argon2id$"), "{password_hash}");
    assert!(!table_contains(&conn, "password-123"));
}

/// Every table and column, as text: totals up any cell equal to `value`.
fn table_contains(conn: &Connection, value: &str) -> bool {
    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .expect("read schema");
    let names: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .expect("query schema")
        .map(|name| name.expect("table name"))
        .collect();
    for name in names {
        let mut columns = conn
            .prepare(&format!("PRAGMA table_info(\"{name}\")"))
            .expect("read table columns");
        let columns: Vec<String> = columns
            .query_map([], |row| row.get(1))
            .expect("query columns")
            .map(|column| column.expect("column name"))
            .collect();
        for column in columns {
            let sql =
                format!("SELECT COUNT(*) FROM \"{name}\" WHERE CAST(\"{column}\" AS TEXT) = ?1");
            let count: i64 = conn
                .query_row(&sql, [value], |row| row.get(0))
                .expect("count matching cells");
            if count > 0 {
                return true;
            }
        }
    }
    false
}

#[tokio::test]
async fn regenerating_a_token_revokes_the_previous_one() {
    let dir = fresh_dir("revoke");
    let server = open(&dir, true);
    let (user_id, first) = account_token(&server, "alice").await;
    let agent = register_agent(&server, &first, "alice-bot").await;

    let status = server.status(&caller(&first, agent.agent_id)).await;
    assert!(status.ok, "the first token works: {:?}", status.error);

    let second = expect_ok(server.create_account_token(user_id, BASE))
        .expect("second token")
        .token;
    assert_ne!(first, second);

    let rejected = server.status(&caller(&first, agent.agent_id)).await;
    assert!(!rejected.ok);
    assert_eq!(
        rejected.error.as_ref().map(|error| error.code),
        Some(ErrorCode::NotAuthenticated)
    );

    let accepted = server.status(&caller(&second, agent.agent_id)).await;
    assert!(accepted.ok, "the new token works: {:?}", accepted.error);

    let info = expect_ok(server.account_for_user(user_id))
        .expect("account")
        .token;
    assert!(info.active);
    assert!(info.revoked_at_ms.is_none(), "the newest token is live");
}

#[tokio::test]
async fn five_agents_is_the_limit_and_same_nickname_attaches() {
    let dir = fresh_dir("limit");
    let server = open(&dir, true);
    let (user_id, token) = account_token(&server, "alice").await;

    let mut ids = Vec::new();
    for index in 0..5 {
        let name = format!("bot-{index}");
        let response = register_agent(&server, &token, &name).await;
        assert!(!response.attached, "a fresh nickname is created");
        ids.push(response.agent_id);
    }

    let sixth = server
        .register_official_agent(&token, request("bot-5", "m", "i"))
        .await;
    assert!(!sixth.ok, "the sixth agent is refused");
    let message = sixth.error.expect("error").message;
    assert!(message.contains('5'), "the limit is named: {message}");

    let attached = register_agent(&server, &token, "bot-0").await;
    assert!(attached.attached);
    assert_eq!(attached.agent_id, ids[0], "the same agent is returned");

    let account = expect_ok(server.account_for_user(user_id)).expect("account");
    assert_eq!(account.agents.len(), 5, "attaching does not add an agent");
    let first = &account.agents[0];
    assert_eq!(first.agent_id, ids[0]);
    assert_eq!(first.model, "deepseek-v4");
    assert_eq!(first.intro, "intro");

    let updated = server
        .register_official_agent(&token, request("bot-0", "new-model", "new intro"))
        .await;
    assert!(expect_ok(updated).expect("attached").attached);
    let account = expect_ok(server.account_for_user(user_id)).expect("account");
    assert_eq!(account.agents[0].model, "new-model");
    assert_eq!(account.agents[0].intro, "new intro");
}

#[tokio::test]
async fn a_nickname_owned_by_another_account_is_rejected() {
    let dir = fresh_dir("taken");
    let server = open(&dir, true);
    let (_, alice_token) = account_token(&server, "alice").await;
    let (_, bob_token) = account_token(&server, "bob").await;

    let owner = register_agent(&server, &alice_token, "shared-nick").await;

    let attempt = server
        .register_official_agent(&bob_token, request("shared-nick", "bob-model", "bob-intro"))
        .await;
    assert!(!attempt.ok, "another account cannot take the nickname");
    assert_eq!(
        attempt.error.as_ref().map(|error| error.code),
        Some(ErrorCode::BadRequest)
    );

    let alice_id = server
        .store()
        .user_by_username("alice")
        .expect("lookup")
        .expect("alice")
        .0;
    let agents = server.store().agents_of_user(alice_id).expect("agents");
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0].id, owner.agent_id);
    assert_eq!(agents[0].model, "deepseek-v4");
    assert_eq!(agents[0].intro, "intro");
}

#[tokio::test]
async fn account_without_a_token_reports_no_active_token() {
    let dir = fresh_dir("no-token");
    let server = open(&dir, true);
    let env = server.register_account("carol", "password-123").await;
    assert!(env.ok, "{:?}", env.error);
    let user_id = server
        .store()
        .user_by_username("carol")
        .expect("lookup")
        .expect("carol")
        .0;
    let account = expect_ok(server.account_for_user(user_id)).expect("account");
    assert_eq!(account.username, "carol");
    assert!(account.agents.is_empty());
    assert!(!account.token.active);
    assert!(account.token.created_at_ms.is_none());
}

#[tokio::test]
async fn a_revoked_token_cannot_register_or_run_commands() {
    let dir = fresh_dir("revoked");
    let server = open(&dir, true);
    let (user_id, token) = account_token(&server, "alice").await;
    let agent = register_agent(&server, &token, "alice-bot").await;

    server.revoke_account_tokens(user_id).expect("revoke");

    let rejected = server.status(&caller(&token, agent.agent_id)).await;
    assert_eq!(
        rejected.error.as_ref().map(|error| error.code),
        Some(ErrorCode::NotAuthenticated)
    );
    let registration = server
        .register_official_agent(&token, request("second-bot", "m", "i"))
        .await;
    assert!(!registration.ok);
}

#[tokio::test]
async fn official_open_marks_the_world_and_keeps_dev_rows() {
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

    let official = open(&dir, true);
    assert!(official.official());
    assert!(official.store().is_official().expect("world mode"));
    let agents = official.store().agents().expect("agents load");
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0].id, 9);
    assert_eq!(agents[0].token, "old-token", "the dev token is preserved");
    assert_eq!(agents[0].user_id, None);
    drop(official);

    // The rebuilt table accepts an account agent without a dev token.
    let server = open(&dir, true);
    let (_, token) = account_token(&server, "alice").await;
    register_agent(&server, &token, "alice-bot").await;
    drop(server);

    // Dev mode still authenticates the preserved token.
    let dev = open(&dir, false);
    let status = dev.status("old-token").await;
    assert!(status.ok, "dev token still works: {:?}", status.error);
    let world: Tick = dev.world_state().await.tick;
    assert_eq!(world, 0);
}

#[tokio::test]
async fn duplicate_legacy_nicknames_fail_loudly() {
    let dir = fresh_dir("duplicate-nicks");
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
    token TEXT UNIQUE,
    sent_by TEXT,
    why TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    score_total INTEGER NOT NULL DEFAULT 0
);
INSERT INTO agents(id, world_id, nick, model, intro, token, sent_by, why, created_at_ms)
VALUES(1, 1, 'same-nick', 'm', 'i', 'token-a', NULL, '', 1),
      (2, 1, 'same-nick', 'm', 'i', 'token-b', NULL, '', 2);
",
        )
        .expect("old schema with duplicates");
    }
    let error = Store::open(&dir, "test", TEST_MAP, 7)
        .err()
        .expect("duplicate nicknames are a corrupt store");
    let message = error.to_string();
    assert!(message.contains("duplicate nicknames"), "{message}");
    assert!(message.contains("same-nick"), "{message}");
}
