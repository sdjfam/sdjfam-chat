import { formatRemainingTime } from "../../utils/formatRemainingTime";
import type { YouTubeAuthStatus } from "./types";
import { YouTubeIcon } from "./YouTubeIcon";

type YouTubeSettingsProps = {
  authStatus: YouTubeAuthStatus | null;
  youtubeConnected: boolean;
  youtubeViewerLive: boolean;
  youtubeStatus: string;
  googleLinkText: string;
  youtubeTitle: string | null;
  youtubeVideoId: string | null;
  oauthStatus: string;
  handleYouTubeLogin: () => Promise<void>;
  oauthLoading: boolean;
  autoConnectLoading: boolean;
};

export function YouTubeSettings({
  authStatus,
  youtubeConnected,
  youtubeViewerLive,
  youtubeStatus,
  googleLinkText,
  youtubeTitle,
  youtubeVideoId,
  oauthStatus,
  handleYouTubeLogin,
  oauthLoading,
  autoConnectLoading
}: YouTubeSettingsProps) {
  return (<div className="settings-section">
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
  </div>);
}
