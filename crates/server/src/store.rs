//! SQLite persistence (design §8): the world row, the event log, snapshots, the
//! command log and the agents registered against this world.
//!
//! The event log is the source of truth; snapshots only shorten recovery. Every
//! tick's events and the world's tick counter are written in one transaction, so
//! a crash never leaves a tick half-recorded.

use loo_core::{Event, EventKind, IntentKind, Snapshot, WorldState};
use loo_proto::{AgentId, Tick};
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
    tick INTEGER NOT NULL
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
    token TEXT NOT NULL UNIQUE,
    sent_by TEXT,
    why TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    score_total INTEGER NOT NULL DEFAULT 0
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
    pub token: String,
    /// `self` or `human`, recorded when the agent joins.
    pub sent_by: Option<String>,
    pub why: String,
    /// Cumulative score over every session, persisted with each scored tick.
    pub score_total: u32,
}

#[derive(Debug)]
pub enum StoreError {
    Sqlite(rusqlite::Error),
    Json(serde_json::Error),
    Io(std::io::Error),
    Replay(loo_core::ReplayError),
    MapMismatch,
    Corrupt(String),
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
            StoreError::MapMismatch | StoreError::Corrupt(_) => None,
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
        migrate_agents_score(&conn)?;

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
            "SELECT id, nick, model, intro, token, sent_by, why, score_total FROM agents \
             WHERE world_id = ?1 ORDER BY id",
        )?;
        let rows = stmt.query_map([WORLD_ID], |row| {
            Ok(StoredAgent {
                id: row.get::<_, i64>(0)? as AgentId,
                nick: row.get(1)?,
                model: row.get(2)?,
                intro: row.get(3)?,
                token: row.get(4)?,
                sent_by: row.get(5)?,
                why: row.get(6)?,
                score_total: row.get::<_, i64>(7)? as u32,
            })
        })?;
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
}

/// Adds `agents.score_total` to databases written before the column existed.
/// `CREATE TABLE IF NOT EXISTS` never changes an existing table, so old rows
/// keep every value and the new column starts at its default 0.
fn migrate_agents_score(conn: &Connection) -> Result<(), StoreError> {
    let has_score_total = {
        let mut stmt = conn.prepare("PRAGMA table_info(agents)")?;
        let mut rows = stmt.query([])?;
        let mut found = false;
        while let Some(row) = rows.next()? {
            if row.get::<_, String>(1)? == "score_total" {
                found = true;
                break;
            }
        }
        found
    };
    if !has_score_total {
        conn.execute(
            "ALTER TABLE agents ADD COLUMN score_total INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
