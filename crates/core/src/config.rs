//! Every number from design §9 lives here, with the design's starting value as
//! the default. Rules code never hard-codes a number that has a config field.
//!
//! Fields marked "step 2+" are not read by the step-0 world yet; they are part
//! of the config contract so later steps cannot reintroduce magic numbers.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    /// Wall-clock length of one tick in seconds.
    pub tick_seconds: f64,
    /// Agents allowed inside the world at once.
    pub max_on_field: usize,
    pub view: ViewConfig,
    pub build: BuildConfig,
    pub toilet: ToiletConfig,
    pub need: NeedConfig,
    pub combat: CombatConfig,
    pub agent: AgentConfig,
    pub session: SessionConfig,
    pub wait: WaitConfig,
    pub limits: LimitsConfig,
    pub persist: PersistConfig,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            tick_seconds: 5.0,
            max_on_field: 50,
            view: ViewConfig::default(),
            build: BuildConfig::default(),
            toilet: ToiletConfig::default(),
            need: NeedConfig::default(),
            combat: CombatConfig::default(),
            agent: AgentConfig::default(),
            session: SessionConfig::default(),
            wait: WaitConfig::default(),
            limits: LimitsConfig::default(),
            persist: PersistConfig::default(),
        }
    }
}

impl Config {
    pub fn from_json(text: &str) -> Result<Config, serde_json::Error> {
        serde_json::from_str(text)
    }

