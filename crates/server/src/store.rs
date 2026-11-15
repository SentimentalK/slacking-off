//! SQLite persistence (design §8): the world row, the event log, snapshots, the
//! command log and the agents registered against this world.
//!
//! The event log is the source of truth; snapshots only shorten recovery. Every
//! tick's events and the world's tick counter are written in one transaction, so
//! a crash never leaves a tick half-recorded.

use loo_core::{Event, EventKind, IntentKind, Snapshot, WorldState};
use loo_proto::{
    AccountTokenInfo, AgentId, EventTag, KindStats, LeaderRow, ModelStats, Need, PlayerKind,
    ProfileResponse, ScopeStats, SentBy, SessionId, SessionOutcome, SessionRow, StatsResponse,
    Tick, TimelineMarker, TimelineSpan, WorldSummary,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::projection::event_tag;

/// This server keeps a single world per database file.
pub(crate) const WORLD_ID: i64 = 1;

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
    created_at_ms INTEGER NOT NULL,
    prompt_enabled INTEGER NOT NULL DEFAULT 0
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
CREATE TABLE IF NOT EXISTS sessions(
  id INTEGER PRIMARY KEY, world_id INTEGER NOT NULL, agent INTEGER NOT NULL,
  started_tick INTEGER NOT NULL, ended_tick INTEGER, outcome TEXT,
  score INTEGER NOT NULL DEFAULT 0, need TEXT, sent_by TEXT, why TEXT NOT NULL DEFAULT '',
  moved INTEGER NOT NULL DEFAULT 0, built INTEGER NOT NULL DEFAULT 0,
  hits_taken INTEGER NOT NULL DEFAULT 0, defends INTEGER NOT NULL DEFAULT 0
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
    /// `Ai` for every CLI registration; `Human` for the account's one browser
    /// character.
    pub kind: PlayerKind,
    /// Explicit colour `0..=11`; `None` means `id % 12`.
    pub color: Option<u8>,
}

/// `GET /api/stats?prompt=` — narrow the stats to accounts whose install did
/// (`On`) or did not (`Off`) add the loo line to an agent instruction file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PromptFilter {
    Any,
    On,
    Off,
}

impl PromptFilter {
    /// The SQL predicate value: `None` for `Any`, `1`/`0` for the two halves.
    fn as_flag(self) -> Option<i64> {
        match self {
            PromptFilter::Any => None,
            PromptFilter::On => Some(1),
            PromptFilter::Off => Some(0),
        }
    }
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
        migrate_play_kind(&conn)?;
        migrate_worlds_official(&conn)?;
        migrate_users_prompt(&conn)?;

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
             created_at_ms, kind, color FROM agents WHERE world_id = ?1 ORDER BY id",
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

    /// Records whether this account's install added the loo line to an agent
    /// instruction file. An unknown account is an error, never a silent no-op.
    pub fn set_prompt_enabled(&self, user_id: u64, enabled: bool) -> Result<bool, StoreError> {
        let updated = self.conn()?.execute(
            "UPDATE users SET prompt_enabled = ?1 WHERE id = ?2",
            params![i64::from(enabled), user_id as i64],
        )?;
        if updated == 0 {
            return Err(StoreError::Conflict(format!(
                "account {user_id} does not exist"
            )));
        }
        Ok(enabled)
    }

    /// `prompt_enabled` for an account; an unknown account is an error.
    pub fn prompt_enabled(&self, user_id: u64) -> Result<bool, StoreError> {
        self.conn()?
            .query_row(
                "SELECT prompt_enabled FROM users WHERE id = ?1",
                [user_id as i64],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .map(|value| value != 0)
            .ok_or_else(|| StoreError::Conflict(format!("account {user_id} does not exist")))
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
             created_at_ms, kind, color FROM agents WHERE world_id = ?1 AND user_id = ?2 ORDER BY id",
        )?;
        let rows = stmt.query_map(params![WORLD_ID, user_id as i64], agent_from_row)?;
        let mut agents = Vec::new();
        for agent in rows {
            agents.push(agent?);
        }
        Ok(agents)
    }

