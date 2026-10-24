/**
 * Settings: fast-forward per roll type (one setting, typed by its schema), automatic damage, rerolls.
 * Fast-forward is set in dnd5e's pre-roll hooks, which run before dnd5e reads its skip-dialog
 * keys (`dialog.configure ??=`); the skip-dialog key then shows the dialog instead.
 */
import { MODULE_ID, TEMPLATES } from "./common.mjs";

/** Roll types with their own fast-forward choice. */
const ROLL_TYPES = ["use", "attack", "damage", "healing", "checks", "saves"];

/** The key that opens the dialog of a fast-forwarded roll. */
const DIALOG_KEY = "skipDialogNormal";

/** Fast-forward choices: whether each roll type skips its dialog, and the item use exception. */
function fastForwardSchema() {
  const { BooleanField, SchemaField } = foundry.data.fields;
  return new SchemaField({
    ...Object.fromEntries(ROLL_TYPES.map(type => [type, new BooleanField({
      label: `STEADY_STRIKE.Settings.FastForward.Type.${type}`
    })])),
    useChoices: new BooleanField({
      initial: true, label: "STEADY_STRIKE.Settings.UseChoices.Name", hint: "STEADY_STRIKE.Settings.UseChoices.Hint"
    })
  });
}

export function registerSettings() {
  game.settings.register(MODULE_ID, "fastForward", { scope: "client", config: false, type: fastForwardSchema() });
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
  game.settings.register(MODULE_ID, "autoSaveDamage", {
    name: "STEADY_STRIKE.Settings.AutoSaveDamage.Name",
    hint: "STEADY_STRIKE.Settings.AutoSaveDamage.Hint",
    scope: "client", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, "rerolls", {
    name: "STEADY_STRIKE.Settings.Rerolls.Name",
    hint: "STEADY_STRIKE.Settings.Rerolls.Hint",
    scope: "world", config: true, type: String, default: "owner",
    choices: {
      off: "STEADY_STRIKE.Settings.Rerolls.Off",
      gm: "STEADY_STRIKE.Settings.Rerolls.GM",
      owner: "STEADY_STRIKE.Settings.Rerolls.Owner"
    }
  });
}

/** A fast-forward choice: a roll type, or "useChoices". */
export function fastForward(choice) {
  return !!game.settings.get(MODULE_ID, "fastForward")[choice];
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

/** Fast-forward choice for a roll, from the hook names dnd5e gives it and its message type. */
function rollType(hookNames = [], message) {
  if ( hookNames.includes("attack") ) return "attack";
  if ( hookNames.includes("damage") ) return (message?.data?.type === "healing") ? "healing" : "damage";
  if ( hookNames.some(name => name.toLowerCase() === "savingthrow") ) return "saves";
  if ( hookNames.includes("d20Test") ) return "checks";
  return null;
}

/** dnd5e.preRollV2: every dnd5e roll. */
export function onPreRoll(config, dialog, message) {
  const type = rollType(config.hookNames, message);
  if ( !type || !fastForward(type) ) return;
  const shown = wantsDialog(config.event);
  // An attack rolled with its dialog shown gets its automatic damage dialog too.
  if ( (type === "attack") && shown ) foundry.utils.setProperty(message, `data.flags.${MODULE_ID}.dialog`, true);
  dialog.configure ??= shown;
}

/**
 * Whether using an activity asks for a choice in its dialog: a spell slot (a leveled spell, or a
 * feature spending one, like Divine Smite), an amount of a resource (Lay on Hands), an order.
 */
function hasChoice(activity) {
  return activity.canScale || (activity.type === "order")
    || !!activity.consumption?.targets?.some(target => target.type === "spellSlots");
}

/** dnd5e.preUseActivity: the item use dialog. */
export function onPreUseActivity(activity, usage, dialog) {
  if ( !fastForward("use") ) return;
  const choice = fastForward("useChoices") && hasChoice(activity);
  dialog.configure = choice || wantsDialog(usage.event);
}

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Fast-forward choices, one column per roll type. */
class FastForwardConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "steady-strike-fast-forward",
    tag: "form",
    window: { title: "STEADY_STRIKE.Settings.FastForward.Name", contentClasses: ["standard-form"] },
    position: { width: 600 },
    form: { handler: FastForwardConfig.#onSubmit, closeOnSubmit: true }
  };

  static PARTS = {
    form: { template: `${TEMPLATES}/fast-forward-config.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  /** @override */
  async _prepareContext() {
    const values = game.settings.get(MODULE_ID, "fastForward");
    const { fields } = game.settings.settings.get(`${MODULE_ID}.fastForward`).type;
    return {
      key: keyLabel(DIALOG_KEY),
      types: ROLL_TYPES.map(type => ({ type, checked: values[type], label: fields[type].label })),
      useChoices: { checked: values.useChoices, label: fields.useChoices.label, hint: fields.useChoices.hint },
      buttons: [{ type: "submit", icon: "fa-solid fa-floppy-disk", label: "SETTINGS.Save" }]
    };
  }

  /** The "All" checkbox sets every column, and shows whether all, some or none are checked. */
  _onRender(context, options) {
    super._onRender(context, options);
    const all = this.element.querySelector("input[data-all]");
    const boxes = [...this.element.querySelectorAll(".steady-strike-column input[name]")];
    const sync = () => {
      const checked = boxes.filter(b => b.checked).length;
      all.checked = checked === boxes.length;
      all.indeterminate = (checked > 0) && (checked < boxes.length);
    };
    // The choices option only applies while item use skips its dialog.
    const use = this.element.querySelector('input[name="use"]');
    const choices = this.element.querySelector('input[name="useChoices"]');
    const syncChoices = () => choices.disabled = !use.checked;
    all.addEventListener("change", () => {
      boxes.forEach(b => b.checked = all.checked);
      syncChoices();
    });
    boxes.forEach(b => b.addEventListener("change", sync));
    use.addEventListener("change", syncChoices);
    sync();
    syncChoices();
  }

  /** A disabled checkbox is not submitted: useChoices keeps its value while Item use is off. */
  static async #onSubmit(event, form, formData) {
    const value = { ...game.settings.get(MODULE_ID, "fastForward"), ...formData.object };
    await game.settings.set(MODULE_ID, "fastForward", value);
  }
}
