//! World state. Pure data plus lookups; no clocks, no I/O.

use crate::map::{Map, MapDef};
use loo_proto::{AgentId, Dir, Nick, Pos, SessionId, Tick};
use std::collections::{BTreeMap, VecDeque};

/// A world object. At most one per cell (design §4.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Object {
    Wall,
    Door { open: bool },
    Toilet { level: u8 },
}

impl Object {
    pub fn blocks_movement(self) -> bool {
        match self {
            Object::Wall => true,
            Object::Door { open } => !open,
            Object::Toilet { .. } => false,
        }
    }

    /// Design §10 view symbol.
    pub fn glyph(self) -> char {
        match self {
            Object::Wall => '#',
            Object::Door { open: true } => '\'',
            Object::Door { open: false } => '+',
            Object::Toilet { level } => char::from(b'0' + level.clamp(1, 9)),
        }
    }
}

/// The single action an agent is currently running (design §3).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Action {
    pub dirs: VecDeque<Dir>,
    pub total: u32,
    pub label: String,
}

impl Action {
    pub fn remaining(&self) -> u32 {
        self.dirs.len() as u32
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Agent {
    pub id: AgentId,
    pub nick: Nick,
    pub pos: Option<Pos>,
    pub action: Option<Action>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionStatus {
    /// Joined, waiting outside the entrance for a free entrance cell.
    Waiting,
    Inside,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Session {
    pub id: SessionId,
    pub agent: AgentId,
    pub status: SessionStatus,
    /// Cells this session has seen, with the tick they were first seen
    /// (design §4.10 `loo map`).
    pub seen: BTreeMap<Pos, Tick>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorldState {
    pub tick: Tick,
    pub map: Map,
    pub objects: Vec<Option<Object>>,
    pub agents: BTreeMap<AgentId, Agent>,
    pub sessions: BTreeMap<SessionId, Session>,
    pub entrance: Pos,
    /// FIFO of sessions waiting outside the entrance. Step 5 replaces this with
    /// queue cells on the map (design §2.1); step 0 only needs the order.
    pub entry_queue: VecDeque<SessionId>,
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
            entry_queue: VecDeque::new(),
        }
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

    /// Marks the configured view window around `pos` as seen at `tick`.
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
        let WorldState { sessions, map, .. } = self;
        let Some(session) = sessions.get_mut(&session) else {
            return;
        };
        for dy in -radius_y..=radius_y {
            for dx in -radius_x..=radius_x {
                let cell = Pos::new(pos.x + dx, pos.y + dy);
                if map.in_bounds(cell) {
                    session.seen.entry(cell).or_insert(tick);
                }
            }
        }
    }
}
