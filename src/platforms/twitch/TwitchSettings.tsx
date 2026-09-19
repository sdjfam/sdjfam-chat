import { TwitchIcon } from "./TwitchIcon";
import { TWITCH_CLIENT_ID } from "./config";
import { eventSubNeedsRelogin } from "./eventSubStatus";
import type { TwitchAuthStatus, TwitchEventSubStatus } from "./types";

type TwitchSettingsProps = {
  twitchConnected: boolean;
  twitchViewerLive: boolean;
  twitchAuthStatus: TwitchAuthStatus | null;
  twitchEventSubStatus: TwitchEventSubStatus;
  twitchOauthStatus: string;
  handleTwitchLogin: () => Promise<void>;
  twitchOauthLoading: boolean;
};

export function TwitchSettings({
  twitchConnected,
  twitchViewerLive,
  twitchAuthStatus,
  twitchEventSubStatus,
  twitchOauthStatus,
  handleTwitchLogin,
  twitchOauthLoading
}: TwitchSettingsProps) {
  return (<div className="settings-section">
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
            twitchAuthStatus?.validation_status === "validated" &&
              !twitchAuthStatus?.needs_relogin &&
              !twitchAuthStatus?.expired
              ? "status-good"
              : "status-muted"
          }
        >
          {twitchAuthStatus?.connected
            ? twitchAuthStatus.expired
              ? "Verlopen"
              : twitchAuthStatus.validation_status === "validated"
                ? "Gekoppeld"
                : "Opgeslagen / niet bevestigd"
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
                : ["reconnecting", "retry_scheduled"].includes(
                  twitchEventSubStatus.status
                )
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
  </div>);
}
