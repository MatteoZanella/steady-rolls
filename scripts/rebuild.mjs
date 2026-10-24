/**
 * Rolls rebuilt after the fact, with their dice kept: the base of the mode switches (modes.mjs)
 * and of rerolls (rerolls.mjs). The roll is rebuilt by dnd5e (configureModifiers,
 * configureDamage) and evaluated by Foundry. Each die of the new roll is fed the results of the
 * die it comes from, so dice already rolled keep their values and only missing dice are
 * rolled; results left unused are kept with the roll as spares and reused by the next rebuild.
 *
 * Dice are matched by identity, not by value: d20 rolls keep their structure, so a die is its
 * position; damage dice are tagged with their position in the formula before critical scaling,
 * and dnd5e's critical dice (altered counts, copies) carry the tag of their source. Rolls whose
 * dice cannot be tracked (pools, functions, random counts) are not rebuilt.
 */
import { DAMAGE_TYPES, MODULE_ID } from "./common.mjs";
import { diceSoNiceHides, isRolling, throwDice } from "./dice.mjs";

/** Term option holding a damage die's position in the formula before critical scaling. */
const SOURCE = "steadyRollsSource";

/** A queued result to roll anew instead of reusing (a reroll). */
const FRESH = Symbol("fresh");

/** Messages whose rolls this client is changing. */
const changing = new Set();

/* -------------------------------------------- */
/*  Dice identity                               */
/* -------------------------------------------- */

/** A roll's dice in evaluation order, or null if any dice cannot be tracked. */
export function diceOf(roll) {
  const { DiceTerm, ParentheticalTerm, PoolTerm, FunctionTerm } = foundry.dice.terms;
  const dice = [];
  const visit = terms => terms.every(term => {
    if ( term instanceof DiceTerm ) {
      const random = [term._number, term._faces].some(r => (r instanceof Roll) && !r.isDeterministic);
      if ( !random ) dice.push(term);
      return !random;
    }
    if ( term instanceof ParentheticalTerm ) return visit((term.roll ??= Roll.create(term.term)).terms);
    if ( (term instanceof PoolTerm) || (term instanceof FunctionTerm) ) return term.isDeterministic;
    return true;
  });
  return visit(roll.terms) ? dice : null;
}

/** Each die with its identity: source and copy number ("0#0" for the first copy of source 0). */
export function keyed(dice) {
  const copies = {};
  return dice.map((die, index) => {
    const source = die.options?.[SOURCE] ?? `u${index}`;
    copies[source] = (copies[source] ?? -1) + 1;
    return { die, key: `${source}#${copies[source]}` };
  });
}

/** How many of a die's results are first rolls; the rest are its rerolls and explosions. */
function firstCount(die) {
  return Number.isInteger(die.number) ? Math.abs(die.number) : die.results.length;
}

/** A die by identity, or undefined. */
export function dieOf(roll, key) {
  return keyed(diceOf(roll) ?? []).find(k => k.key === key)?.die;
}

/** A die's result by identity and index, or undefined. */
export function resultAt(roll, key, index) {
  return dieOf(roll, key)?.results[index];
}

/**
 * Whether a message's rolls can be rebuilt, and how: "d20" or "damage" (also healing). Not
 * once their result was applied (death saves, initiative, a resisted or concluded save), nor
 * for damage whose dice are not all tagged with their source.
 * @returns {"d20"|"damage"|null}
 */
export function rebuildKind(message) {
  if ( !message.rolls.length ) return null;
  if ( ["attack", "check", "save"].includes(message.type) ) {
    if ( message.getFlag("core", "initiativeRoll") ) return null;
    const { type, resisted, outcome } = message.system;
    if ( (message.type === "save") && ((type === "death") || resisted || outcome) ) return null;
    return message.rolls.every(roll => roll.validD20Roll && diceOf(roll)) ? "d20" : null;
  }
  if ( !DAMAGE_TYPES.has(message.type) ) return null;
  return message.rolls.every(roll => {
    const dice = roll.options?.[MODULE_ID]?.base && diceOf(roll);
    return dice && dice.every(die => die.options?.[SOURCE] !== undefined);
  }) ? "damage" : null;
}

