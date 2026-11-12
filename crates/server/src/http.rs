//! HTTP layer. Handlers are thin: they authenticate, call `Server`, and map the
//! envelope to a status code.
//!
//! Dev mode keeps the token-only rules from earlier steps. Official mode adds
//! accounts, cookie sessions and CSRF (contract §1).

use crate::auth::{new_token, sha256_hex};
use crate::{error_envelope, Server};
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::response::sse::{Event as SseEvent, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::stream::unfold;
use include_dir::{include_dir, Dir};
use loo_proto::{
    ActionQueued, ApiError, AttackRequest, AuthLoginRequest, AuthMeResponse, AuthRegisterRequest,
    BuildRequest, ConfigResponse, DefendRequest, DemolishRequest, DoorRequest, DowngradeRequest,
    Envelope, ErrorCode, JoinRequest, JoinResponse, LeaveResponse, MoveRequest, Projection,
    RegisterRequest, Tick, UpgradeRequest, WaitRequest,
};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::convert::Infallible;
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;

/// Cookie lifetime for both the session and its CSRF mirror (30 days).
const SESSION_MAX_AGE: u64 = 2_592_000;
const SESSION_COOKIE: &str = "loo_session";
const CSRF_COOKIE: &str = "loo_csrf";

/// The SPA is compiled into the server; the binary never reads `web/dist` at
/// runtime. `build.rs` guarantees the directory exists before this expands.
static WEB_DIST: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/../../web/dist");

/// `build.rs` changes this whenever any `web/dist` file changes; referencing it
/// makes Cargo recompile the crate so `include_dir!` picks up the new files.
const _: &str = env!("LOO_WEB_DIST_STAMP");

/// Runtime options the HTTP layer needs; `downloads_dir` backs `/downloads/*`.
#[derive(Clone, Debug)]
pub struct HttpOptions {
    pub downloads_dir: PathBuf,
}

impl Default for HttpOptions {
    fn default() -> Self {
        Self {
            downloads_dir: PathBuf::from("target/release"),
        }
    }
}

struct AppState {
    server: Arc<Server>,
    options: HttpOptions,
}

/// Keeps the old signature: downloads come from `target/release`.
pub fn router(server: Arc<Server>) -> Router {
    router_with(server, HttpOptions::default())
}

pub fn router_with(server: Arc<Server>, options: HttpOptions) -> Router {
    let state = Arc::new(AppState { server, options });
    Router::new()
        .route("/healthz", get(healthz))
        .route("/api/dev/register", post(dev_register))
        .route("/api/register", post(register))
        .route("/api/auth/register", post(auth_register))
        .route("/api/auth/login", post(auth_login))
        .route("/api/auth/logout", post(auth_logout))
        .route("/api/auth/me", get(auth_me))
        .route("/api/account", get(account))
        .route("/api/account/token", post(account_token))
        .route("/api/account/token/revoke", post(account_token_revoke))
        .route("/install.sh", get(install_sh))
        .route("/install.ps1", get(install_ps1))
        .route("/downloads/{name}", get(download))
        .route("/api/join", post(join))
        .route("/api/look", get(look))
        .route("/api/map", get(map_view))
        .route("/api/status", get(status))
        .route("/api/config", get(config))
        .route("/api/rules", get(rules))
        .route("/api/terrain", get(terrain))
        .route("/api/worlds", get(worlds))
        .route("/api/leaderboard", get(leaderboard))
        .route("/api/stats", get(stats))
        .route("/api/agents/{id}", get(agent_profile))
        .route("/api/timeline", get(timeline))
        .route("/api/projection", get(projection))
        .route("/api/metrics", get(metrics))
        .route("/api/watch", get(watch))
        .route("/api/move", post(move_cmd))
        .route("/api/build", post(build_cmd))
        .route("/api/demolish", post(demolish_cmd))
        .route("/api/door", post(door_cmd))
        .route("/api/attack", post(attack_cmd))
        .route("/api/defend", post(defend_cmd))
        .route("/api/upgrade", post(upgrade_cmd))
        .route("/api/downgrade", post(downgrade_cmd))
        .route("/api/use", post(use_cmd))
        .route("/api/cancel", post(cancel_cmd))
        .route("/api/leave", post(leave_cmd))
        .route("/api/wait", post(wait))
        .fallback(static_site)
        .with_state(state)
}

async fn healthz() -> impl IntoResponse {
    Json(serde_json::json!({ "ok": true }))
}

// --- embedded web app ------------------------------------------------------

/// `/api/*` and the installer/download prefixes stay API-shaped even when no
/// route matched: JSON 404, never the SPA. Everything else falls back to
/// `index.html` so a deep link such as `/agent/7` survives a reload.
async fn static_site(uri: Uri, method: Method) -> Response {
    let path = uri.path();
    let api_like = path == "/api"
        || path.starts_with("/api/")
        || path.starts_with("/install")
        || path == "/downloads"
        || path.starts_with("/downloads/");
    if api_like || (method != Method::GET && method != Method::HEAD) {
        return respond_status(
            StatusCode::NOT_FOUND,
            error_envelope::<()>(ErrorCode::BadRequest, "no such route"),
        );
    }

    let relative = path.trim_start_matches('/');
    if !relative.is_empty() {
        if let Some(file) = WEB_DIST.get_file(relative) {
            return serve_embedded(file);
        }
    }
    match WEB_DIST.get_file("index.html") {
        Some(file) => serve_embedded(file),
        None => respond_status(
            StatusCode::INTERNAL_SERVER_ERROR,
            error_envelope::<()>(ErrorCode::Internal, "the embedded web app is missing"),
        ),
    }
}

fn serve_embedded(file: &'static include_dir::File<'static>) -> Response {
    // Vite hashes every asset filename, so those never change under the same
    // URL; index.html must be revalidated to pick up the next build.
    let immutable = file.path().to_string_lossy().starts_with("assets/");
    let cache = if immutable {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let mut response = Response::new(Body::from(file.contents()));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(content_type(file.path())),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    response
}

fn content_type(path: &FsPath) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("json") => "application/json",
        _ => "application/octet-stream",
    }
}

