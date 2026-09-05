use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter};
use tokio::time::{interval, sleep, Duration};
use tokio_tungstenite::{
    connect_async,
    tungstenite::Message,
};

use crate::event_engine::{
    EventAmount,
    EventType,
    EventUser,
    Platform,
    SdjfamEvent,
};

use crate::load_stored_twitch_token;

const TWITCH_EVENTSUB_WEBSOCKET_URL: &str =
    "wss://eventsub.wss.twitch.tv/ws";

const TWITCH_EVENTSUB_SUBSCRIPTIONS_URL: &str =
    "https://api.twitch.tv/helix/eventsub/subscriptions";

const TWITCH_VALIDATE_URL: &str =
    "https://id.twitch.tv/oauth2/validate";

const REQUIRED_SCOPES: [&str; 3] = [
    "moderator:read:followers",
    "channel:read:subscriptions",
    "bits:read",
];

static EVENTSUB_RUN_ID: AtomicU64 =
    AtomicU64::new(0);

fn create_eventsub_http_client()
-> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(
            "SDJFAM-Chat/0.1.2",
        )
        .build()
        .map_err(|e| {
            format!(
                "EventSub HTTP-client kon niet worden gemaakt: {e}"
            )
        })
}

// =========================================================
// PUBLIC RESULT TYPES
// =========================================================

#[derive(Debug, Clone, Serialize)]
pub struct TwitchEventSubStartResult {
    pub connected: bool,
    pub broadcaster_login: String,
    pub message: String,
}

// =========================================================
// TWITCH TOKEN VALIDATION
// =========================================================

#[derive(Debug, Deserialize)]
struct TwitchValidateResponse {
    client_id: String,

    #[serde(default)]
    login: Option<String>,

    #[serde(default)]
    user_id: Option<String>,

    #[serde(default)]
    scopes: Option<Vec<String>>,
}

async fn validate_twitch_token(
    http_client: &reqwest::Client,
    client_id: &str,
    access_token: &str,
) -> Result<TwitchValidateResponse, String> {
    let response =
        http_client
            .get(TWITCH_VALIDATE_URL)
            .header(
                "Authorization",
                format!("OAuth {access_token}"),
            )
            .send()
            .await
            .map_err(|e| {
                format!(
                    "Twitch tokenvalidatie kon niet worden uitgevoerd: {e}"
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
                    "Twitch tokenvalidatie kon niet worden gelezen: {e}"
                )
            })?;

    if !status.is_success() {
        return Err(
            "Twitch login is niet meer geldig. Koppel Twitch opnieuw."
                .to_string(),
        );
    }

    let validation =
        serde_json::from_str::<TwitchValidateResponse>(
            &body,
        )
        .map_err(|e| {
            format!(
                "Twitch tokenvalidatie bevat ongeldige JSON: {e}"
            )
        })?;

    if validation.client_id != client_id {
        return Err(
            "De opgeslagen Twitch-login hoort bij een andere Client ID. Koppel Twitch opnieuw."
                .to_string(),
        );
    }

    let missing_scopes =
        REQUIRED_SCOPES
            .iter()
            .filter(|required| {
                !validation
                    .scopes
                .as_deref()
                .unwrap_or_default()
                .iter()
                    .any(|scope| {
                        scope == **required
                    })
            })
            .copied()
            .collect::<Vec<_>>();

    if !missing_scopes.is_empty() {
        return Err(
            format!(
                "Twitch moet opnieuw gekoppeld worden voor EventSub. Ontbrekende rechten: {}",
                missing_scopes.join(", ")
            ),
        );
    }

    if validation
        .user_id
        .as_deref()
        .unwrap_or("")
        .is_empty()
    {
        return Err(
            "Twitch token bevat geen gebruikers-ID."
                .to_string(),
        );
    }

    Ok(validation)
}

// =========================================================
// STATUS EVENTS
// =========================================================

fn emit_status(
    app: &AppHandle,
    status: &str,
    message: impl Into<String>,
) {
    let _ =
        app.emit(
            "twitch-eventsub-status",
            json!({
                "status": status,
                "message": message.into(),
            }),
        );
}

// =========================================================
// CREATE EVENTSUB SUBSCRIPTION
// =========================================================

