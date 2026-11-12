//! World events: the append-only record of state changes (design §8).
//!
//! Every event carries the tick it happened in, a per-tick sequence number, and
//! the tick's shuffle seed, so a replay can be verified.

use crate::config::Config;
use crate::state::{Action, Object, SiteKind};
use loo_proto::{AgentId, Dir, Need, Pos, SessionId, SessionOutcome, Tick};
use serde::{Deserialize, Serialize};

fn need_name(need: Need) -> &'static str {
    match need {
        Need::Urine => "urine",
        Need::Feces => "feces",
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

fn kind_name(kind: SiteKind) -> &'static str {
    match kind {
        SiteKind::Wall => "wall",
        SiteKind::Door => "door",
        SiteKind::Toilet => "toilet",
    }
}

fn object_kind_name(object: Object) -> &'static str {
    match object {
        Object::Wall { .. } => "wall",
        Object::Door { .. } => "door",
        Object::Toilet { .. } => "toilet",
        Object::Site { kind, .. } => kind_name(kind),
    }
}

/// Damage is server-generated state; the event has no config handle, so the text
/// reports the accumulated damage and leaves the total to the object's config.
fn damage_suffix(object: Object) -> String {
    match object {
        Object::Wall { damage } | Object::Door { damage, .. } => format!(" (damage {damage})"),
        _ => String::new(),
    }
}

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
        /// The action that ended, so the text can name it.
        action: Action,
        outcome: ActionOutcome,
    },
    /// A cell's object was built, damaged, removed or a door changed state.
    /// `object` is `None` when the object was removed.
    ObjectChanged {
        session: Option<SessionId>,
        agent: Option<AgentId>,
        nick: Option<String>,
        pos: Pos,
        object: Option<Object>,
        cause: ObjectCause,
    },
    /// A session got its need and deadline, at join or when it entered from the
    /// queue.
    NeedAssigned {
        session: SessionId,
        agent: AgentId,
        nick: String,
        need: Need,
        deadline: Tick,
    },
    /// The agent started using the toilet under its feet.
    UseStarted {
        session: SessionId,
        agent: AgentId,
        nick: String,
        pos: Pos,
    },
    /// One tick of use progress; `ticks_done` counts up to `use_ticks`.
    UseProgressed {
        session: SessionId,
        agent: AgentId,
        nick: String,
        pos: Pos,
        level: u8,
        ticks_done: u32,
        use_ticks: u32,
    },
    /// The use stopped before completion: the world changed, another action
    /// replaced it, or the agent cancelled. Progress is kept for a resume.
    UseInterrupted {
        session: SessionId,
        agent: AgentId,
        nick: String,
        pos: Option<Pos>,
        reason: String,
        recovery_deadline: Tick,
    },
    /// A use started again inside the recovery window.
    UseResumed {
        session: SessionId,
        agent: AgentId,
        nick: String,
        pos: Pos,
    },
    /// The need was met; the session lingers until `linger_until`.
    UseSucceeded {
        session: SessionId,
        agent: AgentId,
        nick: String,
        pos: Pos,
        score: u32,
        success_tick: Tick,
        linger_until: Tick,
    },
    /// The session failed its deadline or its recovery window.
    UseFailed {
        session: SessionId,
        agent: AgentId,
        nick: String,
        pos: Option<Pos>,
        outcome: SessionOutcome,
    },
    /// The session left the world, one way or another.
    SessionEnded {
        session: SessionId,
        agent: AgentId,
        nick: String,
        pos: Option<Pos>,
        outcome: SessionOutcome,
        score: u32,
    },
    /// The session is close to its deadline; sent once.
    DeadlineWarning {
        session: SessionId,
        agent: AgentId,
        nick: String,
        remaining: u32,
    },
    /// Marks the settlement of one tick. Always the first event of its tick and
    /// never delivered to an agent; `Event::seed` is the tick's shuffle seed.
    TickSettled,
}

