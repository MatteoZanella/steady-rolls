// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const MODULE = "steady-rolls";

/** dnd5e's registered classes, as Steady Rolls finds them at init. */
function dnd5eClasses({ summaries = true } = {}) {
  class Model {
    static metadata = Object.freeze({ actions: {}, template: "", summaryTemplate: "" });
  }
  class Usage extends Model {
    get rendersSummaries() {
      return summaries;
    }
  }
  const usage = summaries ? Usage : Model;
  CONFIG.ChatMessage = {
    documentClass: class ChatMessage5e {},
    dataModels: {
      usage, attack: class Attack extends Model {}, damage: class Damage extends Model {},
      healing: class Healing extends Model {}
    }
  };
  CONFIG.ui = { chat: class ChatLog5e {} };
  game.system = { id: "dnd5e" };
}

async function init() {
  await import("../scripts/steady-rolls.mjs");
  Hooks.callAll("init");
  return CONFIG.ChatMessage.dataModels;
}

describe("init", () => {
  it("extends dnd5e's classes: summary templates, the info card type, the chat log", async () => {
    dnd5eClasses();
    const models = await init();
    expect(models.attack.metadata.summaryTemplate).toBe(`modules/${MODULE}/templates/attack-summary.hbs`);
    expect(models.healing.metadata.summaryTemplate).toBe(`modules/${MODULE}/templates/damage-summary.hbs`);
    expect(models.usage.name).toBe("SteadyRollsUsage");
    expect(models[`${MODULE}.reroll`]).toBeTypeOf("function");
    expect(CONFIG.ui.chat.name).toBe("SteadyRollsChatLog5e");
    expect(Hooks.on).toHaveBeenCalledWith("dnd5e.renderChatMessage", expect.any(Function));
  });

  it("reads damage parts last: after the other modules' listeners, from ready", async () => {
    dnd5eClasses();
    await init();
    const registered = () => Hooks.on.mock.calls.some(([name]) => name === "dnd5e.postBuildRollConfig");
    expect(registered()).toBe(false);
    Hooks.callAll("ready");
    expect(registered()).toBe(true);
  });

  it("registers nothing without dnd5e's card summaries", async () => {
    dnd5eClasses({ summaries: false });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const models = await init();
    expect(warn).toHaveBeenCalledWith("steady-rolls | dnd5e card summaries not found; nothing registered.");
    expect(models.attack.metadata.summaryTemplate).toBe("");
    expect(Hooks.on).not.toHaveBeenCalledWith("dnd5e.renderChatMessage", expect.any(Function));
  });

});
