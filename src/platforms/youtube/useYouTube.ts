import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { listen } from "@tauri-apps/api/event";
import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import { diagnosticError, diagnosticLog, incrementDiagnosticCounter, recordChatMessage, recordConnectionState, recordDiagnosticEvent, recordViewerCount } from "../../diagnostics";
import type { ChatMessage } from "../../types/chat";
import { formatRemainingTime } from "../../utils/formatRemainingTime";
import { normalizeViewerCount } from "../../utils/normalizeViewerCount";
import type { YouTubeAuthStatus, YouTubeAutoConnectResult, YouTubeGrpcChatMessage, YouTubeGrpcStatus, YouTubeLoginResult, YouTubeViewerResult } from "./types";

type YouTubeOptions = {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
};

export function useYouTube({
  setMessages
}: YouTubeOptions) {
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

  const youtubePlatformActive =
    youtubeConnected ||
    youtubeViewerLive;

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
    } catch(error) {
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

        if(cancelled) {
          return;
        }

        if(
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

        if(
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

        if(!result.live) {
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

        if(
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
      } catch(error) {
        if(cancelled) {
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

        if(
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
        if(!cancelled) {
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

  useEffect(() => {
    if(!youtubeVideoId) {
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

        if(cancelled) {
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

        if(
          result.live &&
          viewerCount !== null
        ) {
          recordViewerCount(
            "youtube",
            viewerCount
          );
        }

        if(!result.live) {
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
      } catch(error) {
        if(cancelled) {
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

  useEffect(() => {
    if(!youtubeLiveChatId) {
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
              if(cancelled) {
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

              if(
                youtubeMessageIdsRef.current.has(
                  chat.id
                )
              ) {
                return;
              }

              youtubeMessageIdsRef.current.add(
                chat.id
              );

              if(
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

        if(cancelled) {
          unlistenMessage();
          unlistenMessage = null;

          return;
        }

        unlistenStatus =
          await listen<YouTubeGrpcStatus>(
            "youtube-chat-status",
            (event) => {
              if(cancelled) {
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

              switch(
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

                case "stream_ended":
                  setYoutubeConnected(
                    false
                  );

                  setYoutubeStatus(
                    "YouTube livechat verbinding vernieuwen..."
                  );

                  recordConnectionState(
                    "youtube",
                    false,
                    "gRPC stream ended normally"
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

                  if(
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

        if(cancelled) {
          unlistenStatus();
          unlistenStatus = null;

          return;
        }

        unlistenError =
          await listen<string>(
            "youtube-chat-error",
            (event) => {
              if(cancelled) {
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

              if(
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
              } else if(
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

        if(cancelled) {
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

        if(cancelled) {
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
      } catch(error) {
        if(cancelled) {
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

      if(unlistenMessage) {
        unlistenMessage();
      }

      if(unlistenStatus) {
        unlistenStatus();
      }

      if(unlistenError) {
        unlistenError();
      }
    };
  }, [youtubeLiveChatId]);

  async function handleYouTubeLogin() {
    if(oauthLoading) {
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
    } catch(error) {
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

  let googleLinkText =
    "Google niet gekoppeld";

  if(
    authStatus?.connected
  ) {
    if(
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
  return {
    youtubeConnected,
    youtubeStatus,
    youtubeVideoId,
    youtubeTitle,
    youtubeViewerCount,
    youtubeViewerLive,
    oauthLoading,
    autoConnectLoading,
    oauthStatus,
    authStatus,
    youtubePlatformActive,
    handleYouTubeLogin,
    googleLinkText
  };
}
