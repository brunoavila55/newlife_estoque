//! Chips (SIM cards) da MVNO: importação da planilha da operadora, entrega ao
//! técnico, devolução ao estoque e consulta por ICCID.
//!
//! A custódia de cada chip é a do último movimento registrado. Os dados da
//! operadora (status, assinante, rede) são informativos e nunca movem o chip.

use std::collections::{HashMap, HashSet};

use axum::{
    Json,
    extract::{Path, Query, State, rejection::QueryRejection},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::{
    AppState,
    auth::{Role, audit, authorize, parse_id},
    error::{ApiError, Body, request_id},
    locations::{Scope, require_local_technician, warehouse_scope},
    receipts::{checked_query, conflict, limit},
};

pub const MAX_IMPORT_ROWS: usize = 5000;
pub const MAX_TRANSFER_ITEMS: usize = 500;
pub const IMPORT_BODY_LIMIT: usize = 2 * 1024 * 1024;
pub const TRANSFER_BODY_LIMIT: usize = 64 * 1024;

/// Normaliza um ICCID lido pelo leitor, digitado ou vindo da planilha.
///
/// Aceita espaços e hífens como separadores e o preenchimento `F` final usado
/// por algumas operadoras. Exige o prefixo de telecomunicações `89` e 19 ou 20
/// dígitos; com 20, o último precisa ser o dígito verificador (Luhn).
pub fn normalize_iccid(raw: &str) -> Result<String, &'static str> {
    let compact: String = raw
        .trim()
        .chars()
        .filter(|c| !matches!(c, ' ' | '-'))
        .collect();
    let digits = compact.trim_end_matches(['F', 'f']);
    if digits.is_empty() {
        return Err("ICCID vazio.");
    }
    if !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err("O ICCID deve ter apenas números.");
    }
    if !(19..=20).contains(&digits.len()) {
        return Err("O ICCID deve ter 19 ou 20 dígitos.");
    }
    if !digits.starts_with("89") {
        return Err("O ICCID de um chip começa com 89.");
    }
    if digits.len() == 20 && !luhn_valid(digits) {
        return Err("Dígito verificador inválido. Bipe ou digite novamente.");
    }
    Ok(digits.to_owned())
}

fn luhn_valid(digits: &str) -> bool {
    let sum: u32 = digits
        .bytes()
        .rev()
        .enumerate()
        .map(|(index, byte)| {
            let value = u32::from(byte - b'0');
            if index % 2 == 1 {
                let doubled = value * 2;
                if doubled > 9 { doubled - 9 } else { doubled }
            } else {
                value
            }
        })
        .sum();
    sum.is_multiple_of(10)
}

/// Os 19 primeiros dígitos identificam o chip com ou sem o dígito verificador.
fn prefix(iccid: &str) -> &str {
    &iccid[..19]
}

/// Campo informativo da planilha. Traço ou vazio significam "sem valor".
fn info(value: Option<&str>, max: usize) -> Result<Option<String>, &'static str> {
    let Some(value) = value.map(str::trim) else {
        return Ok(None);
    };
    if value.is_empty() || value.chars().all(|c| c == '-' || c.is_whitespace()) {
        return Ok(None);
    }
    if value.chars().any(char::is_control) {
        return Err("Texto com caracteres de controle.");
    }
    if value.chars().count() > max {
        return Err("Texto longo demais em uma das colunas.");
    }
    Ok(Some(value.to_owned()))
}

