const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || ".",
  ".cursorbuddy"
);
const HISTORY_FILE = path.join(DATA_DIR, "chat-history.json");

/** @type {Array<{role:string,text:string,ts:string}>} */
let history = [];

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (_) {}
}

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
      history = Array.isArray(parsed) ? parsed : [];
    }
  } catch (_) {
    history = [];
  }
  return getHistory();
}

function saveHistory() {
  try {
    ensureDataDir();
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (_) {}
}

function getHistory() {
  return history.map((entry) => ({ ...entry }));
}

function appendMessage(role, text) {
  history.push({ role, text, ts: new Date().toISOString() });
  saveHistory();
  return getHistory();
}

function replaceLastMessage(role, text) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === role) {
      history[i] = { ...history[i], text, ts: new Date().toISOString() };
      saveHistory();
      return getHistory();
    }
  }
  return appendMessage(role, text);
}

function clearHistory() {
  history = [];
  saveHistory();
  return getHistory();
}

module.exports = {
  HISTORY_FILE,
  loadHistory,
  getHistory,
  appendMessage,
  replaceLastMessage,
  clearHistory,
};
