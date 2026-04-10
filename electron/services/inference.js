/**
 * Inference Service
 *
 * Streaming LLM inference via Anthropic SDK, OpenAI SDK, and local
 * LLM endpoints (Ollama, LM Studio). Sends chunks to the renderer
 * via IPC as they arrive.
 *
 * All providers normalize to the same stream event format:
 *   { type: 'text'|'done'|'error', text?, error? }
 */

const Anthropic = require("@anthropic-ai/sdk").default;
const OpenAI = require("openai").default;
const { extractToolResultText } = require("../lib/tool-result-text.js");
const { parsePointingCoordinates } = require("../lib/point-parser.js");
const log = require("../lib/session-logger.js");

const SYSTEM_PROMPT_BASE = `you're cursorbuddy, a friendly always-on companion that lives in the user's menu bar. the user speaks to you via push-to-talk or types in the chat panel. you can see their screen(s) and any screenshots they've attached. your reply will be spoken aloud via text-to-speech AND displayed in a chat panel, so write conversationally. this is an ongoing conversation — you remember everything they've said before.

rules:
- default to one or two sentences. be direct and dense. BUT if the user asks you to explain more, go deeper, or elaborate, then go all out.
- all lowercase, casual, warm. no emojis.
- write for the ear, not the eye. short sentences. no lists, bullet points, markdown, or formatting — just natural speech.
- don't use abbreviations or symbols that sound weird read aloud. write "for example" not "e.g.", spell out small numbers.
- if the user's question relates to what's on their screen, reference specific things you see.
- if the screenshot doesn't seem relevant to their question, just answer the question directly.
- if the user has attached a screenshot (labeled "user-attached screenshot"), that's something they specifically want you to look at — prioritise it.
- never say "simply" or "just".
- don't read out code verbatim. describe what the code does or what needs to change conversationally.
- focus on giving a thorough, useful explanation. don't end with simple yes/no questions.
- instead, when it fits naturally, end by planting a seed — mention something bigger they could try, a related concept, or a next-level technique.

element pointing:
you have a small blue triangle cursor that can fly to and point at things on screen. use it whenever pointing would genuinely help the user — if they're asking how to do something, looking for a menu, trying to find a button, or need help navigating. err on the side of pointing. your spoken text will appear as a bubble next to the cursor when you point.

when you point, append a coordinate tag at the very end of your response, AFTER your spoken text. the screenshot images are labeled with their pixel dimensions. use those dimensions as the coordinate space. origin (0,0) is top-left.

format: [POINT:x,y:label] where x,y are integer pixel coordinates and label is a short 1-3 word description. if the element is on a DIFFERENT screen, append :screenN.

if pointing wouldn't help, append [POINT:none].

screen analysis:
when your input includes a [Screen Analysis] block, a dedicated vision system has already analyzed the screenshots. use that data to answer — reference the apps, windows, and elements it found. if elements have coordinates, use those for pointing instead of guessing from the screenshot.

other tools:
you may also have access to additional tools. if tools are listed in the conversation, use them when helpful. when you use a tool, briefly explain what you're doing.

screenshots:
you receive automatic screenshots of all connected displays with each message. the one labeled "primary focus" is where the cursor is. if the user has manually attached screenshots (labeled "user-attached screenshot"), those are things they specifically captured and want you to analyze — give them priority over the auto-captured screens.`;

