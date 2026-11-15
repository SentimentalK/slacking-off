//! The browser's window on the world (`/api/play/state`).
//!
//! Unlike the spectator projection this view is clipped to a 9×9 window around
//! the player and carries no player kind, score, level or `sent_by`: the page
//! must not be able to read other players' private state (contract §7).

use loo_core::{Config, WorldState};
use loo_proto::{AgentId, PlayAgent, PlayWindow, Pos, ProjectionObject};
use std::collections::BTreeMap;

use crate::projection::{facing, pose, project_object, AgentPublic, COLOR_COUNT};

/// Cells per side of the visible window (contract §5).
pub const WINDOW_SIDE: i32 = 9;

/// A 9×9 window centred on `center`, shifted inside the map. A map smaller
/// than the window is taken at its own size.
pub fn window_around(world: &WorldState, center: Pos) -> PlayWindow {
    let map_width = world.map.width().max(0);
    let map_height = world.map.height().max(0);
    let width = WINDOW_SIDE.min(map_width);
    let height = WINDOW_SIDE.min(map_height);
    let origin = Pos::new(
        (center.x - width / 2).clamp(0, (map_width - width).max(0)),
        (center.y - height / 2).clamp(0, (map_height - height).max(0)),
    );
    PlayWindow {
        origin,
        width,
        height,
    }
}

fn in_window(window: &PlayWindow, pos: Pos) -> bool {
    pos.x >= window.origin.x
        && pos.x < window.origin.x + window.width
        && pos.y >= window.origin.y
        && pos.y < window.origin.y + window.height
}

/// Every object inside the window, in y then x order like the projection.
pub fn objects_in(world: &WorldState, cfg: &Config, window: &PlayWindow) -> Vec<ProjectionObject> {
    let mut out = Vec::new();
    for y in window.origin.y..window.origin.y + window.height {
        for x in window.origin.x..window.origin.x + window.width {
            let pos = Pos::new(x, y);
            let Some(object) = world.object_at(pos) else {
                continue;
            };
            out.push(project_object(cfg, pos, object));
        }
    }
    out
}

/// Every player standing inside the window, the caller included. A player
/// without a session or a cell is not drawn.
pub fn agents_in(
    world: &WorldState,
    cfg: &Config,
    window: &PlayWindow,
    publics: &BTreeMap<AgentId, AgentPublic>,
) -> Vec<PlayAgent> {
    let mut out = Vec::new();
    for agent in world.agents.values() {
        let Some(pos) = agent.pos else {
            continue;
        };
        if !in_window(window, pos) {
            continue;
        }
        let Some(session) = world.session_of(agent.id) else {
            continue;
        };
        let use_total = match session.need {
            Some(loo_proto::Need::Urine) => cfg.need.urine_use_ticks,
            Some(loo_proto::Need::Feces) => cfg.need.feces_use_ticks,
            None => 0,
        };
        out.push(PlayAgent {
            id: agent.id,
            nick: agent.nick.to_string(),
            color: color_of(agent.id, publics.get(&agent.id)),
            session_id: session.id,
            pos,
            pose: pose(agent, session, world.tick),
            facing: facing(agent),
            need: session.need,
            use_done: session.use_ticks_done,
            use_total,
            deadline_tick: session.deadline,
            defending: agent.defending,
            stun_until: agent.stun_until,
            immunity_until: agent.immunity_until,
        });
    }
    out
}

/// An explicit colour wins; otherwise the id picks the palette entry, exactly
/// as the spectator projection does.
pub fn color_of(id: AgentId, public: Option<&AgentPublic>) -> u8 {
    public
        .and_then(|public| public.color)
        .unwrap_or((id % COLOR_COUNT as u64) as u8)
}
