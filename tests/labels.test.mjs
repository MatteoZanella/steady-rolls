import { describe, expect, it } from "vitest";
import { D20Roll } from "./helpers/foundry.mjs";

const load = () => import("../scripts/labels.mjs");
const MODULE = "steady-rolls";

/** An actor whose effect bonus rules are `rules` ({ value, name }). */
function actor({ rules = [] } = {}) {
  class Rules {
    static collect() {
      const list = rules.map(({ value, name }) => ({ value, effect: { name } }));
      return { filterWith: () => ({ toArray: () => list }) };
    }
  }
  return {
    appliedRules: new Rules(), appliedEffects: [], items: new Map(), system: {}, _source: { system: {} },
    getRollData: () => ({})
  };
}

/** An attack's roll config, built as dnd5e does, then labelled. */
async function attack(parts, data, owner = actor()) {
  const { onPostBuildD20 } = await load();
  const activity = { actor: owner, item: { name: "Longsword" }, getActionType: () => "mwak" };
  const config = { parts, data: { abilityId: "str", ...data }, options: {} };
  onPostBuildD20({ hookNames: ["attack", "d20Test"], subject: activity }, config);
  return { parts: config.parts, labels: config.options[MODULE].labels };
}

describe("onPostBuildD20", () => {
  it("names the parts that are plain numbers, and gives a formula part one term", async () => {
    expect(await attack(["@mod", "@prof", "@bonus"], { mod: 3, prof: 2, bonus: "1d4 + 1" })).toEqual({
      parts: ["@mod", "@prof", "(@bonus)"], labels: ["Strength", "DND5E.Proficiency", null]
    });
  });

  it("splits the effect bonus per effect when the pieces add up to it", async () => {
    const owner = actor({ rules: [{ value: "1", name: "Bless" }, { value: "2", name: "Ring" }] });
    expect(await attack(["@mod", "@ruleBonus"], { mod: 3, ruleBonus: "1 + 2" }, owner)).toEqual({
      parts: ["@mod", "1", "2"], labels: ["Strength", "Bless", "Ring"]
    });
  });

  it("keeps the effect bonus whole, under a generic label, when the pieces don't add up", async () => {
    const owner = actor({ rules: [{ value: "2", name: "Bless" }] });
    expect(await attack(["@ruleBonus"], { ruleBonus: "3" }, owner)).toEqual({
      parts: ["@ruleBonus"], labels: ["DND5E.Bonus"]
    });
  });

});

describe("labelBreakdowns", () => {
  function card() {
    document.body.innerHTML = `
      <div class="card">
        <div class="roll-breakdown">
          <section class="tooltip-part"><div class="total"><span class="label">d20</span></div></section>
          <section class="tooltip-part constant-term"><span class="flavor"></span></section>
          <section class="tooltip-part constant-term"><span class="flavor"></span></section>
        </div>
      </div>`;
    return document.querySelector(".card");
  }

  it("writes the labels on the breakdown's rows, in roll order", async () => {
    const { labelBreakdowns } = await load();
    const roll = new D20Roll("1d20 + 3 + 2", {}, { [MODULE]: { labels: ["Strength", "Proficiency"] } });
    const root = card();
    labelBreakdowns({ rolls: [roll] }, root);
    expect([...root.querySelectorAll(".flavor")].map(e => e.textContent)).toEqual(["Strength", "Proficiency"]);
    expect(root.querySelector(".label").textContent).toBe("d20");
  });

  it("leaves the breakdown alone when the roll's terms don't match the labels", async () => {
    const { labelBreakdowns } = await load();
    const roll = new D20Roll("1d20 + 3 + 2", {}, { [MODULE]: { labels: ["Strength"] } });
    const root = card();
    labelBreakdowns({ rolls: [roll] }, root);
    expect([...root.querySelectorAll(".flavor")].map(e => e.textContent)).toEqual(["", ""]);
  });
});
