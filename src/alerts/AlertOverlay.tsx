import type { SdjfamEvent } from "../types/events";
import { getAlertContent, isTestEvent } from "../events/eventPresentation";

type AlertOverlayProps = { event: SdjfamEvent | null };

export default function AlertOverlay({
  event,
}: AlertOverlayProps) {
  if(!event) {
    return null;
  }

  const alert =
    getAlertContent(event);

  if(!alert) {
    return null;
  }

  return (
    <div
      className="sdjfam-alert-overlay"
      aria-live="polite"
    >
      <div
        className={`sdjfam-alert-card sdjfam-alert-${alert.className} sdjfam-alert-platform-${event.platform}`}
      >
        <span className="sdjfam-alert-label">
          {isTestEvent(event) ? `TEST · ${alert.label}` : alert.label}
        </span>

        <strong className="sdjfam-alert-name">
          {alert.name}
        </strong>

        <span className="sdjfam-alert-message">
          {alert.message}
        </span>
      </div>
    </div>
  );
}
