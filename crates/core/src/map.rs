//! Map file parsing. Maps are text files; changing the map never changes code.
//!
//! Format (see `maps/README.md`):
//!
//! ```text
//! # comment
//! grid
//! ....:E:...
//! ```
//!
//! Characters: `#` wall, `+` closed door, `'` open door, `1`..`5` toilet of
//! that level, `x` unfinished build site (blocks movement), `*` pillar (a
//! corner of a toilet's 3x3, blocks movement), `.` buildable
//! floor, `:` no-build floor, `E` entrance (no-build floor), `q` primary queue
//! lane, `r` overflow queue lane. Exactly one `E` is required.
//!
//! Every map has a queue area: the primary lane (`q`) must be non-empty, must
//! touch the entrance through exactly one mouth cell, and both lanes must be
//! connected and orderable head to tail (see [`parse`]).

use crate::state::{Object, SiteKind};
use loo_proto::{Dir, Pos};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Terrain {
    Buildable,
    NoBuild,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Map {
    width: i32,
    height: i32,
    terrain: Vec<Terrain>,
}

impl Map {
    pub fn width(&self) -> i32 {
        self.width
    }

    pub fn height(&self) -> i32 {
        self.height
    }

    pub fn in_bounds(&self, pos: Pos) -> bool {
        pos.x >= 0 && pos.y >= 0 && pos.x < self.width && pos.y < self.height
    }

    pub fn index(&self, pos: Pos) -> Option<usize> {
        if self.in_bounds(pos) {
            Some(pos.y as usize * self.width as usize + pos.x as usize)
        } else {
            None
        }
    }

    pub fn terrain_at(&self, pos: Pos) -> Option<Terrain> {
        self.index(pos).map(|i| self.terrain[i])
    }

    /// Orthogonal in-bounds neighbours, north first.
    pub fn neighbours(&self, pos: Pos) -> impl Iterator<Item = (Dir, Pos)> + '_ {
        Dir::ALL
            .into_iter()
            .map(move |d| (d, pos.step(d)))
            .filter(move |(_, p)| self.in_bounds(*p))
    }

    /// Run-length rectangles of no-build terrain, used for the join briefing.
    /// Horizontal runs per row, merged downwards when identical.
    pub fn no_build_rects(&self) -> Vec<loo_proto::Rect> {
        let mut rects: Vec<loo_proto::Rect> = Vec::new();
        for y in 0..self.height {
            let mut x = 0;
            while x < self.width {
                if self.terrain_at(Pos::new(x, y)) != Some(Terrain::NoBuild) {
                    x += 1;
                    continue;
                }
                let start = x;
                while x < self.width && self.terrain_at(Pos::new(x, y)) == Some(Terrain::NoBuild) {
                    x += 1;
                }
                let w = x - start;
                if let Some(r) = rects
                    .iter_mut()
                    .rev()
                    .find(|r| r.y + r.h == y && r.x == start && r.w == w)
                {
                    r.h += 1;
                } else {
                    rects.push(loo_proto::Rect {
                        x: start,
                        y,
                        w,
                        h: 1,
                    });
                }
            }
        }
        rects
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MapDef {
    pub map: Map,
    pub objects: Vec<Option<Object>>,
    pub entrance: Pos,
    /// Primary queue lane, head (the mouth next to the entrance) first.
    pub queue_primary: Vec<Pos>,
    /// Overflow queue lane, head first. Empty when the map has no overflow.
    pub queue_overflow: Vec<Pos>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MapError {
    pub line: usize,
    pub message: String,
}

impl fmt::Display for MapError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "map line {}: {}", self.line, self.message)
    }
}

impl std::error::Error for MapError {}

