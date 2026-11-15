//! Compact, colourless text output for language models (design §10).
//!
//! Every response shows three things, in this order: this command's result, the
//! events since the previous response, and your own state.

use loo_proto::{
    ActionQueued, AgentView, Envelope, ErrorCode, Grid, JoinResponse, LeaveResponse, LookResponse,
    MapResponse, Need, Placement, RegisterResponse, RulesResponse, SessionOutcome, Tick,
    WaitResponse, WaitWake,
};

pub trait Renderable {
    fn result_lines(&self) -> Vec<String>;
}

impl Renderable for () {
    fn result_lines(&self) -> Vec<String> {
        Vec::new()
    }
}

impl Renderable for RegisterResponse {
    fn result_lines(&self) -> Vec<String> {
        vec![format!(
            "registered {} as agent {} · this LOO_HOME now holds the identity",
            self.nick, self.agent_id
        )]
    }
}

impl Renderable for JoinResponse {
    fn result_lines(&self) -> Vec<String> {
        match &self.placement {
            Placement::Inside { at, briefing } => {
                let usable = briefing.toilets.iter().filter(|t| t.usable).count();
                vec![
                    format!("session {} · entered the world at {at}", self.session_id),
                    format!(
                        "briefing: map {}x{} · entrance {} · view {}x{} · toilets {} ({} usable) · no-build areas {}",
                        briefing.map_width,
                        briefing.map_height,
                        briefing.entrance,
                        briefing.view_width,
                        briefing.view_height,
                        briefing.toilets.len(),
                        usable,
                        briefing.no_build.len()
                    ),
                ]
            }
            Placement::Waiting { ahead } => vec![format!(
                "session {} · waiting outside the entrance · {} ahead of you",
                self.session_id, ahead
            )],
        }
    }
}

impl Renderable for LookResponse {
    fn result_lines(&self) -> Vec<String> {
        let mut lines = vec![format!("view at {} · tick {}", self.pos, self.tick)];
        lines.extend(self.grid.rows.iter().cloned());
        lines.push(legend_line(&self.grid));
        lines
    }
}

impl Renderable for MapResponse {
    fn result_lines(&self) -> Vec<String> {
        if self.grid.rows.is_empty() {
            return vec!["no map memory yet".to_string()];
        }
        let mut lines = vec![format!(
            "remembered map {}x{} at ({},{})",
            self.grid.width, self.grid.height, self.grid.origin.x, self.grid.origin.y
        )];
        lines.extend(self.grid.rows.iter().cloned());
        lines.push(legend_line(&self.grid));
        lines.push("first seen (hex tick mod 16, '-' = never seen):".to_string());
        for row in &self.seen_at {
            lines.push(row.iter().map(|t| hex_tick(*t)).collect());
        }
        lines
    }
}

impl Renderable for ActionQueued {
    fn result_lines(&self) -> Vec<String> {
        let steps = if self.action.remaining > 0 {
            format!(" · {} step(s)", self.action.remaining)
        } else {
            String::new()
        };
        vec![format!(
            "queued {}{} · takes effect at tick {}",
            self.action.description, steps, self.effective_tick
        )]
    }
}

impl Renderable for LeaveResponse {
    fn result_lines(&self) -> Vec<String> {
        vec![format!(
            "left the world · outcome {} · score {}",
            outcome_word(self.outcome),
            self.score
        )]
    }
}

impl Renderable for WaitResponse {
    fn result_lines(&self) -> Vec<String> {
        let woke = match self.woke {
            WaitWake::Event => "something happened",
            WaitWake::Timeout => "timeout (normal result, not an error)",
        };
        vec![format!(
            "wait returned: {woke} · waited {}ms · timeout {}s",
            self.elapsed_ms, self.timeout_seconds
        )]
    }
}

impl Renderable for RulesResponse {
    fn result_lines(&self) -> Vec<String> {
        self.text.lines().map(|line| line.to_string()).collect()
    }
}