// ---------------------------------------------------------------------------
// Importação
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportRow {
    row: u32,
    iccid: String,
    #[serde(default)]
    operator_status: Option<String>,
    #[serde(default)]
    subscriber: Option<String>,
    #[serde(default)]
    carrier: Option<String>,
    #[serde(default)]
    mvno_display: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportInput {
    client_import_id: Uuid,
    file_name: String,
    #[serde(default)]
    dry_run: bool,
    rows: Vec<ImportRow>,
}

#[derive(Clone, PartialEq, Serialize)]
struct Info {
    carrier: Option<String>,
    mvno_display: Option<String>,
    operator_status: Option<String>,
    subscriber: Option<String>,
}

#[derive(sqlx::FromRow)]
struct ExistingCard {
    id: Uuid,
    iccid: String,
    carrier: Option<String>,
    mvno_display: Option<String>,
    operator_status: Option<String>,
    subscriber: Option<String>,
    holder: String,
    holder_location: Option<Uuid>,
}

pub async fn import(
    State(state): State<AppState>,
    headers: HeaderMap,
    Body(input): Body<ImportInput>,
) -> Result<Json<Value>, ApiError> {
    let file_name = input.file_name.trim();
    if !(1..=255).contains(&file_name.chars().count()) || file_name.chars().any(char::is_control) {
        return Err(ApiError::invalid(
            "Informe o nome do arquivo com até 255 caracteres.",
        ));
    }
    if input.rows.is_empty() || input.rows.len() > MAX_IMPORT_ROWS {
        return Err(ApiError::invalid(
            "A planilha precisa ter de 1 a 5000 chips.",
        ));
    }
    let (mut tx, Scope { actor, location }) = warehouse_scope(&state, &headers).await?;
    if !input.dry_run
        && let Some(summary) =
            sqlx::query_scalar::<_, Value>("SELECT summary FROM sim_imports WHERE id = $1")
                .bind(input.client_import_id)
                .fetch_optional(&mut *tx)
                .await?
    {
        tx.commit().await?;
        return Ok(Json(summary));
    }

    // Validação linha a linha. Linhas inválidas não entram e são relatadas.
    let mut invalid = Vec::new();
    let mut seen: HashMap<String, u32> = HashMap::new();
    let mut valid: Vec<(String, Info)> = Vec::new();
    for row in &input.rows {
        let iccid = match normalize_iccid(&row.iccid) {
            Ok(value) => value,
            Err(reason) => {
                invalid.push(json!({"row": row.row, "value": row.iccid.chars().take(40).collect::<String>(), "reason": reason}));
                continue;
            }
        };
        if let Some(first) = seen.get(prefix(&iccid)) {
            invalid.push(json!({"row": row.row, "value": iccid, "reason": format!("Repetido na planilha (linha {first}).")}));
            continue;
        }
        let fields = (|| -> Result<Info, &'static str> {
            Ok(Info {
                carrier: info(row.carrier.as_deref(), 60)?,
                mvno_display: info(row.mvno_display.as_deref(), 60)?,
                operator_status: info(row.operator_status.as_deref(), 60)?,
                subscriber: info(row.subscriber.as_deref(), 200)?,
            })
        })();
        match fields {
            Ok(fields) => {
                seen.insert(prefix(&iccid).to_owned(), row.row);
                valid.push((iccid, fields));
            }
            Err(reason) => invalid.push(json!({"row": row.row, "value": iccid, "reason": reason})),
        }
    }

    // Serializa importações: duas planilhas com o mesmo chip não podem criar dois registros.
    sqlx::query("LOCK TABLE sim_cards IN SHARE ROW EXCLUSIVE MODE")
        .execute(&mut *tx)
        .await?;
    let prefixes: Vec<String> = valid
        .iter()
        .map(|(iccid, _)| prefix(iccid).to_owned())
        .collect();
    let existing: Vec<ExistingCard> = sqlx::query_as(
        "SELECT s.id, s.iccid, s.carrier, s.mvno_display, s.operator_status, s.subscriber,
            coalesce(u.name, l.name) AS holder, coalesce(u.location_id, s.location_id) AS holder_location
         FROM sim_cards s LEFT JOIN users u ON u.id = s.technician_id
         LEFT JOIN locations l ON l.id = s.location_id
         WHERE left(s.iccid, 19) = ANY($1)",
    )
    .bind(&prefixes)
    .fetch_all(&mut *tx)
    .await?;
    let existing: HashMap<String, ExistingCard> = existing
        .into_iter()
        .map(|card| (prefix(&card.iccid).to_owned(), card))
        .collect();

    let mut created: Vec<(Uuid, String, Info)> = Vec::new();
    let mut updated: Vec<(Uuid, String, Info, Info)> = Vec::new();
    let mut unchanged = 0usize;
    let mut other_location = Vec::new();
    for (iccid, fields) in valid {
        match existing.get(prefix(&iccid)) {
            None => created.push((Uuid::new_v4(), iccid, fields)),
            Some(card) => {
                if card.holder_location != Some(location) {
                    other_location.push(json!({"iccid": card.iccid, "holder": card.holder}));
                }
                let before = Info {
                    carrier: card.carrier.clone(),
                    mvno_display: card.mvno_display.clone(),
                    operator_status: card.operator_status.clone(),
                    subscriber: card.subscriber.clone(),
                };
                if before == fields {
                    unchanged += 1;
                } else {
                    updated.push((card.id, card.iccid.clone(), before, fields));
                }
            }
        }
    }
    let location_name: String = sqlx::query_scalar("SELECT name FROM locations WHERE id = $1")
        .bind(location)
        .fetch_one(&mut *tx)
        .await?;
    let summary = json!({
        "import_id": input.client_import_id,
        "dry_run": input.dry_run,
        "file_name": file_name,
        "location_id": location,
        "location_name": location_name,
        "total_rows": input.rows.len(),
        "created": created.len(),
        "updated": updated.len(),
        "unchanged": unchanged,
        "invalid": invalid,
        "other_location_count": other_location.len(),
        "other_location": other_location.iter().take(50).collect::<Vec<_>>(),
        "status_changes": updated.iter().filter(|(_, _, before, after)| before.operator_status != after.operator_status)
            .take(50)
            .map(|(_, iccid, before, after)| json!({"iccid": iccid, "from": before.operator_status, "to": after.operator_status}))
            .collect::<Vec<_>>(),
    });
    if input.dry_run {
        tx.rollback().await?;
        return Ok(Json(summary));
    }

    sqlx::query(
        "INSERT INTO sim_imports (id, location_id, actor_id, file_name, summary) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(input.client_import_id)
    .bind(location)
    .bind(actor)
    .bind(file_name)
    .bind(&summary)
    .execute(&mut *tx)
    .await?;
    if !created.is_empty() {
        let ids: Vec<Uuid> = created.iter().map(|row| row.0).collect();
        let iccids: Vec<String> = created.iter().map(|row| row.1.clone()).collect();
        let column = |pick: fn(&Info) -> &Option<String>| -> Vec<Option<String>> {
            created.iter().map(|row| pick(&row.2).clone()).collect()
        };
        sqlx::query(
            "INSERT INTO sim_cards (id, iccid, carrier, mvno_display, operator_status, subscriber, location_id)
             SELECT id, iccid, carrier, mvno_display, operator_status, subscriber, $7
             FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
                AS t(id, iccid, carrier, mvno_display, operator_status, subscriber)",
        )
        .bind(&ids)
        .bind(&iccids)
        .bind(column(|info| &info.carrier))
        .bind(column(|info| &info.mvno_display))
        .bind(column(|info| &info.operator_status))
        .bind(column(|info| &info.subscriber))
        .bind(location)
        .execute(&mut *tx)
        .await?;
        let movements: Vec<Uuid> = ids.iter().map(|_| Uuid::new_v4()).collect();
        sqlx::query(
            "INSERT INTO sim_movements (id, sim_card_id, movement_type, to_location_id, import_id, actor_id)
             SELECT m, c, 'IMPORTED', $3, $4, $5 FROM unnest($1::uuid[], $2::uuid[]) AS t(m, c)",
        )
        .bind(&movements)
        .bind(&ids)
        .bind(location)
        .bind(input.client_import_id)
        .bind(actor)
        .execute(&mut *tx)
        .await?;
    }
    for (id, _, _, after) in &updated {
        sqlx::query(
            "UPDATE sim_cards SET carrier = $2, mvno_display = $3, operator_status = $4, subscriber = $5,
                updated_at = now() WHERE id = $1",
        )
        .bind(id)
        .bind(&after.carrier)
        .bind(&after.mvno_display)
        .bind(&after.operator_status)
        .bind(&after.subscriber)
        .execute(&mut *tx)
        .await?;
    }
    let changes: Vec<Value> = updated
        .iter()
        .map(|(_, iccid, before, after)| json!({"iccid": iccid, "before": before, "after": after}))
        .collect();
    audit(
        &mut tx,
        actor,
        "SIM_IMPORTED",
        "sim_import",
        input.client_import_id,
        None,
        json!({"summary": summary, "created": created.iter().map(|row| &row.1).collect::<Vec<_>>(), "changes": changes}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(summary))
}

#[derive(Serialize, sqlx::FromRow)]
struct ImportEntry {
    id: Uuid,
    file_name: String,
    actor_name: String,
    location_name: String,
    summary: Value,
    created_at: DateTime<Utc>,
}

pub async fn imports(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, scope) = warehouse_scope(&state, &headers).await?;
    let items: Vec<ImportEntry> = sqlx::query_as(
        "SELECT i.id, i.file_name, u.name AS actor_name, l.name AS location_name, i.summary - 'invalid' - 'other_location' - 'status_changes' AS summary, i.created_at
         FROM sim_imports i JOIN users u ON u.id = i.actor_id JOIN locations l ON l.id = i.location_id
         WHERE i.location_id = $1 ORDER BY i.created_at DESC, i.id DESC LIMIT 20",
    )
    .bind(scope.location)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"items": items})))
}

