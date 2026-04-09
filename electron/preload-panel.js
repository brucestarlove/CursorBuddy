/**
 * Panel Preload — settings, CLI verification, overlay commands,
 * screen bounds, inference, STT audio, TTS.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("panelAPI", {
  // Overlay commands
  sendCommand: (command, payload) => ipcRenderer.send("panel:overlay-command", command, payload),
  hidePanel: () => ipcRenderer.send("panel:hide"),

  // Screen bounds
  onScreenBounds: (callback) => {
    const handler = (_event, bounds) => callback(bounds);
    ipcRenderer.on("screen-bounds", handler);
    return () => ipcRenderer.removeListener("screen-bounds", handler);
  },
  getScreenBounds: () => ipcRenderer.invoke("get-screen-bounds"),

  // Settings
  loadSettings: () => ipcRenderer.invoke("settings:load"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),

  // CLI verification
  verifyCLI: (binaryName) => ipcRenderer.invoke("verify-cli", binaryName),

  // Screen capture
  captureScreens: () => ipcRenderer.invoke("capture-screens"),

  // Inference
  runInference: (opts) => ipcRenderer.send("inference:run", opts),
  onInferenceChunk: (callback) => {
    const handler = (_event, chunk) => callback(chunk);
    ipcRenderer.on("inference:chunk", handler);
    return () => ipcRenderer.removeListener("inference:chunk", handler);
  },
  clearHistory: () => ipcRenderer.send("inference:clear-history"),
  loadChatHistory: () => ipcRenderer.invoke("chat:history-load"),
  appendChatHistory: (role, text) => ipcRenderer.invoke("chat:history-append", role, text),
  replaceLastChatHistory: (role, text) => ipcRenderer.invoke("chat:history-replace-last", role, text),
  clearChatHistory: () => ipcRenderer.invoke("chat:history-clear"),

  // STT (speech-to-text)
  startSTT: (provider) => ipcRenderer.invoke("stt:start", provider),
  sendAudio: (pcm16ArrayBuffer) => ipcRenderer.send("stt:audio", pcm16ArrayBuffer),
  requestFinalTranscript: () => ipcRenderer.send("stt:request-final"),
  stopSTT: () => ipcRenderer.send("stt:stop"),
  onTranscript: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("stt:transcript", handler);
    return () => ipcRenderer.removeListener("stt:transcript", handler);
  },
  onSTTError: (callback) => {
    const handler = (_event, msg) => callback(msg);
    ipcRenderer.on("stt:error", handler);
    return () => ipcRenderer.removeListener("stt:error", handler);
  },

  // TTS
  speak: (text) => ipcRenderer.invoke("tts:speak", text),

  // Voice audio chunks (sentence-by-sentence from voice pipeline)
  onVoiceAudioChunk: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('voice:audio-chunk', handler);
    return () => ipcRenderer.removeListener('voice:audio-chunk', handler);
  },

  // Push-to-talk events from main process (global hotkey)
  onPushToTalk: (callback) => {
    const handler = (_event, action) => callback(action);
    ipcRenderer.on("push-to-talk", handler);
    return () => ipcRenderer.removeListener("push-to-talk", handler);
  },

  // Screenshot interceptor
  onScreenshotIntercepted: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('screenshot:intercepted', handler);
    return () => ipcRenderer.removeListener('screenshot:intercepted', handler);
  },

  // Debug + Calibration
  getDebugInfo: () => ipcRenderer.invoke("get-debug-info"),
  getCursorPosition: () => ipcRenderer.invoke("get-cursor-position"),
  showCalTarget: (x, y) => ipcRenderer.invoke("cal:show-target", x, y),
  hideCalTarget: () => ipcRenderer.invoke("cal:hide-target"),

  // MCP Server (CursorBuddy as server)
  mcpServerStart: (port) => ipcRenderer.invoke("mcp:server-start", port),
  mcpServerStop: () => ipcRenderer.invoke("mcp:server-stop"),
  mcpServerStatus: () => ipcRenderer.invoke("mcp:server-status"),

  // MCP Client (connect to external servers)
  mcpConnect: (config) => ipcRenderer.invoke("mcp:connect", config),
  mcpDisconnect: (name) => ipcRenderer.invoke("mcp:disconnect", name),
  mcpListTools: () => ipcRenderer.invoke("mcp:list-tools"),
  mcpListServers: () => ipcRenderer.invoke("mcp:list-servers"),
});
