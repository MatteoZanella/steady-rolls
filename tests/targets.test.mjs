// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Message } from "./helpers/foundry.mjs";

const DISPOSITIONS = { SECRET: -2, HOSTILE: -1, NEUTRAL: 0, FRIENDLY: 1 };
const { HOSTILE, NEUTRAL, FRIENDLY, SECRET } = DISPOSITIONS;

let scene;
const region = { id: "area" };

/** A token on the scene; `inside` the placed area or not. */
function token(id, disposition, { inside = true, hidden = false } = {}) {
  return { id, disposition, hidden, actor: {}, testInsideRegion: r => inside && (r === region) };
}

function activity(affects, casterDisposition = FRIENDLY) {
  return {
    uuid: "Item.spell.Activity.save",
    target: { affects: { type: affects } },
    getUsageToken: () => ({ disposition: casterDisposition })
  };
}

/** Click a usage card's Place Template button. */
async function clickPlaceTemplate(card) {
  const { withTemplateTargets } = await import("../scripts/targets.mjs");
  class Usage { constructor(parent) { this.parent = parent; } _onClickAction() {} getButton() {} }
  new (withTemplateTargets(Usage))(card)._onClickAction({ button: 0 }, { dataset: { action: "placeTemplate" } });
}

async function load() {
  const settings = await import("../scripts/settings.mjs");
  settings.registerSettings();
  return import("../scripts/targets.mjs");
}

beforeEach(() => {
  scene = { tokens: [] };
  region.parent = scene;
  globalThis.CONST = { TOKEN_DISPOSITIONS: DISPOSITIONS };
  globalThis.canvas = { scene, tokens: { setTargets: vi.fn() } };
  dnd5e.dataModels.chatMessage = { fields: { TargetsField: { getDescriptors: tokens => tokens.map(t => ({ token: t.id })) } } };
});

describe("tokensInside", () => {
  beforeEach(() => {
    scene.tokens = [
      token("friend", FRIENDLY), token("foe", HOSTILE), token("bystander", NEUTRAL),
      token("secret", SECRET), token("hidden", HOSTILE, { hidden: true }), token("away", HOSTILE, { inside: false })
    ];
  });
  const ids = tokens => tokens.map(t => t.id);

  it("takes every creature inside when the activity affects any", async () => {
    const { tokensInside } = await load();
    expect(ids(tokensInside(activity("creature"), [region]))).toEqual(["friend", "foe", "bystander"]);
  });

  it("takes allies or enemies by disposition, relative to the user's token", async () => {
    const { tokensInside } = await load();
    expect(ids(tokensInside(activity("ally"), [region]))).toEqual(["friend"]);
    expect(ids(tokensInside(activity("enemy"), [region]))).toEqual(["foe"]);
    expect(ids(tokensInside(activity("enemy", HOSTILE), [region]))).toEqual(["friend"]);
  });

  it("takes hidden tokens for the GM only", async () => {
    const { tokensInside } = await load();
    game.user.isGM = true;
    expect(ids(tokensInside(activity("enemy"), [region]))).toEqual(["foe", "hidden"]);
  });
});

describe("item card targets", () => {
  beforeEach(() => {
    scene.tokens = [token("foe", HOSTILE)];
  });

  it("go to the card whose Place Template button was clicked", async () => {
    const { onPostCreateTemplate } = await load();
    const spell = activity("creature");
    const older = game.messages.add(new Message({ activity: spell }));
    game.messages.add(new Message({ activity: spell }));
    await clickPlaceTemplate(older);
    await onPostCreateTemplate(spell, [region]);
    expect(canvas.tokens.setTargets).toHaveBeenCalledWith(["foe"]);
    expect(older.system.targets).toEqual([{ token: "foe" }]);
  });

  it("go to a new use's card, not one whose placement was cancelled", async () => {
    const { onPostCreateTemplate, onPostUseTemplate, onPreUseTemplate } = await load();
    const spell = activity("creature");
    const cancelled = game.messages.add(new Message({ activity: spell }));
    await clickPlaceTemplate(cancelled);
    onPreUseTemplate(spell);
    const card = game.messages.add(new Message({ activity: spell }));
    await onPostCreateTemplate(spell, [region]);
    await onPostUseTemplate(spell, {}, { message: card, templates: [region] });
    expect(cancelled.system.targets).toBeUndefined();
    expect(card.system.targets).toEqual([{ token: "foe" }]);
  });
});

describe("the card's target list", () => {
  it("goes back to Targeted once the template's targets arrive, if dnd5e set it to Selected", async () => {
    const { onPostUseTemplate } = await load();
    const { onTargetsUpdate: onUpdateCardTargets } = await import("../scripts/common.mjs");
    scene.tokens = [token("foe", HOSTILE)];
    Hooks.on("updateChatMessage", onUpdateCardTargets);
    const card = game.messages.add(new Message({ _targetState: { mode: "selected" } }));
    await onPostUseTemplate(activity("creature"), {}, { message: card, templates: [region] });
    expect(card._targetState.mode).toBe("");
    card._targetState.mode = "selected";
    await card.update({ "system.targets": [] });
    expect(card._targetState.mode).toBe("selected");
  });
});