    pub fn human_agent_of_user(&self, user_id: u64) -> Result<Option<StoredAgent>, StoreError> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, nick, model, intro, COALESCE(token, ''), sent_by, why, score_total, user_id, \
             created_at_ms, kind, color FROM agents \
             WHERE world_id = ?1 AND user_id = ?2 AND kind = 'human' ORDER BY id LIMIT 1",
        )?;
        let mut rows = stmt.query_map(params![WORLD_ID, user_id as i64], agent_from_row)?;
        match rows.next() {
            Some(agent) => Ok(Some(agent?)),
            None => Ok(None),
        }
    }

    /// The player kind of an agent; `None` when the id is unknown.
    pub fn agent_kind(&self, agent_id: AgentId) -> Result<Option<PlayerKind>, StoreError> {
        let kind: Option<String> = self
            .conn()?
            .query_row(
                "SELECT kind FROM agents WHERE id = ?1 AND world_id = ?2",
                params![agent_id as i64, WORLD_ID],
                |row| row.get(0),
            )
            .optional()?;
        kind.map(|name| player_kind_from_name(&name)).transpose()
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

    /// Creates the account's one browser character. `model`/`intro` stay
    /// empty: a person types no self-description. The partial unique index is
    /// the authority on "one per account".
    pub fn create_human_agent(
        &self,
        user_id: u64,
        nick: &str,
        color: Option<u8>,
    ) -> Result<AgentId, StoreError> {
        let conn = self.conn()?;
        let next: i64 = conn.query_row(
            "SELECT COALESCE(MAX(id), 0) + 1 FROM agents WHERE world_id = ?1",
            [WORLD_ID],
            |row| row.get(0),
        )?;
        conn.execute(
            "INSERT INTO agents(id, world_id, nick, model, intro, token, sent_by, why, \
             created_at_ms, score_total, user_id, kind, color) \
             VALUES(?1, ?2, ?3, '', '', NULL, NULL, '', ?4, 0, ?5, 'human', ?6)",
            params![
                next,
                WORLD_ID,
                nick,
                now_ms() as i64,
                user_id as i64,
                color.map(i64::from)
            ],
        )
        .map_err(|error| {
            if is_unique_violation(&error) {
                StoreError::Conflict("this account already has a human character".to_string())
            } else {
                StoreError::Sqlite(error)
            }
        })?;
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

    /// Records a join. `need` is written when the session got one immediately;
    /// queued sessions get it through [`Store::set_session_need`] later.
    #[allow(clippy::too_many_arguments)]
    pub fn insert_session(
        &self,
        id: SessionId,
        world_id: u64,
        agent: AgentId,
        started_tick: Tick,
        need: Option<Need>,
        sent_by: Option<SentBy>,
        why: &str,
    ) -> Result<(), StoreError> {
        self.conn()?.execute(
            "INSERT INTO sessions(id, world_id, agent, started_tick, need, sent_by, why) \
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id as i64,
                world_id as i64,
                agent as i64,
                started_tick as i64,
                need.map(need_name),
                sent_by.map(SentBy::as_str),
                why
            ],
        )?;
        Ok(())
    }

    /// Highest session id persisted so a restart never reuses one.
    pub fn max_session_id(&self) -> Result<Option<SessionId>, StoreError> {
        let id: Option<i64> =
            self.conn()?
                .query_row("SELECT MAX(id) FROM sessions", [], |row| row.get(0))?;
        Ok(id.map(|id| id as SessionId))
    }

    pub fn set_session_need(&self, session: SessionId, need: Need) -> Result<(), StoreError> {
        self.conn()?.execute(
            "UPDATE sessions SET need = ?1 WHERE id = ?2",
            params![need_name(need), session as i64],
        )?;
        Ok(())
    }

    /// Adds one settled tick's counters in a single statement.
    pub fn bump_session(
        &self,
        session: SessionId,
        moved: u32,
        built: u32,
        hits_taken: u32,
        defends: u32,
    ) -> Result<(), StoreError> {
        self.conn()?.execute(
            "UPDATE sessions SET moved = moved + ?1, built = built + ?2, \
             hits_taken = hits_taken + ?3, defends = defends + ?4 WHERE id = ?5",
            params![
                moved as i64,
                built as i64,
                hits_taken as i64,
                defends as i64,
                session as i64
            ],
        )?;
        Ok(())
    }

    pub fn finish_session(
        &self,
        session: SessionId,
        ended_tick: Tick,
        outcome: SessionOutcome,
        score: u32,
    ) -> Result<(), StoreError> {
        let conn = self.conn()?;
        conn.execute(
            "UPDATE sessions SET ended_tick = ?1, outcome = ?2, score = ?3 WHERE id = ?4",
            params![
                ended_tick as i64,
                outcome_name(outcome),
                score as i64,
                session as i64
            ],
        )?;
        // Contract §2: mark the session when another player kind shared the
        // world while it was running. Plain overlap, not weighted by headcount.
        conn.execute(
            "UPDATE sessions SET with_other_kind = CASE WHEN EXISTS ( \
                 SELECT 1 FROM sessions o \
                 JOIN agents oa ON oa.id = o.agent AND oa.world_id = o.world_id \
                 JOIN agents a ON a.id = sessions.agent AND a.world_id = sessions.world_id \
                 WHERE o.world_id = sessions.world_id AND o.id <> sessions.id \
                   AND oa.kind <> a.kind \
                   AND o.started_tick <= sessions.ended_tick \
                   AND (o.ended_tick IS NULL OR o.ended_tick >= sessions.started_tick) \
             ) THEN 1 ELSE 0 END WHERE id = ?1",
            params![session as i64],
        )?;
        Ok(())
    }

    /// Only official worlds with account-owned agents feed the boards. `kind`
    /// is `ai`, `human` or `mixed`; the lib layer rejects anything else.
    pub fn leaderboard(
        &self,
        metric: &str,
        kind: &str,
        model: Option<&str>,
        limit: usize,
    ) -> Result<Vec<LeaderRow>, StoreError> {
        let order = match metric {
            "best" => "best_score DESC, a.id ASC",
            "successes" => "successes DESC, a.id ASC",
            _ => "a.score_total DESC, a.id ASC",
        };
        let sql = format!(
            "SELECT a.id, a.nick, COALESCE(u.username, ''), a.model, a.kind, a.score_total, \
             COALESCE(MAX(s.score), 0) AS best_score, \
             COALESCE(SUM(CASE WHEN s.outcome = 'success' THEN 1 ELSE 0 END), 0) AS successes \
             FROM agents a \
             JOIN worlds w ON w.id = a.world_id AND w.official = 1 \
             LEFT JOIN users u ON u.id = a.user_id \
             LEFT JOIN sessions s ON s.agent = a.id AND s.world_id = a.world_id \
             WHERE a.user_id IS NOT NULL AND (?1 IS NULL OR a.model = ?1) \
               AND (?2 = 'mixed' OR a.kind = ?2) \
             GROUP BY a.id, a.nick, u.username, a.model, a.kind, a.score_total \
             ORDER BY {order} LIMIT ?3"
        );
        let conn = self.conn()?;
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![model, kind, limit as i64], |row| {
            let kind: String = row.get(4)?;
            Ok((
                row.get::<_, i64>(0)? as AgentId,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                kind,
                row.get::<_, i64>(5)? as u32,
                row.get::<_, i64>(6)? as u32,
                row.get::<_, i64>(7)? as u32,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (agent_id, nick, owner, model, kind, score_total, best_score, successes) = row?;
            out.push(LeaderRow {
                rank: out.len() + 1,
                agent_id,
                nick,
                owner,
                model,
                kind: player_kind_from_name(&kind)?,
                score_total,
                best_score,
                successes,
            });
        }
        Ok(out)
    }

    /// Two ranges (`all`, `mixed`) split by player kind, then the AI-only model
    /// table. A session can be in both ranges, so the range is a join row, not
    /// a partition. `prompt` narrows every number to accounts that did (or did
    /// not) install the loo line in their agent instructions.
    pub fn stats(&self, prompt: PromptFilter) -> Result<StatsResponse, StoreError> {
        // `None` is `any`; the SQL keeps the parameter shape identical.
        let prompt: Option<i64> = prompt.as_flag();
        let conn = self.conn()?;
        let mut scopes = [ScopeStats::default(); 2];
        let mut ended = [0u64; 2];
        {
            let mut stmt = conn.prepare(
                "SELECT r.mixed, a.kind, COUNT(DISTINCT a.id), COUNT(s.id), \
                 COALESCE(SUM(CASE WHEN s.outcome = 'success' THEN 1 ELSE 0 END), 0), \
                 COALESCE(SUM(CASE WHEN s.outcome IS NOT NULL THEN 1 ELSE 0 END), 0), \
                 COALESCE(SUM(s.score), 0), COALESCE(MAX(s.score), 0) \
                 FROM (SELECT 0 AS mixed UNION ALL SELECT 1) r \
                 JOIN sessions s ON r.mixed = 0 OR s.with_other_kind = 1 \
                 JOIN agents a ON a.id = s.agent AND a.world_id = s.world_id \
                 JOIN worlds w ON w.id = s.world_id AND w.official = 1 \
                 JOIN users u ON u.id = a.user_id \
                 WHERE a.user_id IS NOT NULL \
                   AND (?1 IS NULL OR u.prompt_enabled = ?1) \
                 GROUP BY r.mixed, a.kind",
            )?;
            let rows = stmt.query_map(params![prompt], |row| {
                Ok((
                    row.get::<_, i64>(0)? != 0,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                ))
            })?;
            for row in rows {
                let (mixed, kind, agents, sessions, successes, ended_rows, total, best) = row?;
                let index = usize::from(mixed);
                let stats = match player_kind_from_name(&kind)? {
                    PlayerKind::Ai => &mut scopes[index].ai,
                    PlayerKind::Human => &mut scopes[index].human,
                };
                *stats = KindStats {
                    agents: agents as u64,
                    sessions: sessions as u64,
                    successes: successes as u64,
                    success_rate: rate(successes as u64, ended_rows as u64),
                    total_score: total as u64,
                    best_score: best as u32,
                };
                ended[index] += ended_rows as u64;
            }
        }
        for (index, scope) in scopes.iter_mut().enumerate() {
            scope.total_sessions = scope.ai.sessions + scope.human.sessions;
            scope.success_rate = rate(scope.ai.successes + scope.human.successes, ended[index]);
        }

        #[derive(Default)]
        struct ModelAcc {
            agents: u64,
            sessions: u64,
            successes: u64,
            ended: u64,
            total_score: u64,
        }
        let mut models: BTreeMap<String, ModelAcc> = BTreeMap::new();
        {
            let mut stmt = conn.prepare(
                "SELECT a.model, COUNT(*), COALESCE(SUM(a.score_total), 0) \
                 FROM agents a JOIN worlds w ON w.id = a.world_id AND w.official = 1 \
                 JOIN users u ON u.id = a.user_id \
                 WHERE a.user_id IS NOT NULL AND a.kind = 'ai' \
                   AND (?1 IS NULL OR u.prompt_enabled = ?1) GROUP BY a.model",
            )?;
            let rows = stmt.query_map(params![prompt], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?;
            for row in rows {
                let (model, agents, total_score) = row?;
                let acc = models.entry(model).or_default();
                acc.agents = agents as u64;
                acc.total_score = total_score as u64;
            }
        }
        {
            let mut stmt = conn.prepare(
                "SELECT a.model, COUNT(s.id), \
                 COALESCE(SUM(CASE WHEN s.outcome = 'success' THEN 1 ELSE 0 END), 0), \
                 COALESCE(SUM(CASE WHEN s.outcome IS NOT NULL THEN 1 ELSE 0 END), 0) \
                 FROM sessions s \
                 JOIN agents a ON a.id = s.agent AND a.world_id = s.world_id \
                 JOIN worlds w ON w.id = s.world_id AND w.official = 1 \
                 JOIN users u ON u.id = a.user_id \
                 WHERE a.user_id IS NOT NULL AND a.kind = 'ai' \
                   AND (?1 IS NULL OR u.prompt_enabled = ?1) GROUP BY a.model",
            )?;
            let rows = stmt.query_map(params![prompt], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })?;
            for row in rows {
                let (model, sessions, successes, ended_rows) = row?;
                let acc = models.entry(model).or_default();
                acc.sessions = sessions as u64;
                acc.successes = successes as u64;
                acc.ended = ended_rows as u64;
            }
        }
        let mut model_stats: Vec<ModelStats> = models
            .into_iter()
            .map(|(model, acc)| ModelStats {
                model,
                agents: acc.agents,
                sessions: acc.sessions,
                successes: acc.successes,
                success_rate: rate(acc.successes, acc.ended),
                total_score: acc.total_score,
            })
            .collect();
        model_stats.sort_by(|a, b| {
            b.total_score
                .cmp(&a.total_score)
                .then_with(|| a.model.cmp(&b.model))
        });

        Ok(StatsResponse {
            all: scopes[0],
            mixed: scopes[1],
            models: model_stats,
        })
    }

    /// Any agent is queryable; dev agents have an empty owner. `why`/`intro`/
    /// `model` are web-only and never enter the projection.
    pub fn profile(&self, agent_id: AgentId) -> Result<Option<ProfileResponse>, StoreError> {
        let conn = self.conn()?;
        let agent: Option<(String, String, String, String, i64, String)> = conn
            .query_row(
                "SELECT a.nick, COALESCE(u.username, ''), a.model, a.intro, a.score_total, a.kind \
                 FROM agents a LEFT JOIN users u ON u.id = a.user_id \
                 WHERE a.id = ?1 AND a.world_id = ?2",
                params![agent_id as i64, WORLD_ID],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .optional()?;
        let Some((nick, owner, model, intro, score_total, kind)) = agent else {
            return Ok(None);
        };
        let kind = player_kind_from_name(&kind)?;

        let mut stmt = conn.prepare(
            "SELECT id, world_id, started_tick, ended_tick, outcome, score, need, sent_by, \
             why, moved, built, hits_taken, defends, with_other_kind FROM sessions \
             WHERE agent = ?1 ORDER BY started_tick DESC, id DESC",
        )?;
        let rows = stmt.query_map([agent_id as i64], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, i64>(9)?,
                row.get::<_, i64>(10)?,
                row.get::<_, i64>(11)?,
                row.get::<_, i64>(12)?,
                row.get::<_, i64>(13)?,
            ))
        })?;
        let mut sessions = Vec::new();
        let (mut successes, mut self_sessions, mut human_sessions, mut ended) =
            (0u32, 0u32, 0u32, 0u32);
        for row in rows {
            let (
                id,
                world,
                started_tick,
                ended_tick,
                outcome,
                score,
                need,
                sent_by,
                why,
                moved,
                built,
                hits_taken,
                defends,
                with_other_kind,
            ) = row?;
            let outcome = outcome.map(|name| outcome_from_name(&name)).transpose()?;
            let need = need.map(|name| need_from_name(&name)).transpose()?;
            let sent_by = sent_by.map(|name| sent_by_from_name(&name)).transpose()?;
            if outcome == Some(SessionOutcome::Success) {
                successes += 1;
            }
            if outcome.is_some() {
                ended += 1;
            }
            match sent_by {
                Some(SentBy::Self_) => self_sessions += 1,
                Some(SentBy::Human) => human_sessions += 1,
                None => {}
            }
            sessions.push(SessionRow {
                session_id: id as SessionId,
                world: world as u64,
                started_tick: started_tick as Tick,
                ended_tick: ended_tick.map(|tick| tick as Tick),
                outcome,
                score: score as u32,
                need,
                sent_by,
                why,
                moved: moved as u32,
                built: built as u32,
                hits_taken: hits_taken as u32,
                defends: defends as u32,
                with_other_kind: with_other_kind != 0,
            });
        }
        let visits = sessions.len() as u32;
        let score_total = score_total as u32;
        Ok(Some(ProfileResponse {
            agent_id,
            nick,
            owner,
            model,
            intro,
            kind,
            score_total,
            level: loo_core::agent_level(score_total, &loo_core::Config::default()),
            visits,
            successes,
            success_rate: rate(u64::from(successes), u64::from(ended)),
            self_sessions,
            human_sessions,
            sessions,
        }))
    }

    /// `success`/`attack`/`demolish`/`defend` markers in `[from, to]`, ascending,
    /// capped at 5000.
    pub fn timeline_markers(
        &self,
        from: Tick,
        to: Tick,
    ) -> Result<Vec<TimelineMarker>, StoreError> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT payload FROM events WHERE world_id = ?1 AND tick >= ?2 AND tick <= ?3 \
             AND kind IN ('UseSucceeded', 'AttackStarted', 'AttackLanded', 'AttackMissed', \
             'AttackBlocked', 'AttackCancelled', 'DefendStarted', 'DefendEnded', \
             'DemolishBlocked', 'ObjectChanged', 'ActionStarted', 'ActionFinished', \
             'ActionReplaced') ORDER BY tick, seq",
        )?;
        let rows = stmt.query_map(params![WORLD_ID, from as i64, to as i64], |row| {
            row.get::<_, String>(0)
        })?;
        let mut markers = Vec::new();
        for payload in rows {
            let event: Event = serde_json::from_str(&payload?)?;
            let kind = event_tag(&event);
            if matches!(
                kind,
                EventTag::Success | EventTag::Attack | EventTag::Demolish | EventTag::Defend
            ) {
                markers.push(TimelineMarker {
                    tick: event.tick,
                    kind,
                    text: event.text(),
                });
                if markers.len() == 5000 {
                    break;
                }
            }
        }
        Ok(markers)
    }

    /// Replayable spans of `[from, to]`, consistent with
    /// [`crate::Server::projection_at`]: a tick replays at least one session
    /// when, after it settles, at least one session stands in the world.
    ///
    /// The tick a session joins counts, including the queue: a queued player is
    /// still a body on the map, so its stretch starts at `Joined` and
    /// `EnteredWorld` only keeps that start. The tick a session ends does not
    /// count, so a session that joins at `t` and ends at `e > t` covers
    /// `[t, e - 1]`. A session still present after `current_tick` covers
    /// `[start, max(start, current_tick)]`. Spans
    /// are trimmed to `[from, to]`, sorted ascending, and merged when they
    /// overlap or touch.
    pub fn timeline_spans(
        &self,
        from: Tick,
        to: Tick,
        current_tick: Tick,
    ) -> Result<Vec<TimelineSpan>, StoreError> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT payload FROM events WHERE world_id = ?1 \
             AND kind IN ('Joined', 'EnteredWorld', 'SessionEnded') ORDER BY tick, seq",
        )?;
        let rows = stmt.query_map([WORLD_ID], |row| row.get::<_, String>(0))?;
        let mut starts: BTreeMap<SessionId, Tick> = BTreeMap::new();
        let mut spans = Vec::new();
        for payload in rows {
            let event: Event = serde_json::from_str(&payload?)?;
            match &event.kind {
                // Both an immediate entry and a queued join put a body on the
                // map, so the replayable stretch begins at the join tick.
                EventKind::Joined { session, .. } => {
                    starts.entry(*session).or_insert(event.tick);
                }
                // Entering from the queue must not move the start forward: the
                // queue ticks were already replayable.
                EventKind::EnteredWorld { session, .. } => {
                    starts.entry(*session).or_insert(event.tick);
                }
                EventKind::SessionEnded { session, .. } => {
                    if let Some(start) = starts.remove(session) {
                        if event.tick > start {
                            spans.push(TimelineSpan {
                                from: start,
                                to: event.tick - 1,
                            });
                        }
                    }
                }
                _ => {}
            }
        }
        // `starts` maps a session to the tick it entered: the values are the
        // start ticks, the keys are only session ids.
        for start in starts.into_values() {
            spans.push(TimelineSpan {
                from: start,
                to: start.max(current_tick),
            });
        }

        let mut clipped: Vec<TimelineSpan> = spans
            .into_iter()
            .filter_map(|span| {
                let start = span.from.max(from);
                let end = span.to.min(to);
                (start <= end).then_some(TimelineSpan {
                    from: start,
                    to: end,
                })
            })
            .collect();
        clipped.sort_by_key(|span| span.from);
        let mut merged: Vec<TimelineSpan> = Vec::with_capacity(clipped.len());
        for span in clipped {
            match merged.last_mut() {
                Some(last) if span.from <= last.to.saturating_add(1) => {
                    last.to = last.to.max(span.to);
                }
                _ => merged.push(span),
            }
        }
        Ok(merged)
    }

    pub fn is_official(&self) -> Result<bool, StoreError> {
        Ok(self.conn()?.query_row(
            "SELECT official FROM worlds WHERE id = ?1",
            [WORLD_ID],
            |row| row.get::<_, i64>(0),
        )? != 0)
    }
}

