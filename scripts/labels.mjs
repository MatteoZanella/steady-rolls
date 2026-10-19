/**
 * Names the parts of an attack breakdown. Labels are kept in the roll's options and written
 * into the breakdown when it renders, so the formula itself stays untouched (no `[flavor]`
 * in dialogs or for other modules). The merged effect bonus (`@ruleBonus`) is split per
 * effect only when the pieces rebuild dnd5e's formula, so the total never changes.
 */
import { MODULE_ID } from "./common.mjs";

const PLAIN_NUMBER = /^\s*[+-]?\d+\s*$/;
const SINGLE_TERM = /^\s*[+-]?[\w@.]+\s*$/;

const localize = key => game.i18n.localize(key);
const normalize = formula => String(formula ?? "").replace(/\s+/g, " ").trim();

/** Whether pieces add up to a formula: the same terms, in any order. */
function sameSum(pieces, formula) {
  const terms = f => normalize(f).split(" + ").sort().join("|");
  return terms(pieces.map(p => p.formula).join(" + ")) === terms(formula);
}

/** Label for a named part that resolves to a plain number. */
const LABELS = {
  mod: ({ ability }) => CONFIG.DND5E.abilities[ability]?.label,
  prof: () => localize("DND5E.Proficiency"),
  bonus: ({ activity }) => activity?.item?.name ?? localize("DND5E.Bonus"),
  weaponMagic: ({ activity }) => activity?.item?.name ?? localize("DND5E.MagicalBonus"),
  ammoMagic: ({ ammunition }) => ammunition?.name ?? localize("DND5E.ITEM.Property.Ammunition")
};

/** The actor fields an attack takes bonuses from (AttackActivity#getAttackData). */
function bonusFields(activity, ability, attackMode) {
  return [
    `abilities.${ability}.attack.roll`, "rolls.attack", `rolls.attack.${activity.getActionType(attackMode)}`
  ];
}

/**
 * An actor bonus field split into the sheet's value and each effect's addition.
 * @returns {{ formula: string, label: string }[]}
 */
function splitField(actor, path) {
  const value = foundry.utils.getProperty(actor.system, `${path}.bonus`);
  if ( !value ) return [];
  const key = `system.${path}.bonus`;
  const pieces = [];
  const base = foundry.utils.getProperty(actor._source.system, `${path}.bonus`);
  if ( base ) pieces.push({ formula: String(base), label: localize("DND5E.Bonus") });
  for ( const effect of actor.appliedEffects ?? [] ) {
    for ( let change of effect.system?.changes ?? effect.changes ?? [] ) {
      // Old keys (system.bonuses.rsak.attack) apply to the new fields.
      change = effect._applyChangeShim?.(change) ?? change;
      if ( (change.key === key) && ((change.type ?? "add") === "add") && change.value ) {
        pieces.push({ formula: String(change.value), label: effect.name });
      }
    }
  }
  return sameSum(pieces, value) ? pieces : [{ formula: String(value), label: localize("DND5E.Bonus") }];
}

/** The effect bonus split per source, or null if the pieces do not rebuild dnd5e's formula. */
function splitRuleBonus(activity, actor, ability, attackMode, rollData, formula) {
  const Rules = actor.appliedRules?.constructor;
  if ( typeof Rules?.collect !== "function" ) return null;
  const rules = Rules.collect("attack:bonus", actor, activity.item).filterWith(rollData).toArray()
    .filter(r => (r.value !== "") && (r.value != null))
    .map(r => ({ formula: String(r.value), label: r.effect?.name ?? localize("DND5E.Bonus") }));
  const fields = bonusFields(activity, ability, attackMode).flatMap(path => splitField(actor, path));
  const pieces = [...rules, ...fields];
  return sameSum(pieces, formula) ? pieces : null;
}

/** A part as one term, so each part maps to one term of the roll. */
function oneTerm(formula) {
  return SINGLE_TERM.test(formula) ? formula.trim() : `(${formula})`;
}

/** dnd5e.postBuildAttackRollConfig: each time the attack's parts are built. */
export function onPostBuildAttack(process, config) {
  if ( !Array.isArray(config.parts) ) return;
  const activity = process.subject;
  const actor = activity?.actor;
  const ability = config.options?.ability ?? process.ability;
  const attackMode = config.options?.attackMode ?? process.attackMode;
  const ammunition = actor?.items.get(config.options?.ammunition ?? process.ammunition);
  const data = config.data ?? {};

  const parts = [];
  const labels = [];
  for ( const part of config.parts ) {
    const key = /^@(\w+)$/.exec(part)?.[1];
    const value = key ? foundry.utils.getProperty(data, key) : part;
    const pieces = ((key === "ruleBonus") && actor && activity)
      ? splitRuleBonus(activity, actor, ability, attackMode, data, value) : null;
    if ( pieces?.length ) {
      for ( const p of pieces ) {
        parts.push(oneTerm(p.formula));
        labels.push(p.label);
      }
      continue;
    }
    parts.push(SINGLE_TERM.test(String(value)) ? part : `(${part})`);
    // Only plain numbers get a label: a formula's terms do not map to one name.
    const plain = PLAIN_NUMBER.test(String(value));
    labels.push(!plain ? null : (key === "ruleBonus") ? localize("DND5E.Bonus")
      : (LABELS[key]?.({ activity, ability, ammunition }) ?? null));
  }
  config.parts = parts;
  foundry.utils.setProperty(config, `options.${MODULE_ID}.labels`, labels);
}

/**
 * Write a roll's labels into its breakdown: dice rows and constant rows, in roll order.
 * Skipped when the roll's terms do not match the labels (e.g. a formula split into more terms).
 * @param {ChatMessage5e} message
 * @param {HTMLElement} element  The message's card or its summary.
 */
export function labelBreakdowns(message, element) {
  const { NumericTerm, OperatorTerm } = foundry.dice.terms;
  // Only this message's breakdowns, not those of rolls folded into it.
  const own = element.matches?.(".card-summary") ? element : null;
  const popovers = [...element.querySelectorAll(".roll-breakdown")]
    .filter(p => p.closest(".card-summary") === own);
  message.rolls.forEach((roll, i) => {
    const labels = roll.options?.[MODULE_ID]?.labels;
    const popover = popovers[i];
    if ( !labels?.length || !popover ) return;
    const terms = roll.terms.filter(t => !(t instanceof OperatorTerm));
    if ( terms.length !== labels.length + 1 ) return; // The d20, then one term per part.
    const labelOf = new Map(terms.slice(1).map((t, k) => [t, labels[k]]));
    const write = (el, label) => { if ( el && label ) el.textContent = label; };
    const diceRows = popover.querySelectorAll(".tooltip-part:not(.constant-term)");
    roll.dice.forEach((die, k) => write(diceRows[k]?.querySelector(".total .label"), labelOf.get(die)));
    const constants = terms.filter(t => (t instanceof NumericTerm) && t.total);
    const constantRows = popover.querySelectorAll(".constant-term");
    if ( constantRows.length !== constants.length ) return;
    constants.forEach((t, k) => write(constantRows[k].querySelector(".flavor"), labelOf.get(t)));
  });
}