const PLATFORM_TOOL_HINTS = {
  darwin: `\ncomputer control:
you have tools to control the user's computer. when the user asks you to open something, click something, type something, or navigate — DO IT using your tools. don't just describe how to do it. use the tools:
- open_app_or_url: open apps by name or URLs in the browser. use this first when asked to open something.
- click: click at screen coordinates. use with screenshot coordinates converted to screen space.
- type_text: type text at the current cursor position. click a text field first.
- key_press: press keyboard shortcuts like "cmd+t", "cmd+l", "return", "escape".
- scroll: scroll up or down at a position.
- wait: pause between actions to let the UI update.

when the user says "open github", use open_app_or_url with "https://github.com". when they say "open safari", use open_app_or_url with "Safari". always act, don't just explain.`,

  win32: `\ncomputer control:
you have tools to control the user's Windows computer. when the user asks you to open something, click something, type something, or navigate — DO IT using your tools. don't just describe how to do it. use the tools:
- open_app_or_url: open apps by name or URLs in the browser. use this first when asked to open something.
- click: click at screen coordinates. use with screenshot coordinates converted to screen space.
- type_text: type text at the current cursor position. click a text field first.
- key_press: press keyboard shortcuts like "ctrl+t", "ctrl+l", "return", "escape", "alt+space". use ctrl instead of cmd on windows.
- scroll: scroll up or down at a position.
- wait: pause between actions to let the UI update.

when the user says "open github", use open_app_or_url with "https://github.com". when they say "open chrome", use open_app_or_url with "Chrome". always act, don't just explain.`,
};

function getSystemPrompt() {
  const toolHint = PLATFORM_TOOL_HINTS[process.platform] || PLATFORM_TOOL_HINTS.win32;
  return SYSTEM_PROMPT_BASE + toolHint;
}

// Keep backward compat — SYSTEM_PROMPT is still exported
const SYSTEM_PROMPT = getSystemPrompt();

/** Conversation history — kept in the main process */
let conversationHistory = [];
const MAX_HISTORY = 10;

function addToHistory(userMessage, assistantMessage) {
  // Strip POINT tags from stored history so stale coordinates don't leak
  // into future turns and cause the model to echo them
  const cleanAssistant = assistantMessage.replace(/\s*\[POINT:[^\]]*\]\s*/g, "").trim();
  conversationHistory.push({ user: userMessage, assistant: cleanAssistant });
  if (conversationHistory.length > MAX_HISTORY) {
    conversationHistory = conversationHistory.slice(-MAX_HISTORY);
  }
}

function clearHistory() {
  conversationHistory = [];
}

// ── SDK Client Cache ─────────────────────────────────────────
// Reuse clients when the API key hasn't changed, preserving connection pools.

let cachedAnthropicClient = null;
let cachedAnthropicKey = null;

function getAnthropicClient(apiKey) {
  if (cachedAnthropicClient && cachedAnthropicKey === apiKey) {
    return cachedAnthropicClient;
  }
  cachedAnthropicClient = new Anthropic({ apiKey });
  cachedAnthropicKey = apiKey;
  return cachedAnthropicClient;
}

/** @type {Map<string, {client: any, baseURL: string, apiKey: string}>} */
const openAIClientCache = new Map();

function getOpenAIClient(baseURL, apiKey) {
  const cacheKey = `${baseURL}|${apiKey}`;
  const existing = openAIClientCache.get(cacheKey);
  if (existing) return existing.client;
  const client = new OpenAI({ baseURL, apiKey });
  openAIClientCache.set(cacheKey, { client, baseURL, apiKey });
  return client;
}

// ── Tool Execution ───────────────────────────────────────────

/**
 * Create a tool executor for the given MCP tools.
 * Resolves the right backend (MCP client, pi-compatible tool, tool-loader).
 */
function createToolExecutor(mcpTools) {
  if (!mcpTools || mcpTools.length === 0) return null;

  return async (name, input) => {
    const tool = mcpTools.find(t => t.name === name);
    if (!tool) return { error: `Tool ${name} not found` };

    // MCP client tool
    if (tool.serverName) {
      const mcpClient = require("./mcp-client.js");
      try {
        return await mcpClient.callTool(tool.serverName, name, input);
      } catch (err) { return { error: err.message }; }
    }

    // pi-compatible tool with inline execute
    if (tool.execute) {
      try { return await tool.execute(input); } catch (err) { return { error: err.message }; }
    }

    // Fall through to tool-loader
    const toolLoader = require("./tool-loader.js");
    try { return await toolLoader.executeTool(name, input); } catch (err) { return { error: err.message }; }
  };
}

/**
 * Build the system prompt with tool awareness.
 */
