/**
 * One card per attack. Every roll keeps the usage card as its origin, as in dnd5e; only
 * where rolls are shown changes:
 * - the usage card shows the first attack and its damage; each later attack gets its own
 *   "strike card" with its damage;
 * - the Attack and Damage buttons sit below the rolls and disappear once used.
 * Flags set at creation: `strike` (number) on attacks, `attack` (id of its attack) on damage.
 * dnd5e has no damage-to-attack link: its Damage button uses the latest attack.
 */
import { DAMAGE_TYPES, MODULE_ID, TEMPLATES, hasDamage, isUsage, named } from "./common.mjs";
import { diceLanded, releaseDice } from "./dice.mjs";

const STRIKE_TEMPLATE = `${TEMPLATES}/strike-card.hbs`;
const USAGE_TEMPLATE = `${TEMPLATES}/usage-card.hbs`;
/** Buttons rolled once per card, by the message type of their roll: hidden once rolled. */
const ONE_SHOT = { rollDamage: "damage", rollHealing: "healing" };
/** Card action for a damage roll that belongs to the card's attack. */
const DAMAGE_ACTION = "steadyStrikeDamage";

function summariesOn() {
  return game.settings.get("dnd5e", "chatCardSummary");
}

/** Number of an attack on its usage card. */
function strikeNumber(attack) {
  return attack.getFlag(MODULE_ID, "strike") ?? 1;
}

/** Number of the latest attack on a usage card, 0 before any. */
function latestStrike(usage) {
  return usage.getAssociatedRolls("attack").reduce((n, a) => Math.max(n, strikeNumber(a)), 0);
}

/** Whether an attack has its own card: any attack after the first. */
function isStrikeCard(message) {
  return summariesOn() && (message?.type === "attack") && isUsage(message.system?.origin)
    && (strikeNumber(message) > 1);
}

/** The card that shows a roll: its usage card or its strike card. Null if not folded. */
export function hostOf(message) {
  const usage = message.system?.origin;
  if ( !isUsage(usage) || isStrikeCard(message) ) return null;
  if ( DAMAGE_TYPES.has(message.type) ) {
    const attack = game.messages.get(message.getFlag(MODULE_ID, "attack"));
    if ( isStrikeCard(attack) && (attack.system.origin?.id === usage.id) ) return attack;
  }
  return usage;
}

/** The usage card of a card: itself, or a strike card's origin. */
function usageOf(host) {
  return isUsage(host) ? host : host.system.origin;
}

/** Rolls shown inside a card, in the order they were made. */
function rollsOf(host) {
  return usageOf(host).getAssociatedRolls().filter(m => hostOf(m)?.id === host.id);
}

/** The attack a card is about: a strike card's own, or the usage card's first. */
function attackOf(host) {
  if ( !isUsage(host) ) return host;
  return host.getAssociatedRolls("attack").find(a => !isStrikeCard(a)) ?? null;
}

/** Which of the card's actions are still open. */
function openActions(host) {
  const number = isUsage(host) ? 1 : strikeNumber(host);
  return {
    // Only the newest card offers the next attack.
    attack: number >= latestStrike(usageOf(host)),
    damage: !rollsOf(host).some(m => DAMAGE_TYPES.has(m.type))
  };
}

/** Number the attack, or link the damage to the latest attack, as the message is created. */
export function onPreCreateMessage(message) {
  const usage = message.system?.origin;
  if ( !isUsage(usage) ) return;
  if ( (message.type === "attack") && (message.getFlag(MODULE_ID, "strike") === undefined) ) {
    message.updateSource({ [`flags.${MODULE_ID}.strike`]: latestStrike(usage) + 1 });
  }
  else if ( DAMAGE_TYPES.has(message.type) && !message.getFlag(MODULE_ID, "attack") ) {
    const latest = usage.getAssociatedRolls("attack").at(-1);
    if ( latest ) message.updateSource({ [`flags.${MODULE_ID}.attack`]: latest.id });
  }
}

/**
 * On message create, update and delete: re-render the cards affected. dnd5e refreshes only
 * the usage card; strike card buttons depend on the other attacks.
 */
