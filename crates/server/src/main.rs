use clap::Parser;
use loo_core::{map, Config};
use loo_server::{http, Logs, Server};
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Parser)]
#[command(about = "Company Time dev server (step 0)", version)]
struct Args {
    /// Step 0 only ships the dev server; this flag must be present.
    #[arg(long)]
    dev: bool,
    #[arg(long, default_value = "127.0.0.1:18080")]
    addr: String,
    #[arg(long, default_value = "maps/default.txt")]
    map: PathBuf,
    /// JSON file that overrides any design §9 value for this run.
    #[arg(long)]
    config: Option<PathBuf>,
    /// Overrides `tick_seconds` from the config file.
    #[arg(long)]
    tick_seconds: Option<f64>,
    /// Directory for commands.jsonl and events.jsonl.
    #[arg(long, default_value = ".conductor/dev")]
    data_dir: PathBuf,
    #[arg(long, default_value_t = 42)]
    seed: u64,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    if !args.dev {
        eprintln!("step 0 only runs in dev mode: pass --dev");
        std::process::exit(2);
    }

    let mut cfg = match &args.config {
        Some(path) => Config::from_json(&std::fs::read_to_string(path)?)?,
        None => Config::default(),
    };
    if let Some(tick) = args.tick_seconds {
        cfg.tick_seconds = tick;
    }

    let map_text = std::fs::read_to_string(&args.map)?;
    let def = map::parse(&map_text).map_err(|error| format!("{}: {error}", args.map.display()))?;
    let logs = Logs::open(&args.data_dir)?;
    let server = Arc::new(Server::new(cfg, def, logs, args.seed));
    server.spawn_ticker();

    let listener = tokio::net::TcpListener::bind(&args.addr).await?;
    println!(
        "loo dev server on http://{} tick={}s map={} data={} seed={}",
        args.addr,
        server.config().tick_seconds,
        args.map.display(),
        args.data_dir.display(),
        args.seed
    );
    axum::serve(listener, http::router(server.clone()))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