fn rate(successes: u64, ended: u64) -> f64 {
    if ended == 0 {
        0.0
    } else {
        successes as f64 / ended as f64
    }
}

fn need_name(need: Need) -> &'static str {
    match need {
        Need::Urine => "urine",
        Need::Feces => "feces",
    }
}

fn need_from_name(name: &str) -> Result<Need, StoreError> {
    match name {
        "urine" => Ok(Need::Urine),
        "feces" => Ok(Need::Feces),
        other => Err(StoreError::Corrupt(format!(
            "sessions holds an unknown need {other:?}"
        ))),
    }
}

fn outcome_name(outcome: SessionOutcome) -> &'static str {
    match outcome {
        SessionOutcome::Success => "success",
        SessionOutcome::FailedDeadline => "failed_deadline",
        SessionOutcome::FailedRecovery => "failed_recovery",
        SessionOutcome::Left => "left",
        SessionOutcome::Abandoned => "abandoned",
    }
}

fn outcome_from_name(name: &str) -> Result<SessionOutcome, StoreError> {
    match name {
        "success" => Ok(SessionOutcome::Success),
        "failed_deadline" => Ok(SessionOutcome::FailedDeadline),
        "failed_recovery" => Ok(SessionOutcome::FailedRecovery),
        "left" => Ok(SessionOutcome::Left),
        "abandoned" => Ok(SessionOutcome::Abandoned),
        other => Err(StoreError::Corrupt(format!(
            "sessions holds an unknown outcome {other:?}"
        ))),
    }
}

