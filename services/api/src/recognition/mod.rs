use std::{io, process::Stdio, time::Duration};

use axum::body::Bytes;
use serde::Serialize;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    time::timeout,
};

pub mod labels;

const MAX_OUTPUT: u64 = 1024 * 1024;
const PROVIDER_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Clone, Copy)]
pub enum Failure {
    StorageUnavailable,
    ImageIntegrity,
    EngineUnavailable,
    EngineTimeout,
    EngineRejected,
    EngineOutput,
    LeaseExpired,
}

impl Failure {
    pub fn code(self) -> &'static str {
        match self {
            Self::StorageUnavailable => "STORAGE_UNAVAILABLE",
            Self::ImageIntegrity => "IMAGE_INTEGRITY",
            Self::EngineUnavailable => "ENGINE_UNAVAILABLE",
            Self::EngineTimeout => "ENGINE_TIMEOUT",
            Self::EngineRejected => "ENGINE_REJECTED",
            Self::EngineOutput => "ENGINE_OUTPUT",
            Self::LeaseExpired => "LEASE_EXPIRED",
        }
    }

    pub fn retryable(self) -> bool {
        matches!(
            self,
            Self::StorageUnavailable
                | Self::EngineUnavailable
                | Self::EngineTimeout
                | Self::EngineRejected
        )
    }
}

#[derive(Serialize)]
pub struct Suggestion {
    pub kind: &'static str,
    pub label: String,
    pub raw_value: String,
    pub normalized_value: String,
    pub confidence: Option<f32>,
}

#[derive(Serialize)]
pub struct Reading {
    pub suggestions: Vec<Suggestion>,
    pub warnings: Vec<&'static str>,
}

pub trait LabelRecognitionProvider {
    fn name(&self) -> &str;
    fn model_version(&self) -> &str;
    fn recognize(&self, image: Bytes) -> impl Future<Output = Result<String, Failure>> + Send;
}

pub struct Tesseract {
    executable: std::ffi::OsString,
    language: String,
    version: String,
}

impl Tesseract {
    pub async fn from_env() -> Result<Self, Box<dyn std::error::Error>> {
        let executable =
            std::env::var_os("OCR_TESSERACT_BIN").unwrap_or_else(|| "tesseract".into());
        let language = std::env::var("OCR_LANGUAGE").unwrap_or_else(|_| "eng".into());
        if language.is_empty()
            || language.len() > 64
            || !language
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'+'))
        {
            return Err("OCR_LANGUAGE inválido.".into());
        }
        let version = run(&executable, &["--version"], None).await.map_err(
            |_| "Tesseract indisponível. Instale o executável ou ajuste OCR_TESSERACT_BIN.",
        )?;
        let version = version
            .lines()
            .next()
            .filter(|line| !line.is_empty())
            .ok_or("Tesseract não informou a versão.")?;
        Ok(Self {
            executable,
            version: format!("{version} / {language} / psm11"),
            language,
        })
    }
}

impl LabelRecognitionProvider for Tesseract {
    fn name(&self) -> &str {
        "tesseract"
    }

    fn model_version(&self) -> &str {
        &self.version
    }

    async fn recognize(&self, image: Bytes) -> Result<String, Failure> {
        let output = run(
            &self.executable,
            &[
                "stdin",
                "stdout",
                "-l",
                &self.language,
                "--psm",
                "11",
                "tsv",
            ],
            Some(image),
        )
        .await?;
        if !output.starts_with("level\tpage_num\t") || output.contains('\0') {
            return Err(Failure::EngineOutput);
        }
        Ok(output)
    }
}

async fn run(
    executable: &std::ffi::OsStr,
    args: &[&str],
    image: Option<Bytes>,
) -> Result<String, Failure> {
    let mut child = Command::new(executable)
        .args(args)
        .env("OMP_THREAD_LIMIT", "1")
        .stdin(if image.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| Failure::EngineUnavailable)?;

    let mut input = child.stdin.take();
    let mut output = child
        .stdout
        .take()
        .expect("stdout foi configurado")
        .take(MAX_OUTPUT + 1);
    let result = timeout(PROVIDER_TIMEOUT, async {
        let (written, bytes) = tokio::join!(
            async {
                if let (Some(mut pipe), Some(image)) = (input.take(), image) {
                    pipe.write_all(&image).await?;
                }
                Ok::<_, io::Error>(())
            },
            async {
                let mut bytes = Vec::new();
                output.read_to_end(&mut bytes).await?;
                Ok::<_, io::Error>(bytes)
            }
        );
        let bytes = bytes.map_err(|_| Failure::EngineUnavailable)?;
        if bytes.len() as u64 > MAX_OUTPUT {
            return Err(Failure::EngineOutput);
        }
        let status = child.wait().await.map_err(|_| Failure::EngineUnavailable)?;
        if !status.success() || written.is_err() {
            return Err(Failure::EngineRejected);
        }
        String::from_utf8(bytes).map_err(|_| Failure::EngineOutput)
    })
    .await;
    match result {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(error)) => {
            let _ = child.kill().await;
            Err(error)
        }
        Err(_) => {
            let _ = child.kill().await;
            Err(Failure::EngineTimeout)
        }
    }
}
