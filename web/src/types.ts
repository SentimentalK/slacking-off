// Wire types mirrored field-for-field from `.conductor/contract-E.md` §2–§3.
// Field names and enum spellings come from the Rust serde derives in
// `crates/proto/src/lib.rs`; do not rename them here.

export type Tick = number;
export type AgentId = number;
export type SessionId = number;

export interface Pos {
  x: number;
  y: number;
}

/** `Need` — snake_case serde. */
export type Need = 'urine' | 'feces';

/** `SentBy` — serde spellings are `self` / `human`. */
export type SentBy = 'self' | 'human';

/** `Dir` — serialised as the bare variant name. */
export type Dir = 'N' | 'E' | 'S' | 'W';

/** `AgentPose` — snake_case serde. */
export type AgentPose =
  | 'idle'
  | 'walking'
  | 'using'
  | 'working'
  | 'demolishing'
  | 'attacking'
  | 'defending'
  | 'stunned'
  | 'success';

/** `ObjectKind` — snake_case serde. */
export type ObjectKind = 'wall' | 'door' | 'toilet';

/** `EventTag` — snake_case serde. */
export type EventTag =
  | 'success'
  | 'attack'
  | 'demolish'
  | 'defend'
  | 'join'
  | 'leave'
  | 'build'
  | 'use'
  | 'other';

/** `SessionOutcome` — snake_case serde. */
export type SessionOutcome =
  | 'success'
  | 'failed_deadline'
  | 'failed_recovery'
  | 'left'
  | 'abandoned';

/** `GET /api/terrain` — rows are top-down, `.` buildable, `:` no-build, `~` wilderness (static). */
export interface Terrain {
  width: number;
  height: number;
  /** Where agents walk in; the spectator camera starts here. */
  entrance: Pos;
  rows: string[];
}

export interface ProjectionCounts {
  inside: number;
  queued: number;
  /** `config.max_on_field`. */
  capacity: number;
  /** `session.queue_capacity`. */
  queue_capacity: number;
}

export interface ProjectionAgent {
  id: AgentId;
  nick: string;
  /** 0..11, indexes `AGENT_COLORS`. */
  color: number;
  session_id: SessionId;
  pos: Pos;
  pose: AgentPose;
  facing: Dir;
  kind: PlayerKind;
  need: Need | null;
  use_done: number;
  use_total: number;
  deadline_tick: Tick;
  sent_by: SentBy | null;
  level: number;
  score_total: number;
  defending: Pos | null;
  stun_until: Tick;
  immunity_until: Tick;
}

export interface ProjectionObject {
  pos: Pos;
  kind: ObjectKind;
  level: number;
  open: boolean;
  progress: number;
  progress_total: number;
  site: ObjectKind | null;
  crack: boolean;
}

export interface ProjectionQueueEntry {
  id: AgentId;
  nick: string;
  color: number;
  /** The physical queue cell the waiter stands on. */
  pos: Pos;
  /** 1-based place in the line; `1` enters next. */
  index: number;
}

export interface ProjectionEvent {
  tick: Tick;
  seq: number;
  kind: EventTag;
  text: string;
}

export interface Projection {
  world: number;
  tick: Tick;
  tick_seconds: number;
  width: number;
  height: number;
  counts: ProjectionCounts;
  agents: ProjectionAgent[];
  /** Whole object table; with `objects_mode: 'delta'`, only new/changed objects. */
  objects: ProjectionObject[];
  /** SSE only. Omitted means `full` (and `/api/projection` is always full). */
  objects_mode?: 'full' | 'delta';
  /** `delta` only: positions whose object is gone since tick - 1. */
  objects_removed?: Pos[];
  queue: ProjectionQueueEntry[];
  events: ProjectionEvent[];
}

/** `GET /api/worlds` — `WorldSummary`. */
export interface WorldSummary {
  id: number;
  name: string;
  last_tick: Tick;
  official: boolean;
}

/** `GET /api/timeline` only carries the four marker-worthy tags. */
export type MarkerKind = 'success' | 'attack' | 'demolish' | 'defend';

export interface TimelineMarker {
  tick: Tick;
  kind: MarkerKind;
  text: string;
}

/** One closed interval of replayable ticks: every tick in it holds a session. */
export interface TimelineSpan {
  from: Tick;
  to: Tick;
}

export interface Timeline {
  from: Tick;
  to: Tick;
  markers: TimelineMarker[];
  /** Closed, ascending, non-overlapping replayable intervals. */
  spans: TimelineSpan[];
}

// --- §1 accounts -----------------------------------------------------------

export interface AccountAgent {
  agent_id: AgentId;
  nick: string;
  model: string;
  intro: string;
  score_total: number;
  level: number;
  created_at_ms: number;
}

export interface AccountTokenInfo {
  created_at_ms: number | null;
  revoked_at_ms: number | null;
  active: boolean;
}

export interface AccountResponse {
  username: string;
  agents: AccountAgent[];
  token: AccountTokenInfo;
  /** Whether the install appended the loo line to an agent instruction file. */
  prompt_enabled: boolean;
}

export interface InstallCommands {
  sh: string;
  ps1: string;
}

/** `GET /api/downloads`: one platform binary that actually exists. */
export interface DownloadEntry {
  file: string;
  bytes: number;
}

export interface TokenCreateResponse {
  token: string;
  created_at_ms: number;
  install: InstallCommands;
}

export interface AuthMe {
  username: string;
}

// --- §3 leaderboard / stats / profile --------------------------------------

