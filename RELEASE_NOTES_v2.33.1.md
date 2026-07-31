# Release Notes — v2.33.1

**KBT-B504 — de specialist-skills dispatchten naar een subagent-naam die na een sync niet bestaat**

## Waarom
`kanbantic-specialist-test-coverage` declareerde `test-specialist`. De naam waaronder Claude Code een subagent kent is echter de **slug van de titel van het Toolkit-item**, geschreven door `/kanbantic-sync-workspace-skills` — en "Test Coverage Specialist" levert `test-coverage-specialist` op. Wie zijn workspace netjes synchroniseert en daarna de skill gebruikt, dispatcht dus naar een agent die niet bestaat.

De andere drie specialisten matchten toevallig wél. Toevallig, want niets dwong het af: elke hertiteling van een Toolkit-item brak de delegatie stil.

Dat het zo lang onzichtbaar bleef, heeft een tweede oorzaak die zwaarder weegt dan de naam zelf. De shared lifecycle-core viel bij een onvindbare subagent terug op inline-analyse en noteerde dat als voetnoot. Bij een naamsmismatch is de subagent echter niet *afwezig* — hij bestaat, hij heet anders. De run meldde succes terwijl de geregistreerde specialist genegeerd werd. Dezelfde klasse als KBT-B495 (sync meldt succes, niets laadt) en KBT-B483 (guard meldt OK, snapshot mist tools).

Zichtbaar geworden door de fix van **KBT-B495**: zolang gesyncte agents überhaupt niet laadden, viel een verkeerde naam niemand op.

## Wat er verandert

- **Nieuwe Step 3a in `specialist-run-shared/lifecycle-core.md`** — de core resolvet de agent-naam uit de Toolkit (`list_toolkit_items(category: "Subagent")`) en past dezelfde slug-regel toe als het sync-script. De `SUBAGENT`-waarde in een skill is voortaan expliciet een **hint**, geen aanname over hoe een workspace zijn subagent noemt. Dat is dezelfde regel die KBT-B499 invoerde (KBT-TRUL028): de plugin geldt voor élke workspace en beslist niet hoe die zijn Toolkit inricht.
- **De terugval is gesplitst.** Eén tak met twee betekenissen is er nu twee met één:

  | Situatie | Gedrag |
  |---|---|
  | Geen Subagent-item in de Toolkit | inline-analyse + voetnoot — een legitieme leemte, ongewijzigd |
  | Item bestaat, maar is niet te dispatchen | **HARD-GATE**: melden als misconfiguratie, met itemcode, gezochte naam en de fix (sync draaien, of herstarten omdat de agent-registry alleen bij sessiestart wordt gelezen). Alleen inline doorgaan als de gebruiker daar expliciet om vraagt. |

- **`kanbantic-specialist-test-coverage`** declareert nu `test-coverage-specialist`, wat de sync daadwerkelijk schrijft.

## Tests
`plugin/tests/specialist-subagent-resolution.test.js` (4 tests). De suite gaat van 339 naar 343.

- Elke specialist-skill declareert exact de slug van zijn Toolkit-titel — de guard rekent dat live uit met de `slugify()` van het sync-script, dus hij verschuift mee als die regel ooit verandert.
- De shared core moet de resolutiestap hebben en de geresolvede naam dispatchen.
- Het onderscheid tussen leemte en misconfiguratie moet in een HARD-GATE staan.

**De guard kan falen:** met de skill-wijzigingen teruggedraaid staan drie van de vier rood. De vierde is de zuivere slug-eigenschap (`"Test Coverage Specialist"` → `test-coverage-specialist`, en níét `test-specialist`) en hoort ook zonder de fix groen te zijn.

Daarnaast tegen de echte Toolkit gecontroleerd: alle negen actieve Subagent-items leveren een slug op die overeenkomt met een gesynchroniseerd bestand, en alle vier de specialist-skills verwijzen naar een naam die bestaat.

## Migratie
De Kanbantic-monorepo draagt een **handmatig onderhouden** `.claude/agents/test-specialist.md` (er staat geen `.kanbantic-sync.json` in die map, dus die mirrors zijn nooit door het script gemaakt). Aanbevolen: daar één keer `/kanbantic-sync-workspace-skills` draaien en de verweesde `test-specialist.md` verwijderen. Dat is een handmatige stap in een ander repo — bewust niet stilzwijgend meegenomen.
