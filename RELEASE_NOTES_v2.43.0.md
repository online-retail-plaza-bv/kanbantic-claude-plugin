# v2.43.0 — Eén sessie per Claude-proces, en de chat blijft aan (KBT-F717)

Onderdeel van Epic **KBT-E134** ("Agent-chat betrouwbaar maken"), actie 1.

## Wat er misging

Elke `end_agent_session`-aanroep zette de hele proxy doof: poll, heartbeat en het
sessiebestand gingen uit, ongeacht welke sessie er beëindigd werd. Lane-skills riepen
die tool aan zodra ze een issue afrondden. Vanaf dat moment ontving de rest van de run
— en elk vervolgissue in dezelfde sessie — geen enkel bericht meer.

Daarnaast maakte een tweede `register_agent_session` binnen hetzelfde proces een
tweede sessie én channel aan, bovenop de auto-register. De eerste bleef als "home"
hangen tot hij verouderde.

## Wat er nu gebeurt

**Idempotente registratie, aan beide kanten.** De proxy beantwoordt een dubbele
registratie binnen hetzelfde proces uit zijn cache, zonder serveraanroep — behalve
wanneer de aanroep een update draagt (`summary`, `cwd`, `currentIssueId`), want die
moet wél persisteren. Elke aanroep die de server bereikt, draagt een `processToken`
dat de proxy één keer per proces genereert. De server herkent daarmee een tweede
registratie en geeft de bestaande sessie terug.

Bewust **niet** op `spawnCommandId` gematcht: de daemon hergebruikt dat id als hij een
gecrashte agent opnieuw start, en zo'n herstart hoort juist een nieuwe sessie te
krijgen (KBT-GTCH167).

**`end_agent_session` reset alleen de eigen sessie, en alleen bij succes.** Een
aanroep voor een andere sessie, of een mislukte aanroep, laat poll, heartbeat en
sessiebestand met rust.

**Eén sessiebestand per Claude-sessie.** `~/.claude-kanbantic-session.json` is
vervangen door `~/.claude-kanbantic-session-<CLAUDE_CODE_SESSION_ID>.json`. Die
variabele zet Claude Code op zichzelf en elk kindproces erft hem — de proxy én elke
hook, onafhankelijk van elkaar. Twee gelijktijdige Claude-processen op één werkstation
houden zo elk hun eigen sessie en inbox.

Hooks die de variabele niet zien (oudere Claude Code-build) gebruiken een
sessiebestand alleen als er precies één op schijf staat. Bij 0 of meer dan 1 doen ze
niets en loggen ze een waarschuwing. Nooit "het nieuwste bestand" raden — dat was
precies de fout die deze release oplost.

**Opruimen van verweesde sessiebestanden** gebeurt op bewijs, niet op leeftijd: alleen
als het proces dat het bestand schreef aantoonbaar niet meer bestaat. Bij twijfel
blijft het bestand staan.

## Skills

`kanbantic-issue-execute`, `-prepare`, `-triage`, `-review`, `kanbantic-orchestrate`
en `kanbantic-bug-autopilot` beëindigen de sessie niet meer als ze klaar zijn. Ze
melden dat met `report_status(status: "Idle")` en `set_current_issue(null)`. Alleen
echte procesbeëindiging sluit de sessie nog.

De periodieke `heartbeat`-instructies zijn uit de skills gehaald: de proxy doet dat
zelf al elke 90 seconden (KBT-B470).

## Vereist

Deze release hoort bij de API-wijziging uit KBT-F717 (`processToken` op
`register_agent_session`, plus de migraties `AddAgentSessionProcessToken` en
`MakeAgentSessionProcessTokenUniquePartial`). Een oudere API negeert het veld; de
proxy blijft dan werken op zijn eigen cache.
