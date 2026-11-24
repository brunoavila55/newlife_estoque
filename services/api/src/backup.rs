use std::{
    fs::{self, DirBuilder, File},
    io::{self, Read},
    path::{Path, PathBuf},
    process::Stdio,
};

use axum::body::Bytes;
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, PgPool, postgres::PgConnectOptions};
use tokio::process::Command;
use url::Url;
use uuid::Uuid;

use crate::{
    captures::MAX_IMAGE_BYTES,
    storage::{ObjectStorage, S3Storage},
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

const ARCHIVE: &str = "postgres.dump";
const MANIFEST: &str = "manifest.json";
const FORMAT_VERSION: u32 = 1;

#[derive(Debug, Deserialize, PartialEq, Serialize, sqlx::FromRow)]
struct Photo {
    id: Uuid,
    image_object_key: String,
    sha256: Vec<u8>,
}

#[derive(Deserialize, Serialize)]
struct Manifest {
    format_version: u32,
    postgres_sha256: Vec<u8>,
    captures: Vec<Photo>,
}

pub async fn execute(
    action: &str,
    directory: &Path,
    database_url: &str,
    db: &PgPool,
    storage: &S3Storage,
) -> Result<()> {
    match action {
        "backup" => backup(directory, database_url, db, storage).await,
        "restore" => restore(directory, database_url, db, storage).await,
        "verify-backup" => {
            let manifest = load(directory)?;
            validate_local_photos(directory, &manifest)?;
            verify(db, storage, &manifest).await
        }
        _ => Err("Comando de backup inválido.".into()),
    }
}

async fn photos(db: &mut PgConnection) -> Result<Vec<Photo>> {
    Ok(
        sqlx::query_as("SELECT id, image_object_key, sha256 FROM captures ORDER BY id")
            .fetch_all(db)
            .await?,
    )
}

async fn backup(
    directory: &Path,
    database_url: &str,
    db: &PgPool,
    storage: &impl ObjectStorage,
) -> Result<()> {
    if directory.exists() || directory.symlink_metadata().is_ok() {
        return Err("O diretório de destino já existe.".into());
    }
    let parent = directory
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let temporary = parent.join(format!(".backup-{}", Uuid::new_v4()));
    private_directory(&temporary)?;
    let result = write_backup(&temporary, database_url, db, storage).await;
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&temporary);
        return Err(error);
    }
    if let Err(error) = fs::rename(&temporary, directory) {
        let _ = fs::remove_dir_all(&temporary);
        return Err(error.into());
    }
    println!("Backup concluído e verificado.");
    Ok(())
}

async fn write_backup(
    directory: &Path,
    database_url: &str,
    db: &PgPool,
    storage: &impl ObjectStorage,
) -> Result<()> {
    private_directory(&directory.join("photos"))?;
    let mut tx = db.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    let snapshot: String = sqlx::query_scalar("SELECT pg_export_snapshot()")
        .fetch_one(&mut *tx)
        .await?;
    let captures = photos(&mut tx).await?;
    let archive = directory.join(ARCHIVE);
    run(postgres_tool("pg_dump", database_url)?
        .args([
            "--format=custom",
            "--no-owner",
            "--no-privileges",
            "--exclude-table-data=public.sessions",
            "--snapshot",
        ])
        .arg(snapshot)
        .stdout(Stdio::from(File::create(&archive)?)))
    .await?;
    tx.commit().await?;

    for photo in &captures {
        let bytes = checked_photo(storage, photo).await?;
        photo_mime(&bytes)?;
        fs::write(photo_path(directory, photo.id), bytes)?;
    }
    let manifest = Manifest {
        format_version: FORMAT_VERSION,
        postgres_sha256: file_hash(&archive)?,
        captures,
    };
    fs::write(
        directory.join(MANIFEST),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    Ok(())
}

async fn restore(
    directory: &Path,
    database_url: &str,
    db: &PgPool,
    storage: &S3Storage,
) -> Result<()> {
    let manifest = load(directory)?;
    let empty: bool = sqlx::query_scalar(
        "SELECT NOT EXISTS (
            SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('information_schema', 'public') AND nspname !~ '^pg_'
         ) AND NOT EXISTS (
            SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
         ) AND NOT EXISTS (
            SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
         )",
    ).fetch_one(db).await?;
    if !empty || storage.has_objects().await? {
        return Err("A restauração exige um banco e um bucket vazios e isolados.".into());
    }

    // Valida os artefatos antes da primeira escrita no destino.
    validate_local_photos(directory, &manifest)?;

    let database = database_name(&Url::parse(database_url)?)?;
    run(postgres_tool("pg_restore", database_url)?
        .args([
            "--single-transaction",
            "--no-owner",
            "--no-privileges",
            "--dbname",
        ])
        .arg(database)
        .stdin(Stdio::from(File::open(directory.join(ARCHIVE))?)))
    .await?;

    let restored = photos(&mut *db.acquire().await?).await?;
    if restored != manifest.captures {
        return Err("A lista de capturas restauradas diverge do manifesto.".into());
    }
    for photo in &manifest.captures {
        let bytes = local_photo(directory, photo)?;
        let mime = photo_mime(&bytes)?;
        storage
            .create_image(&photo.image_object_key, bytes, mime)
            .await?;
    }
    verify(db, storage, &manifest).await
}

