//! Shared Twitch recovery. Errors never contain response bodies or credentials.
use crate::StoredTwitchToken;
use oauth2::reqwest;
use serde::Deserialize;
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

static TOKEN_CHANGES: std::sync::LazyLock<tokio::sync::watch::Sender<u64>> =
    std::sync::LazyLock::new(|| tokio::sync::watch::channel(0).0);
pub fn token_changes() -> tokio::sync::watch::Receiver<u64> {
    TOKEN_CHANGES.subscribe()
}
fn token_changed() {
    *OBSERVATION.lock().unwrap_or_else(|e| e.into_inner()) = None;
    TOKEN_CHANGES.send_modify(|generation| *generation = generation.wrapping_add(1));
}

const VALIDATE_URL: &str = "https://id.twitch.tv/oauth2/validate";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthError {
    AccessInvalid,
    RelinkRequired,
    MissingScopes,
    Configuration,
    TemporaryService,
    Network,
    Protocol,
    Storage,
}
impl AuthError {
    pub fn code(self) -> &'static str {
        match self {
            Self::AccessInvalid => "access_token_invalid",
            Self::RelinkRequired => "relink_required",
            Self::MissingScopes => "missing_scopes",
            Self::Configuration => "configuration_error",
            Self::TemporaryService => "temporary_service_error",
            Self::Network => "network_error",
            Self::Protocol => "protocol_error",
            Self::Storage => "storage_error",
        }
    }
    pub fn retryable(self) -> bool {
        matches!(
            self,
            Self::TemporaryService | Self::Network | Self::Protocol
        )
    }
    pub fn needs_relink(self) -> bool {
        matches!(self, Self::RelinkRequired | Self::MissingScopes)
    }
}
impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::AccessInvalid => "Twitch access token geweigerd; tokenherstel nodig.",
            Self::RelinkRequired => "Twitch tokenherstel is niet mogelijk. Koppel Twitch opnieuw.",
            Self::MissingScopes => {
                "Vereiste Twitch-rechten ontbreken. Koppel Twitch opnieuw en geef toestemming."
            }
            Self::Configuration => {
                "Twitch Client ID of API-configuratie klopt niet. Controleer de configuratie."
            }
            Self::TemporaryService => {
                "Twitch is tijdelijk niet beschikbaar of beperkt verzoeken. Wacht op herstel."
            }
            Self::Network => "Twitch is niet bereikbaar door een netwerkfout. Wacht op herstel.",
            Self::Protocol => "Twitch gaf een onverwacht antwoord. Wacht op herstel.",
            Self::Storage => "De lokale Twitch-koppeling kon niet worden gelezen of opgeslagen.",
        })
    }
}
impl From<AuthError> for String {
    fn from(error: AuthError) -> Self {
        error.to_string()
    }
}

pub fn http_error(status: u16, refresh: bool, body: &str) -> AuthError {
    if status == 429 || status >= 500 {
        return AuthError::TemporaryService;
    }
    if refresh {
        let value: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
        let message = value
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let code = value.get("error").and_then(|v| v.as_str()).unwrap_or("");
        if (status == 400 || status == 401)
            && (code == "invalid_grant"
                || message.contains("invalid refresh token")
                || message.contains("refresh token is invalid"))
        {
            return AuthError::RelinkRequired;
        }
        return AuthError::Configuration;
    }
    match status {
        401 => AuthError::AccessInvalid,
        403 => AuthError::MissingScopes,
        _ => AuthError::Configuration,
    }
}

pub fn log(message: &str) {
    #[cfg(not(test))]
    let _ = crate::diagnostics::write_diagnostic_log("TWITCH_AUTH", message);
    #[cfg(test)]
    let _ = message;
}

// The local link date is not proof of a valid access token.
static OBSERVATION: StdMutex<Option<Result<(), AuthError>>> = StdMutex::new(None);
pub fn observe(result: Result<(), AuthError>) {
    *OBSERVATION.lock().unwrap_or_else(|e| e.into_inner()) = Some(result);
}
pub fn observation() -> Option<Result<(), AuthError>> {
    *OBSERVATION.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Deserialize)]
