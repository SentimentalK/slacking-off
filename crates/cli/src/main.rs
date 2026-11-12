//! `loo` — the only interface an agent has to Company Time (design §10).
//!
//! Exit codes: 0 success, 1 the action was rejected by the rules, 2 network,
//! authentication or usage problem.

mod client;
mod config;
mod render;

use clap::{Parser, Subcommand, ValueEnum};
use loo_proto::{
    AccountRegisterResponse, ActionQueued, AttackRequest, BuildKind, BuildRequest, ConfigResponse,
    DefendRequest, DemolishRequest, Dir, DoorRequest, DowngradeRequest, Envelope, JoinRequest,
    JoinResponse, LeaveResponse, LookResponse, MapResponse, MoveRequest, MoveSpec, Nick,
    RegisterResponse, RulesResponse, SentBy, TargetSpec, UpgradeRequest, WaitRequest, WaitResponse,
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

#[derive(Subcommand, Debug)]
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
    /// Attack the adjacent agent in a direction.
    Attack {
        #[arg(value_enum, ignore_case = true)]
        dir: DirArg,
    },
    /// Defend the adjacent cell in a direction for this tick.
    Defend {
        #[arg(value_enum, ignore_case = true)]
        dir: DirArg,
    },
    /// Queue building a wall, door or toilet.
    Build {
        #[arg(value_enum)]
        kind: BuildKindArg,
        #[arg(value_enum, ignore_case = true)]
        target: TargetArg,
    },
    /// Queue demolishing the object on a cell.
    Demolish {
        #[arg(value_enum, ignore_case = true)]
        target: TargetArg,
    },
    /// Queue opening or closing an adjacent door.
    Door {
        #[arg(value_enum)]
        action: DoorActionArg,
        #[arg(value_enum, ignore_case = true)]
        dir: DirArg,
    },
    /// Queue upgrading a toilet one level.
    Upgrade {
        #[arg(value_enum, ignore_case = true)]
        target: TargetArg,
    },
    /// Queue downgrading a toilet one level.
    Downgrade {
        #[arg(value_enum, ignore_case = true)]
        target: TargetArg,
    },
    /// Start using the toilet under your feet.
    Use,
    /// Cancel the running action.
    Cancel,
    /// Leave the world, keeping the session score.
    Leave,
    /// Block until something happens, or until the timeout.
    Wait {
        #[arg(long)]
        timeout: Option<f64>,
    },
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, ValueEnum)]
enum BuildKindArg {
    Wall,
    Door,
    Toilet,
}

impl From<BuildKindArg> for BuildKind {
    fn from(value: BuildKindArg) -> Self {
        match value {
            BuildKindArg::Wall => BuildKind::Wall,
            BuildKindArg::Door => BuildKind::Door,
            BuildKindArg::Toilet => BuildKind::Toilet,
        }
    }
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, ValueEnum)]
enum TargetArg {
    Here,
    N,
    E,
    S,
    W,
}

impl From<TargetArg> for TargetSpec {
    fn from(value: TargetArg) -> Self {
        match value {
            TargetArg::Here => TargetSpec::Here,
            TargetArg::N => TargetSpec::Dir(Dir::N),
            TargetArg::E => TargetSpec::Dir(Dir::E),
            TargetArg::S => TargetSpec::Dir(Dir::S),
            TargetArg::W => TargetSpec::Dir(Dir::W),
        }
    }
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, ValueEnum)]
enum DirArg {
    N,
    E,
    S,
    W,
}

impl From<DirArg> for Dir {
    fn from(value: DirArg) -> Self {
        match value {
            DirArg::N => Dir::N,
            DirArg::E => Dir::E,
            DirArg::S => Dir::S,
            DirArg::W => Dir::W,
        }
    }
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, ValueEnum)]
enum DoorActionArg {
    Open,
    Close,
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
    let agent = saved.as_ref().and_then(|cfg| cfg.agent_id);
    let http = client::Client::new(base.clone(), token.clone(), agent);
    let json = cli.json;

    // Contract §1: an official config holds a token but no agent yet, so only
    // registration and the rules are available.
    let needs_agent = saved
        .as_ref()
        .is_some_and(|cfg| cfg.agent_id.is_none() && !cfg.token.is_empty());

    if !matches!(cli.command, Command::Register { .. } | Command::Rules) && saved.is_none() {
        eprintln!(
            "not registered in {} · run `loo register` first",
            config::home().display()
        );
        return 2;
    }
    if needs_agent && !matches!(cli.command, Command::Register { .. } | Command::Rules) {
        eprintln!(
            "this account has no agent yet · run `loo register --name ... --model ... --intro ...`"
        );
        return 2;
    }

