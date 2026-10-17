/**
 * Steady Strike: show attack, damage and healing rolls inside their dnd5e 6 usage card.
 *
 * dnd5e 6 already folds roll messages into the usage card that started them: a usage card
 * renders each associated roll whose data model has a `summaryTemplate` as a
 * `.card-summary` block, in the order the rolls were made; the roll's own card hides itself
 * in the chat log; the card re-renders when one of its rolls is created, updated or deleted;
 * deleting the card deletes those rolls. Out of the box only saves and checks have a
 * summary template.
 *
 * Steady Strike:
 * - gives attack, damage and healing messages a summary template, by subclassing the data
 *   models dnd5e registered;
 * - subclasses the registered chat log so a card that grows as its rolls fold in behaves
 *   like a new message: the log stays at the bottom, and a folded roll gets no separate
 *   notification while its card is shown there.
 * Rolls, data and workflow stay dnd5e's.
 */
const MODULE_ID = "steady-strike";
const TEMPLATES = `modules/${MODULE_ID}/templates`;

/** Summary template per roll message type. Healing has the damage card's layout. */
export const SUMMARY_TEMPLATES = {
  attack: `${TEMPLATES}/attack-summary.hbs`,
  damage: `${TEMPLATES}/damage-summary.hbs`,
  healing: `${TEMPLATES}/damage-summary.hbs`
};

/** Subclass of a roll message data model that declares a summary template. */
export function withSummaryTemplate(Base, summaryTemplate) {
  const Subclass = class extends Base {
    static metadata = Object.freeze(foundry.utils.mergeObject(super.metadata, { summaryTemplate }, { inplace: false }));
  };
  Object.defineProperty(Subclass, "name", { value: `SteadyStrike${Base.name}` });
  return Subclass;
}

/**
 * Whether dnd5e shows this message inside its usage card, with the condition
 * ChatMessage5e#renderHTML uses to hide the message's own card.
 */
export function isFolded(message) {
  return game.settings.get("dnd5e", "chatCardSummary")
    && !!message.system?.summaryTemplate
    && !!message.system.origin?.system?.rendersSummaries;
}

/** The notification currently showing a message, if any (#chat-notifications is ChatLog's). */
function notificationFor(messageId) {
  return document.getElementById("chat-notifications")
    ?.querySelector(`.message[data-message-id="${CSS.escape(messageId)}"]`) ?? null;
}

/**
 * Subclass of the chat log for cards whose rolls fold in. A folded roll is posted to the
 * log hidden (dnd5e), and its card is then re-rendered taller through updateMessage, which
 * neither scrolls nor notifies as posting a message does.
 */
export function withFoldedRolls(Base) {
  const Subclass = class extends Base {
    /**
     * Keep the log at the bottom when a card that shows summaries grows, if it was there:
     * what ChatLog#postOne does for a new message, and ChatLog5e does for an opening tray.
     * @override
     */
    async updateMessage(message, ...args) {
      const pinned = this.isAtBottom && !!message.system?.rendersSummaries;
      await super.updateMessage(message, ...args);
      if (pinned) this.scrollBottom({ waitImages: true });
    }

    /**
     * Do not post a notification for a folded roll while its card is in the notifications:
     * the card already shows the roll (ChatLog updates its notification copy). dnd5e hides
     * folded rolls only in the log, and ChatLog un-hides every notification after animating
     * it in, so this has to happen before the notification exists. When the card is not in
     * the notifications (expired, or never shown), the roll is notified as usual.
     * @override
     */
    notify(message, options = {}) {
      const card = (options.newMessage && isFolded(message)) ? notificationFor(message.system.origin.id) : null;
      if (!card) return super.notify(message, options);
      // ChatLog's notification timer: restart it so the updated card stays up as long as a new one.
      if ("_lifeSpan" in card) card._lifeSpan = 0;
      // What ChatLog#notify does besides posting: the message's sound (e.g. dice).
      if (message.sound) game.audio.play(message.sound, { context: game.audio.interface });
    }
  };
  Object.defineProperty(Subclass, "name", { value: `SteadyStrike${Base.name}` });
  return Subclass;
}

/**
 * Extend whatever is registered, so another module that does the same builds on top of
 * this one instead of replacing it.
 */
export function register(config) {
  const models = config.ChatMessage?.dataModels;
  if (!models?.usage?.prototype || !("rendersSummaries" in models.usage.prototype)) {
    console.warn(`${MODULE_ID} | dnd5e card summaries not found; nothing registered.`);
    return false;
  }
  for (const [type, template] of Object.entries(SUMMARY_TEMPLATES)) {
    if (models[type]) models[type] = withSummaryTemplate(models[type], template);
  }
  if (config.ui?.chat) config.ui.chat = withFoldedRolls(config.ui.chat);
  return true;
}

// dnd5e registers its data models and chat log in its own init hook, which runs before a
// module's; Foundry instantiates CONFIG.ui after init.
Hooks.once("init", () => {
  if (game.system.id !== "dnd5e") return;
  register(CONFIG);
});
