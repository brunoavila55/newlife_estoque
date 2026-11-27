use std::sync::LazyLock;

use argon2::{
    Argon2, PasswordHash, PasswordHasher, PasswordVerifier,
    password_hash::{SaltString, rand_core::OsRng},
};
use axum::{
    Json,
    extract::{Path, Query, State, rejection::QueryRejection},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use rand::{Rng, distributions::Alphanumeric};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, PgPool, Postgres, Transaction};
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::{
    AppState,
    error::{ApiError, Body, request_id},
};

static PASSWORD_WORKERS: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(4));

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(type_name = "text", rename_all = "snake_case")]
pub enum Role {
    Technician,
    WarehouseClerk,
    Administrator,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct User {
    id: Uuid,
    name: String,
    login: String,
    role: Role,
    active: bool,
    whatsapp: Option<String>,
    location_id: Option<Uuid>,
}

impl User {
    pub fn role(&self) -> Role {
        self.role
    }
    pub fn location_id(&self) -> Option<Uuid> {
        self.location_id
    }
}

#[derive(sqlx::FromRow)]
struct LoginUser {
    #[sqlx(flatten)]
    user: User,
    password_hash: String,
}

#[derive(Deserialize)]
pub struct Credentials {
    login: String,
    password: String,
}

#[derive(Deserialize)]
pub struct NewUser {
    #[serde(flatten)]
    credentials: Credentials,
    name: String,
    role: Role,
    #[serde(default)]
    whatsapp: Option<String>,
    /// Cidade do técnico ou estoquista. Opcional para administradores.
    #[serde(default)]
    location_id: Option<Uuid>,
}

#[derive(Deserialize)]
pub struct NewPassword {
    password: String,
}

#[derive(Serialize)]
pub struct Session {
    access_token: String,
    refresh_token: String,
    expires_in: u32,
    user: User,
}

fn checked_login(value: &str) -> Result<String, ApiError> {
    let login = value.trim().to_ascii_lowercase();
    if !(3..=64).contains(&login.len())
        || !login
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
    {
        return Err(ApiError::invalid(
            "Use de 3 a 64 caracteres no login: letras ASCII, números, ponto, hífen ou sublinhado.",
        ));
    }
    Ok(login)
}

fn checked_name(value: &str) -> Result<&str, ApiError> {
    let name = value.trim();
    if !(1..=120).contains(&name.chars().count()) || name.chars().any(char::is_control) {
        return Err(ApiError::invalid("Informe um nome de 1 a 120 caracteres."));
    }
    Ok(name)
}

/// Normaliza o WhatsApp para dígitos com código do país. Vazio significa "sem número".
/// Números brasileiros com DDD (10 ou 11 dígitos) recebem o prefixo 55.
fn checked_whatsapp(value: &str) -> Result<Option<String>, ApiError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let valid_chars = trimmed
        .chars()
        .all(|c| c.is_ascii_digit() || " +-().".contains(c));
    let digits: String = trimmed.chars().filter(char::is_ascii_digit).collect();
    let digits = match digits.len() {
        10 | 11 if !trimmed.starts_with('+') => format!("55{digits}"),
        _ => digits,
    };
    if !valid_chars || !(12..=15).contains(&digits.len()) || digits.starts_with('0') {
        return Err(ApiError::invalid(
            "Informe o WhatsApp com DDD, por exemplo (11) 98765-4321.",
        ));
    }
    Ok(Some(digits))
}

async fn password_work<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, ApiError> + Send + 'static,
) -> Result<T, ApiError> {
    let permit = PASSWORD_WORKERS.try_acquire().map_err(|_| {
        ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "AUTH_BUSY",
            "Autenticação ocupada. Tente novamente.",
        )
    })?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        work()
    })
    .await
    .map_err(|_| ApiError::internal())?
}

pub async fn hash_password(password: String) -> Result<String, ApiError> {
    if password.chars().count() < 6 || password.len() > 256 {
        return Err(ApiError::invalid(
            "Use uma senha com pelo menos 6 caracteres e até 256 bytes.",
        ));
    }
    password_work(move || {
        let salt = SaltString::generate(&mut OsRng);
        Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map(|hash| hash.to_string())
            .map_err(|_| ApiError::internal())
    })
    .await
}