// ---------------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------------

#[derive(Serialize, sqlx::FromRow)]
struct Card {
    id: Uuid,
    iccid: String,
    carrier: Option<String>,
    mvno_display: Option<String>,
    operator_status: Option<String>,
    subscriber: Option<String>,
    location_id: Option<Uuid>,
    location_name: Option<String>,
    technician_id: Option<Uuid>,
    technician_name: Option<String>,
    /// Cidade de quem está com o chip: o estoque ou a cidade do técnico.
    holder_location_id: Option<Uuid>,
    holder_location_name: Option<String>,
    since: DateTime<Utc>,
}

const CARD_FIELDS: &str =
    "s.id, s.iccid, s.carrier, s.mvno_display, s.operator_status, s.subscriber,
    s.location_id, l.name AS location_name, s.technician_id, u.name AS technician_name,
    coalesce(s.location_id, u.location_id) AS holder_location_id, hl.name AS holder_location_name,
    (SELECT max(m.occurred_at) FROM sim_movements m WHERE m.sim_card_id = s.id) AS since";
const CARD_FROM: &str = "sim_cards s LEFT JOIN locations l ON l.id = s.location_id
    LEFT JOIN users u ON u.id = s.technician_id
    LEFT JOIN locations hl ON hl.id = coalesce(s.location_id, u.location_id)";

