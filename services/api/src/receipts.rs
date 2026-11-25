use axum::{
    Json,
    extract::{Path, Query, State, rejection::QueryRejection},
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgConnection, Postgres, Transaction};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{Role, audit, authorize_roles, parse_id},
    custody::{normalize_mac, normalize_serial},
    error::{ApiError, Body},
};

const PILOT_WAREHOUSE: Uuid = Uuid::from_u128(0x00000000_0000_4000_8000_000000000001);

pub(crate) async fn authorize_receive<'a>(
    state: &'a AppState,
    headers: &HeaderMap,
) -> Result<(Transaction<'a, Postgres>, Uuid), ApiError> {
    authorize_roles(
        &state.db,
        headers,
        &[Role::WarehouseClerk, Role::Administrator],
    )
    .await
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct Session {
    id: Uuid,
    technician_id: Uuid,
    technician_name: String,
    technician_whatsapp: Option<String>,
    warehouse_id: Uuid,
    warehouse_name: String,
    opened_at: DateTime<Utc>,
    closed_at: Option<DateTime<Utc>>,
    closing_reason: Option<String>,
    batch_id: Option<Uuid>,
    batch_number: Option<i64>,
    batch_notes: Option<String>,
}

const SESSION_FIELDS: &str = "s.id, s.technician_id, u.name AS technician_name,
    u.whatsapp AS technician_whatsapp, s.warehouse_id,
    w.name AS warehouse_name, s.opened_at, s.closed_at, s.closing_reason,
    b.id AS batch_id, b.number AS batch_number, b.notes AS batch_notes";
const SESSION_FROM: &str = "receipt_sessions s JOIN users u ON s.technician_id = u.id
    JOIN locations w ON s.warehouse_id = w.id
    LEFT JOIN delivery_batches b ON b.receipt_session_id = s.id";

async fn session(db: &mut PgConnection, actor: Uuid, id: Uuid) -> Result<Session, ApiError> {
    sqlx::query_as(&format!(
        "SELECT {SESSION_FIELDS} FROM {SESSION_FROM}
         WHERE s.id = $1 AND s.clerk_id = $2 AND s.warehouse_id = $3 FOR UPDATE OF s"
    ))
    .bind(id)
    .bind(actor)
    .bind(PILOT_WAREHOUSE)
    .fetch_optional(db)
    .await?
    .ok_or_else(ApiError::missing)
}

fn open_only(session: &Session) -> Result<(), ApiError> {
    if session.closed_at.is_some() {
        return Err(conflict("SESSION_CLOSED", "A sessão já está encerrada."));
    }
    Ok(())
}

pub(crate) fn conflict(code: &'static str, message: &'static str) -> ApiError {
    ApiError(StatusCode::CONFLICT, code, message)
}

pub(crate) fn limit(value: Option<i64>) -> Result<i64, ApiError> {
    let limit = value.unwrap_or(25);
    if !(1..=100).contains(&limit) {
        return Err(ApiError::invalid("Use um limite de 1 a 100 registros."));
    }
    Ok(limit)
}

pub(crate) fn checked_query<T>(query: Result<Query<T>, QueryRejection>) -> Result<T, ApiError> {
    query
        .map(|Query(value)| value)
        .map_err(|_| ApiError::invalid("Parâmetros de consulta inválidos."))
}

#[derive(Deserialize)]
pub struct PickerQuery {
    search: Option<String>,
    after: Option<Uuid>,
    limit: Option<i64>,
}

pub async fn technicians(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: Result<Query<PickerQuery>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, _) = authorize_receive(&state, &headers).await?;
    let query = checked_query(query)?;
    let value = query.search.as_deref().unwrap_or_default().trim();
    if value.len() > 120 || value.chars().any(char::is_control) {
        return Err(ApiError::invalid("Busca inválida."));
    }
    let limit = limit(query.limit)? as usize;
    let mut users: Vec<(Uuid, String, String, i64)> = sqlx::query_as(
        "SELECT id, name, login, (SELECT count(*) FROM equipment WHERE technician_id = users.id) AS pending_count FROM users WHERE role = 'technician'
            AND ($2::uuid IS NULL OR id > $2)
            AND ($1 = '' OR strpos(lower(name), lower($1)) > 0 OR strpos(login, lower($1)) > 0)
         ORDER BY id LIMIT $3",
    )
    .bind(value)
    .bind(query.after)
    .bind(limit as i64 + 1)
    .fetch_all(&mut *tx)
    .await?;
    let more = users.len() > limit;
    users.truncate(limit);
    let cursor = users.last().filter(|_| more).map(|row| row.0);
    let items: Vec<_> = users
        .into_iter()
        .map(|(id, name, login, pending_count)| json!({"id":id,"name":name,"login":login,"pending_count":pending_count}))
        .collect();
    tx.commit().await?;
    Ok(Json(json!({"items":items,"next_cursor":cursor})))
}

#[derive(Deserialize)]
pub struct ListQuery {
    after: Option<Uuid>,
    limit: Option<i64>,
    status: Option<String>,
}

pub async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: Result<Query<ListQuery>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, actor) = authorize_receive(&state, &headers).await?;
    let query = checked_query(query)?;
    let limit = limit(query.limit)? as usize;
    let closed = match query.status.as_deref().unwrap_or("all") {
        "all" => None,
        "open" => Some(false),
        "closed" => Some(true),
        _ => return Err(ApiError::invalid("Filtro de sessão inválido.")),
    };
    let mut items: Vec<Session> = sqlx::query_as(&format!(
        "SELECT {SESSION_FIELDS} FROM {SESSION_FROM}
         WHERE s.clerk_id = $1 AND s.warehouse_id = $2 AND ($3::bool IS NULL OR (s.closed_at IS NOT NULL) = $3)
           AND ($4::uuid IS NULL OR (s.opened_at, s.id) <
               (SELECT opened_at, id FROM receipt_sessions WHERE id = $4 AND clerk_id = $1 AND warehouse_id = $2))
         ORDER BY s.opened_at DESC, s.id DESC LIMIT $5"
    )).bind(actor).bind(PILOT_WAREHOUSE).bind(closed).bind(query.after)
        .bind(limit as i64 + 1).fetch_all(&mut *tx).await?;
    let more = items.len() > limit;
    items.truncate(limit);
    let cursor = items.last().filter(|_| more).map(|row| row.id);
    tx.commit().await?;
    Ok(Json(json!({"items":items,"next_cursor":cursor})))
}

