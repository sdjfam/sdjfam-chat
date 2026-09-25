import type { SdjfamEvent } from "../../types/events";
import type { TikTokSidecarPayload } from "./types";

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function toTikTokGiftEvent(payload: TikTokSidecarPayload): SdjfamEvent | null {
  if (payload.type !== "gift" || payload.platform !== "tiktok" || !text(payload.eventId) || !count(payload.repeatCount)) return null;
  const name = text(payload.giftName) || "TikTok Gift";
  return {
    id: payload.eventId!, platform: "tiktok", event_type: "gift",
    user: { id: text(payload.userId) || text(payload.uniqueId) || null,
      username: text(payload.uniqueId) || null,
      display_name: text(payload.username) || text(payload.uniqueId) || "TikTok Viewer" },
    message: `${name} ×${payload.repeatCount}`, amount: null, raw_event_type: "tiktok_gift",
    metadata: { gift_name: name, gift_id: payload.giftId ?? null, repeat_count: payload.repeatCount,
      diamond_count: payload.diamondCount ?? null, gift_type: payload.giftType ?? null,
      repeat_end: payload.repeatEnd === true, group_id: text(payload.groupId) || null,
      room_id: text(payload.roomId) || null },
  };
}

export function isTikTokGiftInProgress(event: SdjfamEvent): boolean {
  const meta = event.metadata as Record<string, unknown> | null;
  return event.platform === "tiktok" && event.event_type === "gift" && meta?.gift_type === 1 && meta.repeat_end === false;
}

export function getTikTokGiftDetails(event: SdjfamEvent): string | null {
  if (event.platform !== "tiktok" || event.event_type !== "gift") return null;
  const meta = event.metadata as Record<string, unknown> | null;
  return `${text(meta?.gift_name) || "TikTok Gift"}${count(meta?.repeat_count) ? ` ×${meta.repeat_count}` : ""}`;
}

export function createTikTokGiftDeduplicator(limit = 1000) {
  const seen = new Map<string, { count: number; complete: boolean }>();
  return (event: SdjfamEvent): boolean => {
    const meta = event.metadata as Record<string, unknown> | null;
    if (!event.id || !count(meta?.repeat_count)) return false;
    const progress = isTikTokGiftInProgress(event);
    const previous = seen.get(event.id);
    if (previous?.complete || (progress && previous && meta.repeat_count <= previous.count)) return false;
    seen.delete(event.id);
    seen.set(event.id, { count: meta.repeat_count, complete: !progress });
    if (seen.size > limit) seen.delete(seen.keys().next().value!);
    return true;
  };
}
