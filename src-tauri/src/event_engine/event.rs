use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Platform {
    Twitch,
    YouTube,
    TikTok,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EventType {
    ChatMessage,
    Follow,
    Subscription,
    GiftSubscription,
    Bits,
    Raid,
    Donation,
    MemberJoin,
    SuperChat,
    Gift,
    Like,
    ViewerJoin,
    StreamOnline,
    StreamOffline,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventUser {
    pub id: Option<String>,
    pub username: Option<String>,
    pub display_name: Option<String>,
}

impl EventUser {
    pub fn new(
        id: Option<String>,
        username: Option<String>,
        display_name: Option<String>,
    ) -> Self {
        Self {
            id,
            username,
            display_name,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventAmount {
    pub value: f64,
    pub currency: Option<String>,
}

impl EventAmount {
    pub fn new(
        value: f64,
        currency: Option<String>,
    ) -> Self {
        Self {
            value,
            currency,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SdjfamEvent {
    pub id: String,
    pub platform: Platform,
    pub event_type: EventType,
    pub timestamp: DateTime<Utc>,
    pub user: Option<EventUser>,
    pub message: Option<String>,
    pub amount: Option<EventAmount>,
    pub raw_event_type: Option<String>,
    pub metadata: serde_json::Value,
}

impl SdjfamEvent {
    pub fn new(
        id: impl Into<String>,
        platform: Platform,
        event_type: EventType,
    ) -> Self {
        Self {
            id: id.into(),
            platform,
            event_type,
            timestamp: Utc::now(),
            user: None,
            message: None,
            amount: None,
            raw_event_type: None,
            metadata: serde_json::Value::Null,
        }
    }

    pub fn with_user(
        mut self,
        user: EventUser,
    ) -> Self {
        self.user = Some(user);
        self
    }

    pub fn with_message(
        mut self,
        message: impl Into<String>,
    ) -> Self {
        self.message = Some(message.into());
        self
    }

    pub fn with_amount(
        mut self,
        amount: EventAmount,
    ) -> Self {
        self.amount = Some(amount);
        self
    }

    pub fn with_raw_event_type(
        mut self,
        raw_event_type: impl Into<String>,
    ) -> Self {
        self.raw_event_type = Some(raw_event_type.into());
        self
    }

    pub fn with_metadata(
        mut self,
        metadata: serde_json::Value,
    ) -> Self {
        self.metadata = metadata;
        self
    }
}