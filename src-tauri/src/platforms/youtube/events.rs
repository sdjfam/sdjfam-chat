use crate::event_engine::{EventAmount, EventType, EventUser, Platform, SdjfamEvent};
use crate::youtube_api::{live_chat_message_snippet::DisplayedContent, LiveChatMessage};
use serde_json::json;

/// Normalize support events from the checked-in YouTube streamList protobuf.
/// This runs before the chat display filter: stickers/memberships need no text.
pub fn normalize_event(item: &LiveChatMessage) -> Option<SdjfamEvent> {
    let snippet = item.snippet.as_ref()?;
    let id = item.id.as_ref().filter(|id| !id.is_empty())?;
    let content = snippet.displayed_content.as_ref()?;
    let (event_type, raw_type, amount, metadata) = match content {
        DisplayedContent::SuperChatDetails(details) => (
            EventType::SuperChat,
            "youtube.superChatEvent",
            details.amount_micros.map(|micros| {
                EventAmount::new(micros as f64 / 1_000_000.0, details.currency.clone())
            }),
            json!({"tier": details.tier}),
        ),
        DisplayedContent::SuperStickerDetails(details) => (
            EventType::SuperChat,
            "youtube.superStickerEvent",
            details.amount_micros.map(|micros| {
                EventAmount::new(micros as f64 / 1_000_000.0, details.currency.clone())
            }),
            json!({"tier": details.tier}),
        ),
        DisplayedContent::NewSponsorDetails(details) => (
            EventType::MemberJoin,
            "youtube.newSponsorEvent",
            None,
            json!({"level": details.member_level_name, "is_upgrade": details.is_upgrade}),
        ),
        DisplayedContent::MemberMilestoneChatDetails(details) => (
            EventType::MemberJoin,
            "youtube.memberMilestoneChatEvent",
            None,
            json!({"level": details.member_level_name, "months": details.member_month}),
        ),
        DisplayedContent::MembershipGiftingDetails(details) => (
            EventType::GiftSubscription,
            "youtube.membershipGiftingEvent",
            None,
            json!({"total": details.gift_memberships_count, "level": details.gift_memberships_level_name}),
        ),
        DisplayedContent::GiftMembershipReceivedDetails(details) => (
            EventType::MemberJoin,
            "youtube.giftMembershipReceivedEvent",
            None,
            json!({"level": details.member_level_name, "gifter_channel_id": details.gifter_channel_id}),
        ),
        _ => return None,
    };
    let author = item.author_details.as_ref();
    let mut event = SdjfamEvent::new(id.clone(), Platform::YouTube, event_type)
        .with_user(EventUser::new(
            author
                .and_then(|a| a.channel_id.clone())
                .or_else(|| snippet.author_channel_id.clone()),
            None,
            author.and_then(|a| a.display_name.clone()),
        ))
        .with_raw_event_type(raw_type)
        .with_metadata(metadata);
    event.message = snippet
        .display_message
        .as_ref()
        .filter(|message| !message.trim().is_empty())
        .cloned();
    event.amount = amount;
    Some(event)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::youtube_api::{
        LiveChatMembershipGiftingDetails, LiveChatMessageSnippet, LiveChatNewSponsorDetails,
        LiveChatSuperChatDetails, LiveChatSuperStickerDetails,
    };

    fn message(content: DisplayedContent) -> LiveChatMessage {
        LiveChatMessage {
            id: Some("event-123".into()),
            snippet: Some(LiveChatMessageSnippet {
                displayed_content: Some(content),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn super_chat_converts_micros_and_preserves_currency_and_id() {
        let item = message(DisplayedContent::SuperChatDetails(
            LiveChatSuperChatDetails {
                amount_micros: Some(1_750_000),
                currency: Some("EUR".into()),
                ..Default::default()
            },
        ));
        let event = normalize_event(&item).unwrap();
        assert_eq!(event.id, "event-123");
        assert_eq!(event.platform, Platform::YouTube);
        assert_eq!(event.event_type, EventType::SuperChat);
        let amount = event.amount.unwrap();
        assert_eq!(amount.value, 1.75);
        assert_eq!(amount.currency.as_deref(), Some("EUR"));
    }

    #[test]
    fn sticker_without_display_text_still_becomes_an_alert() {
        let event = normalize_event(&message(DisplayedContent::SuperStickerDetails(
            LiveChatSuperStickerDetails::default(),
        )))
        .unwrap();
        assert_eq!(
            event.raw_event_type.as_deref(),
            Some("youtube.superStickerEvent")
        );
        assert!(event.message.is_none());
        assert!(event.amount.is_none());
    }

    #[test]
    fn memberships_preserve_gift_count_and_new_member_type() {
        let event = normalize_event(&message(DisplayedContent::MembershipGiftingDetails(
            LiveChatMembershipGiftingDetails {
                gift_memberships_count: Some(5),
                ..Default::default()
            },
        )))
        .unwrap();
        assert_eq!(event.event_type, EventType::GiftSubscription);
        assert_eq!(event.metadata["total"], 5);
        let member = normalize_event(&message(DisplayedContent::NewSponsorDetails(
            LiveChatNewSponsorDetails::default(),
        )))
        .unwrap();
        assert_eq!(member.event_type, EventType::MemberJoin);
    }

    #[test]
    fn ignores_regular_chat_and_missing_ids() {
        assert!(normalize_event(&LiveChatMessage::default()).is_none());
        let mut item = message(DisplayedContent::NewSponsorDetails(
            LiveChatNewSponsorDetails::default(),
        ));
        item.id = None;
        assert!(normalize_event(&item).is_none());
    }
}