pub fn render<T: Renderable>(label: &str, env: &Envelope<T>) -> String {
    let tick = env.state.as_ref().map(|state| state.tick).unwrap_or(0);
    let mut out = String::new();
    match (&env.ok, &env.error) {
        (true, _) => {
            out.push_str(&format!("ok {label} tick={tick}\n"));
            if let Some(result) = &env.result {
                for line in result.result_lines() {
                    out.push_str("  ");
                    out.push_str(&line);
                    out.push('\n');
                }
            }
        }
        (false, Some(error)) => {
            let head = if error.code == ErrorCode::RateLimited {
                "rate limited"
            } else {
                "rejected"
            };
            out.push_str(&format!("{head} {label} tick={tick}\n"));
            out.push_str(&format!("  {}\n", error.message));
            if let Some(seconds) = error.retry_after_seconds {
                out.push_str(&format!("  retry after {seconds}s\n"));
            }
        }
        (false, None) => out.push_str(&format!("failed {label} tick={tick}\n")),
    }

    if env.events.is_empty() {
        out.push_str("events: none\n");
    } else {
        out.push_str("events:\n");
        for event in &env.events {
            out.push_str(&format!("  [t{}] {}\n", event.tick, event.text));
        }
    }

    match &env.state {
        Some(state) => out.push_str(&format!("you: {}\n", state_line(state))),
        None => out.push_str("you: no identity yet\n"),
    }
    out
}

pub fn state_line(state: &AgentView) -> String {
    let mut parts = vec![format!("{} (#{})", state.nick, state.agent_id)];
    match state.session_id {
        Some(session) => parts.push(format!("session {session}")),
        None => parts.push("no session".to_string()),
    }
    match state.pos {
        Some(pos) => parts.push(format!("at {pos}")),
        None => parts.push("outside the world".to_string()),
    }
    if let Some(ahead) = state.queue_ahead {
        parts.push(format!("queue position {ahead}"));
    }
    if let Some(need) = state.need {
        parts.push(format!(
            "need: {} · use {}/{} · deadline in {}",
            need_word(need),
            state.use_ticks_done,
            state.use_ticks_total,
            state.deadline_tick.saturating_sub(state.tick)
        ));
    }
    if let Some(recovery) = state.recovery_deadline {
        parts.push(format!(
            "recovery in {}",
            recovery.saturating_sub(state.tick)
        ));
    }
    if state.score > 0 || state.outcome.is_some() {
        let outcome = state
            .outcome
            .map(|outcome| format!(" · outcome {}", outcome_word(outcome)))
            .unwrap_or_default();
        parts.push(format!("score {}{}", state.score, outcome));
    }
    if state.stun_until > state.tick {
        parts.push(format!("stunned for {}", state.stun_until - state.tick));
    }
    if state.immunity_until > state.tick {
        parts.push(format!("immune for {}", state.immunity_until - state.tick));
    }
    if let Some(pos) = state.defending {
        parts.push(format!("defending {pos}"));
    }
    if state.attack_cooldown_until > state.tick {
        parts.push(format!(
            "attack cooldown {}",
            state.attack_cooldown_until - state.tick
        ));
    }
    if state.defend_cooldown_until > state.tick {
        parts.push(format!(
            "defend cooldown {}",
            state.defend_cooldown_until - state.tick
        ));
    }
    parts.push(format!(
        "score_total {} · level {}",
        state.score_total, state.level
    ));
    match &state.action {
        Some(action) if action.remaining > 0 => parts.push(format!(
            "action: {} ({} step(s) left)",
            action.description, action.remaining
        )),
        Some(action) => parts.push(format!("action: {}", action.description)),
        None => parts.push("idle".to_string()),
    }
    parts.join(" · ")
}

fn need_word(need: Need) -> &'static str {
    match need {
        Need::Urine => "urine",
        Need::Feces => "feces",
    }
}

fn outcome_word(outcome: SessionOutcome) -> &'static str {
    match outcome {
        SessionOutcome::Success => "success",
        SessionOutcome::FailedDeadline => "failed_deadline",
        SessionOutcome::FailedRecovery => "failed_recovery",
        SessionOutcome::Left => "left",
        SessionOutcome::Abandoned => "abandoned",
    }
}

fn legend_line(grid: &Grid) -> String {
    let entries: Vec<String> = grid
        .legend
        .iter()
        .map(|entry| format!("{} {}", entry.symbol, entry.meaning))
        .collect();
    format!("legend: {}", entries.join(" · "))
}

