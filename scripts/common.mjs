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

/** Name a subclass after its base, for readable stacks and class names. */
export function named(Subclass, Base) {
  Object.defineProperty(Subclass, "name", { value: `SteadyRolls${Base.name}` });
  return Subclass;
}