function buildSystemPrompt(mcpTools) {
  if (!mcpTools || mcpTools.length === 0) return SYSTEM_PROMPT;
  const toolList = mcpTools.map(t => `- ${t.name}: ${t.description}`).join('\n');
  return `${SYSTEM_PROMPT}\n\navailable tools:\n${toolList}\n\nuse these tools whenever the user asks you to do something actionable. don't describe how to do it — use the tool and do it.`;
}

/**
 * Build a structured observation context block from screen analysis results.
 * This replaces the old approach of injecting JSON into the transcript string.
 * The observation data is presented as a separate context block that the model
 * can reference without it being confused with the user's actual message.
 */
function buildObservationContext(observations) {
  const parts = ["[Screen Analysis]"];

  if (observations.apps.length > 0) {
    const appList = observations.apps.map(a => `${a.name} (screen ${a.screen})`).join(", ");
    parts.push(`Visible apps: ${appList}`);
  }

  if (observations.windows.length > 0) {
    const winList = observations.windows.map(w => `${w.count} ${w.kind} window${w.count > 1 ? "s" : ""} (screen ${w.screen})`).join(", ");
    parts.push(`Windows: ${winList}`);
  }

  if (observations.elements.length > 0) {
    const elList = observations.elements.map(e => `"${e.label}" at (${e.x},${e.y}) screen ${e.screen}`).join("; ");
    parts.push(`Elements found: ${elList}`);
    parts.push("Use these coordinates for pointing if relevant.");
  }

  if (observations.summary) {
    parts.push(`Summary: ${observations.summary}`);
  }

  parts.push(`Analysis confidence: ${observations.confidence}`);
  return parts.join("\n");
}

/**
 * Build Anthropic-format tool definitions from MCP tools.
 */
function buildAnthropicToolDefs(mcpTools) {
  if (!mcpTools || mcpTools.length === 0) return undefined;
  return mcpTools.map(t => ({
    name: t.name,
    description: t.description || '',
    input_schema: t.inputSchema || t.parameters || { type: 'object', properties: {} },
  }));
}

/**
 * Run inference with the configured provider.
 * @param {object} opts
 * @param {string} opts.provider - 'anthropic'|'openai'|'ollama'|'lmstudio'
 * @param {string} opts.model - model name
 * @param {string} opts.transcript - user's message
 * @param {Array} opts.screens - screenshot data from capture service
 * @param {object} opts.settings - full settings object (keys, params)
 * @param {object} [opts.observations] - structured screen analysis result (ObservationResult)
 * @param {function} opts.onChunk - called with {type, text?, error?}
 * @returns {Promise<string>} full response text
 */