#[derive(Deserialize)]
pub struct OpenInput {
    client_session_id: Uuid,
    technician_id: Uuid,
}

pub async fn open(
    State(state): State<AppState>,
    headers: HeaderMap,
    Body(input): Body<OpenInput>,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, actor) = authorize_receive(&state, &headers).await?;
    let exists: bool = sqlx::query_scalar(
        // FOR SHARE serializa com a troca de perfil da conta, que bloqueia a linha.
        "SELECT EXISTS (SELECT 1 FROM users WHERE id = $1 AND role = 'technician' FOR SHARE)",
    )
    .bind(input.technician_id)
    .fetch_one(&mut *tx)
    .await?;
    if !exists {
        return Err(ApiError::missing());
    }
    let created = sqlx::query(
        "INSERT INTO receipt_sessions (id, technician_id, warehouse_id, clerk_id)
         VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING",
    )
    .bind(input.client_session_id)
    .bind(input.technician_id)
    .bind(PILOT_WAREHOUSE)
    .bind(actor)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        == 1;
    let session = session(&mut tx, actor, input.client_session_id).await?;
    if session.technician_id != input.technician_id {
        return Err(conflict(
            "SESSION_KEY_CONFLICT",
            "Esta chave já foi usada para outra sessão.",
        ));
    }
    if created {
        let expected = sqlx::query(
            "INSERT INTO receipt_items (session_id, equipment_id)
             SELECT $1, id FROM equipment WHERE technician_id = $2",
        )
        .bind(session.id)
        .bind(session.technician_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        audit(&mut tx, actor, "RECEIPT_OPENED", "receipt_session", session.id, None,
            json!({"technician_id": session.technician_id, "warehouse_id": session.warehouse_id, "expected": expected})).await?;
    }
    tx.commit().await?;
    Ok(Json(json!(session)))
}

/// Cria a sessão de recebimento de um lote com os equipamentos identificados
/// que ainda estão com o técnico. Coletas sem identificação entram pela leitura no balcão.
pub(crate) async fn open_batch_session(
    db: &mut PgConnection,
    actor: Uuid,
    technician: Uuid,
    batch: Uuid,
    session_id: Uuid,
) -> Result<Uuid, ApiError> {
    let created = sqlx::query(
        "INSERT INTO receipt_sessions (id, technician_id, warehouse_id, clerk_id)
         VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING",
    )
    .bind(session_id)
    .bind(technician)
    .bind(PILOT_WAREHOUSE)
    .bind(actor)
    .execute(&mut *db)
    .await?
    .rows_affected()
        == 1;
    if !created {
        return Err(conflict(
            "SESSION_KEY_CONFLICT",
            "Esta chave já foi usada para outra sessão.",
        ));
    }
    let expected = sqlx::query(
        "INSERT INTO receipt_items (session_id, equipment_id)
         SELECT DISTINCT $1::uuid, e.id FROM delivery_batch_items i
            JOIN captures c ON c.id = i.capture_id JOIN equipment e ON e.id = c.equipment_id
         WHERE i.batch_id = $2 AND i.active AND e.technician_id = $3",
    )
    .bind(session_id)
    .bind(batch)
    .bind(technician)
    .execute(&mut *db)
    .await?
    .rows_affected();
    audit(db, actor, "RECEIPT_OPENED", "receipt_session", session_id, None,
        json!({"technician_id": technician, "warehouse_id": PILOT_WAREHOUSE, "expected": expected, "batch_id": batch})).await?;
    Ok(session_id)
}

#[derive(Clone, Copy, PartialEq, Eq, sqlx::Type, Serialize)]
#[sqlx(type_name = "text", rename_all = "SCREAMING_SNAKE_CASE")]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum ScanResult {
    Matched,
    DuplicateScan,
    Unknown,
    Ambiguous,
    OtherTechnician,
    AlreadyReceived,
    NotInSession,
    IdentifierMismatch,
}

#[derive(Serialize, sqlx::FromRow)]
struct Scan {
    id: Uuid,
    equipment_id: Option<Uuid>,
    value: String,
    secondary_value: Option<String>,
    result: ScanResult,
    created_at: DateTime<Utc>,
}

#[derive(Deserialize)]
pub struct ScanInput {
    client_scan_id: Uuid,
    value: String,
    secondary_value: Option<String>,
}

fn validated_code(raw: &str) -> Result<&str, ApiError> {
    let value = raw.trim();
    if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        return Err(ApiError::invalid(
            "Informe um código de até 128 bytes, sem caracteres de controle.",
        ));
    }
    Ok(value)
}

#[derive(PartialEq)]
enum Match {
    Missing,
    Unique(Uuid),
    Ambiguous,
}

async fn code_match(db: &mut PgConnection, value: &str) -> Result<Match, ApiError> {
    let matches: Vec<Uuid> = sqlx::query_scalar(
        "SELECT DISTINCT equipment_id FROM equipment_identifiers
         WHERE (kind = 'SERIAL' AND normalized_value = $1)
            OR (kind = 'MAC' AND normalized_value = $2)
            OR (kind = 'BARCODE' AND normalized_value = $3)
         LIMIT 2",
    )
    .bind(normalize_serial(value))
    .bind(normalize_mac(value).ok())
    .bind(value)
    .fetch_all(db)
    .await?;
    Ok(match matches.as_slice() {
        [] => Match::Missing,
        [id] => Match::Unique(*id),
        _ => Match::Ambiguous,
    })
}

