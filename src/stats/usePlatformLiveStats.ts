import { useCallback, useEffect, useRef, useState } from "react";
import type { Platform } from "../types/chat";
import { LiveStatsStore } from "./liveStatsStore";
import type { PlatformStatsEvent } from "./types";

export function usePlatformLiveStats(platform: Platform) {
  const store = useRef<LiveStatsStore | null>(null);
  if (store.current === null) store.current = new LiveStatsStore(platform);
  const [stats, setStats] = useState(store.current.snapshot);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (timer.current !== null) clearTimeout(timer.current); timer.current = null; };
  }, []);
  const publish = useCallback((immediate: boolean) => {
    if (!mounted.current) return;
    if (immediate) {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      setStats(store.current!.snapshot);
    } else if (timer.current === null) {
      // Count every event immediately, but repaint at most twice a second.
      timer.current = setTimeout(() => { timer.current = null; if (mounted.current) setStats(store.current!.snapshot); }, 500);
    }
  }, []);
  const recordStats = useCallback((event: PlatformStatsEvent | null) => {
    if (event && store.current!.consume(event)) publish(event.kind === "session");
  }, [publish]);
  const disconnectStats = useCallback(() => { if (store.current!.disconnect()) publish(true); }, [publish]);
  return { stats, recordStats, disconnectStats };
}
