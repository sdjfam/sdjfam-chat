import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { listen } from "@tauri-apps/api/event";
import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import tmi from "tmi.js";
import { diagnosticError, diagnosticLog, incrementDiagnosticCounter, recordChatMessage, recordConnectionState, recordDiagnosticEvent, recordViewerCount, updatePlatformDiagnosticState } from "../../diagnostics";
import type { ChatMessage, ChatUserProfile } from "../../types/chat";
import { normalizeViewerCount } from "../../utils/normalizeViewerCount";
import { TWITCH_CHANNEL, TWITCH_CLIENT_ID } from "./config";
import type { TwitchAuthStatus, TwitchEventSubStatus, TwitchLoginResult, TwitchUserProfileResult, TwitchViewerResult } from "./types";

let twitchEventSubLifecycle: Promise<void> =
  Promise.resolve();

type TwitchOptions = {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  chatUserProfilesRef: React.RefObject<Map<string, ChatUserProfile>>;
};

export function useTwitch({
  setMessages,
  chatUserProfilesRef
}: TwitchOptions) {
  const twitchProfileRequestsRef =
    useRef<Set<string>>(
      new Set()
    );

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







  async function refreshTwitchAuthStatus() {
    if(!TWITCH_CLIENT_ID) {
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
          validation_status: result.validation_status,
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

  async function refreshTwitchViewerCount() {
    if(!TWITCH_CLIENT_ID) {
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

      if(
        result.live &&
        viewerCount !== null
      ) {
        recordViewerCount(
          "twitch",
          viewerCount
        );
      }
    } catch(error) {
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

  useEffect(() => {
    let cancelled = false;

    const unlisteners:
      UnlistenFn[] = [];

    let startAttempted =
      false;

    const setup =
      async () => {
        if(cancelled) {
          return;
        }

        if(!TWITCH_CLIENT_ID) {
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
                if(
                  cancelled
                ) {
                  return;
                }

                setTwitchEventSubStatus(
                  payload
                );

                // Refresh only local status; this does not initiate token recovery.
                if (["connected", "relink_required", "missing_scopes"].includes(payload.status)) {
                  void refreshTwitchAuthStatus();
                }

                recordDiagnosticEvent(
                  "twitch",
                  "status",
                  {
                    eventsub_status:
                      payload.status,
                  }
                );

                if(
                  payload.status ===
                  "reconnecting"
                ) {
                  incrementDiagnosticCounter(
                    "twitch_reconnects"
                  );
                }
              }
            );

          if(cancelled) {
            statusUnlisten();

            return;
          }

          unlisteners.push(
            statusUnlisten
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
        } catch(error) {
          diagnosticError(
            "TWITCH_EVENTSUB",
            error
          );

          if(!cancelled) {
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
            if(
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

  async function handleTwitchLogin() {
    if(
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

      if(
        result.connected
      ) {
        setTwitchEventSubGeneration(
          (generation) =>
            generation + 1
        );
      }

      await refreshTwitchAuthStatus();

      await refreshTwitchViewerCount();
    } catch(error) {
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
        if(self) {
          return;
        }

        const username =
          tags["display-name"] ||
          tags.username ||
          "Unknown";

        const userId =
          tags["user-id"] ??
          null;

        const profileKey =
          `twitch:${userId ?? username.toLowerCase()}`;

        if(
          !chatUserProfilesRef.current.has(
            profileKey
          )
        ) {
          chatUserProfilesRef.current.set(
            profileKey,
            {
              platform: "twitch",
              userId,
              username,
              avatarUrl: null,

              support: {
                gifts: 0,
                giftSubs: 0,
                subs: 0,
                bits: 0,
              },
            }
          );
        }

        if(
          userId &&
          !chatUserProfilesRef.current.get(
            profileKey
          )?.avatarUrl &&
          !twitchProfileRequestsRef.current.has(
            userId
          )
        ) {
          twitchProfileRequestsRef.current.add(
            userId
          );

          void invoke<TwitchUserProfileResult>(
            "twitch_user_profile",
            {
              clientId: TWITCH_CLIENT_ID,
              userId,
            }
          )
            .then((profile) => {
              const cachedProfile =
                chatUserProfilesRef.current.get(
                  profileKey
                );

              if(cachedProfile) {
                chatUserProfilesRef.current.set(
                  profileKey,
                  {
                    ...cachedProfile,
                    username:
                      profile.display_name ||
                      cachedProfile.username,
                    avatarUrl:
                      profile.profile_image_url ||
                      null,
                  }
                );
              }

              if(profile.profile_image_url) {
                setMessages((current) =>
                  current.map((chatMessage) =>
                    chatMessage.platform ===
                      "twitch" &&
                      chatMessage.userId === userId
                      ? {
                        ...chatMessage,
                        avatarUrl:
                          profile.profile_image_url,
                      }
                      : chatMessage
                  )
                );
              }
            })
            .catch((error) => {
              console.error(
                "Twitch profiel ophalen mislukt:",
                error
              );
            })
            .finally(() => {
              twitchProfileRequestsRef.current.delete(
                userId
              );
            });
        }

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

              userId,

              avatarUrl:
                chatUserProfilesRef.current.get(
                  profileKey
                )?.avatarUrl ?? null,
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
  return {
    twitchConnected,
    twitchViewerCount,
    twitchViewerLive,
    twitchAuthStatus,
    twitchOauthLoading,
    twitchOauthStatus,
    twitchEventSubStatus,
    handleTwitchLogin,
  };
}