/** Whether a damage roll is kept as rolled: changed by another module after it was built. */
export function isFixed(message) {
  return message.rolls.some(roll => roll.options?.[MODULE_ID]?.fixed);
}

/* -------------------------------------------- */
/*  Building                                    */
/* -------------------------------------------- */

/**
 * dnd5e.postBuildRollConfig: keep a damage roll's formula before critical scaling, from its parts.
 * Listeners after this one can still add parts: checked once the roll is built.
 */
export function onPostBuildRoll(process, config) {
  if ( !process.hookNames?.includes("damage") || !config.parts?.length ) return;
  const base = Roll.replaceFormulaData(config.parts.join(" + "), config.data ?? {});
  foundry.utils.setProperty(config, `options.${MODULE_ID}.base`, base);
}

/**
 * dnd5e.postDamageRollConfiguration: make each damage roll rebuildable.
 * - A roll built normal is its own formula before scaling: dnd5e only re-compiles it.
 * - A roll built critical keeps the formula from its parts, only if rebuilding from it gives this
 *   very roll. Otherwise another module added a part after the parts were read (onPostBuildRoll
 *   is registered last to avoid it): the roll is kept as rolled (`fixed`), not rebuilt without it.
 * Then each die is tagged with its source, from the rebuilt roll.
 */
export function onPostDamageRollConfiguration(rolls) {
  for ( const roll of rolls ) {
    const own = roll.options?.[MODULE_ID];
    if ( !own?.base ) continue;
    if ( !roll.isCritical ) own.base = roll.formula;
    const reference = buildDamage(roll, roll.isCritical);
    const dice = diceOf(roll);
    if ( !dice || (reference.formula !== roll.formula) ) {
      delete own.base;
      own.fixed = reference.formula !== roll.formula;
      continue;
    }
    diceOf(reference).forEach((die, i) => dice[i].options[SOURCE] = die.options[SOURCE]);
  }
}

/** A damage roll rebuilt from its formula before scaling, its dice tagged, then scaled by dnd5e. */
export function buildDamage(old, isCritical) {
  const options = foundry.utils.deepClone(old.options);
  delete options[MODULE_ID].spare;
  delete options[MODULE_ID].fresh;
  const roll = new old.constructor(options[MODULE_ID].base, old.data, {
    ...options, isCritical, configured: true, preprocessed: false
  });
  diceOf(roll)?.forEach((die, i) => die.options[SOURCE] = i);
  roll.options.configured = false;
  roll.configureDamage();
  // Dice added by the critical itself (its bonus damage) have no source: tag them by position.
  diceOf(roll)?.forEach((die, i) => die.options[SOURCE] ??= `c${i}`);
  return roll;
}

/** A d20 roll rebuilt by dnd5e in an advantage mode (its own by default). */
export function buildD20(old, mode = old.options.advantageMode) {
  const { ADVANTAGE, DISADVANTAGE } = CONFIG.Dice.D20Roll.ADV_MODE;
  const roll = old.clone();
  roll.options = foundry.utils.deepClone(old.options);
  Object.assign(roll.options, {
    advantageMode: mode, advantage: mode === ADVANTAGE, disadvantage: mode === DISADVANTAGE, configured: false
  });
  roll.configureModifiers();
  return roll;
}

/** A roll rebuilt in its own mode. */
export function buildSame(old) {
  return old.validD20Roll ? buildD20(old) : buildDamage(old, old.isCritical);
}

/* -------------------------------------------- */
/*  Evaluation                                  */
/* -------------------------------------------- */