fn digest(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

fn token_hash(token: &str) -> Result<Vec<u8>, ApiError> {
    if token.len() == 48 && token.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return Ok(digest(token));
    }
    Err(ApiError::unauthorized())
}

fn bearer(headers: &HeaderMap) -> Result<Vec<u8>, ApiError> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split_once(' '))
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("Bearer"))
        .map(|(_, token)| token)
        .ok_or_else(ApiError::unauthorized)?;
    token_hash(token)
}

pub(crate) async fn locked_user(
    db: &mut PgConnection,
    user_id: Uuid,
) -> Result<Option<User>, ApiError> {
    Ok(sqlx::query_as(
        "SELECT id, name, login, role, active, whatsapp, location_id FROM users WHERE id = $1 FOR UPDATE",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?)
}

pub async fn authorize<'a>(
    db: &'a PgPool,
    headers: &HeaderMap,
    role: Role,
) -> Result<(Transaction<'a, Postgres>, Uuid), ApiError> {
    authorize_roles(db, headers, &[role]).await
}

pub async fn authorize_roles<'a>(
    db: &'a PgPool,
    headers: &HeaderMap,
    roles: &[Role],
) -> Result<(Transaction<'a, Postgres>, Uuid), ApiError> {
    let token = bearer(headers)?;
    let mut tx = db.begin().await?;
    let id = session_user(&mut tx, &token, false).await?.id;
    let user = locked_user(&mut tx, id)
        .await?
        .ok_or_else(ApiError::unauthorized)?;
    if !user.active {
        return Err(ApiError::unauthorized());
    }
    // Recheck after obtaining the same user lock used for revocation.
    session_user(&mut tx, &token, false).await?;
    if !roles.contains(&user.role) {
        return Err(ApiError::forbidden());
    }
    Ok((tx, id))
}

async fn session_user(
    db: &mut PgConnection,
    token: &[u8],
    refresh: bool,
) -> Result<User, ApiError> {
    let sql = if refresh {
        "SELECT u.id, name, login, role, active, whatsapp, location_id FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE refresh_hash = $1 AND renew_until > now() AND active"
    } else {
        "SELECT u.id, name, login, role, active, whatsapp, location_id FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE token_hash = $1 AND expires_at > now() AND active"
    };
    sqlx::query_as(sql)
        .bind(token)
        .fetch_optional(db)
        .await?
        .ok_or_else(ApiError::unauthorized)
}

fn new_token() -> String {
    rand::thread_rng()
        .sample_iter(Alphanumeric)
        .take(48)
        .map(char::from)
        .collect()
}

async fn issue(
    db: &mut PgConnection,
    user: User,
    previous: Option<&[u8]>,
) -> Result<Session, ApiError> {
    let access_token = new_token();
    let refresh_token = new_token();
    if let Some(previous) = previous {
        sqlx::query(
            "UPDATE sessions SET token_hash = $1, refresh_hash = $2,
            expires_at = LEAST(renew_until, now() + interval '1 hour') WHERE refresh_hash = $3",
        )
        .bind(digest(&access_token))
        .bind(digest(&refresh_token))
        .bind(previous)
        .execute(&mut *db)
        .await?;
    } else {
        sqlx::query(
            "INSERT INTO sessions (token_hash, refresh_hash, user_id, expires_at, renew_until)
            VALUES ($1, $2, $3, now() + interval '1 hour', now() + interval '7 days')",
        )
        .bind(digest(&access_token))
        .bind(digest(&refresh_token))
        .bind(user.id)
        .execute(&mut *db)
        .await?;
    }
    let expires_in = sqlx::query_scalar::<_, i32>(
        "SELECT floor(extract(epoch FROM expires_at - now()))::int FROM sessions WHERE token_hash = $1",
    ).bind(digest(&access_token)).fetch_one(db).await? as u32;
    Ok(Session {
        access_token,
        refresh_token,
        expires_in,
        user,
    })
}

pub async fn login(
    State(state): State<AppState>,
    Body(input): Body<Credentials>,
) -> Result<Json<Session>, ApiError> {
    Ok(Json(login_session(&state, input).await?))
}

