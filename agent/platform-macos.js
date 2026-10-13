// ---------------------------------------------------------------------------
// macOS: avfoundation screen capture + VideoToolbox, cliclick input
// ---------------------------------------------------------------------------
// Verified on: nothing yet -- written on Windows, awaiting a real Mac.
//
// THE BIGGEST CAVEAT ON THIS PLATFORM: macOS gates screen capture and input
// injection behind permissions in System Settings, and it only attaches those
// permissions cleanly to a real application bundle. When you run this from
// Terminal, the permissions get granted to *Terminal* (or your terminal app),
// not to node -- so you must enable BOTH:
//     System Settings > Privacy & Security > Screen Recording
//     System Settings > Privacy & Security > Accessibility
// and add your terminal to each. That is the step most likely to make this
// look broken when it isn't; preflight() below says so out loud.
// ---------------------------------------------------------------------------

const { tryRun, hasCommand } = require("./platform-util");

// ---- Capture device --------------------------------------------------------

// avfoundation numbers video devices, and the numbers SHIFT between macOS
// versions (a camera appearing or disappearing renumbers the screens). So ask
// ffmpeg what it actually sees rather than assuming screen 1.
function listVideoDevices() {
  const out = tryRun("ffmpeg", ["-f", "avfoundation", "-list_devices", "true", "-i", ""], 8000);
  if (!out) return [];
  const lines = out.split("\n");
  const devices = [];
  let inVideo = false;
  for (const line of lines) {
    if (/AVFoundation video devices/i.test(line)) { inVideo = true; continue; }
    if (/AVFoundation audio devices/i.test(line)) { inVideo = false; continue; }
    if (!inVideo) continue;
    const m = line.match(/\[(\d+)\]\s+(.+?)\s*$/);
    if (m) devices.push({ index: m[1], name: m[2] });
  }
  return devices;
}

// "Capture screen 0" is a screen; "FaceTime HD Camera" is not.
function pickScreenDevice() {
  const devices = listVideoDevices();
  const screens = devices.filter((d) => /capture screen/i.test(d.name));
  if (screens.length) return screens[0];
  return devices.length ? devices[devices.length - 1] : null;
}

