// ---------------------------------------------------------------------------
// Linux input helper
// ---------------------------------------------------------------------------
// Speaks the SAME JSON-lines protocol as input-helper.ps1, so agent.js pipes
// viewer input here unchanged:
//     {"type":"mousemove_relative","dx":5,"dy":-3}
//     {"type":"mousedown_relative","button":0}
//     {"type":"mouseup_relative","button":0}
//     {"type":"keydown","code":"KeyA"}
//     {"type":"keyup","code":"KeyA"}
//
// X11 uses xdotool, which is driven through ONE long-lived `xdotool -` process
// (it reads commands from stdin) -- spawning a process per mouse-move would
// add latency you would feel on every drag.
// Wayland uses ydotool, which has no batch mode, so each event is a short
// spawn. That is slower; on Wayland, logging into an X11 session is better.
// ---------------------------------------------------------------------------

const { spawn, execFileSync } = require("child_process");

// DOM KeyboardEvent.code -> [xdotool keysym, ydotool evdev code]
// Letters and digits are generated below rather than typed out.
const NAMED = {
  Enter: ["Return", "28"], Escape: ["Escape", "1"], Space: ["space", "57"],
  Backspace: ["BackSpace", "14"], Tab: ["Tab", "15"], Delete: ["Delete", "111"],
  Insert: ["Insert", "110"], Home: ["Home", "102"], End: ["End", "107"],
  PageUp: ["Prior", "104"], PageDown: ["Next", "109"],
  ArrowUp: ["Up", "103"], ArrowDown: ["Down", "108"],
  ArrowLeft: ["Left", "105"], ArrowRight: ["Right", "106"],
  ShiftLeft: ["Shift_L", "42"], ShiftRight: ["Shift_R", "54"],
  ControlLeft: ["Control_L", "29"], ControlRight: ["Control_R", "97"],
  AltLeft: ["Alt_L", "56"], AltRight: ["Alt_R", "100"], MetaLeft: ["Super_L", "125"],
  MetaRight: ["Super_R", "126"], CapsLock: ["Caps_Lock", "58"],
  Minus: ["minus", "12"], Equal: ["equal", "13"], BracketLeft: ["bracketleft", "26"],
  BracketRight: ["bracketright", "27"], Backslash: ["backslash", "43"],
  Semicolon: ["semicolon", "39"], Quote: ["apostrophe", "40"],
  Backquote: ["grave", "41"], Comma: ["comma", "51"], Period: ["period", "52"],
  Slash: ["slash", "53"], NumpadEnter: ["KP_Enter", "96"],
  NumpadAdd: ["KP_Add", "78"], NumpadSubtract: ["KP_Subtract", "74"],
  NumpadMultiply: ["KP_Multiply", "55"], NumpadDivide: ["KP_Divide", "98"],
  NumpadDecimal: ["KP_Decimal", "83"],
};
// Evdev codes for A..Z are not contiguous (Q=16, A=30, Z=44, B=48...), so the
// letters need spelling out rather than arithmetic.
Object.assign(NAMED, {
  KeyA: ["a", "30"], KeyB: ["b", "48"], KeyC: ["c", "46"], KeyD: ["d", "32"],
  KeyE: ["e", "18"], KeyF: ["f", "33"], KeyG: ["g", "34"], KeyH: ["h", "35"],
  KeyI: ["i", "23"], KeyJ: ["j", "36"], KeyK: ["k", "37"], KeyL: ["l", "38"],
  KeyM: ["m", "50"], KeyN: ["n", "49"], KeyO: ["o", "24"], KeyP: ["p", "25"],
  KeyQ: ["q", "16"], KeyR: ["r", "19"], KeyS: ["s", "31"], KeyT: ["t", "20"],
  KeyU: ["u", "22"], KeyV: ["v", "47"], KeyW: ["w", "17"], KeyX: ["x", "45"],
  KeyY: ["y", "21"], KeyZ: ["z", "44"],
});
const DIGIT_EVDEV = { Digit0: "11", Digit1: "2", Digit2: "3", Digit3: "4", Digit4: "5",
                      Digit5: "6", Digit6: "7", Digit7: "8", Digit8: "9", Digit9: "10" };
for (const [code, ev] of Object.entries(DIGIT_EVDEV)) NAMED[code] = [code.slice(5), ev];
for (let i = 1; i <= 12; i++) NAMED["F" + i] = ["F" + i, String(111 + i)];
NAMED.F1 = ["F1", "59"]; NAMED.F2 = ["F2", "60"]; NAMED.F3 = ["F3", "61"];
NAMED.F4 = ["F4", "62"]; NAMED.F5 = ["F5", "63"]; NAMED.F6 = ["F6", "64"];
NAMED.F7 = ["F7", "65"]; NAMED.F8 = ["F8", "66"]; NAMED.F9 = ["F9", "67"];
NAMED.F10 = ["F10", "68"]; NAMED.F11 = ["F11", "87"]; NAMED.F12 = ["F12", "88"];

