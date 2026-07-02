---
name: apply-edits
description: >
  Verwerk Slop Off browser-rapporten via de slop-off MCP server en
  pas de edits toe op de broncode van het huidige project. Blijft standaard
  in een lus rapporten verwerken tot de gebruiker stopt. Gebruik bij
  "/apply-edits", "pas mijn edit-rapport toe", "wacht op mijn browser-edits",
  of nadat de gebruiker in de browser edits heeft gemaakt met de
  Slop Off extensie.
---

# Apply browser edits

Verwerk rapporten van de `slop-off` MCP server en pas ze toe op de bron.

## Modus

- **Standaard (lus)**: roep `wait_for_report` aan (timeout_seconds: 60),
  pas het rapport toe, meld kort wat er is gedaan, en roep dán meteen weer
  `wait_for_report` aan. Blijf dit herhalen tot de gebruiker zegt te stoppen
  ("stop", "klaar", of een andere opdracht geeft).
  - Timeout zonder rapport? Gewoon opnieuw `wait_for_report` aanroepen,
    zonder commentaar. Na ~10 lege timeouts op rij: vraag de gebruiker één
    keer of je moet blijven wachten.
  - Meld bij de start éénmalig: "Ik wacht op browser-edits — zeg 'stop' als
    je klaar bent."
- Argument `once`: verwerk precies één rapport en stop.
- Argument `latest`: roep `get_latest_report` aan (niet wachten), pas toe, stop.
- Argument `list`: roep `list_reports` aan, toon de queue, vraag welke.

## Edits toepassen

Het rapport bevat per URL secties met Before/After HTML-paren en een
CSS-selector als hint.

1. Zoek per edit het bronbestand dat die pagina/HTML rendert: zoek op
   onderscheidende tekst uit het Before-blok (letterlijke strings eerst,
   daarna fuzzy). De URL zegt welke route/pagina; de selector waar in de DOM.
2. Vervang de Before-inhoud door de After-inhoud. Behoud bestaande
   formattering, indentatie en templating (vertaal HTML-wijzigingen naar de
   template/JSX/component als de bron geen platte HTML is).
3. Niet gevonden? Meld het expliciet met de dichtstbijzijnde match — nooit
   stil gokken of overslaan. Ga daarna gewoon door met de lus.
4. Placeholder-, href- en andere attribuutwijzigingen zijn attribuut-edits;
   pas alleen dat attribuut aan.

## Per verwerkt rapport

- Draai een snelle check als het project die heeft (typecheck/lint; geen
  volledige build per rapport in lus-modus).
- Vat in 1-3 regels samen: welke bestanden, welke edits, wat niet lukte.
- Ga direct terug naar wachten.
