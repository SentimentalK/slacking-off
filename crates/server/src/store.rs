//! SQLite persistence (design §8): the world row, the event log, snapshots, the
//! command log and the agents registered against this world.
//!
//! The event log is the source of truth; snapshots only shorten recovery. Every
//! tick's events and the world's tick counter are written in one transaction, so
//! a crash never leaves a tick half-recorded.

use loo_core::{Event, EventKind, IntentKind, Snapshot, WorldState};
use loo_proto::{AccountTokenInfo, AgentId, Tick, WorldSummary};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

/// This server keeps a single world per database file.
const WORLD_ID: i64 = 1;

const SCHEMA: &str = "\
CREATE TABLE IF NOT EXISTS worlds(
    id INTEGER PRIMARY KEY,
    seed_base INTEGER NOT NULL,
    map_name TEXT NOT NULL,
    map_text TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    tick INTEGER NOT NULL,
    official INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    world_id INTEGER NOT NULL,
    tick INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    seed INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    ts_ms INTEGER NOT NULL,
    UNIQUE(world_id, tick, seq)
);
CREATE TABLE IF NOT EXISTS snapshots(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    world_id INTEGER NOT NULL,
    tick INTEGER NOT NULL,
    state TEXT NOT NULL,
    ts_ms INTEGER NOT NULL,
    UNIQUE(world_id, tick)
);
CREATE TABLE IF NOT EXISTS commands(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    world_id INTEGER NOT NULL,
    ts_ms INTEGER NOT NULL,
    tick INTEGER NOT NULL,
    agent INTEGER,
    command TEXT NOT NULL,
    ok INTEGER NOT NULL,
    summary TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    intent TEXT
);
CREATE TABLE IF NOT EXISTS agents(
    id INTEGER PRIMARY KEY,
    world_id INTEGER NOT NULL,
    nick TEXT NOT NULL,
    model TEXT NOT NULL,
    intro TEXT NOT NULL,
    token TEXT UNIQUE,
    sent_by TEXT,
    why TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    score_total INTEGER NOT NULL DEFAULT 0,
    user_id INTEGER
);
CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_tokens(
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at_ms INTEGER NOT NULL,
    revoked_at_ms INTEGER
);
CREATE TABLE IF NOT EXISTS web_sessions(
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_tick ON events(world_id, tick, seq);
";

/// One registered dev identity as stored in the `agents` table.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredAgent {
    pub id: AgentId,
    pub nick: String,
    pub model: String,
    pub intro: String,
    /// `""` for an account agent: its token lives in `auth_tokens`.
    pub token: String,
    /// `self` or `human`, recorded when the agent joins.
    pub sent_by: Option<String>,
    pub why: String,
    /// Cumulative score over every session, persisted with each scored tick.
    pub score_total: u32,
    /// Owning account; `None` for dev agents.
    pub user_id: Option<u64>,
    pub created_at_ms: u64,
}

#[derive(Debug)]
pub enum StoreError {
    Sqlite(rusqlite::Error),
    Json(serde_json::Error),
    Io(std::io::Error),
    Replay(loo_core::ReplayError),
    MapMismatch,
    Corrupt(String),
    Conflict(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Sqlite(error) => write!(f, "sqlite: {error}"),
            StoreError::Json(error) => write!(f, "json: {error}"),
            StoreError::Io(error) => write!(f, "io: {error}"),
            StoreError::Replay(error) => write!(f, "replay: {error}"),
            StoreError::MapMismatch => write!(
                f,
                "the stored world was created from a different map; point --map at that map or use a fresh --data-dir"
            ),
            StoreError::Corrupt(message) => write!(f, "corrupt store: {message}"),
            StoreError::Conflict(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for StoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            StoreError::Sqlite(error) => Some(error),
            StoreError::Json(error) => Some(error),
            StoreError::Io(error) => Some(error),
            StoreError::Replay(error) => Some(error),
            StoreError::MapMismatch | StoreError::Corrupt(_) | StoreError::Conflict(_) => None,
        }
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        StoreError::Sqlite(error)
    }
}