async fn resolve(
    db: &mut PgConnection,
    value: &str,
    secondary: Option<&str>,
) -> Result<Result<Uuid, ScanResult>, ApiError> {
    let first = code_match(db, value).await?;
    let equipment = match first {
        Match::Missing => return Ok(Err(ScanResult::Unknown)),
        Match::Ambiguous => return Ok(Err(ScanResult::Ambiguous)),
        Match::Unique(id) => id,
    };
    if let Some(secondary) = secondary {
        let second = code_match(db, secondary).await?;
        if second == Match::Ambiguous {
            return Ok(Err(ScanResult::Ambiguous));
        }
        if second != first {
            return Ok(Err(ScanResult::IdentifierMismatch));
        }
    }
    Ok(Ok(equipment))
}

#[derive(Deserialize)]
pub struct LookupInput {
    value: String,
}

#[derive(Deserialize)]
pub struct ExceptionQuery {
    after: Option<String>,
}

pub async fn exceptions(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: Result<Query<ExceptionQuery>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, actor) = authorize_receive(&state, &headers).await?;
    let query = checked_query(query)?;
    let mut rows: Vec<(String, String, DateTime<Utc>)> = sqlx::query_as(
        "SELECT value, result, seen_at FROM receipt_exceptions WHERE clerk_id = $1 AND warehouse_id = $2
         AND resolved_at IS NULL AND ($3::text IS NULL OR value > $3) ORDER BY value LIMIT 26"
    ).bind(actor).bind(PILOT_WAREHOUSE).bind(query.after).fetch_all(&mut *tx).await?;
    let more = rows.len() > 25;
    rows.truncate(25);
    let cursor = rows.last().filter(|_| more).map(|row| row.0.clone());
    let items: Vec<_> = rows
        .into_iter()
        .map(
            |(value, result, seen_at)| json!({ "value":value, "result":result, "seen_at":seen_at }),
        )
        .collect();
    tx.commit().await?;
    Ok(Json(json!({"items":items,"next_cursor":cursor})))
}

pub async fn trace_equipment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(input): Query<LookupInput>,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, _) = authorize_receive(&state, &headers).await?;
    let id = match resolve(&mut tx, validated_code(&input.value)?, None).await? {
        Ok(id) => id,
        Err(result) => return Ok(Json(json!({"result":result}))),
    };
    let history: Vec<Value> = sqlx::query_scalar(
        "SELECT jsonb_build_object('type',m.movement_type,'at',m.occurred_at,'holder',coalesce(u.name,l.name))
         FROM custody_movements m LEFT JOIN users u ON u.id = m.to_technician_id
         LEFT JOIN locations l ON l.id = m.to_warehouse_id
         WHERE m.equipment_id = $1 ORDER BY m.occurred_at DESC, m.id DESC"
    ).bind(id).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({"result":"MATCHED","history":history})))
}

pub async fn lookup(
    State(state): State<AppState>,
    headers: HeaderMap,
    Body(input): Body<LookupInput>,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, actor) = authorize_receive(&state, &headers).await?;
    let value = validated_code(&input.value)?;
    let response = match resolve(&mut tx, value, None).await? {
        Err(result) => {
            sqlx::query("INSERT INTO receipt_exceptions (clerk_id, warehouse_id, value, result) VALUES ($1,$2,$3,$4)
                ON CONFLICT (clerk_id, warehouse_id, value) DO UPDATE SET result = EXCLUDED.result, seen_at = now(), resolved_at = NULL")
                .bind(actor).bind(PILOT_WAREHOUSE).bind(value).bind(result).execute(&mut *tx).await?;
            let pending: Vec<(Uuid, String)> = sqlx::query_as(
                "SELECT c.id, u.name FROM captures c JOIN users u ON u.id = c.technician_id
                 JOIN LATERAL (SELECT suggestions FROM ocr_results WHERE capture_id = c.id
                   ORDER BY created_at DESC, id DESC LIMIT 1) o ON TRUE
                 WHERE c.status = 'NEEDS_REVIEW' AND EXISTS (
                   SELECT 1 FROM jsonb_array_elements(o.suggestions) s
                   WHERE (s->>'kind' = 'SERIAL' AND s->>'normalized_value' = $1)
                      OR (s->>'kind' = 'MAC' AND s->>'normalized_value' = $2))
                 ORDER BY c.received_at_server DESC, c.id LIMIT 10",
            )
            .bind(normalize_serial(value))
            .bind(normalize_mac(value).ok())
            .fetch_all(&mut *tx)
            .await?;
            let candidates: Vec<_> = pending
                .into_iter()
                .map(|(id, name)| json!({"capture_id":id,"technician_name":name}))
                .collect();
            json!({"result": result,"review_candidates":candidates})
        }
        Ok(id) => {
            sqlx::query("UPDATE receipt_exceptions SET resolved_at = now() WHERE clerk_id = $1 AND warehouse_id = $2 AND value = $3 AND resolved_at IS NULL")
                .bind(actor).bind(PILOT_WAREHOUSE).bind(value).execute(&mut *tx).await?;
            let owner: Option<(Uuid, String)> = sqlx::query_as(
                "SELECT u.id, u.name FROM equipment e JOIN users u ON u.id = e.technician_id WHERE e.id = $1",
            ).bind(id).fetch_optional(&mut *tx).await?;
            if let Some((technician, name)) = owner {
                let session: Option<Uuid> = sqlx::query_scalar(
                    "SELECT s.id FROM receipt_sessions s JOIN receipt_items i ON i.session_id = s.id
                     WHERE s.clerk_id = $1 AND s.warehouse_id = $2 AND s.technician_id = $3
                       AND s.closed_at IS NULL AND i.equipment_id = $4
                     ORDER BY s.opened_at DESC, s.id DESC LIMIT 1",
                ).bind(actor).bind(PILOT_WAREHOUSE).bind(technician).bind(id)
                 .fetch_optional(&mut *tx).await?;
                json!({"result":"MATCHED","equipment_id":id,"technician_id":technician,"technician_name":name,"session_id":session})
            } else {
                json!({"result":"ALREADY_RECEIVED"})
            }
        }
    };
    tx.commit().await?;
    Ok(Json(response))
}

