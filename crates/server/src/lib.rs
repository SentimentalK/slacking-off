//! Dev-mode HTTP server: the world lives in memory, every settled tick and every
//! command is persisted to SQLite, and a restart resumes from that store.
//!
//! Design §12: one process, world state in memory, `core` settles each tick.
//! Step 1 has movement, vision, collisions and SQLite replay; building, doors,
//! toilets in use, combat, accounts, SSE and the web UI are later steps.

use loo_core::{
    Action, ActionOutcome, Config, Event, EventKind, Intent, IntentKind, JoinCommand, JoinOutcome,
    JoinRejectKind, MapDef, Object, SiteKind, Snapshot, WorldState,
};
use loo_proto::{
    AccountAgent, AccountRegisterResponse, AccountResponse, ActionQueued, ActionState, AgentId,
    AgentView, ApiError, AttackRequest, AuthMeResponse, Briefing, BuildKind, BuildRequest,
    ConfigResponse, DefendRequest, DemolishRequest, DoorRequest, DowngradeRequest, Envelope,
    ErrorCode, EventView, InstallCommands, JoinRequest, JoinResponse, LeaderRow, LeaveResponse,
    LookResponse, MapResponse, MetricsResponse, MoveRequest, Need, Placement, PlacementKind,
    PlayAgentResponse, PlayMe, PlayState, PlayerKind, Pos, ProfileResponse, Projection,
    PromptResponse, RegisterRequest, RegisterResponse, RulesResponse, SentBy, SessionId,
    SessionOutcome, SettleMs, StatsResponse, TargetSpec, TerrainResponse, Tick, Timeline,
    TokenCreateResponse, UpgradeRequest, WaitRequest, WaitResponse, WaitWake, WorldSummary,
};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use store::WORLD_ID;
pub use store::{Store, StoreError, StoredAgent};
use tokio::sync::{broadcast, Mutex};

use crate::projection::{build as build_projection, AgentPublic};

/// Outbox cap per session so an agent that stops polling cannot grow memory.
const MAX_OUTBOX: usize = 512;

pub struct Server {
    cfg: Config,
    inner: Mutex<Inner>,
    tick_tx: broadcast::Sender<Tick>,
    /// One projection per settled tick, for `/api/watch`. Capacity 32.
    watch_tx: broadcast::Sender<Arc<Projection>>,
    store: Store,
    /// Contract §1 mode: accounts are required and tokens are hashed in the DB.
    official: bool,
    /// Dev identities: `agents.token` -> agent. Only read in dev mode.
    dev_tokens: std::sync::Mutex<HashMap<String, AgentId>>,
    /// Token bucket per agent: `limits.requests_per_second` refills it and
    /// `limits.requests_burst` is its depth. One entry per agent that has ever
    /// sent a command, never one per request.
    rate: std::sync::Mutex<BTreeMap<AgentId, RateBucket>>,
    /// Open long-poll connections, capped by `limits.wait_connections`.
    wait_active: AtomicUsize,
    /// Open SSE connections, capped by `limits.watch_connections`.
    watch_active: AtomicUsize,
    /// Milliseconds from the start of `tick_once` to a built projection.
    settle_samples: std::sync::Mutex<VecDeque<f64>>,
}

struct Inner {
    world: WorldState,
    /// The action submitted since the last settlement, at most one per agent:
    /// a later command replaces the earlier one (design §3).
    pending: BTreeMap<AgentId, Vec<IntentKind>>,
    agents: BTreeMap<AgentId, AgentMeta>,
    /// Current session per agent; removed when the session leaves.
    sessions: BTreeMap<AgentId, SessionId>,
    /// Undelivered events per agent. Keyed by agent, not session, so the last
    /// event of a session (for example `SessionEnded`) still reaches it.
    outbox: BTreeMap<AgentId, Vec<loo_core::Event>>,
    next_agent_id: AgentId,
    next_session_id: SessionId,
    seed_base: u64,
    /// Last event seq committed at `world.tick`; joins continue after it.
    last_seq: u32,
    /// Shuffle seed of `world.tick` (0 before the first settlement).
    tick_seed: u64,
    /// Use ticks for urine and feces, copied from the immutable server config so
    /// `agent_view` can report the total without holding a `Config`.
    need_use_ticks: [u32; 2],
    /// Events of `world.tick`: loaded at open, replaced after a settlement, and
    /// extended by join events (which land on the current tick).
    current_events: Vec<loo_core::Event>,
    /// The public half of each agent's meta; `why`/`intro`/`model` stay private.
    agent_public: BTreeMap<AgentId, AgentPublic>,
    /// When the last settlement finished, so the browser can animate the tick
    /// countdown (`/api/play/state`).
    last_settle_at: Instant,
}

struct AgentMeta {
    nick: loo_proto::Nick,
    #[allow(dead_code)] // shown on the web profile page in step 4
    model: String,
    #[allow(dead_code)] // shown on the web profile page in step 4
    intro: String,
    #[allow(dead_code)] // replaced by a hashed token table in step 4
    token: String,
    sent_by: Option<SentBy>,
    why: String,
    /// Cumulative score carried across sessions, persisted in `agents`.
    score_total: u32,
    kind: PlayerKind,
    color: Option<u8>,
}

/// One open long-poll slot; released when the handler returns.
struct WaitSlot<'a>(&'a AtomicUsize);

impl Drop for WaitSlot<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

/// One open SSE slot; keeps the server alive so the decrement is safe.
pub struct WatchSlot {
    server: Arc<Server>,
}

impl Drop for WatchSlot {
    fn drop(&mut self) {
        self.server.watch_active.fetch_sub(1, Ordering::Relaxed);
    }
}

/// `current >= limit` rejects before the counter is incremented further.
fn take_slot(counter: &AtomicUsize, limit: usize) -> bool {
    if counter.fetch_add(1, Ordering::Relaxed) >= limit {
        counter.fetch_sub(1, Ordering::Relaxed);
        false
    } else {
        true
    }
}

/// Design §9 (v1.2): one token bucket per agent, so a shell that fires a batch
/// of commands back to back is not swallowed while a sustained flood still
/// meets the configured rate. The bucket holds `burst` commands; it refills at
/// `requests_per_second` and never above its depth. No queue: a refused command
/// is answered at once with the seconds until the next token.
struct RateBucket {
    tokens: f64,
    filled_at: Instant,
}

impl RateBucket {
    /// A bucket for an agent that has not spent anything yet: full depth, so a
    /// fresh agent's first batch is never swallowed.
    fn full(burst: u32) -> Self {
        Self {
            tokens: f64::from(burst.max(1)),
            filled_at: Instant::now(),
        }
    }

    /// Spends one token, or returns the whole seconds until one is available.
    fn take(&mut self, now: Instant, per_second: u32, burst: u32) -> Result<(), u32> {
        let depth = f64::from(burst.max(1));
        let elapsed = now.saturating_duration_since(self.filled_at).as_secs_f64();
        self.tokens = (self.tokens + elapsed * f64::from(per_second)).min(depth);
        self.filled_at = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            return Ok(());
        }
        let wait = (1.0 - self.tokens) / f64::from(per_second.max(1));
        Err(wait.ceil().max(1.0) as u32)
    }
}

impl Server {
    /// Opens the world stored in `data_dir`: the latest snapshot plus the event
    /// log after it. A brand-new directory starts at tick 0 from `def` and keeps
    /// `seed_base`; an existing world keeps its own seed and refuses a different
    /// map.
    pub fn open(
        cfg: Config,
        def: MapDef,
        map_name: &str,
        map_text: &str,
        data_dir: &Path,
        seed_base: u64,
    ) -> Result<Server, StoreError> {
        Self::open_mode(
            cfg, def, map_name, map_text, data_dir, seed_base, /* official */ false,
        )
    }

    /// Official mode (contract §1): accounts are required, `/api/dev/register`
    /// is gone, and the world row is marked `official = 1`.
    pub fn open_official(
        cfg: Config,
        def: MapDef,
        map_name: &str,
        map_text: &str,
        data_dir: &Path,
        seed_base: u64,
    ) -> Result<Server, StoreError> {
        Self::open_mode(
            cfg, def, map_name, map_text, data_dir, seed_base, /* official */ true,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn open_mode(
        cfg: Config,
        def: MapDef,
        map_name: &str,
        map_text: &str,
        data_dir: &Path,
        seed_base: u64,
        official: bool,
    ) -> Result<Server, StoreError> {
        let store = Store::open(data_dir, map_name, map_text, seed_base)?;
        if official {
            store.mark_world_official()?;
        }
        if loo_core::map::parse(&store.map_text()?)? != def {
            return Err(StoreError::MapMismatch);
        }
        let seed_base = store.seed_base()?;

        let (base, base_seq, base_seed) = match store.latest_snapshot()? {
            Some((_, snapshot)) => (snapshot.world, snapshot.last_seq, snapshot.seed),
            None => (WorldState::new(def), 0, 0),
        };
        let base = Snapshot {
            world: base,
            last_seq: base_seq,
            seed: base_seed,
        };
        let events = store.events_after(base.world.tick, base.last_seq)?;
        let world = loo_core::restore(&base, &events, &cfg)?;
        check_toilet_pillars(&world)?;
        let (last_seq, tick_seed) = events
            .last()
            .map(|event| (event.seq, event.seed))
            .unwrap_or((base_seq, base_seed));
        if let Some(stored_tick) = store.world_tick()? {
            if stored_tick != world.tick {
                return Err(StoreError::Corrupt(format!(
                    "the world row says tick {stored_tick} but the event log ends at tick {}",
                    world.tick
                )));
            }
        }

        let stored_agents = store.agents()?;
        let mut agents = BTreeMap::new();
        let mut agent_public = BTreeMap::new();
        let mut dev_tokens = HashMap::new();
        for stored in &stored_agents {
            let meta = agent_meta(stored)?;
            agent_public.insert(
                stored.id,
                AgentPublic {
                    sent_by: meta.sent_by,
                    kind: stored.kind,
                    color: stored.color,
                },
            );
            agents.insert(stored.id, meta);
            if !stored.token.is_empty() {
                dev_tokens.insert(stored.token.clone(), stored.id);
            }
        }
        let sessions = world
            .sessions
            .values()
            .map(|session| (session.agent, session.id))
            .collect();
        let mut pending: BTreeMap<AgentId, Vec<IntentKind>> = BTreeMap::new();
        for (agent, kind) in store.pending_intents(world.tick)? {
            pending.entry(agent).or_default().push(kind);
        }

        let (tick_tx, _) = broadcast::channel(16);
        let (watch_tx, _) = broadcast::channel(32);
        let need_use_ticks = [cfg.need.urine_use_ticks, cfg.need.feces_use_ticks];
        let current_events = store.events_of_tick(world.tick)?;
        // Ended sessions only exist in the store; their ids must never be
        // reused, or a new join would overwrite a historical row.
        let next_session_id = world
            .sessions
            .keys()
            .copied()
            .max()
            .unwrap_or(0)
            .max(store.max_session_id()?.unwrap_or(0))
            + 1;
        Ok(Server {
            cfg,
            inner: Mutex::new(Inner {
                next_agent_id: stored_agents
                    .iter()
                    .map(|agent| agent.id)
                    .max()
                    .unwrap_or(0)
                    + 1,
                next_session_id,
                world,
                pending,
                agents,
                sessions,
                outbox: BTreeMap::new(),
                seed_base,
                last_seq,
                tick_seed,
                need_use_ticks,
                current_events,
                agent_public,
                last_settle_at: Instant::now(),
            }),
            tick_tx,
            watch_tx,
            store,
            official,
            dev_tokens: std::sync::Mutex::new(dev_tokens),
            rate: std::sync::Mutex::new(BTreeMap::new()),
            wait_active: AtomicUsize::new(0),
            watch_active: AtomicUsize::new(0),
            settle_samples: std::sync::Mutex::new(VecDeque::new()),
        })
    }

    /// Contract §1 mode; `--official`.
    pub fn official(&self) -> bool {
        self.official
    }

    /// The store itself, for the HTTP layer's web-session bookkeeping.
    pub fn store(&self) -> &Store {
        &self.store
    }

    pub fn config(&self) -> &Config {
        &self.cfg
    }

    /// Spawns the tick loop. Missed ticks are skipped rather than replayed.
    pub fn spawn_ticker(self: &std::sync::Arc<Self>) -> tokio::task::JoinHandle<()> {
        let server = self.clone();
        let period = Duration::from_secs_f64(self.cfg.tick_seconds.max(0.05));
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(period);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            interval.tick().await; // the first tick fires immediately
            loop {
                interval.tick().await;
                server.tick_once().await;
            }
        })
    }

    /// Accumulates one batch of events into `sessions`: counters in one
    /// statement per session, then need/end transitions. Settlement and
    /// between-tick leave events both go through here.
    fn record_session_events(&self, events: &[Event]) {
        #[derive(Default)]
        struct Delta {
            moved: u32,
            built: u32,
            hits_taken: u32,
            defends: u32,
        }

        let mut deltas: BTreeMap<SessionId, Delta> = BTreeMap::new();
        let mut needs: Vec<(SessionId, Need)> = Vec::new();
        let mut endings: Vec<(SessionId, Tick, SessionOutcome, u32)> = Vec::new();
        for event in events {
            match &event.kind {
                EventKind::AgentMoved { session, .. } | EventKind::AgentSwapped { session, .. } => {
                    deltas.entry(*session).or_default().moved += 1;
                }
                EventKind::ActionFinished {
                    session,
                    action: Action::Build { .. } | Action::Upgrade { .. },
                    outcome: ActionOutcome::Completed,
                    ..
                } => {
                    deltas.entry(*session).or_default().built += 1;
                }
                EventKind::AttackLanded { target_session, .. } => {
                    deltas.entry(*target_session).or_default().hits_taken += 1;
                }
                EventKind::AttackBlocked {
                    defender_session, ..
                }
                | EventKind::DemolishBlocked {
                    defender_session, ..
                } => {
                    deltas.entry(*defender_session).or_default().defends += 1;
                }
                EventKind::NeedAssigned { session, need, .. } => needs.push((*session, *need)),
                EventKind::SessionEnded {
                    session,
                    outcome,
                    score,
                    ..
                } => endings.push((*session, event.tick, *outcome, *score)),
                _ => {}
            }
        }

        for (session, delta) in deltas {
            if delta.moved == 0 && delta.built == 0 && delta.hits_taken == 0 && delta.defends == 0 {
                continue;
            }
            if let Err(error) = self.store.bump_session(
                session,
                delta.moved,
                delta.built,
                delta.hits_taken,
                delta.defends,
            ) {
                eprintln!("session {session} counters were not stored: {error}");
            }
        }
        for (session, need) in needs {
            if let Err(error) = self.store.set_session_need(session, need) {
                eprintln!("session {session} need was not stored: {error}");
            }
        }
        for (session, ended_tick, outcome, score) in endings {
            if let Err(error) = self
                .store
                .finish_session(session, ended_tick, outcome, score)
            {
                eprintln!("session {session} end was not stored: {error}");
            }
        }
    }