fn sent_by_from_name(name: &str) -> Result<SentBy, StoreError> {
    match name {
        "self" => Ok(SentBy::Self_),
        "human" => Ok(SentBy::Human),
        other => Err(StoreError::Corrupt(format!(
            "sessions holds an unknown sent_by {other:?}"
        ))),
    }
}

/// Maps the twelve selected agent columns to a `StoredAgent`.
fn agent_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredAgent> {
    let kind: String = row.get(10)?;
    let color: Option<i64> = row.get(11)?;
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
        // A corrupt kind is a store bug; fall back to the column default so a
        // read never fails on it (agent_meta already rejects unknown values).
        kind: match kind.as_str() {
            "human" => PlayerKind::Human,
            _ => PlayerKind::Ai,
        },
        color: color.map(|color| color.clamp(0, 11) as u8),
    })
}

fn player_kind_from_name(name: &str) -> Result<PlayerKind, StoreError> {
    match name {
        "ai" => Ok(PlayerKind::Ai),
        "human" => Ok(PlayerKind::Human),
        other => Err(StoreError::Corrupt(format!(
            "agents holds an unknown kind {other:?}"
        ))),
    }
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

/// Contract §2: player kind and colour on `agents`, the mixed-world marker on
/// `sessions`, and the one-human-per-account index. Every step adds a missing
/// column only, so an old database upgrades in place.
fn migrate_play_kind(conn: &Connection) -> Result<(), StoreError> {
    let agent_columns = table_columns(conn, "agents")?;
    let has_agent = |name: &str| agent_columns.iter().any(|column| column.name == name);
    if !has_agent("kind") {
        add_column(conn, "agents", "kind TEXT NOT NULL DEFAULT 'ai'")?;
    }
    if !has_agent("color") {
        add_column(conn, "agents", "color INTEGER")?;
    }
    let session_columns = table_columns(conn, "sessions")?;
    if !session_columns
        .iter()
        .any(|column| column.name == "with_other_kind")
    {
        add_column(
            conn,
            "sessions",
            "with_other_kind INTEGER NOT NULL DEFAULT 0",
        )?;
    }
    conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS one_human_per_user \
         ON agents(user_id) WHERE kind = 'human' AND user_id IS NOT NULL",
    )?;
    Ok(())
}