/// Why an object changed (design §4.6/§4.7).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ObjectCause {
    Build { kind: SiteKind },
    Demolish,
    DoorOpened,
    DoorClosed,
    AutoOpened,
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
            EventKind::ObjectChanged { .. } => "ObjectChanged",
            EventKind::NeedAssigned { .. } => "NeedAssigned",
            EventKind::UseStarted { .. } => "UseStarted",
            EventKind::UseProgressed { .. } => "UseProgressed",
            EventKind::UseInterrupted { .. } => "UseInterrupted",
            EventKind::UseResumed { .. } => "UseResumed",
            EventKind::UseSucceeded { .. } => "UseSucceeded",
            EventKind::UseFailed { .. } => "UseFailed",
            EventKind::SessionEnded { .. } => "SessionEnded",
            EventKind::DeadlineWarning { .. } => "DeadlineWarning",
            EventKind::TickSettled => "TickSettled",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ActionOutcome {
    Completed,
    Blocked { by: Blocker },
    Cancelled,
    Failed { reason: String },
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
            | EventKind::ActionFinished { agent, .. }
            | EventKind::NeedAssigned { agent, .. }
            | EventKind::UseStarted { agent, .. }
            | EventKind::UseProgressed { agent, .. }
            | EventKind::UseInterrupted { agent, .. }
            | EventKind::UseResumed { agent, .. }
            | EventKind::UseSucceeded { agent, .. }
            | EventKind::UseFailed { agent, .. }
            | EventKind::SessionEnded { agent, .. }
            | EventKind::DeadlineWarning { agent, .. } => Some(*agent),
            EventKind::ObjectChanged { agent, .. } => *agent,
            EventKind::TickSettled => None,
        }
    }

    pub fn at(&self) -> Option<Pos> {
        match &self.kind {
            EventKind::Joined { at, .. } => *at,
            EventKind::EnteredWorld { at, .. } | EventKind::ActionFinished { at, .. } => Some(*at),
            EventKind::AgentMoved { to, .. } | EventKind::AgentSwapped { to, .. } => Some(*to),
            EventKind::ObjectChanged { pos, .. } => Some(*pos),
            EventKind::UseStarted { pos, .. }
            | EventKind::UseProgressed { pos, .. }
            | EventKind::UseResumed { pos, .. }
            | EventKind::UseSucceeded { pos, .. } => Some(*pos),
            EventKind::UseInterrupted { pos, .. }
            | EventKind::UseFailed { pos, .. }
            | EventKind::SessionEnded { pos, .. } => *pos,
            EventKind::ActionStarted { .. }
            | EventKind::ActionReplaced { .. }
            | EventKind::NeedAssigned { .. }
            | EventKind::DeadlineWarning { .. }
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
                format!("{nick} started {}", action.label())
            }
            EventKind::ActionReplaced { nick, from, to, .. } => format!(
                "{nick}'s action {} was replaced by {}",
                from.label(),
                to.label()
            ),
            EventKind::ActionFinished {
                nick,
                at,
                dir,
                action,
                outcome,
                ..
            } => match outcome {
                ActionOutcome::Completed => match action {
                    Action::Move { .. } => format!("{nick}'s move finished at {at}"),
                    other => format!("{nick} finished {} at {at}", other.label()),
                },
                ActionOutcome::Blocked { by } => {
                    let toward = dir
                        .map(|d| format!("towards the {}", d.word()))
                        .unwrap_or_else(|| "ahead".to_string());
                    let what = match action {
                        Action::Move { .. } => "move".to_string(),
                        other => other.label().to_string(),
                    };
                    format!(
                        "{nick}'s {what} stopped at {at}: {toward} is blocked by {}",
                        by.describe()
                    )
                }
                ActionOutcome::Cancelled => {
                    format!("{nick}'s {} was cancelled at {at}", action.label())
                }
                ActionOutcome::Failed { reason } => {
                    format!("{nick}'s {} failed at {at}: {reason}", action.label())
                }
            },
            EventKind::ObjectChanged {
                nick,
                pos,
                object,
                cause,
                ..
            } => match cause {
                ObjectCause::Build { kind } => match object {
                    Some(Object::Site { .. }) => format!(
                        "{} worked on a {} at {pos}",
                        nick.as_deref().unwrap_or("someone"),
                        kind_name(*kind)
                    ),
                    _ => format!(
                        "{} finished a {} at {pos}",
                        nick.as_deref().unwrap_or("someone"),
                        kind_name(*kind)
                    ),
                },
                ObjectCause::Demolish => match object {
                    Some(object) => format!(
                        "{} damaged a {} at {pos}{}",
                        nick.as_deref().unwrap_or("someone"),
                        object_kind_name(*object),
                        damage_suffix(*object)
                    ),
                    None => format!(
                        "{} demolished the object at {pos}",
                        nick.as_deref().unwrap_or("someone")
                    ),
                },
                ObjectCause::DoorOpened => format!(
                    "{} opened the door at {pos}",
                    nick.as_deref().unwrap_or("someone")
                ),
                ObjectCause::DoorClosed => format!(
                    "{} closed the door at {pos}",
                    nick.as_deref().unwrap_or("someone")
                ),
                ObjectCause::AutoOpened => format!(
                    "the door at {pos} closed with nobody on its toilet and opened automatically"
                ),
            },
            EventKind::NeedAssigned {
                nick,
                need,
                deadline,
                ..
            } => format!(
                "{nick} needs the toilet ({}) before tick {deadline}",
                need_name(*need)
            ),
            EventKind::UseStarted { nick, pos, .. } => {
                format!("{nick} started using the toilet at {pos}")
            }
            EventKind::UseProgressed {
                nick,
                pos,
                level,
                ticks_done,
                use_ticks,
                ..
            } => format!(
                "{nick} is using the level {level} toilet at {pos}: {ticks_done}/{use_ticks}"
            ),
            EventKind::UseInterrupted {
                nick,
                pos,
                reason,
                recovery_deadline,
                ..
            } => match pos {
                Some(pos) => format!(
                    "{nick}'s use at {pos} was interrupted: {reason}; recovery by tick {recovery_deadline}"
                ),
                None => format!(
                    "{nick}'s use was interrupted: {reason}; recovery by tick {recovery_deadline}"
                ),
            },
            EventKind::UseResumed { nick, pos, .. } => {
                format!("{nick} resumed using the toilet at {pos}")
            }
            EventKind::UseSucceeded {
                nick,
                pos,
                score,
                ..
            } => format!("{nick} finished at {pos} and scored {score}"),
            EventKind::UseFailed { nick, outcome, .. } => {
                format!("{nick} failed: {}", outcome_name(*outcome))
            }
            EventKind::SessionEnded {
                nick,
                outcome,
                score,
                ..
            } => match outcome {
                SessionOutcome::Success => {
                    format!("{nick} left the world: success, score {score}")
                }
                other => format!("{nick} left the world: {}", outcome_name(*other)),
            },
            EventKind::DeadlineWarning {
                nick, remaining, ..
            } => format!("{nick} has {remaining} ticks left before the deadline"),
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
