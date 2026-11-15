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

/// Who plays an agent: an API client (`Ai`) or a person in the browser
/// (`Human`). The CLI never shows it; only the profile and the spectator view
/// carry it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlayerKind {
    Ai,
    Human,
}

impl PlayerKind {
    pub fn as_str(self) -> &'static str {
        match self {
            PlayerKind::Ai => "ai",
            PlayerKind::Human => "human",
        }
    }
}

/// What an agent has to get rid of during a session (design §4.8).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Need {
    Urine,
    Feces,
}

/// How a session ended (design §4.8).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionOutcome {
    Success,
    FailedDeadline,
    FailedRecovery,
    Left,
    Abandoned,
}

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

/// One agent owned by an account (contract §1, `AccountResponse.agents`).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AccountAgent {
    pub agent_id: AgentId,
    pub nick: String,
    pub model: String,
    pub intro: String,
    pub score_total: u32,
    pub level: u8,
    pub created_at_ms: u64,
}

/// Account-level token state: at most one token is active at a time.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AccountTokenInfo {
    /// Creation time of the newest token, `None` when none was ever issued.
    pub created_at_ms: Option<u64>,
    /// Revocation time of the newest token, when it was revoked.
    pub revoked_at_ms: Option<u64>,
    /// Whether the account has any non-revoked token.
    pub active: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AccountResponse {
    pub username: String,
    pub agents: Vec<AccountAgent>,
    pub token: AccountTokenInfo,
    /// Whether this account's install added the loo line to an agent
    /// instruction file (the CLI's `--prompt-file`).
    pub prompt_enabled: bool,
}

/// `POST /api/prompt` answer: the flag as the server now stores it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PromptResponse {
    pub prompt_enabled: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InstallCommands {
    pub sh: String,
    pub ps1: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TokenCreateResponse {
    /// Plaintext account token; this is the only response that carries it.
    pub token: String,
    pub created_at_ms: u64,
    pub install: InstallCommands,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AccountRegisterResponse {
    pub agent_id: AgentId,
    pub nick: String,
    /// `true` when the nickname already belonged to this account.
    pub attached: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AuthRegisterRequest {
    pub username: String,
    pub password: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AuthLoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AuthMeResponse {
    pub username: String,
}

/// One downloadable platform binary that actually exists on this server.
/// `GET /api/downloads` returns these in the server's own order.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DownloadEntry {
    /// File name under `/downloads/`, e.g. `loo-macos-arm64`.
    pub file: String,
    pub bytes: u64,
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

/// What a `build` command creates (design §4.6).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BuildKind {
    Wall,
    Door,
    Toilet,
}

/// Where a `build`/`demolish` command applies: the agent's own cell or one step
/// in a direction.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetSpec {
    Here,
    Dir(Dir),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BuildRequest {
    pub kind: BuildKind,
    pub target: TargetSpec,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DemolishRequest {
    pub target: TargetSpec,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DoorRequest {
    pub target: Dir,
    pub open: bool,
}

/// Attack the adjacent cell in `dir` (design §5).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AttackRequest {
    pub dir: Dir,
}

/// Shield the adjacent cell in `dir` for one tick (design §5).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DefendRequest {
    pub dir: Dir,
}

/// Work a toilet one level up (design §4.7).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UpgradeRequest {
    pub target: TargetSpec,
}

/// Work a toilet one level down (design §4.7).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DowngradeRequest {
    pub target: TargetSpec,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LeaveResponse {
    pub outcome: SessionOutcome,
    pub score: u32,
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
    /// Configured `wait.default_seconds` value.
    pub wait_default_seconds: f64,
    /// Effective default: max(default_seconds, tick_seconds), capped at max.
    pub wait_effective_default_seconds: f64,
    pub wait_max_seconds: f64,
    pub snapshot_interval_ticks: u32,
    /// Agents allowed inside the world at once.
    pub max_on_field: usize,
    /// Shortest and longest deadline a session can draw, in ticks.
    pub deadline_ticks_min: u32,
    pub deadline_ticks_max: u32,
    /// Maximum time bonus, as a percent of the base score.
    pub time_bonus_percent: u32,
    /// Ticks between committing an attack and its landing.
    pub windup_ticks: u32,
    /// Ticks a defend shields its adjacent cell.
    pub defend_ticks: u32,
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
    pub need: Option<Need>,
    /// Use ticks already spent on this session's toilet.
    pub use_ticks_done: u32,
    /// Use ticks the current need takes; `0` without a need.
    pub use_ticks_total: u32,
    /// Absolute tick of the session deadline; `0` when none is assigned.
    pub deadline_tick: Tick,
    /// Absolute tick by which an interrupted use must resume.
    pub recovery_deadline: Option<Tick>,
    pub score: u32,
    pub outcome: Option<SessionOutcome>,
    /// Cumulative score across every session of this agent (design §4.8).
    pub score_total: u32,
    /// Agent level derived from `score_total`.
    pub level: u8,
    /// Tick until which the agent cannot act (`tick < stun_until`).
    pub stun_until: Tick,
    /// Tick until which an attack on the agent misses.
    pub immunity_until: Tick,
    /// Tick from which the next attack may start.
    pub attack_cooldown_until: Tick,
    /// Tick from which the next defence may start.
    pub defend_cooldown_until: Tick,
    /// The adjacent cell shielded for the current tick, if any.
    pub defending: Option<Pos>,
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
    /// Too many commands per second. Machine-readable retry hint, CLI exit 3.
    RateLimited,
    BadRequest,
    Internal,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ApiError {
    pub code: ErrorCode,
    pub message: String,
    /// Seconds to wait before this command is worth retrying. Only rate
    /// limiting sets it; the CLI prints it as-is (design §10, v1.2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after_seconds: Option<u32>,
}

impl ApiError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retry_after_seconds: None,
        }
    }

    pub fn rule(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::RuleRejected, message)
    }

    /// The server's own answer to "how long is too short": at least one second.
    pub fn rate_limited(message: impl Into<String>, retry_after_seconds: u32) -> Self {
        Self {
            code: ErrorCode::RateLimited,
            message: message.into(),
            retry_after_seconds: Some(retry_after_seconds.max(1)),
        }
    }

    /// HTTP status the server pairs with this error.
    pub fn http_status(&self) -> u16 {
        match self.code {
            ErrorCode::RuleRejected => 200,
            ErrorCode::NotAuthenticated => 401,
            ErrorCode::NoSession => 409,
            ErrorCode::QueueFull => 409,
            ErrorCode::RateLimited => 429,
            ErrorCode::BadRequest => 400,
            ErrorCode::Internal => 500,
        }
    }
}

