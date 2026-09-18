import { TikTokIcon } from "./TikTokIcon";
import { TIKTOK_USERNAME } from "./config";

type TikTokSettingsProps = {
  tiktokConnected: boolean;
};

export function TikTokSettings({
  tiktokConnected
}: TikTokSettingsProps) {
  return (<div className="settings-section">
    <div className="settings-section-title">
      <div className="settings-tiktok-icon">
        <TikTokIcon />
      </div>

      <div>
        <h3>
          TikTok
        </h3>

        <p>
          LIVE chat via TikTok sidecar
        </p>
      </div>
    </div>

    <div className="settings-status-card">
      <div className="settings-status-line">
        <span>
          Account
        </span>

        <strong>
          @{TIKTOK_USERNAME}
        </strong>
      </div>

      <div className="settings-status-line">
        <span>
          Livechat
        </span>

        <strong
          className={
            tiktokConnected
              ? "status-good"
              : "status-muted"
          }
        >
          {tiktokConnected
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
            tiktokConnected
              ? "status-good"
              : "status-muted"
          }
        >
          {tiktokConnected
            ? "Live"
            : "Offline"}
        </strong>
      </div>

      <div className="settings-status-line">
        <span>
          Chat helper
        </span>

        <strong
          className={
            tiktokConnected
              ? "status-good"
              : "status-muted"
          }
        >
          {tiktokConnected
            ? "Actief"
            : "Wachten op LIVE"}
        </strong>
      </div>
    </div>

    <div className="settings-detail">
      <span>
        Verbinding
      </span>

      <p>
        {tiktokConnected
          ? `TikTok LIVE @${TIKTOK_USERNAME} is verbonden. Nieuwe chatberichten verschijnen automatisch in SDJFAM Chat.`
          : `SDJFAM Chat wacht op een actieve TikTok LIVE van @${TIKTOK_USERNAME}.`}
      </p>
    </div>
  </div>);
}
