/**
 * A small stand-in for the Foundry and dnd5e globals the scripts use, reset before each test.
 * Dice results are scripted: `nextFaces(...)` queues the values new dice roll (1 when empty).
 */
import { beforeEach, vi } from "vitest";

/* -------------------------------------------- */
/*  Utilities                                   */
/* -------------------------------------------- */

const isPlainObject = value => value?.constructor === Object;

function deepClone(value) {
  if ( Array.isArray(value) ) return value.map(deepClone);
  if ( value?.constructor !== Object ) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepClone(v)]));
}

function getProperty(object, key) {
  return key.split(".").reduce((target, part) => target?.[part], object);
}

function setProperty(object, key, value) {
  const parts = key.split(".");
  const last = parts.pop();
  let target = object;
  for ( const part of parts ) target = (target[part] ??= {});
  target[last] = value;
  return true;
}

function mergeObject(original, other = {}, { inplace = true } = {}) {
  const target = inplace ? original : deepClone(original);
  for ( const [key, value] of Object.entries(other) ) {
    if ( isPlainObject(value) && isPlainObject(target[key]) ) target[key] = mergeObject(target[key], value);
    else target[key] = deepClone(value);
  }
  return target;
}

let ids = 0;
const utils = {
  deepClone, getProperty, setProperty, mergeObject,
  hasProperty: (object, key) => getProperty(object, key) !== undefined,
  isEmpty: value => !value || (Object.keys(value).length === 0),
  randomID: () => `id${++ids}`,
  getType: value => (typeof value === "function") ? "function" : typeof value
};

/* -------------------------------------------- */
/*  Dice                                        */
/* -------------------------------------------- */

let faces = [];
/** Queue the values that new dice roll, in order. */
export function nextFaces(...values) {
  faces.push(...values);
}

class RollTerm {
  constructor({ options = {} } = {}) {
    this.options = options;
  }
  get isDeterministic() {
    return true;
  }
}

class NumericTerm extends RollTerm {
  constructor({ number, options }) {
    super({ options });
    this.number = number;
  }
  get formula() {
    return String(this.number);
  }
  get total() {
    return this.number;
  }
}

class OperatorTerm extends RollTerm {
  constructor({ operator, options }) {
    super({ options });
    this.operator = operator;
  }
  get formula() {
    return this.operator;
  }
}

/**
 * A die rolled as Foundry does: each result from `_roll` (the fulfillment point), else a random
 * face; then its modifiers: `r<N` rerolls results below N once, `x` explodes on the highest face
 * once, `kh`/`kl` keep the highest/lowest.
 */
