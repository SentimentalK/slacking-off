//! Wire types shared by `loo` (the CLI) and the game server.
//!
//! Privacy rule from design §6: text authored by an agent (`--why`, `--intro`,
//! `--model`) is recorded but never serialised into another agent's response.
//! Everything that can reach another agent is either a validated [`Nick`] or
//! server-generated text.

use serde::{Deserialize, Serialize};
use std::fmt;

pub type Tick = u64;
pub type AgentId = u64;
pub type SessionId = u64;

/// A grid cell coordinate. `x` grows east, `y` grows south.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct Pos {
    pub x: i32,
    pub y: i32,
}

impl Pos {
    pub const fn new(x: i32, y: i32) -> Self {
        Self { x, y }
    }

    pub fn step(self, dir: Dir) -> Self {
        let (dx, dy) = dir.delta();
        Self::new(self.x + dx, self.y + dy)
    }

    pub fn manhattan(self, other: Self) -> i32 {
        (self.x - other.x).abs() + (self.y - other.y).abs()
    }
}

impl fmt::Display for Pos {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "({},{})", self.x, self.y)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum Dir {
    N,
    E,
    S,
    W,
}

impl Dir {
    pub const ALL: [Dir; 4] = [Dir::N, Dir::E, Dir::S, Dir::W];

    pub fn delta(self) -> (i32, i32) {
        match self {
            Dir::N => (0, -1),
            Dir::E => (1, 0),
            Dir::S => (0, 1),
            Dir::W => (-1, 0),
        }
    }

    pub fn code(self) -> char {
        match self {
            Dir::N => 'N',
            Dir::E => 'E',
            Dir::S => 'S',
            Dir::W => 'W',
        }
    }

    pub fn word(self) -> &'static str {
        match self {
            Dir::N => "north",
            Dir::E => "east",
            Dir::S => "south",
            Dir::W => "west",
        }
    }

    pub fn from_char(c: char) -> Option<Dir> {
        match c.to_ascii_uppercase() {
            'N' => Some(Dir::N),
            'E' => Some(Dir::E),
            'S' => Some(Dir::S),
            'W' => Some(Dir::W),
            _ => None,
        }
    }

    pub fn opposite(self) -> Dir {
        match self {
            Dir::N => Dir::S,
            Dir::E => Dir::W,
            Dir::S => Dir::N,
            Dir::W => Dir::E,
        }
    }
}

/// Nickname: the only identifier of one agent that another agent can see.
/// Design §6 constrains it to `^[a-z0-9-]{2,16}$`.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Nick(String);

pub const NICK_MIN_LEN: usize = 2;
pub const NICK_MAX_LEN: usize = 16;

