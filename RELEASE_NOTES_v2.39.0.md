# Release Notes — v2.39.0

**KBT-B492 — het lokale-memory-verbod wordt afgedwongen in plaats van opgeschreven**

## Waarom deze release ertoe doet voor wie de plugin gebruikt

Er zit een nieuwe `PreToolUse`-hook in op `Write|Edit`. Schrijft een agent naar `~/.claude/projects/<slug>/memory/` of naar een `MEMORY.md`, dan wordt die schrijfactie **gepauzeerd** en krijg je een bevestigingsvraag met de regeltekst van je eigen workspace erbij.

Overal elders gebeurt er niets. De hook is stil buiten die twee paden, en stil wanneer je workspace geen regel over lokale memory heeft.

---

## Het probleem: een regel die verliest van zijn eigen omgeving

`KBT-TRUL021` (Kanbantic) en `ADM-TRUL006` (AdminHub) zeggen hetzelfde: leg kennis vast in de AI Toolkit, nooit in Claude's lokale memory. Lokale memory is privé voor één Claude-instance op één machine — andere agents en mensen zien het niet, en het gaat verloren bij een verse clone of een ander werkstation.

Die regel bestond alleen als tekst. Claude Code's eigen memory-instructies staan daarentegen in de **systeemprompt** en beschrijven het schrijven naar die map als de normale gang van zaken, compleet met bestandsformaat en index. Die instructie staat dichter bij het moment van handelen dan een Toolkit-item dat je toevallig gelezen moet hebben.

Het gevolg is niet hypothetisch. Twee keer vastgelegd:

1. **2026-07-30** — een agent die de Toolkit expliciet als leidend behandelde maakte tóch een memory-bestand aan, met daarin de vondst dat Docker Desktop de WSL-VHDX ná een `fstrim` zelf compacteert (14,57 GB → 6,39 GB, zonder verhoogde rechten). Die kennis stond op één machine en was voor elke andere agent onvindbaar tot iemand dagen later de Toolkit systematisch doorlas.
2. **2026-08-14** — tijdens de voorbereiding van deze fix. De sessie legde een gotcha in de Toolkit vast in plaats van in memory, uitsluitend omdat de opdracht de regel expliciet als randvoorwaarde meegaf. Zonder die zin was de harness gevolgd.

Dát een agent die de regel serieus neemt er tóch in loopt, is het argument. Nóg een tekstuele regel verandert de verhouding niet; een hook wel.

---

## Drie ontwerpkeuzes, en waarom de voor de hand liggende variant het niet werd

### `ask`, niet `deny` en niet achteraf waarschuwen

Het oorspronkelijke voorstel was een `PostToolUse`-hook die waarschuwt. Die vuurt nadat het bestand er staat: je houdt een overtreding én een melding over, en iemand moet alsnog opruimen. Voor een regel die zegt *"schrijf hier niets"* is een signaal ná het schrijven de zwakste vorm van handhaving.

`deny` overschiet de andere kant op. Het zou ook het **verkleinen** van `MEMORY.md` tot één verwijzing blokkeren — precies wat de regel voorschrijft. Een handhaving die de voorgeschreven opruimactie onmogelijk maakt, werkt tegen zichzelf.

`permissionDecision: "ask"` onderschept zonder te oordelen. Een onbedoelde memory-write gaat niet meer stilzwijgend door; een bedoelde opruimactie keur je goed en gaat gewoon door.

### De regeltekst komt uit jouw workspace, niet uit deze plugin

Deze plugin gaat naar élke workspace. Een hardgecodeerde `KBT-TRUL021` zou één workspace-conventie opleggen aan alle andere — precies wat `KBT-TRUL028` en `KBT-B499` eerder uit deze plugin hebben gehaald — en zou stil falen in AdminHub, waar dezelfde regel `ADM-TRUL006` heet.

De hook detecteert daarom de workspace (dezelfde vierlaagse detectie als de SessionStart-sync, `KBT-SR606`) en zoekt in díé Toolkit een `Rule` die over lokale memory gaat. Selectie gebeurt **op inhoud, niet op itemcode**. Geen workspace of geen zo'n regel: de plugin heeft geen grond om iets te zeggen en zwijgt.

**Wat dit voor je betekent:** wil je de hook in een workspace actief hebben, zorg dan dat er een `Rule`-item staat dat `MEMORY.md` of het `.claude/.../memory/`-pad noemt. Staat dat er niet, dan gebeurt er niets — dat is een keuze, geen storing.

### Faalt open, altijd

