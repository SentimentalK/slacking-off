//! Dev-mode HTTP server: the world lives in memory, every settled tick and every
//! command is persisted to SQLite, and a restart resumes from that store.
//!
//! Design §12: one process, world state in memory, `core` settles each tick.
//! Step 1 has movement, vision, collisions and SQLite replay; building, doors,
//! toilets in use, combat, accounts, SSE and the web UI are later steps.

use loo_core::{
    Config, Intent, IntentKind, JoinCommand, JoinOutcome, JoinRejectKind, MapDef, SiteKind,
    Snapshot, WorldState,
};
use loo_proto::{
    AccountAgent, AccountRegisterResponse, AccountResponse, ActionQueued, ActionState, AgentId,
    AgentView, ApiError, AttackRequest, AuthMeResponse, Briefing, BuildKind, BuildRequest,
    ConfigResponse, DefendRequest, DemolishRequest, DoorRequest, DowngradeRequest, Envelope,
    ErrorCode, EventView, InstallCommands, JoinRequest, JoinResponse, LeaveResponse, LookResponse,
    MapResponse, MoveRequest, Need, Placement, PlacementKind, Pos, RegisterRequest,
    RegisterResponse, RulesResponse, SentBy, SessionId, TargetSpec, Tick, TokenCreateResponse,
    UpgradeRequest, WaitRequest, WaitResponse, WaitWake,
};
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
pub use store::{Store, StoreError, StoredAgent};
use tokio::sync::{broadcast, Mutex};

/// Outbox cap per session so an agent that stops polling cannot grow memory.
const MAX_OUTBOX: usize = 512;

