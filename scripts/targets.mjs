/**
 * Targets from templates: once an activity's template is placed, the tokens inside become the
 * user's targets and the targets of its item card, as if targeted before the use. The card's
 * targets are what its save and damage buttons use. An activity that affects allies or enemies
 * only takes those, by disposition, as dnd5e's region behaviors do. While the template is being
 * placed, the user's targets are released and the tokens it would target show faint target
 * arrows, drawn only on this client, with walls taken into account as on the placed template;
 * cancelling brings the targets back. The preview itself is drawn cut by walls too, as the placed
 * template will be: dnd5e's preview ignores them. Area template aids, each on its own: the
 * targets; snapping to square corners and edges, ties going one way; a template in its damage
 * type's colour; areas thinner than a square (walls) outlined; a right-click while placing asking
 * before skipping the template.
 */
import { MODULE_ID, TARGETS_UPDATE, named } from "./common.mjs";
import { templateAid } from "./settings.mjs";

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
  return templateAid("targets");
}

/** Write targets to an item card, if this user can. */
function setCardTargets(card, tokens) {
  if ( !card?.id || !game.messages.has(card.id) || !card.canUserModify(game.user, "update") ) return;
  const { TargetsField } = dnd5e.dataModels.chatMessage.fields;
  return card.update({ "system.targets": TargetsField.getDescriptors(tokens) }, TARGETS_UPDATE);
}

/* -------------------------------------------- */
/*  Preview while placing                       */
/* -------------------------------------------- */

/** The activity whose template is being placed, and its preview regions. */
let placement = null;

/** Whether a template is being placed: from its first preview until it targets, or is cancelled. */
let templating = false;

/** Whether target changes now come from placing a template, not from the user. */
export function isTemplating() {
  return templating;
}

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

/**
 * dnd5e.preCreateMeasuredTemplate: an activity's template is about to be placed. It takes the
 * colour of its damage type (an aid), in its preview and once placed (onCreateTemplate).
 */
export function onPreCreateTemplate(activity, config) {
  const color = templateAid("colors") && damageColor(activity);
  if ( color && config ) config.color = color;
  placement = { activity, previews: new Set(), targeting: enabled() };
}

/** The colour of an activity's first damage or healing type, as dnd5e defines it, as CSS. */
export function damageColor(activity) {
  const { damageTypes, healingTypes } = CONFIG.DND5E;
  const parts = [...(activity.damage?.parts ?? []), ...(activity.healing ? [activity.healing] : [])];
  for ( const part of parts ) {
    for ( const type of part.types ?? [] ) {
      const color = (damageTypes[type] ?? healingTypes[type])?.color;
      if ( color ) return color.css;
    }
  }
  return null;
}

/**
 * refreshRegion, for dnd5e's templates: thin ones outlined (an aid). Its previews are cut by walls,
 * as the placed template, with arrows on the tokens they would target (an aid), the user's targets
 * released when the first preview shows and kept to restore on cancel.
 */
export function onRefreshRegion(region) {
  const flags = region.document.flags;
  const preview = !!placement && region.isPreview && !!foundry.utils.getProperty(flags, "core.MeasuredTemplate");
  if ( !preview && !flags.dnd5e?.activity ) return;
  const outlined = templateAid("outline");
  if ( outlined && preview ) drawThin(region);
  outline(region, outlined);
  if ( !preview ) return;
  drawAsPlaced(region);
  joinPlacement(region);
  placement.previews.add(region);
  if ( !placement.targeting ) return;
  if ( !placement.targets ) {
    templating = true;
    placement.targets = Array.from(game.user.targets, t => t.id);
    canvas.tokens.setTargets([]);
  }
  showArrows(tokensInside(placement.activity, [...placement.previews].map(p => p.document)));
}

/** dnd5e's placed template: restricted for movement, so walls cut it. Its preview isn't. */
const RESTRICTION = { enabled: true, type: "move" };

/**
 * Draw a preview as dnd5e will place it: restricted like the placed template, on the viewed level.
 * Foundry's own region code computes the wall cut, again as it moves and turns, as for the placed
 * template and for one dragged; dnd5e takes just the preview's shapes when it is placed.
 */
function drawAsPlaced(preview) {
  if ( preview.document.restriction.enabled ) return;
  preview.document.updateSource({ levels: [canvas.level.id], restriction: RESTRICTION });
  preview.document.updateShapeConstraints();
  preview.renderFlags.set({ refreshShapes: true });
}

/** A preview of thin lines covers no square: drawn as its shape, as the placed template (onCreateTemplate). */
function drawThin(preview) {
  const document = preview.document;
  if ( (document.highlightMode === "shapes") || !document.shapes.length || !document.shapes.every(isThin) ) return;
  document.updateSource({ highlightMode: "shapes" });
  preview.renderFlags.set({ refresh: true });
}

/** Whether a template's line is thinner than a square: it covers none. */
function isThin(shape) {
  return (shape.type === "line") && (shape.width < canvas.grid.size);
}

/** dnd5e.createMeasuredTemplate: the placed template looks as its preview: colour, thin lines. */
export function onCreateTemplate(activity, regions) {
  const color = templateAid("colors") && damageColor(activity);
  for ( const region of regions ) {
    if ( color ) region.color = color;
    if ( templateAid("outline") && region.shapes?.length && region.shapes.every(isThin) ) region.highlightMode = "shapes";
  }
}

/** Outlines of thin templates: a wall an inch thick is drawn 2.5 px wide on a 150 px grid. */
const outlines = new WeakMap();

