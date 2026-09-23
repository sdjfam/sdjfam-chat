

export type Platform =
  | "twitch"
  | "youtube"
  | "tiktok";

export type ChatMessage = {
  id: string;
  platform: Platform;
  username: string;
  message: string;

  channelPoints?: { rewardTitle: string; cost: number; userInput: string };

  userId?: string | null;
  avatarUrl?: string | null;

  support?: {
    gifts?: number;
    giftSubs?: number;
    subs?: number;
    bits?: number;
  };
};

export type ChatUserProfile = {
  platform: Platform;
  userId: string | null;
  username: string;
  avatarUrl: string | null;

  support: {
    gifts: number;
    giftSubs: number;
    subs: number;
    bits: number;
  };
};
