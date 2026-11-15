//! World state. Pure data plus lookups; no clocks, no I/O.

use crate::map::{Map, MapDef};
use loo_proto::{AgentId, Dir, Need, Nick, Pos, SessionId, SessionOutcome, Tick};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};

/// What an unfinished build site will become once the work is done.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SiteKind {
    Wall,
    Door,
    Toilet,
}

/// A world object. At most one per cell (design §4.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Object {
    Wall {
        damage: u32,
    },
    Door {
        open: bool,
        damage: u32,
    },
    Toilet {
        level: u8,
        progress: i32,
    },
    /// An unfinished build site for a wall, door or toilet. `work` is the
    /// remaining construction work; building lowers it by one per tick until it
    /// becomes the finished object. `Site` never means demolition: damage lives
    /// on the wall/door itself so it keeps enclosing the toilet while breaking.
    Site {
        kind: SiteKind,
        work: u32,
    },
    /// A corner of a toilet's 3x3, present while that toilet or its site exists.
    Pillar,
}

/// The four corner cells of the 3x3 centred on a toilet, in NW, NE, SW, SE order.
pub fn toilet_corners(pos: Pos) -> [Pos; 4] {
    [
        Pos::new(pos.x - 1, pos.y - 1),
        Pos::new(pos.x + 1, pos.y - 1),
        Pos::new(pos.x - 1, pos.y + 1),
        Pos::new(pos.x + 1, pos.y + 1),
    ]
}

impl Object {
    pub fn blocks_movement(self) -> bool {
        match self {
            Object::Wall { .. } => true,
            Object::Door { open, .. } => !open,
            Object::Toilet { .. } => false,
            Object::Site { kind, .. } => kind != SiteKind::Toilet,
            Object::Pillar => true,
        }
    }

    /// Design §10 view symbol.
    pub fn glyph(self) -> char {
        match self {
            Object::Wall { .. } => '#',
            Object::Door { open: true, .. } => '\'',
            Object::Door { open: false, .. } => '+',
            Object::Toilet { level, .. } => char::from(b'0' + level.clamp(1, 9)),
            Object::Site { .. } => 'x',
            Object::Pillar => '*',
        }
    }

    /// A finished wall, as opposed to a wall site mid-build.
    pub fn is_complete_wall(self) -> bool {
        matches!(self, Object::Wall { .. })
    }

    /// A closed door, as opposed to an open door or a door site.
    pub fn is_closed_door(self) -> bool {
        matches!(self, Object::Door { open: false, .. })
    }
}

/// The single action an agent is currently running (design §3).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Action {
    Move {
        dirs: VecDeque<Dir>,
        total: u32,
        label: String,
    },
    Build {
        kind: SiteKind,
        target: Pos,
        label: String,
    },
    Demolish {
        target: Pos,
        label: String,
    },
    Door {
        target: Pos,
        open: bool,
        label: String,
    },
    Use {
        target: Pos,
        label: String,
    },
    Upgrade {
        target: Pos,
        label: String,
    },
    Downgrade {
        target: Pos,
        label: String,
    },
    /// A committed attack. It does nothing until `land_tick`, then resolves
    /// against wherever the target actually stands (design §5).
    Attack {
        target_agent: AgentId,
        target_pos: Pos,
        land_tick: Tick,
        label: String,
    },
}

impl Action {
    pub fn label(&self) -> &str {
        match self {
            Action::Move { label, .. }
            | Action::Build { label, .. }
            | Action::Demolish { label, .. }
            | Action::Door { label, .. }
            | Action::Use { label, .. }
            | Action::Upgrade { label, .. }
            | Action::Downgrade { label, .. }
            | Action::Attack { label, .. } => label,
        }
    }