async fn classify(
    db: &mut PgConnection,
    session: &Session,
    id: Uuid,
) -> Result<(ScanResult, Option<Uuid>), ApiError> {
    let (technician, warehouse): (Option<Uuid>, Option<Uuid>) =
        sqlx::query_as("SELECT technician_id, warehouse_id FROM equipment WHERE id = $1")
            .bind(id)
            .fetch_one(&mut *db)
            .await?;
    if warehouse.is_some() {
        return Ok((ScanResult::AlreadyReceived, None));
    }
    if technician != Some(session.technician_id) {
        return Ok((ScanResult::OtherTechnician, None));
    }
    let expected: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM receipt_items WHERE session_id = $1 AND equipment_id = $2)",
    )
    .bind(session.id)
    .bind(id)
    .fetch_one(&mut *db)
    .await?;
    if !expected {
        // Coleta do lote identificada depois da abertura: passa a ser prevista.
        let in_batch: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM delivery_batches b
                JOIN delivery_batch_items i ON i.batch_id = b.id AND i.active
                JOIN captures c ON c.id = i.capture_id
             WHERE b.receipt_session_id = $1 AND c.equipment_id = $2)",
        )
        .bind(session.id)
        .bind(id)
        .fetch_one(&mut *db)
        .await?;
        if !in_batch {
            return Ok((ScanResult::NotInSession, None));
        }
        sqlx::query("INSERT INTO receipt_items (session_id, equipment_id) VALUES ($1, $2)")
            .bind(session.id)
            .bind(id)
            .execute(&mut *db)
            .await?;
    }
    let already_scanned: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM receipt_scans WHERE session_id = $1 AND equipment_id = $2 AND result = 'MATCHED')",
    ).bind(session.id).bind(id).fetch_one(db).await?;
    Ok((
        if already_scanned {
            ScanResult::DuplicateScan
        } else {
            ScanResult::Matched
        },
        Some(id),
    ))
}

pub async fn scan(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Body(input): Body<ScanInput>,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, actor) = authorize_receive(&state, &headers).await?;
    let session = session(&mut tx, actor, parse_id(&id)?).await?;
    let value = validated_code(&input.value)?;
    let secondary = input
        .secondary_value
        .as_deref()
        .map(validated_code)
        .transpose()?;
    let previous: Option<Scan> = sqlx::query_as(
        "SELECT id, equipment_id, value, secondary_value, result, created_at FROM receipt_scans WHERE session_id = $1 AND id = $2",
    ).bind(session.id).bind(input.client_scan_id).fetch_optional(&mut *tx).await?;
    if let Some(previous) = previous {
        if previous.value != value || previous.secondary_value.as_deref() != secondary {
            return Err(conflict(
                "SCAN_KEY_CONFLICT",
                "Esta chave já foi usada para outra leitura.",
            ));
        }
        let body = scan_body(&mut tx, &session, previous).await?;
        tx.commit().await?;
        return Ok(Json(body));
    }
    open_only(&session)?;
    let (result, equipment) = match resolve(&mut tx, value, secondary).await? {
        Ok(id) => classify(&mut tx, &session, id).await?,
        Err(result) => (result, None),
    };
    let scan: Scan = sqlx::query_as(
        "INSERT INTO receipt_scans (session_id, id, value, secondary_value, equipment_id, result)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, equipment_id, value, secondary_value, result, created_at",
    ).bind(session.id).bind(input.client_scan_id).bind(value).bind(secondary).bind(equipment)
        .bind(result).fetch_one(&mut *tx).await?;
    let body = scan_body(&mut tx, &session, scan).await?;
    tx.commit().await?;
    Ok(Json(body))
}

/// Para um código desconhecido num lote, aponta as coletas ainda sem identificação
/// cuja leitura sugerida (OCR ou código lido no celular) coincide com o bipe.
async fn scan_body(
    db: &mut PgConnection,
    session: &Session,
    scan: Scan,
) -> Result<Value, ApiError> {
    let mut body = json!(scan);
    if scan.result == ScanResult::Unknown && session.batch_id.is_some() {
        let candidates: Vec<Uuid> = sqlx::query_scalar(
            "SELECT c.id FROM delivery_batch_items i JOIN captures c ON c.id = i.capture_id
             WHERE i.batch_id = $1 AND i.active AND c.equipment_id IS NULL AND (
                upper(btrim(c.barcode_evidence->>'raw_value')) = $2
                OR upper(regexp_replace(btrim(c.barcode_evidence->>'raw_value'), '[:-]', '', 'g')) = $3
                OR EXISTS (SELECT 1 FROM jsonb_array_elements((SELECT o.suggestions FROM ocr_results o
                    WHERE o.capture_id = c.id ORDER BY o.created_at DESC, o.id DESC LIMIT 1)) s
                  WHERE (s->>'kind' = 'SERIAL' AND s->>'normalized_value' = $2)
                     OR (s->>'kind' = 'MAC' AND s->>'normalized_value' = $3)))
             ORDER BY c.captured_at_device, c.id LIMIT 10",
        )
        .bind(session.batch_id)
        .bind(normalize_serial(&scan.value))
        .bind(normalize_mac(&scan.value).ok())
        .fetch_all(db)
        .await?;
        body["capture_candidates"] = json!(candidates);
    }
    Ok(body)
}