describe("placing a template", () => {
  /** A template preview as dnd5e has Foundry draw it: not restricted. */
  const preview = () => ({ isPreview: true, renderFlags: { set: vi.fn() }, document: {
    parent: scene, flags: { core: { MeasuredTemplate: true } }, shapes: [], _source: { shapes: [] }, restriction: { enabled: false },
    toObject: () => ({ shapes: [] }),
    updateSource(changes) { Object.assign(this, changes); },
    updateShapeConstraints() { this.constrained = !!this.restriction?.enabled; }
  } });

  beforeEach(() => {
    scene.tokens = [token("foe", HOSTILE)];
    canvas.level = { id: "ground" };
    game.user.targets = new Set([{ id: "ally" }]);
    canvas.regions = { _placementContext: {} };
  });

  it("releases the user's targets and brings them back on cancel", async () => {
    const { onDestroyRegion, onPreCreateTemplate, onRefreshRegion } = await load();
    const shown = preview();
    onPreCreateTemplate(activity("creature"));
    onRefreshRegion(shown);
    expect(canvas.tokens.setTargets).toHaveBeenLastCalledWith([]);
    onDestroyRegion(shown);
    expect(canvas.tokens.setTargets).toHaveBeenLastCalledWith(["ally"]);
  });

  it("draws the preview cut by walls, as the placed template, and marks the tokens it covers so", async () => {
    const { onPreCreateTemplate, onRefreshRegion } = await load();
    const tested = [];
    scene.tokens = [{ ...token("foe", HOSTILE), testInsideRegion: r => tested.push(r) && false }];
    const drawn = preview();
    vi.spyOn(drawn.document, "updateShapeConstraints");
    onPreCreateTemplate(activity("creature"));
    onRefreshRegion(drawn);
    onRefreshRegion(drawn); // Redrawn: restricted once.
    expect(drawn.document).toMatchObject({ restriction: { enabled: true, type: "move" }, levels: ["ground"], constrained: true });
    expect(drawn.document.updateShapeConstraints).toHaveBeenCalledTimes(1);
    expect(tested[0]).toBe(drawn.document);
  });

  it("asks before stopping on a right click, and pans on a right drag", async () => {
    const { onPreCreateTemplate, onRefreshRegion } = await load();
    const shown = preview();
    const context = { preview: shown };
    canvas.regions = { _placementContext: context, _cancelPlacement: vi.fn() };
    canvas.stage = { pivot: { x: 0, y: 0 } };
    globalThis.window = new EventTarget();
    const confirm = vi.fn(async () => true);
    foundry.applications.api.DialogV2 = { confirm };
    const release = () => window.dispatchEvent(Object.assign(new Event("pointerup"), { button: 2 }));
    onPreCreateTemplate(activity("creature"));
    onRefreshRegion(shown);
    expect(context.preSkip({})).toBe(false); // The press doesn't skip.
    expect(context.onMove({ shape: { type: "line" }, snap: false })).toBeUndefined();
    canvas.stage.pivot.x = 300; // Dragged: the map panned.
    release();
    expect(confirm).not.toHaveBeenCalled();
    context.preSkip({});
    release();
    expect(context.onMove({ shape: { type: "line" } })).toBe(false); // Held still while asking.
    await vi.waitFor(() => expect(canvas.regions._cancelPlacement).toHaveBeenCalled());
  });

  it("leaves the targets to the placed template", async () => {
    const { onDestroyRegion, onPreCreateTemplate, onRefreshRegion } = await load();
    const shown = preview();
    onPreCreateTemplate(activity("creature"));
    onRefreshRegion(shown);
    canvas.regions._placementContext = null;
    onDestroyRegion(shown);
    expect(canvas.tokens.setTargets).toHaveBeenLastCalledWith([]);
  });
});

describe("thin areas", () => {
  /** A line's preview, a square wide or thinner. */
  function linePreview(width) {
    const document = {
      flags: { core: { MeasuredTemplate: true } }, restriction: { enabled: true }, highlightMode: "coverage",
      shapes: [{ type: "line", width }], polygons: [{}],
      updateSource(changes) { Object.assign(this, changes); }
    };
    return { isPreview: true, renderFlags: { set: vi.fn() }, addChildAt: vi.fn(child => child), document };
  }

  beforeEach(() => {
    canvas.grid = { size: 100 };
    canvas.dimensions = { uiScale: 1 };
    canvas.regions = { _placementContext: null };
    game.user.targets = new Set();
    globalThis.PIXI = { Graphics: class { clear() { return this; } lineStyle() { return this; } drawShape() {} } };
  });

  it("draws a wall's preview as its shape, outlined; a wider line as dnd5e does", async () => {
    const { onPreCreateTemplate, onRefreshRegion } = await load();
    const wall = linePreview(2.5);
    const bolt = linePreview(100);
    onPreCreateTemplate(activity("creature"));
    onRefreshRegion(wall);
    onRefreshRegion(bolt);
    expect([wall.document.highlightMode, bolt.document.highlightMode]).toEqual(["shapes", "coverage"]);
    expect(wall.addChildAt).toHaveBeenCalled();
    expect(bolt.addChildAt).not.toHaveBeenCalled();
  });

  it("draws a placed template of thin lines as its shape, as its preview", async () => {
    const { onCreateTemplate } = await load();
    const wall = { highlightMode: "coverage", shapes: [{ type: "line", width: 2.5 }] };
    const bolt = { highlightMode: "coverage", shapes: [{ type: "line", width: 100 }] };
    onCreateTemplate({}, [wall, bolt]);
    expect([wall.highlightMode, bolt.highlightMode]).toEqual(["shapes", "coverage"]);
  });
});