    /// Remaining steps of a move; work actions have no step count.
    pub fn remaining(&self) -> u32 {
        match self {
            Action::Move { dirs, .. } => dirs.len() as u32,
            Action::Build { .. }
            | Action::Demolish { .. }
            | Action::Door { .. }
            | Action::Use { .. }
            | Action::Upgrade { .. }
            | Action::Downgrade { .. }
            | Action::Attack { .. } => 0,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Agent {
    pub id: AgentId,
    pub nick: Nick,
    pub pos: Option<Pos>,
    pub action: Option<Action>,
    /// Tick until which the agent is stunned; it is stunned while
    /// `tick < stun_until`. A stunned agent can be shoved out of its cell by a
    /// mover and cannot start or advance an action.
    pub stun_until: Tick,
    /// Tick until which an attack would miss (`tick < immunity_until`).
    #[serde(default)]
    pub immunity_until: Tick,
    /// Tick from which the next attack may start (`tick >= ...`).
    #[serde(default)]
    pub attack_cooldown_until: Tick,
    /// Tick from which the next defence may start.
    #[serde(default)]
    pub defend_cooldown_until: Tick,
    /// The adjacent cell this agent shields. The shield is in force while
    /// `tick < defend_until`; `expire_defends` clears both fields together.
    #[serde(default)]
    pub defending: Option<Pos>,
    /// Tick at which the shield ends (open interval: in force below it).
    #[serde(default)]
    pub defend_until: Tick,
    /// Cumulative score over every session of this agent (design §4.8).
    #[serde(default)]
    pub score_total: u32,
    /// Level derived from `score_total` (design §4.8).
    #[serde(default = "default_level")]
    pub level: u8,
}

/// One definition of "still stunned": every rule compares the tick to the
/// agent's `stun_until` the same way.
pub fn is_stunned(agent: &Agent, tick: Tick) -> bool {
    tick < agent.stun_until
}

/// Serde default for `Agent::level`; old snapshots predate levels.
fn default_level() -> u8 {
    1
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SessionStatus {
    /// Joined, waiting outside the entrance for a free entrance cell.
    Waiting,
    Inside,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Session {
    pub id: SessionId,
    pub agent: AgentId,
    pub status: SessionStatus,
    /// Cells this session has seen, with the tick they were first seen
    /// (design §4.10 `loo map`).
    #[serde(with = "seen_serde")]
    pub seen: BTreeMap<Pos, Tick>,
    #[serde(default)]
    pub need: Option<Need>,
    /// Tick by which the need must be met; `0` means no deadline assigned.
    #[serde(default)]
    pub deadline: Tick,
    /// Length of the deadline drawn at assignment (`deadline - join tick`).
    /// The time bonus is a fraction of this span, so its scale does not depend
    /// on how large a deadline the session happened to draw.
    #[serde(default)]
    pub deadline_span: Tick,
    #[serde(default)]
    pub use_ticks_done: u32,
    #[serde(default)]
    pub use_levels: Vec<u8>,
    #[serde(default)]
    pub recovery_deadline: Option<Tick>,
    #[serde(default)]
    pub score: u32,
    #[serde(default)]
    pub outcome: Option<SessionOutcome>,
    #[serde(default)]
    pub linger_until: Option<Tick>,
    #[serde(default)]
    pub warned_deadline: bool,
    /// What a cell looked like when this session first saw it, aligned with
    /// `seen`. Later object changes never overwrite it.
    #[serde(default, with = "seen_glyph_serde")]
    pub seen_glyph: BTreeMap<Pos, char>,
    /// Last tick this session sent a command from the queue. A queued session
    /// is abandoned once it has been idle for the configured queue idle time.
    #[serde(default)]
    pub last_active_tick: Tick,
}

impl Session {
    /// A session with every later-step field at its default.
    pub fn fresh(
        id: SessionId,
        agent: AgentId,
        status: SessionStatus,
        seen: BTreeMap<Pos, Tick>,
    ) -> Self {
        Self {
            id,
            agent,
            status,
            seen,
            need: None,
            deadline: 0,
            deadline_span: 0,
            use_ticks_done: 0,
            use_levels: Vec::new(),
            recovery_deadline: None,
            score: 0,
            outcome: None,
            linger_until: None,
            warned_deadline: false,
            seen_glyph: BTreeMap::new(),
            last_active_tick: 0,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorldState {
    pub tick: Tick,
    pub map: Map,
    pub objects: Vec<Option<Object>>,
    pub agents: BTreeMap<AgentId, Agent>,
    pub sessions: BTreeMap<SessionId, Session>,
    pub entrance: Pos,
    /// Primary queue lane as map cells, head (mouth next to the entrance)
    /// first. Only an old snapshot can carry an empty lane: `map::parse`
    /// rejects maps without one.
    #[serde(default)]
    pub queue_primary: Vec<Pos>,
    /// Overflow queue lane, head first. Empty when the map has no overflow.
    #[serde(default)]
    pub queue_overflow: Vec<Pos>,
    /// Derived cache: queued sessions in global queue order (primary lane,
    /// then overflow lane, then anything outside the lanes by session id).
    /// `rebuild_entry_queue` recomputes it; never treat it as the source of
    /// truth for a session's position.
    pub entry_queue: VecDeque<SessionId>,
}

/// Which lane a queue cell belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum QueueLane {
    Primary,
    Overflow,
}

impl WorldState {
    pub fn new(def: MapDef) -> Self {
        Self {
            tick: 0,
            map: def.map,
            objects: def.objects,
            agents: BTreeMap::new(),
            sessions: BTreeMap::new(),
            entrance: def.entrance,
            queue_primary: def.queue_primary,
            queue_overflow: def.queue_overflow,
            entry_queue: VecDeque::new(),
        }
    }

    /// Which lane `pos` belongs to, if any.
    pub fn queue_lane(&self, pos: Pos) -> Option<QueueLane> {
        if self.queue_primary.contains(&pos) {
            Some(QueueLane::Primary)
        } else if self.queue_overflow.contains(&pos) {
            Some(QueueLane::Overflow)
        } else {
            None
        }
    }

    /// Position in the global queue: `0` is the head of the primary lane.
    /// Overflow ranks continue after the whole primary lane. `None` when the
    /// cell is not a queue cell.
    pub fn queue_rank(&self, pos: Pos) -> Option<usize> {
        if let Some(index) = self.queue_primary.iter().position(|cell| *cell == pos) {
            Some(index)
        } else {
            self.queue_overflow
                .iter()
                .position(|cell| *cell == pos)
                .map(|index| self.queue_primary.len() + index)
        }
    }

    /// Every waiting session in global queue order. Waiters that stand on no
    /// queue cell come last, ordered by session id so the order is total.
    pub fn waiting_sessions(&self) -> Vec<SessionId> {
        let mut waiting: Vec<(Option<usize>, SessionId)> = self
            .sessions
            .values()
            .filter(|session| session.status == SessionStatus::Waiting)
            .map(|session| {
                let rank = self
                    .agents
                    .get(&session.agent)
                    .and_then(|agent| agent.pos)
                    .and_then(|pos| self.queue_rank(pos));
                (rank, session.id)
            })
            .collect();
        waiting.sort_by_key(|(rank, session)| (rank.is_none(), rank.unwrap_or(0), *session));
        waiting.into_iter().map(|(_, session)| session).collect()
    }

    /// 1-based place in the queue, or `None` when the session is not waiting.
    pub fn queue_position(&self, session: SessionId) -> Option<usize> {
        self.waiting_sessions()
            .iter()
            .position(|queued| *queued == session)
            .map(|index| index + 1)
    }

    /// Rebuilds `entry_queue` from the physical queue.
    pub fn rebuild_entry_queue(&mut self) {
        self.entry_queue = self.waiting_sessions().into();
    }

    pub fn object_at(&self, pos: Pos) -> Option<Object> {
        self.map.index(pos).and_then(|i| self.objects[i])
    }

    pub fn set_object(&mut self, pos: Pos, object: Option<Object>) {
        if let Some(i) = self.map.index(pos) {
            self.objects[i] = object;
        }
    }

    pub fn agent_at(&self, pos: Pos) -> Option<&Agent> {
        self.agents.values().find(|a| a.pos == Some(pos))
    }

    pub fn agent_at_mut(&mut self, pos: Pos) -> Option<&mut Agent> {
        self.agents.values_mut().find(|a| a.pos == Some(pos))
    }

    pub fn session_of(&self, agent: AgentId) -> Option<&Session> {
        self.sessions.values().find(|s| s.agent == agent)
    }

    pub fn inside_count(&self) -> usize {
        self.sessions
            .values()
            .filter(|s| s.status == SessionStatus::Inside)
            .count()
    }

    pub fn is_inside(&self, agent: AgentId) -> bool {
        self.session_of(agent)
            .is_some_and(|s| s.status == SessionStatus::Inside)
    }

    /// Marks the configured view window around `pos` as seen at `tick`,
    /// remembering what each cell looked like the first time it was seen.
    pub fn mark_seen(
        &mut self,
        session: SessionId,
        pos: Pos,
        tick: Tick,
        view_w: i32,
        view_h: i32,
    ) {
        let radius_x = view_w / 2;
        let radius_y = view_h / 2;
        let WorldState {
            sessions,
            map,
            objects,
            ..
        } = self;
        let Some(session) = sessions.get_mut(&session) else {
            return;
        };
        for dy in -radius_y..=radius_y {
            for dx in -radius_x..=radius_x {
                let cell = Pos::new(pos.x + dx, pos.y + dy);
                if !map.in_bounds(cell) {
                    continue;
                }
                let glyph = match map.index(cell).and_then(|i| objects[i]) {
                    Some(object) => object.glyph(),
                    None => match map.terrain_at(cell) {
                        Some(crate::map::Terrain::NoBuild) => ':',
                        Some(crate::map::Terrain::Buildable) => '.',
                        None => '?',
                    },
                };
                session.seen.entry(cell).or_insert(tick);
                session.seen_glyph.entry(cell).or_insert(glyph);
            }
        }
    }
}

/// `Session::seen` keys are coordinates, which JSON cannot use as object keys.
/// Store it as a list of `(pos, tick)` pairs instead; the map round-trips
/// exactly because it is a `BTreeMap`.
mod seen_serde {
    use loo_proto::{Pos, Tick};
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    use std::collections::BTreeMap;

    pub fn serialize<S: Serializer>(
        seen: &BTreeMap<Pos, Tick>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        seen.iter()
            .map(|(pos, tick)| (*pos, *tick))
            .collect::<Vec<(Pos, Tick)>>()
            .serialize(serializer)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<BTreeMap<Pos, Tick>, D::Error> {
        Ok(Vec::<(Pos, Tick)>::deserialize(deserializer)?
            .into_iter()
            .collect())
    }
}

/// `Session::seen_glyph` has the same JSON-key problem as `seen`; store a list
/// of `(pos, glyph)` pairs so the map round-trips exactly.
mod seen_glyph_serde {
    use loo_proto::Pos;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    use std::collections::BTreeMap;

    pub fn serialize<S: Serializer>(
        seen: &BTreeMap<Pos, char>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        seen.iter()
            .map(|(pos, glyph)| (*pos, *glyph))
            .collect::<Vec<(Pos, char)>>()
            .serialize(serializer)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<BTreeMap<Pos, char>, D::Error> {
        Ok(Vec::<(Pos, char)>::deserialize(deserializer)?
            .into_iter()
            .collect())
    }
}
