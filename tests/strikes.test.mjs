// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { DamageRoll, Message } from "./helpers/foundry.mjs";

const MODULE = "steady-rolls";

async function load({ summaries = true, autoDamage } = {}) {
  game.settings.register("dnd5e", "chatCardSummary", { default: summaries });
  (await import("../scripts/settings.mjs")).registerSettings();
  if ( autoDamage ) await game.settings.set(MODULE, "autoDamage", autoDamage);
  return import("../scripts/strikes.mjs");
}

/** A usage card with its activity; rolls made from it are messages whose origin is the card. */
function usageCard() {
  const activity = {
    id: "activity", type: "attack", damage: { parts: [["1d8"]] }, rollDamage: vi.fn(),
    createConsumedFlag: () => null
  };
  activity.item = { system: { activities: { get: () => activity } } };
  const usage = game.messages.add(new Message({ type: "usage", system: { rendersSummaries: true }, activity }));
  usage.getAssociatedActor = () => null;
  usage.getAssociatedRolls = type => [...game.messages]
    .filter(m => (m.system.origin === usage) && (!type || (m.type === type)));
  return usage;
}

/** A roll message from a usage card, created as Foundry does (preCreateChatMessage first). */
async function roll(usage, type, flags = {}) {
  const { onPreCreateMessage } = await import("../scripts/strikes.mjs");
  const message = new Message({ type, system: { origin: usage }, flags: { [MODULE]: { ...flags } } });
  onPreCreateMessage(message);
  return game.messages.add(message);
}

describe("onPreCreateMessage", () => {
  it("numbers each attack of a card, and links damage to the latest attack", async () => {
    await load();
    const usage = usageCard();
    const first = await roll(usage, "attack");
    const firstDamage = await roll(usage, "damage");
    const second = await roll(usage, "attack");
    const secondDamage = await roll(usage, "damage");
    expect([first, second].map(a => a.getFlag(MODULE, "strike"))).toEqual([1, 2]);
    expect([firstDamage, secondDamage].map(d => d.getFlag(MODULE, "attack"))).toEqual([first.id, second.id]);
  });

  it("keeps a link given at creation, and leaves rolls outside a usage card alone", async () => {
    await load();
    const usage = usageCard();
    const first = await roll(usage, "attack");
    await roll(usage, "attack");
    const again = await roll(usage, "damage", { attack: first.id });
    expect(again.getFlag(MODULE, "attack")).toBe(first.id);
    const loose = await roll(new Message(), "attack");
    expect(loose.getFlag(MODULE, "strike")).toBeUndefined();
  });
});

describe("hostOf", () => {
  it("shows the first attack on the usage card, and later ones on their own card with their damage", async () => {
    const { hostOf } = await load();
    const usage = usageCard();
    const first = await roll(usage, "attack");
    const firstDamage = await roll(usage, "damage");
    const second = await roll(usage, "attack");
    const secondDamage = await roll(usage, "damage");
    const own = await roll(usage, "damage", { own: true });
    expect([first, firstDamage, second, secondDamage, own].map(m => hostOf(m)?.id))
      .toEqual([usage.id, usage.id, undefined, second.id, undefined]);
  });

  it("folds everything into the usage card when dnd5e's card summaries are off", async () => {
    const { hostOf } = await load({ summaries: false });
    const usage = usageCard();
    await roll(usage, "attack");
    const second = await roll(usage, "attack");
    expect(hostOf(second)?.id).toBe(usage.id);
  });
});

describe("refreshCards", () => {
  it("redraws each affected card once, never the changed message itself", async () => {
    const { refreshCards } = await load();
    const usage = usageCard();
    await roll(usage, "attack");
    const second = await roll(usage, "attack");
    const damage = await roll(usage, "damage");
    const third = await roll(usage, "attack");
    refreshCards(damage, { rolls: [] });
    expect(ui.chat.updateMessage.mock.calls.map(([m]) => m.id)).toEqual([second.id, third.id]);
    ui.chat.updateMessage.mockClear();
    refreshCards(second, { rolls: [] });
    expect(ui.chat.updateMessage.mock.calls.map(([m]) => m.id)).toEqual([third.id]);
  });
});

