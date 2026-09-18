export type Platform = "twitch" | "youtube" | "tiktok";

export type ChatMessage = {
  id: string;
  platform: Platform;
  username: string;
  message: string;
};
