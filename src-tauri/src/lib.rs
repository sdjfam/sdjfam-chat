pub mod youtube_api {
    tonic::include_proto!("youtube.api.v3");
}

mod event_engine;

use event_engine::{EventType, Platform, SdjfamEvent};


use chrono::{DateTime, Duration, Utc};
use oauth2::basic::BasicClient;
use oauth2::reqwest;
use oauth2::{
    AuthUrl, AuthorizationCode, ClientId, ClientSecret, CsrfToken,
    PkceCodeChallenge, RedirectUrl, RefreshToken, Scope, TokenResponse,
    TokenUrl,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};
use tauri::path::BaseDirectory;
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::{sleep, Duration as TokioDuration};
use tonic::{Code, Request};
use url::Url;

use youtube_api::v3_data_live_chat_message_service_client::
    V3DataLiveChatMessageServiceClient;
use youtube_api::{
    LiveChatMessage,
    LiveChatMessageListRequest,
};

// =========================================================
// CONFIG
// =========================================================

const YOUTUBE_READONLY_SCOPE: &str =
    "https://www.googleapis.com/auth/youtube.readonly";

const YOUTUBE_BROADCASTS_URL: &str =
    "https://www.googleapis.com/youtube/v3/liveBroadcasts?part=id,snippet,status&mine=true";

const YOUTUBE_GRPC_ENDPOINT: &str =
    "https://youtube.googleapis.com";

const TEST_OAUTH_LIFETIME_DAYS: i64 = 7;
const RELINK_WARNING_HOURS: i64 = 24;

const YOUTUBE_CHAT_MESSAGE_EVENT: &str =
    "youtube-chat-message";

const YOUTUBE_CHAT_STATUS_EVENT: &str =
    "youtube-chat-status";

const YOUTUBE_CHAT_ERROR_EVENT: &str =
    "youtube-chat-error";

static YOUTUBE_CHAT_STREAM_RUNNING: AtomicBool =
    AtomicBool::new(false);

static YOUTUBE_CHAT_STREAM_STOP_REQUESTED: AtomicBool =
    AtomicBool::new(false);

// =========================================================
// TOKEN OPSLAG
// =========================================================

