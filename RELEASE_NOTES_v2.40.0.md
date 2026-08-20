# Release Notes — v2.40.0

**KBT-B654 — een halve fetch wist geen mirrors meer**

## Waarom deze release ertoe doet voor wie de plugin gebruikt

Als je subagents uit de Toolkit gebruikt, installeer deze versie.

Op 2026-08-14 verdwenen op één werkstation alle negen Subagent-mirrors uit `.claude/agents/` van de Kanbantic-monorepo. De Toolkit was intact. De sync deed precies wat hem was opgedragen. Er kwam geen foutmelding, want de SessionStart-hook is per ontwerp stil.

Deze release maakt dat onmogelijk vanuit een onbeheerde sync.

---

## Het probleem: één vlag met drie bevoegdheden

`--force` deed drie dingen tegelijk in `sync-workspace-skills.js`:

| Plaats | Effect |
|---|---|
| `buildPlan` | de completeness-guard overslaan (KBT-B489) |
| `buildPlan` | lokale bewerkingen overschrijven |
| `applyPlan` | `delete` wordt `force-delete` |

De SessionStart-hook geeft `--force` mee op elke run. Zijn eigen commentaar motiveert dat uitsluitend met het tweede punt: zonder die vlag herhaalt elke sessie dezelfde waarschuwingen over bestanden die niemand met de hand aanpast. Dat de vlag óók de completeness-guard uitschakelde, was een neveneffect dat niemand had gekozen.

Toen kwam er één fetch terug met 17 Skills en 0 Subagents, zonder fout:

```text
Subagent-call geeft een lege payload terug (geen exception)
→ de lijst bevat alleen de 17 Skills, dus is niet leeg
→ de leeg-lijst-check laat door
→ --force ontwapent de completeness-guard
→ 9 mirrors verwijderd + uit het manifest geschrapt
→ de hook zwijgt, want zo is hij ontworpen (KBT-BD206)
```

De guard die dit had moeten tegenhouden bestond al, sinds KBT-B489, en was er letterlijk voor gebouwd. Hij stond alleen uit.

---

## Wat er verandert

**`--force` houdt alleen zijn eigen bevoegdheid:** lokale bewerkingen overschrijven.

**`--prune` is nieuw** en is voortaan het enige dat de completeness-guard opheft. De hook geeft die vlag niet mee. Een mirror opruimen waarvan de bron hard uit de Toolkit is verwijderd blijft dus mogelijk, maar het is een bewuste handeling geworden in plaats van een bijvangst.

**De fetch is strikt geworden.** `payload.items || []` maakte "de call gaf geen items-sleutel terug" ononderscheidbaar van "er zijn nul items". Een ontbrekende `items`-array, `truncated: true` of een `totalCount` die niet klopt met het aantal ontvangen items is nu een fout. Nul items mét een kloppende `totalCount` blijft een geldig antwoord — een workspace zonder subagents moet gewoon werken.

Twee lagen dus, onafhankelijk van elkaar: de fetch weigert een kapot antwoord, en de guard weigert een onvolledige lijst.

### Wat níet is gekozen

`--force` uit de hook halen was de andere optie. Dan keren de `skip-local-edit`-waarschuwingen elke sessie terug, en KBT-B525 laat zien waar dat toe leidt: terugkerende ruis drijft de operator naar de vlag, en toen bleek één van zeventien weggewuifde meldingen echt — `kanbantic-deploy.md` verloor er 345 regels runbook door. De vlag moest blijven; alleen zijn bevoegdheid moest kleiner.

---

## Verificatie

Negen nieuwe tests in `plugin/tests/sync-partial-fetch-guard.test.js`. **Vijf ervan falen op de code van vóór deze fix**, inclusief de regressietest die de echte hook als apart proces tegen een stub-MCP draait die halverwege stopt met Subagents teruggeven.

Die tegenproef is bewust gedraaid. Een groene test op een fix bewijst niets zolang niet is aangetoond dat hij rood staat zonder die fix.

`KBT-TC3304` legde het oude gedrag vast — *"--force waives the guard"* — en faalde terecht. Hij toetst nu beide kanten van de nieuwe grens.

---

## Ook in deze release

- **#78** — `GITHUB_TOKEN` in `ci.yml` staat expliciet op `contents: read`. De repo-default stond al op read, maar dat is een instelling elders; nu legt de workflow het zelf vast.
- **#77** — GitHub Actions naar v7, zodat ze niet meer op node20 draaien.
- **#76** — de ruleset van de `main`-branch staat nu in de repo, met drift-detectie erop.
- **#75** — KBT-B224: Unit- en E2E-dekking voor de signal-cleanup van de proxy.

---

## Bekende beperking

Waaróm de Subagent-call op 14 augustus leeg terugkwam is niet vastgesteld en niet reproduceerbaar gebleken. Deze release maakt de gevolgen onschadelijk; hij maakt de oorzaak niet onmogelijk. Dat onderscheid staat ook in KBT-B654 zelf.

Dat de hook stil blijft wanneer er iets wordt overgeslagen, is een aparte kwestie — zie **KBT-B621**.
