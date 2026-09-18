

export type YouTubeLoginResult = {
  message: string;
  video_id: string;
  live_chat_id: string;
  title: string;
};

export type YouTubeAutoConnectResult = {
  connected: boolean;
  needs_relogin: boolean;
  live: boolean;
  discovery_available: boolean;
  message: string;
  video_id: string | null;
  live_chat_id: string | null;
  title: string | null;
};

export type YouTubeAuthStatus = {
  connected: boolean;
  linked_at: string | null;
  expected_expiry_at: string | null;
  seconds_remaining: number;
  needs_relogin: boolean;
  expired: boolean;
  message: string;
};

export type YouTubeGrpcChatMessage = {
  id: string;
  author: string;
  message: string;
  published_at: string | null;
  message_type: number;
  channel_id: string | null;
  is_verified: boolean;
  is_chat_owner: boolean;
  is_chat_sponsor: boolean;
  is_chat_moderator: boolean;
};

export type YouTubeGrpcStatus = {
  connected: boolean;
  status: string;
  message: string;
};

export type YouTubeViewerResult = {
  connected: boolean;
  live: boolean;
  viewer_count: number | null;
  message: string;
};