async fn login_session(state: &AppState, input: Credentials) -> Result<Session, ApiError> {
    let login = checked_login(&input.login).map_err(|_| ApiError::unauthorized())?;
    if input.password.len() > 256 {
        return Err(ApiError::unauthorized());
    }
    let account: Option<LoginUser> = sqlx::query_as(
        "SELECT id, name, login, role, active, whatsapp, location_id, password_hash FROM users WHERE login = $1",
    )
    .bind(login)
    .fetch_optional(&state.db)
    .await?;
    let hash = account
        .as_ref()
        .map(|entry| entry.password_hash.clone())
        .unwrap_or_else(|| state.fallback_password_hash.to_string());
    let valid = password_work(move || {
        let hash = PasswordHash::new(&hash).map_err(|_| ApiError::internal())?;
        Ok(Argon2::default()
            .verify_password(input.password.as_bytes(), &hash)
            .is_ok())
    })
    .await?;
    let account = account
        .filter(|entry| valid && entry.user.active)
        .ok_or_else(ApiError::unauthorized)?;
    let mut tx = state.db.begin().await?;
    let user = locked_user(&mut tx, account.user.id)
        .await?
        .filter(|user| user.active)
        .ok_or_else(ApiError::unauthorized)?;
    let current_hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id = $1")
        .bind(user.id)
        .fetch_one(&mut *tx)
        .await?;
    if current_hash != account.password_hash {
        return Err(ApiError::unauthorized());
    }
    sqlx::query("DELETE FROM sessions WHERE user_id = $1 AND renew_until <= now()")
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
    let session = issue(&mut tx, user, None).await?;
    tx.commit().await?;
    Ok(session)
}

#[derive(Deserialize)]
pub struct RefreshInput {
    refresh_token: String,
}

pub async fn refresh(
    State(state): State<AppState>,
    Body(input): Body<RefreshInput>,
) -> Result<Json<Session>, ApiError> {
    let token = token_hash(&input.refresh_token)?;
    let mut tx = state.db.begin().await?;
    let id = session_user(&mut tx, &token, true).await?.id;
    locked_user(&mut tx, id).await?;
    let user = session_user(&mut tx, &token, true).await?;
    let session = issue(&mut tx, user, Some(&token)).await?;
    tx.commit().await?;
    Ok(Json(session))
}

pub async fn logout(
    State(state): State<AppState>,
    Body(input): Body<RefreshInput>,
) -> Result<StatusCode, ApiError> {
    let token = token_hash(&input.refresh_token)?;
    sqlx::query("DELETE FROM sessions WHERE refresh_hash = $1")
        .bind(token)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

const WEB_COOKIE: &str = "stock_web_refresh";

fn check_web(headers: &HeaderMap) -> Result<(), ApiError> {
    if headers.get("x-stock-web").is_some_and(|value| value == "1") {
        Ok(())
    } else {
        Err(ApiError::forbidden())
    }
}

fn web_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|entry| entry.trim().split_once('='))
        .find_map(|(name, value)| (name == WEB_COOKIE).then(|| value.to_owned()))
}

fn web_cookie(token: &str, seconds: u32) -> HeaderValue {
    HeaderValue::from_str(&format!(
        "{WEB_COOKIE}={token}; Path=/api/v1/auth/web; Max-Age={seconds}; HttpOnly; Secure; SameSite=Strict"
    )).expect("cookie usa apenas caracteres ASCII válidos")
}

fn web_session(session: Session) -> Response {
    let mut response = Json(json!({
        "access_token": session.access_token,
        "expires_in": session.expires_in,
        "user": session.user,
    }))
    .into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        web_cookie(&session.refresh_token, 7 * 24 * 3600),
    );
    response
}

pub async fn web_login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Body(input): Body<Credentials>,
) -> Result<Response, ApiError> {
    check_web(&headers)?;
    let session = login_session(&state, input).await?;
    if let Some(refresh_token) = web_token(&headers).filter(|token| token_hash(token).is_ok()) {
        logout(State(state), Body(RefreshInput { refresh_token })).await?;
    }
    Ok(web_session(session))
}

pub async fn web_refresh(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    check_web(&headers)?;
    let refresh_token = web_token(&headers).ok_or_else(ApiError::unauthorized)?;
    let Json(session) = refresh(State(state), Body(RefreshInput { refresh_token })).await?;
    Ok(web_session(session))
}

