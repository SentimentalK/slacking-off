//! Compact, colourless text output for language models (design §10).
//!
//! Every response shows three things, in this order: this command's result, the
//! events since the previous response, and your own state.

use loo_proto::{
    ActionQueued, AgentView, Envelope, Grid, JoinResponse, LookResponse, MapResponse, Placement,
    RegisterResponse, RulesResponse, Tick, WaitResponse, WaitWake,
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
        vec![format!(
            "queued {} · {} step(s) · takes effect at tick {}",
            self.action.description, self.action.remaining, self.effective_tick
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
            out.push_str(&format!("rejected {label} tick={tick}\n"));
            out.push_str(&format!("  {}\n", error.message));
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
    match &state.action {
        Some(action) => parts.push(format!(
            "action: {} ({} step(s) left)",
            action.description, action.remaining
        )),
        None => parts.push("idle".to_string()),
    }
    parts.join(" · ")
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
    use loo_proto::{EventView, Legend};

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
            }),
        );
        let text = render("look", &env);
        assert!(text.starts_with("ok look tick=4\n"));
        assert!(text.contains("  #@.\n  ?:+\n"), "{text}");
        assert!(text.contains("legend: # wall"));
        assert!(text.contains("[t3] dev-1 moved (0,0) -> (1,0)"));
        assert!(text.contains("you: dev-1 (#1) · session 1 · at (1,0) · idle"));
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
            }),
        );
        let text = render("move", &env);
        assert!(text.starts_with("rejected move tick=9\n"));
        assert!(text.contains("north is blocked by a wall"));
        assert!(text.contains("queue position 1"));
        assert!(text.contains("events: none"));
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
}
