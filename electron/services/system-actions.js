/**
 * System Actions
 *
 * Built-in tools that give the assistant the ability to interact with the OS:
 * click, type, press keys, open apps/URLs, and scroll.
 *
 * Cross-platform:
 *   macOS   — cliclick + osascript
 *   Windows — PowerShell automation
 *   Linux   — xdotool (future)
 *
 * These tools are injected into the inference tool array alongside
 * MCP tools so the assistant can call them during conversation.
 */

const { execFileSync, execSync } = require("child_process");
const log = require("../lib/session-logger.js");

const PLATFORM = process.platform;

// ── Platform Helpers ─────────────────────────────────────────

// macOS: cliclick
function runCliclick(args) {
  execFileSync("cliclick", args, { timeout: 5000 });
}

function runOsascript(script) {
  execFileSync("osascript", ["-e", script], { timeout: 5000 });
}

// Windows: PowerShell with .NET mouse/keyboard automation
function runPowerShell(script) {
  execSync(
    `powershell -NoProfile -NonInteractive -Command "${script.replace(/"/g, '\\"')}"`,
    { timeout: 10000, windowsHide: true }
  );
}

/**
 * Windows mouse click via PowerShell + .NET interop.
 * Loads System.Windows.Forms, sets cursor, sends click.
 */
function winClick(x, y, button = "left", double = false) {
  // Using C# Add-Type for reliable mouse input
  const clickScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class MouseInput {
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, IntPtr dwExtraInfo);
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    public static void Click(int x, int y, bool right, bool dbl) {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(50);
        uint down = right ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN;
        uint up = right ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP;
        mouse_event(down, 0, 0, 0, IntPtr.Zero);
        mouse_event(up, 0, 0, 0, IntPtr.Zero);
        if (dbl) {
            System.Threading.Thread.Sleep(50);
            mouse_event(down, 0, 0, 0, IntPtr.Zero);
            mouse_event(up, 0, 0, 0, IntPtr.Zero);
        }
    }
}
'@
[MouseInput]::Click(${x}, ${y}, $${button === "right" ? "true" : "false"}, $${double ? "true" : "false"})
`.trim();
  runPowerShell(clickScript);
}

function winTypeText(text) {
  // Use SendKeys for typing — escape special characters
  const escaped = text
    .replace(/[+^%~(){}[\]]/g, "{$&}")
    .replace(/\n/g, "{ENTER}")
    .replace(/\t/g, "{TAB}");
  runPowerShell(
    `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped.replace(/'/g, "''")}')`
  );
}

function winKeyPress(combo) {
  // Map key combo to SendKeys format
  const parts = combo.toLowerCase().split("+").map(p => p.trim());
  let sendKeysStr = "";

  for (const part of parts) {
    switch (part) {
      case "ctrl": case "control": sendKeysStr += "^"; break;
      case "alt": case "option": sendKeysStr += "%"; break;
      case "shift": sendKeysStr += "+"; break;
      case "cmd": case "command": case "win": sendKeysStr += "^"; break; // map cmd to ctrl on Windows
      default:
        // Map special keys
        const keyMap = {
          return: "{ENTER}", enter: "{ENTER}", tab: "{TAB}",
          escape: "{ESC}", esc: "{ESC}", space: " ",
          delete: "{DELETE}", backspace: "{BACKSPACE}", bs: "{BACKSPACE}",
          up: "{UP}", down: "{DOWN}", left: "{LEFT}", right: "{RIGHT}",
          home: "{HOME}", end: "{END}",
          pageup: "{PGUP}", pagedown: "{PGDN}",
          f1: "{F1}", f2: "{F2}", f3: "{F3}", f4: "{F4}",
          f5: "{F5}", f6: "{F6}", f7: "{F7}", f8: "{F8}",
          f9: "{F9}", f10: "{F10}", f11: "{F11}", f12: "{F12}",
        };
        sendKeysStr += keyMap[part] || part;
    }
  }

  runPowerShell(
    `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${sendKeysStr.replace(/'/g, "''")}')`
  );
}

function winScroll(x, y, dy) {
  const scrollAmount = Math.round(dy) * 120; // Windows scroll units
  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class ScrollInput {
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, IntPtr dwExtraInfo);
    public const uint MOUSEEVENTF_WHEEL = 0x0800;
    public static void Scroll(int x, int y, int amount) {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(50);
        mouse_event(MOUSEEVENTF_WHEEL, 0, 0, (uint)(amount & 0xFFFFFFFF), IntPtr.Zero);
    }
}
'@
[ScrollInput]::Scroll(${x || 0}, ${y || 0}, ${-scrollAmount})
`.trim();
  runPowerShell(script);
}

