use std::{sync::Arc, time::Instant};

use axum::{
    Json,
    extract::{FromRequest, MatchedPath, Request, State},
    http::{HeaderValue, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde::de::DeserializeOwned;
use serde_json::json;
use uuid::Uuid;

tokio::task_local! { static REQUEST_ID: Uuid; }

pub fn request_id() -> Uuid {
    REQUEST_ID
        .try_with(|id| *id)
        .unwrap_or_else(|_| Uuid::new_v4())
}

pub async fn request_context(
    State(operations): State<Arc<crate::operations::Operations>>,
    request: Request,
    next: Next,
) -> Response {
    let id = Uuid::new_v4();
    let started = Instant::now();
    let method = request.method().clone();
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(|path| path.as_str().to_owned())
        .unwrap_or_default();
    let mut response = REQUEST_ID.scope(id, next.run(request)).await;
    response.headers_mut().insert(
        "x-request-id",
        HeaderValue::from_str(&id.to_string()).unwrap(),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    let status = response.status();
    if matches!(
        route.as_str(),
        "/api/v1/captures/{id}/image" | "/api/v1/captures/{id}/complete"
    ) && !status.is_success()
        && !matches!(
            status,
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN | StatusCode::METHOD_NOT_ALLOWED
        )
    {
        operations.record_upload_failure();
    }
    if !matches!(route.as_str(), "/health" | "/ready" | "/metrics") || !status.is_success() {
        tracing::info!(request_id = %id, method = %method, route, status = status.as_u16(),
            duration_ms = started.elapsed().as_millis() as u64, "Requisição concluída");
    }
    response
}

#[derive(Debug)]
pub struct ApiError(pub StatusCode, pub &'static str, pub &'static str);

impl std::fmt::Display for ApiError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.2)
    }
}
impl std::error::Error for ApiError {}

impl ApiError {
    pub fn invalid(message: &'static str) -> Self {
        Self(StatusCode::BAD_REQUEST, "INVALID_INPUT", message)
    }
    pub fn unauthorized() -> Self {
        Self(
            StatusCode::UNAUTHORIZED,
            "UNAUTHORIZED",
            "Credenciais ou sessão inválidas.",
        )
    }
    pub fn forbidden() -> Self {
        Self(
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
            "Você não tem permissão para esta operação.",
        )
    }
    pub fn missing() -> Self {
        Self(
            StatusCode::NOT_FOUND,
            "NOT_FOUND",
            "Registro não encontrado.",
        )
    }
    pub fn internal() -> Self {
        tracing::error!(request_id = %request_id(), "Falha interna");
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL_ERROR",
            "Não foi possível concluir a operação.",
        )
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        if let Some(database) = error.as_database_error() {
            tracing::error!(request_id = %request_id(), sqlstate = ?database.code(), "Falha no PostgreSQL");
        }
        Self::internal()
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.0,
            Json(json!({"code": self.1, "message": self.2, "request_id": request_id()})),
        )
            .into_response()
    }
}

pub struct Body<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequest<S> for Body<T> {
    type Rejection = ApiError;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        Json::<T>::from_request(request, state)
            .await
            .map(|Json(value)| Self(value))
            .map_err(|error| {
                ApiError(
                    error.status(),
                    "INVALID_BODY",
                    "Corpo JSON inválido ou incompatível com o contrato.",
                )
            })
    }
}