// --- dev registration -------------------------------------------------------

async fn dev_register(
    State(app): State<Arc<AppState>>,
    body: Option<Json<RegisterRequest>>,
) -> Response {
    if app.server.official() {
        return not_found();
    }
    let req = body.map(|Json(req)| req).unwrap_or(RegisterRequest {
        name: None,
        model: None,
        intro: None,
    });
    respond(app.server.dev_register(req).await)
}

// --- accounts ---------------------------------------------------------------

async fn register(
    State(app): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Option<Json<RegisterRequest>>,
) -> Response {
    if !app.server.official() {
        return not_found();
    }
    let Some(token) = bearer(&headers) else {
        return unauthorized("account token is required");
    };
    let req = body.map(|Json(req)| req).unwrap_or(RegisterRequest {
        name: None,
        model: None,
        intro: None,
    });
    let env = app.server.register_official_agent(&token, req).await;
    if env.ok {
        respond(env)
    } else {
        // 401 keeps its own status; every refusal here (nickname taken, limit,
        // invalid field) is a 409 conflict for the caller.
        match env.error.as_ref().map(|error| error.code) {
            Some(ErrorCode::NotAuthenticated) => respond_status(StatusCode::UNAUTHORIZED, env),
            Some(ErrorCode::Internal) => respond_status(StatusCode::INTERNAL_SERVER_ERROR, env),
            _ => respond_status(StatusCode::CONFLICT, env),
        }
    }
}

