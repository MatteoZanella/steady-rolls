/**
 * Roll modes switched after the roll: advantage and disadvantage on d20 rolls, critical on
 * damage (following its attack's critical). The roll is rebuilt in the new mode by dnd5e
 * (configureModifiers, configureDamage) and evaluated by Foundry. Each die of the new roll is
 * fed the results of the die it comes from, so dice already rolled keep their values and only
 * missing dice are rolled; dice dropped by a switch are kept with the roll and reused by the
 * next one, so switching back and forth cannot fish for a better die.
 *
 * Dice are matched by identity, not by value: d20 rolls keep their structure, so a die is
 * its position; damage dice are tagged with their position in the formula before critical
 * scaling, and dnd5e's critical dice (altered counts, copies) carry the tag of their source.
 * Rolls whose dice cannot be tracked (pools, functions, random counts) get no toggles.
 */
import { MODULE_ID } from "./common.mjs";
import { diceSoNiceHides, isRolling, throwDice } from "./dice.mjs";

/** Term option holding a damage die's position in the formula before critical scaling. */
const SOURCE = "steadyStrikeSource";

/** Result value standing for a new result, to find it in dnd5e's breakdown data. No die rolls it. */
const MARK = -1;

/** The breakdown open when a switch was clicked, shown again once its card is redrawn. */
let reopen = null;

/* -------------------------------------------- */
/*  Dice identity                               */
/* -------------------------------------------- */

