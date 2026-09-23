import { TIKTOK_STATS_PREVIEW } from "./events/testLiveStats";
import { EventTestPanel } from "./events/EventTestPanel";
import { usePlatformEvents } from "./events/usePlatformEvents";
import { useEffect, useState } from "react";
import { AlertHistory } from "./alerts/AlertHistory";
import AlertOverlay from "./alerts/AlertOverlay";
import { useAlerts } from "./alerts/useAlerts";
import "./App.css";
import { ChatMessages } from "./chat/ChatMessages";
import { useChat } from "./chat/useChat";
import { Settings } from "./components/Settings";
import { Topbar } from "./components/Topbar";
import { startFrontendDiagnostics, updateDiagnosticSnapshot } from "./diagnostics";
import { TikTokSettings } from "./platforms/tiktok/TikTokSettings";
import { useTikTok } from "./platforms/tiktok/useTikTok";
import { TwitchSettings } from "./platforms/twitch/TwitchSettings";
import { useTwitch } from "./platforms/twitch/useTwitch";
import { useYouTube } from "./platforms/youtube/useYouTube";
import { YouTubeSettings } from "./platforms/youtube/YouTubeSettings";
import { UpdatePopup } from "./updater/UpdatePopup";
import { useUpdater } from "./updater/useUpdater";

function App() {
  useEffect(() => startFrontendDiagnostics(), []);

  const alerts = useAlerts();
  const chat = useChat();
  const events = usePlatformEvents({ pushAlert: alerts.pushAlert, setMessages: chat.setMessages });
  const twitch = useTwitch({
    setMessages: chat.setMessages,
    chatUserProfilesRef: chat.chatUserProfilesRef,
  });
  const youtube = useYouTube({ setMessages: chat.setMessages });
  const tiktok = useTikTok({
    receiveEvent: events.receiveEvent,
    setMessages: chat.setMessages,
  });
  const updater = useUpdater();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Memory-only and dev-only. Never replace the real hook state or diagnostics.
  const [statsPreviewEnabled, setStatsPreviewEnabled] = useState(false);
  const statsPreviewActive = import.meta.env.DEV && statsPreviewEnabled;

  useEffect(() => {
    updateDiagnosticSnapshot({
      twitchConnected: twitch.twitchConnected,
      twitchViewerCount: twitch.twitchViewerCount,
      youtubeConnected: youtube.youtubeConnected,
      youtubeViewerCount: youtube.youtubeViewerCount,
      tiktokConnected: tiktok.tiktokConnected,
      tiktokViewerCount: tiktok.tiktokViewerCount,
      youtubeChatStatus: youtube.youtubeConnected ? "connected" : "disconnected",
      twitchEventSubStatus: twitch.twitchEventSubStatus.status,
      tiktokSidecarRunning: tiktok.tiktokChildRef.current !== null,
    });
  }, [
    twitch.twitchConnected,
    twitch.twitchViewerCount,
    youtube.youtubeConnected,
    youtube.youtubeViewerCount,
    tiktok.tiktokConnected,
    tiktok.tiktokViewerCount,
    twitch.twitchEventSubStatus.status,
  ]);

  return (
    <main className="app-shell">
      <AlertOverlay event={alerts.activeAlert} />
      {updater.updatePopupOpen && updater.updateVersion && (
        <UpdatePopup {...updater} />
      )}
      <Topbar
        {...twitch}
        {...youtube}
        {...tiktok}
        {...updater}
        {...(statsPreviewActive ? {
          tiktokLiveStats: TIKTOK_STATS_PREVIEW,
          tiktokConnected: true,
          tiktokViewerCount: TIKTOK_STATS_PREVIEW.currentViewers,
        } : {})}
        statsPreviewActive={statsPreviewActive}
        onResetStatsPreview={() => setStatsPreviewEnabled(false)}
        settingsOpen={settingsOpen}
        setSettingsOpen={setSettingsOpen}
      />
      <div className="main-content-layout">
        <ChatMessages {...chat} {...twitch} {...youtube} {...tiktok} />
        <AlertHistory alertHistory={alerts.alertHistory} tiktokJoins={events.tiktokJoins} />
      </div>
      {settingsOpen && (
        <Settings setSettingsOpen={setSettingsOpen}>
          <EventTestPanel {...events}
            statsPreviewActive={statsPreviewActive}
            onEnableStatsPreview={() => { if (import.meta.env.DEV) { setStatsPreviewEnabled(true); setSettingsOpen(false); } }}
            onResetStatsPreview={() => setStatsPreviewEnabled(false)}
          />
          <TwitchSettings {...twitch} />
          <YouTubeSettings {...youtube} />
          <TikTokSettings {...tiktok} />
        </Settings>
      )}
    </main>
  );
}

export default App;