async fn auth_register(
    State(app): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Option<Json<AuthRegisterRequest>>,
) -> Response {
    if !app.server.official() {
        return not_found();
    }
    let Some(Json(body)) = body else {
        return respond::<AuthMeResponse>(bad_request("body must be {username, password}"));
    };
    // Validate before touching the store: a malformed field is the caller's
    // 400, while a rejected insert after this point is a taken username (409).
    for check in [
        crate::auth::validate_username(&body.username),
        crate::auth::validate_password(&body.password),
    ] {
        if let Err(message) = check {
            return respond_status(
                StatusCode::BAD_REQUEST,
                error_envelope::<AuthMeResponse>(ErrorCode::BadRequest, message),
            );
        }
    }
    let env = app
        .server
        .register_account(&body.username, &body.password)
        .await;
    if !env.ok {
        let status = match env.error.as_ref().map(|error| error.code) {
            Some(ErrorCode::Internal) => StatusCode::INTERNAL_SERVER_ERROR,
            // The fields already passed validation, so this is the unique
            // username index refusing a duplicate.
            _ => StatusCode::CONFLICT,
        };
        return respond_status(status, env);
    }
    let cookies = match begin_session(&app, &body.username, forwarded_https(&headers)) {
        Ok(cookies) => cookies,
        Err(response) => return *response,
    };
    with_cookies(respond(env), &cookies)
}

async fn auth_login(
    State(app): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Option<Json<AuthLoginRequest>>,
) -> Response {
    if !app.server.official() {
        return not_found();
    }
    let Some(Json(body)) = body else {
        return respond::<AuthMeResponse>(bad_request("body must be {username, password}"));
    };
    let env = app
        .server
        .login_account(&body.username, &body.password)
        .await;
    if !env.ok {
        return respond(env);
    }
    let cookies = match begin_session(&app, &body.username, forwarded_https(&headers)) {
        Ok(cookies) => cookies,
        Err(response) => return *response,
    };
    with_cookies(respond(env), &cookies)
}

async fn auth_logout(State(app): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if !app.server.official() {
        return not_found();
    }
    if let Err(response) = session_user(&app, &headers) {
        return *response;
    }
    if !csrf_ok(&headers) {
        return forbidden("X-Loo-CSRF must match the loo_csrf cookie");
    }
    let session = cookie(&headers, SESSION_COOKIE).unwrap_or_default();
    if let Err(error) = app.server.store().web_session_delete(&sha256_hex(&session)) {
        return internal(format!("deleting the session failed: {error}"));
    }
    with_cookies(
        respond(Envelope::ok(serde_json::json!({}), Vec::new(), None)),
        &clear_cookies(forwarded_https(&headers)),
    )
}

async fn auth_me(State(app): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if !app.server.official() {
        return not_found();
    }
    let user_id = match session_user(&app, &headers) {
        Ok(user_id) => user_id,
        Err(response) => return *response,
    };
    match app.server.store().username_of(user_id) {
        Ok(Some(username)) => respond(Envelope::ok(AuthMeResponse { username }, Vec::new(), None)),
        Ok(None) => unauthorized("the account no longer exists"),
        Err(error) => internal(format!("reading the account failed: {error}")),
    }
}

async fn account(State(app): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if !app.server.official() {
        return not_found();
    }
    let user_id = match session_user(&app, &headers) {
        Ok(user_id) => user_id,
        Err(response) => return *response,
    };
    respond(app.server.account_for_user(user_id))
}

async fn account_token(State(app): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if !app.server.official() {
        return not_found();
    }
    let user_id = match session_user(&app, &headers) {
        Ok(user_id) => user_id,
        Err(response) => return *response,
    };
    if !csrf_ok(&headers) {
        return forbidden("X-Loo-CSRF must match the loo_csrf cookie");
    }
    let base = match request_base(&headers) {
        Ok(base) => base,
        Err(response) => return *response,
    };
    respond(app.server.create_account_token(user_id, &base))
}

async fn account_token_revoke(State(app): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if !app.server.official() {
        return not_found();
    }
    let user_id = match session_user(&app, &headers) {
        Ok(user_id) => user_id,
        Err(response) => return *response,
    };
    if !csrf_ok(&headers) {
        return forbidden("X-Loo-CSRF must match the loo_csrf cookie");
    }
    match app.server.revoke_account_tokens(user_id) {
        Ok(()) => respond(Envelope::ok(serde_json::json!({}), Vec::new(), None)),
        Err(error) => internal(format!("revoking the token failed: {error}")),
    }
}