impl From<serde_json::Error> for StoreError {
    fn from(error: serde_json::Error) -> Self {
        StoreError::Json(error)
    }
}

impl From<std::io::Error> for StoreError {
    fn from(error: std::io::Error) -> Self {
        StoreError::Io(error)
    }
}

impl From<loo_core::ReplayError> for StoreError {
    fn from(error: loo_core::ReplayError) -> Self {
        StoreError::Replay(error)
    }
}

impl From<loo_core::MapError> for StoreError {
    fn from(error: loo_core::MapError) -> Self {
        StoreError::Corrupt(format!("stored map text does not parse: {error}"))
    }
}

pub struct Store {
    conn: Mutex<Connection>,
    path: PathBuf,
}

impl Store {
    /// Opens (or creates) `<dir>/world.db`. `map_name`, `map_text` and
    /// `seed_base` only seed a brand-new world; an existing world keeps its own
    /// seed.
    pub fn open(
        dir: &Path,
        map_name: &str,
        map_text: &str,
        seed_base: u64,
    ) -> Result<Store, StoreError> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join("world.db");
        let conn = Connection::open(&path)?;
        conn.query_row("PRAGMA journal_mode=WAL", [], |_| Ok(()))?;
        conn.execute_batch("PRAGMA synchronous=NORMAL;")?;
        conn.execute_batch(SCHEMA)?;
        migrate_agents(&conn)?;
        migrate_worlds_official(&conn)?;

        let existing: Option<i64> = conn
            .query_row(
                "SELECT seed_base FROM worlds WHERE id = ?1",
                [WORLD_ID],
                |row| row.get(0),
            )
            .optional()?;
        if existing.is_none() {
            conn.execute(
                "INSERT INTO worlds(id, seed_base, map_name, map_text, created_at_ms, tick) \
                 VALUES(?1, ?2, ?3, ?4, ?5, 0)",
                params![
                    WORLD_ID,
                    seed_base as i64,
                    map_name,
                    map_text,
                    now_ms() as i64
                ],
            )?;
        }

