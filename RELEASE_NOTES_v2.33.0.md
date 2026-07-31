# Release Notes — v2.33.0

**KBT-B499 — workspace-specifieke werkwijzen uit de plugin; generiek pre-flight-uitbreidingspunt ervoor in de plaats**

## Waarom
Deze plugin geldt voor élke workspace. Toch droeg hij een ABP Pro licentiecheck met zich mee die alleen voor één workspace en één techstack betekenis had: ~350 regels PowerShell plus een hard-gecodeerde HARD-GATE in `kanbantic-issue-execute`, met applicatie-slugs, `.NET`-projectnamen, env-var-namen en Toolkit-codes die in geen enkele andere workspace resolven.

Functioneel deed dat andere workspaces geen kwaad — de scope-gate viel er stil terug op `out-of-scope`. De schade zat elders:

- De plugin die **KBT-TRUL014** afdwingt ("platform-specifieke skills horen NIET in de plugin zelf") overtrad die regel zelf, en dat ondermijnt de norm.
- Elke wijziging in de licentiepraktijk van één repo vereiste een **plugin-release die iedereen raakt**. In KBT-B480 moest een feed-check-fix precies die route nemen.
- Workspaces met een eigen preconditie — een draaiende Docker-daemon, een bereikbare VPN, een licentieserver — hadden **geen weg**. De enige route was "vraag een plugin-release aan", precies het antipatroon.

## Wat er verandert

### Nieuw: workspaces declareren hun eigen precondities
`kanbantic-issue-execute` **Step 0.7** heet nu *Workspace pre-flight checks* en bevat geen enkele workspace-, techstack- of env-var-naam meer. De stap:

1. haalt het Toolkit-item **`pre-flight-checks`** op van de workspace — bestaat het niet, dan wordt de stap stil overgeslagen (de normale situatie voor de meeste workspaces);
2. parseert de declaratietabel met de nieuwe **`plugin/scripts/preflight-block.js`**;
3. filtert op de applicatie-slug(s) en tags van het issue;
4. draait de overgebleven commando's en beoordeelt ze op **exit-code**.

De declaratie is een markdown-tabel:

| Check | Scope | Command | On fail |
|---|---|---|---|
| Licence runtime authenticated | app:my-backend-api | pwsh -NoProfile -File .claude/preflight/licence-check.ps1 | stop |
| Docker daemon up | tag:live-stack | docker info | stop |

Scope-tokens: `app:<slug>`, `tag:<tag>`, `always`. `On fail`: `stop` of `warn` — een leeg veld wordt `stop`, de veilige kant. De uitvoer van een gefaalde check komt letterlijk in de Kanbantic-Decision-entry terecht: wie een goede faalmelding schrijft, heeft het probleem van de operator al opgelost.

**Fail-not-skip (KBT-RL191).** Een declaratie die niet parseert is een fout, geen overslaan. De skill stopt met regelnummer en reden in plaats van door te lopen alsof er geen check was — een stilzwijgend genegeerde blokkerende check is erger dan geen check.

### Verwijderd uit de bundel
- `plugin/hooks/abp-license-check.ps1` en `plugin/tests/abp-license-check.test.js`.
- De ABP-specifieke rule-tabel, `KANBANTIC_SKIP_ABP_CHECK` en `KANBANTIC_ABP_TOKEN_MAX_AGE_DAYS` uit de skill-tekst. De opt-out heet nu **`KANBANTIC_SKIP_PREFLIGHT`** en geldt voor elke gedeclareerde check.
- Kleinere lekkage in dezelfde geest: de `.NET`/Angular-voorbeelden in `implementer-prompt.md`, een repo-code als voorbeeld in `kanbantic-issue-review`, en applicatie-slugs van één workspace als voorbeeld in drie version-commands. Allemaal vervangen door neutrale formuleringen.

### De check zelf is niet verdwenen
Hij staat nu in het repo waar hij over gaat: `.claude/preflight/abp-license-check.ps1` in de Kanbantic-monorepo, gedeclareerd in het `pre-flight-checks`-item van die workspace. Alle vier de controles zijn behouden (env-var, token aanwezig, tokenleeftijd inclusief override, feed-bereikbaarheid), inclusief de KBT-B480-regel dat de API-key nooit in de uitvoer belandt. Daar kan hij mee-evolueren met de ABP-praktijk **zonder plugin-release**.

Workspaces anders dan `kanbantic` werden nooit door de oude check geraakt en merken niets van de verwijdering.

## Tests
40 nieuwe tests; de suite gaat van 319 naar 339 (14 ABP-tests vervallen mee).

| Niveau | Dekking |
|---|---|
| Unit | `preflight-block.test.js` — 31 tests: kolomherkenning op naam, scope-ontleding, `always`-conflict, `On fail`-default, escaped pipes in commando's, één error per rij, en de selector |
| Integration | `workspace-agnostic-plugin.test.js` — scant de bundel op operationele termen van één workspace en controleert dat het uitbreidingspunt aanwezig én gedocumenteerd is |
| E2E | Het `pre-flight-checks`-item van de `kanbantic`-workspace door de parser: de ABP-check verschijnt voor de backend-applicaties en verdwijnt voor de plugin-applicatie |

**De guard kan falen.** Met de oude hook teruggezet levert `workspace-agnostic-plugin.test.js` 34 treffers op en faalt hij op twee van de drie assertions. Dat is de directe les uit KBT-B480/B483/B484: een guard die niet kan falen bewaakt niets.

## Toolkit (companion, workspace `kanbantic`)
Per KBT-TRUL014 gaat de Toolkit vóór de plugin-kant:
- **KBT-CUST001 `pre-flight-checks`** — de declaratie, met de ABP-rij.
- **KBT-TRUL028** — de regel: workspace-precondities declareer je in de Toolkit, niet in de plugin. Inclusief de grens: generieke gates (worktree, git sync, git identity) blijven wél in de plugin.
- **KBT-CMND007 / KBT-GTCH013 / KBT-CLMD001** bijgewerkt naar de nieuwe situatie; daarbij is meteen de bestaande drift rechtgezet waarbij de ClaudeMd Step 0.6 noemde en de plugin Step 0.7.

## Migratie
Niets te doen voor gebruikers buiten de `kanbantic`-workspace. Binnen die workspace: de check draait ongewijzigd door zodra de companion-PR in de monorepo gemerged is. Vervang `KANBANTIC_SKIP_ABP_CHECK` door `KANBANTIC_SKIP_PREFLIGHT` als je die in een CI-omgeving gezet had.
