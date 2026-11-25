//! Lotes de devolução.
//!
//! O técnico declara quais coletas vai entregar. O estoque abre a conferência
//! do lote, que cria uma sessão de recebimento com os equipamentos previstos.
//! O lote nunca transfere custódia: apenas a confirmação item a item da sessão
//! (em `receipts`) move o equipamento para o depósito.

use axum::{
    Json,
    extract::{Path, Query, State, rejection::QueryRejection},
    http::HeaderMap,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::{
    AppState,
    auth::{Role, audit, authorize, parse_id},
    custody::require_technician,
    error::{ApiError, Body},
    receipts::{self, authorize_receive, checked_query, conflict, limit},
};

const MAX_BATCH_ITEMS: usize = 200;
const MAX_CUSTODY_ROWS: i64 = 500;

#[derive(Serialize, sqlx::FromRow)]
pub(crate) struct BatchSummary {
    pub(crate) id: Uuid,
    number: i64,
    technician_id: Uuid,
    technician_name: String,
    status: String,
    notes: Option<String>,
    receipt_session_id: Option<Uuid>,
    clerk_name: Option<String>,
    created_at: DateTime<Utc>,
    finished_at: Option<DateTime<Utc>>,
    total: i64,
    unidentified: i64,
    received: i64,
}

const SUMMARY: &str = "SELECT b.id, b.number, b.technician_id, u.name AS technician_name, b.status, b.notes,
        b.receipt_session_id, k.name AS clerk_name, b.created_at, b.finished_at,
        (SELECT count(*) FROM delivery_batch_items i WHERE i.batch_id = b.id) AS total,
        (SELECT count(*) FROM delivery_batch_items i JOIN captures c ON c.id = i.capture_id
          WHERE i.batch_id = b.id AND c.equipment_id IS NULL) AS unidentified,
        (SELECT count(*) FROM delivery_batch_items i JOIN captures c ON c.id = i.capture_id
          JOIN custody_movements m ON m.equipment_id = c.equipment_id AND m.movement_type = 'WAREHOUSE_RECEIVED'
          WHERE i.batch_id = b.id) AS received
     FROM delivery_batches b JOIN users u ON u.id = b.technician_id
        LEFT JOIN receipt_sessions s ON s.id = b.receipt_session_id
        LEFT JOIN users k ON k.id = s.clerk_id";

/// Campos comuns às linhas de coleta (lote e custódia).
/// `identifiers` são os valores verificados; `suggestions` vêm do OCR mais recente
/// e `typed_code` do código digitado ou lido no celular. Os dois últimos são apenas sugestões.
const CAPTURE_FIELDS: &str = "c.id AS capture_id, c.equipment_id, c.status AS capture_status,
        c.captured_at_device AS captured_at, c.complement, c.barcode_evidence->>'raw_value' AS typed_code,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', x.kind, 'raw_value', x.raw_value)
            ORDER BY x.kind, x.normalized_value) FROM equipment_identifiers x
            WHERE x.equipment_id = c.equipment_id), '[]'::jsonb) AS identifiers,
        COALESCE((SELECT o.suggestions FROM ocr_results o WHERE o.capture_id = c.id
            ORDER BY o.created_at DESC, o.id DESC LIMIT 1), '[]'::jsonb) AS suggestions,
        (SELECT m.occurred_at FROM custody_movements m WHERE m.equipment_id = c.equipment_id
            AND m.movement_type = 'WAREHOUSE_RECEIVED') AS received_at";

#[derive(Serialize, sqlx::FromRow)]
struct BatchItem {
    capture_id: Uuid,
    equipment_id: Option<Uuid>,
    capture_status: String,
    captured_at: DateTime<Utc>,
    complement: Option<Value>,
    typed_code: Option<String>,
    identifiers: Value,
    suggestions: Value,
    received_at: Option<DateTime<Utc>>,
    added_by_clerk: bool,
}

