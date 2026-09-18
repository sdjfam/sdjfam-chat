import { useState } from "react";
import { getPlatformLabel } from "../platforms/labels";
import type { Platform } from "../types/chat";
import type { SdjfamEvent } from "../types/events";
import { createTestEvent, TEST_EVENTS } from "./testEvents";

type Props = {
  receiveEvent: (event: SdjfamEvent) => boolean;
  listenerError: string;
  statsPreviewActive: boolean;
  onEnableStatsPreview: () => void;
  onResetStatsPreview: () => void;
};

export function EventTestPanel({ receiveEvent, listenerError, statsPreviewActive, onEnableStatsPreview, onResetStatsPreview }: Props) {
  const [status, setStatus] = useState("");
  function test(platform: Platform, type: string, label: string) {
    try {
      if (!receiveEvent(createTestEvent(platform, type))) throw new Error("Testevent niet verwerkt");
      setStatus(`${getPlatformLabel(platform)}: ${label} staat in de alertwachtrij en geschiedenis.`);
    } catch {
      setStatus("Het testevent kon niet worden toegevoegd. Probeer het opnieuw.");
    }
  }
  return (
    <section className="settings-section" aria-labelledby="event-test-title">
      <div className="settings-section-title"><div>
        <h3 id="event-test-title">Alerts testen</h3>
        <p>Bekijk je meldingen zonder livestream of login.</p>
      </div></div>
      <p className="settings-message">Testmeldingen zijn herkenbaar aan TEST. Hiermee test je de weergave; de liveverbinding wordt niet gecontroleerd.</p>
      {listenerError && <p className="settings-message" role="alert">{listenerError}</p>}
      {(["twitch", "youtube", "tiktok"] as const).map(platform => (
        <fieldset key={platform} className="event-test-group">
          <legend>{getPlatformLabel(platform)}</legend>
          <div className="event-test-buttons">
            {TEST_EVENTS.filter(option => option.platform === platform).map(option => (
              <button type="button" className="event-test-button" key={option.type}
                onClick={() => test(platform, option.type, option.label)}>{option.label}</button>
            ))}
          </div>
        </fieldset>
      ))}
      {import.meta.env.DEV && (
        <fieldset className="event-test-group">
          <legend>TikTok Live Stats — TEST-preview</legend>
          <p className="settings-message">Tijdelijke voorbeeldcijfers voor de topbar. Worden niet opgeslagen en veranderen je echte livegegevens niet. Na herstart staat de preview uit.</p>
          <div className="event-test-buttons">
            <button type="button" className="event-test-button" onClick={onEnableStatsPreview} disabled={statsPreviewActive}>TikTok stats-preview starten</button>
            <button type="button" className="event-test-button" onClick={onResetStatsPreview} disabled={!statsPreviewActive}>Stats-preview resetten</button>
          </div>
        </fieldset>
      )}
      <p className="settings-message" role="status">{status}</p>
    </section>
  );
}
