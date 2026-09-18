import type { Platform } from "../types/chat";

/** Serializable per-room observation, ready for a future history store. */
export type PlatformLiveStats = {
  schemaVersion: 1;
  platform: Platform;
  sessionId: string | null;
  connected: boolean;
  observedSince: number | null;
  updatedAt: number | null;
  endedAt: number | null;
  // Actual broadcast start is not supplied by this adapter.
  streamStartedAt: number | null;
  currentViewers: number | null;
  peakViewers: number | null;
  averageViewers: number | null;
  viewerObservedMs: number;
  viewerIntegral: number;
  lastViewerAt: number | null;
  totalLikes: number | null;
  followersObserved: number | null;
  giftsObserved: number | null;
  diamondsObserved: number | null;
  diamondValuesComplete: boolean;
  chatMessagesObserved: number | null;
  // No currency conversion without an explicit, documented estimation method.
  estimatedRevenue: { amount: number; currency: string; method: string } | null;
};

export type PlatformStatsEvent = {
  sessionId: string;
  at: number;
  id?: string;
} & (
  | { kind: "session"; status: "connected" | "disconnected" | "ended" }
  | { kind: "viewers"; count: number }
  | { kind: "likes"; total: number }
  | { kind: "follow"; userId: string | null }
  | { kind: "gift"; count: number; diamondsPerGift: number | null }
  | { kind: "chat" }
);
