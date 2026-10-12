// Exercises the Linux and macOS platform modules on a machine that is not
// those platforms. It cannot prove the capture works -- only a real box can
// do that -- but it does prove the modules LOAD, produce syntactically
// sensible ffmpeg argv, and never throw on a missing tool. That is the class
// of bug that would otherwise only show up on the user's laptop at midnight.
const lin = require("./platform-linux");
const mac = require("./platform-macos");
const pw = require("./platform-windows");

const PRESETS = {
  "1080p60": { w: 1920, h: 1080, fps: 60, bitrate: "10M", bufsize: "5M" },
  "720p60":  { w: 1280, h: 720,  fps: 60, bitrate: "4M",  bufsize: "3M" },
  "1080p30": { w: 1920, h: 1080, fps: 30, bitrate: "8M",  bufsize: "3M" },
};
const CTX = { nativeW: 1920, nativeH: 1080 };

let bad = 0;
function check(label, fn) {
  try { fn(); console.log("  ok   " + label); }
  catch (e) { bad++; console.log("  FAIL " + label + " -> " + e.message); }
}

// Every module must implement the same surface, or agent.js crashes at runtime
// on whichever OS is missing the method.
const REQUIRED = ["videoArgs", "audioInputArgs", "audioHelper", "inputHelper",
                  "supportsHostWindow", "osLabel", "deps"];
for (const [name, mod] of [["windows", pw], ["linux", lin], ["macos", mac]]) {
  check(`${name}: implements the full interface`, () => {
    const missing = REQUIRED.filter((m) => mod[m] === undefined);
    if (missing.length) throw new Error("missing: " + missing.join(", "));
  });
}

for (const [name, mod] of [["linux", lin], ["macos", mac]]) {
  console.log(`\n--- ${name} ---`);
  for (const [key, preset] of Object.entries(PRESETS)) {
    check(`${key}: videoArgs is a non-empty string array`, () => {
      const a = mod.videoArgs(preset, CTX);
      if (!Array.isArray(a) || !a.length) throw new Error("not an array");
      if (a.some((x) => typeof x !== "string")) throw new Error("non-string element");
      if (a[a.length - 1] !== "pipe:1") throw new Error("does not end with pipe:1");
      // These are what the browser's decoder depends on. `-f` appears more
      // than once (x11grab/avfoundation AND h264), so scan every occurrence
      // rather than trusting indexOf to land on the right one.
      const hasPair = (flag, value) => a.some((v, i) => v === flag && a[i + 1] === value);
      if (!hasPair("-f", "h264")) throw new Error("missing '-f h264' (raw Annex-B out)");
      if (!hasPair("-profile:v", "high")) throw new Error("missing '-profile:v high'");
      if (!hasPair("-bf", "0")) throw new Error("missing '-bf 0'");
      // A keyframe interval equal to the framerate, so the viewer's latency
      // guard can resync. This is the single most important shared setting.
      const g = a.indexOf("-g");
      if (g === -1 || a[g + 1] !== String(preset.fps)) throw new Error("-g is not " + preset.fps);
    });
  }

  check("audioInputArgs returns args", () => {
    const a = mod.audioInputArgs({ audioDevice: "" });
    if (!Array.isArray(a.args) || !a.args.length) throw new Error("no args");
    if (typeof a.helper !== "boolean") throw new Error("helper is not a boolean");
  });

  check("inputHelper points at a script that exists", () => {
    const h = mod.inputHelper();
    const path = require("path");
    const p = path.join(__dirname, h.script);
    if (!require("fs").existsSync(p)) throw new Error("missing file: " + p);
    if (h.command !== "powershell.exe" && h.command !== process.execPath) {
      throw new Error("unexpected command: " + h.command);
    }
  });

  check("osLabel returns a string", () => {
    if (typeof mod.osLabel("10.0.22631") !== "string") throw new Error("not a string");
  });

  check("preflight returns problems[] and warns[]", () => {
    const p = mod.preflight();
    if (!Array.isArray(p.problems) || !Array.isArray(p.warns)) throw new Error("bad shape");
  });
}

// The input helpers must speak the protocol agent.js actually sends.
console.log("\n--- input helpers ---");
for (const f of ["helpers/input-linux.js", "helpers/input-macos.js"]) {
  const src = require("fs").readFileSync(require("path").join(__dirname, f), "utf8");
  for (const t of ["mousemove_relative", "mousedown_relative", "mouseup_relative", "keydown", "keyup"]) {
    check(`${f} handles ${t}`, () => {
      if (!src.includes(t)) throw new Error("event type not handled");
    });
  }
  check(`${f} reads newline-delimited JSON on stdin`, () => {
    if (!src.includes('process.stdin.on("data"') || !src.includes('indexOf("\\n")')) {
      throw new Error("does not read NDJSON");
    }
  });
}

// The one thing that must never regress.
console.log("\n--- windows regression ---");
check("windows argv identical to the original hardcoded array", () => {
  require("child_process").execFileSync(process.execPath, [require("path").join(__dirname, "platform-selftest.js")], { stdio: "ignore" });
});

console.log(bad ? `\n${bad} FAILURE(S)` : "\nAll platform checks passed.");
process.exit(bad ? 1 : 0);
