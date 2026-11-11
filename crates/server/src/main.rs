use clap::Parser;
use loo_core::{map, Config};
use loo_server::{http, Server};
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
    /// Directory of `world.db`: the world, its event log and commands.
    #[arg(long, default_value = ".conductor/dev")]
    data_dir: PathBuf,
    /// Seed for the first world in an empty data directory.
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
    let map_name = args.map.display().to_string();
    let server = Arc::new(Server::open(
        cfg,
        def,
        &map_name,
        &map_text,
        &args.data_dir,
        args.seed,
    )?);
    let tick = server.world_state().await.tick;
    server.spawn_ticker();

    let listener = tokio::net::TcpListener::bind(&args.addr).await?;
    println!(
        "loo dev server on http://{} tick={}s map={} data={} tick={} seed={}",
        args.addr,
        server.config().tick_seconds,
        map_name,
        args.data_dir.display(),
        tick,
        args.seed
    );
    axum::serve(listener, http::router(server.clone()))
        .with_graceful_shutdown(shutdown())
        .await?;
    server.save_snapshot().await?;
    Ok(())
}

/// Ctrl-C or SIGTERM: either one flushes a snapshot before the process leaves.
async fn shutdown() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("SIGTERM handler installs");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
