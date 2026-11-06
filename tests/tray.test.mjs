import { describe, expect, it } from "vitest";
import { Message } from "./helpers/foundry.mjs";

const MODULE = "steady-rolls";

describe("the Apply tray of a save card's damage", () => {
  /** A tray with a pill per target, ×1 pressed. */
  function tray(damage, targets) {
    const root = document.createElement("div");
    const pills = targets.map(id => `<target-pill><option value="Token.${id}"></option>
      <span class="calculated damage"><span class="value">28</span></span></target-pill>`).join("");
    root.innerHTML = `<div data-message-id="${damage.id}"><damage-application>
      <div class="multiplier-row"><button class="multiplier-button" aria-pressed="true"></button></div>
      <recorded-targets>${pills}</recorded-targets></damage-application></div>`;
    return root;
  }

  it("shows an hourglass for a target still to save, a rolling die for one whose save rolls, and no multiplier; others keep their amounts", async () => {
    await import("../scripts/settings.mjs").then(m => m.registerSettings());
    const { maskSaveOutcomes } = await import("../scripts/saves.mjs");
    const save = (id, flags = {}) => new Message({ type: "save", flags, getAssociatedToken: () => ({ uuid: `Token.${id}` }) });
    const saves = [save("krusk"), save("zanna", { [MODULE]: { rolling: game.time.serverTime } })];
    const targets = ["krusk", "zanna", "akra"].map(id => ({ token: `Token.${id}`, actor: `Actor.${id}` }));
    const card = new Message({ activity: { type: "save" }, system: { rendersSummaries: true, targets } });
    card.getAssociatedRolls = type => ((type === "save") ? saves : []);
    const damage = game.messages.add(new Message({ type: "damage", system: { origin: card } }));
    const root = tray(damage, ["krusk", "zanna", "akra", "selected"]);
    maskSaveOutcomes({ target: root.querySelector("recorded-targets") });
    await Promise.resolve();
    const values = [...root.querySelectorAll(".value")];
    expect(values[0].textContent).toBe("28");
    expect(values[1].querySelector(".fa-dice-d20")).not.toBeNull();
    expect(values[2].querySelector(".fa-hourglass-half")).not.toBeNull();
    expect(values[3].textContent).toBe("28");
    expect(root.querySelector(".multiplier-button").ariaPressed).toBe("false");
  });
});