// ── Tool Definitions (Anthropic format) ──────────────────────

function buildMacOSTools() {
  return [
    {
      name: "click",
      description: "Click at screen coordinates. Use after identifying where to click from a screenshot.",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number", description: "X coordinate in logical screen pixels" },
          y: { type: "number", description: "Y coordinate in logical screen pixels" },
          button: { type: "string", enum: ["left", "right"], description: "Mouse button (default: left)" },
          double: { type: "boolean", description: "Double-click (default: false)" },
        },
        required: ["x", "y"],
      },
      execute: async (input) => {
        const { x, y, button, double: dbl } = input;
        const ix = Math.round(x);
        const iy = Math.round(y);
        try {
          if (button === "right") {
            runCliclick([`rc:${ix},${iy}`]);
          } else if (dbl) {
            runCliclick([`dc:${ix},${iy}`]);
          } else {
            runCliclick([`c:${ix},${iy}`]);
          }
          log.event("action:click", { x: ix, y: iy, button: button || "left", double: !!dbl });
          return { content: [{ type: "text", text: `Clicked at (${ix}, ${iy})` }] };
        } catch (err) {
          log.error("action:click_error", err, { x: ix, y: iy });
          return { content: [{ type: "text", text: `Click failed: ${err.message}` }] };
        }
      },
    },
    {
      name: "type_text",
      description: "Type text at the current cursor position. Click a text field first, then type into it.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to type" },
        },
        required: ["text"],
      },
      execute: async (input) => {
        const { text } = input;
        try {
          runCliclick([`t:${text}`]);
          log.event("action:type", { textLength: text.length });
          return { content: [{ type: "text", text: `Typed: "${text.slice(0, 50)}${text.length > 50 ? "..." : ""}"` }] };
        } catch (err) {
          log.error("action:type_error", err);
          return { content: [{ type: "text", text: `Type failed: ${err.message}` }] };
        }
      },
    },
    {
      name: "key_press",
      description: "Press a key or key combination. Examples: 'return', 'cmd+t', 'cmd+l', 'cmd+space', 'escape', 'tab', 'cmd+shift+a'. Use for keyboard shortcuts and special keys.",
      inputSchema: {
        type: "object",
        properties: {
          keys: { type: "string", description: "Key combo like 'return', 'cmd+t', 'cmd+l', 'escape', 'cmd+space'" },
        },
        required: ["keys"],
      },
      execute: async (input) => {
        const { keys } = input;
        try {
          const cliclickArgs = buildMacKeySequence(keys);
          runCliclick(cliclickArgs);
          log.event("action:key_press", { keys });
          return { content: [{ type: "text", text: `Pressed: ${keys}` }] };
        } catch (err) {
          log.error("action:key_press_error", err, { keys });
          return { content: [{ type: "text", text: `Key press failed: ${err.message}` }] };
        }
      },
    },
    {
      name: "open_app_or_url",
      description: "Open an application by name or a URL in the default browser. Examples: 'Safari', 'GitHub Desktop', 'https://github.com'.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "App name (e.g. 'Safari', 'Terminal') or full URL (e.g. 'https://github.com')" },
        },
        required: ["target"],
      },
      execute: async (input) => {
        const { target } = input;
        try {
          if (target.startsWith("http://") || target.startsWith("https://")) {
            execFileSync("open", [target], { timeout: 5000 });
            log.event("action:open_url", { url: target });
            return { content: [{ type: "text", text: `Opened URL: ${target}` }] };
          } else {
            execFileSync("open", ["-a", target], { timeout: 5000 });
            log.event("action:open_app", { app: target });
            return { content: [{ type: "text", text: `Opened app: ${target}` }] };
          }
        } catch (err) {
          log.error("action:open_error", err, { target });
          return { content: [{ type: "text", text: `Open failed: ${err.message}` }] };
        }
      },
    },
    {
      name: "scroll",
      description: "Scroll at the current mouse position. Use positive dy to scroll down, negative dy to scroll up.",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number", description: "X coordinate to scroll at" },
          y: { type: "number", description: "Y coordinate to scroll at" },
          dy: { type: "number", description: "Scroll amount: positive = down, negative = up. Typical: 3-5." },
        },
        required: ["dy"],
      },
      execute: async (input) => {
        const { x, y, dy } = input;
        try {
          if (x != null && y != null) {
            runCliclick([`m:${Math.round(x)},${Math.round(y)}`]);
          }
          const direction = dy > 0 ? "down" : "up";
          const amount = Math.abs(Math.round(dy));
          runOsascript(`tell application "System Events" to scroll ${direction} by ${amount}`);
          log.event("action:scroll", { x, y, dy });
          return { content: [{ type: "text", text: `Scrolled ${direction} by ${amount}` }] };
        } catch (err) {
          log.error("action:scroll_error", err);
          return { content: [{ type: "text", text: `Scroll failed: ${err.message}` }] };
        }
      },
    },
    {
      name: "wait",
      description: "Wait for milliseconds. Use between actions to let UI update or pages load.",
      inputSchema: {
        type: "object",
        properties: {
          ms: { type: "number", description: "Milliseconds to wait (max 5000)" },
        },
        required: ["ms"],
      },
      execute: async (input) => {
        const ms = Math.min(input.ms || 1000, 5000);
        await new Promise(resolve => setTimeout(resolve, ms));
        log.event("action:wait", { ms });
        return { content: [{ type: "text", text: `Waited ${ms}ms` }] };
      },
    },
  ];
}