/** A roll's dice in evaluation order, or null if any dice cannot be tracked. */
function diceOf(roll) {
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
function keyed(dice) {
  const copies = {};
  return dice.map((die, index) => {
    const source = die.options?.[SOURCE] ?? `u${index}`;
    copies[source] = (copies[source] ?? -1) + 1;
    return { die, key: `${source}#${copies[source]}` };
  });
}

/** Whether two lists of dice have the same shape: size, count and modifiers. */
function sameShape(a, b) {
  return a && b && (a.length === b.length) && a.every((die, i) => (die.faces === b[i].faces)
    && (die.number === b[i].number) && (die.modifiers.join() === b[i].modifiers.join()));
}

/* -------------------------------------------- */
/*  Damage                                      */
/* -------------------------------------------- */

/** dnd5e.postBuildRollConfig: keep a damage roll's formula before critical scaling. */
export function onPostBuildRoll(process, config) {
  if ( !process.hookNames?.includes("damage") || !config.parts?.length ) return;
  const base = Roll.replaceFormulaData(config.parts.join(" + "), config.data ?? {});
  foundry.utils.setProperty(config, `options.${MODULE_ID}.base`, base);
}

/**
 * dnd5e.postDamageRollConfiguration: tag each die with its source, by rebuilding the roll from
 * its formula before scaling and checking that dnd5e produces the same dice.
 */
export function onPostDamageRollConfiguration(rolls) {
  for ( const roll of rolls ) {
    if ( !roll.options?.[MODULE_ID]?.base ) continue;
    const reference = diceOf(buildDamage(roll, roll.isCritical));
    const dice = diceOf(roll);
    if ( sameShape(reference, dice) ) dice.forEach((die, i) => die.options[SOURCE] = reference[i].options[SOURCE]);
  }
}

/** A damage roll rebuilt from its formula before scaling, its dice tagged, then scaled by dnd5e. */
function buildDamage(old, isCritical) {
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

/* -------------------------------------------- */
/*  Eligibility                                 */
/* -------------------------------------------- */

/** Whether a message's d20 rolls can switch mode: not once their result was applied (death saves, initiative). */
function switchesAdvantage(message) {
  if ( !["attack", "check", "save"].includes(message.type) || message.getFlag("core", "initiativeRoll") ) return false;
  const { type, resisted, outcome } = message.system;
  if ( (message.type === "save") && ((type === "death") || resisted || outcome) ) return false;
  return (message.rolls.length > 0) && message.rolls.every(roll => roll.validD20Roll && diceOf(roll));
}

/**
 * Whether a message's damage rolls can switch critical. Only attacks crit: the damage of an
 * attack, or of a damage activity added to one (a smite); not a save's. A damage already
 * critical can always be switched back. Every die must be tagged with its source.
 */
function switchesCritical(message) {
  if ( message.type !== "damage" ) return false;
  const canCrit = ["attack", "damage"].includes(message.getAssociatedActivity()?.type);
  if ( !canCrit && !message.rolls[0]?.isCritical ) return false;
  return (message.rolls.length > 0) && message.rolls.every(roll => {
    const dice = roll.options?.[MODULE_ID]?.base && diceOf(roll);
    return dice && dice.every(die => die.options?.[SOURCE] !== undefined);
  });
}

/** Whether this user can switch a message's rolls now. */
function canSwitch(message) {
  return message.canUserModify(game.user, "update") && message.isContentVisible && !isRolling(message);
}

/* -------------------------------------------- */
/*  Rendering                                   */
/* -------------------------------------------- */

/**
 * dnd5e.renderChatMessage: show every d20 of a roll with more than one (kept one in full,
 * dropped ones greyed), mark what a switch rolled anew, show a breakdown open before a switch
 * again, and put the mode toggles on the roll's bar, outside its button.
 */
export function decorateRolls(message, root, own = null) {
  const buttons = [...root.querySelectorAll("button.dice-roll")].filter(b => b.closest(".card-summary") === own);
  buttons.forEach((button, index) => markRoll(button, message.rolls[index]));
  markBreakdowns(message, root, own);
  showAgain(message, root, own);
  if ( message.type === "damage" ) showCritical(message, root, own, buttons[0]);
  if ( !canSwitch(message) ) return;
  if ( switchesAdvantage(message) ) {
    const { ADVANTAGE, DISADVANTAGE, NORMAL } = CONFIG.Dice.D20Roll.ADV_MODE;
    buttons.forEach((button, index) => {
      const current = message.rolls[index]?.options.advantageMode;
      if ( current === undefined ) return;
      const toggle = (mode, icon, label) => modeButton(icon, label, current === mode,
        () => setAdvantage(message, index, (current === mode) ? NORMAL : mode));
      onBar(button, toggle(DISADVANTAGE, "fa-angles-down", "DND5E.Disadvantage"),
        toggle(ADVANTAGE, "fa-angles-up", "DND5E.Advantage"));
    });
  }
  else if ( switchesCritical(message) && buttons[0] ) {
    const critical = message.rolls[0].isCritical;
    const toggle = modeButton("fa-explosion", "DND5E.Critical", critical, () => setCritical(message, !critical));
    toggle.classList.add("critical");
    onBar(buttons[0], toggle, null);
  }
}

/**
 * A critical damage shows the critical symbol instead of dnd5e's Critical tag: the toggle for
 * users who can switch it, otherwise the symbol alone. Hidden while the dice roll, as it would
 * tell the attack's crit.
 */
function showCritical(message, root, own, button) {
  [...root.querySelectorAll(".pill.critical")].filter(p => p.closest(".card-summary") === own).forEach(p => p.remove());
  if ( !button || !message.rolls[0]?.isCritical || isRolling(message) ) return;
  if ( canSwitch(message) && switchesCritical(message) ) return;
  const symbol = document.createElement("span");
  symbol.className = "steady-strike-mode critical";
  symbol.ariaLabel = game.i18n.localize("DND5E.Critical");
  symbol.dataset.tooltip = "";
  symbol.role = "img";
  symbol.innerHTML = '<i class="fa-solid fa-explosion" inert></i>';
  onBar(button, symbol, null);
}

/** A message's breakdowns inside `root`, without those of rolls folded into it. */
function breakdownsOf(root, own) {
  return [...root.querySelectorAll(".roll-breakdown")].filter(p => p.closest(".card-summary") === own);
}

/**
 * While new dice roll, mark their results in the breakdown (`data-steady-strike-new`), for
 * masking. dnd5e builds the breakdown data from the rolls; it is built again here from copies
 * whose new results carry MARK, so each mark lands on the result dnd5e shows for it.
 */
function markBreakdowns(message, root, own) {
  if ( !isRolling(message) ) return;
  const added = message.rolls.map(roll => roll.options?.[MODULE_ID]?.fresh ?? {});
  if ( !added.some(a => Object.keys(a).length) ) return;
  const marked = message.rolls.map((roll, i) => {
    const copy = roll.constructor.fromData(foundry.utils.deepClone(roll.toJSON()));
    for ( const { die, key } of keyed(diceOf(copy) ?? []) ) {
      for ( const index of added[i][key] ?? [] ) if ( die.results[index] ) die.results[index].result = MARK;
    }
    return copy;
  });
  const breakdowns = breakdownsOf(root, own);
  const parts = (message.type === "damage")
    ? [(CONFIG.DND5E.aggregateDamageDisplay ? dnd5e.dice.aggregateDamageRolls(marked) : marked)
      .map(roll => roll.aggregateTerms().dice)]
    : marked.map(roll => roll.dice.map(die => die.getTooltipData().rolls));
  parts.forEach((rolls, i) => {
    const sections = breakdowns[i]?.querySelectorAll(".tooltip-part:not(.constant-term)") ?? [];
    rolls.forEach((results, k) => {
      const items = sections[k]?.querySelectorAll(".dice-rolls > li.roll") ?? [];
      results.forEach((result, j) => {
        if ( (result.result !== String(MARK)) || !items[j] ) return;
        items[j].dataset.steadyStrikeNew = "";
        sections[k].dataset.steadyStrikeNew = "";
      });
    });
  });
}

/** Remember the open breakdown before a switch: clicking the toggle closes it (light dismiss). */
function rememberBreakdown() {
  reopen = null;
  const popover = document.querySelector(".roll-breakdown:popover-open");
  const scope = popover?.closest(".card-summary[data-message-id], .message[data-message-id]");
  if ( !scope ) return;
  const index = breakdownsOf(scope, scope.matches(".card-summary") ? scope : null).indexOf(popover);
  reopen = { id: scope.dataset.messageId, index, notifications: !!popover.closest("#chat-notifications") };
}

/** Show the remembered breakdown again on its redrawn card, until its dice have landed. */
function showAgain(message, root, own) {
  const pending = reopen;
  if ( pending?.id !== message.id ) return;
  const popover = breakdownsOf(root, own)[pending.index];
  if ( !popover ) return;
  // The card is not in the log yet: show it once it is, and only where it was (log or notifications).
  requestAnimationFrame(() => {
    const roll = popover.previousElementSibling?.querySelector("button.dice-roll") ?? popover.previousElementSibling;
    if ( !popover.isConnected || !roll?.checkVisibility() ) return;
    if ( !!popover.closest("#chat-notifications") !== pending.notifications ) return;
    popover.showPopover({ source: roll });
    if ( (reopen === pending) && !isRolling(message) ) reopen = null;
  });
}

/**
 * Mark a roll's button: changed by the last switch (`data-steady-strike-switched`), with its new
 * d20 results (`data-steady-strike-new`), for masking. A roll with more than one d20 shows them
 * all, in roll order, without the results replaced by rerolls.
 */
function markRoll(button, roll) {
  const added = roll?.options?.[MODULE_ID]?.fresh;
  if ( added ) button.dataset.steadyStrikeSwitched = "";
  const d20 = roll?.validD20Roll ? roll.d20 : null;
  const element = button.querySelector(".d20die");
  if ( !d20 || !element ) return;
  const key = keyed(diceOf(roll) ?? []).find(k => k.die === d20)?.key;
  const isNew = index => !!added?.[key]?.includes(index);
  const shown = d20.results.map((result, index) => ({ result, index }))
    .filter(({ result }) => result.active || result.discarded);
  if ( shown.length < 2 ) {
    if ( shown.length && isNew(shown[0].index) ) element.dataset.steadyStrikeNew = "";
    return;
  }
  element.classList.add("steady-strike-d20s");
  element.replaceChildren(...shown.map(({ result, index }) => {
    const span = document.createElement("span");
    span.className = `steady-strike-d20${result.active ? "" : " dropped"}`;
    if ( isNew(index) ) span.dataset.steadyStrikeNew = "";
    span.innerHTML = '<i class="fa-fw fa-solid fa-hexagon fa-rotate-90" inert></i><span class="roll"></span>';
    span.querySelector(".roll").textContent = result.count ?? result.result;
    return span;
  }));
}

/**
 * Put toggles on a roll's bar, either side of its total: siblings of its button, so they
 * neither open nor highlight it.
 */
function onBar(button, before, after) {
  const bar = document.createElement("span");
  bar.className = "steady-strike-bar";
  button.replaceWith(bar);
  before?.classList.add("before");
  after?.classList.add("after");
  bar.append(...[before, button, after].filter(Boolean));
}

/** A toggle icon: gold when on, greyed out when off. */
function modeButton(icon, label, pressed, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "steady-strike-mode";
  button.ariaLabel = game.i18n.localize(label);
  button.ariaPressed = String(pressed);
  button.dataset.tooltip = "";
  button.innerHTML = `<i class="fa-solid ${icon}" inert></i>`;
  button.addEventListener("pointerdown", rememberBreakdown);
  button.addEventListener("click", async event => {
    event.stopPropagation();
    if ( event.detail === 0 ) rememberBreakdown(); // From the keyboard: no pointerdown.
    button.disabled = true;
    try { await onClick(); }
    catch(err) { console.error(`${MODULE_ID} | Could not switch the roll`, err); }
    finally { button.disabled = false; }
  });
  return button;
}

/* -------------------------------------------- */
/*  Switching                                   */
/* -------------------------------------------- */

/** Switch one d20 roll to advantage, disadvantage or normal; an attack's damage follows its critical. */
async function setAdvantage(message, index, mode) {
  const { ADVANTAGE, DISADVANTAGE } = CONFIG.Dice.D20Roll.ADV_MODE;
  const old = message.rolls[index];
  const roll = old.clone();
  roll.options = foundry.utils.deepClone(old.options);
  Object.assign(roll.options, {
    advantageMode: mode, advantage: mode === ADVANTAGE, disadvantage: mode === DISADVANTAGE, configured: false
  });
  roll.configureModifiers();
  const rolls = message.rolls.with(index, roll);
  const attack = await save(message, rolls, await evaluateWith([old], [roll]), {
    flavor: advantageFlavor(message.flavor, rolls)
  });
  const thrown = [attack];
  if ( (message.type === "attack") && (old.isCritical !== roll.isCritical) ) {
    const usage = message.system.origin;
    // Only damage still matching the attack's old critical: a damage switched by hand stays.
    const damage = (usage?.getAssociatedRolls?.("damage") ?? []).filter(m => switchesCritical(m) && canSwitch(m)
      && (m.getFlag(MODULE_ID, "attack") === message.id) && (m.rolls[0].isCritical === old.isCritical));
    // While the attack's dice roll, its damage is masked whole: its change would tell the crit.
    for ( const m of damage ) thrown.push(await switchCritical(m, roll.isCritical, { whole: attack.masked }));
  }
  throwAll(thrown);
}

/** Switch all damage rolls of a message to critical or normal. */
async function setCritical(message, isCritical) {
  throwAll([await switchCritical(message, isCritical)]);
}

/**
 * @param {object} [options]
 * @param {boolean} [options.whole]  Mask the whole damage until the dice land, not only its new dice.
 */
async function switchCritical(message, isCritical, { whole = false } = {}) {
  const rolls = message.rolls.map(old => buildDamage(old, isCritical));
  const dice = await evaluateWith(message.rolls, rolls);
  if ( whole ) rolls.forEach(roll => delete roll.options[MODULE_ID].fresh);
  return save(message, rolls, dice, { mask: whole });
}

/** The message flavor with dnd5e's advantage tag for the new rolls. */
function advantageFlavor(flavor = "", rolls) {
  const tag = key => ` (${game.i18n.localize(key)})`;
  for ( const key of ["DND5E.Advantage", "DND5E.Disadvantage"] ) {
    if ( flavor.endsWith(tag(key)) ) flavor = flavor.slice(0, -tag(key).length);
  }
  if ( rolls.every(r => r.hasAdvantage) ) flavor += tag("DND5E.Advantage");
  else if ( rolls.every(r => r.hasDisadvantage) ) flavor += tag("DND5E.Disadvantage");
  return flavor;
}

/**
 * Evaluate new rolls, each die fed the results of the old die with the same identity (first
 * rolls, then rerolls and explosions), then its spares. Missing results are rolled through the
 * user's dice configuration (DiceTerm#_roll, Foundry's fulfillment point). Unused results are
 * kept as spares, and the indices of new results are recorded to mask only them.
 * @returns {Die[]}  The dice rolled anew, for Dice So Nice.
 */
async function evaluateWith(oldRolls, rolls) {
  const { Die } = foundry.dice.terms;
  const fresh = {};
  for ( const [i, roll] of rolls.entries() ) {
    const old = oldRolls[i];
    const queues = {};
    for ( const { die, key } of keyed(diceOf(old)) ) {
      const values = die.results.map(r => r.result);
      const count = Number.isInteger(die.number) ? Math.abs(die.number) : values.length;
      queues[key] = { first: values.slice(0, count), extra: values.slice(count) };
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
        if ( values.length ) return values.shift();
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

/**
 * Save the new rolls. With new dice (or `mask`), the message is marked rolling, masking it until
 * the dice land; rolls left unchanged lose their record of new dice.
 * @returns {{ message: ChatMessage5e, dice: Die[], masked: boolean }}
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
function throwAll(thrown) {
  const dice = thrown.flatMap(t => t.dice);
  if ( dice.length && game.dice3d ) throwDice(thrown.filter(t => t.masked || t.dice.length).map(t => t.message), dice);
}
