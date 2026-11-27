//! Cidades (locais de estoque) e escopo de operação do estoque.
//!
//! Técnicos e estoquistas pertencem a uma cidade e só operam nela. O
//! administrador escolhe a cidade em que está operando pelo cabeçalho
//! `X-Location-Id`; sem ele, usa a cidade de referência da própria conta.

use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::{PgConnection, Postgres, Transaction};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{Role, authorize_roles, locked_user},
    error::ApiError,
};

pub const LOCATION_HEADER: &str = "x-location-id";

/// Operador do estoque e a cidade em que a operação acontece.
pub struct Scope {
    pub actor: Uuid,
    pub location: Uuid,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Location {
    pub id: Uuid,
    pub name: String,
}

/// Autoriza estoquista ou administrador e resolve a cidade da operação.
pub async fn warehouse_scope<'a>(
    state: &'a AppState,
    headers: &HeaderMap,
) -> Result<(Transaction<'a, Postgres>, Scope), ApiError> {
    let (mut tx, actor) = authorize_roles(
        &state.db,
        headers,
        &[Role::WarehouseClerk, Role::Administrator],
    )
    .await?;
    let location = resolve(&mut tx, actor, headers).await?;
    Ok((tx, Scope { actor, location }))
}

async fn resolve(
    db: &mut PgConnection,
    actor: Uuid,
    headers: &HeaderMap,
) -> Result<Uuid, ApiError> {
    let user = locked_user(db, actor)
        .await?
        .ok_or_else(ApiError::unauthorized)?;
    let requested = headers
        .get(LOCATION_HEADER)
        .map(|value| {
            value
                .to_str()
                .ok()
                .and_then(|value| Uuid::parse_str(value.trim()).ok())
                .ok_or_else(|| ApiError::invalid("Cidade inválida no cabeçalho X-Location-Id."))
        })
        .transpose()?;
    let location = match user.role() {
        // O estoquista opera somente na própria cidade, qualquer que seja o cabeçalho.
        Role::WarehouseClerk => user.location_id(),
        _ => requested.or(user.location_id()),
    }
    .ok_or(ApiError(
        StatusCode::BAD_REQUEST,
        "LOCATION_REQUIRED",
        "Escolha a cidade em que você está operando.",
    ))?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM locations WHERE id = $1)")
        .bind(location)
        .fetch_one(&mut *db)
        .await?;
    if !exists {
        return Err(ApiError::invalid("Cidade não encontrada."));
    }
    Ok(location)
}

/// O técnico pertence à cidade da operação? Bloqueia a conta para serializar
/// com a troca de perfil ou de cidade.
pub async fn require_local_technician(
    db: &mut PgConnection,
    technician: Uuid,
    location: Uuid,
) -> Result<(), ApiError> {
    let local: Option<bool> = sqlx::query_scalar(
        "SELECT location_id = $2 FROM users WHERE id = $1 AND role = 'technician' FOR SHARE",
    )
    .bind(technician)
    .bind(location)
    .fetch_optional(db)
    .await?
    .flatten();
    match local {
        None => Err(ApiError::missing()),
        Some(false) => Err(ApiError(
            StatusCode::CONFLICT,
            "OTHER_LOCATION",
            "Este técnico pertence a outra cidade.",
        )),
        Some(true) => Ok(()),
    }
}

/// Lista as cidades. Qualquer conta autenticada pode consultar.
pub async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, _) = authorize_roles(
        &state.db,
        &headers,
        &[Role::Technician, Role::WarehouseClerk, Role::Administrator],
    )
    .await?;
    let items: Vec<Location> = sqlx::query_as("SELECT id, name FROM locations ORDER BY name")
        .fetch_all(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({"items": items})))
}

#[derive(Serialize, sqlx::FromRow)]
struct CityOverview {
    id: Uuid,
    name: String,
    technicians: i64,
    clerks: i64,
    equipment_in_stock: i64,
    equipment_with_technicians: i64,
    open_batches: i64,
    sims_in_stock: i64,
    sims_with_technicians: i64,
}

/// Painel por cidade: o administrador vê todas; o estoquista, a própria.
pub async fn overview(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, actor) = authorize_roles(
        &state.db,
        &headers,
        &[Role::WarehouseClerk, Role::Administrator],
    )
    .await?;
    let user = locked_user(&mut tx, actor)
        .await?
        .ok_or_else(ApiError::unauthorized)?;
    let only: Option<Uuid> = match user.role() {
        Role::WarehouseClerk => user.location_id(),
        _ => None,
    };
    let items: Vec<CityOverview> = sqlx::query_as(
        "SELECT l.id, l.name,
            (SELECT count(*) FROM users u WHERE u.location_id = l.id AND u.role = 'technician'
                AND u.deleted_at IS NULL AND u.active) AS technicians,
            (SELECT count(*) FROM users u WHERE u.location_id = l.id AND u.role = 'warehouse_clerk'
                AND u.deleted_at IS NULL AND u.active) AS clerks,
            (SELECT count(*) FROM equipment e WHERE e.warehouse_id = l.id) AS equipment_in_stock,
            (SELECT count(*) FROM equipment e JOIN users u ON u.id = e.technician_id
                WHERE u.location_id = l.id) AS equipment_with_technicians,
            (SELECT count(*) FROM delivery_batches b JOIN users u ON u.id = b.technician_id
                WHERE u.location_id = l.id AND b.status IN ('SUBMITTED', 'RECEIVING')) AS open_batches,
            (SELECT count(*) FROM sim_cards s WHERE s.location_id = l.id) AS sims_in_stock,
            (SELECT count(*) FROM sim_cards s JOIN users u ON u.id = s.technician_id
                WHERE u.location_id = l.id) AS sims_with_technicians
         FROM locations l WHERE ($1::uuid IS NULL OR l.id = $1) ORDER BY l.name",
    )
    .bind(only)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"items": items})))
}
