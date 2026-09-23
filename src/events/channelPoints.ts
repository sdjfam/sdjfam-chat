import type { ChatMessage } from "../types/chat";
import type { SdjfamEvent } from "../types/events";
import { isTestEvent } from "./eventPresentation";

export function channelPointChatMessage(event: SdjfamEvent): ChatMessage | null {
  if (event.platform !== "twitch" || event.event_type !== "channel_points_redemption") return null;
  const metadata = event.metadata as Record<string, unknown> | null;
  const title = metadata?.reward_title;
  const cost = metadata?.reward_cost;
  if (typeof title !== "string" || !title.trim() || typeof cost !== "number" || !Number.isSafeInteger(cost) || cost < 0) return null;
  const input = typeof metadata?.user_input === "string" ? metadata.user_input : "";
  return {
    id: `eventsub:${event.id}`, platform: "twitch",
    username: event.user?.display_name || event.user?.username || "Twitch",
    userId: event.user?.id,
    message: `${isTestEvent(event) ? "[TEST] " : ""}heeft ${title} ingewisseld (${cost.toLocaleString("nl-NL")} punten)`,
    channelPoints: { rewardTitle: title, cost, userInput: input },
  };
}
