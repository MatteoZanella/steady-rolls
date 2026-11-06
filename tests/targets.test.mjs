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
  /** A dnd5e template preview, as Foundry draws it while placing. */
  const preview = () => ({ isPreview: true, document: { ...region, flags: { core: { MeasuredTemplate: true } } } });

  beforeEach(() => {
    scene.tokens = [token("foe", HOSTILE)];
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
