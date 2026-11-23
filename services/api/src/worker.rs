use std::time::{Duration, Instant};

use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    captures::MAX_IMAGE_BYTES,
    recognition::{Failure, LabelRecognitionProvider, Reading, labels},
    storage::ObjectStorage,
};

const MAX_ATTEMPTS: i32 = 3;

#[derive(sqlx::FromRow)]
pub struct Job {
    id: Uuid,
    capture_id: Uuid,
    image_object_key: String,
    sha256: Vec<u8>,
    barcode_evidence: Option<Value>,
    attempts: i32,
    run_id: Uuid,
    exhausted: bool,
}

pub async fn run(
    db: &PgPool,
    storage: &impl ObjectStorage,
    provider: &impl LabelRecognitionProvider,
) {
    tracing::info!(
        engine = provider.name(),
        version = provider.model_version(),
        "Worker de OCR em execução"
    );
    let shutdown = crate::operations::shutdown_signal();
    tokio::pin!(shutdown);
    loop {
        let processing = process_one(db, storage, provider);
        tokio::select! {
            _ = &mut shutdown => break,
            result = processing => {
                if matches!(result, Ok(true)) {
                    continue;
                }
                if let Err(error) = result {
                    tracing::error!(sqlstate = ?error.as_database_error().and_then(|error| error.code()), "Falha na fila de OCR");
                }
            }
        }
        tokio::select! {
            _ = &mut shutdown => break,
            _ = tokio::time::sleep(Duration::from_secs(2)) => {}
        }
    }
}

pub async fn process_one(
    db: &PgPool,
    storage: &impl ObjectStorage,
    provider: &impl LabelRecognitionProvider,
) -> Result<bool, sqlx::Error> {
    let Some(job) = claim(db).await? else {
        return Ok(false);
    };
    let started = Instant::now();
    let result = if job.exhausted {
        Err(Failure::LeaseExpired)
    } else {
        read_label(storage, provider, &job).await
    };
    finish(
        db,
        provider,
        job,
        result,
        started.elapsed().as_millis() as i64,
    )
    .await?;
    Ok(true)
}

pub async fn claim(db: &PgPool) -> Result<Option<Job>, sqlx::Error> {
    let mut tx = db.begin().await?;
    // Todos os fluxos que alteram captura e job bloqueiam a captura primeiro.
    let capture = sqlx::query_as::<_, (Uuid, i32)>(
        "SELECT c.id, j.attempts
         FROM jobs j JOIN captures c ON c.id = j.capture_id
         WHERE j.kind = 'LABEL_RECOGNITION' AND (
           (j.status = 'PENDING' AND j.next_run_at <= now()) OR
           (j.status = 'RUNNING' AND j.locked_at <= now() - interval '90 seconds')
         )
         ORDER BY j.next_run_at, j.id LIMIT 1 FOR UPDATE OF c SKIP LOCKED",
    )
    .fetch_optional(&mut *tx)
    .await?;
    let Some((capture, attempts)) = capture else {
        tx.commit().await?;
        return Ok(None);
    };
    let job: Option<Job> = sqlx::query_as(
        "UPDATE jobs j SET status = 'RUNNING', locked_at = now(), run_id = $2,
            attempts = CASE WHEN j.attempts < $3 THEN j.attempts + 1 ELSE j.attempts END
         FROM captures c
         WHERE j.capture_id = c.id AND j.kind = 'LABEL_RECOGNITION' AND c.id = $1 AND j.attempts = $4 AND (
           (j.status = 'PENDING' AND j.next_run_at <= now()) OR
           (j.status = 'RUNNING' AND j.locked_at <= now() - interval '90 seconds')
         )
         RETURNING j.id, j.capture_id, j.run_id, j.attempts,
            c.image_object_key, c.sha256, c.barcode_evidence,
            ($4 >= $3) AS exhausted",
    )
    .bind(capture)
    .bind(Uuid::new_v4())
    .bind(MAX_ATTEMPTS)
    .bind(attempts)
    .fetch_optional(&mut *tx)
    .await?;
    if job.is_some() {
        sqlx::query("UPDATE captures SET status = 'OCR_PROCESSING' WHERE id = $1 AND status = 'OCR_PENDING'")
            .bind(capture).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(job)
}

async fn read_label(
    storage: &impl ObjectStorage,
    provider: &impl LabelRecognitionProvider,
    job: &Job,
) -> Result<(String, Reading), Failure> {
    let image = storage
        .read_image(&job.image_object_key, MAX_IMAGE_BYTES)
        .await
        .map_err(|_| Failure::StorageUnavailable)?;
    if image.is_empty() || Sha256::digest(&image)[..] != job.sha256 {
        return Err(Failure::ImageIntegrity);
    }
    let raw = provider.recognize(image).await?;
    let barcode = job
        .barcode_evidence
        .as_ref()
        .and_then(|evidence| evidence["raw_value"].as_str());
    let reading = labels::parse(&raw, barcode);
    Ok((raw, reading))
}

async fn finish(
    db: &PgPool,
    provider: &impl LabelRecognitionProvider,
    job: Job,
    result: Result<(String, Reading), Failure>,
    duration_ms: i64,
) -> Result<(), sqlx::Error> {
    let mut tx = db.begin().await?;
    sqlx::query("SELECT id FROM captures WHERE id = $1 FOR UPDATE")
        .bind(job.capture_id)
        .execute(&mut *tx)
        .await?;
    let (job_status, capture_status, failure) = match &result {
        Ok(_) => ("SUCCEEDED", "NEEDS_REVIEW", None),
        Err(error) if error.retryable() && job.attempts < MAX_ATTEMPTS => {
            ("PENDING", "OCR_PENDING", Some(error.code()))
        }
        Err(error) => ("FAILED", "OCR_FAILED", Some(error.code())),
    };
    let delay = 15 * 2_i32.pow((job.attempts - 1).clamp(0, MAX_ATTEMPTS - 1) as u32);
    let count = sqlx::query(
        "UPDATE jobs SET status = $1, last_error = $2, locked_at = NULL, run_id = NULL,
            next_run_at = now() + $3 * interval '1 second'
         WHERE id = $4 AND run_id = $5 AND status = 'RUNNING'",
    )
    .bind(job_status)
    .bind(failure)
    .bind(delay)
    .bind(job.id)
    .bind(job.run_id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if count == 0 {
        tx.rollback().await?;
        return Ok(());
    }
    let (raw, suggestions, warnings) = match result {
        Ok((raw, reading)) => (
            Some(raw),
            serde_json::json!(reading.suggestions),
            serde_json::json!(reading.warnings),
        ),
        Err(_) => (None, serde_json::json!([]), serde_json::json!([])),
    };
    sqlx::query(
        "INSERT INTO ocr_results (id, capture_id, provider, model_version, status, raw_tsv, suggestions, warnings, failure_code, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    ).bind(job.run_id).bind(job.capture_id).bind(provider.name()).bind(provider.model_version())
        .bind(if raw.is_some() { "RECOGNIZED" } else { "FAILED" })
        .bind(raw).bind(suggestions).bind(warnings).bind(failure).bind(duration_ms).execute(&mut *tx).await?;

    // A decisão humana pode ter sido registrada enquanto o OCR estava em execução.
    sqlx::query("UPDATE captures SET status = $1 WHERE id = $2 AND status = 'OCR_PROCESSING'")
        .bind(capture_status)
        .bind(job.capture_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    tracing::info!(capture_id = %job.capture_id, attempts = job.attempts, status = job_status, failure, "Tentativa de OCR concluída");
    Ok(())
}