pub async fn web_logout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    check_web(&headers)?;
    if let Some(refresh_token) = web_token(&headers).filter(|token| token_hash(token).is_ok()) {
        logout(State(state), Body(RefreshInput { refresh_token })).await?;
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    response
        .headers_mut()
        .insert(header::SET_COOKIE, web_cookie("", 0));
    Ok(response)
}

#[derive(Deserialize)]
pub struct UserListQuery {
    after: Option<Uuid>,
    limit: Option<i64>,
}

#[derive(Serialize)]
pub struct UserPage {
    items: Vec<User>,
    next_cursor: Option<Uuid>,
}

pub async fn list_users(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: Result<Query<UserListQuery>, QueryRejection>,
) -> Result<Json<UserPage>, ApiError> {
    let (mut tx, _) = authorize(&state.db, &headers, Role::Administrator).await?;
    let Query(query) =
        query.map_err(|_| ApiError::invalid("Parâmetros de paginação inválidos."))?;
    let limit = query.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(ApiError::invalid("Use um limite de 1 a 100 itens."));
    }
    let mut items: Vec<User> = sqlx::query_as(
        "SELECT id, name, login, role, active, whatsapp, location_id FROM users
         WHERE deleted_at IS NULL AND ($1::uuid IS NULL OR id > $1) ORDER BY id LIMIT $2",
    )
    .bind(query.after)
    .bind(limit + 1)
    .fetch_all(&mut *tx)
    .await?;
    let has_more = items.len() > limit as usize;
    items.truncate(limit as usize);
    let next_cursor = items.last().filter(|_| has_more).map(|user| user.id);
    tx.commit().await?;
    Ok(Json(UserPage { items, next_cursor }))
}

pub async fn create_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    Body(input): Body<NewUser>,
) -> Result<(StatusCode, Json<User>), ApiError> {
    let (tx, _) = authorize(&state.db, &headers, Role::Administrator).await?;
    tx.rollback().await?;
    let login = checked_login(&input.credentials.login)?;
    let name = checked_name(&input.name)?;
    let whatsapp = input
        .whatsapp
        .as_deref()
        .map(checked_whatsapp)
        .transpose()?
        .flatten();
    let location = checked_location_need(input.role, input.location_id)?;
    let hash = hash_password(input.credentials.password).await?;
    let (mut tx, actor) = authorize(&state.db, &headers, Role::Administrator).await?;
    if let Some(location) = location {
        require_location(&mut tx, location).await?;
    }
    let user = insert_user(
        &mut tx,
        name,
        &login,
        &hash,
        input.role,
        whatsapp.as_deref(),
        location,
    )
    .await?;
    audit(
        &mut tx,
        actor,
        "USER_CREATED",
        "user",
        user.id,
        None,
        json!(&user),
    )
    .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(user)))
}