#[derive(Deserialize)]
pub struct ConfirmInput {
    equipment_id: Uuid,
    scan_id: Uuid,
    inspection: Inspection,
}

#[derive(Deserialize, Serialize)]
struct Inspection {
    power_supply: PowerSupply,
    cables_present: bool,
    condition: Condition,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum PowerSupply {
    Original,
    Replacement,
    Missing,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum Condition {
    Good,
    Damaged,
    Inoperative,
}

#[derive(Serialize, sqlx::FromRow)]
struct Confirmation {
    equipment_id: Uuid,
    scan_id: Uuid,
    movement_id: Uuid,
    confirmed_at: DateTime<Utc>,
}

pub async fn confirm(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Body(input): Body<ConfirmInput>,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, actor) = authorize_receive(&state, &headers).await?;
    let session = session(&mut tx, actor, parse_id(&id)?).await?;
    let previous: Option<Confirmation> = sqlx::query_as(
        "SELECT m.equipment_id, m.receipt_scan_id AS scan_id, m.id AS movement_id, i.confirmed_at
         FROM receipt_items i JOIN custody_movements m ON m.receipt_session_id = i.session_id AND m.equipment_id = i.equipment_id
         WHERE i.session_id = $1 AND i.equipment_id = $2",
    ).bind(session.id).bind(input.equipment_id).fetch_optional(&mut *tx).await?;
    if let Some(previous) = previous {
        if previous.scan_id != input.scan_id {
            return Err(conflict(
                "ITEM_ALREADY_CONFIRMED",
                "O equipamento já foi confirmado nesta sessão.",
            ));
        }
        tx.commit().await?;
        return Ok(Json(json!(previous)));
    }
    open_only(&session)?;
    let confirmation = receive_item(
        &mut tx,
        actor,
        &session,
        input.equipment_id,
        input.scan_id,
        &input.inspection,
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!(confirmation)))
}

/// Transfere a custódia de um item previsto e lido nesta sessão.
async fn receive_item(
    db: &mut PgConnection,
    actor: Uuid,
    session: &Session,
    equipment_id: Uuid,
    scan_id: Uuid,
    inspection: &Inspection,
) -> Result<Confirmation, ApiError> {
    let tx = db;
    let scan: Scan = sqlx::query_as(
        "SELECT id, equipment_id, value, secondary_value, result, created_at FROM receipt_scans
         WHERE session_id = $1 AND id = $2 AND equipment_id = $3 AND result = 'MATCHED'",
    )
    .bind(session.id)
    .bind(scan_id)
    .bind(equipment_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| {
        conflict(
            "SCAN_NOT_MATCHED",
            "Confirme um equipamento que tenha uma leitura correspondente nesta sessão.",
        )
    })?;

    sqlx::query("LOCK TABLE equipment_identifiers IN SHARE MODE")
        .execute(&mut *tx)
        .await?;
    let (current_technician, current_warehouse): (Option<Uuid>, Option<Uuid>) = sqlx::query_as(
        "SELECT technician_id, warehouse_id FROM equipment WHERE id = $1 FOR UPDATE",
    )
    .bind(equipment_id)
    .fetch_one(&mut *tx)
    .await?;
    if current_warehouse.is_some() {
        return Err(conflict(
            "ALREADY_RECEIVED",
            "O equipamento já foi recebido.",
        ));
    }
    if current_technician != Some(session.technician_id) {
        return Err(conflict(
            "OTHER_TECHNICIAN",
            "O equipamento está sob custódia de outro técnico.",
        ));
    }
    if resolve(tx, &scan.value, scan.secondary_value.as_deref()).await? != Ok(equipment_id) {
        return Err(conflict(
            "IDENTIFIER_MISMATCH",
            "Os identificadores divergiram. Preserve a custódia e registre uma ocorrência.",
        ));
    }

    let confirmed_at: DateTime<Utc> = sqlx::query_scalar(
        "UPDATE receipt_items SET confirmed_scan_id = $1, confirmed_at = now(), inspection = $4
         WHERE session_id = $2 AND equipment_id = $3 RETURNING confirmed_at",
    )
    .bind(scan_id)
    .bind(session.id)
    .bind(equipment_id)
    .bind(json!(inspection))
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query("UPDATE equipment SET technician_id = NULL, warehouse_id = $1 WHERE id = $2")
        .bind(session.warehouse_id)
        .bind(equipment_id)
        .execute(&mut *tx)
        .await?;
    let movement_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO custody_movements (id, equipment_id, from_technician_id, to_warehouse_id, actor_id,
             movement_type, receipt_session_id, receipt_scan_id)
         VALUES ($1, $2, $3, $4, $5, 'WAREHOUSE_RECEIVED', $6, $7)",
    ).bind(movement_id).bind(equipment_id).bind(session.technician_id)
        .bind(session.warehouse_id).bind(actor).bind(session.id).bind(scan_id).execute(&mut *tx).await?;
    audit(tx, actor, "WAREHOUSE_RECEIVED", "equipment", equipment_id,
        Some(json!({"technician_id":session.technician_id})),
        json!({"warehouse_id":session.warehouse_id,"movement_id":movement_id,"session_id":session.id,"scan_id":scan_id,"inspection":inspection,"batch_id":session.batch_id})).await?;
    Ok(Confirmation {
        movement_id,
        equipment_id,
        scan_id,
        confirmed_at,
    })
}

#[derive(Serialize, sqlx::FromRow)]
struct Totals {
    expected: i64,
    confirmed: i64,
    missing: i64,
    duplicates: i64,
    divergences: i64,
    unidentified: i64,
}

