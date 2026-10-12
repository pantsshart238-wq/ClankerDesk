// ---------------------------------------------------------------------------
// macOS input helper
// ---------------------------------------------------------------------------
// Same JSON-lines protocol as input-helper.ps1 (see input-linux.js for the
// contract), driving cliclick.
//
// REQUIRES ACCESSIBILITY PERMISSION. macOS grants that to your terminal app,
// not to node: System Settings > Privacy & Security > Accessibility, then add
// and enable Terminal / iTerm / VS Code. Without it every command below fails
// silently, which looks exactly like "the mouse is broken".
// ---------------------------------------------------------------------------

const { spawn, execFileSync } = require("child_process");

// DOM KeyboardEvent.code -> cliclick key name
const NAMED = {
  Enter: "return", Escape: "esc", Space: "space", Backspace: "bksp", Tab: "tab",
  Delete: "del", Insert: "ins", Home: "home", End: "end",
  PageUp: "pgup", PageDown: "pgdn",
  ArrowUp: "up", ArrowDown: "dn", ArrowLeft: "lt", ArrowRight: "rt",
  ShiftLeft: "shift", ShiftRight: "shift",
  ControlLeft: "ctrl", ControlRight: "ctrl",
  AltLeft: "alt", AltRight: "alt",
  MetaLeft: "cmd", MetaRight: "cmd",
  CapsLock: "caps_lock", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
  Backslash: "\\", Semicolon: ";", Quote: "'", Backquote: "`",
  Comma: ",", Period: ".", Slash: "/",
  NumpadEnter: "kp_enter", NumpadAdd: "kp_plus", NumpadSubtract: "kp_minus",
  NumpadMultiply: "kp_multiply", NumpadDivide: "kp_divide", NumpadDecimal: "kp_decimal",
};
for (let i = 0; i < 26; i++) {
  NAMED["Key" + String.fromCharCode(65 + i)] = String.fromCharCode(97 + i);
}
for (let i = 0; i <= 9; i++) NAMED["Digit" + i] = String(i);
for (let i = 1; i <= 12; i++) NAMED["F" + i] = "f" + i;

// cliclick's down/up verbs per button: left / middle / right
const DOWN = { 0: "dd", 1: "md", 2: "rd" };
const UP = { 0: "du", 1: "mu", 2: "ru" };

function cliclick(args) {
  if (!args.length) return;
  try {
    execFileSync("cliclick", args, { stdio: "ignore", timeout: 1000 });
  } catch (_) {
    // A dropped click beats a crashed agent. If this fires constantly it is
    // almost always missing Accessibility permission -- see the banner above.
  }
}

function handle(ev) {
  if (ev.type === "mousemove_relative") {
    const dx = Math.round(ev.dx || 0), dy = Math.round(ev.dy || 0);
    if (dx || dy) cliclick(["dp:" + dx + "," + dy]);
    return;
  }
  if (ev.type === "mousedown_relative") {
    const v = DOWN[ev.button]; if (v) cliclick([v]);
    return;
  }
  if (ev.type === "mouseup_relative") {
    const v = UP[ev.button]; if (v) cliclick([v]);
    return;
  }
  if (ev.type === "keydown" || ev.type === "keyup") {
    const k = NAMED[ev.code];
    if (!k) return;                                  // unmapped key: ignore
    cliclick([(ev.type === "keydown" ? "kd:" : "ku:") + k]);
  }
}

console.error("[input] macOS helper using cliclick");

let pending = "";
process.stdin.on("data", (chunk) => {
  pending += chunk;
  let nl;
  while ((nl = pending.indexOf("\n")) !== -1) {
    const line = pending.slice(0, nl).trim();
    pending = pending.slice(nl + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch (_) { /* ignore junk */ }
  }
});
process.stdin.on("end", () => process.exit(0));
