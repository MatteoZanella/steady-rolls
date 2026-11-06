/**
 * Damage applied from a damage card is recorded on it, one entry per application:
 * `flags.steady-rolls.applied`, [{ target, amount, hp: { value, temp, tempmax } }]. The target is
 * the token's uuid, or the actor's for a linked actor; `hp` is how much each hit-point field
 * changed. In the card's Apply tray, the targets that took damage are marked; a click on the mark
 * undoes it: the changes are taken back, so whatever happened to the actor since stays.
 * A user who can't update the card (a player applying to their own token) has the active GM write
 * the record, which checks they own the actor. The tray applies to its targets one after the
 * other: their records are written together once it is done, so the card changes once.
 */
import { MODULE_ID } from "./common.mjs";

const QUERY = `${MODULE_ID}.recordDamage`;
const HP = "system.attributes.hp";

/** A damage card's applications, as recorded. */
export function appliedOn(message) {
  return message?.getFlag(MODULE_ID, "applied") ?? [];
}

/** An actor's key in the record: its token's uuid, or its own for a linked actor. */
function keyOf(actor) {
  return actor.token?.uuid ?? actor.uuid;
}

/** Updates of each card, one after the other, so concurrent applications all stay. */
const queues = new Map();

/** Change a card's record: `change` makes the new list from the current one. */
function write(message, change) {
  const next = (queues.get(message.id) ?? Promise.resolve())
    .then(() => message.setFlag(MODULE_ID, "applied", change(appliedOn(message))));
  queues.set(message.id, next.catch(() => {}));
  return next;
}

/** Write a change to a card's record, through the GM if this user can't. */
function writeFor(message, change) {
  if ( message.canUserModify(game.user, "update") ) return apply(message, change);
  return game.users.activeGM?.query(QUERY, { message: message.id, ...change });
}

/**
 * Change a record: `add`, applications ({ actor uuid, entry }); `undo`, an actor uuid whose
 * applications are removed.
 */
function apply(message, { add = [], undo }) {
  const key = uuid => keyOf(fromUuidSync(uuid, { strict: false }) ?? { uuid });
  if ( undo ) return write(message, applied => applied.filter(e => e.target !== key(undo)));
  return write(message, applied => [...applied, ...add.map(({ actor, entry }) => ({ target: key(actor), ...entry }))]);
}

/** The hit-point changes of each application, from its preApplyDamage to its applyDamage. */
const changes = new WeakMap();

/** Applications not yet written, by card; written once no other follows at once. */
const pending = new Map();
let flushing = null;

/** Write the pending applications, each card's at once. */
function flush() {
  flushing = null;
  for ( const [message, add] of pending ) {
    pending.delete(message);
    writeFor(message, { add });
  }
}

/**
 * dnd5e.preApplyDamage: how much each hit-point field will change. An application is under way:
 * the pending ones wait for it (at most 2 seconds, should another module cancel it).
 */
export function onPreApplyDamage(actor, amount, updates, options) {
  clearTimeout(flushing);
  if ( pending.size ) flushing = setTimeout(flush, 2000);
  const hp = actor.system.attributes.hp;
  const source = actor.system._source.attributes.hp;
  changes.set(options, {
    value: (updates[`${HP}.value`] ?? hp.value) - hp.value,
    temp: (updates[`${HP}.temp`] ?? hp.temp) - hp.temp,
    tempmax: (updates[`${HP}.tempmax`] ?? source.tempmax) - source.tempmax
  });
}

/** dnd5e.applyDamage: record it on the damage card it came from (the tray or the context menu). */
export function onApplyDamage(actor, amount, options = {}) {
  const message = options.origin ?? options.originatingMessage;
  const hp = changes.get(options);
  if ( !amount || !hp || !game.messages.has(message?.id) ) return;
  pending.set(message, [...(pending.get(message) ?? []), { actor: actor.uuid, entry: { amount, hp } }]);
  clearTimeout(flushing);
  flushing = setTimeout(flush, 100);
}

/** CONFIG.queries: the GM changes a record for a user who owns the actors. */
export function onRecordQuery({ message, add = [], undo }, { user }) {
  const card = game.messages.get(message);
  const owns = uuid => !!fromUuidSync(uuid, { strict: false })?.testUserPermission(user, "OWNER");
  if ( !card ) return false;
  if ( undo ) return owns(undo) && apply(card, { undo });
  const valid = add.filter(a => owns(a.actor) && Number.isFinite(a.entry?.amount));
  return !!valid.length && apply(card, { add: valid });
}

/**
 * Undo the damage a card did to an actor: take back each hit-point change, then remove them from
 * the record. Hit points stay within 0 and the maximum.
 */
export async function undoDamage(message, actor) {
  const entries = appliedOn(message).filter(e => e.target === keyOf(actor));
  if ( !entries.length ) return;
  const total = field => entries.reduce((sum, e) => sum + (e.hp?.[field] ?? 0), 0);
  const hp = actor.system.attributes.hp;
  const source = actor.system._source.attributes.hp;
  await actor.update({
    [`${HP}.value`]: Math.clamp(hp.value - total("value"), 0, hp.max),
    [`${HP}.temp`]: Math.max(hp.temp - total("temp"), 0),
    [`${HP}.tempmax`]: source.tempmax - total("tempmax")
  });
  return writeFor(message, { undo: actor.uuid });
}

/** A tray target's keys: its token, and its actor if linked. */
function keysOf(uuid) {
  const token = fromUuidSync(uuid, { strict: false });
  return [uuid, token?.actorLink ? token.actor?.uuid : null];
}

/**
 * recorded-targets:build, caught on the way down as it doesn't bubble: in an Apply tray, a mark
 * on each target that took damage from this card, with the amount; for whoever owns the target, a
 * button that undoes it.
 */
export function markApplied(event) {
  const list = event.target;
  if ( !list.closest?.("damage-application") ) return;
  const message = game.messages.get(list.closest("[data-message-id]")?.dataset.messageId);
  const applied = appliedOn(message);
  if ( !applied.length ) return;
  for ( const pill of list.querySelectorAll("target-pill") ) {
    const tokens = Array.from(pill.querySelectorAll("option"), o => fromUuidSync(o.value, { strict: false }));
    const taken = Array.from(pill.querySelectorAll("option"), o => keysOf(o.value))
      .map(keys => applied.filter(e => keys.includes(e.target)).reduce((sum, e) => sum + e.amount, 0));
    const amount = taken.reduce((sum, a) => sum + a, 0);
    pill.querySelector(".steady-rolls-applied")?.remove();
    if ( !amount ) continue;
    const actors = tokens.filter((t, i) => taken[i] && t?.actor?.isOwner).map(t => t.actor);
    const key = `STEADY_ROLLS.Applied.${actors.length ? "Undo" : ""}${(amount > 0) ? "Damage" : "Healing"}`;
    const mark = document.createElement(actors.length ? "button" : "i");
    mark.className = "steady-rolls-applied";
    mark.dataset.tooltip = game.i18n.format(key, { amount: Math.abs(amount) });
    mark.innerHTML = '<i class="fa-solid fa-heart-crack" inert></i><i class="fa-solid fa-clock-rotate-left" inert></i>';
    if ( actors.length ) {
      mark.type = "button";
      mark.ariaLabel = mark.dataset.tooltip;
      mark.addEventListener("click", async clicked => {
        clicked.stopPropagation();
        mark.disabled = true;
        try { for ( const actor of actors ) await undoDamage(message, actor); }
        catch(err) { console.error(`${MODULE_ID} | Could not undo the damage`, err); }
      });
    }
    pill.prepend(mark);
  }
}
