/**
 * Following targets: changing your targets on the canvas changes the targets of the newest card
 * you made with targets, until you make another. A card's targeting is shared by the messages
 * that make it up: the usage card (or a strike card), its attack, and the damage rolled for it.
 * - attacks: their hit or miss is recomputed against the new targets;
 * - save cards: their damage follows the card's targets (saves.mjs, onSaveCardTargets);
 * - checks have no targets to follow.
 * Once damage was applied from a card, it is done: untargeting removes no one, and a token
 * targeted is added for now. On a save card, untargeting never removes a token that saved: its
 * save is on the card, and its damage is still to apply. When you make another card, those added for now leave it, unless
 * they took damage from it (or saved, on a save card): targeting for your next action doesn't stay
 * on the last one. Added for now: `flags.steady-rolls.provisional`, token uuids.
 * Changes made while placing a template are the template's (targets.mjs).
 */
import { DAMAGE_TYPES, MODULE_ID, TARGETS_UPDATE, isSaveCard, isUsage, rolledOn } from "./common.mjs";
import { appliedOn } from "./applied.mjs";
import { isStrikeCard } from "./strikes.mjs";
import { isTemplating } from "./targets.mjs";

/** Target changes not yet written: token document → targeted. */
let changes = new Map();

/** Whether a message is a card that targets: a usage card (not a check's) or a strike card. */
function isTargetingCard(message) {
  if ( isStrikeCard(message) ) return true;
  return isUsage(message) && !!message.system.targets && (message.getAssociatedActivity()?.type !== "check");
}

/** The newest card this user made with targets. */
export function newestCard() {
  const messages = game.messages.contents;
  for ( let i = messages.length - 1; i >= 0; i-- ) {
    if ( messages[i].isAuthor && isTargetingCard(messages[i]) ) return messages[i];
  }
  return null;
}

/** The messages that share a card's targeting. */
export function sharing(card) {
  if ( isStrikeCard(card) ) {
    const usage = card.system.origin;
    return [card, ...damageOf(usage).filter(d => d.getFlag(MODULE_ID, "attack") === card.id)];
  }
  const attack = card.getAssociatedRolls("attack").find(a => !isStrikeCard(a));
  const damage = damageOf(card).filter(d => {
    const of = d.getFlag(MODULE_ID, "attack");
    return !of || (of === attack?.id);
  });
  return [card, ...(attack ? [attack] : []), ...damage];
}

/** The damage and healing rolled from a usage card. */
function damageOf(usage) {
  return [...DAMAGE_TYPES].flatMap(type => usage?.getAssociatedRolls(type) ?? []);
}

/** Whether a card's targeting is done: damage was applied from it. */
function isDone(group) {
  return group.some(m => appliedOn(m).length);
}

/** Whether a token took part in a card: took damage from it, or saved on a save card. */
function involvedIn(group, card) {
  const applied = new Set(group.flatMap(m => appliedOn(m).map(e => e.target)));
  const saved = isSaveCard(card) ? rolledOn(card) : new Set();
  return uuid => {
    const token = fromUuidSync(uuid, { strict: false });
    return applied.has(uuid) || saved.has(uuid) || (!!token?.actorLink && applied.has(token.actor?.uuid));
  };
}

/**
 * A message's targets after the changes, and those added for now: see the module's doc.
 * @param {Set<string>} [kept]  Tokens untargeting doesn't remove: those that saved on a save card.
 */
export function changedTargets(message, batch, done, kept = new Set()) {
  const { TargetsField } = dnd5e.dataModels.chatMessage.fields;
  let targets = message.system.targets;
  let provisional = message.getFlag(MODULE_ID, "provisional") ?? [];
  for ( const [token, targeted] of batch ) {
    const present = targets.some(t => t.token === token.uuid);
    if ( targeted && !present ) {
      targets = [...targets, ...TargetsField.getDescriptors([token])];
      if ( done ) provisional = [...provisional, token.uuid];
    }
    else if ( !targeted && present && !kept.has(token.uuid) && (!done || provisional.includes(token.uuid)) ) {
      targets = targets.filter(t => t.token !== token.uuid);
      provisional = provisional.filter(uuid => uuid !== token.uuid);
    }
  }
  return { targets, provisional };
}

/** The changes a message needs, if any, with the update options that mark them as targets. */
async function write(message, { targets, provisional }) {
  const was = message.getFlag(MODULE_ID, "provisional") ?? [];
  if ( (targets === message.system.targets) && (provisional.join() === was.join()) ) return;
  await message.update({ "system.targets": targets, [`flags.${MODULE_ID}.provisional`]: provisional }, TARGETS_UPDATE);
}

/** The messages of a card whose targets follow: on a save card, not its damage, which takes the card's. */
function following(card) {
  return sharing(card).filter(m => !(isSaveCard(card) && DAMAGE_TYPES.has(m.type))
    && m.canUserModify(game.user, "update"));
}

/** Write the pending changes to the newest card's messages. */
async function flush() {
  const batch = changes;
  changes = new Map();
  const card = newestCard();
  if ( !card ) return;
  const done = isDone(sharing(card));
  const kept = isSaveCard(card) ? rolledOn(card) : new Set();
  for ( const message of following(card) ) await write(message, changedTargets(message, batch, done, kept));
}

/**
 * createChatMessage: a new card of yours with targets; on the card before it, those added for now
 * leave unless they took part.
 */
export async function onCreateCard(message) {
  if ( !message.isAuthor || !isTargetingCard(message) ) return;
  const messages = game.messages.contents;
  const at = messages.indexOf(message);
  const previous = messages.slice(0, at).findLast(m => m.isAuthor && isTargetingCard(m));
  if ( !previous ) return;
  const group = sharing(previous);
  const involved = involvedIn(group, previous);
  for ( const m of following(previous) ) {
    const provisional = m.getFlag(MODULE_ID, "provisional") ?? [];
    if ( !provisional.length ) continue;
    const leaving = provisional.filter(uuid => !involved(uuid));
    await write(m, { targets: m.system.targets.filter(t => !leaving.includes(t.token)), provisional: [] });
  }
}

let timer = null;

/** targetToken: your target changes, gathered for a moment and written together. */
export function onTargetToken(user, token, targeted) {
  if ( !user.isSelf || isTemplating() || !game.settings.get(MODULE_ID, "followTargets") ) return;
  changes.set(token.document, targeted);
  clearTimeout(timer);
  timer = setTimeout(() => flush().catch(err => console.error(`${MODULE_ID} | Could not follow the targets`, err)), 100);
}