#[derive(Debug, Serialize, Deserialize)]
struct StoredYouTubeToken {
    refresh_token: String,
    linked_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
struct YouTubeAuthStatus {
    connected: bool,
    linked_at: Option<String>,
    expected_expiry_at: Option<String>,
    seconds_remaining: i64,
    needs_relogin: bool,
    expired: bool,
    message: String,
}

fn get_token_storage_path() -> Result<PathBuf, String> {
    let local_app_data =
        std::env::var("LOCALAPPDATA").map_err(|_| {
            "Windows LOCALAPPDATA kon niet worden gevonden"
                .to_string()
        })?;

    let app_dir =
        Path::new(&local_app_data)
            .join("SDJFAM Chat");

    fs::create_dir_all(&app_dir).map_err(|e| {
        format!(
            "SDJFAM Chat opslagmap kon niet worden gemaakt: {e}"
        )
    })?;

    Ok(app_dir.join("youtube-token.json"))
}

fn save_refresh_token(
    refresh_token: &str,
) -> Result<(), String> {
    let token_path =
        get_token_storage_path()?;

    let stored_token =
        StoredYouTubeToken {
            refresh_token:
                refresh_token.to_string(),
            linked_at:
                Utc::now(),
        };

    let json =
        serde_json::to_string_pretty(
            &stored_token,
        )
        .map_err(|e| {
            format!(
                "YouTube token kon niet worden voorbereid: {e}"
            )
        })?;

    fs::write(
        &token_path,
        json,
    )
    .map_err(|e| {
        format!(
            "YouTube token kon niet lokaal worden opgeslagen: {e}"
        )
    })?;

    Ok(())
}

fn load_stored_token()
    -> Result<Option<StoredYouTubeToken>, String>
{
    let token_path =
        get_token_storage_path()?;

    if !token_path.exists() {
        return Ok(None);
    }

    let contents =
        fs::read_to_string(
            &token_path,
        )
        .map_err(|e| {
            format!(
                "Opgeslagen YouTube-koppeling kon niet worden gelezen: {e}"
            )
        })?;

    let stored_token =
        serde_json::from_str::<StoredYouTubeToken>(
            &contents,
        )
        .map_err(|e| {
            format!(
                "Opgeslagen YouTube-koppeling is ongeldig: {e}"
            )
        })?;

    if stored_token
        .refresh_token
        .trim()
        .is_empty()
    {
        return Err(
            "Opgeslagen YouTube refresh token is leeg"
                .to_string(),
        );
    }

    Ok(Some(stored_token))
}

fn create_auth_status()
    -> Result<YouTubeAuthStatus, String>
{
    let stored_token =
        match load_stored_token()? {
            Some(token) => token,

            None => {
                return Ok(
                    YouTubeAuthStatus {
                        connected: false,
                        linked_at: None,
                        expected_expiry_at: None,
                        seconds_remaining: 0,
                        needs_relogin: false,
                        expired: false,
                        message:
                            "YouTube is nog niet gekoppeld"
                                .to_string(),
                    },
                );
            }
        };

    let expected_expiry =
        stored_token.linked_at
            + Duration::days(
                TEST_OAUTH_LIFETIME_DAYS,
            );

    let remaining =
        expected_expiry
            .signed_duration_since(
                Utc::now(),
            )
            .num_seconds();

    let expired =
        remaining <= 0;

    let warning_seconds =
        Duration::hours(
            RELINK_WARNING_HOURS,
        )
        .num_seconds();

    let needs_relogin =
        remaining <= warning_seconds;

    let safe_remaining =
        remaining.max(0);

    let message =
        if expired {
            "YouTube-koppeling opnieuw uitvoeren"
                .to_string()
        } else if needs_relogin {
            "YouTube-koppeling verloopt binnenkort"
                .to_string()
        } else {
            "YouTube-koppeling actief"
                .to_string()
        };

    Ok(
        YouTubeAuthStatus {
            connected: true,
            linked_at: Some(
                stored_token
                    .linked_at
                    .to_rfc3339(),
            ),
            expected_expiry_at: Some(
                expected_expiry
                    .to_rfc3339(),
            ),
            seconds_remaining:
                safe_remaining,
            needs_relogin,
            expired,
            message,
        },
    )
}

// =========================================================
// GOOGLE OAUTH TYPES
// =========================================================

#[derive(Debug, Deserialize)]
struct GoogleOAuthFile {
    installed: GoogleOAuthInstalled,
}

#[derive(Debug, Deserialize)]
struct GoogleOAuthInstalled {
    client_id: String,
    client_secret: String,
    auth_uri: String,
    token_uri: String,
}

// =========================================================
// YOUTUBE REST API TYPES
// =========================================================

#[derive(Debug, Deserialize)]
struct LiveBroadcastsResponse {
    items: Option<Vec<LiveBroadcast>>,
}

#[derive(Debug, Deserialize)]
struct LiveBroadcast {
    id: String,
    snippet: Option<LiveBroadcastSnippet>,
    status: Option<LiveBroadcastStatus>,
}

#[derive(Debug, Deserialize)]
struct LiveBroadcastSnippet {
    #[serde(rename = "liveChatId")]
    live_chat_id: Option<String>,
    title: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LiveBroadcastStatus {
    #[serde(rename = "lifeCycleStatus")]
    life_cycle_status: Option<String>,
}

// =========================================================
// RESULTATEN VOOR REACT
// =========================================================

#[derive(Debug, Serialize)]
struct YouTubeLoginResult {
    message: String,
    video_id: String,
    live_chat_id: String,
    title: String,
}

#[derive(Debug, Serialize)]
struct YouTubeAutoConnectResult {
    connected: bool,
    needs_relogin: bool,
    live: bool,
    discovery_available: bool,
    message: String,
    video_id: Option<String>,
    live_chat_id: Option<String>,
    title: Option<String>,
}

// =========================================================
// YOUTUBE CHAT EVENTS VOOR REACT
// =========================================================

#[derive(Debug, Clone, Serialize)]
struct YouTubeChatMessageEvent {
    id: String,
    author: String,
    message: String,
    published_at: Option<String>,
    message_type: i32,
    channel_id: Option<String>,
    is_verified: bool,
    is_chat_owner: bool,
    is_chat_sponsor: bool,
    is_chat_moderator: bool,
}

#[derive(Debug, Clone, Serialize)]
struct YouTubeChatStatusEvent {
    connected: bool,
    status: String,
    message: String,
}

// =========================================================
// OAUTH CONFIG LADEN
// =========================================================

fn get_oauth_file_path(
    app: &tauri::AppHandle,
) -> Result<PathBuf, String> {
    let oauth_path = app
        .path()
        .resolve(
            "../youtube-oauth.json",
            BaseDirectory::Resource,
        )
        .map_err(|e| {
            format!(
                "OAuth resource-pad kon niet worden bepaald: {e}"
            )
        })?;

    if !oauth_path.exists() {
        return Err(format!(
            "youtube-oauth.json niet gevonden op: {}",
            oauth_path.display()
        ));
    }

    Ok(oauth_path)
}

fn load_oauth_config(
    app: &tauri::AppHandle,
) -> Result<GoogleOAuthFile, String> {
    let oauth_path =
        get_oauth_file_path(app)?;

    let contents =
        fs::read_to_string(
            &oauth_path,
        )
        .map_err(|e| {
            format!(
                "OAuth-bestand kon niet worden gelezen: {e}"
            )
        })?;

    serde_json::from_str(
        &contents,
    )
    .map_err(|e| {
        format!(
            "OAuth-bestand heeft geen geldig formaat: {e}"
        )
    })
}

// =========================================================
// OAUTH CLIENT
// =========================================================

type GoogleOAuthClient =
    oauth2::Client<
        oauth2::StandardErrorResponse<
            oauth2::basic::BasicErrorResponseType,
        >,
        oauth2::StandardTokenResponse<
            oauth2::EmptyExtraTokenFields,
            oauth2::basic::BasicTokenType,
        >,
        oauth2::StandardTokenIntrospectionResponse<
            oauth2::EmptyExtraTokenFields,
            oauth2::basic::BasicTokenType,
        >,
        oauth2::StandardRevocableToken,
        oauth2::StandardErrorResponse<
            oauth2::RevocationErrorResponseType,
        >,
        oauth2::EndpointSet,
        oauth2::EndpointNotSet,
        oauth2::EndpointNotSet,
        oauth2::EndpointNotSet,
        oauth2::EndpointSet,
    >;

fn create_oauth_client(
    oauth_file: GoogleOAuthFile,
    redirect_url: String,
) -> Result<GoogleOAuthClient, String> {
    let auth_url =
        AuthUrl::new(
            oauth_file
                .installed
                .auth_uri,
        )
        .map_err(|e| {
            format!(
                "Ongeldige Google auth URL: {e}"
            )
        })?;

    let token_url =
        TokenUrl::new(
            oauth_file
                .installed
                .token_uri,
        )
        .map_err(|e| {
            format!(
                "Ongeldige Google token URL: {e}"
            )
        })?;

    let redirect_url =
        RedirectUrl::new(
            redirect_url,
        )
        .map_err(|e| {
            format!(
                "Ongeldige redirect URL: {e}"
            )
        })?;

    Ok(
        BasicClient::new(
            ClientId::new(
                oauth_file
                    .installed
                    .client_id,
            ),
        )
        .set_client_secret(
            ClientSecret::new(
                oauth_file
                    .installed
                    .client_secret,
            ),
        )
        .set_auth_uri(
            auth_url,
        )
        .set_token_uri(
            token_url,
        )
        .set_redirect_uri(
            redirect_url,
        ),
    )
}

// =========================================================
// HTTP CLIENT
// =========================================================

fn create_http_client()
    -> Result<reqwest::Client, String>
{
    reqwest::ClientBuilder::new()
        .redirect(
            reqwest::redirect::Policy::none(),
        )
        .build()
        .map_err(|e| {
            format!(
                "HTTP-client kon niet starten: {e}"
            )
        })
}

// =========================================================
// CALLBACK SERVER
// =========================================================

async fn start_callback_server()
    -> Result<(TcpListener, String), String>
{
    let listener =
        TcpListener::bind(
            "127.0.0.1:0",
        )
        .await
        .map_err(|e| {
            format!(
                "Lokale OAuth-server kon niet starten: {e}"
            )
        })?;

    let address =
        listener
            .local_addr()
            .map_err(|e| {
                format!(
                    "Lokale OAuth-poort kon niet worden gelezen: {e}"
                )
            })?;

    let redirect_url =
        format!(
            "http://127.0.0.1:{}",
            address.port()
        );

    Ok(
        (
            listener,
            redirect_url,
        ),
    )
}

// =========================================================
// GOOGLE CALLBACK UITLEZEN
// =========================================================

fn parse_callback_request(
    request_line: &str,
) -> Result<(String, String), String> {
    let request_target =
        request_line
            .split_whitespace()
            .nth(1)
            .ok_or(
                "Ongeldige OAuth callback",
            )?;

    let callback_url =
        Url::parse(
            &format!(
                "http://127.0.0.1{}",
                request_target
            ),
        )
        .map_err(|e| {
            format!(
                "OAuth callback URL is ongeldig: {e}"
            )
        })?;

    let mut code:
        Option<String> = None;

    let mut state:
        Option<String> = None;

    let mut oauth_error:
        Option<String> = None;

    for (key, value)
        in callback_url.query_pairs()
    {
        match key.as_ref() {
            "code" => {
                code =
                    Some(
                        value.into_owned(),
                    );
            }

            "state" => {
                state =
                    Some(
                        value.into_owned(),
                    );
            }

            "error" => {
                oauth_error =
                    Some(
                        value.into_owned(),
                    );
            }

            _ => {}
        }
    }

    if let Some(error) =
        oauth_error
    {
        return Err(
            format!(
                "Google OAuth fout: {error}"
            ),
        );
    }

    let code =
        code.ok_or(
            "Google heeft geen authorization code teruggegeven",
        )?;

    let state =
        state.ok_or(
            "OAuth state ontbreekt",
        )?;

    Ok(
        (
            code,
            state,
        ),
    )
}

// =========================================================
// BROWSER PAGINA
// =========================================================

async fn send_browser_page(
    stream: &mut TcpStream,
    success: bool,
) -> Result<(), String> {
    let message =
        if success {
            "YouTube is gekoppeld."
        } else {
            "De YouTube-login is mislukt."
        };

    let html =
        format!(
            r#"<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>SDJFAM Chat</title>
</head>
<body style="
    background:#090b10;
    color:white;
    font-family:Arial;
    text-align:center;
    padding-top:80px;
">
<h2>SDJFAM Chat</h2>
<p>{}</p>
<p>Je kunt dit venster sluiten en teruggaan naar SDJFAM Chat.</p>
</body>
</html>"#,
            message
        );

    let response =
        format!(
            "HTTP/1.1 200 OK\r\n\
Content-Type: text/html; charset=utf-8\r\n\
Content-Length: {}\r\n\
Connection: close\r\n\
\r\n\
{}",
            html.len(),
            html
        );

    stream
        .write_all(
            response.as_bytes(),
        )
        .await
        .map_err(|e| {
            format!(
                "OAuth browserantwoord kon niet worden verzonden: {e}"
            )
        })
}

// =========================================================
// AUTHORIZATION CODE OMZETTEN
// =========================================================

async fn exchange_code_for_token(
    client: &GoogleOAuthClient,
    code: String,
    pkce_verifier:
        oauth2::PkceCodeVerifier,
    http_client:
        &reqwest::Client,
) -> Result<(String, String), String> {
    let token_result =
        client
            .exchange_code(
                AuthorizationCode::new(
                    code,
                ),
            )
            .set_pkce_verifier(
                pkce_verifier,
            )
            .request_async(
                http_client,
            )
            .await
            .map_err(|e| {
                format!(
                    "Google token aanvraag mislukt: {e}"
                )
            })?;

    let access_token =
        token_result
            .access_token()
            .secret()
            .to_string();

    if access_token.is_empty() {
        return Err(
            "Google gaf geen access token terug"
                .to_string(),
        );
    }

    let refresh_token =
        token_result
            .refresh_token()
            .ok_or_else(|| {
                "Google gaf geen refresh token terug"
                    .to_string()
            })?
            .secret()
            .to_string();

    if refresh_token.is_empty() {
        return Err(
            "Google gaf een lege refresh token terug"
                .to_string(),
        );
    }

    Ok(
        (
            access_token,
            refresh_token,
        ),
    )
}

// =========================================================
// ACCESS TOKEN VERNIEUWEN
// =========================================================

async fn refresh_access_token(
    client: &GoogleOAuthClient,
    stored_refresh_token: &str,
    http_client:
        &reqwest::Client,
) -> Result<String, String> {
    let refresh_token =
        RefreshToken::new(
            stored_refresh_token
                .to_string(),
        );

    let token_result =
        client
            .exchange_refresh_token(
                &refresh_token,
            )
            .request_async(
                http_client,
            )
            .await
            .map_err(|e| {
                format!(
                    "Google access token vernieuwen mislukt: {e}"
                )
            })?;

    let access_token =
        token_result
            .access_token()
            .secret()
            .to_string();

    if access_token.is_empty() {
        return Err(
            "Google gaf geen nieuwe access token terug"
                .to_string(),
        );
    }

    Ok(access_token)
}

// =========================================================
// YOUTUBE BROADCASTS
// =========================================================

async fn fetch_youtube_broadcasts(
    http_client:
        &reqwest::Client,
    access_token: &str,
) -> Result<LiveBroadcastsResponse, String> {
    let response =
        http_client
            .get(
                YOUTUBE_BROADCASTS_URL,
            )
            .bearer_auth(
                access_token,
            )
            .send()
            .await
            .map_err(|e| {
                format!(
                    "YouTube broadcast-opvraag mislukt: {e}"
                )
            })?;

    let status =
        response.status();

    let response_text =
        response
            .text()
            .await
            .map_err(|e| {
                format!(
                    "YouTube broadcast-resultaat kon niet worden gelezen: {e}"
                )
            })?;

    if !status.is_success() {
        return Err(
            format!(
                "YouTube liveBroadcasts API fout {}: {}",
                status,
                response_text
            ),
        );
    }

    serde_json::from_str(
        &response_text,
    )
    .map_err(|e| {
        format!(
            "YouTube broadcast-JSON is ongeldig: {e}"
        )
    })
}

// =========================================================
// QUOTA FOUT HERKENNEN
// =========================================================

fn is_youtube_quota_error(
    error: &str,
) -> bool {
    let lower =
        error.to_lowercase();

    lower.contains(
        "quotaexceeded",
    )
        || lower.contains(
            "youtube.quota",
        )
        || lower.contains(
            "exceeded your",
        )
        || lower.contains(
            "quota is reached",
        )
}

// =========================================================
// ACTIEVE BROADCAST KIEZEN
// =========================================================

fn find_active_broadcast(
    broadcasts:
        LiveBroadcastsResponse,
) -> Result<LiveBroadcast, String> {
    let items =
        broadcasts
            .items
            .unwrap_or_default();

    items
        .into_iter()
        .find(|broadcast| {
            broadcast
                .status
                .as_ref()
                .and_then(|status| {
                    status
                        .life_cycle_status
                        .as_deref()
                })
                == Some("live")
        })
        .ok_or_else(|| {
            "Geen actieve YouTube-broadcast gevonden"
                .to_string()
        })
}

// =========================================================
// LOGIN RESULTAAT
// =========================================================

fn create_login_result(
    broadcast: LiveBroadcast,
) -> Result<YouTubeLoginResult, String> {
    let video_id =
        broadcast.id;

    let snippet =
        broadcast
            .snippet
            .ok_or(
                "Actieve broadcast heeft geen snippet",
            )?;

    let live_chat_id =
        snippet
            .live_chat_id
            .ok_or(
                "Actieve broadcast heeft geen liveChatId",
            )?;

    let title =
        snippet
            .title
            .unwrap_or_else(|| {
                "YouTube Live"
                    .to_string()
            });

    Ok(
        YouTubeLoginResult {
            message:
                "YouTube OAuth login gelukt"
                    .to_string(),
            video_id,
            live_chat_id,
            title,
        },
    )
}

// =========================================================
// AUTO-CONNECT RESULTAAT
// =========================================================

fn create_auto_connect_live_result(
    broadcast: LiveBroadcast,
) -> Result<YouTubeAutoConnectResult, String> {
    let video_id =
        broadcast.id;

    let snippet =
        broadcast
            .snippet
            .ok_or(
                "Actieve broadcast heeft geen snippet",
            )?;

    let live_chat_id =
        snippet
            .live_chat_id
            .ok_or(
                "Actieve broadcast heeft geen liveChatId",
            )?;

    let title =
        snippet
            .title
            .unwrap_or_else(|| {
                "YouTube Live"
                    .to_string()
            });

    Ok(
        YouTubeAutoConnectResult {
            connected: true,
            needs_relogin: false,
            live: true,
            discovery_available: true,
            message:
                "YouTube automatisch gekoppeld"
                    .to_string(),
            video_id:
                Some(video_id),
            live_chat_id:
                Some(live_chat_id),
            title:
                Some(title),
        },
    )
}

// =========================================================
// CHAT MESSAGE OMZETTEN NAAR REACT EVENT
// =========================================================

fn create_chat_message_event(
    item: LiveChatMessage,
) -> Option<YouTubeChatMessageEvent> {
    let snippet =
        item.snippet?;

    if snippet.has_display_content
        == Some(false)
    {
        return None;
    }

    let message =
        snippet
            .display_message?
            .trim()
            .to_string();

    if message.is_empty() {
        return None;
    }

    let author_details =
        item.author_details;

    let author =
        author_details
            .as_ref()
            .and_then(|details| {
                details
                    .display_name
                    .clone()
            })
            .filter(|name| {
                !name.trim().is_empty()
            })
            .unwrap_or_else(|| {
                "YouTube"
                    .to_string()
            });

    let channel_id =
        author_details
            .as_ref()
            .and_then(|details| {
                details
                    .channel_id
                    .clone()
            });

    let is_verified =
        author_details
            .as_ref()
            .and_then(|details| {
                details.is_verified
            })
            .unwrap_or(false);

    let is_chat_owner =
        author_details
            .as_ref()
            .and_then(|details| {
                details.is_chat_owner
            })
            .unwrap_or(false);

    let is_chat_sponsor =
        author_details
            .as_ref()
            .and_then(|details| {
                details.is_chat_sponsor
            })
            .unwrap_or(false);

    let is_chat_moderator =
        author_details
            .as_ref()
            .and_then(|details| {
                details
                    .is_chat_moderator
            })
            .unwrap_or(false);

    Some(
        YouTubeChatMessageEvent {
            id:
                item.id
                    .unwrap_or_else(|| {
                        format!(
                            "youtube-{}",
                            Utc::now()
                                .timestamp_nanos_opt()
                                .unwrap_or_default()
                        )
                    }),
            author,
            message,
            published_at:
                snippet.published_at,
            message_type:
                snippet
                    .r#type
                    .unwrap_or_default(),
            channel_id,
            is_verified,
            is_chat_owner,
            is_chat_sponsor,
            is_chat_moderator,
        },
    )
}

// =========================================================
// YOUTUBE GRPC STREAM
// =========================================================

async fn run_youtube_chat_stream(
    app: tauri::AppHandle,
    live_chat_id: String,
) -> Result<(), String> {
    let stored_token =
        load_stored_token()?
            .ok_or_else(|| {
                "YouTube is nog niet gekoppeld"
                    .to_string()
            })?;

    let oauth_file =
        load_oauth_config(&app)?;

    let oauth_client =
        create_oauth_client(
            oauth_file,
            "http://127.0.0.1"
                .to_string(),
        )?;

    let http_client =
        create_http_client()?;

    let mut next_page_token:
        Option<String> = None;

    let mut discard_initial_history =
        true;

    loop {
        if YOUTUBE_CHAT_STREAM_STOP_REQUESTED
            .load(Ordering::SeqCst)
        {
            let _ =
                app.emit(
                    YOUTUBE_CHAT_STATUS_EVENT,
                    YouTubeChatStatusEvent {
                        connected: false,
                        status:
                            "stopped"
                                .to_string(),
                        message:
                            "YouTube chatstream gestopt"
                                .to_string(),
                    },
                );

            return Ok(());
        }

        let access_token =
            refresh_access_token(
                &oauth_client,
                &stored_token.refresh_token,
                &http_client,
            )
            .await?;

        let mut grpc_client =
            V3DataLiveChatMessageServiceClient::connect(
                YOUTUBE_GRPC_ENDPOINT,
            )
            .await
            .map_err(|e| {
                format!(
                    "YouTube gRPC verbinding mislukt: {e}"
                )
            })?;

        let request_data =
            LiveChatMessageListRequest {
                live_chat_id:
                    Some(
                        live_chat_id
                            .clone(),
                    ),
                hl: None,
                profile_image_size: None,
                max_results: None,
                page_token:
                    next_page_token
                        .clone(),
                part: vec![
                    "id".to_string(),
                    "snippet".to_string(),
                    "authorDetails".to_string(),
                ],
            };

        let mut request =
            Request::new(
                request_data,
            );

        let authorization =
            format!(
                "Bearer {access_token}"
            )
            .parse()
            .map_err(|e| {
                format!(
                    "Google authorization metadata is ongeldig: {e}"
                )
            })?;

        request
            .metadata_mut()
            .insert(
                "authorization",
                authorization,
            );

        let response =
            grpc_client
                .stream_list(
                    request,
                )
                .await
                .map_err(|status| {
                    format!(
                        "YouTube streamList kon niet starten ({:?}): {}",
                        status.code(),
                        status.message()
                    )
                })?;

        let mut stream =
            response.into_inner();

        let _ =
            app.emit(
                YOUTUBE_CHAT_STATUS_EVENT,
                YouTubeChatStatusEvent {
                    connected: true,
                    status:
                        "connected"
                            .to_string(),
                    message:
                        "YouTube live chat verbonden via streamList"
                            .to_string(),
                },
            );

        loop {
            if YOUTUBE_CHAT_STREAM_STOP_REQUESTED
                .load(Ordering::SeqCst)
            {
                let _ =
                    app.emit(
                        YOUTUBE_CHAT_STATUS_EVENT,
                        YouTubeChatStatusEvent {
                            connected: false,
                            status:
                                "stopped"
                                    .to_string(),
                            message:
                                "YouTube chatstream gestopt"
                                    .to_string(),
                        },
                    );

                return Ok(());
            }

            match stream
                .message()
                .await
            {
                Ok(Some(response)) => {
                    if let Some(token) =
                        response
                            .next_page_token
                            .clone()
                    {
                        next_page_token =
                            Some(token);
                    }

                    if response
                        .offline_at
                        .is_some()
                    {
                        let _ =
                            app.emit(
                                YOUTUBE_CHAT_STATUS_EVENT,
                                YouTubeChatStatusEvent {
                                    connected: false,
                                    status:
                                        "offline"
                                            .to_string(),
                                    message:
                                        "YouTube livestream is offline"
                                            .to_string(),
                                },
                            );

                        return Ok(());
                    }

                    if discard_initial_history {
                        discard_initial_history =
                            false;

                        continue;
                    }

                    for item in response.items {
                        if let Some(chat_message) =
                            create_chat_message_event(
                                item,
                            )
                        {
                            let _ =
                                app.emit(
                                    YOUTUBE_CHAT_MESSAGE_EVENT,
                                    chat_message,
                                );
                        }
                    }
                }

                Ok(None) => {
                    let _ =
                        app.emit(
                            YOUTUBE_CHAT_STATUS_EVENT,
                            YouTubeChatStatusEvent {
                                connected: false,
                                status:
                                    "reconnecting"
                                        .to_string(),
                                message:
                                    "YouTube chatstream verbroken, opnieuw verbinden..."
                                        .to_string(),
                            },
                        );

                    break;
                }

                Err(status) => {
                    match status.code() {
                        Code::PermissionDenied
                        | Code::Unauthenticated
                        | Code::InvalidArgument
                        | Code::NotFound
                        | Code::ResourceExhausted => {
                            return Err(
                                format!(
                                    "YouTube streamList fout ({:?}): {}",
                                    status.code(),
                                    status.message()
                                ),
                            );
                        }

                        _ => {
                            let _ =
                                app.emit(
                                    YOUTUBE_CHAT_STATUS_EVENT,
                                    YouTubeChatStatusEvent {
                                        connected: false,
                                        status:
                                            "reconnecting"
                                                .to_string(),
                                        message:
                                            format!(
                                                "YouTube chatstream tijdelijk verbroken ({:?}), opnieuw verbinden...",
                                                status.code()
                                            ),
                                    },
                                );

                            break;
                        }
                    }
                }
            }
        }

        if YOUTUBE_CHAT_STREAM_STOP_REQUESTED
            .load(Ordering::SeqCst)
        {
            return Ok(());
        }

        sleep(
            TokioDuration::from_secs(3),
        )
        .await;
    }
}

// =========================================================
// TAURI COMMAND: OAUTH STATUS
// =========================================================

#[tauri::command]
fn youtube_auth_status()
    -> Result<YouTubeAuthStatus, String>
{
    create_auth_status()
}

// =========================================================
// TAURI COMMAND: AUTO-CONNECT
// =========================================================

#[tauri::command]
async fn youtube_auto_connect(
    app: tauri::AppHandle,
)
    -> Result<YouTubeAutoConnectResult, String>
{
    let stored_token =
        match load_stored_token()? {
            Some(token) => token,

            None => {
                return Ok(
                    YouTubeAutoConnectResult {
                        connected: false,
                        needs_relogin: false,
                        live: false,
                        discovery_available: true,
                        message:
                            "YouTube is nog niet gekoppeld"
                                .to_string(),
                        video_id: None,
                        live_chat_id: None,
                        title: None,
                    },
                );
            }
        };

    let oauth_file =
        load_oauth_config(&app)?;

    let client =
        create_oauth_client(
            oauth_file,
            "http://127.0.0.1"
                .to_string(),
        )?;

    let http_client =
        create_http_client()?;

    let access_token =
        match refresh_access_token(
            &client,
            &stored_token.refresh_token,
            &http_client,
        )
        .await
        {
            Ok(token) => token,

            Err(error) => {
                eprintln!(
                    "YouTube access token vernieuwen mislukt: {}",
                    error
                );

                return Ok(
                    YouTubeAutoConnectResult {
                        connected: false,
                        needs_relogin: true,
                        live: false,
                        discovery_available: true,
                        message:
                            "Google-koppeling moet opnieuw worden uitgevoerd"
                                .to_string(),
                        video_id: None,
                        live_chat_id: None,
                        title: None,
                    },
                );
            }
        };

    let broadcasts =
        match fetch_youtube_broadcasts(
            &http_client,
            &access_token,
        )
        .await
        {
            Ok(broadcasts) => {
                broadcasts
            }

            Err(error) => {
                eprintln!(
                    "YouTube livestream-detectie fout: {}",
                    error
                );

                let message =
                    if is_youtube_quota_error(
                        &error,
                    ) {
                        "YouTube is gekoppeld, maar de dagelijkse API-quota is bereikt. Livestream-detectie is tijdelijk niet beschikbaar."
                            .to_string()
                    } else {
                        "YouTube is gekoppeld, maar livestream-detectie is tijdelijk niet beschikbaar."
                            .to_string()
                    };

                return Ok(
                    YouTubeAutoConnectResult {
                        connected: true,
                        needs_relogin: false,
                        live: false,
                        discovery_available: false,
                        message,
                        video_id: None,
                        live_chat_id: None,
                        title: None,
                    },
                );
            }
        };

    let active_broadcast =
        match find_active_broadcast(
            broadcasts,
        ) {
            Ok(broadcast) => {
                broadcast
            }

            Err(_) => {
                return Ok(
                    YouTubeAutoConnectResult {
                        connected: true,
                        needs_relogin: false,
                        live: false,
                        discovery_available: true,
                        message:
                            "YouTube gekoppeld, maar er is geen actieve livestream"
                                .to_string(),
                        video_id: None,
                        live_chat_id: None,
                        title: None,
                    },
                );
            }
        };

    create_auto_connect_live_result(
        active_broadcast,
    )
}

// =========================================================
// TAURI COMMAND: START GRPC CHAT STREAM
// =========================================================

#[tauri::command]
async fn youtube_start_chat_stream(
    app: tauri::AppHandle,
    live_chat_id: String,
) -> Result<String, String> {
    let live_chat_id =
        live_chat_id
            .trim()
            .to_string();

    if live_chat_id.is_empty() {
        return Err(
            "YouTube liveChatId ontbreekt"
                .to_string(),
        );
    }

    if YOUTUBE_CHAT_STREAM_RUNNING
        .swap(
            true,
            Ordering::SeqCst,
        )
    {
        return Ok(
            "YouTube chatstream draait al"
                .to_string(),
        );
    }

    YOUTUBE_CHAT_STREAM_STOP_REQUESTED
        .store(
            false,
            Ordering::SeqCst,
        );

    let stream_app =
        app.clone();

    tokio::spawn(
        async move {
            let result =
                run_youtube_chat_stream(
                    stream_app.clone(),
                    live_chat_id,
                )
                .await;

            if let Err(error) =
                result
            {
                let _ =
                    stream_app.emit(
                        YOUTUBE_CHAT_ERROR_EVENT,
                        error.clone(),
                    );

                let _ =
                    stream_app.emit(
                        YOUTUBE_CHAT_STATUS_EVENT,
                        YouTubeChatStatusEvent {
                            connected: false,
                            status:
                                "error"
                                    .to_string(),
                            message:
                                error,
                        },
                    );
            }

            YOUTUBE_CHAT_STREAM_RUNNING
                .store(
                    false,
                    Ordering::SeqCst,
                );
        },
    );

    Ok(
        "YouTube chatstream wordt gestart"
            .to_string(),
    )
}

// =========================================================
// TAURI COMMAND: STOP GRPC CHAT STREAM
// =========================================================

#[tauri::command]
fn youtube_stop_chat_stream()
    -> Result<String, String>
{
    if !YOUTUBE_CHAT_STREAM_RUNNING
        .load(Ordering::SeqCst)
    {
        return Ok(
            "YouTube chatstream draait niet"
                .to_string(),
        );
    }

    YOUTUBE_CHAT_STREAM_STOP_REQUESTED
        .store(
            true,
            Ordering::SeqCst,
        );

    Ok(
        "YouTube chatstream wordt gestopt"
            .to_string(),
    )
}

// =========================================================
// TAURI COMMAND: HANDMATIGE YOUTUBE LOGIN
// =========================================================

#[tauri::command]
async fn youtube_login(
    app: tauri::AppHandle,
) -> Result<YouTubeLoginResult, String> {
    let oauth_file =
        load_oauth_config(&app)?;

    let (
        listener,
        redirect_url,
    ) =
        start_callback_server()
            .await?;

    let client =
        create_oauth_client(
            oauth_file,
            redirect_url,
        )?;

    let (
        pkce_challenge,
        pkce_verifier,
    ) =
        PkceCodeChallenge::
            new_random_sha256();

    let (
        authorize_url,
        csrf_state,
    ) =
        client
            .authorize_url(
                CsrfToken::new_random,
            )
            .add_scope(
                Scope::new(
                    YOUTUBE_READONLY_SCOPE
                        .to_string(),
                ),
            )
            .add_extra_param(
                "access_type",
                "offline",
            )
            .add_extra_param(
                "prompt",
                "consent",
            )
            .set_pkce_challenge(
                pkce_challenge,
            )
            .url();

    app.opener()
        .open_url(
            authorize_url.as_str(),
            None::<&str>,
        )
        .map_err(|e| {
            format!(
                "Browser kon niet worden geopend: {e}"
            )
        })?;

    let (
        mut stream,
        _,
    ) =
        listener
            .accept()
            .await
            .map_err(|e| {
                format!(
                    "OAuth callback mislukt: {e}"
                )
            })?;

    let mut reader =
        BufReader::new(
            &mut stream,
        );

    let mut request_line =
        String::new();

    reader
        .read_line(
            &mut request_line,
        )
        .await
        .map_err(|e| {
            format!(
                "OAuth callback kon niet worden gelezen: {e}"
            )
        })?;

    let (
        code,
        returned_state,
    ) =
        parse_callback_request(
            &request_line,
        )?;

    if returned_state
        != *csrf_state.secret()
    {
        send_browser_page(
            reader.get_mut(),
            false,
        )
        .await?;

        return Err(
            "OAuth beveiligingscontrole mislukt (state mismatch)"
                .to_string(),
        );
    }

    let http_client =
        create_http_client()?;

    let (
        access_token,
        refresh_token,
    ) =
        exchange_code_for_token(
            &client,
            code,
            pkce_verifier,
            &http_client,
        )
        .await?;

    save_refresh_token(
        &refresh_token,
    )?;

    let broadcasts =
        fetch_youtube_broadcasts(
            &http_client,
            &access_token,
        )
        .await?;

    let active_broadcast =
        find_active_broadcast(
            broadcasts,
        )?;

    let result =
        create_login_result(
            active_broadcast,
        )?;

    send_browser_page(
        reader.get_mut(),
        true,
    )
    .await?;

    Ok(result)
}

// =========================================================
// TAURI START
// =========================================================


// =========================================================

// =========================================================
// SDJFAM V0.1.2 YOUTUBE VIEWERS
// =========================================================

const YOUTUBE_VIDEOS_URL: &str =
    "https://www.googleapis.com/youtube/v3/videos";

#[derive(Debug, Serialize)]
struct YouTubeViewerResult {
    connected: bool,
    live: bool,
    viewer_count: Option<u64>,
    message: String,
}

#[derive(Debug, Deserialize)]
struct YouTubeVideosResponse {
    items: Option<Vec<YouTubeVideo>>,
}

#[derive(Debug, Deserialize)]
struct YouTubeVideo {
    #[serde(rename = "liveStreamingDetails")]
    live_streaming_details: Option<YouTubeLiveStreamingDetails>,
}

#[derive(Debug, Deserialize)]
struct YouTubeLiveStreamingDetails {
    #[serde(rename = "concurrentViewers")]
    concurrent_viewers: Option<String>,

