# Branch-protection als config-in-de-repo

De regels die `main` beschermen leven in **GitHub's database**, niet in deze repo.
GitHub leest een ruleset nooit uit een bestand — er bestaat geen `.github/rulesets.yml`
die automatisch wordt toegepast. `main-protection.json` is daarom per definitie een
**kopie**, en een kopie die niemand controleert loopt uit de pas.

Deze map lost dat niet op door de twee plekken te verminderen (dat kan niet), maar door
er één de baas te maken en dat mechanisch af te dwingen:

| Bestand | Rol |
|---|---|
| `main-protection.json` | de bron van waarheid — wordt **letterlijk** toegepast |
| `../scripts/apply-ruleset.ps1` | schrijft dat bestand naar GitHub (PUT op naam) |
| `../../../.github/scripts/ruleset-drift.mjs` | vergelijkt live vs. bestand |
| `../../../.github/workflows/ruleset-drift.yml` | draait die vergelijking bij PR + wekelijks |

Overgenomen uit de monorepo (`Online-Retail-Plaza-BV/kanbantic`, KBT-B533 / KBT-F620).

## Waarom dit bestaat

In de monorepo ging precies dit mis. Het gecommitte bestand was van de live ruleset
afgeweken op **elke** instelling — required checks met nul overlap, approvals 1 vs 0,
signatures, linear history — en dat bleef **maandenlang** onopgemerkt, omdat niets de
twee vergeleek. De README droeg een handmatige "diff deze af en toe"-procedure die
aantoonbaar nooit is uitgevoerd.

Dat is niet cosmetisch. Tijdens KBT-B512 concludeerde iemand uit dat bestand dat een
rode `security / all-checks` alle PR's blokkeerde. Dat deed hij niet — die context was
helemaal niet live-required. Zowel mensen als agents namen beslissingen op basis van
een bestand dat loog.

## De regel

> **Bewerk `main-protection.json` nooit om een *gewenste* toestand te beschrijven.**

Het bestand wordt letterlijk verstuurd: alles wat erin staat wordt afgedwongen, alles
wat ontbreekt verdwijnt. Een "vast vooruitlopend" bestand is geen plan maar een
tijdbom — en tot je het toepast is het bovendien een leugen tegen de volgende lezer.

## Procedure — regels wijzigen

Twee routes, allebei goed, zolang je de tweede stap niet overslaat.

**Via het bestand (voorkeur):**

1. Pas `main-protection.json` aan.
2. `pwsh -File deploy/github/scripts/apply-ruleset.ps1 -DryRun` — bekijk de payload.
3. `pwsh -File deploy/github/scripts/apply-ruleset.ps1` — toepassen.
4. Commit het bestand in dezelfde PR als de wijziging die erom vroeg.

**Via de GitHub UI:**

1. Wijzig de ruleset in `Settings → Rules → Rulesets → Protect Branch`.
2. Werk `main-protection.json` bij zodat het weer klopt, en commit dat.

Stap 2 is de hele afspraak. Sla je hem over, dan slaat de wekelijkse cron aan — een
UI-wijziging levert geen commit op en dus geen PR-run, en zonder die cron zou de drift
onzichtbaar blijven tot iemand toevallig deze bestanden aanraakt.

Het bestand regenereren vanuit de live toestand:

```bash
gh api repos/Online-Retail-Plaza-BV/kanbantic-claude-plugin/rulesets/18930043
```

en daaruit `name`, `target`, `enforcement`, `conditions`, `bypass_actors` en `rules`
overnemen. De rest (`id`, `node_id`, `source`, `created_at`, `updated_at`, `_links`,
`current_user_can_bypass`) beheert GitHub zelf en hoort niet in de payload.

## De drift-check is bewust géén required status check

Hij is path-filtered, dus op de meeste PR's draait hij niet en rapporteert hij niets.
Precies die combinatie — required maar niet-rapporterend — laat een check **voor altijd**
blokkeren (KBT-SR590 / KBT-RL194). Hem verplicht stellen zou de val nabouwen die hij moet
voorkomen. Rood hier blokkeert geen merge; het is een signaal aan een mens.

## Benodigd token

De workflow heeft een token met **Administration: Read** nodig. De standaard
`GITHUB_TOKEN` kan dat niet zijn: `permissions:` kent geen `administration`-scope, dus
er is geen manier om het te vragen.

Deze repo heeft nog **geen** secrets. Tot er één is, faalt de job bij de stap
"Fetch live ruleset" met de instructie hieronder — bewust, want een check die zijn
onderwerp niet kan lezen moet dat luid zeggen en nooit "geen drift" melden.

Zet één van deze twee klaar:

- **`RULESET_READ_TOKEN`** (wordt als eerste geprobeerd) — een fine-grained PAT op deze
  repo met `Repository permissions → Administration: Read`. Een classic PAT met `repo`
  werkt ook.
- **`KANBANTIC_BOT_GITHUB_TOKEN`** — de fallback; bestaat al in de monorepo en zou als
  org-secret aan deze repo beschikbaar gesteld kunnen worden.

Let op: **niet** `KANBANTIC_PAT`. Ondanks de naam is dat een Kanbantic API-key voor
gebruik als Bearer tegen de Kanbantic API, geen GitHub-token; `gh` geeft er
"Bad credentials (HTTP 401)" op.

## Huidige toestand (18-08-2026)

```
Protect Branch  (id 18930043, active, refs/heads/main)
  deletion                — main kan niet verwijderd worden
  non_fast_forward        — geen force-push
  pull_request            — PR verplicht, 0 approvals vereist
  required_status_checks  — test, Analyze (actions), Analyze (javascript-typescript)
                            strict: branch moet up-to-date zijn vóór merge
  bypass: ronald-evers    — bypass_mode "pull_request" (wel een PR doorduwen bij een
                            runner-storing, géén directe push naar main)
```

`required_approving_review_count` staat bewust op 0: agent-PR's komen via een gedeelde
PAT binnen als één en dezelfde GitHub-gebruiker, dus 1 approval zou betekenen dat de
enige andere admin elke PR moet goedkeuren. De akkoordverklaring loopt via de
agent-sessie, niet via GitHub.