async fn create_subscription(
    http_client: &reqwest::Client,
    client_id: &str,
    access_token: &str,
    session_id: &str,
    subscription_type: &str,
    version: &str,
    condition: Value,
) -> Result<(), String> {
    let request_body =
        json!({
            "type": subscription_type,
            "version": version,
            "condition": condition,
            "transport": {
                "method": "websocket",
                "session_id": session_id,
            }
        });

    let response =
        http_client
            .post(
                TWITCH_EVENTSUB_SUBSCRIPTIONS_URL,
            )
            .header(
                "Client-Id",
                client_id,
            )
            .bearer_auth(
                access_token,
            )
            .json(
                &request_body,
            )
            .send()
            .await
            .map_err(|e| {
                format!(
                    "EventSub subscription {subscription_type} kon niet worden aangemaakt: {e}"
                )
            })?;

    let status =
        response.status();

    let body =
        response
            .text()
            .await
            .unwrap_or_default();

    if !status.is_success() {
        return Err(
            format!(
                "Twitch EventSub {} fout {}: {}",
                subscription_type,
                status,
                body,
            ),
        );
    }

    println!(
        "SDJFAM EventSub actief: {} v{}",
        subscription_type,
        version,
    );

    Ok(())
}

// =========================================================
// REGISTER ALL SDJFAM TWITCH EVENTS
// =========================================================

async fn register_subscriptions(
    http_client: &reqwest::Client,
    client_id: &str,
    access_token: &str,
    broadcaster_user_id: &str,
    session_id: &str,
) -> Result<(), String> {
    create_subscription(
        http_client,
        client_id,
        access_token,
        session_id,
        "channel.follow",
        "2",
        json!({
            "broadcaster_user_id":
                broadcaster_user_id,
            "moderator_user_id":
                broadcaster_user_id,
        }),
    )
    .await?;

    create_subscription(
        http_client,
        client_id,
        access_token,
        session_id,
        "channel.subscribe",
        "1",
        json!({
            "broadcaster_user_id":
                broadcaster_user_id,
        }),
    )
    .await?;

    create_subscription(
        http_client,
        client_id,
        access_token,
        session_id,
        "channel.subscription.gift",
        "1",
        json!({
            "broadcaster_user_id":
                broadcaster_user_id,
        }),
    )
    .await?;

    create_subscription(
        http_client,
        client_id,
        access_token,
        session_id,
        "channel.cheer",
        "1",
        json!({
            "broadcaster_user_id":
                broadcaster_user_id,
        }),
    )
    .await?;

    create_subscription(
        http_client,
        client_id,
        access_token,
        session_id,
        "channel.raid",
        "1",
        json!({
            "to_broadcaster_user_id":
                broadcaster_user_id,
        }),
    )
    .await?;

    create_subscription(
        http_client,
        client_id,
        access_token,
        session_id,
        "stream.online",
        "1",
        json!({
            "broadcaster_user_id":
                broadcaster_user_id,
        }),
    )
    .await?;

    create_subscription(
        http_client,
        client_id,
        access_token,
        session_id,
        "stream.offline",
        "1",
        json!({
            "broadcaster_user_id":
                broadcaster_user_id,
        }),
    )
    .await?;

    Ok(())
}

// =========================================================
// EVENT HELPERS
// =========================================================

fn string_value(
    value: &Value,
    field: &str,
) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn twitch_user(
    event: &Value,
    id_field: &str,
    login_field: &str,
    name_field: &str,
) -> EventUser {
    EventUser::new(
        string_value(
            event,
            id_field,
        ),
        string_value(
            event,
            login_field,
        ),
        string_value(
            event,
            name_field,
        ),
    )
}

// =========================================================
// NORMALIZE TWITCH -> SDJFAM EVENT
// =========================================================

