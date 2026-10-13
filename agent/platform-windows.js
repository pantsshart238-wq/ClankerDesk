// ---------------------------------------------------------------------------
// Windows: gfxcapture + NVENC + WASAPI loopback
// ---------------------------------------------------------------------------
// This file is a faithful EXTRACTION of what used to be inline in agent.js.
// Do not "improve" it -- any change here changes the working Windows build.
// The self-test compares its output against the recorded original, so an
// accidental edit fails loudly rather than shipping a subtle regression.

const { hasCommand } = require("./platform-util");
const binaries = require("./binaries");

module.exports = {
  name: "Windows",

  // ---- Startup checks -------------------------------------------------------
  // Setup.bat used to install Node.js and nothing else, and the agent had no
  // checks at all on Windows. A machine without ffmpeg therefore produced a
  // wall of unrelated-looking errors instead of one sentence: "spawn ffmpeg
  // ENOENT", a watchdog claiming capture had stalled, and ffplay missing too.
  // None of those name the actual problem. Say it plainly, up front.
  preflight() {
    const problems = [];
    const warns = [];

    if (!binaries.findBinary("ffmpeg")) {
      problems.push(
        "ffmpeg is not installed, so there will be no picture.\n" +
        "            Install it, then restart ClankerDesk:\n" +
        "              winget install --id Gyan.FFmpeg --accept-source-agreements\n" +
        "            (or download a build from https://ffmpeg.org/download.html and add\n" +
        "             its bin folder to your PATH)"
      );
    } else if (!binaries.findBinary("ffplay")) {
      // ffplay ships inside the same ffmpeg package. Without it there is still
      // video, but a viewer's microphone will never play on this PC.
      warns.push(
        "ffplay is missing (it normally ships with ffmpeg), so viewers'\n" +
        "            microphones will not play on this PC. Reinstall ffmpeg."
      );
    }

    if (!this.d3d11Available()) {
      warns.push(
        "Windows Graphics Capture cannot start (D3D11 unavailable), so it will\n" +
        "            fall back to GDI capture. That works without a monitor, but it is\n" +
        "            slower and limited to whatever the virtual display's size is\n" +
        "            (often 640x480). Plugging in a monitor -- or an HDMI dummy plug --\n" +
        "            gives the fast path back."
      );
    }

    return { problems, warns };
  },

  // ---- Which capture path ---------------------------------------------------
  // gfxcapture is built on D3D11, and D3D11 needs a display adapter it can
  // open. A PC with no monitor (headless / server-style, often driven over
  // Parsec or similar) reports no physical monitor, falls back to a 640x480
  // virtual display, and D3D11 then fails outright with
  //     Device creation failed: -1313558101
  //     Failed to set value 'd3d11va' for option 'init_hw_device'
  // ...leaving no video at all. gdigrab goes through plain GDI, does not need
  // D3D11, and still captures that virtual display. Slower, and limited to
  // whatever the virtual display is, but it works.
  //
  // Probed once at startup rather than on every failure, so a working machine
  // pays ~50ms and a headless one stops retrying a path that cannot work.
  d3d11Available() {
    if (this._d3d11 !== undefined) return this._d3d11;
    try {
      require("child_process").execFileSync("ffmpeg", [
        "-hide_banner", "-loglevel", "error",
        "-init_hw_device", "d3d11va",
        "-f", "lavfi", "-i", "color=s=8x8:d=0.1",
        "-f", "null", "-",
      ], { timeout: 20000, stdio: ["ignore", "ignore", "ignore"] });
      this._d3d11 = true;
    } catch (_) {
      this._d3d11 = false;
    }
    return this._d3d11;
  },

  // Headless capture. Everything is the same as the D3D11 path except the
  // capture filter and the downscale: GDI gives us whatever the virtual
  // display happens to be (often 640x480), and upscaling that to 1080p would
  // just waste megabits, so the native size is streamed and the viewer's
  // canvas does the scaling.
  headlessArgs(preset) {
    return [
      "-f", "gdigrab",
      "-framerate", String(preset.fps),
      "-draw_mouse", "1",
      "-i", "desktop",

      "-c:v", "h264_nvenc",
      "-preset", "p1",
      "-tune", "ull",
      "-slices", "1",
      "-rc", "cbr",
      "-b:v", preset.bitrate,
      "-maxrate", preset.bitrate,
      "-bufsize", preset.bufsize,
      "-g", String(preset.fps),
      "-profile:v", "high",
      "-level:v", "5.1",
      "-bf", "0",
      "-forced-idr", "1",

      "-f", "h264",
      "pipe:1",
    ];
  },

  // ---- Video ---------------------------------------------------------------
  // `preset` is one of the QUALITY_PRESETS entries; `ctx.nativeW/nativeH` are
  // this PC's real screen size, used to decide whether the preset downscales.
  videoArgs(preset, ctx) {
    // Escape hatch, in case the probe guesses wrong on an odd machine.
    const forced = String(process.env.CAPTURE || "").toLowerCase();
    if (forced === "gdi" || (forced !== "d3d11" && !this.d3d11Available())) {
      if (!this._warnedHeadless) {
        this._warnedHeadless = true;
        console.error(
          "\n[capture] No display adapter available for Windows Graphics Capture (D3D11 could not start).\n" +
          "           Usually that means no monitor is connected, so Windows is on a small\n" +
          "           virtual display. Falling back to GDI capture, which works headless but\n" +
          "           is slower and limited to that virtual display's size.\n" +
          "           Plug in a monitor (or an HDMI dummy plug) for full quality.\n"
        );
      }
      return this.headlessArgs(preset);
    }

    return [
      "-init_hw_device", "d3d11va",

      // gfxcapture (Windows Graphics Capture) -- the capture method we're keeping.
      // It handles busy 3D scenes without the freezing ddagrab/gdigrab showed.
      //
      // gfxcapture hands back D3D11 (GPU) frames, and the plain `scale` filter
      // cannot read that format -- it aborts the whole graph with "Error
      // configuring filter graph: Function not implemented", so ffmpeg died
      // instantly and 720p never produced a picture. The downscale therefore
      // downloads to system memory first (bgra), scales there, and converts to
      // the nv12 NVENC wants. Presets that don't downscale keep the original
      // untouched GPU path.
      "-filter_complex", `gfxcapture=monitor_idx=0:max_framerate=${preset.fps}:capture_cursor=1` +
        (preset.w !== ctx.nativeW || preset.h !== ctx.nativeH
          ? `,hwdownload,format=bgra,scale=${preset.w}:${preset.h},format=nv12`
          : ""),

      "-c:v", "h264_nvenc",
      "-preset", "p1",           // reverted from p4 back to p1 -- p1 is the most
                                 // consistent/lowest-latency preset with the least
                                 // per-frame timing variance; prioritizing "never
                                 // laggy" over "slightly sharper text" right now
      "-tune", "ull",            // zero lookahead/buffering
      "-slices", "1",           // force exactly one slice per frame -- the AnnexBFrameParser
                                 // assumes this to find frame boundaries; without it, a
                                 // multi-slice frame (more likely in high-motion scenes) can
                                 // confuse the browser's decoder and stall video with no error
      "-rc", "cbr",
      "-b:v", preset.bitrate,
      "-maxrate", preset.bitrate,
      "-bufsize", preset.bufsize, // deliberately smaller than the bitrate -- a bufsize equal to
                                 // the full bitrate lets up to ~1 second of frames queue up before
                                 // delivery (exactly what "randomly gets delayed" feels like);
                                 // a tighter buffer forces the encoder to drop quality briefly
                                 // during spikes instead of building up a delay
      "-g", String(preset.fps),  // keyframe once a second. The viewer's latency guard
                                 // resyncs a falling-behind decoder on the NEXT
                                 // keyframe, so this gap bounds how long a slow
                                 // client freezes before it is live again.
      "-profile:v", "high",
      "-level:v", "5.1",
      "-bf", "0",                // no B-frames: keeps decode order == display order, simplifies timestamps
      "-forced-idr", "1",

      "-f", "h264",
      "pipe:1",
    ];
  },

  // ---- Audio ---------------------------------------------------------------
  // Loopback is WASAPI: audio-helper.ps1 listens to whatever the PC is
  // playing and writes raw PCM into ffmpeg's stdin. An explicit device in
  // config.json still uses the older direct dshow capture.
  audioInputArgs(cfg) {
    const device = (cfg && cfg.audioDevice) || "";
    if (!device) {
      return { helper: true, args: ["-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "pipe:0"] };
    }
    return {
      helper: false,
      args: ["-f", "dshow", "-audio_buffer_size", "20", "-use_wallclock_as_timestamps", "1",
             "-i", `audio=${device}`],
    };
  },

  audioHelper() {
    return { command: "powershell.exe", script: "audio-helper.ps1", extra: [] };
  },

  // ---- Input ---------------------------------------------------------------
  inputHelper() {
    return { command: "powershell.exe", script: "input-helper.ps1", extra: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"] };
  },

  // ---- Host control window -------------------------------------------------
  supportsHostWindow: true,
  hostWindowScript: "host-window.ps1",

  // ---- What this needs installed ------------------------------------------
  deps: ["Node.js 18+", "FFmpeg built with nvenc + gfxcapture", "An NVIDIA GPU"],

  // ---- Diagnostics ---------------------------------------------------------
  osLabel(nativeRelease) {
    let label = "Windows";
    if (/^\d+\.\d+\.\d+/.test(nativeRelease || "")) {
      const parts = String(nativeRelease).split(".").map(Number);
      const names = { 10: "Windows 10/11", 6: "Windows Vista", 7: "Windows 7", 5: "Windows XP" };
      label = names[parts[0]] || "Windows";
      return label + " (build " + parts[2] + ")";
    }
    return label;
  },
};
