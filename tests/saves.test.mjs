// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Message } from "./helpers/foundry.mjs";

class Actor {
  constructor(uuid, owner = true) { Object.assign(this, { uuid, name: uuid, isOwner: owner }); }
  getActiveTokens() { return []; }
}

/** A token on the canvas, owned or not. */
function token(id, owner = true) {
  const actor = new Actor(`Actor.${id}`, owner);
  return { actor, name: id, document: { uuid: `Scene.s.Token.${id}`, isOwner: owner } };
}

/** dnd5e's usage card model, enough to subclass: the Save button handler reads evaluatedTargets. */
class Usage {
  constructor(parent) { this.parent = parent; }
  get evaluatedTargets() { return "dnd5e"; }
  _onClickAction() { this.rolled = this.evaluatedTargets; }
  _getButtonGroupContextOptions() { return [{ onClick: () => (this.rolled = this.evaluatedTargets) }]; }
}

/** A save card whose saves were rolled by these token uuids. */
function saveCard(rolledBy = []) {
  const card = new Message({ activity: { type: "save" }, system: { rendersSummaries: true, targets: [] } });
  card.getAssociatedRolls = () => rolledBy.map(uuid => ({ getAssociatedToken: () => ({ uuid }) }));
  return card;
}

let model;
async function load(card) {
  const { withSaveList } = await import("../scripts/saves.mjs");
  model = new (withSaveList(Usage))(card);
  return model;
}
const click = (dataset = {}) => model._onClickAction({}, { dataset: { action: "rollSave", ...dataset } });

beforeEach(() => {
  Object.assign(globalThis, {
    Actor,
    canvas: { tokens: { controlled: [] } },
    fromUuidSync: uuid => ({ object: { uuid } })
  });
});

describe("the Save button", () => {
  it("rolls for the selected tokens this user owns, not the card's targets", async () => {
    await load(saveCard());
    const mine = token("mine");
    canvas.tokens.controlled = [mine, token("theirs", false)];
    click();
    expect(model.rolled).toEqual([mine]);
  });

  it("rolls for the user's character when nothing is selected, if it has a token on the scene", async () => {
    await load(saveCard());
    game.user.character = new Actor("Actor.pc");
    expect(model.evaluatedTargets).toEqual([]);
    const pc = token("pc");
    game.user.character.getActiveTokens = () => [pc];
    click();
    expect(model.rolled).toEqual([pc]);
  });

  it("skips tokens that already rolled, and rolls nothing if all did", async () => {
    const done = token("done");
    const fresh = token("fresh");
    await load(saveCard([done.document.uuid]));
    canvas.tokens.controlled = [done, fresh];
    click();
    expect(model.rolled).toEqual([fresh]);

    model.rolled = undefined;
    canvas.tokens.controlled = [done];
    click();
    expect(model.rolled).toBeUndefined();
    expect(ui.notifications.warn).toHaveBeenCalledWith("STEADY_ROLLS.Save.AllRolled", { localize: true });
  });
});

describe("a row's roll button", () => {
  it("rolls for that row's token only, whatever is selected", async () => {
    await load(saveCard());
    canvas.tokens.controlled = [token("mine")];
    click({ steadyRollsSave: "Scene.s.Token.goblin" });
    expect(model.rolled).toEqual([{ uuid: "Scene.s.Token.goblin" }]);
  });

  it("does the same from a grouped button's menu", async () => {
    await load(saveCard());
    ui.context = { target: { dataset: { steadyRollsSave: "Scene.s.Token.goblin" } } };
    model._getButtonGroupContextOptions()[0].onClick();
    expect(model.rolled).toEqual([{ uuid: "Scene.s.Token.goblin" }]);
  });
});

it("leaves other activities' cards to dnd5e", async () => {
  const card = new Message({ activity: { type: "check" } });
  await load(card);
  canvas.tokens.controlled = [token("mine")];
  click();
  expect(model.rolled).toBe("dnd5e");
});

