# Release Notes — v2.47.0

**KBT-F754 — schijfopruimfunctie: `/kanbantic-disk-cleanup`, meetscript en een `SessionStart`-waarschuwing bij weinig vrije ruimte**

## Waarom deze release ertoe doet voor wie de plugin gebruikt

Een dev-werkstation met veel agent-runs loopt structureel vol: elke parallelle run laat worktrees achter onder `.claude/worktrees/` die niets opruimt, de temp-map verzamelt installers, drie package-managers houden elk hun cache, en de Docker-datadisk groeit zonder ooit te krimpen. Een volle schijf meldt zich niet netjes — hij meldt zich als een `restore` die halverwege klapt of een worktree-checkout met halve bestanden. Op 2026-10-22 stond het werkstation waarop de plugin ontwikkeld wordt op **0,1 GB vrij**.

De opruimkennis bestond al, maar alleen als workspace-specifiek Toolkit-subagent-item (KBT-SAGN010) van één workspace, en de `SessionStart`-waarschuwing die de ClaudeMd van die workspace beloofde bestond nergens. Vanaf deze versie levert de plugin het generieke mechanisme zelf mee.

## Wat er verandert

- **`hooks/session-start-disk-space.js`** — vierde `SessionStart`-hook. Meet de vrije ruimte van het volume van de sessie en zegt **één regel** onder de drempel (standaard 20 GB; "KRITIEK" onder 12 GB), met verwijzing naar `/kanbantic-disk-cleanup`. Erboven stil. Fail-safe (KBT-BD206): elk foutpad eindigt in exit 0 zonder uitvoer. Drempels via `KANBANTIC_DISK_WARN_GB` / `KANBANTIC_DISK_CRITICAL_GB`; `0` of `KANBANTIC_SKIP_DISK_CHECK=1` schakelt uit.
- **`scripts/disk-space.js`** — meet alleen, verwijdert nooit. Vrije/totale ruimte via `fs.statfs`; per repo elke gekoppelde worktree met dirty-count, commits die niet op de remote staan, lock-status en de harde verdict `safeToRemove` (alleen een agent-worktree die schoon, volledig gepusht én ongelockt is); de temp-map met wat er ouder is dan `--temp-age-days` (de actieve Claude-scratchpad altijd overgeslagen); de bekende caches per platform (npm, NuGet, pip, Playwright, Docker-datadisk). Volgt nooit symlinks of junctions — een gedeelde `node_modules`-junction mag niet als "van de worktree" meetellen. `--json` voor de inventaris, `--repos`/`--siblings` voor extra repo's, `--no-sizes` voor een snelle eerste blik.
- **`scripts/disk-cleanup-policy.js`** — pure parser voor het optionele Toolkit-item **`disk-cleanup-policy`** (Custom, tabel `Setting | Value`: `warn-gb`, `critical-gb`, `repo-roots`, `protected-paths`, `temp-age-days`, `delegate-to`, `elevated-script`, `docker`). Fail-not-skip (KBT-RL191): een onbekende sleutel of een getal dat geen getal is belandt in `errors`, want een stil genegeerde `protected-paths` is precies de fout die een opruimer niet mag maken.
- **Skill `kanbantic-disk-cleanup`** + command `/kanbantic-disk-cleanup [--dry-run] [--full] [--repos] [--siblings]`. Vaste volgorde: meten → policy lezen → delegeren aan een workspace-maintenance-subagent als die er is (`.claude/agents/maintenance-agent.md` of `delegate-to`) → per post verifiëren, terugvalpad vastleggen (refs-backup in `.git/` vóór `git worktree remove`), verwijderen, opnieuw meten → gemeten winst rapporteren. Harde grenzen in een HARD-GATE: alleen de Docker build cache en alleen bij een lege `docker ps -a` (nooit `docker system prune`, containers, volumes, images); nooit worktrees met niet-gecommit of niet-gepusht werk; nooit `node_modules`/`bin`/`obj`/`dist` van actieve repo's; nooit `git branch -D`; nooit zelf eleveren — het elevated deel wordt met `--full` als script voor een mens opgeleverd en, als de policy een Toolkit-item noemt, daaruit **verbatim** overgenomen.
- README-sectie "Schijfruimte".

## Verificatie

Vier nieuwe testbestanden, zero deps:

- `plugin/tests/disk-space.test.js` (KBT-TC4231) — fixture-repo met vier worktrees: alleen de schone, gepushte agent-worktree is `safeToRemove`; dirty, ongepusht, niet-agent en "geen remote-referentie" zijn dat niet, elk met reden. Cache-paden per platform, junction niet gevolgd, temp-ouderdom, CLI die de boom onaangeraakt laat.
- `plugin/tests/disk-cleanup-policy.test.js` (KBT-TC4232) — volledige tabel, kolomvolgorde, fail-not-skip op onbekende sleutel/ongeldig getal/ongeldige docker-modus, `isProtected`.
- `plugin/tests/disk-cleanup-skill-contract.test.js` (KBT-TC4232) — SKILL.md draagt de HARD-GATE met de verboden commando's, meet vóór verwijderen, backup vóór `remove`, junction-detach, Docker achter `docker ps -a`, "Do not execute it", README-vermelding; lint-skills blijft groen.
- `plugin/tests/session-start-disk-space.test.js` (KBT-TC4233) — het commando uit `hooks.json` wordt geëxpandeerd en als child-process gedraaid met een SessionStart-payload: stil boven de drempel, één regel eronder, KRITIEK-bewoording, env-drempels, uitschakelen, fail-safe op onbruikbare fixture of payload, en een echte meting zonder fixture.

Op het ontwikkel-werkstation gemeten: `freeSpace` in 3 ms; de worktree-analyse van vijf worktrees op een volle, drukke schijf ~15 s (elke git-aanroep ~2 s) — daarom meet de hook alleen de vrije ruimte en laat hij de inventaris aan de skill.

## Wat dit niet is

Geen vervanging van een workspace-specifiek opruimprotocol: de schijfgrootte, de incidenthistorie en het elevated script van een werkstation horen in de Toolkit van die workspace (KBT-TRUL014 / KBT-B499). De plugin levert het generieke mechanisme en de haak om die kennis te gebruiken. De skill ruimt ook niets automatisch op bij sessiestart — de hook waarschuwt, de mens of agent beslist.
