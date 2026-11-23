use axum::{
    Router,
    body::{Body, Bytes, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tower::ServiceExt;
use uuid::Uuid;

use crate::{
    AppState,
    auth::hash_password,
    custody::normalize_mac,
    router,
    storage::{ObjectStorage, StorageFuture},
};

const PASSWORD: &str = "senha-de-teste-local";

#[derive(Default)]
struct FakeStorage(Mutex<HashMap<String, Bytes>>);

impl ObjectStorage for FakeStorage {
    fn has_objects(&self) -> StorageFuture<'_, bool> {
        Box::pin(async { Ok(false) })
    }

    fn write_image<'a>(
        &'a self,
        key: &'a str,
        bytes: Bytes,
        _: &'static str,
    ) -> StorageFuture<'a, ()> {
        Box::pin(async move {
            self.0.lock().unwrap().insert(key.to_owned(), bytes);
            Ok(())
        })
    }

    fn read_image<'a>(&'a self, key: &'a str, _: usize) -> StorageFuture<'a, Bytes> {
        Box::pin(async move {
            self.0
                .lock()
                .unwrap()
                .get(key)
                .cloned()
                .ok_or_else(|| object_store::Error::NotFound {
                    path: key.to_owned(),
                    source: std::io::Error::from(std::io::ErrorKind::NotFound).into(),
                })
        })
    }

    fn read_url<'a>(&'a self, key: &'a str) -> StorageFuture<'a, String> {
        Box::pin(async move { Ok(format!("https://storage.test/{key}")) })
    }

    fn verify_exists<'a>(&'a self, key: &'a str) -> StorageFuture<'a, ()> {
        Box::pin(async move {
            if key.starts_with("missing/") {
                return Err(object_store::Error::NotFound {
                    path: key.to_owned(),
                    source: std::io::Error::from(std::io::ErrorKind::NotFound).into(),
                });
            }
            Ok(())
        })
    }
}

#[test]
fn mac_accepts_supported_formats_and_rejects_invalid_values() {
    for value in ["AA:bb:cc:dd:ee:01", "aa-bb-cc-dd-ee-01", "aabbccddee01"] {
        assert_eq!(normalize_mac(value).unwrap(), "AABBCCDDEE01");
    }
    for value in [
        "AA:BB-CC:DD:EE:01",
        "ZZBBCCDDEE01",
        "AABBCCDDEE0",
        "AABBCCDD:EE0",
    ] {
        assert!(normalize_mac(value).is_err(), "{value}");
    }
}

static INTEGRATION_TESTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

async fn fixture(db: &PgPool) -> (Router, tokio::sync::SemaphorePermit<'static>) {
    let permit = INTEGRATION_TESTS.acquire().await.unwrap();
    let password_hash = hash_password(PASSWORD.into()).await.unwrap();
    for login in ["admin", "reviewer"] {
        sqlx::query("INSERT INTO users (id, name, login, password_hash, role) VALUES ($1, $2, $2, $3, 'administrator')")
            .bind(Uuid::new_v4()).bind(login).bind(&password_hash).execute(db).await.unwrap();
    }
    let app = router(AppState {
        db: db.clone(),
        storage: Arc::new(FakeStorage::default()),
        fallback_password_hash: password_hash.into(),
        operations: Arc::new(
            crate::operations::Operations::new(Some("metrics-token-only-for-tests-1234".into()))
                .unwrap(),
        ),
    });
    (app, permit)
}

async fn call(
    app: &Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    value: Value,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(value.to_string())).unwrap())
        .await
        .unwrap();
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert!(response.headers().contains_key("x-request-id"));
    let status = response.status();
    let body = to_bytes(response.into_body(), 16 * 1024).await.unwrap();
    (
        status,
        if body.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&body).unwrap()
        },
    )
}