const BUTTON_XDO = { 0: "1", 1: "3", 2: "2" };                 // DOM -> X11 button
const BUTTON_EVDEV = { 0: "0x01", 1: "0x04", 2: "0x02" };       // DOM -> BTN_*

function have(cmd) {
  try { execFileSync("which", [cmd], { stdio: "ignore", timeout: 3000 }); return true; }
  catch (_) { return false; }
}

const WAYLAND = !!process.env.WAYLAND_DISPLAY ||
  (process.env.XDG_SESSION_TYPE || "").toLowerCase() === "wayland";
const USE_YDOTOOL = WAYLAND && have("ydotool");

let xdo = null;                    // the long-lived `xdotool -` process
let xdotoolBrokenUntil = 0;        // back off after a failed spawn

// Say a thing once, not once per mouse-move.
const warned = {};
function warnOnce(key, message) {
  if (warned[key]) return;
  warned[key] = true;
  console.error("[input] " + message);
}

function xdotoolLine(line) {
  // If xdotool is missing or just failed, stop trying for a few seconds.
  // Otherwise every single mouse-move attempts a doomed spawn and logs an
  // error -- thousands of lines a minute.
  if (Date.now() < xdotoolBrokenUntil) return;

  if (!xdo || xdo.exitCode !== null) {
    try {
      xdo = spawn("xdotool", ["-"], { stdio: ["pipe", "ignore", "inherit"] });
    } catch (_) {
      xdotoolBrokenUntil = Date.now() + 10000;
      return;
    }
    xdo.on("exit", () => { xdo = null; });
    // WITHOUT THIS HANDLER, a missing xdotool raises an unhandled 'error'
    // event and the helper dies -- then agent.js restarts it, it fails again,
    // and the two of them spin forever. It must degrade, not crash.
    xdo.on("error", () => {
      xdo = null;
      xdotoolBrokenUntil = Date.now() + 10000;
      warnOnce("xdotool",
        "xdotool is not installed, so the mouse and keyboard will not move. " +
        "Install it (sudo apt install xdotool), or log in to an X11 session, " +
        "then restart ClankerDesk. Video keeps working either way.");
    });
  }
  try { xdo.stdin.write(line + "\n"); } catch (_) { xdo = null; }
}

function ydotool(args) {
  if (Date.now() < ydotoolBrokenUntil) return;
  try {
    execFileSync("ydotool", args, { stdio: "ignore", timeout: 1000 });
  } catch (_) {
    // One dropped keystroke beats a crashed agent. But if it keeps failing,
    // stop trying every frame and say why -- otherwise this is a silent,
    // inexplicable "the mouse is dead".
    ydotoolBrokenUntil = Date.now() + 10000;
    warnOnce("ydotool",
      "ydotool is not working, so the mouse and keyboard will not move. " +
      "Install it and start its daemon:  sudo apt install ydotool && sudo ydotoald");
  }
}
let ydotoolBrokenUntil = 0;

function handle(ev) {
  if (ev.type === "mousemove_relative") {
    const dx = Math.round(ev.dx || 0), dy = Math.round(ev.dy || 0);
    if (!dx && !dy) return;
    if (USE_YDOTOOL) ydotool(["mousemove", "--", String(-dx), String(-dy)]);
    else xdotoolLine(`mousemove_relative -- ${dx} ${dy}`);
    return;
  }
  if (ev.type === "mousedown_relative" || ev.type === "mouseup_relative") {
    const down = ev.type === "mousedown_relative";
    if (USE_YDOTOOL) {
      const b = BUTTON_EVDEV[ev.button]; if (b) ydotool([down ? "click" : "release", b]);
    } else {
      const b = BUTTON_XDO[ev.button]; if (b) xdotoolLine(down ? `mousedown ${b}` : `mouseup ${b}`);
    }
    return;
  }
  if (ev.type === "keydown" || ev.type === "keyup") {
    const hit = NAMED[ev.code];
    if (!hit) return;                       // unmapped key: ignore, don't crash
    if (USE_YDOTOOL) ydotool(["key", `${parseInt(hit[1], 10)}:${ev.type === "keydown" ? 1 : 0}`]);
    else xdotoolLine(`${ev.type === "keydown" ? "key" : "keyup"} ${hit[0]}`);
  }
}

console.error(
  `[input] Linux helper using ${USE_YDOTOOL ? "ydotool (Wayland)" : "xdotool (X11)"}, display=${process.env.DISPLAY || "(unset)"}`
);

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
