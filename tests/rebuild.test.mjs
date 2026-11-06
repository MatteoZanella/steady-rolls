// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { D20Roll, DamageRoll, Message, PoolTerm, nextFaces } from "./helpers/foundry.mjs";

const load = () => import("../scripts/rebuild.mjs");
const MODULE = "steady-rolls";

/** A d20 roll as dnd5e makes it, evaluated with the given d20 results. */
async function d20(mode = 0, ...results) {
  const roll = new D20Roll("1d20 + 5", {}, { advantageMode: mode });
  roll.configureModifiers();
  nextFaces(...results);
  return roll.evaluate();
}

/**
 * A damage roll as dnd5e makes it: parts read by Steady Rolls, then `late` parts added by a
 * listener after it, then built (critical or not), configured and evaluated.
 */
async function damage(parts, { isCritical = false, late = [], results = [] } = {}) {
  const { onPostBuildRoll, onPostDamageRollConfiguration } = await load();
  const config = { parts: [...parts], data: {} };
  onPostBuildRoll({ hookNames: ["damage"] }, config);
  config.parts.push(...late);
  const roll = new DamageRoll(config.parts.join(" + "), {}, { ...config.options, isCritical });
  onPostDamageRollConfiguration([roll]);
  nextFaces(...results);
  return roll.evaluate();
}

const values = die => die.results.map(r => r.result);

describe("dice identity", () => {
  it("lists a roll's dice in order, or none when a die can't be tracked", async () => {
    const { diceOf } = await load();
    const roll = new Roll("1d8 + 2d6 + 3");
    expect(diceOf(roll).map(d => d.faces)).toEqual([8, 6]);
    roll.terms.push(new PoolTerm());
    expect(diceOf(roll)).toBeNull();
    roll.terms[roll.terms.length - 1] = new PoolTerm({ deterministic: true });
    expect(diceOf(roll)).toHaveLength(2);
  });

});

describe("evaluateWith", () => {
  it("keeps the dice already rolled and rolls only the missing ones", async () => {
    const { buildD20, evaluateWith } = await load();
    const old = await d20(0, 7);
    const roll = buildD20(old, D20Roll.ADV_MODE.ADVANTAGE);
    nextFaces(15);
    const dice = await evaluateWith([old], [roll]);
    expect(values(roll.d20)).toEqual([7, 15]);
    expect(roll.options[MODULE].fresh).toEqual({ "u0#0": [1] });
    expect(dice.map(d => [d.faces, values(d)])).toEqual([[20, [15]]]);
  });

  it("keeps dice dropped by a switch as spares, so switching back rolls nothing", async () => {
    const { buildD20, evaluateWith } = await load();
    const { ADVANTAGE, NORMAL } = D20Roll.ADV_MODE;
    const advantage = await d20(ADVANTAGE, 7, 15);
    const normal = buildD20(advantage, NORMAL);
    expect(await evaluateWith([advantage], [normal])).toEqual([]);
    expect(values(normal.d20)).toEqual([7]);
    expect(normal.options[MODULE].spare).toEqual({ "u0#0": { first: [15], extra: [] } });
    const again = buildD20(normal, ADVANTAGE);
    expect(await evaluateWith([normal], [again])).toEqual([]);
    expect(values(again.d20)).toEqual([7, 15]);
  });

  it("rolls a replaced result anew (a reroll), or uses the value given (an undo)", async () => {
    const { buildSame, evaluateWith } = await load();
    const old = await d20(0, 3);
    const rerolled = buildSame(old);
    nextFaces(18);
    const dice = await evaluateWith([old], [rerolled], { replace: [{ "u0#0": { 0: null } }] });
    expect(values(rerolled.d20)).toEqual([18]);
    expect(dice).toHaveLength(1);
    const undone = buildSame(rerolled);
    expect(await evaluateWith([rerolled], [undone], { replace: [{ "u0#0": { 0: 3 } }] })).toEqual([]);
    expect(values(undone.d20)).toEqual([3]);
  });

  it("feeds rerolls and explosions from the old die's extra results", async () => {
    const { evaluateWith } = await load();
    const old = new Roll("1d6x");
    nextFaces(6, 4);
    await old.evaluate();
    const roll = new Roll("1d6x");
    expect(await evaluateWith([old], [roll])).toEqual([]);
    expect(values(roll.dice[0])).toEqual([6, 4]);
  });
});

describe("damage rolls", () => {
  it("switches critical keeping the dice, and every part of a normal roll", async () => {
    const { buildDamage, evaluateWith, rebuildKind } = await load();
    const normal = await damage(["1d8", "3"], { late: ["2"], results: [5] });
    expect(normal.options[MODULE].base).toBe("1d8 + 3 + 2");
    expect(rebuildKind(new Message({ type: "damage", rolls: [normal] }))).toBe("damage");
    const critical = buildDamage(normal, true);
    nextFaces(8);
    await evaluateWith([normal], [critical]);
    expect(critical.formula).toBe("2d8 + 3 + 2");
    expect(values(critical.dice[0])).toEqual([5, 8]);
    const back = buildDamage(critical, false);
    expect(await evaluateWith([critical], [back])).toEqual([]);
    expect(back.total).toBe(10);
  });

  it("keeps a roll made critical switchable when its base rebuilds it", async () => {
    const { buildDamage, evaluateWith, isFixed, rebuildKind } = await load();
    const critical = await damage(["1d8", "3"], { isCritical: true, results: [2, 6] });
    const message = new Message({ type: "damage", rolls: [critical] });
    expect(rebuildKind(message)).toBe("damage");
    expect(isFixed(message)).toBe(false);
    const normal = buildDamage(critical, false);
    await evaluateWith([critical], [normal]);
    expect(normal.formula).toBe("1d8 + 3");
    expect(values(normal.dice[0])).toEqual([2]);
  });

  it("keeps a roll made critical as rolled when a part was added after its base was read", async () => {
    const { isFixed, rebuildKind } = await load();
    const critical = await damage(["1d8", "3"], { isCritical: true, late: ["2"] });
    const message = new Message({ type: "damage", rolls: [critical] });
    expect(critical.options[MODULE].base).toBeUndefined();
    expect(isFixed(message)).toBe(true);
    expect(rebuildKind(message)).toBeNull();
  });
});

