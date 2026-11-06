// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { Message } from "./helpers/foundry.mjs";

const MODULE = "steady-rolls";
const token = id => ({ uuid: `Scene.s.Token.${id}`, actor: {}, actorLink: false });
const descriptor = id => ({ token: `Scene.s.Token.${id}` });

/** A usage card of this activity type, with its rolls by type. */
function usage(type, { author = "player", targets = [], rolls = {} } = {}) {
  return game.messages.add(new Message({
    author, activity: { type }, system: { rendersSummaries: true, targets },
    getAssociatedRolls: kind => rolls[kind] ?? []
  }));
}

async function load() {
  const settings = await import("../scripts/settings.mjs");
  settings.registerSettings();
  return import("../scripts/follow.mjs");
}

beforeEach(() => {
  dnd5e.dataModels.chatMessage = { fields: { TargetsField: {
    getDescriptors: tokens => tokens.map(t => ({ token: t.uuid }))
  } } };
  game.settings.settings.set("dnd5e.chatCardSummary", { default: true });
});

describe("the card that follows your targets", () => {
  it("is your newest card with targets, not a check's or someone else's", async () => {
    const { newestCard } = await load();
    const mine = usage("save");
    usage("check");
    usage("attack", { author: "other" });
    expect(newestCard()).toBe(mine);
  });
});

describe("a target change", () => {
  it("adds and removes tokens freely until damage is applied", async () => {
    const { changedTargets } = await load();
    const attack = new Message({ type: "attack", system: { targets: [descriptor("wrong")] } });
    const batch = new Map([[token("wrong"), false], [token("right"), true]]);
    expect(changedTargets(attack, batch, false)).toEqual({ targets: [descriptor("right")], provisional: [] });
  });

  it("once damage is applied, removes no one and adds tokens for now", async () => {
    const { changedTargets } = await load();
    const attack = new Message({ type: "attack", system: { targets: [descriptor("hit")] } });
    attack.flags[MODULE] = { provisional: ["Scene.s.Token.earlier"] };
    attack.system.targets.push(descriptor("earlier"));
    const batch = new Map([[token("hit"), false], [token("earlier"), false], [token("next"), true]]);
    expect(changedTargets(attack, batch, true)).toEqual({
      targets: [descriptor("hit"), descriptor("next")], provisional: ["Scene.s.Token.next"]
    });
  });

  it("keeps a token that saved on a save card when it's untargeted", async () => {
    const { changedTargets } = await load();
    const card = new Message({ system: { targets: [descriptor("saved"), descriptor("other")] } });
    const batch = new Map([[token("saved"), false], [token("other"), false]]);
    expect(changedTargets(card, batch, false, new Set(["Scene.s.Token.saved"])).targets).toEqual([descriptor("saved")]);
  });

  it("is shared by the card, its first attack and that attack's damage, not a later strike's", async () => {
    const { sharing } = await load();
    const first = new Message({ type: "attack" });
    const later = new Message({ type: "attack", flags: { [MODULE]: { strike: 2 } } });
    const ofFirst = new Message({ type: "damage", flags: { [MODULE]: { attack: first.id } } });
    const ofLater = new Message({ type: "damage", flags: { [MODULE]: { attack: later.id } } });
    const card = usage("attack", { rolls: { attack: [first, later], damage: [ofFirst, ofLater] } });
    later.system = { origin: card };
    expect(sharing(card)).toEqual([card, first, ofFirst]);
  });
});

describe("making another card", () => {
  it("removes from the card before those added for now who took no damage from it", async () => {
    const { onCreateCard } = await load();
    globalThis.fromUuidSync = () => null;
    const damage = new Message({ type: "damage", system: { targets: [] } });
    damage.flags[MODULE] = { applied: [{ target: "Scene.s.Token.hurt", amount: 5 }] };
    const previous = usage("damage", { targets: [descriptor("hit"), descriptor("hurt"), descriptor("next")], rolls: { damage: [damage] } });
    previous.flags[MODULE] = { provisional: ["Scene.s.Token.hurt", "Scene.s.Token.next"] };
    await onCreateCard(usage("attack"));
    expect(previous.system.targets).toEqual([descriptor("hit"), descriptor("hurt")]);
    expect(previous.getFlag(MODULE, "provisional")).toEqual([]);
  });
});
