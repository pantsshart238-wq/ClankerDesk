// ---------------------------------------------------------------------------
// Windows: gfxcapture + NVENC + WASAPI loopback
// ---------------------------------------------------------------------------
// This file is a faithful EXTRACTION of what used to be inline in agent.js.
// Do not "improve" it -- any change here changes the working Windows build.
// The self-test compares its output against the recorded original, so an
// accidental edit fails loudly rather than shipping a subtle regression.

const { hasCommand } = require("./platform-util");
const binaries = require("./binaries");

// ---------------------------------------------------------------------------
// Choosing an H.264 encoder
// ---------------------------------------------------------------------------
// This used to be hardcoded to h264_nvenc, on the theory that a machine with
// an NVIDIA GPU can use it. That is not true, and the failure is total and
// silent:
//
//   [h264_nvenc] Driver does not support the required nvenc API version.
//                 Required: 13.1 Found: 11.1
//   [h264_nvenc] The minimum required Nvidia driver for nvenc is 610.00
//
// An NVIDIA GPU being present says nothing about whether the installed DRIVER
// is recent enough for the installed ffmpeg. Those two versions move
// independently: ffmpeg 7 wants NVENC API 12, ffmpeg 9 wants 13.1, and a driver
// from a few years ago still reports 11.1. So a laptop could have a perfectly
// good NVIDIA card and still be unable to open the encoder at all.
//
// When that happens, ffmpeg exits immediately, the agent restarts it, it exits
// again, and the user sees an endless watchdog loop ("capture appears stalled")
// that never mentions an encoder or a driver.
//
// So the encoder is PROBED, not assumed, and there is always something that
// works: Intel Quick Sync and AMD AMF are hardware encoders present on most
// laptops, and libx264 is software and works on literally any machine.
//
// The nvenc entry below must stay byte-for-byte what it always was:
// platform-selftest.js compares generated argv against the recorded original,
// so any drift fails loudly instead of quietly regressing the working path.
const ENCODER_OPTS = {
  h264_nvenc: (p) => [
    "-c:v", "h264_nvenc",
    "-preset", "p1",             // p1 is the most consistent/lowest-latency preset with the
                                 // least per-frame timing variance; prioritising "never laggy"
                                 // over "slightly sharper text" is the right trade right now
    "-tune", "ull",              // zero lookahead/buffering
    "-slices", "1",              // exactly one slice per frame -- the AnnexBFrameParser assumes
                                 // this to find frame boundaries; a multi-slice frame can
                                 // confuse the browser's decoder and stall video with no error
    "-rc", "cbr",
    "-b:v", p.bitrate,
    "-maxrate", p.bitrate,
    "-bufsize", p.bufsize,       // deliberately smaller than the bitrate: a bufsize equal to the
                                 // full bitrate lets up to ~1s of frames queue before delivery
                                 // (exactly what "randomly gets delayed" feels like); a tighter
                                 // buffer drops quality briefly during spikes instead of
                                 // building up a delay
    "-g", String(p.fps),         // keyframe once a second, so the viewer's latency guard resyncs
                                 // a falling-behind decoder on the NEXT keyframe
    "-profile:v", "high",
    "-level:v", "5.1",
    "-bf", "0",                  // no B-frames: keeps decode order == display order
    "-forced-idr", "1",
  ],
  h264_qsv: (p) => [
    "-c:v", "h264_qsv",
    "-preset", "veryfast",
    // QSV has no "ull" and, per a real user log, no "tune" either -- ffmpeg said
    // "Codec AVOption tune ... has not been used for any stream", i.e. it was
    // silently ignored. Dropping it costs nothing and removes a warning that
    // nobody can act on.
    "-pix_fmt", "nv12",            // QSV rejects yuv420p by name: "Incompatible pixel
                                   // format 'yuv420p' ... auto-selecting 'nv12'"
    "-profile:v", "high",
    "-level:v", "5.1",
    "-bf", "0",
    "-forced_idr", "1",          // note the underscore: QSV spells it differently to NVENC
    "-b:v", p.bitrate,
    "-maxrate", p.bitrate,
    "-bufsize", p.bufsize,
    "-g", String(p.fps),
  ],
  h264_amf: (p) => [
    "-c:v", "h264_amf",
    "-usage", "ultralowlatency",
    "-quality", "speed",
    "-pix_fmt", "nv12",            // same hardware-NV12 convention as QSV
    "-rc", "cqp",
    "-qp_i", "18", "-qp_p", "20", "-qp_b", "22",
    "-profile:v", "high",
    "-bf", "0",
    "-b:v", p.bitrate,
    "-maxrate", p.bitrate,
    "-bufsize", p.bufsize,
    "-g", String(p.fps),
  ],
  libx264: (p) => [
    "-c:v", "libx264",
    "-preset", "ultrafast",      // software: the speed presets are the only sane ones at 60fps
    "-tune", "zerolatency",
    // gdigrab hands over bgra, and libx264 refuses it outright:
    //   "Task finished with error code: -22 (Invalid argument)", 0 frames.
    // So the fallback meant to rescue a machine whose NVENC cannot open was
    // itself guaranteed to fail on the headless capture path. Ask for 4:2:0
    // explicitly instead of relying on ffmpeg to negotiate it.
    "-pix_fmt", "yuv420p",
    "-profile:v", "high",
    "-level:v", "5.1",
    "-bf", "0",
    "-forced-idr", "1",
    "-b:v", p.bitrate,
    "-maxrate", p.bitrate,
    "-bufsize", p.bufsize,
    "-g", String(p.fps),
  ],
};