async function runInference(opts) {
  const { provider, model, transcript, screens, settings, onChunk, mcpTools, observations } = opts;

  switch (provider) {
    case "anthropic":
      return runAnthropicInference(model, transcript, screens, settings, onChunk, mcpTools, observations);
    case "openai":
    case "ollama":
    case "lmstudio":
      return runOpenAICompatibleInference(provider, model, transcript, screens, settings, onChunk, mcpTools, observations);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

// ── Anthropic ─────────────────────────────────────────────

async function runAnthropicInference(model, transcript, screens, settings, onChunk, mcpTools, observations) {
  const client = getAnthropicClient(settings.anthropicKey);

  // Build messages with conversation history
  const messages = [];
  for (const turn of conversationHistory) {
    messages.push({ role: "user", content: turn.user });
    messages.push({ role: "assistant", content: turn.assistant });
  }

  // Current message with images
  const content = [];
  for (const scr of screens) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: scr.imageDataBase64 },
    });
    content.push({ type: "text", text: scr.label });
  }

  // Inject structured observations as a separate context block before the user query
  if (observations && observations.confidence > 0.2) {
    content.push({ type: "text", text: buildObservationContext(observations) });
  }

  content.push({ type: "text", text: transcript });
  messages.push({ role: "user", content });

  let fullText = "";
  let thinkingText = "";

  // Build request params
  const requestParams = {
    model: model || "claude-sonnet-4-6",
    max_tokens: settings.maxTokens || 1024,
    system: buildSystemPrompt(mcpTools),
    messages,
  };

  // Add MCP tools as Anthropic tool definitions
  const toolDefs = buildAnthropicToolDefs(mcpTools);
  if (toolDefs) requestParams.tools = toolDefs;

  // Extended thinking / reasoning support
  const reasoningEnabled = settings.chatReasoningEnabled;
  const reasoningBudget = settings.chatReasoningBudget || 4096;
  if (reasoningEnabled && reasoningBudget > 0) {
    requestParams.thinking = {
      type: "enabled",
      budget_tokens: reasoningBudget,
    };
    requestParams.max_tokens = Math.max(
      requestParams.max_tokens,
      reasoningBudget + 1024
    );
  }

  const executeToolFn = createToolExecutor(mcpTools);
  log.event("inference:request_shape", {
    provider: "anthropic",
    model: requestParams.model,
    visionScreensSent: screens.length,
    toolCount: mcpTools?.length || 0,
    historyTurns: conversationHistory.length,
    screenLabels: screens.map((s) => s.label),
  });

  // Run inference with tool loop (may need multiple rounds)
  let currentMessages = [...messages];
  let maxToolRounds = 5;

  while (maxToolRounds-- > 0) {
    const response = await client.messages.create({ ...requestParams, messages: currentMessages });

    let hasToolUse = false;
    const toolResults = [];

    for (const block of response.content) {
      if (block.type === "text") {
        fullText += block.text;
        onChunk({ type: "text", text: fullText });
      } else if (block.type === "thinking") {
        thinkingText += block.thinking;
        onChunk({ type: "thinking", text: thinkingText });
      } else if (block.type === "tool_use" && executeToolFn) {
        hasToolUse = true;
        onChunk({ type: "tool_use", name: block.name, input: block.input });

        log.event("inference:tool_call", { tool: block.name, inputKeys: Object.keys(block.input || {}) });
        const toolResult = await executeToolFn(block.name, block.input);
        const resultText = extractToolResultText(toolResult);
        log.event("inference:tool_result", { tool: block.name, resultLength: resultText.length });

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: [{ type: "text", text: resultText }],
        });
        onChunk({ type: "tool_result", name: block.name, result: resultText });
      }
    }

    if (!hasToolUse || response.stop_reason !== "tool_use") {
      break;
    }

    // Continue conversation with tool results
    currentMessages.push({ role: "assistant", content: response.content });
    currentMessages.push({ role: "user", content: toolResults });
  }

  log.event("inference:complete", {
    provider: "anthropic", model, responseLength: fullText.length,
    toolRounds: 5 - maxToolRounds, hasPoint: fullText.includes("[POINT:"),
  });
  onChunk({ type: "done" });
  addToHistory(transcript, fullText);
  return fullText;
}

// ── OpenAI-compatible (OpenAI, Ollama, LM Studio) ─────────