pub struct Validation {
    pub client_id: String,
    pub user_id: Option<String>,
    pub scopes: Option<Vec<String>>,
}
async fn validate_at(
    http: &reqwest::Client,
    url: &str,
    client_id: &str,
    token: &str,
    scopes: &[&str],
) -> Result<Validation, AuthError> {
    let response = http
        .get(url)
        .header("Authorization", format!("OAuth {token}"))
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|_| AuthError::Network)?;
    let status = response.status();
    if !status.is_success() {
        return Err(http_error(status.as_u16(), false, ""));
    }
    let body = response.text().await.map_err(|_| AuthError::Network)?;
    let value: Validation = serde_json::from_str(&body).map_err(|_| AuthError::Protocol)?;
    if value.client_id != client_id {
        return Err(AuthError::Configuration);
    }
    if value.user_id.as_deref().unwrap_or("").is_empty() {
        return Err(AuthError::Protocol);
    }
    if scopes.iter().any(|required| {
        !value
            .scopes
            .as_deref()
            .unwrap_or_default()
            .iter()
            .any(|s| s == required)
    }) {
        return Err(AuthError::MissingScopes);
    }
    Ok(value)
}

trait TokenStore: Sync {
    fn load(&self) -> Result<StoredTwitchToken, AuthError>;
    fn save(&self, access: &str, refresh: &str) -> Result<StoredTwitchToken, AuthError>;
}
struct DiskStore;
impl TokenStore for DiskStore {
    fn load(&self) -> Result<StoredTwitchToken, AuthError> {
        crate::load_stored_twitch_token()
            .map_err(|_| AuthError::Storage)?
            .ok_or(AuthError::RelinkRequired)
    }
    fn save(&self, access: &str, refresh: &str) -> Result<StoredTwitchToken, AuthError> {
        crate::save_twitch_token(access, refresh).map_err(|_| AuthError::Storage)?;
        self.load()
    }
}
struct Failure {
    token: String,
    client_id: String,
    error: AuthError,
    at: Instant,
}
struct TokenRecovery {
    state: Mutex<Option<Failure>>,
}
impl TokenRecovery {
    const fn new() -> Self {
        Self {
            state: Mutex::const_new(None),
        }
    }
    async fn observe_current<S: TokenStore>(
        &self,
        token: &str,
        result: Result<(), AuthError>,
        store: &S,
    ) -> bool {
        let _state = self.state.lock().await;
        if store
            .load()
            .is_ok_and(|current| current.access_token == token)
        {
            observe(result);
            true
        } else {
            false
        }
    }
    async fn reject<S: TokenStore>(&self, client_id: &str, rejected: &str, store: &S) {
        let mut state = self.state.lock().await;
        // Do not poison a newer manual login or refresh with an old in-flight 401.
        if store
            .load()
            .is_ok_and(|token| token.access_token == rejected)
        {
            *state = Some(Failure {
                token: rejected.to_string(),
                client_id: client_id.to_string(),
                error: AuthError::RelinkRequired,
                at: Instant::now(),
            });
            observe(Err(AuthError::RelinkRequired));
        }
    }
    async fn refresh<S: TokenStore>(
        &self,
        http: &reqwest::Client,
        url: &str,
        client_id: &str,
        rejected: &str,
        store: &S,
    ) -> Result<StoredTwitchToken, AuthError> {
        let mut state = self.state.lock().await;
        let current = store.load()?;
        // Another caller or manual login already replaced the rejected token.
        if current.access_token != rejected {
            return Ok(current);
        }
        if let Some(failure) = state.as_ref() {
            if failure.token == rejected
                && failure.client_id == client_id
                && (!failure.error.retryable() || failure.at.elapsed() < Duration::from_secs(30))
            {
                return Err(failure.error);
            }
        }
        log("access token refresh attempted");
        let result = async {
            if current.refresh_token.is_empty() {
                return Err(AuthError::RelinkRequired);
            }
            let response = http
                .post(url)
                .form(&[
                    ("client_id", client_id),
                    ("grant_type", "refresh_token"),
                    ("refresh_token", current.refresh_token.as_str()),
                ])
                .timeout(REQUEST_TIMEOUT)
                .send()
                .await
                .map_err(|_| AuthError::Network)?;
            let status = response.status();
            let body = response.text().await.map_err(|_| AuthError::Network)?;
            if !status.is_success() {
                return Err(http_error(status.as_u16(), true, &body));
            }
            let token: crate::TwitchTokenResponse =
                serde_json::from_str(&body).map_err(|_| AuthError::Protocol)?;
            if token.access_token.is_empty() || token.refresh_token.is_empty() {
                return Err(AuthError::Protocol);
            }
            store.save(&token.access_token, &token.refresh_token)
        }
        .await;
        match &result {
            Ok(token) => {
                *state = Some(Failure {
                    token: token.access_token.clone(),
                    client_id: client_id.to_string(),
                    error: AuthError::TemporaryService,
                    at: Instant::now(),
                });
                log("access token refresh succeeded");
                token_changed();
            }
            Err(error) => {
                *state = Some(Failure {
                    token: rejected.to_string(),
                    client_id: client_id.to_string(),
                    error: *error,
                    at: Instant::now(),
                });
                log(&format!(
                    "access token refresh failed | category={}",
                    error.code()
                ));
            }
        }
        result
    }
}
static RECOVERY: TokenRecovery = TokenRecovery::new();

