/**
 * Rerolls: click a die in a breakdown to roll it again, and use the new result (Heroic
 * Inspiration, Indomitable, Empowered Spell). The roll is rebuilt with only that die rolled anew
 * (rebuild.mjs), so dnd5e applies its modes and modifiers again. The old value stays in the
 * breakdown, crossed out; clicking it goes back to it. Once the dice land, an info card is
 * posted as the user, with the roll's visibility and its own Undo: a message of the module's own
 * type (module.json `documentTypes`), rendered by dnd5e like its own cards.
 * Each reroll is kept in its roll's options: `rerolls`, { id, key, index, old, new }. A
 * reroll no longer there was undone.
 */
import { MODULE_ID, TEMPLATES } from "./common.mjs";
import { diceLanded } from "./dice.mjs";
import { rememberBreakdown, replaceRoll } from "./modes.mjs";
import { buildSame, canChange, dieOf, evaluateWith, locateResults, rebuildKind, resultAt } from "./rebuild.mjs";

/** Message type of the info card. */
export const REROLL_TYPE = `${MODULE_ID}.reroll`;

/** Dice with an image of their own in Foundry's breakdowns; others show as a d6. */
const DIE_IMAGES = new Set([4, 6, 8, 10, 12, 20]);

/** A roll's rerolls, oldest first. */
function rerollsOf(roll) {
  return roll?.options?.[MODULE_ID]?.rerolls ?? [];
}

/** A reroll, and the later rerolls of the same die, which undoing it undoes too. */
function fromReroll(roll, id) {
  const history = rerollsOf(roll);
  const at = history.findIndex(e => e.id === id);
  if ( at < 0 ) return [];
  const { key, index } = history[at];
  return history.slice(at).filter(e => (e.key === key) && (e.index === index));
}

/**
 * Whether this user can reroll a message's dice now, or undo its rerolls: who can change the
 * message (its author and the GM, as for dnd5e's own card actions), within the "Rerolls" setting.
 */
function canReroll(message) {
  const who = game.settings.get(MODULE_ID, "rerolls");
  if ( (who === "off") || !rebuildKind(message) || !canChange(message) ) return false;
  return game.user.isGM || (who === "owner");
}


/* -------------------------------------------- */
/*  Breakdown                                   */
/* -------------------------------------------- */

/**
 * dnd5e.renderChatMessage: in the breakdowns, the values replaced by rerolls crossed out before
 * the value that replaced them, and made buttons to go back to them; the dice this user can
 * reroll made buttons too. A die's value is wrapped (`.steady-rolls-face`), so the die can
 * turn under it.
 */
export function decorateRerolls(message, root, own = null) {
  const allowed = canReroll(message);
  if ( !allowed && !message.rolls.some(roll => rerollsOf(roll).length) ) return;
  for ( const { item, roll, key, index, first } of locateResults(message, root, own) ) {
    const history = rerollsOf(message.rolls[roll]).filter(e => (e.key === key) && (e.index === index));
    const replaced = history.map(entry => {
      const li = document.createElement("li");
      li.className = item.className;
      li.classList.remove("min", "max", "discarded", "steady-rolls-tumbling");
      li.classList.add("steady-rolls-rerolled");
      li.append(face(entry.old));
      item.before(li);
      return li;
    });
    if ( replaced.length || (allowed && first) ) item.replaceChildren(face(...item.childNodes));
    history.forEach((entry, i) => {
      if ( !allowed ) return;
      const label = game.i18n.format("STEADY_ROLLS.Reroll.GoBack", { value: entry.old });
      asButton(replaced[i], "steady-rolls-undoable", label, () => undo(message, roll, entry.id));
      previewUndo(replaced[i], [...replaced.slice(i + 1), item]);
    });
    if ( !allowed || !first ) continue;
    const label = game.i18n.localize("STEADY_ROLLS.Reroll.Action");
    asButton(item, "steady-rolls-rerollable", label, () => reroll(message, roll, key, index));
  }
}

/** A die's value, in its own element. */
function face(...content) {
  const span = document.createElement("span");
  span.className = "steady-rolls-face";
  span.append(...content.map(c => (c instanceof Node) ? c : String(c)));
  return span;
}

/** While an undo is hovered or focused, the values it would remove turn back (`.steady-rolls-undoing`). */
function previewUndo(button, removed) {
  const show = on => () => removed.forEach(li => li.classList.toggle("steady-rolls-undoing", on));
  for ( const type of ["pointerenter", "focus"] ) button.addEventListener(type, show(true));
  for ( const type of ["pointerleave", "blur"] ) button.addEventListener(type, show(false));
}

/** Make a breakdown die a button, which runs `action` once: from a click, Enter or Space. */
function asButton(item, className, label, action) {
  item.classList.add(className);
  Object.assign(item, { role: "button", tabIndex: 0, ariaLabel: label });
  item.dataset.tooltip = "";
  const run = event => {
    if ( (event.type === "keydown") && !["Enter", " "].includes(event.key) ) return;
    event.preventDefault();
    item.removeEventListener("click", run);
    item.removeEventListener("keydown", run);
    action().catch(err => console.error(`${MODULE_ID} | Could not change the die`, err));
  };
  item.addEventListener("click", run);
  item.addEventListener("keydown", run);
}

/* -------------------------------------------- */
/*  Rerolling                                   */
/* -------------------------------------------- */

