import { recordDiagnosticEvent } from "../../diagnostics";
import type { SdjfamEvent } from "../../types/events";
import { isTestEvent } from "../../events/eventPresentation";
import { isTikTokGiftInProgress } from "./giftEvents";

// Whitelisted, bounded fields only. Existing diagnostics performs secret redaction.
export function createTikTokEventDiagnostics() {
  let windowStart = 0, emitted = 0, suppressed = 0;
  const text = (value: unknown) => typeof value === "string" ? value.replace(/[\r\n|]/g, " ").slice(0, 120) : null;
  const number = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  return (event: SdjfamEvent, now = Date.now()) => {
    if (isTestEvent(event)) return;
    const progress = isTikTokGiftInProgress(event);
    const join = event.event_type === "viewer_join";
    if (now - windowStart >= 1000) { windowStart = now; emitted = 0; }
    // Final gifts always log. Bursts of joins/progress have an explicit suppression count.
    if ((join || progress) && emitted >= 20) { suppressed++; return; }
    if (join || progress) emitted++;
    const meta = event.metadata as Record<string, unknown> | null;
    recordDiagnosticEvent("tiktok", join ? "viewer_join" : progress ? "gift_progress" : "gift", {
      id: text(event.id), sender: text(event.user?.display_name) || text(event.user?.username),
      sender_id: text(event.user?.id), room_id: text(meta?.room_id),
      ...(join ? {} : { gift: text(meta?.gift_name), gift_id: text(String(meta?.gift_id ?? "")),
        repeat_count: number(meta?.repeat_count), repeat_end: meta?.repeat_end === true,
        gift_type: number(meta?.gift_type), group_id: text(meta?.group_id), diamonds: number(meta?.diamond_count) }),
      ...(suppressed ? { suppressed_details: suppressed } : {}),
    });
    suppressed = 0;
  };
}
