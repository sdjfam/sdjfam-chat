import type { SdjfamEvent } from "../types/events";

export function isTestEvent(event: SdjfamEvent): boolean {
  return event.raw_event_type?.startsWith("simulated.") === true;
}

export function getAlertContent(event: SdjfamEvent) {
  const name = event.user?.display_name || event.user?.username || "Onbekende gebruiker";
  const metadata = event.metadata && typeof event.metadata === "object"
    ? event.metadata as Record<string, unknown> : {};
  const count = (key: string) => typeof metadata[key] === "number" && Number.isFinite(metadata[key])
    ? metadata[key] as number : null;
  let label: string;
  let fallback: string;
  switch (event.event_type) {
    case "follow": label = "Nieuwe volger"; fallback = "volgt het kanaal"; break;
    case "subscription": label = "Nieuwe subscriber"; fallback = "heeft zich geabonneerd"; break;
    case "gift_subscription":
      label = event.platform === "youtube" ? "Cadeaulidmaatschappen" : "Gift Subs";
      fallback = `heeft ${count("total") ?? "meerdere"} ${event.platform === "youtube" ? "lidmaatschappen" : "subs"} cadeau gedaan`;
      break;
    case "bits":
      label = "Bits";
      fallback = typeof event.amount?.value === "number" ? `heeft ${event.amount.value.toLocaleString()} bits gecheerd` : "heeft bits gecheerd";
      break;
    case "raid": label = "Raid"; fallback = count("viewers") !== null ? `raidt met ${count("viewers")} kijkers` : "heeft het kanaal geraid"; break;
    case "gift": label = "TikTok Gift"; fallback = `${metadata.gift_name || "Gift"} × ${count("repeat_count") ?? 1}`; break;
    case "super_chat":
      label = event.raw_event_type?.includes("superSticker") ? "Super Sticker" : "Super Chat";
      fallback = "bedankt voor je steun!";
      break;
    case "member_join":
      label = event.raw_event_type?.includes("memberMilestone") ? "Ledenmijlpaal" : "YouTube-lidmaatschap";
      fallback = "bedankt voor je lidmaatschap!";
      break;
    default: return null;
  }
  let amount = "";
  if (event.event_type === "super_chat" && typeof event.amount?.value === "number" && Number.isFinite(event.amount.value)) {
    try {
      amount = event.amount.currency ? new Intl.NumberFormat("nl-NL", { style: "currency", currency: event.amount.currency }).format(event.amount.value) : String(event.amount.value);
    } catch { amount = `${event.amount.value} ${event.amount.currency ?? ""}`.trim(); }
  }
  return { label, name, message: [amount, event.message || fallback].filter(Boolean).join(" · "), className: event.event_type.replace(/_/g, "-") };
}

export function createEventDeduplicator(limit = 1000) {
  const seen = new Set<string>();
  return (event: SdjfamEvent) => {
    const key = `${event.platform}:${event.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > limit) seen.delete(seen.values().next().value!);
    return true;
  };
}
