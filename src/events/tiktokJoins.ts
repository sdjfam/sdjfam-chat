import type { SdjfamEvent } from "../types/events";
import { isTestEvent } from "./eventPresentation";

export const JOIN_VISIBLE_MS = 5000;
const DEDUP_LIMIT = 1000;
export type TikTokJoin = { id: string; name: string; test: boolean };

export function createTikTokJoinBuffer(publish: (joins: TikTokJoin[]) => void) {
  const ids = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  function cancel() {
    generation++;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }
  return {
    add(event: SdjfamEvent): boolean {
      if (event.platform !== "tiktok" || event.event_type !== "viewer_join" || !event.id) return false;
      const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
      const name = text(event.user?.display_name) || text(event.user?.username);
      if (!name || ids.has(event.id)) return false;
      ids.add(event.id);
      if (ids.size > DEDUP_LIMIT) ids.delete(ids.values().next().value!);
      cancel();
      const current = generation;
      publish([{ id: event.id, name, test: isTestEvent(event) }]);
      timer = setTimeout(() => {
        // Protect against an already queued callback from a cancelled timer.
        if (current !== generation) return;
        timer = undefined;
        publish([]);
      }, JOIN_VISIBLE_MS);
      return true;
    },
    dispose: cancel,
  };
}