        Ok(Store {
            conn: Mutex::new(conn),
            path,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn conn(&self) -> Result<MutexGuard<'_, Connection>, StoreError> {
        self.conn
            .lock()
            .map_err(|_| StoreError::Corrupt("the store mutex is poisoned".to_string()))
    }

    pub fn map_text(&self) -> Result<String, StoreError> {
        Ok(self.conn()?.query_row(
            "SELECT map_text FROM worlds WHERE id = ?1",
            [WORLD_ID],
            |row| row.get(0),
        )?)
    }

    pub fn seed_base(&self) -> Result<u64, StoreError> {
        let seed: i64 = self.conn()?.query_row(
            "SELECT seed_base FROM worlds WHERE id = ?1",
            [WORLD_ID],
            |row| row.get(0),
        )?;
        Ok(seed as u64)
    }

    pub fn world_tick(&self) -> Result<Option<Tick>, StoreError> {
        let tick: Option<i64> = self
            .conn()?
            .query_row("SELECT tick FROM worlds WHERE id = ?1", [WORLD_ID], |row| {
                row.get(0)
            })
            .optional()?;
        Ok(tick.map(|tick| tick as Tick))
    }

    /// `journal_mode`, so tests and operators can confirm WAL is on.
    pub fn journal_mode(&self) -> Result<String, StoreError> {
        Ok(self
            .conn()?
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))?)
    }

    /// Appends one tick's events and advances the stored tick in one
    /// transaction. Any failure rolls the whole tick back.
    pub fn append_tick(&self, tick: Tick, events: &[Event]) -> Result<(), StoreError> {
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let ts_ms = now_ms() as i64;
        {
            let mut insert = tx.prepare(
                "INSERT INTO events(world_id, tick, seq, seed, kind, payload, ts_ms) \
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            for event in events {
                insert.execute(params![
                    WORLD_ID,
                    event.tick as i64,
                    event.seq as i64,
                    event.seed as i64,
                    event.kind.name(),
                    serde_json::to_string(event)?,
                    ts_ms
                ])?;
            }
        }
        {
            // Scores and their events commit together; `SessionEnded` and
            // `UseFailed` never carry a score.
            let mut update = tx.prepare(
                "UPDATE agents SET score_total = score_total + ?1 \
                 WHERE id = ?2 AND world_id = ?3",
            )?;
            for event in events {
                if let EventKind::UseSucceeded { agent, score, .. } = &event.kind {
                    update.execute(params![*score as i64, *agent as i64, WORLD_ID])?;
                }
            }
        }
        tx.execute(
            "UPDATE worlds SET tick = ?1 WHERE id = ?2",
            params![tick as i64, WORLD_ID],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Appends between-tick events (joins) without advancing the world tick.
    pub fn append_join_events(&self, tick: Tick, events: &[Event]) -> Result<(), StoreError> {
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let ts_ms = now_ms() as i64;
        {
            let mut insert = tx.prepare(
                "INSERT INTO events(world_id, tick, seq, seed, kind, payload, ts_ms) \
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            for event in events {
                insert.execute(params![
                    WORLD_ID,
                    tick as i64,
                    event.seq as i64,
                    event.seed as i64,
                    event.kind.name(),
                    serde_json::to_string(event)?,
                    ts_ms
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn snapshot(&self, snapshot: &Snapshot) -> Result<(), StoreError> {
        self.conn()?.execute(
            "INSERT OR REPLACE INTO snapshots(world_id, tick, state, ts_ms) \
             VALUES(?1, ?2, ?3, ?4)",
            params![
                WORLD_ID,
                snapshot.world.tick as i64,
                serde_json::to_string(snapshot)?,
                now_ms() as i64
            ],
        )?;
        Ok(())
    }

    /// The latest checkpoint. Older databases stored a bare `WorldState`; they
    /// are upgraded in place by reading the last seq already committed at that
    /// tick, so a restart never loses the tick-0 join cursor.
    pub fn latest_snapshot(&self) -> Result<Option<(Tick, Snapshot)>, StoreError> {
        let row: Option<(i64, String)> = self
            .conn()?
            .query_row(
                "SELECT tick, state FROM snapshots WHERE world_id = ?1 \
                 ORDER BY tick DESC LIMIT 1",
                [WORLD_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        match row {
            None => Ok(None),
            Some((tick, state)) => {
                let tick = tick as Tick;
                match serde_json::from_str::<Snapshot>(&state) {
                    Ok(snapshot) => Ok(Some((tick, snapshot))),
                    Err(_) => {
                        let world: WorldState = serde_json::from_str(&state)?;
                        let last_seq = self.last_seq_at(tick)?;
                        Ok(Some((tick, Snapshot::at(world, last_seq))))
                    }
                }
            }
        }
    }

    /// The newest checkpoint at or before `tick`, by tick.
    ///
    /// Older databases stored a bare `WorldState`; those rows are upgraded the
    /// same way [`Store::latest_snapshot`] does it.
    pub fn snapshot_at_or_before(
        &self,
        tick: Tick,
    ) -> Result<Option<(Tick, Snapshot)>, StoreError> {
        let row: Option<(i64, String)> = self
            .conn()?
            .query_row(
                "SELECT tick, state FROM snapshots WHERE world_id = ?1 AND tick <= ?2 \
                 ORDER BY tick DESC LIMIT 1",
                params![WORLD_ID, tick as i64],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        match row {
            None => Ok(None),
            Some((tick, state)) => {
                let tick = tick as Tick;
                match serde_json::from_str::<Snapshot>(&state) {
                    Ok(snapshot) => Ok(Some((tick, snapshot))),
                    Err(_) => {
                        let world: WorldState = serde_json::from_str(&state)?;
                        let last_seq = self.last_seq_at(tick)?;
                        Ok(Some((tick, Snapshot::at(world, last_seq))))
                    }
                }
            }
        }
    }

    /// Every event of one tick, in sequence order.
    pub fn events_of_tick(&self, tick: Tick) -> Result<Vec<Event>, StoreError> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare("SELECT payload FROM events WHERE world_id = ?1 AND tick = ?2 ORDER BY seq")?;
        let rows = stmt.query_map(params![WORLD_ID, tick as i64], |row| {
            row.get::<_, String>(0)
        })?;
        let mut events = Vec::new();
        for payload in rows {
            events.push(serde_json::from_str(&payload?)?);
        }
        Ok(events)
    }

    /// Events from the `(from_tick, from_seq)` cursor through `to_tick`
    /// inclusive, in `(tick, seq)` order. The cursor itself is included.
    pub fn events_between(
        &self,
        from_tick: Tick,
        from_seq: u32,
        to_tick: Tick,
    ) -> Result<Vec<Event>, StoreError> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT payload FROM events WHERE world_id = ?1 AND tick <= ?4 \
             AND (tick > ?2 OR (tick = ?2 AND seq >= ?3)) ORDER BY tick, seq",
        )?;
        let rows = stmt.query_map(
            params![WORLD_ID, from_tick as i64, from_seq as i64, to_tick as i64],
            |row| row.get::<_, String>(0),
        )?;
        let mut events = Vec::new();
        for payload in rows {
            events.push(serde_json::from_str(&payload?)?);
        }
        Ok(events)
    }

    /// The single world row plus the last settled tick in its event log.
    pub fn world_summary(&self) -> Result<WorldSummary, StoreError> {
        let conn = self.conn()?;
        let (id, name, last_tick, official) = conn.query_row(
            "SELECT w.id, w.map_name, \
             COALESCE((SELECT MAX(tick) FROM events WHERE world_id = w.id), w.tick), w.official \
             FROM worlds w WHERE w.id = ?1",
            [WORLD_ID],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )?;
        Ok(WorldSummary {
            id: id as u64,
            name,
            last_tick: last_tick as Tick,
            official: official != 0,
        })
    }

    /// Highest event seq committed at `tick` (0 when none).
    pub fn last_seq_at(&self, tick: Tick) -> Result<u32, StoreError> {
        let seq: Option<i64> = self.conn()?.query_row(
            "SELECT MAX(seq) FROM events WHERE world_id = ?1 AND tick = ?2",
            params![WORLD_ID, tick as i64],
            |row| row.get(0),
        )?;
        Ok(seq.unwrap_or(0) as u32)
    }

    /// Events after a cursor: later ticks, plus same-tick events with a higher
    /// seq (joins appended after a snapshot).
    pub fn events_after(&self, tick: Tick, last_seq: u32) -> Result<Vec<Event>, StoreError> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT payload FROM events WHERE world_id = ?1 \
             AND (tick > ?2 OR (tick = ?2 AND seq > ?3)) \
             ORDER BY tick, seq",
        )?;
        let rows = stmt.query_map(params![WORLD_ID, tick as i64, last_seq as i64], |row| {
            row.get::<_, String>(0)
        })?;
        let mut events = Vec::new();
        for payload in rows {
            events.push(serde_json::from_str(&payload?)?);
        }
        Ok(events)
    }

    pub fn insert_agent(
        &self,
        id: AgentId,
        nick: &str,
        model: &str,
        intro: &str,
        token: &str,
    ) -> Result<(), StoreError> {
        self.conn()?.execute(
            "INSERT INTO agents(id, world_id, nick, model, intro, token, sent_by, why, created_at_ms, score_total) \
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, NULL, '', ?7, 0)",
            params![
                id as i64,
                WORLD_ID,
                nick,
                model,
                intro,
                token,
                now_ms() as i64
            ],
        )?;
        Ok(())
    }

    pub fn update_agent_entry(
        &self,
        id: AgentId,
        sent_by: Option<&str>,
        why: &str,
    ) -> Result<(), StoreError> {
        self.conn()?.execute(
            "UPDATE agents SET sent_by = ?1, why = ?2 WHERE id = ?3 AND world_id = ?4",
            params![sent_by, why, id as i64, WORLD_ID],
        )?;
        Ok(())
    }

    /// Overwrites the persisted cumulative score of one agent. The server keeps
    /// using its in-memory meta at join time, so tests reopen afterwards.
    pub fn set_agent_score(&self, id: AgentId, score: u32) -> Result<(), StoreError> {
        self.conn()?.execute(
            "UPDATE agents SET score_total = ?1 WHERE id = ?2 AND world_id = ?3",
            params![score as i64, id as i64, WORLD_ID],
        )?;
        Ok(())
    }

    pub fn agents(&self) -> Result<Vec<StoredAgent>, StoreError> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, nick, model, intro, COALESCE(token, ''), sent_by, why, score_total, user_id, \
             created_at_ms FROM agents WHERE world_id = ?1 ORDER BY id",
        )?;
        let rows = stmt.query_map([WORLD_ID], agent_from_row)?;
        let mut agents = Vec::new();
        for agent in rows {
            agents.push(agent?);
        }
        Ok(agents)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn record_command(
        &self,
        tick: Tick,
        agent: Option<AgentId>,
        command: &str,
        ok: bool,
        summary: &str,
        duration_ms: u64,
        intent: Option<&Value>,
    ) -> Result<(), StoreError> {
        self.conn()?.execute(
            "INSERT INTO commands(world_id, ts_ms, tick, agent, command, ok, summary, duration_ms, intent) \
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                WORLD_ID,
                now_ms() as i64,
                tick as i64,
                agent.map(|agent| agent as i64),
                command,
                i64::from(ok),
                summary,
                duration_ms as i64,
                intent.map(serde_json::to_string).transpose()?
            ],
        )?;
        Ok(())
    }

    /// Actions submitted at `tick` that have not settled yet. A later command
    /// from the same agent replaces the earlier one, as it did in memory.
    pub fn pending_intents(&self, tick: Tick) -> Result<Vec<(AgentId, IntentKind)>, StoreError> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT agent, intent FROM commands WHERE world_id = ?1 AND tick = ?2 \
             AND intent IS NOT NULL ORDER BY id",
        )?;
        let rows = stmt.query_map(params![WORLD_ID, tick as i64], |row| {
            Ok((row.get::<_, i64>(0)? as AgentId, row.get::<_, String>(1)?))
        })?;
        let mut by_agent = std::collections::BTreeMap::new();
        for row in rows {
            let (agent, intent) = row?;
            by_agent.insert(agent, serde_json::from_str(&intent)?);
        }
        Ok(by_agent.into_iter().collect())
    }

    // --- accounts and tokens (contract §1) ---

    /// Inserts an account. The unique username index is the authority: a
    /// concurrent double registration becomes `StoreError::Conflict`.
    pub fn create_user(&self, username: &str, password_hash: &str) -> Result<u64, StoreError> {
        let conn = self.conn()?;
        match conn.execute(
            "INSERT INTO users(username, password_hash, created_at_ms) VALUES(?1, ?2, ?3)",
            params![username, password_hash, now_ms() as i64],
        ) {
            Ok(_) => Ok(conn.last_insert_rowid() as u64),
            Err(error) if is_unique_violation(&error) => Err(StoreError::Conflict(format!(
                "username {username:?} is already taken"
            ))),
            Err(error) => Err(StoreError::Sqlite(error)),
        }
    }

    /// `(id, password_hash)` for a username.
    pub fn user_by_username(&self, username: &str) -> Result<Option<(u64, String)>, StoreError> {
        Ok(self
            .conn()?
            .query_row(
                "SELECT id, password_hash FROM users WHERE username = ?1",
                [username],
                |row| Ok((row.get::<_, i64>(0)? as u64, row.get::<_, String>(1)?)),
            )
            .optional()?)
    }

    pub fn username_of(&self, user_id: u64) -> Result<Option<String>, StoreError> {
        Ok(self
            .conn()?
            .query_row(
                "SELECT username FROM users WHERE id = ?1",
                [user_id as i64],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// Stores `sha256(token)` and returns the creation time.
    pub fn auth_token_insert(&self, user_id: u64, token_hash: &str) -> Result<u64, StoreError> {
        let created_at_ms = now_ms();
        self.conn()?.execute(
            "INSERT INTO auth_tokens(user_id, token_hash, created_at_ms, revoked_at_ms) \
             VALUES(?1, ?2, ?3, NULL)",
            params![user_id as i64, token_hash, created_at_ms as i64],
        )?;
        Ok(created_at_ms)
    }

    /// Revokes every active token of the account; returns how many were live.
    pub fn auth_token_revoke_all(&self, user_id: u64) -> Result<usize, StoreError> {
        Ok(self.conn()?.execute(
            "UPDATE auth_tokens SET revoked_at_ms = ?1 \
             WHERE user_id = ?2 AND revoked_at_ms IS NULL",
            params![now_ms() as i64, user_id as i64],
        )?)
    }

    pub fn auth_token_lookup(&self, token_hash: &str) -> Result<Option<u64>, StoreError> {
        Ok(self
            .conn()?
            .query_row(
                "SELECT user_id FROM auth_tokens WHERE token_hash = ?1 AND revoked_at_ms IS NULL",
                [token_hash],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .map(|id| id as u64))
    }

    /// Account-level token state. `active` is about any live token; the two
    /// timestamps describe the newest token ever issued.
    pub fn auth_token_info(&self, user_id: u64) -> Result<AccountTokenInfo, StoreError> {
        let conn = self.conn()?;
        let newest: Option<(i64, Option<i64>)> = conn
            .query_row(
                "SELECT created_at_ms, revoked_at_ms FROM auth_tokens \
                 WHERE user_id = ?1 ORDER BY id DESC LIMIT 1",
                [user_id as i64],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let active: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM auth_tokens \
             WHERE user_id = ?1 AND revoked_at_ms IS NULL)",
            [user_id as i64],
            |row| row.get(0),
        )?;
        let (created_at_ms, revoked_at_ms) = match newest {
            Some((created, revoked)) => (Some(created as u64), revoked.map(|at| at as u64)),
            None => (None, None),
        };
        Ok(AccountTokenInfo {
            created_at_ms,
            revoked_at_ms,
            active,
        })
    }

    pub fn web_session_insert(&self, token_hash: &str, user_id: u64) -> Result<(), StoreError> {
        self.conn()?.execute(
            "INSERT OR REPLACE INTO web_sessions(token_hash, user_id, created_at_ms) \
             VALUES(?1, ?2, ?3)",
            params![token_hash, user_id as i64, now_ms() as i64],
        )?;
        Ok(())
    }

    pub fn web_session_lookup(&self, token_hash: &str) -> Result<Option<u64>, StoreError> {
        Ok(self
            .conn()?
            .query_row(
                "SELECT user_id FROM web_sessions WHERE token_hash = ?1",
                [token_hash],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .map(|id| id as u64))
    }

    pub fn web_session_delete(&self, token_hash: &str) -> Result<(), StoreError> {
        self.conn()?.execute(
            "DELETE FROM web_sessions WHERE token_hash = ?1",
            [token_hash],
        )?;
        Ok(())
    }

    pub fn agents_of_user(&self, user_id: u64) -> Result<Vec<StoredAgent>, StoreError> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, nick, model, intro, COALESCE(token, ''), sent_by, why, score_total, user_id, \
             created_at_ms FROM agents WHERE world_id = ?1 AND user_id = ?2 ORDER BY id",
        )?;
        let rows = stmt.query_map(params![WORLD_ID, user_id as i64], agent_from_row)?;
        let mut agents = Vec::new();
        for agent in rows {
            agents.push(agent?);
        }
        Ok(agents)
    }

    pub fn agent_owner(&self, agent_id: AgentId) -> Result<Option<u64>, StoreError> {
        Ok(self
            .conn()?
            .query_row(
                "SELECT user_id FROM agents WHERE id = ?1 AND world_id = ?2",
                params![agent_id as i64, WORLD_ID],
                |row| row.get::<_, Option<i64>>(0),
            )
            .optional()?
            .flatten()
            .map(|id| id as u64))
    }

    /// `(agent_id, user_id)` for a nickname; dev agents have no owner.
    pub fn agent_by_nick(&self, nick: &str) -> Result<Option<(AgentId, Option<u64>)>, StoreError> {
        Ok(self
            .conn()?
            .query_row(
                "SELECT id, user_id FROM agents WHERE nick = ?1 AND world_id = ?2",
                params![nick, WORLD_ID],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)? as AgentId,
                        row.get::<_, Option<i64>>(1)?.map(|id| id as u64),
                    ))
                },
            )
            .optional()?)
    }

    /// Creates an account agent and returns its id.
    pub fn create_account_agent(
        &self,
        user_id: u64,
        nick: &str,
        model: &str,
        intro: &str,
    ) -> Result<AgentId, StoreError> {
        let conn = self.conn()?;
        let next: i64 = conn.query_row(
            "SELECT COALESCE(MAX(id), 0) + 1 FROM agents WHERE world_id = ?1",
            [WORLD_ID],
            |row| row.get(0),
        )?;
        conn.execute(
            "INSERT INTO agents(id, world_id, nick, model, intro, token, sent_by, why, \
             created_at_ms, score_total, user_id) \
             VALUES(?1, ?2, ?3, ?4, ?5, NULL, NULL, '', ?6, 0, ?7)",
            params![
                next,
                WORLD_ID,
                nick,
                model,
                intro,
                now_ms() as i64,
                user_id as i64
            ],
        )?;
        Ok(next as AgentId)
    }

    /// Updates the account's own agent with this nickname; `None` when the
    /// nickname is not theirs.
    pub fn update_account_agent(
        &self,
        user_id: u64,
        nick: &str,
        model: &str,
        intro: &str,
    ) -> Result<Option<AgentId>, StoreError> {
        let conn = self.conn()?;
        let changed = conn.execute(
            "UPDATE agents SET model = ?1, intro = ?2 \
             WHERE nick = ?3 AND user_id = ?4 AND world_id = ?5",
            params![model, intro, nick, user_id as i64, WORLD_ID],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        Ok(conn
            .query_row(
                "SELECT id FROM agents WHERE nick = ?1 AND world_id = ?2",
                params![nick, WORLD_ID],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .map(|id| id as AgentId))
    }

    /// Records the mode this world was created in; only official worlds feed
    /// the public leaderboard and stats.
    pub fn mark_world_official(&self) -> Result<(), StoreError> {
        self.conn()?
            .execute("UPDATE worlds SET official = 1 WHERE id = ?1", [WORLD_ID])?;
        Ok(())
    }

    pub fn is_official(&self) -> Result<bool, StoreError> {
        Ok(self.conn()?.query_row(
            "SELECT official FROM worlds WHERE id = ?1",
            [WORLD_ID],
            |row| row.get::<_, i64>(0),
        )? != 0)
    }
}

/// Maps the ten selected agent columns to a `StoredAgent`.
fn agent_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredAgent> {
    Ok(StoredAgent {
        id: row.get::<_, i64>(0)? as AgentId,
        nick: row.get(1)?,
        model: row.get(2)?,
        intro: row.get(3)?,
        token: row.get(4)?,
        sent_by: row.get(5)?,
        why: row.get(6)?,
        score_total: row.get::<_, i64>(7)? as u32,
        user_id: row.get::<_, Option<i64>>(8)?.map(|id| id as u64),
        created_at_ms: row.get::<_, i64>(9)? as u64,
    })
}

fn is_unique_violation(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(inner, _)
            if inner.code == rusqlite::ErrorCode::ConstraintViolation
    )
}

