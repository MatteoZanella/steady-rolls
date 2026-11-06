/**
 * Roll modes switched after the roll: advantage and disadvantage on d20 rolls, critical on
 * damage (following its attack's critical). The roll is rebuilt in the new mode with its dice
 * kept (rebuild.mjs): dice dropped by a switch are kept as spares and reused by the next one,
 * so switching back and forth cannot fish for a better die. Also shows every d20 of a roll,
 * and keeps a breakdown open across the redraw that a switch or reroll causes.
 */
import { MODULE_ID } from "./common.mjs";
import { isPlaying, isRolling } from "./dice.mjs";
import {
  breakdownsOf, buildD20, buildDamage, canChange, canModify, changeRolls, diceOf, evaluateWith, isFixed, keyed,
  locateResults, rebuildKind, throwAll
} from "./rebuild.mjs";

/** The breakdown open when a switch was clicked, shown again once its card is redrawn. */
let reopen = null;

/* -------------------------------------------- */
/*  Eligibility                                 */
/* -------------------------------------------- */

/** Whether a message's d20 rolls can switch advantage. */
function switchesAdvantage(message) {
  return rebuildKind(message) === "d20";
}

/**
 * Whether a message's damage can be critical. Only attacks crit: the damage of an attack, or of a
 * damage activity added to one (a smite); not a save's. A damage already critical always can.
 */
function canCrit(message) {
  if ( message.type !== "damage" ) return false;
  return ["attack", "damage"].includes(message.getAssociatedActivity()?.type) || !!message.rolls[0]?.isCritical;
}

/** Whether a message's damage rolls can switch critical. */
function switchesCritical(message) {
  return canCrit(message) && (rebuildKind(message) === "damage");
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
  if ( !canModify(message) ) return showResist(message, root, own, buttons[0]);
  // While its new dice roll, a roll keeps its toggles in place, inert, so they don't vanish and come back.
  // Advantage can switch on the client throwing them: the new die is thrown at once.
  const rolling = isRolling(message);
  const act = onClick => (rolling ? null : onClick);
  const actNow = onClick => ((rolling && !isPlaying(message)) ? null : onClick);
  if ( switchesAdvantage(message) ) {
    const { ADVANTAGE, DISADVANTAGE, NORMAL } = CONFIG.Dice.D20Roll.ADV_MODE;
    buttons.forEach((button, index) => {
      const current = message.rolls[index]?.options.advantageMode;
      if ( current === undefined ) return;
      const toggle = (mode, icon, label) => modeButton(icon, label, current === mode,
        actNow(() => setAdvantage(message, index, (current === mode) ? NORMAL : mode)));
      onBar(button, toggle(DISADVANTAGE, "fa-angles-down", "DND5E.Disadvantage"),
        toggle(ADVANTAGE, "fa-angles-up", "DND5E.Advantage"));
    });
  }
  else if ( buttons[0] && canCrit(message) ) {
    // A damage kept as rolled shows its toggle disabled, with the reason. While the dice roll, the
    // toggle doesn't show the critical: it would tell the attack's.
    const critical = !!message.rolls[0].isCritical;
    const toggle = switchesCritical(message)
      ? modeButton("fa-explosion", "DND5E.Critical", critical && !rolling, act(() => setCritical(message, !critical)))
      : isFixed(message) ? modeButton("fa-explosion", "STEADY_ROLLS.CriticalFixed", critical && !rolling) : null;
    toggle?.classList.add("critical");
    if ( toggle ) onBar(buttons[0], toggle, null);
  }
  showResist(message, root, own, buttons[0]);
}

/**
 * Legendary Resistance on a save, as a status toggle like critical, in place of dnd5e's Resist
 * button: on, the failed save counts as a success and a use is spent (dnd5e's resistSave); off
 * again, the use comes back. Shown only on a failed save (one without a DC can't fail) or one
 * resisted, for actors with Legendary Resistance; to others only once resisted. Without uses left
 * it stays inert, and says so; a death save resisted stays resisted (dnd5e also changes its tallies).
 */