#[derive(Deserialize)]
pub struct LookupQuery {
    code: String,
}

/// Resolve um ICCID bipado. Responde também para chips de outra cidade, para
/// que o estoquista saiba onde o chip deveria estar.
pub async fn lookup(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: Result<Query<LookupQuery>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, _) = warehouse_scope(&state, &headers).await?;
    let query = checked_query(query)?;
    if query.code.len() > 64 {
        return Err(ApiError::invalid("Código longo demais."));
    }
    let iccid = match normalize_iccid(&query.code) {
        Ok(value) => value,
        Err(reason) => {
            tx.commit().await?;
            return Ok(Json(json!({"result": "INVALID", "reason": reason})));
        }
    };
    let cards: Vec<Card> = sqlx::query_as(&format!(
        "SELECT {CARD_FIELDS} FROM {CARD_FROM} WHERE left(s.iccid, 19) = $1 LIMIT 2"
    ))
    .bind(prefix(&iccid))
    .fetch_all(&mut *tx)
    .await?;
    let response = match cards.as_slice() {
        [] => json!({"result": "UNKNOWN", "iccid": iccid}),
        [card] => {
            let history: Vec<Value> = sqlx::query_scalar(
                "SELECT jsonb_build_object('type', m.movement_type, 'at', m.occurred_at,
                    'holder', coalesce(tu.name, tl.name), 'actor', a.name, 'transfer_number', t.number)
                 FROM sim_movements m JOIN users a ON a.id = m.actor_id
                 LEFT JOIN users tu ON tu.id = m.to_technician_id
                 LEFT JOIN locations tl ON tl.id = m.to_location_id
                 LEFT JOIN sim_transfers t ON t.id = m.transfer_id
                 WHERE m.sim_card_id = $1 ORDER BY m.seq DESC LIMIT 50",
            )
            .bind(card.id)
            .fetch_all(&mut *tx)
            .await?;
            json!({"result": "FOUND", "card": card, "history": history})
        }
        _ => json!({"result": "AMBIGUOUS", "iccid": iccid}),
    };
    tx.commit().await?;
    Ok(Json(response))
}

#[derive(Deserialize)]
pub struct CardQuery {
    holder: Option<String>,
    technician_id: Option<Uuid>,
    search: Option<String>,
    after: Option<String>,
    limit: Option<i64>,
}