/// Brings `agents` up to the account schema: `user_id` added, `token` made
/// nullable, `score_total` added, and a unique nickname index. A table that
/// already has the shape is left alone.
///
/// Old databases can hold duplicate nicknames; the unique index cannot be built
/// then, and silently dropping rows would lose identities, so that case is
/// reported as `StoreError::Corrupt` naming the duplicates.
fn migrate_agents(conn: &Connection) -> Result<(), StoreError> {
    let columns = table_columns(conn, "agents")?;
    let has = |name: &str| columns.iter().any(|column| column.name == name);
    let has_score_total = has("score_total");
    let has_user_id = has("user_id");
    let token_nullable = columns
        .iter()
        .find(|column| column.name == "token")
        .is_some_and(|column| !column.not_null);
    if has_user_id && token_nullable {
        if !has_score_total {
            add_column(conn, "agents", "score_total INTEGER NOT NULL DEFAULT 0")?;
        }
        ensure_nick_index(conn)?;
        return Ok(());
    }

    let duplicates = duplicate_nicks(conn)?;
    if !duplicates.is_empty() {
        return Err(StoreError::Corrupt(format!(
            "agents has duplicate nicknames {:?}; the account schema needs unique nicknames, \
             so the table was left untouched — rename the duplicates and open again",
            duplicates
        )));
    }

    let score_expr = if has_score_total { "score_total" } else { "0" };
    // SQLite cannot drop a NOT NULL constraint or add a column in front of an
    // existing one, so the table is rebuilt and every row copied.
    conn.execute_batch(&format!(
        "\
BEGIN IMMEDIATE;
CREATE TABLE agents_rebuild(
    id INTEGER PRIMARY KEY,
    world_id INTEGER NOT NULL,
    nick TEXT NOT NULL,
    model TEXT NOT NULL,
    intro TEXT NOT NULL,
    token TEXT UNIQUE,
    sent_by TEXT,
    why TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    score_total INTEGER NOT NULL DEFAULT 0,
    user_id INTEGER
);
INSERT INTO agents_rebuild(id, world_id, nick, model, intro, token, sent_by, why, created_at_ms, score_total, user_id)
SELECT id, world_id, nick, model, intro, token, sent_by, why, created_at_ms, {score_expr}, NULL FROM agents;
DROP TABLE agents;
ALTER TABLE agents_rebuild RENAME TO agents;
COMMIT;
"
    ))?;
    ensure_nick_index(conn)?;
    Ok(())
}