pub fn parse(text: &str) -> Result<MapDef, MapError> {
    let mut rows: Vec<(usize, String)> = Vec::new();
    let mut seen_grid = false;
    for (n, raw) in text.lines().enumerate() {
        let line_no = n + 1;
        if !seen_grid {
            let trimmed = raw.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            if trimmed == "grid" {
                seen_grid = true;
                continue;
            }
            return Err(MapError {
                line: line_no,
                message: format!("expected `grid` before map rows, got {trimmed:?}"),
            });
        }
        if raw.trim().is_empty() {
            continue;
        }
        rows.push((line_no, raw.to_string()));
    }

    if rows.is_empty() {
        return Err(MapError {
            line: 1,
            message: "map has no grid rows".to_string(),
        });
    }

    let width = rows[0].1.len() as i32;
    let height = rows.len() as i32;
    let mut terrain = Vec::with_capacity((width * height) as usize);
    let mut objects = Vec::with_capacity((width * height) as usize);
    let mut entrance = None;
    let mut primary_cells: Vec<Pos> = Vec::new();
    let mut overflow_cells: Vec<Pos> = Vec::new();

    for (row_index, (line_no, row)) in rows.iter().enumerate() {
        if row.len() as i32 != width {
            return Err(MapError {
                line: *line_no,
                message: format!("row is {} cells wide, expected {width}", row.len()),
            });
        }
        for (x, ch) in row.chars().enumerate() {
            let pos = Pos::new(x as i32, row_index as i32);
            let (t, object) = match ch {
                '.' => (Terrain::Buildable, None),
                ':' => (Terrain::NoBuild, None),
                'q' => {
                    primary_cells.push(pos);
                    (Terrain::NoBuild, None)
                }
                'r' => {
                    overflow_cells.push(pos);
                    (Terrain::NoBuild, None)
                }
                'E' => {
                    if entrance.replace(pos).is_some() {
                        return Err(MapError {
                            line: *line_no,
                            message: "map has more than one entrance".to_string(),
                        });
                    }
                    (Terrain::NoBuild, None)
                }
                '#' => (Terrain::Buildable, Some(Object::Wall { damage: 0 })),
                '+' => (
                    Terrain::Buildable,
                    Some(Object::Door {
                        open: false,
                        damage: 0,
                    }),
                ),
                '\'' => (
                    Terrain::Buildable,
                    Some(Object::Door {
                        open: true,
                        damage: 0,
                    }),
                ),
                '1'..='5' => (
                    Terrain::Buildable,
                    Some(Object::Toilet {
                        level: ch.to_digit(10).unwrap_or(1) as u8,
                        progress: 0,
                    }),
                ),
                'x' => (
                    Terrain::Buildable,
                    Some(Object::Site {
                        kind: SiteKind::Wall,
                        work: 1,
                    }),
                ),
                '*' => (Terrain::Buildable, Some(Object::Pillar)),
                other => {
                    return Err(MapError {
                        line: *line_no,
                        message: format!("unknown map character {other:?} at {pos}"),
                    })
                }
            };
            terrain.push(t);
            objects.push(object);
        }
    }

    let entrance = entrance.ok_or(MapError {
        line: 1,
        message: "map has no entrance (`E`)".to_string(),
    })?;
    let (queue_primary, queue_overflow) =
        order_queue_lanes(entrance, &primary_cells, &overflow_cells)?;

    Ok(MapDef {
        map: Map {
            width,
            height,
            terrain,
        },
        objects,
        entrance,
        queue_primary,
        queue_overflow,
    })
}

/// Orders both queue lanes head to tail.
///
/// Every map must declare a primary lane. The primary lane must be non-empty
/// and its mouth must be the single `q` cell orthogonally adjacent to the
/// entrance. The overflow lane is optional; its mouth is the unique `r` cell
/// closest to the entrance.
/// Both lanes are ordered by BFS distance from their mouth, so every distance
/// must belong to exactly one cell — otherwise the order would be ambiguous.
fn order_queue_lanes(
    entrance: Pos,
    primary_cells: &[Pos],
    overflow_cells: &[Pos],
) -> Result<(Vec<Pos>, Vec<Pos>), MapError> {
    if primary_cells.is_empty() {
        return Err(MapError {
            line: 1,
            message:
                "queue primary lane (`q`) is empty: the map needs a queue next to the entrance"
                    .to_string(),
        });
    }

    let mouths: Vec<Pos> = Dir::ALL
        .into_iter()
        .map(|dir| entrance.step(dir))
        .filter(|pos| primary_cells.contains(pos))
        .collect();
    let primary_mouth = match mouths.as_slice() {
        [mouth] => *mouth,
        [] => {
            return Err(MapError {
                line: 1,
                message: format!(
                    "queue primary lane has no mouth: no `q` is orthogonally adjacent to the entrance {entrance}"
                ),
            })
        }
        many => {
            return Err(MapError {
                line: 1,
                message: format!(
                    "queue primary lane has {} mouths next to the entrance {entrance}: {}",
                    many.len(),
                    join_positions(many)
                ),
            })
        }
    };
    let primary = order_lane(primary_cells, primary_mouth, "primary")?;

    let overflow = if overflow_cells.is_empty() {
        Vec::new()
    } else {
        let closest = overflow_cells
            .iter()
            .map(|pos| (pos.manhattan(entrance), *pos))
            .min()
            .map(|(_, pos)| pos)
            .expect("overflow lane is not empty");
        let distance = closest.manhattan(entrance);
        let tied: Vec<Pos> = overflow_cells
            .iter()
            .copied()
            .filter(|pos| pos.manhattan(entrance) == distance)
            .collect();
        if tied.len() > 1 {
            return Err(MapError {
                line: 1,
                message: format!(
                    "queue overflow lane has {} mouths equally close to the entrance {entrance}: {}",
                    tied.len(),
                    join_positions(&tied)
                ),
            });
        }
        order_lane(overflow_cells, closest, "overflow")?
    };

    if !overflow.is_empty() && !lanes_connected(primary_cells, overflow_cells) {
        return Err(MapError {
            line: 1,
            message: format!(
                "queue lanes are not connected: primary mouth {primary_mouth} and overflow mouth {} never meet",
                overflow[0]
            ),
        });
    }

    Ok((primary, overflow))
}