// --- installers and downloads ----------------------------------------------

async fn install_sh() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/x-shellscript; charset=utf-8")],
        include_str!("../static/install.sh"),
    )
}

async fn install_ps1() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        include_str!("../static/install.ps1"),
    )
}

/// Contract §1: six download names, each backed by a file of the same name.
/// A missing file is a 404 with `暂无构建`; there is no fallback to another
/// platform's binary.
fn platform_file(name: &str) -> Option<&str> {
    match name {
        "loo-linux-x64"
        | "loo-linux-arm64"
        | "loo-macos-x64"
        | "loo-macos-arm64"
        | "loo-windows-x64.exe"
        | "loo-windows-arm64.exe" => Some(name),
        _ => None,
    }
}

async fn download(State(app): State<Arc<AppState>>, Path(name): Path<String>) -> Response {
    let Some(file) = platform_file(&name) else {
        return no_build();
    };
    let path = app.options.downloads_dir.join(file);
    match tokio::task::spawn_blocking(move || std::fs::read(path)).await {
        Ok(Ok(bytes)) => {
            ([(header::CONTENT_TYPE, "application/octet-stream")], bytes).into_response()
        }
        _ => no_build(),
    }
}

fn no_build() -> Response {
    (
        StatusCode::NOT_FOUND,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        "暂无构建",
    )
        .into_response()
}

// --- world commands ---------------------------------------------------------

async fn join(
    State(app): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Option<Json<JoinRequest>>,
) -> Response {
    let Some(Json(req)) = body else {
        return respond::<JoinResponse>(bad_request("body must be {sent_by, why}"));
    };
    respond(app.server.join(&caller(&app.server, &headers), req).await)
}

async fn look(State(app): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    respond(app.server.look(&caller(&app.server, &headers)).await)
}

async fn map_view(State(app): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    respond(app.server.map_view(&caller(&app.server, &headers)).await)
}

async fn status(State(app): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    respond(app.server.status(&caller(&app.server, &headers)).await)
}

async fn config(State(app): State<Arc<AppState>>) -> Response {
    respond::<ConfigResponse>(app.server.config_response().await)
}

async fn rules(State(app): State<Arc<AppState>>) -> Response {
    respond(app.server.rules().await)
}

// --- public projection, terrain and SSE (contract §2) -----------------------

#[derive(Deserialize)]
struct ProjectionQuery {
    tick: Option<Tick>,
}

async fn terrain(State(app): State<Arc<AppState>>) -> Response {
    Json(app.server.terrain().await).into_response()
}

async fn worlds(State(app): State<Arc<AppState>>) -> Response {
    respond(Envelope::ok(app.server.worlds().await, Vec::new(), None))
}

#[derive(Deserialize)]
struct LeaderboardQuery {
    metric: Option<String>,
    model: Option<String>,
    limit: Option<usize>,
}

async fn leaderboard(
    State(app): State<Arc<AppState>>,
    Query(query): Query<LeaderboardQuery>,
) -> Response {
    let metric = query.metric.as_deref().unwrap_or("score");
    let limit = query.limit.unwrap_or(50);
    respond(
        app.server
            .leaderboard(metric, query.model.as_deref(), limit)
            .await,
    )
}

async fn stats(State(app): State<Arc<AppState>>) -> Response {
    respond(app.server.stats().await)
}

async fn agent_profile(State(app): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let Ok(agent_id) = id.trim().parse::<u64>() else {
        return respond_status(
            StatusCode::NOT_FOUND,
            error_envelope::<loo_proto::ProfileResponse>(
                ErrorCode::BadRequest,
                format!("unknown agent {id}"),
            ),
        );
    };
    let env = app.server.profile(agent_id).await;
    let unknown = env
        .error
        .as_ref()
        .is_some_and(|error| error.code == ErrorCode::BadRequest);
    if unknown {
        return respond_status(StatusCode::NOT_FOUND, env);
    }
    respond(env)
}

