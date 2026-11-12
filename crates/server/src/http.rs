//! HTTP layer. Handlers are thin: they authenticate, call `Server`, and map the
//! envelope to a status code.
//!
//! Dev mode keeps the token-only rules from earlier steps. Official mode adds
//! accounts, cookie sessions and CSRF (contract §1).

use crate::auth::{new_token, sha256_hex};
use crate::{error_envelope, Server};
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use loo_proto::{
    ActionQueued, AttackRequest, AuthLoginRequest, AuthMeResponse, AuthRegisterRequest,
    BuildRequest, ConfigResponse, DefendRequest, DemolishRequest, DoorRequest, DowngradeRequest,
    Envelope, ErrorCode, JoinRequest, JoinResponse, LeaveResponse, MoveRequest, RegisterRequest,
    UpgradeRequest, WaitRequest,
};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;

/// Cookie lifetime for both the session and its CSRF mirror (30 days).
const SESSION_MAX_AGE: u64 = 2_592_000;
const SESSION_COOKIE: &str = "loo_session";
const CSRF_COOKIE: &str = "loo_csrf";

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
        .with_state(state)
}

async fn healthz() -> impl IntoResponse {
    Json(serde_json::json!({ "ok": true }))
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
    body: Option<Json<AuthRegisterRequest>>,
) -> Response {
    if !app.server.official() {
        return not_found();
    }
    let Some(Json(body)) = body else {
        return respond::<AuthMeResponse>(bad_request("body must be {username, password}"));
    };
    let env = app
        .server
        .register_account(&body.username, &body.password)
        .await;
    if !env.ok {
        return respond_status(StatusCode::CONFLICT, env);
    }
    let cookies = match begin_session(&app, &body.username) {
        Ok(cookies) => cookies,
        Err(response) => return *response,
    };
    with_cookies(respond(env), &cookies)
}

async fn auth_login(
    State(app): State<Arc<AppState>>,
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
    let cookies = match begin_session(&app, &body.username) {
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
        &clear_cookies(),
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

/// Contract §1: six download names, mapped onto the two binaries the build
/// produces.
fn platform_file(name: &str) -> Option<&'static str> {
    match name {
        "loo-linux-x64" | "loo-linux-arm64" | "loo-macos-x64" | "loo-macos-arm64" => Some("loo"),
        "loo-windows-x64.exe" | "loo-windows-arm64.exe" => Some("loo.exe"),
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
fn begin_session(app: &AppState, username: &str) -> Result<Vec<String>, Box<Response>> {
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
    Ok(session_cookies(&session))
}

fn session_cookies(session: &str) -> Vec<String> {
    vec![
        format!(
            "{SESSION_COOKIE}={session}; HttpOnly; Path=/; SameSite=Lax; Max-Age={SESSION_MAX_AGE}"
        ),
        format!("{CSRF_COOKIE}={session}; Path=/; SameSite=Lax; Max-Age={SESSION_MAX_AGE}"),
    ]
}

fn clear_cookies() -> Vec<String> {
    vec![
        format!("{SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0"),
        format!("{CSRF_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0"),
    ]
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
    Ok(format!("http://{}", host.trim_end_matches('/')))
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
