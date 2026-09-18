

export const TWITCH_CLIENT_ID =
  import.meta.env.VITE_TWITCH_CLIENT_ID?.trim() ??
  "";

export const TWITCH_CHANNEL = "sdjfam";

export const ALERT_EVENT_TYPES = new Set([
  "follow",
  "subscription",
  "gift_subscription",
  "bits",
  "raid",
]);
