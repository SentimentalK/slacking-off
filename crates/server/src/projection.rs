//! The single public projection builder (contract §2).
//!
//! Both `/api/watch` and `/api/projection?tick=` call [`build`]; there is no
//! second code path. Only public state goes in: the nickname is the only
//! free-form string, and `why`/`intro`/`model`/tokens never leave the store.

use loo_core::{
    Action, Config, Event, EventKind, Object, ObjectCause, Session, SiteKind, WorldState,
};
use loo_proto::{
    AgentId, AgentPose, Dir, EventTag, Need, ObjectKind, ObjectsMode, PlayerKind, Pos, Projection,
    ProjectionAgent, ProjectionCounts, ProjectionEvent, ProjectionObject, ProjectionQueueEntry,
    SentBy, SessionOutcome, TerrainResponse, Tick,
};
use std::collections::BTreeMap;

/// Colour palette size; `color = id % COLOR_COUNT`.
pub const COLOR_COUNT: usize = 12;

/// This server keeps a single world per database file (`worlds.id = 1`).
const WORLD_ID: u64 = 1;

/// What the server knows about an agent without touching private text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AgentPublic {
    pub sent_by: Option<SentBy>,
    pub kind: PlayerKind,
    /// Explicit colour `0..=11`; `None` means `id % 12`.
    pub color: Option<u8>,
}

/// Builds the projection for one settled tick.
///
/// `events` must be exactly that tick's events in sequence order; agents and
/// objects are ordered here, so the result is deterministic.
pub fn build(
    cfg: &Config,
    world: &WorldState,
    agents: &BTreeMap<AgentId, AgentPublic>,
    events: &[Event],
) -> Projection {
    Projection {
        world: WORLD_ID,
        tick: world.tick,
        tick_seconds: cfg.tick_seconds,
        width: world.map.width(),
        height: world.map.height(),
        counts: ProjectionCounts {
            inside: world.inside_count(),
            queued: world.entry_queue.len(),
            capacity: cfg.max_on_field,
            queue_capacity: cfg.session.queue_capacity,
        },
        agents: project_agents(cfg, world, agents),
        objects: project_objects(cfg, world),
        objects_mode: ObjectsMode::Full,
        objects_removed: Vec::new(),
        queue: project_queue(world, agents),
        // Contract §2: settlement markers and queue heartbeats have no
        // user-facing meaning and would flood the live log.
        events: events
            .iter()
            .filter(|event| {
                !matches!(
                    event.kind,
                    EventKind::TickSettled | EventKind::QueueTouched { .. }
                )
            })
            .map(project_event)
            .collect(),
    }
}

/// What changed in the object table between two consecutive ticks.
///
/// Keyed by `pos`. The first vector holds objects that are new or differ from
/// `prev`, in `next` order; the second holds positions present in `prev` but
/// absent from `next`, in `prev` order. Both inputs come from
/// `project_objects`, so both orders are y then x and the result is
/// deterministic.
pub fn delta_objects(
    prev: &[ProjectionObject],
    next: &[ProjectionObject],
) -> (Vec<ProjectionObject>, Vec<Pos>) {
    let before: BTreeMap<Pos, &ProjectionObject> = prev.iter().map(|o| (o.pos, o)).collect();
    let after: std::collections::BTreeSet<Pos> = next.iter().map(|o| o.pos).collect();
    let changed = next
        .iter()
        .filter(|object| before.get(&object.pos).map_or(true, |old| *old != *object))
        .cloned()
        .collect();
    let removed = prev
        .iter()
        .map(|object| object.pos)
        .filter(|pos| !after.contains(pos))
        .collect();
    (changed, removed)
}

/// `GET /api/terrain`: rows are y = 0..height, one character per x.
pub fn terrain_rows(world: &WorldState) -> TerrainResponse {
    let width = world.map.width();
    let height = world.map.height();
    let mut rows = Vec::with_capacity(height.max(0) as usize);
    for y in 0..height {
        let mut row = String::with_capacity(width.max(0) as usize);
        for x in 0..width {
            let glyph = match world.map.terrain_at(Pos::new(x, y)) {
                Some(loo_core::Terrain::NoBuild) => ':',
                Some(loo_core::Terrain::Buildable) => '.',
                None => '.',
            };
            row.push(glyph);
        }
        rows.push(row);
    }
    TerrainResponse {
        width,
        height,
        entrance: world.entrance,
        rows,
    }
}