describe("joining a save", () => {
  const doc = id => ({ uuid: `Scene.s.Token.${id}`, id, parent: "scene" });
  const save = tokenDoc => new Message({ type: "save", getAssociatedToken: () => tokenDoc });

  function setup({ targets, saves, damage }) {
    dnd5e.dataModels.chatMessage = { fields: { TargetsField: {
      getDescriptors: tokens => tokens.map(t => ({ token: t.uuid }))
    } } };
    globalThis.canvas = { scene: "scene", tokens: { setTargets: vi.fn() } };
    game.users.activeGM = { isSelf: true };
    globalThis.fromUuidSync = uuid => doc(uuid.split(".").pop());
    game.settings.settings.set("dnd5e.chatCardSummary", { default: true });
    const card = game.messages.add(new Message({ activity: { type: "save" }, system: { rendersSummaries: true, targets } }));
    card.getAssociatedRolls = type => ({ save: saves, damage })[type] ?? [];
    for ( const message of [...saves, ...damage] ) message.system.origin = card;
    return card;
  }

  it("adds a token that saved without being targeted, and targets it for the caster on their newest card", async () => {
    const { onSaveCardRoll } = await import("../scripts/saves.mjs");
    const joiner = save(doc("joiner"));
    const card = setup({ targets: [{ token: "Scene.s.Token.target" }], saves: [joiner], damage: [] });
    await onSaveCardRoll(joiner);
    expect(card.system.targets).toEqual([{ token: "Scene.s.Token.target" }, { token: "Scene.s.Token.joiner" }]);
    expect(canvas.tokens.setTargets).toHaveBeenCalledWith(["joiner"], { mode: "acquire" });
  });

  it("keeps both of two saves made together, though the card's update takes time", async () => {
    const { onSaveCardRoll } = await import("../scripts/saves.mjs");
    const saves = [save(doc("one")), save(doc("two"))];
    const card = setup({ targets: [], saves, damage: [] });
    const update = card.update.bind(card);
    const delays = [20, 0]; // The first update lands last, if both are under way.
    card.update = (...args) => new Promise(resolve => setTimeout(resolve, delays.shift())).then(() => update(...args));
    let joined = 1; // The second save is made while the first joins.
    card.getAssociatedRolls = type => ((type === "save") ? saves.slice(0, joined) : []);
    const first = onSaveCardRoll(saves[0]);
    joined = 2;
    await Promise.all([first, onSaveCardRoll(saves[1])]);
    expect(card.system.targets.map(t => t.token)).toEqual(["Scene.s.Token.one", "Scene.s.Token.two"]);
  });

  it("gives the damage the card's targets from the start, before anyone saves, and as they change", async () => {
    const { onSaveCardRoll, onSaveCardTargets } = await import("../scripts/saves.mjs");
    const damage = new Message({ type: "damage", system: { targets: [] } });
    const card = setup({ targets: [{ token: "Scene.s.Token.waiting" }], saves: [], damage: [damage] });
    await onSaveCardRoll(damage); // Rolled at once, as automatic save damage is.
    expect(damage.system.targets).toEqual([{ token: "Scene.s.Token.waiting" }]);
    card.system.targets = [{ token: "Scene.s.Token.waiting" }, { token: "Scene.s.Token.followed" }];
    await onSaveCardTargets(card, { system: { targets: card.system.targets } });
    expect(damage.system.targets).toEqual(card.system.targets);
  });
});

describe("the save list", () => {
  it("lists targets and anyone else who saved by name, rolled or not", async () => {
    const { saveRows } = await import("../scripts/saves.mjs");
    dnd5e.dataModels.chatMessage = { fields: { TargetsField: { resolve: () => ({}) } } };
    const save = (name, hidden = false) => game.messages.add(new Message({
      type: "save", alias: name, getAssociatedToken: () => ({ uuid: name, name, hidden })
    }));
    const bruna = save("Bruna");
    const zed = save("Zed");
    const card = new Message({ system: { targets: [{ token: "Carl", name: "Carl" }, { token: "Bruna", name: "Bruna" }] } });
    card.getAssociatedRolls = () => [zed, bruna];
    const rows = saveRows(card, [{ id: zed.id }, { id: bruna.id }]);
    expect(rows.map(r => r.name)).toEqual(["Bruna", "Carl", "Zed"]);
    expect(rows.map(r => r.id ?? r.key)).toEqual([bruna.id, "Carl", zed.id]);
  });

  it("shows a save this user can't see as private", async () => {
    const { saveRows } = await import("../scripts/saves.mjs");
    dnd5e.dataModels.chatMessage = { fields: { TargetsField: { resolve: () => ({}) } } };
    const lurker = game.messages.add(new Message({
      type: "save", alias: "Lurker", getAssociatedToken: () => ({ uuid: "lurker", name: "Lurker", hidden: true })
    }));
    const card = new Message({ system: { targets: [] } });
    card.getAssociatedRolls = () => [lurker];
    expect(saveRows(card, [])).toEqual([{ key: "lurker", name: "Lurker", private: true }]);
  });
});
