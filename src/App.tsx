import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  listen,
  type UnlistenFn,
} from "@tauri-apps/api/event";
import { check } from "@tauri-apps/plugin-updater";
import {
  Command,
  type Child,
} from "@tauri-apps/plugin-shell";
import tmi from "tmi.js";

import AlertOverlay from "./alerts/AlertOverlay";

import {
  diagnosticError,
  diagnosticLog,
  incrementDiagnosticCounter,
  recordChatMessage,
  recordConnectionState,
  recordDiagnosticEvent,
  recordViewerCount,
  startFrontendDiagnostics,
  updateDiagnosticSnapshot,
  updatePlatformDiagnosticState,
} from "./diagnostics";

import "./App.css";

// =========================================================
// TYPES
// =========================================================

type Platform =
  | "twitch"
  | "youtube"
  | "tiktok";

type ChatMessage = {
  id: string;
  platform: Platform;
  username: string;
  message: string;
};

type YouTubeLoginResult = {
  message: string;
  video_id: string;
  live_chat_id: string;
  title: string;
};

type YouTubeAutoConnectResult = {
  connected: boolean;
  needs_relogin: boolean;
  live: boolean;
  discovery_available: boolean;
  message: string;
  video_id: string | null;
  live_chat_id: string | null;
  title: string | null;
};

type YouTubeAuthStatus = {
  connected: boolean;
  linked_at: string | null;
  expected_expiry_at: string | null;
  seconds_remaining: number;
  needs_relogin: boolean;
  expired: boolean;
  message: string;
};

type YouTubeGrpcChatMessage = {
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

type YouTubeGrpcStatus = {
  connected: boolean;
  status: string;
  message: string;
};

type TwitchAuthStatus = {
  connected: boolean;
  linked_at: string | null;
  expected_expiry_at: string | null;
  seconds_remaining: number;
  needs_relogin: boolean;
  expired: boolean;
  message: string;
};

type TwitchLoginResult = {
  connected: boolean;
  message: string;
};

type TwitchEventSubStatus = {
  status: string;
  message: string;
};

type TwitchViewerResult = {
  connected: boolean;
  live: boolean;
  viewer_count: number | null;
  message: string;
};

type YouTubeViewerResult = {
  connected: boolean;
  live: boolean;
  viewer_count: number | null;
  message: string;
};

type TikTokSidecarPayload = {
  type?: string;
  platform?: string;

  username?: string;
  uniqueId?: string;
  message?: string;

  count?: number;

  giftName?: string;
  giftId?: string | number;
  repeatCount?: number;
  diamondCount?: number;

  eventType?: string;
  status?: string;
};

export type SdjfamEvent = {
  id: string;
  platform: Platform | "system";
  event_type: string;

  user: {
    id?: string | null;
    username: string | null;
    display_name: string | null;
  } | null;

  message: string | null;

  amount?: {
    value: number;
    currency: string | null;
  } | null;

  raw_event_type?: string | null;
  metadata?: unknown;
};

// =========================================================
// GLOBAL CONSTANTS
// =========================================================

let twitchEventSubLifecycle: Promise<void> =
  Promise.resolve();

const TWITCH_CLIENT_ID =
  import.meta.env.VITE_TWITCH_CLIENT_ID?.trim() ??
  "";

const TWITCH_CHANNEL = "sdjfam";
const TIKTOK_USERNAME = "sdjfam1";

const ALERT_EVENT_TYPES = new Set([
  "follow",
  "subscription",
  "gift_subscription",
  "bits",
  "raid",
]);

// =========================================================
// HELPERS
// =========================================================

function eventSubNeedsRelogin(
  status: TwitchEventSubStatus
): boolean {
  return (
    status.status === "auth_error" ||
    status.status === "revoked" ||
    /ontbrekende rechten|scope|opnieuw.*koppel|koppel.*opnieuw|niet gekoppeld|nog niet gekoppeld|401|403/i.test(
      status.message
    )
  );
}

function formatRemainingTime(
  seconds: number
): string {
  if (seconds <= 0) {
    return "verlopen";
  }

  const totalHours =
    Math.floor(seconds / 3600);

  const days =
    Math.floor(totalHours / 24);

  const hours =
    totalHours % 24;

  if (days > 0) {
    return `${days} dagen ${hours} uur`;
  }

  const minutes =
    Math.floor(
      (seconds % 3600) / 60
    );

  if (hours > 0) {
    return `${hours} uur ${minutes} min`;
  }

  return `${Math.max(minutes, 1)} min`;
}

function normalizeViewerCount(
  value: number | null
): number | null {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value)
  ) {
    return null;
  }

  return Math.max(
    0,
    Math.trunc(value)
  );
}

// =========================================================
// ICONS
// =========================================================

function TwitchIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="M4 2h17v11.2l-4.8 4.8h-3.7L10 20.5H7.5V18H3V5L4 2Zm1.5 2L5 5.5V16h4.5v2.3l2.3-2.3h4l3.2-3.2V4H5.5Zm5 3h2v5h-2V7Zm5 0h2v5h-2V7Z"
      />
    </svg>
  );
}

function YouTubeIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="M21.6 7.2a3 3 0 0 0-2.1-2.1C17.6 4.6 12 4.6 12 4.6s-5.6 0-7.5.5A3 3 0 0 0 2.4 7.2 31 31 0 0 0 2 12a31 31 0 0 0 .4 4.8 3 3 0 0 0 2.1 2.1c1.9.5 7.5.5 7.5.5s5.6 0 7.5-.5a3 3 0 0 0 2.1-2.1A31 31 0 0 0 22 12a31 31 0 0 0-.4-4.8ZM10 15.5v-7l6 3.5-6 3.5Z"
      />
    </svg>
  );
}

function TikTokIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="M15.3 3c.3 2.2 1.6 3.6 3.7 3.8v3.1a8.4 8.4 0 0 1-3.7-.9v6.3a5.7 5.7 0 1 1-4.9-5.6v3.2a2.5 2.5 0 1 0 1.7 2.4V3h3.2Z"
      />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="M19.1 13a7.7 7.7 0 0 0 .1-1 7.7 7.7 0 0 0-.1-1l2.1-1.6-2-3.4-2.5 1a7.7 7.7 0 0 0-1.7-1L14.6 3h-4l-.4 3a7.7 7.7 0 0 0-1.7 1L6 6 4 9.4 6.1 11a7.7 7.7 0 0 0-.1 1 7.7 7.7 0 0 0 .1 1L4 14.6 6 18l2.5-1a7.7 7.7 0 0 0 1.7 1l.4 3h4l.4-3a7.7 7.7 0 0 0 1.7-1l2.5 1 2-3.4L19.1 13ZM12.6 16A4 4 0 1 1 12.6 8a4 4 0 0 1 0 8Z"
      />
    </svg>
  );
}

function PlatformIcon({
  platform,
}: {
  platform: Platform;
}) {
  switch (platform) {
    case "twitch":
      return <TwitchIcon />;

    case "youtube":
      return <YouTubeIcon />;

    case "tiktok":
      return <TikTokIcon />;
  }
}

function getPlatformLabel(
  platform: Platform
): string {
  switch (platform) {
    case "twitch":
      return "Twitch";

    case "youtube":
      return "YouTube";

    case "tiktok":
      return "TikTok";
  }
}

// =========================================================
// APP
// =========================================================