function showResist(message, root, own, button) {
  const actor = message.getAssociatedActor?.();
  if ( !button || (message.type !== "save") || !actor?.system.resources?.legres?.max ) return;
  for ( const resist of root.querySelectorAll('button[data-action="resistSave"]') ) {
    if ( resist.closest(".card-summary") !== own ) continue;
    // On the save's own card, in dnd5e's button row: its item, and the row if nothing is left.
    const item = resist.parentElement?.matches("li") ? resist.parentElement : resist;
    const row = item.closest("section.icon-row");
    item.remove();
    if ( row && !row.querySelector("button") ) row.remove();
  }
  const resisted = !!message.system.resisted;
  const failed = message.rolls.some(r => r.isFailure);
  let toggle;
  if ( !resisted && !failed ) return; // Nothing to resist: a success, or a save without a DC.
  if ( actor.isOwner && message.canUserModify(game.user, "update") ) {
    const left = actor.system.resources.legres.value > 0;
    const canResist = !resisted && left;
    const canUndo = resisted && (message.system.type !== "death");
    const action = (canResist || canUndo) && !isRolling(message) ? () => setResisted(message, !resisted) : null;
    const label = (resisted || left) ? "DND5E.LegendaryResistance.Action.Resist" : "STEADY_ROLLS.ResistNone";
    toggle = modeButton("fa-dragon", label, resisted, action);
  }
  else if ( resisted ) {
    toggle = document.createElement("span");
    toggle.className = "steady-rolls-mode";
    toggle.ariaLabel = game.i18n.localize("DND5E.LegendaryResistance.Resisted");
    toggle.dataset.tooltip = "";
    toggle.role = "img";
    toggle.innerHTML = '<i class="fa-solid fa-dragon" inert></i>';
  }
  if ( !toggle ) return;
  toggle.classList.add("resist");
  let bar = button.closest(".steady-rolls-bar");
  if ( !bar ) {
    bar = document.createElement("span");
    bar.className = "steady-rolls-bar";
    button.replaceWith(bar);
    bar.append(button);
  }
  bar.prepend(toggle);
}

/**
 * Resist a failed save, spending a use (dnd5e's resistSave); or stop resisting it, giving the use
 * back, in one batch as dnd5e does. The actor is read now: a token's actor is rebuilt on update.
 */
async function setResisted(message, resisted) {
  const actor = message.getAssociatedActor();
  if ( resisted ) return actor.system.resistSave(message);
  const { spent } = actor.system.resources.legres;
  return actor.performBulkUpdate({
    actor: { "system.resources.legres.spent": Math.max(spent - 1, 0) },
    operations: [{ action: "update", documentName: "ChatMessage", updates: [{ _id: message.id, "system.resisted": false }] }]
  });
}

/**
 * A critical damage shows the critical symbol instead of dnd5e's Critical tag: the toggle for
 * users who can switch it, otherwise the symbol alone. Hidden while the dice roll, as it would
 * tell the attack's crit.
 */
function showCritical(message, root, own, button) {
  [...root.querySelectorAll(".pill.critical")].filter(p => p.closest(".card-summary") === own).forEach(p => p.remove());
  if ( !button || !message.rolls[0]?.isCritical || isRolling(message) ) return;
  if ( canChange(message) && (switchesCritical(message) || isFixed(message)) ) return;
  const symbol = document.createElement("span");
  symbol.className = "steady-rolls-mode critical";
  symbol.ariaLabel = game.i18n.localize("DND5E.Critical");
  symbol.dataset.tooltip = "";
  symbol.role = "img";
  symbol.innerHTML = '<i class="fa-solid fa-explosion" inert></i>';
  onBar(button, symbol, null);
}

/** While new dice roll after a switch or reroll, mark their results in the breakdown (`data-steady-rolls-new`). */
function markBreakdowns(message, root, own) {
  if ( !isRolling(message) ) return;
  const added = message.rolls.map(roll => roll.options?.[MODULE_ID]?.fresh ?? {});
  if ( !added.some(a => Object.keys(a).length) ) return;
  for ( const { item, part, roll, key, index } of locateResults(message, root, own) ) {
    if ( !added[roll][key]?.includes(index) ) continue;
    item.dataset.steadyRollsNew = "";
    part.dataset.steadyRollsNew = "";
  }
}

/** Remember the open breakdown before a change: clicking a toggle closes it (light dismiss). */
export function rememberBreakdown() {
  reopen = null;
  const popover = document.querySelector(".roll-breakdown:popover-open");
  const scope = popover?.closest(".card-summary[data-message-id], .message[data-message-id]");
  if ( !scope ) return;
  const index = breakdownsOf(scope, scope.matches(".card-summary") ? scope : null).indexOf(popover);
  reopen = { id: scope.dataset.messageId, index, notifications: !!popover.closest("#chat-notifications") };
}

/** Forget the remembered breakdown, when nothing changed: no redraw is coming. */
function forgetBreakdown() {
  reopen = null;
  return null;
}

/** Show the remembered breakdown again on its redrawn card, on every redraw until the user closes it. */
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
    // Closed by the user, not by a redraw (which removes it): no longer shown again.
    popover.addEventListener("toggle", event => {
      if ( (event.newState === "closed") && popover.isConnected && (reopen === pending) ) reopen = null;
    });
  });
}

/**
 * Mark a roll's button: changed by the last switch or reroll (`data-steady-rolls-changed`), with
 * its new d20 results (`data-steady-rolls-new`), for masking. A roll with more than one d20 shows them
 * all, in roll order, without the results replaced by rerolls.
 */