fn load(directory: &Path) -> Result<Manifest> {
    let manifest: Manifest = serde_json::from_reader(File::open(directory.join(MANIFEST))?)?;
    if manifest.format_version != FORMAT_VERSION
        || file_hash(&directory.join(ARCHIVE))? != manifest.postgres_sha256
    {
        return Err("O manifesto ou o dump do PostgreSQL está inválido.".into());
    }
    Ok(manifest)
}

fn validate_local_photos(directory: &Path, manifest: &Manifest) -> Result<()> {
    for photo in &manifest.captures {
        photo_mime(&local_photo(directory, photo)?)?;
    }
    Ok(())
}

async fn verify(db: &PgPool, storage: &impl ObjectStorage, manifest: &Manifest) -> Result<()> {
    let mut tx = db.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    if photos(&mut tx).await? != manifest.captures {
        return Err("As capturas no banco divergem do manifesto.".into());
    }
    // Os gatilhos de integridade funcionam em operação normal. A restauração
    // carrega os dados antes dos gatilhos, então validamos as invariantes aqui.
    let anomalies: i64 = sqlx::query_scalar(
        "SELECT
          (SELECT count(*) FROM captures c WHERE c.status = 'IDENTIFIED' AND (
             NOT EXISTS (SELECT 1 FROM custody_movements m WHERE m.equipment_id = c.equipment_id
               AND m.movement_type = 'COLLECTION_VALIDATED' AND m.to_technician_id = c.technician_id)
             OR NOT EXISTS (SELECT 1 FROM audit_events a WHERE a.entity_id = c.id AND a.action = 'CAPTURE_VALIDATED')
          ))
          + (SELECT count(*) FROM equipment e
             LEFT JOIN custody_movements first ON first.equipment_id = e.id AND first.movement_type = 'COLLECTION_VALIDATED'
             LEFT JOIN custody_movements receipt ON receipt.equipment_id = e.id AND receipt.movement_type = 'WAREHOUSE_RECEIVED'
             WHERE e.technician_id IS DISTINCT FROM CASE WHEN receipt.id IS NULL THEN first.to_technician_id END
                OR (receipt.id IS NOT NULL AND (e.warehouse_id IS DISTINCT FROM receipt.to_warehouse_id
                    OR first.to_technician_id IS DISTINCT FROM receipt.from_technician_id)))
          + (SELECT count(*) FROM custody_movements m WHERE NOT EXISTS (
               SELECT 1 FROM audit_events a WHERE a.entity_id = m.equipment_id
                 AND a.action = CASE WHEN m.movement_type = 'COLLECTION_VALIDATED'
                                    THEN 'CUSTODY_STARTED' ELSE 'WAREHOUSE_RECEIVED' END
                 AND a.after_json->>'movement_id' = m.id::text))
          + (SELECT count(*) FROM receipt_items i
             LEFT JOIN receipt_scans s ON s.session_id = i.session_id AND s.id = i.confirmed_scan_id
             WHERE i.confirmed_at IS NOT NULL AND (s.result IS DISTINCT FROM 'MATCHED'
               OR NOT EXISTS (SELECT 1 FROM custody_movements m WHERE m.receipt_session_id = i.session_id
                   AND m.equipment_id = i.equipment_id AND m.receipt_scan_id = i.confirmed_scan_id)))",
    ).fetch_one(&mut *tx).await?;
    if anomalies != 0 {
        return Err("Foram encontradas divergências entre custódia, recibos e auditoria.".into());
    }
    tx.commit().await?;
    for photo in &manifest.captures {
        checked_photo(storage, photo).await?;
    }
    println!(
        "Restauração verificada. {} foto(s) conferida(s) por SHA-256.",
        manifest.captures.len()
    );
    Ok(())
}

