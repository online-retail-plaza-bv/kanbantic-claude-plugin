# Release Notes — v2.45.0

**KBT-F718 fast-follow — de proxy injecteert automatisch fromSessionId bij send_message**

## Waarom deze release ertoe doet voor wie de plugin gebruikt

Voor bestaand gebruik verandert er niets aan de buitenkant: `send_message(channelId, content)` blijft precies zo werken. Wat verandert is dat elk bericht dat deze proxy verstuurt nu de expliciete-afzender-weg gebruikt die KBT-F718 op de server bouwde, in plaats van de terugval-heuristiek — zonder dat een model daar iets van moet weten of om moet vragen.

## Het probleem

KBT-F718 (v0.18.0-actie 2 van Epic KBT-E134) voegde `fromSessionId` toe aan `send_message`: de server valideert expliciet dat de opgegeven sessie bij de aanroepende agent-identiteit hoort en actief is, in plaats van te gokken. Zonder die parameter blijft de server terugvallen op *"de meest recent geziene sessie van dezelfde agent-identiteit"* — precies de gok die tot een verkeerde afzender kan leiden zodra één agent-identiteit twee actieve sessies heeft (twee processen, twee werkstations). Tot deze release riep niets `send_message` ooit aan met `fromSessionId` — de parameter bestond, maar werd nooit gebruikt.

## Wat er verandert

`kanbantic-mcp-proxy.js`'s `dispatch`-pad krijgt een nieuwe mutatie, naast de bestaande `processToken`-injectie voor `register_agent_session`: elke uitgaande `send_message`-aanroep krijgt automatisch `fromSessionId` gezet op de sessie-id die deze proxy bij registratie (KBT-F717) heeft vastgelegd. Een expliciete `fromSessionId` die de aanroeper zelf al meegeeft wordt nooit overschreven. Zolang deze proxy nog niet geregistreerd is (geen sessie bekend), gebeurt er niets — de aanroep gaat ongewijzigd door, exact het oude gedrag.

## Verificatie

5 nieuwe tests in `plugin/tests/proxy-fromsessionid-injection.test.js`: injectie bij een bekende sessie, geen overschrijving van een expliciete waarde, geen effect op andere tools, geen effect zonder geregistreerde sessie, en de edge-case zonder een `arguments`-object. Volledige proxy-suite groen: 706 tests, 701 pass, 5 skipped, 0 fail.

## Wat dit niet is

Geen wijziging aan het rechtenmodel of de server-validatie zelf (die is al in KBT-F718 gedaan) — uitsluitend de proxy-kant die de al bestaande parameter nu daadwerkelijk gebruikt.
