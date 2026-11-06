/**
 * Targets from templates: once an activity's template is placed, the tokens inside become the
 * user's targets and the targets of its item card, as if targeted before the use. The card's
 * targets are what its save and damage buttons use. An activity that affects allies or enemies
 * only takes those, by disposition, as dnd5e's region behaviors do. While the template is being
 * placed, the user's targets are released and the tokens it would target show faint target
 * arrows, drawn only on this client; cancelling brings the targets back.
 */
import { MODULE_ID, named } from "./common.mjs";

/** Item cards whose Place Template button was clicked, by activity uuid. */
const placing = new Map();

/** The disposition an activity affects, relative to its user's; null for any. */
function affected(activity) {
  const { FRIENDLY, HOSTILE } = CONST.TOKEN_DISPOSITIONS;
  const type = activity.target?.affects?.type;
  if ( !["ally", "enemy"].includes(type) ) return null;
  const token = activity.getUsageToken?.() ?? activity.actor?.prototypeToken;
  const ally = (type === "ally") !== (token?.disposition === HOSTILE);
  return ally ? FRIENDLY : HOSTILE;
}

/** Tokens inside the regions that the activity affects and this user may target. */
export function tokensInside(activity, regions) {
  const scene = regions[0]?.parent;
  if ( !scene ) return [];
  const disposition = affected(activity);
  return scene.tokens.filter(token => token.actor
    && (token.disposition !== CONST.TOKEN_DISPOSITIONS.SECRET)
    && (game.user.isGM || !token.hidden)
    && ((disposition === null) || (token.disposition === disposition))
    && regions.some(region => token.testInsideRegion(region)));
}

function enabled() {
  return game.settings.get(MODULE_ID, "templateTargets");
}

/** Write targets to an item card, if this user can. */
function setCardTargets(card, tokens) {
  if ( !card?.id || !game.messages.has(card.id) || !card.canUserModify(game.user, "update") ) return;
  const { TargetsField } = dnd5e.dataModels.chatMessage.fields;
  return card.update({ "system.targets": TargetsField.getDescriptors(tokens) }, { [MODULE_ID]: { targets: true } });
}

/**
 * updateChatMessage, on every client: a card drawn before its template was placed had no targets,
 * so dnd5e set its list to Selected for the session. With the template's targets, it goes back to
 * dnd5e's default, Targeted. Runs before the card is drawn again.
 */
export function onUpdateCardTargets(message, changes, options) {
  if ( !options?.[MODULE_ID]?.targets || (message._targetState?.mode !== "selected") ) return;
  message._targetState.mode = "";
}

/* -------------------------------------------- */
/*  Preview while placing                       */
/* -------------------------------------------- */

/** The activity whose template is being placed, and its preview regions. */
let placement = null;

/** Preview arrows, by token. */
const arrows = new Map();

/** Target arrows as Foundry draws them, faint, in the token's disposition colour. */
function previewArrows(token) {
  const l = CONFIG.Canvas.targeting.size * 100 * canvas.dimensions.uiScale;
  const { w, h } = token;
  const graphics = new PIXI.Graphics();
  graphics.alpha = 0.5;
  graphics.beginFill(token.getDispositionColor())
    .lineStyle({ color: 0, width: 2 * canvas.dimensions.uiScale, join: PIXI.LINE_JOIN.BEVEL })
    .drawPolygon([0, 0, -l, 0, 0, -l])
    .drawPolygon([w, 0, w + l, 0, w, -l])
    .drawPolygon([0, h, -l, h, 0, h + l])
    .drawPolygon([w, h, w + l, h, w, h + l]);
  return graphics;
}

/** Show preview arrows on these tokens only. */
function showArrows(tokens) {
  const shown = new Set(tokens.map(t => t.object).filter(Boolean));
  for ( const [token, graphics] of arrows ) {
    if ( shown.has(token) && !graphics.destroyed ) continue;
    graphics.destroy();
    arrows.delete(token);
  }
  for ( const token of shown ) if ( !arrows.has(token) ) arrows.set(token, token.addChild(previewArrows(token)));
}

/** dnd5e.preCreateMeasuredTemplate: an activity's template is about to be placed. */
export function onPreCreateTemplate(activity) {
  if ( enabled() ) placement = { activity, previews: new Set() };
}

/**
 * refreshRegion: while a template is placed, arrows on the tokens its previews would target. The
 * user's targets are released when the first preview shows, and kept to restore on cancel.
 */
export function onRefreshRegion(region) {
  if ( !placement || !region.isPreview || !foundry.utils.getProperty(region.document.flags, "core.MeasuredTemplate") ) return;
  if ( !placement.previews.size && !placement.targets ) {
    placement.targets = Array.from(game.user.targets, t => t.id);
    canvas.tokens.setTargets([]);
  }
  placement.previews.add(region);
  showArrows(tokensInside(placement.activity, [...placement.previews].map(r => r.document)));
}

/**
 * destroyRegion: placement over, the arrows go; if cancelled, the targets come back. Foundry
 * destroys a cancelled preview while its placement is still open, a placed one after.
 */
export function onDestroyRegion(region) {
  if ( !placement?.previews.delete(region) ) return;
  if ( canvas.regions._placementContext ) placement.cancelled = true;
  if ( placement.previews.size ) return;
  if ( placement.cancelled ) canvas.tokens.setTargets(placement.targets);
  placement = null;
  showArrows([]);
}

/* -------------------------------------------- */
/*  Targets                                     */
/* -------------------------------------------- */

/** dnd5e.postCreateMeasuredTemplate: target the tokens inside; from a card button, that card's too. */
export function onPostCreateTemplate(activity, regions) {
  const card = placing.get(activity.uuid);
  placing.delete(activity.uuid);
  if ( !enabled() || !regions?.length ) return;
  const tokens = tokensInside(activity, regions);
  if ( canvas.scene === regions[0].parent ) canvas.tokens.setTargets(tokens.map(t => t.id));
  return setCardTargets(card, tokens);
}

/** dnd5e.preUseActivity: a new use, not a card's Place Template button. */
export function onPreUseTemplate(activity) {
  placing.delete(activity.uuid);
}

/** dnd5e.postUseActivity: the item card gets the targets of the templates just placed. */
export function onPostUseTemplate(activity, usageConfig, results) {
  if ( !enabled() || !results?.templates?.length ) return;
  return setCardTargets(results.message, tokensInside(activity, results.templates));
}

/** Usage card: remembers itself while its Place Template button places one. */
export function withTemplateTargets(Base) {
  const Subclass = class extends Base {
    /** @inheritDoc */
    _onClickAction(event, target) {
      const action = target.dataset.action ?? this.getButton(target)?.action;
      const activity = this.parent.getAssociatedActivity();
      if ( (action === "placeTemplate") && activity ) placing.set(activity.uuid, this.parent);
      return super._onClickAction(event, target);
    }
  };
  return named(Subclass, Base);
}
