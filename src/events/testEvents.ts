import type { Platform } from "../types/chat";
import type { SdjfamEvent } from "../types/events";

export const TEST_EVENTS: { platform: Platform; type: string; label: string }[] = [
  { platform: "twitch", type: "follow", label: "Volger" },
  { platform: "twitch", type: "subscription", label: "Abonnement" },
  { platform: "twitch", type: "gift_subscription", label: "5 cadeau-subs" },
  { platform: "twitch", type: "bits", label: "100 bits" },
  { platform: "twitch", type: "raid", label: "Raid" },
  { platform: "youtube", type: "super_chat", label: "Super Chat" },
  { platform: "youtube", type: "super_sticker", label: "Super Sticker" },
  { platform: "youtube", type: "member_join", label: "Nieuw lid" },
  { platform: "youtube", type: "gift_subscription", label: "5 cadeaulidmaatschappen" },
  { platform: "tiktok", type: "gift", label: "Gift" },
];

export function createTestEvent(platform: Platform, type: string): SdjfamEvent {
  if (!TEST_EVENTS.some(option => option.platform === platform && option.type === type)) throw new Error("Onbekend testevent");
  const messages: Record<string, string> = {
    follow: "volgt het kanaal", subscription: "heeft zich geabonneerd",
    gift_subscription: platform === "youtube" ? "geeft 5 lidmaatschappen cadeau" : "geeft 5 subs cadeau",
    bits: "heeft 100 bits gecheerd", raid: "raidt met 25 kijkers",
    super_chat: "Wat een fijne stream!", super_sticker: "Bedankt voor de stream!",
    member_join: "is lid geworden", gift: "Roos × 3",
  };
  return {
    id: `test-${crypto.randomUUID()}`, platform,
    event_type: type === "super_sticker" ? "super_chat" : type,
    user: { username: "testviewer", display_name: "Testkijker" },
    message: messages[type],
    amount: type.startsWith("super_") ? { value: 5, currency: "EUR" } : type === "bits" ? { value: 100, currency: "BITS" } : null,
    raw_event_type: `simulated.${type === "super_sticker" ? "superStickerEvent" : type}`,
    metadata: { total: 5, viewers: 25, gift_name: "Roos", repeat_count: 3 },
  };
}