/** Outline a template of thin lines, so it shows; its area stays the same. Off: no outline. */
function outline(region, on) {
  let graphics = outlines.get(region);
  const shapes = region.document.shapes;
  if ( !on || !shapes.length || !shapes.every(isThin) ) return graphics?.clear();
  if ( !graphics || graphics.destroyed ) {
    graphics = region.addChildAt(new PIXI.Graphics(), 0);
    graphics.eventMode = "none";
    outlines.set(region, graphics);
  }
  graphics.clear().lineStyle({ width: 6 * canvas.dimensions.uiScale, color: region.document.color, alpha: 0.8 });
  for ( const polygon of region.document.polygons ) graphics.drawShape(polygon);
}

/* -------------------------------------------- */
/*  Foundry's placement                         */
/* -------------------------------------------- */

/** The open question whether to stop placing, if any. */
let asking = null;

/**
 * Join Foundry's placement through the callbacks dnd5e leaves unset. onMove snaps the template to
 * square corners and edges (an aid), and holds it still while asking whether to skip it. preSkip:
 * Foundry skips a template on a right press, so a right drag can't pan; instead a right click (a
 * release where the map didn't pan) asks first (an aid). Escape still skips at once.
 */
function joinPlacement(preview) {
  const context = canvas.regions._placementContext;
  if ( context?.preview !== preview ) return;
  context.onMove ??= onPlacementMove;
  if ( templateAid("stop") ) context.preSkip ??= onRightPress;
}

/** Snapping on a square's corners and edges, not its centre: an area's origin, as the rules place it. */
function edges() {
  const M = CONST.GRID_SNAPPING_MODES;
  return M.VERTEX | M.EDGE_MIDPOINT;
}

/** Shapes placed by their origin; an emanation follows its token. */
const PLACED = new Set(["circle", "cone", "ellipse", "line", "rectangle", "ring"]);

function onPlacementMove({ shape, position, snap }) {
  if ( asking ) return false;
  if ( !snap || !templateAid("snap") || canvas.grid.isGridless || !PLACED.has(shape.type) ) return;
  const snapped = canvas.grid.getSnappedPoint(position, { mode: edges() });
  shape.move(nudge(snapped, canvas.grid));
  return false;
}

/**
 * Off a grid point, so no square's centre lies on the edge of an area along the grid: a tie the
 * half-square rule can't settle, which Foundry counts for both squares (a 5 ft line along a grid
 * line covers two rows). Every tie then goes one way. Just past Foundry's 0.75 px tolerance.
 */
const NUDGE = { x: 0.8, y: 0.8 };

/** A point on a grid corner, edge or centre, nudged off it; any other point as it is. */
export function nudge(point, grid) {
  const M = CONST.GRID_SNAPPING_MODES;
  const key = grid.getSnappedPoint(point, { mode: M.CENTER | edges() });
  if ( (key.x !== point.x) || (key.y !== point.y) ) return { x: point.x, y: point.y };
  return { x: point.x + NUDGE.x, y: point.y + NUDGE.y };
}

/**
 * preUpdateRegion: a placed template moved later, with the region tools, is nudged off the grid
 * point Foundry snapped it to (an aid), on its own scene's grid.
 */
export function onPreUpdateRegion(region, changes) {
  const grid = region.parent?.grid;
  if ( !region.flags.dnd5e?.activity || !changes.shapes || !templateAid("snap") || !grid || grid.isGridless ) return;
  for ( const shape of changes.shapes ) if ( PLACED.has(shape.type) ) Object.assign(shape, nudge(shape, grid));
}

function onRightPress() {
  const { x, y } = canvas.stage.pivot;
  const release = event => {
    if ( event.button !== 2 ) return;
    window.removeEventListener("pointerup", release, true);
    if ( (canvas.stage.pivot.x === x) && (canvas.stage.pivot.y === y) ) askToStop();
  };
  window.addEventListener("pointerup", release, true);
  return false;
}

/** Whether a dnd5e template is being placed. */
function isPlacing() {
  return !!placement?.previews.size && !!canvas.regions._placementContext;
}

/** Ask whether to stop placing the template; if so, cancel the placement. */
async function askToStop() {
  if ( asking || !isPlacing() ) return;
  const item = foundry.utils.escapeHTML(placement.activity.item?.name ?? "");
  asking = foundry.applications.api.DialogV2.confirm({
    window: { title: "STEADY_ROLLS.StopArea.Title" },
    content: `<p>${game.i18n.format("STEADY_ROLLS.StopArea.Content", { item })}</p>`,
    yes: { label: "STEADY_ROLLS.StopArea.Stop", icon: "fa-solid fa-forward" },
    no: { label: "STEADY_ROLLS.StopArea.Keep", icon: "fa-solid fa-bullseye", class: "bright" },
    modal: true
  });
  try {
    if ( await asking ) canvas.regions._cancelPlacement();
  } finally {
    asking = null;
  }
}

/**
 * destroyRegion: placement over, the arrows go; if cancelled, the targets come back. Foundry
 * destroys a cancelled preview while its placement is still open, a placed one after.
 */
export function onDestroyRegion(region) {
  if ( !placement?.previews.delete(region) ) return;
  if ( canvas.regions._placementContext ) placement.cancelled = true;
  if ( placement.previews.size ) return;
  if ( placement.cancelled && placement.targets ) {
    canvas.tokens.setTargets(placement.targets);
    templating = false;
  }
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
  templating = false;
  return setCardTargets(card, tokens);
}

/** dnd5e.preUseActivity: a new use, not a card's Place Template button. */
export function onPreUseTemplate(activity) {
  placing.delete(activity.uuid);
  templating = false;
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
