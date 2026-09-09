import {
  TikTokLiveConnection,
  WebcastEvent,
} from "tiktok-live-connector";

const username = process.argv[2]?.replace(/^@/, "").trim();

if (!username) {
  console.error(
    "Gebruik: node tiktok-chat-helper.mjs <TikTok-gebruikersnaam>"
  );
  process.exit(1);
}

console.log(`TikTok LIVE verbinden met @${username}...`);

const connection = new TikTokLiveConnection(username, {
  processInitialData: false,
  enableExtendedGiftInfo: false,
});

connection.on(WebcastEvent.CONNECTED, (state) => {
  console.log(
    `TIKTOK_CONNECTED roomId=${state.roomId}`
  );
});

connection.on(WebcastEvent.CHAT, (data) => {
  const nickname =
    data.user?.nickname ||
    data.user?.displayId ||
    "TikTok";

  const uniqueId =
    data.user?.displayId ||
    "";

  const message =
    data.content ||
    "";

  if (!message.trim()) {
    return;
  }

  console.log(
    JSON.stringify({
      type: "chat",
      platform: "tiktok",
      username: nickname,
      uniqueId,
      message,
    })
  );
});

connection.on(WebcastEvent.ROOM_USER, (data) => {
  const rawViewerCount = data.viewerCount;
  const viewerCount = Number(rawViewerCount);

  const roomUserKeys =
    data && typeof data === "object"
      ? Object.keys(data).sort()
      : [];

  console.log(
    `TIKTOK_ROOM_USER keys=${roomUserKeys.join(",")}`
  );

  console.log(
    `TIKTOK_ROOM_USER received viewerCount=${String(rawViewerCount)}`
  );

  if (!Number.isFinite(viewerCount)) {
    console.log(
      "TIKTOK_ROOM_USER invalid viewerCount"
    );

    return;
  }

  console.log(
    JSON.stringify({
      type: "viewerCount",
      platform: "tiktok",
      count: Math.max(
        0,
        Math.trunc(viewerCount)
      ),
    })
  );
});

connection.on(WebcastEvent.GIFT, (data) => {
  const giftName =
    data.giftName ||
    data.giftDetails?.giftName ||
    "TikTok Gift";

  const giftId =
    data.giftId ??
    data.giftDetails?.giftId ??
    null;

  const repeatCount = Math.max(
    1,
    Number(data.repeatCount) || 1
  );

  const rawDiamondCount =
    data.diamondCount ??
    data.giftDetails?.diamondCount ??
    null;

  const parsedDiamondCount =
    rawDiamondCount === null
      ? null
      : Number(rawDiamondCount);

  const diamondCount =
    parsedDiamondCount !== null &&
    Number.isFinite(parsedDiamondCount)
      ? parsedDiamondCount
      : null;

  const username =
    data.nickname ||
    data.uniqueId ||
    "TikTok Viewer";

  console.log(
    JSON.stringify({
      type: "gift",
      platform: "tiktok",
      username,
      uniqueId:
        data.uniqueId || null,
      giftName,
      giftId,
      repeatCount,
      diamondCount,
    })
  );
});

connection.on(
  WebcastEvent.DISCONNECTED,
  () => {
    console.log(
      "TIKTOK_DISCONNECTED"
    );
  }
);

connection.on(WebcastEvent.ERROR, (error) => {
  console.error(
    "TIKTOK_ERROR",
    error instanceof Error
      ? error.message
      : String(error)
  );
});

try {
  const state = await connection.connect();

  console.log(
    `TikTok LIVE actief voor @${username} (roomId ${state.roomId})`
  );
} catch (error) {
  console.error(
    "TikTok LIVE verbinden mislukt:",
    error instanceof Error
      ? error.message
      : String(error)
  );

  process.exit(1);
}