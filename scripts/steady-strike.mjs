/**
 * Steady Strike: attack, damage and healing rolls inside their dnd5e 6 item card.
 *
 * dnd5e folds into a usage card every roll whose data model has a `summaryTemplate`; out of
 * the box only saves and checks have one. This module gives one to attack, damage and
 * healing, extending dnd5e's registered classes rather than patching them.
 * - strikes.mjs: one card per attack, card buttons, automatic damage
 * - modes.mjs: every d20 of a roll shown; advantage, disadvantage and critical switched after the roll
 * - dice.mjs: results masked while Dice So Nice rolls
 * - labels.mjs: names of the bonuses in d20 breakdowns
 * - settings.mjs: fast-forward and automatic damage
 */
import { MODULE_ID, TEMPLATES, named } from "./common.mjs";
import { markRolling, maskRolling, onDiceSoNicePreProcess, playDice } from "./dice.mjs";
import { labelBreakdowns, onPostBuildD20, onPreRollInitiative } from "./labels.mjs";
import { decorateRolls, onPostBuildRoll, onPostDamageRollConfiguration } from "./modes.mjs";
import { onPreRoll, onPreUseActivity, registerSettings } from "./settings.mjs";
import {
  hostOf, onPostUseActivity, onPreCreateMessage, onRollAttack, refreshCards,
  withStrikeAttack, withStrikeCascade, withStrikeUsage
} from "./strikes.mjs";

/** Summary template per roll message type. Healing has the damage card's layout. */
const SUMMARY_TEMPLATES = {
  attack: `${TEMPLATES}/attack-summary.hbs`,
  damage: `${TEMPLATES}/damage-summary.hbs`,
  healing: `${TEMPLATES}/damage-summary.hbs`
};

/** Roll message data model with a summary template. */
function withSummaryTemplate(Base, summaryTemplate) {
  const Subclass = class extends Base {
    static metadata = Object.freeze(foundry.utils.mergeObject(super.metadata, { summaryTemplate }, { inplace: false }));
  };
  return named(Subclass, Base);
}

/** Whether dnd5e shows this message inside its usage card (as in ChatMessage5e#renderHTML). */
function isFolded(message) {
  return game.settings.get("dnd5e", "chatCardSummary")
    && !!message.system?.summaryTemplate
    && !!message.system.origin?.system?.rendersSummaries;
}

/** The notification showing a message, if any. */
function notificationFor(messageId) {
  return document.getElementById("chat-notifications")
    ?.querySelector(`.message[data-message-id="${CSS.escape(messageId)}"]`) ?? null;
}

/** Chat log elements already followed by withFoldedRolls#_onRender. */
const observed = new WeakSet();

/** Chat log for cards whose rolls fold in: follows them as they grow, stays put for their rolls, notifies them once. */
function withFoldedRolls(Base) {
  const Subclass = class extends Base {
    /**
     * Keep the log at the bottom while it grows, if it was there. ChatLog only follows new
     * messages, and its isAtBottom is updated on scroll, so it misses cards that grow.
     * @inheritDoc
     */
    async _onRender(context, options) {
      await super._onRender(context, options);
      // The log element can be replaced on re-render: observe each one.
      const scroller = this.element.querySelector(".chat-scroll");
      const log = scroller?.querySelector(".chat-log");
      if ( !log || observed.has(log) ) return;
      observed.add(log);
      // A scroll event can fire after growth but before the observer: also test the old height.
      let height = scroller.scrollHeight;
      const atBottomOf = h => (h - scroller.clientHeight - scroller.scrollTop) <= 2;
      let pinned = true; // ChatLog opens at the bottom.
      scroller.addEventListener("scroll", () => {
        pinned = atBottomOf(scroller.scrollHeight) || atBottomOf(height);
      }, { passive: true });
      new ResizeObserver(() => {
        if ( pinned && scroller.isConnected ) scroller.scrollTop = scroller.scrollHeight;
        height = scroller.scrollHeight;
      }).observe(log);
    }

    /**
     * A folded roll is shown in its card, wherever that is: no jump to the bottom of the log,
     * which ChatLog makes for this user's own new messages. If the log was at the bottom, the
     * observer above keeps it there as the card grows.
     * @inheritDoc
     */
    postOne(message, options = {}) {
      return super.postOne(message, isFolded(message) ? { ...options, scroll: options.scroll ?? false } : options);
    }

    /**
     * No notification for a folded roll while its card is in the notifications: the card
     * shows it. Restart the card's timer and play the roll's sound instead.
     * @override
     */
    notify(message, options = {}) {
      const host = (options.newMessage && isFolded(message)) ? hostOf(message) : null;
      const card = host ? notificationFor(host.id) : null;
      if ( !card ) return super.notify(message, options);
      if ( "_lifeSpan" in card ) card._lifeSpan = 0;
      if ( message.sound ) game.audio.play(message.sound, { context: game.audio.interface });
    }
  };
  return named(Subclass, Base);
}