#[derive(Serialize, sqlx::FromRow)]
struct CustodyItem {
    capture_id: Uuid,
    equipment_id: Option<Uuid>,
    capture_status: String,
    captured_at: DateTime<Utc>,
    complement: Option<Value>,
    typed_code: Option<String>,
    identifiers: Value,
    suggestions: Value,
    received_at: Option<DateTime<Utc>>,
    batch_id: Option<Uuid>,
    batch_number: Option<i64>,
    batch_status: Option<String>,
}

pub(crate) async fn summary(db: &mut PgConnection, id: Uuid) -> Result<BatchSummary, ApiError> {
    sqlx::query_as(&format!("{SUMMARY} WHERE b.id = $1"))
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(ApiError::missing)
}

async fn items(db: &mut PgConnection, batch: Uuid) -> Result<Vec<BatchItem>, ApiError> {
    Ok(sqlx::query_as(&format!(
        "SELECT {CAPTURE_FIELDS}, i.added_by <> i.technician_id AS added_by_clerk
         FROM delivery_batch_items i JOIN captures c ON c.id = i.capture_id
         WHERE i.batch_id = $1 ORDER BY c.captured_at_device, c.id"
    ))
    .bind(batch)
    .fetch_all(db)
    .await?)
}

async fn detail_json(db: &mut PgConnection, id: Uuid) -> Result<Value, ApiError> {
    let batch = summary(db, id).await?;
    let items = items(db, id).await?;
    Ok(json!({"batch": batch, "items": items}))
}

/// Equipamentos e coletas ainda sob responsabilidade do técnico.
/// Uma linha por equipamento identificado e uma por coleta ainda sem identificação.
async fn custody(db: &mut PgConnection, technician: Uuid) -> Result<Vec<CustodyItem>, ApiError> {
    Ok(sqlx::query_as(&format!(
        "SELECT * FROM (
            SELECT DISTINCT ON (COALESCE(c.equipment_id, c.id)) {CAPTURE_FIELDS},
                b.id AS batch_id, b.number AS batch_number, b.status AS batch_status
            FROM captures c
                LEFT JOIN equipment e ON e.id = c.equipment_id
                LEFT JOIN delivery_batch_items bi ON bi.capture_id = c.id AND bi.active
                LEFT JOIN delivery_batches b ON b.id = bi.batch_id
            WHERE c.technician_id = $1 AND (c.equipment_id IS NULL OR e.technician_id = $1)
            ORDER BY COALESCE(c.equipment_id, c.id), (b.id IS NULL), c.received_at_server DESC, c.id
         ) held ORDER BY captured_at DESC, capture_id LIMIT $2"
    ))
    .bind(technician)
    .bind(MAX_CUSTODY_ROWS)
    .fetch_all(db)
    .await?)
}

#[derive(Deserialize)]
pub struct ListQuery {
    status: Option<String>,
    technician_id: Option<Uuid>,
    after: Option<Uuid>,
    limit: Option<i64>,
}

async fn list_batches(
    db: &mut PgConnection,
    technician: Option<Uuid>,
    query: ListQuery,
) -> Result<Value, ApiError> {
    let limit = limit(query.limit)?;
    let statuses: &[&str] = match query.status.as_deref().unwrap_or("all") {
        "all" => &["SUBMITTED", "RECEIVING", "CLOSED", "CANCELLED"],
        "open" => &["SUBMITTED", "RECEIVING"],
        "closed" => &["CLOSED", "CANCELLED"],
        _ => return Err(ApiError::invalid("Filtro de lote inválido.")),
    };
    let mut rows: Vec<BatchSummary> = sqlx::query_as(&format!(
        "{SUMMARY} WHERE b.status = ANY($1) AND ($2::uuid IS NULL OR b.technician_id = $2)
           AND ($3::uuid IS NULL OR (b.created_at, b.id) <
               (SELECT created_at, id FROM delivery_batches WHERE id = $3))
         ORDER BY b.created_at DESC, b.id DESC LIMIT $4"
    ))
    .bind(statuses)
    .bind(technician.or(query.technician_id))
    .bind(query.after)
    .bind(limit + 1)
    .fetch_all(db)
    .await?;
    let more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let cursor = rows.last().filter(|_| more).map(|row| row.id);
    Ok(json!({"items": rows, "next_cursor": cursor}))
}

