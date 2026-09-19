

export type TwitchUserProfileResult = {
  id: string;
  login: string;
  display_name: string;
  profile_image_url: string;
};

export type TwitchAuthStatus = {
  validation_status: string;
  connected: boolean;
  linked_at: string | null;
  expected_expiry_at: string | null;
  seconds_remaining: number;
  needs_relogin: boolean;
  expired: boolean;
  message: string;
};

export type TwitchLoginResult = {
  connected: boolean;
  message: string;
};

export type TwitchEventSubStatus = {
  status: string;
  message: string;
};

export type TwitchViewerResult = {
  connected: boolean;
  live: boolean;
  viewer_count: number | null;
  message: string;
};