pub async fn disable_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let (mut tx, actor) = authorize(&state.db, &headers, Role::Administrator).await?;
    let id = parse_id(&id)?;
    if id == actor {
        return Err(self_blocked(
            "Você não pode desativar a própria conta. Peça a outro administrador.",
        ));
    }
    let user = target_user(&mut tx, id).await?;
    if user.active {
        sqlx::query("UPDATE users SET active = false WHERE id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        revoke(&mut tx, id).await?;
        audit(
            &mut tx,
            actor,
            "USER_DISABLED",
            "user",
            id,
            Some(json!({"active": true})),
            json!({"active": false}),
        )
        .await?;
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn reset_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Body(input): Body<NewPassword>,
) -> Result<StatusCode, ApiError> {
    let id = parse_id(&id)?;
    let (tx, _) = authorize(&state.db, &headers, Role::Administrator).await?;
    tx.rollback().await?;
    let hash = hash_password(input.password).await?;
    let (mut tx, actor) = authorize(&state.db, &headers, Role::Administrator).await?;
    let changed =
        sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2 AND deleted_at IS NULL")
            .bind(hash)
            .bind(id)
            .execute(&mut *tx)
            .await?
            .rows_affected();
    if changed == 0 {
        return Err(ApiError::missing());
    }
    revoke(&mut tx, id).await?;
    audit(
        &mut tx,
        actor,
        "USER_PASSWORD_RESET",
        "user",
        id,
        None,
        json!({"sessions_revoked": true}),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UserChanges {
    name: Option<String>,
    role: Option<Role>,
    /// Texto vazio remove o número; ausente mantém o atual.
    whatsapp: Option<String>,
    /// Cidade da conta; ausente mantém a atual.
    location_id: Option<Uuid>,
}

/// Pendência que impede trocar o perfil ou excluir a conta.
enum Pending {
    Custody,
    Captures,
    Batches,
    Sessions,
    SimCards,
}

impl Pending {
    fn message(&self, deleting: bool) -> &'static str {
        match (self, deleting) {
            (Pending::SimCards, false) => {
                "O técnico ainda tem chips em posse. Receba a devolução antes de trocar o perfil ou a cidade."
            }
            (Pending::SimCards, true) => {
                "O técnico ainda tem chips em posse. Receba a devolução antes de excluir a conta."
            }
            (Pending::Custody, false) => {
                "O técnico ainda tem equipamentos em posse. Receba-os antes de trocar o perfil."
            }
            (Pending::Custody, true) => {
                "O técnico ainda tem equipamentos em posse. Receba-os ou transfira-os antes de excluir a conta."
            }
            (Pending::Captures, false) => {
                "O técnico tem capturas aguardando identificação. Resolva-as antes de trocar o perfil."
            }
            (Pending::Captures, true) => {
                "O técnico tem capturas aguardando identificação. Resolva-as antes de excluir a conta."
            }
            (Pending::Batches, false) => {
                "O técnico tem lotes de devolução em aberto. Encerre-os antes de trocar o perfil."
            }
            (Pending::Batches, true) => {
                "O técnico tem lotes de devolução em aberto. Encerre-os antes de excluir a conta."
            }
            (Pending::Sessions, false) => {
                "A conta participa de sessões de recebimento em aberto. Encerre-as antes de trocar o perfil."
            }
            (Pending::Sessions, true) => {
                "A conta participa de sessões de recebimento em aberto. Encerre-as antes de excluir a conta."
            }
        }
    }
}

/// A conta ainda responde por custódia, capturas sem identificação, lotes
/// ou sessões de recebimento em aberto?
async fn pending_work(db: &mut PgConnection, user: &User) -> Result<Option<Pending>, ApiError> {
    let reason = match user.role {
        Role::Technician => sqlx::query_scalar::<_, Option<String>>(
            "SELECT CASE
                WHEN EXISTS (SELECT 1 FROM equipment WHERE technician_id = $1) THEN 'custody'
                WHEN EXISTS (SELECT 1 FROM captures WHERE technician_id = $1 AND equipment_id IS NULL) THEN 'captures'
                WHEN EXISTS (SELECT 1 FROM delivery_batches WHERE technician_id = $1
                    AND status IN ('SUBMITTED', 'RECEIVING')) THEN 'batches'
                WHEN EXISTS (SELECT 1 FROM receipt_sessions WHERE technician_id = $1 AND closed_at IS NULL) THEN 'sessions'
                WHEN EXISTS (SELECT 1 FROM sim_cards WHERE technician_id = $1) THEN 'sims'
             END",
        ),
        // Administradores também operam a mesa de recebimento.
        Role::WarehouseClerk | Role::Administrator => sqlx::query_scalar::<_, Option<String>>(
            "SELECT CASE
                WHEN EXISTS (SELECT 1 FROM receipt_sessions WHERE clerk_id = $1 AND closed_at IS NULL) THEN 'sessions'
             END",
        ),
    }
    .bind(user.id)
    .fetch_one(db)
    .await?;
    Ok(reason.map(|reason| match reason.as_str() {
        "custody" => Pending::Custody,
        "captures" => Pending::Captures,
        "batches" => Pending::Batches,
        "sims" => Pending::SimCards,
        _ => Pending::Sessions,
    }))
}

/// Trava a conta alvo. Contas excluídas não podem mais ser alteradas.
async fn target_user(db: &mut PgConnection, id: Uuid) -> Result<User, ApiError> {
    sqlx::query_as(
        "SELECT id, name, login, role, active, whatsapp, location_id FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(db)
    .await?
    .ok_or_else(ApiError::missing)
}

/// Impede que o administrador se tranque fora: como quem age é sempre um
/// administrador ativo, proibir a ação sobre si garante que sobre ao menos um.
fn self_blocked(message: &'static str) -> ApiError {
    ApiError(StatusCode::CONFLICT, "SELF_CHANGE_BLOCKED", message)
}

pub async fn update_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Body(input): Body<UserChanges>,
) -> Result<Json<User>, ApiError> {
    let (mut tx, actor) = authorize(&state.db, &headers, Role::Administrator).await?;
    let id = parse_id(&id)?;
    let name = input.name.as_deref().map(checked_name).transpose()?;
    let whatsapp = input
        .whatsapp
        .as_deref()
        .map(checked_whatsapp)
        .transpose()?;
    let before = target_user(&mut tx, id).await?;
    let name = name.unwrap_or(&before.name).to_owned();
    let role = input.role.unwrap_or(before.role);
    let whatsapp = whatsapp.unwrap_or_else(|| before.whatsapp.clone());
    let location = input.location_id.or(before.location_id);
    checked_location_need(role, location)?;
    if let Some(location) = location.filter(|value| Some(*value) != before.location_id) {
        require_location(&mut tx, location).await?;
    }
    let location_changed = location != before.location_id;
    if name == before.name
        && role == before.role
        && whatsapp == before.whatsapp
        && !location_changed
    {
        tx.commit().await?;
        return Ok(Json(before));
    }
    if location_changed
        && before.role != Role::Administrator
        && let Some(pending) = pending_work(&mut tx, &before).await?
    {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "LOCATION_CHANGE_BLOCKED",
            pending.message(false),
        ));
    }
    if role != before.role && id == actor {
        return Err(self_blocked(
            "Você não pode trocar o próprio perfil. Peça a outro administrador.",
        ));
    }
    if role != before.role
        && let Some(pending) = pending_work(&mut tx, &before).await?
    {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "ROLE_CHANGE_BLOCKED",
            pending.message(false),
        ));
    }
    let after: User = sqlx::query_as(
        "UPDATE users SET name = $1, role = $2, whatsapp = $4, location_id = $5 WHERE id = $3
         RETURNING id, name, login, role, active, whatsapp, location_id",
    )
    .bind(&name)
    .bind(role)
    .bind(id)
    .bind(&whatsapp)
    .bind(location)
    .fetch_one(&mut *tx)
    .await?;
    if role != before.role || location_changed {
        // Sessões emitidas para o perfil ou a cidade anterior não devem sobreviver à troca.
        revoke(&mut tx, id).await?;
    }
    audit(
        &mut tx,
        actor,
        "USER_UPDATED",
        "user",
        id,
        Some(json!({"name": before.name, "role": before.role, "whatsapp": before.whatsapp, "location_id": before.location_id})),
        json!({"name": after.name, "role": after.role, "whatsapp": after.whatsapp, "location_id": after.location_id,
            "sessions_revoked": role != before.role || location_changed}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(after))
}