// Order matters: hardware encoders first (they leave the CPU free), software
// last as the thing that cannot fail.
const ENCODER_ORDER = ["h264_nvenc", "h264_qsv", "h264_amf", "libx264"];

// Only NVENC can encode straight out of GPU memory. QSV, AMF and x264 all need
// system memory, so those paths must always hwdownload (see videoArgs).
function encoderReadsGpuFrames(enc) { return enc === "h264_nvenc"; }

// The pixel format each encoder is fed. nv12 is the same 4:2:0 layout as
// yuv420p in memory, but ffmpeg treats them as distinct formats and libx264
// only accepts yuv420p by that name.
function encoderPixFmt(enc) { return encoderReadsGpuFrames(enc) ? "nv12" : "yuv420p"; }

// A stand-in preset for probing: the options only need to be accepted by the
  // encoder, not produce a sensible picture.
const PROBE_PRESET = { fps: 30, bitrate: "4M", bufsize: "2M" };

// The probe's source MUST be full-size. Probing at 128x128 looks like a cheap
// way to test quickly, and it is actively harmful: NVENC rejects frames below
// a minimum dimension with "Frame Dimension less than the minimum supported
// value", so a small probe reports a working NVENC as broken and silently
// demotes a perfectly good RTX card to software encoding. 1920x1080 is what
// actually gets encoded in practice, so it is what gets tested.
const PROBE_SIZE = "1920x1080";

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

    return { problems, warns, info: "encoder: " + this.pickEncoder() };
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

  // Which encoder can ACTUALLY open here. Probed once, then cached, because
  // the answer cannot change while the agent runs and because a wrong choice
  // is a total failure rather than a slow one.
  //
  // The probe encodes a couple of frames of a synthetic 128x128 clip. That is
  // what catches the driver-too-old case, since the NVENC error appears when
  // the encoder opens, before any real capture happens.
  pickEncoder() {
    if (this._encoder) return this._encoder;

    const forced = String(process.env.ENCODER || "").trim().toLowerCase();
    if (forced && ENCODER_OPTS[forced]) {
      this._encoder = forced;
      return forced;
    }

    const ff = binaries.findBinary("ffmpeg");
    // Without ffmpeg there is nothing to probe, and binaries.js/preflight
    // will report that properly. Assume x264 so the argv is still valid.
    if (!ff) { this._encoder = "libx264"; return this._encoder; }

    for (const enc of ENCODER_ORDER) {
      let args;
      try {
        args = ["-hide_banner", "-loglevel", "error",
          "-f", "lavfi", "-i", `color=c=black:s=${PROBE_SIZE}:r=30:d=0.2`,
          ...ENCODER_OPTS[enc](PROBE_PRESET),
          "-frames:v", "2", "-f", "null", "-"];
      } catch (_) { continue; }

      try {
        require("child_process").execFileSync(ff, args,
          { timeout: 25000, stdio: ["ignore", "ignore", "ignore"] });
        if (enc !== ENCODER_ORDER[0] && !this._warnedEncoder) {
          this._warnedEncoder = true;
          console.error(
            `\n[encode] Using ${enc} instead of NVENC.\n` +
            "          This PC has an NVIDIA GPU, but its driver is too old for the\n" +
            "          installed ffmpeg to use it (ffmpeg 7 needs driver 560+, ffmpeg 9\n" +
            "          needs 610+). This is not a fault with your PC -- updating the\n" +
            "          NVIDIA driver would let it use NVENC again, which is faster.\n"
          );
        }
        this._encoder = enc;
        return enc;
      } catch (_) { /* try the next one */ }
    }

    // Nothing opened. x264 is the best guess, and the spawn error handler will
    // say so plainly rather than looping.
    this._encoder = "libx264";
    return this._encoder;
  },

  // Forget the probed encoder so the next capture re-probes.
  //
  // The startup probe and the real pipeline are close but not identical: the
  // probe encodes from a synthetic lavfi source, production encodes from
  // gdigrab or gfxcapture. So it is possible for an encoder to open in the
  // probe and still fail for real. When that happens the agent asks for this,
  // and the next start re-probes from scratch -- which may well land on a
  // different encoder.
  //
  // _warnedEncoder is deliberately NOT cleared, so the "using x instead of
  // NVENC" explanation is printed once per run, not once per retry.
  resetEncoder() {
    this._encoder = undefined;
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

      ...ENCODER_OPTS[this.pickEncoder()](preset),

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

    const enc = this.pickEncoder();

    // ---- If the encoder cannot read GPU frames, do not use GPU capture ----
    //
    // gfxcapture produces D3D11 frames. To hand those to a non-NVENC encoder the
    // frame has to be downloaded with hwdownload, and that path is fragile: on a
    // real user machine the graph set up, ffmpeg ran, and produced NOTHING --
    // the stream mapping degraded to "format:default" instead of
    // "gfxcapture:default", so the watchdog killed a capture that had already
    // been starved. It worked on the machine it was written on, which is exactly
    // why it survived being shipped.
    //
    // But note what that download would buy: nothing. Once a frame is in system
    // memory, the GPU-capture advantage is already gone -- every frame still
    // crosses the bus, and the encoder is now doing the work on the CPU anyway.
    // So when the encoder is not NVENC, capture with gdigrab instead: it is
    // plain GDI, needs no D3D11 device, no hwdownload, and no filter graph at
    // all. It is the same path headless machines already use successfully.
    if (!encoderReadsGpuFrames(enc) && forced !== "d3d11") {
      if (!this._warnedSoftwareCapture) {
        this._warnedSoftwareCapture = true;
        console.error(
          `\n[capture] Using gdigrab capture because ${enc} cannot encode GPU frames directly.\n` +
          "           Windows Graphics Capture would have to download every frame to\n" +
          "           system memory anyway, so there is nothing to gain from it, and the\n" +
          "           download path has been seen to produce no frames at all.\n" +
          "           Updating the NVIDIA driver will bring back the fast GPU path.\n"
        );
      }
      return this.headlessArgs(preset);
    }

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

    const downscaling = (preset.w !== ctx.nativeW || preset.h !== ctx.nativeH);
    const needsSystemMemory = downscaling;

    return [
      "-init_hw_device", "d3d11va",

      "-filter_complex", `gfxcapture=monitor_idx=0:max_framerate=${preset.fps}:capture_cursor=1` +
        (needsSystemMemory
          ? `,hwdownload,format=bgra` +
            (downscaling ? `,scale=${preset.w}:${preset.h}` : "") +
            `,format=nv12`
          : ""),

      ...ENCODER_OPTS[enc](preset),

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
  deps: ["Node.js 18+", "FFmpeg built with gfxcapture", "A video encoder (NVENC, QSV, AMF or x264)"],

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