async function runOpenAICompatibleInference(provider, model, transcript, screens, settings, onChunk, mcpTools, observations) {
  let baseURL, apiKey;

  switch (provider) {
    case "openai":
      baseURL = "https://api.openai.com/v1";
      apiKey = settings.openaiKey;
      break;
    case "ollama":
      baseURL = (settings.ollamaUrl || "http://localhost:11434") + "/v1";
      apiKey = "ollama"; // Ollama doesn't need a real key but the SDK requires one
      break;
    case "lmstudio":
      baseURL = (settings.lmstudioUrl || "http://localhost:1234") + "/v1";
      apiKey = "lmstudio";
      break;
  }

  model = await resolveLocalVisionModel(provider, model, baseURL);
  const client = getOpenAIClient(baseURL, apiKey);

  // Build messages
  const messages = [{ role: "system", content: buildSystemPrompt(mcpTools) }];
  for (const turn of conversationHistory) {
    messages.push({ role: "user", content: turn.user });
    messages.push({ role: "assistant", content: turn.assistant });
  }

  // Current message — with vision if screenshots provided and model supports it
  const userContent = [];
  const modelName = model || "gpt-4o";
  const sendsVision = screens.length > 0 && (
    provider === "openai" ||
    modelName.includes("llava") ||
    modelName.includes("vision") ||
    modelName.includes("gemma")
  );
  if (sendsVision) {
    for (const scr of screens) {
      userContent.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${scr.imageDataBase64}` },
      });
      userContent.push({ type: "text", text: scr.label });
    }
  }
  // Inject structured observations before the user query
  if (observations && observations.confidence > 0.2) {
    userContent.push({ type: "text", text: buildObservationContext(observations) });
  }

  userContent.push({ type: "text", text: transcript });
  messages.push({ role: "user", content: userContent.length === 1 ? transcript : userContent });

  let fullText = "";

  // Build request params — newer OpenAI models (gpt-5.x, o-series) use
  // max_completion_tokens instead of max_tokens
  const usesNewTokenParam = /^(gpt-5|o[34])/.test(modelName);
  const tokenLimit = settings.maxTokens || 1024;

  const requestParams = {
    model: modelName,
    messages,
    temperature: settings.temperature || 0.7,
    stream: true,
  };

  if (usesNewTokenParam) {
    requestParams.max_completion_tokens = tokenLimit;
  } else {
    requestParams.max_tokens = tokenLimit;
  }

  // OpenAI reasoning models (o3, o4-mini) use reasoning_effort
  const isReasoningModel = /^o[34]/.test(modelName);
  if (isReasoningModel && settings.chatReasoningEnabled) {
    const budget = settings.chatReasoningBudget || 4096;
    if (budget <= 1024) requestParams.reasoning_effort = 'low';
    else if (budget <= 8192) requestParams.reasoning_effort = 'medium';
    else requestParams.reasoning_effort = 'high';
    // o-series models don't use temperature
    delete requestParams.temperature;
  }

  log.event("inference:request_shape", {
    provider,
    model: requestParams.model,
    sendsVision,
    visionScreensSent: sendsVision ? screens.length : 0,
    toolCount: mcpTools?.length || 0,
    historyTurns: conversationHistory.length,
    baseURL,
    screenLabels: screens.map((s) => s.label),
  });

  const stream = await client.chat.completions.create(requestParams);

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) {
      fullText += delta;
      onChunk({ type: "text", text: fullText });
    }
  }

  log.event("inference:complete", {
    provider, model, responseLength: fullText.length,
    hasPoint: fullText.includes("[POINT:"),
  });
  onChunk({ type: "done" });
  addToHistory(transcript, fullText);
  return fullText;
}

async function resolveLocalVisionModel(provider, requestedModel, baseURL) {
  if (provider !== "ollama" && provider !== "lmstudio") {
    return requestedModel;
  }

  const fallbackBadPrefixes = ["claude-", "gpt-", "o3", "o4", "computer-use-preview"];
  const looksWrongProvider = !requestedModel || fallbackBadPrefixes.some((prefix) => String(requestedModel).startsWith(prefix));

  try {
    const modelListUrl = provider === "ollama"
      ? baseURL.replace(/\/v1$/, "/api/tags")
      : baseURL.replace(/\/v1$/, "/v1/models");
    const res = await fetch(modelListUrl);
    if (!res.ok) return requestedModel;
    const data = await res.json();
    const availableModels = provider === "ollama"
      ? (data.models || []).map((m) => m.name || m.model).filter(Boolean)
      : (data.data || []).map((m) => m.id).filter(Boolean);
    if (availableModels.length === 0) return requestedModel;

    if (availableModels.includes(requestedModel)) {
      return requestedModel;
    }

    const chosenModel = availableModels[0];
    if (looksWrongProvider || !requestedModel) {
      log.event("inference:model_autocorrect", {
        provider,
        requestedModel,
        chosenModel,
        reason: "requested_model_invalid_for_local_provider",
      });
      return chosenModel;
    }
  } catch (_) {}

  return requestedModel;
}

// ── Computer Use ──────────────────────────────────────────
//
// CU is a FALLBACK for when the primary POINT-tag approach fails.
// It makes a separate API call asking the model to identify a
// clickable element. Supports Anthropic (computer_20251124 tool)
// and OpenAI (Responses API with computer-use-preview model).

const { bestCUResolution, screenshotPointToScreenCoords } = require("./capture.js");

const CU_PROMPT = (userQuestion, assistantResponse) => {
  let prompt = `The user asked: "${userQuestion}"\n\n`;
  if (assistantResponse) {
    prompt += `The assistant already responded: "${assistantResponse.slice(0, 500)}"\n\nBased on the assistant's response, find the specific UI element being discussed and click on it.\n`;
  } else {
    prompt += `Look at the screenshot. If there is a specific UI element the user should interact with, click on it.\n`;
  }
  prompt += `If there is no element to point to, respond with text saying "no specific element".`;
  return prompt;
};

/**
 * Run computer use to find a screen element.
 * Dispatches to Anthropic or OpenAI based on settings.cuProvider.
 *
 * @param {object} opts
 * @param {string} opts.userQuestion - what the user asked
 * @param {string} [opts.assistantResponse] - Claude's response text (for context in fallback CU)
 * @param {object} opts.screenCapture - single screen capture from capture service
 * @param {object} opts.settings - full settings (keys, cuProvider, cuModel)
 * @param {function} [opts.onChunk] - optional callback for UI feedback
 * @returns {Promise<{ action: string, coordinate?: [number,number], text?: string }>}
 */
async function runComputerUse(opts) {
  const { settings, onChunk } = opts;
  const provider = settings.cuProvider || "anthropic";

  onChunk?.({ type: "tool_use", name: "computer_use", input: { provider, model: settings.cuModel } });
  log.event("cu:start", { provider, model: settings.cuModel });

  switch (provider) {
    case "anthropic":
      return runAnthropicComputerUse(opts);
    case "openai":
      return runOpenAIComputerUse(opts);
    case "ollama":
    case "lmstudio":
      return runOpenAICompatibleVisionComputerUse(provider, opts);
    default:
      throw new Error(`Unknown CU provider: ${provider}`);
  }
}

// ── Anthropic Computer Use (computer_20251124) ────────────

async function runAnthropicComputerUse(opts) {
  const { userQuestion, assistantResponse, screenCapture, settings, onChunk } = opts;
  const client = getAnthropicClient(settings.anthropicKey);
  if (!settings.anthropicKey) throw new Error("Anthropic API key required for computer use");

  const model = settings.cuModel || "claude-sonnet-4-6";

  // Pick CU resolution matching the display's aspect ratio
  const cuRes = bestCUResolution(screenCapture.displayWidthPx, screenCapture.displayHeightPx);
  const declaredWidth = cuRes.w;
  const declaredHeight = cuRes.h;

  // CRITICAL: Resize the screenshot to EXACTLY the declared resolution.
  // If we send a 1280x540 image but declare 1280x800, Claude's coordinate
  // space won't match the image and Y coordinates will be wrong.
  let imageData = screenCapture.imageDataBase64;
  try {
    const { nativeImage } = require('electron');
    const img = nativeImage.createFromBuffer(Buffer.from(imageData, 'base64'));
    if (!img.isEmpty()) {
      const resized = img.resize({ width: declaredWidth, height: declaredHeight });
      imageData = resized.toJPEG(80).toString('base64');
      console.log(`[CU] Resized screenshot from ${img.getSize().width}x${img.getSize().height} to ${declaredWidth}x${declaredHeight}`);
    }
  } catch (resizeErr) {
    console.warn('[CU] Could not resize screenshot:', resizeErr.message);
  }

  const response = await client.beta.messages.create({
    model,
    max_tokens: 1024,
    betas: ["computer-use-2025-11-24"],
    tools: [
      {
        type: "computer_20251124",
        name: "computer",
        display_width_px: declaredWidth,
        display_height_px: declaredHeight,
        display_number: 1,
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: imageData,
            },
          },
          { type: "text", text: CU_PROMPT(userQuestion, assistantResponse) },
        ],
      },
    ],
  });

  const contentBlocks = response.content || [];

  // Look for tool_use block with coordinates (click action)
  for (const block of contentBlocks) {
    if (block.type === "tool_use" && block.input?.coordinate) {
      const [cuX, cuY] = block.input.coordinate;

      // Build a synthetic screenCapture for coordinate conversion so CU
      // coordinates go through the same calibration path as POINT tags.
      const cuScreenCapture = {
        screenshotWidthPx: declaredWidth,
        screenshotHeightPx: declaredHeight,
        displayWidthPx: screenCapture.displayWidthPx,
        displayHeightPx: screenCapture.displayHeightPx,
        displayX: screenCapture.displayX,
        displayY: screenCapture.displayY,
        scaleX: screenCapture.displayWidthPx / declaredWidth,
        scaleY: screenCapture.displayHeightPx / declaredHeight,
      };
      const calibratedPoint = screenshotPointToScreenCoords(cuX, cuY, cuScreenCapture);

      const result = {
        action: block.input.action || "left_click",
        coordinate: [Math.round(calibratedPoint.x), Math.round(calibratedPoint.y)],
        cuCoordinate: [cuX, cuY],
        declaredResolution: [declaredWidth, declaredHeight],
      };
      console.log(`[CU] Anthropic found element: ${result.action} at (${result.coordinate})`);
      onChunk?.({ type: "tool_result", name: "computer_use", result: `${result.action} at (${result.coordinate})` });
      return result;
    }
  }

  // No tool_use — return text response
  const textBlock = contentBlocks.find((b) => b.type === "text");
  const textResult = textBlock?.text || "No element detected";
  console.log(`[CU] Anthropic: no element — ${textResult.slice(0, 80)}`);
  onChunk?.({ type: "tool_result", name: "computer_use", result: textResult.slice(0, 100) });
  return { action: "none", text: textResult };
}