fn normalize_notification(
    message: &Value,
) -> Option<SdjfamEvent> {
    let metadata =
        message.get("metadata")?;

    let payload =
        message.get("payload")?;

    let event =
        payload.get("event")?;

    let subscription_type =
        metadata
            .get("subscription_type")
            .and_then(Value::as_str)?;

    let message_id =
        metadata
            .get("message_id")
            .and_then(Value::as_str)
            .unwrap_or("twitch-event");

    match subscription_type {
        "channel.follow" => {
            Some(
                SdjfamEvent::new(
                    message_id,
                    Platform::Twitch,
                    EventType::Follow,
                )
                .with_user(
                    twitch_user(
                        event,
                        "user_id",
                        "user_login",
                        "user_name",
                    ),
                )
                .with_raw_event_type(
                    subscription_type,
                )
                .with_metadata(
                    event.clone(),
                ),
            )
        }

        "channel.subscribe" => {
            let is_gift =
                event
                    .get("is_gift")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);

            // Gift subs komen via channel.subscription.gift.
            // Hiermee voorkomen we dubbele gift-alerts.
            if is_gift {
                return None;
            }

            Some(
                SdjfamEvent::new(
                    message_id,
                    Platform::Twitch,
                    EventType::Subscription,
                )
                .with_user(
                    twitch_user(
                        event,
                        "user_id",
                        "user_login",
                        "user_name",
                    ),
                )
                .with_raw_event_type(
                    subscription_type,
                )
                .with_metadata(
                    event.clone(),
                ),
            )
        }

        "channel.subscription.gift" => {
            let mut normalized =
                SdjfamEvent::new(
                    message_id,
                    Platform::Twitch,
                    EventType::GiftSubscription,
                )
                .with_raw_event_type(
                    subscription_type,
                )
                .with_metadata(
                    event.clone(),
                );

            let anonymous =
                event
                    .get("is_anonymous")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);

            if !anonymous {
                normalized =
                    normalized.with_user(
                        twitch_user(
                            event,
                            "user_id",
                            "user_login",
                            "user_name",
                        ),
                    );
            }

            Some(normalized)
        }

        "channel.cheer" => {
            let bits =
                event
                    .get("bits")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);

            let mut normalized =
                SdjfamEvent::new(
                    message_id,
                    Platform::Twitch,
                    EventType::Bits,
                )
                .with_amount(
                    EventAmount::new(
                        bits as f64,
                        Some(
                            "BITS".to_string(),
                        ),
                    ),
                )
                .with_raw_event_type(
                    subscription_type,
                )
                .with_metadata(
                    event.clone(),
                );

            let anonymous =
                event
                    .get("is_anonymous")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);

            if !anonymous {
                normalized =
                    normalized.with_user(
                        twitch_user(
                            event,
                            "user_id",
                            "user_login",
                            "user_name",
                        ),
                    );
            }

            if let Some(message) =
                string_value(
                    event,
                    "message",
                )
            {
                normalized =
                    normalized.with_message(
                        message,
                    );
            }

            Some(normalized)
        }

        "channel.raid" => {
            Some(
                SdjfamEvent::new(
                    message_id,
                    Platform::Twitch,
                    EventType::Raid,
                )
                .with_user(
                    twitch_user(
                        event,
                        "from_broadcaster_user_id",
                        "from_broadcaster_user_login",
                        "from_broadcaster_user_name",
                    ),
                )
                .with_raw_event_type(
                    subscription_type,
                )
                .with_metadata(
                    event.clone(),
                ),
            )
        }

        "stream.online" => {
            Some(
                SdjfamEvent::new(
                    message_id,
                    Platform::Twitch,
                    EventType::StreamOnline,
                )
                .with_user(
                    twitch_user(
                        event,
                        "broadcaster_user_id",
                        "broadcaster_user_login",
                        "broadcaster_user_name",
                    ),
                )
                .with_raw_event_type(
                    subscription_type,
                )
                .with_metadata(
                    event.clone(),
                ),
            )
        }

        "stream.offline" => {
            Some(
                SdjfamEvent::new(
                    message_id,
                    Platform::Twitch,
                    EventType::StreamOffline,
                )
                .with_user(
                    twitch_user(
                        event,
                        "broadcaster_user_id",
                        "broadcaster_user_login",
                        "broadcaster_user_name",
                    ),
                )
                .with_raw_event_type(
                    subscription_type,
                )
                .with_metadata(
                    event.clone(),
                ),
            )
        }

        _ => None,
    }
}

// =========================================================
// EVENTSUB WEBSOCKET LOOP
// =========================================================