/** Roll one die of a message's roll again; its new result is used. Then post the info card. */
async function reroll(message, rollIndex, key, index) {
  rememberBreakdown();
  let entry;
  const done = await replaceRoll(message, rollIndex, "reroll", async old => {
    const result = resultAt(old, key, index);
    if ( !result ) return null;
    const roll = buildSame(old);
    const dice = await evaluateWith([old], [roll], { replace: [{ [key]: { [index]: null } }] });
    entry = {
      id: foundry.utils.randomID(), key, index,
      old: result.result, new: resultAt(roll, key, index)?.result
    };
    roll.options[MODULE_ID].rerolls = [...rerollsOf(old), entry];
    return { roll, dice };
  });
  if ( !done ) return;
  await diceLanded(message);
  const system = {
    message: message.id, roll: rollIndex, reroll: entry.id,
    faces: dieOf(done.old, key).faces, label: rollLabel(message), before: entry.old, after: entry.new
  };
  // The content is shown only if the module is disabled.
  const content = game.i18n.format("STEADY_ROLLS.Reroll.Card", {
    user: game.user.name, faces: system.faces, label: system.label, old: entry.old, new: entry.new
  });
  await ChatMessage.implementation.create({
    type: REROLL_TYPE, system, content, whisper: message.whisper, blind: message.blind,
    speaker: ChatMessage.implementation.getSpeaker({ user: game.user })
  });
}

/**
 * Undo a reroll: put back the value it replaced. Later rerolls of the same die are undone with
 * it, as they replaced values that came after. Only while the die shows its last reroll's value.
 */
async function undo(message, rollIndex, id) {
  rememberBreakdown();
  let refused = false;
  await replaceRoll(message, rollIndex, "undo", async old => {
    const undone = fromReroll(old, id);
    const current = undone.length ? resultAt(old, undone[0].key, undone[0].index)?.result : undefined;
    if ( !canReroll(message) || !undone.length || (current !== undone.at(-1).new) ) {
      refused = true;
      return null;
    }
    const { key, index, old: value } = undone[0];
    const roll = buildSame(old);
    const dice = await evaluateWith([old], [roll], { replace: [{ [key]: { [index]: value } }] });
    roll.options[MODULE_ID].rerolls = rerollsOf(old).filter(e => !undone.includes(e));
    return { roll, dice };
  });
  if ( refused ) ui.notifications.warn("STEADY_ROLLS.Reroll.CannotUndo", { localize: true });
}

/* -------------------------------------------- */
/*  Info card                                   */
/* -------------------------------------------- */

/** What a roll is, for the info card: its item, or its flavor. */
function rollLabel(message) {
  return message.getAssociatedItem?.()?.name ?? message.flavor ?? "";
}

/** A die as Foundry draws it in breakdowns: its classes and value. */
function dieChip(faces, value, crossed) {
  const classes = ["roll", "die", `d${DIE_IMAGES.has(faces) ? faces : 6}`];
  if ( crossed ) classes.push("steady-rolls-rerolled");
  else if ( value === 1 ) classes.push("min");
  else if ( value === faces ) classes.push("max");
  return { classes: classes.join(" "), value };
}

/**
 * The info card's data model: which die of which roll was rerolled, its values before and after,
 * and the roll's label. A dnd5e chat message model, so dnd5e renders it and dispatches its Undo.
 * Built on demand: dnd5e's classes exist only once dnd5e is loaded.
 */
export function rerollCardModel() {
  const { ChatMessageDataModel } = dnd5e.dataModels.abstract;
  const { NumberField, StringField } = foundry.data.fields;
  return class RerollCardData extends ChatMessageDataModel {
    static metadata = Object.freeze(foundry.utils.mergeObject(super.metadata, {
      actions: { undo: RerollCardData.#undo },
      template: `${TEMPLATES}/reroll-card.hbs`
    }, { inplace: false }));

    /** @override */
    static defineSchema() {
      return {
        message: new StringField({ required: true, blank: false }),
        roll: new NumberField({ required: true, integer: true, min: 0 }),
        reroll: new StringField({ required: true, blank: false }),
        faces: new NumberField({ integer: true, positive: true }),
        label: new StringField(),
        before: new NumberField(),
        after: new NumberField()
      };
    }

    /** The rerolled message and roll, if still there. */
    get target() {
      const message = game.messages.get(this.message);
      return { message, roll: message?.rolls[this.roll] };
    }

    /**
     * The die before and after; once undone (the roll no longer has the reroll), the new value
     * is the one crossed out. Undo for those who can reroll the roll.
     * @inheritDoc
     */
    async _prepareContext(options) {
      const { message, roll } = this.target;
      const undone = !!message && !rerollsOf(roll).some(e => e.id === this.reroll);
      return {
        undone,
        label: this.label,
        note: game.i18n.format(`STEADY_ROLLS.Reroll.${undone ? "Undone" : "Done"}`, { faces: this.faces }),
        before: dieChip(this.faces, this.before, !undone),
        after: dieChip(this.faces, this.after, undone),
        undoable: !undone && !!roll && canReroll(message)
      };
    }

    /** Card action: undo the reroll. */
    static async #undo(event, button) {
      const { message } = this.target;
      if ( !message ) return;
      button.disabled = true;
      try { await undo(message, this.roll, this.reroll); }
      catch(err) { console.error(`${MODULE_ID} | Could not undo the reroll`, err); }
      finally { button.disabled = false; }
    }
  };
}

/** updateChatMessage (rolls) and deleteChatMessage: redraw the info cards of a roll's rerolls. */
export function refreshRerollCards(message) {
  for ( const card of game.messages ) {
    if ( (card.type === REROLL_TYPE) && (card.system.message === message.id) ) ui.chat?.updateMessage(card);
  }
}
