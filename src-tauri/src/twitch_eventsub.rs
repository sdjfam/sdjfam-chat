use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use oauth2::reqwest;
use crate::twitch_auth::{self, AuthError};
use std::collections::{HashSet, VecDeque};
use std::future::Future;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio::time::{timeout, Instant};
use serde_json::{json, Value};
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


const TWITCH_EVENTSUB_WEBSOCKET_URL: &str =
    "wss://eventsub.wss.twitch.tv/ws";

const TWITCH_EVENTSUB_SUBSCRIPTIONS_URL: &str =
    "https://api.twitch.tv/helix/eventsub/subscriptions";


const REQUIRED_SCOPES: [&str; 3] = [
    "moderator:read:followers",
    "channel:read:subscriptions",
    "bits:read",
];

fn create_eventsub_http_client() -> Result<reqwest::Client, AuthError> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build().map_err(|_| AuthError::Configuration)
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

async fn validate_twitch_token(http: &reqwest::Client, client_id: &str)
    -> Result<(crate::StoredTwitchToken, twitch_auth::Validation), AuthError> {
    twitch_auth::validated_token(http, client_id, &REQUIRED_SCOPES).await
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
) -> Result<(), AuthError> {
    let request_body = json!({
        "type": subscription_type, "version": version, "condition": condition,
        "transport": { "method": "websocket", "session_id": session_id }
    });
    let send = |token: String| {
        http_client.post(TWITCH_EVENTSUB_SUBSCRIPTIONS_URL)
            .header("Client-Id", client_id).bearer_auth(token).header("Content-Type", "application/json").body(request_body.to_string()).send()
    };
    // Only retry the rejected subscription, never the whole partial batch on this socket.
    let mut response = send(access_token.to_string()).await.map_err(|_| AuthError::Network)?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        let token = twitch_auth::refresh_after_rejection(http_client, client_id, access_token).await?;
        response = send(token.access_token.clone()).await.map_err(|_| AuthError::Network)?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            twitch_auth::reject_refreshed_token(client_id, &token.access_token).await;
            return Err(AuthError::RelinkRequired);
        }
    }
    if !response.status().is_success() {
        let error = twitch_auth::http_error(response.status().as_u16(), false, "");
        return Err(if error == AuthError::AccessInvalid { AuthError::RelinkRequired } else { error });
    }
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
) -> Result<(), AuthError> {
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

// One owner controls start, cancellation and retries. Stop waits for the old task
// to drop its socket before another start can acquire the slot.
struct TaskSlot { task: Mutex<Option<JoinHandle<()>>> }
impl TaskSlot {
    const fn new() -> Self { Self { task: Mutex::const_new(None) } }
    async fn start(&self, task: impl Future<Output = ()> + Send + 'static) -> bool {
        let mut slot = self.task.lock().await;
        if slot.as_ref().is_some_and(|task| !task.is_finished()) { return false; }
        *slot = Some(tokio::spawn(task));
        true
    }
    async fn stop(&self) {
        let mut slot = self.task.lock().await;
        if let Some(task) = slot.take() {
            task.abort();
            let _ = task.await;
        }
    }
}
static EVENTSUB_TASK: TaskSlot = TaskSlot::new();

#[derive(Default)]
struct RetryBudget { failures: usize }
impl RetryBudget {
    fn next(&mut self, error: AuthError) -> Option<Duration> {
        const DELAYS: [u64; 6] = [5, 10, 20, 40, 80, 120];
        if !error.retryable() { return None; }
        let seconds = *DELAYS.get(self.failures)?;
        self.failures += 1;
        Some(Duration::from_secs(seconds))
    }
    fn healthy(&mut self, since: Instant) {
        // A welcome alone does not replenish the retry budget of a flapping socket.
        if since.elapsed() >= Duration::from_secs(300) { self.failures = 0; }
    }
}

#[derive(Default)]
struct MessageIds { ids: HashSet<String>, order: VecDeque<String> }
impl MessageIds {
    fn first(&mut self, id: &str) -> bool {
        if id.is_empty() || !self.ids.insert(id.to_string()) { return false; }
        self.order.push_back(id.to_string());
        if self.order.len() > 4096 {
            if let Some(old) = self.order.pop_front() { self.ids.remove(&old); }
        }
        true
    }
}

// Survives task replacement; Twitch redelivery must not emit a second alert.
static MESSAGE_IDS: std::sync::LazyLock<std::sync::Mutex<MessageIds>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(MessageIds::default()));