async fn run_eventsub(
    app: AppHandle,
    client_id: String,
    access_token: String,
    broadcaster_user_id: String,
    run_id: u64,
) -> Result<(), String> {
    let http_client =
        create_eventsub_http_client()?;

    let mut websocket_url =
        TWITCH_EVENTSUB_WEBSOCKET_URL
            .to_string();

    let mut create_subscriptions_on_welcome =
        true;

    loop {
        if EVENTSUB_RUN_ID.load(
            Ordering::SeqCst,
        ) != run_id
        {
            return Ok(());
        }

        emit_status(
            &app,
            "connecting",
            "Verbinden met Twitch EventSub...",
        );

        let connection =
            connect_async(
                websocket_url.as_str(),
            )
            .await;

        let (mut socket, _) =
            match connection {
                Ok(value) => value,

                Err(error) => {
                    emit_status(
                        &app,
                        "reconnecting",
                        format!(
                            "EventSub verbinding mislukt: {error}"
                        ),
                    );

                    sleep(
                        Duration::from_secs(3),
                    )
                    .await;

                    websocket_url =
                        TWITCH_EVENTSUB_WEBSOCKET_URL
                            .to_string();

                    create_subscriptions_on_welcome =
                        true;

                    continue;
                }
            };

        emit_status(
            &app,
            "socket_connected",
            "Twitch EventSub WebSocket verbonden",
        );

        let mut reconnect_url:
            Option<String> = None;

        let mut validation_interval =
            interval(
                Duration::from_secs(3600),
            );

        // interval() tikt direct bij de eerste tick.
        validation_interval.tick().await;

        loop {
            if EVENTSUB_RUN_ID.load(
                Ordering::SeqCst,
            ) != run_id
            {
                let _ =
                    socket.close(None).await;

                emit_status(
                    &app,
                    "stopped",
                    "Twitch EventSub gestopt",
                );

                return Ok(());
            }

            tokio::select! {
                _ = validation_interval.tick() => {
                    if let Err(error) =
                        validate_twitch_token(
                            &http_client,
                            &client_id,
                            &access_token,
                        )
                        .await
                    {
                        emit_status(
                            &app,
                            "auth_error",
                            error.clone(),
                        );

                        return Err(error);
                    }
                }

                message = socket.next() => {
                    let Some(message) = message else {
                        break;
                    };

                    let message =
                        match message {
                            Ok(value) => value,

                            Err(error) => {
                                println!(
                                    "Twitch EventSub WebSocket fout: {}",
                                    error,
                                );

                                break;
                            }
                        };

                    match message {
                        Message::Text(text) => {
                            let text =
                                text.to_string();

                            let json_message =
                                match serde_json::from_str::<Value>(
                                    &text,
                                ) {
                                    Ok(value) => value,

                                    Err(error) => {
                                        println!(
                                            "Ongeldige Twitch EventSub JSON: {}",
                                            error,
                                        );

                                        continue;
                                    }
                                };

                            let message_type =
                                json_message
                                    .get("metadata")
                                    .and_then(|metadata| {
                                        metadata.get(
                                            "message_type"
                                        )
                                    })
                                    .and_then(Value::as_str)
                                    .unwrap_or("");

                            match message_type {
                                "session_welcome" => {
                                    let session_id =
                                        json_message
                                            .pointer(
                                                "/payload/session/id"
                                            )
                                            .and_then(
                                                Value::as_str
                                            )
                                            .ok_or_else(|| {
                                                "Twitch EventSub welcome bevat geen session ID"
                                                    .to_string()
                                            })?;

                                    if create_subscriptions_on_welcome {
                                        register_subscriptions(
                                            &http_client,
                                            &client_id,
                                            &access_token,
                                            &broadcaster_user_id,
                                            session_id,
                                        )
                                        .await?;

                                        emit_status(
                                            &app,
                                            "connected",
                                            "Twitch EventSub actief",
                                        );
                                    }
                                    else {
                                        emit_status(
                                            &app,
                                            "connected",
                                            "Twitch EventSub opnieuw verbonden",
                                        );
                                    }
                                }

                                "notification" => {
                                    if let Some(event) =
                                        normalize_notification(
                                            &json_message,
                                        )
                                    {
                                        println!(
                                            "SDJFAM EVENT: {:?} / {:?}",
                                            event.platform,
                                            event.event_type,
                                        );

                                        if let Err(error) =
                                            app.emit(
                                                "sdjfam-event",
                                                &event,
                                            )
                                        {
                                            println!(
                                                "SDJFAM event kon niet naar frontend: {}",
                                                error,
                                            );
                                        }
                                    }
                                }

                                "session_keepalive" => {
                                    // Verbinding is gezond.
                                }

                                "session_reconnect" => {
                                    reconnect_url =
                                        json_message
                                            .pointer(
                                                "/payload/session/reconnect_url"
                                            )
                                            .and_then(
                                                Value::as_str
                                            )
                                            .map(
                                                str::to_string
                                            );

                                    if reconnect_url.is_some() {
                                        emit_status(
                                            &app,
                                            "reconnecting",
                                            "Twitch vraagt EventSub reconnect",
                                        );

                                        break;
                                    }
                                }

                                "revocation" => {
                                    let subscription_type =
                                        json_message
                                            .pointer(
                                                "/payload/subscription/type"
                                            )
                                            .and_then(
                                                Value::as_str
                                            )
                                            .unwrap_or(
                                                "onbekend"
                                            );

                                    let status =
                                        json_message
                                            .pointer(
                                                "/payload/subscription/status"
                                            )
                                            .and_then(
                                                Value::as_str
                                            )
                                            .unwrap_or(
                                                "onbekend"
                                            );

                                    emit_status(
                                        &app,
                                        "revoked",
                                        format!(
                                            "EventSub {} ingetrokken: {}",
                                            subscription_type,
                                            status,
                                        ),
                                    );
                                }

                                _ => {}
                            }
                        }

                        Message::Ping(payload) => {
                            if let Err(error) =
                                socket
                                    .send(
                                        Message::Pong(
                                            payload,
                                        ),
                                    )
                                    .await
                            {
                                println!(
                                    "EventSub pong mislukt: {}",
                                    error,
                                );

                                break;
                            }
                        }

                        Message::Close(_) => {
                            break;
                        }

                        _ => {}
                    }
                }
            }
        }

        if let Some(url) =
            reconnect_url
        {
            websocket_url =
                url;

            create_subscriptions_on_welcome =
                false;
        }
        else {
            emit_status(
                &app,
                "reconnecting",
                "Twitch EventSub verbinding verbroken; opnieuw verbinden...",
            );

            websocket_url =
                TWITCH_EVENTSUB_WEBSOCKET_URL
                    .to_string();

            create_subscriptions_on_welcome =
                true;

            sleep(
                Duration::from_secs(3),
            )
            .await;
        }
    }
}

