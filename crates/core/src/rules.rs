//! Validation rules for the verbs that touch objects (design §4.6, §4.7).
//!
//! These are pure predicates: the server can reject a bad command before it is
//! queued, and `step` re-checks at settlement because the world may have
//! changed in between.

use crate::config::Config;
use crate::map::Terrain;
use crate::state::{Action, Object, Session, SiteKind, WorldState};
use loo_proto::{AgentId, Dir, Need, Pos, SessionOutcome, Tick};

const OUT_OF_REACH: &str =
    "target is out of reach; you can only act on your cell or the four neighbours";
const NO_BUILD_AREA: &str = "that cell is in a no-build area";
const NO_DOOR: &str = "there is no door there";
const DOOR_PERMISSION: &str =
    "only an agent on an adjacent toilet cell can open or close this door";
/// Design §4.7: at most this many agents may work one toilet at a time.
const MAX_TOILET_WORKERS: usize = 5;

/// Design §4.8: the highest threshold (from level 5 down to 1) that is at most
/// `score_total`. Score 0 is level 1.
pub fn agent_level(score_total: u32, cfg: &Config) -> u8 {
    for level in (1..=5u8).rev() {
        if cfg.agent.level_thresholds[usize::from(level) - 1] <= score_total {
            return level;
        }
    }
    1
}

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

const NO_TARGET: &str = "there is no unstunned agent next to you in that direction";

/// Design §5: an attack needs an unstunned agent in one of the four adjacent
/// cells, no stun on the attacker and no cooldown. Returns the target's id.
pub fn validate_attack(
    world: &WorldState,
    agent: AgentId,
    target: Pos,
    cfg: &Config,
) -> Result<AgentId, String> {
    validate_attack_at(world, agent, target, cfg, world.tick)
}

/// Design §5: an attack needs an unstunned agent in one of the four adjacent
/// cells, no stun on the attacker and no cooldown. Returns the target's id.
///
/// `at_tick` is the tick the command will settle in. A command submitted
/// between ticks settles on `world.tick + 1`, so the server checks with that
/// tick: a cooldown or stun that ends exactly then is already over.
pub fn validate_attack_at(
    world: &WorldState,
    agent: AgentId,
    target: Pos,
    _cfg: &Config,
    at_tick: Tick,
) -> Result<AgentId, String> {
    let Some(me) = world.agents.get(&agent) else {
        return Err("you are not in the world".to_string());
    };
    let Some(pos) = me.pos else {
        return Err("you are not in the world".to_string());
    };
    let adjacent = pos.manhattan(target) == 1;
    let target_agent = match world.agent_at(target) {
        Some(other) if adjacent && !crate::state::is_stunned(other, at_tick) => Some(other.id),
        _ => None,
    };
    if crate::state::is_stunned(me, at_tick) {
        return Err(format!(
            "you are stunned until tick {}; you cannot attack",
            me.stun_until
        ));
    }
    if at_tick < me.attack_cooldown_until {
        return Err(format!(
            "your attack is on cooldown until tick {}",
            me.attack_cooldown_until
        ));
    }
    target_agent.ok_or_else(|| NO_TARGET.to_string())
}

/// Design §5: a defence covers one adjacent cell for one tick. It needs no
/// cooldown check for the *target* cell, only the agent's own cooldown.
pub fn validate_defend(world: &WorldState, agent: AgentId, target: Pos) -> Result<(), String> {
    validate_defend_at(world, agent, target, world.tick)
}

/// The tick-parameterised form of [`validate_defend`]; see [`validate_attack_at`]
/// for the meaning of `at_tick`.
pub fn validate_defend_at(
    world: &WorldState,
    agent: AgentId,
    target: Pos,
    at_tick: Tick,
) -> Result<(), String> {
    let Some(me) = world.agents.get(&agent) else {
        return Err("you are not in the world".to_string());
    };
    let Some(pos) = me.pos else {
        return Err("you are not in the world".to_string());
    };
    if crate::state::is_stunned(me, at_tick) {
        return Err(format!(
            "you are stunned until tick {}; you cannot defend",
            me.stun_until
        ));
    }
    if !world.map.in_bounds(target) {
        return Err("that cell is outside the map".to_string());
    }
    if target == pos {
        return Err("you cannot defend your own cell; defend an adjacent cell".to_string());
    }
    if pos.manhattan(target) != 1 {
        return Err(OUT_OF_REACH.to_string());
    }
    if at_tick < me.defend_cooldown_until {
        return Err(format!(
            "your defend is on cooldown until tick {}",
            me.defend_cooldown_until
        ));
    }
    Ok(())
}

/// Agents other than `agent` already working `target`, whatever the verb. The
/// agent issuing the command counts towards the same cap, so five others are
/// already the maximum.
fn other_workers(world: &WorldState, agent: AgentId, target: Pos) -> usize {
    world
        .agents
        .values()
        .filter(|other| {
            other.id != agent
                && matches!(
                    other.action.as_ref(),
                    Some(
                        Action::Upgrade { target: at, .. }
                            | Action::Downgrade { target: at, .. }
                            | Action::Demolish { target: at, .. }
                    ) if *at == target
                )
        })
        .count()
}

fn toilet_state_for(
    world: &WorldState,
    agent: AgentId,
    target: Pos,
    verb: &str,
) -> Result<(u8, i32), String> {
    acting_pos(world, agent, target)?;
    match world.object_at(target) {
        Some(Object::Toilet { level, progress }) => Ok((level, progress)),
        _ => Err(format!(
            "there is no toilet there; {verb} only works on a toilet"
        )),
    }
}

