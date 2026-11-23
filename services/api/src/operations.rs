use std::{
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use axum::{
    Json,
    extract::{Query, State, rejection::QueryRejection},
    http::{HeaderMap, StatusCode, header},
    response::IntoResponse,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{Role, authorize},
    error::ApiError,
};

pub struct Operations {
    token_digest: Option<[u8; 32]>,
    upload_failures: AtomicU64,
}

impl Operations {
    pub fn new(token: Option<String>) -> Result<Self, &'static str> {
        let token = token.filter(|token| !token.is_empty());
        if token.as_ref().is_some_and(|token| {
            token.len() < 32
                || token.len() > 256
                || !token.bytes().all(|byte| byte.is_ascii_graphic())
        }) {
            return Err("METRICS_TOKEN deve ter entre 32 e 256 caracteres ASCII sem espaços.");
        }
        Ok(Self {
            token_digest: token.map(|value| Sha256::digest(value).into()),
            upload_failures: AtomicU64::new(0),
        })
    }

    pub fn record_upload_failure(&self) {
        self.upload_failures.fetch_add(1, Ordering::Relaxed);
    }

    fn authorize_metrics(&self, headers: &HeaderMap) -> Result<(), ApiError> {
        let expected = self.token_digest.as_ref().ok_or_else(ApiError::missing)?;
        let token = headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .ok_or_else(ApiError::unauthorized)?;
        let actual = Sha256::digest(token);
        let differences = actual
            .iter()
            .zip(expected)
            .fold(0, |different, (a, b)| different | (a ^ b));
        if differences != 0 {
            return Err(ApiError::unauthorized());
        }
        Ok(())
    }
}

pub async fn readiness(State(state): State<AppState>) -> impl IntoResponse {
    let deadline = Duration::from_secs(3);
    let (db, storage) = tokio::join!(
        tokio::time::timeout(deadline, schema_ready(&state.db)),
        tokio::time::timeout(deadline, state.storage.has_objects()),
    );
    if matches!(db, Ok(Ok(true))) && matches!(storage, Ok(Ok(_))) {
        return (StatusCode::OK, Json(json!({"status":"ready"})));
    }
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({"status":"unavailable"})),
    )
}

async fn schema_ready(db: &sqlx::PgPool) -> Result<bool, sqlx::Error> {
    let applied: Vec<(i64, Vec<u8>, bool)> =
        sqlx::query_as("SELECT version, checksum, success FROM _sqlx_migrations ORDER BY version")
            .fetch_all(db)
            .await?;
    let expected = crate::MIGRATOR
        .iter()
        .filter(|migration| migration.migration_type.is_up_migration());
    Ok(applied
        .iter()
        .map(|(version, checksum, success)| (*version, checksum.as_slice(), *success))
        .eq(expected.map(|migration| (migration.version, migration.checksum.as_ref(), true))))
}

#[derive(sqlx::FromRow)]
struct Counts {
    pending_uploads: i64,
    overdue_jobs: i64,
    recognized: i64,
    reviewed: i64,
    divergences: i64,
    durations_count: i64,
    durations_seconds: f64,
}

pub async fn metrics(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    state.operations.authorize_metrics(&headers)?;
    let counts: Counts = tokio::time::timeout(Duration::from_secs(3), sqlx::query_as(
        "WITH recognized AS (
            SELECT DISTINCT capture_id FROM ocr_results WHERE status = 'RECOGNIZED'
        )
        SELECT
          (SELECT count(*) FROM capture_uploads u WHERE NOT EXISTS (SELECT 1 FROM captures c WHERE c.id = u.id)) AS pending_uploads,
          (SELECT count(*) FROM jobs WHERE
              (status = 'PENDING' AND next_run_at < now() - interval '1 minute')
              OR (status = 'RUNNING' AND locked_at < now() - interval '90 seconds')) AS overdue_jobs,
          (SELECT count(*) FROM recognized) AS recognized,
          (SELECT count(*) FROM recognized r WHERE EXISTS (
              SELECT 1 FROM audit_events a WHERE a.entity_type = 'capture' AND a.entity_id = r.capture_id
                AND a.action IN ('CAPTURE_VALIDATED', 'CAPTURE_FLAGGED')
          )) AS reviewed,
          (SELECT count(*) FROM receipt_scans WHERE result NOT IN ('MATCHED', 'DUPLICATE_SCAN')) AS divergences,
          (SELECT count(duration_ms) FROM ocr_results) AS durations_count,
          (SELECT COALESCE(sum(duration_ms)::float8 / 1000, 0) FROM ocr_results) AS durations_seconds",
    ).fetch_one(&state.db)).await.map_err(|_| ApiError(
        StatusCode::SERVICE_UNAVAILABLE, "METRICS_UNAVAILABLE", "Métricas temporariamente indisponíveis.",
    ))??;
    let failure_count = state.operations.upload_failures.load(Ordering::Relaxed);
    let values = [
        (
            "stock_uploads_pending",
            "gauge",
            counts.pending_uploads.to_string(),
        ),
        (
            "stock_jobs_overdue",
            "gauge",
            counts.overdue_jobs.to_string(),
        ),
        (
            "stock_ocr_recognized_captures",
            "gauge",
            counts.recognized.to_string(),
        ),
        (
            "stock_ocr_reviewed_captures",
            "gauge",
            counts.reviewed.to_string(),
        ),
        (
            "stock_receipt_divergences_total",
            "counter",
            counts.divergences.to_string(),
        ),
        (
            "stock_upload_failures_total",
            "counter",
            failure_count.to_string(),
        ),
    ];
    let mut body = String::new();
    for (name, kind, value) in values {
        body.push_str(&format!("# TYPE {name} {kind}\n{name} {value}\n"));
    }
    body.push_str(&format!("# TYPE stock_ocr_duration_seconds summary\nstock_ocr_duration_seconds_count {}\nstock_ocr_duration_seconds_sum {}\n",
        counts.durations_count, counts.durations_seconds));
    Ok((
        [(
            header::CONTENT_TYPE,
            "text/plain; version=0.0.4; charset=utf-8",
        )],
        body,
    ))
}

