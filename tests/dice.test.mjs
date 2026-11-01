import { describe, expect, it, vi } from "vitest";
import { Message } from "./helpers/foundry.mjs";

const MODULE = "steady-rolls";

async function load({ diceSoNice = true, immediate = false } = {}) {
  (await import("../scripts/settings.mjs")).registerSettings();
  game.settings.register("dice-so-nice", "immediatelyDisplayChatMessages", { default: immediate });
  if ( diceSoNice ) game.dice3d = {};
  return import("../scripts/dice.mjs");
}

/** A message being created, with dice or not. */
function creating(type, dice = true) {
  return new Message({ type, rolls: [{ dice: dice ? [{}] : [] }], sound: "dice.wav" });
}

describe("isRolling", () => {
  it("is true from the mark until the dice land, and for 30 seconds at most", async () => {
    const { isRolling } = await load();
    const marked = since => new Message({ flags: { [MODULE]: { rolling: since } } });
    expect(isRolling(marked(game.time.serverTime - 1000))).toBe(true);
    expect(isRolling(marked(game.time.serverTime - 31_000))).toBe(false);
    expect(isRolling(new Message())).toBe(false);
    expect(isRolling(undefined)).toBe(false);
  });
});

describe("markRolling", () => {
  it("marks rolls with dice while Dice So Nice holds results back, and drops their sound", async () => {
    const { markRolling } = await load();
    const attack = creating("attack");
    markRolling(attack);
    expect(attack.getFlag(MODULE, "rolling")).toBe(game.time.serverTime);
    expect(attack.sound).toBeNull();
  });

  it("leaves recharges, rolls without dice, and Dice So Nice showing results at once", async () => {
    const { markRolling } = await load();
    for ( const message of [creating("recharge"), creating("damage", false)] ) {
      markRolling(message);
      expect(message.getFlag(MODULE, "rolling")).toBeUndefined();
    }
    const immediate = await load({ immediate: true });
    const attack = creating("attack");
    immediate.markRolling(attack);
    expect(attack.getFlag(MODULE, "rolling")).toBeUndefined();
  });
});

describe("maskRolling", () => {
  function card(...rolls) {
    document.body.innerHTML = `<div class="card">${rolls.map(changed => `
      <div><button class="dice-roll" ${changed ? "data-steady-rolls-changed" : ""}>
        <span class="d20die" ${changed ? "data-steady-rolls-new" : ""}>7</span><span class="total">12</span>
      </button>
      <div class="roll-breakdown"><section class="tooltip-part" ${changed ? "data-steady-rolls-new" : ""}>
        <ol class="dice-rolls"><li class="roll max" ${changed ? "data-steady-rolls-new" : ""}>7</li></ol>
        <div class="total"><span class="value">7</span></div>
      </section></div></div>`).join("")}
      <damage-application></damage-application>
    </div>`;
    return document.querySelector(".card");
  }
  const rolling = () => new Message({ flags: { [MODULE]: { rolling: game.time.serverTime } } });

  it("hides every result of a new roll, its breakdown and its applied damage", async () => {
    const { maskRolling } = await load();
    const root = card(false);
    maskRolling(rolling(), root);
    const button = root.querySelector("button.dice-roll");
    expect(button.disabled).toBe(true);
    expect(button.classList).toContain("steady-rolls-rolling");
    expect(root.querySelector(".total").textContent).not.toContain("12");
    expect(root.querySelector(".d20die").classList).toContain("steady-rolls-tumbling");
    expect(root.querySelector(".roll-breakdown")).toBeNull();
    expect(root.querySelector("damage-application")).toBeNull();
  });

  it("after a change, hides only the changed roll's new dice and keeps the breakdown", async () => {
    const { maskRolling } = await load();
    const root = card(false, true);
    maskRolling(rolling(), root);
    const [kept, changed] = root.querySelectorAll("button.dice-roll");
    expect(kept.disabled).toBe(false);
    expect(changed.disabled).toBe(true);
    const [, newDie] = root.querySelectorAll(".roll-breakdown li.roll");
    expect(root.querySelectorAll(".roll-breakdown")).toHaveLength(2);
    expect(newDie.classList).toContain("steady-rolls-tumbling");
    expect(newDie.classList).not.toContain("max");
    expect(newDie.textContent.trim()).toBe("");
  });

  it("leaves a message whose dice have landed", async () => {
    const { maskRolling } = await load();
    const root = card(false);
    maskRolling(new Message(), root);
    expect(root.querySelector("button.dice-roll").disabled).toBe(false);
  });
});

describe("playDice", () => {
  /** A roll this user just made, marked rolling, with one die. */
  function rolled(type, flags = {}) {
    const message = game.messages.add(new Message({
      type, author: game.user.id, rolls: [{ dice: [`${type} die`] }],
      flags: { [MODULE]: { rolling: game.time.serverTime, ...flags } },
      activity: { damage: { parts: [["1d8"]] } }
    }));
    return message;
  }

  async function always() {
    const dice = await load();
    await game.settings.set(MODULE, "autoDamage", "always");
    await game.settings.set(MODULE, "fastForward", { damage: true });
    game.dice3d.animateRoll = vi.fn(async () => {});
    return dice;
  }

  it("throws an attack with its automatic damage, then reveals both", async () => {
    const { playDice, diceLanded } = await always();
    const attack = rolled("attack");
    playDice(attack);
    expect(game.dice3d.animateRoll).not.toHaveBeenCalled();
    const damage = rolled("damage", { attack: attack.id });
    playDice(damage);
    expect(game.dice3d.animateRoll).toHaveBeenCalledWith({ dice: ["attack die", "damage die"] }, attack);
    await diceLanded(damage);
    expect([attack, damage].map(m => m.getFlag(MODULE, "rolling"))).toEqual([undefined, undefined]);
  });

  it("throws a waiting attack alone when its damage isn't rolled", async () => {
    const { playDice, releaseDice } = await always();
    const attack = rolled("attack");
    playDice(attack);
    releaseDice(attack);
    expect(game.dice3d.animateRoll).toHaveBeenCalledWith({ dice: ["attack die"] }, attack);
  });

  it("leaves rolls made by other users, and rolls not marked, to their own client", async () => {
    const { playDice } = await always();
    const theirs = rolled("damage");
    theirs.author = "someone else";
    playDice(theirs);
    playDice(game.messages.add(new Message({ type: "damage", author: game.user.id })));
    expect(game.dice3d.animateRoll).not.toHaveBeenCalled();
  });
});
