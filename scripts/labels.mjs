/**
 * Names the parts of an attack breakdown, as term flavor (`@mod[CHA]`), which dnd5e's
 * breakdown already shows. The merged effect bonus (`@ruleBonus`) is split per effect only
 * when the pieces rebuild dnd5e's formula, so the total never changes. Damage is left alone:
 * there, flavor is the damage type.
 */
const PLAIN_NUMBER = /^\s*[+-]?\d+\s*$/;
const SINGLE_TERM = /^\s*[+-]?[\w@.]+\s*$/;

const localize = key => game.i18n.localize(key);
const normalize = formula => String(formula ?? "").replace(/\s+/g, " ").trim();
const clean = label => String(label ?? "").replace(/[[\]]/g, "").trim();

/** Whether pieces add up to a formula: the same terms, in any order. */
function sameSum(pieces, formula) {
  const terms = f => normalize(f).split(" + ").sort().join("|");
  return terms(pieces.map(p => p.formula).join(" + ")) === terms(formula);
}

/** Label for a named part that resolves to a plain number. */
const LABELS = {
  mod: ({ ability }) => CONFIG.DND5E.abilities[ability]?.abbreviation?.toUpperCase(),
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

/** A labelled part; a formula is wrapped so the label covers all of it. */
function labelled(formula, label) {
  return SINGLE_TERM.test(formula) ? `${formula.trim()}[${label}]` : `(${formula})[${label}]`;
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

  config.parts = config.parts.flatMap(part => {
    const key = /^@(\w+)$/.exec(part)?.[1];
    if ( !key ) return [part];
    const value = foundry.utils.getProperty(data, key);

    if ( (key === "ruleBonus") && actor && activity ) {
      const pieces = splitRuleBonus(activity, actor, ability, attackMode, data, value);
      if ( pieces?.length ) return pieces.map(p => labelled(p.formula, clean(p.label)));
      const bonus = localize("DND5E.Bonus");
      return [PLAIN_NUMBER.test(String(value)) ? `${part}[${bonus}]` : `(${part})[${bonus}]`];
    }

    // Other parts: only plain numbers (on a formula, the label would go on its last term).
    if ( !PLAIN_NUMBER.test(String(value)) ) return [part];
    const label = clean(LABELS[key]?.({ activity, ability, ammunition }));
    return [label ? `${part}[${label}]` : part];
  });
}