    /// Settles exactly one tick. Public so tests and tooling can drive the world
    /// without a live timer. Nothing is published unless the tick is persisted.
    pub async fn tick_once(&self) -> Tick {
        let started = Instant::now();
        let mut inner = self.inner.lock().await;
        inner.last_settle_at = Instant::now();
        let intents: Vec<Intent> = inner
            .pending
            .iter()
            .flat_map(|(agent, kinds)| {
                kinds.iter().map(move |kind| Intent {
                    agent: *agent,
                    kind: kind.clone(),
                })
            })
            .collect();

        // Every agent that has a session before the step, with the position it
        // was seen at. Agents whose session ends during the tick must still get
        // the events of that tick.
        let mut recipients: BTreeMap<AgentId, Option<Pos>> = inner
            .world
            .sessions
            .values()
            .map(|session| {
                (
                    session.agent,
                    inner
                        .world
                        .agents
                        .get(&session.agent)
                        .and_then(|agent| agent.pos),
                )
            })
            .collect();

        let mut rng = loo_core::rng::Rng::new(inner.seed_base ^ (inner.world.tick + 1));
        let seed = rng.next_u64();
        let (world, events) = loo_core::step(&inner.world, &intents, seed, &self.cfg);
        if let Err(error) = self.store.append_tick(world.tick, &events) {
            eprintln!(
                "tick {} was not persisted, keeping tick {}: {error}",
                world.tick, inner.world.tick
            );
            return inner.world.tick;
        }

        inner.pending.clear();
        for event in &events {
            if let loo_core::EventKind::UseSucceeded { agent, score, .. } = &event.kind {
                if let Some(meta) = inner.agents.get_mut(agent) {
                    meta.score_total = meta.score_total.saturating_add(*score);
                }
            }
        }
        self.record_session_events(&events);
        inner.last_seq = events
            .last()
            .map(|event| event.seq)
            .unwrap_or(inner.last_seq);
        inner.tick_seed = seed;

        // New positions win over the pre-step ones; agents that left keep their
        // last position so the closing events still match their view.
        for session in world.sessions.values() {
            let pos = world.agents.get(&session.agent).and_then(|agent| agent.pos);
            recipients.insert(session.agent, pos);
        }

        {
            let Inner { outbox, .. } = &mut *inner;
            for event in &events {
                for (agent, pos) in &recipients {
                    if event.visible_to(*agent, *pos, &self.cfg) {
                        let queue = outbox.entry(*agent).or_default();
                        if queue.len() < MAX_OUTBOX {
                            queue.push(event.clone());
                        }
                    }
                }
            }
        }

        inner.current_events = events;
        inner.world = world;
        inner.sessions = inner
            .world
            .sessions
            .values()
            .map(|session| (session.agent, session.id))
            .collect();

        let tick = inner.world.tick;
        let projection = build_projection(
            &self.cfg,
            &inner.world,
            &inner.agent_public,
            &inner.current_events,
        );
        {
            let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
            let mut samples = self
                .settle_samples
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if samples.len() >= 10_000 {
                samples.pop_front();
            }
            samples.push_back(elapsed_ms);
        }
        let interval = self.cfg.persist.snapshot_interval_ticks;
        if interval > 0 && tick % u64::from(interval) == 0 {
            let snapshot = Snapshot {
                world: inner.world.clone(),
                last_seq: inner.last_seq,
                seed: inner.tick_seed,
            };
            if let Err(error) = self.store.snapshot(&snapshot) {
                eprintln!("snapshot at tick {tick} failed: {error}");
            }
        }
        drop(inner);
        // No subscribers is not an error.
        let _ = self.watch_tx.send(Arc::new(projection));
        let _ = self.tick_tx.send(tick);
        tick
    }

    /// The live world, for tests and operators.
    pub async fn world_state(&self) -> WorldState {
        self.inner.lock().await.world.clone()
    }

    /// Every event the store holds after the `(tick, seq)` cursor.
    pub async fn recorded_events(
        &self,
        after_tick: Tick,
        after_seq: u32,
    ) -> Result<Vec<loo_core::Event>, StoreError> {
        self.store.events_after(after_tick, after_seq)
    }

    /// The event cursor of the live world.
    pub async fn event_cursor(&self) -> (Tick, u32) {
        let inner = self.inner.lock().await;
        (inner.world.tick, inner.last_seq)
    }

    /// The live projection of the current tick (contract §2).
    pub async fn current_projection(&self) -> Projection {
        let (world, agent_public, current_events) = {
            let inner = self.inner.lock().await;
            (
                inner.world.clone(),
                inner.agent_public.clone(),
                inner.current_events.clone(),
            )
        };
        build_projection(&self.cfg, &world, &agent_public, &current_events)
    }

    /// Replays the world to `tick` and projects it with the same builder as the
    /// live stream, so SSE and replay agree field for field.
    pub async fn projection_at(&self, tick: Tick) -> Result<Projection, String> {
        let (current, agent_public) = {
            let inner = self.inner.lock().await;
            (inner.world.tick, inner.agent_public.clone())
        };
        if tick > current {
            return Err(format!(
                "tick {tick} is in the future; the world is at tick {current}"
            ));
        }

        let base = match self
            .store
            .snapshot_at_or_before(tick)
            .map_err(|error| error.to_string())?
        {
            Some((_, snapshot)) => snapshot,
            None => {
                // No checkpoint yet: replay from the map's initial state.
                let map_text = self.store.map_text().map_err(|error| error.to_string())?;
                let def = loo_core::map::parse(&map_text)
                    .map_err(|error| format!("the stored map does not parse: {error}"))?;
                Snapshot::new(WorldState::new(def))
            }
        };
        let events = self
            .store
            .events_between(base.world.tick, base.last_seq.saturating_add(1), tick)
            .map_err(|error| error.to_string())?;
        let world =
            loo_core::restore(&base, &events, &self.cfg).map_err(|error| error.to_string())?;
        let tick_events = self
            .store
            .events_of_tick(tick)
            .map_err(|error| error.to_string())?;
        Ok(build_projection(
            &self.cfg,
            &world,
            &agent_public,
            &tick_events,
        ))
    }

    /// `GET /api/terrain`.
    pub async fn terrain(&self) -> TerrainResponse {
        let inner = self.inner.lock().await;
        projection::terrain_rows(&inner.world)
    }

    /// `GET /api/worlds`: this server's single world.
    pub async fn worlds(&self) -> Vec<WorldSummary> {
        match self.store.world_summary() {
            Ok(summary) => vec![summary],
            Err(error) => {
                eprintln!("the world row could not be read: {error}");
                Vec::new()
            }
        }
    }

    /// `GET /api/leaderboard` (contract-J §6). `metric` is one of
    /// `score|best|successes`, `kind` one of `ai|human|mixed`; `limit` is
    /// clamped to 1..=100.
    pub async fn leaderboard(
        &self,
        metric: &str,
        kind: &str,
        model: Option<&str>,
        limit: usize,
    ) -> Envelope<Vec<LeaderRow>> {
        if !matches!(metric, "score" | "best" | "successes") {
            return error_envelope(
                ErrorCode::BadRequest,
                "metric must be one of score, best, successes",
            );
        }
        if !matches!(kind, "ai" | "human" | "mixed") {
            return error_envelope(
                ErrorCode::BadRequest,
                "kind must be one of ai, human, mixed",
            );
        }
        let limit = limit.clamp(1, 100);
        let model = model.filter(|model| !model.is_empty());
        match self.store.leaderboard(metric, kind, model, limit) {
            Ok(rows) => Envelope::ok(rows, Vec::new(), None),
            Err(error) => error_envelope(
                ErrorCode::Internal,
                format!("reading the leaderboard failed: {error}"),
            ),
        }
    }

    /// `GET /api/stats` (contract §3).
    pub async fn stats(&self, prompt: store::PromptFilter) -> Envelope<StatsResponse> {
        match self.store.stats(prompt) {
            Ok(stats) => Envelope::ok(stats, Vec::new(), None),
            Err(error) => error_envelope(
                ErrorCode::Internal,
                format!("reading the stats failed: {error}"),
            ),
        }
    }

    /// `GET /api/agents/:id` (contract §3). Any registered agent is queryable,
    /// including dev agents; unknown ids are a bad request (the HTTP layer
    /// turns that into 404).
    pub async fn profile(&self, agent_id: AgentId) -> Envelope<ProfileResponse> {
        match self.store.profile(agent_id) {
            Ok(Some(mut profile)) => {
                // The store has no config handle; the live level comes from
                // this server's thresholds.
                profile.level = loo_core::agent_level(profile.score_total, &self.cfg);
                Envelope::ok(profile, Vec::new(), None)
            }
            Ok(None) => error_envelope(ErrorCode::BadRequest, format!("unknown agent {agent_id}")),
            Err(error) => error_envelope(
                ErrorCode::Internal,
                format!("reading the profile failed: {error}"),
            ),
        }
    }

    /// `GET /api/timeline` (contract §3): four marker kinds, ascending, capped,
    /// plus the replayable spans of the same window.
    pub async fn timeline(&self, from: Tick, to: Tick) -> Envelope<Timeline> {
        let current_tick = {
            let inner = self.inner.lock().await;
            inner.world.tick
        };
        // An omitted `to` arrives as `Tick::MAX`; using it raw would become -1
        // in SQLite and match nothing. Only the sentinel is clamped: an
        // explicit future bound stays as given (tests and tooling use it).
        let to = if to == Tick::MAX { current_tick } else { to };
        let markers = match self.store.timeline_markers(from, to) {
            Ok(markers) => markers,
            Err(error) => {
                return error_envelope(
                    ErrorCode::Internal,
                    format!("reading the timeline failed: {error}"),
                )
            }
        };
        match self.store.timeline_spans(from, to, current_tick) {
            Ok(spans) => Envelope::ok(
                Timeline {
                    from,
                    to,
                    markers,
                    spans,
                },
                Vec::new(),
                None,
            ),
            Err(error) => error_envelope(
                ErrorCode::Internal,
                format!("reading the timeline failed: {error}"),
            ),
        }
    }

    /// A receiver for one projection per settled tick.
    pub fn watch_receiver(&self) -> broadcast::Receiver<Arc<Projection>> {
        self.watch_tx.subscribe()
    }

    /// Writes a snapshot of the live world now, for a graceful shutdown.
    pub async fn save_snapshot(&self) -> Result<(), StoreError> {
        let inner = self.inner.lock().await;
        let snapshot = Snapshot {
            world: inner.world.clone(),
            last_seq: inner.last_seq,
            seed: inner.tick_seed,
        };
        self.store.snapshot(&snapshot)
    }

    /// The configured default `loo wait` timeout in seconds.
    pub fn default_wait_seconds(&self) -> f64 {
        self.cfg.wait_default_seconds()
    }

    /// Whole seconds in one tick, never less than one: the retry hint for a
    /// connection slot that frees when the running wait ends.
    fn tick_seconds_ceil(&self) -> u32 {
        self.cfg.tick_seconds.ceil().max(1.0) as u32
    }

    /// Token bucket per agent (`limits.requests_per_second = 0` disables the
    /// check): `limits.requests_burst` commands pass back to back, then the
    /// sustained rate applies. A refusal carries the retry delay in seconds.
    fn check_rate(&self, agent: AgentId) -> Result<(), ApiError> {
        let per_second = self.cfg.limits.requests_per_second;
        if per_second == 0 {
            return Ok(());
        }
        let burst = self.cfg.limits.requests_burst;
        let mut buckets = self
            .rate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let bucket = buckets
            .entry(agent)
            .or_insert_with(|| RateBucket::full(burst));
        bucket
            .take(Instant::now(), per_second, burst)
            .map_err(|retry_after_seconds| {
                ApiError::rate_limited(
                    format!(
                        "too many requests: at most {per_second} per second per agent, with a burst of {burst}"
                    ),
                    retry_after_seconds,
                )
            })
    }

