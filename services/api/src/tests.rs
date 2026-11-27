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
const SAO_GABRIEL: &str = "00000000-0000-4000-8000-000000000001";
const BAGE: &str = "00000000-0000-4000-8000-000000000002";

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
        sqlx::query("INSERT INTO users (id, name, login, password_hash, role, location_id) VALUES ($1, $2, $2, $3, 'administrator', $4::uuid)")
            .bind(Uuid::new_v4()).bind(login).bind(&password_hash).bind(SAO_GABRIEL).execute(db).await.unwrap();
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
    create_account_in(app, admin, name, role, SAO_GABRIEL).await
}

async fn create_account_in(
    app: &Router,
    admin: &Value,
    name: &str,
    role: &str,
    location: &str,
) -> Uuid {
    let (status, result) = call(
        app,
        "POST",
        "/api/v1/admin/users",
        Some(access(admin)),
        json!({"login": name, "name": name, "password": PASSWORD, "role": role, "location_id": location}),
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
    sqlx::query("INSERT INTO equipment (id, warehouse_id) SELECT $1, id FROM locations WHERE name = 'São Gabriel'")
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
        "barcode_evidence": {"raw_value": "00678", "source": "ZXING"},
        "complement": {"model": "Roteador A", "service_order": "OS-10492", "condition": "DAMAGED", "power_supply": "MISSING", "cables": false}
    });
    let mut legacy = input.clone();
    legacy.as_object_mut().unwrap().remove("complement");
    let (status, legacy_stage) = call(&app, "POST", "/api/v1/captures", Some(token), legacy).await;
    assert_eq!(status, StatusCode::OK);
    let (status, staged) = call(&app, "POST", "/api/v1/captures", Some(token), input.clone()).await;
    assert_eq!(legacy_stage, staged);
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
    let detail = format!("/api/v1/admin/captures/{}", staged["id"].as_str().unwrap());
    let (status, reviewed) = call(&app, "GET", &detail, Some(access(&admin)), Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{reviewed}");
    assert_eq!(reviewed["complement"], input["complement"]);
    let mut conflicting = input.clone();
    conflicting["complement"]["cables"] = json!(true);
    assert_eq!(
        call(&app, "POST", "/api/v1/captures", Some(token), conflicting)
            .await
            .0,
        StatusCode::CONFLICT
    );
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
        call(
            &app,
            "GET",
            "/api/v1/receipt-technicians",
            Some(access(&admin)),
            Value::Null
        )
        .await
        .0,
        StatusCode::OK
    );
    let admin_session = call(
        &app,
        "POST",
        sessions,
        Some(access(&admin)),
        json!({"technician_id":other,"client_session_id":Uuid::new_v4()}),
    )
    .await;
    assert_eq!(admin_session.0, StatusCode::OK, "{}", admin_session.1);
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

    let lookup = "/api/v1/receipt-lookup";
    let queue = "/api/v1/receipt-exceptions";
    let label = json!({"value":"PENDENTE-001"});
    for _ in 0..2 {
        let (status, result) = call(&app, "POST", lookup, Some(access(&left)), label.clone()).await;
        assert_eq!(status, StatusCode::OK, "{result}");
        assert_eq!(result["result"], "UNKNOWN");
    }
    let (_, mine) = call(&app, "GET", queue, Some(access(&left)), Value::Null).await;
    assert_eq!(mine["items"].as_array().unwrap().len(), 1);
    let (_, theirs) = call(&app, "GET", queue, Some(access(&right)), Value::Null).await;
    assert!(theirs["items"].as_array().unwrap().is_empty());
    identify_fixture(
        &db,
        &app,
        &admin,
        other,
        json!([{"kind":"SERIAL","raw_value":"PENDENTE-001"}]),
    )
    .await;
    let (_, found) = call(&app, "POST", lookup, Some(access(&left)), label).await;
    assert_eq!(found["technician_id"], other.to_string());
    let (_, mine) = call(&app, "GET", queue, Some(access(&left)), Value::Null).await;
    assert!(mine["items"].as_array().unwrap().is_empty());

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

    let deliveries = format!("/api/v1/admin/users/{owner}/deliveries");
    let pending_delivery = call(&app, "GET", &deliveries, Some(access(&admin)), Value::Null).await;
    assert_eq!(pending_delivery.0, StatusCode::OK);
    assert_eq!(pending_delivery.1["items"], json!([]));
    assert_eq!(
        call(&app, "GET", &deliveries, Some(access(&actor)), Value::Null)
            .await
            .0,
        StatusCode::FORBIDDEN
    );

    let left_confirm = format!("{first}/confirm");
    let right_confirm = format!("{second}/confirm");
    let left_input = json!({"equipment_id":equipment,"scan_id":left_scan_id,"inspection":{"power_supply":"ORIGINAL","cables_present":true,"condition":"GOOD"}});
    let right_input = json!({"equipment_id":equipment,"scan_id":right_scan_id,"inspection":{"power_supply":"ORIGINAL","cables_present":true,"condition":"GOOD"}});
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
    let inspected: Value = sqlx::query_scalar(
        "SELECT inspection FROM receipt_items WHERE equipment_id = $1 AND confirmed_at IS NOT NULL",
    )
    .bind(equipment)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(inspected, winning_input["inspection"]);
    let history = call(
        &app,
        "GET",
        "/api/v1/warehouse/equipment/lookup?value=0001-O",
        Some(access(winner)),
        Value::Null,
    )
    .await;
    assert_eq!(history.0, StatusCode::OK);
    assert_eq!(history.1["history"][0]["type"], "WAREHOUSE_RECEIVED");
    let delivered = call(&app, "GET", &deliveries, Some(access(&admin)), Value::Null).await;
    assert_eq!(delivered.0, StatusCode::OK, "{}", delivered.1);
    let items = delivered.1["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["warehouse_name"], "São Gabriel");
    assert!(items[0]["delivered_at"].is_string());
    assert!(items[0]["identifiers"].as_array().unwrap().iter().any(|identifier|
        identifier["kind"] == "SERIAL" && identifier["raw_value"] == "0001-O"));
    let other_deliveries = call(
        &app,
        "GET",
        &format!("/api/v1/admin/users/{other}/deliveries"),
        Some(access(&admin)),
        Value::Null,
    )
    .await;
    assert_eq!(other_deliveries.0, StatusCode::OK);
    assert_eq!(other_deliveries.1["items"], json!([]));
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

async fn pending_capture(db: &PgPool, technician_id: Uuid, typed_code: &str) -> Uuid {
    let id = capture(db, technician_id, "labels").await;
    sqlx::query("UPDATE captures SET status = 'NEEDS_REVIEW', barcode_evidence = $1 WHERE id = $2")
        .bind(json!({"raw_value": typed_code, "source": "MANUAL"}))
        .bind(id)
        .execute(db)
        .await
        .unwrap();
    id
}

async fn capture_of(db: &PgPool, equipment: Uuid) -> Uuid {
    sqlx::query_scalar("SELECT id FROM captures WHERE equipment_id = $1")
        .bind(equipment)
        .fetch_one(db)
        .await
        .unwrap()
}

const GOOD: &str = r#"{"power_supply":"ORIGINAL","cables_present":true,"condition":"GOOD"}"#;

#[sqlx::test(migrations = "../../migrations")]
async fn delivery_batches_scope_receipt_and_identify_at_counter(db: PgPool) {
    let (app, _permit) = fixture(&db).await;
    let admin = login(&app, "admin").await;
    let owner = create_technician(&app, &admin, "batch-tech").await;
    let other = create_technician(&app, &admin, "batch-other").await;
    create_account(&app, &admin, "batch-clerk", "warehouse_clerk").await;
    create_account(&app, &admin, "batch-clerk-two", "warehouse_clerk").await;
    let tech = login(&app, "batch-tech").await;
    let intruder = login(&app, "batch-other").await;
    let clerk = login(&app, "batch-clerk").await;
    let clerk_two = login(&app, "batch-clerk-two").await;
    let inspection: Value = serde_json::from_str(GOOD).unwrap();

    let first = identify_fixture(
        &db,
        &app,
        &admin,
        owner,
        json!([{"kind":"SERIAL","raw_value":"LOTE-0001"}]),
    )
    .await;
    let left_behind = identify_fixture(
        &db,
        &app,
        &admin,
        owner,
        json!([{"kind":"SERIAL","raw_value":"LOTE-0002"}]),
    )
    .await;
    let forgotten = identify_fixture(
        &db,
        &app,
        &admin,
        owner,
        json!([{"kind":"MAC","raw_value":"AA:BB:CC:00:00:03"}]),
    )
    .await;
    let foreign = identify_fixture(
        &db,
        &app,
        &admin,
        other,
        json!([{"kind":"SERIAL","raw_value":"ALHEIO-01"}]),
    )
    .await;
    let unread = pending_capture(&db, owner, "sn-novo-77").await;
    let (first_capture, behind_capture) = (
        capture_of(&db, first).await,
        capture_of(&db, left_behind).await,
    );

    // O técnico vê equipamentos identificados e coletas sem identificação.
    let (status, custody) = call(
        &app,
        "GET",
        "/api/v1/me/custody",
        Some(access(&tech)),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{custody}");
    assert_eq!(custody["items"].as_array().unwrap().len(), 4, "{custody}");

    let batch_id = Uuid::new_v4();
    let body = json!({"client_batch_id": batch_id, "capture_ids": [first_capture, behind_capture, unread], "notes": "Pilha da manhã"});
    let (status, created) = call(
        &app,
        "POST",
        "/api/v1/me/batches",
        Some(access(&tech)),
        body.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["batch"]["status"], "SUBMITTED");
    assert_eq!(created["batch"]["total"], 3);
    assert_eq!(created["batch"]["unidentified"], 1);
    // Repetir a mesma requisição devolve o mesmo lote.
    let (status, again) = call(
        &app,
        "POST",
        "/api/v1/me/batches",
        Some(access(&tech)),
        body,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{again}");
    assert_eq!(again["batch"]["number"], created["batch"]["number"]);
    let (status, reused) = call(
        &app,
        "POST",
        "/api/v1/me/batches",
        Some(access(&tech)),
        json!({"client_batch_id": batch_id, "capture_ids": [first_capture]}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{reused}");
    let (status, twice) = call(
        &app,
        "POST",
        "/api/v1/me/batches",
        Some(access(&tech)),
        json!({"client_batch_id": Uuid::new_v4(), "capture_ids": [first_capture]}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{twice}");
    assert_eq!(twice["code"], "ITEM_IN_ANOTHER_BATCH");
    let foreign_capture = capture_of(&db, foreign).await;
    let (status, _) = call(
        &app,
        "POST",
        "/api/v1/me/batches",
        Some(access(&tech)),
        json!({"client_batch_id": Uuid::new_v4(), "capture_ids": [foreign_capture]}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let batch_path = format!("/api/v1/me/batches/{batch_id}");
    assert_eq!(
        call(
            &app,
            "GET",
            &batch_path,
            Some(access(&intruder)),
            Value::Null
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &app,
            "GET",
            "/api/v1/warehouse/batches",
            Some(access(&tech)),
            Value::Null
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    // O lote em si não transfere custódia.
    let holder: Option<Uuid> =
        sqlx::query_scalar("SELECT technician_id FROM equipment WHERE id = $1")
            .bind(first)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(holder, Some(owner));

    let (status, summary) = call(
        &app,
        "GET",
        "/api/v1/warehouse/technicians-summary?search=batch-tech",
        Some(access(&clerk)),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{summary}");
    assert_eq!(summary["items"][0]["in_custody"], 3, "{summary}");
    assert_eq!(summary["items"][0]["unidentified"], 1);
    assert_eq!(summary["items"][0]["open_batches"], 1);
    let (status, queue) = call(
        &app,
        "GET",
        "/api/v1/warehouse/batches?status=open",
        Some(access(&clerk)),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{queue}");
    assert_eq!(queue["items"].as_array().unwrap().len(), 1);

    // Dois estoquistas abrindo o mesmo lote ao mesmo tempo: apenas um conduz a conferência.
    let receive = format!("/api/v1/warehouse/batches/{batch_id}/receive");
    let (left, right) = tokio::join!(
        call(
            &app,
            "POST",
            &receive,
            Some(access(&clerk)),
            json!({"client_session_id": Uuid::new_v4()})
        ),
        call(
            &app,
            "POST",
            &receive,
            Some(access(&clerk_two)),
            json!({"client_session_id": Uuid::new_v4()})
        ),
    );
    let (winner, opened) = match (left.0, right.0) {
        (StatusCode::OK, StatusCode::CONFLICT) => (&clerk, left.1),
        (StatusCode::CONFLICT, StatusCode::OK) => (&clerk_two, right.1),
        other => panic!("resultado inesperado: {other:?} {} {}", left.1, right.1),
    };
    let session_id = opened["receipt_session_id"].as_str().unwrap().to_owned();
    let (status, resumed) = call(
        &app,
        "POST",
        &receive,
        Some(access(winner)),
        json!({"client_session_id": Uuid::new_v4()}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{resumed}");
    assert_eq!(resumed["receipt_session_id"], session_id.as_str());
    let (status, cancel) = call(
        &app,
        "POST",
        &format!("{batch_path}/cancel"),
        Some(access(&tech)),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{cancel}");

    let path = format!("/api/v1/receipt-sessions/{session_id}");
    let (status, detail) = call(&app, "GET", &path, Some(access(winner)), Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(detail["totals"]["expected"], 2, "{detail}");
    assert_eq!(detail["totals"]["unidentified"], 1);
    assert_eq!(
        detail["session"]["batch_number"],
        created["batch"]["number"]
    );

    // Item identificado do lote.
    let scan = examine(
        &app,
        &path,
        winner,
        json!({"client_scan_id": Uuid::new_v4(), "value": "lote-0001"}),
        "MATCHED",
    )
    .await;
    let (status, confirmed) = call(
        &app,
        "POST",
        &format!("{path}/confirm"),
        Some(access(winner)),
        json!({"equipment_id": first, "scan_id": scan["id"], "inspection": inspection}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{confirmed}");

    // Equipamento de outro técnico e item esquecido fora do lote.
    examine(
        &app,
        &path,
        winner,
        json!({"client_scan_id": Uuid::new_v4(), "value": "ALHEIO-01"}),
        "OTHER_TECHNICIAN",
    )
    .await;
    let (status, _) = call(
        &app,
        "POST",
        &format!("{path}/include"),
        Some(access(winner)),
        json!({"value": "ALHEIO-01"}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    examine(
        &app,
        &path,
        winner,
        json!({"client_scan_id": Uuid::new_v4(), "value": "aabbcc000003"}),
        "NOT_IN_SESSION",
    )
    .await;
    let (status, included) = call(
        &app,
        "POST",
        &format!("{path}/include"),
        Some(access(winner)),
        json!({"value": "aabbcc000003"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{included}");
    let scan = examine(
        &app,
        &path,
        winner,
        json!({"client_scan_id": Uuid::new_v4(), "value": "aabbcc000003"}),
        "MATCHED",
    )
    .await;
    let (status, _) = call(
        &app,
        "POST",
        &format!("{path}/confirm"),
        Some(access(winner)),
        json!({"equipment_id": forgotten, "scan_id": scan["id"], "inspection": inspection}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Coleta sem identificação: o bipe aponta a foto e o estoquista confirma.
    let unknown = examine(
        &app,
        &path,
        winner,
        json!({"client_scan_id": Uuid::new_v4(), "value": "SN-NOVO-77"}),
        "UNKNOWN",
    )
    .await;
    assert_eq!(unknown["capture_candidates"], json!([unread]), "{unknown}");
    let (status, photo) = call(
        &app,
        "GET",
        &format!("{path}/captures/{unread}/image-url"),
        Some(access(winner)),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{photo}");
    let (status, _) = call(
        &app,
        "GET",
        &format!("{path}/captures/{foreign_capture}/image-url"),
        Some(access(winner)),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let identify = json!({"scan_id": unknown["id"], "capture_id": unread, "inspection": inspection,
        "identifiers": [{"kind":"SERIAL","raw_value":"OUTRO-CODIGO"}]});
    let (status, _) = call(
        &app,
        "POST",
        &format!("{path}/identify"),
        Some(access(winner)),
        identify,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let identify = json!({"scan_id": unknown["id"], "capture_id": unread, "inspection": inspection,
        "identifiers": [{"kind":"SERIAL","raw_value":"SN-NOVO-77"}]});
    let (status, received) = call(
        &app,
        "POST",
        &format!("{path}/identify"),
        Some(access(winner)),
        identify.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{received}");
    assert_eq!(received["result"], "RECEIVED");
    let (status, repeated) = call(
        &app,
        "POST",
        &format!("{path}/identify"),
        Some(access(winner)),
        identify,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{repeated}");
    assert_eq!(
        repeated["confirmation"]["movement_id"],
        received["confirmation"]["movement_id"]
    );
    let movements: i64 =
        sqlx::query_scalar("SELECT count(*) FROM custody_movements WHERE receipt_session_id = $1")
            .bind(Uuid::parse_str(&session_id).unwrap())
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(movements, 3);

    // O item que ficou para trás exige justificativa e volta a ficar livre.
    let (status, _) = call(
        &app,
        "POST",
        &format!("{path}/close"),
        Some(access(winner)),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _) = call(
        &app,
        "POST",
        &format!("{path}/close"),
        Some(access(winner)),
        json!({"reason": "LOTE-0002 não veio na pilha"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, finished) = call(&app, "GET", &batch_path, Some(access(&tech)), Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{finished}");
    assert_eq!(finished["batch"]["status"], "CLOSED");
    assert_eq!(finished["batch"]["total"], 4, "{finished}");
    assert_eq!(finished["batch"]["received"], 3);
    assert_eq!(finished["batch"]["unidentified"], 0);
    let (_, custody) = call(
        &app,
        "GET",
        "/api/v1/me/custody",
        Some(access(&tech)),
        Value::Null,
    )
    .await;
    let items = custody["items"].as_array().unwrap();
    assert_eq!(items.len(), 1, "{custody}");
    assert_eq!(items[0]["equipment_id"], json!(left_behind));
    assert!(items[0]["batch_id"].is_null());
    let (status, next) = call(
        &app,
        "POST",
        "/api/v1/me/batches",
        Some(access(&tech)),
        json!({"client_batch_id": Uuid::new_v4(), "capture_ids": [behind_capture]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{next}");
    let next_id = next["batch"]["id"].as_str().unwrap();
    let (status, cancelled) = call(
        &app,
        "POST",
        &format!("/api/v1/me/batches/{next_id}/cancel"),
        Some(access(&tech)),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{cancelled}");
    assert_eq!(cancelled["batch"]["status"], "CANCELLED");
    assert!(
        sqlx::query("DELETE FROM delivery_batches")
            .execute(&db)
            .await
            .is_err(),
        "o histórico de lotes é permanente"
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn admin_edits_profile_role_and_reactivates_accounts(db: PgPool) {
    let (app, _permit) = fixture(&db).await;
    let admin = login(&app, "admin").await;
    let clerk = create_account(&app, &admin, "estoquista", "warehouse_clerk").await;
    let tech = create_technician(&app, &admin, "tecnico").await;
    let clerk_session = login(&app, "estoquista").await;
    let user = |id: Uuid| format!("/api/v1/admin/users/{id}");

    assert_eq!(
        call(
            &app,
            "PATCH",
            &user(tech),
            Some(access(&clerk_session)),
            json!({"name": "X"})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    // Administradores também são gerenciáveis, exceto a própria conta em ações que trancariam o acesso.
    let admin_id: Uuid = sqlx::query_scalar("SELECT id FROM users WHERE login = 'admin'")
        .fetch_one(&db)
        .await
        .unwrap();
    let reviewer: Uuid = sqlx::query_scalar("SELECT id FROM users WHERE login = 'reviewer'")
        .fetch_one(&db)
        .await
        .unwrap();
    let (status, renamed_admin) = call(
        &app,
        "PATCH",
        &user(reviewer),
        Some(access(&admin)),
        json!({"name": "Revisora"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{renamed_admin}");
    for (method, path, body) in [
        ("PATCH", user(admin_id), json!({"role": "technician"})),
        ("POST", format!("{}/disable", user(admin_id)), Value::Null),
        ("DELETE", user(admin_id), Value::Null),
    ] {
        let (status, body) = call(&app, method, &path, Some(access(&admin)), body).await;
        assert_eq!(status, StatusCode::CONFLICT, "{method} {path}");
        assert_eq!(body["code"], "SELF_CHANGE_BLOCKED");
    }
    let boss = create_account(&app, &admin, "chefe", "warehouse_clerk").await;
    let (status, promoted) = call(
        &app,
        "PATCH",
        &user(boss),
        Some(access(&admin)),
        json!({"role": "administrator"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{promoted}");
    assert_eq!(promoted["role"], "administrator");
    let (status, demoted) = call(
        &app,
        "PATCH",
        &user(boss),
        Some(access(&admin)),
        json!({"role": "warehouse_clerk"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{demoted}");
    assert_eq!(
        call(
            &app,
            "PATCH",
            &user(clerk),
            Some(access(&admin)),
            json!({"name": "  "})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );

    // WhatsApp: normalized to digits with country code, rejected when malformed, cleared with "".
    let (status, created) = call(
        &app,
        "POST",
        "/api/v1/admin/users",
        Some(access(&admin)),
        json!({"login": "zap", "name": "Zap", "password": PASSWORD, "role": "technician",
            "whatsapp": "(11) 98765-4321", "location_id": SAO_GABRIEL}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    assert_eq!(created["whatsapp"], "5511987654321");
    let zap: Uuid = serde_json::from_value(created["id"].clone()).unwrap();
    for bad in ["123", "11 9876-ABCD", "0011987654321"] {
        assert_eq!(
            call(
                &app,
                "PATCH",
                &user(zap),
                Some(access(&admin)),
                json!({"whatsapp": bad})
            )
            .await
            .0,
            StatusCode::BAD_REQUEST,
            "{bad}"
        );
    }
    let (status, changed) = call(
        &app,
        "PATCH",
        &user(zap),
        Some(access(&admin)),
        json!({"whatsapp": "+351 912 345 678"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{changed}");
    assert_eq!(changed["whatsapp"], "351912345678");
    let (_, cleared) = call(
        &app,
        "PATCH",
        &user(zap),
        Some(access(&admin)),
        json!({"whatsapp": ""}),
    )
    .await;
    assert!(cleared["whatsapp"].is_null(), "{cleared}");
    let changes: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE action = 'USER_UPDATED' AND entity_id = $1",
    )
    .bind(zap)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(changes, 2);

    // Name-only edits keep the person's sessions.
    let (status, renamed) = call(
        &app,
        "PATCH",
        &user(clerk),
        Some(access(&admin)),
        json!({"name": " Maria Estoque "}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    assert_eq!(renamed["name"], "Maria Estoque");
    assert_eq!(renamed["role"], "warehouse_clerk");
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v1/auth/refresh",
            None,
            refresh(&clerk_session)
        )
        .await
        .0,
        StatusCode::OK
    );

    // A role change revokes sessions issued for the previous role.
    let clerk_session = login(&app, "estoquista").await;
    let (status, changed) = call(
        &app,
        "PATCH",
        &user(clerk),
        Some(access(&admin)),
        json!({"role": "technician"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{changed}");
    assert_eq!(changed["role"], "technician");
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v1/auth/refresh",
            None,
            refresh(&clerk_session)
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let (before, after): (Value, Value) = sqlx::query_as(
        "SELECT before_json, after_json FROM audit_events
         WHERE action = 'USER_UPDATED' AND entity_id = $1 ORDER BY created_at DESC LIMIT 1",
    )
    .bind(clerk)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(before["role"], "warehouse_clerk");
    assert_eq!(after["role"], "technician");

    // A technician with pending captures keeps the profile.
    capture(&db, tech, "pending").await;
    let (status, blocked) = call(
        &app,
        "PATCH",
        &user(tech),
        Some(access(&admin)),
        json!({"role": "warehouse_clerk"}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{blocked}");
    assert_eq!(blocked["code"], "ROLE_CHANGE_BLOCKED");
    let role: String = sqlx::query_scalar("SELECT role FROM users WHERE id = $1")
        .bind(tech)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(role, "technician");

    // Disable, then reactivate exactly once.
    let disable = format!("{}/disable", user(tech));
    let enable = format!("{}/enable", user(tech));
    assert_eq!(
        call(&app, "POST", &disable, Some(access(&admin)), Value::Null)
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    for _ in 0..2 {
        assert_eq!(
            call(&app, "POST", &enable, Some(access(&admin)), Value::Null)
                .await
                .0,
            StatusCode::NO_CONTENT
        );
    }
    login(&app, "tecnico").await;
    let enabled: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE action = 'USER_ENABLED' AND entity_id = $1",
    )
    .bind(tech)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(enabled, 1);
}

#[sqlx::test(migrations = "../../migrations")]
async fn admin_deletes_accounts_preserving_history(db: PgPool) {
    let (app, _permit) = fixture(&db).await;
    let admin = login(&app, "admin").await;
    let user = |id: Uuid| format!("/api/v1/admin/users/{id}");

    // Conta sem vínculos: apagada de verdade, e o login fica livre.
    let fresh = create_account(&app, &admin, "novato", "warehouse_clerk").await;
    let session = login(&app, "novato").await;
    let (status, result) = call(
        &app,
        "DELETE",
        &user(fresh),
        Some(access(&admin)),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["mode"], "removed");
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v1/auth/refresh",
            None,
            refresh(&session)
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let gone: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE id = $1")
        .bind(fresh)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(gone, 0);
    create_account(&app, &admin, "novato", "technician").await;
    assert_eq!(
        call(
            &app,
            "DELETE",
            &user(fresh),
            Some(access(&admin)),
            Value::Null
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );

    // Técnico com captura pendente: bloqueado até resolver.
    let tech = create_technician(&app, &admin, "tecnico").await;
    let pending = capture(&db, tech, "pendente").await;
    let (status, body) = call(
        &app,
        "DELETE",
        &user(tech),
        Some(access(&admin)),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "DELETE_BLOCKED");

    // Com histórico e sem pendência: arquivada, some da lista e não entra mais.
    let equipment = Uuid::new_v4();
    sqlx::query("INSERT INTO equipment (id, warehouse_id) SELECT $1, id FROM locations LIMIT 1")
        .bind(equipment)
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("UPDATE captures SET equipment_id = $1, status = 'IDENTIFIED', validated_identifiers = '[]' WHERE id = $2")
        .bind(equipment)
        .bind(pending)
        .execute(&db)
        .await
        .unwrap();
    let (status, result) = call(
        &app,
        "DELETE",
        &user(tech),
        Some(access(&admin)),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["mode"], "archived");
    let kept: (bool, bool) =
        sqlx::query_as("SELECT active, deleted_at IS NOT NULL FROM users WHERE id = $1")
            .bind(tech)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(kept, (false, true));
    let (_, list) = call(
        &app,
        "GET",
        "/api/v1/admin/users",
        Some(access(&admin)),
        Value::Null,
    )
    .await;
    assert!(
        list["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["login"] != "tecnico"),
        "{list}"
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v1/auth/login",
            None,
            json!({"login": "tecnico", "password": PASSWORD})
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    for (method, path) in [
        ("PATCH", user(tech)),
        ("POST", format!("{}/enable", user(tech))),
        ("DELETE", user(tech)),
    ] {
        let body = if method == "PATCH" {
            json!({"name": "X"})
        } else {
            Value::Null
        };
        assert_eq!(
            call(&app, method, &path, Some(access(&admin)), body)
                .await
                .0,
            StatusCode::NOT_FOUND,
            "{method} {path}"
        );
    }
    let audited: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE action = 'USER_DELETED' AND entity_id = ANY($1)",
    )
    .bind(vec![fresh, tech])
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(audited, 2);

    // Administrador pode criar outro administrador.
    create_account(&app, &admin, "gestor", "administrator").await;
}

async fn call_in(
    app: &Router,
    method: &str,
    path: &str,
    token: &str,
    location: &str,
    value: Value,
) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {token}"))
        .header("x-location-id", location);
    let response = app
        .clone()
        .oneshot(request.body(Body::from(value.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), 256 * 1024).await.unwrap();
    (
        status,
        if body.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&body).unwrap()
        },
    )
}

/// ICCID válido (Luhn) a partir de um número de série de 10 dígitos.
fn iccid(serial: u64) -> String {
    let body = format!("895540000{serial:010}");
    let sum: u32 = body
        .bytes()
        .rev()
        .enumerate()
        .map(|(index, byte)| {
            let value = u32::from(byte - b'0');
            if index % 2 == 0 {
                let doubled = value * 2;
                if doubled > 9 { doubled - 9 } else { doubled }
            } else {
                value
            }
        })
        .sum();
    format!("{body}{}", (10 - sum % 10) % 10)
}

fn sheet(serials: std::ops::Range<u64>) -> Vec<Value> {
    serials
        .enumerate()
        .map(|(index, serial)| {
            json!({"row": index + 2, "iccid": iccid(serial), "operator_status": "Livre",
                "subscriber": " - ", "carrier": "VIVO", "mvno_display": "NEW LIFE"})
        })
        .collect()
}

#[sqlx::test(migrations = "../../migrations")]
async fn cities_scope_technicians_batches_and_receipts(db: PgPool) {
    let (app, _permit) = fixture(&db).await;
    let admin = login(&app, "admin").await;
    let gabriel_tech = create_account(&app, &admin, "tec-sg", "technician").await;
    let bage_tech = create_account_in(&app, &admin, "tec-bage", "technician", BAGE).await;
    create_account_in(&app, &admin, "estoque-bage", "warehouse_clerk", BAGE).await;
    let clerk = login(&app, "estoque-bage").await;

    // Técnico e estoquista precisam de cidade; administrador não.
    let (status, body) = call(
        &app,
        "POST",
        "/api/v1/admin/users",
        Some(access(&admin)),
        json!({"login": "semcidade", "name": "Sem", "password": PASSWORD, "role": "technician"}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, body) = call(
        &app,
        "POST",
        "/api/v1/admin/users",
        Some(access(&admin)),
        json!({"login": "outroadm", "name": "Adm", "password": PASSWORD, "role": "administrator"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert!(body["location_id"].is_null());

    let (status, cities) = call(
        &app,
        "GET",
        "/api/v1/locations",
        Some(access(&clerk)),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let names: Vec<_> = cities["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Bagé", "Passo Fundo", "São Gabriel"]);

    // O estoquista só vê técnicos da própria cidade, mesmo pedindo outra.
    let (status, list) = call_in(
        &app,
        "GET",
        "/api/v1/warehouse/technicians-summary",
        access(&clerk),
        SAO_GABRIEL,
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let ids: Vec<_> = list["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].clone())
        .collect();
    assert_eq!(ids, [json!(bage_tech)]);
    let (status, _) = call(
        &app,
        "POST",
        "/api/v1/receipt-sessions",
        Some(access(&clerk)),
        json!({"client_session_id": Uuid::new_v4(), "technician_id": gabriel_tech}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _) = call(
        &app,
        "POST",
        "/api/v1/receipt-sessions",
        Some(access(&clerk)),
        json!({"client_session_id": Uuid::new_v4(), "technician_id": bage_tech}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Lote de São Gabriel não aparece nem abre em Bagé.
    let capture_id = capture(&db, gabriel_tech, "sg").await;
    let tech = login(&app, "tec-sg").await;
    let (status, batch) = call(
        &app,
        "POST",
        "/api/v1/me/batches",
        Some(access(&tech)),
        json!({"client_batch_id": Uuid::new_v4(), "capture_ids": [capture_id]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{batch}");
    let batch_id = batch["batch"]["id"].as_str().unwrap().to_owned();
    let (_, queue) = call(
        &app,
        "GET",
        "/api/v1/warehouse/batches?status=open",
        Some(access(&clerk)),
        Value::Null,
    )
    .await;
    assert_eq!(queue["items"].as_array().unwrap().len(), 0);
    let (status, _) = call(
        &app,
        "POST",
        &format!("/api/v1/warehouse/batches/{batch_id}/receive"),
        Some(access(&clerk)),
        json!({"client_session_id": Uuid::new_v4()}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // O administrador escolhe a cidade pelo cabeçalho.
    let (_, queue) = call_in(
        &app,
        "GET",
        "/api/v1/warehouse/batches?status=open",
        access(&admin),
        SAO_GABRIEL,
        Value::Null,
    )
    .await;
    assert_eq!(queue["items"].as_array().unwrap().len(), 1);
    let (_, queue) = call_in(
        &app,
        "GET",
        "/api/v1/warehouse/batches?status=open",
        access(&admin),
        BAGE,
        Value::Null,
    )
    .await;
    assert_eq!(queue["items"].as_array().unwrap().len(), 0);

    // Com lote em aberto, o técnico não muda de cidade.
    let (status, body) = call(
        &app,
        "PATCH",
        &format!("/api/v1/admin/users/{gabriel_tech}"),
        Some(access(&admin)),
        json!({"location_id": BAGE}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "LOCATION_CHANGE_BLOCKED");

    let (status, overview) = call(
        &app,
        "GET",
        "/api/v1/warehouse/overview",
        Some(access(&clerk)),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(overview["items"].as_array().unwrap().len(), 1);
    assert_eq!(overview["items"][0]["technicians"], 1);
    let (_, overview) = call(
        &app,
        "GET",
        "/api/v1/warehouse/overview",
        Some(access(&admin)),
        Value::Null,
    )
    .await;
    assert_eq!(overview["items"].as_array().unwrap().len(), 3);
}

#[sqlx::test(migrations = "../../migrations")]
async fn sim_import_previews_reports_and_updates_operator_data(db: PgPool) {
    let (app, _permit) = fixture(&db).await;
    let admin = login(&app, "admin").await;
    let mut rows = sheet(0..20);
    rows.push(json!({"row": 30, "iccid": "89554000000414256298"}));
    rows.push(json!({"row": 31, "iccid": iccid(3)}));
    rows.push(json!({"row": 32, "iccid": "8,95540000004142E+19"}));
    let key = Uuid::new_v4();
    let body = |dry_run: bool, key: Uuid, rows: &Vec<Value>| {
        json!({
        "client_import_id": key, "file_name": "Planilha ICCID.xlsx", "dry_run": dry_run, "rows": rows})
    };

    let (status, preview) = call_in(
        &app,
        "POST",
        "/api/v1/sims/imports",
        access(&admin),
        SAO_GABRIEL,
        body(true, key, &rows),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["created"], 20);
    assert_eq!(preview["invalid"].as_array().unwrap().len(), 3);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM sim_cards")
            .fetch_one(&db)
            .await
            .unwrap(),
        0
    );

    let (status, done) = call_in(
        &app,
        "POST",
        "/api/v1/sims/imports",
        access(&admin),
        SAO_GABRIEL,
        body(false, key, &rows),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert_eq!(done["created"], 20);
    // Repetir a mesma importação não duplica nada.
    let (status, again) = call_in(
        &app,
        "POST",
        "/api/v1/sims/imports",
        access(&admin),
        SAO_GABRIEL,
        body(false, key, &rows),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(again, done);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM sim_movements")
            .fetch_one(&db)
            .await
            .unwrap(),
        20
    );

    // Nova planilha: um chip ativado, um novo (em Bagé) e os demais iguais.
    let mut next = sheet(0..21);
    next[4]["operator_status"] = json!("Ativo");
    next[4]["subscriber"] = json!("Cliente 01");
    let (status, second) = call_in(
        &app,
        "POST",
        "/api/v1/sims/imports",
        access(&admin),
        BAGE,
        body(false, Uuid::new_v4(), &next),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{second}");
    assert_eq!(
        (
            second["created"].as_i64(),
            second["updated"].as_i64(),
            second["unchanged"].as_i64()
        ),
        (Some(1), Some(1), Some(19))
    );
    assert_eq!(second["other_location_count"], 20);
    assert_eq!(second["status_changes"][0]["to"], "Ativo");
    let (_, found) = call_in(
        &app,
        "GET",
        &format!("/api/v1/sims/lookup?code={}", &iccid(4)[..19]),
        access(&admin),
        SAO_GABRIEL,
        Value::Null,
    )
    .await;
    assert_eq!(found["result"], "FOUND", "{found}");
    assert_eq!(found["card"]["operator_status"], "Ativo");
    assert_eq!(found["card"]["location_name"], "São Gabriel");
    let (_, found) = call_in(
        &app,
        "GET",
        &format!("/api/v1/sims/lookup?code={}", iccid(20)),
        access(&admin),
        SAO_GABRIEL,
        Value::Null,
    )
    .await;
    assert_eq!(found["card"]["location_name"], "Bagé");
    let (_, invalid) = call_in(
        &app,
        "GET",
        "/api/v1/sims/lookup?code=7891234567895",
        access(&admin),
        SAO_GABRIEL,
        Value::Null,
    )
    .await;
    assert_eq!(invalid["result"], "INVALID");

    // Técnico não importa planilha.
    let tech_id = create_technician(&app, &admin, "tecnico").await;
    let _ = tech_id;
    let tech = login(&app, "tecnico").await;
    let (status, _) = call(
        &app,
        "POST",
        "/api/v1/sims/imports",
        Some(access(&tech)),
        body(false, Uuid::new_v4(), &next),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[sqlx::test(migrations = "../../migrations")]
async fn sim_delivery_and_return_move_each_chip_exactly_once(db: PgPool) {
    let (app, _permit) = fixture(&db).await;
    let admin = login(&app, "admin").await;
    let bruno = create_technician(&app, &admin, "bruno").await;
    let colleague = create_technician(&app, &admin, "colega").await;
    let bage_tech = create_account_in(&app, &admin, "tec-bage", "technician", BAGE).await;
    create_account(&app, &admin, "estoque-sg", "warehouse_clerk").await;
    create_account_in(&app, &admin, "estoque-bage", "warehouse_clerk", BAGE).await;
    let clerk = login(&app, "estoque-sg").await;
    let bage_clerk = login(&app, "estoque-bage").await;
    let (status, _) = call(
        &app,
        "POST",
        "/api/v1/sims/imports",
        Some(access(&clerk)),
        json!({
        "client_import_id": Uuid::new_v4(), "file_name": "chips.xlsx", "rows": sheet(0..40)}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Entrega 15 chips ao Bruno, um deles bipado sem o dígito verificador.
    let mut fifteen: Vec<String> = (0..15).map(iccid).collect();
    fifteen[14].truncate(19);
    let key = Uuid::new_v4();
    let delivery = json!({"client_transfer_id": key, "kind": "DELIVERY", "technician_id": bruno, "iccids": fifteen});
    let (status, voucher) = call(
        &app,
        "POST",
        "/api/v1/sims/transfers",
        Some(access(&clerk)),
        delivery.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{voucher}");
    assert_eq!(voucher["transfer"]["total"], 15);
    assert_eq!(voucher["transfer"]["technician_name"], "bruno");
    assert_eq!(voucher["items"].as_array().unwrap().len(), 15);
    assert_eq!(voucher["items"][14]["iccid"], iccid(14));
    // Repetição idempotente: mesmo comprovante, nenhum movimento a mais.
    let (status, repeated) = call(
        &app,
        "POST",
        "/api/v1/sims/transfers",
        Some(access(&clerk)),
        delivery,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{repeated}");
    assert_eq!(repeated, voucher);
    let moved = || {
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM sim_movements WHERE movement_type <> 'IMPORTED'",
        )
        .fetch_one(&db)
    };
    assert_eq!(moved().await.unwrap(), 15);
    // A mesma chave com outra lista é recusada.
    let (status, _) = call(&app, "POST", "/api/v1/sims/transfers", Some(access(&clerk)),
        json!({"client_transfer_id": key, "kind": "DELIVERY", "technician_id": bruno, "iccids": [iccid(20)]})).await;
    assert_eq!(status, StatusCode::CONFLICT);

    // Tudo ou nada: um chip já entregue bloqueia a entrega inteira.
    let (status, rejected) = call(
        &app,
        "POST",
        "/api/v1/sims/transfers",
        Some(access(&clerk)),
        json!({
        "client_transfer_id": Uuid::new_v4(), "kind": "DELIVERY", "technician_id": colleague,
        "iccids": [iccid(20), iccid(0), "89554000000414256298", iccid(20), iccid(99)]}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{rejected}");
    assert_eq!(rejected["code"], "SIM_TRANSFER_REJECTED");
    assert_eq!(
        rejected["problems"].as_array().unwrap().len(),
        4,
        "{rejected}"
    );
    let reason_of = |code: &str| {
        rejected["problems"]
            .as_array()
            .unwrap()
            .iter()
            .find(|problem| problem["iccid"] == code)
            .map(|problem| problem["reason"].clone())
    };
    assert_eq!(reason_of(&iccid(0)).unwrap(), "Este chip está com bruno.");
    assert_eq!(reason_of(&iccid(20)).unwrap(), "Chip repetido na lista.");
    assert!(
        reason_of(&iccid(99))
            .unwrap()
            .as_str()
            .unwrap()
            .starts_with("Chip não cadastrado")
    );
    assert_eq!(moved().await.unwrap(), 15);

    // Outra cidade não entrega chips de São Gabriel nem a técnicos de São Gabriel.
    let (status, body) = call(&app, "POST", "/api/v1/sims/transfers", Some(access(&bage_clerk)), json!({
        "client_transfer_id": Uuid::new_v4(), "kind": "DELIVERY", "technician_id": bage_tech, "iccids": [iccid(20)]})).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        body["problems"][0]["reason"],
        "Este chip está no estoque de São Gabriel."
    );
    let (status, _) = call(&app, "POST", "/api/v1/sims/transfers", Some(access(&bage_clerk)), json!({
        "client_transfer_id": Uuid::new_v4(), "kind": "DELIVERY", "technician_id": bruno, "iccids": [iccid(20)]})).await;
    assert_eq!(status, StatusCode::CONFLICT);

    // O técnico vê os próprios chips; a conta não sai com chips em posse.
    let tech = login(&app, "bruno").await;
    let (_, mine) = call(
        &app,
        "GET",
        "/api/v1/me/sims",
        Some(access(&tech)),
        Value::Null,
    )
    .await;
    assert_eq!(mine["items"].as_array().unwrap().len(), 15);
    let (status, body) = call(
        &app,
        "DELETE",
        &format!("/api/v1/admin/users/{bruno}"),
        Some(access(&admin)),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");

    // Devolução de 5 chips: só o que está com o técnico volta ao estoque.
    let back: Vec<String> = (0..5).map(iccid).collect();
    let (status, returned) = call(&app, "POST", "/api/v1/sims/transfers", Some(access(&clerk)), json!({
        "client_transfer_id": Uuid::new_v4(), "kind": "RETURN", "technician_id": bruno, "iccids": back})).await;
    assert_eq!(status, StatusCode::CREATED, "{returned}");
    let (_, list) = call(
        &app,
        "GET",
        "/api/v1/sims?holder=technicians",
        Some(access(&clerk)),
        Value::Null,
    )
    .await;
    assert_eq!(list["totals"]["stock"], 30);
    assert_eq!(list["totals"]["with_technicians"], 10);
    let (_, history) = call(
        &app,
        "GET",
        &format!("/api/v1/sims/lookup?code={}", iccid(0)),
        Some(access(&clerk)),
        Value::Null,
    )
    .await;
    let types: Vec<_> = history["history"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["type"].as_str().unwrap())
        .collect();
    assert_eq!(types, ["RETURNED", "DELIVERED", "IMPORTED"]);
    let (_, transfers) = call(
        &app,
        "GET",
        "/api/v1/sims/transfers",
        Some(access(&clerk)),
        Value::Null,
    )
    .await;
    assert_eq!(transfers["items"].as_array().unwrap().len(), 2);
    let (status, _) = call(
        &app,
        "GET",
        &format!("/api/v1/sims/transfers/{key}"),
        Some(access(&bage_clerk)),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Duas entregas concorrentes do mesmo chip: apenas uma move.
    let race = |technician: Uuid| {
        let app = app.clone();
        let token = access(&clerk).to_owned();
        async move {
            call(&app, "POST", "/api/v1/sims/transfers", Some(&token), json!({
                "client_transfer_id": Uuid::new_v4(), "kind": "DELIVERY", "technician_id": technician,
                "iccids": [iccid(30), iccid(31)]})).await.0
        }
    };
    let (left, right) = tokio::join!(race(bruno), race(colleague));
    let mut statuses = [left, right];
    statuses.sort();
    assert_eq!(statuses, [StatusCode::CREATED, StatusCode::CONFLICT]);
    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT count(*) FROM sim_movements WHERE movement_type = 'DELIVERED' AND sim_card_id IN (SELECT id FROM sim_cards WHERE iccid = $1)")
        .bind(iccid(30)).fetch_one(&db).await.unwrap(), 1);

    // O banco recusa custódia sem movimento e alteração do histórico.
    assert!(
        sqlx::query("UPDATE sim_cards SET location_id = NULL, technician_id = $1 WHERE iccid = $2")
            .bind(colleague)
            .bind(iccid(35))
            .execute(&db)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("DELETE FROM sim_movements")
            .execute(&db)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("UPDATE sim_cards SET iccid = $1 WHERE iccid = $2")
            .bind(iccid(98))
            .bind(iccid(36))
            .execute(&db)
            .await
            .is_err()
    );
}
