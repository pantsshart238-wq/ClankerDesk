// Does the extracted Windows path still produce exactly the old argv?
// If someone edits agent.js's original block or platform-windows.js and not
// the other, this fails -- which is the point.
const pw = require("./platform-windows");

const WIDTH = 1920, HEIGHT = 1080;   // stand-ins; only ever compared for equality
const PRESETS = {
  "1080p60": { w: 1920, h: 1080, fps: 60, bitrate: "10M", bufsize: "5M" },
  "720p60":  { w: 1280, h: 720,  fps: 60, bitrate: "4M",  bufsize: "3M" },
  "1080p30": { w: 1920, h: 1080, fps: 30, bitrate: "8M",  bufsize: "3M" },
};

// Copied verbatim from agent.js's ORIGINAL hardcoded array (pre-extraction).
function original(preset, ctxW, ctxH) {
  return [
    "-init_hw_device", "d3d11va",
    "-filter_complex", `gfxcapture=monitor_idx=0:max_framerate=${preset.fps}:capture_cursor=1` +
      (preset.w !== ctxW || preset.h !== ctxH
        ? `,hwdownload,format=bgra,scale=${preset.w}:${preset.h},format=nv12`
        : ""),
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
}

let failures = 0;
for (const [key, preset] of Object.entries(PRESETS)) {
  for (const [label, w, h] of [["native", WIDTH, HEIGHT], ["other-native", 2560, 1440]]) {
    const a = original(preset, w, h);
    const b = pw.videoArgs(preset, { nativeW: w, nativeH: h });
    const same = a.length === b.length && a.every((v, i) => v === b[i]);
    if (!same) {
      failures++;
      console.log(`FAIL ${key} @${label}`);
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) console.log(`   [${i}] old=${JSON.stringify(a[i])}  new=${JSON.stringify(b[i])}`);
      }
    } else {
      console.log(`ok   ${key} @${label}  (${a.length} args identical)`);
    }
  }
}
console.log(failures ? `\n${failures} MISMATCH(ES)` : "\nWindows argv unchanged.");
process.exit(failures ? 1 : 0);
