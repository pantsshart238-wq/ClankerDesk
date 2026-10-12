// ---------------------------------------------------------------------------
// Windows: gfxcapture + NVENC + WASAPI loopback
// ---------------------------------------------------------------------------
// This file is a faithful EXTRACTION of what used to be inline in agent.js.
// Do not "improve" it -- any change here changes the working Windows build.
// The self-test compares its output against the recorded original, so an
// accidental edit fails loudly rather than shipping a subtle regression.

module.exports = {
  name: "Windows",

  // ---- Video ---------------------------------------------------------------
  // `preset` is one of the QUALITY_PRESETS entries; `ctx.nativeW/nativeH` are
  // this PC's real screen size, used to decide whether the preset downscales.
  videoArgs(preset, ctx) {
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