/// Chips da cidade: no estoque, com os técnicos da cidade, ou ambos.
pub async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: Result<Query<CardQuery>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, scope) = warehouse_scope(&state, &headers).await?;
    let query = checked_query(query)?;
    let limit = limit(query.limit)?;
    let holder = query.holder.as_deref().unwrap_or("all");
    if !matches!(holder, "all" | "stock" | "technicians") {
        return Err(ApiError::invalid("Filtro de chips inválido."));
    }
    let search: String = query
        .search
        .as_deref()
        .unwrap_or_default()
        .chars()
        .filter(char::is_ascii_digit)
        .take(20)
        .collect();
    let mut items: Vec<Card> = sqlx::query_as(&format!(
        "SELECT {CARD_FIELDS} FROM {CARD_FROM}
         WHERE coalesce(s.location_id, u.location_id) = $1
           AND ($2 <> 'stock' OR s.location_id IS NOT NULL)
           AND ($2 <> 'technicians' OR s.technician_id IS NOT NULL)
           AND ($3::uuid IS NULL OR s.technician_id = $3)
           AND ($4 = '' OR strpos(s.iccid, $4) > 0)
           AND ($5::text IS NULL OR s.iccid > $5)
         ORDER BY s.iccid LIMIT $6"
    ))
    .bind(scope.location)
    .bind(holder)
    .bind(query.technician_id)
    .bind(&search)
    .bind(&query.after)
    .bind(limit + 1)
    .fetch_all(&mut *tx)
    .await?;
    let more = items.len() > limit as usize;
    items.truncate(limit as usize);
    let cursor = items.last().filter(|_| more).map(|card| card.iccid.clone());
    let (stock, with_technicians): (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM sim_cards WHERE location_id = $1),
                (SELECT count(*) FROM sim_cards s JOIN users u ON u.id = s.technician_id WHERE u.location_id = $1)",
    )
    .bind(scope.location)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(json!({
        "items": items, "next_cursor": cursor,
        "totals": {"stock": stock, "with_technicians": with_technicians},
    })))
}

#[derive(Serialize, sqlx::FromRow)]
struct TechnicianSims {
    id: Uuid,
    name: String,
    login: String,
    active: bool,
    whatsapp: Option<String>,
    sims: i64,
    last_delivery_at: Option<DateTime<Utc>>,
}

/// Técnicos da cidade com a quantidade de chips em posse.
pub async fn technicians(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, scope) = warehouse_scope(&state, &headers).await?;
    let items: Vec<TechnicianSims> = sqlx::query_as(
        "SELECT u.id, u.name, u.login, u.active, u.whatsapp,
            (SELECT count(*) FROM sim_cards s WHERE s.technician_id = u.id) AS sims,
            (SELECT max(t.created_at) FROM sim_transfers t WHERE t.technician_id = u.id AND t.kind = 'DELIVERY') AS last_delivery_at
         FROM users u WHERE u.role = 'technician' AND u.deleted_at IS NULL AND u.location_id = $1
         ORDER BY u.active DESC, lower(u.name), u.id LIMIT 500",
    )
    .bind(scope.location)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"items": items})))
}

/// Chips sob responsabilidade do técnico autenticado.
pub async fn mine(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, technician) = authorize(&state.db, &headers, Role::Technician).await?;
    let items: Vec<Card> = sqlx::query_as(&format!(
        "SELECT {CARD_FIELDS} FROM {CARD_FROM} WHERE s.technician_id = $1 ORDER BY s.iccid LIMIT 1000"
    ))
    .bind(technician)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"items": items})))
}

// ---------------------------------------------------------------------------
// Entrega e devolução
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize, sqlx::Type)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[sqlx(type_name = "text", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TransferKind {
    Delivery,
    Return,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TransferInput {
    client_transfer_id: Uuid,
    kind: TransferKind,
    technician_id: Uuid,
    iccids: Vec<String>,
    #[serde(default)]
    notes: Option<String>,
}

#[derive(sqlx::FromRow)]
struct LockedCard {
    id: Uuid,
    iccid: String,
    location_id: Option<Uuid>,
    technician_id: Option<Uuid>,
    holder: String,
}

fn rejected(problems: Vec<Value>) -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({
            "code": "SIM_TRANSFER_REJECTED",
            "message": "Nenhum chip foi movimentado. Corrija os itens indicados e confirme novamente.",
            "problems": problems,
            "request_id": request_id(),
        })),
    )
        .into_response()
}

