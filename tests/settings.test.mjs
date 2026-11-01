// @vitest-environment node
import { describe, expect, it } from "vitest";

const MODULE = "steady-rolls";

async function load(fastForward) {
  const module = await import("../scripts/settings.mjs");
  module.registerSettings();
  if ( fastForward ) await game.settings.set(MODULE, "fastForward", fastForward);
  return module;
}

/** Hold the key that shows the dialog of a fast-forwarded roll. */
function holdDialogKey() {
  dnd5e.utils.areKeysPressed = (event, action) => !!event?.held && (action === "skipDialogNormal");
  return { held: true };
}


describe("onPreRoll", () => {
  const roll = (hookNames, type) => [{ hookNames }, {}, { data: { type } }];

  it("skips the dialog of the roll types chosen", async () => {
    const { onPreRoll } = await load({ attack: true, healing: true, saves: true });
    const cases = [
      [["attack", "d20Test"], "attack", false],
      [["damage"], "damage", undefined],
      [["damage"], "healing", false],
      [["savingThrow", "d20Test"], "save", false],
      [["skill", "d20Test"], "check", undefined],
      [["hitDie"], "hitDie", undefined]
    ];
    for ( const [hookNames, type, configure] of cases ) {
      const [config, dialog, message] = roll(hookNames, type);
      onPreRoll(config, dialog, message);
      expect(dialog.configure, `${hookNames} ${type}`).toBe(configure);
    }
  });

  it("shows the dialog with the dialog key, and asks the attack's damage dialog too", async () => {
    const { onPreRoll } = await load({ attack: true });
    const [config, dialog, message] = roll(["attack"], "attack");
    config.event = holdDialogKey();
    onPreRoll(config, dialog, message);
    expect(dialog.configure).toBe(true);
    expect(message.data.flags[MODULE].dialog).toBe(true);
  });

  it("leaves a dialog choice made by the caller", async () => {
    const { onPreRoll } = await load({ attack: true });
    const [config, , message] = roll(["attack"], "attack");
    const dialog = { configure: true };
    onPreRoll(config, dialog, message);
    expect(dialog.configure).toBe(true);
  });
});

describe("onPreUseActivity", () => {
  const plain = { canScale: false, type: "attack", consumption: { targets: [] } };
  const leveled = { ...plain, canScale: true };
  const slotSpender = { ...plain, consumption: { targets: [{ type: "spellSlots" }] } };

  it("skips the dialog, unless there is a choice to make or the dialog key is held", async () => {
    const { onPreUseActivity } = await load({ use: true });
    const configure = (activity, usage = {}) => {
      const dialog = {};
      onPreUseActivity(activity, usage, dialog);
      return dialog.configure;
    };
    expect(configure(plain)).toBe(false);
    expect(configure(leveled)).toBe(true);
    expect(configure(slotSpender)).toBe(true);
    expect(configure({ ...plain, type: "order" })).toBe(true);
    expect(configure(plain, { event: holdDialogKey() })).toBe(true);
  });

  it("skips it even with a choice when the choices option is off", async () => {
    const { onPreUseActivity } = await load({ use: true, useChoices: false });
    const dialog = {};
    onPreUseActivity(leveled, {}, dialog);
    expect(dialog.configure).toBe(false);
  });
});
