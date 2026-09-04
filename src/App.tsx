import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  listen,
  type UnlistenFn,
} from "@tauri-apps/api/event";
import tmi from "tmi.js";
import "./App.css";

// =========================================================
// TYPES
// =========================================================

type Platform = "twitch" | "youtube";

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

// =========================================================
// TIMER FORMAT
// =========================================================

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

// =========================================================
// APP
// =========================================================

function App() {
  // Chatberichten bestaan alleen in het geheugen.
  // Na volledig afsluiten en opnieuw starten begint alles leeg.
  const [messages, setMessages] =
    useState<ChatMessage[]>([]);

  // -------------------------------------------------------
  // TWITCH STATE
  // -------------------------------------------------------

  const [
    twitchConnected,
    setTwitchConnected,
  ] =
    useState(false);

  // -------------------------------------------------------
  // YOUTUBE STATE
  // -------------------------------------------------------

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

  // -------------------------------------------------------
  // OAUTH / AUTO-CONNECT STATE
  // -------------------------------------------------------

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

  // -------------------------------------------------------
  // REFERENCES
  // -------------------------------------------------------

  const messageListRef =
    useRef<HTMLDivElement | null>(
      null
    );

  const youtubeMessageIdsRef =
    useRef<Set<string>>(
      new Set()
    );

  // =========================================================
  // GOOGLE KOPPELING STATUS / 7-DAGEN TIMER
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
    refreshAuthStatus();

    const timer =
      window.setInterval(() => {
        refreshAuthStatus();
      }, 60000);

    return () => {
      window.clearInterval(timer);
    };
  }, []);

  // =========================================================
  // YOUTUBE AUTO-CONNECT BIJ OPSTARTEN
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
          setYoutubeLiveChatId(null);
          setYoutubeVideoId(null);
          setYoutubeTitle(null);

          setYoutubeStatus(
            "Google opnieuw koppelen"
          );

          setOauthStatus(
            result.message
          );

          await refreshAuthStatus();
          return;
        }

if (!result.discovery_available) {
  setYoutubeConnected(false);
  setYoutubeLiveChatId(null);
  setYoutubeVideoId(null);
  setYoutubeTitle(null);

  setYoutubeStatus(
    "YouTube livestream-detectie tijdelijk niet beschikbaar"
  );

  setOauthStatus(
    result.message
  );

  return;
}

