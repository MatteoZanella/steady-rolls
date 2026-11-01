import { describe, expect, it, vi } from "vitest";
import { D20Roll, DamageRoll, Message, nextFaces } from "./helpers/foundry.mjs";

const MODULE = "steady-rolls";

async function load() {
  (await import("../scripts/settings.mjs")).registerSettings();
  return import("../scripts/modes.mjs");
}

async function d20(mode, ...results) {
  const roll = new D20Roll("1d20 + 5", {}, { advantageMode: mode });
  roll.configureModifiers();
  nextFaces(...results);
  return roll.evaluate();
}

/** A damage roll made as dnd5e does, `late` parts added after Steady Rolls read the base. */
async function damage({ isCritical = false, late = [], results = [] } = {}) {
  const { onPostBuildRoll, onPostDamageRollConfiguration } = await import("../scripts/rebuild.mjs");
  const config = { parts: ["1d8", "3"], data: {} };
  onPostBuildRoll({ hookNames: ["damage"] }, config);
  config.parts.push(...late);
  const roll = new DamageRoll(config.parts.join(" + "), {}, { ...config.options, isCritical });
  onPostDamageRollConfiguration([roll]);
  nextFaces(...results);
  return roll.evaluate();
}

/** A card with one roll button per roll, as dnd5e renders it. */
function card(message) {
  document.body.innerHTML = `<div class="card">${message.rolls.map(() => `
    <div><button class="dice-roll"><span class="d20die"></span><span class="total"></span></button></div>`
  ).join("")}</div>`;
  return document.querySelector(".card");
}

const toggles = root => [...root.querySelectorAll(".steady-rolls-mode")];
const pressed = root => toggles(root).map(t => t.ariaPressed);

describe("d20 rolls", () => {
  it("gives no toggles to a user who can't change the roll", async () => {
    const { decorateRolls } = await load();
    const message = new Message({ type: "attack", author: "someone else", rolls: [await d20(0, 7)] });
    const root = card(message);
    decorateRolls(message, root);
    expect(toggles(root)).toEqual([]);
  });

  it("switches to advantage keeping the die rolled, and tags the flavor", async () => {
    const { decorateRolls } = await load();
    const message = game.messages.add(new Message({
      type: "attack", author: game.user.id, flavor: "Longsword", rolls: [await d20(0, 7)]
    }));
    const root = card(message);
    decorateRolls(message, root);
    nextFaces(15);
    toggles(root)[1].click();
    await vi.waitFor(() => expect(message.rolls[0].options.advantageMode).toBe(1));
    expect(message.rolls[0].d20.results.map(r => r.result)).toEqual([7, 15]);
    expect(message.flavor).toBe("Longsword (DND5E.Advantage)");
  });
});

describe("critical damage", () => {
  const attackDamage = async (roll, author = game.user.id) => new Message({
    type: "damage", author, rolls: [roll], activity: { type: "attack" }
  });

  it("doesn't show the critical while the dice roll: it would tell the attack's", async () => {
    const { decorateRolls } = await load();
    const message = await attackDamage(await damage({ isCritical: true }));
    message.flags[MODULE] = { rolling: game.time.serverTime };
    const root = card(message);
    decorateRolls(message, root);
    expect(pressed(root)).toEqual(["false"]);
    expect(root.querySelector("span.steady-rolls-mode")).toBeNull();
  });

  it("shows the toggle disabled, with the reason, for damage changed by another module", async () => {
    const { decorateRolls } = await load();
    const message = await attackDamage(await damage({ isCritical: true, late: ["2"] }));
    const root = card(message);
    decorateRolls(message, root);
    const [toggle] = toggles(root);
    expect(toggle.ariaDisabled).toBe("true");
    expect(toggle.ariaLabel).toBe("STEADY_ROLLS.CriticalFixed");
  });

  it("offers no critical for a save's damage: saves don't crit", async () => {
    const { decorateRolls } = await load();
    const save = new Message({
      type: "damage", author: game.user.id, rolls: [await damage()], activity: { type: "save" }
    });
    const saveCard = card(save);
    decorateRolls(save, saveCard);
    expect(toggles(saveCard)).toEqual([]);
  });

  it("follows the attack: damage still matching the attack's old critical switches with it", async () => {
    const { decorateRolls } = await load();
    const usage = new Message({ type: "usage" });
    const attack = game.messages.add(new Message({
      type: "attack", author: game.user.id, rolls: [await d20(0, 7)], system: { origin: usage }
    }));
    const hit = game.messages.add(await attackDamage(await damage({ results: [5] })));
    hit.flags[MODULE] = { attack: attack.id };
    usage.getAssociatedRolls = type => [hit].filter(m => m.type === type);
    const root = card(attack);
    decorateRolls(attack, root);
    nextFaces(20, 8);
    toggles(root)[1].click();
    await vi.waitFor(() => expect(hit.rolls[0].isCritical).toBe(true));
    expect(hit.rolls[0].formula).toBe("2d8 + 3");
    expect(hit.rolls[0].dice[0].results.map(r => r.result)).toEqual([5, 8]);
  });
});
