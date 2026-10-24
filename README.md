# Steady Strike

Foundry VTT v14 module for dnd5e 6.

- Attack, damage and healing rolls are shown inside the item card that made them.
- Each further attack gets its own short card, with its own damage.
- The Attack and Damage buttons sit at the bottom of the card. Once used, they roll again on a new card: a new attack, or damage or healing on its own.
- Attack, check, save and initiative breakdowns name each bonus: ability, proficiency, item, effects.
- Rolls with several d20s show each die, the kept one highlighted.
- Advantage, disadvantage and critical damage can be switched after the roll, keeping the dice already rolled.
- A die can be rerolled from the roll's breakdown. The old value stays there crossed out: clicking it, or Undo on the info card in chat, goes back to it.
- Optional fast-forward per roll type, automatic damage (never, on hit, always) and automatic save damage.
- With Dice So Nice, cards appear at once and show their results when the dice land.

## Hooks

Changes made after a roll (advantage, critical, rerolls, undo) update the message without dnd5e's roll hooks. Modules can follow them with:

- `steady-strike.preChangeRolls(message, rolls, cause)`: the new rolls, evaluated, before they are saved. Return `false` to cancel.
- `steady-strike.changeRolls(message, previous, cause)`: after they are saved; `previous` are the rolls they replaced.

`cause` is `"advantage"`, `"critical"`, `"reroll"` or `"undo"`.

## License

MIT, see [LICENSE](LICENSE). Some templates are adapted from the dnd5e system; see [NOTICE](NOTICE).
