/**
 * Saves on a save activity's card, in a section before the other rolls:
 * - the DC, then a row per target and per save rolled, by name: the save, a total "?" for one
 *   this user can't see, or, for a target still to roll, a roll button for its owner;
 * - the card's Save button rolls for the user's selected tokens, or their character's token on
 *   this scene, not for the card's targets, and names them; those who already rolled are struck
 *   through and not rolled again (rerolling their dice changes a save).
 * Every roll goes through dnd5e's own Save button handler, which reads the card's
 * `evaluatedTargets`.
 * A token that saves without being targeted joins the card's targets (written by the active GM,
 * or the card's author without one), and the caster's targets while it is their newest card. The
 * card's damage targets are the tokens that saved.
 */
import { TARGETS_UPDATE, isSaveCard, named, rolledOn, rollerOf } from "./common.mjs";
import { newestCard } from "./follow.mjs";

/** A token's or actor's key on a card: the token's uuid, or the actor's without a token. */
function keyOf(subject) {
  return (subject instanceof Actor) ? subject.uuid : (subject.document ?? subject).uuid;
}

/**
 * Whom the Save button rolls for: the user's selected tokens, or their character's token on this
 * scene. A character without one rolls from its sheet: a save card's targets are tokens.
 */
function candidates() {
  const selected = canvas.tokens?.controlled.filter(t => t.actor && t.document.isOwner) ?? [];
  if ( selected.length ) return selected;
  const token = game.user.character?.getActiveTokens()[0];
  return token ? [token] : [];
}

/**
 * A card's save list, by name: its targets, and anyone else who saved. Each row is a save rolled
 * (its summary), a save this user can't see (`private`: its total shown as "?", as dnd5e shows a
 * private roll's), or a target still to roll (key, and whether this user can roll for it).
 */
export function saveRows(card, summaries) {
  const shown = new Map(summaries.map(s => [s.id, s]));
  const rolled = new Map(card.getAssociatedRolls("save").map(save => {
    const name = save.getAssociatedToken()?.name ?? save.alias;
    const row = shown.has(save.id) ? { ...shown.get(save.id), name } : { key: rollerOf(save), name, private: true };
    return [rollerOf(save), row];
  }));
  const { TargetsField } = dnd5e.dataModels.chatMessage.fields;
  const pending = card.system.targets.flatMap(descriptor => {
    const key = descriptor.token ?? descriptor.actor;
    if ( rolled.has(key) ) return [];
    const { actor, token } = TargetsField.resolve(descriptor);
    return [{ key, name: token?.name ?? descriptor.name, owner: !!(actor ?? token?.actor)?.isOwner }];
  });
  return [...rolled.values(), ...pending].sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
}

/** The token or actor a key stands for, as dnd5e's handler takes it. */
function subjectOf(key) {
  const document = fromUuidSync(key, { strict: false });
  return document?.object ?? document ?? null;
}

