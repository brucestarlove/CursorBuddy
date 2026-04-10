/**
 * Intent Router
 *
 * Classifies user requests into three categories:
 *   - non_visual:            no screen context needed
 *   - visual_understanding:  needs screen analysis (what app, what's on screen)
 *   - visual_action:         needs screen analysis + action execution (click, open, find)
 *
 * Two classification modes:
 *   1. Semantic — fast local LLM call (LM Studio / Ollama) for accurate classification
 *   2. Keyword — regex heuristics as fallback when no local model is available
 *
 * Later this slot can be replaced by a remote orchestrator.
 */

const { createIntentResult } = require("../lib/contracts.js");
const log = require("../lib/session-logger.js");

// ── Semantic Classification (local LLM) ─────────────────────

const CLASSIFY_PROMPT = `Classify the user's intent into exactly one category. Reply with ONLY the category name, nothing else.

Categories:
- non_visual: general questions, conversation, tasks that don't need screen context (jokes, drafts, calculations, summaries, coding help, general knowledge)
- visual_understanding: user wants to know what's on their screen, identify apps/windows/elements, read text or errors visible on screen
- visual_action: user wants to interact with something on screen (click, open, scroll, find a button, navigate, point to something)

User message: `;

/**
 * Classify intent using a local LLM for semantic understanding.
 * Fast and free — runs against LM Studio or Ollama.
 *
 * @param {string} text - user's message
 * @param {object} settings - app settings (for local model URLs)
 * @returns {Promise<{intent: string, confidence: number} | null>} null if unavailable
 */
async function classifyWithLocalLLM(text, settings) {
  // Try local endpoints for fast, free intent classification.
  // Always probe LM Studio and Ollama on their default ports — even if the
  // user's main provider is cloud. The 3s timeout handles "not running."
  const lmstudioUrl = settings.lmstudioUrl || "http://localhost:1234";
  const ollamaUrl = settings.ollamaUrl || "http://localhost:11434";

  // Try LM Studio first, then Ollama
  const endpoints = [
    { baseURL: lmstudioUrl + "/v1", apiKey: "lmstudio", label: "lmstudio" },
    { baseURL: ollamaUrl + "/v1", apiKey: "ollama", label: "ollama" },
  ];

  for (const ep of endpoints) {
    const result = await tryLocalClassify(text, ep.baseURL, ep.apiKey, settings.fastModel);
    if (result) return result;
  }

  return null;
}

async function tryLocalClassify(text, baseURL, apiKey, model) {

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000); // 3s max

    const response = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: model || undefined,
        messages: [{ role: "user", content: CLASSIFY_PROMPT + text }],
        max_tokens: 20,
        temperature: 0,
        stream: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) return null;

    const data = await response.json();
    const raw = (data.choices?.[0]?.message?.content || "").trim().toLowerCase();

    // Parse the response — look for one of our three categories
    let intent = null;
    if (raw.includes("visual_action")) intent = "visual_action";
    else if (raw.includes("visual_understanding")) intent = "visual_understanding";
    else if (raw.includes("non_visual")) intent = "non_visual";

    if (!intent) return null;

    log.event("intent:semantic_classify", { intent, raw: raw.slice(0, 50), model: model || "default" });
    return { intent, confidence: 0.85 }; // Local LLM gets solid but not perfect confidence
  } catch (err) {
    // Timeout or connection refused — local model not running
    if (err.name !== "AbortError") {
      log.event("intent:semantic_unavailable", { error: err.message });
    }
    return null;
  }
}

// ── Pattern Banks (keyword fallback) ────────────────────────
// Each entry: [regex, weight]. Higher weight = stronger signal.

