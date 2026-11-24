use std::io::Cursor;

use axum::{
    Json,
    body::Bytes,
    extract::{Path, State, rejection::BytesRejection},
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, Utc};
use image::{ImageFormat, ImageReader, Limits};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, types::Json as SqlJson};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{Role, audit, authorize, parse_id},
    error::{ApiError, Body, request_id},
};

pub const MAX_IMAGE_BYTES: usize = 12 * 1024 * 1024;

#[derive(Deserialize)]
pub struct CreateUpload {
    client_capture_id: Uuid,
    captured_at_device: DateTime<Utc>,
    sha256: String,
    byte_length: i32,
    barcode_evidence: Option<BarcodeEvidence>,
    complement: Option<CaptureComplement>,
}

#[derive(Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct CaptureComplement {
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    service_order: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    condition: Option<CollectionCondition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    power_supply: Option<CollectionPowerSupply>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cables: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    notes: Option<String>,
}

#[derive(Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum CollectionCondition {
    Good,
    Damaged,
}

#[derive(Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum CollectionPowerSupply {
    Original,
    Replacement,
    Missing,
}

#[derive(Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct BarcodeEvidence {
    raw_value: String,
    source: BarcodeSource,
}

#[derive(Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum BarcodeSource {
    Manual,
    BarcodeDetector,
    Zxing,
}

#[derive(Serialize)]
pub struct CaptureStatus {
    id: Uuid,
    status: String,
    received: bool,
}

#[derive(sqlx::FromRow)]
struct Upload {
    id: Uuid,
    client_capture_id: Uuid,
    image_object_key: String,
    sha256: Vec<u8>,
    byte_length: i32,
    barcode_evidence: Option<SqlJson<BarcodeEvidence>>,
    complement: Option<SqlJson<CaptureComplement>>,
    captured_at_device: DateTime<Utc>,
}

#[derive(sqlx::FromRow)]
struct StoredCapture {
    id: Uuid,
    sha256: Vec<u8>,
    captured_at_device: DateTime<Utc>,
    status: String,
    barcode_evidence: Option<SqlJson<BarcodeEvidence>>,
    complement: Option<SqlJson<CaptureComplement>>,
}

impl CaptureStatus {
    fn pending(id: Uuid) -> Self {
        Self {
            id,
            status: "AWAITING_IMAGE".into(),
            received: false,
        }
    }

    fn received(id: Uuid, status: String) -> Self {
        Self {
            id,
            status,
            received: true,
        }
    }
}

fn conflict() -> ApiError {
    ApiError(
        StatusCode::CONFLICT,
        "CAPTURE_CONFLICT",
        "O identificador da captura já está associado a outros dados.",
    )
}

fn unavailable() -> ApiError {
    ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        "STORAGE_UNAVAILABLE",
        "Não foi possível acessar o armazenamento. Tente novamente.",
    )
}

fn missing_image() -> ApiError {
    ApiError(
        StatusCode::CONFLICT,
        "IMAGE_NOT_READY",
        "A imagem ainda precisa ser enviada ou reenviada.",
    )
}

fn validate_barcode(barcode: Option<&BarcodeEvidence>) -> Result<(), ApiError> {
    if barcode.is_some_and(|barcode| {
        let value = &barcode.raw_value;
        value.trim().is_empty() || value.len() > 128 || value.chars().any(char::is_control)
    }) {
        return Err(ApiError::invalid(
            "O código opcional deve ter até 128 bytes.",
        ));
    }
    Ok(())
}

fn parse_checksum(value: &str) -> Result<Vec<u8>, ApiError> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ApiError::invalid(
            "Informe um SHA-256 hexadecimal com 64 caracteres.",
        ));
    }
    Ok((0..64)
        .step_by(2)
        .map(|start| u8::from_str_radix(&value[start..start + 2], 16).unwrap())
        .collect())
}

async fn stored_status(
    db: &mut PgConnection,
    technician: Uuid,
    id: Uuid,
) -> Result<Option<CaptureStatus>, ApiError> {
    let status =
        sqlx::query_scalar("SELECT status FROM captures WHERE technician_id = $1 AND id = $2")
            .bind(technician)
            .bind(id)
            .fetch_optional(db)
            .await?;
    Ok(status.map(|status| CaptureStatus::received(id, status)))
}

