//! `loo-core`: the rules engine (design §12).
//!
//! Pure functions only: `join`, `step`, and read-only views. The engine reads no
//! clock, opens no socket, touches no disk, and never uses a global RNG; the
//! seed is an argument. That is what makes replays exact.
//!
//! ```
//! use loo_core::{map, Config, EventKind, Intent, WorldState, join, step, JoinCommand, JoinOutcome};
//! use loo_proto::Nick;
//!
//! let def = map::parse("grid\n.1.\n..E\n").unwrap();
//! let cfg = Config::default();
//! let world = WorldState::new(def);
//! let (world, outcome, _events) = join(
//!     &world,
//!     &JoinCommand { agent: 1, nick: Nick::parse("dev-1").unwrap(), session: 1, score_total: 0 },
//!     &cfg,
//!     0,
//!     0,
//! )
//! .unwrap();
//! assert_eq!(outcome, JoinOutcome::Inside { at: world.entrance });
//! let (_next, events) = step(&world, &[] as &[Intent], 42, &cfg);
//! assert_eq!(events.len(), 1, "every tick settles");
//! assert!(matches!(events[0].kind, EventKind::TickSettled));
//! ```

pub mod config;
pub mod event;
pub mod map;
pub mod replay;
pub mod rng;
pub mod rules;
pub mod state;
pub mod step;
pub mod view;

pub use config::Config;
pub use event::{ActionOutcome, Blocker, Event, EventKind, ObjectCause};
pub use map::{Map, MapDef, MapError, Terrain};
pub use replay::{diff_worlds, replay, restore, ReplayError, Snapshot, WorldDiff};
pub use rules::{
    agent_level, session_score, validate_attack, validate_attack_at, validate_build,
    validate_defend, validate_defend_at, validate_demolish, validate_door, validate_downgrade,
    validate_upgrade, validate_use, weighted_score,
};
pub use state::{is_stunned, Action, Agent, Object, Session, SessionStatus, SiteKind, WorldState};
pub use step::{
    join, leave, step, Intent, IntentKind, JoinCommand, JoinOutcome, JoinReject, JoinRejectKind,
};
pub use view::{briefing, is_usable, look, map_memory};