function buildWindowsTools() {
  return [
    {
      name: "click",
      description: "Click at screen coordinates. Use after identifying where to click from a screenshot.",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number", description: "X coordinate in logical screen pixels" },
          y: { type: "number", description: "Y coordinate in logical screen pixels" },
          button: { type: "string", enum: ["left", "right"], description: "Mouse button (default: left)" },
          double: { type: "boolean", description: "Double-click (default: false)" },
        },
        required: ["x", "y"],
      },
      execute: async (input) => {
        const { x, y, button, double: dbl } = input;
        const ix = Math.round(x);
        const iy = Math.round(y);
        try {
          winClick(ix, iy, button || "left", !!dbl);
          log.event("action:click", { x: ix, y: iy, button: button || "left", double: !!dbl });
          return { content: [{ type: "text", text: `Clicked at (${ix}, ${iy})` }] };
        } catch (err) {
          log.error("action:click_error", err, { x: ix, y: iy });
          return { content: [{ type: "text", text: `Click failed: ${err.message}` }] };
        }
      },
    },
    {
      name: "type_text",
      description: "Type text at the current cursor position. Click a text field first, then type into it.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to type" },
        },
        required: ["text"],
      },
      execute: async (input) => {
        const { text } = input;
        try {
          winTypeText(text);
          log.event("action:type", { textLength: text.length });
          return { content: [{ type: "text", text: `Typed: "${text.slice(0, 50)}${text.length > 50 ? "..." : ""}"` }] };
        } catch (err) {
          log.error("action:type_error", err);
          return { content: [{ type: "text", text: `Type failed: ${err.message}` }] };
        }
      },
    },
    {
      name: "key_press",
      description: "Press a key or key combination. Examples: 'return', 'ctrl+t', 'ctrl+l', 'alt+space', 'escape', 'tab', 'ctrl+shift+a'. Use for keyboard shortcuts and special keys. Note: on Windows, use ctrl instead of cmd.",
      inputSchema: {
        type: "object",
        properties: {
          keys: { type: "string", description: "Key combo like 'return', 'ctrl+t', 'ctrl+l', 'escape', 'alt+space'" },
        },
        required: ["keys"],
      },
      execute: async (input) => {
        const { keys } = input;
        try {
          winKeyPress(keys);
          log.event("action:key_press", { keys });
          return { content: [{ type: "text", text: `Pressed: ${keys}` }] };
        } catch (err) {
          log.error("action:key_press_error", err, { keys });
          return { content: [{ type: "text", text: `Key press failed: ${err.message}` }] };
        }
      },
    },
    {
      name: "open_app_or_url",
      description: "Open an application by name or a URL in the default browser. Examples: 'notepad', 'Chrome', 'https://github.com'.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "App name (e.g. 'notepad', 'Chrome') or full URL (e.g. 'https://github.com')" },
        },
        required: ["target"],
      },
      execute: async (input) => {
        const { target } = input;
        try {
          if (target.startsWith("http://") || target.startsWith("https://")) {
            execSync(`start "" "${target}"`, { timeout: 5000, windowsHide: true });
            log.event("action:open_url", { url: target });
            return { content: [{ type: "text", text: `Opened URL: ${target}` }] };
          } else {
            // Try to start by name — works for things in PATH and Start Menu
            execSync(`start "" "${target}"`, { timeout: 5000, windowsHide: true });
            log.event("action:open_app", { app: target });
            return { content: [{ type: "text", text: `Opened: ${target}` }] };
          }
        } catch (err) {
          log.error("action:open_error", err, { target });
          return { content: [{ type: "text", text: `Open failed: ${err.message}` }] };
        }
      },
    },
    {
      name: "scroll",
      description: "Scroll at a position. Use positive dy to scroll down, negative dy to scroll up.",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number", description: "X coordinate to scroll at" },
          y: { type: "number", description: "Y coordinate to scroll at" },
          dy: { type: "number", description: "Scroll amount: positive = down, negative = up. Typical: 3-5." },
        },
        required: ["dy"],
      },
      execute: async (input) => {
        const { x, y, dy } = input;
        try {
          winScroll(x, y, dy);
          const direction = dy > 0 ? "down" : "up";
          log.event("action:scroll", { x, y, dy });
          return { content: [{ type: "text", text: `Scrolled ${direction} by ${Math.abs(Math.round(dy))}` }] };
        } catch (err) {
          log.error("action:scroll_error", err);
          return { content: [{ type: "text", text: `Scroll failed: ${err.message}` }] };
        }
      },
    },
    {
      name: "wait",
      description: "Wait for milliseconds. Use between actions to let UI update or pages load.",
      inputSchema: {
        type: "object",
        properties: {
          ms: { type: "number", description: "Milliseconds to wait (max 5000)" },
        },
        required: ["ms"],
      },
      execute: async (input) => {
        const ms = Math.min(input.ms || 1000, 5000);
        await new Promise(resolve => setTimeout(resolve, ms));
        log.event("action:wait", { ms });
        return { content: [{ type: "text", text: `Waited ${ms}ms` }] };
      },
    },
  ];
}

