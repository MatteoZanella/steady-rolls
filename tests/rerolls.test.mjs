import { describe, expect, it, vi } from "vitest";
import { D20Roll, Message, nextFaces } from "./helpers/foundry.mjs";

const MODULE = "steady-rolls";

async function load(who) {
  (await import("../scripts/settings.mjs")).registerSettings();
  if ( who ) await game.settings.set(MODULE, "rerolls", who);
  return import("../scripts/rerolls.mjs");
}

/** An attack rolled by this user, its d20 showing `result`. */
async function attack(result) {
  const roll = new D20Roll("1d20 + 5", {}, { advantageMode: 0 });
  roll.configureModifiers();
  nextFaces(result);
  await roll.evaluate();
  return game.messages.add(new Message({ type: "attack", author: game.user.id, rolls: [roll], flavor: "Longsword" }));
}

/** The attack's card with its breakdown, as dnd5e renders it, decorated. */
async function render(message) {
  const { decorateRerolls } = await import("../scripts/rerolls.mjs");
  const results = message.rolls[0].d20.results.filter(r => r.active || r.discarded);
  document.body.innerHTML = `<div class="card"><div class="roll-breakdown"><section class="tooltip-part">
    <ol class="dice-rolls">${results.map(r => `<li class="roll die d20">${r.result}</li>`).join("")}</ol>
  </section></div></div>`;
  const root = document.querySelector(".card");
  decorateRerolls(message, root);
  return root;
}

const result = message => message.rolls[0].d20.results[0].result;
const items = root => [...root.querySelectorAll("li.roll")];

describe("rerolling a die", () => {
  it("rolls the die again, keeps the old value crossed out, and posts an info card as the user", async () => {
    await load();
    const message = await attack(3);
    const [die] = items(await render(message));
    expect(die.classList).toContain("steady-rolls-rerollable");
    nextFaces(17);
    die.click();
    await vi.waitFor(() => expect(ChatMessage.implementation.create).toHaveBeenCalled());
    expect(result(message)).toBe(17);
    const [card] = ChatMessage.implementation.create.mock.calls[0];
    expect(card).toMatchObject({
      type: `${MODULE}.reroll`, speaker: { alias: game.user.name },
      system: { message: message.id, roll: 0, faces: 20, before: 3, after: 17 }
    });
    const [old, current] = items(await render(message));
    expect(old.textContent).toBe("3");
    expect(old.classList).toContain("steady-rolls-rerolled");
    expect(current.textContent).toBe("17");
  });

  it("goes back to an old value when it is clicked, undoing the rerolls after it", async () => {
    await load();
    const message = await attack(3);
    nextFaces(9);
    items(await render(message))[0].click();
    await vi.waitFor(() => expect(result(message)).toBe(9));
    nextFaces(14);
    items(await render(message))[1].click();
    await vi.waitFor(() => expect(result(message)).toBe(14));
    const [first] = items(await render(message));
    expect(first.classList).toContain("steady-rolls-undoable");
    first.click();
    await vi.waitFor(() => expect(result(message)).toBe(3));
    expect(message.rolls[0].options[MODULE].rerolls).toEqual([]);
    expect(items(await render(message))).toHaveLength(1);
  });

  it("refuses an undo once the die no longer shows its reroll's value", async () => {
    await load();
    const message = await attack(3);
    nextFaces(9);
    items(await render(message))[0].click();
    await vi.waitFor(() => expect(result(message)).toBe(9));
    const [old] = items(await render(message));
    message.rolls[0].d20.results[0].result = 11;
    old.click();
    const refused = ["STEADY_ROLLS.Reroll.CannotUndo", { localize: true }];
    await vi.waitFor(() => expect(ui.notifications.warn).toHaveBeenCalledWith(...refused));
    expect(result(message)).toBe(11);
  });

  it("follows the Rerolls setting and Foundry's permissions", async () => {
    await load("gm");
    const mine = await attack(3);
    expect(items(await render(mine))[0].classList).not.toContain("steady-rolls-rerollable");
    game.user.isGM = true;
    const theirs = await attack(3);
    theirs.author = "someone else";
    expect(items(await render(theirs))[0].classList).toContain("steady-rolls-rerollable");
    await game.settings.set(MODULE, "rerolls", "off");
    expect(items(await render(theirs))[0].classList).not.toContain("steady-rolls-rerollable");
  });
});

describe("info card", () => {
  async function card(who) {
    const { rerollCardModel } = await load(who);
    const message = await attack(3);
    nextFaces(9);
    items(await render(message))[0].click();
    await vi.waitFor(() => expect(ChatMessage.implementation.create).toHaveBeenCalled());
    const [{ system }] = ChatMessage.implementation.create.mock.calls[0];
    const Model = rerollCardModel();
    return { message, model: new Model(system), Model };
  }

  it("shows the die before and after, crossed out where replaced, with Undo for who can reroll", async () => {
    const { model, Model } = await card();
    expect(Model.metadata.template).toBe(`modules/${MODULE}/templates/reroll-card.hbs`);
    expect(Model.metadata.actions.undo).toBeTypeOf("function");
    const context = await model._prepareContext({});
    expect(context).toMatchObject({ undone: false, label: "Longsword", undoable: true });
    expect(context.before).toEqual({ classes: "roll die d20 steady-rolls-rerolled", value: 3 });
    expect(context.after).toEqual({ classes: "roll die d20", value: 9 });
  });

  it("reads as undone once the roll no longer has the reroll, and loses its Undo", async () => {
    const { message, model } = await card();
    message.rolls[0].options[MODULE].rerolls = [];
    const context = await model._prepareContext({});
    expect(context.undone).toBe(true);
    expect(context.undoable).toBe(false);
    expect(context.note).toContain("STEADY_ROLLS.Reroll.Undone");
    expect(context.after.classes).toContain("steady-rolls-rerolled");
  });

  it("is redrawn when its roll changes, other cards are not", async () => {
    const { refreshRerollCards } = await load();
    const target = new Message();
    const reroll = game.messages.add(new Message({ type: `${MODULE}.reroll`, system: { message: target.id } }));
    game.messages.add(new Message({ type: `${MODULE}.reroll`, system: { message: "other" } }));
    refreshRerollCards(target);
    expect(ui.chat.updateMessage.mock.calls.map(([m]) => m)).toEqual([reroll]);
  });
});
