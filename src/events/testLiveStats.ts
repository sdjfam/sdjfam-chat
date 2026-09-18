import { emptyLiveStats } from "../stats/liveStatsStore";

// Presentation-only fixture: never send this to sidecar/events/storage/diagnostics.
// No session identity or observation timestamps: this is not a recorded stream.
export const TIKTOK_STATS_PREVIEW = Object.freeze({
  ...emptyLiveStats("tiktok"),
  connected: true,
  currentViewers: 47,
  totalLikes: 12400,
  giftsObserved: 85,
  diamondsObserved: 850,
  followersObserved: 14,
});
