import type { SdjfamEvent } from "../types/events";
import { isTestEvent } from "./eventPresentation";

export const TIKTOK_JOIN_LIMIT = 5;
export const JOIN_BATCH_MS = 500;
const DEDUP_LIMIT = 1000;
const USER_COOLDOWN_MS = 10_000;
export type TikTokJoin = { id: string; name: string; test: boolean };

// Independent bounded dedup: a join storm must not evict Twitch/alert IDs.
export function createTikTokJoinBuffer() {
  const ids = new Set<string>();
  const users = new Map<string, number>();
  let recent: TikTokJoin[] = [];
  let dirty = false;
  return {
    add(event: SdjfamEvent, now = Date.now()): boolean {
      if (event.platform !== "tiktok" || event.event_type !== "viewer_join" || !event.id) return false;
      const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
      const name = text(event.user?.display_name) || text(event.user?.username);
      if (!name || ids.has(event.id)) return false;
      ids.add(event.id);
      if (ids.size > DEDUP_LIMIT) ids.delete(ids.values().next().value!);
      const metadata = event.metadata as { room_id?: unknown } | null;
      const userKey = `${isTestEvent(event)}:${text(metadata?.room_id)}:${text(event.user?.id) || text(event.user?.username) || name}`;
      const last = users.get(userKey);
      if (last !== undefined && now - last < USER_COOLDOWN_MS) return false;
      users.delete(userKey);
      users.set(userKey, now);
      if (users.size > DEDUP_LIMIT) users.delete(users.keys().next().value!);
      recent = [{ id: event.id, name, test: isTestEvent(event) }, ...recent.filter(join => join.id !== event.id)].slice(0, TIKTOK_JOIN_LIMIT);
      dirty = true;
      return true;
    },
    flush(): TikTokJoin[] | null {
      if (!dirty) return null;
      dirty = false;
      return [...recent];
    },
  };
}