const VISUAL_UNDERSTANDING_PATTERNS = [
  [/\bwhat(?:'s| is) (?:on |this |that |the )?(screen|display|monitor)/i, 1.0],
  [/\bwhat app/i, 1.0],
  [/\bwhat(?:'s| is) (?:this|that)\b/i, 0.7],
  [/\bhow many (windows?|tabs?|screens?|monitors?|displays?)/i, 0.9],
  [/\bwhat do you see\b/i, 1.0],
  [/\bdo you see\b/i, 0.9],
  [/\bcan you see\b/i, 0.8],
  [/\byou see (?:any|the|my|a)\b/i, 0.7],
  [/\bsee (?:anything|something|any)\b/i, 0.7],
  [/\bdescribe (?:the |my |this )?(screen|display|window|desktop)/i, 1.0],
  [/\bidentify\b/i, 0.7],
  [/\brecognize\b/i, 0.6],
  [/\bread (?:the |this |that )?(text|screen|error|message|notification)/i, 0.8],
  [/\bwhat(?:'s| is) (?:the |that )?(error|warning|notification|message|dialog|popup|alert)/i, 0.8],
  [/\bwhich (app|application|program|window|browser|tab)/i, 0.9],
  [/\btell me (?:about )?what(?:'s| is) (?:on |happening)/i, 0.8],
  [/\blook at (?:the |my |this )?screen/i, 0.9],
  [/\bscreen ?\d\b/i, 0.6],
];

const VISUAL_ACTION_PATTERNS = [
  [/\bclick(?: on)?\b/i, 1.0],
  [/\btap(?: on)?\b/i, 0.8],
  [/\bpress(?: the| on)?\b/i, 0.6],
  [/\bopen (?:the |that |this )?/i, 0.7],
  [/\bclose (?:the |that |this )?/i, 0.6],
  [/\bfind (?:the |a |where)/i, 0.7],
  [/\bwhere(?:'s| is) (?:the |a )?/i, 0.8],
  [/\bshow me (?:where|how to)/i, 0.9],
  [/\bpoint (?:to|at|me to)\b/i, 1.0],
  [/\bnavigate to\b/i, 0.8],
  [/\bgo to\b/i, 0.6],
  [/\bscroll (up|down|to)\b/i, 0.9],
  [/\btype\b/i, 0.6],
  [/\bselect (?:the |that |this )/i, 0.7],
  [/\bdrag\b/i, 0.8],
  [/\bswitch to\b/i, 0.7],
  [/\bminimize\b/i, 0.8],
  [/\bmaximize\b/i, 0.8],
  [/\bresize\b/i, 0.7],
  [/\bhighlight\b/i, 0.6],
  [/\bfocus(?: on)?\b/i, 0.5],
];

const NON_VISUAL_PATTERNS = [
  [/\b(summarize|summary|recap)\b/i, 0.7],
  [/\b(explain|what does|how does|why does)\b.*\b(mean|work|do)\b/i, 0.6],
  [/\b(draft|write|compose)\b.*\b(email|message|text|letter|response)\b/i, 0.8],
  [/\b(remind|remember|note)\b/i, 0.6],
  [/\b(calculate|convert|compute)\b/i, 0.8],
  [/\b(translate)\b/i, 0.8],
  [/\b(tell me a |joke|story)\b/i, 0.9],
  [/\b(what time|weather|date|day)\b/i, 0.7],
  [/\b(set a timer|set an alarm|countdown)\b/i, 0.9],
  [/\b(search for|look up|google)\b/i, 0.5],
  [/\b(todo|task|checklist)\b/i, 0.6],
];

// ── Keyword Router (fallback) ────────────────────────────────

function routeIntentKeywords(text, hasAttachments) {
  let visualUnderstandingScore = 0;
  let visualActionScore = 0;
  let nonVisualScore = 0;
  const matchedCues = [];

  for (const [pattern, weight] of VISUAL_UNDERSTANDING_PATTERNS) {
    if (pattern.test(text)) {
      visualUnderstandingScore += weight;
      matchedCues.push(`vu:${pattern.source.slice(0, 30)}`);
    }
  }

  for (const [pattern, weight] of VISUAL_ACTION_PATTERNS) {
    if (pattern.test(text)) {
      visualActionScore += weight;
      matchedCues.push(`va:${pattern.source.slice(0, 30)}`);
    }
  }

  for (const [pattern, weight] of NON_VISUAL_PATTERNS) {
    if (pattern.test(text)) {
      nonVisualScore += weight;
      matchedCues.push(`nv:${pattern.source.slice(0, 30)}`);
    }
  }

  if (hasAttachments) {
    visualUnderstandingScore += 0.5;
    matchedCues.push("boost:attachment");
  }

  let intent = "non_visual";
  let topScore = nonVisualScore;

  if (visualActionScore > topScore) {
    intent = "visual_action";
    topScore = visualActionScore;
  }
  if (visualUnderstandingScore > topScore) {
    intent = "visual_understanding";
    topScore = visualUnderstandingScore;
  }

  const totalScore = nonVisualScore + visualUnderstandingScore + visualActionScore;
  const confidence = totalScore > 0
    ? Math.min(topScore / Math.max(totalScore, 1), 1.0)
    : 0.5;

  return { intent, confidence: Math.round(confidence * 100) / 100, matchedCues };
}

// ── Public API ───────────────────────────────────────────────

/**
 * Classify a user request. Tries semantic (local LLM) first, falls back to keywords.
 *
 * @param {Object} opts
 * @param {string}   opts.transcript       - the user's message
 * @param {boolean}  [opts.hasScreenshots] - were screenshots captured?
 * @param {boolean}  [opts.hasAttachments] - did user attach images?
 * @param {object}   [opts.settings]       - app settings (for local model access)
 * @returns {Promise<import('../lib/contracts.js').IntentResult>}
 */
async function routeIntent({ transcript, hasScreenshots = false, hasAttachments = false, settings = null }) {
  const text = (transcript || "").trim();
  if (!text) {
    return createIntentResult({ intent: "non_visual", confidence: 1.0, matchedCues: ["empty"] });
  }

  // Try semantic classification first (local LLM — fast, free)
  if (settings) {
    const semantic = await classifyWithLocalLLM(text, settings);
    if (semantic) {
      return createIntentResult({
        intent: semantic.intent,
        needsVision: semantic.intent !== "non_visual",
        needsAction: semantic.intent === "visual_action",
        confidence: semantic.confidence,
        matchedCues: ["semantic"],
      });
    }
  }

  // Fall back to keyword heuristics
  const kw = routeIntentKeywords(text, hasAttachments);

  return createIntentResult({
    intent: kw.intent,
    needsVision: kw.intent !== "non_visual",
    needsAction: kw.intent === "visual_action",
    confidence: kw.confidence,
    matchedCues: kw.matchedCues,
  });
}

module.exports = { routeIntent };
