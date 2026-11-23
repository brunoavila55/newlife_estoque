use axum::{
    Json,
    extract::{Path, Query, State, rejection::QueryRejection},
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{Role, audit, authorize, parse_id},
    error::ApiError,
};

#[derive(Deserialize)]
pub struct QueueQuery {
    status: Option<String>,
    after: Option<Uuid>,
    limit: Option<i64>,
}

#[derive(Serialize, sqlx::FromRow)]
struct QueueCapture {
    id: Uuid,
    technician_name: String,
    status: String,
    captured_at_device: DateTime<Utc>,
    received_at_server: DateTime<Utc>,
    equipment_id: Option<Uuid>,
    review_issue: Option<Value>,
}

#[derive(Serialize)]
pub struct QueuePage {
    items: Vec<QueueCapture>,
    next_cursor: Option<Uuid>,
}

pub async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: Result<Query<QueueQuery>, QueryRejection>,
) -> Result<Json<QueuePage>, ApiError> {
    let (mut tx, _) = authorize(&state.db, &headers, Role::Administrator).await?;
    let Query(query) =
        query.map_err(|_| ApiError::invalid("Parâmetros de paginação inválidos."))?;
    let limit = query.limit.unwrap_or(25);
    if !(1..=100).contains(&limit) {
        return Err(ApiError::invalid("Use um limite de 1 a 100 capturas."));
    }
    let filter = query.status.as_deref().unwrap_or("pending");
    let statuses: &[&str] = match filter {
        "pending" => &[
            "RECEIVED",
            "OCR_PENDING",
            "OCR_PROCESSING",
            "NEEDS_REVIEW",
            "OCR_FAILED",
        ],
        "all" => &[],
        "RECEIVED" | "OCR_PENDING" | "OCR_PROCESSING" | "NEEDS_REVIEW" | "OCR_FAILED"
        | "IDENTIFIED" => &[filter],
        _ => return Err(ApiError::invalid("Filtro de status inválido.")),
    };
    if let Some(after) = query.after {
        let valid: bool =
            sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM captures WHERE id = $1)")
                .bind(after)
                .fetch_one(&mut *tx)
                .await?;
        if !valid {
            return Err(ApiError::invalid("Cursor de paginação inválido."));
        }
    }
    let mut items: Vec<QueueCapture> = sqlx::query_as(
        "SELECT c.id, u.name AS technician_name, c.status, c.captured_at_device, c.received_at_server,
                c.equipment_id, c.review_issue
         FROM captures c JOIN users u ON u.id = c.technician_id
         WHERE (cardinality($1::text[]) = 0 OR c.status = ANY($1))
           AND ($2::uuid IS NULL OR (c.received_at_server, c.id) <
               (SELECT received_at_server, id FROM captures WHERE id = $2))
         ORDER BY c.received_at_server DESC, c.id DESC LIMIT $3",
    ).bind(statuses).bind(query.after).bind(limit + 1).fetch_all(&mut *tx).await?;
    let more = items.len() > limit as usize;
    items.truncate(limit as usize);
    let next_cursor = items.last().filter(|_| more).map(|capture| capture.id);
    tx.commit().await?;
    Ok(Json(QueuePage { items, next_cursor }))
}

#[derive(Deserialize)]
pub struct DetailQuery {
    result_id: Option<Uuid>,
}

#[derive(Serialize, sqlx::FromRow)]
struct OcrRun {
    id: Uuid,
    status: String,
    created_at: DateTime<Utc>,
}

#[derive(Serialize, sqlx::FromRow)]
struct OcrResult {
    id: Uuid,
    provider: String,
    model_version: String,
    status: String,
    raw_tsv: Option<String>,
    suggestions: Value,
    warnings: Value,
    failure_code: Option<String>,
    created_at: DateTime<Utc>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct CaptureDetail {
    #[serde(flatten)]
    #[sqlx(flatten)]
    capture: QueueCapture,
    barcode_evidence: Option<Value>,
    validated_identifiers: Option<Value>,
    #[sqlx(skip)]
    runs: Vec<OcrRun>,
    #[sqlx(skip)]
    result: Option<OcrResult>,
}

pub async fn detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    query: Result<Query<DetailQuery>, QueryRejection>,
) -> Result<Json<CaptureDetail>, ApiError> {
    let (mut tx, _) = authorize(&state.db, &headers, Role::Administrator).await?;
    let id = parse_id(&id)?;
    let Query(query) =
        query.map_err(|_| ApiError::invalid("Identificador da leitura inválido."))?;
    let mut detail: CaptureDetail = sqlx::query_as(
        "SELECT c.id, u.name AS technician_name, c.status, c.captured_at_device, c.received_at_server,
                c.equipment_id, c.review_issue, c.barcode_evidence, c.validated_identifiers
         FROM captures c JOIN users u ON u.id = c.technician_id WHERE c.id = $1 FOR SHARE OF c",
    ).bind(id).fetch_optional(&mut *tx).await?.ok_or_else(ApiError::missing)?;
    detail.runs = sqlx::query_as(
        "SELECT id, status, created_at FROM ocr_results WHERE capture_id = $1
         ORDER BY created_at DESC, id DESC LIMIT 20",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    if let Some(result_id) = query
        .result_id
        .or_else(|| detail.runs.first().map(|run| run.id))
    {
        detail.result = Some(sqlx::query_as(
            "SELECT id, provider, model_version, status, raw_tsv, suggestions, warnings, failure_code, created_at
             FROM ocr_results WHERE capture_id = $1 AND id = $2",
        ).bind(id).bind(result_id).fetch_optional(&mut *tx).await?.ok_or_else(ApiError::missing)?);
    }
    tx.commit().await?;
    Ok(Json(detail))
}

pub async fn reprocess(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, actor) = authorize(&state.db, &headers, Role::Administrator).await?;
    let id = parse_id(&id)?;
    let (status, issue): (String, Option<Value>) =
        sqlx::query_as("SELECT status, review_issue FROM captures WHERE id = $1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(ApiError::missing)?;
    if matches!(status.as_str(), "OCR_PENDING" | "OCR_PROCESSING") {
        tx.commit().await?;
        return Ok(Json(json!({ "status": status })));
    }
    if issue.is_some() || !matches!(status.as_str(), "RECEIVED" | "NEEDS_REVIEW" | "OCR_FAILED") {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "OCR_REPROCESS_CONFLICT",
            "A captura possui uma decisão administrativa que precisa ser preservada.",
        ));
    }
    let changed = sqlx::query(
        "INSERT INTO jobs (id, kind, capture_id) VALUES ($1, 'LABEL_RECOGNITION', $2)
         ON CONFLICT (kind, capture_id) DO UPDATE SET status = 'PENDING', attempts = 0,
            next_run_at = now(), locked_at = NULL, run_id = NULL, last_error = NULL
         WHERE jobs.status IN ('SUCCEEDED', 'FAILED')",
    )
    .bind(Uuid::new_v4())
    .bind(id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if changed == 0 {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "OCR_REPROCESS_CONFLICT",
            "A captura já tem um processamento em andamento.",
        ));
    }
    sqlx::query("UPDATE captures SET status = 'OCR_PENDING' WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    audit(
        &mut tx,
        actor,
        "OCR_REPROCESS_REQUESTED",
        "capture",
        id,
        Some(json!({ "status": status })),
        json!({ "status": "OCR_PENDING" }),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({ "status": "OCR_PENDING" })))
}