async fn totals(db: &mut PgConnection, id: Uuid) -> Result<Totals, ApiError> {
    Ok(sqlx::query_as(
        "SELECT count(*) AS expected, count(confirmed_at) AS confirmed,
            count(*) FILTER (WHERE confirmed_at IS NULL) AS missing,
            (SELECT count(*) FROM receipt_scans WHERE session_id = $1 AND result = 'DUPLICATE_SCAN') AS duplicates,
            (SELECT count(*) FROM receipt_scans WHERE session_id = $1 AND result NOT IN ('MATCHED','DUPLICATE_SCAN')) AS divergences,
            (SELECT count(*) FROM delivery_batches b JOIN delivery_batch_items bi ON bi.batch_id = b.id
                JOIN captures c ON c.id = bi.capture_id
              WHERE b.receipt_session_id = $1 AND c.equipment_id IS NULL) AS unidentified
         FROM receipt_items WHERE session_id = $1",
    ).bind(id).fetch_one(db).await?)
}

#[derive(Deserialize)]
pub struct DetailQuery {
    after_item: Option<Uuid>,
    after_scan: Option<Uuid>,
    limit: Option<i64>,
}

#[derive(Serialize, sqlx::FromRow)]
struct Item {
    equipment_id: Uuid,
    matched_scan_id: Option<Uuid>,
    confirmed_at: Option<DateTime<Utc>>,
    identifiers: Value,
    inspection: Option<Value>,
}

async fn list_items(
    db: &mut PgConnection,
    session_id: Uuid,
    after: Option<Uuid>,
    exact: Option<Uuid>,
    limit: i64,
) -> Result<Vec<Item>, ApiError> {
    Ok(sqlx::query_as(
        "SELECT i.equipment_id, i.confirmed_at, i.inspection, s.id AS matched_scan_id,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', kind, 'raw_value', raw_value)
              ORDER BY kind, normalized_value) FROM equipment_identifiers WHERE equipment_id = i.equipment_id), '[]'::jsonb) AS identifiers
         FROM receipt_items i LEFT JOIN receipt_scans s ON s.session_id = i.session_id
            AND s.equipment_id = i.equipment_id AND s.result = 'MATCHED'
         WHERE i.session_id = $1 AND ($2::uuid IS NULL OR i.equipment_id > $2)
           AND ($3::uuid IS NULL OR i.equipment_id = $3)
         ORDER BY i.equipment_id LIMIT $4",
    ).bind(session_id).bind(after).bind(exact).bind(limit).fetch_all(db).await?)
}

pub async fn get_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, equipment)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, actor) = authorize_receive(&state, &headers).await?;
    let session = session(&mut tx, actor, parse_id(&id)?).await?;
    let item = list_items(&mut tx, session.id, None, Some(parse_id(&equipment)?), 1)
        .await?
        .pop()
        .ok_or_else(ApiError::missing)?;
    tx.commit().await?;
    Ok(Json(json!(item)))
}

pub async fn detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    query: Result<Query<DetailQuery>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, actor) = authorize_receive(&state, &headers).await?;
    let session = session(&mut tx, actor, parse_id(&id)?).await?;
    let query = checked_query(query)?;
    let limit = limit(query.limit)? as usize;
    let totals = totals(&mut tx, session.id).await?;
    let mut items = list_items(
        &mut tx,
        session.id,
        query.after_item,
        None,
        limit as i64 + 1,
    )
    .await?;
    let mut scans: Vec<Scan> = sqlx::query_as(
        "SELECT id, equipment_id, value, secondary_value, result, created_at FROM receipt_scans
         WHERE session_id = $1 AND ($2::uuid IS NULL OR (created_at, id) <
           (SELECT created_at,id FROM receipt_scans WHERE session_id = $1 AND id = $2))
         ORDER BY created_at DESC, id DESC LIMIT $3",
    )
    .bind(session.id)
    .bind(query.after_scan)
    .bind(limit as i64 + 1)
    .fetch_all(&mut *tx)
    .await?;
    let more_items = items.len() > limit;
    let more_scans = scans.len() > limit;
    items.truncate(limit);
    scans.truncate(limit);
    let next_item = items
        .last()
        .filter(|_| more_items)
        .map(|item| item.equipment_id);
    let next_scan = scans.last().filter(|_| more_scans).map(|scan| scan.id);
    let unidentified: Vec<Value> = sqlx::query_scalar(
        "SELECT jsonb_build_object('capture_id', c.id, 'captured_at', c.captured_at_device,
            'typed_code', c.barcode_evidence->>'raw_value', 'complement', c.complement,
            'suggestions', COALESCE((SELECT o.suggestions FROM ocr_results o WHERE o.capture_id = c.id
                ORDER BY o.created_at DESC, o.id DESC LIMIT 1), '[]'::jsonb))
         FROM delivery_batches b JOIN delivery_batch_items i ON i.batch_id = b.id
            JOIN captures c ON c.id = i.capture_id
         WHERE b.receipt_session_id = $1 AND c.equipment_id IS NULL
         ORDER BY c.captured_at_device, c.id LIMIT 200",
    )
    .bind(session.id)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(
        json!({"session":session,"totals":totals,"items":items,"scans":scans,"next_item":next_item,"next_scan":next_scan,"unidentified":unidentified}),
    ))
}

#[derive(Deserialize)]
pub struct CloseInput {
    reason: Option<String>,
}