/// Registra a entrega de chips ao técnico ou a devolução ao estoque.
///
/// Tudo ou nada: se um único chip não estiver onde deveria, nenhum se move.
/// A chave do cliente torna a confirmação idempotente.
pub async fn transfer(
    State(state): State<AppState>,
    headers: HeaderMap,
    Body(input): Body<TransferInput>,
) -> Result<Response, ApiError> {
    if input.iccids.is_empty() || input.iccids.len() > MAX_TRANSFER_ITEMS {
        return Err(ApiError::invalid("Informe de 1 a 500 chips."));
    }
    let notes = match input.notes.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(value) if value.chars().count() <= 500 && !value.chars().any(char::is_control) => {
            Some(value.to_owned())
        }
        Some(_) => return Err(ApiError::invalid("Use até 500 caracteres na observação.")),
    };
    let (mut tx, Scope { actor, location }) = warehouse_scope(&state, &headers).await?;
    require_local_technician(&mut tx, input.technician_id, location).await?;

    let mut problems = Vec::new();
    let mut wanted: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for raw in &input.iccids {
        match normalize_iccid(raw) {
            Err(reason) => problems
                .push(json!({"iccid": raw.chars().take(40).collect::<String>(), "reason": reason})),
            Ok(iccid) if !seen.insert(prefix(&iccid).to_owned()) => {
                problems.push(json!({"iccid": iccid, "reason": "Chip repetido na lista."}))
            }
            Ok(iccid) => wanted.push(iccid),
        }
    }
    let prefixes: Vec<String> = wanted
        .iter()
        .map(|iccid| prefix(iccid).to_owned())
        .collect();

    let cards: Vec<LockedCard> = sqlx::query_as(
        "SELECT s.id, s.iccid, s.location_id, s.technician_id, coalesce(u.name, l.name) AS holder
         FROM sim_cards s LEFT JOIN users u ON u.id = s.technician_id
         LEFT JOIN locations l ON l.id = s.location_id
         WHERE left(s.iccid, 19) = ANY($1) ORDER BY s.id FOR UPDATE OF s",
    )
    .bind(&prefixes)
    .fetch_all(&mut *tx)
    .await?;
    // Verificada depois do bloqueio: uma repetição concorrente da mesma
    // confirmação espera a primeira e devolve o mesmo resultado.
    if let Some(previous) = existing_transfer(&mut tx, input.client_transfer_id).await? {
        let same = previous.kind == input.kind
            && previous.technician_id == input.technician_id
            && previous.location_id == location
            && previous.clerk_id == actor
            && problems.is_empty()
            && previous.prefixes == prefixes.iter().cloned().collect::<HashSet<_>>();
        if !same {
            return Err(conflict(
                "TRANSFER_KEY_CONFLICT",
                "Esta chave já foi usada para outra movimentação de chips.",
            ));
        }
        let detail = transfer_detail(&mut tx, input.client_transfer_id).await?;
        tx.commit().await?;
        return Ok(Json(detail).into_response());
    }

    let by_prefix: HashMap<&str, &LockedCard> = cards
        .iter()
        .map(|card| (prefix(&card.iccid), card))
        .collect();
    let mut moving: Vec<&LockedCard> = Vec::new();
    for iccid in &wanted {
        let Some(card) = by_prefix.get(prefix(iccid)) else {
            problems.push(json!({"iccid": iccid, "reason": "Chip não cadastrado. Importe a planilha da operadora."}));
            continue;
        };
        let reason = match input.kind {
            TransferKind::Delivery if card.location_id == Some(location) => None,
            TransferKind::Delivery if card.technician_id == Some(input.technician_id) => {
                Some("Este chip já está com este técnico.".to_owned())
            }
            TransferKind::Delivery if card.technician_id.is_some() => {
                Some(format!("Este chip está com {}.", card.holder))
            }
            TransferKind::Delivery => {
                Some(format!("Este chip está no estoque de {}.", card.holder))
            }
            TransferKind::Return if card.technician_id == Some(input.technician_id) => None,
            TransferKind::Return if card.technician_id.is_some() => Some(format!(
                "Este chip está com {}, não com este técnico.",
                card.holder
            )),
            TransferKind::Return => {
                Some(format!("Este chip já está no estoque de {}.", card.holder))
            }
        };
        match reason {
            Some(reason) => problems.push(json!({"iccid": card.iccid, "reason": reason})),
            None => moving.push(card),
        }
    }
    if !problems.is_empty() {
        tx.rollback().await?;
        return Ok(rejected(problems));
    }

    sqlx::query(
        "INSERT INTO sim_transfers (id, kind, location_id, technician_id, clerk_id, notes)
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(input.client_transfer_id)
    .bind(input.kind)
    .bind(location)
    .bind(input.technician_id)
    .bind(actor)
    .bind(&notes)
    .execute(&mut *tx)
    .await?;
    let ids: Vec<Uuid> = moving.iter().map(|card| card.id).collect();
    let movements: Vec<Uuid> = ids.iter().map(|_| Uuid::new_v4()).collect();
    match input.kind {
        TransferKind::Delivery => {
            sqlx::query("UPDATE sim_cards SET location_id = NULL, technician_id = $2, updated_at = now() WHERE id = ANY($1)")
                .bind(&ids).bind(input.technician_id).execute(&mut *tx).await?;
            sqlx::query(
                "INSERT INTO sim_movements (id, sim_card_id, movement_type, from_location_id, to_technician_id,
                    transfer_id, transfer_kind, actor_id)
                 SELECT m, c, 'DELIVERED', $3, $4, $5, 'DELIVERY', $6 FROM unnest($1::uuid[], $2::uuid[]) AS t(m, c)",
            )
            .bind(&movements).bind(&ids).bind(location).bind(input.technician_id)
            .bind(input.client_transfer_id).bind(actor).execute(&mut *tx).await?;
        }
        TransferKind::Return => {
            sqlx::query("UPDATE sim_cards SET location_id = $2, technician_id = NULL, updated_at = now() WHERE id = ANY($1)")
                .bind(&ids).bind(location).execute(&mut *tx).await?;
            sqlx::query(
                "INSERT INTO sim_movements (id, sim_card_id, movement_type, from_technician_id, to_location_id,
                    transfer_id, transfer_kind, actor_id)
                 SELECT m, c, 'RETURNED', $4, $3, $5, 'RETURN', $6 FROM unnest($1::uuid[], $2::uuid[]) AS t(m, c)",
            )
            .bind(&movements).bind(&ids).bind(location).bind(input.technician_id)
            .bind(input.client_transfer_id).bind(actor).execute(&mut *tx).await?;
        }
    }
    let action = match input.kind {
        TransferKind::Delivery => "SIM_DELIVERED",
        TransferKind::Return => "SIM_RETURNED",
    };
    audit(
        &mut tx,
        actor,
        action,
        "sim_transfer",
        input.client_transfer_id,
        None,
        json!({"technician_id": input.technician_id, "location_id": location, "notes": notes,
            "iccids": moving.iter().map(|card| &card.iccid).collect::<Vec<_>>()}),
    )
    .await?;
    let detail = transfer_detail(&mut tx, input.client_transfer_id).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(detail)).into_response())
}

