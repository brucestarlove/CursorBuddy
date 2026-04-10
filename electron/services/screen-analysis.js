/**
 * Screen Analysis Service — Perception Layer
 *
 * Takes screenshots + user query, calls the configured vision/CU model,
 * and returns structured ObservationResult (not prose).
 *
 * This is the dedicated visual pipeline that replaces the old fallback-only
 * CU approach. For visual queries, this runs FIRST, and its structured
 * output feeds the chat model's response generation.
 *
 * Supports: Anthropic, OpenAI, Ollama, LM Studio vision models.
 */

const { createObservationResult } = require("../lib/contracts.js");
const log = require("../lib/session-logger.js");

// ── Analysis Prompt ──────────────────────────────────────────

const ANALYSIS_SYSTEM_PROMPT = `You are a screen analysis system. You receive screenshots and a user query. Your job is to analyze what's visible and return ONLY a JSON object — no markdown, no prose, no explanation.

Return this exact JSON structure:
{
  "apps": [{"name": "AppName", "screen": 1, "confidence": 0.9}],
  "windows": [{"kind": "terminal", "count": 2, "screen": 1, "confidence": 0.85}],
  "elements": [{"label": "button label or description", "x": 640, "y": 400, "screen": 1, "confidence": 0.8}],
  "summary": "Brief one-sentence description of what's visible",
  "confidence": 0.85
}

Rules:
- x,y coordinates are in screenshot pixel space (origin top-left)
- screen numbers are 1-indexed, matching the screenshot labels
- confidence is 0.0-1.0 for each observation
- only include elements the user is asking about or that are clearly relevant
- if the user asks "where is X", the elements array MUST contain X with coordinates
- if the user asks "what app is this", the apps array MUST contain the identified app
- keep the summary under 50 words
- return ONLY the JSON object, nothing else`;

/**
 * Build the analysis prompt for a specific query.
 */
function buildAnalysisPrompt(userQuery, intentType) {
  let focus = "";
  if (intentType === "visual_action") {
    focus = "\nFocus on finding the specific UI element the user wants to interact with. Include precise x,y coordinates in the elements array.";
  } else if (intentType === "visual_understanding") {
    focus = "\nFocus on describing what's visible — apps, windows, content. Include elements only if the user is asking about specific things.";
  }
  return `User query: "${userQuery}"${focus}\n\nAnalyze the screenshots and return the JSON observation.`;
}

// ── Provider Dispatch ────────────────────────────────────────

/**
 * Run screen analysis on captured screens.
 *
 * @param {Object} opts
 * @param {string}   opts.requestId     - correlation id
 * @param {string}   opts.query         - user's question
 * @param {string}   opts.intentType    - 'visual_understanding' | 'visual_action'
 * @param {Object[]} opts.screens       - screen captures from capture service
 * @param {Object}   opts.settings      - full settings (keys, providers)
 * @returns {Promise<import('../lib/contracts.js').ObservationResult>}
 */
async function analyzeScreens(opts) {
  const { requestId, query, intentType, screens, settings } = opts;

  // Determine which provider/model to use for vision analysis.
  // Priority: visionProvider > chatProvider (skip cuProvider — CU models like
  // computer-use-preview are CU-specific and can't do general vision calls)
  const provider = settings.visionProvider || settings.chatProvider || "anthropic";
  const model = settings.visionModel || (
    // Only fall through to chatModel if the provider matches, otherwise use defaults
    (settings.visionProvider && settings.visionModel) ? settings.visionModel
    : provider === "anthropic" ? "claude-sonnet-4-6"
    : provider === "openai" ? "gpt-4o"
    : settings.chatModel
  );

  log.event("screen_analysis:start", {
    requestId,
    provider,
    model,
    intentType,
    screenCount: screens.length,
  });

  try {
    let result;
    switch (provider) {
      case "anthropic":
        result = await analyzeWithAnthropic(requestId, query, intentType, screens, settings, model);
        break;
      case "openai":
        result = await analyzeWithOpenAI(requestId, query, intentType, screens, settings, model);
        break;
      case "ollama":
      case "lmstudio":
        result = await analyzeWithLocalVision(provider, requestId, query, intentType, screens, settings, model);
        break;
      default:
        throw new Error(`Unknown vision provider: ${provider}`);
    }

    log.event("screen_analysis:complete", {
      requestId,
      provider,
      appsFound: result.apps.length,
      elementsFound: result.elements.length,
      confidence: result.confidence,
    });

    return result;
  } catch (err) {
    log.error("screen_analysis:error", err, { requestId, provider });
    // Return an empty observation on failure — caller decides what to do
    return createObservationResult({
      requestId,
      summary: `Screen analysis failed: ${err.message}`,
      confidence: 0,
      needsFollowup: true,
    });
  }
}

// ── Anthropic Vision ─────────────────────────────────────────