    match cli.command {
        Command::Register { name, model, intro } => match token {
            // Contract §1: a saved token means an official account.
            Some(token) => register_account(&http, &base, token, name, model, intro, json),
            None => register_dev(&http, &base, name, model, intro, json),
        },
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
        Command::Attack { dir } => {
            let request = AttackRequest { dir: dir.into() };
            let raw = http.post("/api/attack", to_value(request), SHORT_TIMEOUT);
            print_env::<ActionQueued>(raw, "attack", json)
        }
        Command::Defend { dir } => {
            let request = DefendRequest { dir: dir.into() };
            let raw = http.post("/api/defend", to_value(request), SHORT_TIMEOUT);
            print_env::<ActionQueued>(raw, "defend", json)
        }
        Command::Build { kind, target } => {
            let request = BuildRequest {
                kind: kind.into(),
                target: target.into(),
            };
            let raw = http.post("/api/build", to_value(request), SHORT_TIMEOUT);
            print_env::<ActionQueued>(raw, "build", json)
        }
        Command::Demolish { target } => {
            let request = DemolishRequest {
                target: target.into(),
            };
            let raw = http.post("/api/demolish", to_value(request), SHORT_TIMEOUT);
            print_env::<ActionQueued>(raw, "demolish", json)
        }
        Command::Door { action, dir } => {
            let request = DoorRequest {
                target: dir.into(),
                open: matches!(action, DoorActionArg::Open),
            };
            let raw = http.post("/api/door", to_value(request), SHORT_TIMEOUT);
            print_env::<ActionQueued>(raw, "door", json)
        }
        Command::Upgrade { target } => {
            let request = UpgradeRequest {
                target: target.into(),
            };
            let raw = http.post("/api/upgrade", to_value(request), SHORT_TIMEOUT);
            print_env::<ActionQueued>(raw, "upgrade", json)
        }
        Command::Downgrade { target } => {
            let request = DowngradeRequest {
                target: target.into(),
            };
            let raw = http.post("/api/downgrade", to_value(request), SHORT_TIMEOUT);
            print_env::<ActionQueued>(raw, "downgrade", json)
        }
        Command::Use => print_env::<ActionQueued>(
            http.post("/api/use", Value::Null, SHORT_TIMEOUT),
            "use",
            json,
        ),
        Command::Cancel => print_env::<ActionQueued>(
            http.post("/api/cancel", Value::Null, SHORT_TIMEOUT),
            "cancel",
            json,
        ),
        Command::Leave => print_env::<LeaveResponse>(
            http.post("/api/leave", Value::Null, SHORT_TIMEOUT),
            "leave",
            json,
        ),
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

fn register_dev(
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
    // The identity must be saved in both output modes; `--json` only changes
    // what is printed.
    let pretty_json = json.then(|| pretty(&value));
    let envelope: Envelope<RegisterResponse> = match serde_json::from_value(value) {
        Ok(envelope) => envelope,
        Err(error) => {
            eprintln!("protocol error: {error}");
            return 2;
        }
    };
    if let Some(text) = pretty_json {
        println!("{text}");
    } else {
        print!("{}", render::render("register", &envelope));
    }
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
            agent_id: Some(result.agent_id),
            nick: Some(nick),
            token: result.token.clone(),
        };
        match config::save(&local) {
            Ok(path) => {
                // `--json` stdout must stay a single JSON document.
                if json {
                    eprintln!("identity saved: {}", path.display());
                } else {
                    println!("identity saved: {}", path.display());
                }
            }
            Err(message) => {
                eprintln!("{message}");
                return 2;
            }
        }
    }
    code
}

