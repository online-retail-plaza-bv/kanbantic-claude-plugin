# Release Notes — v2.44.0

**KBT-F719 — berichtbezorging naar agents zonder verlies of duplicaten**

## Waarom deze release ertoe doet voor wie de plugin gebruikt

v2.42.0 (de room-spike) noemde zelf al twee beperkingen onderaan: *"De cursor is een tijdstempel, geen sequence... berichten binnen dezelfde tick kunnen wegvallen"* en *"Subscripties leven alleen in het proxy-proces... geen persistentie en geen herstel."* Deze release verhelpt beide, plus een derde, niet eerder gedocumenteerd probleem: de 1s poll-loop had geen overlap-guard, waardoor een trage request (tot 120s) en de volgende timer-tick tegelijk konden lopen — elk bericht dat tijdens die trage request binnenkwam werd dan TWEE keer bezorgd.

Voor bestaand gebruik verandert er niets aan de buitenkant: dezelfde tools, dezelfde `notifications/claude/channel`-vorm. Wat verandert is dat de bezorging nu daadwerkelijk klopt — geen dubbele berichten, geen weggevallen berichten op een exacte-tijdstempel-tie, en een proxy-restart van dezelfde Claude Code-sessie hervat vanaf waar hij gebleven was in plaats van vanaf "nu" (een gat) of vanaf "toen" (een replay).

---

## Het probleem (KBT-E134, action 3)

Vier onafhankelijke bezorgingsdefecten, gevonden bij het uitwerken van KBT-F721's baseline-e2e-suite (scenario 6, duurtest) en teruggebracht tot deze Feature:

- **Overlap:** `setInterval` had geen in-flight-guard, terwijl één `get_channel_messages`-call tot 120s kan duren — twee polls tegelijk op hetzelfde channel betekende dubbele bezorging van alles dat in die tussentijd binnenkwam.
- **Verlies:** de cursor was een bare timestamp met een strikte `SentAt > after`-vergelijking, zonder id-tiebreak. Twee berichten met exact dezelfde `SentAt` (concurrent posts, milliseconde-resolutie) lieten er één permanent achter de cursor vallen.
- **Geen herstel na restart:** de cursor per channel leefde alleen in het geheugen van het proxy-proces. Een crash of herstart begon altijd opnieuw bij "nu", met een gat als gevolg.
- **Geen dedup op messageId:** er was geen backstop tegen een dubbele bezorging, ongeacht de oorzaak.

Een vijfde, scherper failure-mode is uit KBT-F721 meegenomen: `end_agent_session` archiveert het channel server-side. Dat is een permanente, niet-transiënte toestand — vóór deze release bleef de proxy dat channel voor altijd pollen zonder ooit te slagen, zonder duidelijk logsignaal.

---

## Wat er verandert

**Server (Kanbantic API — `AgentChannelAppService.GetMessagesAsync`):** de cursor wordt samengesteld: `(After, AfterId)`. Bij een exacte tijdstempel-tie beslist het id-gedeelte de volgorde, zodat geen enkel bericht kan wegvallen op een paginagrens. Ontdekt tijdens het uitwerken hiervan: de bestaande implementatie sorteerde ALTIJD `OrderByDescending(...).Take(maxResults).Reverse()`, ook bij een forward/incrementele poll — bij een burst groter dan `maxResults` bleef de oudere achterstand voor altijd achter zodra de cursor voorbij het geretourneerde stuk opschoof. Dat is nu gecorrigeerd: oplopende sortering zodra er een `After`-cursor is (incrementeel pollen), aflopend+omgekeerd alleen zonder cursor (geschiedenis tonen). Achterwaarts compatibel: `afterId` weglaten geeft precies het oude gedrag.

**Proxy (`kanbantic-mcp-proxy.js`):**

| Wat | Hoe |
|---|---|
| Overlap-guard | `pollInFlight`-vlag; een tick die nog loopt maakt de volgende tick een no-op in plaats van een tweede, racende ronde. |
| Ontdubbeling | Een begrensde LRU (`Set`, 500 ids) op `messageId` — een backstop die werkt onafhankelijk van de oorzaak van een herhaling. |
| Samengestelde cursor | `roomSubscriptions`-item is nu `{ cursorAt, cursorId, ... }` in plaats van een bare `cursor`; wordt doorgegeven als `afterId` naast `after`. |
| Archivering | Een `AgentChannel.Archived`-foutmelding zet de room op `archived: true` en stopt permanent met pollen — in plaats van voor altijd te blijven falen. |
| Backoff-met-jitter | Elke andere fout (netwerk, tijdelijke server-fout) telt op in `failCount` en wacht `computeBackoffMs(failCount)` (exponentieel, gemaximeerd op 30s, met jitter) voor de volgende poging. |
| Cursor-persistentie | Elke keer dat een cursor opschuift, schrijft de proxy `cursors: { [channelId]: { at, id } }` naar het bestaande per-sessie sessiebestand (`~/.claude-kanbantic-session-<CLAUDE_CODE_SESSION_ID>.json`, KBT-F717). Bij het (her)joinen van een channel leest `loadPersistedCursor()` dat bestand terug — alleen als het `sessionId`-veld overeenkomt met de huidige sessie — en hervat daar, in plaats van bij "nu". |

`list_rooms()` blijft naar buiten toe `cursor` heten (draad-compatibiliteit); intern is dat nu `cursorAt` plus het onzichtbare `cursorId`.

---

## Verificatie

**Server:** 4 nieuwe tests in `Kanbantic.Application.Tests` (`AgentChannelAppServiceGetMessagesTests`) pinnen de exacte-tie-tiebreak, het fetch-vóór-filter-ordeningsdefect, en het achterwaarts-compatibele pad zonder `afterId`. Volledige suite groen (2192/2192, 0 regressies), architectuur-tests groen (50/50).

**Proxy:** 10 nieuwe tests in `plugin/tests/proxy-delivery-reliability.test.js` — overlap-guard, dedup, samengestelde-cursor-doorgifte, archivering-is-terminaal, backoff-vóór-retry, `computeBackoffMs`-vorm, en drie cursor-persistentie/hervattingsscenario's (inclusief: een sessiebestand van een ANDERE sessie wordt nooit vertrouwd). Volledige proxy-suite groen: 711 tests, 706 pass, 5 skipped, 0 fail.

De duurtest van KBT-F721 (scenario 6) was het beoogde ijkpunt voor deze fix en kan na deze release opnieuw tegen de baseline-suite gedraaid worden.

---

## Wat dit niet is

**Geen sequence-kolom op de server.** De samengestelde `(SentAt, Id)`-cursor is een correcte totale ordening zonder schema-wijziging; een monotone sequence blijft een mogelijke toekomstige vereenvoudiging, niet iets deze release vereist.

**Geen wijziging aan het Room-model.** De v2.42.0-spike-beperkingen rond Rooms-als-entiteit, mentions en rollen blijven ongewijzigd — dit is uitsluitend een bezorgingsfix, geen ontwerpstap voor Rooms.
