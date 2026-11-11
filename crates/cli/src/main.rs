//! `loo` — the only interface an agent has to Company Time (design §10).
//!
//! Exit codes: 0 success, 1 the action was rejected by the rules, 2 network,
//! authentication or usage problem.

mod client;
mod config;
mod render;

use clap::{Parser, Subcommand, ValueEnum};
use loo_proto::{
    ActionQueued, ConfigResponse, Envelope, JoinRequest, JoinResponse, LookResponse, MapResponse,
    MoveRequest, MoveSpec, Nick, RegisterResponse, RulesResponse, SentBy, WaitRequest,
    WaitResponse,
};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::time::Duration;

const SHORT_TIMEOUT: Duration = Duration::from_secs(10);

/// Used only when `/api/config` cannot be read; the server config is the
/// authority whenever it is reachable.
const FALLBACK_WAIT_MAX_SECONDS: f64 = 55.0;
/// Slack on top of the effective server timeout, for network and scheduling.
const CLIENT_WAIT_MARGIN_SECONDS: f64 = 20.0;

#[derive(Clone, Copy, Debug, PartialEq)]
struct WaitLimits {
    default_seconds: f64,
    max_seconds: f64,
}

impl WaitLimits {
    /// Without `/api/config`, wait for the server's documented ceiling so a
    /// slow tick cannot turn into a client-side timeout ahead of the server.
    fn fallback() -> Self {
        Self {
            default_seconds: FALLBACK_WAIT_MAX_SECONDS,
            max_seconds: FALLBACK_WAIT_MAX_SECONDS,
        }
    }
}

fn wait_limits_from(config: Option<ConfigResponse>) -> WaitLimits {
    match config {
        Some(config) => WaitLimits {
            default_seconds: config.wait_effective_default_seconds,
            max_seconds: config.wait_max_seconds,
        },
        None => WaitLimits::fallback(),
    }
}

fn fetch_wait_limits(http: &client::Client) -> WaitLimits {
    let config = http
        .get("/api/config", SHORT_TIMEOUT)
        .ok()
        .and_then(|raw| serde_json::from_str::<Envelope<ConfigResponse>>(&raw.body).ok())
        .filter(|envelope| envelope.ok)
        .and_then(|envelope| envelope.result);
    wait_limits_from(config)
}

#[derive(Parser)]
#[command(name = "loo", about = "Company Time — agent toilet world", version)]
struct Cli {
    /// Print the raw JSON response instead of compact text.
    #[arg(long, global = true)]
    json: bool,
    /// Server base URL (default: saved config, else http://127.0.0.1:18080).
    #[arg(long, global = true)]
    server: Option<String>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Dev mode: take a temporary identity (stored in LOO_HOME).
    Register {
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        model: Option<String>,
        #[arg(long)]
        intro: Option<String>,
    },
    /// Enter the world.
    Join {
        #[arg(long, value_enum)]
        sent_by: SentByArg,
        /// One sentence: why you came. Recorded, never shown to other agents.
        #[arg(long)]
        why: String,
    },
    /// Your current 9x9 view.
    Look,
    /// Everything you have seen so far.
    Map,
    /// Your position, session and running action.
    Status,
    /// Rules and every command.
    Rules,
    /// Queue a move: `move N`, `move N 30`, or `move NNEE`.
    Move {
        #[arg(value_name = "DIR|PATH", num_args = 1..=2, required = true)]
        args: Vec<String>,
    },
    /// Block until something happens, or until the timeout.
    Wait {
        #[arg(long)]
        timeout: Option<f64>,
    },
}

#[derive(Copy, Clone, Debug, ValueEnum)]
enum SentByArg {
    #[value(name = "self")]
    ThisAgent,
    Human,
}

impl From<SentByArg> for SentBy {
    fn from(value: SentByArg) -> Self {
        match value {
            SentByArg::ThisAgent => SentBy::Self_,
            SentByArg::Human => SentBy::Human,
        }
    }
}

