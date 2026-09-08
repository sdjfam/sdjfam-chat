import { invoke } from "@tauri-apps/api/core";

export type DiagnosticPlatform =
  | "twitch"
  | "youtube"
  | "tiktok"
  | "obs"
  | "app"
  | string;

export type DiagnosticEventType =
  | "connect"
  | "disconnect"
  | "reconnect"
  | "viewer"
  | "chat"
  | "gift"
  | "alert"
  | "moderation"
  | "sidecar"
  | "auth"
  | "updater"
  | "obs"
  | "status"
  | "error"
  | string;

type LegacyDiagnosticCounterName =
  | "twitch_messages"
  | "youtube_messages"
  | "tiktok_messages"
  | "twitch_viewer_updates"
  | "youtube_viewer_updates"
  | "tiktok_viewer_updates"
  | "twitch_disconnects"
  | "youtube_disconnects"
  | "tiktok_disconnects"
  | "twitch_reconnects"
  | "youtube_reconnects"
  | "tiktok_reconnects"
  | "eventsub_events"
  | "alerts"
  | "errors";

type DiagnosticSnapshot = {
  twitchConnected: boolean;
  twitchViewerCount: number | null;

  youtubeConnected: boolean;
  youtubeViewerCount: number | null;

  tiktokConnected: boolean;
  tiktokViewerCount: number | null;

  youtubeChatStatus: string;
  twitchEventSubStatus: string;
  tiktokSidecarRunning: boolean;
};

type PlatformRuntimeState = {
  connected?: boolean;
  viewers?: number | null;
  chatStatus?: string;
  sidecarRunning?: boolean;
  status?: string;
};

type SafeMetadata = Record<
  string,
  string | number | boolean | null | undefined
>;

const sessionStartedAt = Date.now();

const counters: Record<string, number> = {
  twitch_messages: 0,
  youtube_messages: 0,
  tiktok_messages: 0,

  twitch_viewer_updates: 0,
  youtube_viewer_updates: 0,
  tiktok_viewer_updates: 0,

  twitch_disconnects: 0,
  youtube_disconnects: 0,
  tiktok_disconnects: 0,

  twitch_reconnects: 0,
  youtube_reconnects: 0,
  tiktok_reconnects: 0,

  eventsub_events: 0,
  alerts: 0,
  errors: 0,

  gifts: 0,
  obs_events: 0,
  moderation_actions: 0,
  updater_events: 0,
  auth_events: 0,
  sidecar_events: 0,
};

let snapshot: DiagnosticSnapshot = {
  twitchConnected: false,
  twitchViewerCount: null,

  youtubeConnected: false,
  youtubeViewerCount: null,

  tiktokConnected: false,
  tiktokViewerCount: null,

  youtubeChatStatus: "unknown",
  twitchEventSubStatus: "unknown",
  tiktokSidecarRunning: false,
};

const platformStates: Record<
  string,
  PlatformRuntimeState
> = {};

let heartbeatTimer: number | null = null;
let diagnosticsStarted = false;

