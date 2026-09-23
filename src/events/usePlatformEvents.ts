import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { diagnosticError, incrementDiagnosticCounter, recordDiagnosticEvent } from "../diagnostics";
import type { ChatMessage } from "../types/chat";
import type { SdjfamEvent } from "../types/events";
import { createEventDeduplicator, getAlertContent, isTestEvent } from "./eventPresentation";

import { channelPointChatMessage } from "./channelPoints";
import { createTikTokJoinBuffer, JOIN_BATCH_MS, type TikTokJoin } from "./tiktokJoins";

type EventOptions = {
  pushAlert: (event: SdjfamEvent) => void;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
};

export function usePlatformEvents({ pushAlert, setMessages }: EventOptions) {
  const accept = useRef(createEventDeduplicator());
  const joinBuffer = useRef(createTikTokJoinBuffer());
  const [tiktokJoins, setTikTokJoins] = useState<TikTokJoin[]>([]);
  const [listenerError, setListenerError] = useState("");
  const receiveEvent = useCallback((event: SdjfamEvent) => {
    if (!["twitch", "youtube", "tiktok"].includes(event.platform) || event.event_type === "chat_message" || !event.id) return false;
    if (event.platform === "tiktok" && event.event_type === "viewer_join") return joinBuffer.current.add(event);
    const redemption = channelPointChatMessage(event);
    if (event.event_type === "channel_points_redemption" && !redemption) return false;
    if (!accept.current(event)) return false;
    const test = isTestEvent(event);
    const content = getAlertContent(event);
    if (!test) {
      if (event.platform === "twitch") incrementDiagnosticCounter("eventsub_events");
      recordDiagnosticEvent(event.platform, event.event_type, { source: "platform_event", amount: event.amount?.value ?? null });
      if (content) incrementDiagnosticCounter("alerts");
    }
    if (redemption) {
      // Stable redemption IDs also guard redelivery after the bounded cache evicts an ID.
      setMessages(current => current.some(message => message.id === redemption.id) ? current : [...current, redemption]);
      return true;
    }
    if (content) pushAlert(event);
    // YouTube already supplies its display message through the chat stream.
    // TikTok gifts retain their separate alert/history presentation.
    if (event.platform === "twitch") {
      setMessages(current => [...current, {
        id: `eventsub:${event.id}`,
        platform: "twitch",
        username: event.user?.display_name || event.user?.username || "Twitch",
        message: `${test ? "[TEST] " : ""}${event.message || content?.message || `Twitch-event: ${event.event_type}`}`,
      }]);
    }
    return true;
  }, [pushAlert, setMessages]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    // This listener belongs to all platforms and stays active without Twitch OAuth.
    void listen<SdjfamEvent>("sdjfam-event", ({ payload }) => {
      if (!cancelled) receiveEvent(payload);
    }).then(stop => {
      if (cancelled) stop();
      else { unlisten = stop; setListenerError(""); }
    }).catch(error => {
      if (!cancelled) {
        setListenerError("Live-events kunnen niet worden ontvangen. Start de app opnieuw.");
        diagnosticError("PLATFORM_EVENTS", error);
      }
    });
    return () => { cancelled = true; unlisten?.(); };
  }, [receiveEvent]);

  useEffect(() => {
    const timer = setInterval(() => {
      const next = joinBuffer.current.flush();
      if (next) setTikTokJoins(next);
    }, JOIN_BATCH_MS);
    return () => clearInterval(timer);
  }, []);

  return { receiveEvent, listenerError, tiktokJoins };
}