/// Official registration (contract §1): all three fields are required and the
/// returned identity is merged into the config, keeping server and token.
fn register_account(
    http: &client::Client,
    base: &str,
    token: String,
    name: Option<String>,
    model: Option<String>,
    intro: Option<String>,
    json: bool,
) -> u8 {
    let (Some(name), Some(model), Some(intro)) = (name, model, intro) else {
        eprintln!("official registration needs --name, --model and --intro");
        return 2;
    };
    if name.trim().is_empty() || model.trim().is_empty() || intro.trim().is_empty() {
        eprintln!("--name, --model and --intro must not be empty");
        return 2;
    }
    let nick = match Nick::parse(&name) {
        Ok(nick) => nick,
        Err(message) => {
            eprintln!("{message}");
            return 2;
        }
    };

    let body = json!({ "name": nick, "model": model, "intro": intro });
    let raw = match http.post("/api/register", body, SHORT_TIMEOUT) {
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
    let pretty_json = json.then(|| pretty(&value));
    let envelope: Envelope<AccountRegisterResponse> = match serde_json::from_value(value) {
        Ok(envelope) => envelope,
        Err(error) => {
            eprintln!("protocol error: {error}");
            return 2;
        }
    };
    if let Some(text) = pretty_json {
        println!("{text}");
    }
    if code != 0 {
        if let Some(error) = &envelope.error {
            eprintln!("{}", error.message);
        }
        return code;
    }
    let Some(result) = envelope.result else {
        eprintln!("protocol error: the server returned no agent");
        return 2;
    };
    let nick = match Nick::parse(&result.nick) {
        Ok(nick) => nick,
        Err(message) => {
            eprintln!("server returned an invalid nickname: {message}");
            return 2;
        }
    };
    let local = config::LocalConfig {
        server: base.to_string(),
        token,
        agent_id: Some(result.agent_id),
        nick: Some(nick),
    };
    let path = match config::save(&local) {
        Ok(path) => path,
        Err(message) => {
            eprintln!("{message}");
            return 2;
        }
    };
    if json {
        eprintln!("identity saved: {}", path.display());
    } else {
        println!(
            "{} {} as agent {}",
            if result.attached {
                "attached"
            } else {
                "created"
            },
            result.nick,
            result.agent_id
        );
        println!("identity saved: {}", path.display());
    }
    0
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
    if code == 2 {
        if let Some(message) = value.pointer("/error/message").and_then(Value::as_str) {
            eprintln!("{message}");
        }
    }
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
        "rule_rejected" | "rate_limited" => 1,
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

    fn command(args: &[&str]) -> Command {
        Cli::try_parse_from(args)
            .unwrap_or_else(|error| panic!("{args:?} should parse: {error}"))
            .command
    }

    #[test]
    fn object_commands_parse_their_arguments() {
        match command(&["loo", "build", "wall", "here"]) {
            Command::Build { kind, target } => {
                assert_eq!(kind, BuildKindArg::Wall);
                assert_eq!(target, TargetArg::Here);
            }
            other => panic!("expected build, got {other:?}"),
        }
        match command(&["loo", "build", "toilet", "n"]) {
            Command::Build { kind, target } => {
                assert_eq!(kind, BuildKindArg::Toilet);
                assert_eq!(TargetSpec::from(target), TargetSpec::Dir(Dir::N));
            }
            other => panic!("expected build, got {other:?}"),
        }
        match command(&["loo", "demolish", "w"]) {
            Command::Demolish { target } => {
                assert_eq!(TargetSpec::from(target), TargetSpec::Dir(Dir::W));
            }
            other => panic!("expected demolish, got {other:?}"),
        }
        match command(&["loo", "door", "close", "e"]) {
            Command::Door { action, dir } => {
                assert_eq!(action, DoorActionArg::Close);
                assert_eq!(Dir::from(dir), Dir::E);
            }
            other => panic!("expected door, got {other:?}"),
        }
        match command(&["loo", "door", "open", "S"]) {
            Command::Door { action, dir } => {
                assert_eq!(action, DoorActionArg::Open);
                assert_eq!(Dir::from(dir), Dir::S);
            }
            other => panic!("expected door, got {other:?}"),
        }
        match command(&["loo", "build", "wall", "N"]) {
            Command::Build { kind, target } => {
                assert_eq!(kind, BuildKindArg::Wall);
                assert_eq!(TargetSpec::from(target), TargetSpec::Dir(Dir::N));
            }
            other => panic!("expected build, got {other:?}"),
        }
        assert!(matches!(command(&["loo", "use"]), Command::Use));
        assert!(matches!(command(&["loo", "cancel"]), Command::Cancel));
        assert!(matches!(command(&["loo", "leave"]), Command::Leave));
    }

    #[test]
    fn combat_and_upgrade_commands_parse_their_arguments() {
        match command(&["loo", "attack", "n"]) {
            Command::Attack { dir } => assert_eq!(Dir::from(dir), Dir::N),
            other => panic!("expected attack, got {other:?}"),
        }
        match command(&["loo", "defend", "W"]) {
            Command::Defend { dir } => assert_eq!(Dir::from(dir), Dir::W),
            other => panic!("expected defend, got {other:?}"),
        }
        match command(&["loo", "upgrade", "here"]) {
            Command::Upgrade { target } => assert_eq!(target, TargetArg::Here),
            other => panic!("expected upgrade, got {other:?}"),
        }
        match command(&["loo", "upgrade", "s"]) {
            Command::Upgrade { target } => {
                assert_eq!(TargetSpec::from(target), TargetSpec::Dir(Dir::S));
            }
            other => panic!("expected upgrade, got {other:?}"),
        }
        match command(&["loo", "downgrade", "e"]) {
            Command::Downgrade { target } => {
                assert_eq!(TargetSpec::from(target), TargetSpec::Dir(Dir::E));
            }
            other => panic!("expected downgrade, got {other:?}"),
        }
    }

    #[test]
    fn invalid_object_command_arguments_exit_two() {
        assert!(Cli::try_parse_from(["loo", "build", "ladder", "here"]).is_err());
        assert!(Cli::try_parse_from(["loo", "build", "wall"]).is_err());
        assert!(Cli::try_parse_from(["loo", "door", "open"]).is_err());
        assert!(Cli::try_parse_from(["loo", "door", "slam", "n"]).is_err());
        assert!(Cli::try_parse_from(["loo", "demolish", "up"]).is_err());
        assert!(Cli::try_parse_from(["loo", "attack", "here"]).is_err());
        assert!(Cli::try_parse_from(["loo", "defend"]).is_err());
        assert!(Cli::try_parse_from(["loo", "upgrade"]).is_err());
        assert!(Cli::try_parse_from(["loo", "downgrade", "up"]).is_err());
    }
}
