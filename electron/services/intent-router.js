/**
 * Intent Router
 *
 * Classifies user requests into three categories:
 *   - non_visual:            no screen context needed
 *   - visual_understanding:  needs screen analysis (what app, what's on screen)
 *   - visual_action:         needs screen analysis + action execution (click, open, find)
 *
 * Currently uses keyword heuristics. Later this slot can be replaced by
 * a remote orchestrator doing centralized intent matching.
 */

const { createIntentResult } = require("../lib/contracts.js");

// ── Pattern Banks ────────────────────────────────────────────
// Each entry: [regex, weight]. Higher weight = stronger signal.

const VISUAL_UNDERSTANDING_PATTERNS = [
  [/\bwhat(?:'s| is) (?:on |this |that |the )?(screen|display|monitor)/i, 1.0],
  [/\bwhat app/i, 1.0],
  [/\bwhat(?:'s| is) (?:this|that)\b/i, 0.7],
  [/\bhow many (windows?|tabs?|screens?|monitors?|displays?)/i, 0.9],
  [/\bwhat do you see\b/i, 1.0],
  [/\bcan you see\b/i, 0.8],
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

// Patterns that suggest NO visual context is needed (boost non_visual)
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

// ── Router ───────────────────────────────────────────────────

/**
 * Classify a user request.
 *
 * @param {Object} opts
 * @param {string}   opts.transcript       - the user's message
 * @param {boolean}  [opts.hasScreenshots] - were screenshots captured?
 * @param {boolean}  [opts.hasAttachments] - did user attach images?
 * @param {string[]} [opts.previousTurns]  - recent conversation context
 * @returns {import('../lib/contracts.js').IntentResult}
 */
function routeIntent({ transcript, hasScreenshots = false, hasAttachments = false, previousTurns = [] }) {
  const text = (transcript || "").trim();
  if (!text) {
    return createIntentResult({ intent: "non_visual", confidence: 1.0, matchedCues: [] });
  }

  // Score each category
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

  // Boost visual scores if user attached images
  if (hasAttachments) {
    visualUnderstandingScore += 0.5;
    matchedCues.push("boost:attachment");
  }

  // Determine winner
  const scores = {
    non_visual: nonVisualScore,
    visual_understanding: visualUnderstandingScore,
    visual_action: visualActionScore,
  };

  // Visual action implies visual understanding too
  // If action score is highest, intent is visual_action
  // If understanding score is highest, intent is visual_understanding
  // Otherwise non_visual
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

  // If all scores are 0, default to non_visual
  // But if screenshots exist and no strong non-visual signal, lean visual
  if (topScore === 0 && hasScreenshots && nonVisualScore === 0) {
    // Ambiguous — could go either way. Keep as non_visual but low confidence.
    intent = "non_visual";
    topScore = 0.1;
  }

  // Compute confidence: how decisive was the classification?
  const totalScore = nonVisualScore + visualUnderstandingScore + visualActionScore;
  const confidence = totalScore > 0
    ? Math.min(topScore / Math.max(totalScore, 1), 1.0)
    : 0.5;

  return createIntentResult({
    intent,
    needsVision: intent !== "non_visual",
    needsAction: intent === "visual_action",
    confidence: Math.round(confidence * 100) / 100,
    matchedCues,
  });
}

module.exports = { routeIntent };