/// Exclui a conta. Sem nenhum vínculo (capturas, movimentos, auditoria),
/// a linha é apagada. Com histórico, a conta é arquivada: sai das listas e
/// não entra mais, mas nomes e movimentações antigas continuam rastreáveis.
pub async fn delete_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let (mut tx, actor) = authorize(&state.db, &headers, Role::Administrator).await?;
    let id = parse_id(&id)?;
    if id == actor {
        return Err(self_blocked(
            "Você não pode excluir a própria conta. Peça a outro administrador.",
        ));
    }
    let user = target_user(&mut tx, id).await?;
    if let Some(pending) = pending_work(&mut tx, &user).await? {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "DELETE_BLOCKED",
            pending.message(true),
        ));
    }
    revoke(&mut tx, id).await?;
    sqlx::query("SAVEPOINT delete_user")
        .execute(&mut *tx)
        .await?;
    let removed = match sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
    {
        Ok(_) => true,
        Err(sqlx::Error::Database(error)) if error.code().as_deref() == Some("23503") => {
            sqlx::query("ROLLBACK TO SAVEPOINT delete_user")
                .execute(&mut *tx)
                .await?;
            sqlx::query("UPDATE users SET active = false, deleted_at = now() WHERE id = $1")
                .bind(id)
                .execute(&mut *tx)
                .await?;
            false
        }
        Err(error) => return Err(error.into()),
    };
    let mode = if removed { "removed" } else { "archived" };
    audit(
        &mut tx,
        actor,
        "USER_DELETED",
        "user",
        id,
        Some(json!(&user)),
        json!({"mode": mode, "sessions_revoked": true}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"mode": mode})))
}