/**
 * Evaluate new rolls, each die fed the results of the old die with the same identity (first
 * rolls, then rerolls and explosions), then its spares. Missing results are rolled through the
 * user's dice configuration (DiceTerm#_roll, Foundry's fulfillment point). Unused results are
 * kept as spares, and the indices of new results are recorded to mask only them.
 * @param {Roll[]} oldRolls
 * @param {Roll[]} rolls
 * @param {object} [options]
 * @param {Record<string, Record<number, number|null>>[]} [options.replace]  Per roll, first
 *   results to replace by die identity and index: with a value, or rolled anew if null.
 * @returns {Promise<Die[]>}  The dice rolled anew, for Dice So Nice.
 */
export async function evaluateWith(oldRolls, rolls, { replace = [] } = {}) {
  const { Die } = foundry.dice.terms;
  const fresh = {};
  for ( const [i, roll] of rolls.entries() ) {
    const old = oldRolls[i];
    const queues = {};
    for ( const { die, key } of keyed(diceOf(old)) ) {
      const values = die.results.map(r => r.result);
      const count = firstCount(die);
      queues[key] = { first: values.slice(0, count), extra: values.slice(count) };
      for ( const [index, value] of Object.entries(replace[i]?.[key] ?? {}) ) {
        if ( index < count ) queues[key].first[index] = value ?? FRESH;
      }
    }
    for ( const [key, spare] of Object.entries(old.options[MODULE_ID]?.spare ?? {}) ) {
      queues[key] ??= { first: [], extra: [] };
      queues[key].first.push(...spare.first);
      queues[key].extra.push(...spare.extra);
    }
    const added = {};
    const tracked = keyed(diceOf(roll)).map(({ die, key }) => {
      const queue = queues[key] ?? { first: [], extra: [] };
      delete queues[key];
      die._roll = async (options = {}) => {
        const values = queue[(options.reroll || options.explode) ? "extra" : "first"];
        const value = values.length ? values.shift() : FRESH;
        if ( value !== FRESH ) return value;
        const result = (await Object.getPrototypeOf(die)._roll.call(die, options)) ?? die.randomFace();
        (added[key] ??= []).push(die.results.length);
        (fresh[die.faces] ??= []).push(result);
        return result;
      };
      return { key, queue };
    });
    await roll.evaluate({ allowInteractive: false });
    const spare = { ...queues };
    for ( const { key, queue } of tracked ) if ( queue.first.length || queue.extra.length ) spare[key] = queue;
    roll.options[MODULE_ID] ??= {};
    roll.options[MODULE_ID].spare = spare;
    roll.options[MODULE_ID].fresh = added;
  }
  return Object.entries(fresh).map(([faces, values]) => new Die({
    faces: Number(faces), number: values.length, results: values.map(result => ({ result, active: true }))
  }));
}

/* -------------------------------------------- */
/*  Changing                                    */
/* -------------------------------------------- */

/** Whether this user can change a message's rolls now. */
export function canChange(message) {
  return message.canUserModify(game.user, "update") && message.isContentVisible && !isRolling(message);
}

/**
 * Change a message's rolls, one change at a time: `build` makes the new rolls from the current
 * ones, and they are saved only if the rolls are still those (another client may have changed
 * them meanwhile). A change asked while another runs is dropped.
 * Hooks, for other modules (dnd5e's roll hooks don't fire for a change):
 * - `steady-rolls.preChangeRolls(message, rolls, cause)`: the new rolls, evaluated, before they
 *   are saved; return false to cancel.
 * - `steady-rolls.changeRolls(message, previous, cause)`: after; `previous` are the rolls replaced.
 * @param {ChatMessage5e} message
 * @param {"advantage"|"critical"|"reroll"|"undo"} cause
 * @param {(rolls: Roll[]) => Promise<{ rolls: Roll[], dice: Die[], mask?: boolean }|null>} build
 *   The new rolls, their new dice, and other changes to save; null to change nothing.
 * @returns {Promise<{ message: ChatMessage5e, dice: Die[], masked: boolean }|null>}
 */
