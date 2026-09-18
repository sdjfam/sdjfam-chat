import { TikTokLiveConnection, WebcastEvent, ControlEvent } from "tiktok-live-connector";
import { attachTikTokEvents } from "./sidecar/tiktok-events.mjs";

const username = process.argv[2]?.replace(/^@/, "").trim();
if (!username) {
  console.error("Gebruik: node tiktok-chat-helper.mjs <TikTok-gebruikersnaam>");
  process.exit(1);
}

console.log(`TikTok LIVE verbinden met @${username}...`);
const connection = new TikTokLiveConnection(username, {
  processInitialData: false,
  enableExtendedGiftInfo: false,
});
const detach = attachTikTokEvents(connection, { WebcastEvent, ControlEvent }, payload => {
  console.log(JSON.stringify(payload));
});
connection.on(ControlEvent.ERROR, error => {
  console.error("TIKTOK_ERROR", error instanceof Error ? error.message : String(error));
});

try {
  const state = await connection.connect();
  console.log(`TikTok LIVE actief voor @${username} (roomId ${state.roomId})`);
} catch (error) {
  detach();
  console.error("TikTok LIVE verbinden mislukt:", error instanceof Error ? error.message : String(error));
  process.exit(1);
}
