# Release Notes — v2.46.0

**KBT-B1012 — kanaalmeldingen bevatten alleen strings in `meta`; Claude Code 2.1.277 sloot anders de MCP-verbinding**

## Waarom deze release ertoe doet voor wie de plugin gebruikt

Met Claude Code 2.1.277 (auto-update) verloor een agent bij het **eerste** kanaalbericht van een andere agent al zijn Kanbantic-tools. De sessie bleef draaien, het bord toonde het bericht als afgeleverd, maar Claude verwerkte het niet en de proxy-verbinding was weg. Wie een oudere Claude draait merkte niets; wie is bijgewerkt, alles.

## Het probleem

`notifications/claude/channel` heeft in Claude Code het schema `meta: Record<string, string>`. De proxy stuurde `from_user: null` (elk bericht van een agent-sessie) en `room_is_home: false` (boolean). Claude Code 2.1.277 valideert dat strikt en meldt in zijn debug-log:

```
Invalid params for notification notifications/claude/channel: meta.from_user: Invalid input, meta.room_is_home: Invalid input
STDIO connection dropped after 75s uptime
```

Gemeten op Kanbantic-Dev-03 met een door het werkstation-daemon gespawnde agent (2026-09-18 21:46Z).

## Wat er verandert

`kanbantic-mcp-proxy.js` bouwt `meta` via `channelMeta()`: `null`/`undefined` worden weggelaten (dus geen `from_user` bij een sessie-auteur), alle overige waarden worden strings (`room_is_home: "true"`/`"false"`). Sleutels blijven identifiers. Voor de ontvangende Claude verandert de betekenis niet; alleen de vorm voldoet nu aan het schema.

## Verificatie

`plugin/tests/proxy-channel-meta.test.js`: de helper in isolatie én het echte `pollRoom()`-pad voor een sessie-auteur in een niet-home room — elke meta-waarde is een string, elke sleutel een identifier, `from_user` ontbreekt in plaats van `"null"`. `proxy-multi-room.test.js` verwacht nu `"true"` in plaats van `true`.

End-to-end op Dev-03 met de gepatchte proxy: de gespawnde Claude beantwoordde een kanaalbericht binnen tien seconden (KBT-TC3700, KBT-TC3804), waar het vóór de fix de verbinding verloor.

## Wat dit niet is

Geen wijziging aan wat er wordt meegestuurd of aan de server; uitsluitend de vorm van `meta`. Het F721-harnas (`ProxyHarness` in de monorepo) valideert dit schema nog niet — dat volgt apart onder KBT-F721.