class DiceTerm extends RollTerm {
  constructor({ number = 1, faces = 6, modifiers = [], results = [], options = {} } = {}) {
    super({ options });
    Object.assign(this, { _number: number, _faces: faces, modifiers, results });
  }
  get number() {
    return this._number;
  }
  set number(value) {
    this._number = value;
  }
  get faces() {
    return this._faces;
  }
  get formula() {
    return `${this.number}d${this.faces}${this.modifiers.join("")}`;
  }
  get total() {
    return this.results.filter(r => r.active).reduce((sum, r) => sum + r.result, 0);
  }
  async _roll() {
    return undefined;
  }
  getTooltipData() {
    return { rolls: this.results.map(r => ({ result: r.result })) };
  }
  randomFace() {
    return faces.length ? faces.shift() : 1;
  }
  async #next(options) {
    return (await this._roll(options)) ?? this.randomFace();
  }
  async evaluate() {
    for ( let i = 0; i < this.number; i++ ) this.results.push({ result: await this.#next(), active: true });
    for ( const modifier of this.modifiers ) {
      const below = /^r(\d+)$/.exec(modifier)?.[1];
      if ( below ) {
        for ( const r of [...this.results] ) {
          if ( r.result >= Number(below) ) continue;
          Object.assign(r, { rerolled: true, active: false });
          this.results.push({ result: await this.#next({ reroll: true }), active: true });
        }
      }
      if ( modifier === "x" ) {
        for ( const r of [...this.results] ) {
          if ( !r.active || (r.result !== this.faces) ) continue;
          this.results.push({ result: await this.#next({ explode: true }), active: true });
        }
      }
      if ( (modifier === "kh") || (modifier === "kl") ) {
        const active = this.results.filter(r => r.active);
        const better = (a, b) => (modifier === "kh") ? (b.result > a.result) : (b.result < a.result);
        const kept = active.reduce((a, b) => better(a, b) ? b : a);
        for ( const r of active ) if ( r !== kept ) Object.assign(r, { active: false, discarded: true });
      }
    }
  }
}

class Die extends DiceTerm {}
class ParentheticalTerm extends RollTerm {}
class PoolTerm extends RollTerm {
  constructor({ deterministic = false } = {}) {
    super();
    this.deterministic = deterministic;
  }
  get isDeterministic() {
    return this.deterministic;
  }
}
class FunctionTerm extends PoolTerm {}

/** Parse "2d6kh + 3 - 1d4" into terms. */
function parse(formula) {
  return String(formula).trim().split(/\s+/).filter(Boolean).map(token => {
    if ( ["+", "-"].includes(token) ) return new OperatorTerm({ operator: token });
    const dice = /^(\d+)d(\d+)(.*)$/.exec(token);
    if ( dice ) {
      const modifiers = dice[3].match(/r\d+|kh|kl|x/g) ?? [];
      return new Die({ number: Number(dice[1]), faces: Number(dice[2]), modifiers });
    }
    return new NumericTerm({ number: Number(token) });
  });
}

class Roll {
  constructor(formula, data = {}, options = {}) {
    this.data = data;
    this.options = options;
    this.terms = parse(formula);
    this._evaluated = false;
  }
  static create(formula, data, options) {
    return new this(formula, data, options);
  }
  static replaceFormulaData(formula, data = {}) {
    return String(formula).replace(/@([\w.]+)/g, (_, key) => String(getProperty(data, key) ?? 0));
  }
  static fromData({ class: name, formula, options, results }) {
    const cls = globalThis.CONFIG.Dice.rolls.find(c => c.name === name) ?? Roll;
    const roll = new cls(formula, {}, { ...deepClone(options), configured: true, preprocessed: true });
    roll.dice.forEach((die, i) => die.results = deepClone(results[i] ?? []));
    roll._evaluated = true;
    return roll;
  }
  get dice() {
    return this.terms.filter(t => t instanceof DiceTerm);
  }
  get formula() {
    return this.terms.map(t => t.formula).join(" ");
  }
  get total() {
    let sign = 1;
    let total = 0;
    for ( const term of this.terms ) {
      if ( term instanceof OperatorTerm ) sign = (term.operator === "-") ? -1 : 1;
      else total += sign * term.total;
    }
    return total;
  }
  get isDeterministic() {
    return !this.dice.length;
  }
  resetFormula() {}
  clone() {
    return new this.constructor(this.formula, this.data, this.options);
  }
  async evaluate() {
    for ( const die of this.dice ) await die.evaluate();
    this._evaluated = true;
    return this;
  }
  toJSON() {
    return {
      class: this.constructor.name, formula: this.formula, options: deepClone(this.options),
      results: this.dice.map(d => deepClone(d.results))
    };
  }
}

/** dnd5e's damage roll: a critical doubles the dice, and adds `critical.bonusDamage`. */
class DamageRoll extends Roll {
  constructor(formula, data, options) {
    super(formula, data, options);
    if ( !this.options.preprocessed ) this.options.preprocessed = true;
    if ( !this.options.configured ) this.configureDamage();
  }
  get isCritical() {
    return !!this.options.isCritical;
  }
  configureDamage() {
    if ( this.options.configured ) return;
    if ( this.isCritical ) {
      for ( const die of this.dice ) die.number *= 2;
      const bonus = this.options.critical?.bonusDamage;
      if ( bonus ) this.terms.push(new OperatorTerm({ operator: "+" }), ...parse(bonus));
    }
    this.options.configured = true;
  }
}

/** dnd5e's d20 roll: advantage and disadvantage roll a second d20 and keep one. */
class D20Roll extends Roll {
  static ADV_MODE = { NORMAL: 0, ADVANTAGE: 1, DISADVANTAGE: -1 };
  get validD20Roll() {
    return (this.terms[0] instanceof Die) && (this.terms[0].faces === 20);
  }
  get d20() {
    return this.terms[0];
  }
  get isCritical() {
    return this.d20.total === 20;
  }
  get hasAdvantage() {
    return this.options.advantageMode === 1;
  }
  get hasDisadvantage() {
    return this.options.advantageMode === -1;
  }
  configureModifiers() {
    const mode = this.options.advantageMode ?? 0;
    this.d20.number = mode ? 2 : 1;
    this.d20.modifiers = (mode === 1) ? ["kh"] : (mode === -1) ? ["kl"] : [];
    this.options.configured = true;
  }
}

/* -------------------------------------------- */
/*  Data fields (settings)                      */
/* -------------------------------------------- */

class DataField {
  constructor(options = {}) {
    Object.assign(this, options);
  }
}
class BooleanField extends DataField {
  getInitialValue() {
    return this.initial ?? false;
  }
  clean(value) {
    return (value === undefined) ? this.getInitialValue() : !!value;
  }
}
class NumberField extends DataField {}
class StringField extends DataField {}
class SchemaField extends DataField {
  constructor(fields, options) {
    super(options);
    this.fields = fields;
  }
  getInitialValue() {
    return Object.fromEntries(Object.entries(this.fields).map(([k, f]) => [k, f.getInitialValue()]));
  }
  clean(value = {}) {
    return Object.fromEntries(Object.entries(this.fields).map(([k, f]) => [k, f.clean(value[k])]));
  }
}

/* -------------------------------------------- */
/*  Hooks, settings, messages                   */
/* -------------------------------------------- */

function createHooks() {
  const listeners = new Map();
  const of = name => listeners.get(name) ?? [];
  return {
    on: vi.fn((name, fn) => listeners.set(name, [...of(name), fn])),
    once: vi.fn((name, fn) => listeners.set(name, [...of(name), fn])),
    off: vi.fn((name, fn) => listeners.set(name, of(name).filter(f => f !== fn))),
    call: vi.fn((name, ...args) => of(name).every(fn => fn(...args) !== false)),
    callAll: vi.fn((name, ...args) => {
      of(name).forEach(fn => fn(...args));
      return true;
    })
  };
}

function createSettings() {
  const settings = new Map();
  const values = new Map();
  return {
    settings,
    register: vi.fn((namespace, key, config) => settings.set(`${namespace}.${key}`, { ...config })),
    registerMenu: vi.fn(),
    get: vi.fn((namespace, key) => {
      const id = `${namespace}.${key}`;
      const config = settings.get(id);
      if ( !config ) throw new Error(`Setting ${id} is not registered`);
      const value = values.has(id) ? values.get(id) : config.default;
      return (config.type instanceof DataField) ? config.type.clean(value) : value;
    }),
    set: vi.fn(async (namespace, key, value) => values.set(`${namespace}.${key}`, deepClone(value)))
  };
}

/** A chat message, enough of ChatMessage5e: flags, rolls (stored as data, as Foundry does), permissions. */
export class Message {
  constructor({ id = utils.randomID(), type = "base", author = "player", ...data } = {}) {
    Object.assign(this, { id, type, author, rolls: [], flags: {}, system: {}, isContentVisible: true, ...data });
  }
  updateSource(changes) {
    for ( const [key, value] of Object.entries(changes) ) setProperty(this, key, value);
  }
  getFlag(scope, key) {
    return getProperty(this.flags, `${scope}.${key}`);
  }
  canUserModify(user) {
    return user.isGM || (user.id === this.author);
  }
  get isAuthor() {
    return game.user.id === this.author;
  }
  getAssociatedActivity() {
    return this.activity ?? null;
  }
  async update(changes) {
    for ( const [key, value] of Object.entries(changes) ) {
      if ( key === "rolls" ) this.rolls = value.map(data => Roll.fromData(data));
      else setProperty(this, key, value);
    }
    Hooks.callAll("updateChatMessage", this, changes);
    return this;
  }
  async unsetFlag(scope, key) {
    delete getProperty(this.flags, scope)?.[key];
    return this.update({});
  }
}

/** dnd5e's base of its chat message models: data in, metadata with a template and actions. */
class ChatMessageDataModel {
  static metadata = Object.freeze({ actions: {}, template: "" });
  constructor(data = {}) {
    Object.assign(this, data);
  }
  get metadata() {
    return this.constructor.metadata;
  }
}

/** A collection of messages, as game.messages. */
class Messages extends Map {
  add(...messages) {
    for ( const message of messages ) this.set(message.id, message);
    return messages[0];
  }
  [Symbol.iterator]() {
    return this.values();
  }
}

/* -------------------------------------------- */
/*  Globals                                     */
/* -------------------------------------------- */

function install() {
  faces = [];
  ids = 0;
  const terms = { RollTerm, NumericTerm, OperatorTerm, DiceTerm, Die, ParentheticalTerm, PoolTerm, FunctionTerm };
  Object.assign(globalThis, {
    Roll,
    Hooks: createHooks(),
    foundry: {
      utils,
      dice: { terms },
      data: { fields: { BooleanField, NumberField, StringField, SchemaField } },
      applications: {
        api: { ApplicationV2: class {}, HandlebarsApplicationMixin: Base => class extends Base {} }
      }
    },
    CONFIG: {
      Dice: { D20Roll, DamageRoll, rolls: [Roll, DamageRoll, D20Roll] },
      DND5E: { abilities: { str: { label: "Strength" }, dex: { label: "Dexterity" } } },
      ChatMessage: { dataModels: {} }
    },
    game: {
      user: { id: "player", isGM: false, name: "Player" },
      users: new Map(),
      modules: new Map(),
      messages: new Messages(),
      settings: createSettings(),
      keybindings: { get: () => [] },
      time: { serverTime: 1_000_000 },
      i18n: { localize: key => key, format: (key, data) => `${key} ${JSON.stringify(data)}` }
    },
    ui: { notifications: { warn: vi.fn() }, chat: { updateMessage: vi.fn() } },
    ChatMessage: {
      implementation: {
        create: vi.fn(async data => game.messages.add(new Message({ author: game.user.id, ...data }))),
        getSpeaker: ({ user }) => ({ alias: user.name })
      }
    },
    dnd5e: {
      utils: { areKeysPressed: () => false },
      dataModels: { abstract: { ChatMessageDataModel } }
    }
  });
}

install();
beforeEach(() => {
  vi.resetModules();
  install();
});

export { DamageRoll, D20Roll, PoolTerm };
