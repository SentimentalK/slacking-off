//! Dev-mode HTTP server for step 0: in-memory world, one tick loop, JSONL logs.
//!
//! Design §12: one process, world state in memory, `core` settles each tick.
//! Step 0 has no accounts, database tables, SSE or web UI; the command and world
//! event logs are JSONL files on disk.

use loo_core::{
    Config, Intent, IntentKind, JoinCommand, JoinOutcome, JoinRejectKind, MapDef, WorldState,
};
use loo_proto::{
    ActionQueued, ActionState, AgentId, AgentView, ApiError, Briefing, Envelope, ErrorCode,
    EventView, JoinRequest, JoinResponse, LookResponse, MapResponse, MoveRequest, Placement,
    PlacementKind, RegisterRequest, RegisterResponse, RulesResponse, SentBy, SessionId, Tick,
    WaitRequest, WaitResponse, WaitWake,
};
use std::collections::{BTreeMap, HashMap};
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{broadcast, Mutex};

/// Outbox cap per session so an agent that stops polling cannot grow memory.
const MAX_OUTBOX: usize = 512;

pub struct Server {
    cfg: Config,
    inner: Mutex<Inner>,
    tick_tx: broadcast::Sender<Tick>,
    logs: Logs,
}

struct Inner {
    world: WorldState,
    /// Actions submitted since the last settlement; one per agent, last wins.
    pending: BTreeMap<AgentId, IntentKind>,
    agents: BTreeMap<AgentId, AgentMeta>,
    tokens: HashMap<String, AgentId>,
    /// Current session per agent (step 0 has no leave/cleanup yet).
    sessions: BTreeMap<AgentId, SessionId>,
    outbox: BTreeMap<SessionId, Vec<loo_core::Event>>,
    next_agent_id: AgentId,
    next_session_id: SessionId,
    seed_base: u64,
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
}