function markRoll(button, roll) {
  const added = roll?.options?.[MODULE_ID]?.fresh;
  if ( added ) button.dataset.steadyRollsChanged = "";
  const d20 = roll?.validD20Roll ? roll.d20 : null;
  const element = button.querySelector(".d20die");
  if ( !d20 || !element ) return;
  const key = keyed(diceOf(roll) ?? []).find(k => k.die === d20)?.key;
  const isNew = index => !!added?.[key]?.includes(index);
  const shown = d20.results.map((result, index) => ({ result, index }))
    .filter(({ result }) => result.active || result.discarded);
  if ( shown.length < 2 ) {
    if ( shown.length && isNew(shown[0].index) ) element.dataset.steadyRollsNew = "";
    return;
  }
  element.classList.add("steady-rolls-d20s");
  element.replaceChildren(...shown.map(({ result, index }) => {
    const span = document.createElement("span");
    span.className = `steady-rolls-d20${result.active ? "" : " dropped"}`;
    if ( isNew(index) ) span.dataset.steadyRollsNew = "";
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
  bar.className = "steady-rolls-bar";
  button.replaceWith(bar);
  before?.classList.add("before");
  after?.classList.add("after");
  bar.append(...[before, button, after].filter(Boolean));
}

/** A toggle icon: gold when on, greyed out when off. */
function modeButton(icon, label, pressed, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "steady-rolls-mode";
  button.ariaLabel = game.i18n.localize(label);
  button.ariaPressed = String(pressed);
  button.dataset.tooltip = "";
  button.innerHTML = `<i class="fa-solid ${icon}" inert></i>`;
  // Without an action (dice rolling, or kept as rolled): shown with its tooltip, but inert (aria-disabled,
  // which keeps the tooltip).
  if ( !onClick ) {
    button.ariaDisabled = "true";
    button.addEventListener("click", event => event.stopPropagation());
    return button;
  }
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

/**
 * Replace one roll of a message by `build(old)`: { roll, dice }, or null to keep it. An attack's
 * damage follows its new critical, and the new dice of both are thrown at once.
 * @param {ChatMessage5e} message
 * @param {number} index
 * @param {"advantage"|"reroll"|"undo"} cause  For other modules (rebuild.mjs changeRolls).
 * @param {(old: Roll) => Promise<{ roll: Roll, dice: Die[] }|null>} build
 * @param {(rolls: Roll[]) => object} [changes]  Other changes to save with the new rolls.
 * @returns {Promise<{ old: Roll, roll: Roll }|null>}
 */
export async function replaceRoll(message, index, cause, build, changes = () => ({})) {
  let old;
  let roll;
  const saved = await changeRolls(message, cause, async current => {
    old = current[index];
    const built = old ? await build(old) : null;
    if ( !built ) return null;
    roll = built.roll;
    const rolls = current.with(index, roll);
    return { rolls, dice: built.dice, ...changes(rolls) };
  });
  if ( !saved ) return forgetBreakdown();
  throwAll([saved, ...await followCritical(message, old, roll, saved.masked)]);
  return { old, roll };
}

/**
 * Switch one d20 roll to advantage, disadvantage or normal. While its first die still rolls, the
 * new roll is masked whole: its kept die is not known before both land.
 */
function setAdvantage(message, index, mode) {
  const whole = isRolling(message);
  return replaceRoll(message, index, "advantage", async old => {
    const roll = buildD20(old, mode);
    const dice = await evaluateWith([old], [roll]);
    if ( whole ) delete roll.options[MODULE_ID].fresh;
    return { roll, dice };
  }, rolls => ({ flavor: advantageFlavor(message.flavor, rolls), mask: whole }));
}

/**
 * When an attack roll changes its critical, switch its damage to match: only damage still
 * matching the attack's old critical, so a damage switched by hand stays. While the attack's
 * dice roll (`masked`), the damage is masked whole: its change would tell the crit.
 * @returns {Promise<object[]>}  The saved damage, for throwAll.
 */
async function followCritical(message, old, roll, masked) {
  if ( (message.type !== "attack") || (old.isCritical === roll.isCritical) ) return [];
  const usage = message.system.origin;
  const damage = (usage?.getAssociatedRolls?.("damage") ?? []).filter(m => switchesCritical(m) && canChange(m)
    && (m.getFlag(MODULE_ID, "attack") === message.id) && (m.rolls[0].isCritical === old.isCritical));
  const thrown = [];
  for ( const m of damage ) thrown.push(await switchCritical(m, roll.isCritical, { whole: masked }));
  return thrown.filter(Boolean);
}

/** Switch all damage rolls of a message to critical or normal. */
async function setCritical(message, isCritical) {
  const saved = await switchCritical(message, isCritical);
  if ( saved ) throwAll([saved]);
  else forgetBreakdown();
}

/**
 * @param {object} [options]
 * @param {boolean} [options.whole]  Mask the whole damage until the dice land, not only its new dice.
 */
function switchCritical(message, isCritical, { whole = false } = {}) {
  return changeRolls(message, "critical", async current => {
    const rolls = current.map(old => buildDamage(old, isCritical));
    const dice = await evaluateWith(current, rolls);
    if ( whole ) rolls.forEach(roll => delete roll.options[MODULE_ID].fresh);
    return { rolls, dice, mask: whole };
  });
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
