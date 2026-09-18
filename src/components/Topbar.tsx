import { CompactLiveStats } from "../stats/CompactLiveStats";
import type { PlatformLiveStats } from "../stats/types";
import type * as React from "react";
import { TIKTOK_USERNAME } from "../platforms/tiktok/config";
import { TikTokIcon } from "../platforms/tiktok/TikTokIcon";
import { TwitchIcon } from "../platforms/twitch/TwitchIcon";
import { YouTubeIcon } from "../platforms/youtube/YouTubeIcon";
import { SettingsIcon } from "./SettingsIcon";

type TopbarProps = {
  updateStatus: string;
  updateVersion: string | null;
  handleInstallUpdate: () => Promise<void>;
  updateInstalling: boolean;
  twitchViewerLive: boolean;
  twitchViewerCount: number | null;
  youtubePlatformActive: boolean;
  youtubeConnected: boolean;
  youtubeStatus: string;
  youtubeViewerLive: boolean;
  youtubeViewerCount: number | null;
  statsPreviewActive?: boolean;
  onResetStatsPreview?: () => void;
  tiktokLiveStats: PlatformLiveStats;
  tiktokConnected: boolean;
  tiktokViewerCount: number | null;
  settingsOpen: boolean;
  setSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>;
};

export function Topbar({
  updateStatus,
  updateVersion,
  handleInstallUpdate,
  updateInstalling,
  twitchViewerLive,
  twitchViewerCount,
  youtubePlatformActive,
  youtubeConnected,
  youtubeStatus,
  youtubeViewerLive,
  youtubeViewerCount,
  statsPreviewActive = false,
  onResetStatsPreview,
  tiktokLiveStats,
  tiktokConnected,
  tiktokViewerCount,
  settingsOpen,
  setSettingsOpen
}: TopbarProps) {
  return (<header className="topbar">
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
        className={`platform-viewer twitch ${twitchViewerLive
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
        className={`platform-viewer youtube ${youtubePlatformActive
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
        className={`platform-viewer tiktok ${tiktokConnected
            ? "connected"
            : "offline"
          }`}
        title={
          statsPreviewActive ? "TEST-preview — tijdelijke voorbeelddata, geen livegegevens" : tiktokConnected
            ? `TikTok @${TIKTOK_USERNAME} LIVE verbonden`
            : `TikTok @${TIKTOK_USERNAME} offline`
        }
      >
        <div className="platform-status">
          <TikTokIcon />
        </div>

        <div className="platform-viewer-info">
          {statsPreviewActive && <button type="button" className="stats-preview-reset" onClick={onResetStatsPreview}
            title="TEST-preview uitschakelen en echte gegevens tonen" aria-label="TikTok stats-preview uitschakelen">TEST ×</button>}
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
          {tiktokConnected && <CompactLiveStats stats={tiktokLiveStats} />}
        </div>
      </div>

      {/* Settings */}

      <button
        type="button"
        className={`settings-button ${settingsOpen
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
  </header>);
}
