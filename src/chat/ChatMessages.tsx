import type * as React from "react";
import { PlatformIcon } from "../components/PlatformIcon";
import { getPlatformLabel } from "../platforms/labels";
import type { ChatMessage } from "../types/chat";

type ChatMessagesProps = {
  messages: ChatMessage[];
  twitchConnected: boolean;
  tiktokConnected: boolean;
  youtubeStatus: string;
  oauthStatus: string;
  youtubeTitle: string | null;
  youtubeVideoId: string | null;
  messageListRef: React.RefObject<HTMLDivElement | null>;
};

export function ChatMessages({
  messages,
  twitchConnected,
  tiktokConnected,
  youtubeStatus,
  oauthStatus,
  youtubeTitle,
  youtubeVideoId,
  messageListRef
}: ChatMessagesProps) {
  return (<section className="chat-panel">
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

              {chat.avatarUrl && (
                <img
                  className="chat-avatar"
                  src={chat.avatarUrl}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                />
              )}

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
  </section>);
}
