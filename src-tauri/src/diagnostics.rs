use chrono::Local;
use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

static DIAGNOSTIC_LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
static DIAGNOSTIC_WRITE_LOCK: Mutex<()> = Mutex::new(());

const APP_NAME: &str = "SDJFAM Chat";

// =========================================================
// LOG TYPES
// =========================================================

#[derive(Debug, Serialize)]
pub struct DiagnosticInfo {
    pub log_path: String,
    pub session_started_at: String,
}

// =========================================================
// LOG DIRECTORY
// =========================================================

fn diagnostic_log_directory() -> Result<PathBuf, String> {
    let local_app_data =
        std::env::var("LOCALAPPDATA").map_err(|_| {
            "Windows LOCALAPPDATA kon niet worden gevonden".to_string()
        })?;

    let log_dir =
        Path::new(&local_app_data)
            .join(APP_NAME)
            .join("logs");

    fs::create_dir_all(&log_dir).map_err(|error| {
        format!(
            "Diagnostische logmap kon niet worden gemaakt: {error}"
        )
    })?;

    Ok(log_dir)
}

// =========================================================
// SESSION LOG PATH
// =========================================================

fn create_session_log_path() -> Result<PathBuf, String> {
    let log_dir =
        diagnostic_log_directory()?;

    let timestamp =
        Local::now()
            .format("%Y-%m-%d_%H-%M-%S")
            .to_string();

    Ok(
        log_dir.join(
            format!(
                "stream-{timestamp}.log"
            ),
        ),
    )
}

fn diagnostic_log_path() -> Result<&'static PathBuf, String> {
    if let Some(path) =
        DIAGNOSTIC_LOG_PATH.get()
    {
        return Ok(path);
    }

    let path =
        create_session_log_path()?;

    let _ =
        DIAGNOSTIC_LOG_PATH.set(path);

    DIAGNOSTIC_LOG_PATH
        .get()
        .ok_or_else(|| {
            "Diagnostisch logpad kon niet worden geïnitialiseerd"
                .to_string()
        })
}

// =========================================================
// REDACTION HELPERS
// =========================================================

fn is_sensitive_key(
    key: &str,
) -> bool {
    matches!(
        key.to_ascii_lowercase().as_str(),
        "token"
            | "access_token"
            | "refresh_token"
            | "id_token"
            | "api_key"
            | "apikey"
            | "client_secret"
            | "secret"
            | "authorization"
            | "password"
            | "passwd"
            | "oauth_code"
            | "auth_code"
            | "device_code"
            | "user_code"
            | "code_verifier"
            | "code_challenge"
            | "pkce_verifier"
            | "pkce_challenge"
            | "state"
            | "bearer"
    )
}

fn redact_key_value_token(
    token: &str,
) -> String {
    for separator in ['=', ':'] {
        if let Some(index) =
            token.find(separator)
        {
            let key =
                token[..index]
                    .trim()
                    .trim_matches('"')
                    .trim_matches('\'');

            if is_sensitive_key(key) {
                return format!(
                    "{}{}[REDACTED]",
                    &token[..index],
                    separator
                );
            }
        }
    }

    token.to_string()
}

fn redact_bearer_tokens(
    value: &str,
) -> String {
    let mut output =
        Vec::new();

    let mut redact_next =
        false;

    for token in value.split_whitespace() {
        if redact_next {
            output.push(
                "[REDACTED]".to_string()
            );

            redact_next = false;
            continue;
        }

        if token.eq_ignore_ascii_case(
            "bearer",
        ) {
            output.push(
                "Bearer".to_string()
            );

            redact_next = true;
            continue;
        }

        output.push(
            token.to_string()
        );
    }

    output.join(" ")
}