/** Extend what is registered, so modules doing the same stack instead of replacing each other. */
function register(config) {
  const models = config.ChatMessage?.dataModels;
  if ( !models?.usage?.prototype || !("rendersSummaries" in models.usage.prototype) ) {
    console.warn(`${MODULE_ID} | dnd5e card summaries not found; nothing registered.`);
    return false;
  }
  for ( const [type, template] of Object.entries(SUMMARY_TEMPLATES) ) {
    if ( models[type] ) models[type] = withSummaryTemplate(models[type], template);
  }
  if ( models.attack ) models.attack = withStrikeAttack(models.attack);
  models.usage = withStrikeUsage(models.usage);
  if ( config.ChatMessage.documentClass ) {
    config.ChatMessage.documentClass = withStrikeCascade(config.ChatMessage.documentClass);
  }
  if ( config.ui?.chat ) config.ui.chat = withFoldedRolls(config.ui.chat);
  return true;
}

// dnd5e registers its classes in its own init hook, which runs first; CONFIG.ui is created later.
Hooks.once("init", () => {
  if ( game.system.id !== "dnd5e" ) return;
  registerSettings();
  if ( !register(CONFIG) ) return;
  Hooks.on("preCreateChatMessage", onPreCreateMessage);
  // Every rendered message and the rolls folded into it: name breakdown parts, show the d20s and
  // mode toggles, mask results still rolling. dnd5e renders its cards after renderChatMessageHTML.
  Hooks.on("dnd5e.renderChatMessage", (message, html) => {
    labelBreakdowns(message, html);
    decorateRolls(message, html);
    for ( const summary of html.querySelectorAll(".card-summary[data-message-id]") ) {
      const folded = game.messages.get(summary.dataset.messageId);
      if ( !folded ) continue;
      labelBreakdowns(folded, summary);
      decorateRolls(folded, summary, summary);
    }
    maskRolling(message, html);
  });
  if ( game.modules.get("dice-so-nice")?.active ) {
    Hooks.on("preCreateChatMessage", markRolling);
    Hooks.on("diceSoNiceMessagePreProcess", onDiceSoNicePreProcess);
    Hooks.on("createChatMessage", playDice);
  }
  for ( const event of ["createChatMessage", "updateChatMessage", "deleteChatMessage"] ) {
    Hooks.on(event, refreshCards);
  }
  Hooks.on("dnd5e.rollAttackV2", onRollAttack);
  Hooks.on("dnd5e.preRollV2", onPreRoll);
  Hooks.on("dnd5e.preUseActivity", onPreUseActivity);
  Hooks.on("dnd5e.postUseActivity", onPostUseActivity);
  Hooks.on("dnd5e.postBuildD20TestRollConfig", onPostBuildD20);
  Hooks.on("dnd5e.postBuildRollConfig", onPostBuildRoll);
  Hooks.on("dnd5e.postDamageRollConfiguration", onPostDamageRollConfiguration);
  Hooks.on("dnd5e.preRollInitiative", onPreRollInitiative);
});
