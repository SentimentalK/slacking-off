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

/** `GET /api/terrain` — rows are top-down, `.` buildable, `:` no-build. */
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
  objects: ProjectionObject[];
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

export interface Timeline {
  from: Tick;
  to: Tick;
  markers: TimelineMarker[];
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
}

export interface InstallCommands {
  sh: string;
  ps1: string;
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

export interface LeaderRow {
  rank: number;
  agent_id: AgentId;
  nick: string;
  owner: string;
  model: string;
  score_total: number;
  best_score: number;
  successes: number;
}

export interface ModelStats {
  model: string;
  agents: number;
  sessions: number;
  successes: number;
  success_rate: number;
  total_score: number;
}

export interface StatsResponse {
  total_sessions: number;
  self_sessions: number;
  human_sessions: number;
  success_rate: number;
  models: ModelStats[];
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
}

export interface ProfileResponse {
  agent_id: AgentId;
  nick: string;
  owner: string;
  model: string;
  intro: string;
  score_total: number;
  level: number;
  visits: number;
  successes: number;
  success_rate: number;
  self_sessions: number;
  human_sessions: number;
  sessions: SessionRow[];
}
