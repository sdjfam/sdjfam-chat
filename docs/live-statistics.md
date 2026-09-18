# Live-statistieken

TikTok gebruikt dezelfde bestaande sidecar en stdout-listener voor chat, viewers en statistieken. De helper normaliseert protobuf-v3-velden en oudere veldnamen naar een versiegebonden bericht. `src/stats` bevat het platformonafhankelijke sessiemodel; `platforms/tiktok/liveStatsEvents.ts` vormt de platformgrens. Twitch en YouTube leveren nu nog geen gegevens aan dit model.

- Likes zijn het laatste door TikTok gemelde livestreamtotaal, geen optelsom van cumulatieve meldingen.
- Gifts en unieke follow-gebruikers worden waargenomen sinds verbinden. Dit is geen gegarandeerd totaal van de hele stream. Gifts van type 1 tellen uitsluitend bij de eindmelding; een stabiele groepsidentiteit voorkomt dubbele telling.
- Diamonds zijn giftwaarde, geen euro-opbrengst. Zodra een gift geen bekende diamondwaarde heeft, toont de UI het aantal gifts. `estimatedRevenue` blijft null totdat een betrouwbare bron en berekeningsmethode beschikbaar zijn.
- Ontbrekende waarden blijven null en verborgen. Een werkelijk ontvangen nul voor likes/viewers is geldig.
- Een andere room-ID begint een nieuwe sessie. Opnieuw verbinden met dezelfde room bewaart de waargenomen tellers zolang de app draait. Er is nog geen opslag na afsluiten en geen automatisch herstel van gemiste events.
- `observedSince` is het begin van onze waarneming; `streamStartedAt` blijft onbekend. Gemiddelde viewers is tijdgewogen tussen waargenomen viewerupdates, stopt bij disconnect en bevat geen offline tijd. Peak en chats zijn eveneens alleen waargenomen gegevens.
- De UI publiceert maximaal twee statistiekupdates per seconde; lifecycle-updates zijn direct. De deduplicatiecache is begrensd op 10.000 identiteiten per sessie.
- De Settings-testevents veranderen deze cijfers niet. Tests gebruiken afzonderlijke fixtures zonder productiegegevens te simuleren.

`npm run build:sidecar` bouwt de daadwerkelijk door Tauri gebruikte executable opnieuw. Tauri dev/release voert dit automatisch uit. `npm run test:live-stats` controleert veldmapping, giftreeksen, sessies, ontbrekende data en listener-cleanup.

Upstream: https://github.com/zerodytrash/TikTok-Live-Connector (events en beperkingen van TikTok-data). Geïnstalleerde connector/protobuf-typen zijn leidend voor veldnamen.

## Development-preview

In het bestaande alerttestpaneel staat in development een knop **TikTok stats-preview starten**. Deze verandert alleen de weergaveprops van Topbar; de echte hook, diagnostiek, eventverwerking en opslag ontvangen geen fixturedata. TEST × in de topbar of **Stats-preview resetten** schakelt terug naar de actuele echte gegevens. De vlag leeft alleen in React-geheugen, begint altijd uit en is bovendien begrensd met `import.meta.env.DEV`; de bediening is afwezig in productie. Herstart/herladen wist de preview.
