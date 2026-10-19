/**
 * Dice So Nice: cards stay visible while the dice roll, with results masked until they land.
 * Public API only: the rolling client marks the roll `rolling`; every client tells Dice So
 * Nice to skip marked rolls (`diceSoNiceMessagePreProcess`); the rolling client plays the
 * dice everywhere (`animateRoll`), then clears the mark, which re-renders the cards.
 * "Always" automatic damage is thrown together with its attack.
 */
import { DAMAGE_TYPES, MODULE_ID, hasDamage, isUsage } from "./common.mjs";
import { fastForward } from "./settings.mjs";

/** Marks older than this are ignored, in case the rolling client left mid-roll. */
const MAX_AGE = 30_000;

/** Animations playing on this client, by message id. */
const playing = new Map();

/** Whether Dice So Nice holds back roll results on this client. */
function diceSoNiceHides() {
  return !!game.dice3d && !game.settings.get("dice-so-nice", "immediatelyDisplayChatMessages");
}

/** Whether a roll's result is still masked. */
export function isRolling(message) {
  return !!message?.getFlag(MODULE_ID, "rolling") && ((Date.now() - message.timestamp) < MAX_AGE);
}

/** preCreateChatMessage: mark the roll, and drop the dice sound as Dice So Nice does. */
export function markRolling(message) {
  if ( !diceSoNiceHides() || !isUsage(message.system?.origin) ) return;
  if ( (message.type !== "attack") && !DAMAGE_TYPES.has(message.type) ) return;
  if ( !message.rolls.some(roll => roll.dice.length) ) return;
  message.updateSource({ [`flags.${MODULE_ID}.rolling`]: true, sound: null });
}

/** diceSoNiceMessagePreProcess: Steady Strike plays the dice of marked rolls. */
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

/** One throw for several messages, then reveal them together. */
function throwDice(messages) {
  const dice = messages.flatMap(m => m.rolls.flatMap(roll => roll.dice));
  const animation = game.dice3d.animateRoll({ dice }, messages[0])
    .catch(err => console.error(`${MODULE_ID} | Dice So Nice animation failed`, err))
    .then(() => Promise.all(messages.filter(m => game.messages.has(m.id))
      .map(m => m.unsetFlag(MODULE_ID, "rolling"))))
    .finally(() => messages.forEach(m => playing.delete(m.id)));
  for ( const m of messages ) playing.set(m.id, animation);
}

/** Resolves when this client's animation of a message ends (at once if none). */
export function diceLanded(message) {
  return playing.get(message?.id) ?? Promise.resolve();
}
