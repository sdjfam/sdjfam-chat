import type { PlatformStatsEvent } from "../../stats/types";
import type { TikTokSidecarPayload } from "./types";

const validCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

export function toTikTokStatsEvent(payload: TikTokSidecarPayload): PlatformStatsEvent | null {
  if (payload.platform !== "tiktok" || payload.schemaVersion !== 1 || typeof payload.roomId !== "string" || !payload.roomId) return null;
  if (typeof payload.receivedAt !== "number" || !Number.isFinite(payload.receivedAt)) return null;
  const base = { sessionId: payload.roomId, at: payload.receivedAt, id: typeof payload.eventId === "string" ? payload.eventId : undefined };
  switch (payload.type) {
    case "session":
      return ["connected", "disconnected", "ended"].includes(payload.status ?? "")
        ? { ...base, kind: "session", status: payload.status as "connected" | "disconnected" | "ended" } : null;
    case "viewerCount": return validCount(payload.count) ? { ...base, kind: "viewers", count: payload.count } : null;
    case "like": return validCount(payload.totalLikeCount) ? { ...base, kind: "likes", total: payload.totalLikeCount } : null;
    case "follow": return { ...base, kind: "follow", userId: payload.userId || payload.uniqueId || null };
    case "chat": return payload.message?.trim() ? { ...base, kind: "chat" } : null;
    case "gift":
      if (!validCount(payload.giftType) || (payload.giftType === 1 && payload.repeatEnd !== true)) return null;
      return validCount(payload.repeatCount) && payload.repeatCount > 0
        ? { ...base, kind: "gift", count: payload.repeatCount, diamondsPerGift: validCount(payload.diamondCount) && payload.diamondCount > 0 ? payload.diamondCount : null } : null;
    default: return null;
  }
}