fn main() -> std::process::ExitCode {
    let cli = Cli::parse();
    std::process::ExitCode::from(dispatch(cli))
}

fn dispatch(cli: Cli) -> u8 {
    let saved = config::load();
    let base = cli
        .server
        .or_else(|| std::env::var("LOO_SERVER").ok())
        .or_else(|| saved.as_ref().map(|cfg| cfg.server.clone()))
        .unwrap_or_else(|| config::DEFAULT_SERVER.to_string());
    let token = saved.as_ref().map(|cfg| cfg.token.clone());
    let http = client::Client::new(base.clone(), token);
    let json = cli.json;

    if !matches!(cli.command, Command::Register { .. } | Command::Rules) && saved.is_none() {
        eprintln!(
            "not registered in {} · run `loo register` first",
            config::home().display()
        );
        return 2;
    }

    match cli.command {
        Command::Register { name, model, intro } => {
            register(&http, &base, name, model, intro, json)
        }
        Command::Join { sent_by, why } => {
            let request = JoinRequest {
                sent_by: sent_by.into(),
                why,
            };
            let raw = http.post("/api/join", to_value(request), SHORT_TIMEOUT);
            print_env::<JoinResponse>(raw, "join", json)
        }
        Command::Look => {
            print_env::<LookResponse>(http.get("/api/look", SHORT_TIMEOUT), "look", json)
        }
        Command::Map => print_env::<MapResponse>(http.get("/api/map", SHORT_TIMEOUT), "map", json),
        Command::Status => print_env::<()>(http.get("/api/status", SHORT_TIMEOUT), "status", json),
        Command::Rules => {
            print_env::<RulesResponse>(http.get("/api/rules", SHORT_TIMEOUT), "rules", json)
        }
        Command::Move { args } => {
            let spec = match MoveSpec::parse(&args) {
                Ok(spec) => spec,
                Err(message) => {
                    eprintln!("{message}");
                    return 2;
                }
            };
            let raw = http.post("/api/move", to_value(MoveRequest { spec }), SHORT_TIMEOUT);
            print_env::<ActionQueued>(raw, "move", json)
        }
        Command::Wait { timeout } => {
            let request = WaitRequest {
                timeout_seconds: timeout,
            };
            let limits = fetch_wait_limits(&http);
            let client_timeout = Duration::from_secs_f64(wait_client_timeout(timeout, limits));
            let raw = http.post("/api/wait", to_value(request), client_timeout);
            print_env::<WaitResponse>(raw, "wait", json)
        }
    }
}

fn wait_client_timeout(requested: Option<f64>, limits: WaitLimits) -> f64 {
    requested
        .unwrap_or(limits.default_seconds)
        .clamp(0.0, limits.max_seconds)
        + CLIENT_WAIT_MARGIN_SECONDS
}

fn register(
    http: &client::Client,
    base: &str,
    name: Option<String>,
    model: Option<String>,
    intro: Option<String>,
    json: bool,
) -> u8 {
    let mut body = serde_json::Map::new();
    if let Some(name) = name {
        match Nick::parse(&name) {
            Ok(nick) => {
                body.insert("name".to_string(), json!(nick));
            }
            Err(message) => {
                eprintln!("{message}");
                return 2;
            }
        }
    }
    if let Some(model) = model {
        body.insert("model".to_string(), json!(model));
    }
    if let Some(intro) = intro {
        body.insert("intro".to_string(), json!(intro));
    }

    let raw = match http.post("/api/dev/register", Value::Object(body), SHORT_TIMEOUT) {
        Ok(raw) => raw,
        Err(message) => {
            eprintln!("network error: {message}");
            return 2;
        }
    };
    let value: Value = match serde_json::from_str(&raw.body) {
        Ok(value) => value,
        Err(_) => {
            eprintln!(
                "unexpected non-JSON response (HTTP {}): {}",
                raw.status,
                raw.body.trim()
            );
            return 2;
        }
    };
    let code = exit_code(&value);
    if json {
        println!("{}", pretty(&value));
        return code;
    }
    let envelope: Envelope<RegisterResponse> = match serde_json::from_value(value) {
        Ok(envelope) => envelope,
        Err(error) => {
            eprintln!("protocol error: {error}");
            return 2;
        }
    };
    print!("{}", render::render("register", &envelope));
    if let Some(result) = envelope.result.as_ref().filter(|_| envelope.ok) {
        let nick = match Nick::parse(&result.nick) {
            Ok(nick) => nick,
            Err(message) => {
                eprintln!("server returned an invalid nickname: {message}");
                return 2;
            }
        };
        let local = config::LocalConfig {
            server: base.to_string(),
            agent_id: result.agent_id,
            nick,
            token: result.token.clone(),
        };
        match config::save(&local) {
            Ok(path) => println!("identity saved: {}", path.display()),
            Err(message) => {
                eprintln!("{message}");
                return 2;
            }
        }
    }
    code
}

