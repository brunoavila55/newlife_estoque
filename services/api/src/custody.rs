use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgConnection, types::Json as SqlJson};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{Role, audit, authorize, parse_id},
    error::{ApiError, Body},
};

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "UPPERCASE")]
enum Kind {
    Serial,
    Mac,
    Barcode,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Serial => "SERIAL",
            Self::Mac => "MAC",
            Self::Barcode => "BARCODE",
        }
    }
}

#[derive(Deserialize)]
pub struct SubmittedIdentifier {
    kind: Kind,
    raw_value: String,
}

#[derive(Deserialize, Serialize, sqlx::FromRow)]
struct Identifier {
    kind: String,
    raw_value: String,
    normalized_value: String,
}

impl SubmittedIdentifier {
    fn normalize(self) -> Result<Identifier, ApiError> {
        let value = self.raw_value.trim();
        if value.is_empty() || self.raw_value.len() > 128 || value.chars().any(char::is_control) {
            return Err(ApiError::invalid(
                "Informe um identificador válido de até 128 bytes.",
            ));
        }
        let normalized_value = match self.kind {
            Kind::Serial => normalize_serial(value),
            Kind::Barcode => value.to_owned(),
            Kind::Mac => normalize_mac(value)?,
        };
        Ok(Identifier {
            kind: self.kind.as_str().into(),
            raw_value: self.raw_value,
            normalized_value,
        })
    }
}

pub fn normalize_serial(value: &str) -> String {
    value.trim().to_ascii_uppercase()
}

pub fn normalize_mac(value: &str) -> Result<String, ApiError> {
    let invalid =
        || ApiError::invalid("MAC inválido. Use 12 dígitos hexadecimais, com ou sem separadores.");
    let bytes = value.as_bytes();
    let normalized: Vec<u8> = match bytes.len() {
        12 => bytes.to_vec(),
        17 if matches!(bytes[2], b':' | b'-')
            && (2..17).step_by(3).all(|index| bytes[index] == bytes[2]) =>
        {
            bytes
                .iter()
                .enumerate()
                .filter(|(index, _)| index % 3 != 2)
                .map(|(_, byte)| *byte)
                .collect()
        }
        _ => return Err(invalid()),
    };
    if !normalized.iter().all(u8::is_ascii_hexdigit) {
        return Err(invalid());
    }
    Ok(normalized
        .into_iter()
        .map(|byte| char::from(byte.to_ascii_uppercase()))
        .collect())
}

#[derive(Deserialize)]
#[serde(tag = "decision", rename_all = "snake_case")]
pub enum ReviewInput {
    Validate {
        identifiers: Vec<SubmittedIdentifier>,
        ocr_result_id: Option<Uuid>,
    },
    Flag {
        reason: String,
    },
}

#[derive(sqlx::FromRow)]
struct Capture {
    id: Uuid,
    technician_id: Uuid,
    equipment_id: Option<Uuid>,
    image_object_key: String,
    status: String,
    review_issue: Option<Value>,
    validated_identifiers: Option<Value>,
}

#[derive(Serialize)]
pub struct ReviewResult {
    status: &'static str,
    equipment_id: Option<Uuid>,
    issue: Option<Value>,
}

pub async fn image_url(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, _) = authorize(&state.db, &headers, Role::Administrator).await?;
    let key: String = sqlx::query_scalar("SELECT image_object_key FROM captures WHERE id = $1")
        .bind(parse_id(&id)?)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(ApiError::missing)?;
    let url = state
        .storage
        .read_url(&key)
        .await
        .map_err(|_| ApiError::internal())?;
    tx.commit().await?;
    Ok(Json(json!({"url": url, "expires_in": 120})))
}

pub async fn review(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Body(input): Body<ReviewInput>,
) -> Result<Json<ReviewResult>, ApiError> {
    let (mut tx, actor) = authorize(&state.db, &headers, Role::Administrator).await?;
    let capture: Capture = sqlx::query_as(
        "SELECT id, technician_id, equipment_id, image_object_key, status, review_issue, validated_identifiers
         FROM captures WHERE id = $1 FOR UPDATE",
    ).bind(parse_id(&id)?).fetch_optional(&mut *tx).await?.ok_or_else(ApiError::missing)?;

    let result =
        match input {
            ReviewInput::Flag { reason } => {
                ensure_pending(&capture)?;
                let reason = reason.trim();
                if !(1..=500).contains(&reason.chars().count()) || reason.contains('\0') {
                    return Err(ApiError::invalid(
                        "Informe uma justificativa de 1 a 500 caracteres.",
                    ));
                }
                flag(
                    &mut tx,
                    actor,
                    &capture,
                    json!({"code": "MANUAL_REVIEW", "reason": reason}),
                )
                .await?
            }
            ReviewInput::Validate {
                identifiers,
                ocr_result_id,
            } => {
                if let Some(result_id) = ocr_result_id {
                    let exists: bool = sqlx::query_scalar(
                    "SELECT EXISTS (SELECT 1 FROM ocr_results WHERE id = $1 AND capture_id = $2)",
                ).bind(result_id).bind(capture.id).fetch_one(&mut *tx).await?;
                    if !exists {
                        return Err(ApiError::missing());
                    }
                }
                let identifiers = checked_identifiers(identifiers)?;
                let evidence = json!(&identifiers);
                if let Some(equipment_id) = capture.equipment_id {
                    if capture.validated_identifiers.as_ref() != Some(&evidence) {
                        return Err(already_identified());
                    }
                    identified(equipment_id)
                } else {
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
                    validate(
                        &mut tx,
                        actor,
                        &capture,
                        identifiers,
                        evidence,
                        ocr_result_id,
                    )
                    .await?
                }
            }
        };
    tx.commit().await?;
    Ok(Json(result))
}

