# Release Notes — v2.42.0

**Spike — een agent kan naar meerdere channels tegelijk luisteren**

## Waarom deze release ertoe doet voor wie de plugin gebruikt

Voor bestaand gebruik verandert er niets. Deze release voegt drie tools toe die niets doen tenzij een agent ze aanroept, en op dit moment roept geen enkele skill ze aan. Roept niemand `join_room` aan, dan gedraagt de plugin zich exact als v2.41.0.

Installeer deze versie als je wil experimenteren met meerdere agents die elkaar rechtstreeks bereiken.

**Dit is een spike, geen afgerond ontwerp.** Zie "Wat dit expliciet niet is" onderaan — die sectie is geen slag om de arm, maar de lijst van dingen die je niet moet aannemen.

---

## Het probleem: agent-to-agent bestond al, maar niemand kon luisteren

De helft van agent-onderlinge communicatie zat er al in en werkte:

- `send_message(channelId, content)` accepteert een wíllekeurig channel-id. De enige gate is workspace-view — er is geen eigenaarschapscontrole. De server heeft er zelfs een expliciete tak voor: *"Otherwise, the agent is posting cross-channel — find their own active session."*
- `list_agents` geeft van elke actieve sessie het `channelId` terug.

Agent A kon dus altijd al naar het channel van agent B posten. Wat ontbrak zat aan de ontvangende kant, in deze proxy:

```js
let agentChannelId = null;   // één variabele
let inboxCursor = null;      // één cursor
```

De inbox-poll kende precies één channel: dat van de eigen sessie. Een agent kon praten tegen iedereen, maar alleen luisteren naar zichzelf. Het gevolg is dat agent-to-agent messaging als capability al maanden in de codebase zit zonder dat één lane-skill hem aanroept — hij is nooit bruikbaar geweest.

---

## Wat er verandert

**De enkele channel is een verzameling geworden.** `roomSubscriptions` is een `Map<channelId, { cursor, label, home }>` met een eigen cursor per channel. De poll-loop loopt ze allemaal langs; één room kan de cursor van een andere niet meer beïnvloeden.

**Drie nieuwe tools, volledig proxy-lokaal:**

| Tool | Wat het doet |
|---|---|
| `join_room(channelId, label?)` | Begin te luisteren naar een channel. Id's komen uit `list_agents`. |
| `leave_room(channelId)` | Stop met luisteren. Het eigen sessie-channel is niet verlaatbaar. |
| `list_rooms()` | Toont waar deze sessie momenteel naar luistert. |

Ze worden onderschept in `dispatch` en nooit doorgestuurd — de server kent ze niet. Antwoorden gaat met het bestaande `send_message`. Ze verschijnen in `tools/list` doordat de proxy de respons aanvult, net zoals hij dat al deed voor de `filePath`-hint (KBT-F464).

**Room-herkomst staat in de berichttekst, niet alleen in meta.** Een bericht uit een niet-eigen room komt binnen als `[KBT-B123] build is red`. Of het model meerdere gelijktijdige rooms uit elkaar kan houden is precies de vraag die deze spike stelt, en `meta` bereikt het model niet gegarandeerd. Het eigen sessie-channel behoudt zijn exacte huidige formaat, dus bestaand gedrag verandert niet.

**Joinen begint bij *nu*.** Een nieuwe subscription krijgt een cursor op het moment van joinen, zodat de backlog van een room nooit ineens in context wordt gestort. Historie blijft opvraagbaar via `get_channel_messages(before: ...)`.

**Cap van 8 rooms.** Niet defensief bedoeld. Elke room duwt in hetzelfde context-window, dus "hoeveel rooms voordat de agent de draad kwijtraakt" is wat er gemeten moet worden — een stille onbegrensdheid zou die vraag juist verbergen.

### Wat níet is gekozen

Een `Room`-entiteit op de server bouwen was het alternatief, en dat is uiteindelijk waar dit heen moet. Maar dat vereist een migratie tegen een harde 1:1-constraint (`HasOne/WithOne` plus een unique index op `AgentChannel.SessionId`), een deelnemersmodel, en een keuze over hoe Rooms zich verhouden tot `DiscussionEntry`. Dat zijn ontwerpbeslissingen die je beter neemt nadát je hebt gezien hoe een agent zich in meerdere rooms gedraagt, niet ervoor.

Een room ís hier gewoon een channel dat de deelnemers als gedeeld behandelen — posten stond immers al open voor elk workspace-lid. Daardoor draait deze spike tegen productie zonder één regel backend-wijziging en zonder migratie.

---

## Hoe je het probeert

1. Start twee agents in dezelfde workspace, beide met `--dangerously-load-development-channels=server:kanbantic`.
2. Laat agent A `list_agents` aanroepen en het `channelId` van agent B pakken.
3. Beide agents `join_room(<dat channelId>, "KBT-B123")`.
4. Post vanuit `/agent-sessions` in de web-app in datzelfde channel — jij zit er als mens al in, want elk workspace-lid met View is deelnemer.

Voor een room per issue zonder Room-entiteit: neem één sessie-channel, geef het het issue-nummer als label, en laat iedereen daar joinen.

---

## Verificatie

Acht nieuwe tests in `plugin/tests/proxy-multi-room.test.js`: cursor-isolatie tussen rooms, geen backlog-replay bij join, geen echo van eigen berichten (met cursor-doorloop, zodat een overgeslagen eigen bericht niet eeuwig opnieuw wordt opgehaald), join/leave-idempotentie, de cap, onverlaatbaarheid van het home-channel, lokale afhandeling van de tools, en eenmalige injectie in `tools/list`.

De volledige proxy-suite is groen: 72 pass, 1 skipped, 0 fail.

Een nieuw test-seam (`setSendForTest`) laat de poll-loop zijn notificaties in een test opvangen in plaats van naar stdout te schrijven. Productiegedrag is ongewijzigd.

---

## Wat dit expliciet niet is

**Geen Rooms.** Er is geen `Room`-entiteit, geen koppeling naar Issues, geen deelnemersmodel. Een room is een afspraak tussen deelnemers over een channel-id, niets meer.

**Geen mentions.** `@reviewer` bereikt nog steeds geen enkele agent — mentions bestaan alleen als regex in de Angular-client (KBT-F416 MVP), zonder backend-entiteit, routing of notificatie.

**De cursor is een tijdstempel, geen sequence.** Met één schrijver was dat onschuldig. Met meerdere agents die tegelijk in dezelfde room posten kunnen berichten binnen dezelfde tick wegvallen. Dit is de bekendste beperking van de spike, en het eerste dat moet veranderen in een echt Room-model.

**Subscripties leven alleen in het proxy-proces.** Een herstart betekent opnieuw joinen. Er is geen persistentie en geen herstel.

**Geen rollen.** "Bugfixer" en "reviewer" bestaan niet als eigenschap van een agent; wie wat doet is een afspraak, geen mechanisme.

**Een agent die zich niet registreert heeft geen home-channel.** Auto-registratie vereist `KANBANTIC_WORKSPACE_ID` in de omgeving — normaal gezet door de Workstation Daemon bij het spawnen. Zonder dat moet de agent zelf `register_agent_session` aanroepen voordat er iets te luisteren valt.