describe("refreshCards on saves", () => {
  it("draws the usage card from scratch when a save changes, so its damage halves for who saved", async () => {
    const { refreshCards } = await load();
    const usage = usageCard();
    const save = await roll(usage, "save");
    const damage = await roll(usage, "damage");
    usage.reset = vi.fn();
    ui.chat.updateMessage.mockClear();
    refreshCards(save, { rolls: [] }); // Advantage switched.
    expect(usage.reset).toHaveBeenCalled();
    expect(ui.chat.updateMessage.mock.calls.map(([m]) => m.id)).toEqual([usage.id, damage.id]);
    usage.reset.mockClear();
    refreshCards(save, { flags: {} }); // Not its outcome.
    expect(usage.reset).not.toHaveBeenCalled();
  });
});

describe("withStrikeUsage", () => {
  async function buttons(usage) {
    const { withStrikeUsage } = await import("../scripts/strikes.mjs");
    class Base {
      static metadata = { actions: {}, template: "" };
      _prepareButtons() {
        return [
          { action: "rollAttack", label: "Attack", dataset: {} },
          { action: "rollDamage", label: "Damage", dataset: {} }
        ];
      }
    }
    const model = new (withStrikeUsage(Base))();
    model.parent = usage;
    return Object.fromEntries(model._prepareButtons().map(b => [b.action, b]));
  }

  it("sends Damage to the card's attack, and turns used buttons into \"again\" buttons", async () => {
    await load();
    const usage = usageCard();
    const before = await buttons(usage);
    expect(before.rollAttack.dataset.steadyRollsAgain).toBeUndefined();
    expect(before.steadyRollsDamage).toBeDefined();
    await roll(usage, "attack");
    await roll(usage, "damage");
    const after = await buttons(usage);
    expect(after.rollAttack.label).toBe("STEADY_ROLLS.Again.attack");
    expect(after.steadyRollsAgain.label).toBe("STEADY_ROLLS.Again.damage");
  });

  it("offers the next attack only on the newest card", async () => {
    await load();
    const usage = usageCard();
    await roll(usage, "attack");
    await roll(usage, "attack");
    expect((await buttons(usage)).rollAttack.hidden).toBe(true);
  });
});

describe("withStrikeCascade", () => {
  it("deletes a card's strike and damage-only cards with it, those the user can delete", async () => {
    const { withStrikeCascade } = await load();
    const usage = usageCard();
    await roll(usage, "attack");
    const second = await roll(usage, "attack");
    const secondDamage = await roll(usage, "damage");
    const own = await roll(usage, "damage", { own: true, attack: second.id });
    const others = await roll(usage, "attack");
    others.author = "someone else";
    class Base {
      static async _preDeleteOperation(documents, operation) {
        return operation;
      }
    }
    const Cascade = withStrikeCascade(Base);
    const user = game.user;
    const fromUsage = await Cascade._preDeleteOperation([usage], { ids: [usage.id] }, user);
    expect(fromUsage.ids).toEqual([usage.id, second.id, own.id]);
    const fromStrike = await Cascade._preDeleteOperation([second], { ids: [second.id] }, user);
    expect(fromStrike.ids).toEqual([second.id, secondDamage.id, own.id]);
  });
});

describe("onRollAttack", () => {
  async function attackRolled(mode, targets = []) {
    const { onRollAttack } = await load({ autoDamage: mode });
    const usage = usageCard();
    const attack = await roll(usage, "attack");
    attack.system.evaluatedTargets = targets;
    attack.rolls = [{ isCritical: true }];
    const attackRoll = new DamageRoll("1d20");
    attackRoll.parent = attack;
    await onRollAttack([attackRoll], { subject: usage.activity });
    return { attack, rollDamage: usage.activity.rollDamage };
  }

  it("rolls the damage of the attack, with its critical: always, never, or on a hit", async () => {
    const always = await attackRolled("always");
    expect(always.rollDamage).toHaveBeenCalledTimes(1);
    const [config, , message] = always.rollDamage.mock.calls[0];
    expect(message.data.flags[MODULE].attack).toBe(always.attack.id);
    expect(config.isCritical).toBe(true);
    expect((await attackRolled("never")).rollDamage).not.toHaveBeenCalled();
    expect((await attackRolled("hit", [{ isMiss: true }])).rollDamage).not.toHaveBeenCalled();
    expect((await attackRolled("hit", [])).rollDamage).not.toHaveBeenCalled();
    expect((await attackRolled("hit", [{ isMiss: true }, { isMiss: false }])).rollDamage).toHaveBeenCalledTimes(1);
  });
});