fn checked_identifiers(submitted: Vec<SubmittedIdentifier>) -> Result<Vec<Identifier>, ApiError> {
    if !(1..=16).contains(&submitted.len()) {
        return Err(ApiError::invalid("Informe de 1 a 16 identificadores."));
    }
    let mut identifiers = submitted
        .into_iter()
        .map(SubmittedIdentifier::normalize)
        .collect::<Result<Vec<_>, _>>()?;
    identifiers.sort_by(|left, right| {
        (&left.kind, &left.normalized_value).cmp(&(&right.kind, &right.normalized_value))
    });
    if identifiers.windows(2).any(|pair| {
        pair[0].kind == pair[1].kind && pair[0].normalized_value == pair[1].normalized_value
    }) {
        return Err(ApiError::invalid("Remova os identificadores repetidos."));
    }
    Ok(identifiers)
}

fn already_identified() -> ApiError {
    ApiError(
        StatusCode::CONFLICT,
        "ALREADY_IDENTIFIED",
        "A captura já possui uma identificação validada.",
    )
}

fn ensure_pending(capture: &Capture) -> Result<(), ApiError> {
    if capture.equipment_id.is_some() {
        return Err(already_identified());
    }
    Ok(())
}

fn identified(equipment_id: Uuid) -> ReviewResult {
    ReviewResult {
        status: "IDENTIFIED",
        equipment_id: Some(equipment_id),
        issue: None,
    }
}

async fn flag(
    db: &mut PgConnection,
    actor: Uuid,
    capture: &Capture,
    issue: Value,
) -> Result<ReviewResult, ApiError> {
    if capture.review_issue.as_ref() != Some(&issue) {
        sqlx::query("UPDATE captures SET status = 'NEEDS_REVIEW', review_issue = $1 WHERE id = $2")
            .bind(&issue)
            .bind(capture.id)
            .execute(&mut *db)
            .await?;
        audit(
            db,
            actor,
            "CAPTURE_FLAGGED",
            "capture",
            capture.id,
            Some(json!({"status": capture.status, "issue": capture.review_issue})),
            json!({"status": "NEEDS_REVIEW", "issue": issue}),
        )
        .await?;
    }
    Ok(ReviewResult {
        status: "NEEDS_REVIEW",
        equipment_id: None,
        issue: Some(issue),
    })
}