async fn upload(db: &mut PgConnection, technician: Uuid, id: Uuid) -> Result<Upload, ApiError> {
    sqlx::query_as(
        "SELECT id, client_capture_id, image_object_key, sha256, byte_length, captured_at_device, barcode_evidence, complement
         FROM capture_uploads WHERE technician_id = $1 AND id = $2 FOR UPDATE",
    )
    .bind(technician)
    .bind(id)
    .fetch_optional(db)
    .await?
    .ok_or_else(ApiError::missing)
}

pub async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Body(input): Body<CreateUpload>,
) -> Result<Json<CaptureStatus>, ApiError> {
    let (mut tx, technician) = authorize(&state.db, &headers, Role::Technician).await?;
    if input.byte_length <= 0 || input.byte_length as usize > MAX_IMAGE_BYTES {
        return Err(ApiError::invalid("A foto deve ter entre 1 byte e 12 MiB."));
    }
    let sha256 = parse_checksum(&input.sha256)?;
    validate_barcode(input.barcode_evidence.as_ref())?;
    if let Some(details) = &input.complement {
        for (value, limit) in [
            (&details.model, 160),
            (&details.service_order, 160),
            (&details.notes, 2000),
        ] {
            if value
                .as_ref()
                .is_some_and(|value| value.chars().count() > limit || value.contains('\0'))
            {
                return Err(ApiError::invalid(
                    "Modelo e OS aceitam até 160 caracteres. Observações aceitam até 2.000 caracteres.",
                ));
            }
        }
    }
    let captured_at = DateTime::from_timestamp_micros(input.captured_at_device.timestamp_micros())
        .ok_or_else(|| ApiError::invalid("Data da captura inválida."))?;
    let candidate = Uuid::new_v4();
    let existing: Option<StoredCapture> = sqlx::query_as(
        "SELECT id, sha256, captured_at_device, status, barcode_evidence, complement FROM captures
         WHERE technician_id = $1 AND client_capture_id = $2",
    )
    .bind(technician)
    .bind(input.client_capture_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(previous) = existing {
        if previous.sha256 != sha256
            || previous.captured_at_device != captured_at
            || previous.barcode_evidence.as_ref().map(|value| &value.0)
                != input.barcode_evidence.as_ref()
            || previous
                .complement
                .as_ref()
                .is_some_and(|previous| Some(&previous.0) != input.complement.as_ref())
        {
            return Err(conflict());
        }
        let previous_length: Option<i32> =
            sqlx::query_scalar("SELECT byte_length FROM capture_uploads WHERE id = $1")
                .bind(previous.id)
                .fetch_optional(&mut *tx)
                .await?;
        if previous_length.is_some_and(|length| length != input.byte_length) {
            return Err(conflict());
        }
        tx.commit().await?;
        return Ok(Json(CaptureStatus::received(previous.id, previous.status)));
    }
    sqlx::query(
        "INSERT INTO capture_uploads (id, client_capture_id, technician_id, image_object_key, sha256, byte_length, captured_at_device, barcode_evidence, complement)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (technician_id, client_capture_id) DO NOTHING",
    ).bind(candidate).bind(input.client_capture_id).bind(technician).bind(format!("labels/{}", Uuid::new_v4()))
        .bind(&sha256).bind(input.byte_length).bind(captured_at).bind(input.barcode_evidence.as_ref().map(SqlJson)).bind(input.complement.as_ref().map(SqlJson)).execute(&mut *tx).await?;
    let row: Upload = sqlx::query_as(
        "SELECT id, client_capture_id, image_object_key, sha256, byte_length, captured_at_device, barcode_evidence, complement
         FROM capture_uploads WHERE technician_id = $1 AND client_capture_id = $2",
    )
    .bind(technician)
    .bind(input.client_capture_id)
    .fetch_one(&mut *tx)
    .await?;
    if row.sha256 != sha256
        || row.byte_length != input.byte_length
        || row.captured_at_device != captured_at
        || row.barcode_evidence.as_ref().map(|value| &value.0) != input.barcode_evidence.as_ref()
        || row
            .complement
            .as_ref()
            .is_some_and(|previous| Some(&previous.0) != input.complement.as_ref())
    {
        return Err(conflict());
    }
    if row.complement.is_none() && input.complement.is_some() {
        sqlx::query("UPDATE capture_uploads SET complement = $2 WHERE id = $1")
            .bind(row.id)
            .bind(input.complement.as_ref().map(SqlJson))
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(Json(CaptureStatus::pending(row.id)))
}

fn validate_image(bytes: &[u8]) -> Result<&'static str, ApiError> {
    let invalid =
        || ApiError::invalid("Envie uma foto JPEG, PNG ou WebP válida com até 24 megapixels.");
    let format = image::guess_format(bytes).map_err(|_| invalid())?;
    let mime = match format {
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::Png => "image/png",
        ImageFormat::WebP => "image/webp",
        _ => return Err(invalid()),
    };
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(120 * 1024 * 1024);
    reader.limits(limits.clone());
    let decoder = reader.into_decoder().map_err(|_| invalid())?;
    use image::ImageDecoder;
    let (width, height) = decoder.dimensions();
    if u64::from(width) * u64::from(height) > 24_000_000 || decoder.total_bytes() > 96_000_000 {
        return Err(invalid());
    }
    image::DynamicImage::from_decoder(decoder).map_err(|_| invalid())?;
    Ok(mime)
}

pub async fn put_image(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    bytes: Result<Bytes, BytesRejection>,
) -> Result<Json<CaptureStatus>, ApiError> {
    let (mut tx, technician) = authorize(&state.db, &headers, Role::Technician).await?;
    let id = parse_id(&id)?;
    if let Some(result) = stored_status(&mut tx, technician, id).await? {
        tx.commit().await?;
        return Ok(Json(result));
    }
    let row = upload(&mut tx, technician, id).await?;
    let bytes = bytes.map_err(|error| {
        ApiError(
            error.status(),
            "INVALID_IMAGE",
            "Falha ao ler a imagem. O limite é 12 MiB.",
        )
    })?;
    if bytes.len() != row.byte_length as usize || Sha256::digest(&bytes)[..] != row.sha256 {
        return Err(ApiError::invalid(
            "A imagem enviada tem tamanho ou SHA-256 diferente da captura.",
        ));
    }
    let (bytes, mime) =
        tokio::task::spawn_blocking(move || validate_image(&bytes).map(|mime| (bytes, mime)))
            .await
            .map_err(|_| ApiError::internal())??;
    state
        .storage
        .write_image(&row.image_object_key, bytes, mime)
        .await
        .map_err(|_| unavailable())?;
    tx.commit().await?;
    Ok(Json(CaptureStatus::pending(id)))
}

pub async fn complete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<CaptureStatus>, ApiError> {
    let (mut tx, technician) = authorize(&state.db, &headers, Role::Technician).await?;
    let id = parse_id(&id)?;
    if let Some(result) = stored_status(&mut tx, technician, id).await? {
        tx.commit().await?;
        return Ok(Json(result));
    }
    let row = upload(&mut tx, technician, id).await?;
    let image = state
        .storage
        .read_image(&row.image_object_key, row.byte_length as usize)
        .await
        .map_err(|error| match error {
            object_store::Error::NotFound { .. } => missing_image(),
            _ => unavailable(),
        })?;
    if image.len() != row.byte_length as usize || Sha256::digest(&image)[..] != row.sha256 {
        return Err(missing_image());
    }
    sqlx::query(
        "INSERT INTO captures (id, client_capture_id, technician_id, image_object_key, sha256, captured_at_device, status, barcode_evidence, complement)
         VALUES ($1, $2, $3, $4, $5, $6, 'OCR_PENDING', $7, $8)",
    ).bind(id).bind(row.client_capture_id).bind(technician).bind(&row.image_object_key)
        .bind(&row.sha256).bind(row.captured_at_device).bind(row.barcode_evidence).bind(row.complement).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO jobs (id, kind, capture_id) VALUES ($1, 'LABEL_RECOGNITION', $2)")
        .bind(Uuid::new_v4())
        .bind(id)
        .execute(&mut *tx)
        .await?;
    audit(
        &mut tx,
        technician,
        "CAPTURE_RECEIVED",
        "capture",
        id,
        None,
        serde_json::json!({"status":"OCR_PENDING"}),
    )
    .await?;
    tx.commit().await?;
    tracing::info!(capture_id = %id, request_id = %request_id(), "Captura recebida e enfileirada");
    Ok(Json(CaptureStatus::received(id, "OCR_PENDING".into())))
}

pub async fn get_capture(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<CaptureStatus>, ApiError> {
    let (mut tx, technician) = authorize(&state.db, &headers, Role::Technician).await?;
    let id = parse_id(&id)?;
    let result = if let Some(result) = stored_status(&mut tx, technician, id).await? {
        result
    } else {
        upload(&mut tx, technician, id).await?;
        CaptureStatus::pending(id)
    };
    tx.commit().await?;
    Ok(Json(result))
}