// ---------------------------------------------------------------------------
// Técnico
// ---------------------------------------------------------------------------

pub async fn my_custody(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, technician) = authorize(&state.db, &headers, Role::Technician).await?;
    let items = custody(&mut tx, technician).await?;
    tx.commit().await?;
    Ok(Json(json!({"items": items})))
}

pub async fn my_batches(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: Result<Query<ListQuery>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, technician) = authorize(&state.db, &headers, Role::Technician).await?;
    let page = list_batches(&mut tx, Some(technician), checked_query(query)?).await?;
    tx.commit().await?;
    Ok(Json(page))
}

pub async fn my_batch(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, technician) = authorize(&state.db, &headers, Role::Technician).await?;
    let id = parse_id(&id)?;
    owned_batch(&mut tx, id, technician, false).await?;
    let detail = detail_json(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(detail))
}

async fn owned_batch(
    db: &mut PgConnection,
    id: Uuid,
    technician: Uuid,
    lock: bool,
) -> Result<String, ApiError> {
    let sql = if lock {
        "SELECT status FROM delivery_batches WHERE id = $1 AND technician_id = $2 FOR UPDATE"
    } else {
        "SELECT status FROM delivery_batches WHERE id = $1 AND technician_id = $2"
    };
    sqlx::query_scalar(sql)
        .bind(id)
        .bind(technician)
        .fetch_optional(db)
        .await?
        .ok_or_else(ApiError::missing)
}

#[derive(Deserialize)]
pub struct CreateInput {
    client_batch_id: Uuid,
    capture_ids: Vec<Uuid>,
    notes: Option<String>,
}

pub async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Body(input): Body<CreateInput>,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, technician) = authorize(&state.db, &headers, Role::Technician).await?;
    let mut captures = input.capture_ids;
    captures.sort();
    captures.dedup();
    if captures.is_empty() || captures.len() > MAX_BATCH_ITEMS {
        return Err(ApiError::invalid(
            "Selecione de 1 a 200 equipamentos para o lote.",
        ));
    }
    let notes = input
        .notes
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if notes.is_some_and(|value| value.chars().count() > 500 || value.contains('\0')) {
        return Err(ApiError::invalid(
            "Use uma observação de até 500 caracteres.",
        ));
    }

    // Repetição da mesma requisição devolve o lote já criado.
    let existing: Option<Uuid> =
        sqlx::query_scalar("SELECT technician_id FROM delivery_batches WHERE id = $1")
            .bind(input.client_batch_id)
            .fetch_optional(&mut *tx)
            .await?;
    if let Some(owner) = existing {
        let mut previous: Vec<Uuid> = sqlx::query_scalar(
            "SELECT capture_id FROM delivery_batch_items WHERE batch_id = $1 AND added_by = $2",
        )
        .bind(input.client_batch_id)
        .bind(technician)
        .fetch_all(&mut *tx)
        .await?;
        previous.sort();
        if owner != technician || previous != captures {
            return Err(conflict(
                "BATCH_KEY_CONFLICT",
                "Esta chave já foi usada para outro lote.",
            ));
        }
        let detail = detail_json(&mut tx, input.client_batch_id).await?;
        tx.commit().await?;
        return Ok(Json(detail));
    }

    let rows: Vec<(Uuid, Option<Uuid>)> = sqlx::query_as(
        "SELECT id, equipment_id FROM captures WHERE id = ANY($1) AND technician_id = $2
         ORDER BY id FOR UPDATE",
    )
    .bind(&captures)
    .bind(technician)
    .fetch_all(&mut *tx)
    .await?;
    if rows.len() != captures.len() {
        return Err(ApiError::invalid(
            "Uma das coletas não foi encontrada na sua conta. Atualize a lista.",
        ));
    }
    let mut equipment: Vec<Uuid> = rows.iter().filter_map(|row| row.1).collect();
    equipment.sort();
    if equipment.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(ApiError::invalid(
            "Duas fotos selecionadas são do mesmo equipamento. Selecione apenas uma.",
        ));
    }
    let held: Vec<(Uuid, Option<Uuid>)> = sqlx::query_as(
        "SELECT id, technician_id FROM equipment WHERE id = ANY($1) ORDER BY id FOR UPDATE",
    )
    .bind(&equipment)
    .fetch_all(&mut *tx)
    .await?;
    if held.iter().any(|(_, holder)| *holder != Some(technician)) {
        return Err(conflict(
            "ALREADY_RECEIVED",
            "Um dos equipamentos já foi recebido pelo estoque. Atualize a lista.",
        ));
    }
    let busy: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM delivery_batch_items i JOIN captures c ON c.id = i.capture_id
         WHERE i.active AND (i.capture_id = ANY($1) OR c.equipment_id = ANY($2)))",
    )
    .bind(&captures)
    .bind(&equipment)
    .fetch_one(&mut *tx)
    .await?;
    if busy {
        return Err(conflict(
            "ITEM_IN_ANOTHER_BATCH",
            "Um dos equipamentos já está em outro lote aberto. Atualize a lista.",
        ));
    }

    sqlx::query("INSERT INTO delivery_batches (id, technician_id, notes) VALUES ($1, $2, $3)")
        .bind(input.client_batch_id)
        .bind(technician)
        .bind(notes)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO delivery_batch_items (batch_id, technician_id, capture_id, added_by)
         SELECT $1, $2, unnest($3::uuid[]), $2",
    )
    .bind(input.client_batch_id)
    .bind(technician)
    .bind(&captures)
    .execute(&mut *tx)
    .await?;
    audit(
        &mut tx,
        technician,
        "BATCH_SUBMITTED",
        "delivery_batch",
        input.client_batch_id,
        None,
        json!({"captures": captures, "notes": notes}),
    )
    .await?;
    let detail = detail_json(&mut tx, input.client_batch_id).await?;
    tx.commit().await?;
    Ok(Json(detail))
}

