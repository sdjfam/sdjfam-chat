import { TikTokIcon } from "../platforms/tiktok/TikTokIcon";
import { TwitchIcon } from "../platforms/twitch/TwitchIcon";
import { YouTubeIcon } from "../platforms/youtube/YouTubeIcon";
import type { Platform } from "../types/chat";

export function PlatformIcon({
  platform,
}: {
  platform: Platform;
}) {
  switch(platform) {
    case "twitch":
      return <TwitchIcon />;

    case "youtube":
      return <YouTubeIcon />;

    case "tiktok":
      return <TikTokIcon />;
  }
}
