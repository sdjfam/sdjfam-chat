import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { check } from "@tauri-apps/plugin-updater";
import tmi from "tmi.js";

import AlertOverlay from "./alerts/AlertOverlay";
import "./App.css";

// =========================================================
// TYPES
// =========================================================

type Platform = "twitch" | "youtube" | "tiktok";

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

// =========================================================
// GLOBALS
// =========================================================

let twitchEventSubLifecycle: Promise<void> = Promise.resolve();

const TWITCH_CLIENT_ID =
  import.meta.env.VITE_TWITCH_CLIENT_ID?.trim() ?? "";

const TWITCH_CHANNEL = "sdjfam";

const ALERT_EVENT_TYPES = new Set([
  "follow",
  "subscription",
  "gift_subscription",
  "bits",
  "raid",
]);

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

function formatRemainingTime(seconds: number): string {
  if (seconds <= 0) {
    return "verlopen";
  }

  const totalHours = Math.floor(seconds / 3600);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;

  if (days > 0) {
    return `${days} dagen ${hours} uur`;
  }

  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0) {
    return `${hours} uur ${minutes} min`;
  }

  return `${Math.max(minutes, 1)} min`;
}

// =========================================================
// ICONS
// =========================================================

function TwitchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M4 2h17v11.2l-4.8 4.8h-3.7L10 20.5H7.5V18H3V5L4 2Zm1.5 2L5 5.5V16h4.5v2.3l2.3-2.3h4l3.2-3.2V4H5.5Zm5 3h2v5h-2V7Zm5 0h2v5h-2V7Z"
      />
    </svg>
  );
}

function YouTubeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M21.6 7.2a3 3 0 0 0-2.1-2.1C17.6 4.6 12 4.6 12 4.6s-5.6 0-7.5.5A3 3 0 0 0 2.4 7.2 31 31 0 0 0 2 12a31 31 0 0 0 .4 4.8 3 3 0 0 0 2.1 2.1c1.9.5 7.5.5 7.5.5s5.6 0 7.5-.5a3 3 0 0 0 2.1-2.1A31 31 0 0 0 22 12a31 31 0 0 0-.4-4.8ZM10 15.5v-7l6 3.5-6 3.5Z"
      />
    </svg>
  );
}

function TikTokIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M15.3 3c.3 2.2 1.6 3.6 3.7 3.8v3.1a8.4 8.4 0 0 1-3.7-.9v6.3a5.7 5.7 0 1 1-4.9-5.6v3.2a2.5 2.5 0 1 0 1.7 2.4V3h3.2Z"
      />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
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
  if (platform === "twitch") {
    return <TwitchIcon />;
  }

  if (platform === "youtube") {
    return <YouTubeIcon />;
  }

  return <TikTokIcon />;
}

function getPlatformLabel(platform: Platform) {
  if (platform === "twitch") {
    return "Twitch";
  }

  if (platform === "youtube") {
    return "YouTube";
  }

  return "TikTok";
}

// =========================================================
// APP
// =========================================================

