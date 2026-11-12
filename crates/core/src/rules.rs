//! Validation rules for the verbs that touch objects (design §4.6, §4.7).
//!
//! These are pure predicates: the server can reject a bad command before it is
//! queued, and `step` re-checks at settlement because the world may have
//! changed in between.

use crate::config::Config;
use crate::map::Terrain;
use crate::state::{Object, SiteKind, WorldState};
use loo_proto::{AgentId, Dir, Pos};

const OUT_OF_REACH: &str =
    "target is out of reach; you can only act on your cell or the four neighbours";
const NO_BUILD_AREA: &str = "that cell is in a no-build area";
const NO_DOOR: &str = "there is no door there";
const DOOR_PERMISSION: &str =
    "only an agent on an adjacent toilet cell can open or close this door";

/// The agent's cell; shared by every validator.
fn acting_pos(world: &WorldState, agent: AgentId, target: Pos) -> Result<Pos, String> {
    let Some(me) = world.agents.get(&agent).and_then(|a| a.pos) else {
        return Err("you are not in the world".to_string());
    };
    if me.manhattan(target) > 1 {
        return Err(OUT_OF_REACH.to_string());
    }
    Ok(me)
}

fn kind_name(kind: SiteKind) -> &'static str {
    match kind {
        SiteKind::Wall => "wall",
        SiteKind::Door => "door",
        SiteKind::Toilet => "toilet",
    }
}

pub fn validate_build(
    world: &WorldState,
    agent: AgentId,
    kind: SiteKind,
    target: Pos,
    _cfg: &Config,
) -> Result<(), String> {
    acting_pos(world, agent, target)?;
    match world.map.terrain_at(target) {
        None => return Err("that cell is outside the map".to_string()),
        Some(Terrain::NoBuild) => return Err(NO_BUILD_AREA.to_string()),
        Some(Terrain::Buildable) => {}
    }
    if matches!(kind, SiteKind::Wall | SiteKind::Door) && world.agent_at(target).is_some() {
        return Err(format!(
            "you cannot build a {} on a cell with an agent",
            kind_name(kind)
        ));
    }
    match world.object_at(target) {
        None => Ok(()),
        Some(Object::Site { kind: existing, .. }) if existing == kind => Ok(()),
        Some(Object::Site { .. }) => {
            Err("a different unfinished site is there; demolish it first".to_string())
        }
        Some(_) => Err("something is already there; demolish it first".to_string()),
    }
}

pub fn validate_demolish(world: &WorldState, agent: AgentId, target: Pos) -> Result<(), String> {
    acting_pos(world, agent, target)?;
    if world.object_at(target).is_none() {
        return Err("there is nothing to demolish there".to_string());
    }
    Ok(())
}

pub fn validate_door(
    world: &WorldState,
    agent: AgentId,
    target: Pos,
    open: bool,
) -> Result<(), String> {
    let me = acting_pos(world, agent, target)?;
    let Some(Object::Door { open: current }) = world.object_at(target) else {
        return Err(NO_DOOR.to_string());
    };
    let on_toilet = matches!(world.object_at(me), Some(Object::Toilet { .. }));
    let adjacent = me != target && Dir::ALL.iter().any(|dir| me.step(*dir) == target);
    if !(on_toilet && adjacent) {
        return Err(DOOR_PERMISSION.to_string());
    }
    if !open && world.agent_at(target).is_some() {
        return Err("someone is standing in the doorway".to_string());
    }
    if current == open {
        return Err(format!(
            "the door is already {}",
            if open { "open" } else { "closed" }
        ));
    }
    Ok(())
}
