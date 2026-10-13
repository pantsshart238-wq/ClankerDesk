// ---------------------------------------------------------------------------
// Linux: X11/Wayland capture + NVENC or x264, PulseAudio loopback, xdotool
// ---------------------------------------------------------------------------
// Verified on: nothing yet -- this was written on Windows and is being tested
// on a real Linux box. Expect the first run to need a tweak; the console
// output here is deliberately loud about WHY something failed so a paste-back
// is enough to diagnose it.

const { tryRun, hasCommand } = require("./platform-util");

// ---- Screen geometry -------------------------------------------------------

// x11grab needs an explicit size. Ask X what the display actually is rather
// than trusting config.json, because the user may have changed resolution.
function screenSize(fallbackW, fallbackH) {
  const out = tryRun("xrandr", ["--current"]);
  if (out) {
    // The connected output line looks like:
    //   "   1920x1080+0+0"  -- take the first mode with no rotation marker.
    const m = out.match(/(\d+)x(\d+)\+\d+\+\d+(?!\s+rot)/);
    if (m) return { w: parseInt(m[1], 10), h: parseInt(m[2], 10) };
  }
  return { w: fallbackW, h: fallbackH };
}

function isWayland() {
  return !!process.env.WAYLAND_DISPLAY ||
    (process.env.XDG_SESSION_TYPE || "").toLowerCase() === "wayland";
}

// ---- Encoder choice --------------------------------------------------------

// Prefer NVENC when there is an NVIDIA card, because it is what the Windows
// build uses and it leaves the CPU free. Otherwise x264 in ultrafast -- slower,
// but it works on Intel/AMD laptops, which is what most people have.
function pickEncoder() {
  if (hasCommand("nvidia-smi")) {
    try {
      if (tryRun("nvidia-smi", ["-L"])) return "h264_nvenc";
    } catch (_) { /* fall through */ }
  }
  return "libx264";
}

module.exports = {
  name: "Linux",

  // ---- Video ---------------------------------------------------------------
  videoArgs(preset, ctx) {
    const size = screenSize(ctx.nativeW, ctx.nativeH);
    // Grab at the real screen size and let the filter downscale to the preset,
    // so switching quality never needs a different capture rectangle.
    const out = [
      "-f", "x11grab",
      "-draw_mouse", "1",
      "-framerate", String(preset.fps),
      "-video_size", `${size.w}x${size.h}`,
      "-i", (process.env.DISPLAY || ":0") + ".0+0,0",
    ];

    if (preset.w !== size.w || preset.h !== size.h) {
      out.push("-vf", `scale=${preset.w}:${preset.h}`);
    }

    const codec = pickEncoder();
    if (codec === "h264_nvenc") {
      out.push(
        "-c:v", "h264_nvenc",
        "-preset", "p1",
        "-tune", "ull",
        "-slices", "1",
        "-rc", "cbr",
      );
    } else {
      // x264: zerolatency kills lookahead, ultrafast keeps CPU cost low, and
      // slices=1 is the x264 equivalent of NVENC's -slices 1 (the browser's
      // Annex-B frame parser needs single-slice frames to find boundaries).
      out.push(
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-tune", "zerolatency",
        "-x264-params", "slices=1",
      );
    }

    out.push(
      "-b:v", preset.bitrate,
      "-maxrate", preset.bitrate,
      "-bufsize", preset.bufsize,
      "-g", String(preset.fps),   // keyframe once a second, same as every other
                                  // platform: the viewer's latency guard resyncs
                                  // on the next keyframe
      // x11grab hands back BGR[0] -- 4:4:4 -- and libx264 will NOT convert on
      // its own. Asking for profile "high" (4:2:0 only) then fails outright:
      //     x264 [error]: high profile doesn't support 4:4:4
      //     Conversion failed!
      // NVENC converts internally, which is why this never showed on Windows.
      // Naming the pixel format explicitly is what fixes it.
      "-pix_fmt", "yuv420p",
      "-profile:v", "high",
      "-level:v", "5.1",
      "-bf", "0",                 // no B-frames
      "-forced-idr", "1",
      "-f", "h264",
      "pipe:1",
    );
    return out;
  },

  // ---- Audio ---------------------------------------------------------------
  // PulseAudio/PipeWire have a real monitor source -- the Linux equivalent of
  // WASAPI loopback, and the reason no virtual cable is needed here either.
  audioInputArgs(cfg) {
    const configured = (cfg && cfg.audioDevice) || "";
    let source = configured;
    if (!source) {
      const sink = tryRun("pactl", ["get-default-sink"]);
      if (sink) source = sink + ".monitor";
      else source = "@DEFAULT_SINK@";
    }
    return { helper: false, args: ["-f", "pulse", "-i", source] };
  },

  audioHelper() {
    return { command: "ffmpeg", script: null, extra: [] };
  },

  // ---- Input ---------------------------------------------------------------
  // A Node helper speaking the SAME JSON-lines protocol as input-helper.ps1, so
  // agent.js forwards input to all three platforms without knowing the
  // difference.
  inputHelper() {
    return { command: process.execPath, script: "helpers/input-linux.js", extra: [] };
  },

  // ---- Host control window -------------------------------------------------
  // No PowerShell equivalent; the console IS the control surface.
  supportsHostWindow: false,
  hostWindowScript: null,

  // ---- What this needs installed ------------------------------------------
  deps: [
    "Node.js 18+",
    "FFmpeg with x11grab (standard on Debian/Ubuntu/Fedora)",
    "xdotool (X11) or ydotool (Wayland)",
    "PulseAudio or PipeAudio (for sound)",
  ],

  // ---- Diagnostics ---------------------------------------------------------
  osLabel() {
    let rel = "";
    try { rel = require("os").release(); } catch (_) {}
    let name = "Linux";
    try {
      const r = require("fs").readFileSync("/etc/os-release", "utf8");
      const m = r.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
      if (m) name = m[1];
    } catch (_) { /* /etc/os-release missing: keep "Linux" */ }
    return name + (rel ? " (kernel " + rel + ")" : "");
  },

  // ---- Preflight -----------------------------------------------------------
  // Called once at startup on non-Windows so a missing package is a clear
  // sentence instead of an ffmpeg exit code.
  preflight() {
    const problems = [];
    const warns = [];

    if (!hasCommand("ffmpeg")) {
      problems.push("ffmpeg is not installed. On Debian/Ubuntu: sudo apt install ffmpeg");
    }
    if (isWayland()) {
      if (!hasCommand("ydotool")) {
        problems.push(
          "This is a Wayland session, so xdotool cannot move the mouse.\n" +
          "            EITHER: log in to an X11 session (GNOME: 'Ubuntu on Xorg' at the login screen)\n" +
          "            OR:     install ydotool (sudo apt install ydotool) and run: sudo ydotoald"
        );
      }
      warns.push("Wayland detected -- screen capture uses XWayland, which can miss some pop-up windows.");
    } else if (!hasCommand("xdotool")) {
      problems.push("xdotool is not installed. On Debian/Ubuntu: sudo apt install xdotool");
    }
    if (!hasCommand("pactl")) {
      warns.push("pactl not found -- no sound. Install PulseAudio or PipeAudio (sudo apt install pulseaudio-utils)");
    }
    return { problems, warns };
  },

  // Exposed for tests
  _screenSize: screenSize,
  _pickEncoder: pickEncoder,
  _isWayland: isWayland,
};