pub struct Server {
    cfg: Config,
    inner: Mutex<Inner>,
    tick_tx: broadcast::Sender<Tick>,
    store: Store,
    /// Contract §1 mode: accounts are required and tokens are hashed in the DB.
    official: bool,
    /// Dev identities: `agents.token` -> agent. Only read in dev mode.
    dev_tokens: std::sync::Mutex<HashMap<String, AgentId>>,
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
        let mut dev_tokens = HashMap::new();
        for stored in &stored_agents {
            agents.insert(stored.id, agent_meta(stored)?);
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
        let need_use_ticks = [cfg.need.urine_use_ticks, cfg.need.feces_use_ticks];
        Ok(Server {
            cfg,
            inner: Mutex::new(Inner {
                next_agent_id: stored_agents
                    .iter()
                    .map(|agent| agent.id)
                    .max()
                    .unwrap_or(0)
                    + 1,
                next_session_id: world.sessions.keys().copied().max().unwrap_or(0) + 1,
                world,
                pending,
                agents,
                sessions,
                outbox: BTreeMap::new(),
                seed_base,
                last_seq,
                tick_seed,
                need_use_ticks,
            }),
            tick_tx,
            store,
            official,
            dev_tokens: std::sync::Mutex::new(dev_tokens),
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

    /// Settles exactly one tick. Public so tests and tooling can drive the world
    /// without a live timer. Nothing is published unless the tick is persisted.
    pub async fn tick_once(&self) -> Tick {
        let mut inner = self.inner.lock().await;
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

        inner.world = world;
        inner.sessions = inner
            .world
            .sessions
            .values()
            .map(|session| (session.agent, session.id))
            .collect();

        let tick = inner.world.tick;
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
        (self.store.agent_owner(agent).ok()?? == user_id).then_some(agent)
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
            Ok(Some((_, owner))) if owner == Some(user_id) => {
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
        let mut inner = self.inner.lock().await;
        let Some(agent) = self.authenticate(token) else {
            let env = failed_env(&self.cfg, &mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("join", None, 0, env, started, "not authenticated", None);
        };
        let tick = inner.world.tick;

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
        let mut inner = self.inner.lock().await;
        let Some(agent) = self.authenticate(token) else {
            let env = failed_env(&self.cfg, &mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("look", None, 0, env, started, "not authenticated", None);
        };
        let tick = inner.world.tick;
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
        let mut inner = self.inner.lock().await;
        let Some(agent) = self.authenticate(token) else {
            let env = failed_env(&self.cfg, &mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("map", None, 0, env, started, "not authenticated", None);
        };
        let tick = inner.world.tick;
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
        let mut inner = self.inner.lock().await;
        let Some(agent) = self.authenticate(token) else {
            let env = failed_env(&self.cfg, &mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("status", None, 0, env, started, "not authenticated", None);
        };
        let tick = inner.world.tick;
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
        let text = rules_text(&self.cfg, width, height);
        let env = Envelope::ok(RulesResponse { text }, Vec::new(), None);
        // `rules` needs no identity, but design §8 logs every command.
        self.finish("rules", None, tick, env, started, "rules text", None)
    }

    pub async fn move_cmd(&self, token: &str, req: MoveRequest) -> Envelope<ActionQueued> {
        let started = Instant::now();
        let mut inner = self.inner.lock().await;
        let Some(agent) = self.authenticate(token) else {
            let env = failed_env(&self.cfg, &mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("move", None, 0, env, started, "not authenticated", None);
        };
        let tick = inner.world.tick;

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
        if !inner.world.is_inside(agent) {
            let err = session_required(&inner, agent);
            let env = failed_env(&self.cfg, &mut inner, Some(agent), err);
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
        let mut inner = self.inner.lock().await;
        let Some(agent) = self.authenticate(token) else {
            let env = failed_env(&self.cfg, &mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("build", None, 0, env, started, "not authenticated", None);
        };
        let tick = inner.world.tick;
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
        let mut inner = self.inner.lock().await;
        let Some(agent) = self.authenticate(token) else {
            let env = failed_env(&self.cfg, &mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("demolish", None, 0, env, started, "not authenticated", None);
        };
        let tick = inner.world.tick;
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
        let mut inner = self.inner.lock().await;
        let Some(agent) = self.authenticate(token) else {
            let env = failed_env(&self.cfg, &mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("door", None, 0, env, started, "not authenticated", None);
        };
        let tick = inner.world.tick;
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
        let mut inner = self.inner.lock().await;
        let Some(agent) = self.authenticate(token) else {
            let env = failed_env(&self.cfg, &mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("attack", None, 0, env, started, "not authenticated", None);
        };
        let tick = inner.world.tick;
        let pos = match require_inside(&inner, agent) {
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
        let mut inner = self.inner.lock().await;
        let Some(agent) = self.authenticate(token) else {
            let env = failed_env(&self.cfg, &mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("defend", None, 0, env, started, "not authenticated", None);
        };
        let tick = inner.world.tick;
        let pos = match require_inside(&inner, agent) {
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
        let label = format!("defend {target} this tick");
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
        let mut inner = self.inner.lock().await;
        let Some(agent) = self.authenticate(token) else {
            let env = failed_env(&self.cfg, &mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("upgrade", None, 0, env, started, "not authenticated", None);
        };
        let tick = inner.world.tick;
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
        let mut inner = self.inner.lock().await;
        let Some(agent) = self.authenticate(token) else {
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
        let tick = inner.world.tick;
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
        if let Err(message) = loo_core::validate_downgrade(&inner.world, agent, target) {
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
        let mut inner = self.inner.lock().await;
        let Some(agent) = self.authenticate(token) else {
            let env = failed_env(&self.cfg, &mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("use", None, 0, env, started, "not authenticated", None);
        };
        let tick = inner.world.tick;
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
        let mut inner = self.inner.lock().await;
        let Some(agent) = self.authenticate(token) else {
            let env = failed_env(&self.cfg, &mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("cancel", None, 0, env, started, "not authenticated", None);
        };
        let tick = inner.world.tick;
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
        let mut inner = self.inner.lock().await;
        let Some(agent) = self.authenticate(token) else {
            let env = failed_env(&self.cfg, &mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("leave", None, 0, env, started, "not authenticated", None);
        };
        let tick = inner.world.tick;
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

        let deadline = Instant::now() + Duration::from_secs_f64(timeout_seconds);
        let mut rx = self.tick_tx.subscribe();
        loop {
            {
                let mut inner = self.inner.lock().await;
                let state = agent_view(&self.cfg, &inner, agent);
                let has_events = inner
                    .outbox
                    .get(&agent)
                    .is_some_and(|queue| !queue.is_empty());
                if has_events {
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
            let ahead = inner
                .world
                .entry_queue
                .iter()
                .position(|s| *s == session.id)
                .map(|i| i + 1)
                .unwrap_or(0);
            ApiError::rule(format!(
                "you are still outside the entrance waiting ({ahead} in line); you are not in the world yet"
            ))
        }
        Some(_) => ApiError::rule("no position in the world"),
    }
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
    let queue_ahead = session.and_then(|s| {
        inner
            .world
            .entry_queue
            .iter()
            .position(|queued| *queued == s.id)
            .map(|i| i + 1)
    });
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
    })
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

/// Design §10: neutral list of every action and its consequence. No advice.
fn rules_text(cfg: &Config, map_width: i32, map_height: i32) -> String {
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
    format!(
        "\
Company Time — AI toilet world (step 2 dev server)

You are an AI agent in a {w}x{h} grid world. Time runs in ticks; one tick is {tick} seconds on this server.
Every command prints: this command's result, the events since your previous command that concern you or happened in your view, and your own state.

Commands
  loo register [--name NICK] [--model TEXT] [--intro TEXT]
      Dev mode: get a temporary identity, stored in LOO_HOME (one identity per LOO_HOME).
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
      Commit an attack on the unstunned agent in that adjacent cell. The windup is {windup} ticks; the hit resolves on the landing tick, and a target that stepped away is missed. A hit removes {penalty} ticks from the target's deadline, stuns it for {stun} ticks and then leaves it immune for {immunity} ticks. The attack cooldown is {attack_cooldown} ticks from the commit. A defended cell blocks the hit and stuns the attacker.
  loo defend <N|E|S|W>
      Shield one adjacent cell for one tick. Attacks and every demolition aimed at that cell are blocked; the attacker is stunned for {stun} ticks. A defending tick cannot build, move or attack; a use is paused, not interrupted. The defend cooldown is {defend_cooldown} ticks. Your own cell cannot be defended.
  loo build wall|door|toilet <dir|here>
      Queue work on a cell: your own cell (here) or one step away. A wall needs {wall_work} work points, a door {door_work}, a level 1 toilet {toilet_work}; each work tick adds 1 point, so several agents build faster. A new door starts closed.
  loo upgrade <dir|here>
      Work a toilet up one level. Each worker adds 1 work point per tick; levels 1 to 4 need {upgrade_work} points. Your agent level must be at least the target level; agent levels are cumulative score {levels} for levels 1 to 5. At most 5 agents work one toilet, and a toilet with non-zero progress is not usable.
  loo demolish <dir|here>
      Queue demolition of the object on a cell. A wall or door loses {wall_door_demolish} work per tick until it is gone (a wall has {wall_work} work, a door {door_work}); an unfinished site goes in {site_demolish} tick. A toilet is downgraded continuously at {toilet_demolish} per tick; while its progress is not 0 it cannot be used.
  loo downgrade <dir|here>
      Work a toilet down one level. Each worker removes 2 work points per tick. A level 1 toilet with no progress left cannot be downgraded; use demolish to remove it.
  loo door open|close <N|E|S|W>
      Queue a door state change. Only an agent standing on a toilet cell next to the door may do it. At the end of a tick a closed door with nobody on an adjacent toilet cell opens by itself.
  loo use
      Start using the toilet under your feet. It must be at a complete level and its four sides must be finished walls or closed doors. The rules are re-checked every tick; an interruption keeps the progress but opens a {recovery}s recovery window. A completed use scores.
  loo cancel
      Queue a cancel of the running action. The tick settles it; a cancelled use keeps its progress and opens the recovery window.
  loo leave
      Leave the world now, keeping whatever score the session has. You can join again afterwards.
  loo wait [--timeout seconds]
      Block until something happens that concerns you or is in your view, or until the timeout. A timeout is a normal result, not an error.
      The default timeout is max(wait.default_seconds = {wait_default}s, one tick = {tick}s); no wait exceeds {wait_max}s, and the server always allows at least one tick.
  loo rules
      This text.

World facts
- Every agent occupies one cell; two agents never share a cell.
- Dirs: N north (y-1), E east (x+1), S south (y+1), W west (x-1).
- A closed door blocks movement; an open door does not. A toilet never blocks. A wall or door site blocks; a toilet site does not.
- Only the last command you submit before a tick settles is used; a new action replaces an unfinished one and says so.
- The settlement order inside a tick is a seeded shuffle of the agents present; the seed is written to the event log.
- View symbols: # wall, + closed door, ' open door, 1-5 toilet level, x unfinished site, @ you, a-z other agents, . buildable floor, : no-build floor, ? not seen or outside the map.
- You cannot see or receive events from outside your view; you get the full map size, the entrance, the toilets and the no-build areas once, when you join.
- Exit codes: 0 the command succeeded, 1 the rules rejected it, 2 network, authentication or usage problem.",
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
        windup = cfg.combat.windup_ticks,
        penalty = cfg.combat.penalty_ticks,
        stun = cfg.combat.stun_ticks,
        immunity = cfg.combat.immunity_ticks,
        attack_cooldown = cfg.combat.attack_cooldown_ticks,
        defend_cooldown = cfg.combat.defend_cooldown_ticks,
        wait_default = cfg.wait.default_seconds,
        wait_max = cfg.wait.max_seconds,
    )
}

pub mod auth;
pub mod http;
pub mod store;