// ── macOS Key Combo Parser (cliclick) ────────────────────────

const KEY_MAP = {
  return: "kp:return", enter: "kp:return",
  tab: "kp:tab",
  escape: "kp:escape", esc: "kp:escape",
  space: "kp:space",
  delete: "kp:delete", backspace: "kp:delete",
  up: "kp:arrow-up", down: "kp:arrow-down",
  left: "kp:arrow-left", right: "kp:arrow-right",
  home: "kp:home", end: "kp:end",
  pageup: "kp:page-up", pagedown: "kp:page-down",
  f1: "kp:f1", f2: "kp:f2", f3: "kp:f3", f4: "kp:f4",
  f5: "kp:f5", f6: "kp:f6", f7: "kp:f7", f8: "kp:f8",
  f9: "kp:f9", f10: "kp:f10", f11: "kp:f11", f12: "kp:f12",
};

const MODIFIER_MAP = {
  cmd: "cmd", command: "cmd",
  ctrl: "ctrl", control: "ctrl",
  alt: "alt", option: "alt",
  shift: "shift",
};

function buildMacKeySequence(combo) {
  const parts = combo.toLowerCase().split("+").map(p => p.trim());
  const modifiers = [];
  let key = null;

  for (const part of parts) {
    if (MODIFIER_MAP[part]) {
      modifiers.push(MODIFIER_MAP[part]);
    } else {
      key = part;
    }
  }

  if (!key) throw new Error(`No key found in combo: ${combo}`);

  const args = [];
  for (const mod of modifiers) args.push(`kd:${mod}`);
  if (KEY_MAP[key]) {
    args.push(KEY_MAP[key]);
  } else if (key.length === 1) {
    args.push(`t:${key}`);
  } else {
    args.push(`kp:${key}`);
  }
  for (const mod of [...modifiers].reverse()) args.push(`ku:${mod}`);

  return args;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Get system tools appropriate for the current platform.
 * @param {string} [platform] - override for testing. Defaults to process.platform.
 * @returns {Array} tool definitions in Anthropic format
 */
function getSystemTools(platform) {
  const p = platform || PLATFORM;
  switch (p) {
    case "darwin":
      return buildMacOSTools();
    case "win32":
      return buildWindowsTools();
    default:
      // Linux: no system tools yet — return empty
      // This prevents injecting macOS-only tools into prompts on unsupported platforms
      log.event("system_actions:no_tools", { platform: p });
      return [];
  }
}

module.exports = { getSystemTools };
