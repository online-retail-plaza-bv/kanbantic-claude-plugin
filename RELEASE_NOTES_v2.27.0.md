# Release Notes — v2.27.0

**KBT-F605 — Wireframe-blok dereferencen in prepare/execute/graduation + server-side pagina-id-validatie**

## Waarom
Een issue kan een `## Wireframe`-blok bevatten (wireframe/versie/pagina), maar dat blok werd nergens in de lane-skills gedereferenceerd — het was een inert kruimelspoor. Gevolg: de gebouwde UI dreef af van het ontwerp (root-cause AdminHub ADM-INI018). Deze release maakt het blok **bindende** input.

## Plugin (deze repo)
- **Nieuw**: `plugin/scripts/wireframe-block.js` — pure, workspace-agnostische `parseWireframeBlock` (KBT-SR578): gestructureerde + legacy vrije-tekst-vorm + `## Wireframe — n.v.t. (geen UI)`-opt-out → `{ present, optOut, incomplete, wireframe, versie, paginas[] }`.
- **Skills gewired** (KBT-RL191):
  - `kanbantic-graduation` — Step 2 "graceful skip" vervangen door harde validatie.
  - `kanbantic-issue-prepare` — nieuwe Step 5W: wireframe-blok-validatie vóór de Ready-transitie.
  - `kanbantic-issue-execute` — nieuwe Step 3d: de gepinde pagina-markup als **bindende** context voor UI-tasks.
- **Fail-not-skip**: een onbekende/ambigue pagina of een incompleet blok blokkeert de lane-transitie (STOP); een `n.v.t.`-opt-out slaat de gate schoon over.
- **Tests**: `plugin/tests/wireframe-block.test.js` (16 unit) + `plugin/tests/wireframe-proxy-e2e.test.js` (real-proxy E2E: parser + proxy + get_wireframe-contract).

## Companion — Kanbantic API (repo `Kanbantic`)
- `get_wireframe` krijgt een optionele `page`-parameter (KBT-SR579): geeft de content van **díe** pagina terug (niet altijd de entry-point) via `ResolvedPage`, en onderscheidt deterministisch `PageNotFoundInVersion`, `AmbiguousPage` en `VersionNotFound` (met de beschikbare pagina-id's). Pure resolver `WireframePageResolver` (Domain.Shared). Additief/backward-compatible responsevelden.

## Grens (KBT-BD191)
Volledig workspace-agnostisch — geen hardcoded wireframe-id, workspace-slug of pagina-id in plugin- of API-code; alles komt uit het issue-blok.

## Downstream
Consument van de conventie: AdminHub Rule ADM-RL073.