type EventSocket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

fn emit_notification(app: &AppHandle, value: &Value) {
    let id = value.pointer("/metadata/message_id").and_then(Value::as_str).unwrap_or("");
    if MESSAGE_IDS.lock().unwrap_or_else(|e| e.into_inner()).first(id) {
        if let Some(event) = normalize_notification(value) { let _ = app.emit("sdjfam-event", &event); }
    }
}

// Twitch requires overlap during server-requested handover. Both sockets belong
// to this one task; the replacement inherits subscriptions and never registers again.
async fn handover(old: &mut EventSocket, url: &str, mut deliver: impl FnMut(&Value))
    -> Result<(EventSocket, Value), AuthError> {
    timeout(Duration::from_secs(25), async {
        let connecting = connect_async(url);
        tokio::pin!(connecting);
        let mut old_open = true;
        let mut replacement = loop {
            tokio::select! {
                result = &mut connecting => break result.map_err(|_| AuthError::Network)?.0,
                message = old.next(), if old_open => {
                    match message {
                        Some(Ok(Message::Text(text))) => {
                            let value: Value = serde_json::from_str(&text).map_err(|_| AuthError::Protocol)?;
                            if value.pointer("/metadata/message_type").and_then(Value::as_str) == Some("notification") { deliver(&value); }
                        }
                        Some(Ok(Message::Ping(data))) => { old.send(Message::Pong(data)).await.map_err(|_| AuthError::Network)?; }
                        None | Some(Err(_)) | Some(Ok(Message::Close(_))) => old_open = false,
                        _ => {}
                    }
                }
            }
        };
        loop {
            tokio::select! {
                message = replacement.next() => {
                    match message {
                        Some(Ok(Message::Text(text))) => {
                            let welcome: Value = serde_json::from_str(&text).map_err(|_| AuthError::Protocol)?;
                            if welcome.pointer("/metadata/message_type").and_then(Value::as_str) != Some("session_welcome") ||
                                welcome.pointer("/payload/session/id").and_then(Value::as_str).is_none() { return Err(AuthError::Protocol); }
                            let _ = timeout(Duration::from_secs(1), old.close(None)).await;
                            return Ok((replacement, welcome));
                        }
                        Some(Ok(Message::Ping(data))) => { replacement.send(Message::Pong(data)).await.map_err(|_| AuthError::Network)?; }
                        _ => return Err(AuthError::Network),
                    }
                }
                message = old.next(), if old_open => {
                    match message {
                        Some(Ok(Message::Text(text))) => {
                            let value: Value = serde_json::from_str(&text).map_err(|_| AuthError::Protocol)?;
                            if value.pointer("/metadata/message_type").and_then(Value::as_str) == Some("notification") { deliver(&value); }
                        }
                        Some(Ok(Message::Ping(data))) => { old.send(Message::Pong(data)).await.map_err(|_| AuthError::Network)?; }
                        None | Some(Err(_)) | Some(Ok(Message::Close(_))) => old_open = false,
                        _ => {}
                    }
                }
            }
        }
    }).await.map_err(|_| AuthError::Network)?
}