Geen API-sleutel, geen workspace, netwerkfout, time-out, onparsebaar antwoord, geen regel gevonden: lege uitvoer, exit 0, de toolaanroep gaat door alsof de hook er niet was.

Dit staat bewust haaks op `fail-not-skip` (`KBT-RL191`), om dezelfde reden die `KBT-BD206` voor de SessionStart-sync geeft. Dat principe bewaakt poorten die de correctheid van wérk afdwingen; deze hook bewaakt een administratieve conventie. Een hook die tijdens een netwerkstoring elke `Write` in een willekeurige repository blokkeert, is een zwaarder defect dan de bug die hij afvangt.

`KANBANTIC_SYNC_DEBUG=1` schrijft de reden van een skip naar stderr, zonder ooit het gedrag te veranderen.

---

## Prestatie: de pad-match staat vóór alles

Deze hook draait op **elke** `Write` en `Edit`, in elke repository, of die nu iets met Kanbantic te maken heeft of niet. Het overgrote deel van die aanroepen is een miss, en een miss mag niets kosten.

De volgorde is daarom onderdeel van het contract, niet een optimalisatie: eerst de pad-match, en bij geen match onmiddellijk terug — vóór enige workspace-detectie of netwerkronde. Een test pint dat vast door te asserteren dat een niet-matchend pad **nul** netwerkaanroepen veroorzaakt.

---

## Wat de matcher wel en niet vangt

| Vangt | Vangt niet |
|---|---|
| `~/.claude/projects/<slug>/memory/**` | `src/memory/cache.ts` |
| `MEMORY.md`, op elk niveau | `MEMORY.md.bak`, `NOT-MEMORY.md` |
| Windows- en POSIX-schrijfwijze, elke casing | `.claude/projects/memory/` (geen project-slug) |

Matcher-scope is **gemeten, niet aangenomen**: `NotebookEdit` draagt `notebook_path` en niet `file_path`, dus toevoegen aan de matcher zou een permanente miss opleveren — een hook die stil niets doet, wat de faalmodus van dit issue is. `MultiEdit` bestaat niet in de huidige tool-set. Vandaar `Write|Edit` en niets meer.

---

## Dekking

23 nieuwe tests: 14 unit (`KBT-TC3582`) en 9 integratie (`KBT-TC3583`). Vijf van de negen integratietests dekken **faalpaden** — die zijn hier belangrijker dan het succespad, omdat het fail-open-gedrag de gevaarlijkste eigenschap is om verkeerd te hebben.

Het rood-bewijs is een counterfactual: vervang de segment-exacte matcher door een substring-variant — de naïeve implementatie die iemand hier zou schrijven — en precies drie assertions vallen om (`src/memory/cache.ts`, `.claude/projects/memory/` zonder slug, `MEMORY.md.bak`). De positieve assertions blijven in beide toestanden groen en zijn dus zwak; daarom staan de negatieve erbij.

Eén assertie verdient aparte vermelding: de integratietest controleert dat de Toolkit-lookup **daadwerkelijk is aangeroepen**. Zonder die spy zou een implementatie die de regeltekst tóch hardcodeert alle andere assertions halen door simpelweg dezelfde string in te bakken.

---

## Bekende beperking

De laadverificatie (`KBT-TC3309`) staat nog open. De assertie luidt *"een verse Claude Code-sessie laadt `hooks.json` en de hook vuurt"*, en die kan pas gedraaid worden ná installatie van deze versie.

Een geautomatiseerde vervanger die controleert dát de entry in `hooks.json` staat is hier expliciet niet goed genoeg. `KBT-B621` is het bewijs: negen mirror-bestanden met geldige frontmatter, een consistent manifest en correcte slugs — elke bestandscontrole slaagde, en de runtime laadde er maandenlang geen enkele van, omdat hij ergens anders keek. Zie `ADM-TRUL015` en `KBT-GTCH133`.

Draai die test dus na het installeren, en let vooral op twee stappen: een gewone bronbestand-write mag **niets** doen, en het verkleinen van een `MEMORY.md` moet **slagen**.

Eén gedragsdetail uit de Claude Code changelog is daarbij relevant: een `permissions.deny`-regel in je eigen instellingen **overrulet** de `ask` van een hook. Dat maakt het strenger, nooit losser — maar het verklaart een uitblijvende bevestigingsvraag als je zo'n regel op dat pad hebt staan.

---

## Ook in deze release

`KBT-CLMD001` van de Kanbantic-workspace zegt op het moment van uitbrengen nog *"Er is nog geen geautomatiseerde handhaving"*. Die zin wordt bijgewerkt zodra deze versie draait — niet eerder, omdat hij tot dat moment waar is.