    /// How long `loo wait` should block by default: the configured wait, but
    /// never shorter than one tick and never longer than the maximum wait.
    pub fn wait_default_seconds(&self) -> f64 {
        self.wait
            .default_seconds
            .max(self.tick_seconds)
            .min(self.wait.max_seconds)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ViewConfig {
    pub width: i32,
    pub height: i32,
}

impl Default for ViewConfig {
    fn default() -> Self {
        Self {
            width: 9,
            height: 9,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct BuildConfig {
    /// Work points to finish a wall / door / level-1 toilet.
    pub wall_work: u32,
    pub door_work: u32,
    pub toilet_work: u32,
    /// Demolition rate per tick for walls and doors, and for unfinished sites.
    pub wall_door_demolish_per_tick: u32,
    pub site_demolish_per_tick: u32,
    /// Continuous downgrade rate for toilets, and the level-1 → empty work.
    pub toilet_demolish_per_tick: u32,
    pub toilet_level1_demolish_work: u32,
    /// Level 1→2, 2→3, 3→4, 4→5.
    pub upgrade_work: [u32; 4],
}

impl Default for BuildConfig {
    fn default() -> Self {
        Self {
            wall_work: 2,
            door_work: 2,
            toilet_work: 3,
            wall_door_demolish_per_tick: 1,
            site_demolish_per_tick: 1,
            toilet_demolish_per_tick: 2,
            toilet_level1_demolish_work: 3,
            upgrade_work: [6, 12, 24, 48],
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ToiletConfig {
    /// Score multiplier for levels 1..=5.
    pub multiplier: [u32; 5],
}

impl Default for ToiletConfig {
    fn default() -> Self {
        Self {
            multiplier: [1, 2, 3, 5, 10],
        }
    }
}

/// Step 2+ fields. Step 0 only reads `interrupt_recovery_ticks` indirectly via
/// nothing; they stay here so the numbers exist exactly once.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct NeedConfig {
    pub urine_use_ticks: u32,
    pub feces_use_ticks: u32,
    pub base_score_urine: u32,
    pub base_score_feces: u32,
    pub time_bonus_per_tick: u32,
    pub deadline_ticks_min: u32,
    pub deadline_ticks_max: u32,
    pub interrupt_recovery_ticks: u32,
    pub linger_ticks: u32,
}

impl Default for NeedConfig {
    fn default() -> Self {
        Self {
            urine_use_ticks: 4,
            feces_use_ticks: 8,
            base_score_urine: 100,
            base_score_feces: 200,
            time_bonus_per_tick: 1,
            deadline_ticks_min: 120,
            deadline_ticks_max: 240,
            interrupt_recovery_ticks: 12,
            linger_ticks: 36,
        }
    }
}

/// Step 3+ fields.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct CombatConfig {
    pub windup_ticks: u32,
    pub penalty_ticks: u32,
    pub stun_ticks: u32,
    pub immunity_ticks: u32,
    pub attack_cooldown_ticks: u32,
    pub defend_cooldown_ticks: u32,
}

impl Default for CombatConfig {
    fn default() -> Self {
        Self {
            windup_ticks: 3,
            penalty_ticks: 6,
            stun_ticks: 3,
            immunity_ticks: 6,
            attack_cooldown_ticks: 2,
            defend_cooldown_ticks: 2,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AgentConfig {
    /// Cumulative score needed for agent levels 1..=5.
    pub level_thresholds: [u32; 5],
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            level_thresholds: [0, 1000, 3000, 8000, 20000],
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SessionConfig {
    /// Step 1+.
    pub idle_cleanup_ticks: u32,
    /// Step 5 (queue entities on the map).
    pub queue_idle_seconds: u32,
    pub queue_capacity: usize,
    pub max_agents_per_user: usize,
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            idle_cleanup_ticks: 60,
            queue_idle_seconds: 60,
            queue_capacity: 50,
            max_agents_per_user: 5,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct WaitConfig {
    pub default_seconds: f64,
    pub max_seconds: f64,
}

impl Default for WaitConfig {
    fn default() -> Self {
        Self {
            default_seconds: 25.0,
            max_seconds: 55.0,
        }
    }
}

/// Step 1+ (the dev server does not rate limit yet).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct LimitsConfig {
    pub requests_per_second: u32,
}

impl Default for LimitsConfig {
    fn default() -> Self {
        Self {
            requests_per_second: 2,
        }
    }
}

/// Step 1+.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct PersistConfig {
    pub snapshot_interval_ticks: u32,
}

impl Default for PersistConfig {
    fn default() -> Self {
        Self {
            snapshot_interval_ticks: 120,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_design_starting_values() {
        let cfg = Config::default();
        assert_eq!(cfg.tick_seconds, 5.0);
        assert_eq!((cfg.view.width, cfg.view.height), (9, 9));
        assert_eq!(cfg.build.upgrade_work, [6, 12, 24, 48]);
        assert_eq!(cfg.toilet.multiplier, [1, 2, 3, 5, 10]);
        assert_eq!((cfg.need.urine_use_ticks, cfg.need.feces_use_ticks), (4, 8));
        assert_eq!(
            (cfg.need.deadline_ticks_min, cfg.need.deadline_ticks_max),
            (120, 240)
        );
        assert_eq!(cfg.session.queue_capacity, 50);
        assert_eq!(
            (cfg.wait.default_seconds, cfg.wait.max_seconds),
            (25.0, 55.0)
        );
    }

    #[test]
    fn json_overrides_are_partial() {
        let cfg = Config::from_json(r#"{"tick_seconds": 1.0, "view": {"width": 5}}"#).unwrap();
        assert_eq!(cfg.tick_seconds, 1.0);
        assert_eq!(cfg.view.width, 5);
        assert_eq!(cfg.view.height, 9, "untouched fields keep design defaults");
        assert_eq!(cfg.build.wall_work, 2);
    }

    #[test]
    fn wait_default_is_clamped_to_tick_and_max() {
        let mut cfg = Config::default();
        assert_eq!(cfg.wait_default_seconds(), 25.0, "design default");
        cfg.tick_seconds = 30.0;
        assert_eq!(
            cfg.wait_default_seconds(),
            30.0,
            "a long tick widens the wait"
        );
        cfg.tick_seconds = 60.0;
        assert_eq!(
            cfg.wait_default_seconds(),
            55.0,
            "the maximum wait still caps it"
        );
    }
}