async function analyzeWithAnthropic(requestId, query, intentType, screens, settings, model) {
  const Anthropic = require("@anthropic-ai/sdk").default;
  if (!settings.anthropicKey) throw new Error("Anthropic API key required for screen analysis");

  const client = new Anthropic({ apiKey: settings.anthropicKey });

  const content = [];
  for (const scr of screens) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: scr.imageDataBase64 },
    });
    content.push({ type: "text", text: scr.label });
  }
  content.push({ type: "text", text: buildAnalysisPrompt(query, intentType) });

  const response = await client.messages.create({
    model: model || "claude-sonnet-4-6",
    max_tokens: 1024,
    system: ANALYSIS_SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
  });

  const text = response.content?.find(b => b.type === "text")?.text || "{}";
  return parseAnalysisResponse(requestId, text);
}

// ── OpenAI Vision ────────────────────────────────────────────

async function analyzeWithOpenAI(requestId, query, intentType, screens, settings, model) {
  const OpenAI = require("openai").default;
  if (!settings.openaiKey) throw new Error("OpenAI API key required for screen analysis");

  const client = new OpenAI({ apiKey: settings.openaiKey });

  const userContent = [];
  for (const scr of screens) {
    userContent.push({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${scr.imageDataBase64}` },
    });
    userContent.push({ type: "text", text: scr.label });
  }
  userContent.push({ type: "text", text: buildAnalysisPrompt(query, intentType) });

  const modelName = model || "gpt-4o";
  const usesNewTokenParam = /^(gpt-5|o[34])/.test(modelName);
  const tokenParam = usesNewTokenParam
    ? { max_completion_tokens: 1024 }
    : { max_tokens: 1024 };

  const response = await client.chat.completions.create({
    model: modelName,
    ...tokenParam,
    messages: [
      { role: "system", content: ANALYSIS_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
  });

  const text = response.choices?.[0]?.message?.content || "{}";
  return parseAnalysisResponse(requestId, text);
}

// ── Local Vision (Ollama / LM Studio) ────────────────────────

async function analyzeWithLocalVision(provider, requestId, query, intentType, screens, settings, model) {
  const OpenAI = require("openai").default;

  let baseURL, apiKey;
  if (provider === "ollama") {
    baseURL = (settings.ollamaUrl || "http://localhost:11434") + "/v1";
    apiKey = "ollama";
  } else {
    baseURL = (settings.lmstudioUrl || "http://localhost:1234") + "/v1";
    apiKey = "lmstudio";
  }

  const client = new OpenAI({ baseURL, apiKey });
  const modelName = model || (provider === "ollama" ? "llava" : undefined);
  if (!modelName) throw new Error(`No ${provider} vision model configured`);

  const userContent = [];
  for (const scr of screens) {
    userContent.push({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${scr.imageDataBase64}` },
    });
    userContent.push({ type: "text", text: scr.label });
  }
  userContent.push({ type: "text", text: buildAnalysisPrompt(query, intentType) });

  const response = await client.chat.completions.create({
    model: modelName,
    max_tokens: 1024,
    temperature: 0,
    messages: [
      { role: "system", content: ANALYSIS_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
  });

  const text = response.choices?.[0]?.message?.content || "{}";
  return parseAnalysisResponse(requestId, text);
}

// ── Response Parsing ─────────────────────────────────────────

/**
 * Parse the model's JSON response into a validated ObservationResult.
 * Handles markdown-wrapped JSON, partial JSON, and malformed responses.
 */
function parseAnalysisResponse(requestId, rawText) {
  let parsed;
  try {
    // Strip markdown code fences if present
    let cleaned = rawText.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }
    parsed = JSON.parse(cleaned);
  } catch (_) {
    // Try to extract JSON from mixed text
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch (_) {
        return createObservationResult({
          requestId,
          summary: rawText.slice(0, 200),
          confidence: 0.1,
          needsFollowup: true,
          rawModelResponse: rawText,
        });
      }
    } else {
      return createObservationResult({
        requestId,
        summary: rawText.slice(0, 200),
        confidence: 0.1,
        needsFollowup: true,
        rawModelResponse: rawText,
      });
    }
  }

  // Validate and normalize arrays
  const apps = Array.isArray(parsed.apps)
    ? parsed.apps.map(a => ({
        name: String(a.name || ""),
        screen: Number(a.screen) || 1,
        confidence: clampConfidence(a.confidence),
      }))
    : [];

  const windows = Array.isArray(parsed.windows)
    ? parsed.windows.map(w => ({
        kind: String(w.kind || "unknown"),
        count: Number(w.count) || 1,
        screen: Number(w.screen) || 1,
        confidence: clampConfidence(w.confidence),
      }))
    : [];

  const elements = Array.isArray(parsed.elements)
    ? parsed.elements.map(e => ({
        label: String(e.label || "element"),
        x: Number(e.x) || 0,
        y: Number(e.y) || 0,
        screen: Number(e.screen) || 1,
        confidence: clampConfidence(e.confidence),
      }))
    : [];

  return createObservationResult({
    requestId,
    apps,
    windows,
    elements,
    summary: String(parsed.summary || ""),
    confidence: clampConfidence(parsed.confidence),
    needsFollowup: parsed.confidence != null && parsed.confidence < 0.4,
    rawModelResponse: rawText,
  });
}

function clampConfidence(val) {
  const n = Number(val);
  if (isNaN(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

module.exports = { analyzeScreens };