function App() {
  // =======================================================
  // DIAGNOSTICS START
  // =======================================================

  useEffect(() => {
    const stopDiagnostics =
      startFrontendDiagnostics();

    return () => {
      stopDiagnostics();
    };
  }, []);

  // =======================================================
  // CHAT STATE
  // =======================================================

  const [
    messages,
    setMessages,
  ] =
    useState<ChatMessage[]>([]);

  const messageListRef =
    useRef<HTMLDivElement | null>(null);

  // =======================================================
  // ALERT STATE
  // =======================================================

  const [
    activeAlert,
    setActiveAlert,
  ] =
    useState<SdjfamEvent | null>(null);

  const [
    alertQueue,
    setAlertQueue,
  ] =
    useState<SdjfamEvent[]>([]);

  // =======================================================
  // TWITCH STATE
  // =======================================================

  const [
    twitchConnected,
    setTwitchConnected,
  ] =
    useState(false);

  const [
    twitchViewerCount,
    setTwitchViewerCount,
  ] =
    useState<number | null>(null);

  const [
    twitchViewerLive,
    setTwitchViewerLive,
  ] =
    useState(false);

  const [
    twitchAuthStatus,
    setTwitchAuthStatus,
  ] =
    useState<TwitchAuthStatus | null>(
      null
    );

  const [
    twitchOauthLoading,
    setTwitchOauthLoading,
  ] =
    useState(false);

  const [
    twitchOauthStatus,
    setTwitchOauthStatus,
  ] =
    useState("");

  const [
    twitchEventSubStatus,
    setTwitchEventSubStatus,
  ] =
    useState<TwitchEventSubStatus>({
      status: "idle",
      message:
        "Twitch EventSub voorbereiden...",
    });

  const [
    twitchEventSubGeneration,
    setTwitchEventSubGeneration,
  ] =
    useState(0);

  const twitchEventIdsRef =
    useRef<Set<string>>(
      new Set()
    );

  // =======================================================
  // EVENT SIMULATOR STATE
  // =======================================================

  const [
    eventSimulatorLoading,
    setEventSimulatorLoading,
  ] =
    useState<string | null>(null);

  const [
    eventSimulatorStatus,
    setEventSimulatorStatus,
  ] =
    useState("");

  // =======================================================
  // TIKTOK STATE
  // =======================================================

  const [
    tiktokConnected,
    setTikTokConnected,
  ] =
    useState(false);

  const [
    tiktokViewerCount,
    setTikTokViewerCount,
  ] =
    useState<number | null>(null);

  const tiktokChildRef =
    useRef<Child | null>(null);

  // =======================================================
  // YOUTUBE STATE
  // =======================================================

  const [
    youtubeConnected,
    setYoutubeConnected,
  ] =
    useState(false);

  const [
    youtubeStatus,
    setYoutubeStatus,
  ] =
    useState(
      "YouTube nog niet gekoppeld"
    );

  const [
    youtubeLiveChatId,
    setYoutubeLiveChatId,
  ] =
    useState<string | null>(null);

  const [
    youtubeVideoId,
    setYoutubeVideoId,
  ] =
    useState<string | null>(null);

  const [
    youtubeTitle,
    setYoutubeTitle,
  ] =
    useState<string | null>(null);

  const [
    youtubeViewerCount,
    setYoutubeViewerCount,
  ] =
    useState<number | null>(null);

  const [
    youtubeViewerLive,
    setYoutubeViewerLive,
  ] =
    useState(false);

  const youtubeMessageIdsRef =
    useRef<Set<string>>(
      new Set()
    );

  // =======================================================
  // SETTINGS STATE
  // =======================================================

  const [
    settingsOpen,
    setSettingsOpen,
  ] =
    useState(false);

  // =======================================================
  // YOUTUBE OAUTH STATE
  // =======================================================

  const [
    oauthLoading,
    setOauthLoading,
  ] =
    useState(false);

  const [
    autoConnectLoading,
    setAutoConnectLoading,
  ] =
    useState(true);

  const [
    oauthStatus,
    setOauthStatus,
  ] =
    useState("");

  const [
    authStatus,
    setAuthStatus,
  ] =
    useState<YouTubeAuthStatus | null>(
      null
    );

  // =======================================================
  // UPDATER STATE
  // =======================================================

  const [
    updateVersion,
    setUpdateVersion,
  ] =
    useState<string | null>(null);

  const [
    updateInstalling,
    setUpdateInstalling,
  ] =
    useState(false);

  const [
    updateStatus,
    setUpdateStatus,
  ] =
    useState("");

  const [
    updateNotes,
    setUpdateNotes,
  ] =
    useState("");

  const [
    updatePopupOpen,
    setUpdatePopupOpen,
  ] =
    useState(false);

  const updateRef =
    useRef<
      Awaited<
        ReturnType<typeof check>
      >
    >(null);

  // =======================================================
  // DERIVED STATE
  // =======================================================

  const youtubePlatformActive =
    youtubeConnected ||
    youtubeViewerLive;

  // =======================================================
  // ALERT QUEUE
  // =======================================================

  useEffect(() => {
    if (!activeAlert) {
      return;
    }

    const timer =
      window.setTimeout(() => {
        setActiveAlert(null);
      }, 5000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [activeAlert]);

  useEffect(() => {
    if (
      activeAlert ||
      alertQueue.length === 0
    ) {
      return;
    }

    const nextAlert =
      alertQueue[0];

    setActiveAlert(nextAlert);

    setAlertQueue(
      (currentQueue) =>
        currentQueue.slice(1)
    );
  }, [
    activeAlert,
    alertQueue,
  ]);

  // =======================================================
  // DIAGNOSTIC LIVE SNAPSHOT
  // =======================================================

  useEffect(() => {
    updateDiagnosticSnapshot({
      twitchConnected,
      twitchViewerCount,

      youtubeConnected,
      youtubeViewerCount,

      tiktokConnected,
      tiktokViewerCount,

      youtubeChatStatus:
        youtubeConnected
          ? "connected"
          : "disconnected",

      twitchEventSubStatus:
        twitchEventSubStatus.status,

      tiktokSidecarRunning:
        tiktokChildRef.current !== null,
    });
  }, [
    twitchConnected,
    twitchViewerCount,
    youtubeConnected,
    youtubeViewerCount,
    tiktokConnected,
    tiktokViewerCount,
    twitchEventSubStatus.status,
  ]);

  // =======================================================
  // UPDATER
  // =======================================================

  useEffect(() => {
    let cancelled = false;

    async function checkForUpdates() {
      diagnosticLog(
        "UPDATER",
        "Update check started"
      );

      recordDiagnosticEvent(
        "app",
        "updater",
        {
          action: "check_started",
        }
      );

      try {
        const update =
          await check({
            timeout: 30000,
          });

        if (cancelled) {
          if (update) {
            await update
              .close()
              .catch(() => {});
          }

          return;
        }

        if (!update) {
          updateRef.current = null;

          setUpdateVersion(null);
          setUpdateNotes("");
          setUpdatePopupOpen(false);
          setUpdateStatus("");

          recordDiagnosticEvent(
            "app",
            "updater",
            {
              action:
                "no_update_available",
            }
          );

          return;
        }

        updateRef.current =
          update;

        setUpdateVersion(
          update.version
        );

        const notes =
          typeof update.body ===
          "string"
            ? update.body.trim()
            : "";

        setUpdateNotes(
          notes ||
            "Deze update bevat verbeteringen en bugfixes."
        );

        setUpdatePopupOpen(true);

        setUpdateStatus(
          `Versie ${update.version} is beschikbaar`
        );

        recordDiagnosticEvent(
          "app",
          "updater",
          {
            action:
              "update_available",
            version:
              update.version,
          }
        );
      } catch (error) {
        console.warn(
          "Updatecontrole niet beschikbaar:",
          error
        );

        diagnosticError(
          "UPDATER",
          error
        );
      }
    }

    void checkForUpdates();

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleInstallUpdate() {
    const update =
      updateRef.current;

    if (
      !update ||
      updateInstalling
    ) {
      return;
    }

    try {
      setUpdateInstalling(true);

      recordDiagnosticEvent(
        "app",
        "updater",
        {
          action:
            "install_started",
          version:
            update.version,
        }
      );

      setUpdateStatus(
        `Update ${update.version} downloaden...`
      );

      let downloaded = 0;

      let contentLength:
        | number
        | undefined;

      await update.downloadAndInstall(
        (event) => {
          switch (
            event.event
          ) {
            case "Started":
              contentLength =
                event.data
                  .contentLength;

              diagnosticLog(
                "UPDATER",
                `download_started version=${update.version}`
              );

              setUpdateStatus(
                `Update ${update.version} downloaden...`
              );

              break;

            case "Progress":
              downloaded +=
                event.data
                  .chunkLength;

              if (
                contentLength &&
                contentLength > 0
              ) {
                const percentage =
                  Math.min(
                    100,
                    Math.round(
                      (
                        downloaded /
                        contentLength
                      ) * 100
                    )
                  );

                setUpdateStatus(
                  `Update ${update.version} downloaden... ${percentage}%`
                );
              }

              break;

            case "Finished":
              diagnosticLog(
                "UPDATER",
                `download_finished version=${update.version}`
              );

              setUpdateStatus(
                "Update gedownload. Installeren..."
              );

              break;
          }
        }
      );

      setUpdateStatus(
        "Update wordt geïnstalleerd..."
      );

      recordDiagnosticEvent(
        "app",
        "updater",
        {
          action:
            "install_triggered",
          version:
            update.version,
        }
      );
    } catch (error) {
      console.error(
        "Update installeren mislukt:",
        error
      );

      diagnosticError(
        "UPDATER",
        error
      );

      setUpdateStatus(
        `Update mislukt: ${String(
          error
        )}`
      );

      setUpdateInstalling(false);
    }
  }

  // =======================================================
  // YOUTUBE AUTH
  // =======================================================

  async function refreshAuthStatus() {
    try {
      const result =
        await invoke<YouTubeAuthStatus>(
          "youtube_auth_status"
        );

      setAuthStatus(result);

      recordDiagnosticEvent(
        "youtube",
        "auth",
        {
          connected:
            result.connected,
          expired:
            result.expired,
          needs_relogin:
            result.needs_relogin,
        }
      );
    } catch (error) {
      console.error(
        "YouTube auth status error:",
        error
      );

      setAuthStatus(null);

      diagnosticError(
        "YOUTUBE_AUTH",
        error
      );
    }
  }

  useEffect(() => {
    void refreshAuthStatus();

    const timer =
      window.setInterval(() => {
        void refreshAuthStatus();
      }, 60000);

    return () => {
      window.clearInterval(
        timer
      );
    };
  }, []);

  // =======================================================
  // YOUTUBE AUTO CONNECT
  // =======================================================

  useEffect(() => {
    let cancelled = false;

    async function autoConnectYouTube() {
      try {
        setAutoConnectLoading(
          true
        );

        setYoutubeStatus(
          "YouTube automatisch verbinden..."
        );

        recordDiagnosticEvent(
          "youtube",
          "connect",
          {
            method:
              "auto_connect_started",
          }
        );

        const result =
          await invoke<YouTubeAutoConnectResult>(
            "youtube_auto_connect"
          );

        if (cancelled) {
          return;
        }

        if (
          result.needs_relogin
        ) {
          setYoutubeConnected(
            false
          );

          setYoutubeViewerLive(
            false
          );

          setYoutubeLiveChatId(
            null
          );

          setYoutubeVideoId(
            null
          );

          setYoutubeTitle(null);

          setYoutubeStatus(
            "Google opnieuw koppelen"
          );

          setOauthStatus(
            result.message
          );

          recordDiagnosticEvent(
            "youtube",
            "auth",
            {
              status:
                "needs_relogin",
            }
          );

          await refreshAuthStatus();

          return;
        }

        if (
          !result.discovery_available
        ) {
          setYoutubeConnected(
            false
          );

          setYoutubeViewerLive(
            false
          );

          setYoutubeLiveChatId(
            null
          );

          setYoutubeVideoId(
            null
          );

          setYoutubeTitle(null);

          setYoutubeStatus(
            "YouTube livestream-detectie tijdelijk niet beschikbaar"
          );

          setOauthStatus(
            result.message
          );

          recordDiagnosticEvent(
            "youtube",
            "status",
            {
              discovery_available:
                false,
            }
          );

          return;
        }

        if (!result.live) {
          setYoutubeConnected(
            false
          );

          setYoutubeViewerLive(
            false
          );

          setYoutubeLiveChatId(
            null
          );

          setYoutubeVideoId(
            null
          );

          setYoutubeTitle(null);

          setYoutubeStatus(
            "Geen actieve YouTube livestream"
          );

          setOauthStatus(
            result.message
          );

          recordConnectionState(
            "youtube",
            false,
            "No active livestream"
          );

          return;
        }

        setYoutubeViewerLive(
          true
        );

        if (
          !result.live_chat_id
        ) {
          setYoutubeConnected(
            false
          );

          setYoutubeLiveChatId(
            null
          );

          setYoutubeVideoId(
            result.video_id
          );

          setYoutubeTitle(
            result.title
          );

          setYoutubeStatus(
            "YouTube live, maar livechat niet gevonden"
          );

          setOauthStatus(
            "De actieve YouTube-stream heeft geen live chat."
          );

          recordDiagnosticEvent(
            "youtube",
            "status",
            {
              live: true,
              live_chat: false,
            }
          );

          return;
        }

        setYoutubeLiveChatId(
          result.live_chat_id
        );

        setYoutubeVideoId(
          result.video_id
        );

        setYoutubeTitle(
          result.title
        );

        setYoutubeStatus(
          "YouTube livechat gevonden"
        );

        setOauthStatus(
          result.title
            ? `${result.message} • ${result.title}`
            : result.message
        );

        recordDiagnosticEvent(
          "youtube",
          "status",
          {
            live: true,
            live_chat: true,
          }
        );

        await refreshAuthStatus();
      } catch (error) {
        if (cancelled) {
          return;
        }

        console.error(
          "YouTube auto-connect error:",
          error
        );

        diagnosticError(
          "YOUTUBE_AUTO_CONNECT",
          error
        );

        setYoutubeConnected(
          false
        );

        setYoutubeViewerLive(
          false
        );

        setYoutubeLiveChatId(
          null
        );

        const errorText =
          String(error);

        if (
          errorText.includes(
            "quotaExceeded"
          )
        ) {
          setYoutubeStatus(
            "YouTube quota bereikt"
          );

          setOauthStatus(
            "YouTube API-quota is bereikt. Automatisch verbinden is gestopt."
          );
        } else {
          setYoutubeStatus(
            "YouTube automatisch verbinden mislukt"
          );

          setOauthStatus(
            `Auto-connect mislukt: ${errorText}`
          );
        }

        await refreshAuthStatus();
      } finally {
        if (!cancelled) {
          setAutoConnectLoading(
            false
          );
        }
      }
    }

    void autoConnectYouTube();

    return () => {
      cancelled = true;
    };
  }, []);

  // =======================================================
  // YOUTUBE VIEWERS
  // =======================================================

  useEffect(() => {
    if (!youtubeVideoId) {
      setYoutubeViewerCount(
        null
      );

      setYoutubeViewerLive(
        false
      );

      return;
    }

    let cancelled = false;

    async function refreshYouTubeViewerCount() {
      try {
        const result =
          await invoke<YouTubeViewerResult>(
            "youtube_viewer_count",
            {
              videoId:
                youtubeVideoId,
            }
          );

        if (cancelled) {
          return;
        }

        setYoutubeViewerLive(
          result.live
        );

        const viewerCount =
          result.live
            ? normalizeViewerCount(
                result.viewer_count
              )
            : null;

        setYoutubeViewerCount(
          viewerCount
        );

        if (
          result.live &&
          viewerCount !== null
        ) {
          recordViewerCount(
            "youtube",
            viewerCount
          );
        }

        if (!result.live) {
          setYoutubeConnected(
            false
          );

          setYoutubeStatus(
            "YouTube livestream offline"
          );

          recordConnectionState(
            "youtube",
            false,
            "Livestream offline"
          );
        }
      } catch (error) {
        if (cancelled) {
          return;
        }

        console.warn(
          "YouTube viewer count niet beschikbaar:",
          error
        );

        setYoutubeViewerCount(
          null
        );

        diagnosticError(
          "YOUTUBE_VIEWERS",
          error
        );
      }
    }

    void refreshYouTubeViewerCount();

    const timer =
      window.setInterval(() => {
        void refreshYouTubeViewerCount();
      }, 30000);

    return () => {
      cancelled = true;

      window.clearInterval(
        timer
      );
    };
  }, [youtubeVideoId]);

  // =======================================================
  // YOUTUBE GRPC CHAT
  // =======================================================

  useEffect(() => {
    if (!youtubeLiveChatId) {
      setYoutubeConnected(
        false
      );

      return;
    }

    let cancelled = false;

    let unlistenMessage:
      | UnlistenFn
      | null = null;

    let unlistenStatus:
      | UnlistenFn
      | null = null;

    let unlistenError:
      | UnlistenFn
      | null = null;

    youtubeMessageIdsRef.current.clear();

    async function startYouTubeGrpcChat(
      liveChatId: string
    ) {
      try {
        diagnosticLog(
          "YOUTUBE_GRPC",
          "Starting YouTube chat stream"
        );

        unlistenMessage =
          await listen<YouTubeGrpcChatMessage>(
            "youtube-chat-message",
            (event) => {
              if (cancelled) {
                return;
              }

              const chat =
                event.payload;

              setYoutubeConnected(
                true
              );

              setYoutubeViewerLive(
                true
              );

              setYoutubeStatus(
                "YouTube verbonden"
              );

              if (
                youtubeMessageIdsRef.current.has(
                  chat.id
                )
              ) {
                return;
              }

              youtubeMessageIdsRef.current.add(
                chat.id
              );

              if (
                !chat.message ||
                !chat.message.trim()
              ) {
                return;
              }

              recordChatMessage(
                "youtube"
              );

              setMessages(
                (current) => [
                  ...current,
                  {
                    id: chat.id,

                    platform:
                      "youtube",

                    username:
                      chat.author ||
                      "Unknown",

                    message:
                      chat.message,
                  },
                ]
              );
            }
          );

        if (cancelled) {
          unlistenMessage();
          unlistenMessage = null;

          return;
        }

        unlistenStatus =
          await listen<YouTubeGrpcStatus>(
            "youtube-chat-status",
            (event) => {
              if (cancelled) {
                return;
              }

              const status =
                event.payload;

              recordDiagnosticEvent(
                "youtube",
                "status",
                {
                  chat_status:
                    status.status,
                  connected:
                    status.connected,
                }
              );

              switch (
                status.status
              ) {
                case "connected":
                  setYoutubeConnected(
                    true
                  );

                  setYoutubeViewerLive(
                    true
                  );

                  setYoutubeStatus(
                    "YouTube verbonden"
                  );

                  recordConnectionState(
                    "youtube",
                    true,
                    "gRPC chat connected"
                  );

                  break;

                case "reconnecting":
                  setYoutubeConnected(
                    false
                  );

                  setYoutubeStatus(
                    "YouTube livechat opnieuw verbinden..."
                  );

                  incrementDiagnosticCounter(
                    "youtube_reconnects"
                  );

                  recordDiagnosticEvent(
                    "youtube",
                    "reconnect",
                    {
                      source:
                        "grpc_chat",
                    }
                  );

                  break;

                case "offline":
                  setYoutubeConnected(
                    false
                  );

                  setYoutubeViewerLive(
                    false
                  );

                  setYoutubeStatus(
                    "YouTube livestream offline"
                  );

                  incrementDiagnosticCounter(
                    "youtube_disconnects"
                  );

                  break;

                case "stopped":
                  setYoutubeConnected(
                    false
                  );

                  setYoutubeStatus(
                    "YouTube chatstream gestopt"
                  );

                  break;

                case "error":
                  setYoutubeConnected(
                    false
                  );

                  setYoutubeStatus(
                    "YouTube chat fout"
                  );

                  break;

                default:
                  setYoutubeConnected(
                    status.connected
                  );

                  if (
                    status.connected
                  ) {
                    setYoutubeViewerLive(
                      true
                    );
                  }

                  setYoutubeStatus(
                    status.message
                  );

                  break;
              }
            }
          );

        if (cancelled) {
          unlistenStatus();
          unlistenStatus = null;

          return;
        }

        unlistenError =
          await listen<string>(
            "youtube-chat-error",
            (event) => {
              if (cancelled) {
                return;
              }

              const errorText =
                String(
                  event.payload
                );

              console.error(
                "YouTube gRPC error:",
                errorText
              );

              diagnosticError(
                "YOUTUBE_GRPC",
                errorText
              );

              setYoutubeConnected(
                false
              );

              if (
                errorText.includes(
                  "ResourceExhausted"
                ) ||
                errorText.includes(
                  "RESOURCE_EXHAUSTED"
                )
              ) {
                setYoutubeStatus(
                  "YouTube quota bereikt"
                );

                setOauthStatus(
                  "YouTube streamList meldt dat de beschikbare API-capaciteit is bereikt."
                );
              } else if (
                errorText.includes(
                  "Unauthenticated"
                ) ||
                errorText.includes(
                  "PermissionDenied"
                )
              ) {
                setYoutubeStatus(
                  "YouTube autorisatie mislukt"
                );

                setOauthStatus(
                  "Google/YouTube autorisatie voor de chatstream is mislukt."
                );
              } else {
                setYoutubeStatus(
                  "YouTube chat verbinding mislukt"
                );

                setOauthStatus(
                  errorText
                );
              }
            }
          );

        if (cancelled) {
          unlistenError();
          unlistenError = null;

          return;
        }

        setYoutubeConnected(
          false
        );

        setYoutubeStatus(
          "YouTube livechat verbinden..."
        );

        const result =
          await invoke<string>(
            "youtube_start_chat_stream",
            {
              liveChatId,
            }
          );

        if (cancelled) {
          return;
        }

        console.log(
          "YouTube gRPC:",
          result
        );

        setYoutubeConnected(
          true
        );

        setYoutubeViewerLive(
          true
        );

        setYoutubeStatus(
          "YouTube verbonden"
        );

        recordConnectionState(
          "youtube",
          true,
          "gRPC stream started"
        );
      } catch (error) {
        if (cancelled) {
          return;
        }

        console.error(
          "YouTube gRPC start error:",
          error
        );

        diagnosticError(
          "YOUTUBE_GRPC",
          error
        );

        setYoutubeConnected(
          false
        );

        setYoutubeStatus(
          "YouTube chat verbinding mislukt"
        );

        setOauthStatus(
          `YouTube streamList starten mislukt: ${String(
            error
          )}`
        );
      }
    }

    void startYouTubeGrpcChat(
      youtubeLiveChatId
    );

    return () => {
      cancelled = true;

      diagnosticLog(
        "YOUTUBE_GRPC",
        "Stopping YouTube chat stream"
      );

      setYoutubeConnected(
        false
      );

      void invoke<string>(
        "youtube_stop_chat_stream"
      ).catch((error) => {
        console.error(
          "YouTube gRPC stop error:",
          error
        );

        diagnosticError(
          "YOUTUBE_GRPC",
          error
        );
      });

      if (unlistenMessage) {
        unlistenMessage();
      }

      if (unlistenStatus) {
        unlistenStatus();
      }

      if (unlistenError) {
        unlistenError();
      }
    };
  }, [youtubeLiveChatId]);

  // =======================================================
  // YOUTUBE LOGIN
  // =======================================================

  async function handleYouTubeLogin() {
    if (oauthLoading) {
      return;
    }

    try {
      setOauthLoading(true);

      setOauthStatus(
        "Google login openen..."
      );

      setYoutubeStatus(
        "YouTube koppelen..."
      );

      recordDiagnosticEvent(
        "youtube",
        "auth",
        {
          action:
            "login_started",
        }
      );

      const result =
        await invoke<YouTubeLoginResult>(
          "youtube_login"
        );

      setYoutubeLiveChatId(
        result.live_chat_id
      );

      setYoutubeVideoId(
        result.video_id
      );

      setYoutubeTitle(
        result.title
      );

      setYoutubeViewerLive(
        true
      );

      setOauthStatus(
        `${result.message} • ${result.title}`
      );

      setYoutubeStatus(
        "YouTube livechat gevonden"
      );

      recordDiagnosticEvent(
        "youtube",
        "auth",
        {
          action:
            "login_success",
        }
      );

      await refreshAuthStatus();
    } catch (error) {
      console.error(
        "OAuth error:",
        error
      );

      diagnosticError(
        "YOUTUBE_AUTH",
        error
      );

      setYoutubeConnected(
        false
      );

      setYoutubeViewerLive(
        false
      );

      setYoutubeLiveChatId(
        null
      );

      setYoutubeStatus(
        "YouTube niet verbonden"
      );

      setOauthStatus(
        `OAuth mislukt: ${String(
          error
        )}`
      );

      await refreshAuthStatus();
    } finally {
      setOauthLoading(false);
    }
  }

  // =======================================================
  // TWITCH AUTH
  // =======================================================

  async function refreshTwitchAuthStatus() {
    if (!TWITCH_CLIENT_ID) {
      setTwitchAuthStatus(
        null
      );

      return;
    }

    try {
      const result =
        await invoke<TwitchAuthStatus>(
          "twitch_auth_status"
        );

      setTwitchAuthStatus(
        result
      );

      recordDiagnosticEvent(
        "twitch",
        "auth",
        {
          connected:
            result.connected,
          expired:
            result.expired,
          needs_relogin:
            result.needs_relogin,
        }
      );
    } catch (error) {
      console.error(
        "Twitch auth status error:",
        error
      );

      setTwitchAuthStatus(
        null
      );

      diagnosticError(
        "TWITCH_AUTH",
        error
      );
    }
  }

  // =======================================================
  // TWITCH VIEWERS
  // =======================================================

  async function refreshTwitchViewerCount() {
    if (!TWITCH_CLIENT_ID) {
      setTwitchViewerCount(
        null
      );

      setTwitchViewerLive(
        false
      );

      return;
    }

    try {
      const result =
        await invoke<TwitchViewerResult>(
          "twitch_viewer_count",
          {
            clientId:
              TWITCH_CLIENT_ID,

            channelLogin:
              TWITCH_CHANNEL,
          }
        );

      setTwitchViewerLive(
        result.live
      );

      const viewerCount =
        result.live
          ? normalizeViewerCount(
              result.viewer_count
            )
          : null;

      setTwitchViewerCount(
        viewerCount
      );

      if (
        result.live &&
        viewerCount !== null
      ) {
        recordViewerCount(
          "twitch",
          viewerCount
        );
      }
    } catch (error) {
      console.warn(
        "Twitch viewer count niet beschikbaar:",
        error
      );

      setTwitchViewerCount(
        null
      );

      setTwitchViewerLive(
        false
      );

      diagnosticError(
        "TWITCH_VIEWERS",
        error
      );
    }
  }

  useEffect(() => {
    void refreshTwitchAuthStatus();

    void refreshTwitchViewerCount();

    const timer =
      window.setInterval(() => {
        void refreshTwitchAuthStatus();

        void refreshTwitchViewerCount();
      }, 30000);

    return () => {
      window.clearInterval(
        timer
      );
    };
  }, []);

  // =======================================================
  // TWITCH EVENTSUB
  // =======================================================

  useEffect(() => {
    let cancelled = false;

    const unlisteners:
      UnlistenFn[] = [];

    let startAttempted =
      false;

    const setup =
      async () => {
        if (cancelled) {
          return;
        }

        if (!TWITCH_CLIENT_ID) {
          setTwitchEventSubStatus({
            status: "error",

            message:
              "Twitch EventSub kan niet starten: VITE_TWITCH_CLIENT_ID ontbreekt in deze build.",
          });

          diagnosticError(
            "TWITCH_EVENTSUB",
            "Client ID missing"
          );

          return;
        }

        try {
          const statusUnlisten =
            await listen<TwitchEventSubStatus>(
              "twitch-eventsub-status",
              ({ payload }) => {
                if (
                  cancelled
                ) {
                  return;
                }

                setTwitchEventSubStatus(
                  payload
                );

                recordDiagnosticEvent(
                  "twitch",
                  "status",
                  {
                    eventsub_status:
                      payload.status,
                  }
                );

                if (
                  payload.status ===
                  "reconnecting"
                ) {
                  incrementDiagnosticCounter(
                    "twitch_reconnects"
                  );
                }
              }
            );

          if (cancelled) {
            statusUnlisten();

            return;
          }

          unlisteners.push(
            statusUnlisten
          );

          const eventUnlisten =
            await listen<SdjfamEvent>(
              "sdjfam-event",
              ({ payload }) => {
                if (
                  cancelled ||
                  payload.platform !==
                    "twitch" ||
                  payload.event_type ===
                    "chat_message"
                ) {
                  return;
                }

                const ids =
                  twitchEventIdsRef.current;

                if (
                  ids.has(
                    payload.id
                  )
                ) {
                  return;
                }

                ids.add(
                  payload.id
                );

                if (
                  ids.size > 1000
                ) {
                  const firstId =
                    ids
                      .values()
                      .next()
                      .value;

                  if (firstId) {
                    ids.delete(
                      firstId
                    );
                  }
                }

                incrementDiagnosticCounter(
                  "eventsub_events"
                );

                recordDiagnosticEvent(
                  "twitch",
                  payload.event_type,
                  {
                    source:
                      "eventsub",

                    amount:
                      payload.amount
                        ?.value ??
                      null,

                    currency:
                      payload.amount
                        ?.currency ??
                      null,
                  }
                );

                if (
                  ALERT_EVENT_TYPES.has(
                    payload.event_type
                  )
                ) {
                  incrementDiagnosticCounter(
                    "alerts"
                  );

                  recordDiagnosticEvent(
                    "twitch",
                    "alert",
                    {
                      event_type:
                        payload.event_type,
                    }
                  );

                  setAlertQueue(
                    (
                      currentQueue
                    ) => [
                      ...currentQueue,
                      payload,
                    ]
                  );
                }

                setMessages(
                  (current) => [
                    ...current,
                    {
                      id:
                        `eventsub:${payload.id}`,

                      platform:
                        "twitch",

                      username:
                        payload.user
                          ?.display_name ||
                        payload.user
                          ?.username ||
                        "Twitch",

                      message:
                        payload.message ||
                        `Twitch-event: ${payload.event_type}`,
                    },
                  ]
                );
              }
            );

          if (cancelled) {
            eventUnlisten();

            return;
          }

          unlisteners.push(
            eventUnlisten
          );

          setTwitchEventSubStatus({
            status:
              "connecting",

            message:
              "Twitch EventSub starten...",
          });

          startAttempted =
            true;

          diagnosticLog(
            "TWITCH_EVENTSUB",
            "Starting EventSub"
          );

          await invoke(
            "twitch_start_eventsub",
            {
              clientId:
                TWITCH_CLIENT_ID,
            }
          );
        } catch (error) {
          diagnosticError(
            "TWITCH_EVENTSUB",
            error
          );

          if (!cancelled) {
            setTwitchEventSubStatus({
              status: "error",
              message:
                String(error),
            });
          }

          unlisteners
            .splice(0)
            .forEach(
              (unlisten) =>
                unlisten()
            );
        }
      };

    twitchEventSubLifecycle =
      twitchEventSubLifecycle.then(
        setup
      );

    return () => {
      cancelled = true;

      unlisteners
        .splice(0)
        .forEach(
          (unlisten) =>
            unlisten()
        );

      twitchEventSubLifecycle =
        twitchEventSubLifecycle.then(
          async () => {
            if (
              startAttempted
            ) {
              diagnosticLog(
                "TWITCH_EVENTSUB",
                "Stopping EventSub"
              );

              await invoke(
                "twitch_stop_eventsub"
              ).catch(
                (error) => {
                  console.warn(
                    "Twitch EventSub stoppen mislukt:",
                    error
                  );

                  diagnosticError(
                    "TWITCH_EVENTSUB",
                    error
                  );
                }
              );
            }
          }
        );
    };
  }, [
    twitchEventSubGeneration,
  ]);

  // =======================================================
  // TWITCH LOGIN
  // =======================================================

  async function handleTwitchLogin() {
    if (
      twitchOauthLoading ||
      !TWITCH_CLIENT_ID
    ) {
      return;
    }

    try {
      setTwitchOauthLoading(
        true
      );

      setTwitchOauthStatus(
        "Twitch koppeling openen..."
      );

      recordDiagnosticEvent(
        "twitch",
        "auth",
        {
          action:
            "login_started",
        }
      );

      const result =
        await invoke<TwitchLoginResult>(
          "twitch_login",
          {
            clientId:
              TWITCH_CLIENT_ID,
          }
        );

      setTwitchOauthStatus(
        result.message
      );

      recordDiagnosticEvent(
        "twitch",
        "auth",
        {
          action:
            result.connected
              ? "login_success"
              : "login_not_connected",
        }
      );

      if (
        result.connected
      ) {
        setTwitchEventSubGeneration(
          (generation) =>
            generation + 1
        );
      }

      await refreshTwitchAuthStatus();

      await refreshTwitchViewerCount();
    } catch (error) {
      console.error(
        "Twitch OAuth error:",
        error
      );

      diagnosticError(
        "TWITCH_AUTH",
        error
      );

      setTwitchOauthStatus(
        `Twitch koppelen mislukt: ${String(
          error
        )}`
      );

      await refreshTwitchAuthStatus();
    } finally {
      setTwitchOauthLoading(
        false
      );
    }
  }

  // =======================================================
  // EVENT ENGINE SIMULATOR
  // =======================================================

  async function handleSimulateEvent(
    eventType: string
  ) {
    if (
      eventSimulatorLoading
    ) {
      return;
    }

    try {
      setEventSimulatorLoading(
        eventType
      );

      setEventSimulatorStatus(
        `Testevent ${eventType} versturen...`
      );

      recordDiagnosticEvent(
        "app",
        "status",
        {
          action:
            "simulator_started",

          event_type:
            eventType,
        }
      );

      const result =
        await invoke<SdjfamEvent>(
          "event_engine_simulate",
          {
            eventType,
          }
        );

      setEventSimulatorStatus(
        `Testevent ontvangen: ${result.event_type}`
      );

      recordDiagnosticEvent(
        "app",
        "status",
        {
          action:
            "simulator_received",

          event_type:
            result.event_type,
        }
      );
    } catch (error) {
      console.error(
        "Event Engine simulator fout:",
        error
      );

      diagnosticError(
        "EVENT_SIMULATOR",
        error
      );

      setEventSimulatorStatus(
        `Simulator fout: ${String(
          error
        )}`
      );
    } finally {
      setEventSimulatorLoading(
        null
      );
    }
  }

  // =======================================================
  // TWITCH CHAT
  // =======================================================

  useEffect(() => {
    const client =
      new tmi.Client({
        connection: {
          secure: true,
          reconnect: true,
        },

        channels: [
          TWITCH_CHANNEL,
        ],
      });

    client.on(
      "connected",
      () => {
        setTwitchConnected(
          true
        );

        updatePlatformDiagnosticState(
          "twitch",
          {
            connected: true,
            chatStatus:
              "connected",
          }
        );

        recordConnectionState(
          "twitch",
          true,
          "TMI chat connected"
        );
      }
    );

    client.on(
      "disconnected",
      () => {
        setTwitchConnected(
          false
        );

        incrementDiagnosticCounter(
          "twitch_disconnects"
        );

        updatePlatformDiagnosticState(
          "twitch",
          {
            connected: false,
            chatStatus:
              "disconnected",
          }
        );

        recordConnectionState(
          "twitch",
          false,
          "TMI chat disconnected"
        );
      }
    );

    client.on(
      "message",
      (
        _channel,
        tags,
        message,
        self
      ) => {
        if (self) {
          return;
        }

        const username =
          tags["display-name"] ||
          tags.username ||
          "Unknown";

        recordChatMessage(
          "twitch"
        );

        setMessages(
          (current) => [
            ...current,
            {
              id:
                `twitch-${Date.now()}-${Math.random()}`,

              platform:
                "twitch",

              username,

              message,
            },
          ]
        );
      }
    );

    diagnosticLog(
      "TWITCH_CHAT",
      "Starting TMI client"
    );

    client
      .connect()
      .catch((error) => {
        console.error(
          "Twitch connection error:",
          error
        );

        diagnosticError(
          "TWITCH_CHAT",
          error
        );

        setTwitchConnected(
          false
        );
      });

    return () => {
      diagnosticLog(
        "TWITCH_CHAT",
        "Stopping TMI client"
      );

      client
        .disconnect()
        .catch((error) => {
          diagnosticError(
            "TWITCH_CHAT",
            error
          );
        });
    };
  }, []);

  // =======================================================
  // TIKTOK LIVE + CHAT + VIEWERS + FUTURE GIFTS
  // =======================================================

  useEffect(() => {
    let cancelled = false;

    const command =
      Command.sidecar(
        "binaries/tiktok-chat-helper",
        [
          TIKTOK_USERNAME,
        ]
      );

    // -----------------------------------------------------
    // STDOUT
    // -----------------------------------------------------

    command.stdout.on(
      "data",
      (line) => {
        if (cancelled) {
          return;
        }

        const output =
          String(line).trim();

        if (!output) {
          return;
        }

        // TikTok ROOM_USER diagnostic output.
        if (
          output.startsWith(
            "TIKTOK_ROOM_USER received viewerCount="
          )
        ) {
          diagnosticLog(
            "TIKTOK",
            output
          );

          return;
        }

        if (
          output ===
          "TIKTOK_ROOM_USER invalid viewerCount"
        ) {
          diagnosticLog(
            "TIKTOK",
            output
          );

          return;
        }

        // Connected.
        if (
          output.startsWith(
            "TIKTOK_CONNECTED"
          ) ||
          output.startsWith(
            "TikTok LIVE actief"
          )
        ) {
          setTikTokConnected(
            true
          );

          updateDiagnosticSnapshot({
            tiktokConnected:
              true,

            tiktokSidecarRunning:
              true,
          });

          updatePlatformDiagnosticState(
            "tiktok",
            {
              connected: true,

              sidecarRunning:
                true,

              status: "live",
            }
          );

          recordConnectionState(
            "tiktok",
            true,
            "TikTok LIVE connected"
          );

          return;
        }

        // Disconnected.
        if (
          output ===
          "TIKTOK_DISCONNECTED"
        ) {
          setTikTokConnected(
            false
          );

          setTikTokViewerCount(
            null
          );

          incrementDiagnosticCounter(
            "tiktok_disconnects"
          );

          updateDiagnosticSnapshot({
            tiktokConnected:
              false,

            tiktokViewerCount:
              null,

            tiktokSidecarRunning:
              true,
          });

          updatePlatformDiagnosticState(
            "tiktok",
            {
              connected:
                false,

              viewers:
                null,

              sidecarRunning:
                true,

              status:
                "disconnected",
            }
          );

          recordConnectionState(
            "tiktok",
            false,
            "TikTok LIVE disconnected"
          );

          return;
        }

        // Other sidecar status output.
        if (
          !output.startsWith(
            "{"
          )
        ) {
          diagnosticLog(
            "TIKTOK_SIDECAR",
            `status=${output}`
          );

          return;
        }

        // JSON event.
        try {
          const payload =
            JSON.parse(
              output
            ) as TikTokSidecarPayload;

          // -----------------------------------------------
          // VIEWER COUNT
          // -----------------------------------------------

          if (
            payload.type ===
              "viewerCount" &&
            payload.platform ===
              "tiktok" &&
            typeof payload.count ===
              "number" &&
            Number.isFinite(
              payload.count
            )
          ) {
            const viewerCount =
              Math.max(
                0,
                Math.trunc(
                  payload.count
                )
              );

            setTikTokConnected(
              true
            );

            setTikTokViewerCount(
              viewerCount
            );

            updateDiagnosticSnapshot({
              tiktokConnected:
                true,

              tiktokViewerCount:
                viewerCount,

              tiktokSidecarRunning:
                true,
            });

            updatePlatformDiagnosticState(
              "tiktok",
              {
                connected:
                  true,

                viewers:
                  viewerCount,

                sidecarRunning:
                  true,

                status:
                  "live",
              }
            );

            recordViewerCount(
              "tiktok",
              viewerCount
            );

            return;
          }

          // -----------------------------------------------
          // FUTURE TIKTOK GIFTS
          // -----------------------------------------------

          if (
            payload.type ===
              "gift" &&
            payload.platform ===
              "tiktok"
          ) {
            recordDiagnosticEvent(
              "tiktok",
              "gift",
              {
                gift:
                  payload.giftName ??
                  "unknown",

                gift_id:
                  payload.giftId ??
                  null,

                count:
                  payload.repeatCount ??
                  1,

                diamonds:
                  payload.diamondCount ??
                  null,
              }
            );

            return;
          }

          // -----------------------------------------------
          // FUTURE GENERIC TIKTOK EVENTS
          // -----------------------------------------------

          if (
            payload.platform ===
              "tiktok" &&
            payload.type !==
              "chat"
          ) {
            recordDiagnosticEvent(
              "tiktok",
              "status",
              {
                payload_type:
                  payload.type ??
                  "unknown",

                event_type:
                  payload.eventType ??
                  null,

                status:
                  payload.status ??
                  null,
              }
            );

            return;
          }

          // -----------------------------------------------
          // CHAT
          // -----------------------------------------------

          if (
            payload.type !==
              "chat" ||
            payload.platform !==
              "tiktok"
          ) {
            return;
          }

          const message =
            payload.message?.trim() ??
            "";

          if (!message) {
            return;
          }

          setTikTokConnected(
            true
          );

          updateDiagnosticSnapshot({
            tiktokConnected:
              true,

            tiktokSidecarRunning:
              true,
          });

          updatePlatformDiagnosticState(
            "tiktok",
            {
              connected:
                true,

              sidecarRunning:
                true,

              status:
                "live",
            }
          );

          // Alleen teller.
          // Geen chattekst of username in diagnostics.
          recordChatMessage(
            "tiktok"
          );

          setMessages(
            (current) => [
              ...current,
              {
                id:
                  `tiktok-${Date.now()}-${Math.random()}`,

                platform:
                  "tiktok",

                username:
                  payload.username?.trim() ||
                  payload.uniqueId?.trim() ||
                  "TikTok",

                message,
              },
            ]
          );
        } catch (error) {
          console.warn(
            "TikTok chatregel kon niet worden gelezen:",
            error,
            output
          );

          diagnosticError(
            "TIKTOK",
            `Sidecar JSON parse failed: ${String(
              error
            )}`
          );
        }
      }
    );

    // -----------------------------------------------------
    // STDERR
    // -----------------------------------------------------

    command.stderr.on(
      "data",
      (line) => {
        if (cancelled) {
          return;
        }

        const errorLine =
          String(line).trim();

        if (!errorLine) {
          return;
        }

        console.warn(
          "TikTok sidecar:",
          errorLine
        );

        diagnosticError(
          "TIKTOK_SIDECAR",
          errorLine
        );

        if (
          errorLine.includes(
            "isn't online"
          ) ||
          errorLine.includes(
            "verbinden mislukt"
          ) ||
          errorLine.includes(
            "TIKTOK_ERROR"
          )
        ) {
          setTikTokConnected(
            false
          );

          setTikTokViewerCount(
            null
          );

          updateDiagnosticSnapshot({
            tiktokConnected:
              false,

            tiktokViewerCount:
              null,
          });

          updatePlatformDiagnosticState(
            "tiktok",
            {
              connected:
                false,

              viewers:
                null,

              status:
                "offline_or_error",
            }
          );
        }
      }
    );

    // -----------------------------------------------------
    // CLOSE
    // -----------------------------------------------------

    command.on(
      "close",
      () => {
        diagnosticLog(
          "TIKTOK_SIDECAR",
          "Sidecar process closed"
        );

        incrementDiagnosticCounter(
          "sidecar_events"
        );

        if (!cancelled) {
          setTikTokConnected(
            false
          );

          setTikTokViewerCount(
            null
          );
        }

        tiktokChildRef.current =
          null;

        updateDiagnosticSnapshot({
          tiktokConnected:
            false,

          tiktokViewerCount:
            null,

          tiktokSidecarRunning:
            false,
        });

        updatePlatformDiagnosticState(
          "tiktok",
          {
            connected:
              false,

            viewers:
              null,

            sidecarRunning:
              false,

            status:
              "sidecar_closed",
          }
        );
      }
    );

    // -----------------------------------------------------
    // PROCESS ERROR
    // -----------------------------------------------------

    command.on(
      "error",
      (error) => {
        if (cancelled) {
          return;
        }

        console.error(
          "TikTok sidecar fout:",
          error
        );

        diagnosticError(
          "TIKTOK_SIDECAR",
          error
        );

        setTikTokConnected(
          false
        );

        setTikTokViewerCount(
          null
        );

        updateDiagnosticSnapshot({
          tiktokConnected:
            false,

          tiktokViewerCount:
            null,

          tiktokSidecarRunning:
            false,
        });

        updatePlatformDiagnosticState(
          "tiktok",
          {
            connected:
              false,

            viewers:
              null,

            sidecarRunning:
              false,

            status:
              "sidecar_error",
          }
        );
      }
    );

    // -----------------------------------------------------
    // SPAWN
    // -----------------------------------------------------

    diagnosticLog(
      "TIKTOK_SIDECAR",
      "Starting TikTok sidecar"
    );

    incrementDiagnosticCounter(
      "sidecar_events"
    );

    command
      .spawn()
      .then((child) => {
        if (cancelled) {
          void child
            .kill()
            .catch(() => {});

          return;
        }

        tiktokChildRef.current =
          child;

        diagnosticLog(
          "TIKTOK_SIDECAR",
          "TikTok sidecar started"
        );

        updateDiagnosticSnapshot({
          tiktokSidecarRunning:
            true,
        });

        updatePlatformDiagnosticState(
          "tiktok",
          {
            sidecarRunning:
              true,

            status:
              "sidecar_running",
          }
        );
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        console.error(
          "TikTok sidecar kon niet starten:",
          error
        );

        diagnosticError(
          "TIKTOK_SIDECAR",
          error
        );

        setTikTokConnected(
          false
        );

        setTikTokViewerCount(
          null
        );

        updateDiagnosticSnapshot({
          tiktokConnected:
            false,

          tiktokViewerCount:
            null,

          tiktokSidecarRunning:
            false,
        });

        updatePlatformDiagnosticState(
          "tiktok",
          {
            connected:
              false,

            viewers:
              null,

            sidecarRunning:
              false,

            status:
              "spawn_failed",
          }
        );
      });

    // -----------------------------------------------------
    // CLEANUP
    // -----------------------------------------------------

    return () => {
      cancelled = true;

      diagnosticLog(
        "TIKTOK_SIDECAR",
        "TikTok sidecar cleanup requested"
      );

      setTikTokConnected(
        false
      );

      setTikTokViewerCount(
        null
      );

      const child =
        tiktokChildRef.current;

      tiktokChildRef.current =
        null;

      updateDiagnosticSnapshot({
        tiktokConnected:
          false,

        tiktokViewerCount:
          null,

        tiktokSidecarRunning:
          false,
      });

      updatePlatformDiagnosticState(
        "tiktok",
        {
          connected:
            false,

          viewers:
            null,

          sidecarRunning:
            false,

          status:
            "cleanup",
        }
      );

      if (child) {
        void child
          .kill()
          .catch((error) => {
            diagnosticError(
              "TIKTOK_SIDECAR",
              `Sidecar kill failed: ${String(
                error
              )}`
            );
          });
      }
    };
  }, []);

  // =======================================================
  // AUTO SCROLL
  // =======================================================

  useEffect(() => {
    const list =
      messageListRef.current;

    if (!list) {
      return;
    }

    list.scrollTop =
      list.scrollHeight;
  }, [messages]);

  // =======================================================
  // GOOGLE STATUS TEXT
  // =======================================================

  let googleLinkText =
    "Google niet gekoppeld";

  if (
    authStatus?.connected
  ) {
    if (
      authStatus.expired
    ) {
      googleLinkText =
        "Google koppeling verlopen";
    } else {
      googleLinkText =
        `Google koppeling: nog ${formatRemainingTime(
          authStatus.seconds_remaining
        )}`;
    }
  }

  // =======================================================
  // UI
  // =======================================================

  return (
    <main className="app-shell">
      <AlertOverlay
        event={activeAlert}
      />

      {/* ===================================================
          UPDATE POPUP
      =================================================== */}

      {updatePopupOpen &&
        updateVersion && (
          <div
            className="update-popup-backdrop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="update-popup-title"
          >
            <div className="update-popup">
              <div className="update-popup-label">
                SDJFAM CHAT UPDATE
              </div>

              <h2 id="update-popup-title">
                Nieuwe update beschikbaar
              </h2>

              <p className="update-popup-version">
                Versie {updateVersion} staat klaar.
              </p>

              <div className="update-popup-notes">
                <strong>
                  Wat is er nieuw?
                </strong>

                <div>
                  {updateNotes}
                </div>
              </div>

              {updateInstalling &&
                updateStatus && (
                  <p className="update-popup-status">
                    {updateStatus}
                  </p>
                )}

              <div className="update-popup-actions">
                <button
                  type="button"
                  className="update-popup-later"
                  onClick={() =>
                    setUpdatePopupOpen(
                      false
                    )
                  }
                  disabled={
                    updateInstalling
                  }
                >
                  Later
                </button>

                <button
                  type="button"
                  className="update-popup-now"
                  onClick={() =>
                    void handleInstallUpdate()
                  }
                  disabled={
                    updateInstalling
                  }
                >
                  {updateInstalling
                    ? "Update installeren..."
                    : "Nu updaten"}
                </button>
              </div>
            </div>
          </div>
        )}

      {/* ===================================================
          TOPBAR
      =================================================== */}

      <header className="topbar">
        <div className="topbar-brand">
          <h1>
            SDJFAM Chat
          </h1>

          <p>
            Twitch + YouTube + TikTok live chat
          </p>

          {updateStatus && (
            <p className="update-status">
              {updateStatus}
            </p>
          )}
        </div>

        <div className="status-row">
          {updateVersion && (
            <button
              type="button"
              className="update-button"
              onClick={
                handleInstallUpdate
              }
              disabled={
                updateInstalling
              }
            >
              {updateInstalling
                ? "Update installeren..."
                : `Update ${updateVersion}`}
            </button>
          )}

          {/* Twitch viewer */}

          <div
            className={`platform-viewer twitch ${
              twitchViewerLive
                ? "connected"
                : "offline"
            }`}
            title={
              twitchViewerLive
                ? "Twitch livestream actief"
                : "Twitch offline"
            }
          >
            <div className="platform-status">
              <TwitchIcon />
            </div>

            <div className="viewer-count">
              <span
                className="viewer-eye"
                aria-hidden="true"
              >
                👁
              </span>

              <strong>
                {twitchViewerLive &&
                twitchViewerCount !==
                  null
                  ? twitchViewerCount.toLocaleString()
                  : "—"}
              </strong>
            </div>
          </div>

          {/* YouTube viewer */}

          <div
            className={`platform-viewer youtube ${
              youtubePlatformActive
                ? "connected"
                : "offline"
            }`}
            title={
              youtubePlatformActive
                ? youtubeConnected
                  ? "YouTube live en livechat verbonden"
                  : "YouTube livestream actief"
                : youtubeStatus
            }
          >
            <div className="platform-status">
              <YouTubeIcon />
            </div>

            <div className="viewer-count">
              <span
                className="viewer-eye"
                aria-hidden="true"
              >
                👁
              </span>

              <strong>
                {youtubeViewerLive &&
                youtubeViewerCount !==
                  null
                  ? youtubeViewerCount.toLocaleString()
                  : "—"}
              </strong>
            </div>
          </div>

          {/* TikTok viewer */}

          <div
            className={`platform-viewer tiktok ${
              tiktokConnected
                ? "connected"
                : "offline"
            }`}
            title={
              tiktokConnected
                ? `TikTok @${TIKTOK_USERNAME} LIVE verbonden`
                : `TikTok @${TIKTOK_USERNAME} offline`
            }
          >
            <div className="platform-status">
              <TikTokIcon />
            </div>

            <div className="viewer-count">
              <span
                className="viewer-eye"
                aria-hidden="true"
              >
                👁
              </span>

              <strong>
                {tiktokConnected &&
                tiktokViewerCount !==
                  null
                  ? tiktokViewerCount.toLocaleString()
                  : "—"}
              </strong>
            </div>
          </div>

          {/* Settings */}

          <button
            type="button"
            className={`settings-button ${
              settingsOpen
                ? "active"
                : ""
            }`}
            onClick={() =>
              setSettingsOpen(
                (current) =>
                  !current
              )
            }
            aria-label="Settings"
            title="Settings"
          >
            <SettingsIcon />
          </button>
        </div>
      </header>

      {/* ===================================================
          CHAT
      =================================================== */}

      <section className="chat-panel">
        {messages.length === 0 ? (
          <div className="empty-state">
            <h2>
              {twitchConnected
                ? "Twitch chat verbonden"
                : "Twitch chat verbinden..."}
            </h2>

            <p>
              {twitchConnected ||
              tiktokConnected
                ? `Nieuwe berichten verschijnen hier. ${youtubeStatus}`
                : "Even wachten terwijl SDJFAM Chat verbinding maakt."}
            </p>

            {oauthStatus && (
              <p className="empty-oauth-status">
                {oauthStatus}
              </p>
            )}

            {youtubeTitle && (
              <p className="empty-live-title">
                Live:{" "}
                {youtubeTitle}
              </p>
            )}

            {youtubeVideoId && (
              <p className="empty-video-id">
                Video ID:{" "}
                {youtubeVideoId}
              </p>
            )}
          </div>
        ) : (
          <div
            className="message-list"
            ref={messageListRef}
          >
            {messages.map(
              (chat) => (
                <div
                  className={`chat-message ${chat.platform}`}
                  key={chat.id}
                >
                  <span
                    className={`platform-badge ${chat.platform}-badge`}
                    title={getPlatformLabel(
                      chat.platform
                    )}
                    aria-label={getPlatformLabel(
                      chat.platform
                    )}
                  >
                    <PlatformIcon
                      platform={
                        chat.platform
                      }
                    />
                  </span>

                  <div className="message-content">
                    <strong>
                      {chat.username}
                    </strong>

                    <p>
                      {chat.message}
                    </p>
                  </div>
                </div>
              )
            )}
          </div>
        )}
      </section>

      {/* ===================================================
          SETTINGS
      =================================================== */}

      {settingsOpen && (
        <div
          className="settings-backdrop"
          onMouseDown={() =>
            setSettingsOpen(
              false
            )
          }
        >
          <aside
            className="settings-panel"
            onMouseDown={(
              event
            ) =>
              event.stopPropagation()
            }
          >
            {/* Header */}

            <div className="settings-header">
              <div>
                <h2>
                  Settings
                </h2>

                <p>
                  SDJFAM Chat instellingen
                </p>
              </div>

              <button
                type="button"
                className="settings-close"
                onClick={() =>
                  setSettingsOpen(
                    false
                  )
                }
                aria-label="Settings sluiten"
              >
                ×
              </button>
            </div>

            {/* =============================================
                TWITCH SETTINGS
            ============================================= */}

            <div className="settings-section">
              <div className="settings-section-title">
                <div className="settings-twitch-icon">
                  <TwitchIcon />
                </div>

                <div>
                  <h3>
                    Twitch
                  </h3>

                  <p>
                    Chat, livestream en EventSub
                  </p>
                </div>
              </div>

              <div className="settings-status-card">
                <div className="settings-status-line">
                  <span>
                    Chat
                  </span>

                  <strong
                    className={
                      twitchConnected
                        ? "status-good"
                        : "status-muted"
                    }
                  >
                    {twitchConnected
                      ? "Verbonden"
                      : "Niet verbonden"}
                  </strong>
                </div>

                <div className="settings-status-line">
                  <span>
                    Livestream
                  </span>

                  <strong
                    className={
                      twitchViewerLive
                        ? "status-good"
                        : "status-muted"
                    }
                  >
                    {twitchViewerLive
                      ? "Live"
                      : "Offline"}
                  </strong>
                </div>

                <div className="settings-status-line">
                  <span>
                    Twitch API
                  </span>

                  <strong
                    className={
                      twitchAuthStatus?.connected &&
                      !twitchAuthStatus?.needs_relogin &&
                      !twitchAuthStatus?.expired
                        ? "status-good"
                        : "status-muted"
                    }
                  >
                    {twitchAuthStatus?.connected
                      ? twitchAuthStatus.expired
                        ? "Verlopen"
                        : "Gekoppeld"
                      : "Niet gekoppeld"}
                  </strong>
                </div>
              </div>

              <div
                className="settings-status-card"
                role="status"
              >
                <div className="settings-status-line">
                  <span>
                    EventSub
                  </span>

                  <strong
                    className={
                      twitchEventSubStatus.status ===
                      "connected"
                        ? "status-good"
                        : "status-muted"
                    }
                  >
                    {twitchEventSubStatus.status ===
                    "connected"
                      ? "Actief"
                      : eventSubNeedsRelogin(
                            twitchEventSubStatus
                          )
                        ? "Opnieuw koppelen"
                        : [
                              "connecting",
                              "socket_connected",
                            ].includes(
                              twitchEventSubStatus.status
                            )
                          ? "Verbinden..."
                          : twitchEventSubStatus.status ===
                              "reconnecting"
                            ? "Opnieuw verbinden..."
                            : "Niet actief"}
                  </strong>
                </div>

                <p className="settings-message">
                  {
                    twitchEventSubStatus.message
                  }
                </p>

                {eventSubNeedsRelogin(
                  twitchEventSubStatus
                ) && (
                  <p className="settings-message">
                    Klik hieronder op Twitch opnieuw
                    koppelen en geef toestemming voor de
                    EventSub-rechten. EventSub start daarna
                    automatisch opnieuw.
                  </p>
                )}
              </div>

              {/* Simulator */}

              <div className="settings-status-card">
                <div className="settings-status-line">
                  <span>
                    Event Engine Simulator
                  </span>

                  <strong className="status-good">
                    Testmodus
                  </strong>
                </div>

                <p className="settings-message">
                  Test Twitch-events lokaal via dezelfde
                  SDJFAM Event Engine die echte
                  EventSub-events verwerkt.
                </p>

                <div
                  style={{
                    display:
                      "flex",

                    flexWrap:
                      "wrap",

                    gap:
                      "8px",

                    marginTop:
                      "12px",
                  }}
                >
                  {[
                    [
                      "follow",
                      "Test Follow",
                    ],

                    [
                      "subscription",
                      "Test Sub",
                    ],

                    [
                      "gift_subscription",
                      "Test Gift Sub",
                    ],

                    [
                      "bits",
                      "Test Bits",
                    ],

                    [
                      "raid",
                      "Test Raid",
                    ],
                  ].map(
                    ([
                      eventType,
                      label,
                    ]) => (
                      <button
                        key={
                          eventType
                        }
                        type="button"
                        className="twitch-link-button"
                        disabled={
                          eventSimulatorLoading !==
                          null
                        }
                        onClick={() =>
                          void handleSimulateEvent(
                            eventType
                          )
                        }
                      >
                        {eventSimulatorLoading ===
                        eventType
                          ? "Testen..."
                          : label}
                      </button>
                    )
                  )}
                </div>

                {eventSimulatorStatus && (
                  <p className="settings-message">
                    {
                      eventSimulatorStatus
                    }
                  </p>
                )}
              </div>

              {!TWITCH_CLIENT_ID && (
                <div className="settings-message">
                  Twitch Client ID ontbreekt in deze build.
                </div>
              )}

              {twitchOauthStatus && (
                <div className="settings-message">
                  {twitchOauthStatus}
                </div>
              )}

              <button
                type="button"
                className="twitch-link-button"
                onClick={
                  handleTwitchLogin
                }
                disabled={
                  twitchOauthLoading ||
                  !TWITCH_CLIENT_ID
                }
              >
                {twitchOauthLoading
                  ? "Twitch koppelen..."
                  : twitchAuthStatus?.connected ||
                      eventSubNeedsRelogin(
                        twitchEventSubStatus
                      )
                    ? "Twitch opnieuw koppelen"
                    : "Twitch koppelen"}
              </button>
            </div>

            {/* =============================================
                YOUTUBE SETTINGS
            ============================================= */}

            <div className="settings-section">
              <div className="settings-section-title">
                <div className="settings-youtube-icon">
                  <YouTubeIcon />
                </div>

                <div>
                  <h3>
                    YouTube
                  </h3>

                  <p>
                    Google-koppeling en livestreamstatus
                  </p>
                </div>
              </div>

              <div className="settings-status-card">
                <div className="settings-status-line">
                  <span>
                    Google koppeling
                  </span>

                  <strong
                    className={
                      authStatus?.connected &&
                      !authStatus?.needs_relogin &&
                      !authStatus?.expired
                        ? "status-good"
                        : "status-muted"
                    }
                  >
                    {authStatus?.connected
                      ? authStatus.expired
                        ? "Verlopen"
                        : "Gekoppeld"
                      : "Niet gekoppeld"}
                  </strong>
                </div>

                <div className="settings-status-line">
                  <span>
                    Resterende tijd
                  </span>

                  <strong>
                    {authStatus?.connected
                      ? formatRemainingTime(
                          authStatus.seconds_remaining
                        )
                      : "—"}
                  </strong>
                </div>

                <div className="settings-status-line">
                  <span>
                    Livechat
                  </span>

                  <strong
                    className={
                      youtubeConnected
                        ? "status-good"
                        : "status-muted"
                    }
                  >
                    {youtubeConnected
                      ? "Verbonden"
                      : "Niet verbonden"}
                  </strong>
                </div>

                <div className="settings-status-line">
                  <span>
                    Livestream
                  </span>

                  <strong
                    className={
                      youtubeViewerLive
                        ? "status-good"
                        : "status-muted"
                    }
                  >
                    {youtubeViewerLive
                      ? "Live"
                      : "Offline"}
                  </strong>
                </div>
              </div>

              <div className="settings-detail">
                <span>
                  Status
                </span>

                <p>
                  {youtubeStatus}
                </p>
              </div>

              <div className="settings-detail">
                <span>
                  Google
                </span>

                <p>
                  {googleLinkText}
                </p>
              </div>

              {youtubeTitle && (
                <div className="settings-detail">
                  <span>
                    Livestream
                  </span>

                  <p>
                    {youtubeTitle}
                  </p>
                </div>
              )}

              {youtubeVideoId && (
                <div className="settings-detail">
                  <span>
                    Video ID
                  </span>

                  <p>
                    {youtubeVideoId}
                  </p>
                </div>
              )}

              {oauthStatus && (
                <div className="settings-message">
                  {oauthStatus}
                </div>
              )}

              <button
                type="button"
                className="youtube-link-button"
                onClick={
                  handleYouTubeLogin
                }
                disabled={
                  oauthLoading ||
                  autoConnectLoading
                }
              >
                {oauthLoading
                  ? "Google login..."
                  : autoConnectLoading
                    ? "YouTube controleren..."
                    : authStatus?.needs_relogin
                      ? "Google opnieuw koppelen"
                      : authStatus?.connected
                        ? "YouTube opnieuw koppelen"
                        : "YouTube koppelen"}
              </button>
            </div>

            {/* =============================================
                TIKTOK SETTINGS
            ============================================= */}

            <div className="settings-section">
              <div className="settings-section-title">
                <div className="settings-tiktok-icon">
                  <TikTokIcon />
                </div>

                <div>
                  <h3>
                    TikTok
                  </h3>

                  <p>
                    LIVE chat via TikTok sidecar
                  </p>
                </div>
              </div>

              <div className="settings-status-card">
                <div className="settings-status-line">
                  <span>
                    Account
                  </span>

                  <strong>
                    @{TIKTOK_USERNAME}
                  </strong>
                </div>

                <div className="settings-status-line">
                  <span>
                    Livechat
                  </span>

                  <strong
                    className={
                      tiktokConnected
                        ? "status-good"
                        : "status-muted"
                    }
                  >
                    {tiktokConnected
                      ? "Verbonden"
                      : "Niet verbonden"}
                  </strong>
                </div>

                <div className="settings-status-line">
                  <span>
                    Livestream
                  </span>

                  <strong
                    className={
                      tiktokConnected
                        ? "status-good"
                        : "status-muted"
                    }
                  >
                    {tiktokConnected
                      ? "Live"
                      : "Offline"}
                  </strong>
                </div>

                <div className="settings-status-line">
                  <span>
                    Chat helper
                  </span>

                  <strong
                    className={
                      tiktokConnected
                        ? "status-good"
                        : "status-muted"
                    }
                  >
                    {tiktokConnected
                      ? "Actief"
                      : "Wachten op LIVE"}
                  </strong>
                </div>
              </div>

              <div className="settings-detail">
                <span>
                  Verbinding
                </span>

                <p>
                  {tiktokConnected
                    ? `TikTok LIVE @${TIKTOK_USERNAME} is verbonden. Nieuwe chatberichten verschijnen automatisch in SDJFAM Chat.`
                    : `SDJFAM Chat wacht op een actieve TikTok LIVE van @${TIKTOK_USERNAME}.`}
                </p>
              </div>
            </div>
          </aside>
        </div>
      )}
    </main>
  );
}

export default App;