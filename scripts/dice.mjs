/**
 * Dice So Nice: cards stay visible while the dice roll, with results masked until they land.
 * Public API only: the rolling client marks the roll `rolling`; every client tells Dice So
 * Nice to skip marked rolls (`diceSoNiceMessagePreProcess`); the rolling client plays the
 * dice everywhere (`animateRoll`), then clears the mark, which re-renders the cards.
 * "Always" automatic damage is thrown together with its attack.
 */
import { MODULE_ID, hasDamage } from "./common.mjs";
import { fastForward } from "./settings.mjs";

/** Rolls masked while their dice roll. Recharges are left out: their flavor tells the result. */
const MASKED_TYPES = new Set(["attack", "check", "save", "damage", "healing", "generic", "hitDie", "hitPoints"]);

/** Marks older than this are ignored, in case the rolling client left mid-roll. */
const MAX_AGE = 30_000;

/** Animations playing on this client, by message id. */
const playing = new Map();

/** Whether Dice So Nice holds back roll results on this client. */
export function diceSoNiceHides() {
  return !!game.dice3d && !game.settings.get("dice-so-nice", "immediatelyDisplayChatMessages");
}

/** Whether a roll's result is still masked. The mark is the server time it was set. */
export function isRolling(message) {
  const since = message?.getFlag(MODULE_ID, "rolling");
  return Number.isFinite(since) && ((game.time.serverTime - since) < MAX_AGE);
}

/** preCreateChatMessage: mark the roll, and drop the dice sound as Dice So Nice does. */
export function markRolling(message) {
  if ( !diceSoNiceHides() || !MASKED_TYPES.has(message.type) ) return;
  if ( !message.rolls.some(roll => roll.dice.length) ) return;
  message.updateSource({ [`flags.${MODULE_ID}.rolling`]: game.time.serverTime, sound: null });
}

/**
 * dnd5e.renderChatMessage: hide a message's results while its dice roll, inside `root` (its card,
 * or its summary in another card: `own`), leaving those of other rolls folded into it. After a
 * switch or a reroll (modes.mjs, rerolls.mjs), only the changed rolls are masked, and of their
 * dice only the new ones roll, in the bar and in the breakdown, which stays; otherwise every
 * roll and die is, and the breakdown is removed.
 */
export function maskRolling(message, root, own = null) {
  if ( !isRolling(message) ) return;
  const mine = selector => [...root.querySelectorAll(selector)].filter(el => el.closest(".card-summary") === own);
  const buttons = mine("button.dice-roll");
  const changed = buttons.filter(b => b.matches("[data-steady-rolls-changed]"));
  for ( const button of changed.length ? changed : buttons ) {
    button.classList.remove("success", "failure", "critical", "fumble");
    button.classList.add("steady-rolls-rolling");
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.querySelector(".icons")?.replaceChildren();
    const d20 = button.querySelector(".d20die");
    if ( d20 ) {
      const dice = d20.matches(".steady-rolls-d20s") ? [...d20.children] : [d20];
      dice.forEach(d => d.classList.remove("dropped")); // Which die is kept is not known yet.
      const rolling = changed.length ? dice.filter(d => d.matches("[data-steady-rolls-new]")) : dice;
      rolling.forEach(d => d.classList.add("steady-rolls-tumbling"));
    }
    const total = button.querySelector(".total");
    if ( total ) total.innerHTML = `<i class="fa-solid ${d20 ? "fa-dice-d20" : "fa-dice-d6"}" inert></i>\u200b`;
  }
  for ( const pill of mine("target-pill") ) {
    pill.removeAttribute("data-hit");
    pill.removeAttribute("data-miss");
  }
  // In the breakdown, a new die tumbles without its number, and so does its part's total.
  for ( const part of changed.length ? mine(".roll-breakdown [data-steady-rolls-new].tooltip-part") : [] ) {
    part.querySelectorAll("li.roll").forEach(li => li.classList.remove("discarded"));
    part.querySelectorAll("li.roll[data-steady-rolls-new]").forEach(li => {
      li.classList.remove("min", "max"); // Their colours tell the result.
      li.classList.add("steady-rolls-tumbling");
      li.textContent = "\u00a0";
    });
    const value = part.querySelector(".total .value");
    if ( value ) value.innerHTML = '<i class="fa-regular fa-dice-d20 steady-rolls-spinner" inert></i>';
  }
  // Breakdowns, applied damage and outcomes (death saves, resisted, recovered hit points).
  const outcomes = [...(changed.length ? [] : [".roll-breakdown"]), "damage-application", ".deltas"];
  if ( message.type === "save" ) outcomes.push(".supplement");
  mine(outcomes.join(", ")).forEach(el => el.remove());
}

/** diceSoNiceMessagePreProcess: Steady Rolls plays the dice of marked rolls. */
export function onDiceSoNicePreProcess(messageId, interception) {
  if ( isRolling(game.messages.get(messageId)) ) interception.willTrigger3DRoll = false;
}

/** Attacks waiting to be thrown with their automatic damage, by id. */
const waiting = new Map();

/**
 * Whether this attack's dice wait for its automatic damage ("always"): only when the damage
 * has no dialog. With a dialog, the attack is thrown at once and the damage after the dialog.
 */
function joinsDamage(message) {
  return (message.type === "attack") && (game.settings.get(MODULE_ID, "autoDamage") === "always")
    && fastForward("damage") && !message.getFlag(MODULE_ID, "dialog")
    && hasDamage(message.getAssociatedActivity());
}

/** createChatMessage: the rolling client throws the dice; an attack waits for its automatic damage. */
export function playDice(message) {
  if ( !message.isAuthor || !isRolling(message) || !game.dice3d ) return;
  if ( joinsDamage(message) ) {
    waiting.set(message.id, message);
    return;
  }
  const attack = waiting.get(message.getFlag(MODULE_ID, "attack"));
  if ( attack ) waiting.delete(attack.id);
  throwDice(attack ? [attack, message] : [message]);
}

/** Throw a waiting attack alone, if its damage was not rolled (e.g. a cancelled dialog). */
export function releaseDice(attack) {
  if ( waiting.delete(attack?.id) ) throwDice([attack]);
}

/** One throw for several messages (all their dice, unless given), then reveal them together. */
export function throwDice(messages, dice = messages.flatMap(m => m.rolls.flatMap(roll => roll.dice))) {
  const animation = game.dice3d.animateRoll({ dice }, messages[0])
    .catch(err => console.error(`${MODULE_ID} | Dice So Nice animation failed`, err))
    .then(() => Promise.all(messages.filter(m => game.messages.has(m.id) && m.getFlag(MODULE_ID, "rolling"))
      .map(m => m.unsetFlag(MODULE_ID, "rolling"))))
    .finally(() => messages.forEach(m => playing.delete(m.id)));
  for ( const m of messages ) playing.set(m.id, animation);
}

/** Resolves when this client's animation of a message ends (at once if none). */
export function diceLanded(message) {
  return playing.get(message?.id) ?? Promise.resolve();
}