struct PreviousTransfer {
    kind: TransferKind,
    technician_id: Uuid,
    location_id: Uuid,
    clerk_id: Uuid,
    prefixes: HashSet<String>,
}

async fn existing_transfer(
    db: &mut PgConnection,
    id: Uuid,
) -> Result<Option<PreviousTransfer>, ApiError> {
    let row: Option<(TransferKind, Uuid, Uuid, Uuid)> = sqlx::query_as(
        "SELECT kind, technician_id, location_id, clerk_id FROM sim_transfers WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&mut *db)
    .await?;
    let Some((kind, technician_id, location_id, clerk_id)) = row else {
        return Ok(None);
    };
    let iccids: Vec<String> = sqlx::query_scalar(
        "SELECT s.iccid FROM sim_movements m JOIN sim_cards s ON s.id = m.sim_card_id WHERE m.transfer_id = $1",
    )
    .bind(id)
    .fetch_all(db)
    .await?;
    Ok(Some(PreviousTransfer {
        kind,
        technician_id,
        location_id,
        clerk_id,
        prefixes: iccids
            .iter()
            .map(|iccid| prefix(iccid).to_owned())
            .collect(),
    }))
}

#[derive(Serialize, sqlx::FromRow)]
struct TransferSummary {
    id: Uuid,
    number: i64,
    kind: TransferKind,
    location_id: Uuid,
    location_name: String,
    technician_id: Uuid,
    technician_name: String,
    technician_whatsapp: Option<String>,
    clerk_name: String,
    notes: Option<String>,
    created_at: DateTime<Utc>,
    total: i64,
}

const TRANSFER_SUMMARY: &str = "SELECT t.id, t.number, t.kind, t.location_id, l.name AS location_name,
    t.technician_id, u.name AS technician_name, u.whatsapp AS technician_whatsapp, c.name AS clerk_name,
    t.notes, t.created_at, (SELECT count(*) FROM sim_movements m WHERE m.transfer_id = t.id) AS total
    FROM sim_transfers t JOIN locations l ON l.id = t.location_id
    JOIN users u ON u.id = t.technician_id JOIN users c ON c.id = t.clerk_id";

async fn transfer_detail(db: &mut PgConnection, id: Uuid) -> Result<Value, ApiError> {
    let summary: TransferSummary = sqlx::query_as(&format!("{TRANSFER_SUMMARY} WHERE t.id = $1"))
        .bind(id)
        .fetch_optional(&mut *db)
        .await?
        .ok_or_else(ApiError::missing)?;
    let items: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT s.iccid, s.operator_status FROM sim_movements m JOIN sim_cards s ON s.id = m.sim_card_id
         WHERE m.transfer_id = $1 ORDER BY s.iccid",
    )
    .bind(id)
    .fetch_all(db)
    .await?;
    let items: Vec<Value> = items
        .into_iter()
        .map(|(iccid, status)| json!({"iccid": iccid, "operator_status": status}))
        .collect();
    Ok(json!({"transfer": summary, "items": items}))
}