describe("rebuildKind", () => {
  it("allows d20 rolls of attacks, checks and saves, until their result is applied", async () => {
    const { rebuildKind } = await load();
    const roll = await d20(0, 10);
    expect(rebuildKind(new Message({ type: "attack", rolls: [roll] }))).toBe("d20");
    expect(rebuildKind(new Message({ type: "save", rolls: [roll], system: { outcome: "success" } }))).toBeNull();
    expect(rebuildKind(new Message({ type: "save", rolls: [roll], system: { type: "death" } }))).toBeNull();
    const initiative = new Message({ type: "check", rolls: [roll], flags: { core: { initiativeRoll: true } } });
    expect(rebuildKind(initiative)).toBeNull();
    expect(rebuildKind(new Message({ type: "attack", rolls: [] }))).toBeNull();
    expect(rebuildKind(new Message({ type: "base", rolls: [roll] }))).toBeNull();
  });
});

describe("changeRolls", () => {
  async function setup() {
    const module = await load();
    const message = game.messages.add(new Message({ type: "attack", rolls: [await d20(0, 7)] }));
    const build = vi.fn(async current => {
      const roll = module.buildD20(current[0], D20Roll.ADV_MODE.ADVANTAGE);
      nextFaces(12);
      return { rolls: [roll], dice: await module.evaluateWith(current, [roll]) };
    });
    return { ...module, message, build };
  }

  it("saves the new rolls, with hooks before and after", async () => {
    const { changeRolls, message, build } = await setup();
    const before = vi.fn();
    const after = vi.fn();
    Hooks.on("steady-rolls.preChangeRolls", before);
    Hooks.on("steady-rolls.changeRolls", after);
    const previous = message.rolls;
    expect(await changeRolls(message, "advantage", build)).toMatchObject({ message, masked: false });
    expect(values(message.rolls[0].d20)).toEqual([7, 12]);
    expect(before).toHaveBeenCalledWith(message, expect.any(Array), "advantage");
    expect(after).toHaveBeenCalledWith(message, previous, "advantage");
  });

  it("lets a hook cancel the change", async () => {
    const { changeRolls, message, build } = await setup();
    const update = vi.spyOn(message, "update");
    Hooks.on("steady-rolls.preChangeRolls", () => false);
    expect(await changeRolls(message, "advantage", build)).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it("drops a change asked while another one runs", async () => {
    const { changeRolls, message, build } = await setup();
    let release;
    const slow = vi.fn(async current => {
      await new Promise(resolve => release = resolve);
      return build(current);
    });
    const first = changeRolls(message, "advantage", slow);
    expect(await changeRolls(message, "reroll", build)).toBeNull();
    expect(build).not.toHaveBeenCalled();
    release();
    expect(await first).not.toBeNull();
  });

  it("doesn't save over rolls changed meanwhile, by another user", async () => {
    const { changeRolls, message, build } = await setup();
    const changed = vi.fn(async current => {
      const result = await build(current);
      message.rolls = [await d20(0, 1)];
      return result;
    });
    expect(await changeRolls(message, "advantage", changed)).toBeNull();
    expect(ui.notifications.warn).toHaveBeenCalledWith("STEADY_ROLLS.Changed", { localize: true });
    expect(values(message.rolls[0].d20)).toEqual([1]);
  });

  it("changes nothing for a user who can't change the message, or when the build gives nothing", async () => {
    const { changeRolls, message, build } = await setup();
    message.author = "someone else";
    expect(await changeRolls(message, "advantage", build)).toBeNull();
    expect(build).not.toHaveBeenCalled();
    message.author = game.user.id;
    expect(await changeRolls(message, "advantage", async () => null)).toBeNull();
  });
});

describe("a change by the owner of the actor who rolled", () => {
  const roller = owners => ({ testUserPermission: user => owners.includes(user.id) });

  it("is saved by the GM, only the rolls and the module's flags", async () => {
    const { onSaveRollsQuery } = await import("../scripts/rebuild.mjs");
    const message = game.messages.add(new Message({ author: "gm" }));
    message.getAssociatedActor = () => roller(["player"]);
    expect(await onSaveRollsQuery({ message: message.id, data: { content: "forged" } }, { user: game.user })).toBe(false);
    expect(await onSaveRollsQuery({ message: message.id, data: { rolls: [], "flags.steady-rolls.rolling": 1 } }, { user: game.user })).toBe(true);
    message.getAssociatedActor = () => roller([]);
    expect(await onSaveRollsQuery({ message: message.id, data: { rolls: [] } }, { user: game.user })).toBe(false);
  });
});