#[derive(Deserialize)]
pub struct AuditQuery {
    entity_id: Option<Uuid>,
    after: Option<Uuid>,
    limit: Option<i64>,
}

#[derive(Serialize, sqlx::FromRow)]
struct AuditEvent {
    id: Uuid,
    actor_id: Uuid,
    action: String,
    entity_type: String,
    entity_id: Uuid,
    before_json: Option<Value>,
    after_json: Option<Value>,
    request_id: Uuid,
    created_at: DateTime<Utc>,
}

pub async fn audit_events(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: Result<Query<AuditQuery>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, _) = authorize(&state.db, &headers, Role::Administrator).await?;
    let Query(query) =
        query.map_err(|_| ApiError::invalid("Parâmetros de auditoria inválidos."))?;
    let limit = query.limit.unwrap_or(25);
    if !(1..=100).contains(&limit) {
        return Err(ApiError::invalid("Use um limite de 1 a 100 eventos."));
    }
    let mut items: Vec<AuditEvent> = sqlx::query_as(
        "SELECT id, actor_id, action, entity_type, entity_id, before_json, after_json, request_id, created_at
         FROM audit_events
         WHERE ($1::uuid IS NULL OR entity_id = $1)
           AND ($2::uuid IS NULL OR (created_at, id) <
                (SELECT created_at, id FROM audit_events WHERE id = $2))
         ORDER BY created_at DESC, id DESC LIMIT $3",
    ).bind(query.entity_id).bind(query.after).bind(limit + 1).fetch_all(&mut *tx).await?;
    let more = items.len() > limit as usize;
    items.truncate(limit as usize);
    let next = items.last().filter(|_| more).map(|event| event.id);
    tx.commit().await?;
    Ok(Json(json!({"items":items, "next_cursor":next})))
}

#[derive(Deserialize)]
pub struct RetentionQuery {
    older_than_days: i32,
}

pub async fn retention_report(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: Result<Query<RetentionQuery>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, _) = authorize(&state.db, &headers, Role::Administrator).await?;
    let Query(query) =
        query.map_err(|_| ApiError::invalid("Informe older_than_days entre 1 e 36500."))?;
    if !(1..=36_500).contains(&query.older_than_days) {
        return Err(ApiError::invalid(
            "Informe older_than_days entre 1 e 36500.",
        ));
    }
    let counts: (i64, i64) = sqlx::query_as(
        "SELECT
         (SELECT count(*) FROM capture_uploads u WHERE u.created_at < now() - make_interval(days => $1)
            AND NOT EXISTS (SELECT 1 FROM captures c WHERE c.id = u.id)),
         (SELECT count(*) FROM captures WHERE received_at_server < now() - make_interval(days => $1))",
    ).bind(query.older_than_days).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({
        "older_than_days": query.older_than_days,
        "incomplete_uploads": counts.0,
        "confirmed_captures": counts.1,
    })))
}

pub async fn shutdown_signal() {
    #[cfg(unix)]
    if let Ok(mut terminate) =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
    {
        tokio::select! {
            _ = terminate.recv() => {},
            _ = tokio::signal::ctrl_c() => {},
        }
        return;
    }
    let _ = tokio::signal::ctrl_c().await;
}