#[derive(Deserialize)]
struct TimelineQuery {
    from: Option<String>,
    to: Option<String>,
}

/// `?from=&to=` with empty values falls back to the whole log.
fn query_tick(raw: Option<&str>, default: Tick) -> Option<Tick> {
    match raw.map(str::trim) {
        None | Some("") => Some(default),
        Some(text) => text.parse::<Tick>().ok(),
    }
}

async fn timeline(
    State(app): State<Arc<AppState>>,
    Query(query): Query<TimelineQuery>,
) -> Response {
    let (Some(from), Some(to)) = (
        query_tick(query.from.as_deref(), 0),
        query_tick(query.to.as_deref(), Tick::MAX),
    ) else {
        return respond_status(
            StatusCode::BAD_REQUEST,
            error_envelope::<loo_proto::Timeline>(
                ErrorCode::BadRequest,
                "from and to must be unsigned tick numbers",
            ),
        );
    };
    respond(app.server.timeline(from, to).await)
}

async fn metrics(State(app): State<Arc<AppState>>) -> Response {
    respond(Envelope::ok(app.server.metrics().await, Vec::new(), None))
}

async fn projection(
    State(app): State<Arc<AppState>>,
    Query(query): Query<ProjectionQuery>,
) -> Response {
    match query.tick {
        None => respond(Envelope::ok(
            app.server.current_projection().await,
            Vec::new(),
            None,
        )),
        Some(tick) => match app.server.projection_at(tick).await {
            Ok(projection) => respond(Envelope::ok(projection, Vec::new(), None)),
            Err(message) => respond(Envelope::<Projection>::failed(
                ApiError::new(ErrorCode::BadRequest, message),
                Vec::new(),
                None,
            )),
        },
    }
}

/// Replay cap for `Last-Event-ID`; a bigger gap sends only the current tick.
const MAX_REPLAY_TICKS: Tick = 30;
const PING_INTERVAL: Duration = Duration::from_secs(15);

struct WatchState {
    server: Arc<Server>,
    /// Released when the stream (and this state) is dropped.
    _slot: crate::WatchSlot,
    receiver: broadcast::Receiver<Arc<Projection>>,
    /// Frames still to send before live updates start.
    pending: VecDeque<SseEvent>,
    /// Last tick written to this connection, so replay and live never repeat.
    last_sent: Option<Tick>,
    interval: tokio::time::Interval,
}