pub async fn enable_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let (mut tx, actor) = authorize(&state.db, &headers, Role::Administrator).await?;
    let id = parse_id(&id)?;
    let user = target_user(&mut tx, id).await?;
    if !user.active {
        sqlx::query("UPDATE users SET active = true WHERE id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        audit(
            &mut tx,
            actor,
            "USER_ENABLED",
            "user",
            id,
            Some(json!({"active": false})),
            json!({"active": true}),
        )
        .await?;
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn revoke(db: &mut PgConnection, id: Uuid) -> Result<(), ApiError> {
    sqlx::query("DELETE FROM sessions WHERE user_id = $1")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

async fn insert_user(
    db: &mut PgConnection,
    name: &str,
    login: &str,
    hash: &str,
    role: Role,
    whatsapp: Option<&str>,
    location: Option<Uuid>,
) -> Result<User, ApiError> {
    sqlx::query_as(
        "INSERT INTO users (id, name, login, password_hash, role, whatsapp, location_id) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (login) DO NOTHING RETURNING id, name, login, role, active, whatsapp, location_id",
    )
    .bind(Uuid::new_v4())
    .bind(name)
    .bind(login)
    .bind(hash)
    .bind(role)
    .bind(whatsapp)
    .bind(location)
    .fetch_optional(db)
    .await?
    .ok_or(ApiError(
        StatusCode::CONFLICT,
        "LOGIN_EXISTS",
        "Este login já está cadastrado.",
    ))
}

/// Técnicos e estoquistas precisam de uma cidade; administradores, não.
fn checked_location_need(role: Role, location: Option<Uuid>) -> Result<Option<Uuid>, ApiError> {
    if role != Role::Administrator && location.is_none() {
        return Err(ApiError::invalid(
            "Escolha a cidade do técnico ou estoquista.",
        ));
    }
    Ok(location)
}

async fn require_location(db: &mut PgConnection, location: Uuid) -> Result<(), ApiError> {
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM locations WHERE id = $1)")
        .bind(location)
        .fetch_one(db)
        .await?;
    if !exists {
        return Err(ApiError::invalid("Cidade não encontrada."));
    }
    Ok(())
}

pub fn parse_id(value: &str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(value).map_err(|_| ApiError::invalid("Identificador UUID inválido."))
}

pub async fn audit(
    db: &mut PgConnection,
    actor: Uuid,
    action: &str,
    entity: &str,
    id: Uuid,
    before: Option<Value>,
    after: Value,
) -> Result<(), ApiError> {
    sqlx::query("INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, before_json, after_json, request_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)")
        .bind(Uuid::new_v4()).bind(actor).bind(action).bind(entity).bind(id)
        .bind(before).bind(after).bind(request_id()).execute(db).await?;
    Ok(())
}

pub async fn bootstrap(db: &PgPool) -> Result<(), Box<dyn std::error::Error>> {
    let credentials = tokio::task::spawn_blocking(|| -> Result<_, std::io::Error> {
        let login = rpassword::prompt_password("Login do administrador: ")?;
        let name = rpassword::prompt_password("Nome do administrador: ")?;
        let password = rpassword::prompt_password("Senha inicial: ")?;
        let confirmation = rpassword::prompt_password("Confirme a senha inicial: ")?;
        Ok((login, name, password, confirmation))
    })
    .await??;
    let (login, name, password, confirmation) = credentials;
    if password != confirmation {
        return Err("As senhas informadas são diferentes.".into());
    }
    let hash = hash_password(password).await?;
    let mut tx = db.begin().await?;
    sqlx::query("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE")
        .execute(&mut *tx)
        .await?;
    if sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM users WHERE role = 'administrator')",
    )
    .fetch_one(&mut *tx)
    .await?
    {
        return Err("O administrador inicial já foi cadastrado.".into());
    }
    let user = insert_user(
        &mut tx,
        checked_name(&name)?,
        &checked_login(&login)?,
        &hash,
        Role::Administrator,
        None,
        None,
    )
    .await?;
    audit(
        &mut tx,
        user.id,
        "ADMIN_BOOTSTRAPPED",
        "user",
        user.id,
        None,
        json!(&user),
    )
    .await?;
    tx.commit().await?;
    println!("Administrador inicial cadastrado.");
    Ok(())
}
