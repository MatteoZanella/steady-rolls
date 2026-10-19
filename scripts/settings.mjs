/**
 * Settings: fast-forward per roll type, and automatic damage.
 * Fast-forward is set in dnd5e's pre-roll hooks, which run before dnd5e reads its skip-dialog
 * keys (`dialog.configure ??=`); the skip-dialog key then shows the dialog instead.
 */
import { MODULE_ID, TEMPLATES } from "./common.mjs";

/** Roll types with their own fast-forward choice. */
const ROLL_TYPES = ["use", "attack", "damage", "checks"];

/** The key that opens the dialog of a fast-forwarded roll. */
const DIALOG_KEY = "skipDialogNormal";

export function registerSettings() {
  game.settings.register(MODULE_ID, "fastForward", {
    scope: "client", config: false, type: Object,
    default: Object.fromEntries(ROLL_TYPES.map(type => [type, false]))
  });
  game.settings.registerMenu(MODULE_ID, "fastForwardMenu", {
    name: "STEADY_STRIKE.Settings.FastForward.Name",
    label: "STEADY_STRIKE.Settings.FastForward.Label",
    hint: "STEADY_STRIKE.Settings.FastForward.MenuHint",
    icon: "fa-solid fa-forward",
    type: FastForwardConfig,
    restricted: false
  });
  game.settings.register(MODULE_ID, "autoDamage", {
    name: "STEADY_STRIKE.Settings.AutoDamage.Name",
    hint: "STEADY_STRIKE.Settings.AutoDamage.Hint",
    scope: "client", config: true, type: String, default: "never",
    choices: {
      never: "STEADY_STRIKE.Settings.AutoDamage.Never",
      hit: "STEADY_STRIKE.Settings.AutoDamage.Hit",
      always: "STEADY_STRIKE.Settings.AutoDamage.Always"
    }
  });
}

export function fastForward(type) {
  return !!game.settings.get(MODULE_ID, "fastForward")?.[type];
}

/** The keys bound to a dnd5e action, with left and right modifier keys named once ("Shift"). */
function keyLabel(action) {
  const { KeyboardManager } = foundry.helpers.interaction;
  const name = key => Object.entries(KeyboardManager.MODIFIER_CODES).find(([, codes]) => codes.includes(key))?.[0]
    ?? KeyboardManager.getKeycodeDisplayString(key);
  const labels = (game.keybindings.get("dnd5e", action) ?? [])
    .map(b => [...(b.modifiers ?? []), name(b.key)].join(" + "));
  return [...new Set(labels)].join(" / ") || game.i18n.localize("STEADY_STRIKE.Settings.FastForward.Unbound");
}

function wantsDialog(event) {
  return !!event && dnd5e.utils.areKeysPressed(event, DIALOG_KEY);
}

/** Fast-forward choice for a roll, from the hook names dnd5e gives it. */
function rollType(hookNames = []) {
  if ( hookNames.includes("attack") ) return "attack";
  if ( hookNames.includes("damage") ) return "damage";
  if ( hookNames.includes("d20Test") ) return "checks";
  return null;
}

/** dnd5e.preRollV2: every dnd5e roll. */
export function onPreRoll(config, dialog, message) {
  const type = rollType(config.hookNames);
  if ( !type || !fastForward(type) ) return;
  const shown = wantsDialog(config.event);
  // An attack rolled with its dialog shown gets its automatic damage dialog too.
  if ( (type === "attack") && shown ) foundry.utils.setProperty(message, `data.flags.${MODULE_ID}.dialog`, true);
  dialog.configure ??= shown;
}

/** dnd5e.preUseActivity: the item use dialog. */
export function onPreUseActivity(activity, usage, dialog) {
  if ( fastForward("use") ) dialog.configure = wantsDialog(usage.event);
}

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Fast-forward choices, one column per roll type. */
class FastForwardConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "steady-strike-fast-forward",
    tag: "form",
    window: { title: "STEADY_STRIKE.Settings.FastForward.Name", contentClasses: ["standard-form"] },
    position: { width: 480 },
    form: { handler: FastForwardConfig.#onSubmit, closeOnSubmit: true }
  };

  static PARTS = {
    form: { template: `${TEMPLATES}/fast-forward-config.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  /** @override */
  async _prepareContext() {
    const values = game.settings.get(MODULE_ID, "fastForward") ?? {};
    return {
      key: keyLabel(DIALOG_KEY),
      types: ROLL_TYPES.map(type => ({
        type, checked: !!values[type], label: `STEADY_STRIKE.Settings.FastForward.Type.${type}`
      })),
      buttons: [{ type: "submit", icon: "fa-solid fa-floppy-disk", label: "SETTINGS.Save" }]
    };
  }

  static async #onSubmit(event, form, formData) {
    const data = formData.object;
    await game.settings.set(MODULE_ID, "fastForward",
      Object.fromEntries(ROLL_TYPES.map(type => [type, !!data[type]])));
  }
}
