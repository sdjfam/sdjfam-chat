import { getAlertContent, isTestEvent } from "../events/eventPresentation";
import { PlatformIcon } from "../components/PlatformIcon";
import type { Platform } from "../types/chat";
import type { SdjfamEvent } from "../types/events";

type AlertHistoryProps = {
  alertHistory: SdjfamEvent[];
};

export function AlertHistory({
  alertHistory
}: AlertHistoryProps) {
  return (<aside className="alerts-panel">
    <div className="alerts-panel-header">
      <div>
        <span className="alerts-panel-eyebrow">
          LIVE EVENTS
        </span>

        <h2>
          Alerts & Gifts
        </h2>
      </div>

      <span className="alerts-panel-count">
        {alertHistory.length}
      </span>
    </div>

    {alertHistory.length === 0 ? (
      <div className="alerts-empty-state">
        <strong>
          Nog geen alerts
        </strong>

        <p>
          Follows, subs, gifts, Super Chats, lidmaatschappen, bits en raids verschijnen hier.
        </p>
      </div>
    ) : (
      <div className="alerts-history-list">
        {alertHistory.map(
          (event) => (
            <div
              className={`alert-history-item ${event.platform}`}
              key={`${event.platform}:${event.id}`}
            >
              <span
                className={`platform-badge ${event.platform}-badge`}
              >
                <PlatformIcon
                  platform={
                    event.platform as Platform
                  }
                />
              </span>

              <div className="alert-history-content">
                <strong>
                  {isTestEvent(event) ? "TEST · " : ""}{getAlertContent(event)?.label || event.event_type}
                </strong>

                <span>
                  {event.user?.display_name ||
                    event.user?.username ||
                    event.platform}
                </span>
              </div>
            </div>
          )
        )}
      </div>
    )}
  </aside>);
}