pub async fn cancel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, technician) = authorize(&state.db, &headers, Role::Technician).await?;
    let id = parse_id(&id)?;
    match owned_batch(&mut tx, id, technician, true).await?.as_str() {
        "SUBMITTED" => {
            sqlx::query(
                "UPDATE delivery_batches SET status = 'CANCELLED', finished_at = now() WHERE id = $1",
            )
            .bind(id)
            .execute(&mut *tx)
            .await?;
            release_items(&mut tx, id).await?;
            audit(
                &mut tx,
                technician,
                "BATCH_CANCELLED",
                "delivery_batch",
                id,
                Some(json!({"status": "SUBMITTED"})),
                json!({"status": "CANCELLED"}),
            )
            .await?;
        }
        "CANCELLED" => {}
        _ => {
            return Err(conflict(
                "BATCH_IN_RECEIPT",
                "O estoque já iniciou a conferência deste lote.",
            ));
        }
    }
    let detail = detail_json(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(detail))
}

pub(crate) async fn release_items(db: &mut PgConnection, batch: Uuid) -> Result<(), ApiError> {
    sqlx::query("UPDATE delivery_batch_items SET active = false WHERE batch_id = $1 AND active")
        .bind(batch)
        .execute(db)
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Estoque
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct TechnicianQuery {
    search: Option<String>,
}

#[derive(Serialize, sqlx::FromRow)]
struct TechnicianSummary {
    id: Uuid,
    name: String,
    login: String,
    active: bool,
    in_custody: i64,
    unidentified: i64,
    open_batches: i64,
    oldest_pending_at: Option<DateTime<Utc>>,
}

pub async fn technicians_summary(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: Result<Query<TechnicianQuery>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, _) = authorize_receive(&state, &headers).await?;
    let query = checked_query(query)?;
    let search = query.search.as_deref().unwrap_or_default().trim();
    if search.len() > 120 || search.chars().any(char::is_control) {
        return Err(ApiError::invalid("Busca inválida."));
    }
    let rows: Vec<TechnicianSummary> = sqlx::query_as(
        "SELECT u.id, u.name, u.login, u.active,
            (SELECT count(*) FROM equipment e WHERE e.technician_id = u.id) AS in_custody,
            (SELECT count(*) FROM captures c WHERE c.technician_id = u.id AND c.equipment_id IS NULL) AS unidentified,
            (SELECT count(*) FROM delivery_batches b WHERE b.technician_id = u.id
                AND b.status IN ('SUBMITTED', 'RECEIVING')) AS open_batches,
            (SELECT min(c.captured_at_device) FROM captures c LEFT JOIN equipment e ON e.id = c.equipment_id
              WHERE c.technician_id = u.id AND (c.equipment_id IS NULL OR e.technician_id = u.id)) AS oldest_pending_at
         FROM users u WHERE u.role = 'technician' AND u.deleted_at IS NULL
           AND ($1 = '' OR strpos(lower(u.name), lower($1)) > 0 OR strpos(u.login, lower($1)) > 0)
         ORDER BY u.active DESC, lower(u.name), u.id LIMIT 200",
    )
    .bind(search)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"items": rows})))
}

