import type { Platform } from "../types/chat";

export function getPlatformLabel(
  platform: Platform
): string {
  switch(platform) {
    case "twitch":
      return "Twitch";

    case "youtube":
      return "YouTube";

    case "tiktok":
      return "TikTok";
  }
}