/** Usage card of a save activity: the save list and the Save button's own subjects. */
export function withSaveList(Base) {
  const Subclass = class extends Base {
    /** The token a row's button rolls for, set by the button that triggers the roll. */
    #only = null;

    /** @inheritDoc */
    get evaluatedTargets() {
      if ( !isSaveCard(this.parent) ) return super.evaluatedTargets;
      if ( this.#only ) return [subjectOf(this.#only)].filter(Boolean);
      const rolled = rolledOn(this.parent);
      return candidates().filter(s => !rolled.has(keyOf(s)));
    }

    /**
     * The saves section, before the other rolls: the DC, the saves rolled, the targets still to
     * roll, then the Save button with whom it rolls for. The button and the DC leave dnd5e's rows.
     * @inheritDoc
     */
    async _prepareContext(options) {
      const context = await super._prepareContext(options);
      if ( !isSaveCard(this.parent) || context.content ) return context;
      context.showTargets = false; // The save list shows them.
      const isSave = s => game.messages.get(s.id)?.type === "save";
      context.saves = {
        dc: context.rows?.rollSave,
        rows: saveRows(this.parent, context.summaries?.filter(isSave) ?? []),
        buttons: context.buttonGroups?.rollSave?.entries ?? [],
        label: saveLabel(this.parent.getAssociatedActivity())
      };
      context.summaries = context.summaries?.filter(s => !isSave(s));
      delete context.rows?.rollSave;
      delete context.buttonGroups?.rollSave;
      if ( foundry.utils.isEmpty(context.buttonGroups) ) delete context.buttonGroups;
      return context;
    }

    /** @inheritDoc */
    _onRender(element, options) {
      super._onRender(element, options);
      if ( !isSaveCard(this.parent) ) return;
      // Saves rolled, drawn as the card's other rolls: in a box, with their toggles around the total.
      for ( const row of element.querySelectorAll(".card-summary .save-summary") ) row.classList.add("steady-rolls-roll");
      const button = element.querySelector(".steady-rolls-save-roll button");
      if ( button ) showSubjects(button, this.parent);
    }

    /** @inheritDoc */
    _onClickAction(event, target) {
      if ( isSaveCard(this.parent) && (target.dataset.action === "rollSave") ) {
        this.#only = target.dataset.steadyRollsSave ?? null;
        if ( !this.#canRoll() ) return;
      }
      return super._onClickAction(event, target);
    }

    /** @inheritDoc */
    _getButtonGroupContextOptions() {
      const options = super._getButtonGroupContextOptions();
      if ( !isSaveCard(this.parent) ) return options;
      const only = ui.context.target.dataset.steadyRollsSave ?? null;
      return options.map(option => ({ ...option, onClick: (event, group) => {
        this.#only = only;
        if ( this.#canRoll() ) return option.onClick(event, group);
      } }));
    }

    /** Whether the Save button has anyone to roll for; if all already rolled, say so. */
    #canRoll() {
      if ( this.#only ) return true;
      const subjects = candidates();
      if ( !subjects.length ) {
        // dnd5e would roll for the character, even without a token on the scene.
        ui.notifications.warn("DND5E.ActionWarningNoToken", { localize: true });
        return false;
      }
      const rolled = rolledOn(this.parent);
      if ( subjects.some(s => !rolled.has(keyOf(s))) ) return true;
      ui.notifications.warn("STEADY_ROLLS.Save.AllRolled", { localize: true });
      return false;
    }
  };
  return named(Subclass, Base);
}

/** The Save button's label, for screen readers and its tooltip: the ability, if only one. */
function saveLabel(activity) {
  const abilities = activity?.save?.ability ?? new Set();
  const ability = (abilities.size === 1) ? CONFIG.DND5E.abilities[abilities.first()]?.label : null;
  return ability ? game.i18n.format("STEADY_ROLLS.Save.RollAbility", { ability }) : game.i18n.localize("STEADY_ROLLS.Save.Roll");
}

/**
 * The Save button shows whom it rolls for, those who already rolled struck through; with no one
 * to roll for, a hint, and it is disabled.
 */
function showSubjects(button, card) {
  const rolled = rolledOn(card);
  const subjects = candidates();
  const names = subjects.map(subject => {
    const name = document.createElement(rolled.has(keyOf(subject)) ? "s" : "span");
    name.textContent = subject.name;
    return name;
  });
  const text = button.querySelector(".steady-rolls-for");
  if ( !names.length ) text.replaceChildren(game.i18n.localize("STEADY_ROLLS.Save.SelectTokens"));
  else text.replaceChildren(...names.flatMap((n, i) => i ? [", ", n] : [n]));
  button.disabled = !names.length || subjects.every(s => rolled.has(keyOf(s)));
}

/** controlToken: the Save buttons' subjects follow the selection. */
export function refreshSaveSubjects() {
  for ( const button of document.querySelectorAll(".steady-rolls-save-roll button") ) {
    const card = game.messages.get(button.closest("[data-message-id]")?.dataset.messageId);
    if ( card ) showSubjects(button, card);
  }
}

/* -------------------------------------------- */
/*  Joining                                     */
/* -------------------------------------------- */

/** Whether this client writes a card's shared changes: the active GM, or its author without one. */
function writesFor(card) {
  const gm = game.users.activeGM;
  return gm ? gm.isSelf : !!card.author?.isSelf;
}

/** createChatMessage and deleteChatMessage, for saves and damage on a save card: see the module's doc. */
export async function onSaveCardRoll(message) {
  const card = message.system?.origin;
  if ( !["save", "damage"].includes(message.type) || !isSaveCard(card) || !game.messages.has(card.id) ) return;
  const { TargetsField } = dnd5e.dataModels.chatMessage.fields;
  const saved = TargetsField.getDescriptors(card.getAssociatedRolls("save").map(m => m.getAssociatedToken()).filter(Boolean));
  const known = new Set(card.system.targets.map(t => t.token));
  const joined = saved.filter(t => !known.has(t.token));
  if ( joined.length && card.isAuthor && (newestCard() === card) ) {
    const ids = joined.map(t => fromUuidSync(t.token, { strict: false })).filter(t => t?.parent === canvas.scene).map(t => t.id);
    if ( ids.length ) canvas.tokens.setTargets(ids, { mode: "acquire" });
  }
  if ( !writesFor(card) ) return;
  if ( joined.length ) await card.update({ "system.targets": [...card.system.targets, ...joined] }, TARGETS_UPDATE);
  const tokens = targets => targets.map(t => t.token).sort().join();
  for ( const damage of card.getAssociatedRolls("damage") ) {
    if ( tokens(damage.system.targets) !== tokens(saved) ) await damage.update({ "system.targets": saved }, TARGETS_UPDATE);
  }
}