impl Server {
    pub fn new(cfg: Config, def: MapDef, logs: Logs, seed_base: u64) -> Self {
        let (tick_tx, _) = broadcast::channel(16);
        Self {
            cfg,
            inner: Mutex::new(Inner {
                world: WorldState::new(def),
                pending: BTreeMap::new(),
                agents: BTreeMap::new(),
                tokens: HashMap::new(),
                sessions: BTreeMap::new(),
                outbox: BTreeMap::new(),
                next_agent_id: 1,
                next_session_id: 1,
                seed_base,
            }),
            tick_tx,
            logs,
        }
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
    /// without a live timer.
    pub async fn tick_once(&self) -> Tick {
        let mut inner = self.inner.lock().await;
        let intents: Vec<Intent> = inner
            .pending
            .iter()
            .map(|(agent, kind)| Intent {
                agent: *agent,
                kind: kind.clone(),
            })
            .collect();
        inner.pending.clear();

        let mut rng = loo_core::rng::Rng::new(inner.seed_base ^ (inner.world.tick + 1));
        let seed = rng.next_u64();
        let (world, events) = loo_core::step(&inner.world, &intents, seed, &self.cfg);
        inner.world = world;

        {
            let Inner { world, outbox, .. } = &mut *inner;
            for event in &events {
                for session in world.sessions.values() {
                    let pos = world.agents.get(&session.agent).and_then(|a| a.pos);
                    if event.visible_to(session.agent, pos, &self.cfg) {
                        let queue = outbox.entry(session.id).or_default();
                        if queue.len() < MAX_OUTBOX {
                            queue.push(event.clone());
                        }
                    }
                }
            }
        }

        let tick = inner.world.tick;
        drop(inner);
        self.logs.events(tick, &events);
        let _ = self.tick_tx.send(tick);
        tick
    }

    /// Dev mode only (design §2.3): hands out a temporary identity, no account.
    pub async fn dev_register(&self, req: RegisterRequest) -> Envelope<RegisterResponse> {
        let started = Instant::now();
        let mut inner = self.inner.lock().await;

        if let Some(model) = &req.model {
            if model.trim().is_empty() || model.chars().count() > 64 {
                let env = failed_env(
                    &mut inner,
                    None,
                    ApiError::new(ErrorCode::BadRequest, "model must be 1-64 characters"),
                );
                drop(inner);
                return self.finish("register", None, 0, env, started, "bad model");
            }
        }
        if let Some(intro) = &req.intro {
            if intro.chars().count() > 200 {
                let env = failed_env(
                    &mut inner,
                    None,
                    ApiError::new(
                        ErrorCode::BadRequest,
                        "intro must be at most 200 characters",
                    ),
                );
                drop(inner);
                return self.finish("register", None, 0, env, started, "bad intro");
            }
        }

        let agent_id = inner.next_agent_id;
        let nick = match &req.name {
            Some(name) => {
                if inner.agents.values().any(|m| m.nick == *name) {
                    let env = failed_env(
                        &mut inner,
                        None,
                        ApiError::new(
                            ErrorCode::BadRequest,
                            format!("nickname {name} is already taken"),
                        ),
                    );
                    drop(inner);
                    return self.finish("register", None, 0, env, started, "nickname taken");
                }
                name.clone()
            }
            None => loo_proto::Nick::parse(&format!("dev-{agent_id}"))
                .expect("generated dev nickname is valid"),
        };
        let token = format!("dev-{agent_id:x}-{:x}", next_nonce());
        inner.next_agent_id += 1;
        inner.tokens.insert(token.clone(), agent_id);
        inner.agents.insert(
            agent_id,
            AgentMeta {
                nick: nick.clone(),
                model: req.model.unwrap_or_default(),
                intro: req.intro.unwrap_or_default(),
                token: token.clone(),
                sent_by: None,
                why: String::new(),
            },
        );
        let tick = inner.world.tick;
        let state = agent_view(&inner, agent_id);
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
        self.finish("register", Some(agent_id), tick, env, started, summary)
    }

    pub async fn join(&self, token: &str, req: JoinRequest) -> Envelope<JoinResponse> {
        let started = Instant::now();
        let mut inner = self.inner.lock().await;
        let Some(agent) = inner.tokens.get(token).copied() else {
            let env = failed_env(&mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("join", None, 0, env, started, "not authenticated");
        };
        let tick = inner.world.tick;

        let why = req.why.trim().to_string();
        if why.is_empty() || why.chars().count() > 200 {
            let env = failed_env(
                &mut inner,
                Some(agent),
                ApiError::new(
                    ErrorCode::BadRequest,
                    "--why is required: one sentence, at most 200 characters",
                ),
            );
            drop(inner);
            return self.finish("join", Some(agent), tick, env, started, "missing --why");
        }
        if let Some(existing) = inner.sessions.get(&agent).copied() {
            let env = failed_env(
                &mut inner,
                Some(agent),
                ApiError::rule(format!(
                    "you already have session {existing} in this world; step 0 has no leave yet"
                )),
            );
            drop(inner);
            return self.finish("join", Some(agent), tick, env, started, "already joined");
        }

        let Some(meta) = inner.agents.get(&agent) else {
            let env = failed_env(&mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("join", None, 0, env, started, "no agent");
        };
        let session_id = inner.next_session_id;
        let cmd = JoinCommand {
            agent,
            nick: meta.nick.clone(),
            session: session_id,
        };

        let placement = match loo_core::join(&inner.world, &cmd, &self.cfg) {
            Ok((world, outcome)) => {
                inner.world = world;
                inner.next_session_id += 1;
                inner.sessions.insert(agent, session_id);
                if let Some(meta) = inner.agents.get_mut(&agent) {
                    meta.sent_by = Some(req.sent_by);
                    meta.why = why;
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
                let env = failed_env(&mut inner, Some(agent), ApiError::new(code, reject.message));
                drop(inner);
                return self.finish("join", Some(agent), tick, env, started, "join rejected");
            }
        };

        let summary = match &placement {
            Placement::Inside { at, .. } => format!("session {session_id} inside at {at}"),
            Placement::Waiting { ahead } => format!("session {session_id} waiting, {ahead} ahead"),
        };
        let env = ok_env(
            &mut inner,
            agent,
            JoinResponse {
                session_id,
                placement,
            },
        );
        drop(inner);
        self.finish("join", Some(agent), tick, env, started, summary)
    }

    pub async fn look(&self, token: &str) -> Envelope<LookResponse> {
        let started = Instant::now();
        let mut inner = self.inner.lock().await;
        let Some(agent) = inner.tokens.get(token).copied() else {
            let env = failed_env(&mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("look", None, 0, env, started, "not authenticated");
        };
        let tick = inner.world.tick;
        let env = match loo_core::look(&inner.world, agent, &self.cfg) {
            Some(view) => ok_env(&mut inner, agent, view),
            None => {
                let err = session_required(&inner, agent);
                failed_env(&mut inner, Some(agent), err)
            }
        };
        let summary = if env.ok { "view" } else { "rejected" };
        drop(inner);
        self.finish("look", Some(agent), tick, env, started, summary)
    }

    pub async fn map_view(&self, token: &str) -> Envelope<MapResponse> {
        let started = Instant::now();
        let mut inner = self.inner.lock().await;
        let Some(agent) = inner.tokens.get(token).copied() else {
            let env = failed_env(&mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("map", None, 0, env, started, "not authenticated");
        };
        let tick = inner.world.tick;
        let env = match loo_core::map_memory(&inner.world, agent) {
            Some(view) => ok_env(&mut inner, agent, view),
            None => {
                let err = session_required(&inner, agent);
                failed_env(&mut inner, Some(agent), err)
            }
        };
        let summary = if env.ok { "map memory" } else { "rejected" };
        drop(inner);
        self.finish("map", Some(agent), tick, env, started, summary)
    }

    pub async fn status(&self, token: &str) -> Envelope<()> {
        let started = Instant::now();
        let mut inner = self.inner.lock().await;
        let Some(agent) = inner.tokens.get(token).copied() else {
            let env = failed_env(&mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("status", None, 0, env, started, "not authenticated");
        };
        let tick = inner.world.tick;
        let env = ok_env(&mut inner, agent, ());
        drop(inner);
        self.finish("status", Some(agent), tick, env, started, "state")
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
        self.finish("rules", None, tick, env, started, "rules text")
    }

    pub async fn move_cmd(&self, token: &str, req: MoveRequest) -> Envelope<ActionQueued> {
        let started = Instant::now();
        let mut inner = self.inner.lock().await;
        let Some(agent) = inner.tokens.get(token).copied() else {
            let env = failed_env(&mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("move", None, 0, env, started, "not authenticated");
        };
        let tick = inner.world.tick;

        let dirs = match req.spec.dirs() {
            Ok(dirs) => dirs,
            Err(message) => {
                let env = failed_env(
                    &mut inner,
                    Some(agent),
                    ApiError::new(ErrorCode::BadRequest, message),
                );
                drop(inner);
                return self.finish("move", Some(agent), tick, env, started, "bad move");
            }
        };
        if dirs.is_empty() {
            let env = failed_env(
                &mut inner,
                Some(agent),
                ApiError::new(ErrorCode::BadRequest, "empty path"),
            );
            drop(inner);
            return self.finish("move", Some(agent), tick, env, started, "empty path");
        }
        let max_steps = (inner.world.map.width() + inner.world.map.height()) as usize;
        if dirs.len() > max_steps {
            let env = failed_env(
                &mut inner,
                Some(agent),
                ApiError::new(
                    ErrorCode::BadRequest,
                    format!("a move path is at most {max_steps} steps on this map"),
                ),
            );
            drop(inner);
            return self.finish("move", Some(agent), tick, env, started, "path too long");
        }
        if !inner.world.is_inside(agent) {
            let err = session_required(&inner, agent);
            let env = failed_env(&mut inner, Some(agent), err);
            drop(inner);
            return self.finish("move", Some(agent), tick, env, started, "not inside");
        }

        let label = req.spec.label();
        let action = ActionState {
            description: label.clone(),
            remaining: dirs.len() as u32,
        };
        inner.pending.insert(
            agent,
            IntentKind::Move {
                dirs,
                label: label.clone(),
            },
        );
        let effective_tick = tick + 1;
        let env = ok_env(
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
        )
    }

    pub async fn wait(&self, token: &str, req: WaitRequest) -> Envelope<WaitResponse> {
        let started = Instant::now();
        let timeout_seconds = req
            .timeout_seconds
            .unwrap_or(self.cfg.wait.default_seconds)
            .clamp(0.05, self.cfg.wait.max_seconds);

        let agent = { self.inner.lock().await.tokens.get(token).copied() };
        let Some(agent) = agent else {
            let mut inner = self.inner.lock().await;
            let env = failed_env(&mut inner, None, not_authenticated());
            drop(inner);
            return self.finish("wait", None, 0, env, started, "not authenticated");
        };

        let deadline = Instant::now() + Duration::from_secs_f64(timeout_seconds);
        let mut rx = self.tick_tx.subscribe();
        loop {
            {
                let mut inner = self.inner.lock().await;
                let state = agent_view(&inner, agent);
                let session = state.as_ref().and_then(|s| s.session_id);
                let has_events = session
                    .and_then(|s| inner.outbox.get(&s))
                    .is_some_and(|queue| !queue.is_empty());
                if has_events {
                    let events = take_events(&mut inner, session);
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
        let state = agent_view(&inner, agent);
        let session = state.as_ref().and_then(|s| s.session_id);
        let events = take_events(&mut inner, session);
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
        )
    }

    fn finish<T>(
        &self,
        command: &str,
        agent: Option<AgentId>,
        tick: Tick,
        env: Envelope<T>,
        started: Instant,
        summary: impl Into<String>,
    ) -> Envelope<T> {
        let line = serde_json::json!({
            "ts_ms": now_ms(),
            "tick": tick,
            "agent": agent,
            "command": command,
            "ok": env.ok,
            "duration_ms": started.elapsed().as_millis() as u64,
            "summary": summary.into(),
        });
        self.logs.command(&line);
        env
    }
}

fn not_authenticated() -> ApiError {
    ApiError::new(
        ErrorCode::NotAuthenticated,
        "unknown or missing token; run `loo register` first",
    )
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
                "you are outside the entrance waiting for the entrance cell ({ahead} in line)"
            ))
        }
        Some(_) => ApiError::rule("no position in the world"),
    }
}

fn agent_view(inner: &Inner, agent: AgentId) -> Option<AgentView> {
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
            description: action.label.clone(),
            remaining: action.remaining(),
        });
    Some(AgentView {
        agent_id: agent,
        nick: meta.nick.to_string(),
        tick: inner.world.tick,
        session_id: session.map(|s| s.id),
        placement,
        pos: world_agent.and_then(|a| a.pos),
        queue_ahead,
        action,
    })
}

fn ok_env<T>(inner: &mut Inner, agent: AgentId, result: T) -> Envelope<T> {
    let state = agent_view(inner, agent);
    let session = state.as_ref().and_then(|s| s.session_id);
    let events = take_events(inner, session);
    Envelope::ok(result, events, state)
}

fn failed_env<T>(inner: &mut Inner, agent: Option<AgentId>, error: ApiError) -> Envelope<T> {
    let state = agent.and_then(|agent| agent_view(inner, agent));
    let session = state.as_ref().and_then(|s| s.session_id);
    let events = take_events(inner, session);
    Envelope::failed(error, events, state)
}

fn take_events(inner: &mut Inner, session: Option<SessionId>) -> Vec<EventView> {
    let Some(session) = session else {
        return Vec::new();
    };
    inner
        .outbox
        .remove(&session)
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
    format!(
        "\
Company Time — AI toilet world (step 0 dev server)

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
      Your position, session, queue position and running action.
  loo move <N|E|S|W> [steps]   |   loo move <path, e.g. NNEE>
      Queue a move. One cell per tick. It stops at the first wall, closed door, other agent or map edge, and tells you where and why.
  loo wait [--timeout seconds]
      Block until something happens that concerns you or is in your view, or until the timeout (default {wait_default}s, max {wait_max}s). A timeout is a normal result, not an error.
  loo rules
      This text. Step 0 has no building, doors, toilets in use or combat yet.

World facts
- Every agent occupies one cell; two agents never share a cell.
- Dirs: N north (y-1), E east (x+1), S south (y+1), W west (x-1).
- A closed door blocks movement; an open door does not. A toilet never blocks.
- The settlement order inside a tick is a seeded shuffle of the agents present; the seed is written to the event log.
- View symbols: # wall, + closed door, ' open door, 1-5 toilet level, x unfinished site, @ you, a-z other agents, . buildable floor, : no-build floor, ? not seen or outside the map.
- You cannot see or receive events from outside your view; you get the full map size, the entrance, the toilets and the no-build areas once, when you join.",
        w = map_width,
        h = map_height,
        tick = cfg.tick_seconds,
        vw = cfg.view.width,
        vh = cfg.view.height,
        wait_default = cfg.wait.default_seconds,
        wait_max = cfg.wait.max_seconds,
    )
}

pub mod http;

/// Two append-only JSONL logs (design §8): every command, every world event.
pub struct Logs {
    commands: StdMutex<std::fs::File>,
    events: StdMutex<std::fs::File>,
}

impl Logs {
    pub fn open(dir: &Path) -> std::io::Result<Logs> {
        std::fs::create_dir_all(dir)?;
        Ok(Logs {
            commands: StdMutex::new(std::fs::File::create(dir.join("commands.jsonl"))?),
            events: StdMutex::new(std::fs::File::create(dir.join("events.jsonl"))?),
        })
    }

    pub fn command(&self, line: &serde_json::Value) {
        if let Ok(mut file) = self.commands.lock() {
            let _ = writeln!(file, "{line}");
            let _ = file.flush();
        }
    }

    pub fn events(&self, tick: Tick, events: &[loo_core::Event]) {
        if let Ok(mut file) = self.events.lock() {
            for event in events {
                let mut value = serde_json::to_value(event).unwrap_or(serde_json::Value::Null);
                if let serde_json::Value::Object(map) = &mut value {
                    map.insert("ts_ms".to_string(), serde_json::json!(now_ms()));
                    map.insert("world_tick".to_string(), serde_json::json!(tick));
                }
                let _ = writeln!(file, "{value}");
            }
            let _ = file.flush();
        }
    }
}
