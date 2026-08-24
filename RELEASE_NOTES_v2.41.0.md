# Release Notes — v2.41.0

**KBT-B678 — de anti-memory-hook selecteert op een tag in plaats van op tekst**

## Waarom deze release ertoe doet voor wie de plugin gebruikt

De `PreToolUse`-hook uit v2.39.0 zocht de regel over lokale memory door de Toolkit-teksten af te speuren op `MEMORY.md` en het `.claude/.../memory/`-pad. Dat werkte in één workspace en nergens anders.

Vanaf deze versie leest de hook een **tag**: `memory-guard`. De workspace verklaart daarmee zelf welk Rule-item de hook moet citeren.

**Wat je moet weten:** draagt geen enkel Rule-item in jouw workspace die tag, dan doet de hook niets. Dat is geen storing — het is hoe hij nu vraagt of hij welkom is.

---

## Het gat dat dit oplost

De echte selector is op 2026-08-19 tegen alle zeven workspaces van deze installatie gedraaid:

| Workspace | Rule-items | Gevonden |
|---|---|---|
| `kanbantic` | 34 | `KBT-TRUL021` |
| `admin-hub` | 30 | **niets** — terwijl vijf items over geheugen gaan |
| overige vijf | 0–8 | niets — die hebben geen regel hierover |

Voor die vijf is zwijgen correct. AdminHub was het gat: `ADM-TRUL006` — *"Cross-agent kennis hoort in de AI Toolkit, niet in lokaal agent-geheugen"* — zegt inhoudelijk exact hetzelfde als `KBT-TRUL021`, maar bevat noch `memory`, noch `MEMORY.md`, noch het pad. Alleen het woord "geheugen".

Het verschil was **redactioneel, niet inhoudelijk**. En het faalde stil: de hook zweeg, en zwijgen was niet te onderscheiden van "deze workspace heeft die regel niet".

## Waarom de voor de hand liggende fix niet is gekozen

De verleiding is de zoekterm te verbreden naar `memory|geheugen`. Dat is gemeten en afgewezen.

`ADM-TRUL007` luidt *"adminhub-api draait in prod met exact 1 replica — in-memory sessiestate"*. Een bredere matcher zou die vinden en bij een memory-write een regel over **productie-infrastructuur** tonen als lokale-memory-regel. Drie andere AdminHub-items bevatten "geheugen" in weer andere contexten.

Een vals-positief is hier duurder dan een vals-negatief: zo verliest een handhavingsmechanisme zijn geloofwaardigheid, en dan wordt het uitgezet.

De diepere reden om het anders te doen: tekstherkenning hing af van **welke woorden de auteur van een regel toevallig koos**. Elke nieuwe workspace die het verbod in eigen bewoordingen opschrijft, viel er stil buiten. Een tag maakt van *"de hook vindt hem hopelijk"* een *"de workspace verklaart het"*.

---

## Wat je moet doen om de hook actief te houden

Zet de tag `memory-guard` op het Rule-item dat jouw workspace als regel over lokale memory hanteert.

**Al gedaan voor deze installatie:** `KBT-TRUL021` (kanbantic) en `ADM-TRUL006` (admin-hub) dragen hem sinds 2026-08-21, byte-exact geverifieerd. Voor die twee workspaces verandert er niets aan de werking — kanbantic hield zijn dekking, AdminHub kreeg hem erbij.

Drie dingen om te weten:

- **De naam moet exact kloppen.** `memory-guard`, lowercase, met koppelteken. `Memory-Guard`, `memory-guards` of een spatie ervoor tellen niet, en dat faalt stil. Een test pint die exactheid vast.
- **Tags zijn workspace-scoped.** Elke workspace heeft zijn eigen `Tag`-rij met een eigen GUID; de hook matcht daarom op naam. In een nieuwe workspace moet de tag apart worden aangemaakt.
- **Het kan niet via MCP.** `create_toolkit_item` en `update_toolkit_item` accepteren geen tags, en `list_toolkit_items` heeft geen tag-filter — gemeld als **KBT-B674**. Gebruik de REST-API (`POST /api/app/tag`, dan `PUT /api/app/toolkit-item/{id}` met `tagIds`) vanuit een ingelogde sessie.

## Meerdere getagde items

Draagt meer dan één Rule-item de tag, dan neemt de hook het **eerste** en meldt hij alle treffers met hun code — maar alleen met `KANBANTIC_SYNC_DEBUG=1`.

Stil overslaan zou de workspace laten denken dat er dekking is terwijl er niets gebeurt. Dat is precies de faalmodus die deze hele lijn werk wegneemt, dus die variant is afgewezen. De exitcode blijft 0; de debug-vlag verandert nooit gedrag, alleen zichtbaarheid.

## Wat níét verandert

Het faalt-open-gedrag uit `KBT-BD210` blijft ongemoeid: geen API-sleutel, geen workspace, netwerkfout, time-out of onparsebaar antwoord ⇒ lege uitvoer, exit 0, de schrijfactie gaat door. De negen bestaande faalpad-tests draaien onveranderd mee.

De pad-match staat nog steeds vóór alles: matcht het pad niet, dan stopt de hook vóór enige workspace-detectie of netwerkronde.

---

## Dekking

13 nieuwe tests: 10 unit (`KBT-TC3602`) en 3 integratie (`KBT-TC3603`). Volledige suite: 661 tests, 656 pass, 0 fail, 5 skipped.

De scherpste assertie is een **afwezigheidsassertie**: een item dat `MEMORY.md` noemt zonder de tag mag niet matchen. Die bewijst dat tekstherkenning is *vervangen* en niet *aangevuld* — zonder haar zou een implementatie die beide mechanismen naast elkaar zet alle andere tests halen, terwijl het `ADM-TRUL007`-risico blijft bestaan.

Rood-bewijs via een counterfactual: alleen de selectie is teruggezet naar de oude tekstmatch, met gelijke signature en exports zodat gedrag gemeten werd in plaats van een import-fout. Vier van de tien vielen om.

Eerlijk over één test: *"the ADM-TRUL007 shape does not match"* slaagt in beide toestanden — de oude selector matchte los `in-memory` ook niet. Die staat er als guard tegen de verbrede selector, niet als bewijs van deze fix.

## Nog open

De laadverificatie in beide workspaces (`KBT-TC3604`) kan pas ná installatie van deze versie, in een verse sessie en in normale permission-mode. Die test eist dat de waargenomen AdminHub-melding `ADM-TRUL006` **citeert** — dat onderscheid bewijst dat de selectie workspace-gestuurd is en niet toevallig.
