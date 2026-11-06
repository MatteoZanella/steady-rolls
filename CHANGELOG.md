# Changelog

Notable changes, newest first ([Keep a Changelog](https://keepachangelog.com), versions in [SemVer](https://semver.org)). Before tagging a release, rename "Unreleased" to its version and date, e.g. `## [0.1.0] - 2026-11-01`; the release notes are taken from that section.

## [Unreleased]

### Added

- Placing an area of effect targets the tokens inside, on your targets and on the item card, so its save and damage buttons use them. Spells that affect only allies or enemies take only those. While placing, your targets are released and the tokens it will target show faint target arrows; cancelling brings your targets back. A client setting turns it off.
- Save cards have a saves section before the damage: the DC, then a row per target, by name, with its result or, where its total will be, a roll button for its owner (an hourglass for others). Below, a button that rolls for your selected tokens, or your character's token on the scene, and names them; a token that already rolled is struck through and not rolled again (reroll its dice instead). A save you can't see shows its total as "?".
- Legendary Resistance on a save is a toggle, like critical: on a failed save with uses left it turns the save into a success and spends a use; switched off, the use comes back. It replaces dnd5e's Resist button, in the save list and on the save's own card.
- The owner of an actor can switch advantage and reroll on its rolls even when someone else rolled them (the GM saves the change).
- A token that saves without being targeted joins the save card's targets, and the caster's targets while it is their newest card. A save card's damage goes to the tokens that saved.
- Cards follow your targets: changing your targets changes them on the newest card you made, its attack (hit or miss recomputed) and its damage, until you make another card. Once damage is applied from it, untargeting removes no one, and tokens you target are added only for now: when you make another card, they leave the old one unless they took damage from it (or saved, on a save card). A client setting turns it off.
- In the Apply tray, a mark on each target that took damage from that card, with the amount; its owner can click it to undo that damage. Undo takes back the hit-point changes, so damage or healing from elsewhere since stays.

### Fixed

- The advantage, disadvantage and critical toggles no longer fade in again, or vanish while new dice roll, after a click.

## [0.2.0-beta.1] - 2026-10-31

First beta, for testing; still in development.

### Added

- Attack, damage and healing rolls shown inside the item card that made them; each further attack on its own short card, with its damage.
- Attack and Damage buttons at the bottom of the card; once used, they roll again on a new card.
- Named bonuses in attack, check, save and initiative breakdowns; every d20 of a roll shown.
- Advantage, disadvantage and critical damage switched after the roll, keeping the dice already rolled.
- Rerolls of a single die from the breakdown, with the old value crossed out and Undo, from the breakdown or the info card.
- Fast-forward per roll type, automatic damage and save damage; results masked while Dice So Nice rolls.
- Hooks for other modules: `steady-rolls.preChangeRolls` and `steady-rolls.changeRolls`.