describe("colors", () => {
  const types = (...list) => ({ types: new Set(list) });

  beforeEach(() => {
    CONFIG.DND5E.damageTypes = { fire: { color: { css: "#ff4500" } }, radiant: { color: { css: "#ffd700" } } };
    CONFIG.DND5E.healingTypes = { healing: { color: { css: "#46c252" } } };
  });

  it("takes the first damage or healing type's color", async () => {
    const { damageColor } = await load();
    expect(damageColor({ damage: { parts: [types("fire", "radiant")] } })).toBe("#ff4500");
    expect(damageColor({ damage: { parts: [types("other"), types("radiant")] } })).toBe("#ffd700");
    expect(damageColor({ healing: types("healing") })).toBe("#46c252");
    expect(damageColor({})).toBe(null);
  });

  it("colors the preview and the placed template when turned on, as it isn't by default", async () => {
    const { onCreateTemplate, onPreCreateTemplate } = await load();
    const fireball = { damage: { parts: [types("fire")] } };
    const plain = { color: "#user" };
    onPreCreateTemplate(fireball, plain);
    expect(plain.color).toBe("#user");
    await game.settings.set("steady-rolls", "templates", { colors: true });
    const config = { color: "#user" };
    const region = { color: "#user", shapes: [] };
    onPreCreateTemplate(fireball, config);
    onCreateTemplate(fireball, [region]);
    expect([config.color, region.color]).toEqual(["#ff4500", "#ff4500"]);
  });
});

describe("snapping to edges", () => {
  /** Foundry's square grid of 100 px squares: snaps to the nearest point of the modes given. */
  const grid = {
    size: 100,
    isGridless: false,
    getSnappedPoint({ x, y }, { mode }) {
      const near = [];
      for ( const dx of [0, 50, 100] ) for ( const dy of [0, 50, 100] ) {
        const px = (Math.floor(x / 100) * 100) + dx;
        const py = (Math.floor(y / 100) * 100) + dy;
        const kind = ((dx === 50) && (dy === 50)) ? 0x1 : ((dx === 50) || (dy === 50)) ? 0x2 : 0xF0;
        if ( mode & kind ) near.push({ x: px, y: py });
      }
      return near.reduce((a, b) => (Math.hypot(a.x - x, a.y - y) <= Math.hypot(b.x - x, b.y - y) ? a : b));
    }
  };

  beforeEach(() => {
    CONST.GRID_SNAPPING_MODES = { CENTER: 0x1, EDGE_MIDPOINT: 0x2, VERTEX: 0xF0 };
    canvas.grid = grid;
  });

  it("places an area on a square's corner or edge, never its centre, a pixel off the grid point", async () => {
    const { onPreCreateTemplate, onRefreshRegion } = await load();
    game.user.targets = new Set();
    canvas.level = { id: "ground" };
    const context = {};
    canvas.regions = { _placementContext: context };
    const preview = { isPreview: true, renderFlags: { set: vi.fn() }, document: {
      flags: { core: { MeasuredTemplate: true } }, shapes: [], restriction: { enabled: true }, updateSource() {}
    } };
    context.preview = preview;
    onPreCreateTemplate(activity("creature"));
    onRefreshRegion(preview);
    const shape = { type: "line", move: vi.fn() };
    expect(context.onMove({ shape, position: { x: 130, y: 140 }, snap: true })).toBe(false); // Nearer the centre.
    expect(shape.move).toHaveBeenLastCalledWith({ x: 100.8, y: 150.8 });
    expect(context.onMove({ shape, position: { x: 130, y: 140 }, snap: false })).toBeUndefined(); // Shift: Foundry's.
    expect(context.onMove({ shape: { type: "emanation" }, position: { x: 0, y: 0 }, snap: true })).toBeUndefined();
  });

  it("nudges a placed template moved onto a grid point, once", async () => {
    const { onPreUpdateRegion } = await load();
    const region = { parent: { grid }, flags: { dnd5e: { activity: "Item.x.Activity.y" } } };
    const changes = { shapes: [{ type: "circle", x: 200, y: 300 }] };
    onPreUpdateRegion(region, changes);
    expect(changes.shapes[0]).toMatchObject({ x: 200.8, y: 300.8 });
    onPreUpdateRegion(region, changes);
    expect(changes.shapes[0]).toMatchObject({ x: 200.8, y: 300.8 });
  });
});