// ── OpenAI Computer Use (Responses API) ───────────────────

async function runOpenAIComputerUse(opts) {
  const { userQuestion, assistantResponse, screenCapture, settings, onChunk } = opts;
  if (!settings.openaiKey) throw new Error("OpenAI API key required for computer use");

  const model = settings.cuModel || "gpt-5.4";

  // Match display aspect ratio — same logic as Anthropic CU
  const cuRes = bestCUResolution(screenCapture.displayWidthPx, screenCapture.displayHeightPx);
  const declaredWidth = cuRes.w;
  const declaredHeight = cuRes.h;

  // Resize screenshot to declared resolution so coordinate space matches
  let imageData = screenCapture.imageDataBase64;
  try {
    const { nativeImage } = require('electron');
    const img = nativeImage.createFromBuffer(Buffer.from(imageData, 'base64'));
    if (!img.isEmpty()) {
      const resized = img.resize({ width: declaredWidth, height: declaredHeight });
      imageData = resized.toJPEG(80).toString('base64');
      console.log(`[CU] OpenAI: resized screenshot from ${img.getSize().width}x${img.getSize().height} to ${declaredWidth}x${declaredHeight}`);
    }
  } catch (resizeErr) {
    console.warn('[CU] OpenAI: could not resize screenshot:', resizeErr.message);
  }

  // GA computer tool — replaces deprecated computer_use_preview
  const requestBody = {
    model,
    tools: [{ type: "computer", display_width: declaredWidth, display_height: declaredHeight }],
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: `data:image/jpeg;base64,${imageData}`,
            detail: "auto",
          },
          { type: "input_text", text: CU_PROMPT(userQuestion, assistantResponse) },
        ],
      },
    ],
  };

  log.event("cu:openai_request", { model, declaredWidth, declaredHeight });

  // OpenAI CU uses the Responses API — different from Chat Completions
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${settings.openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI CU API ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json();

  // OpenAI GA format returns output[] with computer_call items containing batched actions[]
  const outputs = data.output || [];
  for (const item of outputs) {
    if (item.type === "computer_call") {
      const actions = Array.isArray(item.actions) ? item.actions : [];

      for (const action of actions) {
        // click, double_click actions have x, y coordinates
        if ((action.type === "click" || action.type === "double_click") && action.x != null && action.y != null) {
          const cuScreenCapture = {
            screenshotWidthPx: declaredWidth,
            screenshotHeightPx: declaredHeight,
            displayWidthPx: screenCapture.displayWidthPx,
            displayHeightPx: screenCapture.displayHeightPx,
            displayX: screenCapture.displayX,
            displayY: screenCapture.displayY,
            scaleX: screenCapture.displayWidthPx / declaredWidth,
            scaleY: screenCapture.displayHeightPx / declaredHeight,
          };
          const calibratedPoint = screenshotPointToScreenCoords(action.x, action.y, cuScreenCapture);

          const result = {
            action: action.type,
            coordinate: [Math.round(calibratedPoint.x), Math.round(calibratedPoint.y)],
            cuCoordinate: [action.x, action.y],
            declaredResolution: [declaredWidth, declaredHeight],
          };
          console.log(`[CU] OpenAI found element: ${result.action} at (${result.coordinate})`);
          onChunk?.({ type: "tool_result", name: "computer_use", result: `${result.action} at (${result.coordinate})` });
          return result;
        }
      }
    }
    // Check for text responses
    if (item.type === "message" && item.content) {
      for (const block of item.content) {
        if (block.type === "output_text" && block.text) {
          console.log(`[CU] OpenAI: no element — ${block.text.slice(0, 80)}`);
          onChunk?.({ type: "tool_result", name: "computer_use", result: block.text.slice(0, 100) });
          return { action: "none", text: block.text };
        }
      }
    }
  }

  console.log("[CU] OpenAI: no actionable output");
  onChunk?.({ type: "tool_result", name: "computer_use", result: "No element detected" });
  return { action: "none", text: "No element detected" };
}