    #[serde(rename = "actualEndTime")]
    actual_end_time: Option<String>,
}

async fn fetch_youtube_viewer_count(
    http_client: &reqwest::Client,
    access_token: &str,
    video_id: &str,
) -> Result<YouTubeViewerResult, String> {
    let response =
        http_client
            .get(YOUTUBE_VIDEOS_URL)
            .query(&[
                (
                    "part",
                    "liveStreamingDetails",
                ),
                (
                    "id",
                    video_id,
                ),
            ])
            .bearer_auth(
                access_token,
            )
            .send()
            .await
            .map_err(|e| {
                format!(
                    "YouTube viewer-opvraag mislukt: {e}"
                )
            })?;

    let status =
        response.status();

    let body =
        response
            .text()
            .await
            .map_err(|e| {
                format!(
                    "YouTube viewer-resultaat kon niet worden gelezen: {e}"
                )
            })?;

    if !status.is_success() {
        return Err(
            format!(
                "YouTube videos API fout {}: {}",
                status,
                body
            ),
        );
    }

    let videos =
        serde_json::from_str::<YouTubeVideosResponse>(
            &body,
        )
        .map_err(|e| {
            format!(
                "YouTube videos-JSON is ongeldig: {e}"
            )
        })?;

    let video =
        match videos
            .items
            .unwrap_or_default()
            .into_iter()
            .next()
        {
            Some(video) => video,

            None => {
                return Ok(
                    YouTubeViewerResult {
                        connected: true,
                        live: false,
                        viewer_count: None,
                        message:
                            "YouTube livestream niet gevonden"
                                .to_string(),
                    },
                );
            }
        };

    let details =
        match video.live_streaming_details {
            Some(details) => details,

            None => {
                return Ok(
                    YouTubeViewerResult {
                        connected: true,
                        live: false,
                        viewer_count: None,
                        message:
                            "YouTube video heeft geen live streaming gegevens"
                                .to_string(),
                    },
                );
            }
        };

    if details.actual_end_time.is_some() {
        return Ok(
            YouTubeViewerResult {
                connected: true,
                live: false,
                viewer_count: None,
                message:
                    "YouTube livestream is afgelopen"
                        .to_string(),
            },
        );
    }

    let viewer_count =
        details
            .concurrent_viewers
            .as_deref()
            .and_then(|value| {
                value.parse::<u64>().ok()
            });

    Ok(
        YouTubeViewerResult {
            connected: true,
            live: true,
            viewer_count,
            message:
                if viewer_count.is_some() {
                    "YouTube livestream is live"
                        .to_string()
                } else {
                    "YouTube livestream is live, maar het kijkersaantal is niet beschikbaar"
                        .to_string()
                },
        },
    )
}

// =========================================================
// TAURI COMMAND: YOUTUBE VIEWER COUNT
// =========================================================

#[tauri::command]
async fn youtube_viewer_count(
    app: tauri::AppHandle,
    video_id: String,
) -> Result<YouTubeViewerResult, String> {
    let video_id =
        video_id
            .trim()
            .to_string();

    if video_id.is_empty() {
        return Ok(
            YouTubeViewerResult {
                connected: false,
                live: false,
                viewer_count: None,
                message:
                    "Er is geen actieve YouTube livestream"
                        .to_string(),
            },
        );
    }

    let stored_token =
        match load_stored_token()? {
            Some(token) => token,

            None => {
                return Ok(
                    YouTubeViewerResult {
                        connected: false,
                        live: false,
                        viewer_count: None,
                        message:
                            "YouTube is nog niet gekoppeld"
                                .to_string(),
                    },
                );
            }
        };

    let oauth_file =
        load_oauth_config(&app)?;

    let client =
        create_oauth_client(
            oauth_file,
            "http://127.0.0.1"
                .to_string(),
        )?;

    let http_client =
        create_http_client()?;

    let access_token =
        refresh_access_token(
            &client,
            &stored_token.refresh_token,
            &http_client,
        )
        .await?;

    fetch_youtube_viewer_count(
        &http_client,
        &access_token,
        &video_id,
    )
    .await
}


// // SDJFAM V0.1.2 TWITCH VIEWERS
// =========================================================

const TWITCH_DEVICE_URL: &str =
    "https://id.twitch.tv/oauth2/device";

const TWITCH_TOKEN_URL: &str =
    "https://id.twitch.tv/oauth2/token";

const TWITCH_STREAMS_URL: &str =
    "https://api.twitch.tv/helix/streams";

const TWITCH_PUBLIC_REFRESH_TOKEN_DAYS: i64 = 30;
const TWITCH_RELINK_WARNING_HOURS: i64 = 24;

// =========================================================
// TWITCH TOKEN OPSLAG
// =========================================================

#[derive(Debug, Serialize, Deserialize)]
struct StoredTwitchToken {
    access_token: String,
    refresh_token: String,
    linked_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
struct TwitchAuthStatus {
    connected: bool,
    linked_at: Option<String>,
    expected_expiry_at: Option<String>,
    seconds_remaining: i64,
    needs_relogin: bool,
    expired: bool,
    message: String,
}

#[derive(Debug, Serialize)]
struct TwitchLoginResult {
    connected: bool,
    message: String,
}

#[derive(Debug, Serialize)]
struct TwitchViewerResult {
    connected: bool,
    live: bool,
    viewer_count: Option<u64>,
    message: String,
}

#[derive(Debug, Deserialize)]
struct TwitchDeviceResponse {
    device_code: String,
    expires_in: u64,
    interval: u64,
    user_code: String,
    verification_uri: String,
}

#[derive(Debug, Deserialize)]
struct TwitchTokenResponse {
    access_token: String,
    refresh_token: String,
}

#[derive(Debug, Deserialize)]
struct TwitchStreamsResponse {
    data: Vec<TwitchStream>,
}

#[derive(Debug, Deserialize)]
struct TwitchStream {
    viewer_count: u64,
}

fn get_twitch_token_storage_path() -> Result<PathBuf, String> {
    let local_app_data =
        std::env::var("LOCALAPPDATA").map_err(|_| {
            "Windows LOCALAPPDATA kon niet worden gevonden"
                .to_string()
        })?;

    let app_dir =
        Path::new(&local_app_data)
            .join("SDJFAM Chat");

    fs::create_dir_all(&app_dir).map_err(|e| {
        format!(
            "SDJFAM Chat opslagmap kon niet worden gemaakt: {e}"
        )
    })?;

    Ok(app_dir.join("twitch-token.json"))
}

fn save_twitch_token(
    access_token: &str,
    refresh_token: &str,
) -> Result<(), String> {
    if access_token.trim().is_empty() {
        return Err(
            "Twitch access token is leeg".to_string(),
        );
    }

    if refresh_token.trim().is_empty() {
        return Err(
            "Twitch refresh token is leeg".to_string(),
        );
    }

    let token_path =
        get_twitch_token_storage_path()?;

    let stored_token =
        StoredTwitchToken {
            access_token:
                access_token.to_string(),
            refresh_token:
                refresh_token.to_string(),
            linked_at:
                Utc::now(),
        };

    let json =
        serde_json::to_string_pretty(
            &stored_token,
        )
        .map_err(|e| {
            format!(
                "Twitch token kon niet worden voorbereid: {e}"
            )
        })?;

    fs::write(
        token_path,
        json,
    )
    .map_err(|e| {
        format!(
            "Twitch token kon niet lokaal worden opgeslagen: {e}"
        )
    })?;

    Ok(())
}

fn load_stored_twitch_token()
    -> Result<Option<StoredTwitchToken>, String>
{
    let token_path =
        get_twitch_token_storage_path()?;

    if !token_path.exists() {
        return Ok(None);
    }

    let contents =
        fs::read_to_string(
            token_path,
        )
        .map_err(|e| {
            format!(
                "Opgeslagen Twitch-koppeling kon niet worden gelezen: {e}"
            )
        })?;

    let stored_token =
        serde_json::from_str::<StoredTwitchToken>(
            &contents,
        )
        .map_err(|e| {
            format!(
                "Opgeslagen Twitch-koppeling is ongeldig: {e}"
            )
        })?;

    if stored_token
        .access_token
        .trim()
        .is_empty()
    {
        return Err(
            "Opgeslagen Twitch access token is leeg"
                .to_string(),
        );
    }

    if stored_token
        .refresh_token
        .trim()
        .is_empty()
    {
        return Err(
            "Opgeslagen Twitch refresh token is leeg"
                .to_string(),
        );
    }

    Ok(Some(stored_token))
}

fn create_twitch_auth_status()
    -> Result<TwitchAuthStatus, String>
{
    let stored_token =
        match load_stored_twitch_token()? {
            Some(token) => token,

            None => {
                return Ok(
                    TwitchAuthStatus {
                        connected: false,
                        linked_at: None,
                        expected_expiry_at: None,
                        seconds_remaining: 0,
                        needs_relogin: false,
                        expired: false,
                        message:
                            "Twitch API is nog niet gekoppeld"
                                .to_string(),
                    },
                );
            }
        };

    let expected_expiry =
        stored_token.linked_at
            + Duration::days(
                TWITCH_PUBLIC_REFRESH_TOKEN_DAYS,
            );

    let remaining =
        expected_expiry
            .signed_duration_since(
                Utc::now(),
            )
            .num_seconds();

    let expired =
        remaining <= 0;

    let warning_seconds =
        Duration::hours(
            TWITCH_RELINK_WARNING_HOURS,
        )
        .num_seconds();

    let needs_relogin =
        remaining <= warning_seconds;

    let message =
        if expired {
            "Twitch-koppeling opnieuw uitvoeren"
                .to_string()
        } else if needs_relogin {
            "Twitch-koppeling verloopt binnenkort"
                .to_string()
        } else {
            "Twitch API-koppeling actief"
                .to_string()
        };

    Ok(
        TwitchAuthStatus {
            connected: !expired,
            linked_at: Some(
                stored_token
                    .linked_at
                    .to_rfc3339(),
            ),
            expected_expiry_at: Some(
                expected_expiry
                    .to_rfc3339(),
            ),
            seconds_remaining:
                remaining.max(0),
            needs_relogin,
            expired,
            message,
        },
    )
}

// =========================================================
// TWITCH DEVICE LOGIN
// =========================================================

async fn request_twitch_device_code(
    http_client: &reqwest::Client,
    client_id: &str,
) -> Result<TwitchDeviceResponse, String> {
    let response =
        http_client
            .post(TWITCH_DEVICE_URL)
            .form(&[
                ("client_id", client_id),
                ("scopes", ""),
            ])
            .send()
            .await
            .map_err(|e| {
                format!(
                    "Twitch device-login kon niet starten: {e}"
                )
            })?;

    let status =
        response.status();

    let body =
        response
            .text()
            .await
            .map_err(|e| {
                format!(
                    "Twitch device-login antwoord kon niet worden gelezen: {e}"
                )
            })?;

    if !status.is_success() {
        return Err(
            format!(
                "Twitch device-login fout {}: {}",
                status,
                body
            ),
        );
    }

    serde_json::from_str::<TwitchDeviceResponse>(
        &body,
    )
    .map_err(|e| {
        format!(
            "Twitch device-login JSON is ongeldig: {e}"
        )
    })
}

async fn poll_twitch_device_token(
    http_client: &reqwest::Client,
    client_id: &str,
    device: &TwitchDeviceResponse,
) -> Result<TwitchTokenResponse, String> {
    let started_at =
        std::time::Instant::now();

    let expires_after =
        std::time::Duration::from_secs(
            device.expires_in,
        );

    let poll_interval =
        device.interval.max(1);

    loop {
        if started_at.elapsed() >= expires_after {
            return Err(
                "Twitch login is verlopen. Probeer opnieuw."
                    .to_string(),
            );
        }

        let response =
            http_client
                .post(TWITCH_TOKEN_URL)
                .form(&[
                    ("client_id", client_id),
                    (
                        "scopes",
                        "",
                    ),
                    (
                        "device_code",
                        device.device_code.as_str(),
                    ),
                    (
                        "grant_type",
                        "urn:ietf:params:oauth:grant-type:device_code",
                    ),
                ])
                .send()
                .await
                .map_err(|e| {
                    format!(
                        "Twitch token-opvraag mislukt: {e}"
                    )
                })?;

        let status =
            response.status();

        let body =
            response
                .text()
                .await
                .map_err(|e| {
                    format!(
                        "Twitch token-antwoord kon niet worden gelezen: {e}"
                    )
                })?;

        if status.is_success() {
            let token =
                serde_json::from_str::<TwitchTokenResponse>(
                    &body,
                )
                .map_err(|e| {
                    format!(
                        "Twitch token-JSON is ongeldig: {e}"
                    )
                })?;

            if token.access_token.trim().is_empty() {
                return Err(
                    "Twitch gaf geen access token terug"
                        .to_string(),
                );
            }

            if token.refresh_token.trim().is_empty() {
                return Err(
                    "Twitch gaf geen refresh token terug"
                        .to_string(),
                );
            }

            return Ok(token);
        }

        let pending =
            serde_json::from_str::<serde_json::Value>(
                &body,
            )
            .ok()
            .and_then(|value| {
                value
                    .get("message")
                    .and_then(|message| {
                        message.as_str()
                    })
                    .map(|message| {
                        message.to_string()
                    })
            })
            .unwrap_or_default();

        if pending
            .eq_ignore_ascii_case(
                "authorization_pending",
            )
        {
            sleep(
                TokioDuration::from_secs(
                    poll_interval,
                ),
            )
            .await;

            continue;
        }

        return Err(
            format!(
                "Twitch login mislukt {}: {}",
                status,
                if pending.is_empty() {
                    body
                } else {
                    pending
                }
            ),
        );
    }
}

// =========================================================
// TWITCH TOKEN VERNIEUWEN
// =========================================================

async fn refresh_twitch_token(
    http_client: &reqwest::Client,
    client_id: &str,
    refresh_token: &str,
) -> Result<StoredTwitchToken, String> {
    let response =
        http_client
            .post(TWITCH_TOKEN_URL)
            .form(&[
                (
                    "client_id",
                    client_id,
                ),
                (
                    "grant_type",
                    "refresh_token",
                ),
                (
                    "refresh_token",
                    refresh_token,
                ),
            ])
            .send()
            .await
            .map_err(|e| {
                format!(
                    "Twitch token vernieuwen mislukt: {e}"
                )
            })?;

    let status =
        response.status();

    let body =
        response
            .text()
            .await
            .map_err(|e| {
                format!(
                    "Twitch refresh-antwoord kon niet worden gelezen: {e}"
                )
            })?;

    if !status.is_success() {
        return Err(
            format!(
                "Twitch-koppeling moet opnieuw worden uitgevoerd ({}): {}",
                status,
                body
            ),
        );
    }

    let token =
        serde_json::from_str::<TwitchTokenResponse>(
            &body,
        )
        .map_err(|e| {
            format!(
                "Twitch refresh-JSON is ongeldig: {e}"
            )
        })?;

    save_twitch_token(
        &token.access_token,
        &token.refresh_token,
    )?;

    load_stored_twitch_token()?
        .ok_or_else(|| {
            "Vernieuwde Twitch token kon niet worden geladen"
                .to_string()
        })
}

// =========================================================
// TWITCH HELIX VIEWERS
// =========================================================

async fn fetch_twitch_viewers_with_token(
    http_client: &reqwest::Client,
    client_id: &str,
    channel_login: &str,
    access_token: &str,
) -> Result<(reqwest::StatusCode, String), String> {
    let response =
        http_client
            .get(TWITCH_STREAMS_URL)
            .query(&[
                (
                    "user_login",
                    channel_login,
                ),
            ])
            .header(
                "Client-Id",
                client_id,
            )
            .bearer_auth(
                access_token,
            )
            .send()
            .await
            .map_err(|e| {
                format!(
                    "Twitch viewer-opvraag mislukt: {e}"
                )
            })?;

    let status =
        response.status();

    let body =
        response
            .text()
            .await
            .map_err(|e| {
                format!(
                    "Twitch viewer-resultaat kon niet worden gelezen: {e}"
                )
            })?;

    Ok((status, body))
}

fn parse_twitch_viewer_response(
    body: &str,
) -> Result<TwitchViewerResult, String> {
    let streams =
        serde_json::from_str::<TwitchStreamsResponse>(
            body,
        )
        .map_err(|e| {
            format!(
                "Twitch streams-JSON is ongeldig: {e}"
            )
        })?;

    match streams.data.first() {
        Some(stream) => {
            Ok(
                TwitchViewerResult {
                    connected: true,
                    live: true,
                    viewer_count:
                        Some(
                            stream.viewer_count,
                        ),
                    message:
                        "Twitch livestream is live"
                            .to_string(),
                },
            )
        }

        None => {
            Ok(
                TwitchViewerResult {
                    connected: true,
                    live: false,
                    viewer_count: None,
                    message:
                        "Twitch kanaal is offline"
                            .to_string(),
                },
            )
        }
    }
}

// =========================================================
// TAURI COMMAND: TWITCH AUTH STATUS
// =========================================================

#[tauri::command]
fn twitch_auth_status()
    -> Result<TwitchAuthStatus, String>
{
    create_twitch_auth_status()
}

// =========================================================
// TAURI COMMAND: TWITCH LOGIN
// =========================================================

#[tauri::command]
async fn twitch_login(
    app: tauri::AppHandle,
    client_id: String,
) -> Result<TwitchLoginResult, String> {
    let client_id =
        client_id
            .trim()
            .to_string();

    if client_id.is_empty() {
        return Err(
            "Twitch Client ID ontbreekt"
                .to_string(),
        );
    }

    let http_client =
        create_http_client()?;

    let device =
        request_twitch_device_code(
            &http_client,
            &client_id,
        )
        .await?;

    println!(
        "Twitch device code: {}",
        device.user_code
    );

    app.opener()
        .open_url(
            device.verification_uri.as_str(),
            None::<&str>,
        )
        .map_err(|e| {
            format!(
                "Twitch loginpagina kon niet worden geopend: {e}"
            )
        })?;

    let token =
        poll_twitch_device_token(
            &http_client,
            &client_id,
            &device,
        )
        .await?;

    save_twitch_token(
        &token.access_token,
        &token.refresh_token,
    )?;

    Ok(
        TwitchLoginResult {
            connected: true,
            message:
                "Twitch API succesvol gekoppeld"
                    .to_string(),
        },
    )
}

// =========================================================
// TAURI COMMAND: TWITCH VIEWER COUNT
// =========================================================

#[tauri::command]
async fn twitch_viewer_count(
    client_id: String,
    channel_login: String,
) -> Result<TwitchViewerResult, String> {
    let client_id =
        client_id
            .trim()
            .to_string();

    let channel_login =
        channel_login
            .trim()
            .to_lowercase();

    if client_id.is_empty() {
        return Err(
            "Twitch Client ID ontbreekt"
                .to_string(),
        );
    }

    if channel_login.is_empty() {
        return Err(
            "Twitch kanaalnaam ontbreekt"
                .to_string(),
        );
    }

    let mut stored_token =
        match load_stored_twitch_token()? {
            Some(token) => token,

            None => {
                return Ok(
                    TwitchViewerResult {
                        connected: false,
                        live: false,
                        viewer_count: None,
                        message:
                            "Twitch API is nog niet gekoppeld"
                                .to_string(),
                    },
                );
            }
        };

    let http_client =
        create_http_client()?;

    let (
        mut status,
        mut body,
    ) =
        fetch_twitch_viewers_with_token(
            &http_client,
            &client_id,
            &channel_login,
            &stored_token.access_token,
        )
        .await?;

    if status
        == reqwest::StatusCode::UNAUTHORIZED
    {
        stored_token =
            refresh_twitch_token(
                &http_client,
                &client_id,
                &stored_token.refresh_token,
            )
            .await?;

        (
            status,
            body,
        ) =
            fetch_twitch_viewers_with_token(
                &http_client,
                &client_id,
                &channel_login,
                &stored_token.access_token,
            )
            .await?;
    }

    if !status.is_success() {
        return Err(
            format!(
                "Twitch Helix API fout {}: {}",
                status,
                body
            ),
        );
    }

    parse_twitch_viewer_response(
        &body,
    )
}



// =========================================================
// SDJFAM EVENT ENGINE TEST
// =========================================================

#[tauri::command]
fn event_engine_test() -> SdjfamEvent {
    SdjfamEvent::new(
        format!(
            "sdjfam-test-{}",
            Utc::now()
                .timestamp_nanos_opt()
                .unwrap_or_default()
        ),
        Platform::System,
        EventType::Custom,
    )
    .with_message(
        "SDJFAM Event Engine werkt",
    )
    .with_raw_event_type(
        "event_engine_test",
    )
    .with_metadata(
        serde_json::json!({
            "engine": "sdjfam",
            "status": "ok"
        }),
    )
}
#[cfg_attr(
    mobile,
    tauri::mobile_entry_point
)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_opener::init(),
        )
        .plugin(
            tauri_plugin_updater::Builder::new()
                .build(),
        )
        .invoke_handler(
            tauri::generate_handler![
                
                event_engine_test,youtube_login,
                youtube_auth_status,
                youtube_auto_connect,
                youtube_start_chat_stream,
                youtube_stop_chat_stream,
                            youtube_viewer_count,
                twitch_auth_status,
                twitch_login,
                twitch_viewer_count
            ],
        )
        .run(
            tauri::generate_context!(),
        )
        .expect(
            "error while running tauri application",
        );
}