export async function changeRolls(message, cause, build) {
  if ( changing.has(message.id) || !canChange(message) ) return null;
  changing.add(message.id);
  try {
    const current = message.rolls;
    const before = JSON.stringify(current);
    const built = await build(current);
    if ( !built ) return null;
    if ( JSON.stringify(message.rolls) !== before ) {
      ui.notifications.warn("STEADY_ROLLS.Changed", { localize: true });
      return null;
    }
    const { rolls, dice, ...changes } = built;
    if ( Hooks.call(`${MODULE_ID}.preChangeRolls`, message, rolls, cause) === false ) return null;
    const saved = await save(message, rolls, dice, changes);
    Hooks.callAll(`${MODULE_ID}.changeRolls`, message, current, cause);
    return saved;
  }
  finally {
    changing.delete(message.id);
  }
}

/**
 * Save the new rolls. With new dice (or `mask`), the message is marked rolling, masking it until
 * the dice land; rolls left unchanged lose their record of new dice.
 * @returns {Promise<{ message: ChatMessage5e, dice: Die[], masked: boolean }>}
 */
async function save(message, rolls, dice, { mask = false, ...changes } = {}) {
  for ( const roll of rolls ) {
    if ( !message.rolls.includes(roll) ) continue;
    delete roll.options[MODULE_ID]?.fresh;
  }
  const masked = (mask || (dice.length > 0)) && !!game.dice3d && diceSoNiceHides();
  if ( masked ) changes[`flags.${MODULE_ID}.rolling`] = game.time.serverTime;
  await message.update({ ...changes, rolls: rolls.map(roll => roll.toJSON()) });
  return { message, dice, masked };
}

/** One Dice So Nice throw for every new die, then reveal the messages. */
export function throwAll(thrown) {
  const dice = thrown.flatMap(t => t.dice);
  if ( dice.length && game.dice3d ) throwDice(thrown.filter(t => t.masked || t.dice.length).map(t => t.message), dice);
}

/* -------------------------------------------- */
/*  Breakdown                                   */
/* -------------------------------------------- */

/** A message's breakdowns inside `root`, without those of rolls folded into it. */
export function breakdownsOf(root, own) {
  return [...root.querySelectorAll(".roll-breakdown")].filter(p => p.closest(".card-summary") === own);
}

/**
 * Where each result of a message is shown in its breakdowns. dnd5e builds the breakdown data
 * from the rolls (grouping damage by type); it is built again here from copies whose results
 * carry codes, so each code lands on the item dnd5e shows for that result.
 * @returns {{ item: HTMLElement, part: HTMLElement, roll: number, key: string, index: number, first: boolean }[]}
 */
export function locateResults(message, root, own) {
  const where = [];
  const copies = message.rolls.map((roll, i) => {
    const copy = roll.constructor.fromData(foundry.utils.deepClone(roll.toJSON()));
    for ( const { die, key } of keyed(diceOf(copy) ?? []) ) {
      const count = firstCount(die);
      die.results.forEach((result, index) => {
        result.result = -(where.length + 2); // No die rolls a negative number.
        where.push({ roll: i, key, index, first: index < count });
      });
    }
    return copy;
  });
  const parts = DAMAGE_TYPES.has(message.type)
    ? [(CONFIG.DND5E.aggregateDamageDisplay ? dnd5e.dice.aggregateDamageRolls(copies) : copies)
      .map(roll => roll.aggregateTerms().dice)]
    : copies.map(roll => roll.dice.map(die => die.getTooltipData().rolls));
  const breakdowns = breakdownsOf(root, own);
  const found = [];
  parts.forEach((rolls, i) => {
    const sections = breakdowns[i]?.querySelectorAll(".tooltip-part:not(.constant-term)") ?? [];
    rolls.forEach((results, k) => {
      // Without the replaced values a reroll puts back in the breakdown (rerolls.mjs).
      const items = sections[k]?.querySelectorAll(".dice-rolls > li.roll:not(.steady-rolls-rerolled)") ?? [];
      results.forEach((result, j) => {
        const at = where[-Number(result.result) - 2];
        if ( at && items[j] ) found.push({ ...at, item: items[j], part: sections[k] });
      });
    });
  });
  return found;
}
