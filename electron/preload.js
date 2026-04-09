/**
 * Overlay Preload — receives cursor updates, screen bounds,
 * and commands from the panel window.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  /** Cursor position pushed from main at ~60fps */
  onCursorPosition: (callback) => {
    const handler = (_event, position) => callback(position);
    ipcRenderer.on("cursor-position", handler);
    return () => ipcRenderer.removeListener("cursor-position", handler);
  },

  /** Move the overlay window (during flight) */
  setWindowPosition: (x, y) => {
    const rx = Math.round(x);
    const ry = Math.round(y);
    if (!Number.isFinite(rx) || !Number.isFinite(ry)) return;
    // Send as a single object — safest for Electron IPC serialization
    ipcRenderer.send("set-window-position", { x: rx, y: ry });
  },

  /** Toggle cursor-following on/off */
  setFollowingCursor: (following) => {
    ipcRenderer.send("set-following-cursor", following);
  },

  /** Receive commands from the panel window (relayed via main) */
  onOverlayCommand: (callback) => {
    const handler = (_event, command, payload) => callback(command, payload);
    ipcRenderer.on("overlay-command", handler);
    return () => ipcRenderer.removeListener("overlay-command", handler);
  },

  /** Screen bounds pushed from main on startup and display change */
  onScreenBounds: (callback) => {
    const handler = (_event, bounds) => callback(bounds);
    ipcRenderer.on("screen-bounds", handler);
    return () => ipcRenderer.removeListener("screen-bounds", handler);
  },

  /** Request screen bounds */
  getScreenBounds: () => ipcRenderer.invoke("get-screen-bounds"),

  /** Receive inference stream chunks */
  onInferenceChunk: (callback) => {
    const handler = (_event, chunk) => callback(chunk);
    ipcRenderer.on("inference:chunk", handler);
    return () => ipcRenderer.removeListener("inference:chunk", handler);
  },

  /** STT transcript updates */
  onTranscript: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("stt:transcript", handler);
    return () => ipcRenderer.removeListener("stt:transcript", handler);
  },

  /** Send PCM16 audio to main for STT */
  sendAudio: (pcm16ArrayBuffer) => ipcRenderer.send("stt:audio", pcm16ArrayBuffer),

  /** Push-to-talk events */
  onPushToTalk: (callback) => {
    const handler = (_event, action) => callback(action);
    ipcRenderer.on("push-to-talk", handler);
    return () => ipcRenderer.removeListener("push-to-talk", handler);
  },
  stopPushToTalk: () => ipcRenderer.send("push-to-talk:stop"),

  /** Voice audio chunks */
  onVoiceAudioChunk: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("voice:audio-chunk", handler);
    return () => ipcRenderer.removeListener("voice:audio-chunk", handler);
  },

  /** TTS */
  speak: (text) => ipcRenderer.invoke("tts:speak", text),
});
