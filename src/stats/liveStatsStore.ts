import type { Platform } from "../types/chat";
import type { PlatformLiveStats, PlatformStatsEvent } from "./types";

export function emptyLiveStats(platform: Platform): PlatformLiveStats {
  return {
    schemaVersion: 1, platform, sessionId: null, connected: false,
    observedSince: null, updatedAt: null, endedAt: null, streamStartedAt: null,
    currentViewers: null, peakViewers: null, averageViewers: null,
    viewerObservedMs: 0, viewerIntegral: 0, lastViewerAt: null,
    totalLikes: null, followersObserved: null, giftsObserved: null,
    diamondsObserved: null, diamondValuesComplete: true, chatMessagesObserved: null,
    estimatedRevenue: null,
  };
}

const count = (value: number) => Number.isSafeInteger(value) && value >= 0;

export class LiveStatsStore {
  snapshot: PlatformLiveStats;
  private seen = new Set<string>();
  constructor(platform: Platform) { this.snapshot = emptyLiveStats(platform); }

  consume(event: PlatformStatsEvent): boolean {
    if (!event.sessionId || !Number.isFinite(event.at)) return false;
    let state = this.snapshot;
    if (event.kind === "session" && event.status === "connected" && event.sessionId !== state.sessionId) {
      state = { ...emptyLiveStats(state.platform), sessionId: event.sessionId, observedSince: event.at };
      this.seen.clear();
    }
    if (event.sessionId !== state.sessionId) return false;
    if (event.kind !== "session" && (!state.connected || state.endedAt !== null)) return false;
    if (event.kind === "viewers" && !count(event.count)) return false;
    if (event.kind === "likes" && !count(event.total)) return false;
    if (event.kind === "gift" && (!count(event.count) || event.count < 1 ||
      (event.diamondsPerGift !== null && (!count(event.diamondsPerGift) || !count(event.count * event.diamondsPerGift))))) return false;

    const identity = event.kind === "follow" && event.userId ? event.userId : event.id;
    const key = identity ? `${event.kind}:${identity}` : null;
    if (key && this.seen.has(key)) return false;
    if (key) {
      this.seen.add(key);
      if (this.seen.size > 10000) this.seen.delete(this.seen.values().next().value!);
    }
    const at = Math.max(state.updatedAt ?? event.at, event.at);
    state = { ...state, updatedAt: at };
    if (event.kind === "viewers" || event.kind === "session") {
      if (state.connected && state.lastViewerAt !== null && state.currentViewers !== null) {
        const elapsed = Math.max(0, at - state.lastViewerAt);
        state.viewerObservedMs += elapsed;
        state.viewerIntegral += state.currentViewers * elapsed;
        if (state.viewerObservedMs > 0) state.averageViewers = state.viewerIntegral / state.viewerObservedMs;
      }
    }
    switch (event.kind) {
      case "session":
        state.connected = event.status === "connected" && state.endedAt === null;
        if (event.status === "ended") state.endedAt = at;
        // Never integrate over a disconnected period; keep counters for same-room reconnect.
        state.currentViewers = null;
        state.lastViewerAt = null;
        break;
      case "viewers":
        state.currentViewers = event.count;
        state.peakViewers = Math.max(state.peakViewers ?? event.count, event.count);
        state.lastViewerAt = at;
        break;
      case "likes": state.totalLikes = Math.max(state.totalLikes ?? event.total, event.total); break;
      case "follow": state.followersObserved = (state.followersObserved ?? 0) + 1; break;
      case "chat": state.chatMessagesObserved = (state.chatMessagesObserved ?? 0) + 1; break;
      case "gift":
        state.giftsObserved = (state.giftsObserved ?? 0) + event.count;
        if (event.diamondsPerGift === null) state.diamondValuesComplete = false;
        else state.diamondsObserved = (state.diamondsObserved ?? 0) + event.diamondsPerGift * event.count;
        break;
    }
    this.snapshot = state;
    return true;
  }

  disconnect(at = Date.now()) {
    const sessionId = this.snapshot.sessionId;
    return sessionId !== null && this.consume({ kind: "session", status: "disconnected", sessionId, at });
  }
}