async fn run_eventsub(app: &AppHandle, http: &reqwest::Client, client_id: &str,
    budget: &mut RetryBudget, recovered: bool) -> Result<(), AuthError> {
    let (mut token, validation) = validate_twitch_token(http, client_id).await?;
    let user_id = validation.user_id.ok_or(AuthError::Protocol)?;
    let mut replacement: Option<(EventSocket, Value)> = None;
    let mut transferred = false;
    let mut validation_interval = interval(Duration::from_secs(3600));
    validation_interval.tick().await;
    loop {
        emit_status(app, "connecting", "Verbinden met Twitch EventSub...");
        let (mut socket, mut pending_welcome) = if let Some((socket, welcome)) = replacement.take() {
            (socket, Some(welcome))
        } else {
            let (socket, _) = timeout(Duration::from_secs(20), connect_async(TWITCH_EVENTSUB_WEBSOCKET_URL))
                .await.map_err(|_| AuthError::Network)?.map_err(|_| AuthError::Network)?;
            (socket, None)
        };
        emit_status(app, "socket_connected", "Twitch EventSub WebSocket verbonden");
        let mut welcomed = false;
        let mut healthy_since = None;
        let mut keepalive = Duration::from_secs(30);
        let mut deadline = Instant::now() + Duration::from_secs(15);
        let mut reconnect_url = None;
        let result = async {
            loop {
                tokio::select! {
                    _ = tokio::time::sleep_until(deadline) => return Err(AuthError::Network),
                    _ = validation_interval.tick() => {
                        let (current, validation) = validate_twitch_token(http, client_id).await?;
                        if validation.user_id.as_deref() != Some(user_id.as_str()) {
                            return Err(AuthError::Configuration);
                        }
                        token = current;
                    }
                    message = async {
                        if let Some(welcome) = pending_welcome.take() { Some(Ok(Message::Text(welcome.to_string().into()))) }
                        else { socket.next().await }
                    } => {
                        let message = message.ok_or(AuthError::Network)?.map_err(|_| AuthError::Network)?;
                        match message {
                            Message::Text(text) => {
                                let value: Value = serde_json::from_str(&text).map_err(|_| AuthError::Protocol)?;
                                let kind = value.pointer("/metadata/message_type").and_then(Value::as_str).unwrap_or("");
                                deadline = Instant::now() + keepalive;
                                match kind {
                                    "session_welcome" if !welcomed => {
                                        welcomed = true;
                                        let session_id = value.pointer("/payload/session/id").and_then(Value::as_str).ok_or(AuthError::Protocol)?;
                                        keepalive = Duration::from_secs(value.pointer("/payload/session/keepalive_timeout_seconds")
                                            .and_then(Value::as_u64).unwrap_or(30).clamp(10, 600) + 5);
                                        if !transferred {
                                            register_subscriptions(http, client_id, &token.access_token, &user_id, session_id).await?;
                                        }
                                        deadline = Instant::now() + keepalive;
                                        healthy_since = Some(Instant::now());
                                        if recovered { twitch_auth::log("EventSub recovered"); }
                                        emit_status(app, "connected", "Twitch EventSub actief");
                                    }
                                    "notification" if welcomed => emit_notification(app, &value),
                                    "session_reconnect" if welcomed => {
                                        let next = value.pointer("/payload/session/reconnect_url").and_then(Value::as_str).ok_or(AuthError::Protocol)?;
                                        let parsed = url::Url::parse(next).map_err(|_| AuthError::Protocol)?;
                                        if parsed.scheme() != "wss" || parsed.host_str() != Some("eventsub.wss.twitch.tv") {
                                            return Err(AuthError::Protocol);
                                        }
                                        reconnect_url = Some(next.to_string());
                                        return Ok(());
                                    }
                                    "revocation" => {
                                        let reason = value.pointer("/payload/subscription/status").and_then(Value::as_str).unwrap_or("");
                                        return Err(match reason {
                                            "authorization_revoked" | "user_removed" => AuthError::RelinkRequired,
                                            _ => AuthError::Configuration,
                                        });
                                    }
                                    _ => {}
                                }
                            }
                            Message::Ping(payload) => { socket.send(Message::Pong(payload)).await.map_err(|_| AuthError::Network)?; }
                            Message::Close(_) => return Err(AuthError::Network),
                            _ => {}
                        }
                    }
                }
            }
        }.await;
        if let Some(since) = healthy_since { budget.healthy(since); }
        if let Err(error) = result {
            let _ = timeout(Duration::from_secs(2), socket.close(None)).await;
            return Err(error);
        }
        let url = reconnect_url.ok_or(AuthError::Protocol)?;
        emit_status(app, "reconnecting", "Twitch vraagt EventSub reconnect");
        replacement = Some(handover(&mut socket, &url, |value| emit_notification(app, value)).await?);
        drop(socket);
        transferred = true;
    }
}