pub async fn technician_custody(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, _) = authorize_receive(&state, &headers).await?;
    let technician = parse_id(&id)?;
    require_technician(&mut tx, technician).await?;
    let items = custody(&mut tx, technician).await?;
    tx.commit().await?;
    Ok(Json(json!({"items": items})))
}

pub async fn warehouse_batches(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: Result<Query<ListQuery>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, _) = authorize_receive(&state, &headers).await?;
    let page = list_batches(&mut tx, None, checked_query(query)?).await?;
    tx.commit().await?;
    Ok(Json(page))
}

pub async fn warehouse_batch(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, _) = authorize_receive(&state, &headers).await?;
    let detail = detail_json(&mut tx, parse_id(&id)?).await?;
    tx.commit().await?;
    Ok(Json(detail))
}

#[derive(Deserialize)]
pub struct ReceiveInput {
    client_session_id: Uuid,
}

/// Abre (ou retoma) a conferência de um lote. Idempotente pela chave da sessão.
pub async fn receive(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Body(input): Body<ReceiveInput>,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, actor) = authorize_receive(&state, &headers).await?;
    let id = parse_id(&id)?;
    let (technician, status, session): (Uuid, String, Option<Uuid>) = sqlx::query_as(
        "SELECT technician_id, status, receipt_session_id FROM delivery_batches WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(ApiError::missing)?;
    let session = match (status.as_str(), session) {
        ("SUBMITTED", _) => {
            let session = receipts::open_batch_session(
                &mut tx,
                actor,
                technician,
                id,
                input.client_session_id,
            )
            .await?;
            sqlx::query(
                "UPDATE delivery_batches SET status = 'RECEIVING', receipt_session_id = $1 WHERE id = $2",
            )
            .bind(session)
            .bind(id)
            .execute(&mut *tx)
            .await?;
            audit(
                &mut tx,
                actor,
                "BATCH_RECEIPT_STARTED",
                "delivery_batch",
                id,
                Some(json!({"status": "SUBMITTED"})),
                json!({"status": "RECEIVING", "receipt_session_id": session}),
            )
            .await?;
            session
        }
        ("RECEIVING", Some(session)) => {
            let clerk: Uuid =
                sqlx::query_scalar("SELECT clerk_id FROM receipt_sessions WHERE id = $1")
                    .bind(session)
                    .fetch_one(&mut *tx)
                    .await?;
            if clerk != actor {
                return Err(conflict(
                    "BATCH_IN_PROGRESS",
                    "Este lote já está em conferência com outro estoquista.",
                ));
            }
            session
        }
        ("CANCELLED", _) => {
            return Err(conflict("BATCH_CANCELLED", "O técnico cancelou este lote."));
        }
        _ => {
            return Err(conflict(
                "BATCH_CLOSED",
                "A conferência deste lote já foi encerrada.",
            ));
        }
    };
    let batch = summary(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(json!({"batch": batch, "receipt_session_id": session})))
}