pub async fn refresh_after_rejection(
    http: &reqwest::Client,
    client_id: &str,
    rejected: &str,
) -> Result<StoredTwitchToken, AuthError> {
    // Finish saving a rotated token even when an EventSub task is cancelled.
    let (http, client_id, rejected) = (http.clone(), client_id.to_string(), rejected.to_string());
    let expected = rejected.clone();
    let result = tokio::spawn(async move {
        RECOVERY
            .refresh(
                &http,
                crate::TWITCH_TOKEN_URL,
                &client_id,
                &rejected,
                &DiskStore,
            )
            .await
    })
    .await
    .map_err(|_| AuthError::Storage)?;
    if let Err(error) = &result {
        RECOVERY
            .observe_current(&expected, Err(*error), &DiskStore)
            .await;
    }
    result
}

// Injected recovery keeps validation tests independent of disk and real credentials.
async fn validate_with_recovery<F, Fut>(
    http: &reqwest::Client,
    url: &str,
    client_id: &str,
    mut token: StoredTwitchToken,
    scopes: &[&str],
    recover: F,
) -> Result<(StoredTwitchToken, Validation), AuthError>
where
    F: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = Result<StoredTwitchToken, AuthError>>,
{
    let mut result = validate_at(http, url, client_id, &token.access_token, scopes).await;
    if let Err(error) = result.as_ref() {
        log(&format!(
            "EventSub token validation failed | category={}",
            error.code()
        ));
    }
    if matches!(result, Err(AuthError::AccessInvalid)) {
        token = recover(token.access_token.clone()).await?;
        result = validate_at(http, url, client_id, &token.access_token, scopes).await;
    }
    let validation = result.map_err(|e| {
        if e == AuthError::AccessInvalid {
            AuthError::RelinkRequired
        } else {
            e
        }
    })?;
    Ok((token, validation))
}
pub async fn reject_refreshed_token(client_id: &str, token: &str) {
    RECOVERY.reject(client_id, token, &DiskStore).await;
}
pub async fn validated_token(
    http: &reqwest::Client,
    client_id: &str,
    scopes: &[&str],
) -> Result<(StoredTwitchToken, Validation), AuthError> {
    let token = DiskStore.load()?;
    let initial_access = token.access_token.clone();
    let refreshed = StdMutex::new(None);
    let result = validate_with_recovery(http, VALIDATE_URL, client_id, token, scopes, |rejected| {
        let refreshed = &refreshed;
        async move {
            let token = refresh_after_rejection(http, client_id, &rejected).await?;
            *refreshed.lock().unwrap_or_else(|e| e.into_inner()) = Some(token.access_token.clone());
            Ok(token)
        }
    })
    .await;
    let refreshed: Option<String> = refreshed.into_inner().unwrap_or_else(|e| e.into_inner());
    let observed_access = refreshed.as_deref().unwrap_or(&initial_access);
    if matches!(result, Err(AuthError::RelinkRequired)) && refreshed.is_some() {
        reject_refreshed_token(client_id, observed_access).await;
    }
    RECOVERY
        .observe_current(
            observed_access,
            result.as_ref().map(|_| ()).map_err(|e| *e),
            &DiskStore,
        )
        .await;
    result
}
pub async fn save_login(access: &str, refresh: &str) -> Result<(), String> {
    let mut state = RECOVERY.state.lock().await;
    DiskStore.save(access, refresh).map_err(String::from)?;
    *state = None;
    *OBSERVATION.lock().unwrap_or_else(|e| e.into_inner()) = None;
    token_changed();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    fn token(access: &str) -> StoredTwitchToken {
        StoredTwitchToken {
            access_token: access.into(),
            refresh_token: "fake-refresh".into(),
            linked_at: chrono::Utc::now(),
        }
    }
    struct MemoryStore(StdMutex<StoredTwitchToken>);
    impl MemoryStore {
        fn new() -> Self {
            Self(StdMutex::new(token("old")))
        }
    }
    impl TokenStore for MemoryStore {
        fn load(&self) -> Result<StoredTwitchToken, AuthError> {
            let t = self.0.lock().unwrap();
            Ok(StoredTwitchToken {
                access_token: t.access_token.clone(),
                refresh_token: t.refresh_token.clone(),
                linked_at: t.linked_at,
            })
        }
        fn save(&self, access: &str, refresh: &str) -> Result<StoredTwitchToken, AuthError> {
            *self.0.lock().unwrap() = StoredTwitchToken {
                access_token: access.into(),
                refresh_token: refresh.into(),
                linked_at: chrono::Utc::now(),
            };
            self.load()
        }
    }
    async fn server(
        replies: Vec<(u16, &'static str)>,
    ) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let task = tokio::spawn(async move {
            for (status, body) in replies {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                loop {
                    let mut buf = [0; 4096];
                    let n = socket.read(&mut buf).await.unwrap();
                    if n == 0 {
                        break;
                    }
                    request.extend_from_slice(&buf[..n]);
                    if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..end]);
                        let length: usize = headers
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|n| n.trim().parse().ok())
                            })
                            .unwrap_or(0);
                        if request.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                count.fetch_add(1, Ordering::SeqCst);
                let response = format!("HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}", body.len());
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        (url, calls, task)
    }
    fn client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }
    const VALID: &str = r#"{"client_id":"client","user_id":"user","scopes":["bits:read"]}"#;
    const REFRESHED: &str = r#"{"access_token":"new","refresh_token":"rotated","expires_in":3600,"token_type":"bearer","scope":[]}"#;

    #[tokio::test]
    async fn valid_access_never_refreshes() {
        let (url, calls, task) = server(vec![(200, VALID)]).await;
        let result = validate_with_recovery(
            &client(),
            &url,
            "client",
            token("valid"),
            &["bits:read"],
            |_| async { panic!("must not refresh") },
        )
        .await;
        assert!(result.is_ok());
        task.await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn invalid_access_refreshes_once_then_validates() {
        let (url, calls, task) = server(vec![(401, "{}"), (200, VALID)]).await;
        let refreshes = AtomicUsize::new(0);
        let result = validate_with_recovery(
            &client(),
            &url,
            "client",
            token("old"),
            &["bits:read"],
            |_| async {
                refreshes.fetch_add(1, Ordering::SeqCst);
                Ok(token("new"))
            },
        )
        .await
        .unwrap();
        assert_eq!(result.0.access_token, "new");
        assert_eq!(refreshes.load(Ordering::SeqCst), 1);
        task.await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
    #[tokio::test]
    async fn repeated_401_stops_without_refresh_loop() {
        let (url, _, task) = server(vec![(401, "{}"), (401, "{}")]).await;
        let result =
            validate_with_recovery(&client(), &url, "client", token("old"), &[], |_| async {
                Ok(token("new"))
            })
            .await;
        assert!(matches!(result, Err(AuthError::RelinkRequired)));
        task.await.unwrap();
    }
    #[tokio::test]
    async fn missing_scopes_does_not_refresh() {
        let (url, _, task) = server(vec![(200, VALID)]).await;
        let result = validate_with_recovery(
            &client(),
            &url,
            "client",
            token("valid"),
            &["channel:read:subscriptions"],
            |_| async { panic!("must not refresh") },
        )
        .await;
        assert!(matches!(result, Err(AuthError::MissingScopes)));
        task.await.unwrap();
    }
    #[tokio::test]
    async fn temporary_validation_error_does_not_relink_or_refresh() {
        let (url, _, task) = server(vec![(503, "secret-body")]).await;
        let result =
            validate_with_recovery(&client(), &url, "client", token("valid"), &[], |_| async {
                panic!("must not refresh")
            })
            .await;
        assert!(matches!(result, Err(AuthError::TemporaryService)));
        task.await.unwrap();
    }
    #[tokio::test]
    async fn network_failure_is_retryable_without_relink() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let result =
            validate_with_recovery(&client(), &url, "client", token("valid"), &[], |_| async {
                panic!("must not refresh")
            })
            .await;
        assert!(matches!(result, Err(AuthError::Network)));
    }
    #[tokio::test]
    async fn concurrent_rejections_share_one_refresh_and_save_rotated_token() {
        let (url, calls, task) = server(vec![(200, REFRESHED)]).await;
        let recovery = TokenRecovery::new();
        let store = MemoryStore::new();
        let http = client();
        let (a, b) = tokio::join!(
            recovery.refresh(&http, &url, "client", "old", &store),
            recovery.refresh(&http, &url, "client", "old", &store)
        );
        assert_eq!(a.unwrap().access_token, "new");
        assert_eq!(b.unwrap().access_token, "new");
        assert_eq!(store.load().unwrap().refresh_token, "rotated");
        task.await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn invalid_refresh_is_terminal_and_not_retried_by_other_callers() {
        let (url, calls, task) = server(vec![(
            400,
            r#"{"message":"Invalid refresh token","secret":"never-log"}"#,
        )])
        .await;
        let recovery = TokenRecovery::new();
        let store = MemoryStore::new();
        let http = client();
        for _ in 0..3 {
            assert!(matches!(
                recovery.refresh(&http, &url, "client", "old", &store).await,
                Err(AuthError::RelinkRequired)
            ));
        }
        task.await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn temporary_refresh_failure_has_cooldown_and_keeps_old_token() {
        let (url, calls, task) = server(vec![(503, "do-not-log")]).await;
        let recovery = TokenRecovery::new();
        let store = MemoryStore::new();
        let http = client();
        for _ in 0..2 {
            assert!(matches!(
                recovery.refresh(&http, &url, "client", "old", &store).await,
                Err(AuthError::TemporaryService)
            ));
        }
        assert_eq!(store.load().unwrap().access_token, "old");
        task.await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn token_replaced_by_login_is_reused_without_refresh() {
        let recovery = TokenRecovery::new();
        let store = MemoryStore::new();
        store.save("login-new", "refresh-new").unwrap();
        let result = recovery
            .refresh(&client(), "http://127.0.0.1:1", "client", "old", &store)
            .await
            .unwrap();
        assert_eq!(result.access_token, "login-new");
    }
    #[test]
    fn classification_does_not_expose_provider_body() {
        for (status, refresh, body, expected) in [
            (401, false, "secret", AuthError::AccessInvalid),
            (403, false, "secret", AuthError::MissingScopes),
            (429, false, "secret", AuthError::TemporaryService),
            (500, true, "secret", AuthError::TemporaryService),
            (
                400,
                true,
                r#"{"error":"invalid_grant"}"#,
                AuthError::RelinkRequired,
            ),
            (
                401,
                true,
                r#"{"message":"invalid client secret"}"#,
                AuthError::Configuration,
            ),
        ] {
            let error = http_error(status, refresh, body);
            assert_eq!(error, expected);
            assert!(!error.to_string().contains("secret"));
        }
    }
    #[tokio::test]
    async fn rejected_replacement_blocks_further_refreshes_until_login() {
        let recovery = TokenRecovery::new();
        let store = MemoryStore::new();
        store.save("rejected-new", "new-refresh").unwrap();
        recovery.reject("client", "rejected-new", &store).await;
        assert!(matches!(
            recovery
                .refresh(
                    &client(),
                    "http://127.0.0.1:1",
                    "client",
                    "rejected-new",
                    &store
                )
                .await,
            Err(AuthError::RelinkRequired)
        ));
        store.save("manual-login", "manual-refresh").unwrap();
        assert_eq!(
            recovery
                .refresh(
                    &client(),
                    "http://127.0.0.1:1",
                    "client",
                    "rejected-new",
                    &store
                )
                .await
                .unwrap()
                .access_token,
            "manual-login"
        );
    }
    #[tokio::test]
    async fn stale_401_cannot_block_a_new_login() {
        let recovery = TokenRecovery::new();
        let store = MemoryStore::new();
        store.save("manual-login", "manual-refresh").unwrap();
        recovery.reject("client", "old", &store).await;
        assert!(recovery.state.lock().await.is_none());
    }
    #[tokio::test]
    async fn stale_validation_cannot_overwrite_status_of_new_login() {
        let recovery = TokenRecovery::new();
        let store = MemoryStore::new();
        store.save("new-login", "new-refresh").unwrap();
        assert!(
            !recovery
                .observe_current("old", Err(AuthError::RelinkRequired), &store)
                .await
        );
        assert!(recovery.observe_current("new-login", Ok(()), &store).await);
    }
}
