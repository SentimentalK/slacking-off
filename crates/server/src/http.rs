//! HTTP layer. Handlers are thin: they authenticate, call `Server`, and map the
//! envelope to a status code. SSE is a later step.

use crate::Server;
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use loo_proto::{
    ActionQueued, ApiError, BuildRequest, ConfigResponse, DemolishRequest, DoorRequest, Envelope,
    ErrorCode, JoinRequest, JoinResponse, LeaveResponse, MoveRequest, RegisterRequest, WaitRequest,
};
use serde::Serialize;
use std::sync::Arc;

pub fn router(server: Arc<Server>) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/api/dev/register", post(register))
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
        .route("/api/use", post(use_cmd))
        .route("/api/cancel", post(cancel_cmd))
        .route("/api/leave", post(leave_cmd))
        .route("/api/wait", post(wait))
        .with_state(server)
}

async fn healthz() -> impl IntoResponse {
    Json(serde_json::json!({ "ok": true }))
}

async fn register(
    State(server): State<Arc<Server>>,
    body: Option<Json<RegisterRequest>>,
) -> Response {
    let req = body.map(|Json(req)| req).unwrap_or(RegisterRequest {
        name: None,
        model: None,
        intro: None,
    });
    respond(server.dev_register(req).await)
}

async fn join(
    State(server): State<Arc<Server>>,
    headers: HeaderMap,
    body: Option<Json<JoinRequest>>,
) -> Response {
    let Some(Json(req)) = body else {
        return respond::<JoinResponse>(bad_request("body must be {sent_by, why}"));
    };
    respond(server.join(&token(&headers), req).await)
}

async fn look(State(server): State<Arc<Server>>, headers: HeaderMap) -> Response {
    respond(server.look(&token(&headers)).await)
}

async fn map_view(State(server): State<Arc<Server>>, headers: HeaderMap) -> Response {
    respond(server.map_view(&token(&headers)).await)
}

async fn status(State(server): State<Arc<Server>>, headers: HeaderMap) -> Response {
    respond(server.status(&token(&headers)).await)
}

async fn config(State(server): State<Arc<Server>>) -> Response {
    respond::<ConfigResponse>(server.config_response().await)
}

async fn rules(State(server): State<Arc<Server>>) -> Response {
    respond(server.rules().await)
}

async fn move_cmd(
    State(server): State<Arc<Server>>,
    headers: HeaderMap,
    body: Option<Json<MoveRequest>>,
) -> Response {
    let Some(Json(req)) = body else {
        return respond::<ActionQueued>(bad_request("body must be {spec}"));
    };
    respond(server.move_cmd(&token(&headers), req).await)
}

async fn wait(
    State(server): State<Arc<Server>>,
    headers: HeaderMap,
    body: Option<Json<WaitRequest>>,
) -> Response {
    let req = body.map(|Json(req)| req).unwrap_or(WaitRequest {
        timeout_seconds: None,
    });
    respond(server.wait(&token(&headers), req).await)
}

async fn build_cmd(
    State(server): State<Arc<Server>>,
    headers: HeaderMap,
    body: Option<Json<BuildRequest>>,
) -> Response {
    let Some(Json(req)) = body else {
        return respond::<ActionQueued>(bad_request("body must be {kind, target}"));
    };
    respond(server.build_cmd(&token(&headers), req).await)
}

async fn demolish_cmd(
    State(server): State<Arc<Server>>,
    headers: HeaderMap,
    body: Option<Json<DemolishRequest>>,
) -> Response {
    let Some(Json(req)) = body else {
        return respond::<ActionQueued>(bad_request("body must be {target}"));
    };
    respond(server.demolish_cmd(&token(&headers), req).await)
}

async fn door_cmd(
    State(server): State<Arc<Server>>,
    headers: HeaderMap,
    body: Option<Json<DoorRequest>>,
) -> Response {
    let Some(Json(req)) = body else {
        return respond::<ActionQueued>(bad_request("body must be {target, open}"));
    };
    respond(server.door_cmd(&token(&headers), req).await)
}

async fn use_cmd(State(server): State<Arc<Server>>, headers: HeaderMap) -> Response {
    respond(server.use_cmd(&token(&headers)).await)
}

async fn cancel_cmd(State(server): State<Arc<Server>>, headers: HeaderMap) -> Response {
    respond(server.cancel_cmd(&token(&headers)).await)
}

async fn leave_cmd(State(server): State<Arc<Server>>, headers: HeaderMap) -> Response {
    respond::<LeaveResponse>(server.leave_cmd(&token(&headers)).await)
}

fn token(headers: &HeaderMap) -> String {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or("")
        .to_string()
}

fn bad_request<T>(message: &str) -> Envelope<T> {
    Envelope::failed(
        ApiError::new(ErrorCode::BadRequest, message),
        Vec::new(),
        None,
    )
}

fn respond<T: Serialize>(env: Envelope<T>) -> Response {
    let status = env
        .error
        .as_ref()
        .map(|error| error.http_status())
        .unwrap_or(200);
    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (status, Json(env)).into_response()
}
