//! `loo-core`: the rules engine (design §12).
//!
//! Pure functions only: `join`, `step`, and read-only views. The engine reads no
//! clock, opens no socket, touches no disk, and never uses a global RNG; the
//! seed is an argument. That is what makes replays exact.
//!
//! ```
//! use loo_core::{map, Config, Intent, WorldState, join, step, JoinCommand, JoinOutcome};
//! use loo_proto::Nick;
//!
//! let def = map::parse("grid\n.1.\n..E\n").unwrap();
//! let cfg = Config::default();
//! let world = WorldState::new(def);
//! let (world, outcome) = join(
//!     &world,
//!     &JoinCommand { agent: 1, nick: Nick::parse("dev-1").unwrap(), session: 1 },
//!     &cfg,
//! )
//! .unwrap();
//! assert_eq!(outcome, JoinOutcome::Inside { at: world.entrance });
//! let (_next, events) = step(&world, &[] as &[Intent], 42, &cfg);
//! assert!(events.is_empty());
//! ```

pub mod config;
pub mod event;
pub mod map;
pub mod rng;
pub mod state;
pub mod step;
pub mod view;

pub use config::Config;
pub use event::{ActionOutcome, Blocker, Event, EventKind};
pub use map::{Map, MapDef, MapError, Terrain};
pub use state::{Action, Agent, Object, Session, SessionStatus, WorldState};
pub use step::{
    join, step, Intent, IntentKind, JoinCommand, JoinOutcome, JoinReject, JoinRejectKind,
};
pub use view::{briefing, is_usable, look, map_memory};
