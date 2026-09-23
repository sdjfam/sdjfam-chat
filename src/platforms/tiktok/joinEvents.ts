import type { SdjfamEvent } from "../../types/events";
import type { TikTokSidecarPayload } from "./types";

export function toTikTokJoinEvent(payload: TikTokSidecarPayload): SdjfamEvent | null {
  if (payload.platform !== "tiktok" || payload.type !== "join" || typeof payload.eventId !== "string" || !payload.eventId) return null;
  const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
  const username = text(payload.uniqueId);
  const name = text(payload.username) || username;
  if (!name) return null;
  return {
    id: `join:${text(payload.roomId)}:${payload.eventId}`, platform: "tiktok", event_type: "viewer_join",
    user: { id: text(payload.userId) || null, username: username || null, display_name: name },
    message: null, raw_event_type: "tiktok.member", metadata: { room_id: text(payload.roomId) },
  };
}