function App() {
  const [messages, setMessages] =
    useState<ChatMessage[]>([]);

  const messageListRef =
    useRef<HTMLDivElement | null>(null);

  // Alerts
  const [activeAlert, setActiveAlert] =
    useState<SdjfamEvent | null>(null);

  const [alertQueue, setAlertQueue] =
    useState<SdjfamEvent[]>([]);

  useEffect(() => {
    if (!activeAlert) {
      return;
    }

    const timer = window.setTimeout(() => {
      setActiveAlert(null);
    }, 5000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [activeAlert]);

  useEffect(() => {
    if (activeAlert || alertQueue.length === 0) {
      return;
    }

    const nextAlert = alertQueue[0];

    setActiveAlert(nextAlert);

    setAlertQueue(
      (currentQueue) =>
        currentQueue.slice(1)
    );
  }, [activeAlert, alertQueue]);

  // Twitch
  const [twitchConnected, setTwitchConnected] =
    useState(false);

  const [twitchViewerCount, setTwitchViewerCount] =
    useState<number | null>(null);

  const [twitchViewerLive, setTwitchViewerLive] =
    useState(false);

  const [twitchAuthStatus, setTwitchAuthStatus] =
    useState<TwitchAuthStatus | null>(null);

  const [twitchOauthLoading, setTwitchOauthLoading] =
    useState(false);

  const [twitchOauthStatus, setTwitchOauthStatus] =
    useState("");

  const [twitchEventSubStatus, setTwitchEventSubStatus] =
    useState<TwitchEventSubStatus>({
      status: "idle",
      message: "Twitch EventSub voorbereiden...",
    });

  const [
    twitchEventSubGeneration,
    setTwitchEventSubGeneration,
  ] = useState(0);

  const twitchEventIdsRef =
    useRef<Set<string>>(new Set());

  // Simulator
  const [
    eventSimulatorLoading,
    setEventSimulatorLoading,
  ] = useState<string | null>(null);

  const [
    eventSimulatorStatus,
    setEventSimulatorStatus,
  ] = useState("");

  // YouTube
  const [youtubeConnected, setYoutubeConnected] =
    useState(false);

  const [youtubeStatus, setYoutubeStatus] =
    useState("YouTube nog niet gekoppeld");

  const [youtubeLiveChatId, setYoutubeLiveChatId] =
    useState<string | null>(null);

  const [youtubeVideoId, setYoutubeVideoId] =
    useState<string | null>(null);

  const [youtubeTitle, setYoutubeTitle] =
    useState<string | null>(null);

  const [youtubeViewerCount, setYoutubeViewerCount] =
    useState<number | null>(null);

  const [youtubeViewerLive, setYoutubeViewerLive] =
    useState(false);

  const youtubeMessageIdsRef =
    useRef<Set<string>>(new Set());

  const youtubePlatformActive =
    youtubeConnected || youtubeViewerLive;

  // Settings
  const [settingsOpen, setSettingsOpen] =
    useState(false);

  // OAuth
  const [oauthLoading, setOauthLoading] =
    useState(false);

  const [autoConnectLoading, setAutoConnectLoading] =
    useState(true);

  const [oauthStatus, setOauthStatus] =
    useState("");

  const [authStatus, setAuthStatus] =
    useState<YouTubeAuthStatus | null>(null);

  // Updater
  const [updateVersion, setUpdateVersion] =
    useState<string | null>(null);

  const [updateInstalling, setUpdateInstalling] =
    useState(false);

  const [updateStatus, setUpdateStatus] =
    useState("");

  const [updateNotes, setUpdateNotes] =
    useState("");

  const [updatePopupOpen, setUpdatePopupOpen] =
    useState(false);

  const updateRef =
    useRef<Awaited<ReturnType<typeof check>>>(null);

  // =========================================================
  // UPDATE CHECK
  // =========================================================

  useEffect(() => {
    let cancelled = false;

    async function checkForUpdates() {
      try {
        const update = await check({
          timeout: 30000,
        });

        if (cancelled) {
          if (update) {
            await update.close().catch(() => {});
          }

          return;
        }

        if (!update) {
          updateRef.current = null;
          setUpdateVersion(null);
          setUpdateNotes("");
          setUpdatePopupOpen(false);
          setUpdateStatus("");
          return;
        }

        updateRef.current = update;
        setUpdateVersion(update.version);

        const notes =
          typeof update.body === "string"
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
      } catch (error) {
        console.warn(
          "Updatecontrole niet beschikbaar:",
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
    const update = updateRef.current;

    if (!update || updateInstalling) {
      return;
    }

    try {
      setUpdateInstalling(true);

      setUpdateStatus(
        `Update ${update.version} downloaden...`
      );

      let downloaded = 0;
      let contentLength: number | undefined;

      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            contentLength = event.data.contentLength;

            setUpdateStatus(
              `Update ${update.version} downloaden...`
            );
            break;

          case "Progress":
            downloaded += event.data.chunkLength;

            if (
              contentLength &&
              contentLength > 0
            ) {
              const percentage =
                Math.min(
                  100,
                  Math.round(
                    (downloaded / contentLength) * 100
                  )
                );

              setUpdateStatus(
                `Update ${update.version} downloaden... ${percentage}%`
              );
            }
            break;

          case "Finished":
            setUpdateStatus(
              "Update gedownload. Installeren..."
            );
            break;
        }
      });

      setUpdateStatus(
        "Update wordt geïnstalleerd..."
      );
    } catch (error) {
      console.error(
        "Update installeren mislukt:",
        error
      );

      setUpdateStatus(
        `Update mislukt: ${String(error)}`
      );

      setUpdateInstalling(false);
    }
  }

  // =========================================================
  // YOUTUBE AUTH STATUS
  // =========================================================

  async function refreshAuthStatus() {
    try {
      const result =
        await invoke<YouTubeAuthStatus>(
          "youtube_auth_status"
        );

      setAuthStatus(result);
    } catch (error) {
      console.error(
        "YouTube auth status error:",
        error
      );

      setAuthStatus(null);
    }
  }

  useEffect(() => {
    void refreshAuthStatus();

    const timer =
      window.setInterval(() => {
        void refreshAuthStatus();
      }, 60000);

    return () => {
      window.clearInterval(timer);
    };
  }, []);

  // =========================================================
  // YOUTUBE AUTO CONNECT
  // =========================================================

  useEffect(() => {
    let cancelled = false;

    async function autoConnectYouTube() {
      try {
        setAutoConnectLoading(true);

        setYoutubeStatus(
          "YouTube automatisch verbinden..."
        );

        const result =
          await invoke<YouTubeAutoConnectResult>(
            "youtube_auto_connect"
          );

        if (cancelled) {
          return;
        }

        if (result.needs_relogin) {
          setYoutubeConnected(false);
          setYoutubeViewerLive(false);
          setYoutubeLiveChatId(null);
          setYoutubeVideoId(null);
          setYoutubeTitle(null);

          setYoutubeStatus(
            "Google opnieuw koppelen"
          );

          setOauthStatus(result.message);

          await refreshAuthStatus();
          return;
        }

        if (!result.discovery_available) {
          setYoutubeConnected(false);
          setYoutubeViewerLive(false);
          setYoutubeLiveChatId(null);
          setYoutubeVideoId(null);
          setYoutubeTitle(null);

          setYoutubeStatus(
            "YouTube livestream-detectie tijdelijk niet beschikbaar"
          );

          setOauthStatus(result.message);
          return;
        }

        if (!result.live) {
          setYoutubeConnected(false);
          setYoutubeViewerLive(false);
          setYoutubeLiveChatId(null);
          setYoutubeVideoId(null);
          setYoutubeTitle(null);

          setYoutubeStatus(
            "Geen actieve YouTube livestream"
          );

          setOauthStatus(result.message);
          return;
        }

        setYoutubeViewerLive(true);

        if (!result.live_chat_id) {
          setYoutubeConnected(false);
          setYoutubeLiveChatId(null);
          setYoutubeVideoId(result.video_id);
          setYoutubeTitle(result.title);

          setYoutubeStatus(
            "YouTube live, maar livechat niet gevonden"
          );

          setOauthStatus(
            "De actieve YouTube-stream heeft geen live chat."
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

        await refreshAuthStatus();
      } catch (error) {
        if (cancelled) {
          return;
        }

        console.error(
          "YouTube auto-connect error:",
          error
        );

        setYoutubeConnected(false);
        setYoutubeViewerLive(false);
        setYoutubeLiveChatId(null);

        const errorText = String(error);

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
          setAutoConnectLoading(false);
        }
      }
    }

    void autoConnectYouTube();

    return () => {
      cancelled = true;
    };
  }, []);

  // =========================================================
  // TWITCH AUTH + VIEWERS
  // =========================================================

  async function refreshTwitchAuthStatus() {
    if (!TWITCH_CLIENT_ID) {
      setTwitchAuthStatus(null);
      return;
    }

    try {
      const result =
        await invoke<TwitchAuthStatus>(
          "twitch_auth_status"
        );

      setTwitchAuthStatus(result);
    } catch (error) {
      console.error(
        "Twitch auth status error:",
        error
      );

      setTwitchAuthStatus(null);
    }
  }

  async function refreshTwitchViewerCount() {
    if (!TWITCH_CLIENT_ID) {
      setTwitchViewerCount(null);
      setTwitchViewerLive(false);
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

      setTwitchViewerCount(
        result.live
          ? result.viewer_count
          : null
      );
    } catch (error) {
      console.warn(
        "Twitch viewer count niet beschikbaar:",
        error
      );

      setTwitchViewerCount(null);
      setTwitchViewerLive(false);
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
      window.clearInterval(timer);
    };
  }, []);

  // =========================================================
  // TWITCH EVENTSUB + ALERT ROUTING
  // =========================================================

  useEffect(() => {
    let cancelled = false;

    const unlisteners: UnlistenFn[] = [];

    let startAttempted = false;

    const setup = async () => {
      if (cancelled) {
        return;
      }

      if (!TWITCH_CLIENT_ID) {
        setTwitchEventSubStatus({
          status: "error",
          message:
            "Twitch EventSub kan niet starten: VITE_TWITCH_CLIENT_ID ontbreekt in deze build.",
        });

        return;
      }

      try {
        const statusUnlisten =
          await listen<TwitchEventSubStatus>(
            "twitch-eventsub-status",
            ({ payload }) => {
              if (!cancelled) {
                setTwitchEventSubStatus(
                  payload
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
                payload.platform !== "twitch" ||
                payload.event_type === "chat_message"
              ) {
                return;
              }

              const ids =
                twitchEventIdsRef.current;

              if (ids.has(payload.id)) {
                return;
              }

              ids.add(payload.id);

              if (ids.size > 1000) {
                const firstId =
                  ids.values().next().value;

                if (firstId) {
                  ids.delete(firstId);
                }
              }

              // Alle ondersteunde Twitch alert-events
              // lopen nu door dezelfde alert-route.
              if (
                ALERT_EVENT_TYPES.has(
                  payload.event_type
                )
              ) {
                setAlertQueue(
                  (currentQueue) => [
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
          status: "connecting",
          message:
            "Twitch EventSub starten...",
        });

        startAttempted = true;

        await invoke(
          "twitch_start_eventsub",
          {
            clientId:
              TWITCH_CLIENT_ID,
          }
        );
      } catch (error) {
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
            if (startAttempted) {
              await invoke(
                "twitch_stop_eventsub"
              ).catch((error) => {
                console.warn(
                  "Twitch EventSub stoppen mislukt:",
                  error
                );
              });
            }
          }
        );
    };
  }, [twitchEventSubGeneration]);

  async function handleTwitchLogin() {
    if (
      twitchOauthLoading ||
      !TWITCH_CLIENT_ID
    ) {
      return;
    }

    try {
      setTwitchOauthLoading(true);

      setTwitchOauthStatus(
        "Twitch koppeling openen..."
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

      if (result.connected) {
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

      setTwitchOauthStatus(
        `Twitch koppelen mislukt: ${String(
          error
        )}`
      );

      await refreshTwitchAuthStatus();
    } finally {
      setTwitchOauthLoading(false);
    }
  }

  // =========================================================
  // EVENT ENGINE SIMULATOR
  // =========================================================

  async function handleSimulateEvent(
    eventType: string
  ) {
    if (eventSimulatorLoading) {
      return;
    }

    try {
      setEventSimulatorLoading(
        eventType
      );

      setEventSimulatorStatus(
        `Testevent ${eventType} versturen...`
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
    } catch (error) {
      console.error(
        "Event Engine simulator fout:",
        error
      );

      setEventSimulatorStatus(
        `Simulator fout: ${String(error)}`
      );
    } finally {
      setEventSimulatorLoading(null);
    }
  }

  // =========================================================
  // TWITCH CHAT
  // =========================================================

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
        setTwitchConnected(true);
      }
    );

    client.on(
      "disconnected",
      () => {
        setTwitchConnected(false);
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

        setMessages(
          (current) => [
            ...current,
            {
              id:
                `twitch-${Date.now()}-${Math.random()}`,
              platform: "twitch",
              username,
              message,
            },
          ]
        );
      }
    );

    client
      .connect()
      .catch((error) => {
        console.error(
          "Twitch connection error:",
          error
        );

        setTwitchConnected(false);
      });

    return () => {
      client
        .disconnect()
        .catch(() => {});
    };
  }, []);

  // =========================================================
  // YOUTUBE VIEWERS
  // =========================================================

  useEffect(() => {
    if (!youtubeVideoId) {
      setYoutubeViewerCount(null);
      setYoutubeViewerLive(false);
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

        setYoutubeViewerCount(
          result.live
            ? result.viewer_count
            : null
        );

        if (!result.live) {
          setYoutubeConnected(false);

          setYoutubeStatus(
            "YouTube livestream offline"
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

        setYoutubeViewerCount(null);
      }
    }

    void refreshYouTubeViewerCount();

    const timer =
      window.setInterval(() => {
        void refreshYouTubeViewerCount();
      }, 30000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [youtubeVideoId]);

  // =========================================================
  // YOUTUBE GRPC CHAT
  // =========================================================

  useEffect(() => {
    if (!youtubeLiveChatId) {
      setYoutubeConnected(false);
      return;
    }

    let cancelled = false;

    let unlistenMessage:
      UnlistenFn | null = null;

    let unlistenStatus:
      UnlistenFn | null = null;

    let unlistenError:
      UnlistenFn | null = null;

    youtubeMessageIdsRef.current.clear();

    async function startYouTubeGrpcChat(
      liveChatId: string
    ) {
      try {
        unlistenMessage =
          await listen<YouTubeGrpcChatMessage>(
            "youtube-chat-message",
            (event) => {
              if (cancelled) {
                return;
              }

              const chat =
                event.payload;

              setYoutubeConnected(true);
              setYoutubeViewerLive(true);

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

              switch (
                status.status
              ) {
                case "connected":
                  setYoutubeConnected(true);
                  setYoutubeViewerLive(true);
                  setYoutubeStatus(
                    "YouTube verbonden"
                  );
                  break;

                case "reconnecting":
                  setYoutubeConnected(false);
                  setYoutubeStatus(
                    "YouTube livechat opnieuw verbinden..."
                  );
                  break;

                case "offline":
                  setYoutubeConnected(false);
                  setYoutubeViewerLive(false);
                  setYoutubeStatus(
                    "YouTube livestream offline"
                  );
                  break;

                case "stopped":
                  setYoutubeConnected(false);
                  setYoutubeStatus(
                    "YouTube chatstream gestopt"
                  );
                  break;

                case "error":
                  setYoutubeConnected(false);
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
                    setYoutubeViewerLive(true);
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

              setYoutubeConnected(false);

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

        setYoutubeConnected(false);

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

        setYoutubeConnected(true);
        setYoutubeViewerLive(true);

        setYoutubeStatus(
          "YouTube verbonden"
        );
      } catch (error) {
        if (cancelled) {
          return;
        }

        console.error(
          "YouTube gRPC start error:",
          error
        );

        setYoutubeConnected(false);

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

      setYoutubeConnected(false);

      void invoke<string>(
        "youtube_stop_chat_stream"
      ).catch((error) => {
        console.error(
          "YouTube gRPC stop error:",
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

  // =========================================================
  // YOUTUBE LOGIN
  // =========================================================

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

      const result =
        await invoke<YouTubeLoginResult>(
          "youtube_login"
        );

      console.log(
        "OAuth result:",
        result
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

      setYoutubeViewerLive(true);

      setOauthStatus(
        `${result.message} • ${result.title}`
      );

      setYoutubeStatus(
        "YouTube livechat gevonden"
      );

      await refreshAuthStatus();
    } catch (error) {
      console.error(
        "OAuth error:",
        error
      );

      setYoutubeConnected(false);
      setYoutubeViewerLive(false);
      setYoutubeLiveChatId(null);

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

  // =========================================================
  // AUTO SCROLL
  // =========================================================

  useEffect(() => {
    const list =
      messageListRef.current;

    if (!list) {
      return;
    }

    list.scrollTop =
      list.scrollHeight;
  }, [messages]);

  // =========================================================
  // GOOGLE STATUS TEXT
  // =========================================================

  let googleLinkText =
    "Google niet gekoppeld";

  if (authStatus?.connected) {
    if (authStatus.expired) {
      googleLinkText =
        "Google koppeling verlopen";
    } else {
      googleLinkText =
        `Google koppeling: nog ${formatRemainingTime(
          authStatus.seconds_remaining
        )}`;
    }
  }

  // =========================================================
  // UI
  // =========================================================

  return (
    <main className="app-shell">
      <AlertOverlay
        event={activeAlert}
      />

      {updatePopupOpen && updateVersion && (
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
            <strong>Wat is er nieuw?</strong>

            <div>
              {updateNotes}
            </div>
          </div>

          {updateInstalling && updateStatus && (
            <p className="update-popup-status">
              {updateStatus}
            </p>
          )}

          <div className="update-popup-actions">
            <button
              type="button"
              className="update-popup-later"
              onClick={() =>
                setUpdatePopupOpen(false)
              }
              disabled={updateInstalling}
            >
              Later
            </button>

            <button
              type="button"
              className="update-popup-now"
              onClick={() =>
                void handleInstallUpdate()
              }
              disabled={updateInstalling}
            >
              {updateInstalling
                ? "Update installeren..."
                : "Nu updaten"}
            </button>
          </div>
        </div>
      </div>
    )}

    <header className="topbar">
        <div className="topbar-brand">
          <h1>
            SDJFAM Chat
          </h1>

          <p>
            Twitch + YouTube live chat
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
                twitchViewerCount !== null
                  ? twitchViewerCount.toLocaleString()
                  : "—"}
              </strong>
            </div>
          </div>

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
                youtubeViewerCount !== null
                  ? youtubeViewerCount.toLocaleString()
                  : "—"}
              </strong>
            </div>
          </div>

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

      <section className="chat-panel">
        {messages.length === 0 ? (
          <div className="empty-state">
            <h2>
              {twitchConnected
                ? "Twitch chat verbonden"
                : "Twitch chat verbinden..."}
            </h2>

            <p>
              {twitchConnected
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
                Live: {youtubeTitle}
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
            ref={
              messageListRef
            }
          >
            {messages.map(
              (chat) => (
                <div
                  className={`chat-message ${chat.platform}`}
                  key={
                    chat.id
                  }
                >
                  <span
                    className={`platform-badge ${chat.platform}-badge`}
                    title={
                      getPlatformLabel(
                        chat.platform
                      )
                    }
                    aria-label={
                      getPlatformLabel(
                        chat.platform
                      )
                    }
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

      {settingsOpen && (
        <div
          className="settings-backdrop"
          onMouseDown={() =>
            setSettingsOpen(false)
          }
        >
          <aside
            className="settings-panel"
            onMouseDown={(event) =>
              event.stopPropagation()
            }
          >
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
                  setSettingsOpen(false)
                }
                aria-label="Settings sluiten"
              >
                ×
              </button>
            </div>

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
                    Chat en live kijkersaantal
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

                <div className="settings-status-line">
                  <span>
                    Kijkers
                  </span>

                  <strong>
                    {twitchViewerLive &&
                    twitchViewerCount !== null
                      ? twitchViewerCount.toLocaleString()
                      : "—"}
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
                  {twitchEventSubStatus.message}
                </p>

                {eventSubNeedsRelogin(
                  twitchEventSubStatus
                ) && (
                  <p className="settings-message">
                    Klik hieronder op Twitch opnieuw
                    koppelen en geef toestemming voor de
                    EventSub-rechten (volgers,
                    abonnementen en bits). EventSub start
                    daarna automatisch opnieuw.
                  </p>
                )}
              </div>

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
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "8px",
                    marginTop: "12px",
                  }}
                >
                  <button
                    type="button"
                    className="twitch-link-button"
                    disabled={
                      eventSimulatorLoading !== null
                    }
                    onClick={() =>
                      void handleSimulateEvent(
                        "follow"
                      )
                    }
                  >
                    {eventSimulatorLoading ===
                    "follow"
                      ? "Testen..."
                      : "Test Follow"}
                  </button>

                  <button
                    type="button"
                    className="twitch-link-button"
                    disabled={
                      eventSimulatorLoading !== null
                    }
                    onClick={() =>
                      void handleSimulateEvent(
                        "subscription"
                      )
                    }
                  >
                    {eventSimulatorLoading ===
                    "subscription"
                      ? "Testen..."
                      : "Test Sub"}
                  </button>

                  <button
                    type="button"
                    className="twitch-link-button"
                    disabled={
                      eventSimulatorLoading !== null
                    }
                    onClick={() =>
                      void handleSimulateEvent(
                        "gift_subscription"
                      )
                    }
                  >
                    {eventSimulatorLoading ===
                    "gift_subscription"
                      ? "Testen..."
                      : "Test Gift Sub"}
                  </button>

                  <button
                    type="button"
                    className="twitch-link-button"
                    disabled={
                      eventSimulatorLoading !== null
                    }
                    onClick={() =>
                      void handleSimulateEvent(
                        "bits"
                      )
                    }
                  >
                    {eventSimulatorLoading ===
                    "bits"
                      ? "Testen..."
                      : "Test Bits"}
                  </button>

                  <button
                    type="button"
                    className="twitch-link-button"
                    disabled={
                      eventSimulatorLoading !== null
                    }
                    onClick={() =>
                      void handleSimulateEvent(
                        "raid"
                      )
                    }
                  >
                    {eventSimulatorLoading ===
                    "raid"
                      ? "Testen..."
                      : "Test Raid"}
                  </button>
                </div>

                {eventSimulatorStatus && (
                  <p className="settings-message">
                    {eventSimulatorStatus}
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

                <div className="settings-status-line">
                  <span>
                    Kijkers
                  </span>

                  <strong>
                    {youtubeViewerLive &&
                    youtubeViewerCount !== null
                      ? youtubeViewerCount.toLocaleString()
                      : "—"}
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
          </aside>
        </div>
      )}
    </main>
  );
}

export default App;