async fn wait_for_retry(delay: Option<Duration>, tokens: &mut tokio::sync::watch::Receiver<u64>) -> bool {
    match delay {
        Some(delay) => tokio::select! {
            _ = sleep(delay) => true,
            changed = tokens.changed() => changed.is_ok(),
        },
        None => tokens.changed().await.is_ok(),
    }
}

async fn supervise_eventsub(app: AppHandle, client_id: String) {
    let http = match create_eventsub_http_client() {
        Ok(http) => http,
        Err(error) => { emit_status(&app, error.code(), error.to_string()); return; }
    };
    let mut budget = RetryBudget::default();
    let mut tokens = twitch_auth::token_changes();
    let mut recovered = false;
    loop {
        let error = match run_eventsub(&app, &http, &client_id, &mut budget, recovered).await {
            Ok(()) => return,
            Err(error) => error,
        };
        // Consume changes made during this attempt, including our own refresh.
        // Only a later successful token replacement wakes a paused supervisor.
        tokens.borrow_and_update();
        twitch_auth::log(&format!("EventSub stopped | category={}", error.code()));
        emit_status(&app, error.code(), error.to_string());
        match budget.next(error) {
            Some(delay) => {
                twitch_auth::log(&format!("EventSub retry scheduled | category={} | delay_seconds={}", error.code(), delay.as_secs()));
                emit_status(&app, "retry_scheduled", format!("{} Nieuwe poging over {} seconden.", error, delay.as_secs()));
                if !wait_for_retry(Some(delay), &mut tokens).await { return; }
                recovered = true;
            }
            None => {
                if error.retryable() {
                    emit_status(&app, "retry_exhausted", "EventSub herstel gepauzeerd na zes pogingen. Controleer de verbinding. Een vernieuwde Twitch-koppeling of herstart hervat herstel.");
                    if wait_for_retry(None, &mut tokens).await {
                        budget = RetryBudget::default();
                        recovered = true;
                        continue;
                    }
                }
                return;
            }
        }
    }
}

#[tauri::command]
pub async fn twitch_start_eventsub(app: AppHandle, client_id: String) -> Result<TwitchEventSubStartResult, String> {
    let client_id = client_id.trim().to_string();
    if client_id.is_empty() { return Err(AuthError::Configuration.into()); }
    EVENTSUB_TASK.start(supervise_eventsub(app, client_id)).await;
    // Accepted is not connected; the status event is authoritative.
    Ok(TwitchEventSubStartResult { connected: false, broadcaster_login: String::new(), message: "Twitch EventSub start aangevraagd".to_string() })
}

