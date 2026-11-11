//! World events: the append-only record of state changes (design §8).
//!
//! Every event carries the tick it happened in, a per-tick sequence number, and
//! the tick's shuffle seed, so a replay can be verified.

use crate::config::Config;
use loo_proto::{AgentId, Dir, Pos, SessionId, Tick};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Event {
    pub tick: Tick,
    pub seq: u32,
    pub seed: u64,
    pub kind: EventKind,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum EventKind {
    /// A queued session got the entrance cell.
    EnteredWorld {
        session: SessionId,
        agent: AgentId,
        nick: String,
        at: Pos,
    },
    /// One cell of a move action.
    AgentMoved {
        session: SessionId,
        agent: AgentId,
        nick: String,
        from: Pos,
        to: Pos,
    },
    /// The running action ended, either by finishing its path or by being
    /// blocked.
    ActionFinished {
        session: SessionId,
        agent: AgentId,
        nick: String,
        at: Pos,
        dir: Option<Dir>,
        outcome: ActionOutcome,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ActionOutcome {
    Completed,
    Blocked { by: Blocker },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Blocker {
    MapEdge,
    Wall,
    ClosedDoor,
    Agent { nick: String },
}

impl Blocker {
    pub fn describe(&self) -> String {
        match self {
            Blocker::MapEdge => "the map edge".to_string(),
            Blocker::Wall => "a wall".to_string(),
            Blocker::ClosedDoor => "a closed door".to_string(),
            Blocker::Agent { nick } => format!("agent {nick}"),
        }
    }
}

impl Event {
    pub fn subject(&self) -> AgentId {
        match &self.kind {
            EventKind::EnteredWorld { agent, .. }
            | EventKind::AgentMoved { agent, .. }
            | EventKind::ActionFinished { agent, .. } => *agent,
        }
    }

    pub fn at(&self) -> Pos {
        match &self.kind {
            EventKind::EnteredWorld { at, .. } | EventKind::ActionFinished { at, .. } => *at,
            EventKind::AgentMoved { to, .. } => *to,
        }
    }

    /// Compact agent-facing text. Contains server-generated facts and
    /// nicknames only, never another agent's free text (design §6).
    pub fn text(&self) -> String {
        match &self.kind {
            EventKind::EnteredWorld { nick, at, .. } => {
                format!("{nick} entered the world at {at}")
            }
            EventKind::AgentMoved { nick, from, to, .. } => {
                format!("{nick} moved {from} -> {to}")
            }
            EventKind::ActionFinished {
                nick,
                at,
                dir,
                outcome,
                ..
            } => match outcome {
                ActionOutcome::Completed => format!("{nick}'s move finished at {at}"),
                ActionOutcome::Blocked { by } => {
                    let toward = dir
                        .map(|d| format!("towards the {}", d.word()))
                        .unwrap_or_else(|| "ahead".to_string());
                    format!(
                        "{nick}'s move stopped at {at}: {toward} is blocked by {}",
                        by.describe()
                    )
                }
            },
        }
    }

    /// Whether `viewer` may see this event: events about yourself always, other
    /// events only inside your view window (design §4.10).
    pub fn visible_to(&self, viewer: AgentId, viewer_pos: Option<Pos>, cfg: &Config) -> bool {
        if self.subject() == viewer {
            return true;
        }
        let Some(pos) = viewer_pos else {
            return false;
        };
        let at = self.at();
        (at.x - pos.x).abs() <= cfg.view.width / 2 && (at.y - pos.y).abs() <= cfg.view.height / 2
    }
}

/// Collects events for one tick, assigning sequence numbers.
pub(crate) struct EventLog {
    tick: Tick,
    seed: u64,
    events: Vec<Event>,
}

impl EventLog {
    pub(crate) fn new(tick: Tick, seed: u64) -> Self {
        Self {
            tick,
            seed,
            events: Vec::new(),
        }
    }

    pub(crate) fn push(&mut self, kind: EventKind) {
        self.events.push(Event {
            tick: self.tick,
            seq: self.events.len() as u32 + 1,
            seed: self.seed,
            kind,
        });
    }

    pub(crate) fn into_vec(self) -> Vec<Event> {
        self.events
    }
}
