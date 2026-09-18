import { usePlatformLiveStats } from "../../stats/usePlatformLiveStats";
import { toTikTokStatsEvent } from "./liveStatsEvents";
import type { Child } from "@tauri-apps/plugin-shell";
import { Command } from "@tauri-apps/plugin-shell";
import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import { diagnosticError, diagnosticLog, incrementDiagnosticCounter, recordChatMessage, recordConnectionState, recordDiagnosticEvent, recordViewerCount, updateDiagnosticSnapshot, updatePlatformDiagnosticState } from "../../diagnostics";
import type { ChatMessage } from "../../types/chat";
import type { SdjfamEvent } from "../../types/events";
import { TIKTOK_USERNAME } from "./config";
import type { TikTokSidecarPayload } from "./types";

type TikTokOptions = {
  receiveEvent: (event: SdjfamEvent) => void;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
};

export function useTikTok({
  receiveEvent,
  setMessages
}: TikTokOptions) {
  const { stats: tiktokLiveStats, recordStats, disconnectStats } = usePlatformLiveStats("tiktok");
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
        if(cancelled) {
          return;
        }

        const output =
          String(line).trim();

        if(!output) {
          return;
        }

        // TikTok ROOM_USER diagnostic output.
        if(
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

        if(
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
        if(
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
        if(
          output ===
          "TIKTOK_DISCONNECTED"
        ) {
          disconnectStats();
          setTikTokConnected(false);

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
        if(
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

          recordStats(toTikTokStatsEvent(payload));
          if (payload.type === "session" && payload.platform === "tiktok") {
            const connected = payload.status === "connected";
            if (["connected", "disconnected", "ended"].includes(payload.status ?? "")) {
              updateDiagnosticSnapshot({ tiktokConnected: connected, ...(connected ? {} : { tiktokViewerCount: null }) });
              updatePlatformDiagnosticState("tiktok", { connected, status: payload.status, ...(connected ? {} : { viewers: null }) });
              recordConnectionState("tiktok", connected, "TikTok LIVE " + payload.status);
              if (!connected) incrementDiagnosticCounter("tiktok_disconnects");
            }
            if (payload.status === "connected") setTikTokConnected(true);
            else if (payload.status === "disconnected" || payload.status === "ended") {
              disconnectStats();
              setTikTokConnected(false);
              setTikTokViewerCount(null);
            }
            return;
          }
          if (payload.type === "like" || payload.type === "follow") return;

          // -----------------------------------------------
          // VIEWER COUNT
          // -----------------------------------------------

          if(
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

          // =======================================================
          // TIKTOK GIFTS
          // =======================================================

          if(
            payload.type === "gift" &&
            payload.platform === "tiktok"
          ) {
            const repeatCount =
              Math.max(
                1,
                payload.repeatCount ?? 1
              );

            const giftName =
              payload.giftName ??
              "TikTok Gift";

            recordDiagnosticEvent(
              "tiktok",
              "gift",
              {
                gift: giftName,
                gift_id:
                  payload.giftId ?? null,
                count: repeatCount,
                diamonds:
                  payload.diamondCount ?? null,
              }
            );

            const giftEvent: SdjfamEvent = {
              id:
                payload.eventId || `tiktok-gift-${Date.now()}-${Math.random()
                  .toString(36)
                  .slice(2, 8)}`,
              platform: "tiktok",
              event_type: "gift",
              user: {
                id:
                  payload.uniqueId ?? null,
                username:
                  payload.uniqueId ??
                  payload.username ??
                  null,
                display_name:
                  payload.username ??
                  payload.uniqueId ??
                  "TikTok Viewer",
              },
              message:
                repeatCount > 1
                  ? `${giftName} x${repeatCount}`
                  : giftName,
              amount: null,
              raw_event_type:
                "tiktok_gift",
              metadata: {
                gift_name:
                  giftName,
                gift_id:
                  payload.giftId ?? null,
                repeat_count:
                  repeatCount,
                diamond_count:
                  payload.diamondCount ?? null,
              },
            };

            receiveEvent(
              giftEvent
            );

            return;
          }
          // -----------------------------------------------
          // FUTURE GENERIC TIKTOK EVENTS
          // -----------------------------------------------

          if(
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

          if(
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

          if(!message) {
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
        } catch(error) {
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
        if(cancelled) {
          return;
        }

        const errorLine =
          String(line).trim();

        if(!errorLine) {
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

        if(
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
          disconnectStats();
          setTikTokConnected(false);

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
        if (cancelled) return;
        diagnosticLog(
          "TIKTOK_SIDECAR",
          "Sidecar process closed"
        );

        incrementDiagnosticCounter(
          "sidecar_events"
        );

        if(!cancelled) {
          disconnectStats();
          setTikTokConnected(false);

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
        if(cancelled) {
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

        disconnectStats();

        setTikTokConnected(false);

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
        if(cancelled) {
          void child
            .kill()
            .catch(() => { });

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
        if(cancelled) {
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

        disconnectStats();

        setTikTokConnected(false);

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
      command.stdout.removeAllListeners();
      command.stderr.removeAllListeners();
      command.removeAllListeners();

      diagnosticLog(
        "TIKTOK_SIDECAR",
        "TikTok sidecar cleanup requested"
      );

      disconnectStats();

      setTikTokConnected(false);

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

      if(child) {
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
  }, [recordStats, disconnectStats]);
  return {
    tiktokLiveStats,
    tiktokConnected,
    tiktokViewerCount,
    tiktokChildRef
  };
}