async fn watch(State(app): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let slot = match app.server.watch_slot() {
        Ok(slot) => slot,
        Err(error) => {
            return respond(error_envelope::<()>(error.code, error.message));
        }
    };
    let server = app.server.clone();
    let live = server.current_projection().await;
    let current_tick = live.tick;
    let last_event_id = headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<Tick>().ok());

    // Subscribe before replaying so no settled tick slips between the replay
    // and the live loop; `last_sent` removes any overlap.
    let receiver = server.watch_receiver();

    let mut pending = VecDeque::new();
    pending.push_back(SseEvent::default().retry(Duration::from_secs(3)));
    pending.push_back(
        SseEvent::default().event("hello").data(
            serde_json::json!({
                "world": live.world,
                "tick": live.tick,
                "tick_seconds": live.tick_seconds,
            })
            .to_string(),
        ),
    );

    let mut last_sent = None;
    match last_event_id {
        Some(last) if last < current_tick => {
            if current_tick - last > MAX_REPLAY_TICKS {
                pending.push_back(tick_frame(&live));
                last_sent = Some(current_tick);
            } else {
                for tick in last + 1..=current_tick {
                    match server.projection_at(tick).await {
                        Ok(projection) => {
                            pending.push_back(tick_frame(&projection));
                            last_sent = Some(tick);
                        }
                        Err(message) => {
                            eprintln!("replay for tick {tick} failed: {message}");
                            break;
                        }
                    }
                }
            }
        }
        // The client already has this tick; wait for the next settlement.
        Some(_) => {
            last_sent = Some(current_tick);
        }
        None => {
            pending.push_back(tick_frame(&live));
            last_sent = Some(current_tick);
        }
    }

    let state = WatchState {
        server,
        _slot: slot,
        receiver,
        pending,
        last_sent,
        interval: tokio::time::interval_at(
            tokio::time::Instant::now() + PING_INTERVAL,
            PING_INTERVAL,
        ),
    };

    let stream = unfold(state, |mut state| async move {
        loop {
            if let Some(frame) = state.pending.pop_front() {
                return Some((Ok::<_, Infallible>(frame), state));
            }
            tokio::select! {
                _ = state.interval.tick() => {
                    return Some((
                        Ok(SseEvent::default().comment("ping")),
                        state,
                    ));
                }
                received = state.receiver.recv() => {
                    match received {
                        Ok(projection) => {
                            if state.last_sent == Some(projection.tick) {
                                continue;
                            }
                            state.last_sent = Some(projection.tick);
                            return Some((Ok(tick_frame(&projection)), state));
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            // Too far behind: jump to the live tick.
                            let projection = state.server.current_projection().await;
                            if state.last_sent == Some(projection.tick) {
                                continue;
                            }
                            state.last_sent = Some(projection.tick);
                            return Some((Ok(tick_frame(&projection)), state));
                        }
                        Err(broadcast::error::RecvError::Closed) => return None,
                    }
                }
            }
        }
    });

    let mut response = Sse::new(stream).into_response();
    response
        .headers_mut()
        .insert("x-accel-buffering", HeaderValue::from_static("no"));
    response
        .headers_mut()
        .insert(header::CONNECTION, HeaderValue::from_static("keep-alive"));
    response
}

fn tick_frame(projection: &Projection) -> SseEvent {
    SseEvent::default()
        .id(projection.tick.to_string())
        .event("tick")
        .data(serde_json::to_string(projection).expect("the projection always serialises"))
}

async fn move_cmd(
    State(app): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Option<Json<MoveRequest>>,
) -> Response {
    let Some(Json(req)) = body else {
        return respond::<ActionQueued>(bad_request("body must be {spec}"));
    };
    respond(
        app.server
            .move_cmd(&caller(&app.server, &headers), req)
            .await,
    )
}

async fn wait(
    State(app): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Option<Json<WaitRequest>>,
) -> Response {
    let req = body.map(|Json(req)| req).unwrap_or(WaitRequest {
        timeout_seconds: None,
    });
    respond(app.server.wait(&caller(&app.server, &headers), req).await)
}

async fn build_cmd(
    State(app): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Option<Json<BuildRequest>>,
) -> Response {
    let Some(Json(req)) = body else {
        return respond::<ActionQueued>(bad_request("body must be {kind, target}"));
    };
    respond(
        app.server
            .build_cmd(&caller(&app.server, &headers), req)
            .await,
    )
}

async fn demolish_cmd(
    State(app): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Option<Json<DemolishRequest>>,
) -> Response {
    let Some(Json(req)) = body else {
        return respond::<ActionQueued>(bad_request("body must be {target}"));
    };
    respond(
        app.server
            .demolish_cmd(&caller(&app.server, &headers), req)
            .await,
    )
}

async fn door_cmd(
    State(app): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Option<Json<DoorRequest>>,
) -> Response {
    let Some(Json(req)) = body else {
        return respond::<ActionQueued>(bad_request("body must be {target, open}"));
    };
    respond(
        app.server
            .door_cmd(&caller(&app.server, &headers), req)
            .await,
    )
}

async fn attack_cmd(
    State(app): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Option<Json<AttackRequest>>,
) -> Response {
    let Some(Json(req)) = body else {
        return respond::<ActionQueued>(bad_request("body must be {dir}"));
    };
    respond(
        app.server
            .attack_cmd(&caller(&app.server, &headers), req)
            .await,
    )
}