/** Who plays an agent; the CLI never shows it (contract-J §1). */
export type PlayerKind = 'ai' | 'human';

export interface LeaderRow {
  rank: number;
  agent_id: AgentId;
  nick: string;
  owner: string;
  model: string;
  kind: PlayerKind;
  score_total: number;
  best_score: number;
  successes: number;
}

/** One player kind inside a scope (contract-J §6). */
export interface KindStats {
  agents: number;
  sessions: number;
  successes: number;
  success_rate: number;
  total_score: number;
  best_score: number;
}

/** One range: all official sessions, or only mixed ones. */
export interface ScopeStats {
  total_sessions: number;
  success_rate: number;
  ai: KindStats;
  human: KindStats;
}

export interface StatsResponse {
  all: ScopeStats;
  mixed: ScopeStats;
  /** AI characters only; humans have no self-reported model. */
  models: ModelStats[];
}

export interface ModelStats {
  model: string;
  agents: number;
  sessions: number;
  successes: number;
  success_rate: number;
  total_score: number;
}

export interface SessionRow {
  session_id: SessionId;
  world: number;
  started_tick: Tick;
  ended_tick: Tick | null;
  outcome: SessionOutcome | null;
  score: number;
  need: Need | null;
  sent_by: SentBy | null;
  why: string;
  moved: number;
  built: number;
  hits_taken: number;
  defends: number;
  /** Another player kind shared the world during this session. */
  with_other_kind: boolean;
}

export interface ProfileResponse {
  agent_id: AgentId;
  nick: string;
  owner: string;
  model: string;
  intro: string;
  kind: PlayerKind;
  score_total: number;
  level: number;
  visits: number;
  successes: number;
  success_rate: number;
  self_sessions: number;
  human_sessions: number;
  sessions: SessionRow[];
}

// --- §play (contract-J §3–§5) ----------------------------------------------
// The browser's own view: `/api/play/*` never carries another player's `kind`,
// score, level or `sent_by`.

export type PlacementKind = 'inside' | 'waiting';

export interface Briefing {
  map_width: number;
  map_height: number;
  entrance: Pos;
  view_width: number;
  view_height: number;
  tick: Tick;
}

/** `JoinResponse.placement` — externally tagged, variant names verbatim. */
export type Placement =
  | { Inside: { at: Pos; briefing: Briefing } }
  | { Waiting: { ahead: number } };

export interface JoinResponse {
  session_id: SessionId;
  placement: Placement;
}

export interface ActionState {
  /** Server-generated, e.g. `move N 3`. */
  description: string;
  remaining: number;
}

export interface ActionQueued {
  action: ActionState;
  /** Tick at which the action first takes effect. */
  effective_tick: Tick;
}

export interface LeaveResponse {
  outcome: SessionOutcome;
  score: number;
}

export interface Legend {
  symbol: string;
  meaning: string;
}

/** A rendered character grid (`MapResponse.grid`). */
export interface Grid {
  origin: Pos;
  width: number;
  height: number;
  rows: string[];
  legend: Legend[];
}

export interface MapResponse {
  grid: Grid;
  /** First tick each cell was seen; `0` means never seen. */
  seen_at: Tick[][];
}

/** `AgentView` — the same shape the CLI's `status` prints. */
export interface AgentView {
  agent_id: AgentId;
  nick: string;
  tick: Tick;
  session_id: SessionId | null;
  placement: PlacementKind | null;
  pos: Pos | null;
  queue_ahead: number | null;
  action: ActionState | null;
  need: Need | null;
  use_ticks_done: number;
  use_ticks_total: number;
  deadline_tick: Tick;
  recovery_deadline: Tick | null;
  score: number;
  outcome: SessionOutcome | null;
  score_total: number;
  level: number;
  stun_until: Tick;
  immunity_until: Tick;
  attack_cooldown_until: Tick;
  defend_cooldown_until: Tick;
  defending: Pos | null;
}

/** One event on an `Envelope` (`EventView`): it carries no `kind`. */
export interface EventView {
  tick: Tick;
  seq: number;
  text: string;
}

export type BuildKind = 'wall' | 'door' | 'toilet';

/** `"here"` or one step in a direction; the page never sends absolutes. */
export type TargetSpec = 'here' | { dir: Dir };

export type MoveSpec =
  | { Steps: { dir: Dir; count: number } }
  | { Path: { path: string } };

export interface PlayMe {
  agent_id: AgentId;
  nick: string;
  color: number;
}

/** `GET`/`POST /api/play/agent`. */
export interface PlayAgentResponse {
  agent: PlayMe | null;
}

/** The visible 9×9 window, clipped to the map. */
export interface PlayWindow {
  origin: Pos;
  width: number;
  height: number;
}

export interface PlayAgent {
  id: AgentId;
  nick: string;
  color: number;
  session_id: SessionId;
  pos: Pos;
  pose: AgentPose;
  facing: Dir;
  need: Need | null;
  use_done: number;
  use_total: number;
  deadline_tick: Tick;
  defending: Pos | null;
  stun_until: Tick;
  immunity_until: Tick;
}

/** `GET /api/play/state`. */
export interface PlayState {
  me: PlayMe;
  tick: Tick;
  tick_seconds: number;
  ms_to_next_tick: number;
  joined: boolean;
  placement: PlacementKind | null;
  window: PlayWindow;
  /** Window contents only. */
  objects: ProjectionObject[];
  /** Window contents only, the caller included. */
  agents: PlayAgent[];
  agent: AgentView | null;
  /** The caller's remembered map, same as `loo map`. */
  map: MapResponse | null;
}