fn project_agents(
    cfg: &Config,
    world: &WorldState,
    agents: &BTreeMap<AgentId, AgentPublic>,
) -> Vec<ProjectionAgent> {
    let mut out = Vec::new();
    // `WorldState::agents` is a `BTreeMap`, so iteration is already by id.
    for agent in world.agents.values() {
        if !world.is_inside(agent.id) {
            continue;
        }
        let Some(pos) = agent.pos else {
            continue;
        };
        let Some(session) = world.session_of(agent.id) else {
            continue;
        };
        let use_total = match session.need {
            Some(Need::Urine) => cfg.need.urine_use_ticks,
            Some(Need::Feces) => cfg.need.feces_use_ticks,
            None => 0,
        };
        let public = agents.get(&agent.id);
        out.push(ProjectionAgent {
            id: agent.id,
            nick: agent.nick.to_string(),
            color: crate::play::color_of(agent.id, public),
            kind: public.map_or(PlayerKind::Ai, |public| public.kind),
            session_id: session.id,
            pos,
            pose: pose(agent, session, world.tick),
            facing: facing(agent),
            need: session.need,
            use_done: session.use_ticks_done,
            use_total,
            deadline_tick: session.deadline,
            sent_by: public.and_then(|public| public.sent_by),
            level: agent.level,
            score_total: agent.score_total,
            defending: agent.defending,
            stun_until: agent.stun_until,
            immunity_until: agent.immunity_until,
        });
    }
    out
}

pub(crate) fn pose(agent: &loo_core::Agent, session: &Session, tick: Tick) -> AgentPose {
    if tick < agent.stun_until {
        return AgentPose::Stunned;
    }
    if agent.defending.is_some() {
        return AgentPose::Defending;
    }
    if let Some(action) = &agent.action {
        return match action {
            Action::Move { .. } => AgentPose::Walking,
            Action::Use { .. } => AgentPose::Using,
            Action::Build { .. } | Action::Upgrade { .. } => AgentPose::Working,
            Action::Demolish { .. } | Action::Downgrade { .. } => AgentPose::Demolishing,
            Action::Attack { .. } => AgentPose::Attacking,
            Action::Door { .. } => AgentPose::Idle,
        };
    }
    if session.outcome == Some(SessionOutcome::Success) {
        return AgentPose::Success;
    }
    AgentPose::Idle
}

/// The first direction of a move, else south (contract §2).
pub(crate) fn facing(agent: &loo_core::Agent) -> Dir {
    match &agent.action {
        Some(Action::Move { dirs, .. }) => dirs.front().copied().unwrap_or(Dir::S),
        _ => Dir::S,
    }
}

fn project_objects(cfg: &Config, world: &WorldState) -> Vec<ProjectionObject> {
    let mut out = Vec::new();
    for y in 0..world.map.height() {
        for x in 0..world.map.width() {
            let pos = Pos::new(x, y);
            let Some(object) = world.object_at(pos) else {
                continue;
            };
            out.push(project_object(cfg, pos, object));
        }
    }
    out
}

pub(crate) fn project_object(cfg: &Config, pos: Pos, object: Object) -> ProjectionObject {
    match object {
        Object::Wall { damage } => ProjectionObject {
            pos,
            kind: ObjectKind::Wall,
            level: 0,
            open: false,
            progress: damage,
            progress_total: cfg.build.wall_work,
            site: None,
            crack: damage > 0,
        },
        Object::Door { open, damage } => ProjectionObject {
            pos,
            kind: ObjectKind::Door,
            level: 0,
            open,
            progress: damage,
            progress_total: cfg.build.door_work,
            site: None,
            crack: damage > 0,
        },
        Object::Toilet { level, progress } => ProjectionObject {
            pos,
            kind: ObjectKind::Toilet,
            level,
            open: false,
            progress: progress.max(0) as u32,
            progress_total: if progress > 0 {
                toilet_progress_total(cfg, level)
            } else {
                0
            },
            site: None,
            crack: false,
        },
        Object::Site { kind, work } => {
            let (site_kind, total) = match kind {
                SiteKind::Wall => (ObjectKind::Wall, cfg.build.wall_work),
                SiteKind::Door => (ObjectKind::Door, cfg.build.door_work),
                SiteKind::Toilet => (ObjectKind::Toilet, cfg.build.toilet_work),
            };
            ProjectionObject {
                pos,
                kind: site_kind,
                level: 0,
                open: false,
                progress: total.saturating_sub(work),
                progress_total: total,
                site: Some(site_kind),
                crack: false,
            }
        }
    }
}