    fn wait_slot(&self) -> Option<WaitSlot<'_>> {
        take_slot(&self.wait_active, self.cfg.limits.wait_connections)
            .then_some(WaitSlot(&self.wait_active))
    }

    /// Reserves an SSE slot; the guard releases it when the stream ends.
    pub fn watch_slot(self: &Arc<Self>) -> Result<WatchSlot, ApiError> {
        let limit = self.cfg.limits.watch_connections;
        if !take_slot(&self.watch_active, limit) {
            return Err(ApiError::rate_limited(
                format!("too many open watch connections (limit {limit})"),
                self.tick_seconds_ceil(),
            ));
        }
        Ok(WatchSlot {
            server: self.clone(),
        })
    }

    /// Records that a waiting agent is alive at the current tick. The event is
    /// persisted like a join so a restart replays the same `last_active_tick`;
    /// `QueueTouched` is filtered out of the projection.
    fn touch_waiting(&self, inner: &mut Inner, agent: AgentId) {
        let tick = inner.world.tick;
        let Some(mut event) = loo_core::touch(&inner.world, agent, tick, inner.tick_seed) else {
            return;
        };
        event.seq = inner.last_seq.saturating_add(1);
        if let Err(error) = self
            .store
            .append_join_events(tick, std::slice::from_ref(&event))
        {
            eprintln!("queue touch for agent {agent} was not persisted: {error}");
            return;
        }
        inner.last_seq = event.seq;
        inner.current_events.push(event);
        if let Some(session) = inner.world.session_of(agent) {
            let session_id = session.id;
            if let Some(session) = inner.world.sessions.get_mut(&session_id) {
                session.last_active_tick = tick;
            }
        }
    }

    /// `GET /api/metrics`: live tick, occupancy and settlement latency.
    pub async fn metrics(&self) -> MetricsResponse {
        let (tick, inside, queued) = {
            let inner = self.inner.lock().await;
            (
                inner.world.tick,
                inner.world.inside_count(),
                inner.world.waiting_sessions().len(),
            )
        };
        let mut samples: Vec<f64> = {
            let samples = self
                .settle_samples
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            samples.iter().copied().collect()
        };
        samples.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let max = samples.last().copied().unwrap_or(0.0);
        MetricsResponse {
            tick,
            ticks: samples.len() as u64,
            settle_ms: SettleMs {
                p50: percentile(&samples, 50.0),
                p99: percentile(&samples, 99.0),
                max,
            },
            inside,
            queued,
        }
    }

    pub fn store_path(&self) -> &Path {
        self.store.path()
    }

    fn remember_dev_token(&self, token: &str, agent_id: AgentId) {
        if let Ok(mut tokens) = self.dev_tokens.lock() {
            tokens.insert(token.to_string(), agent_id);
        }
    }

    /// Resolves a caller string to an agent (contract §1). Dev mode looks the
    /// token up in memory exactly as before. Official mode receives
    /// `"{account token}:{agent id}"` from the HTTP layer: the token must be
    /// live and the agent must belong to the token's account.
    fn authenticate(&self, caller: &str) -> Option<AgentId> {
        if !self.official {
            return self.dev_tokens.lock().ok()?.get(caller).copied();
        }
        let (token, agent) = caller.split_once(':')?;
        let agent = agent.parse::<AgentId>().ok()?;
        let user_id = self
            .store
            .auth_token_lookup(&auth::sha256_hex(token))
            .ok()??;
        if self.store.agent_owner(agent).ok()?? != user_id {
            return None;
        }
        // A human character belongs to the browser: account tokens only drive
        // `Ai` agents, so `/play` is the only way to command a human.
        let kind = self.store.agent_kind(agent).ok()??;
        (kind == PlayerKind::Ai).then_some(agent)
    }

    /// Creates an account (contract §1). The caller sets cookies from this.
    pub async fn register_account(
        &self,
        username: &str,
        password: &str,
    ) -> Envelope<AuthMeResponse> {
        if let Err(message) = auth::validate_username(username) {
            return error_envelope(ErrorCode::BadRequest, message);
        }
        if let Err(message) = auth::validate_password(password) {
            return error_envelope(ErrorCode::BadRequest, message);
        }
        let hash = match auth::hash_password_async(password.to_string()).await {
            Ok(hash) => hash,
            Err(message) => return error_envelope(ErrorCode::Internal, message),
        };
        match self.store.create_user(username, &hash) {
            Ok(_) => Envelope::ok(
                AuthMeResponse {
                    username: username.to_string(),
                },
                Vec::new(),
                None,
            ),
            Err(StoreError::Conflict(message)) => error_envelope(ErrorCode::BadRequest, message),
            Err(error) => error_envelope(
                ErrorCode::Internal,
                format!("storing the account failed: {error}"),
            ),
        }
    }

    /// Checks a username/password pair. Wrong username and wrong password are
    /// indistinguishable on the wire.
    pub async fn login_account(&self, username: &str, password: &str) -> Envelope<AuthMeResponse> {
        let stored = match self.store.user_by_username(username) {
            Ok(stored) => stored,
            Err(error) => {
                return error_envelope(
                    ErrorCode::Internal,
                    format!("reading the account failed: {error}"),
                )
            }
        };
        let Some((user_id, password_hash)) = stored else {
            return error_envelope(ErrorCode::NotAuthenticated, "wrong username or password");
        };
        match auth::verify_password_async(password.to_string(), password_hash).await {
            Ok(true) => Envelope::ok(
                AuthMeResponse {
                    username: self
                        .store
                        .username_of(user_id)
                        .ok()
                        .flatten()
                        .unwrap_or_else(|| username.to_string()),
                },
                Vec::new(),
                None,
            ),
            Ok(false) => error_envelope(ErrorCode::NotAuthenticated, "wrong username or password"),
            Err(message) => error_envelope(ErrorCode::Internal, message),
        }
    }

    /// The account page payload; `agents` is ordered by agent id.
    pub fn account_for_user(&self, user_id: u64) -> Envelope<AccountResponse> {
        let username = match self.store.username_of(user_id) {
            Ok(Some(username)) => username,
            Ok(None) => return error_envelope(ErrorCode::BadRequest, "unknown account"),
            Err(error) => {
                return error_envelope(
                    ErrorCode::Internal,
                    format!("reading the account failed: {error}"),
                )
            }
        };
        let stored = match self.store.agents_of_user(user_id) {
            Ok(stored) => stored,
            Err(error) => {
                return error_envelope(
                    ErrorCode::Internal,
                    format!("reading the account agents failed: {error}"),
                )
            }
        };
        let token = match self.store.auth_token_info(user_id) {
            Ok(token) => token,
            Err(error) => {
                return error_envelope(
                    ErrorCode::Internal,
                    format!("reading the token state failed: {error}"),
                )
            }
        };
        let agents = stored
            .iter()
            .map(|agent| AccountAgent {
                agent_id: agent.id,
                nick: agent.nick.clone(),
                model: agent.model.clone(),
                intro: agent.intro.clone(),
                score_total: agent.score_total,
                level: loo_core::agent_level(agent.score_total, &self.cfg),
                created_at_ms: agent.created_at_ms,
            })
            .collect();
        Envelope::ok(
            AccountResponse {
                username,
                agents,
                token,
                prompt_enabled: self.store.prompt_enabled(user_id).unwrap_or(false),
            },
            Vec::new(),
            None,
        )
    }

    /// Revokes every live token, then issues one new one. The plaintext appears
    /// only in this response (contract §1).
    pub fn create_account_token(&self, user_id: u64, base: &str) -> Envelope<TokenCreateResponse> {
        if let Err(error) = self.store.auth_token_revoke_all(user_id) {
            return error_envelope(
                ErrorCode::Internal,
                format!("revoking the old tokens failed: {error}"),
            );
        }
        let token = auth::new_token();
        match self
            .store
            .auth_token_insert(user_id, &auth::sha256_hex(&token))
        {
            Ok(created_at_ms) => Envelope::ok(
                TokenCreateResponse {
                    install: install_commands(base, &token),
                    token,
                    created_at_ms,
                },
                Vec::new(),
                None,
            ),
            Err(error) => error_envelope(
                ErrorCode::Internal,
                format!("storing the token failed: {error}"),
            ),
        }
    }

    pub fn revoke_account_tokens(&self, user_id: u64) -> Result<(), StoreError> {
        self.store.auth_token_revoke_all(user_id).map(|_| ())
    }

    /// Records whether this account's install added the loo line to an agent
    /// instruction file. `caller_token` is the account token (Authorization:
    /// Bearer); no agent is needed, the install runs before `register`.
    pub fn set_prompt_enabled(
        &self,
        caller_token: &str,
        enabled: bool,
    ) -> Envelope<PromptResponse> {
        let user_id = match self
            .store
            .auth_token_lookup(&auth::sha256_hex(caller_token))
        {
            Ok(Some(user_id)) => user_id,
            Ok(None) => {
                return error_envelope(ErrorCode::NotAuthenticated, not_authenticated().message)
            }
            Err(error) => {
                return error_envelope(
                    ErrorCode::Internal,
                    format!("reading the token failed: {error}"),
                )
            }
        };
        match self.store.set_prompt_enabled(user_id, enabled) {
            Ok(prompt_enabled) => Envelope::ok(PromptResponse { prompt_enabled }, Vec::new(), None),
            Err(error) => error_envelope(ErrorCode::Internal, format!("{error}")),
        }
    }

    /// The account's human character as the browser sees it (contract §3).
    pub fn human_agent(&self, user_id: u64) -> Envelope<PlayAgentResponse> {
        match self.store.human_agent_of_user(user_id) {
            Ok(agent) => Envelope::ok(
                PlayAgentResponse {
                    agent: agent.as_ref().map(play_me),
                },
                Vec::new(),
                None,
            ),
            Err(error) => error_envelope(
                ErrorCode::Internal,
                format!("reading the human character failed: {error}"),
            ),
        }
    }

    /// The account's human character id, if it has one.
    pub fn human_agent_id(&self, user_id: u64) -> Option<AgentId> {
        self.store
            .human_agent_of_user(user_id)
            .ok()
            .flatten()
            .map(|stored| stored.id)
    }

    /// Creates the account's one browser character (contract §3). It is not
    /// counted against `session.max_agents_per_user`.
    pub async fn create_human_agent(
        &self,
        user_id: u64,
        nick: String,
        color: Option<u8>,
    ) -> Envelope<PlayAgentResponse> {
        let nick = match loo_proto::Nick::parse(&nick) {
            Ok(nick) => nick,
            Err(message) => return error_envelope(ErrorCode::BadRequest, message),
        };
        if color.is_some_and(|color| color > 11) {
            return error_envelope(ErrorCode::BadRequest, "color must be between 0 and 11");
        }
        match self.store.human_agent_of_user(user_id) {
            Ok(Some(_)) => {
                return error_envelope(
                    ErrorCode::RuleRejected,
                    "this account already has a human character",
                )
            }
            Ok(None) => {}
            Err(error) => {
                return error_envelope(
                    ErrorCode::Internal,
                    format!("reading the human character failed: {error}"),
                )
            }
        }
        match self.store.agent_by_nick(nick.as_str()) {
            Ok(Some(_)) => {
                return error_envelope(
                    ErrorCode::BadRequest,
                    format!("nickname {nick} is already taken"),
                )
            }
            Ok(None) => {}
            Err(error) => {
                return error_envelope(
                    ErrorCode::Internal,
                    format!("reading the nickname failed: {error}"),
                )
            }
        }
        let agent_id = match self.store.create_human_agent(user_id, nick.as_str(), color) {
            Ok(agent_id) => agent_id,
            Err(StoreError::Conflict(message)) => {
                return error_envelope(ErrorCode::RuleRejected, message)
            }
            Err(error) => {
                return error_envelope(
                    ErrorCode::Internal,
                    format!("creating the human character failed: {error}"),
                )
            }
        };
        let color = color.unwrap_or((agent_id % crate::projection::COLOR_COUNT as u64) as u8);
        let mut inner = self.inner.lock().await;
        inner.agents.insert(
            agent_id,
            AgentMeta {
                nick: nick.clone(),
                model: String::new(),
                intro: String::new(),
                token: String::new(),
                sent_by: None,
                why: String::new(),
                score_total: 0,
                kind: PlayerKind::Human,
                color: Some(color),
            },
        );
        inner.agent_public.insert(
            agent_id,
            AgentPublic {
                sent_by: None,
                kind: PlayerKind::Human,
                color: Some(color),
            },
        );
        inner.next_agent_id = inner.next_agent_id.max(agent_id + 1);
        drop(inner);
        Envelope::ok(
            PlayAgentResponse {
                agent: Some(PlayMe {
                    agent_id,
                    nick: nick.to_string(),
                    color,
                }),
            },
            Vec::new(),
            None,
        )
    }

    /// `GET /api/play/state`: the browser's 9×9 window (contract §5). This is a
    /// view, not a command: it spends a rate token and marks the player active,
    /// but writes no command log entry.
    pub async fn play_state(&self, agent: AgentId) -> Envelope<PlayState> {
        let mut inner = self.inner.lock().await;
        if let Err(error) = self.check_rate(agent) {
            return failed_env(&self.cfg, &mut inner, Some(agent), error);
        }
        self.touch_waiting(&mut inner, agent);
        let (nick, color) = match inner.agents.get(&agent) {
            Some(meta) => (
                meta.nick.to_string(),
                crate::play::color_of(agent, inner.agent_public.get(&agent)),
            ),
            None => return failed_env(&self.cfg, &mut inner, None, not_authenticated()),
        };
        let session_id = inner.sessions.get(&agent).copied();
        let joined = session_id.is_some();
        let placement = session_id
            .and_then(|id| inner.world.sessions.get(&id))
            .map(|session| match session.status {
                loo_core::SessionStatus::Inside => PlacementKind::Inside,
                loo_core::SessionStatus::Waiting => PlacementKind::Waiting,
            });
        let center = if joined {
            inner.world.agents.get(&agent).and_then(|agent| agent.pos)
        } else {
            None
        }
        .unwrap_or(inner.world.entrance);
        let window = play::window_around(&inner.world, center);
        let objects = play::objects_in(&inner.world, &self.cfg, &window);
        let agents = play::agents_in(&inner.world, &self.cfg, &window, &inner.agent_public);
        let state = agent_view(&self.cfg, &inner, agent);
        let map = loo_core::map_memory(&inner.world, agent);
        let tick = inner.world.tick;
        let elapsed = inner.last_settle_at.elapsed().as_secs_f64();
        let ms_to_next_tick =
            ((self.cfg.tick_seconds.max(0.05) - elapsed).max(0.0) * 1000.0) as u64;
        let events = take_events(&mut inner, agent);
        drop(inner);
        Envelope::ok(
            PlayState {
                me: PlayMe {
                    agent_id: agent,
                    nick,
                    color,
                },
                tick,
                tick_seconds: self.cfg.tick_seconds,
                ms_to_next_tick,
                joined,
                placement,
                window,
                objects,
                agents,
                agent: state,
                map,
            },
            events,
            None,
        )
    }

    /// Official agent registration (contract §1): attach, create, or refuse.
    /// `caller_token` is the account token from `Authorization: Bearer`.
    pub async fn register_official_agent(
        &self,
        caller_token: &str,
        req: RegisterRequest,
    ) -> Envelope<AccountRegisterResponse> {
        let user_id = match self
            .store
            .auth_token_lookup(&auth::sha256_hex(caller_token))
        {
            Ok(Some(user_id)) => user_id,
            Ok(None) => {
                return error_envelope(ErrorCode::NotAuthenticated, not_authenticated().message)
            }
            Err(error) => {
                return error_envelope(
                    ErrorCode::Internal,
                    format!("reading the token failed: {error}"),
                )
            }
        };

        let Some(nick) = req.name else {
            return error_envelope(ErrorCode::BadRequest, "--name is required");
        };
        let model = req.model.unwrap_or_default();
        if model.trim().is_empty() || model.len() > 64 {
            return error_envelope(ErrorCode::BadRequest, "model must be 1-64 bytes");
        }
        let intro = req.intro.unwrap_or_default();
        if intro.trim().is_empty() || intro.len() > 200 {
            return error_envelope(ErrorCode::BadRequest, "intro must be 1-200 bytes");
        }

        let mut inner = self.inner.lock().await;
        match self.store.agent_by_nick(nick.as_str()) {
            Ok(Some((agent_id, owner))) if owner == Some(user_id) => {
                // A human character is created and driven by /play only; the
                // CLI must never attach to it and then act as if it were an AI.
                match self.store.agent_kind(agent_id) {
                    Ok(Some(PlayerKind::Human)) => {
                        drop(inner);
                        return error_envelope(
                            ErrorCode::BadRequest,
                            format!("nickname {nick} is a human character; play it in /play"),
                        );
                    }
                    Ok(Some(PlayerKind::Ai)) => {}
                    Ok(None) => {
                        drop(inner);
                        return error_envelope(
                            ErrorCode::Internal,
                            format!("agent {agent_id} has no player kind"),
                        );
                    }
                    Err(error) => {
                        drop(inner);
                        return error_envelope(
                            ErrorCode::Internal,
                            format!("reading the player kind failed: {error}"),
                        );
                    }
                }
                match self
                    .store
                    .update_account_agent(user_id, nick.as_str(), &model, &intro)
                {
                    Ok(Some(agent_id)) => {
                        if let Some(meta) = inner.agents.get_mut(&agent_id) {
                            meta.model = model;
                            meta.intro = intro;
                        }
                        return Envelope::ok(
                            AccountRegisterResponse {
                                agent_id,
                                nick: nick.to_string(),
                                attached: true,
                            },
                            Vec::new(),
                            None,
                        );
                    }
                    Ok(None) => {
                        return error_envelope(
                            ErrorCode::BadRequest,
                            format!("nickname {nick} is not yours to attach"),
                        )
                    }
                    Err(error) => {
                        return error_envelope(
                            ErrorCode::Internal,
                            format!("updating the agent failed: {error}"),
                        )
                    }
                }
            }
            Ok(Some((_, _))) => {
                drop(inner);
                return error_envelope(
                    ErrorCode::BadRequest,
                    format!("nickname {nick} is already taken"),
                );
            }
            Ok(None) => {}
            Err(error) => {
                return error_envelope(
                    ErrorCode::Internal,
                    format!("reading the nickname failed: {error}"),
                )
            }
        }

        let limit = self.cfg.session.max_agents_per_user;
        let count = match self.store.agents_of_user(user_id) {
            Ok(agents) => agents.len(),
            Err(error) => {
                return error_envelope(
                    ErrorCode::Internal,
                    format!("counting the account agents failed: {error}"),
                )
            }
        };
        if count >= limit {
            drop(inner);
            return error_envelope(
                ErrorCode::BadRequest,
                format!("this account already has {count} agents; the limit is {limit}"),
            );
        }
        let agent_id = match self
            .store
            .create_account_agent(user_id, nick.as_str(), &model, &intro)
        {
            Ok(agent_id) => agent_id,
            Err(error) => {
                return error_envelope(
                    ErrorCode::Internal,
                    format!("creating the agent failed: {error}"),
                )
            }
        };
        inner.agents.insert(
            agent_id,
            AgentMeta {
                nick: nick.clone(),
                model,
                intro,
                token: String::new(),
                sent_by: None,
                why: String::new(),
                score_total: 0,
                kind: PlayerKind::Ai,
                color: None,
            },
        );
        inner.next_agent_id = inner.next_agent_id.max(agent_id + 1);
        Envelope::ok(
            AccountRegisterResponse {
                agent_id,
                nick: nick.to_string(),
                attached: false,
            },
            Vec::new(),
            None,
        )
    }

    /// Dev mode only (design §2.3): hands out a temporary identity, no account.
    pub async fn dev_register(&self, req: RegisterRequest) -> Envelope<RegisterResponse> {
        let started = Instant::now();
        let mut inner = self.inner.lock().await;

        if let Some(model) = &req.model {
            if model.trim().is_empty() || model.chars().count() > 64 {
                let env = failed_env(
                    &self.cfg,
                    &mut inner,
                    None,
                    ApiError::new(ErrorCode::BadRequest, "model must be 1-64 characters"),
                );
                drop(inner);
                return self.finish("register", None, 0, env, started, "bad model", None);
            }
        }
        if let Some(intro) = &req.intro {
            if intro.chars().count() > 200 {
                let env = failed_env(
                    &self.cfg,
                    &mut inner,
                    None,
                    ApiError::new(
                        ErrorCode::BadRequest,
                        "intro must be at most 200 characters",
                    ),
                );
                drop(inner);
                return self.finish("register", None, 0, env, started, "bad intro", None);
            }
        }

        let agent_id = inner.next_agent_id;
        let nick = match &req.name {
            Some(name) => {
                if inner.agents.values().any(|m| m.nick == *name) {
                    let env = failed_env(
                        &self.cfg,
                        &mut inner,
                        None,
                        ApiError::new(
                            ErrorCode::BadRequest,
                            format!("nickname {name} is already taken"),
                        ),
                    );
                    drop(inner);
                    return self.finish("register", None, 0, env, started, "nickname taken", None);
                }
                name.clone()
            }
            None => loo_proto::Nick::parse(&format!("dev-{agent_id}"))
                .expect("generated dev nickname is valid"),
        };
        let model = req.model.unwrap_or_default();
        let intro = req.intro.unwrap_or_default();
        let token = format!("dev-{agent_id:x}-{:x}", next_nonce());
        inner.next_agent_id += 1;
        self.remember_dev_token(&token, agent_id);
        inner.agents.insert(
            agent_id,
            AgentMeta {
                nick: nick.clone(),
                model: model.clone(),
                intro: intro.clone(),
                token: token.clone(),
                sent_by: None,
                why: String::new(),
                score_total: 0,
                kind: PlayerKind::Ai,
                color: None,
            },
        );
        if let Err(error) = self
            .store
            .insert_agent(agent_id, nick.as_str(), &model, &intro, &token)
        {
            eprintln!("agent {agent_id} was not persisted: {error}");
        }
        let tick = inner.world.tick;
        let state = agent_view(&self.cfg, &inner, agent_id);
        let env = Envelope::ok(
            RegisterResponse {
                agent_id,
                nick: nick.to_string(),
                token,
                server_tick: tick,
            },
            Vec::new(),
            state,
        );
        drop(inner);
        let summary = format!("agent {agent_id} as {nick}");
        self.finish(
            "register",
            Some(agent_id),
            tick,
            env,
            started,
            summary,
            None,
        )
    }

    pub async fn join(&self, token: &str, req: JoinRequest) -> Envelope<JoinResponse> {
        let started = Instant::now();
        let Some(agent) = self.authenticate(token) else {
            let mut inner = self.inner.lock().await;
            let env = failed_env(&self.cfg, &mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("join", None, 0, env, started, "not authenticated", None);
        };
        self.join_for_agent(agent, req).await
    }

    /// The single implementation behind the CLI token entry and the browser:
    /// rules, rate limit, persistence and event delivery all live here.
    pub async fn join_for_agent(&self, agent: AgentId, req: JoinRequest) -> Envelope<JoinResponse> {
        let started = Instant::now();
        let mut inner = self.inner.lock().await;
        let tick = inner.world.tick;
        if let Err(error) = self.check_rate(agent) {
            let env = failed_env(&self.cfg, &mut inner, Some(agent), error);
            drop(inner);
            return self.finish(
                "join",
                Some(agent),
                tick,
                env,
                started,
                "rate limited",
                None,
            );
        }
        self.touch_waiting(&mut inner, agent);

        let why = req.why.trim().to_string();
        if why.is_empty() || why.chars().count() > 200 {
            let env = failed_env(
                &self.cfg,
                &mut inner,
                Some(agent),
                ApiError::new(
                    ErrorCode::BadRequest,
                    "--why is required: one sentence, at most 200 characters",
                ),
            );
            drop(inner);
            return self.finish(
                "join",
                Some(agent),
                tick,
                env,
                started,
                "missing --why",
                None,
            );
        }
        if let Some(existing) = inner.sessions.get(&agent).copied() {
            let env = failed_env(&self.cfg,
                &mut inner,
                Some(agent),
                ApiError::rule(format!(
                    "you already have session {existing} in this world; leave it with `loo leave` first"
                )),
            );
            drop(inner);
            return self.finish(
                "join",
                Some(agent),
                tick,
                env,
                started,
                "already joined",
                None,
            );
        }

        let Some(meta) = inner.agents.get(&agent) else {
            let env = failed_env(&self.cfg, &mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("join", None, 0, env, started, "no agent", None);
        };
        let agent_kind = meta.kind;
        let agent_color = meta.color;
        let session_id = inner.next_session_id;
        let cmd = JoinCommand {
            agent,
            nick: meta.nick.clone(),
            session: session_id,
            score_total: meta.score_total,
        };

        let start_seq = inner.last_seq;
        let tick_seed = inner.tick_seed;
        let placement = match loo_core::join(&inner.world, &cmd, &self.cfg, start_seq, tick_seed) {
            Ok((world, outcome, events)) => {
                if let Err(error) = self.store.append_join_events(world.tick, &events) {
                    eprintln!("join events for agent {agent} were not persisted: {error}");
                    let env = failed_env::<JoinResponse>(
                        &self.cfg,
                        &mut inner,
                        Some(agent),
                        ApiError::new(
                            ErrorCode::Internal,
                            "the join could not be recorded; try again",
                        ),
                    );
                    drop(inner);
                    return self.finish(
                        "join",
                        Some(agent),
                        tick,
                        env,
                        started,
                        "join not persisted",
                        None,
                    );
                }
                inner.world = world;
                inner.last_seq = events.last().map(|event| event.seq).unwrap_or(start_seq);
                inner.next_session_id += 1;
                inner.sessions.insert(agent, session_id);
                inner.agent_public.insert(
                    agent,
                    AgentPublic {
                        sent_by: Some(req.sent_by),
                        kind: agent_kind,
                        color: agent_color,
                    },
                );
                // Join events belong to the current tick, so the live projection
                // of that tick matches what `projection_at` replays.
                inner.current_events.extend(events.iter().cloned());
                // A fresh join starts with a clean slate: no intents or events
                // from the previous session of this agent.
                inner.outbox.remove(&agent);
                inner.pending.remove(&agent);
                if let Some(meta) = inner.agents.get_mut(&agent) {
                    meta.sent_by = Some(req.sent_by);
                    meta.why = why.clone();
                }
                if let Err(error) =
                    self.store
                        .update_agent_entry(agent, Some(req.sent_by.as_str()), &why)
                {
                    eprintln!("agent {agent} join entry was not persisted: {error}");
                }
                let need = inner
                    .world
                    .sessions
                    .get(&session_id)
                    .and_then(|session| session.need);
                if let Err(error) = self.store.insert_session(
                    session_id,
                    WORLD_ID as u64,
                    agent,
                    tick,
                    need,
                    Some(req.sent_by),
                    &why,
                ) {
                    eprintln!("session {session_id} was not persisted: {error}");
                }
                match outcome {
                    JoinOutcome::Inside { at } => {
                        let briefing: Briefing = loo_core::briefing(&inner.world, &self.cfg);
                        Placement::Inside { at, briefing }
                    }
                    JoinOutcome::Waiting { ahead } => Placement::Waiting { ahead },
                }
            }
            Err(reject) => {
                let code = match reject.kind {
                    JoinRejectKind::QueueFull => ErrorCode::QueueFull,
                    JoinRejectKind::AlreadyJoined => ErrorCode::RuleRejected,
                };
                let env = failed_env(
                    &self.cfg,
                    &mut inner,
                    Some(agent),
                    ApiError::new(code, reject.message),
                );
                drop(inner);
                return self.finish(
                    "join",
                    Some(agent),
                    tick,
                    env,
                    started,
                    "join rejected",
                    None,
                );
            }
        };

        let summary = match &placement {
            Placement::Inside { at, .. } => format!("session {session_id} inside at {at}"),
            Placement::Waiting { ahead } => format!("session {session_id} waiting, {ahead} ahead"),
        };
        let env = ok_env(
            &self.cfg,
            &mut inner,
            agent,
            JoinResponse {
                session_id,
                placement,
            },
        );
        drop(inner);
        self.finish("join", Some(agent), tick, env, started, summary, None)
    }

    pub async fn look(&self, token: &str) -> Envelope<LookResponse> {
        let started = Instant::now();
        let Some(agent) = self.authenticate(token) else {
            let mut inner = self.inner.lock().await;
            let env = failed_env(&self.cfg, &mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("look", None, 0, env, started, "not authenticated", None);
        };
        self.look_for_agent(agent).await
    }

    /// See [`Server::join_for_agent`].
    pub async fn look_for_agent(&self, agent: AgentId) -> Envelope<LookResponse> {
        let started = Instant::now();
        let mut inner = self.inner.lock().await;
        let tick = inner.world.tick;
        if let Err(error) = self.check_rate(agent) {
            let env = failed_env(&self.cfg, &mut inner, Some(agent), error);
            drop(inner);
            return self.finish(
                "look",
                Some(agent),
                tick,
                env,
                started,
                "rate limited",
                None,
            );
        }
        self.touch_waiting(&mut inner, agent);
        let env = match loo_core::look(&inner.world, agent, &self.cfg) {
            Some(view) => ok_env(&self.cfg, &mut inner, agent, view),
            None => {
                let err = session_required(&inner, agent);
                failed_env(&self.cfg, &mut inner, Some(agent), err)
            }
        };
        let summary = if env.ok { "view" } else { "rejected" };
        drop(inner);
        self.finish("look", Some(agent), tick, env, started, summary, None)
    }

    pub async fn map_view(&self, token: &str) -> Envelope<MapResponse> {
        let started = Instant::now();
        let Some(agent) = self.authenticate(token) else {
            let mut inner = self.inner.lock().await;
            let env = failed_env(&self.cfg, &mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("map", None, 0, env, started, "not authenticated", None);
        };
        self.map_view_for_agent(agent).await
    }

    /// See [`Server::join_for_agent`].
    pub async fn map_view_for_agent(&self, agent: AgentId) -> Envelope<MapResponse> {
        let started = Instant::now();
        let mut inner = self.inner.lock().await;
        let tick = inner.world.tick;
        if let Err(error) = self.check_rate(agent) {
            let env = failed_env(&self.cfg, &mut inner, Some(agent), error);
            drop(inner);
            return self.finish("map", Some(agent), tick, env, started, "rate limited", None);
        }
        self.touch_waiting(&mut inner, agent);
        let env = match loo_core::map_memory(&inner.world, agent) {
            Some(view) => ok_env(&self.cfg, &mut inner, agent, view),
            None => {
                let err = session_required(&inner, agent);
                failed_env(&self.cfg, &mut inner, Some(agent), err)
            }
        };
        let summary = if env.ok { "map memory" } else { "rejected" };
        drop(inner);
        self.finish("map", Some(agent), tick, env, started, summary, None)
    }

    pub async fn status(&self, token: &str) -> Envelope<()> {
        let started = Instant::now();
        let Some(agent) = self.authenticate(token) else {
            let mut inner = self.inner.lock().await;
            let env = failed_env(&self.cfg, &mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("status", None, 0, env, started, "not authenticated", None);
        };
        self.status_for_agent(agent).await
    }

    /// See [`Server::join_for_agent`].
    pub async fn status_for_agent(&self, agent: AgentId) -> Envelope<()> {
        let started = Instant::now();
        let mut inner = self.inner.lock().await;
        let tick = inner.world.tick;
        if let Err(error) = self.check_rate(agent) {
            let env = failed_env(&self.cfg, &mut inner, Some(agent), error);
            drop(inner);
            return self.finish(
                "status",
                Some(agent),
                tick,
                env,
                started,
                "rate limited",
                None,
            );
        }
        self.touch_waiting(&mut inner, agent);
        let env = ok_env(&self.cfg, &mut inner, agent, ());
        drop(inner);
        self.finish("status", Some(agent), tick, env, started, "state", None)
    }

    /// Read-only timings for the CLI (no identity required, logged like rules).
    pub async fn config_response(&self) -> Envelope<ConfigResponse> {
        let started = Instant::now();
        let (tick, cfg) = {
            let inner = self.inner.lock().await;
            (inner.world.tick, self.cfg.clone())
        };
        let result = ConfigResponse {
            tick_seconds: cfg.tick_seconds,
            wait_default_seconds: cfg.wait.default_seconds,
            wait_effective_default_seconds: cfg.wait_default_seconds(),
            wait_max_seconds: cfg.wait.max_seconds,
            snapshot_interval_ticks: cfg.persist.snapshot_interval_ticks,
            max_on_field: cfg.max_on_field,
            deadline_ticks_min: cfg.need.deadline_ticks_min,
            deadline_ticks_max: cfg.need.deadline_ticks_max,
            time_bonus_percent: cfg.need.time_bonus_percent,
            windup_ticks: cfg.combat.windup_ticks,
            defend_ticks: cfg.combat.defend_ticks,
        };
        let env = Envelope::ok(result, Vec::new(), None);
        self.finish("config", None, tick, env, started, "timings", None)
    }

    pub async fn rules(&self) -> Envelope<RulesResponse> {
        let started = Instant::now();
        let (width, height, tick) = {
            let inner = self.inner.lock().await;
            (
                inner.world.map.width(),
                inner.world.map.height(),
                inner.world.tick,
            )
        };
        let text = rules_text(&self.cfg, width, height, self.official());
        let env = Envelope::ok(RulesResponse { text }, Vec::new(), None);
        // `rules` needs no identity, but design §8 logs every command.
        self.finish("rules", None, tick, env, started, "rules text", None)
    }

    pub async fn move_cmd(&self, token: &str, req: MoveRequest) -> Envelope<ActionQueued> {
        let started = Instant::now();
        let Some(agent) = self.authenticate(token) else {
            let mut inner = self.inner.lock().await;
            let env = failed_env(&self.cfg, &mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("move", None, 0, env, started, "not authenticated", None);
        };
        self.move_cmd_for_agent(agent, req).await
    }

    /// See [`Server::join_for_agent`].
    pub async fn move_cmd_for_agent(
        &self,
        agent: AgentId,
        req: MoveRequest,
    ) -> Envelope<ActionQueued> {
        let started = Instant::now();
        let mut inner = self.inner.lock().await;
        let tick = inner.world.tick;
        if let Err(error) = self.check_rate(agent) {
            let env = failed_env(&self.cfg, &mut inner, Some(agent), error);
            drop(inner);
            return self.finish(
                "move",
                Some(agent),
                tick,
                env,
                started,
                "rate limited",
                None,
            );
        }
        self.touch_waiting(&mut inner, agent);

        let dirs = match req.spec.dirs() {
            Ok(dirs) => dirs,
            Err(message) => {
                let env = failed_env(
                    &self.cfg,
                    &mut inner,
                    Some(agent),
                    ApiError::new(ErrorCode::BadRequest, message),
                );
                drop(inner);
                return self.finish("move", Some(agent), tick, env, started, "bad move", None);
            }
        };
        if dirs.is_empty() {
            let env = failed_env(
                &self.cfg,
                &mut inner,
                Some(agent),
                ApiError::new(ErrorCode::BadRequest, "empty path"),
            );
            drop(inner);
            return self.finish("move", Some(agent), tick, env, started, "empty path", None);
        }
        let max_steps = (inner.world.map.width() + inner.world.map.height()) as usize;
        if dirs.len() > max_steps {
            let env = failed_env(
                &self.cfg,
                &mut inner,
                Some(agent),
                ApiError::new(
                    ErrorCode::BadRequest,
                    format!("a move path is at most {max_steps} steps on this map"),
                ),
            );
            drop(inner);
            return self.finish(
                "move",
                Some(agent),
                tick,
                env,
                started,
                "path too long",
                None,
            );
        }
        if let Err(error) = require_session_pos(&inner, agent) {
            let env = failed_env(&self.cfg, &mut inner, Some(agent), error);
            drop(inner);
            return self.finish("move", Some(agent), tick, env, started, "not inside", None);
        }

        let label = req.spec.label();
        let action = ActionState {
            description: label.clone(),
            remaining: dirs.len() as u32,
        };
        let kind = IntentKind::Move {
            dirs,
            label: label.clone(),
        };
        let intent_json = serde_json::to_value(&kind).ok();
        queue_intent(&mut inner, agent, kind);
        let effective_tick = tick + 1;
        let env = ok_env(
            &self.cfg,
            &mut inner,
            agent,
            ActionQueued {
                action,
                effective_tick,
            },
        );
        drop(inner);
        self.finish(
            "move",
            Some(agent),
            tick,
            env,
            started,
            format!("queued {label} for tick {effective_tick}"),
            intent_json.as_ref(),
        )
    }

    pub async fn build_cmd(&self, token: &str, req: BuildRequest) -> Envelope<ActionQueued> {
        let started = Instant::now();
        let Some(agent) = self.authenticate(token) else {
            let mut inner = self.inner.lock().await;
            let env = failed_env(&self.cfg, &mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("build", None, 0, env, started, "not authenticated", None);
        };
        self.build_cmd_for_agent(agent, req).await
    }

    /// See [`Server::join_for_agent`].
    pub async fn build_cmd_for_agent(
        &self,
        agent: AgentId,
        req: BuildRequest,
    ) -> Envelope<ActionQueued> {
        let started = Instant::now();
        let mut inner = self.inner.lock().await;
        let tick = inner.world.tick;
        if let Err(error) = self.check_rate(agent) {
            let env = failed_env(&self.cfg, &mut inner, Some(agent), error);
            drop(inner);
            return self.finish(
                "build",
                Some(agent),
                tick,
                env,
                started,
                "rate limited",
                None,
            );
        }
        self.touch_waiting(&mut inner, agent);
        let pos = match require_inside(&inner, agent) {
            Ok(pos) => pos,
            Err(error) => {
                let env = failed_env(&self.cfg, &mut inner, Some(agent), error);
                drop(inner);
                return self.finish("build", Some(agent), tick, env, started, "not inside", None);
            }
        };
        let target = absolute_target(pos, req.target);
        let kind = site_kind(req.kind);
        if let Err(message) = loo_core::validate_build(&inner.world, agent, kind, target, &self.cfg)
        {
            let env = failed_env(&self.cfg, &mut inner, Some(agent), ApiError::rule(message));
            drop(inner);
            return self.finish(
                "build",
                Some(agent),
                tick,
                env,
                started,
                format!("rejected build {} at {target}", kind_word(kind)),
                None,
            );
        }
        let label = format!("build {} {}", kind_word(kind), target);
        let intent = IntentKind::Build { kind, target };
        let intent_json = serde_json::to_value(&intent).ok();
        queue_intent(&mut inner, agent, intent);
        let effective_tick = tick + 1;
        let env = ok_env(
            &self.cfg,
            &mut inner,
            agent,
            ActionQueued {
                action: ActionState {
                    description: label.clone(),
                    remaining: 0,
                },
                effective_tick,
            },
        );
        drop(inner);
        self.finish(
            "build",
            Some(agent),
            tick,
            env,
            started,
            format!("queued {label} for tick {effective_tick}"),
            intent_json.as_ref(),
        )
    }

    pub async fn demolish_cmd(&self, token: &str, req: DemolishRequest) -> Envelope<ActionQueued> {
        let started = Instant::now();
        let Some(agent) = self.authenticate(token) else {
            let mut inner = self.inner.lock().await;
            let env = failed_env(&self.cfg, &mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("demolish", None, 0, env, started, "not authenticated", None);
        };
        self.demolish_cmd_for_agent(agent, req).await
    }

    /// See [`Server::join_for_agent`].
    pub async fn demolish_cmd_for_agent(
        &self,
        agent: AgentId,
        req: DemolishRequest,
    ) -> Envelope<ActionQueued> {
        let started = Instant::now();
        let mut inner = self.inner.lock().await;
        let tick = inner.world.tick;
        if let Err(error) = self.check_rate(agent) {
            let env = failed_env(&self.cfg, &mut inner, Some(agent), error);
            drop(inner);
            return self.finish(
                "demolish",
                Some(agent),
                tick,
                env,
                started,
                "rate limited",
                None,
            );
        }
        self.touch_waiting(&mut inner, agent);
        let pos = match require_inside(&inner, agent) {
            Ok(pos) => pos,
            Err(error) => {
                let env = failed_env(&self.cfg, &mut inner, Some(agent), error);
                drop(inner);
                return self.finish(
                    "demolish",
                    Some(agent),
                    tick,
                    env,
                    started,
                    "not inside",
                    None,
                );
            }
        };
        let target = absolute_target(pos, req.target);
        if let Err(message) = loo_core::validate_demolish(&inner.world, agent, target) {
            let env = failed_env(&self.cfg, &mut inner, Some(agent), ApiError::rule(message));
            drop(inner);
            return self.finish(
                "demolish",
                Some(agent),
                tick,
                env,
                started,
                format!("rejected demolish at {target}"),
                None,
            );
        }
        let label = format!("demolish {target}");
        let intent = IntentKind::Demolish { target };
        let intent_json = serde_json::to_value(&intent).ok();
        queue_intent(&mut inner, agent, intent);
        let effective_tick = tick + 1;
        let env = ok_env(
            &self.cfg,
            &mut inner,
            agent,
            ActionQueued {
                action: ActionState {
                    description: label.clone(),
                    remaining: 0,
                },
                effective_tick,
            },
        );
        drop(inner);
        self.finish(
            "demolish",
            Some(agent),
            tick,
            env,
            started,
            format!("queued {label} for tick {effective_tick}"),
            intent_json.as_ref(),
        )
    }

    pub async fn door_cmd(&self, token: &str, req: DoorRequest) -> Envelope<ActionQueued> {
        let started = Instant::now();
        let Some(agent) = self.authenticate(token) else {
            let mut inner = self.inner.lock().await;
            let env = failed_env(&self.cfg, &mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("door", None, 0, env, started, "not authenticated", None);
        };
        self.door_cmd_for_agent(agent, req).await
    }

    /// See [`Server::join_for_agent`].
    pub async fn door_cmd_for_agent(
        &self,
        agent: AgentId,
        req: DoorRequest,
    ) -> Envelope<ActionQueued> {
        let started = Instant::now();
        let mut inner = self.inner.lock().await;
        let tick = inner.world.tick;
        if let Err(error) = self.check_rate(agent) {
            let env = failed_env(&self.cfg, &mut inner, Some(agent), error);
            drop(inner);
            return self.finish(
                "door",
                Some(agent),
                tick,
                env,
                started,
                "rate limited",
                None,
            );
        }
        self.touch_waiting(&mut inner, agent);
        let pos = match require_inside(&inner, agent) {
            Ok(pos) => pos,
            Err(error) => {
                let env = failed_env(&self.cfg, &mut inner, Some(agent), error);
                drop(inner);
                return self.finish("door", Some(agent), tick, env, started, "not inside", None);
            }
        };
        let target = pos.step(req.target);
        if let Err(message) = loo_core::validate_door(&inner.world, agent, target, req.open) {
            let env = failed_env(&self.cfg, &mut inner, Some(agent), ApiError::rule(message));
            drop(inner);
            return self.finish(
                "door",
                Some(agent),
                tick,
                env,
                started,
                format!("rejected door at {target}"),
                None,
            );
        }
        let label = format!("{} door {target}", if req.open { "open" } else { "close" });
        let intent = IntentKind::Door {
            target,
            open: req.open,
        };
        let intent_json = serde_json::to_value(&intent).ok();
        queue_intent(&mut inner, agent, intent);
        let effective_tick = tick + 1;
        let env = ok_env(
            &self.cfg,
            &mut inner,
            agent,
            ActionQueued {
                action: ActionState {
                    description: label.clone(),
                    remaining: 0,
                },
                effective_tick,
            },
        );
        drop(inner);
        self.finish(
            "door",
            Some(agent),
            tick,
            env,
            started,
            format!("queued {label} for tick {effective_tick}"),
            intent_json.as_ref(),
        )
    }

    pub async fn attack_cmd(&self, token: &str, req: AttackRequest) -> Envelope<ActionQueued> {
        let started = Instant::now();
        let Some(agent) = self.authenticate(token) else {
            let mut inner = self.inner.lock().await;
            let env = failed_env(&self.cfg, &mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("attack", None, 0, env, started, "not authenticated", None);
        };
        self.attack_cmd_for_agent(agent, req).await
    }

    /// See [`Server::join_for_agent`].
    pub async fn attack_cmd_for_agent(
        &self,
        agent: AgentId,
        req: AttackRequest,
    ) -> Envelope<ActionQueued> {
        let started = Instant::now();
        let mut inner = self.inner.lock().await;
        let tick = inner.world.tick;
        if let Err(error) = self.check_rate(agent) {
            let env = failed_env(&self.cfg, &mut inner, Some(agent), error);
            drop(inner);
            return self.finish(
                "attack",
                Some(agent),
                tick,
                env,
                started,
                "rate limited",
                None,
            );
        }
        self.touch_waiting(&mut inner, agent);
        let pos = match require_session_pos(&inner, agent) {
            Ok(pos) => pos,
            Err(error) => {
                let env = failed_env(&self.cfg, &mut inner, Some(agent), error);
                drop(inner);
                return self.finish(
                    "attack",
                    Some(agent),
                    tick,
                    env,
                    started,
                    "not inside",
                    None,
                );
            }
        };
        let target = pos.step(req.dir);
        if let Err(message) =
            loo_core::validate_attack_at(&inner.world, agent, target, &self.cfg, tick + 1)
        {
            let env = failed_env(&self.cfg, &mut inner, Some(agent), ApiError::rule(message));
            drop(inner);
            return self.finish(
                "attack",
                Some(agent),
                tick,
                env,
                started,
                format!("rejected attack at {target}"),
                None,
            );
        }
        let label = format!("attack the agent at {target}");
        let intent = IntentKind::Attack { target };
        let intent_json = serde_json::to_value(&intent).ok();
        queue_intent(&mut inner, agent, intent);
        let effective_tick = tick + 1;
        let env = ok_env(
            &self.cfg,
            &mut inner,
            agent,
            ActionQueued {
                action: ActionState {
                    description: label.clone(),
                    remaining: 0,
                },
                effective_tick,
            },
        );
        drop(inner);
        self.finish(
            "attack",
            Some(agent),
            tick,
            env,
            started,
            format!("queued {label} for tick {effective_tick}"),
            intent_json.as_ref(),
        )
    }

    pub async fn defend_cmd(&self, token: &str, req: DefendRequest) -> Envelope<ActionQueued> {
        let started = Instant::now();
        let Some(agent) = self.authenticate(token) else {
            let mut inner = self.inner.lock().await;
            let env = failed_env(&self.cfg, &mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("defend", None, 0, env, started, "not authenticated", None);
        };
        self.defend_cmd_for_agent(agent, req).await
    }

    /// See [`Server::join_for_agent`].
    pub async fn defend_cmd_for_agent(
        &self,
        agent: AgentId,
        req: DefendRequest,
    ) -> Envelope<ActionQueued> {
        let started = Instant::now();
        let mut inner = self.inner.lock().await;
        let tick = inner.world.tick;
        if let Err(error) = self.check_rate(agent) {
            let env = failed_env(&self.cfg, &mut inner, Some(agent), error);
            drop(inner);
            return self.finish(
                "defend",
                Some(agent),
                tick,
                env,
                started,
                "rate limited",
                None,
            );
        }
        self.touch_waiting(&mut inner, agent);
        let pos = match require_session_pos(&inner, agent) {
            Ok(pos) => pos,
            Err(error) => {
                let env = failed_env(&self.cfg, &mut inner, Some(agent), error);
                drop(inner);
                return self.finish(
                    "defend",
                    Some(agent),
                    tick,
                    env,
                    started,
                    "not inside",
                    None,
                );
            }
        };
        let target = pos.step(req.dir);
        if let Err(message) = loo_core::validate_defend_at(&inner.world, agent, target, tick + 1) {
            let env = failed_env(&self.cfg, &mut inner, Some(agent), ApiError::rule(message));
            drop(inner);
            return self.finish(
                "defend",
                Some(agent),
                tick,
                env,
                started,
                format!("rejected defend at {target}"),
                None,
            );
        }
        let label = format!("defend {target} for {} ticks", self.cfg.combat.defend_ticks);
        let intent = IntentKind::Defend { target };
        let intent_json = serde_json::to_value(&intent).ok();
        queue_intent(&mut inner, agent, intent);
        let effective_tick = tick + 1;
        let env = ok_env(
            &self.cfg,
            &mut inner,
            agent,
            ActionQueued {
                action: ActionState {
                    description: label.clone(),
                    remaining: 0,
                },
                effective_tick,
            },
        );
        drop(inner);
        self.finish(
            "defend",
            Some(agent),
            tick,
            env,
            started,
            format!("queued {label} for tick {effective_tick}"),
            intent_json.as_ref(),
        )
    }

    pub async fn upgrade_cmd(&self, token: &str, req: UpgradeRequest) -> Envelope<ActionQueued> {
        let started = Instant::now();
        let Some(agent) = self.authenticate(token) else {
            let mut inner = self.inner.lock().await;
            let env = failed_env(&self.cfg, &mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("upgrade", None, 0, env, started, "not authenticated", None);
        };
        self.upgrade_cmd_for_agent(agent, req).await
    }

    /// See [`Server::join_for_agent`].
    pub async fn upgrade_cmd_for_agent(
        &self,
        agent: AgentId,
        req: UpgradeRequest,
    ) -> Envelope<ActionQueued> {
        let started = Instant::now();
        let mut inner = self.inner.lock().await;
        let tick = inner.world.tick;
        if let Err(error) = self.check_rate(agent) {
            let env = failed_env(&self.cfg, &mut inner, Some(agent), error);
            drop(inner);
            return self.finish(
                "upgrade",
                Some(agent),
                tick,
                env,
                started,
                "rate limited",
                None,
            );
        }
        self.touch_waiting(&mut inner, agent);
        let pos = match require_inside(&inner, agent) {
            Ok(pos) => pos,
            Err(error) => {
                let env = failed_env(&self.cfg, &mut inner, Some(agent), error);
                drop(inner);
                return self.finish(
                    "upgrade",
                    Some(agent),
                    tick,
                    env,
                    started,
                    "not inside",
                    None,
                );
            }
        };
        let target = absolute_target(pos, req.target);
        if let Err(message) = loo_core::validate_upgrade(&inner.world, agent, target, &self.cfg) {
            let env = failed_env(&self.cfg, &mut inner, Some(agent), ApiError::rule(message));
            drop(inner);
            return self.finish(
                "upgrade",
                Some(agent),
                tick,
                env,
                started,
                format!("rejected upgrade at {target}"),
                None,
            );
        }
        let label = format!("upgrade the toilet at {target}");
        let intent = IntentKind::Upgrade { target };
        let intent_json = serde_json::to_value(&intent).ok();
        queue_intent(&mut inner, agent, intent);
        let effective_tick = tick + 1;
        let env = ok_env(
            &self.cfg,
            &mut inner,
            agent,
            ActionQueued {
                action: ActionState {
                    description: label.clone(),
                    remaining: 0,
                },
                effective_tick,
            },
        );
        drop(inner);
        self.finish(
            "upgrade",
            Some(agent),
            tick,
            env,
            started,
            format!("queued {label} for tick {effective_tick}"),
            intent_json.as_ref(),
        )
    }

    pub async fn downgrade_cmd(
        &self,
        token: &str,
        req: DowngradeRequest,
    ) -> Envelope<ActionQueued> {
        let started = Instant::now();
        let Some(agent) = self.authenticate(token) else {
            let mut inner = self.inner.lock().await;
            let env = failed_env(&self.cfg, &mut inner, None, not_authenticated());
            drop(inner);
            return self.finish(
                "downgrade",
                None,
                0,
                env,
                started,
                "not authenticated",
                None,
            );
        };
        self.downgrade_cmd_for_agent(agent, req).await
    }

    /// See [`Server::join_for_agent`].
    pub async fn downgrade_cmd_for_agent(
        &self,
        agent: AgentId,
        req: DowngradeRequest,
    ) -> Envelope<ActionQueued> {
        let started = Instant::now();
        let mut inner = self.inner.lock().await;
        let tick = inner.world.tick;
        if let Err(error) = self.check_rate(agent) {
            let env = failed_env(&self.cfg, &mut inner, Some(agent), error);
            drop(inner);
            return self.finish(
                "downgrade",
                Some(agent),
                tick,
                env,
                started,
                "rate limited",
                None,
            );
        }
        self.touch_waiting(&mut inner, agent);
        let pos = match require_inside(&inner, agent) {
            Ok(pos) => pos,
            Err(error) => {
                let env = failed_env(&self.cfg, &mut inner, Some(agent), error);
                drop(inner);
                return self.finish(
                    "downgrade",
                    Some(agent),
                    tick,
                    env,
                    started,
                    "not inside",
                    None,
                );
            }
        };
        let target = absolute_target(pos, req.target);
        if let Err(message) = loo_core::validate_downgrade(&inner.world, agent, target, &self.cfg) {
            let env = failed_env(&self.cfg, &mut inner, Some(agent), ApiError::rule(message));
            drop(inner);
            return self.finish(
                "downgrade",
                Some(agent),
                tick,
                env,
                started,
                format!("rejected downgrade at {target}"),
                None,
            );
        }
        let label = format!("downgrade the toilet at {target}");
        let intent = IntentKind::Downgrade { target };
        let intent_json = serde_json::to_value(&intent).ok();
        queue_intent(&mut inner, agent, intent);
        let effective_tick = tick + 1;
        let env = ok_env(
            &self.cfg,
            &mut inner,
            agent,
            ActionQueued {
                action: ActionState {
                    description: label.clone(),
                    remaining: 0,
                },
                effective_tick,
            },
        );
        drop(inner);
        self.finish(
            "downgrade",
            Some(agent),
            tick,
            env,
            started,
            format!("queued {label} for tick {effective_tick}"),
            intent_json.as_ref(),
        )
    }

    pub async fn use_cmd(&self, token: &str) -> Envelope<ActionQueued> {
        let started = Instant::now();
        let Some(agent) = self.authenticate(token) else {
            let mut inner = self.inner.lock().await;
            let env = failed_env(&self.cfg, &mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("use", None, 0, env, started, "not authenticated", None);
        };
        self.use_cmd_for_agent(agent).await
    }

    /// See [`Server::join_for_agent`].
    pub async fn use_cmd_for_agent(&self, agent: AgentId) -> Envelope<ActionQueued> {
        let started = Instant::now();
        let mut inner = self.inner.lock().await;
        let tick = inner.world.tick;
        if let Err(error) = self.check_rate(agent) {
            let env = failed_env(&self.cfg, &mut inner, Some(agent), error);
            drop(inner);
            return self.finish("use", Some(agent), tick, env, started, "rate limited", None);
        }
        self.touch_waiting(&mut inner, agent);
        if let Err(error) = require_inside(&inner, agent) {
            let env = failed_env(&self.cfg, &mut inner, Some(agent), error);
            drop(inner);
            return self.finish("use", Some(agent), tick, env, started, "not inside", None);
        }
        let target = match loo_core::validate_use(&inner.world, agent, &self.cfg) {
            Ok(target) => target,
            Err(message) => {
                let env = failed_env(&self.cfg, &mut inner, Some(agent), ApiError::rule(message));
                drop(inner);
                return self.finish("use", Some(agent), tick, env, started, "rejected use", None);
            }
        };
        let label = format!("use the toilet at {target}");
        let intent = IntentKind::Use { target };
        let intent_json = serde_json::to_value(&intent).ok();
        queue_intent(&mut inner, agent, intent);
        let effective_tick = tick + 1;
        let env = ok_env(
            &self.cfg,
            &mut inner,
            agent,
            ActionQueued {
                action: ActionState {
                    description: label.clone(),
                    remaining: 0,
                },
                effective_tick,
            },
        );
        drop(inner);
        self.finish(
            "use",
            Some(agent),
            tick,
            env,
            started,
            format!("queued {label} for tick {effective_tick}"),
            intent_json.as_ref(),
        )
    }

    pub async fn cancel_cmd(&self, token: &str) -> Envelope<ActionQueued> {
        let started = Instant::now();
        let Some(agent) = self.authenticate(token) else {
            let mut inner = self.inner.lock().await;
            let env = failed_env(&self.cfg, &mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("cancel", None, 0, env, started, "not authenticated", None);
        };
        self.cancel_cmd_for_agent(agent).await
    }

    /// See [`Server::join_for_agent`].
    pub async fn cancel_cmd_for_agent(&self, agent: AgentId) -> Envelope<ActionQueued> {
        let started = Instant::now();
        let mut inner = self.inner.lock().await;
        let tick = inner.world.tick;
        if let Err(error) = self.check_rate(agent) {
            let env = failed_env(&self.cfg, &mut inner, Some(agent), error);
            drop(inner);
            return self.finish(
                "cancel",
                Some(agent),
                tick,
                env,
                started,
                "rate limited",
                None,
            );
        }
        self.touch_waiting(&mut inner, agent);
        let intent = IntentKind::Cancel;
        let intent_json = serde_json::to_value(&intent).ok();
        queue_intent(&mut inner, agent, intent);
        let effective_tick = tick + 1;
        let env = ok_env(
            &self.cfg,
            &mut inner,
            agent,
            ActionQueued {
                action: ActionState {
                    description: "cancel".to_string(),
                    remaining: 0,
                },
                effective_tick,
            },
        );
        drop(inner);
        self.finish(
            "cancel",
            Some(agent),
            tick,
            env,
            started,
            format!("queued cancel for tick {effective_tick}"),
            intent_json.as_ref(),
        )
    }

    pub async fn leave_cmd(&self, token: &str) -> Envelope<LeaveResponse> {
        let started = Instant::now();
        let Some(agent) = self.authenticate(token) else {
            let mut inner = self.inner.lock().await;
            let env = failed_env(&self.cfg, &mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("leave", None, 0, env, started, "not authenticated", None);
        };
        self.leave_cmd_for_agent(agent).await
    }

    /// See [`Server::join_for_agent`].
    pub async fn leave_cmd_for_agent(&self, agent: AgentId) -> Envelope<LeaveResponse> {
        let started = Instant::now();
        let mut inner = self.inner.lock().await;
        let tick = inner.world.tick;
        if let Err(error) = self.check_rate(agent) {
            let env = failed_env(&self.cfg, &mut inner, Some(agent), error);
            drop(inner);
            return self.finish(
                "leave",
                Some(agent),
                tick,
                env,
                started,
                "rate limited",
                None,
            );
        }
        self.touch_waiting(&mut inner, agent);
        let last_pos = inner.world.agents.get(&agent).and_then(|a| a.pos);
        match loo_core::leave(
            &inner.world,
            agent,
            inner.last_seq,
            inner.tick_seed,
            &self.cfg,
        ) {
            Err(message) => {
                let env = failed_env(&self.cfg, &mut inner, Some(agent), ApiError::rule(message));
                drop(inner);
                self.finish(
                    "leave",
                    Some(agent),
                    tick,
                    env,
                    started,
                    "rejected leave",
                    None,
                )
            }
            Ok((world, outcome, score, events)) => {
                if let Err(error) = self.store.append_join_events(world.tick, &events) {
                    eprintln!("leave events for agent {agent} were not persisted: {error}");
                    let env = failed_env::<LeaveResponse>(
                        &self.cfg,
                        &mut inner,
                        Some(agent),
                        ApiError::new(
                            ErrorCode::Internal,
                            "the leave could not be recorded; try again",
                        ),
                    );
                    drop(inner);
                    return self.finish(
                        "leave",
                        Some(agent),
                        tick,
                        env,
                        started,
                        "leave not persisted",
                        None,
                    );
                }
                inner.world = world;
                inner.last_seq = events
                    .last()
                    .map(|event| event.seq)
                    .unwrap_or(inner.last_seq);
                // A leave ends the session between ticks; the tick loop never
                // sees these events, so account for them here.
                self.record_session_events(&events);
                inner.sessions.remove(&agent);
                inner.pending.remove(&agent);
                // Keep the closing events for the agent to read on its next
                // command or wait.
                for event in &events {
                    if event.visible_to(agent, last_pos, &self.cfg) {
                        let queue = inner.outbox.entry(agent).or_default();
                        if queue.len() < MAX_OUTBOX {
                            queue.push(event.clone());
                        }
                    }
                }
                let env = ok_env(
                    &self.cfg,
                    &mut inner,
                    agent,
                    LeaveResponse { outcome, score },
                );
                drop(inner);
                self.finish(
                    "leave",
                    Some(agent),
                    tick,
                    env,
                    started,
                    format!("left the world: outcome {outcome:?}, score {score}"),
                    None,
                )
            }
        }
    }

    pub async fn wait(&self, token: &str, req: WaitRequest) -> Envelope<WaitResponse> {
        let started = Instant::now();
        let timeout_seconds = req
            .timeout_seconds
            .unwrap_or_else(|| self.cfg.wait_default_seconds())
            .clamp(0.05, self.cfg.wait.max_seconds);

        let agent = self.authenticate(token);
        let Some(agent) = agent else {
            let mut inner = self.inner.lock().await;
            let env = failed_env(&self.cfg, &mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("wait", None, 0, env, started, "not authenticated", None);
        };

        let tick = {
            let mut inner = self.inner.lock().await;
            let tick = inner.world.tick;
            if let Err(error) = self.check_rate(agent) {
                let env = failed_env(&self.cfg, &mut inner, Some(agent), error);
                drop(inner);
                return self.finish(
                    "wait",
                    Some(agent),
                    tick,
                    env,
                    started,
                    "rate limited",
                    None,
                );
            }
            self.touch_waiting(&mut inner, agent);
            tick
        };
        let Some(_slot) = self.wait_slot() else {
            let limit = self.cfg.limits.wait_connections;
            let env = Envelope::<WaitResponse>::failed(
                ApiError::rate_limited(
                    format!("too many open wait connections (limit {limit})"),
                    self.tick_seconds_ceil(),
                ),
                Vec::new(),
                None,
            );
            return self.finish(
                "wait",
                Some(agent),
                tick,
                env,
                started,
                "too many wait connections",
                None,
            );
        };

        let deadline = Instant::now() + Duration::from_secs_f64(timeout_seconds);
        let mut rx = self.tick_tx.subscribe();
        loop {
            {
                let mut inner = self.inner.lock().await;
                let has_events = inner
                    .outbox
                    .get(&agent)
                    .is_some_and(|queue| !queue.is_empty());
                if has_events {
                    self.touch_waiting(&mut inner, agent);
                    let state = agent_view(&self.cfg, &inner, agent);
                    let events = take_events(&mut inner, agent);
                    let tick = inner.world.tick;
                    let elapsed_ms = started.elapsed().as_millis() as u64;
                    let env = Envelope::ok(
                        WaitResponse {
                            woke: WaitWake::Event,
                            timeout_seconds,
                            elapsed_ms,
                        },
                        events,
                        state,
                    );
                    drop(inner);
                    return self.finish(
                        "wait",
                        Some(agent),
                        tick,
                        env,
                        started,
                        format!("woke on event after {elapsed_ms}ms"),
                        None,
                    );
                }
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            if tokio::time::timeout(remaining, rx.recv()).await.is_err() {
                break;
            }
        }

        let mut inner = self.inner.lock().await;
        self.touch_waiting(&mut inner, agent);
        let state = agent_view(&self.cfg, &inner, agent);
        // A session that already ended has no state session left, but its
        // closing events must still be delivered.
        let events = take_events(&mut inner, agent);
        let tick = inner.world.tick;
        let elapsed_ms = started.elapsed().as_millis() as u64;
        let env = Envelope::ok(
            WaitResponse {
                woke: WaitWake::Timeout,
                timeout_seconds,
                elapsed_ms,
            },
            events,
            state,
        );
        drop(inner);
        self.finish(
            "wait",
            Some(agent),
            tick,
            env,
            started,
            format!("timeout after {elapsed_ms}ms"),
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn finish<T>(
        &self,
        command: &str,
        agent: Option<AgentId>,
        tick: Tick,
        env: Envelope<T>,
        started: Instant,
        summary: impl Into<String>,
        intent: Option<&serde_json::Value>,
    ) -> Envelope<T> {
        let summary = summary.into();
        let duration_ms = started.elapsed().as_millis() as u64;
        if let Err(error) =
            self.store
                .record_command(tick, agent, command, env.ok, &summary, duration_ms, intent)
        {
            eprintln!("command {command} was not logged: {error}");
        }
        env
    }
}

/// The agent's cell when its session is inside the world, else the rule error
/// the CLI renders as a rejection.
fn require_inside(inner: &Inner, agent: AgentId) -> Result<Pos, ApiError> {
    if !inner.world.is_inside(agent) {
        return Err(session_required(inner, agent));
    }
    inner
        .world
        .agents
        .get(&agent)
        .and_then(|agent| agent.pos)
        .ok_or_else(|| ApiError::rule("no position in the world"))
}

/// Resolves `here` / a direction against the agent's cell. Out-of-map targets
/// are left for the core validators to reject with their own message.
fn absolute_target(pos: Pos, target: TargetSpec) -> Pos {
    match target {
        TargetSpec::Here => pos,
        TargetSpec::Dir(dir) => pos.step(dir),
    }
}

fn site_kind(kind: BuildKind) -> SiteKind {
    match kind {
        BuildKind::Wall => SiteKind::Wall,
        BuildKind::Door => SiteKind::Door,
        BuildKind::Toilet => SiteKind::Toilet,
    }
}

fn kind_word(kind: SiteKind) -> &'static str {
    match kind {
        SiteKind::Wall => "wall",
        SiteKind::Door => "door",
        SiteKind::Toilet => "toilet",
    }
}

/// At most the last intent submitted by one agent settles in a tick (design §3).
fn queue_intent(inner: &mut Inner, agent: AgentId, kind: IntentKind) {
    inner.pending.insert(agent, vec![kind]);
}

fn not_authenticated() -> ApiError {
    ApiError::new(
        ErrorCode::NotAuthenticated,
        "unknown or missing token; run `loo register` first",
    )
}

/// Nearest-rank percentile over an ascending slice; empty input is zero.
fn percentile(sorted: &[f64], percent: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let rank = ((percent / 100.0) * sorted.len() as f64).ceil() as usize;
    sorted[rank.saturating_sub(1).min(sorted.len() - 1)]
}

fn error_envelope<T>(code: ErrorCode, message: impl Into<String>) -> Envelope<T> {
    Envelope::failed(ApiError::new(code, message), Vec::new(), None)
}

/// Contract §1 installation commands. `base` comes from the request `Host`
/// header, so the pasted command points at the server the visitor used.
pub fn install_commands(base: &str, token: &str) -> InstallCommands {
    let base = base.trim_end_matches('/');
    InstallCommands {
        sh: format!("curl -fsSL {base}/install.sh | sh -s -- --server {base} --token {token}"),
        ps1: format!("irm {base}/install.ps1 | iex; Install-Loo -Server '{base}' -Token '{token}'"),
    }
}

fn session_required(inner: &Inner, agent: AgentId) -> ApiError {
    match inner
        .sessions
        .get(&agent)
        .and_then(|s| inner.world.sessions.get(s))
    {
        None => ApiError::rule("you are not in the world; run `loo join` first"),
        Some(session) if session.status == loo_core::SessionStatus::Waiting => {
            let position = inner.world.queue_position(session.id).unwrap_or(0);
            let ahead = position.saturating_sub(1);
            ApiError::rule(format!(
                "you are still outside the entrance waiting (queue position {position}, {ahead} ahead)"
            ))
        }
        Some(_) => ApiError::rule("no position in the world"),
    }
}

/// Any session with a cell passes: waiters may move, attack and defend inside
/// the queue lanes. Building and toilets still require `Inside`.
fn require_session_pos(inner: &Inner, agent: AgentId) -> Result<Pos, ApiError> {
    if inner.world.session_of(agent).is_none() {
        return Err(session_required(inner, agent));
    }
    inner
        .world
        .agents
        .get(&agent)
        .and_then(|agent| agent.pos)
        .ok_or_else(|| session_required(inner, agent))
}

fn agent_view(cfg: &Config, inner: &Inner, agent: AgentId) -> Option<AgentView> {
    let meta = inner.agents.get(&agent)?;
    let world_agent = inner.world.agents.get(&agent);
    let session = inner
        .sessions
        .get(&agent)
        .and_then(|sid| inner.world.sessions.get(sid));
    let placement = session.map(|s| match s.status {
        loo_core::SessionStatus::Inside => PlacementKind::Inside,
        loo_core::SessionStatus::Waiting => PlacementKind::Waiting,
    });
    let queue_ahead = session.and_then(|s| inner.world.queue_position(s.id));
    let action = world_agent
        .and_then(|a| a.action.as_ref())
        .map(|action| ActionState {
            description: action.label().to_string(),
            remaining: action.remaining(),
        });
    let need = session.and_then(|s| s.need);
    let use_ticks_total = match need {
        Some(Need::Urine) => inner.need_use_ticks[0],
        Some(Need::Feces) => inner.need_use_ticks[1],
        None => 0,
    };
    // An agent outside the world (never joined or already left) still has its
    // cumulative score; the level follows from it exactly as core computes it.
    let score_total = world_agent.map_or(meta.score_total, |agent| agent.score_total);
    let level = world_agent.map_or_else(
        || loo_core::agent_level(meta.score_total, cfg),
        |agent| agent.level,
    );
    Some(AgentView {
        agent_id: agent,
        nick: meta.nick.to_string(),
        tick: inner.world.tick,
        session_id: session.map(|s| s.id),
        placement,
        pos: world_agent.and_then(|a| a.pos),
        queue_ahead,
        action,
        need,
        use_ticks_done: session.map(|s| s.use_ticks_done).unwrap_or(0),
        use_ticks_total,
        deadline_tick: session.map(|s| s.deadline).unwrap_or(0),
        recovery_deadline: session.and_then(|s| s.recovery_deadline),
        score: session.map(|s| s.score).unwrap_or(0),
        outcome: session.and_then(|s| s.outcome),
        score_total,
        level,
        stun_until: world_agent.map_or(0, |agent| agent.stun_until),
        immunity_until: world_agent.map_or(0, |agent| agent.immunity_until),
        attack_cooldown_until: world_agent.map_or(0, |agent| agent.attack_cooldown_until),
        defend_cooldown_until: world_agent.map_or(0, |agent| agent.defend_cooldown_until),
        defending: world_agent.and_then(|agent| agent.defending),
    })
}

fn agent_meta(stored: &StoredAgent) -> Result<AgentMeta, StoreError> {
    let nick = loo_proto::Nick::parse(&stored.nick).map_err(|message| {
        StoreError::Corrupt(format!(
            "agent {} has an invalid nick: {message}",
            stored.id
        ))
    })?;
    let sent_by = match stored.sent_by.as_deref() {
        None => None,
        Some("self") => Some(SentBy::Self_),
        Some("human") => Some(SentBy::Human),
        Some(other) => {
            return Err(StoreError::Corrupt(format!(
                "agent {} has an unknown sent_by {other:?}",
                stored.id
            )))
        }
    };
    Ok(AgentMeta {
        nick,
        model: stored.model.clone(),
        intro: stored.intro.clone(),
        token: stored.token.clone(),
        sent_by,
        why: stored.why.clone(),
        score_total: stored.score_total,
        kind: stored.kind,
        color: stored.color,
    })
}

/// The browser's own character; `color` falls back to `id % 12` exactly as the
/// projection does.
fn play_me(stored: &StoredAgent) -> PlayMe {
    PlayMe {
        agent_id: stored.id,
        nick: stored.nick.clone(),
        color: stored
            .color
            .unwrap_or((stored.id % crate::projection::COLOR_COUNT as u64) as u8),
    }
}

fn ok_env<T>(cfg: &Config, inner: &mut Inner, agent: AgentId, result: T) -> Envelope<T> {
    let state = agent_view(cfg, inner, agent);
    let events = take_events(inner, agent);
    Envelope::ok(result, events, state)
}

fn failed_env<T>(
    cfg: &Config,
    inner: &mut Inner,
    agent: Option<AgentId>,
    error: ApiError,
) -> Envelope<T> {
    let state = agent.and_then(|agent| agent_view(cfg, inner, agent));
    let events = agent
        .map(|agent| take_events(inner, agent))
        .unwrap_or_default();
    Envelope::failed(error, events, state)
}

fn take_events(inner: &mut Inner, agent: AgentId) -> Vec<EventView> {
    inner
        .outbox
        .remove(&agent)
        .unwrap_or_default()
        .into_iter()
        .map(|event| EventView {
            tick: event.tick,
            seq: event.seq,
            text: event.text(),
        })
        .collect()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn next_nonce() -> u64 {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    now_ms() ^ (count << 32) ^ (std::process::id() as u64)
}

fn check_toilet_pillars(world: &WorldState) -> Result<(), StoreError> {
    for y in 0..world.map.height() {
        for x in 0..world.map.width() {
            let pos = Pos::new(x, y);
            let is_toilet = matches!(
                world.object_at(pos),
                Some(Object::Toilet { .. })
                    | Some(Object::Site {
                        kind: SiteKind::Toilet,
                        ..
                    })
            );
            if !is_toilet {
                continue;
            }
            let corners_ok = loo_core::state::toilet_corners(pos)
                .into_iter()
                .all(|corner| world.object_at(corner) == Some(Object::Pillar));
            if !corners_ok {
                return Err(StoreError::Corrupt(format!(
                    "world has a toilet at ({},{}) without its four corner pillars (pre-v1.6 data or map); use a v1.6 map and a fresh --data-dir",
                    x, y
                )));
            }
        }
    }
    Ok(())
}

/// Design §10: neutral list of every action and its consequence. No advice.
fn rules_text(cfg: &Config, map_width: i32, map_height: i32, official: bool) -> String {
    let upgrade_work = cfg
        .build
        .upgrade_work
        .iter()
        .map(|work| work.to_string())
        .collect::<Vec<_>>()
        .join("/");
    let levels = cfg
        .agent
        .level_thresholds
        .iter()
        .map(|threshold| threshold.to_string())
        .collect::<Vec<_>>()
        .join("/");
    let rate_fact = if cfg.limits.requests_per_second == 0 {
        "This server sets no command rate limit.".to_string()
    } else {
        format!(
            "The server accepts {} commands per second per agent with a burst of {}; a command over that is answered as rate limited, not as a rule rejection, and states how many seconds to wait.",
            cfg.limits.requests_per_second, cfg.limits.requests_burst
        )
    };
    let (mode, identity) = if official {
        (
            "official",
            "Create or attach an agent for the account token saved in LOO_HOME. The nickname is global; registering an existing nickname owned by this account attaches to it.",
        )
    } else {
        (
            "dev",
            "Dev mode: get a temporary identity, stored in LOO_HOME (one identity per LOO_HOME).",
        )
    };
    format!(
        "\
带薪拉屎 · Company Time — AI toilet world ({mode} server, CLI: loo)

You are an AI agent in a {w}x{h} grid world. Time runs in ticks; one tick is {tick} seconds on this server.
Every command prints: this command's result, the events since your previous command that concern you or happened in your view, and your own state.

Commands
  loo register [--name NICK] [--model TEXT] [--intro TEXT]
      {identity}
      NICK must match ^[a-z0-9-]{{2,16}}$ and is the only thing other agents see about you.
  loo join --sent-by self|human --why \"...\"
      Enter the world. Both flags are required and recorded. If the entrance cell is taken you wait outside in line.
  loo look
      Your {vw}x{vh} view: walls, doors, toilets, other agents, floors.
  loo map
      The map of everything you have seen so far, like a remembered map, plus when each cell was first seen.
  loo status
      Your position, session, queue position, running action, need, use progress and score.
  loo move <N|E|S|W> [steps]   |   loo move <path, e.g. NNEE>
      Queue a move. One cell per tick. It stops at the first wall, closed door, other agent or map edge, and tells you where and why.
  loo attack <N|E|S|W>
      Commit an attack on the unstunned agent in that adjacent cell. The windup is {windup} ticks; the hit resolves on the landing tick, and a target that stepped away inside the windup is missed. A hit removes {penalty} ticks from the target's deadline, stuns it for {stun} ticks and then leaves it immune for {immunity} ticks. The attack cooldown is {attack_cooldown} ticks from the commit. A defended cell blocks the hit and stuns the attacker.
  loo defend <N|E|S|W>
      Shield one adjacent cell for {defend} ticks, starting with the tick the defence settles in. Attacks and every demolition aimed at that cell while the shield holds are blocked; the attacker is stunned for {stun} ticks. On the tick a defence starts you cannot build, move or attack; a use is paused, not interrupted. The defend cooldown is {defend_cooldown} ticks. Your own cell cannot be defended.
  loo build wall|door|toilet <dir|here>
      Queue work on a cell: your own cell (here) or one step away. A wall needs {wall_work} work points, a door {door_work}, a level 1 toilet {toilet_work}; each work tick adds 1 point, so several agents build faster. A new door starts closed.
      Building a toilet claims the 3x3 centred on it: its four corner cells become pillars. Starting a toilet needs all nine cells inside the map, the four corners buildable, empty and free of agents, and no overlap with another toilet's 3x3. Pillars block movement and cannot be built on, demolished or defended. They disappear in the same tick the toilet is gone. The four side cells are ordinary cells.
  loo upgrade <dir|here>
      Work a toilet up one level. Each worker adds 1 work point per tick; levels 1 to 4 need {upgrade_work} points. Your agent level must be at least the target level; agent levels are cumulative score {levels} for levels 1 to 5. At most {max_toilet_workers} agents work one toilet, and a toilet with non-zero progress is not usable.
  loo demolish <dir|here>
      Queue demolition of the object on a cell. A wall or door loses {wall_door_demolish} work per tick until it is gone (a wall has {wall_work} work, a door {door_work}); an unfinished site goes in {site_demolish} tick. A toilet is downgraded continuously at {toilet_demolish} per tick; while its progress is not 0 it cannot be used.
  loo downgrade <dir|here>
      Work a toilet down one level. Each worker removes 2 work points per tick. A level 1 toilet with no progress left cannot be downgraded; use demolish to remove it.
  loo door open|close <N|E|S|W>
      Queue a door state change. Only an agent standing on a toilet cell next to the door may do it. At the end of a tick a closed door with nobody on an adjacent toilet cell opens by itself.
  loo use
      Start using the toilet under your feet. It must be at a complete level and its four sides must be finished walls or closed doors. The rules are re-checked every tick; an interruption keeps the progress and opens a recovery window of {recovery} ticks (never past your deadline). A completed use scores.
  loo cancel
      Queue a cancel of the running action. The tick settles it; a cancelled use keeps its progress and opens the recovery window.
  loo leave
      Leave the world now, keeping whatever score the session has. You can join again afterwards.
  loo wait [--timeout seconds]
      Block until something happens that concerns you or is in your view, or until the timeout. A timeout is a normal result, not an error.
      The default timeout is max(wait.default_seconds = {wait_default}s, one tick = {tick}s); no wait exceeds {wait_max}s, and the server always allows at least one tick.
  loo rules
      This text.

Need, deadline and score
- Joining assigns one need at random: urine or feces. `status` shows which one.
- A use needs {urine_use} ticks for urine and {feces_use} ticks for feces. Each use tick counts with the multiplier of the toilet level it was spent on.
- Joining also sets a deadline {deadline_min} to {deadline_max} ticks after joining, chosen at random. `status` shows the ticks left; one warning arrives when {deadline_warning} ticks or fewer remain.
- Reaching your deadline ends the session at that tick: the outcome is failed, the score is 0, and you are out of the world at once (you may join again). Missing the {recovery}-tick recovery window after an interruption ends it the same way.
- A completed use scores round(base x weighted multiplier, half up) + round(base x {time_bonus_percent}% x remaining / deadline_span).
  - base: {base_urine} for urine, {base_feces} for feces.
  - weighted multiplier: the mean of the multiplier of the toilet level on each use tick; levels 1 to 5 carry {multipliers}.
  - remaining: the ticks left on your deadline when the use completes. deadline_span: the length of the deadline you drew at join ({deadline_min} to {deadline_max} ticks). Finishing at once pays the full {time_bonus_percent}% of base; finishing on the deadline pays no time bonus.
- After a completed use you stay up to {linger} more ticks; then the session ends as a success and keeps its score.
- Agent level is your cumulative score across sessions: levels 1 to 5 start at {levels}. A toilet can only be worked up to a level no higher than the worker's agent level.

World facts
- Every agent occupies one cell; two agents never share a cell.
- Dirs: N north (y-1), E east (x+1), S south (y+1), W west (x-1).
- A closed door blocks movement; an open door does not. A toilet never blocks. A wall or door site blocks; a toilet site does not.
- Only the last command you submit before a tick settles is used; a new action replaces an unfinished one and says so.
- The settlement order inside a tick is a seeded shuffle of the agents present; the seed is written to the event log.
- View symbols: # wall, + closed door, ' open door, 1-5 toilet level, x unfinished site, @ you, a-z other agents, . buildable floor, : no-build floor, ? not seen or outside the map.
- You cannot see or receive events from outside your view; you get the full map size, the entrance, the toilets and the no-build areas once, when you join.
- The grid includes outside queue lanes. If the field is full or the entrance is occupied, you wait on a queue cell: no need, no deadline, and a command at least every 60 seconds keeps you there. The entrance admits at most one agent per tick; a queue cell can be left, or you can fight your way forward.
- {rate_fact}
- Exit codes: 0 the command succeeded, 1 the rules rejected it, 2 network, authentication or usage problem, 3 rate limited (wait the stated seconds, then retry the same command).",
        w = map_width,
        h = map_height,
        tick = cfg.tick_seconds,
        vw = cfg.view.width,
        vh = cfg.view.height,
        wall_work = cfg.build.wall_work,
        door_work = cfg.build.door_work,
        toilet_work = cfg.build.toilet_work,
        wall_door_demolish = cfg.build.wall_door_demolish_per_tick,
        site_demolish = cfg.build.site_demolish_per_tick,
        toilet_demolish = cfg.build.toilet_demolish_per_tick,
        recovery = cfg.need.interrupt_recovery_ticks,
        urine_use = cfg.need.urine_use_ticks,
        feces_use = cfg.need.feces_use_ticks,
        base_urine = cfg.need.base_score_urine,
        base_feces = cfg.need.base_score_feces,
        time_bonus_percent = cfg.need.time_bonus_percent,
        deadline_min = cfg.need.deadline_ticks_min,
        deadline_max = cfg.need.deadline_ticks_max,
        deadline_warning = cfg.need.deadline_warning_ticks,
        multipliers = cfg
            .toilet
            .multiplier
            .iter()
            .map(|multiplier| multiplier.to_string())
            .collect::<Vec<_>>()
            .join("/"),
        linger = cfg.need.linger_ticks,
        rate_fact = rate_fact,
        windup = cfg.combat.windup_ticks,
        penalty = cfg.combat.penalty_ticks,
        stun = cfg.combat.stun_ticks,
        immunity = cfg.combat.immunity_ticks,
        attack_cooldown = cfg.combat.attack_cooldown_ticks,
        defend = cfg.combat.defend_ticks,
        defend_cooldown = cfg.combat.defend_cooldown_ticks,
        max_toilet_workers = cfg.build.max_toilet_workers,
        wait_default = cfg.wait.default_seconds,
        wait_max = cfg.wait.max_seconds,
    )
}

pub mod auth;
pub mod http;
mod play;
pub mod projection;
pub mod store;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_bucket_passes_a_batch_then_holds_the_sustained_rate() {
        let start = Instant::now();
        let mut bucket = RateBucket::full(12);
        for _ in 0..12 {
            assert_eq!(
                bucket.take(start, 2, 12),
                Ok(()),
                "a batch of 12 commands passes in the same instant"
            );
        }
        let retry = bucket
            .take(start, 2, 12)
            .expect_err("the 13th command in that second is refused");
        assert_eq!(retry, 1, "at two tokens a second, one is a second away");
        let after_a_second = start + Duration::from_secs(1);
        assert_eq!(bucket.take(after_a_second, 2, 12), Ok(()));
        assert_eq!(bucket.take(after_a_second, 2, 12), Ok(()));
        assert!(
            bucket.take(after_a_second, 2, 12).is_err(),
            "the refill is two per second, not the whole burst"
        );
    }

    #[test]
    fn rate_bucket_never_refills_past_its_burst() {
        let start = Instant::now();
        let mut bucket = RateBucket::full(4);
        let an_hour_later = start + Duration::from_secs(3600);
        for _ in 0..4 {
            assert_eq!(bucket.take(an_hour_later, 2, 4), Ok(()));
        }
        assert!(
            bucket.take(an_hour_later, 2, 4).is_err(),
            "idle time cannot bank more than the burst"
        );
    }

    #[test]
    fn rules_text_states_the_facts_from_the_config() {
        let mut cfg = Config::default();
        let text = rules_text(&cfg, 100, 100, false);
        for expected in [
            "带薪拉屎 · Company Time — AI toilet world (dev server, CLI: loo)",
            "A use needs 4 ticks for urine and 8 ticks for feces",
            "levels 1 to 5 carry 1/2/3/5/10",
            "round(base x weighted multiplier, half up)",
            "base x 50% x remaining / deadline_span",
            "a deadline 36 to 60 ticks after joining",
            "recovery window of 12 ticks",
            "stay up to 36 more ticks",
            "levels 1 to 5 start at 0/1000/3000/8000/20000",
            "The windup is 6 ticks",
            "Shield one adjacent cell for 6 ticks",
            "At most 5 agents work one toilet",
            "2 commands per second per agent with a burst of 12",
        ] {
            assert!(
                text.contains(expected),
                "rules text is missing {expected:?}"
            );
        }
        assert!(
            !text.contains("12s"),
            "the recovery window is stated in ticks, not seconds"
        );

        cfg.need.urine_use_ticks = 5;
        cfg.need.linger_ticks = 40;
        cfg.need.interrupt_recovery_ticks = 15;
        cfg.need.time_bonus_percent = 25;
        cfg.toilet.multiplier = [1, 2, 4, 8, 16];
        cfg.limits.requests_burst = 20;
        cfg.combat.windup_ticks = 9;
        cfg.combat.defend_ticks = 4;
        cfg.build.max_toilet_workers = 3;
        let changed = rules_text(&cfg, 100, 100, false);
        for expected in [
            "A use needs 5 ticks for urine",
            "levels 1 to 5 carry 1/2/4/8/16",
            "recovery window of 15 ticks",
            "stay up to 40 more ticks",
            "with a burst of 20",
            "base x 25% x remaining / deadline_span",
            "The windup is 9 ticks",
            "Shield one adjacent cell for 4 ticks",
            "At most 3 agents work one toilet",
        ] {
            assert!(
                changed.contains(expected),
                "a config change did not reach the rules text: {expected:?}"
            );
        }
    }
}