fn migrate_worlds_official(conn: &Connection) -> Result<(), StoreError> {
    let columns = table_columns(conn, "worlds")?;
    if !columns.iter().any(|column| column.name == "official") {
        add_column(conn, "worlds", "official INTEGER NOT NULL DEFAULT 0")?;
    }
    Ok(())
}

fn add_column(conn: &Connection, table: &str, definition: &str) -> Result<(), StoreError> {
    conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {definition}"))?;
    Ok(())
}

fn table_columns(conn: &Connection, table: &str) -> Result<Vec<ColumnInfo>, StoreError> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = stmt.query_map([], |row| {
        Ok(ColumnInfo {
            name: row.get(1)?,
            not_null: row.get::<_, i64>(3)? != 0,
        })
    })?;
    let mut columns = Vec::new();
    for column in rows {
        columns.push(column?);
    }
    Ok(columns)
}

struct ColumnInfo {
    name: String,
    not_null: bool,
}

fn duplicate_nicks(conn: &Connection) -> Result<Vec<String>, StoreError> {
    let mut stmt = conn.prepare(
        "SELECT nick FROM agents GROUP BY nick HAVING COUNT(*) > 1 ORDER BY nick LIMIT 10",
    )?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    let mut nicks = Vec::new();
    for nick in rows {
        nicks.push(nick?);
    }
    Ok(nicks)
}

fn ensure_nick_index(conn: &Connection) -> Result<(), StoreError> {
    match conn.execute_batch("CREATE UNIQUE INDEX IF NOT EXISTS agents_nick ON agents(nick)") {
        Ok(()) => Ok(()),
        Err(error) => Err(StoreError::Corrupt(format!(
            "cannot enforce unique nicknames on agents: {error}"
        ))),
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
