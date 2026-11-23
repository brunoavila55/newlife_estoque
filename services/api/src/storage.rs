use std::{env, future::Future, pin::Pin, time::Duration};

use axum::body::Bytes;
use futures_util::TryStreamExt;
use object_store::{
    Attribute, Attributes, ObjectStore, PutMode, PutOptions,
    aws::{AmazonS3, AmazonS3Builder, S3ConditionalPut},
    path::Path,
    signer::Signer,
};

pub type StorageFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, object_store::Error>> + Send + 'a>>;

pub trait ObjectStorage: Send + Sync {
    fn has_objects(&self) -> StorageFuture<'_, bool>;
    fn write_image<'a>(
        &'a self,
        key: &'a str,
        bytes: Bytes,
        mime: &'static str,
    ) -> StorageFuture<'a, ()>;
    fn read_image<'a>(&'a self, key: &'a str, max_bytes: usize) -> StorageFuture<'a, Bytes>;
    fn verify_exists<'a>(&'a self, key: &'a str) -> StorageFuture<'a, ()>;
    fn read_url<'a>(&'a self, key: &'a str) -> StorageFuture<'a, String>;
}

pub struct S3Storage {
    storage: AmazonS3,
    signer: AmazonS3,
}

impl S3Storage {
    pub fn from_env() -> Result<Self, Box<dyn std::error::Error>> {
        let builder = AmazonS3Builder::new()
            .with_bucket_name(env::var("S3_BUCKET")?)
            .with_access_key_id(env::var("AWS_ACCESS_KEY_ID")?)
            .with_secret_access_key(env::var("AWS_SECRET_ACCESS_KEY")?)
            .with_conditional_put(S3ConditionalPut::ETagMatch)
            .with_region(env::var("AWS_REGION").unwrap_or_else(|_| "us-east-1".into()))
            .with_client_options(
                object_store::ClientOptions::new().with_timeout(Duration::from_secs(5)),
            )
            .with_retry(object_store::RetryConfig {
                max_retries: 0,
                ..Default::default()
            })
            .with_allow_http(env::var("S3_ALLOW_HTTP").as_deref() == Ok("true"));
        let storage = builder
            .clone()
            .with_endpoint(env::var("S3_ENDPOINT")?)
            .build()?;
        let signer = match env::var("S3_PUBLIC_ENDPOINT") {
            Ok(endpoint) if !endpoint.is_empty() => {
                let url = url::Url::parse(&endpoint)?;
                if url.scheme() != "https"
                    || url.path() != "/"
                    || url.query().is_some()
                    || url.fragment().is_some()
                    || !url.username().is_empty()
                    || url.password().is_some()
                {
                    return Err("S3_PUBLIC_ENDPOINT deve ser uma origem HTTPS.".into());
                }
                builder
                    .with_endpoint(endpoint)
                    .with_allow_http(false)
                    .build()?
            }
            _ => storage.clone(),
        };
        Ok(Self { storage, signer })
    }

    pub async fn create_image(
        &self,
        key: &str,
        bytes: Bytes,
        mime: &'static str,
    ) -> Result<(), object_store::Error> {
        self.put_image(key, bytes, mime, PutMode::Create).await
    }

    async fn put_image(
        &self,
        key: &str,
        bytes: Bytes,
        mime: &'static str,
        mode: PutMode,
    ) -> Result<(), object_store::Error> {
        let attributes = Attributes::from_iter([
            (Attribute::ContentType, mime),
            (Attribute::CacheControl, "private, no-store"),
        ]);
        self.storage
            .put_opts(
                &Path::parse(key)?,
                bytes.into(),
                PutOptions {
                    attributes,
                    mode,
                    ..Default::default()
                },
            )
            .await?;
        Ok(())
    }
}

impl ObjectStorage for S3Storage {
    fn has_objects(&self) -> StorageFuture<'_, bool> {
        Box::pin(async move { Ok(self.storage.list(None).try_next().await?.is_some()) })
    }

    fn write_image<'a>(
        &'a self,
        key: &'a str,
        bytes: Bytes,
        mime: &'static str,
    ) -> StorageFuture<'a, ()> {
        Box::pin(self.put_image(key, bytes, mime, PutMode::Overwrite))
    }

    fn read_image<'a>(&'a self, key: &'a str, max_bytes: usize) -> StorageFuture<'a, Bytes> {
        Box::pin(async move {
            let result = self.storage.get(&Path::parse(key)?).await?;
            if result.meta.size > max_bytes as u64 {
                return Ok(Bytes::new());
            }
            result.bytes().await
        })
    }

    fn verify_exists<'a>(&'a self, key: &'a str) -> StorageFuture<'a, ()> {
        Box::pin(async move {
            self.storage.head(&Path::parse(key)?).await?;
            Ok(())
        })
    }

    fn read_url<'a>(&'a self, key: &'a str) -> StorageFuture<'a, String> {
        Box::pin(async move {
            Ok(self
                .signer
                .signed_url(
                    axum::http::Method::GET,
                    &Path::parse(key)?,
                    Duration::from_secs(120),
                )
                .await?
                .to_string())
        })
    }
}