fn redact_sensitive_values(
    value: &str,
) -> String {
    let mut sanitized =
        redact_bearer_tokens(value);

    let separators =
        [' ', '|', ',', ';'];

    for separator in separators {
        sanitized =
            sanitized
                .split(separator)
                .map(
                    redact_key_value_token
                )
                .collect::<Vec<_>>()
                .join(
                    &separator.to_string()
                );
    }

    sanitized
}

// =========================================================
// SANITIZE
// =========================================================

fn sanitize_log_value(
    value: &str,
) -> String {
    let single_line =
        value
            .replace('\r', " ")
            .replace('\n', " ");

    let mut sanitized =
        redact_sensitive_values(
            &single_line
        );

    const MAX_LENGTH: usize = 4000;

    if sanitized.chars().count() > MAX_LENGTH {
        sanitized =
            sanitized
                .chars()
                .take(MAX_LENGTH)
                .collect::<String>();

        sanitized.push_str(
            " [TRUNCATED]",
        );
    }

    sanitized
}

// =========================================================
// WRITE
// =========================================================

pub fn write_diagnostic_log(
    category: &str,
    message: &str,
) -> Result<(), String> {
    let _write_guard =
        DIAGNOSTIC_WRITE_LOCK
            .lock()
            .map_err(|_| {
                "Diagnostische log-lock is beschadigd"
                    .to_string()
            })?;

    let log_path =
        diagnostic_log_path()?;

    let timestamp =
        Local::now()
            .format(
                "%Y-%m-%d %H:%M:%S%.3f",
            )
            .to_string();

    let category =
        sanitize_log_value(
            category
        );

    let message =
        sanitize_log_value(
            message
        );

    let line =
        format!(
            "[{timestamp}] [{category}] {message}\r\n"
        );

    let mut file =
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_path)
            .map_err(|error| {
                format!(
                    "Diagnostisch logbestand kon niet worden geopend: {error}"
                )
            })?;

    file.write_all(
        line.as_bytes(),
    )
    .map_err(|error| {
        format!(
            "Diagnostische logregel kon niet worden geschreven: {error}"
        )
    })?;

    file.flush()
        .map_err(|error| {
            format!(
                "Diagnostische log kon niet worden opgeslagen: {error}"
            )
        })?;

    Ok(())
}

// =========================================================
// SESSION START
// =========================================================

pub fn initialize_diagnostics(
    app_version: &str,
) -> Result<DiagnosticInfo, String> {
    let log_path =
        diagnostic_log_path()?
            .clone();

    let started_at =
        Local::now()
            .to_rfc3339();

    write_diagnostic_log(
        "SESSION",
        "============================================================",
    )?;

    write_diagnostic_log(
        "SESSION",
        &format!(
            "SDJFAM Chat session started | version={app_version}"
        ),
    )?;

    write_diagnostic_log(
        "SESSION",
        &format!(
            "os={} arch={}",
            std::env::consts::OS,
            std::env::consts::ARCH,
        ),
    )?;

    write_diagnostic_log(
        "SESSION",
        "Diagnostic logging active",
    )?;

    write_diagnostic_log(
        "SESSION",
        "Sensitive values are defensively redacted from diagnostic output",
    )?;

    Ok(
        DiagnosticInfo {
            log_path:
                log_path
                    .to_string_lossy()
                    .to_string(),

            session_started_at:
                started_at,
        },
    )
}

// =========================================================
// TAURI COMMANDS
// =========================================================

#[tauri::command]
pub fn diagnostic_log(
    category: String,
    message: String,
) -> Result<(), String> {
    write_diagnostic_log(
        &category,
        &message,
    )
}

#[tauri::command]
pub fn diagnostic_log_path_command()
    -> Result<String, String>
{
    Ok(
        diagnostic_log_path()?
            .to_string_lossy()
            .to_string(),
    )
}

#[tauri::command]
pub fn diagnostic_session_marker(
    marker: String,
) -> Result<(), String> {
    write_diagnostic_log(
        "SESSION",
        &format!(
            "MARKER: {}",
            marker,
        ),
    )
}