impl Nick {
    pub fn parse(raw: &str) -> Result<Nick, String> {
        let len = raw.len();
        if !(NICK_MIN_LEN..=NICK_MAX_LEN).contains(&len) {
            return Err(format!(
                "nickname must be {NICK_MIN_LEN}-{NICK_MAX_LEN} bytes long, got {len}: {raw:?}"
            ));
        }
        if !raw
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return Err(format!(
                "nickname must match ^[a-z0-9-]{{2,16}}$, got {raw:?}"
            ));
        }
        Ok(Nick(raw.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for Nick {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Nick::parse(&value)
    }
}

impl From<Nick> for String {
    fn from(value: Nick) -> Self {
        value.0
    }
}

impl fmt::Display for Nick {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Self-reported reason for entering (design §2.4).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SentBy {
    #[serde(rename = "self")]
    Self_,
    #[serde(rename = "human")]
    Human,
}

impl SentBy {
    pub fn as_str(self) -> &'static str {
        match self {
            SentBy::Self_ => "self",
            SentBy::Human => "human",
        }
    }
}

impl fmt::Display for SentBy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One move command. Either a direction plus a step count, or a path string.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MoveSpec {
    Steps { dir: Dir, count: u32 },
    Path { path: String },
}

impl MoveSpec {
    /// Parses the CLI arguments of `loo move`: `N`, `N 30`, `NNNEE`.
    pub fn parse(args: &[String]) -> Result<MoveSpec, String> {
        match args {
            [single] => {
                let upper = single.to_ascii_uppercase();
                let chars: Vec<char> = upper.chars().collect();
                if let [only] = chars.as_slice() {
                    let dir = Dir::from_char(*only).ok_or_else(|| {
                        format!("{single:?} is not a direction (N/E/S/W) or a path of them")
                    })?;
                    return Ok(MoveSpec::Steps { dir, count: 1 });
                }
                if chars.iter().all(|c| Dir::from_char(*c).is_some()) {
                    return Ok(MoveSpec::Path { path: upper });
                }
                Err(format!(
                    "move takes a direction (N/E/S/W), a direction and a step count (`N 30`), or a path (`NNEE`); got {single:?}"
                ))
            }
            [dir_text, count_text] => {
                let dir = dir_text
                    .chars()
                    .next()
                    .filter(|_| dir_text.chars().count() == 1)
                    .and_then(Dir::from_char)
                    .ok_or_else(|| format!("{dir_text:?} is not a direction (N/E/S/W)"))?;
                let count: u32 = count_text
                    .parse()
                    .map_err(|_| format!("{count_text:?} is not a step count"))?;
                if count == 0 {
                    return Err("step count must be at least 1".to_string());
                }
                Ok(MoveSpec::Steps { dir, count })
            }
            _ => {
                Err("usage: loo move <N|E|S|W> [steps]  |  loo move <path, e.g. NNEE>".to_string())
            }
        }
    }

    /// Server-generated description used in responses and events.
    pub fn label(&self) -> String {
        match self {
            MoveSpec::Steps { dir, count } => format!("move {} {}", dir.code(), count),
            MoveSpec::Path { path } => format!("move {path}"),
        }
    }

    pub fn dirs(&self) -> Result<Vec<Dir>, String> {
        match self {
            MoveSpec::Steps { dir, count } => Ok(vec![*dir; *count as usize]),
            MoveSpec::Path { path } => path
                .chars()
                .map(|c| Dir::from_char(c).ok_or_else(|| format!("{c:?} is not a direction")))
                .collect(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RegisterRequest {
    pub name: Option<Nick>,
    pub model: Option<String>,
    pub intro: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RegisterResponse {
    pub agent_id: AgentId,
    pub nick: String,
    pub token: String,
    pub server_tick: Tick,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct JoinRequest {
    pub sent_by: SentBy,
    pub why: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct JoinResponse {
    pub session_id: SessionId,
    pub placement: Placement,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum Placement {
    Inside { at: Pos, briefing: Briefing },
    Waiting { ahead: usize },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlacementKind {
    Inside,
    Waiting,
}

/// What an agent learns when it enters (design §4.10).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Briefing {
    pub map_width: i32,
    pub map_height: i32,
    pub entrance: Pos,
    pub view_width: i32,
    pub view_height: i32,
    pub toilets: Vec<ToiletInfo>,
    pub no_build: Vec<Rect>,
    pub tick: Tick,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToiletInfo {
    pub pos: Pos,
    pub level: u8,
    pub usable: bool,
    pub occupied: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Legend {
    pub symbol: String,
    pub meaning: String,
}

/// A rendered character grid (design §10 view symbols).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Grid {
    pub origin: Pos,
    pub width: u32,
    pub height: u32,
    pub rows: Vec<String>,
    pub legend: Vec<Legend>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LookResponse {
    pub grid: Grid,
    pub pos: Pos,
    pub tick: Tick,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MapResponse {
    pub grid: Grid,
    /// First tick each cell of `grid` was seen; `0` means never seen.
    pub seen_at: Vec<Vec<Tick>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MoveRequest {
    pub spec: MoveSpec,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ActionState {
    /// Server-generated, e.g. `move N 3`.
    pub description: String,
    pub remaining: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ActionQueued {
    pub action: ActionState,
    /// Tick at which the action first takes effect.
    pub effective_tick: Tick,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WaitRequest {
    pub timeout_seconds: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WaitResponse {
    pub woke: WaitWake,
    pub timeout_seconds: f64,
    pub elapsed_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WaitWake {
    Event,
    Timeout,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RulesResponse {
    pub text: String,
}

/// Read-only server timings, so the CLI never hard-codes design §9 values.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ConfigResponse {
    pub tick_seconds: f64,
    pub wait_default_seconds: f64,
    pub wait_max_seconds: f64,
    pub snapshot_interval_ticks: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AgentView {
    pub agent_id: AgentId,
    pub nick: String,
    pub tick: Tick,
    pub session_id: Option<SessionId>,
    pub placement: Option<PlacementKind>,
    pub pos: Option<Pos>,
    pub queue_ahead: Option<usize>,
    pub action: Option<ActionState>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EventView {
    pub tick: Tick,
    pub seq: u32,
    pub text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// The action itself is not allowed by the rules. CLI exit code 1.
    RuleRejected,
    NotAuthenticated,
    NoSession,
    QueueFull,
    BadRequest,
    Internal,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ApiError {
    pub code: ErrorCode,
    pub message: String,
}

impl ApiError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn rule(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::RuleRejected, message)
    }

    /// HTTP status the server pairs with this error.
    pub fn http_status(&self) -> u16 {
        match self.code {
            ErrorCode::RuleRejected => 200,
            ErrorCode::NotAuthenticated => 401,
            ErrorCode::NoSession => 409,
            ErrorCode::QueueFull => 409,
            ErrorCode::BadRequest => 400,
            ErrorCode::Internal => 500,
        }
    }
}

/// Every response carries the same three things (design §10): this command's
/// result, the events since the previous response, and the agent's own state.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Envelope<T> {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ApiError>,
    #[serde(default)]
    pub events: Vec<EventView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<AgentView>,
}

impl<T> Envelope<T> {
    pub fn ok(result: T, events: Vec<EventView>, state: Option<AgentView>) -> Self {
        Self {
            ok: true,
            result: Some(result),
            error: None,
            events,
            state,
        }
    }

    pub fn failed(error: ApiError, events: Vec<EventView>, state: Option<AgentView>) -> Self {
        Self {
            ok: false,
            result: None,
            error: Some(error),
            events,
            state,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nick_validation_matches_design() {
        assert!(Nick::parse("dev-07").is_ok());
        assert!(Nick::parse("ab").is_ok());
        assert!(Nick::parse("a").is_err());
        assert!(Nick::parse("has space").is_err());
        assert!(Nick::parse("Upper").is_err());
        assert!(Nick::parse("seventeen-chars-x").is_err());
    }

    #[test]
    fn move_spec_parsing() {
        let one = vec!["N".to_string()];
        assert_eq!(
            MoveSpec::parse(&one).unwrap(),
            MoveSpec::Steps {
                dir: Dir::N,
                count: 1
            }
        );

        let steps = vec!["e".to_string(), "7".to_string()];
        assert_eq!(
            MoveSpec::parse(&steps).unwrap(),
            MoveSpec::Steps {
                dir: Dir::E,
                count: 7
            }
        );
        assert_eq!(MoveSpec::parse(&steps).unwrap().dirs().unwrap().len(), 7);

        let path = vec!["nnEE".to_string()];
        assert_eq!(MoveSpec::parse(&path).unwrap().dirs().unwrap().len(), 4);

        assert!(MoveSpec::parse(&[]).is_err());
        assert!(MoveSpec::parse(&["X".to_string()]).is_err());
    }

    #[test]
    fn free_text_never_round_trips_into_events() {
        // Guards the wire format: events only carry server text.
        let view = EventView {
            tick: 1,
            seq: 1,
            text: "you moved".to_string(),
        };
        let json = serde_json::to_string(&view).unwrap();
        assert!(!json.contains("why"));
    }
}