function sanitizeDiagnosticText(
  value: unknown
): string {
  let text: string;

  if (value instanceof Error) {
    text = `${value.name}: ${value.message}`;
  } else if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }

  text = text
    .replace(/\r/g, " ")
    .replace(/\n/g, " ");

  const secretPatterns = [
    /access_token\s*[:=]\s*["']?[^,\s;"']+/gi,
    /refresh_token\s*[:=]\s*["']?[^,\s;"']+/gi,
    /device_code\s*[:=]\s*["']?[^,\s;"']+/gi,
    /user_code\s*[:=]\s*["']?[^,\s;"']+/gi,
    /client_secret\s*[:=]\s*["']?[^,\s;"']+/gi,
    /authorization\s*[:=]\s*["']?[^,\s;"']+/gi,
    /code_verifier\s*[:=]\s*["']?[^,\s;"']+/gi,
    /pkce_verifier\s*[:=]\s*["']?[^,\s;"']+/gi,
    /oauth_code\s*[:=]\s*["']?[^,\s;"']+/gi,
    /bearer\s+[^,\s;"']+/gi,
    /api[_-]?key\s*[:=]\s*["']?[^,\s;"']+/gi,
    /password\s*[:=]\s*["']?[^,\s;"']+/gi,
  ];

  for (const pattern of secretPatterns) {
    text = text.replace(
      pattern,
      "[REDACTED]"
    );
  }

  if (text.length > 4000) {
    text =
      `${text.slice(0, 4000)} [TRUNCATED]`;
  }

  return text;
}

function formatMetadata(
  metadata?: SafeMetadata
): string {
  if (!metadata) {
    return "";
  }

  const parts: string[] = [];

  for (const [key, value] of Object.entries(
    metadata
  )) {
    if (value === undefined) {
      continue;
    }

    parts.push(
      `${sanitizeDiagnosticText(key)}=${sanitizeDiagnosticText(
        value
      )}`
    );
  }

  return parts.length > 0
    ? ` | ${parts.join(" | ")}`
    : "";
}

export function diagnosticLog(
  category: string,
  message: unknown
): void {
  const safeCategory =
    sanitizeDiagnosticText(category);

  const safeMessage =
    sanitizeDiagnosticText(message);

  void invoke("diagnostic_log", {
    category: safeCategory,
    message: safeMessage,
  }).catch((error) => {
    console.warn(
      "Diagnostic log write failed:",
      error
    );
  });
}

export function diagnosticError(
  category: string,
  message: unknown
): void {
  incrementDiagnosticCounter("errors");

  diagnosticLog(
    category,
    `ERROR | ${sanitizeDiagnosticText(message)}`
  );
}

export function incrementDiagnosticCounter(
  name: LegacyDiagnosticCounterName | string,
  amount = 1
): number {
  counters[name] =
    (counters[name] ?? 0) + amount;

  return counters[name];
}

export function getDiagnosticCounters(): Record<
  string,
  number
> {
  return { ...counters };
}

export function updateDiagnosticSnapshot(
  update: Partial<DiagnosticSnapshot>
): void {
  snapshot = {
    ...snapshot,
    ...update,
  };
}

export function updatePlatformDiagnosticState(
  platform: DiagnosticPlatform,
  update: PlatformRuntimeState
): void {
  const key =
    sanitizeDiagnosticText(platform).toLowerCase();

  platformStates[key] = {
    ...(platformStates[key] ?? {}),
    ...update,
  };
}

export function recordDiagnosticEvent(
  platform: DiagnosticPlatform,
  eventType: DiagnosticEventType,
  metadata?: SafeMetadata
): void {
  const safePlatform =
    sanitizeDiagnosticText(platform)
      .toLowerCase();

  const safeEvent =
    sanitizeDiagnosticText(eventType)
      .toLowerCase();

  incrementDiagnosticCounter(
    `${safePlatform}_${safeEvent}_events`
  );

  switch (safeEvent) {
    case "gift":
      incrementDiagnosticCounter("gifts");
      break;

    case "alert":
      incrementDiagnosticCounter("alerts");
      break;

    case "moderation":
      incrementDiagnosticCounter(
        "moderation_actions"
      );
      break;

    case "obs":
      incrementDiagnosticCounter("obs_events");
      break;

    case "updater":
      incrementDiagnosticCounter(
        "updater_events"
      );
      break;

    case "auth":
      incrementDiagnosticCounter("auth_events");
      break;

    case "sidecar":
      incrementDiagnosticCounter(
        "sidecar_events"
      );
      break;

    case "error":
      incrementDiagnosticCounter("errors");
      break;
  }

  diagnosticLog(
    safePlatform.toUpperCase(),
    `event=${safeEvent}${formatMetadata(
      metadata
    )}`
  );
}

export function recordConnectionState(
  platform: DiagnosticPlatform,
  connected: boolean,
  reason?: string
): void {
  updatePlatformDiagnosticState(
    platform,
    {
      connected,
    }
  );

  recordDiagnosticEvent(
    platform,
    connected
      ? "connect"
      : "disconnect",
    reason
      ? { reason }
      : undefined
  );
}

export function recordViewerCount(
  platform: DiagnosticPlatform,
  count: number
): void {
  const safeCount = Math.max(
    0,
    Math.trunc(count)
  );

  updatePlatformDiagnosticState(
    platform,
    {
      viewers: safeCount,
    }
  );

  incrementDiagnosticCounter(
    `${platform}_viewer_updates`
  );

  recordDiagnosticEvent(
    platform,
    "viewer",
    {
      count: safeCount,
    }
  );
}

export function recordChatMessage(
  platform: DiagnosticPlatform
): void {
  incrementDiagnosticCounter(
    `${platform}_messages`
  );

  recordDiagnosticEvent(
    platform,
    "chat"
  );
}

export function recordGift(
  platform: DiagnosticPlatform,
  metadata?: SafeMetadata
): void {
  recordDiagnosticEvent(
    platform,
    "gift",
    metadata
  );
}

export function recordAlert(
  platform: DiagnosticPlatform,
  metadata?: SafeMetadata
): void {
  recordDiagnosticEvent(
    platform,
    "alert",
    metadata
  );
}

export function recordModerationAction(
  platform: DiagnosticPlatform,
  metadata?: SafeMetadata
): void {
  recordDiagnosticEvent(
    platform,
    "moderation",
    metadata
  );
}

export function recordObsEvent(
  metadata?: SafeMetadata
): void {
  recordDiagnosticEvent(
    "obs",
    "obs",
    metadata
  );
}

function formatNullableNumber(
  value: number | null
): string {
  return value === null
    ? "null"
    : String(value);
}

function formatPlatformStates(): string {
  const entries =
    Object.entries(platformStates);

  if (entries.length === 0) {
    return "none";
  }

  return entries
    .map(([platform, state]) => {
      const parts = [
        `platform=${platform}`,
      ];

      if (state.connected !== undefined) {
        parts.push(
          `connected=${state.connected}`
        );
      }

      if (state.viewers !== undefined) {
        parts.push(
          `viewers=${
            state.viewers === null
              ? "null"
              : state.viewers
          }`
        );
      }

      if (state.chatStatus !== undefined) {
        parts.push(
          `chat=${sanitizeDiagnosticText(
            state.chatStatus
          )}`
        );
      }

      if (
        state.sidecarRunning !== undefined
      ) {
        parts.push(
          `sidecar=${state.sidecarRunning}`
        );
      }

      if (state.status !== undefined) {
        parts.push(
          `status=${sanitizeDiagnosticText(
            state.status
          )}`
        );
      }

      return `[${parts.join(",")}]`;
    })
    .join(" ");
}

function writeHeartbeat(): void {
  const runtimeSeconds = Math.floor(
    (Date.now() - sessionStartedAt) / 1000
  );

  diagnosticLog(
    "HEARTBEAT",
    [
      `runtime_seconds=${runtimeSeconds}`,

      `twitch_connected=${snapshot.twitchConnected}`,
      `twitch_viewers=${formatNullableNumber(
        snapshot.twitchViewerCount
      )}`,

      `youtube_connected=${snapshot.youtubeConnected}`,
      `youtube_viewers=${formatNullableNumber(
        snapshot.youtubeViewerCount
      )}`,

      `tiktok_connected=${snapshot.tiktokConnected}`,
      `tiktok_viewers=${formatNullableNumber(
        snapshot.tiktokViewerCount
      )}`,

      `youtube_chat_status=${snapshot.youtubeChatStatus}`,
      `twitch_eventsub_status=${snapshot.twitchEventSubStatus}`,
      `tiktok_sidecar_running=${snapshot.tiktokSidecarRunning}`,

      `twitch_messages=${counters.twitch_messages ?? 0}`,
      `youtube_messages=${counters.youtube_messages ?? 0}`,
      `tiktok_messages=${counters.tiktok_messages ?? 0}`,

      `twitch_viewer_updates=${counters.twitch_viewer_updates ?? 0}`,
      `youtube_viewer_updates=${counters.youtube_viewer_updates ?? 0}`,
      `tiktok_viewer_updates=${counters.tiktok_viewer_updates ?? 0}`,

      `twitch_disconnects=${counters.twitch_disconnects ?? 0}`,
      `youtube_disconnects=${counters.youtube_disconnects ?? 0}`,
      `tiktok_disconnects=${counters.tiktok_disconnects ?? 0}`,

      `twitch_reconnects=${counters.twitch_reconnects ?? 0}`,
      `youtube_reconnects=${counters.youtube_reconnects ?? 0}`,
      `tiktok_reconnects=${counters.tiktok_reconnects ?? 0}`,

      `eventsub_events=${counters.eventsub_events ?? 0}`,
      `gifts=${counters.gifts ?? 0}`,
      `alerts=${counters.alerts ?? 0}`,
      `obs_events=${counters.obs_events ?? 0}`,
      `moderation_actions=${counters.moderation_actions ?? 0}`,
      `sidecar_events=${counters.sidecar_events ?? 0}`,
      `updater_events=${counters.updater_events ?? 0}`,
      `auth_events=${counters.auth_events ?? 0}`,
      `errors=${counters.errors ?? 0}`,

      `future_platform_states=${formatPlatformStates()}`,
    ].join(" | ")
  );
}

function writeSessionSummary(): void {
  const runtimeSeconds = Math.floor(
    (Date.now() - sessionStartedAt) / 1000
  );

  const counterSummary =
    Object.entries(counters)
      .sort(([a], [b]) =>
        a.localeCompare(b)
      )
      .map(
        ([name, value]) =>
          `${name}=${value}`
      )
      .join(" | ");

  diagnosticLog(
    "SESSION",
    [
      "Frontend session ending",
      `runtime_seconds=${runtimeSeconds}`,
      counterSummary,
      `platform_states=${formatPlatformStates()}`,
    ].join(" | ")
  );
}

function handleWindowError(
  event: ErrorEvent
): void {
  diagnosticError(
    "FRONTEND",
    event.error instanceof Error
      ? event.error
      : event.message
  );
}

function handleUnhandledRejection(
  event: PromiseRejectionEvent
): void {
  diagnosticError(
    "FRONTEND",
    event.reason
  );
}

export function startFrontendDiagnostics(): () => void {
  if (diagnosticsStarted) {
    return () => {};
  }

  diagnosticsStarted = true;

  diagnosticLog(
    "FRONTEND",
    "React frontend diagnostics started"
  );

  window.addEventListener(
    "error",
    handleWindowError
  );

  window.addEventListener(
    "unhandledrejection",
    handleUnhandledRejection
  );

  writeHeartbeat();

  heartbeatTimer =
    window.setInterval(
      writeHeartbeat,
      60_000
    );

  return () => {
    if (heartbeatTimer !== null) {
      window.clearInterval(
        heartbeatTimer
      );

      heartbeatTimer = null;
    }

    window.removeEventListener(
      "error",
      handleWindowError
    );

    window.removeEventListener(
      "unhandledrejection",
      handleUnhandledRejection
    );

    writeSessionSummary();

    diagnosticsStarted = false;
  };
}