pub async fn close(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Body(input): Body<CloseInput>,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, actor) = authorize_receive(&state, &headers).await?;
    let mut session = session(&mut tx, actor, parse_id(&id)?).await?;
    if session.closed_at.is_none() {
        let counts = totals(&mut tx, session.id).await?;
        let reason = input
            .reason
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if reason.is_some_and(|reason| reason.chars().count() > 500 || reason.contains('\0')) {
            return Err(ApiError::invalid(
                "Use uma justificativa de até 500 caracteres.",
            ));
        }
        if (counts.missing > 0 || counts.divergences > 0 || counts.unidentified > 0)
            && reason.is_none()
        {
            return Err(conflict(
                "UNRESOLVED_RECEIPT",
                "Informe o motivo do encerramento com faltantes ou divergências.",
            ));
        }
        session.closed_at = Some(sqlx::query_scalar(
            "UPDATE receipt_sessions SET closed_at = now(), closing_reason = $1 WHERE id = $2 RETURNING closed_at",
        ).bind(reason).bind(session.id).fetch_one(&mut *tx).await?);
        session.closing_reason = reason.map(str::to_owned);
        if let Some(batch) = session.batch_id {
            // Itens não recebidos continuam com o técnico e podem ir para um novo lote.
            sqlx::query(
                "UPDATE delivery_batches SET status = 'CLOSED', finished_at = $1 WHERE id = $2",
            )
            .bind(session.closed_at)
            .bind(batch)
            .execute(&mut *tx)
            .await?;
            crate::batches::release_items(&mut tx, batch).await?;
        }
        audit(
            &mut tx,
            actor,
            "RECEIPT_CLOSED",
            "receipt_session",
            session.id,
            None,
            json!({"totals":counts,"reason":reason,"closed_at":session.closed_at}),
        )
        .await?;
    }
    tx.commit().await?;
    Ok(Json(json!(session)))
}

pub async fn image_url(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, equipment)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, actor) = authorize_receive(&state, &headers).await?;
    let session = session(&mut tx, actor, parse_id(&id)?).await?;
    let equipment = parse_id(&equipment)?;
    let key: String = sqlx::query_scalar(
        "SELECT c.image_object_key FROM captures c
         WHERE c.equipment_id = $1 AND c.technician_id = $2 AND c.status = 'IDENTIFIED'
           AND EXISTS (SELECT 1 FROM receipt_scans WHERE session_id = $3 AND equipment_id = $1 AND result = 'MATCHED')
         ORDER BY c.received_at_server DESC, c.id DESC LIMIT 1",
    ).bind(equipment).bind(session.technician_id).bind(session.id)
        .fetch_optional(&mut *tx).await?.ok_or_else(ApiError::missing)?;
    let url = state
        .storage
        .read_url(&key)
        .await
        .map_err(|_| ApiError::internal())?;
    tx.commit().await?;
    Ok(Json(json!({"url":url,"expires_in":120})))
}

async fn batch_capture(
    db: &mut PgConnection,
    session: &Session,
    capture: Uuid,
) -> Result<(), ApiError> {
    let member: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM delivery_batch_items WHERE batch_id = $1 AND capture_id = $2)",
    )
    .bind(session.batch_id)
    .bind(capture)
    .fetch_one(db)
    .await?;
    if session.batch_id.is_none() || !member {
        return Err(ApiError::missing());
    }
    Ok(())
}

/// Foto de uma coleta do lote, para o estoquista comparar com o equipamento físico.
pub async fn capture_image_url(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, capture)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, actor) = authorize_receive(&state, &headers).await?;
    let session = session(&mut tx, actor, parse_id(&id)?).await?;
    let capture = parse_id(&capture)?;
    batch_capture(&mut tx, &session, capture).await?;
    let key: String = sqlx::query_scalar("SELECT image_object_key FROM captures WHERE id = $1")
        .bind(capture)
        .fetch_one(&mut *tx)
        .await?;
    let url = state
        .storage
        .read_url(&key)
        .await
        .map_err(|_| ApiError::internal())?;
    tx.commit().await?;
    Ok(Json(json!({"url":url,"expires_in":120})))
}

#[derive(Deserialize)]
pub struct IdentifyInput {
    scan_id: Uuid,
    capture_id: Uuid,
    identifiers: Vec<crate::custody::SubmittedIdentifier>,
    inspection: Inspection,
}

fn same_code(kind: &str, scanned: &str, normalized: &str) -> bool {
    match kind {
        "SERIAL" => normalize_serial(scanned) == normalized,
        "MAC" => normalize_mac(scanned.trim()).is_ok_and(|value| value == normalized),
        _ => scanned.trim() == normalized,
    }
}