#[tauri::command]
pub async fn twitch_stop_eventsub() -> Result<(), String> {
    EVENTSUB_TASK.stop().await;
    Ok(())
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
    #[tokio::test]
    async fn concurrent_starts_only_run_one_worker_and_stop_waits() {
        struct Guard(Arc<AtomicUsize>);
        impl Drop for Guard { fn drop(&mut self) { self.0.fetch_sub(1, Ordering::SeqCst); } }
        let slot = TaskSlot::new();
        let active = Arc::new(AtomicUsize::new(0));
        let ready = Arc::new(tokio::sync::Notify::new());
        let worker = || { let active=active.clone(); let ready=ready.clone(); async move {
            active.fetch_add(1,Ordering::SeqCst); let _guard=Guard(active);
            ready.notify_one(); std::future::pending::<()>().await;
        }};
        let (a,b)=tokio::join!(slot.start(worker()),slot.start(worker()));
        assert_ne!(a,b); ready.notified().await; assert_eq!(active.load(Ordering::SeqCst),1);
        slot.stop().await; assert_eq!(active.load(Ordering::SeqCst),0);
        assert!(slot.start(worker()).await); ready.notified().await;
        slot.stop().await; assert_eq!(active.load(Ordering::SeqCst),0);
    }
    #[tokio::test]
    async fn stop_cancels_pending_retry() {
        let slot=TaskSlot::new(); let started=Arc::new(AtomicUsize::new(0)); let count=started.clone();
        slot.start(async move { sleep(Duration::from_secs(60)).await; count.fetch_add(1,Ordering::SeqCst); }).await;
        slot.stop().await; assert_eq!(started.load(Ordering::SeqCst),0);
    }
    #[test]
    fn retry_budget_is_bounded_and_terminal_errors_stop_immediately() {
        let mut budget=RetryBudget::default();
        let delays:Vec<_>=(0..7).map(|_|budget.next(AuthError::Network).map(|d|d.as_secs())).collect();
        assert_eq!(delays,vec![Some(5),Some(10),Some(20),Some(40),Some(80),Some(120),None]);
        for error in [AuthError::RelinkRequired,AuthError::MissingScopes,AuthError::Configuration,AuthError::Storage] {
            assert!(RetryBudget::default().next(error).is_none());
        }
    }
    #[test]
    fn quick_welcome_does_not_reset_budget_but_stable_connection_does() {
        let mut budget=RetryBudget::default(); budget.next(AuthError::Network);
        budget.healthy(Instant::now()); assert_eq!(budget.failures,1);
        budget.healthy(Instant::now()-Duration::from_secs(301)); assert_eq!(budget.failures,0);
    }
    #[test]
    fn notification_redelivery_is_deduplicated() {
        let mut ids=MessageIds::default(); assert!(ids.first("event-1")); assert!(!ids.first("event-1"));
        assert!(!ids.first("")); assert!(ids.first("event-2"));
    }
    #[tokio::test]
    async fn external_token_refresh_wakes_paused_recovery_without_polling() {
        let (sender,mut receiver)=tokio::sync::watch::channel(0);
        let wait=tokio::spawn(async move { wait_for_retry(None,&mut receiver).await });
        tokio::task::yield_now().await; assert!(!wait.is_finished());
        sender.send_replace(1);
        assert!(timeout(Duration::from_secs(1),wait).await.unwrap().unwrap());
    }

    #[tokio::test]
    async fn server_handover_delivers_old_events_until_new_welcome_and_then_closes_old() {
        let old_listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let new_listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let old_url=format!("ws://{}",old_listener.local_addr().unwrap());
        let new_url=format!("ws://{}",new_listener.local_addr().unwrap());
        let (send_welcome, allow_welcome)=tokio::sync::oneshot::channel();
        let (send_event, allow_event)=tokio::sync::oneshot::channel();
        let old_server=tokio::spawn(async move {
            let (tcp,_)=old_listener.accept().await.unwrap();
            let mut ws=tokio_tungstenite::accept_async(tcp).await.unwrap();
            allow_event.await.unwrap();
            ws.send(Message::Text(json!({"metadata":{"message_type":"notification","message_id":"during-handover"}}).to_string().into())).await.unwrap();
            // The client must deliver this event before the new welcome is allowed.
            let message=timeout(Duration::from_secs(3),ws.next()).await.unwrap().unwrap().unwrap();
            assert!(matches!(message,Message::Close(_)));
        });
        let new_server=tokio::spawn(async move {
            let (tcp,_)=new_listener.accept().await.unwrap();
            let mut ws=tokio_tungstenite::accept_async(tcp).await.unwrap();
            send_event.send(()).unwrap();
            allow_welcome.await.unwrap();
            ws.send(Message::Text(json!({"metadata":{"message_type":"session_welcome"},"payload":{"session":{"id":"replacement"}}}).to_string().into())).await.unwrap();
            // The handover must not send subscription commands over this socket.
            let _=ws.next().await;
        });
        let (mut old,_)=connect_async(old_url).await.unwrap();
        let mut delivered=0;let mut signal=Some(send_welcome);
        let (mut new,welcome)=timeout(Duration::from_secs(5),handover(&mut old,&new_url,|value| {
            assert_eq!(value.pointer("/metadata/message_id").and_then(Value::as_str),Some("during-handover"));
            delivered+=1;signal.take().unwrap().send(()).unwrap();
        })).await.unwrap().unwrap();
        assert_eq!(delivered,1);assert_eq!(welcome.pointer("/payload/session/id").and_then(Value::as_str),Some("replacement"));
        new.close(None).await.unwrap();old_server.await.unwrap();new_server.await.unwrap();
    }

}