fn print_env<T>(raw: Result<client::RawResponse, String>, label: &str, json: bool) -> u8
where
    T: DeserializeOwned + render::Renderable,
{
    let raw = match raw {
        Ok(raw) => raw,
        Err(message) => {
            eprintln!("network error: {message}");
            return 2;
        }
    };
    let value: Value = match serde_json::from_str(&raw.body) {
        Ok(value) => value,
        Err(_) => {
            eprintln!(
                "unexpected non-JSON response (HTTP {}): {}",
                raw.status,
                raw.body.trim()
            );
            return 2;
        }
    };
    let code = exit_code(&value);
    if json {
        println!("{}", pretty(&value));
        return code;
    }
    match serde_json::from_value::<Envelope<T>>(value) {
        Ok(envelope) => print!("{}", render::render(label, &envelope)),
        Err(error) => {
            eprintln!("protocol error: {error}");
            return 2;
        }
    }
    code
}

fn exit_code(value: &Value) -> u8 {
    if value.get("ok").and_then(Value::as_bool) == Some(true) {
        return 0;
    }
    match value
        .pointer("/error/code")
        .and_then(Value::as_str)
        .unwrap_or("")
    {
        "rule_rejected" => 1,
        _ => 2,
    }
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

fn to_value<T: serde::Serialize>(value: T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits(default_seconds: f64, max_seconds: f64) -> WaitLimits {
        WaitLimits {
            default_seconds,
            max_seconds,
        }
    }

    #[test]
    fn wait_client_timeout_follows_the_server_config() {
        let server = limits(3.0, 7.0);
        assert_eq!(wait_client_timeout(None, server), 23.0);
        assert_eq!(wait_client_timeout(Some(1.0), server), 21.0);
        assert_eq!(
            wait_client_timeout(Some(1000.0), server),
            27.0,
            "the client must clamp to the server's max, not to 55"
        );
    }

    #[test]
    fn wait_client_timeout_uses_the_fallback_only_without_config() {
        let config = ConfigResponse {
            tick_seconds: 4.0,
            wait_default_seconds: 7.0,
            wait_effective_default_seconds: 7.0,
            wait_max_seconds: 9.0,
            snapshot_interval_ticks: 120,
        };
        let from_server = wait_limits_from(Some(config));
        assert_eq!(from_server, limits(7.0, 9.0));
        assert_eq!(wait_client_timeout(None, from_server), 27.0);
        assert_eq!(wait_client_timeout(Some(1000.0), from_server), 29.0);

        let fallback = wait_limits_from(None);
        assert_eq!(fallback, WaitLimits::fallback());
        assert_eq!(wait_client_timeout(None, fallback), 75.0);
    }

    #[test]
    fn wait_client_timeout_keeps_sub_second_requests() {
        assert_eq!(wait_client_timeout(Some(0.05), limits(3.0, 7.0)), 20.05);
    }
}
