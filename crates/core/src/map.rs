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
//! that level, `.` buildable floor, `:` no-build floor, `E` entrance (no-build
//! floor). Exactly one `E` is required.

use crate::state::Object;
use loo_proto::{Dir, Pos};
use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Terrain {
    Buildable,
    NoBuild,
}

#[derive(Clone, Debug, PartialEq, Eq)]
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
                'E' => {
                    if entrance.replace(pos).is_some() {
                        return Err(MapError {
                            line: *line_no,
                            message: "map has more than one entrance".to_string(),
                        });
                    }
                    (Terrain::NoBuild, None)
                }
                '#' => (Terrain::Buildable, Some(Object::Wall)),
                '+' => (Terrain::Buildable, Some(Object::Door { open: false })),
                '\'' => (Terrain::Buildable, Some(Object::Door { open: true })),
                '1'..='5' => (
                    Terrain::Buildable,
                    Some(Object::Toilet {
                        level: ch.to_digit(10).unwrap_or(1) as u8,
                    }),
                ),
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

    Ok(MapDef {
        map: Map {
            width,
            height,
            terrain,
        },
        objects,
        entrance,
    })
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
#####
";

    #[test]
    fn parses_objects_and_entrance() {
        let def = parse(TINY).expect("tiny map parses");
        assert_eq!((def.map.width(), def.map.height()), (5, 4));
        assert_eq!(def.entrance, Pos::new(3, 2));
        assert_eq!(def.objects[0], Some(Object::Wall));
        assert_eq!(
            def.objects[def.map.index(Pos::new(2, 1)).unwrap()],
            Some(Object::Toilet { level: 1 })
        );
        assert_eq!(
            def.objects[def.map.index(Pos::new(1, 2)).unwrap()],
            Some(Object::Door { open: false })
        );
        assert_eq!(def.map.terrain_at(Pos::new(3, 2)), Some(Terrain::NoBuild));
    }

    #[test]
    fn rejects_broken_maps() {
        assert!(parse("grid\n##\n#\n").is_err(), "ragged rows");
        assert!(parse("grid\n##\n").is_err(), "no entrance");
        assert!(parse("grid\n#E#\nEE#\n").is_err(), "two entrances");
        assert!(parse("grid\n#Z#\n").is_err(), "unknown character");
        assert!(parse("###\n").is_err(), "no grid marker");
    }

    #[test]
    fn no_build_rects_cover_no_build_cells() {
        let def = parse("grid\n:E.\n:..\n").unwrap();
        let rects = def.map.no_build_rects();
        assert_eq!(
            rects,
            vec![
                loo_proto::Rect {
                    x: 0,
                    y: 0,
                    w: 2,
                    h: 1
                },
                loo_proto::Rect {
                    x: 0,
                    y: 1,
                    w: 1,
                    h: 1
                },
            ]
        );
    }
}