/// Work needed to upgrade the toilet from `level`; level 5 reuses level 4's
/// value because there is no level 6.
fn toilet_progress_total(cfg: &Config, level: u8) -> u32 {
    let last = cfg.build.upgrade_work.len().saturating_sub(1);
    let index = usize::from(level.clamp(1, 5) - 1).min(last);
    cfg.build.upgrade_work[index]
}

fn project_queue(
    world: &WorldState,
    agents: &BTreeMap<AgentId, AgentPublic>,
) -> Vec<ProjectionQueueEntry> {
    let mut out = Vec::new();
    // The physical queue decides the order; `queue_position` counts the same
    // sequence, so `index` and `queue_ahead` always agree.
    for (index, session_id) in world.waiting_sessions().iter().enumerate() {
        let Some(session) = world.sessions.get(session_id) else {
            continue;
        };
        let Some(agent) = world.agents.get(&session.agent) else {
            continue;
        };
        // Core puts every waiter on a queue cell; a missing pos is a bug.
        let pos = agent
            .pos
            .expect("a waiting session always stands on a queue cell");
        out.push(ProjectionQueueEntry {
            id: agent.id,
            nick: agent.nick.to_string(),
            color: crate::play::color_of(agent.id, agents.get(&agent.id)),
            pos,
            index: index as u32 + 1,
        });
    }
    out
}

fn project_event(event: &Event) -> ProjectionEvent {
    ProjectionEvent {
        tick: event.tick,
        seq: event.seq,
        kind: event_tag(event),
        text: event.text(),
    }
}

/// Contract §2 tag mapping; the first matching rule wins.
pub(crate) fn event_tag(event: &Event) -> EventTag {
    match &event.kind {
        EventKind::UseSucceeded { .. } => EventTag::Success,
        EventKind::AttackStarted { .. }
        | EventKind::AttackLanded { .. }
        | EventKind::AttackMissed { .. }
        | EventKind::AttackBlocked { .. }
        | EventKind::AttackCancelled { .. } => EventTag::Attack,
        EventKind::DefendStarted { .. }
        | EventKind::DefendEnded { .. }
        | EventKind::DemolishBlocked { .. } => EventTag::Defend,
        EventKind::ObjectChanged { cause, .. } => match cause {
            ObjectCause::Demolish => EventTag::Demolish,
            ObjectCause::Build { .. } | ObjectCause::Upgrade => EventTag::Build,
            ObjectCause::DoorOpened
            | ObjectCause::DoorClosed
            | ObjectCause::AutoOpened
            | ObjectCause::Downgrade => EventTag::Other,
        },
        EventKind::ActionStarted { action, .. } | EventKind::ActionFinished { action, .. } => {
            action_tag(action)
        }
        EventKind::ActionReplaced { to, .. } => action_tag(to),
        EventKind::Joined { .. } | EventKind::EnteredWorld { .. } => EventTag::Join,
        EventKind::SessionEnded { .. } | EventKind::UseFailed { .. } => EventTag::Leave,
        EventKind::UseStarted { .. }
        | EventKind::UseProgressed { .. }
        | EventKind::UseInterrupted { .. }
        | EventKind::UseResumed { .. } => EventTag::Use,
        EventKind::AgentMoved { .. }
        | EventKind::AgentSwapped { .. }
        | EventKind::QueueAdvanced { .. }
        | EventKind::QueueTouched { .. }
        | EventKind::NeedAssigned { .. }
        | EventKind::DeadlineWarning { .. }
        | EventKind::Stunned { .. }
        | EventKind::ActionRejected { .. }
        | EventKind::TickSettled => EventTag::Other,
    }
}

fn action_tag(action: &Action) -> EventTag {
    match action {
        Action::Demolish { .. } => EventTag::Demolish,
        Action::Build { .. } | Action::Upgrade { .. } => EventTag::Build,
        Action::Move { .. }
        | Action::Door { .. }
        | Action::Use { .. }
        | Action::Downgrade { .. }
        | Action::Attack { .. } => EventTag::Other,
    }
}