async fn defend_cmd(
    State(app): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Option<Json<DefendRequest>>,
) -> Response {
    let Some(Json(req)) = body else {
        return respond::<ActionQueued>(bad_request("body must be {dir}"));
    };
    respond(
        app.server
            .defend_cmd(&caller(&app.server, &headers), req)
            .await,
    )
}

async fn upgrade_cmd(
    State(app): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Option<Json<UpgradeRequest>>,
) -> Response {
    let Some(Json(req)) = body else {
        return respond::<ActionQueued>(bad_request("body must be {target}"));
    };
    respond(
        app.server
            .upgrade_cmd(&caller(&app.server, &headers), req)
            .await,
    )
}

async fn downgrade_cmd(
    State(app): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Option<Json<DowngradeRequest>>,
) -> Response {
    let Some(Json(req)) = body else {
        return respond::<ActionQueued>(bad_request("body must be {target}"));
    };
    respond(
        app.server
            .downgrade_cmd(&caller(&app.server, &headers), req)
            .await,
    )
}

async fn use_cmd(State(app): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    respond(app.server.use_cmd(&caller(&app.server, &headers)).await)
}

async fn cancel_cmd(State(app): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    respond(app.server.cancel_cmd(&caller(&app.server, &headers)).await)
}

async fn leave_cmd(State(app): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    respond::<LeaveResponse>(app.server.leave_cmd(&caller(&app.server, &headers)).await)
}

// --- helpers ----------------------------------------------------------------

fn bearer(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::to_string)
}

/// Contract §1: official commands carry the agent in `X-Loo-Agent`, so the
/// `Server` can check ownership of the token's account.
fn caller(server: &Server, headers: &HeaderMap) -> String {
    let token = bearer(headers).unwrap_or_default();
    if !server.official() {
        return token;
    }
    let agent = headers
        .get("x-loo-agent")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    format!("{token}:{agent}")
}

fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|values| values.split(';'))
        .find_map(|pair| {
            let (key, value) = pair.trim().split_once('=')?;
            (key == name).then(|| value.trim().to_string())
        })
}

fn csrf_ok(headers: &HeaderMap) -> bool {
    match (
        cookie(headers, CSRF_COOKIE),
        headers
            .get("x-loo-csrf")
            .and_then(|value| value.to_str().ok()),
    ) {
        (Some(cookie), Some(header)) => cookie == header,
        _ => false,
    }
}

fn session_user(app: &AppState, headers: &HeaderMap) -> Result<u64, Box<Response>> {
    let Some(session) = cookie(headers, SESSION_COOKIE) else {
        return Err(Box::new(unauthorized("sign in first")));
    };
    match app.server.store().web_session_lookup(&sha256_hex(&session)) {
        Ok(Some(user_id)) => Ok(user_id),
        Ok(None) => Err(Box::new(unauthorized(
            "the session has expired; sign in again",
        ))),
        Err(error) => Err(Box::new(internal(format!(
            "reading the session failed: {error}"
        )))),
    }
}

/// A fresh session id, stored hashed, mirrored into both cookies.
fn begin_session(
    app: &AppState,
    username: &str,
    secure: bool,
) -> Result<Vec<String>, Box<Response>> {
    let user_id = match app.server.store().user_by_username(username) {
        Ok(Some((user_id, _))) => user_id,
        Ok(None) => {
            return Err(Box::new(internal(
                "the account vanished after registration",
            )))
        }
        Err(error) => {
            return Err(Box::new(internal(format!(
                "reading the account failed: {error}"
            ))));
        }
    };
    let session = new_token();
    if let Err(error) = app
        .server
        .store()
        .web_session_insert(&sha256_hex(&session), user_id)
    {
        return Err(Box::new(internal(format!(
            "storing the session failed: {error}"
        ))));
    }
    Ok(session_cookies(&session, secure))
}

fn secure_suffix(secure: bool) -> &'static str {
    if secure {
        "; Secure"
    } else {
        ""
    }
}