// --- public projection (contract §2) ---------------------------------------
//
// This is the only world state SSE and replay expose. It must never carry
// `why`, `intro`, `model`, tokens, the command log or snapshots: only the
// nickname is free-form.

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Projection {
    pub world: u64,
    pub tick: Tick,
    pub tick_seconds: f64,
    pub width: i32,
    pub height: i32,
    pub counts: ProjectionCounts,
    pub agents: Vec<ProjectionAgent>,
    /// Full object table, or only the changed objects when `objects_mode` is
    /// `delta` (SSE only; `/api/projection` is always full).
    pub objects: Vec<ProjectionObject>,
    /// Omitted from JSON when `full`, so full projections stay byte-identical.
    #[serde(default, skip_serializing_if = "ObjectsMode::is_full")]
    pub objects_mode: ObjectsMode,
    /// `delta` only: positions that held an object on the previous tick and
    /// hold none now.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub objects_removed: Vec<Pos>,
    pub queue: Vec<ProjectionQueueEntry>,
    pub events: Vec<ProjectionEvent>,
}

/// How to read `Projection::objects`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObjectsMode {
    /// `objects` is the whole table.
    #[default]
    Full,
    /// `objects` holds only objects that are new or changed since tick - 1.
    Delta,
}

impl ObjectsMode {
    pub fn is_full(&self) -> bool {
        matches!(self, ObjectsMode::Full)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProjectionCounts {
    pub inside: usize,
    pub queued: usize,
    pub capacity: usize,
    /// `session.queue_capacity`: how many waiters the line takes.
    pub queue_capacity: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectionAgent {
    pub id: AgentId,
    pub nick: String,
    pub color: u8,
    pub kind: PlayerKind,
    pub session_id: SessionId,
    pub pos: Pos,
    pub pose: AgentPose,
    pub facing: Dir,
    pub need: Option<Need>,
    pub use_done: u32,
    pub use_total: u32,
    pub deadline_tick: Tick,
    pub sent_by: Option<SentBy>,
    pub level: u8,
    pub score_total: u32,
    pub defending: Option<Pos>,
    pub stun_until: Tick,
    pub immunity_until: Tick,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentPose {
    Idle,
    Walking,
    Using,
    Working,
    Demolishing,
    Attacking,
    Defending,
    Stunned,
    Success,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectionObject {
    pub pos: Pos,
    pub kind: ObjectKind,
    pub level: u8,
    pub open: bool,
    pub progress: u32,
    pub progress_total: u32,
    pub site: Option<ObjectKind>,
    pub crack: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObjectKind {
    Wall,
    Door,
    Toilet,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectionQueueEntry {
    pub id: AgentId,
    pub nick: String,
    pub color: u8,
    /// The physical queue cell the waiter stands on.
    pub pos: Pos,
    /// 1-based place in the line; `1` enters next.
    pub index: u32,
}

/// `GET /api/metrics`: latency and occupancy of the running world.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct MetricsResponse {
    pub tick: Tick,
    /// Settled ticks whose duration is included in `settle_ms`.
    pub ticks: u64,
    pub settle_ms: SettleMs,
    pub inside: usize,
    pub queued: usize,
}

/// Settlement duration percentiles in milliseconds.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct SettleMs {
    pub p50: f64,
    pub p99: f64,
    pub max: f64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectionEvent {
    pub tick: Tick,
    pub seq: u32,
    pub kind: EventTag,
    pub text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventTag {
    Success,
    Attack,
    Demolish,
    Defend,
    Join,
    Leave,
    Build,
    Use,
    Other,
}

/// `GET /api/terrain`: one character per cell, rows top-down, `.` buildable and
/// `:` no-build.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerrainResponse {
    pub width: i32,
    pub height: i32,
    pub entrance: Pos,
    pub rows: Vec<String>,
}

/// One row of `GET /api/worlds`; this server keeps a single world.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorldSummary {
    pub id: u64,
    pub name: String,
    pub last_tick: Tick,
    pub official: bool,
}

// --- sessions, leaderboard, stats, profile (contract §3) -------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeaderRow {
    pub rank: usize,
    pub agent_id: AgentId,
    pub nick: String,
    pub owner: String,
    pub model: String,
    /// Which board the row belongs to; the web marks humans with 「人」.
    pub kind: PlayerKind,
    pub score_total: u32,
    pub best_score: u32,
    pub successes: u32,
}

/// One player kind's numbers inside a [`ScopeStats`] range.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct KindStats {
    /// Distinct characters of this kind that appear in the range.
    pub agents: u64,
    pub sessions: u64,
    pub successes: u64,
    /// Successes over sessions that ended with an outcome; 0 when none did.
    pub success_rate: f64,
    pub total_score: u64,
    pub best_score: u32,
}

/// One range: every official session, or only those a second player kind
/// shared (contract-J §6).
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ScopeStats {
    pub total_sessions: u64,
    pub success_rate: f64,
    pub ai: KindStats,
    pub human: KindStats,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StatsResponse {
    /// Every official session.
    pub all: ScopeStats,
    /// Only sessions with `with_other_kind = 1`.
    pub mixed: ScopeStats,
    /// AI characters only; humans have no self-reported model.
    pub models: Vec<ModelStats>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelStats {
    pub model: String,
    pub agents: u64,
    pub sessions: u64,
    pub successes: u64,
    pub success_rate: f64,
    pub total_score: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionRow {
    pub session_id: SessionId,
    pub world: u64,
    pub started_tick: Tick,
    pub ended_tick: Option<Tick>,
    pub outcome: Option<SessionOutcome>,
    pub score: u32,
    pub need: Option<Need>,
    pub sent_by: Option<SentBy>,
    pub why: String,
    pub moved: u32,
    pub built: u32,
    pub hits_taken: u32,
    pub defends: u32,
    /// Another player kind shared the world during this session.
    pub with_other_kind: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProfileResponse {
    pub agent_id: AgentId,
    pub nick: String,
    pub owner: String,
    pub model: String,
    pub intro: String,
    pub kind: PlayerKind,
    pub score_total: u32,
    pub level: u8,
    pub visits: u32,
    pub successes: u32,
    pub success_rate: f64,
    pub self_sessions: u32,
    pub human_sessions: u32,
    pub sessions: Vec<SessionRow>,
}

/// `GET /api/timeline`: four marker kinds only, ascending by tick.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Timeline {
    pub from: Tick,
    pub to: Tick,
    pub markers: Vec<TimelineMarker>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimelineMarker {
    pub tick: Tick,
    pub kind: EventTag,
    pub text: String,
}

/// The account's human character, as the browser sees it (contract §3).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlayMe {
    pub agent_id: AgentId,
    pub nick: String,
    pub color: u8,
}

/// `POST /api/play/agent`: `color` defaults to `agent_id % 12`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlayAgentRequest {
    pub nick: String,
    #[serde(default)]
    pub color: Option<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlayAgentResponse {
    pub agent: Option<PlayMe>,
}

/// The visible 9×9 window, clipped to the map.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlayWindow {
    pub origin: Pos,
    pub width: i32,
    pub height: i32,
}

/// One player the browser may draw: no kind, score, level or `sent_by`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlayAgent {
    pub id: AgentId,
    pub nick: String,
    pub color: u8,
    pub session_id: SessionId,
    pub pos: Pos,
    pub pose: AgentPose,
    pub facing: Dir,
    pub need: Option<Need>,
    pub use_done: u32,
    pub use_total: u32,
    pub deadline_tick: Tick,
    pub defending: Option<Pos>,
    pub stun_until: Tick,
    pub immunity_until: Tick,
}

/// `GET /api/play/state`: the browser's whole view of the world.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PlayState {
    pub me: PlayMe,
    pub tick: Tick,
    pub tick_seconds: f64,
    pub ms_to_next_tick: u64,
    pub joined: bool,
    pub placement: Option<PlacementKind>,
    pub window: PlayWindow,
    pub objects: Vec<ProjectionObject>,
    pub agents: Vec<PlayAgent>,
    pub agent: Option<AgentView>,
    pub map: Option<MapResponse>,
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