async fn login(app: &Router, username: &str) -> Value {
    let (status, result) = call(
        app,
        "POST",
        "/api/v1/auth/login",
        None,
        json!({"login": username, "password": PASSWORD}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    result
}

fn access(session: &Value) -> &str {
    session["access_token"].as_str().unwrap()
}

fn refresh(session: &Value) -> Value {
    json!({"refresh_token": session["refresh_token"]})
}

async fn create_technician(app: &Router, admin: &Value, name: &str) -> Uuid {
    create_account(app, admin, name, "technician").await
}

async fn create_account(app: &Router, admin: &Value, name: &str, role: &str) -> Uuid {
    let (status, result) = call(
        app,
        "POST",
        "/api/v1/admin/users",
        Some(access(admin)),
        json!({"login": name, "name": name, "password": PASSWORD, "role": role}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{result}");
    serde_json::from_value(result["id"].clone()).unwrap()
}

async fn capture(db: &PgPool, technician_id: Uuid, prefix: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO captures (id, client_capture_id, technician_id, image_object_key, sha256, captured_at_device)
        VALUES ($1, $2, $3, $4, $5, now())")
        .bind(id).bind(Uuid::new_v4()).bind(technician_id).bind(format!("{prefix}/{id}"))
        .bind(vec![0_u8; 32]).execute(db).await.unwrap();
    id
}

#[sqlx::test(migrations = "../../migrations")]
async fn session_rotation_reset_disable_and_role_checks(db: PgPool) {
    let (app, _permit) = fixture(&db).await;
    let admin = login(&app, " ADMIN ").await;
    let id = create_technician(&app, &admin, "tecnico").await;
    let tech = login(&app, "tecnico").await;

    let (status, _) = call(
        &app,
        "POST",
        "/api/v1/admin/users",
        Some(access(&tech)),
        json!({"login": "outra", "name": "Outra", "password": PASSWORD, "role": "technician"}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let users = "/api/v1/admin/users";
    let (status, first_page) = call(
        &app,
        "GET",
        &format!("{users}?limit=1"),
        Some(access(&admin)),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let first = &first_page["items"][0];
    assert!(first.get("password_hash").is_none());
    let cursor = first_page["next_cursor"].as_str().unwrap();
    assert_eq!(first["id"], cursor);
    let (status, next_page) = call(
        &app,
        "GET",
        &format!("{users}?limit=1&after={cursor}"),
        Some(access(&admin)),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_ne!(next_page["items"][0]["id"], first["id"]);
    for path in [users.to_owned(), format!("{users}/{id}/inventory")] {
        assert_eq!(
            call(&app, "GET", &path, Some(access(&tech)), Value::Null)
                .await
                .0,
            StatusCode::FORBIDDEN,
        );
    }

    let (status, rotated) = call(&app, "POST", "/api/v1/auth/refresh", None, refresh(&tech)).await;
    assert_eq!(status, StatusCode::OK, "{rotated}");
    assert_eq!(
        call(&app, "POST", "/api/v1/auth/refresh", None, refresh(&tech))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &app,
            "GET",
            "/api/v1/me/inventory",
            Some(access(&tech)),
            Value::Null
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &app,
            "GET",
            "/api/v1/me/inventory",
            Some(access(&rotated)),
            Value::Null
        )
        .await
        .0,
        StatusCode::OK
    );

    let other_session = login(&app, "tecnico").await;
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v1/auth/logout",
            None,
            refresh(&other_session)
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v1/auth/refresh",
            None,
            refresh(&other_session)
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );

    let reset = format!("/api/v1/admin/users/{id}/reset-password");
    let new_password = "senha-redefinida-local";
    assert_eq!(
        call(
            &app,
            "POST",
            &reset,
            Some(access(&admin)),
            json!({"password": new_password})
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v1/auth/refresh",
            None,
            refresh(&rotated)
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let (status, changed) = call(
        &app,
        "POST",
        "/api/v1/auth/login",
        None,
        json!({"login": "tecnico", "password": new_password}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let disable = format!("/api/v1/admin/users/{id}/disable");
    for _ in 0..2 {
        assert_eq!(
            call(&app, "POST", &disable, Some(access(&admin)), Value::Null)
                .await
                .0,
            StatusCode::NO_CONTENT
        );
    }
    assert_eq!(
        call(
            &app,
            "GET",
            "/api/v1/me/inventory",
            Some(access(&changed)),
            Value::Null
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v1/auth/login",
            None,
            json!({"login": "tecnico", "password": new_password})
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let disabled: i64 =
        sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE action = 'USER_DISABLED'")
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(disabled, 1);
}

#[sqlx::test(migrations = "../../migrations")]
async fn review_preserves_custody_under_concurrent_validation(db: PgPool) {
    let (app, _permit) = fixture(&db).await;
    let admin = login(&app, "admin").await;
    let reviewer = login(&app, "reviewer").await;
    let tech_a = create_technician(&app, &admin, "tecnico-a").await;
    let tech_b = create_technician(&app, &admin, "tecnico-b").await;
    let first = capture(&db, tech_a, "labels").await;
    let second = capture(&db, tech_b, "labels").await;
    let first_path = format!("/api/v1/captures/{first}/review");
    let second_path = format!("/api/v1/captures/{second}/review");
    let input = json!({"decision": "validate", "identifiers": [
        {"kind": "SERIAL", "raw_value": "001-o"}, {"kind": "MAC", "raw_value": "aa-bb-cc-dd-ee-01"},
        {"kind": "MAC", "raw_value": "aa:bb:cc:dd:ee:02"}
    ]});
    let session_a = login(&app, "tecnico-a").await;
    let session_b = login(&app, "tecnico-b").await;
    let inventory = "/api/v1/me/inventory";
    assert_eq!(
        call(
            &app,
            "GET",
            inventory,
            Some(access(&session_a)),
            Value::Null
        )
        .await
        .1["items"],
        json!([])
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &first_path,
            Some(access(&session_a)),
            input.clone()
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let image = format!("/api/v1/captures/{first}/image-url");
    assert_eq!(
        call(&app, "GET", &image, Some(access(&session_b)), Value::Null)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(&app, "GET", &image, Some(access(&admin)), Value::Null)
            .await
            .1["expires_in"],
        120
    );

    let (left, right) = tokio::join!(
        call(
            &app,
            "POST",
            &first_path,
            Some(access(&admin)),
            input.clone()
        ),
        call(
            &app,
            "POST",
            &second_path,
            Some(access(&reviewer)),
            input.clone()
        )
    );
    assert_eq!(left.0, StatusCode::OK, "{}", left.1);
    assert_eq!(right.0, StatusCode::OK, "{}", right.1);
    let (winner, loser, owner, private_session, other_session, winning_path, losing_path) =
        if left.1["status"] == "IDENTIFIED" {
            (
                left.1,
                right.1,
                tech_a,
                session_a,
                session_b,
                first_path,
                second_path,
            )
        } else {
            (
                right.1,
                left.1,
                tech_b,
                session_b,
                session_a,
                second_path,
                first_path,
            )
        };
    assert_eq!(winner["status"], "IDENTIFIED");
    assert_eq!(loser["issue"]["code"], "DIFFERENT_CUSTODY");
    for (path, expected) in [(winning_path, &winner), (losing_path, &loser)] {
        assert_eq!(
            call(&app, "POST", &path, Some(access(&admin)), input.clone())
                .await
                .1,
            *expected
        );
    }

    let new_evidence = capture(&db, owner, "labels").await;
    let path = format!("/api/v1/captures/{new_evidence}/review");
    assert_eq!(
        call(&app, "POST", &path, Some(access(&admin)), input.clone())
            .await
            .1,
        winner
    );
    let equipment_page = call(
        &app,
        "GET",
        inventory,
        Some(access(&private_session)),
        Value::Null,
    )
    .await
    .1;
    let (status, admin_page) = call(
        &app,
        "GET",
        &format!("/api/v1/admin/users/{owner}/inventory"),
        Some(access(&admin)),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(admin_page, equipment_page);
    let other = if owner == tech_a { tech_b } else { tech_a };
    let (status, other_page) = call(
        &app,
        "GET",
        &format!("/api/v1/admin/users/{other}/inventory"),
        Some(access(&admin)),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(other_page["items"], json!([]));
    assert_eq!(equipment_page["items"][0]["id"], winner["equipment_id"]);
    assert_eq!(
        equipment_page["items"][0]["identifiers"][2]["normalized_value"],
        "001-O"
    );
    assert_eq!(
        call(
            &app,
            "GET",
            inventory,
            Some(access(&other_session)),
            Value::Null
        )
        .await
        .1["items"],
        json!([])
    );

    let unavailable = capture(&db, owner, "missing").await;
    let unavailable_path = format!("/api/v1/captures/{unavailable}/review");
    assert_eq!(
        call(&app, "POST", &unavailable_path, Some(access(&admin)), input)
            .await
            .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    let status: String = sqlx::query_scalar("SELECT status FROM captures WHERE id = $1")
        .bind(unavailable)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(status, "RECEIVED");

    let pending = capture(&db, owner, "labels").await;
    let pending_path = format!("/api/v1/captures/{pending}/review");
    let (status, mismatch) = call(
        &app,
        "POST",
        &pending_path,
        Some(access(&admin)),
        json!({"decision": "validate", "identifiers": [
            {"kind": "SERIAL", "raw_value": "001-O"},
            {"kind": "MAC", "raw_value": "aabbccddee03"}
        ]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(mismatch["issue"]["code"], "IDENTIFIER_MISMATCH");

    let (status, manual) = call(
        &app,
        "POST",
        &pending_path,
        Some(access(&admin)),
        json!({"decision": "flag", "reason": "Etiqueta danificada"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(manual["issue"]["code"], "MANUAL_REVIEW");

    // A legacy import can contain the same label on two pieces of equipment.
    let legacy = Uuid::new_v4();
    sqlx::query("INSERT INTO equipment (id, warehouse_id) SELECT $1, id FROM locations")
        .bind(legacy)
        .execute(&db)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO equipment_identifiers (equipment_id, kind, raw_value, normalized_value, verified_by)
         SELECT $1, 'SERIAL', '001-O', '001-O', id FROM users WHERE login = 'admin'",
    ).bind(legacy).execute(&db).await.unwrap();
    let (status, ambiguous) = call(
        &app,
        "POST",
        &pending_path,
        Some(access(&admin)),
        json!({"decision": "validate", "identifiers": [{"kind": "SERIAL", "raw_value": "001-O"}]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ambiguous["issue"]["code"], "AMBIGUOUS_IDENTITY");

    let movements: i64 = sqlx::query_scalar("SELECT count(*) FROM custody_movements")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(movements, 1);
    let changed = sqlx::query("UPDATE equipment SET technician_id = $1")
        .bind(if owner == tech_a { tech_b } else { tech_a })
        .execute(&db)
        .await;
    assert!(changed.is_err());
    assert!(
        sqlx::query("DELETE FROM audit_events")
            .execute(&db)
            .await
            .is_err()
    );
}

async fn put_bytes(app: &Router, path: &str, token: &str, bytes: Vec<u8>) -> StatusCode {
    let request = Request::put(path)
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/octet-stream")
        .body(Body::from(bytes))
        .unwrap();
    app.clone().oneshot(request).await.unwrap().status()
}

#[sqlx::test(migrations = "../../migrations")]
async fn captures_retry_safely_and_enqueue_only_after_integrity_check(db: PgPool) {
    let (app, _permit) = fixture(&db).await;
    let admin = login(&app, "admin").await;
    create_technician(&app, &admin, "capture-tech").await;
    create_technician(&app, &admin, "other-tech").await;
    let technician = login(&app, "capture-tech").await;
    let other = login(&app, "other-tech").await;
    let token = access(&technician);
    let pixels: Vec<_> = rand::Rng::sample_iter(rand::thread_rng(), rand::distributions::Standard)
        .take(180 * 180)
        .collect();
    let mut image = Vec::new();
    image::ImageEncoder::write_image(
        image::codecs::png::PngEncoder::new(&mut image),
        &pixels,
        180,
        180,
        image::ExtendedColorType::L8,
    )
    .unwrap();
    assert!(image.len() > 16 * 1024);
    let client_capture_id = Uuid::new_v4();
    let input = json!({
        "client_capture_id": client_capture_id, "captured_at_device": "2026-11-24T12:00:00.000Z",
        "sha256": format!("{:x}", Sha256::digest(&image)), "byte_length": image.len(),
        "barcode_evidence": {"raw_value": "00678", "source": "ZXING"}
    });
    let (status, staged) = call(&app, "POST", "/api/v1/captures", Some(token), input.clone()).await;
    assert_eq!(status, StatusCode::OK, "{staged}");
    assert_eq!(staged["received"], false);
    assert_eq!(
        call(&app, "POST", "/api/v1/captures", Some(token), input.clone())
            .await
            .1,
        staged
    );
    let mut conflicting = input.clone();
    conflicting["byte_length"] = json!(1);
    assert_eq!(
        call(&app, "POST", "/api/v1/captures", Some(token), conflicting)
            .await
            .0,
        StatusCode::CONFLICT
    );

    let base = format!("/api/v1/captures/{}", staged["id"].as_str().unwrap());
    let complete = format!("{base}/complete");
    let put = format!("{base}/image");
    assert_eq!(
        call(&app, "GET", &base, Some(access(&other)), Value::Null)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        put_bytes(&app, &put, access(&other), image.clone()).await,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&app, "POST", &complete, Some(token), Value::Null)
            .await
            .1["code"],
        "IMAGE_NOT_READY"
    );
    assert_eq!(
        put_bytes(&app, &put, token, image[..100].to_vec()).await,
        StatusCode::BAD_REQUEST
    );

    let bogus = b"not an image";
    let (_, bad) = call(
        &app,
        "POST",
        "/api/v1/captures",
        Some(token),
        json!({
            "client_capture_id": Uuid::new_v4(), "captured_at_device": "2026-11-24T12:00:00Z",
            "sha256": format!("{:x}", Sha256::digest(bogus)), "byte_length": bogus.len()
        }),
    )
    .await;
    let bad_path = format!("/api/v1/captures/{}/image", bad["id"].as_str().unwrap());
    assert_eq!(
        put_bytes(&app, &bad_path, token, bogus.to_vec()).await,
        StatusCode::BAD_REQUEST
    );

    assert_eq!(
        put_bytes(&app, &put, token, image.clone()).await,
        StatusCode::OK
    );
    assert_eq!(put_bytes(&app, &put, token, image).await, StatusCode::OK);
    let (first, second) = tokio::join!(
        call(&app, "POST", &complete, Some(token), Value::Null),
        call(&app, "POST", &complete, Some(token), Value::Null)
    );
    assert_eq!(first.0, StatusCode::OK, "{}", first.1);
    assert_eq!(second, first);
    assert_eq!(first.1["received"], true);
    assert_eq!(first.1["status"], "OCR_PENDING");
    let barcode: Value = sqlx::query_scalar("SELECT barcode_evidence FROM captures")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(barcode, input["barcode_evidence"]);
    assert_eq!(
        call(&app, "POST", "/api/v1/captures", Some(token), input)
            .await
            .1,
        first.1
    );
    assert_eq!(
        call(&app, "GET", &base, Some(token), Value::Null).await.1,
        first.1
    );
    for table in ["captures", "jobs"] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count, 1);
    }
    let movements: i64 = sqlx::query_scalar("SELECT count(*) FROM custody_movements")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(movements, 0);
}

const RAW_TSV: &str = concat!(
    "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n",
    "5\t1\t1\t1\t1\t1\t10\t10\t10\t10\t92\tS/N:\n",
    "5\t1\t1\t1\t1\t2\t21\t10\t10\t10\t48\t00O1\n",
    "5\t1\t1\t1\t2\t1\t10\t22\t10\t10\t95\tWAN\n",
    "5\t1\t1\t1\t2\t2\t21\t22\t10\t10\t93\tMAC:\n",
    "5\t1\t1\t1\t2\t3\t42\t22\t10\t10\t94\tAA:BB:CC:DD:EE:01\n",
);

struct TestRecognition;

impl crate::recognition::LabelRecognitionProvider for TestRecognition {
    fn name(&self) -> &str {
        "fixture"
    }
    fn model_version(&self) -> &str {
        "v1"
    }
    async fn recognize(&self, _: Bytes) -> Result<String, crate::recognition::Failure> {
        Ok(RAW_TSV.to_owned())
    }
}

struct GatedRecognition {
    started: tokio::sync::Notify,
    resume: tokio::sync::Notify,
}

impl crate::recognition::LabelRecognitionProvider for GatedRecognition {
    fn name(&self) -> &str {
        "fixture"
    }
    fn model_version(&self) -> &str {
        "delayed"
    }
    async fn recognize(&self, _: Bytes) -> Result<String, crate::recognition::Failure> {
        self.started.notify_one();
        self.resume.notified().await;
        Ok(RAW_TSV.to_owned())
    }
}

async fn recognition_fixture(db: &PgPool, technician: Uuid, bytes: &[u8]) -> (Uuid, String) {
    let id = capture(db, technician, "labels").await;
    let key = sqlx::query_scalar(
        "UPDATE captures SET sha256 = $1, status = 'OCR_PENDING' WHERE id = $2 RETURNING image_object_key",
    ).bind(Sha256::digest(bytes).to_vec()).bind(id).fetch_one(db).await.unwrap();
    sqlx::query("INSERT INTO jobs (id, kind, capture_id) VALUES ($1, 'LABEL_RECOGNITION', $2)")
        .bind(Uuid::new_v4())
        .bind(id)
        .execute(db)
        .await
        .unwrap();
    (id, key)
}

#[sqlx::test(migrations = "../../migrations")]
async fn ocr_retries_preserves_versions_and_never_assigns_custody(db: PgPool) {
    use crate::worker;

    let (app, _permit) = fixture(&db).await;
    let administrator = login(&app, "admin").await;
    let technician = create_technician(&app, &administrator, "tech-ocr").await;
    let tech = login(&app, "tech-ocr").await;
    let token = Some(access(&administrator));
    let storage = FakeStorage::default();
    let bytes = Bytes::from_static(b"photo-test");
    let (id, key) = recognition_fixture(&db, technician, &bytes).await;
    let detail = format!("/api/v1/admin/captures/{id}");
    let reprocess = format!("{detail}/reprocess");

    assert_eq!(
        call(&app, "GET", &detail, Some(access(&tech)), Value::Null)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert!(
        worker::process_one(&db, &storage, &TestRecognition)
            .await
            .unwrap()
    );
    let first = call(&app, "GET", &detail, token, Value::Null).await.1;
    assert_eq!(first["status"], "OCR_PENDING", "{first}");
    assert_eq!(first["result"]["failure_code"], "STORAGE_UNAVAILABLE");
    assert!(
        !worker::process_one(&db, &storage, &TestRecognition)
            .await
            .unwrap()
    );
    for _ in 0..2 {
        sqlx::query("UPDATE jobs SET next_run_at = now() WHERE capture_id = $1")
            .bind(id)
            .execute(&db)
            .await
            .unwrap();
        assert!(
            worker::process_one(&db, &storage, &TestRecognition)
                .await
                .unwrap()
        );
    }
    assert_eq!(
        call(&app, "GET", &detail, token, Value::Null).await.1["status"],
        "OCR_FAILED"
    );
    for _ in 0..2 {
        assert_eq!(
            call(&app, "POST", &reprocess, token, Value::Null).await.1["status"],
            "OCR_PENDING"
        );
    }
    storage.write_image(&key, bytes, "image/png").await.unwrap();
    let (left, right) = tokio::join!(
        worker::process_one(&db, &storage, &TestRecognition),
        worker::process_one(&db, &storage, &TestRecognition)
    );
    assert_ne!(left.unwrap(), right.unwrap());
    let reading = call(&app, "GET", &detail, token, Value::Null).await.1;
    assert_eq!(reading["status"], "NEEDS_REVIEW");
    assert_eq!(reading["runs"].as_array().unwrap().len(), 4);
    assert_eq!(reading["result"]["raw_tsv"], RAW_TSV);
    assert_eq!(reading["result"]["suggestions"][0]["raw_value"], "00O1");
    assert_eq!(reading["result"]["warnings"], json!(["LOW_CONFIDENCE"]));
    let original = format!(
        "{detail}?result_id={}",
        first["result"]["id"].as_str().unwrap()
    );
    assert_eq!(
        call(&app, "GET", &original, token, Value::Null).await.1["result"],
        first["result"]
    );
    let list = call(
        &app,
        "GET",
        "/api/v1/admin/captures?status=NEEDS_REVIEW&limit=1",
        token,
        Value::Null,
    )
    .await
    .1;
    assert_eq!(list["items"][0]["id"], id.to_string());

    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM custody_movements")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let review = format!("/api/v1/captures/{id}/review");
    let (status, validated) = call(
        &app,
        "POST",
        &review,
        token,
        json!({
            "decision": "validate", "ocr_result_id": reading["result"]["id"],
            "identifiers": [{"kind": "SERIAL", "raw_value": "0001"}]
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{validated}");
    assert_eq!(validated["status"], "IDENTIFIED");
    let after = call(&app, "GET", &detail, token, Value::Null).await.1;
    assert_eq!(after["result"], reading["result"]);
    assert_eq!(after["validated_identifiers"][0]["raw_value"], "0001");
    let audit: Value = sqlx::query_scalar(
        "SELECT after_json FROM audit_events WHERE action = 'CAPTURE_VALIDATED'",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(audit["ocr_result_id"], reading["result"]["id"]);
    assert_eq!(
        call(&app, "POST", &reprocess, token, Value::Null).await.0,
        StatusCode::CONFLICT
    );
    assert!(
        sqlx::query("DELETE FROM ocr_results")
            .execute(&db)
            .await
            .is_err()
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn expired_ocr_reservation_and_late_result_preserve_admin_decision(db: PgPool) {
    use crate::worker;

    let (app, _permit) = fixture(&db).await;
    let admin = login(&app, "admin").await;
    let technician = create_technician(&app, &admin, "tech-lease").await;
    let bytes = Bytes::from_static(b"photo-test");
    let (id, key) = recognition_fixture(&db, technician, &bytes).await;
    let storage = FakeStorage::default();
    storage.write_image(&key, bytes, "image/png").await.unwrap();
    let gated = GatedRecognition {
        started: Default::default(),
        resume: Default::default(),
    };

    let (late, ()) = tokio::join!(worker::process_one(&db, &storage, &gated), async {
        gated.started.notified().await;
        sqlx::query(
            "UPDATE jobs SET locked_at = now() - interval '91 seconds' WHERE capture_id = $1",
        )
        .bind(id)
        .execute(&db)
        .await
        .unwrap();
        let review = format!("/api/v1/captures/{id}/review");
        let (_, flagged) = call(
            &app,
            "POST",
            &review,
            Some(access(&admin)),
            json!({"decision": "flag", "reason": "Etiqueta danificada"}),
        )
        .await;
        assert_eq!(flagged["issue"]["code"], "MANUAL_REVIEW");
        assert!(
            worker::process_one(&db, &storage, &TestRecognition)
                .await
                .unwrap()
        );
        gated.resume.notify_one();
    });
    assert!(late.unwrap());
    let detail = format!("/api/v1/admin/captures/{id}");
    let current = call(&app, "GET", &detail, Some(access(&admin)), Value::Null)
        .await
        .1;
    assert_eq!(current["review_issue"]["code"], "MANUAL_REVIEW");
    assert_eq!(current["runs"].as_array().unwrap().len(), 1);
    assert_eq!(current["result"]["model_version"], "v1");
}

async fn identify_fixture(
    db: &PgPool,
    app: &Router,
    admin: &Value,
    owner: Uuid,
    identifiers: Value,
) -> Uuid {
    let id = capture(db, owner, "labels").await;
    let (status, result) = call(
        app,
        "POST",
        &format!("/api/v1/captures/{id}/review"),
        Some(access(admin)),
        json!({"decision":"validate","identifiers":identifiers}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["status"], "IDENTIFIED", "{result}");
    serde_json::from_value(result["equipment_id"].clone()).unwrap()
}

async fn examine(app: &Router, path: &str, clerk: &Value, input: Value, expected: &str) -> Value {
    let (status, scan) = call(
        app,
        "POST",
        &format!("{path}/scan"),
        Some(access(clerk)),
        input,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{scan}");
    assert_eq!(scan["result"], expected);
    scan
}

#[sqlx::test(migrations = "../../migrations")]
async fn receipt_scopes_scans_and_transfers_custody_once_under_concurrency(db: PgPool) {
    let (app, _permit) = fixture(&db).await;
    let admin = login(&app, "admin").await;
    let owner = create_technician(&app, &admin, "receiving-tech").await;
    let other = create_technician(&app, &admin, "other-receiving-tech").await;
    create_account(&app, &admin, "clerk-one", "warehouse_clerk").await;
    create_account(&app, &admin, "clerk-two", "warehouse_clerk").await;
    let left = login(&app, "clerk-one").await;
    let right = login(&app, "clerk-two").await;
    let actor = login(&app, "receiving-tech").await;
    let equipment = identify_fixture(
        &db,
        &app,
        &admin,
        owner,
        json!([
            {"kind":"SERIAL","raw_value":"0001-O"},
            {"kind":"MAC","raw_value":"AA:BB:CC:DD:EE:01"}
        ]),
    )
    .await;
    let not_returned = identify_fixture(
        &db,
        &app,
        &admin,
        owner,
        json!([{"kind":"SERIAL","raw_value":"FALTANTE-01"}]),
    )
    .await;
    let other_equipment = identify_fixture(
        &db,
        &app,
        &admin,
        other,
        json!([{"kind":"SERIAL","raw_value":"OUTRO-01"}]),
    )
    .await;
    let sessions = "/api/v1/receipt-sessions";
    assert_eq!(
        call(&app, "GET", sessions, Some(access(&actor)), Value::Null)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let technicians = call(
        &app,
        "GET",
        "/api/v1/receipt-technicians?search=other-",
        Some(access(&left)),
        Value::Null,
    )
    .await;
    assert_eq!(technicians.0, StatusCode::OK, "{}", technicians.1);
    assert_eq!(technicians.1["items"][0]["id"], other.to_string());

    let left_id = Uuid::new_v4();
    let right_id = Uuid::new_v4();
    let first = format!("{sessions}/{left_id}");
    let second = format!("{sessions}/{right_id}");
    let left_open = json!({"client_session_id":left_id,"technician_id":owner});
    let right_open = json!({"client_session_id":right_id,"technician_id":owner});
    let opened = call(
        &app,
        "POST",
        sessions,
        Some(access(&left)),
        left_open.clone(),
    )
    .await;
    assert_eq!(opened.0, StatusCode::OK, "{}", opened.1);
    assert_eq!(
        call(&app, "POST", sessions, Some(access(&left)), left_open).await,
        opened
    );
    assert_eq!(
        call(&app, "POST", sessions, Some(access(&right)), right_open)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        call(&app, "GET", &first, Some(access(&right)), Value::Null)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&app, "GET", sessions, Some(access(&left)), Value::Null)
            .await
            .1["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let det = call(
        &app,
        "GET",
        &format!("{first}?limit=1"),
        Some(access(&left)),
        Value::Null,
    )
    .await;
    assert_eq!(det.0, StatusCode::OK, "{}", det.1);
    assert_eq!(det.1["totals"]["expected"], 2);
    let cursor = det.1["next_item"].as_str().unwrap();
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("{first}?limit=1&after_item={cursor}"),
            Some(access(&left)),
            Value::Null
        )
        .await
        .1["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let image_path = format!("{first}/items/{equipment}/image-url");
    assert_eq!(
        call(&app, "GET", &image_path, Some(access(&left)), Value::Null)
            .await
            .0,
        StatusCode::NOT_FOUND
    );

    identify_fixture(
        &db,
        &app,
        &admin,
        owner,
        json!([{"kind":"SERIAL","raw_value":"POSTERIOR-01"}]),
    )
    .await;
    for id in [other_equipment, not_returned] {
        sqlx::query("INSERT INTO equipment_identifiers (equipment_id,kind,raw_value,normalized_value,verified_by)
            SELECT $1, 'BARCODE', 'AMB-01', 'AMB-01', id FROM users WHERE login = 'admin'")
            .bind(id).execute(&db).await.unwrap();
    }

    for (value, secondary, expected) in [
        ("0001-0", None, "UNKNOWN"),
        ("AMB-01", None, "AMBIGUOUS"),
        ("OUTRO-01", None, "OTHER_TECHNICIAN"),
        ("POSTERIOR-01", None, "NOT_IN_SESSION"),
        ("0001-O", Some("FALTANTE-01"), "IDENTIFIER_MISMATCH"),
    ] {
        let result = examine(
            &app,
            &first,
            &left,
            json!({
                "client_scan_id":Uuid::new_v4(),"value":value,"secondary_value":secondary
            }),
            expected,
        )
        .await;
        assert!(result["equipment_id"].is_null());
    }

    let left_scan_id = Uuid::new_v4();
    let right_scan_id = Uuid::new_v4();
    let input = json!({"client_scan_id":left_scan_id,"value":" 0001-o\r\n ","secondary_value":"AA-bb-cc-dd-ee-01"});
    let found = examine(&app, &first, &left, input.clone(), "MATCHED").await;
    assert_eq!(found["equipment_id"], equipment.to_string());
    assert_eq!(examine(&app, &first, &left, input, "MATCHED").await, found);
    examine(
        &app,
        &first,
        &left,
        json!({"client_scan_id":Uuid::new_v4(),"value":"0001-O"}),
        "DUPLICATE_SCAN",
    )
    .await;
    examine(
        &app,
        &second,
        &right,
        json!({"client_scan_id":right_scan_id,"value":"0001-O"}),
        "MATCHED",
    )
    .await;
    assert_eq!(
        call(&app, "GET", &image_path, Some(access(&left)), Value::Null)
            .await
            .1["expires_in"],
        120
    );
    let item = call(
        &app,
        "GET",
        &format!("{first}/items/{equipment}"),
        Some(access(&left)),
        Value::Null,
    )
    .await;
    assert_eq!(item.0, StatusCode::OK, "{}", item.1);
    assert_eq!(item.1["matched_scan_id"], left_scan_id.to_string());
    assert_eq!(
        call(
            &app,
            "GET",
            "/api/v1/me/inventory",
            Some(access(&actor)),
            Value::Null
        )
        .await
        .1["items"]
            .as_array()
            .unwrap()
            .len(),
        3
    );

    let left_confirm = format!("{first}/confirm");
    let right_confirm = format!("{second}/confirm");
    let left_input = json!({"equipment_id":equipment,"scan_id":left_scan_id});
    let right_input = json!({"equipment_id":equipment,"scan_id":right_scan_id});
    assert_eq!(
        call(
            &app,
            "POST",
            &left_confirm,
            Some(access(&left)),
            right_input.clone()
        )
        .await
        .1["code"],
        "SCAN_NOT_MATCHED"
    );
    let (a, b) = tokio::join!(
        call(
            &app,
            "POST",
            &left_confirm,
            Some(access(&left)),
            left_input.clone()
        ),
        call(
            &app,
            "POST",
            &right_confirm,
            Some(access(&right)),
            right_input.clone()
        )
    );
    let (winning_session, winning_path, winner, winning_input, result, rejected) =
        if a.0 == StatusCode::OK {
            (&first, &left_confirm, &left, left_input, a, b)
        } else {
            (&second, &right_confirm, &right, right_input, b, a)
        };
    assert_eq!(result.0, StatusCode::OK, "{result:?}");
    assert_eq!(rejected.0, StatusCode::CONFLICT, "{rejected:?}");
    assert_eq!(rejected.1["code"], "ALREADY_RECEIVED");
    assert_eq!(
        call(
            &app,
            "POST",
            winning_path,
            Some(access(winner)),
            winning_input.clone()
        )
        .await,
        result
    );
    let moves: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM custody_movements WHERE movement_type = 'WAREHOUSE_RECEIVED'",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    let events: i64 =
        sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE action = 'WAREHOUSE_RECEIVED'")
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!((moves, events), (1, 1));
    let inventory = call(
        &app,
        "GET",
        "/api/v1/me/inventory",
        Some(access(&actor)),
        Value::Null,
    )
    .await
    .1;
    assert_eq!(inventory["items"].as_array().unwrap().len(), 2);
    assert!(
        inventory["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["id"] != equipment.to_string())
    );
    examine(
        &app,
        &first,
        &left,
        json!({"client_scan_id":Uuid::new_v4(),"value":"0001-O"}),
        "ALREADY_RECEIVED",
    )
    .await;

    let close_path = format!("{winning_session}/close");
    assert!(
        sqlx::query("UPDATE receipt_sessions SET closed_at = now() WHERE id = $1")
            .bind(left_id)
            .execute(&db)
            .await
            .is_err()
    );
    assert_eq!(
        call(&app, "POST", &close_path, Some(access(winner)), json!({}))
            .await
            .1["code"],
        "UNRESOLVED_RECEIPT"
    );
    let closed = call(
        &app,
        "POST",
        &close_path,
        Some(access(winner)),
        json!({"reason":"Segunda peça não entregue."}),
    )
    .await;
    assert_eq!(closed.0, StatusCode::OK, "{}", closed.1);
    assert_eq!(
        call(
            &app,
            "POST",
            winning_path,
            Some(access(winner)),
            winning_input
        )
        .await,
        result
    );
    let report = call(
        &app,
        "GET",
        winning_session,
        Some(access(winner)),
        Value::Null,
    )
    .await
    .1;
    assert_eq!(report["totals"]["confirmed"], 1);
    assert_eq!(report["totals"]["missing"], 1);
    assert_eq!(
        report["session"]["closing_reason"],
        "Segunda peça não entregue."
    );
    let first_report = call(&app, "GET", &first, Some(access(&left)), Value::Null)
        .await
        .1;
    assert_eq!(first_report["totals"]["duplicates"], 1);
    assert_eq!(first_report["totals"]["divergences"], 6);
    assert!(
        sqlx::query("DELETE FROM receipt_scans")
            .execute(&db)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("DELETE FROM receipt_items")
            .execute(&db)
            .await
            .is_err()
    );
    assert!(sqlx::query("UPDATE equipment SET technician_id = NULL, warehouse_id = (SELECT id FROM locations LIMIT 1) WHERE id = $1")
        .bind(not_returned).execute(&db).await.is_err());
}

#[sqlx::test(migrations = "../../migrations")]
async fn operational_routes_are_scoped_and_report_recoverable_failures(db: PgPool) {
    let (app, _permit) = fixture(&db).await;
    let admin = login(&app, "admin").await;
    let technician_id = create_technician(&app, &admin, "tech-ops").await;
    let technician = login(&app, "tech-ops").await;
    assert_eq!(
        call(&app, "GET", "/ready", None, Value::Null).await.1["status"],
        "ready"
    );
    assert_eq!(
        call(&app, "GET", "/metrics", Some(access(&admin)), Value::Null)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );

    let missing = format!("/api/v1/captures/{}/complete", Uuid::new_v4());
    assert_eq!(
        call(
            &app,
            "POST",
            &missing,
            Some(access(&technician)),
            Value::Null
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let request = Request::get("/metrics")
        .header("authorization", "Bearer metrics-token-only-for-tests-1234")
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let output = to_bytes(response.into_body(), 16 * 1024).await.unwrap();
    let output = std::str::from_utf8(&output).unwrap();
    assert!(
        output.contains("stock_upload_failures_total 1\n"),
        "{output}"
    );
    assert!(
        output.contains("stock_receipt_divergences_total 0\n"),
        "{output}"
    );

    let audit = format!("/api/v1/audit-events?entity_id={technician_id}&limit=1");
    assert_eq!(
        call(&app, "GET", &audit, Some(access(&technician)), Value::Null)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let (status, events) = call(&app, "GET", &audit, Some(access(&admin)), Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{events}");
    assert_eq!(events["items"][0]["action"], "USER_CREATED");
    assert!(events["items"][0]["after_json"]["password_hash"].is_null());
    let report = "/api/v1/admin/retention-report?older_than_days=30";
    assert_eq!(
        call(&app, "GET", report, Some(access(&technician)), Value::Null)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(&app, "GET", report, Some(access(&admin)), Value::Null)
            .await
            .1["confirmed_captures"],
        0
    );
    sqlx::query("UPDATE _sqlx_migrations SET success = false WHERE version = (SELECT max(version) FROM _sqlx_migrations)")
        .execute(&db).await.unwrap();
    assert_eq!(
        call(&app, "GET", "/ready", None, Value::Null).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        call(&app, "GET", "/health", None, Value::Null).await.0,
        StatusCode::OK
    );
}