fn session_cookies(session: &str, secure: bool) -> Vec<String> {
    let secure = secure_suffix(secure);
    vec![
        format!(
            "{SESSION_COOKIE}={session}; HttpOnly; Path=/; SameSite=Lax; Max-Age={SESSION_MAX_AGE}{secure}"
        ),
        format!("{CSRF_COOKIE}={session}; Path=/; SameSite=Lax; Max-Age={SESSION_MAX_AGE}{secure}"),
    ]
}

fn clear_cookies(secure: bool) -> Vec<String> {
    let secure = secure_suffix(secure);
    vec![
        format!("{SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0{secure}"),
        format!("{CSRF_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0{secure}"),
    ]
}

/// Traefik/Cloudflare terminate TLS in front of the process. Honour the
/// forwarded scheme so install commands point at HTTPS and session cookies are
/// marked `Secure` in production; a plain dev server without the header keeps
/// the old HTTP behaviour.
fn forwarded_https(headers: &HeaderMap) -> bool {
    headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(|value| value.trim().eq_ignore_ascii_case("https"))
        .unwrap_or(false)
}

fn request_base(headers: &HeaderMap) -> Result<String, Box<Response>> {
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .ok_or_else(|| {
            Box::new(respond_status(
                StatusCode::BAD_REQUEST,
                bad_request::<()>("the Host header is required"),
            ))
        })?;
    let scheme = if forwarded_https(headers) {
        "https"
    } else {
        "http"
    };
    Ok(format!("{scheme}://{}", host.trim_end_matches('/')))
}

fn with_cookies(mut response: Response, cookies: &[String]) -> Response {
    for cookie in cookies {
        if let Ok(value) = HeaderValue::from_str(cookie) {
            response.headers_mut().append(header::SET_COOKIE, value);
        }
    }
    response
}

fn bad_request<T>(message: &str) -> Envelope<T> {
    error_envelope(ErrorCode::BadRequest, message)
}

fn unauthorized(message: &str) -> Response {
    respond_status(
        StatusCode::UNAUTHORIZED,
        error_envelope::<()>(ErrorCode::NotAuthenticated, message),
    )
}

fn forbidden(message: &str) -> Response {
    respond_status(
        StatusCode::FORBIDDEN,
        error_envelope::<()>(ErrorCode::BadRequest, message),
    )
}

fn internal(message: impl Into<String>) -> Response {
    respond_status(
        StatusCode::INTERNAL_SERVER_ERROR,
        error_envelope::<()>(ErrorCode::Internal, message),
    )
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "not found").into_response()
}

fn respond<T: Serialize>(env: Envelope<T>) -> Response {
    let status = env
        .error
        .as_ref()
        .map(|error| error.http_status())
        .unwrap_or(200);
    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    respond_status(status, env)
}

fn respond_status<T: Serialize>(status: StatusCode, env: Envelope<T>) -> Response {
    (status, Json(env)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(host: &str, proto: Option<&str>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, host.parse().expect("host"));
        if let Some(proto) = proto {
            headers.insert("x-forwarded-proto", proto.parse().expect("proto"));
        }
        headers
    }

    #[test]
    fn install_base_uses_https_behind_a_tls_proxy() {
        assert_eq!(
            request_base(&headers("slacking-off.mainstayx.com", None)).unwrap(),
            "http://slacking-off.mainstayx.com"
        );
        assert_eq!(
            request_base(&headers("slacking-off.mainstayx.com", Some("https"))).unwrap(),
            "https://slacking-off.mainstayx.com"
        );
        assert_eq!(
            request_base(&headers("slacking-off.mainstayx.com", Some("https, http"))).unwrap(),
            "https://slacking-off.mainstayx.com"
        );
    }

    #[test]
    fn session_cookies_are_secure_only_behind_tls() {
        let plain = session_cookies("session", false);
        let secure = session_cookies("session", true);
        assert!(plain.iter().all(|cookie| !cookie.contains("; Secure")));
        assert!(secure.iter().all(|cookie| cookie.contains("; Secure")));
        assert!(clear_cookies(true)
            .iter()
            .all(|cookie| cookie.contains("; Secure")));
    }
}
