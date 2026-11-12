//! Rendering and read-only queries: `look`, `map`, join briefing.

use crate::config::Config;
use crate::map::Terrain;
use crate::state::{Object, WorldState};
use loo_proto::{AgentId, Briefing, Dir, Grid, Legend, LookResponse, MapResponse, Pos, ToiletInfo};
use std::collections::{BTreeMap, BTreeSet};

/// Design §4.4: a toilet is usable when it sits at a complete level and all four
/// orthogonal neighbours are finished walls or closed doors.
pub fn is_usable(world: &WorldState, pos: Pos) -> bool {
    match world.object_at(pos) {
        Some(Object::Toilet { level, progress }) if (1..=5).contains(&level) && progress == 0 => {
            Dir::ALL.iter().all(|dir| {
                matches!(
                    world.object_at(pos.step(*dir)),
                    Some(Object::Wall) | Some(Object::Door { open: false })
                )
            })
        }
        _ => false,
    }
}

pub fn briefing(world: &WorldState, cfg: &Config) -> Briefing {
    let mut toilets: Vec<ToiletInfo> = Vec::new();
    for y in 0..world.map.height() {
        for x in 0..world.map.width() {
            let pos = Pos::new(x, y);
            if let Some(Object::Toilet { level, .. }) = world.object_at(pos) {
                toilets.push(ToiletInfo {
                    pos,
                    level,
                    usable: is_usable(world, pos),
                    occupied: world.agent_at(pos).is_some(),
                });
            }
        }
    }
    Briefing {
        map_width: world.map.width(),
        map_height: world.map.height(),
        entrance: world.entrance,
        view_width: cfg.view.width,
        view_height: cfg.view.height,
        toilets,
        no_build: world.map.no_build_rects(),
        tick: world.tick,
    }
}

pub fn look(world: &WorldState, agent: AgentId, cfg: &Config) -> Option<LookResponse> {
    let me = world.agents.get(&agent)?;
    let pos = me.pos?;
    let width = cfg.view.width;
    let height = cfg.view.height;
    let origin = Pos::new(pos.x - width / 2, pos.y - height / 2);

    let letters = letter_map(world, agent);
    let mut used: BTreeSet<char> = BTreeSet::new();
    let mut row_strings: Vec<String> = Vec::with_capacity(height as usize);

    for dy in 0..height {
        let mut row = String::with_capacity(width as usize);
        for dx in 0..width {
            let cell = Pos::new(origin.x + dx, origin.y + dy);
            let ch = if cell == pos {
                '@'
            } else if let Some(other) = world.agent_at(cell) {
                *letters.get(&other.id).unwrap_or(&'?')
            } else {
                cell_glyph(world, cell)
            };
            used.insert(ch);
            row.push(ch);
        }
        row_strings.push(row);
    }

    Some(LookResponse {
        grid: Grid {
            origin,
            width: width as u32,
            height: height as u32,
            rows: row_strings,
            legend: legend(&used, &letters),
        },
        pos,
        tick: world.tick,
    })
}

/// The remembered map (design §4.10): a bounding box of everything this session
/// has ever seen, with the tick each cell was first seen.
pub fn map_memory(world: &WorldState, agent: AgentId) -> Option<MapResponse> {
    let session = world.session_of(agent)?;
    if session.seen.is_empty() {
        return Some(MapResponse {
            grid: Grid {
                origin: Pos::new(0, 0),
                width: 0,
                height: 0,
                rows: Vec::new(),
                legend: Vec::new(),
            },
            seen_at: Vec::new(),
        });
    }
    let min_x = session.seen.keys().map(|p| p.x).min().unwrap_or(0);
    let max_x = session.seen.keys().map(|p| p.x).max().unwrap_or(0);
    let min_y = session.seen.keys().map(|p| p.y).min().unwrap_or(0);
    let max_y = session.seen.keys().map(|p| p.y).max().unwrap_or(0);
    let width = max_x - min_x + 1;
    let height = max_y - min_y + 1;
    let mut rows = Vec::with_capacity(height as usize);
    let mut seen_at = Vec::with_capacity(height as usize);
    let mut used: BTreeSet<char> = BTreeSet::new();

    for y in min_y..=max_y {
        let mut row = String::with_capacity(width as usize);
        let mut ticks = Vec::with_capacity(width as usize);
        for x in min_x..=max_x {
            let cell = Pos::new(x, y);
            match session.seen.get(&cell) {
                Some(&tick) => {
                    let ch = session.seen_glyph.get(&cell).copied().unwrap_or('?');
                    used.insert(ch);
                    row.push(ch);
                    ticks.push(tick);
                }
                None => {
                    used.insert('?');
                    row.push('?');
                    ticks.push(0);
                }
            }
        }
        rows.push(row);
        seen_at.push(ticks);
    }

    let letters: BTreeMap<AgentId, char> = BTreeMap::new();
    Some(MapResponse {
        grid: Grid {
            origin: Pos::new(min_x, min_y),
            width: width as u32,
            height: height as u32,
            rows,
            legend: legend(&used, &letters),
        },
        seen_at,
    })
}

/// Terrain / object glyph for a cell, without agents.
fn cell_glyph(world: &WorldState, cell: Pos) -> char {
    if !world.map.in_bounds(cell) {
        return '?';
    }
    if let Some(object) = world.object_at(cell) {
        return object.glyph();
    }
    match world.map.terrain_at(cell) {
        Some(Terrain::NoBuild) => ':',
        Some(Terrain::Buildable) => '.',
        None => '?',
    }
}

/// Letters for other agents, assigned by agent id so the legend is stable.
fn letter_map(world: &WorldState, viewer: AgentId) -> BTreeMap<AgentId, char> {
    world
        .agents
        .values()
        .filter(|a| a.id != viewer)
        .enumerate()
        .map(|(i, a)| (a.id, char::from(b'a' + (i % 26) as u8)))
        .collect()
}

fn symbol_rank(ch: char) -> u8 {
    match ch {
        '#' => 0,
        '+' => 1,
        '\'' => 2,
        '1'..='9' => 3,
        'x' => 4,
        '@' => 5,
        'a'..='z' => 6,
        '.' => 7,
        ':' => 8,
        _ => 9,
    }
}

fn legend(used: &BTreeSet<char>, letters: &BTreeMap<AgentId, char>) -> Vec<Legend> {
    let mut chars: Vec<char> = used.iter().copied().collect();
    chars.sort_by_key(|c| (symbol_rank(*c), *c));
    chars
        .into_iter()
        .map(|ch| Legend {
            symbol: ch.to_string(),
            meaning: symbol_meaning(ch, letters),
        })
        .collect()
}

fn symbol_meaning(ch: char, letters: &BTreeMap<AgentId, char>) -> String {
    match ch {
        '#' => "wall".to_string(),
        '+' => "closed door".to_string(),
        '\'' => "open door".to_string(),
        '1'..='9' => format!("toilet level {}", ch.to_digit(10).unwrap_or(0)),
        'x' => "unfinished or half-demolished site".to_string(),
        '@' => "you".to_string(),
        'a'..='z' => match letters.iter().find(|(_, letter)| **letter == ch) {
            Some((id, _)) => format!("another agent #{id}"),
            None => "another agent".to_string(),
        },
        '.' => "buildable floor".to_string(),
        ':' => "no-build floor".to_string(),
        _ => "not seen / outside the map".to_string(),
    }
}