async function runOpenAICompatibleVisionComputerUse(provider, opts) {
  const { userQuestion, assistantResponse, screenCapture, settings, onChunk } = opts;

  let baseURL, apiKey, model;
  switch (provider) {
    case "ollama":
      baseURL = (settings.ollamaUrl || "http://localhost:11434") + "/v1";
      apiKey = "ollama";
      model = settings.cuModel || settings.chatModel || "llava";
      break;
    case "lmstudio":
      baseURL = (settings.lmstudioUrl || "http://localhost:1234") + "/v1";
      apiKey = "lmstudio";
      model = settings.cuModel || settings.chatModel;
      break;
    default:
      throw new Error(`Unsupported provider for vision CU fallback: ${provider}`);
  }

  if (!model) throw new Error(`No ${provider} computer-use model configured`);

  const client = getOpenAIClient(baseURL, apiKey);
  const width = screenCapture.screenshotWidthPx;
  const height = screenCapture.screenshotHeightPx;

  const prompt = [
    `The user asked: "${userQuestion}"`,
    assistantResponse
      ? `The assistant already responded: "${assistantResponse.slice(0, 500)}"`
      : "Look at the screenshot and identify the specific UI element the user should interact with.",
    `The screenshot dimensions are ${width}x${height}.`,
    "Return exactly one tag and nothing else.",
    "If you find the element, return [POINT:x,y:label] using integer screenshot pixel coordinates.",
    "If there is no specific element to point to, return [POINT:none].",
  ].join("\n\n");

  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${screenCapture.imageDataBase64}` },
          },
          { type: "text", text: prompt },
        ],
      },
    ],
    max_tokens: 128,
    temperature: 0,
    stream: false,
  });

  const text = response.choices?.[0]?.message?.content?.trim() || "[POINT:none]";
  const parsed = parsePointingCoordinates(text);
  if (!parsed.coordinate) {
    onChunk?.({ type: "tool_result", name: "computer_use", result: "No element detected" });
    return { action: "none", text };
  }

  const calibratedPoint = screenshotPointToScreenCoords(
    parsed.coordinate.x,
    parsed.coordinate.y,
    screenCapture
  );
  const result = {
    action: "point",
    coordinate: [Math.round(calibratedPoint.x), Math.round(calibratedPoint.y)],
    pointCoordinate: [parsed.coordinate.x, parsed.coordinate.y],
    label: parsed.elementLabel || "element",
  };
  onChunk?.({
    type: "tool_result",
    name: "computer_use",
    result: `${provider} vision point at (${result.coordinate})`,
  });
  return result;
}

module.exports = { runInference, runComputerUse, clearHistory, SYSTEM_PROMPT };
