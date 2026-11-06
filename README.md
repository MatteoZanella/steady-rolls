# Steady Rolls

Foundry VTT v14 module for dnd5e 6.

- Attack, damage and healing rolls are shown inside the item card that made them.
- Each further attack gets its own short card, with its own damage.
- The Attack and Damage buttons sit at the bottom of the card. Once used, they roll again on a new card: a new attack, or damage or healing on its own.
- Attack, check, save and initiative breakdowns name each bonus: ability, proficiency, item, effects.
- Rolls with several d20s show each die, the kept one highlighted.
- Advantage, disadvantage and critical damage can be switched after the roll, keeping the dice already rolled.
- A die can be rerolled from the roll's breakdown. The old value stays there crossed out: clicking it, or Undo on the info card in chat, goes back to it.
- Placing an area of effect targets the tokens inside, for the item card's save and damage buttons too; while placing, the tokens it will target are previewed.
- Save cards list each target with its save, or a roll button for its owner; a Save button rolls for your selected tokens. A token that saves untargeted joins the targets; the damage goes to those who saved.
- Legendary Resistance is a toggle on a failed save, and gives the use back when switched off.
- The newest card follows your targets until damage is applied from it; the Apply tray marks who took damage.
- Optional fast-forward per roll type, automatic damage (never, on hit, always) and automatic save damage.
- With Dice So Nice, cards appear at once and show their results when the dice land.

## Installation

In Foundry, Add-on Modules → Install Module, with this manifest URL:

`https://github.com/MatteoZanella/steady-rolls/releases/latest/download/module.json`

## Hooks

Changes made after a roll (advantage, critical, rerolls, undo) update the message without dnd5e's roll hooks. Modules can follow them with:

- `steady-rolls.preChangeRolls(message, rolls, cause)`: the new rolls, evaluated, before they are saved. Return `false` to cancel.
- `steady-rolls.changeRolls(message, previous, cause)`: after they are saved; `previous` are the rolls they replaced.

`cause` is `"advantage"`, `"critical"`, `"reroll"` or `"undo"`.

## License

MIT, see [LICENSE](LICENSE). Some templates are adapted from the dnd5e system; see [NOTICE](NOTICE).