if (!result.live) {
  setYoutubeConnected(false);
  setYoutubeLiveChatId(null);
  setYoutubeVideoId(null);
  setYoutubeTitle(null);

  setYoutubeStatus(
    "Geen actieve YouTube livestream"
  );

  setOauthStatus(
    result.message
  );

  return;
}

        if (!result.live) {
          setYoutubeConnected(false);
          setYoutubeLiveChatId(null);
          setYoutubeVideoId(null);
          setYoutubeTitle(null);

          setYoutubeStatus(
            "Geen actieve YouTube livestream"
        );

        setOauthStatus(
          result.message
        );

           return;
         }

        if (!result.live_chat_id) {
          setYoutubeConnected(false);
          setYoutubeLiveChatId(null);

          setYoutubeStatus(
            "YouTube livechat niet gevonden"
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
        setYoutubeLiveChatId(null);

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
          setAutoConnectLoading(false);
        }
      }
    }

    autoConnectYouTube();

    return () => {
      cancelled = true;
    };
  }, []);

  // =========================================================
  // TWITCH
  // =========================================================

  useEffect(() => {
    const client =
      new tmi.Client({
        connection: {
          secure: true,
          reconnect: true,
        },

        channels: ["sdjfam"],
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
  // YOUTUBE GRPC STREAMLIST
  // =========================================================

  useEffect(() => {
    if (!youtubeLiveChatId) {
      return;
    }

    let cancelled = false;

    let unlistenMessage:
      UnlistenFn | null = null;

    let unlistenStatus:
      UnlistenFn | null = null;

    let unlistenError:
      UnlistenFn | null = null;

    // Nieuwe livestream = nieuwe duplicate-cache.
    youtubeMessageIdsRef.current.clear();

    async function startYouTubeGrpcChat(
      liveChatId: string
    ) {
      try {
        // ---------------------------------------------------
        // CHATBERICHTEN UIT RUST
        // ---------------------------------------------------

        unlistenMessage =
          await listen<YouTubeGrpcChatMessage>(
            "youtube-chat-message",
            (event) => {
              if (cancelled) {
                return;
              }

              const chat =
                event.payload;

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
                    platform: "youtube",
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

        // ---------------------------------------------------
        // VERBINDINGSSTATUS UIT RUST
        // ---------------------------------------------------

        unlistenStatus =
          await listen<YouTubeGrpcStatus>(
            "youtube-chat-status",
            (event) => {
              if (cancelled) {
                return;
              }

              const status =
                event.payload;

              setYoutubeConnected(
                status.connected
              );

              switch (status.status) {
                case "connected":
                  setYoutubeStatus(
                    "YouTube verbonden"
                  );
                  break;

                case "reconnecting":
                  setYoutubeStatus(
                    "YouTube opnieuw verbinden..."
                  );
                  break;

                case "offline":
                  setYoutubeStatus(
                    "YouTube livestream offline"
                  );
                  break;

                case "stopped":
                  setYoutubeStatus(
                    "YouTube chatstream gestopt"
                  );
                  break;

                case "error":
                  setYoutubeStatus(
                    "YouTube chat fout"
                  );
                  break;

                default:
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

        // ---------------------------------------------------
        // FOUTEN UIT RUST
        // ---------------------------------------------------

        unlistenError =
          await listen<string>(
            "youtube-chat-error",
            (event) => {
              if (cancelled) {
                return;
              }

              const errorText =
                String(event.payload);

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

        // Pas starten NADAT alle listeners klaarstaan.
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

    startYouTubeGrpcChat(
      youtubeLiveChatId
    );

    return () => {
      cancelled = true;

      // Niet alleen de React-listeners verwijderen:
      // ook de echte Rust/gRPC-stream stoppen.
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
  // HANDMATIGE GOOGLE / YOUTUBE OAUTH
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
  // GOOGLE TIMER TEKST
  // =========================================================

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

  // =========================================================
  // UI
  // =========================================================

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>SDJFAM Chat</h1>

          <p>
            Twitch + YouTube live chat
          </p>

          <p
            style={{
              marginTop: "5px",
              fontSize: "11px",
              color:
                authStatus?.needs_relogin
                  ? "#ff8b97"
                  : "#8f96a6",
            }}
          >
            {googleLinkText}
          </p>
        </div>

        <div className="status-row">
          <button
            type="button"
            onClick={
              handleYouTubeLogin
            }
            disabled={
              oauthLoading ||
              autoConnectLoading
            }
            style={{
              padding:
                "7px 11px",

              border:
                authStatus
                  ?.needs_relogin
                  ? "1px solid rgba(255, 40, 65, 0.8)"
                  : "1px solid rgba(255, 40, 65, 0.55)",

              borderRadius:
                "8px",

              background:
                authStatus
                  ?.needs_relogin
                  ? "rgba(255, 35, 60, 0.22)"
                  : "rgba(255, 35, 60, 0.12)",

              color:
                "#ff8b97",

              fontSize:
                "12px",

              fontWeight:
                700,

              cursor:
                oauthLoading ||
                autoConnectLoading
                  ? "default"
                  : "pointer",
            }}
          >
            {oauthLoading
              ? "Google login..."
              : autoConnectLoading
              ? "YouTube controleren..."
              : authStatus
                  ?.needs_relogin
              ? "Google opnieuw koppelen"
              : authStatus
                  ?.connected
              ? "YouTube gekoppeld"
              : "YouTube OAuth"}
          </button>

          <span
            className={`status twitch ${
              twitchConnected
                ? "connected"
                : ""
            }`}
          >
            {twitchConnected
              ? "● Twitch"
              : "○ Twitch"}
          </span>

          <span
            className={`status youtube ${
              youtubeConnected
                ? "connected"
                : ""
            }`}
          >
            {youtubeConnected
              ? "● YouTube"
              : "○ YouTube"}
          </span>
        </div>
      </header>

      <section className="chat-panel">
        {messages.length === 0 ? (
          <div className="empty-state">
            <h2>
              {twitchConnected
                ? "Twitch verbonden"
                : "Twitch verbinden..."}
            </h2>

            <p>
              {twitchConnected
                ? `Nieuwe berichten verschijnen hier. ${youtubeStatus}`
                : "Even wachten terwijl SDJFAM Chat verbinding maakt."}
            </p>

            {authStatus && (
              <p
                style={{
                  marginTop:
                    "12px",

                  color:
                    authStatus
                      .needs_relogin
                      ? "#ff8b97"
                      : "#b9c0cf",

                  fontSize:
                    "12px",
                }}
              >
                {googleLinkText}
              </p>
            )}

            {oauthStatus && (
              <p
                style={{
                  marginTop:
                    "12px",

                  color:
                    "#b9c0cf",
                }}
              >
                {oauthStatus}
              </p>
            )}

            {youtubeTitle && (
              <p
                style={{
                  marginTop:
                    "8px",

                  color:
                    "#8f96a6",

                  fontSize:
                    "12px",
                }}
              >
                Live:{" "}
                {youtubeTitle}
              </p>
            )}

            {youtubeVideoId && (
              <p
                style={{
                  marginTop:
                    "4px",

                  color:
                    "#686f7e",

                  fontSize:
                    "11px",
                }}
              >
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
                    className={`platform-badge ${
                      chat.platform ===
                      "twitch"
                        ? "twitch-badge"
                        : "youtube-badge"
                    }`}
                  >
                    {chat.platform ===
                    "twitch"
                      ? "TWITCH"
                      : "YOUTUBE"}
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
    </main>
  );
}

export default App;