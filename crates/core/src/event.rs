//! World events: the append-only record of state changes (design §8).
//!
//! Every event carries the tick it happened in, a per-tick sequence number, and
//! the tick's shuffle seed, so a replay can be verified.

use crate::config::Config;
use crate::state::Action;
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
    /// A session joined between ticks. `at` is the entrance for an immediate
    /// entry, or `None` when the session queued outside.
    Joined {
        session: SessionId,
        agent: AgentId,
        nick: String,
        at: Option<Pos>,
    },
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
    /// A mover walked into a stunned agent and swapped cells with it.
    AgentSwapped {
        session: SessionId,
        agent: AgentId,
        nick: String,
        other_session: SessionId,
        other_agent: AgentId,
        other_nick: String,
        from: Pos,
        to: Pos,
        other_from: Pos,
        other_to: Pos,
    },
    /// A submitted action started, replacing nothing.
    ActionStarted {
        session: SessionId,
        agent: AgentId,
        nick: String,
        action: Action,
    },
    /// A submitted action replaced one that had not finished yet.
    ActionReplaced {
        session: SessionId,
        agent: AgentId,
        nick: String,
        from: Action,
        to: Action,
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
    /// Marks the settlement of one tick. Always the first event of its tick and
    /// never delivered to an agent; `Event::seed` is the tick's shuffle seed.
    TickSettled,
}

impl EventKind {
    /// Variant name, used as the SQLite event-type column.
    pub fn name(&self) -> &'static str {
        match self {
            EventKind::Joined { .. } => "Joined",
            EventKind::EnteredWorld { .. } => "EnteredWorld",
            EventKind::AgentMoved { .. } => "AgentMoved",
            EventKind::AgentSwapped { .. } => "AgentSwapped",
            EventKind::ActionStarted { .. } => "ActionStarted",
            EventKind::ActionReplaced { .. } => "ActionReplaced",
            EventKind::ActionFinished { .. } => "ActionFinished",
            EventKind::TickSettled => "TickSettled",
        }
    }
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
    Site,
}

impl Blocker {
    pub fn describe(&self) -> String {
        match self {
            Blocker::MapEdge => "the map edge".to_string(),
            Blocker::Wall => "a wall".to_string(),
            Blocker::ClosedDoor => "a closed door".to_string(),
            Blocker::Agent { nick } => format!("agent {nick}"),
            Blocker::Site => "an unfinished build site".to_string(),
        }
    }
}

impl Event {
    pub fn subject(&self) -> Option<AgentId> {
        match &self.kind {
            EventKind::Joined { agent, .. }
            | EventKind::EnteredWorld { agent, .. }
            | EventKind::AgentMoved { agent, .. }
            | EventKind::AgentSwapped { agent, .. }
            | EventKind::ActionStarted { agent, .. }
            | EventKind::ActionReplaced { agent, .. }
            | EventKind::ActionFinished { agent, .. } => Some(*agent),
            EventKind::TickSettled => None,
        }
    }

    pub fn at(&self) -> Option<Pos> {
        match &self.kind {
            EventKind::Joined { at, .. } => *at,
            EventKind::EnteredWorld { at, .. } | EventKind::ActionFinished { at, .. } => Some(*at),
            EventKind::AgentMoved { to, .. } | EventKind::AgentSwapped { to, .. } => Some(*to),
            EventKind::ActionStarted { .. }
            | EventKind::ActionReplaced { .. }
            | EventKind::TickSettled => None,
        }
    }

    /// Compact agent-facing text. Contains server-generated facts and
    /// nicknames only, never another agent's free text (design §6).
    pub fn text(&self) -> String {
        match &self.kind {
            EventKind::Joined { nick, at, .. } => match at {
                Some(at) => format!("{nick} entered the world at {at}"),
                None => format!("{nick} joined and waits outside the entrance"),
            },
            EventKind::EnteredWorld { nick, at, .. } => {
                format!("{nick} entered the world at {at}")
            }
            EventKind::AgentMoved { nick, from, to, .. } => {
                format!("{nick} moved {from} -> {to}")
            }
            EventKind::AgentSwapped {
                nick,
                from,
                to,
                other_nick,
                other_from,
                other_to,
                ..
            } => format!(
                "{nick} moved {from} -> {to}; {other_nick} was pushed {other_from} -> {other_to}"
            ),
            EventKind::ActionStarted { nick, action, .. } => {
                format!("{nick} started {}", action.label)
            }
            EventKind::ActionReplaced { nick, from, to, .. } => format!(
                "{nick}'s action {} was replaced by {}",
                from.label, to.label
            ),
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
            EventKind::TickSettled => format!("tick {} settled", self.tick),
        }
    }

    /// Whether `viewer` may see this event: events about yourself always, other
    /// events only inside your view window (design §4.10). Events without a
    /// subject or a location are never visible to anyone else.
    ///
    /// `ActionStarted` is an internal state change: it only goes into the event
    /// log (restore and the SQLite history), never into an agent's event stream.
    /// The command that queued the action already answered; only
    /// `ActionReplaced` is announced, because it overrides what the agent asked
    /// for earlier.
    pub fn visible_to(&self, viewer: AgentId, viewer_pos: Option<Pos>, cfg: &Config) -> bool {
        if matches!(self.kind, EventKind::ActionStarted { .. }) {
            return false;
        }
        if self.subject() == Some(viewer) {
            return true;
        }
        let Some(pos) = viewer_pos else {
            return false;
        };
        let Some(at) = self.at() else {
            return false;
        };
        (at.x - pos.x).abs() <= cfg.view.width / 2 && (at.y - pos.y).abs() <= cfg.view.height / 2
    }
}

/// Collects events for one tick, assigning sequence numbers.
pub(crate) struct EventLog {
    tick: Tick,
    seed: u64,
    first_seq: u32,
    events: Vec<Event>,
}

impl EventLog {
    pub(crate) fn new(tick: Tick, seed: u64) -> Self {
        Self::starting_at(tick, seed, 1)
    }

    /// Builds a log whose first event gets `first_seq`. Join events continue
    /// the sequence already used by the current tick.
    pub(crate) fn starting_at(tick: Tick, seed: u64, first_seq: u32) -> Self {
        Self {
            tick,
            seed,
            first_seq,
            events: Vec::new(),
        }
    }

    pub(crate) fn push(&mut self, kind: EventKind) {
        self.events.push(Event {
            tick: self.tick,
            seq: self.first_seq + self.events.len() as u32,
            seed: self.seed,
            kind,
        });
    }

    pub(crate) fn into_vec(self) -> Vec<Event> {
        self.events
    }
}
