import type { SdjfamEvent } from "../App";

type AlertOverlayProps = {
  event: SdjfamEvent | null;
};

type AlertContent = {
  label: string;
  name: string;
  message: string;
  className: string;
};

function getDisplayName(event: SdjfamEvent): string {
  return (
    event.user?.display_name ||
    event.user?.username ||
    "Onbekende gebruiker"
  );
}

function getMetadataNumber(
  event: SdjfamEvent,
  key: string
): number | null {
  if (
    !event.metadata ||
    typeof event.metadata !== "object" ||
    Array.isArray(event.metadata)
  ) {
    return null;
  }

  const value = (
    event.metadata as Record<string, unknown>
  )[key];

  return typeof value === "number"
    ? value
    : null;
}

function getAlertContent(
  event: SdjfamEvent
): AlertContent | null {
  const name = getDisplayName(event);

  switch (event.event_type) {
    case "follow":
      return {
        label: "Nieuwe volger",
        name,
        message: "volgt het kanaal",
        className: "follow",
      };

    case "subscription":
      return {
        label: "Nieuwe subscriber",
        name,
        message: "heeft zich geabonneerd",
        className: "subscription",
      };

    case "gift_subscription": {
      const total =
        getMetadataNumber(event, "total");

      return {
        label: "Gift Subs",
        name,
        message:
          total !== null
            ? `heeft ${total} subs cadeau gedaan`
            : event.message ||
              "heeft subs cadeau gedaan",
        className: "gift-subscription",
      };
    }

    case "bits": {
      const bits =
        event.amount?.value;

      return {
        label: "Bits",
        name,
        message:
          typeof bits === "number"
            ? `heeft ${bits.toLocaleString()} bits gecheerd`
            : event.message ||
              "heeft bits gecheerd",
        className: "bits",
      };
    }

    case "raid": {
      const viewers =
        getMetadataNumber(event, "viewers");

      return {
        label: "Raid",
        name,
        message:
          viewers !== null
            ? `raidt met ${viewers.toLocaleString()} kijkers`
            : event.message ||
              "heeft het kanaal geraid",
        className: "raid",
      };
    }

    default:
      return null;
  }
}

export default function AlertOverlay({
  event,
}: AlertOverlayProps) {
  if (!event) {
    return null;
  }

  const alert =
    getAlertContent(event);

  if (!alert) {
    return null;
  }

  return (
    <div
      className="sdjfam-alert-overlay"
      aria-live="polite"
    >
      <div
        className={`sdjfam-alert-card sdjfam-alert-${alert.className}`}
      >
        <span className="sdjfam-alert-label">
          {alert.label}
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