async fn checked_photo(storage: &impl ObjectStorage, photo: &Photo) -> Result<Bytes> {
    let bytes = storage
        .read_image(&photo.image_object_key, MAX_IMAGE_BYTES)
        .await
        .map_err(|_| format!("Imagem indisponível da captura {}.", photo.id))?;
    check_photo_hash(&bytes, photo)?;
    Ok(bytes)
}

fn local_photo(directory: &Path, photo: &Photo) -> Result<Bytes> {
    let mut bytes = Vec::new();
    File::open(photo_path(directory, photo.id))?
        .take((MAX_IMAGE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    check_photo_hash(&bytes, photo)?;
    Ok(bytes.into())
}

fn check_photo_hash(bytes: &[u8], photo: &Photo) -> Result<()> {
    if bytes.is_empty()
        || bytes.len() > MAX_IMAGE_BYTES
        || Sha256::digest(bytes)[..] != photo.sha256
    {
        return Err(format!("Imagem inválida ou divergente da captura {}.", photo.id).into());
    }
    Ok(())
}

fn photo_path(directory: &Path, id: Uuid) -> PathBuf {
    directory.join("photos").join(id.to_string())
}

fn photo_mime(bytes: &[u8]) -> Result<&'static str> {
    match image::guess_format(bytes)? {
        image::ImageFormat::Jpeg => Ok("image/jpeg"),
        image::ImageFormat::Png => Ok("image/png"),
        image::ImageFormat::WebP => Ok("image/webp"),
        _ => Err("Formato de foto incompatível.".into()),
    }
}

fn file_hash(path: &Path) -> Result<Vec<u8>> {
    let mut digest = Sha256::new();
    io::copy(&mut File::open(path)?, &mut digest)?;
    Ok(digest.finalize().to_vec())
}

fn private_directory(path: &Path) -> io::Result<()> {
    #[allow(unused_mut)]
    let mut builder = DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

fn database_name(url: &Url) -> Result<String> {
    let database = percent_decode_str(url.path().trim_start_matches('/')).decode_utf8()?;
    if database.is_empty()
        || !database
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
    {
        return Err(
            "Use um nome simples e explícito de banco em DATABASE_URL para backup e restauração."
                .into(),
        );
    }
    Ok(database.into_owned())
}

fn postgres_tool(tool: &str, database_url: &str) -> Result<Command> {
    let url = Url::parse(database_url)?;
    let host = url
        .host_str()
        .ok_or("Use um host explícito em DATABASE_URL para backup e restauração.")?;
    if url.username().is_empty() || !matches!(url.scheme(), "postgres" | "postgresql") {
        return Err("Use uma URL PostgreSQL com usuário explícito.".into());
    }
    let options: PgConnectOptions = database_url.parse()?;
    if options.get_socket().is_some() {
        return Err("Use uma conexão TCP explícita para backup e restauração.".into());
    }
    let mut command = Command::new(tool);
    command
        .env_remove("DATABASE_URL")
        .env_remove("PGSERVICE")
        .env_remove("PGSERVICEFILE")
        .env_remove("PGHOSTADDR")
        .env_remove("PGOPTIONS")
        .env_remove("PGTARGETSESSIONATTRS")
        .env("PGHOST", host.trim_matches(['[', ']']))
        .env("PGPORT", options.get_port().to_string())
        .env("PGDATABASE", database_name(&url)?)
        .env(
            "PGUSER",
            percent_decode_str(url.username()).decode_utf8()?.as_ref(),
        )
        .env(
            "PGSSLMODE",
            std::env::var("PGSSLMODE").unwrap_or_else(|_| "prefer".into()),
        )
        .arg("--no-password")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if let Some(password) = url.password() {
        command.env(
            "PGPASSWORD",
            percent_decode_str(password).decode_utf8()?.as_ref(),
        );
    }
    for (key, value) in url.query_pairs() {
        let variable = match key.as_ref() {
            "sslmode" => "PGSSLMODE",
            "sslrootcert" => "PGSSLROOTCERT",
            "sslcert" => "PGSSLCERT",
            "sslkey" => "PGSSLKEY",
            _ => {
                return Err(
                    "DATABASE_URL contém parâmetro incompatível com os comandos de backup.".into(),
                );
            }
        };
        command.env(variable, value.as_ref());
    }
    Ok(command)
}

async fn run(command: &mut Command) -> Result<()> {
    let tool = command
        .as_std()
        .get_program()
        .to_string_lossy()
        .into_owned();
    let status = command.status().await.map_err(|_| {
        format!("Falha ao executar {tool}. Verifique o cliente PostgreSQL instalado.")
    })?;
    if !status.success() {
        return Err(format!(
            "{tool} terminou com {status}. Verifique a versão, a conexão e as permissões."
        )
        .into());
    }
    Ok(())
}