fn hex_tick(tick: Tick) -> char {
    if tick == 0 {
        '-'
    } else {
        char::from_digit((tick % 16) as u32, 16).unwrap_or('?')
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use loo_proto::{ActionState, EventView, Legend};

    fn grid() -> Grid {
        Grid {
            origin: loo_proto::Pos::new(0, 0),
            width: 3,
            height: 2,
            rows: vec!["#@.".to_string(), "?:+".to_string()],
            legend: vec![Legend {
                symbol: "#".to_string(),
                meaning: "wall".to_string(),
            }],
        }
    }

    #[test]
    fn look_renders_grid_legend_and_state() {
        let env = Envelope::ok(
            LookResponse {
                grid: grid(),
                pos: loo_proto::Pos::new(1, 0),
                tick: 4,
            },
            vec![EventView {
                tick: 3,
                seq: 1,
                text: "dev-1 moved (0,0) -> (1,0)".to_string(),
            }],
            Some(AgentView {
                agent_id: 1,
                nick: "dev-1".to_string(),
                tick: 4,
                session_id: Some(1),
                placement: Some(loo_proto::PlacementKind::Inside),
                pos: Some(loo_proto::Pos::new(1, 0)),
                queue_ahead: None,
                action: None,
                need: None,
                use_ticks_done: 0,
                use_ticks_total: 0,
                deadline_tick: 0,
                recovery_deadline: None,
                score: 0,
                outcome: None,
                score_total: 0,
                level: 1,
                stun_until: 0,
                immunity_until: 0,
                attack_cooldown_until: 0,
                defend_cooldown_until: 0,
                defending: None,
            }),
        );
        let text = render("look", &env);
        assert!(text.starts_with("ok look tick=4\n"));
        assert!(text.contains("  #@.\n  ?:+\n"), "{text}");
        assert!(text.contains("legend: # wall"));
        assert!(text.contains("[t3] dev-1 moved (0,0) -> (1,0)"));
        assert!(text
            .contains("you: dev-1 (#1) · session 1 · at (1,0) · score_total 0 · level 1 · idle"));
        assert!(!text.contains('\u{1b}'), "no colour codes");
    }

    #[test]
    fn rejected_renders_reason_and_state() {
        let env: Envelope<ActionQueued> = Envelope::failed(
            loo_proto::ApiError::rule("north is blocked by a wall"),
            Vec::new(),
            Some(AgentView {
                agent_id: 2,
                nick: "dev-2".to_string(),
                tick: 9,
                session_id: Some(3),
                placement: Some(loo_proto::PlacementKind::Waiting),
                pos: None,
                queue_ahead: Some(1),
                action: None,
                need: None,
                use_ticks_done: 0,
                use_ticks_total: 0,
                deadline_tick: 0,
                recovery_deadline: None,
                score: 0,
                outcome: None,
                score_total: 0,
                level: 1,
                stun_until: 0,
                immunity_until: 0,
                attack_cooldown_until: 0,
                defend_cooldown_until: 0,
                defending: None,
            }),
        );
        let text = render("move", &env);
        assert!(text.starts_with("rejected move tick=9\n"));
        assert!(text.contains("north is blocked by a wall"));
        assert!(text.contains("queue position 1"));
        assert!(text.contains("events: none"));
    }

    #[test]
    fn idle_state_line_is_a_frozen_contract() {
        let env: Envelope<()> = Envelope::ok(
            (),
            Vec::new(),
            Some(AgentView {
                agent_id: 1,
                nick: "dev-1".to_string(),
                tick: 4,
                session_id: Some(1),
                placement: Some(loo_proto::PlacementKind::Inside),
                pos: Some(loo_proto::Pos::new(1, 0)),
                queue_ahead: None,
                action: None,
                need: None,
                use_ticks_done: 0,
                use_ticks_total: 0,
                deadline_tick: 0,
                recovery_deadline: None,
                score: 0,
                outcome: None,
                score_total: 0,
                level: 1,
                stun_until: 0,
                immunity_until: 0,
                attack_cooldown_until: 0,
                defend_cooldown_until: 0,
                defending: None,
            }),
        );
        assert_eq!(
            render("status", &env),
            "ok status tick=4\n\
             events: none\n\
             you: dev-1 (#1) · session 1 · at (1,0) · score_total 0 · level 1 · idle\n"
        );
    }

    #[test]
    fn wait_renders_the_server_effective_timeout() {
        let env = Envelope::ok(
            WaitResponse {
                woke: WaitWake::Timeout,
                timeout_seconds: 30.0,
                elapsed_ms: 42,
            },
            Vec::new(),
            None,
        );
        let text = render("wait", &env);
        assert!(text.contains("timeout 30s"), "{text}");
        assert!(
            text.contains("timeout (normal result, not an error)"),
            "{text}"
        );
    }

    #[test]
    fn map_shows_seen_ticks() {
        let env = Envelope::ok(
            MapResponse {
                grid: Grid {
                    origin: loo_proto::Pos::new(0, 0),
                    width: 2,
                    height: 1,
                    rows: vec!["E?".to_string()],
                    legend: Vec::new(),
                },
                seen_at: vec![vec![1, 0]],
            },
            Vec::new(),
            None,
        );
        let text = render("map", &env);
        assert!(text.contains("first seen"), "{text}");
        assert!(text.contains("1-"), "seen tick 1 then never: {text}");
    }

    fn action_queued(description: &str, remaining: u32) -> Envelope<ActionQueued> {
        Envelope::ok(
            ActionQueued {
                action: ActionState {
                    description: description.to_string(),
                    remaining,
                },
                effective_tick: 5,
            },
            Vec::new(),
            None,
        )
    }

    #[test]
    fn action_queued_shows_steps_only_when_there_are_some() {
        let moved = render("move", &action_queued("move N 3", 3));
        assert!(
            moved.contains("queued move N 3 · 3 step(s) · takes effect at tick 5"),
            "{moved}"
        );

        let built = render("build", &action_queued("build wall (5,4)", 0));
        assert!(
            built.contains("queued build wall (5,4) · takes effect at tick 5"),
            "{built}"
        );
        assert!(!built.contains("0 step(s)"), "{built}");
    }

    fn state_with_fields() -> AgentView {
        AgentView {
            agent_id: 1,
            nick: "dev-1".to_string(),
            tick: 100,
            session_id: Some(1),
            placement: Some(loo_proto::PlacementKind::Inside),
            pos: Some(loo_proto::Pos::new(1, 0)),
            queue_ahead: None,
            action: None,
            need: Some(loo_proto::Need::Feces),
            use_ticks_done: 3,
            use_ticks_total: 8,
            deadline_tick: 212,
            recovery_deadline: None,
            score: 0,
            outcome: None,
            score_total: 0,
            level: 1,
            stun_until: 0,
            immunity_until: 0,
            attack_cooldown_until: 0,
            defend_cooldown_until: 0,
            defending: None,
        }
    }

    #[test]
    fn state_line_renders_need_use_and_deadline() {
        assert_eq!(
            state_line(&state_with_fields()),
            "dev-1 (#1) · session 1 · at (1,0) · need: feces · use 3/8 · deadline in 112 · score_total 0 · level 1 · idle"
        );
    }

    #[test]
    fn state_line_renders_recovery_and_score() {
        let mut state = state_with_fields();
        state.recovery_deadline = Some(105);
        state.score = 1550;
        state.outcome = Some(loo_proto::SessionOutcome::Success);
        assert_eq!(
            state_line(&state),
            "dev-1 (#1) · session 1 · at (1,0) · need: feces · use 3/8 · deadline in 112 · recovery in 5 · score 1550 · outcome success · score_total 0 · level 1 · idle"
        );
    }

    #[test]
    fn state_line_renders_cumulative_score_and_combat() {
        let mut state = state_with_fields();
        state.score_total = 3500;
        state.level = 3;
        state.stun_until = 103;
        state.immunity_until = 106;
        state.defending = Some(loo_proto::Pos::new(2, 1));
        state.attack_cooldown_until = 105;
        state.defend_cooldown_until = 104;

        let line = state_line(&state);
        assert!(line.contains("score_total 3500 · level 3"), "{line}");
        assert!(line.contains("stunned for 3"), "{line}");
        assert!(line.contains("immune for 6"), "{line}");
        assert!(line.contains("defending (2,1)"), "{line}");
        assert!(line.contains("attack cooldown 5"), "{line}");
        assert!(line.contains("defend cooldown 4"), "{line}");
        assert!(
            line.ends_with("score_total 3500 · level 3 · idle"),
            "combat fields precede the action and cumulative score stays last: {line}"
        );
    }

    #[test]
    fn combat_fields_hide_when_inactive_and_score_always_shows() {
        let line = state_line(&state_with_fields());
        assert!(line.contains("score_total 0 · level 1"), "{line}");
        for hidden in ["stunned", "immune", "defending", "cooldown"] {
            assert!(!line.contains(hidden), "{hidden} must stay hidden: {line}");
        }
    }

    #[test]
    fn leave_renders_outcome_and_score() {
        let env = Envelope::ok(
            LeaveResponse {
                outcome: loo_proto::SessionOutcome::Left,
                score: 240,
            },
            Vec::new(),
            None,
        );
        let text = render("leave", &env);
        assert!(
            text.contains("left the world · outcome left · score 240"),
            "{text}"
        );
    }
}