/// BFS from `mouth` through cells of one lane. Distances must be unique: two
/// cells at the same distance would leave their queue order undefined.
fn order_lane(cells: &[Pos], mouth: Pos, lane: &str) -> Result<Vec<Pos>, MapError> {
    let mut distances: BTreeMap<Pos, usize> = BTreeMap::new();
    distances.insert(mouth, 0);
    let mut frontier = vec![mouth];
    while !frontier.is_empty() {
        let mut next = Vec::new();
        for pos in frontier {
            let distance = distances[&pos];
            for dir in Dir::ALL {
                let neighbour = pos.step(dir);
                if !cells.contains(&neighbour) || distances.contains_key(&neighbour) {
                    continue;
                }
                distances.insert(neighbour, distance + 1);
                next.push(neighbour);
            }
        }
        frontier = next;
    }
    if distances.len() != cells.len() {
        let unreachable: Vec<Pos> = cells
            .iter()
            .copied()
            .filter(|pos| !distances.contains_key(pos))
            .collect();
        return Err(MapError {
            line: 1,
            message: format!(
                "queue {lane} lane is not connected to its mouth {mouth}: {} unreachable",
                join_positions(&unreachable)
            ),
        });
    }
    let mut by_distance: BTreeMap<usize, Vec<Pos>> = BTreeMap::new();
    for (pos, distance) in &distances {
        by_distance.entry(*distance).or_default().push(*pos);
    }
    if let Some((distance, tied)) = by_distance.iter().find(|(_, cells)| cells.len() > 1) {
        return Err(MapError {
            line: 1,
            message: format!(
                "queue {lane} lane has {} cells at distance {distance} from its mouth {mouth}: {}",
                tied.len(),
                join_positions(tied)
            ),
        });
    }
    Ok(by_distance.into_values().flatten().collect())
}

/// Whether the two lanes touch each other, so a waiter can shove their way
/// from the overflow lane into the primary one.
fn lanes_connected(primary: &[Pos], overflow: &[Pos]) -> bool {
    overflow
        .iter()
        .any(|pos| Dir::ALL.iter().any(|dir| primary.contains(&pos.step(*dir))))
}

fn join_positions(cells: &[Pos]) -> String {
    cells
        .iter()
        .map(|pos| pos.to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    const TINY: &str = "\
# a tiny map
grid
#####
#.1.#
#+.E#
###q#
###r#
";

    #[test]
    fn parses_objects_and_entrance() {
        let def = parse(TINY).expect("tiny map parses");
        assert_eq!((def.map.width(), def.map.height()), (5, 5));
        assert_eq!(def.queue_primary, vec![Pos::new(3, 3)]);
        assert_eq!(def.queue_overflow, vec![Pos::new(3, 4)]);
        assert_eq!(def.entrance, Pos::new(3, 2));
        assert_eq!(def.objects[0], Some(Object::Wall { damage: 0 }));
        assert_eq!(
            def.objects[def.map.index(Pos::new(2, 1)).unwrap()],
            Some(Object::Toilet {
                level: 1,
                progress: 0
            })
        );
        assert_eq!(
            def.objects[def.map.index(Pos::new(1, 2)).unwrap()],
            Some(Object::Door {
                open: false,
                damage: 0
            })
        );
        assert_eq!(def.map.terrain_at(Pos::new(3, 2)), Some(Terrain::NoBuild));
    }

    #[test]
    fn rejects_broken_maps() {
        assert!(parse("grid\n##\n#\n").is_err(), "ragged rows");
        assert!(parse("grid\n##\n").is_err(), "no entrance");
        assert!(parse("grid\n#E#\nEE#\n").is_err(), "two entrances");
        assert!(parse("grid\n#Z#\n").is_err(), "unknown character");
        assert!(parse("grid\n.E.\n").is_err(), "no queue lane");
        assert!(parse("###\n").is_err(), "no grid marker");
    }

    #[test]
    fn no_build_rects_cover_no_build_cells() {
        let def = parse("grid\n:E.\n:q.\n:r.\n").unwrap();
        let rects = def.map.no_build_rects();
        assert_eq!(
            rects,
            vec![loo_proto::Rect {
                x: 0,
                y: 0,
                w: 2,
                h: 3
            }]
        );
    }
}
