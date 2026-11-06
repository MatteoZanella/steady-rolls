// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Message } from "./helpers/foundry.mjs";

const MODULE = "steady-rolls";
const HP = "system.attributes.hp";

/** A damage card whose flags are written like Foundry's: after an await. */
function damageCard(author = "player") {
  const card = game.messages.add(new Message({ type: "damage", author }));
  card.setFlag = async (scope, key, value) => {
    await Promise.resolve();
    card.flags[scope] = { ...card.flags[scope], [key]: value };
  };
  return card;
}

/** An actor with hit points, which its updates change. */
function actor(uuid, { owners = ["player"], value = 30, temp = 0, max = 40 } = {}) {
  const subject = {
    uuid, token: null, testUserPermission: user => owners.includes(user.id),
    system: { attributes: { hp: { value, temp, max } }, _source: { attributes: { hp: { tempmax: 0 } } } },
    update: vi.fn(async changes => {
      subject.system.attributes.hp.value = changes[`${HP}.value`];
      subject.system.attributes.hp.temp = changes[`${HP}.temp`];
    })
  };
  actors?.set(uuid, subject);
  return subject;
}

/** Apply damage as dnd5e does: the pre hook sees the updates, the post hook follows. */
async function applyDamage(module, subject, amount, updates, origin) {
  const options = { origin };
  module.onPreApplyDamage(subject, amount, updates, options);
  await subject.update(updates);
  return module.onApplyDamage(subject, amount, options);
}

let actors;
beforeEach(() => {
  actors = new Map();
  globalThis.fromUuidSync = uuid => actors.get(uuid) ?? actor(uuid);
});

/** Wait for the applications to be written: once no other follows at once. */
const written = () => new Promise(resolve => setTimeout(resolve, 150));

describe("applied damage", () => {
  it("is recorded per application, every target of a tray in one change of the card", async () => {
    const applied = await import("../scripts/applied.mjs");
    const card = damageCard();
    const setFlag = vi.spyOn(card, "setFlag");
    await applyDamage(applied, actor("Actor.goblin"), 7, { [`${HP}.value`]: 23, [`${HP}.temp`]: 0 }, card);
    await applyDamage(applied, actor("Actor.orc"), 5, { [`${HP}.value`]: 25, [`${HP}.temp`]: 0 }, card);
    await written();
    expect(setFlag).toHaveBeenCalledTimes(1);
    expect(card.getFlag(MODULE, "applied").map(e => [e.target, e.amount])).toEqual([["Actor.goblin", 7], ["Actor.orc", 5]]);
  });

  it("is undone by taking back its changes, keeping what happened since", async () => {
    const applied = await import("../scripts/applied.mjs");
    const card = damageCard();
    const goblin = actor("Actor.goblin", { value: 30, temp: 5 });
    await applyDamage(applied, goblin, 12, { [`${HP}.value`]: 23, [`${HP}.temp`]: 0 }, card);
    await written();
    goblin.system.attributes.hp.value = 20; // Hit again by something else.
    await applied.undoDamage(card, goblin);
    expect(goblin.update).toHaveBeenLastCalledWith({ [`${HP}.value`]: 27, [`${HP}.temp`]: 5, [`${HP}.tempmax`]: 0 });
    expect(card.getFlag(MODULE, "applied")).toEqual([]);
  });

  it("is recorded by the active GM for a player who can't update the card, and only for their own actor", async () => {
    const applied = await import("../scripts/applied.mjs");
    const card = damageCard("gm");
    const gm = { query: vi.fn((name, data) => applied.onRecordQuery(data, { user: game.user })) };
    game.users.activeGM = gm;
    await applyDamage(applied, actor("Actor.pc"), 4, { [`${HP}.value`]: 26 }, card);
    await written();
    expect(card.getFlag(MODULE, "applied").map(e => e.target)).toEqual(["Actor.pc"]);
    actor("Actor.npc", { owners: [] });
    const npc = { actor: "Actor.npc", entry: { amount: 9 } };
    expect(applied.onRecordQuery({ message: card.id, add: [npc] }, { user: game.user })).toBe(false);
  });
});
