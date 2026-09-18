import type { TwitchEventSubStatus } from "./types";

export function eventSubNeedsRelogin(
  status: TwitchEventSubStatus
): boolean {
  return (
    status.status === "auth_error" ||
    status.status === "revoked" ||
    /ontbrekende rechten|scope|opnieuw.*koppel|koppel.*opnieuw|niet gekoppeld|nog niet gekoppeld|401|403/i.test(
      status.message
    )
  );
}
