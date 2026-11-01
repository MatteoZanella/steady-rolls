/**
 * The built package (dist/), as users get it: only what Foundry loads, every file it points to,
 * the release's version, and a minified bundle that still loads and registers at init.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DIST = new URL("../../dist/", import.meta.url);
const read = path => readFileSync(new URL(path, DIST), "utf8");
const manifest = JSON.parse(read("module.json"));
const tag = process.env.TAG;

describe("package", () => {
  it("ships only what Foundry loads", () => {
    expect(readdirSync(DIST).sort()).toEqual(
      ["LICENSE", "NOTICE", "README.md", "lang", "module.json", "scripts", "styles", "templates"]
    );
  });

  it("has every file module.json points to, scripts and styles with their source maps", () => {
    const files = [...manifest.esmodules, ...manifest.styles, ...manifest.languages.map(l => l.path)];
    for ( const path of [...files, ...[...manifest.esmodules, ...manifest.styles].map(p => `${p}.map`)] ) {
      expect(existsSync(new URL(path, DIST)), path).toBe(true);
    }
  });

  it("has every template the scripts render, and no other", () => {
    const bundle = read(manifest.esmodules[0]);
    const rendered = new Set([...bundle.matchAll(/\}\/([\w-]+\.hbs)/g)].map(m => m[1]));
    expect([...rendered].sort()).toEqual(readdirSync(new URL("templates/", DIST)).sort());
  });

  it.runIf(tag)("carries the release's version and download URL", () => {
    expect(manifest.version).toBe(tag.replace(/^v/, ""));
    expect(manifest.download).toBe(`${manifest.url}/releases/download/${tag}/module.zip`);
    expect(manifest.manifest).toBe(`${manifest.url}/releases/latest/download/module.json`);
  });
});

describe("bundle", () => {
  it("loads, and registers with dnd5e at init", async () => {
    class Model {
      static metadata = Object.freeze({ actions: {}, template: "", summaryTemplate: "" });
    }
    class Usage extends Model {
      get rendersSummaries() {
        return true;
      }
    }
    CONFIG.ChatMessage = { documentClass: class {}, dataModels: { usage: Usage, attack: class extends Model {} } };
    CONFIG.ui = { chat: class {} };
    game.system = { id: "dnd5e" };
    await import(new URL(manifest.esmodules[0], DIST).href);
    Hooks.callAll("init");
    const models = CONFIG.ChatMessage.dataModels;
    expect(models.attack.metadata.summaryTemplate).toBe(`modules/${manifest.id}/templates/attack-summary.hbs`);
    expect(models[`${manifest.id}.reroll`]).toBeTypeOf("function");
    expect(Hooks.on).toHaveBeenCalledWith("dnd5e.renderChatMessage", expect.any(Function));
  });
});