module.exports = {
  name: "macOS",

  // ---- Video ---------------------------------------------------------------
  videoArgs(preset, ctx) {
    const screen = pickScreenDevice();
    if (!screen) {
      // Better a clear failure than an opaque ffmpeg one.
      console.error(
        "[capture] No capture device found. macOS needs Screen Recording permission:\n" +
        "           System Settings > Privacy & Security > Screen Recording,\n" +
        "           and add your terminal app (Terminal, iTerm, VS Code...) to the list."
      );
    }
    // "none" as the audio half of the avfoundation device pair -- sound is a
    // separate ffmpeg process on every platform, so this stream is video-only.
    const input = `${screen ? screen.index : "1"}:none`;

    const out = [
      "-f", "avfoundation",
      "-capture_cursor", "1",
      "-framerate", String(preset.fps),
      "-i", input,
    ];
    if (preset.w !== ctx.nativeW || preset.h !== ctx.nativeH) {
      out.push("-vf", `scale=${preset.w}:${preset.h}`);
    }

    out.push(
      // VideoToolbox is the hardware encoder on every modern Mac. It has no
      // -slices / -tune / -forced-idr equivalents, so those are deliberately
      // absent here -- everything else matches the other platforms so the
      // browser decodes all three identically.
      "-c:v", "h264_videotoolbox",
      "-b:v", preset.bitrate,
      "-maxrate", preset.bitrate,
      "-bufsize", preset.bufsize,
      "-g", String(preset.fps),      // keyframe once a second, like everywhere else
      // avfoundation hands back whatever the display gives it (commonly 4:2:2),
      // and "high" profile is 4:2:0 only -- same class of failure as the Linux
      // one ("high profile doesn't support 4:4:4" -> "Conversion failed").
      // Naming the pixel format is what fixes it.
      "-pix_fmt", "yuv420p",
      "-profile:v", "high",
      "-level:v", "5.1",
      "-bf", "0",                    // no B-frames
      "-realtime", "1",              // favour low latency over compression efficiency
      "-f", "h264",
      "pipe:1",
    );
    return out;
  },

  // ---- Audio ---------------------------------------------------------------
  // macOS has no system-audio loopback. The supported route is a virtual audio
  // device, so we look for BlackHole (the standard one) and fall back to
  // whatever audioDevice the user put in config.json.
  audioInputArgs(cfg) {
    const configured = (cfg && cfg.audioDevice) || "";
    let source = configured;
    if (!source) {
      const out = tryRun("ffmpeg", ["-f", "avfoundation", "-list_devices", "true", "-i", ""], 8000);
      if (out) {
        const lines = out.split("\n");
        let inAudio = false;
        for (const line of lines) {
          if (/AVFoundation audio devices/i.test(line)) { inAudio = true; continue; }
          if (!inAudio) continue;
          const m = line.match(/\[(\d+)\]\s+(.+?)\s*$/);
          // A real input that is not the built-in mic: BlackHole and friends.
          if (m && /blackhole|loopback|virtual/i.test(m[2])) { source = m[1] + ":0"; break; }
        }
      }
    }
    if (!source) {
      console.error(
        "\n[sound] No system-audio device found, so this Mac will stream video silently.\n" +
        "        To hear sound on the far side, install a virtual audio device:\n" +
        "          brew install blackhole-2ch\n" +
        "        then set \"audioDevice\" in config.json to the device it lists\n" +
        "        (find the number with: ffmpeg -f avfoundation -list_devices true -i \"\").\n"
      );
    }
    return {
      helper: false,
      args: source
        ? ["-f", "avfoundation", "-i", source]
        : ["-f", "avfoundation", "-i", "0:0"], // built-in mic at least, rather than nothing
    };
  },

  audioHelper() {
    return { command: "ffmpeg", script: null, extra: [] };
  },

  // ---- Input ---------------------------------------------------------------
  inputHelper() {
    return { command: process.execPath, script: "helpers/input-macos.js", extra: [] };
  },

  // ---- Host control window -------------------------------------------------
  supportsHostWindow: false,
  hostWindowScript: null,

  // ---- What this needs installed ------------------------------------------
  deps: [
    "Node.js 18+",
    "FFmpeg (brew install ffmpeg)",
    "cliclick (brew install cliclick) for mouse + keyboard",
    "Screen Recording + Accessibility permission for your terminal app",
  ],

  // ---- Diagnostics ---------------------------------------------------------
  osLabel(nativeRelease) {
    const map = { "23": "macOS Sonoma", "22": "macOS Ventura", "21": "macOS Monterey",
                  "20": "macOS Big Sur", "19": "macOS Catalina", "18": "macOS Mojave",
                  "17": "macOS High Sierra", "16": "macOS Sierra", "15": "macOS El Capitan" };
    let label = "macOS";
    try {
      // Darwin 23 = Sonoma, 24 = Sequoia, 25 = Tahoe...
      const major = parseInt(String(nativeRelease || "").split(".")[1], 10);
      if (!isNaN(major)) label = map[String(major)] || "macOS (Darwin " + nativeRelease + ")";
    } catch (_) {}
    return label;
  },

  // ---- Preflight -----------------------------------------------------------
  preflight() {
    const problems = [];
    const warns = [];

    if (!hasCommand("ffmpeg")) {
      problems.push("ffmpeg is not installed. Run: brew install ffmpeg");
    }
    if (!hasCommand("cliclick")) {
      problems.push(
        "cliclick is not installed, so mouse and keyboard will not work.\n" +
        "            Run: brew install cliclick"
      );
    }
    warns.push(
      "macOS permissions: open System Settings > Privacy & Security and enable BOTH\n" +
      "            'Screen Recording' and 'Accessibility' for your terminal app\n" +
      "            (Terminal, iTerm, VS Code...). Without these the screen will be black\n" +
      "            or grey and input will do nothing. This is the #1 cause of 'it does nothing'."
    );
    return { problems, warns };
  },

  _listVideoDevices: listVideoDevices,
  _pickScreenDevice: pickScreenDevice,
};