async fn validate(
    db: &mut PgConnection,
    actor: Uuid,
    capture: &Capture,
    identifiers: Vec<Identifier>,
    evidence: Value,
    ocr_result_id: Option<Uuid>,
) -> Result<ReviewResult, ApiError> {
    // Serialize identity writes even when there is no existing row to lock.
    sqlx::query("LOCK TABLE equipment_identifiers IN SHARE ROW EXCLUSIVE MODE")
        .execute(&mut *db)
        .await?;
    let kinds: Vec<_> = identifiers
        .iter()
        .map(|identifier| identifier.kind.as_str())
        .collect();
    let values: Vec<_> = identifiers
        .iter()
        .map(|identifier| identifier.normalized_value.as_str())
        .collect();
    let matches: Vec<(Uuid, i64)> = sqlx::query_as(
        "SELECT equipment_id, count(*) FROM equipment_identifiers
         JOIN unnest($1::text[], $2::text[]) AS submitted(kind, normalized_value) USING (kind, normalized_value)
         GROUP BY equipment_id",
    ).bind(kinds).bind(values).fetch_all(&mut *db).await?;

    let equipment_id = match matches.as_slice() {
        [] => register_equipment(db, actor, capture, identifiers).await?,
        [(equipment_id, count)] => {
            let technician_id: Option<Uuid> =
                sqlx::query_scalar("SELECT technician_id FROM equipment WHERE id = $1 FOR UPDATE")
                    .bind(equipment_id)
                    .fetch_one(&mut *db)
                    .await?;
            let problem = if technician_id != Some(capture.technician_id) {
                Some("DIFFERENT_CUSTODY")
            } else if *count != identifiers.len() as i64 {
                Some("IDENTIFIER_MISMATCH")
            } else {
                None
            };
            if let Some(code) = problem {
                return flag(
                    db,
                    actor,
                    capture,
                    json!({"code": code, "identifiers": evidence, "ocr_result_id": ocr_result_id}),
                )
                .await;
            }
            *equipment_id
        }
        _ => {
            return flag(
                db,
                actor,
                capture,
                json!({"code": "AMBIGUOUS_IDENTITY", "identifiers": evidence, "ocr_result_id": ocr_result_id}),
            )
            .await;
        }
    };
    sqlx::query(
        "UPDATE captures SET status = 'IDENTIFIED', equipment_id = $1, validated_identifiers = $2,
         review_issue = NULL WHERE id = $3",
    )
    .bind(equipment_id)
    .bind(&evidence)
    .bind(capture.id)
    .execute(&mut *db)
    .await?;
    audit(
        db,
        actor,
        "CAPTURE_VALIDATED",
        "capture",
        capture.id,
        Some(json!({"status": capture.status, "issue": capture.review_issue})),
        json!({"status": "IDENTIFIED", "equipment_id": equipment_id, "identifiers": evidence, "ocr_result_id": ocr_result_id}),
    )
    .await?;
    Ok(identified(equipment_id))
}

async fn register_equipment(
    db: &mut PgConnection,
    actor: Uuid,
    capture: &Capture,
    identifiers: Vec<Identifier>,
) -> Result<Uuid, ApiError> {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO equipment (id, technician_id) VALUES ($1, $2)")
        .bind(id)
        .bind(capture.technician_id)
        .execute(&mut *db)
        .await?;
    for identifier in identifiers {
        sqlx::query("INSERT INTO equipment_identifiers (equipment_id, kind, raw_value, normalized_value, verified_by)
            VALUES ($1, $2, $3, $4, $5)")
            .bind(id).bind(identifier.kind).bind(identifier.raw_value).bind(identifier.normalized_value).bind(actor)
            .execute(&mut *db).await?;
    }
    let movement_id = Uuid::new_v4();
    sqlx::query("INSERT INTO custody_movements (id, equipment_id, to_technician_id, capture_id, actor_id, movement_type)
        VALUES ($1, $2, $3, $4, $5, 'COLLECTION_VALIDATED')")
        .bind(movement_id).bind(id).bind(capture.technician_id).bind(capture.id).bind(actor).execute(&mut *db).await?;
    audit(db, actor, "CUSTODY_STARTED", "equipment", id, None, json!({
        "technician_id": capture.technician_id, "movement_id": movement_id, "capture_id": capture.id
    })).await?;
    Ok(id)
}

#[derive(Deserialize)]
pub struct InventoryQuery {
    after: Option<Uuid>,
    limit: Option<i64>,
}

#[derive(Deserialize, Serialize, sqlx::FromRow)]
struct InventoryEquipment {
    id: Uuid,
    identifiers: SqlJson<Vec<Identifier>>,
}

#[derive(Serialize)]
pub struct InventoryPage {
    items: Vec<InventoryEquipment>,
    next_cursor: Option<Uuid>,
}

pub async fn inventory(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: Result<Query<InventoryQuery>, axum::extract::rejection::QueryRejection>,
) -> Result<Json<InventoryPage>, ApiError> {
    let (mut tx, technician_id) = authorize(&state.db, &headers, Role::Technician).await?;
    let Query(query) =
        query.map_err(|_| ApiError::invalid("Parâmetros de paginação inválidos."))?;
    let limit = query.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(ApiError::invalid("Use um limite de 1 a 100 itens."));
    }
    let mut items: Vec<InventoryEquipment> = sqlx::query_as(
        "SELECT e.id, (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'raw_value', raw_value,
                'normalized_value', normalized_value) ORDER BY kind, normalized_value), '[]'::jsonb)
              FROM equipment_identifiers i WHERE i.equipment_id = e.id) AS identifiers
         FROM equipment e WHERE technician_id = $1 AND ($2::uuid IS NULL OR e.id > $2)
         ORDER BY e.id LIMIT $3",
    ).bind(technician_id).bind(query.after).bind(limit + 1).fetch_all(&mut *tx).await?;
    let has_more = items.len() > limit as usize;
    items.truncate(limit as usize);
    let next_cursor = items.last().filter(|_| has_more).map(|item| item.id);
    tx.commit().await?;
    Ok(Json(InventoryPage { items, next_cursor }))
}