export function refreshCards(message, changes) {
  // Roll switched, or dice landed: re-render the card showing the roll.
  changes ??= {};
  const landed = foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`) && !message.getFlag(MODULE_ID, "rolling");
  if ( landed || ("rolls" in changes) ) {
    const host = hostOf(message) ?? message;
    if ( game.messages.has(host.id) ) ui.chat?.updateMessage(host);
  }
  const usage = message.system?.origin;
  if ( !isUsage(usage) || !game.messages.has(usage.id) ) return;
  for ( const attack of usage.getAssociatedRolls("attack") ) {
    if ( isStrikeCard(attack) && (attack.id !== message.id) ) ui.chat?.updateMessage(attack);
  }
}

/**
 * Roll damage for one attack, with its crit, ammunition and mode. Consumed resources and
 * scaling come from the usage card, as in Activity#onChatAction.
 * @param {ChatMessage5e} usage
 * @param {ChatMessage5e|null} attack
 * @param {PointerEvent} [event]         The button click, if any.
 * @param {object} [options]
 * @param {boolean} [options.configure]  Show the dialog regardless of fast-forward.
 */
async function rollStrikeDamage(usage, attack, event, { configure } = {}) {
  const base = usage.getAssociatedActivity();
  if ( !base ) return;
  const consumed = base.createConsumedFlag(usage.getAssociatedActor(), usage.system.deltas);
  const scaling = usage.system.scaling ?? 0;
  const item = (consumed || scaling)
    ? base.item.clone({ "flags.dnd5e": { consumed, scaling } }, { keepId: true })
    : base.item;
  const activity = item.system.activities.get(base.id);
  const { ability, ammunitionItem: ammunition, mode: attackMode } = attack?.system ?? {};
  const isCritical = attack?.rolls[0]?.isCritical;
  const dialog = isCritical ? { options: { defaultButton: "critical" } } : {};
  if ( configure ) dialog.configure = true;
  const message = { data: { system: { origin: usage.id } } };
  if ( attack ) foundry.utils.setProperty(message.data, `flags.${MODULE_ID}.attack`, attack.id);
  return activity.rollDamage({ event, ability, ammunition, attackMode, isCritical }, dialog, message);
}

/** Card action: roll the damage of the attack shown on the clicked card. */
async function onDamageAction(event, target) {
  const host = game.messages.get(target.closest("[data-steady-strike-host]")?.dataset.steadyStrikeHost)
    ?? this.parent;
  target.disabled = true;
  try {
    await rollStrikeDamage(this.parent, attackOf(host), event);
  } finally {
    target.disabled = false;
  }
}

async function renderSummaries(messages) {
  const summaries = await Promise.all(messages.filter(m => m.visible).map(async m => ({
    id: m.id, html: await m.system.render({ summary: true })
  })));
  return summaries.filter(s => s.html);
}

/** Usage card: buttons below the rolls, closed once used; shows only its own rolls. */
export function withStrikeUsage(Base) {
  const Subclass = class extends Base {
    static metadata = Object.freeze(foundry.utils.mergeObject(super.metadata, {
      actions: { [DAMAGE_ACTION]: onDamageAction },
      template: USAGE_TEMPLATE
    }, { inplace: false }));

    /** @override */
    _prepareButtons() {
      return this.strikeButtons(super._prepareButtons(), this.parent);
    }

    /** @inheritDoc */
    async _prepareContext(options) {
      const context = await super._prepareContext(options);
      if ( context.summaries ) {
        const shown = new Set(rollsOf(this.parent).map(m => m.id));
        context.summaries = context.summaries.filter(s => shown.has(s.id));
      }
      return context;
    }

    /** Hide used roll buttons; on attack cards, also redirect Damage to the card's attack. */
    strikeButtons(buttons, host) {
      if ( !summariesOn() ) return buttons;
      if ( this.parent.getAssociatedActivity()?.type !== "attack" ) {
        const rolled = new Set(rollsOf(host).map(m => m.type));
        return buttons.map(b => rolled.has(ONE_SHOT[b.action]) ? { ...b, hidden: true } : b);
      }
      const open = openActions(host);
      return buttons.map(button => {
        if ( button.action === "rollAttack" ) return open.attack ? button : { ...button, hidden: true };
        if ( button.action !== "rollDamage" ) return button;
        if ( !open.damage ) return { ...button, hidden: true };
        return { ...button, action: DAMAGE_ACTION, dataset: { ...button.dataset, action: DAMAGE_ACTION } };
      });
    }

    /** Button groups for a strike card: the attack actions only. */
    strikeButtonGroups(host) {
      const context = {
        buttons: this.strikeButtons(Base.prototype._prepareButtons.call(this), host)
          .filter(b => ["rollAttack", DAMAGE_ACTION].includes(b.action)),
        rows: {}
      };
      this._prepareButtonGroups(context);
      return context.buttonGroups;
    }
  };
  return named(Subclass, Base);
}

/** Attack: attacks after the first render as their own card. */
export function withStrikeAttack(Base) {
  const Subclass = class extends Base {
    /** @override */
    get summaryTemplate() {
      return isStrikeCard(this.parent) ? "" : super.summaryTemplate;
    }

    /** @override */
    get template() {
      return isStrikeCard(this.parent) ? STRIKE_TEMPLATE : super.template;
    }

    /** @inheritDoc */
    async _prepareContext(options) {
      const context = await super._prepareContext(options);
      if ( options?.summary || !isStrikeCard(this.parent) ) return context;
      const usage = this.origin;
      const number = strikeNumber(this.parent);
      if ( context.header ) context.header = {
        ...context.header, subtitle: `${game.i18n.localize("DND5E.Attack")} ${number}`
      };
      context.strike = { hostId: this.parent.id, usageId: usage.id, number };
      context.summaries = await renderSummaries(rollsOf(this.parent));
      if ( usage.getAssociatedActivity() ) context.buttonGroups = usage.system.strikeButtonGroups?.(this.parent);
      return context;
    }
  };
  return named(Subclass, Base);
}

/** Chat message: deleting a card deletes everything it shows, strike cards included. */
export function withStrikeCascade(Base) {
  const Subclass = class extends Base {
    /** @inheritDoc */
    static async _preDeleteOperation(documents, operation, user) {
      const ids = new Set(operation.ids);
      for ( const message of documents ) {
        if ( isUsage(message) ) {
          for ( const attack of message.getAssociatedRolls("attack") ) if ( isStrikeCard(attack) ) ids.add(attack.id);
        }
        if ( isStrikeCard(message) ) for ( const roll of rollsOf(message) ) ids.add(roll.id);
      }
      operation.ids = Array.from(ids);
      return super._preDeleteOperation(documents, operation, user);
    }
  };
  return named(Subclass, Base);
}

/** dnd5e.postUseActivity: roll a save activity's damage with its card, if chosen (dnd5e waits for the button). */
export function onPostUseActivity(activity, usageConfig, results) {
  if ( (activity.type !== "save") || !activity.damage?.parts?.length ) return;
  if ( !game.settings.get(MODULE_ID, "autoSaveDamage") || (usageConfig.subsequentActions === false) ) return;
  const usage = results?.message;
  if ( usage?.id && game.messages.has(usage.id) ) rollStrikeDamage(usage, null, usageConfig.event);
}

/** Automatic damage after an attack from a card. */
export async function onRollAttack(rolls, { subject } = {}) {
  const mode = game.settings.get(MODULE_ID, "autoDamage");
  if ( mode === "never" ) return;
  const attack = rolls?.[0]?.parent;
  if ( (attack?.type !== "attack") || !isUsage(attack.system.origin) ) return;
  if ( !hasDamage(subject) ) return;
  const usage = attack.system.origin;
  const configure = !!attack.getFlag(MODULE_ID, "dialog");
  if ( mode === "always" ) {
    // With Dice So Nice, the attack's dice wait for this roll (dice.mjs).
    try {
      await rollStrikeDamage(usage, attack, undefined, { configure });
    } finally {
      releaseDice(attack);
    }
    return;
  }
  // On hit: at least one target hit (none without targets), after the attack's dice land.
  if ( !attack.system.evaluatedTargets.some(t => !t.isMiss) ) return;
  await diceLanded(attack);
  return rollStrikeDamage(usage, attack, undefined, { configure });
}