fn migrate_worlds_official(conn: &Connection) -> Result<(), StoreError> {
    let columns = table_columns(conn, "worlds")?;
    if !columns.iter().any(|column| column.name == "official") {
        add_column(conn, "worlds", "official INTEGER NOT NULL DEFAULT 0")?;
    }
    Ok(())
}

/// Contract §1: whether the account's install added the loo line to an agent
/// instruction file. Defaults to off, so an existing database upgrades in place.
fn migrate_users_prompt(conn: &Connection) -> Result<(), StoreError> {
    let columns = table_columns(conn, "users")?;
    if !columns.iter().any(|column| column.name == "prompt_enabled") {
        add_column(conn, "users", "prompt_enabled INTEGER NOT NULL DEFAULT 0")?;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_store(name: &str) -> (PathBuf, Store) {
        let dir = std::env::temp_dir().join(format!("loo-store-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Store::open(&dir, "test", "test", 7).expect("store opens");
        (dir, store)
    }

    #[test]
    fn a_new_account_has_no_prompt_and_the_flag_round_trips() {
        let (dir, store) = fresh_store("prompt");
        let user_id = store
            .create_user("prompt-user", "hash")
            .expect("account is created");

        assert!(
            !store.prompt_enabled(user_id).expect("the new flag reads"),
            "the flag is off until the install records it"
        );
        store
            .set_prompt_enabled(user_id, true)
            .expect("the flag is writable");
        assert!(
            store.prompt_enabled(user_id).expect("the flag reads back"),
            "the stored flag reads back"
        );

        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }
}
