import { randomUUID } from "node:crypto";

export function safeCount(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function id(value) {
  return typeof value === "string" && value !== "" && value !== "0" ? value : null;
}

// Connector 2.4.4 uses protobuf v3; the older field names are still accepted.
export function normalizeTikTokEvent(type, data, roomId, now = Date.now()) {
  const base = {
    type, platform: "tiktok", schemaVersion: 1,
    roomId: id(data.common?.roomId) || id(roomId),
    eventId: id(data.common?.msgId) || id(data.msgId) || randomUUID(),
    receivedAt: now,
  };
  const user = data.user;
  const userId = id(user?.id) || id(data.userId);
  const uniqueId = user?.uniqueId || user?.displayId || data.uniqueId || null;
  const username = user?.nickname || data.nickname || uniqueId || "TikTok";
  switch (type) {
    case "chat": {
      const message = typeof data.content === "string" ? data.content : "";
      return message.trim() ? { ...base, userId, uniqueId, username, message } : null;
    }
    case "viewerCount": {
      const count = safeCount(data.viewerCount ?? data.total);
      return count === null ? null : { ...base, count };
    }
    case "like": {
      const likeCount = safeCount(data.likeCount ?? data.count);
      let totalLikeCount = safeCount(data.totalLikeCount ?? data.total);
      if (totalLikeCount !== null && likeCount !== null && totalLikeCount < likeCount) totalLikeCount = null;
      return totalLikeCount === null ? null : { ...base, totalLikeCount };
    }
    case "follow":
      // FOLLOW describes one user action; followCount is not a stream delta.
      return { ...base, userId, uniqueId };
    case "gift": {
      const gift = data.giftDetails || data.gift;
      const giftType = safeCount(data.giftType ?? gift?.giftType ?? gift?.type);
      const repeatEnd = data.repeatEnd === true || data.repeatEnd === 1;
      // A streak emits cumulative counts and one final event; process it once.
      if (giftType === 1 && !repeatEnd) return null;
      const repeatCount = safeCount(data.repeatCount);
      if (repeatCount === null || repeatCount < 1) return null;
      const groupId = id(data.groupId);
      return {
        ...base, userId, uniqueId, username,
        eventId: giftType === 1 && groupId ? `gift:${userId || uniqueId || "unknown"}:${groupId}:${data.giftId ?? gift?.id ?? "unknown"}` : base.eventId,
        giftName: data.giftName || gift?.giftName || gift?.name || "TikTok Gift",
        giftId: data.giftId ?? gift?.giftId ?? gift?.id ?? null,
        repeatCount, repeatEnd, giftType, groupId,
        diamondCount: safeCount(data.diamondCount ?? gift?.diamondCount),
      };
    }
    default: return null;
  }
}

export function attachTikTokEvents(connection, { WebcastEvent, ControlEvent }, emit, now = Date.now) {
  let roomId = null;
  const subscriptions = [];
  function on(event, callback) {
    if (typeof event !== "string") throw new Error("TikTok eventnaam ontbreekt");
    connection.on(event, callback);
    subscriptions.push([event, callback]);
  }
  function session(status, state) {
    roomId = id(state?.roomId) || id(connection.state?.roomId) || roomId;
    emit({ type: "session", platform: "tiktok", schemaVersion: 1, roomId, status, receivedAt: now() });
  }
  on(ControlEvent.CONNECTED, state => session("connected", state));
  on(ControlEvent.DISCONNECTED, () => session("disconnected"));
  on(WebcastEvent.STREAM_END, () => session("ended"));
  for (const [event, type] of [
    [WebcastEvent.CHAT, "chat"], [WebcastEvent.ROOM_USER, "viewerCount"],
    [WebcastEvent.GIFT, "gift"], [WebcastEvent.LIKE, "like"], [WebcastEvent.FOLLOW, "follow"],
  ]) {
    on(event, data => {
      const payload = normalizeTikTokEvent(type, data, roomId, now());
      if (payload) emit(payload);
    });
  }
  return () => subscriptions.forEach(([event, callback]) => connection.off(event, callback));
}