/// Design §4.7: an upgrade needs the toilet below level 5, an agent at least one
/// level above the toilet's next level, and a free worker slot.
pub fn validate_upgrade(
    world: &WorldState,
    agent: AgentId,
    target: Pos,
    _cfg: &Config,
) -> Result<(), String> {
    let (level, _) = toilet_state_for(world, agent, target, "upgrade")?;
    if level >= 5 {
        return Err(
            "this toilet is already level 5 (the highest); it cannot be upgraded".to_string(),
        );
    }
    let wanted = level + 1;
    let me = world.agents.get(&agent).map_or(1, |entry| entry.level);
    if me < wanted {
        return Err(format!(
            "your agent level is {me}; upgrading to level {wanted} needs level {wanted}; this tick's +1 was not counted"
        ));
    }
    let workers = other_workers(world, agent, target);
    if workers >= MAX_TOILET_WORKERS {
        return Err(format!(
            "this toilet already has {workers} workers (the maximum); wait for one to finish"
        ));
    }
    Ok(())
}

/// Downgrading has no level requirement. A level-1 toilet with no progress left
/// is a demolition target instead; one that still carries progress from an
/// earlier level keeps its downgrade running until the progress reaches zero.
pub fn validate_downgrade(world: &WorldState, agent: AgentId, target: Pos) -> Result<(), String> {
    let (level, progress) = toilet_state_for(world, agent, target, "downgrade")?;
    if level == 1 && progress == 0 {
        return Err("this toilet is already level 1; use demolish to remove it".to_string());
    }
    let workers = other_workers(world, agent, target);
    if workers >= MAX_TOILET_WORKERS {
        return Err(format!(
            "this toilet already has {workers} workers (the maximum); wait for one to finish"
        ));
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
    let Some(Object::Door { open: current, .. }) = world.object_at(target) else {
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

/// Every reason the cell at `pos` is not a usable toilet, north first for the
/// enclosure. `validate_use` reports these and `view::is_usable` asks whether
/// the list is empty, so the two can never drift apart.
pub(crate) fn toilet_problems(world: &WorldState, pos: Pos) -> Vec<String> {
    let mut problems = Vec::new();
    let Some(Object::Toilet { level, progress }) = world.object_at(pos) else {
        problems.push("you must stand on a toilet to use it".to_string());
        return problems;
    };
    if progress != 0 {
        problems.push(format!(
            "the toilet is under construction (progress {progress}); it is not usable"
        ));
    }
    if !(1..=5).contains(&level) {
        problems.push("the toilet is not at a complete level".to_string());
    }
    let gaps: Vec<String> = Dir::ALL
        .iter()
        .filter_map(|dir| {
            let cell = pos.step(*dir);
            if !world.map.in_bounds(cell) {
                return Some(format!("the {} side is the map edge", dir.word()));
            }
            match world.object_at(cell) {
                Some(Object::Wall { .. }) | Some(Object::Door { open: false, .. }) => None,
                Some(Object::Door { open: true, .. }) => {
                    Some(format!("the {} door is open", dir.word()))
                }
                _ => Some(format!(
                    "the {} side is not enclosed by a wall or a closed door",
                    dir.word()
                )),
            }
        })
        .collect();
    if !gaps.is_empty() {
        problems.push(format!("the toilet is not usable: {}", gaps.join("; ")));
    }
    problems
}

/// A `use` needs the agent to stand on a finished, enclosed toilet and not to
/// have succeeded already. Returns the toilet cell on success.
pub fn validate_use(world: &WorldState, agent: AgentId, _cfg: &Config) -> Result<Pos, String> {
    let Some(me) = world.agents.get(&agent) else {
        return Err("you are not in the world".to_string());
    };
    let Some(pos) = me.pos else {
        return Err("you are not in the world".to_string());
    };
    let Some(session) = world.session_of(agent) else {
        return Err("you are not in the world".to_string());
    };
    if session.outcome == Some(SessionOutcome::Success) {
        return Err("you already succeeded in this session".to_string());
    }
    let problems = toilet_problems(world, pos);
    if problems.is_empty() {
        Ok(pos)
    } else {
        Err(problems.join("; "))
    }
}

/// Design §4.8: each used tick counts with its toilet's multiplier, averaged
/// over the whole use and rounded half-up. An empty or invalid list scores 0.
pub fn weighted_score(base: u32, levels: &[u8], cfg: &Config) -> u32 {
    let ticks = levels.len() as u64;
    if ticks == 0 {
        return 0;
    }
    let mut sum: u64 = 0;
    for level in levels {
        let Some(multiplier) = level
            .checked_sub(1)
            .and_then(|index| cfg.toilet.multiplier.get(index as usize))
        else {
            return 0;
        };
        sum += u64::from(*multiplier);
    }
    let weighted = (u64::from(base) * sum + ticks / 2) / ticks;
    weighted.min(u64::from(u32::MAX)) as u32
}

/// The base score for the need, weighted by the toilets actually used, plus the
/// configured bonus for every tick left before the deadline.
pub fn session_score(session: &Session, cfg: &Config, success_tick: Tick) -> u32 {
    let base = match session.need {
        Some(Need::Urine) => cfg.need.base_score_urine,
        Some(Need::Feces) => cfg.need.base_score_feces,
        None => 0,
    };
    let weighted = u64::from(weighted_score(base, &session.use_levels, cfg));
    let time_bonus = session
        .deadline
        .saturating_sub(success_tick)
        .saturating_mul(u64::from(cfg.need.time_bonus_per_tick));
    (weighted + time_bonus).min(u64::from(u32::MAX)) as u32
}