// =========================================================
// TAURI COMMAND: START EVENTSUB
// =========================================================

#[tauri::command]
pub async fn twitch_start_eventsub(
    app: AppHandle,
    client_id: String,
) -> Result<TwitchEventSubStartResult, String> {
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

    let stored_token =
        load_stored_twitch_token()?
            .ok_or_else(|| {
                "Twitch API is nog niet gekoppeld"
                    .to_string()
            })?;

    let http_client =
        create_eventsub_http_client()?;

    let validation =
        validate_twitch_token(
            &http_client,
            &client_id,
            &stored_token.access_token,
        )
        .await?;

    let broadcaster_user_id =
        validation
            .user_id
            .clone()
            .ok_or_else(|| {
                "Twitch gebruikers-ID ontbreekt"
                    .to_string()
            })?;

    let broadcaster_login =
        validation
            .login
            .clone()
            .unwrap_or_else(|| {
                "Twitch".to_string()
            });

    let run_id =
        EVENTSUB_RUN_ID
            .fetch_add(
                1,
                Ordering::SeqCst,
            )
            + 1;

    let task_app =
        app.clone();

    let task_client_id =
        client_id.clone();

    let task_access_token =
        stored_token
            .access_token
            .clone();

    tauri::async_runtime::spawn(
        async move {
            if let Err(error) =
                run_eventsub(
                    task_app.clone(),
                    task_client_id,
                    task_access_token,
                    broadcaster_user_id,
                    run_id,
                )
                .await
            {
                println!(
                    "Twitch EventSub gestopt met fout: {}",
                    error,
                );

                emit_status(
                    &task_app,
                    "error",
                    error,
                );
            }
        },
    );

    Ok(
        TwitchEventSubStartResult {
            connected: true,
            broadcaster_login:
                broadcaster_login.clone(),
            message:
                format!(
                    "Twitch EventSub wordt gestart voor {}",
                    broadcaster_login,
                ),
        },
    )
}

// =========================================================
// TAURI COMMAND: STOP EVENTSUB
// =========================================================

#[tauri::command]
pub fn twitch_stop_eventsub()
-> Result<(), String> {
    EVENTSUB_RUN_ID.fetch_add(
        1,
        Ordering::SeqCst,
    );

    Ok(())
}