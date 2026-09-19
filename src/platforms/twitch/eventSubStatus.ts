import type { TwitchEventSubStatus } from "./types";

export function eventSubNeedsRelogin(status: TwitchEventSubStatus): boolean {
  if (["relink_required", "missing_scopes"].includes(status.status)) return true;
  // Explicit backend categories take precedence over words in a message.
  if (!["error", "auth_error", "revoked"].includes(status.status)) return false;
  return status.status === "auth_error" ||
    /ontbrekende rechten|koppel.*opnieuw|opnieuw.*koppel|niet gekoppeld/i.test(status.message);
}
