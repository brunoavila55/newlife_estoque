use std::{env, sync::Arc};

use axum::{
    Json, Router,
    routing::{get, post, put},
};
use serde_json::json;
use sqlx::{PgPool, postgres::PgPoolOptions};

mod auth;
mod backup;
mod batches;
mod captures;
mod custody;
mod error;
mod operations;
mod receipts;
mod recognition;
mod review_queue;
mod storage;
mod worker;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../../migrations");

#[derive(Clone)]
struct AppState {
    db: PgPool,
    storage: Arc<dyn storage::ObjectStorage>,
    fallback_password_hash: Arc<str>,
    operations: Arc<operations::Operations>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt().init();
    let command: Vec<_> = env::args().skip(1).collect();
    let operation = match command.as_slice() {
        [] => None,
        [action] if matches!(action.as_str(), "bootstrap-admin" | "worker" | "migrate") => None,
        [action, directory] if matches!(action.as_str(), "backup" | "restore" | "verify-backup") => {
            Some((action.as_str(), std::path::Path::new(directory)))
        }
        _ => return Err("Uso: stock-api [bootstrap-admin | worker | migrate | backup DIRETÓRIO | restore DIRETÓRIO | verify-backup DIRETÓRIO]".into()),
    };
    let database_url = env::var("DATABASE_URL")?;
    let db = PgPoolOptions::new()
        .max_connections(10)
        .connect(&database_url)
        .await?;
    if let Some((action, directory)) = operation {
        let storage = storage::S3Storage::from_env()?;
        backup::execute(action, directory, &database_url, &db, &storage).await?;
        return Ok(());
    }
    let explicit_migration = command
        .first()
        .is_some_and(|value| matches!(value.as_str(), "migrate" | "bootstrap-admin"));
    if explicit_migration || env::var("API_AUTO_MIGRATE").as_deref() != Ok("false") {
        MIGRATOR.run(&db).await?;
    }
    if command.first().is_some_and(|value| value == "migrate") {
        return Ok(());
    }
    if command
        .first()
        .is_some_and(|value| value == "bootstrap-admin")
    {
        auth::bootstrap(&db).await?;
        return Ok(());
    }
    let storage = storage::S3Storage::from_env()?;
    if command.first().is_some_and(|value| value == "worker") {
        let provider = recognition::Tesseract::from_env().await?;
        worker::run(&db, &storage, &provider).await;
        return Ok(());
    }
    let state = AppState {
        db,
        storage: Arc::new(storage),
        operations: Arc::new(operations::Operations::new(env::var("METRICS_TOKEN").ok())?),
        fallback_password_hash: auth::hash_password(uuid::Uuid::new_v4().to_string())
            .await?
            .into(),
    };
    let listener = tokio::net::TcpListener::bind(
        env::var("API_BIND").unwrap_or_else(|_| "127.0.0.1:3000".into()),
    )
    .await?;
    tracing::info!(address = %listener.local_addr()?, "API em execução");
    axum::serve(listener, router(state))
        .with_graceful_shutdown(operations::shutdown_signal())
        .await?;
    Ok(())
}

fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(|| async { Json(json!({"status": "ok"})) }))
        .route("/ready", get(operations::readiness))
        .route("/metrics", get(operations::metrics))
        .route("/api/v1/audit-events", get(operations::audit_events))
        .route(
            "/api/v1/admin/retention-report",
            get(operations::retention_report),
        )
        .route("/api/v1/auth/login", post(auth::login))
        .route("/api/v1/auth/refresh", post(auth::refresh))
        .route("/api/v1/auth/logout", post(auth::logout))
        .route("/api/v1/auth/web/login", post(auth::web_login))
        .route("/api/v1/auth/web/refresh", post(auth::web_refresh))
        .route("/api/v1/auth/web/logout", post(auth::web_logout))
        .route("/api/v1/admin/captures", get(review_queue::list))
        .route("/api/v1/admin/captures/{id}", get(review_queue::detail))
        .route(
            "/api/v1/admin/captures/{id}/reprocess",
            post(review_queue::reprocess),
        )
        .route(
            "/api/v1/admin/users",
            get(auth::list_users).post(auth::create_user),
        )
        .route(
            "/api/v1/admin/users/{id}/inventory",
            get(custody::admin_inventory),
        )
        .route(
            "/api/v1/admin/users/{id}/deliveries",
            get(custody::admin_deliveries),
        )
        .route("/api/v1/admin/users/{id}/disable", post(auth::disable_user))
        .route(
            "/api/v1/admin/users/{id}/reset-password",
            post(auth::reset_password),
        )
        .route("/api/v1/me/inventory", get(custody::inventory))
        .route("/api/v1/me/custody", get(batches::my_custody))
        .route(
            "/api/v1/me/batches",
            get(batches::my_batches).post(batches::create),
        )
        .route("/api/v1/me/batches/{id}", get(batches::my_batch))
        .route("/api/v1/me/batches/{id}/cancel", post(batches::cancel))
        .route(
            "/api/v1/warehouse/technicians-summary",
            get(batches::technicians_summary),
        )
        .route(
            "/api/v1/warehouse/technicians/{id}/custody",
            get(batches::technician_custody),
        )
        .route("/api/v1/warehouse/batches", get(batches::warehouse_batches))
        .route(
            "/api/v1/warehouse/batches/{id}",
            get(batches::warehouse_batch),
        )
        .route(
            "/api/v1/warehouse/batches/{id}/receive",
            post(batches::receive),
        )
        .route("/api/v1/captures/{id}/image-url", get(custody::image_url))
        .route("/api/v1/captures/{id}/review", post(custody::review))
        .route("/api/v1/captures", post(captures::create))
        .route("/api/v1/captures/{id}", get(captures::get_capture))
        .route("/api/v1/captures/{id}/complete", post(captures::complete))
        .route(
            "/api/v1/captures/{id}/image",
            put(captures::put_image).layer(axum::extract::DefaultBodyLimit::max(
                captures::MAX_IMAGE_BYTES,
            )),
        )
        .route("/api/v1/receipt-exceptions", get(receipts::exceptions))
        .route("/api/v1/receipt-lookup", post(receipts::lookup))
        .route(
            "/api/v1/warehouse/equipment/lookup",
            get(receipts::trace_equipment),
        )
        .route("/api/v1/receipt-technicians", get(receipts::technicians))
        .route(
            "/api/v1/receipt-sessions",
            get(receipts::list).post(receipts::open),
        )
        .route("/api/v1/receipt-sessions/{id}", get(receipts::detail))
        .route("/api/v1/receipt-sessions/{id}/scan", post(receipts::scan))
        .route(
            "/api/v1/receipt-sessions/{id}/confirm",
            post(receipts::confirm),
        )
        .route("/api/v1/receipt-sessions/{id}/close", post(receipts::close))
        .route(
            "/api/v1/receipt-sessions/{id}/identify",
            post(receipts::identify),
        )
        .route(
            "/api/v1/receipt-sessions/{id}/include",
            post(receipts::include),
        )
        .route(
            "/api/v1/receipt-sessions/{id}/captures/{capture_id}/image-url",
            get(receipts::capture_image_url),
        )
        .route(
            "/api/v1/receipt-sessions/{id}/items/{equipment_id}",
            get(receipts::get_item),
        )
        .route(
            "/api/v1/receipt-sessions/{id}/items/{equipment_id}/image-url",
            get(receipts::image_url),
        )
        .fallback(|| async { error::ApiError::missing() })
        .method_not_allowed_fallback(|| async {
            error::ApiError(
                axum::http::StatusCode::METHOD_NOT_ALLOWED,
                "METHOD_NOT_ALLOWED",
                "Método não permitido para esta rota.",
            )
        })
        .layer(axum::extract::DefaultBodyLimit::max(16 * 1024))
        .layer(axum::middleware::from_fn_with_state(
            state.operations.clone(),
            error::request_context,
        ))
        .with_state(state)
}

#[cfg(test)]
mod tests;