#[derive(Deserialize)]
pub struct TransferQuery {
    technician_id: Option<Uuid>,
    after: Option<Uuid>,
    limit: Option<i64>,
}

pub async fn transfers(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: Result<Query<TransferQuery>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, scope) = warehouse_scope(&state, &headers).await?;
    let query = checked_query(query)?;
    let limit = limit(query.limit)?;
    let mut items: Vec<TransferSummary> = sqlx::query_as(&format!(
        "{TRANSFER_SUMMARY} WHERE t.location_id = $1 AND ($2::uuid IS NULL OR t.technician_id = $2)
           AND ($3::uuid IS NULL OR (t.created_at, t.id) < (SELECT created_at, id FROM sim_transfers WHERE id = $3))
         ORDER BY t.created_at DESC, t.id DESC LIMIT $4"
    ))
    .bind(scope.location)
    .bind(query.technician_id)
    .bind(query.after)
    .bind(limit + 1)
    .fetch_all(&mut *tx)
    .await?;
    let more = items.len() > limit as usize;
    items.truncate(limit as usize);
    let cursor = items.last().filter(|_| more).map(|item| item.id);
    tx.commit().await?;
    Ok(Json(json!({"items": items, "next_cursor": cursor})))
}

pub async fn transfer_by_id(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, scope) = warehouse_scope(&state, &headers).await?;
    let id = parse_id(&id)?;
    let local: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM sim_transfers WHERE id = $1 AND location_id = $2)",
    )
    .bind(id)
    .bind(scope.location)
    .fetch_one(&mut *tx)
    .await?;
    if !local {
        return Err(ApiError::missing());
    }
    let detail = transfer_detail(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(detail))
}

#[cfg(test)]
mod tests {
    use super::normalize_iccid;

    #[test]
    fn iccid_accepts_separators_padding_and_check_digit() {
        assert_eq!(
            normalize_iccid("89554000000414256297").unwrap(),
            "89554000000414256297"
        );
        assert_eq!(
            normalize_iccid(" 8955 4000 0004 1425 6297 ").unwrap(),
            "89554000000414256297"
        );
        assert_eq!(
            normalize_iccid("89554000000414256297F").unwrap(),
            "89554000000414256297"
        );
        assert_eq!(
            normalize_iccid("8955400000041425629").unwrap(),
            "8955400000041425629"
        );
    }

    #[test]
    fn iccid_rejects_wrong_check_digit_prefix_and_length() {
        assert!(normalize_iccid("89554000000414256298").is_err());
        assert!(normalize_iccid("79554000000414256297").is_err());
        assert!(normalize_iccid("895540000004142").is_err());
        assert!(normalize_iccid("8955400000041425629X").is_err());
        assert!(normalize_iccid("").is_err());
    }
}
