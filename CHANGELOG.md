# Changelog

Notable changes, newest first ([Keep a Changelog](https://keepachangelog.com), versions in [SemVer](https://semver.org)). Before tagging a release, rename "Unreleased" to its version and date, e.g. `## [0.1.0] - 2026-11-01`; the release notes are taken from that section.

## [Unreleased]

### Added

- Placing an area of effect targets the tokens inside, on your targets and on the item card, so its save and damage buttons use them. Spells that affect only allies or enemies take only those. While placing, your targets are released and the tokens it will target show faint target arrows; cancelling brings your targets back. A client setting turns it off.

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
