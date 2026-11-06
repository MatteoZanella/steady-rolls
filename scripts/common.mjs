/** Names and checks shared by the module's scripts. */
export const MODULE_ID = "steady-rolls";
export const TEMPLATES = `modules/${MODULE_ID}/templates`;

/** Message types of a damage roll. */
export const DAMAGE_TYPES = new Set(["damage", "healing"]);

/** Whether a message is a usage card, which shows its rolls as summaries. */
export function isUsage(message) {
  return !!message?.system?.rendersSummaries;
}

/** Whether an activity has damage to roll: the condition of AttackActivity's Damage button. */
export function hasDamage(activity) {
  return !!activity?.damage?.parts?.length || !!activity?.item?.system.properties?.has("amm");
}

/** Whether a card is a save activity's usage card, not one of its saves or damage rolls. */
export function isSaveCard(card) {
  return isUsage(card) && (card.getAssociatedActivity?.()?.type === "save");
}

/** The key of the token, or actor, that rolled a save: the token's uuid, or the actor's without one. */
export function rollerOf(save) {
  return save.getAssociatedToken()?.uuid ?? save.getAssociatedActor()?.uuid;
}

/** Keys of the tokens or actors that rolled a card's save. */
export function rolledOn(card) {
  return new Set(card.getAssociatedRolls("save").map(rollerOf));
}

/** Name a subclass after its base, for readable stacks and class names. */
export function named(Subclass, Base) {
  const name = Base.name.startsWith("SteadyRolls") ? Base.name : `SteadyRolls${Base.name}`;
  Object.defineProperty(Subclass, "name", { value: name });
  return Subclass;
}

/** Update options of the module's changes to a message's targets (see onTargetsUpdate). */
export const TARGETS_UPDATE = { [MODULE_ID]: { targets: true } };

/**
 * updateChatMessage, on every client: dnd5e sets a message's target lists to Selected for the
 * session when it has no targets as it is drawn. Once the module gives it targets (a template, a
 * save, a target followed), it goes back to dnd5e's default, Targeted. Runs before the redraw.
 */
export function onTargetsUpdate(message, changes, options) {
  if ( !options?.[MODULE_ID]?.targets || (message._targetState?.mode !== "selected") ) return;
  message._targetState.mode = "";
}
