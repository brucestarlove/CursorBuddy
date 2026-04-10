/**
 * Contracts — Shared schemas for the perception/reasoning/execution pipeline.
 *
 * These define the structured data that flows between layers:
 *   Intent Router  →  Screen Analysis  →  Response Orchestrator  →  Action Planner
 *
 * Keeping these stable lets us later swap local routing for a remote
 * orchestrator without changing the desktop UI or execution layer.
 */

// ── Intent Classification ────────────────────────────────────

/**
 * @typedef {'non_visual' | 'visual_understanding' | 'visual_action'} IntentType
 */

/**
 * @typedef {Object} IntentResult
 * @property {string}     requestId    - unique id for correlation
 * @property {IntentType} intent       - classified intent
 * @property {boolean}    needsVision  - should we run screen analysis?
 * @property {boolean}    needsAction  - should we plan a click/type/scroll?
 * @property {number}     confidence   - 0-1 how sure the router is
 * @property {string[]}   matchedCues  - which keywords/patterns triggered
 */

function createIntentResult(fields) {
  return {
    requestId: fields.requestId || crypto.randomUUID(),
    intent: fields.intent || "non_visual",
    needsVision: fields.needsVision ?? false,
    needsAction: fields.needsAction ?? false,
    confidence: fields.confidence ?? 0.5,
    matchedCues: fields.matchedCues || [],
  };
}

// ── Perception / Screen Analysis ─────────────────────────────

/**
 * @typedef {Object} ObservedApp
 * @property {string} name
 * @property {number} screen       - 1-indexed screen number
 * @property {number} confidence   - 0-1
 */

/**
 * @typedef {Object} ObservedWindow
 * @property {string} kind         - e.g. "terminal", "browser", "editor"
 * @property {number} count
 * @property {number} screen
 * @property {number} confidence
 */

/**
 * @typedef {Object} ObservedElement
 * @property {string} label
 * @property {number} x            - screenshot pixel coords
 * @property {number} y
 * @property {number} screen       - 1-indexed
 * @property {number} confidence
 */

/**
 * @typedef {Object} ObservationResult
 * @property {string}            requestId
 * @property {ObservedApp[]}     apps
 * @property {ObservedWindow[]}  windows
 * @property {ObservedElement[]} elements
 * @property {string}            summary        - short natural-language summary
 * @property {number}            confidence      - overall 0-1
 * @property {boolean}           needsFollowup   - should we ask a clarifying question?
 * @property {string}            [rawModelResponse] - optional: keep the raw text for debugging
 */

function createObservationResult(fields) {
  return {
    requestId: fields.requestId || "",
    apps: fields.apps || [],
    windows: fields.windows || [],
    elements: fields.elements || [],
    summary: fields.summary || "",
    confidence: fields.confidence ?? 0,
    needsFollowup: fields.needsFollowup ?? false,
    rawModelResponse: fields.rawModelResponse || undefined,
  };
}

// ── Action Planning ──────────────────────────────────────────

/**
 * @typedef {'point' | 'click' | 'type' | 'key_press' | 'open' | 'scroll' | 'none'} ActionType
 */

/**
 * @typedef {Object} ActionPlan
 * @property {string}     requestId
 * @property {ActionType} type
 * @property {Object}     [target]       - { x, y, screen, label }
 * @property {string}     [text]         - for type actions
 * @property {string}     [keys]         - for key_press actions
 * @property {string}     [url]          - for open actions
 * @property {number}     confidence
 * @property {string}     reason         - why this action was chosen
 */

function createActionPlan(fields) {
  return {
    requestId: fields.requestId || "",
    type: fields.type || "none",
    target: fields.target || undefined,
    text: fields.text || undefined,
    keys: fields.keys || undefined,
    url: fields.url || undefined,
    confidence: fields.confidence ?? 0,
    reason: fields.reason || "",
  };
}

// ── Conversation Turn (for remote orchestrator handoff) ──────

/**
 * @typedef {Object} ConversationTurn
 * @property {string}             requestId
 * @property {string}             userText
 * @property {IntentType}         intent
 * @property {ObservationResult}  [perception]    - if visual query
 * @property {ActionPlan}         [actionPlan]    - if visual action
 * @property {Object[]}           [toolResults]   - MCP / system tool results
 * @property {string}             assistantText   - final response
 */

function createConversationTurn(fields) {
  return {
    requestId: fields.requestId || "",
    userText: fields.userText || "",
    intent: fields.intent || "non_visual",
    perception: fields.perception || undefined,
    actionPlan: fields.actionPlan || undefined,
    toolResults: fields.toolResults || [],
    assistantText: fields.assistantText || "",
  };
}

// ── Perception Request (for future remote calls) ────────────

/**
 * @typedef {Object} PerceptionRequest
 * @property {string}   requestId
 * @property {string}   query
 * @property {Object[]} screens       - screen capture data
 * @property {number}   cursorScreen  - 1-indexed
 * @property {Object}   context       - { platform, activeIntent }
 */

function createPerceptionRequest(fields) {
  return {
    requestId: fields.requestId || crypto.randomUUID(),
    query: fields.query || "",
    screens: fields.screens || [],
    cursorScreen: fields.cursorScreen ?? 1,
    context: {
      platform: fields.context?.platform || process.platform,
      activeIntent: fields.context?.activeIntent || "unknown",
      ...(fields.context || {}),
    },
  };
}

module.exports = {
  createIntentResult,
  createObservationResult,
  createActionPlan,
  createConversationTurn,
  createPerceptionRequest,
};