/// Identifica no balcão uma coleta do lote que ainda não tinha identificação e,
/// na mesma transação, confirma o recebimento físico. O código bipado precisa
/// estar entre os identificadores; a validação de identidade é a mesma da revisão.
pub async fn identify(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Body(input): Body<IdentifyInput>,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, actor) = authorize_receive(&state, &headers).await?;
    let session = session(&mut tx, actor, parse_id(&id)?).await?;
    batch_capture(&mut tx, &session, input.capture_id).await?;
    let capture = crate::custody::lock_capture(&mut tx, input.capture_id)
        .await?
        .ok_or_else(ApiError::missing)?;
    if let Some(equipment) = capture.equipment_id {
        let previous: Option<Confirmation> = sqlx::query_as(
            "SELECT m.equipment_id, m.receipt_scan_id AS scan_id, m.id AS movement_id, i.confirmed_at
             FROM receipt_items i JOIN custody_movements m ON m.receipt_session_id = i.session_id
                AND m.equipment_id = i.equipment_id
             WHERE i.session_id = $1 AND i.equipment_id = $2",
        )
        .bind(session.id)
        .bind(equipment)
        .fetch_optional(&mut *tx)
        .await?;
        tx.commit().await?;
        return match previous {
            Some(previous) => Ok(Json(json!({"result":"RECEIVED","confirmation":previous}))),
            None => Err(conflict(
                "ALREADY_IDENTIFIED",
                "A coleta já foi identificada. Bipe o equipamento novamente.",
            )),
        };
    }
    open_only(&session)?;
    let scan: Scan = sqlx::query_as(
        "SELECT id, equipment_id, value, secondary_value, result, created_at FROM receipt_scans
         WHERE session_id = $1 AND id = $2 AND result = 'UNKNOWN'",
    )
    .bind(session.id)
    .bind(input.scan_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| {
        conflict(
            "SCAN_NOT_UNKNOWN",
            "Use uma leitura desta sessão com código ainda não cadastrado.",
        )
    })?;
    let identifiers = crate::custody::checked_identifiers(input.identifiers)?;
    if !identifiers
        .iter()
        .any(|item| same_code(&item.kind, &scan.value, &item.normalized_value))
    {
        return Err(ApiError::invalid(
            "Inclua o código bipado entre os identificadores do equipamento.",
        ));
    }
    state
        .storage
        .verify_exists(&capture.image_object_key)
        .await
        .map_err(|_| {
            ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "IMAGE_UNAVAILABLE",
                "Imagem indisponível para validação.",
            )
        })?;
    let evidence = json!(&identifiers);
    let review = crate::custody::validate(
        &mut tx,
        actor,
        &capture,
        identifiers,
        evidence.clone(),
        None,
    )
    .await?;
    let Some(equipment) = review
        .equipment_id
        .filter(|_| review.status == "IDENTIFIED")
    else {
        // Conflito de identidade: a coleta fica em revisão e a custódia não muda.
        tx.commit().await?;
        return Ok(Json(json!({"result":"NEEDS_REVIEW","issue":review.issue})));
    };
    sqlx::query(
        "INSERT INTO receipt_items (session_id, equipment_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    )
    .bind(session.id)
    .bind(equipment)
    .execute(&mut *tx)
    .await?;
    let matched: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM receipt_scans WHERE session_id = $1 AND equipment_id = $2 AND result = 'MATCHED'",
    )
    .bind(session.id)
    .bind(equipment)
    .fetch_optional(&mut *tx)
    .await?;
    let matched = match matched {
        Some(id) => id,
        None => {
            sqlx::query_scalar(
                "INSERT INTO receipt_scans (session_id, id, value, secondary_value, equipment_id, result)
                 VALUES ($1, $2, $3, $4, $5, 'MATCHED') RETURNING id",
            )
            .bind(session.id)
            .bind(Uuid::new_v4())
            .bind(&scan.value)
            .bind(&scan.secondary_value)
            .bind(equipment)
            .fetch_one(&mut *tx)
            .await?
        }
    };
    audit(&mut tx, actor, "CAPTURE_IDENTIFIED_AT_RECEIPT", "capture", capture.id, None,
        json!({"equipment_id":equipment,"session_id":session.id,"unknown_scan_id":scan.id,"scan_id":matched,"identifiers":evidence})).await?;
    let confirmation = receive_item(
        &mut tx,
        actor,
        &session,
        equipment,
        matched,
        &input.inspection,
    )
    .await?;
    tx.commit().await?;
    Ok(Json(
        json!({"result":"RECEIVED","confirmation":confirmation}),
    ))
}

/// Inclui na conferência um equipamento do mesmo técnico que não estava no lote.
/// Não transfere custódia: o item ainda precisa ser bipado e confirmado.
pub async fn include(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Body(input): Body<LookupInput>,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, actor) = authorize_receive(&state, &headers).await?;
    let session = session(&mut tx, actor, parse_id(&id)?).await?;
    open_only(&session)?;
    let equipment = match resolve(&mut tx, validated_code(&input.value)?, None).await? {
        Ok(equipment) => equipment,
        Err(_) => {
            return Err(conflict(
                "NOT_RESOLVED",
                "O código não corresponde a um único equipamento.",
            ));
        }
    };
    let holder: Option<Uuid> =
        sqlx::query_scalar("SELECT technician_id FROM equipment WHERE id = $1 FOR UPDATE")
            .bind(equipment)
            .fetch_one(&mut *tx)
            .await?;
    if holder != Some(session.technician_id) {
        return Err(conflict(
            "OTHER_TECHNICIAN",
            "O equipamento não está sob custódia deste técnico.",
        ));
    }
    let inserted = sqlx::query(
        "INSERT INTO receipt_items (session_id, equipment_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    )
    .bind(session.id)
    .bind(equipment)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        == 1;
    if inserted {
        if let Some(batch) = session.batch_id {
            let other_batch: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM delivery_batch_items i JOIN captures c ON c.id = i.capture_id
                 WHERE i.active AND c.equipment_id = $1 AND i.batch_id <> $2)",
            )
            .bind(equipment)
            .bind(batch)
            .fetch_one(&mut *tx)
            .await?;
            if other_batch {
                return Err(conflict(
                    "ITEM_IN_ANOTHER_BATCH",
                    "O equipamento está em outro lote deste técnico. Confira aquele lote.",
                ));
            }
            sqlx::query(
                "INSERT INTO delivery_batch_items (batch_id, technician_id, capture_id, added_by)
                 SELECT $1, $2, c.id, $3 FROM captures c
                 WHERE c.equipment_id = $4 AND c.technician_id = $2 AND c.status = 'IDENTIFIED'
                 ORDER BY c.received_at_server DESC, c.id LIMIT 1
                 ON CONFLICT DO NOTHING",
            )
            .bind(batch)
            .bind(session.technician_id)
            .bind(actor)
            .bind(equipment)
            .execute(&mut *tx)
            .await?;
        }
        audit(&mut tx, actor, "RECEIPT_ITEM_INCLUDED", "receipt_session", session.id, None,
            json!({"equipment_id":equipment,"batch_id":session.batch_id,"value":input.value.trim()})).await?;
    }
    tx.commit().await?;
    Ok(Json(json!({"equipment_id":equipment})))
}
