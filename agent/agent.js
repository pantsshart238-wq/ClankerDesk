// Windows agent: captures the desktop with FFmpeg + NVENC, parses the raw H264
// Annex-B stream into access units, and streams them to the Cloudflare relay
// over a WebSocket. Also receives JSON input events from the relay and pipes
// them into input-helper.ps1, which actually moves the mouse / types keys.
//
// Requires: Node.js v24.20.0, `npm install ws`, FFmpeg 9.0.1 on PATH with
// NVENC support (h264_nvenc), an NVIDIA GPU (RTX 3060 Ti here).
//
// Run with:  node agent.js
// Configure RELAY_URL / RELAY_TOKEN below or via environment variables.

"use strict";

const { spawn } = require("child_process");
const { PassThrough } = require("stream");
const path = require("path");
const http = require("http");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const WebSocket = require("ws");

// ---------------------------------------------------------------------------
// config.json (project root) -- your settings, read automatically on startup.
// Just double-click Start-Agent.bat; no other program or web page is involved.
// Environment variables (if you set any) still override this file.
// Lines starting with // are allowed, so you can leave yourself notes.
// ---------------------------------------------------------------------------

try {
  const cfgPath = path.join(__dirname, "..", "config.json");
  if (fs.existsSync(cfgPath)) {
    // Strip a UTF-8 BOM first: Windows editors and PowerShell's UTF8 writes
    // often leave one, and JSON.parse rejects it ("Unexpected token ''").
    let raw = fs.readFileSync(cfgPath, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const text = raw.replace(/^\s*\/\/.*$/gm, "");
    const cfg = JSON.parse(text);
    const toEnv = {
      relayUrl: "RELAY_URL",
      relayToken: "RELAY_TOKEN",
      useRelay: "USE_RELAY",
      publicLink: "PUBLIC_LINK",
      viewerPort: "VIEWER_PORT",
      openViewer: "OPEN_VIEWER",
      allowEmbed: "ALLOW_EMBED",
      audioDevice: "AUDIO_DEVICE",
      micDevice: "MIC_DEVICE",
      quality: "QUALITY",
      deviceName: "DEVICE_NAME",
    };
    const applied = [];
    for (const [key, envName] of Object.entries(toEnv)) {
      const v = cfg[key];
      if (v === undefined || v === null || v === "") continue;
      if (process.env[envName] !== undefined) continue; // explicit env var wins
      process.env[envName] = typeof v === "boolean" ? (v ? "1" : "0") : String(v);
      applied.push(key);
    }
    if (applied.length) console.log("[config] loaded config.json (" + applied.join(", ") + ")");
  }
} catch (e) {
  console.warn("[config] config.json could not be read: " + e.message);
}

// node-interception talks to the "Interception" kernel driver, which presents
// a virtual mouse/keyboard that games see as real hardware. This is required
// for clicks/movement to register in games that read raw/exclusive input
// (they ignore synthetic input injected via mouse_event/SendInput, which is
// what input-helper.ps1 uses -- that path still works fine for the desktop,
// browsers, and most regular apps).
//
// One-time setup on this PC before this will work:
//   npm.cmd install node-interception
//   (in an Administrator prompt) npx node-interception /install
//   restart the PC
let Interception = null;
try {
  ({ Interception } = require("node-interception"));
} catch (e) {
  console.error("[interception] node-interception not installed; game clicks/relative-move will fall back to PowerShell (works for desktop/browser, not most games). Run: npm.cmd install node-interception");
}

const RELAY_URL = process.env.RELAY_URL || "wss://your-worker.workers.dev/ws";
// Fixed token: same every run, so saved viewer logins keep working.
// `let` because provisionAccount() fills it in when the person signs up at
// startup (see below) -- without that they'd still be pasting it by hand.
let RELAY_TOKEN = process.env.RELAY_TOKEN || "1121872352324532328832365433425382714678327459832756445237454";
// The relay is optional: set USE_RELAY=0 to use only the direct/public link.
const USE_RELAY = process.env.USE_RELAY !== "0" && !RELAY_URL.includes("your-worker");
// Direct viewers (and the public link) are only allowed with a strong token.
let DIRECT_OK = RELAY_TOKEN !== "CHANGE_ME" && RELAY_TOKEN.length >= 16;

// ---------------------------------------------------------------------------
// Account setup: type a username and password, get linked -- no Notepad.
//
// The relay's /api/signup and /api/login both hand back the account's private
// key, which is the one thing that used to have to be copy-pasted out of the
// website and typed into config.json by hand. Doing it here means a fresh
// install is: run it, type a username and a password, done.
// ---------------------------------------------------------------------------

function relayApiBase() {
  return RELAY_URL.replace(/^wss:/, "https:").replace(/\/ws\/?$/, "").replace(/\/+$/, "");
}

function promptLine(question) {
  return new Promise((resolve) => {
    const rl = require("readline").createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
  });
}

// Passwords never echo, and never get logged or written anywhere but the
// request body.
function promptHidden(question) {
  const ENTER = 10, CR = 13, BACKSPACE = 8, CTRL_D = 4;
  return new Promise((resolve) => {
    const input = process.stdin;
    const output = process.stdout;
    output.write(question);
    let typed = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      input.removeListener("data", onData);
      if (input.setRawMode) input.setRawMode(false);
      output.write("\n");
      resolve(typed);
    };
    function onData(chunk) {
      for (const ch of String(chunk)) {
        const code = ch.charCodeAt(0);
        if (code === ENTER || code === CR || code === CTRL_D) return finish();
        if (code === BACKSPACE) typed = typed.slice(0, -1);
        else if (code >= 32) typed += ch;
      }
    }
    if (input.setRawMode) input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    input.on("data", onData);
    input.on("end", finish);
    input.on("close", finish);
  });
}

// Write the key back into config.json in place, so the // comment notes in
// that file survive (a JSON round-trip would delete every one of them).
function saveRelayTokenToConfig(token) {
  try {
    const p = path.join(__dirname, "..", "config.json");
    const raw = fs.readFileSync(p, "utf8");
    const next = raw.replace(/("relayToken"\s*:\s*)"[^"]*"/, '$1' + JSON.stringify(token));
    if (next !== raw) fs.writeFileSync(p, next);
  } catch (e) {
    console.warn("[setup] could not save the key to config.json (" + e.message + ")");
  }
}

async function provisionAccount() {
  console.error("");
  console.error("  ============== SET THIS PC UP ==============");
  console.error("");
  console.error("  Make an account for yourself on this relay. One username");
  console.error("  and one password -- that is the whole setup.");
  console.error("");
  console.error("  Already made one? Log in with the same details instead.");
  console.error("");

  const user = await promptLine("  Username: ");
  if (!user) {
    console.error("  No username given -- nothing was changed.");
    return false;
  }
  if (!/^[a-z0-9_-]{3,32}$/.test(user.toLowerCase())) {
    console.error("  Usernames are 3-32 characters: letters, numbers, _ or -");
    console.error("  Got: \"" + user + "\"");
    return false;
  }
  const pass = await promptHidden("  Password: ");
  if (!pass) {
    console.error("  No password given -- nothing was changed.");
    return false;
  }
  if (pass.length < 8) {
    console.error("  Passwords need at least 8 characters (that was " + pass.length + ").");
    return false;
  }

  const post = async (p) => {
    try {
      const r = await fetch(relayApiBase() + p, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: user, password: pass }),
      });
      return { status: r.status, json: await r.json().catch(() => ({})) };
    } catch (e) {
      return { status: 0, json: { error: "could not reach " + relayApiBase() } };
    }
  };

  console.error("  Signing up...");
  let res = await post("/api/signup");

  // "already taken" just means this person has an account here: log them in
  // instead of making them dig out which key they pasted last time.
  if (res.status === 409 || /already taken/i.test((res.json && res.json.error) || "")) {
    console.error("  That username exists -- logging in instead...");
    res = await post("/api/login");
  }

  if (!res.json || !res.json.ok || !res.json.token) {
    const why = (res.json && res.json.error) || "unknown error";
    console.error("");
    console.error("  Could not set this PC up: " + why);
    if (/too many signups/i.test(why)) {
      console.error("  (5 signups per hour per network -- wait a bit and try again)");
    }
    console.error("");
    return false;
  }

  RELAY_TOKEN = res.json.token;
  process.env.RELAY_TOKEN = RELAY_TOKEN;
  DIRECT_OK = RELAY_TOKEN.length >= 16;
  saveRelayTokenToConfig(RELAY_TOKEN);

  console.error("");
  console.error("  All set. This PC is linked to your account and the key is");
  console.error("  saved, so you won't be asked again.");
  console.error("");
  return true;
}

// ---------------------------------------------------------------------------
// This PC's identity in the dashboard. Generated once (device.json, next to
// config.json) and reused forever: a device id Cloudflare can recognize, and
// a short PIN YOU share with the people you let onto this PC. The master
// token alone is never enough for someone to watch -- they need this PIN.
// ---------------------------------------------------------------------------

const DEVICE_FILE = path.join(__dirname, "..", "device.json");

function makePin() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no O/0/I/1 -- easy to read out loud
  let s = "";
  for (let i = 0; i < 6; i++) s += alphabet[crypto.randomInt(alphabet.length)];
  return s;
}

function loadDevice() {
  try {
    const d = JSON.parse(fs.readFileSync(DEVICE_FILE, "utf8"));
    if (d && d.deviceId && d.pin) return d;
  } catch (e) { /* first run: fall through and create one */ }
  const dev = { deviceId: "dev-" + crypto.randomBytes(8).toString("hex"), pin: makePin() };
  try { fs.writeFileSync(DEVICE_FILE, JSON.stringify(dev, null, 2) + "\n"); } catch (e) {}
  return dev;
}

const DEVICE = loadDevice();
const DEVICE_NAME = (() => {
  try {
    const fromConfig = process.env.DEVICE_NAME;
    if (fromConfig) return fromConfig;
    return os.hostname() + " (" + os.userInfo().username + ")";
  } catch (e) { return "ClankerDesk PC"; }
})();

function printDeviceBox() {
  console.log("");
  console.log("============================================================");
  console.log('  THIS PC SHOWS UP IN THE DASHBOARD AS:  ' + DEVICE_NAME);
  console.log("");
  console.log('  PEOPLE CONNECT WITH THIS PIN:          ' + DEVICE.pin);
  console.log("");
  console.log("  The ClankerDesk window shows all of this live.");
  const lp = localPageUrl();
  console.log(lp ? "  (also on " + lp + " -> Info)" : "");
  console.log("============================================================");
  console.log("");
}

const WIDTH = 1920;
const HEIGHT = 1080;

// Capture presets. The viewer can switch between them at any time
// ({type:"set_quality"} -> setCaptureQuality() below). 1080p60 is the
// headline default; 720p60 and 1080p30 exist for weak viewers (Chromebooks)
// and tight networks -- a smooth lighter stream beats a freezing sharp one
// every time. "quality": "<key>" in config.json picks the start default.
const QUALITY_PRESETS = {
  "1080p60": { w: WIDTH, h: HEIGHT, fps: 60, bitrate: "10M", bufsize: "5M" },
  "720p60":  { w: 1280, h: 720,  fps: 60, bitrate: "4M",  bufsize: "3M" },
  "1080p30": { w: WIDTH, h: HEIGHT, fps: 30, bitrate: "8M",  bufsize: "3M" },
};
let captureQuality =
  process.env.QUALITY && QUALITY_PRESETS[process.env.QUALITY]
    ? process.env.QUALITY
    : "720p60";
let preset = QUALITY_PRESETS[captureQuality];
// A deliberate quality switch wants a FAST relaunch (~300ms) instead of the
// 2s crash-backoff: flips to true right before the kill; consumed by the
// ffmpeg exit handler below.
let relaunchFast = false;

// ---------------------------------------------------------------------------
// 1. FFmpeg capture + NVENC encode -> raw H264 Annex-B elementary stream on stdout
// ---------------------------------------------------------------------------

function startFfmpeg() {
  const args = [
    // gfxcapture (Windows Graphics Capture) -- the capture method we're keeping.
    // It handles busy 3D scenes without the freezing ddagrab/gdigrab showed.
    "-init_hw_device", "d3d11va",
    // The active quality preset picks the capture framerate and, for the
    // 720p presets, adds a downscale in the same filter chain (so the
    // encoder never sees more pixels than it must).
    //
    // gfxcapture hands back D3D11 (GPU) frames, and the plain `scale` filter
    // cannot read that format -- it aborts the whole graph with "Error
    // configuring filter graph: Function not implemented", so ffmpeg died
    // instantly and 720p never produced a picture. The downscale therefore
    // downloads to system memory first (bgra), scales there, and converts to
    // the nv12 NVENC wants. Presets that don't downscale keep the original
    // untouched GPU path.
    "-filter_complex", `gfxcapture=monitor_idx=0:max_framerate=${preset.fps}:capture_cursor=1` +
      (preset.w !== WIDTH || preset.h !== HEIGHT
        ? `,hwdownload,format=bgra,scale=${preset.w}:${preset.h},format=nv12`
        : ""),

    "-c:v", "h264_nvenc",
    "-preset", "p1",           // reverted from p4 back to p1 -- p1 is the most
                               // consistent/lowest-latency preset with the least
                               // per-frame timing variance; prioritizing "never
                               // laggy" over "slightly sharper text" right now
    "-tune", "ull",            // zero lookahead/buffering
    "-slices", "1",           // force exactly one slice per frame -- the AnnexBFrameParser
                               // below assumes this to find frame boundaries; without it, a
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
                               // client freezes before it is live again. (This was
                               // widened to 10s once to smooth periodic bitrate
                               // spikes; CBR absorbs a 1/s IDR fine, and a delay
                               // that grows forever is far worse than a
                               // once-a-second size bump.)
    "-profile:v", "high",
    "-level:v", "5.1",
    "-bf", "0",                // no B-frames: keeps decode order == display order, simplifies timestamps
    "-forced-idr", "1",

    "-f", "h264",
    "pipe:1",
  ];

  console.log("Starting ffmpeg:", "ffmpeg", args.join(" "));
  const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

  // stderr is captured (not silenced or inherited): we filter out ffmpeg's
  // constant \r progress spam so it doesn't bury the input-event debug logs,
  // but still surface real errors immediately, plus keep a rolling tail to
  // dump if ffmpeg exits unexpectedly (very useful for ddagrab failures,
  // which are new/less battle-tested than gdigrab was).
  let stderrTail = "";
  proc.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderrTail = (stderrTail + text).slice(-4000);
    // TEMP DIAGNOSTIC: print every non-progress line raw, since gfxcapture's
    // failure wording is unknown and might not match /error|invalid|failed/.
    // A normal progress line looks like "frame=  30 fps=... "; anything else
    // is worth seeing in full while we track this down.
    if (!/^frame=\s*\d/.test(text.trim())) console.error("[ffmpeg:raw]", text);
  });

  proc.on("exit", (code, sig) => {
    console.error(`ffmpeg exited (code=${code}, signal=${sig})` + (captureWanted ? "; restarting" : "; capture is idle"));
    if (code !== 0) console.error("[ffmpeg] output before exit:\n" + stderrTail);
    // BUGFIX: this used to call setTimeout(startFfmpeg, 2000) directly, which
    // spawned a replacement process but never reassigned currentFfmpeg or
    // rewired its stdout to the parser -- so every restart after the first
    // (whether from a natural crash or the watchdog) silently broke video
    // permanently. Going through launchFfmpeg() fixes that for every restart path.
    const delay = relaunchFast ? 300 : 10000; // quality switches relaunch fast;
    // 10s normal delay gives D3D11 resources ample time to fully release/reacquire
    // between gfxcapture format negotiation cycles; the original code succeeded
    // with patient waits on identical hardware/ffmpeg versions.
    relaunchFast = false;
    if (captureWanted) setTimeout(launchFfmpeg, delay);
  });
  return proc;
}

// Switch capture to another QUALITY_PRESETS entry at runtime -- the viewer's
// 🎞️ quality button sends {type:"set_quality"}. If capture is running, the
// ffmpeg exit handler above relaunches it ~300ms later through
// launchFfmpeg() with the new preset (the same path restart_capture uses, so
// no restart races). When capture is idle (watchdog between viewers) the
// choice is stored and applies on the next start. Unknown keys are refused
// here too -- this only picks stream size/fps, never touches input.
function setCaptureQuality(q) {
  const key = typeof q === "string" ? q.trim() : "";
  if (!QUALITY_PRESETS[key]) { console.error("[quality] ignored unknown quality:", q); return; }
  if (key === captureQuality) { console.log("[quality] already at " + key); return; }
  captureQuality = key;
  preset = QUALITY_PRESETS[key];
  console.log(`[quality] switching to ${key} (${preset.w}x${preset.h} @ ${preset.fps} fps, ${preset.bitrate} CBR)`);
  if (captureWanted) {
    relaunchFast = true;
    try { if (currentFfmpeg) currentFfmpeg.kill("SIGKILL"); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// 2. Annex-B parser: turns the continuous ffmpeg byte stream into discrete
//    access units (one per video frame), each tagged as keyframe or delta.
//
//    Assumption: ffmpeg emits one slice per frame (default NVENC behaviour at
//    these settings), so "a slice NAL ends the access unit" is a valid frame
//    boundary. If you enable multi-slice encoding this parser needs to be
//    smarter about detecting new-frame slice headers.
// ---------------------------------------------------------------------------

class AnnexBFrameParser {
  constructor(onAccessUnit) {
    this.onAccessUnit = onAccessUnit;
    this.buffer = Buffer.alloc(0);
    this.pendingNals = []; // NALs (e.g. SPS/PPS) waiting to be attached to the next slice
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    this._extractNals();
  }

  _findStartCodes(buf) {
    // Returns [{ start, codeLen }] for every 00 00 01 / 00 00 00 01 start code.
    const positions = [];
    for (let i = 0; i + 2 < buf.length; i++) {
      if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
        const codeLen = (i > 0 && buf[i - 1] === 0) ? 4 : 3;
        positions.push({ start: i - (codeLen - 3), codeLen });
      }
    }
    return positions;
  }

  _extractNals() {
    const starts = this._findStartCodes(this.buffer);
    if (starts.length < 2) return; // need at least two start codes to know one full NAL is complete

    // Keep the tail after the last start code in the buffer (it may be an incomplete NAL).
    for (let i = 0; i < starts.length - 1; i++) {
      const { start, codeLen } = starts[i];
      const nalStart = start + codeLen;
      const nalEnd = starts[i + 1].start;
      const nal = this.buffer.subarray(nalStart, nalEnd);
      this._handleNal(nal);
    }
    this.buffer = this.buffer.subarray(starts[starts.length - 1].start);
  }

  _handleNal(nal) {
    if (nal.length === 0) return;
    const nalType = nal[0] & 0x1f;

    if (nalType === 7 || nalType === 8) {
      // SPS / PPS: buffer it, it'll be prepended to the next slice's access unit.
      this.pendingNals.push(nal);
      return;
    }

    if (nalType === 1 || nalType === 5) {
      // Non-IDR / IDR slice: this completes an access unit.
      const isKey = nalType === 5;
      const nals = [...this.pendingNals, nal];
      this.pendingNals = [];
      this.onAccessUnit(nals, isKey);
      return;
    }

    // SEI and other NAL types: attach to whatever comes next too.
    this.pendingNals.push(nal);
  }
}

function encodeAccessUnit(nals) {
  // Re-attach 4-byte Annex-B start codes so the browser decoder sees a
  // standard Annex-B access unit.
  const startCode = Buffer.from([0, 0, 0, 1]);
  return Buffer.concat(nals.flatMap((n) => [startCode, n]));
}

// ---------------------------------------------------------------------------
// 2b. Audio: a fully separate FFmpeg process capturing system audio via
// VB-CABLE and encoding it to low-latency Opus. Completely independent of
// the video pipeline above -- if this fails to start (e.g. VB-CABLE isn't
// set up), video and input keep working exactly as before.
//
// One-time setup: install VB-CABLE (you already have it), then in Windows
// Sound settings set "CABLE Input (VB-Audio Virtual Cable)" as your default
// playback device (or route specific apps/games to it) so system audio
// flows into VB-CABLE, where this ffmpeg process picks it up as "CABLE
// Output (VB-Audio Virtual Cable)".
// ---------------------------------------------------------------------------

// Which sound source to stream to viewers. "" (default) = WASAPI loopback:
// capture whatever this PC plays on its default output -- works with zero
// setup on any Windows 10+ machine, no virtual cable required. Set to a
// dshow capture device name (e.g. "CABLE Output (VB-Audio Virtual Cable)")
// for the old explicit-capture mode.
const AUDIO_DEVICE = process.env.AUDIO_DEVICE || "";
// True = the sound stream is a WASAPI loopback of whatever the PC plays
// (the helper is present and no explicit capture device is configured).
// One predicate, used by both the audio pipeline and the mic logic.
function isLoopbackAudio() {
  return !AUDIO_DEVICE && fs.existsSync(path.join(__dirname, "audio-helper.ps1"));
}
// Last output device that actually carried real audio (the helper announces
// it as "listening to '<name>'"). The helper's device walk can take ~2s per
// silent device, so the cache jumps straight to the known-good one on the
// next audio session; any miss (gone/silent) falls back to the full walk.
let loopbackDeviceCache = null;

// Minimal Ogg page parser: ffmpeg's Opus encoder always outputs Ogg-wrapped
// Opus (that's the standard container for it), so we parse just enough Ogg
// framing to pull out individual raw Opus packets, which is what we send to
// the browser (WebCodecs' Opus AudioDecoder wants raw packets, no container).
class OggPacketParser {
  constructor(onPacket, onHeader) {
    this.onPacket = onPacket;
    this.onHeader = onHeader; // called once with the raw OpusHead bytes
    this.buffer = Buffer.alloc(0);
    this.pendingPacket = Buffer.alloc(0);
    // Ogg-Opus always starts with exactly 2 header packets before any actual
    // audio data, per RFC 7845: packet 0 is OpusHead (identification --
    // channel count, sample rate, pre-skip, gain), packet 1 is OpusTags
    // (comment metadata, safe to discard). Browsers' Opus decoders expect
    // OpusHead's bytes as the decoder "description" to configure correctly --
    // passing it through via onHeader instead of just discarding it.
    this.headerPacketsSeen = 0;
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    this._extractPages();
  }

  _extractPages() {
    while (true) {
      const start = this.buffer.indexOf("OggS");
      if (start === -1 || this.buffer.length - start < 27) return;
      if (start > 0) this.buffer = this.buffer.subarray(start);

      const headerType = this.buffer[5];
      const pageSegments = this.buffer[26];
      if (this.buffer.length < 27 + pageSegments) return;

      const segmentTable = this.buffer.subarray(27, 27 + pageSegments);
      let bodyLen = 0;
      for (const s of segmentTable) bodyLen += s;
      const bodyStart = 27 + pageSegments;
      if (this.buffer.length < bodyStart + bodyLen) return;

      let offset = bodyStart;
      let i = 0;
      while (i < segmentTable.length) {
        let packetLen = 0;
        while (i < segmentTable.length && segmentTable[i] === 255) {
          packetLen += segmentTable[i];
          i++;
        }
        if (i < segmentTable.length) {
          packetLen += segmentTable[i];
          i++;
        }
        const packetBytes = this.buffer.subarray(offset, offset + packetLen);
        offset += packetLen;

        const continued = (headerType & 0x01) !== 0 && this.pendingPacket.length > 0;
        this.pendingPacket = continued ? Buffer.concat([this.pendingPacket, packetBytes]) : Buffer.from(packetBytes);

        const isLastSegmentOfTable = i === segmentTable.length;
        const lastSegmentWas255 = segmentTable[i - 1] === 255;
        if (!(isLastSegmentOfTable && lastSegmentWas255)) {
          if (this.pendingPacket.length > 0) {
            if (this.headerPacketsSeen === 0) {
              this.onHeader(this.pendingPacket);
              this.headerPacketsSeen = 1;
            } else if (this.headerPacketsSeen === 1) {
              this.headerPacketsSeen = 2;
            } else {
              this.onPacket(this.pendingPacket);
            }
          }
          this.pendingPacket = Buffer.alloc(0);
        }
      }

      this.buffer = this.buffer.subarray(bodyStart + bodyLen);
    }
  }
}

function startFfmpegAudio() {
  const helper = path.join(__dirname, "audio-helper.ps1");
  // audioDevice empty (the default) = WASAPI loopback: audio-helper.ps1
  // listens to whatever the PC plays and streams raw PCM to us -- no
  // VB-CABLE, no Stereo Mix, nothing to install. A set audioDevice keeps
  // the old explicit dshow capture device.
  const loopback = isLoopbackAudio();
  const inputArgs = loopback
    ? ["-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "pipe:0"]
    : ["-f", "dshow", "-audio_buffer_size", "20", "-use_wallclock_as_timestamps", "1",
       "-i", `audio=${AUDIO_DEVICE || "CABLE Output (VB-Audio Virtual Cable)"}`];
  const args = [
    ...inputArgs,
    "-af", "aresample=async=1000",
    "-c:a", "libopus",
    "-b:a", "96k",
    "-application", "lowdelay",
    "-frame_duration", "10",
    "-vn",
    "-flush_packets", "1",
    "-page_duration", "10000",
    "-f", "ogg",
    "pipe:1",
  ];

  // Loopback specifics: the helper's device walk writes NOTHING to stdout
  // until it commits to a device ("listening to '<name>'"). ffmpeg is
  // spawned only THEN -- an ffmpeg waiting on an empty pipe would exit
  // ("output file is empty") and relaunch the WHOLE pipeline mid-walk,
  // stacking parallel walks. Before commit the helper is the only process
  // alive, so a viewer leaving mid-walk just kills it.
  let helperProc = null;
  let ffmpegProc = null;
  let dead = false;
  const controller = {
    exitCode: null,
    signalCode: null,
    stdout: new PassThrough(),
    kill(sig) {
      dead = true;
      try { if (helperProc) helperProc.kill("SIGKILL"); } catch (_) {}
      try { if (ffmpegProc) ffmpegProc.kill(sig || "SIGKILL"); } catch (_) {}
    },
  };

  const startFfmpeg = () => {
    if (ffmpegProc || dead) return;
    console.log("Starting audio ffmpeg:", "ffmpeg", args.join(" ") + (loopback ? "   [WASAPI loopback via audio-helper.ps1]" : ""));
    ffmpegProc = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    if (helperProc && ffmpegProc.stdin) {
      helperProc.stdout.pipe(ffmpegProc.stdin);
      ffmpegProc.stdin.on("error", () => {}); // EPIPE when ffmpeg dies first
    }
    ffmpegProc.stdout.on("data", (chunk) => controller.stdout.write(chunk));

    let stderrTail = "";
    ffmpegProc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-4000);
      if (!/^size=\s*\d/.test(text.trim())) console.error("[ffmpeg-audio:raw]", text);
    });

    ffmpegProc.on("exit", (code, sig) => {
      // The loopback listener must die with its ffmpeg (kill/restart paths
      // all come through here); a fresh one is spawned on relaunch.
      try { if (helperProc) helperProc.kill("SIGKILL"); } catch (_) {}
      controller.exitCode = code;
      controller.signalCode = sig;
      console.error(`audio ffmpeg exited (code=${code}, signal=${sig}); restarting in 2s`);
      if (code !== 0) console.error("[ffmpeg-audio] output before exit:\n" + stderrTail);
      if (audioWanted) setTimeout(launchFfmpegAudio, 2000);
    });
  };

  if (loopback) {
    helperProc = spawn("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass",
      "-File", helper, "-LoopbackMode", "-LoopbackDevice", loopbackDeviceCache || AUDIO_DEVICE,
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    helperProc.stdout.on("error", () => {}); // EPIPE if ffmpeg exits first
    helperProc.stderr.on("data", (chunk) => {
      String(chunk).split("\n").forEach((line) => {
        const s = line.trim();
        if (!s) return;
        const m = s.match(/\[loopback\] listening to '(.+?)'/);
        if (m) {
          loopbackDeviceCache = m[1]; // straight-line the next audio session
          console.error("[loopback] sound source: " + m[1]);
          startFfmpeg(); // the walk found carrying audio -- encode it
          return;
        }
        console.error("[loopback] " + s);
      });
    });
    helperProc.on("error", (e) => {
      console.error("[loopback] helper failed to start:", e.message);
      controller.exitCode = -1;
    });
    helperProc.on("exit", (code) => {
      if (!ffmpegProc) {
        // Died before committing (every device refused/stayed silent, or
        // PowerShell itself failed). Mark dead so the guard lets a retry
        // through; a longer delay than the normal 2s keeps a pathological
        // host from spinning.
        controller.exitCode = code === null ? -1 : code;
        if (audioWanted && !dead) {
          console.error("[loopback] listener gave up (code=" + code + "); retrying in 5s");
          setTimeout(launchFfmpegAudio, 5000);
        }
        return;
      }
      if (audioWanted && code !== null && code !== 0) {
        console.error("[loopback] listener exited (code=" + code + "); audio restarts shortly");
      }
    });
    return controller;
  }

  console.log("Starting audio ffmpeg:", "ffmpeg", args.join(" "));
  const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderrTail = "";
  proc.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderrTail = (stderrTail + text).slice(-4000);
    if (!/^size=\s*\d/.test(text.trim())) console.error("[ffmpeg-audio:raw]", text);
  });
  proc.on("exit", (code, sig) => {
    console.error(`audio ffmpeg exited (code=${code}, signal=${sig}); restarting in 2s`);
    if (code !== 0) console.error("[ffmpeg-audio] output before exit:\n" + stderrTail);
    if (audioWanted) setTimeout(launchFfmpegAudio, 2000);
  });
  return proc;
}

let currentFfmpegAudio = null;

function launchFfmpegAudio() {
  if (currentFfmpegAudio && currentFfmpegAudio.exitCode === null && currentFfmpegAudio.signalCode === null) return; // already running
  const audioParser = new OggPacketParser(
    (packet) => sendAudioPacket(packet),
    (headerBytes) => sendAudioConfig(headerBytes)
  );
  currentFfmpegAudio = startFfmpegAudio();
  currentFfmpegAudio.stdout.on("data", (chunk) => audioParser.push(chunk));
}

// ---------------------------------------------------------------------------
// 2c. MICROPHONE (viewer -> host): the viewer page captures ITS microphone and
// sends raw PCM chunks here; ffplay plays them into this PC's DEFAULT output
// device, so any app (Discord, game voice chat...) can hear the remote person
// as if they were sitting at this machine.
//
// Why ffplay and not ffmpeg: this ffmpeg build has no dshow OUTPUT support
// (it can capture from devices but never write to them). ffplay renders
// through SDL straight to the Windows default playback device, which -- per
// the setup this project already uses for audio capture -- is "CABLE Input
// (VB-Audio Virtual Cable)". That means:
//   viewer mic -> default device (CABLE Input) -> CABLE Output
//   -> picked up by the system-audio capture AND by any app whose microphone
//      is set to "CABLE Output".
// One-time setup on the host: keep CABLE Input as the default playback
// device, and set the chat/game's microphone input to "CABLE Output".
// ---------------------------------------------------------------------------

const MIC_PCM_TYPE = 0x10; // viewer->agent binary message: [0x10][int16 PCM samples...]
const MIC_ULAW_TYPE = 0x12; // ...or [0x12][8-bit mu-law samples] at 8000 Hz (light stream)
const MIC_RATE = 48000;    // classic default; the viewer's mic_enable announces
                           // its own rate and the session uses that instead
let micRate = MIC_RATE;    // sample rate of the CURRENT mic session's PCM
let micCodec = "pcm";      // "pcm" (s16le) | "ulaw8" (mu-law @ 8 kHz, the light stream)

// 16-bit PCM -> G.711 mu-law, used for the probe tone on light-stream
// sessions (same math the viewer uses).
function pcmToUlaw(v) {
  let p = v >> 2;
  const mask = p < 0 ? (p = -p, 0x7f) : 0xff;
  if (p > 8159) p = 8159;
  p += 33;
  let t = p >> 5, seg = 0;
  while (t > 1) { t >>= 1; seg++; }
  return (((seg << 4) | ((p >> (seg + 1)) & 0xf)) ^ mask) & 0xff;
}

let micWanted = false;
let micFfmpeg = null;
let micStdinBlocked = false;
// The relay tags every viewer control event with a stable per-socket `vid`
// (see src/index.js). We remember which viewer turned the mic on so that a
// disconnect without a clean mic_disable (closed tab, dropped network) still
// releases the mic instead of leaving it stuck ON forever. First writer wins;
// later talkers are ignored while one is active (single shared playback pipe).
let micActiveVid = null;
// Two-cable setup (optional): when a SECOND VB-CABLE exists (the free A+B
// pack adds "CABLE-A"/"CABLE-B"), the mic rides that cable alone instead of
// the main one. Games hear it on "<cable> Output"; the sound capture (classic
// "CABLE Output") never carries the viewer's voice, so the viewer keeps
// hearing host sound while talking -- and there is no echo to suppress.
// Set "micDevice": "CABLE-B" in config.json to force a specific cable.
let micCable = null;
let micBorrowProc = null;

function onViewerGone(vid) {
  // A viewer vanished. If it was the one holding the mic, release it -- the
  // relay already stopped streaming their voice back to them, but the host
  // playback pipe would otherwise stay open with nobody feeding it.
  if (vid && micActiveVid === vid) disableMic("viewer left", vid);
}

function startMicFfmpeg() {
  const args = [
    "-nodisp", "-autoexit", "-loglevel", "error",
    "-fflags", "+nobuffer", "-flags", "low_delay",
    ...(micCodec === "ulaw8"
      ? ["-f", "mulaw", "-ar", "8000", "-ch_layout", "mono"]
      : ["-f", "s16le", "-ar", String(micRate), "-ch_layout", "mono"]),
    "-i", "pipe:0",
  ];
  console.log(`[mic] starting playback via ffplay at ${micCodec === "ulaw8" ? "8000 Hz (mu-law, light stream)" : micRate + " Hz"}`);
  const proc = spawn("ffplay", args, { stdio: ["pipe", "ignore", "pipe"] });

  let stderrTail = "";
  proc.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderrTail = (stderrTail + text).slice(-3000);
    if (!/^\s*$/.test(text)) console.error("[ffplay-mic:raw]", text.trim());
  });

  proc.on("error", (e) => {
    // e.g. ffplay.exe not on PATH -- the ffmpeg build didn't ship it.
    console.error("[mic] could not start ffplay:", e.message, "-- mic streaming stays off");
    micWanted = false;
  });

  proc.on("exit", (code, sig) => {
    if (micFfmpeg !== proc) return; // an older player we replaced on purpose
    micFfmpeg = null;
    if (!micWanted) return; // stopped on purpose (viewer muted or left)
    console.error(`[mic] ffplay exited (code=${code}, signal=${sig}); retrying in 2s`);
    if (code !== 0 && stderrTail) console.error("[mic] output before exit:\n" + stderrTail);
    const session = micSession;
    setTimeout(() => {
      if (!micWanted || session !== micSession) return;
      if (micCable && micCableState === "borrowing") return; // the probe owns the flow
      // On a two-cable setup the restart must hand the second cable over
      // again first -- by now the default device is the main cable once more.
      if (micCable && micCableState !== "shared") startMicViaCable();
      else startMicFfmpeg();
    }, 2000);
  });

  proc.stdin.on("drain", () => { if (micFfmpeg === proc) micStdinBlocked = false; });
  proc.stdin.on("error", () => {}); // EPIPE after a kill is expected, never crash
  micFfmpeg = proc;
  micStdinBlocked = false;
}

// Tell the relay whether the mic is running on its OWN cable. On a dedicated
// cable the talker's voice never reaches the sound capture, so the relay can
// keep sending them host audio while they talk (no echo). On the shared
// cable the relay withholds the sound stream from whoever is talking.
function tellRelayMicIsolated(on) {
  if (!USE_RELAY) return;
  try {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "mic_audio_isolated", on: !!on }));
    }
  } catch (_) { /* relay not up: the next connect state settles it */ }
}

// ffplay renders through SDL, which only ever opens the Windows DEFAULT
// playback device -- there is no "pick a device" flag. So for the two-cable
// setup we BORROW the default for a moment: audio-helper.ps1 switches it to
// the second cable, we start ffplay, and before handing the default back we
// PROVE the chain end to end: a quiet test tone goes through ffplay while two
// recorders watch the pins -- the second cable's game-mic pin must carry the
// tone (the game will hear the viewer), and the main sound-capture pin must
// stay silent (or the viewer's voice would come back to them = mirror).
// Releasing on a fixed timer without that proof once lost a race: ffplay
// opened late, the mic landed on the main cable, and the Chromebook heard
// itself while the game heard nothing. Nothing is assumed from here on: only
// a passing probe lets the relay treat the mic as isolated.
let micCableState = null;   // null | "borrowing" | "active" | "shared"
let micSession = 0;         // bumped per mic session: kills stale probe timers
let micAttempt = 0;         // probes within the current session (one retry)
let micHold = [];           // viewer PCM held while probing, flushed on success
let micHoldBytes = 0;
let probePins = null;       // promise -- the dshow pin names, resolved once

const MIC_PROBE_SECS = 2.5;       // recorder window
const MIC_PROBE_TONE_AT = 350;    // ms after ffplay spawn before the tone
const MIC_PRESENT_DB = -55;       // tone found on the game-mic pin (expect ~-20)
const MIC_LEAK_DB = -75;          // tone bleeding into the capture pin (floor ~-91)
const MIC_HOLD_MAX = 400 * 1024;  // bound on held viewer PCM

function probeToneBuffer() {
  // ~700ms of 440Hz, mono, amplitude 3000 (-20 dBFS): comfortably above the
  // present threshold, only a faint blip in the host's chat/game for the
  // moment the mic opens. Encoded in the session's format so it plays
  // through the same pipe the voice will.
  const rate = micCodec === "ulaw8" ? 8000 : micRate;
  const n = Math.floor(rate * 0.7);
  if (micCodec === "ulaw8") {
    const buf = Buffer.alloc(n);
    for (let i = 0; i < n; i++) {
      buf[i] = pcmToUlaw(Math.round(3000 * Math.sin((2 * Math.PI * 440 * i) / 8000)));
    }
    return buf;
  }
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  }
  return buf;
}

function listDshowCapturePins() {
  // Exact device strings ffmpeg will accept -- dshow prints them itself so
  // we never guess names like "Voicemeeter Out B1 (VB-Audio Voicemeeter VAIO)".
  return new Promise((resolve) => {
    let out = "";
    const p = spawn("ffmpeg", ["-list_devices", "true", "-f", "dshow", "-i", "dummy"],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    p.stderr.on("data", (d) => { out += d; });
    p.on("error", () => resolve([]));
    p.on("close", () => {
      const names = [];
      const re = /"([^"]+)"\s*\(audio\)/g;
      let m;
      while ((m = re.exec(out))) names.push(m[1]);
      resolve(names);
    });
  });
}

function resolveProbePins() {
  // The game-mic pin for this second cable + the main capture pin.
  return listDshowCapturePins().then((pins) => {
    let targetRe;
    if (/^voicemeeter/i.test(micCable || "")) targetRe = /^Voicemeeter (Out B1|Output)\b/i;
    else targetRe = new RegExp("^" + String(micCable).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " Output\\b", "i");
    return {
      target: pins.find((n) => targetRe.test(n)) || null,
      main: pins.find((n) => n === AUDIO_DEVICE) || pins.find((n) => /^CABLE Output\b/i.test(n)) || null,
    };
  });
}

function recordPinPeak(pin, secs) {
  return new Promise((resolve) => {
    const p = spawn("ffmpeg", ["-f", "dshow", "-i", "audio=" + pin, "-t", String(secs),
      "-af", "volumedetect", "-f", "null", "-"],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let err = "";
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", () => resolve(-Infinity));
    p.on("close", () => {
      const m = err.match(/max_volume:\s*(-?[\d.]+)\s*dB/i);
      if (m) { const v = parseFloat(m[1]); return resolve(isNaN(v) ? -Infinity : v); }
      resolve(-Infinity); // no volumedetect line (device busy/absent) = silence
    });
  });
}

function holdMicData(buf) {
  micHold.push(buf);
  micHoldBytes += buf.length;
  while (micHoldBytes > MIC_HOLD_MAX && micHold.length) micHoldBytes -= micHold.shift().length;
}

function flushMicHold() {
  const held = micHold;
  micHold = [];
  micHoldBytes = 0;
  if (!micFfmpeg || micFfmpeg.exitCode !== null) return;
  for (const buf of held) {
    if (micStdinBlocked) break;
    try { micStdinBlocked = !micFfmpeg.stdin.write(buf); } catch (_) { break; }
  }
}

function clearMicHold() { micHold = []; micHoldBytes = 0; }

function startMicViaCable() {
  if (!micCable) return micFailToShared("no second cable configured");
  micCableState = "borrowing";
  const session = micSession;
  const attempt = ++micAttempt;
  const helper = path.join(__dirname, "audio-helper.ps1");
  let settled = false;
  let proc = null;
  let spawned = false;
  let asked = false;

  const stillMine = () => session === micSession && micWanted && !settled;
  const restore = () => { try { if (proc && proc.stdin) proc.stdin.write("\n"); } catch (_) {} };
  const end = (next) => {
    if (settled) return;
    settled = true;
    if (micBorrowProc === proc) micBorrowProc = null;
    restore();
    next();
  };

  const fail = (reason) => end(() => {
    clearMicHold();
    if (spawned && micFfmpeg) {
      try { micFfmpeg.kill("SIGKILL"); } catch (_) {}
      micFfmpeg = null;
    }
    micFailToShared(reason);
  });

  const succeed = (pins) => {
    // Check BEFORE end(): stillMine() includes !settled, and end() flips
    // settled on the way in -- consulting it inside the callback would skip
    // the very lines that turn isolation on (and this must never race a
    // disableMic: session/wanted are re-checked synchronously below).
    if (session !== micSession || !micWanted) return end(() => {});
    end(() => {
      micCableState = "active";
      tellRelayMicIsolated(true);
      console.log(`[mic] confirmed: viewer voice reaches the game on "${pins.target}" and never touches the sound capture -- talking AND hearing host sound, no echo`);
      flushMicHold();
    });
  };

  const evaluate = (pins, targetDb, mainDb) => {
    if (!stillMine()) return end(() => {});
    if (targetDb > MIC_PRESENT_DB && mainDb <= MIC_LEAK_DB) return succeed(pins);
    if (targetDb > MIC_PRESENT_DB && mainDb > MIC_LEAK_DB) {
      // The mic reaches the game, but it ALSO leaks into the sound capture --
      // most likely Voicemeeter's A1 hardware-out button is on. Never claim
      // isolation in that state: withhold sound from the talker instead.
      console.error(`[mic] LEAK: the mic is bleeding into the sound capture (main pin ${mainDb} dB). Turn OFF the A1 button on the Voicemeeter Input strip so the mic only goes to B1.`);
      return end(() => {
        clearMicHold();
        micCableState = "shared";
        tellRelayMicIsolated(false);
        if (micWanted && session === micSession) flushMicHold();
        ensureAudioRouting();
      });
    }
    // Tone never arrived: ffplay opened late, or the device list moved.
    console.error(`[mic] probe ${attempt}: no mic on "${pins.target}" (peak ${targetDb} dB)${attempt < 2 ? " -- retrying" : ""}`);
    if (attempt < 2 && session === micSession && micWanted) {
      end(() => {
        clearMicHold();
        if (micFfmpeg) {
          try { micFfmpeg.kill("SIGKILL"); } catch (_) {}
          micFfmpeg = null; // identity guard: the probe itself restarts ffplay
        }
        // NOT stillMine(): end() already flipped settled -- that would make
        // this condition false and silently kill the retry (dead mic).
        setTimeout(() => { if (session === micSession && micWanted) startMicViaCable(); }, 400);
      });
    } else {
      fail("second cable never carried the mic");
    }
  };

  try {
    proc = spawn("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass",
      "-File", helper, "-Borrow", micCable, "-ReturnTo", "CABLE Input",
    ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    micBorrowProc = proc;

    const onLines = (d, err) => String(d).split("\n").forEach((raw) => {
      const line = raw.trim();
      if (!line) return;
      (err ? console.error : console.log)("[audio] " + line);
      if (asked) return;
      if (/^borrow failed/i.test(line)) { asked = true; fail(line); return; }
      if (/^borrowed$/i.test(line)) { asked = true; runProbe(); }
    });
    if (proc.stdout) proc.stdout.on("data", (d) => onLines(d, false));
    if (proc.stderr) proc.stderr.on("data", (d) => onLines(d, true));
    proc.on("error", (e) => { console.error("[audio] mic cable handoff failed:", e.message); fail("handoff helper could not start"); });
    // 'close' (not 'exit'): stdout may still carry lines after exit -- deciding
    // on 'exit' would race the very verdict we are waiting for.
    proc.on("close", () => {
      if (micBorrowProc === proc) micBorrowProc = null;
      if (!settled && micWanted) fail("handoff helper died");
    });
  } catch (e) {
    console.error("[audio] mic cable handoff failed:", e.message);
    fail("handoff helper could not start");
  }

  async function runProbe() {
    try {
      if (!probePins) probePins = resolveProbePins();
      const pins = await probePins;
      if (!stillMine()) return end(() => {});
      if (!pins.target || !pins.main) {
        return fail(`could not find the mic pins (target=${pins.target}, main=${pins.main})`);
      }
      startMicFfmpeg();          // ffplay opens the borrowed default = second cable
      spawned = true;
      const t = recordPinPeak(pins.target, MIC_PROBE_SECS);
      const m = recordPinPeak(pins.main, MIC_PROBE_SECS);
      setTimeout(() => {
        if (!stillMine() || !micFfmpeg) return;
        try { micFfmpeg.stdin.write(probeToneBuffer()); } catch (_) {}
      }, MIC_PROBE_TONE_AT);
      const [targetDb, mainDb] = await Promise.all([t, m]);
      evaluate(pins, targetDb, mainDb);
    } catch (e) {
      console.error("[mic] probe error:", e.message);
      fail("mic probe errored");
    }
  }
}

function micFailToShared(reason) {
  // The dedicated cable could not be confirmed. NEVER keep the relay in
  // isolated mode while the mic may be riding the shared cable -- that is
  // exactly the configuration that mirrors the talker back at them. Shared
  // mode withholds host sound from the talker instead (sound pauses while
  // they talk): no echo, no mirror, mic always works.
  if (!micWanted) return;
  if (micCableState === "shared") return;
  micCableState = "shared";
  console.error(`[mic] ${reason} -- falling back to the shared cable (host sound pauses while a viewer talks)`);
  tellRelayMicIsolated(false);
  clearMicHold();
  if (micFfmpeg) {
    // Deliberate replacement: null first so the exit handler's identity
    // guard does not race a second restart on top of this one.
    try { micFfmpeg.kill("SIGKILL"); } catch (_) {}
    micFfmpeg = null;
  }
  if (micWanted) {
    try { startMicFfmpeg(); } catch (e) {
      console.error("[mic] start failed:", e.message);
      micWanted = false;
      micActiveVid = null;
    }
  }
  ensureAudioRouting();
}

function releaseMicBorrow() {
  // If the mic was stopped mid-handoff, let the helper switch the default back
  // immediately instead of waiting for its stdin timeout.
  try {
    if (micBorrowProc && micBorrowProc.stdin) micBorrowProc.stdin.write("\n");
  } catch (_) {}
}

function enableMic(vid, rate, codec) {
  // The viewer announces its stream format: the light mu-law stream
  // ("ulaw8", ~8 KB/s) since the minimal-data update, or plain PCM at a
  // stated rate (older pages say nothing at all -- those keep the classic
  // 48000 s16le). Set BEFORE the early return so a re-claim refreshes it.
  micCodec = codec === "ulaw8" ? "ulaw8" : "pcm";
  const r = Math.round(Number(rate));
  micRate = (Number.isFinite(r) && r >= 8000 && r <= 48000) ? r : MIC_RATE;
  // Re-claim under the CURRENT socket id even when the mic is already
  // running: the viewer page re-sends mic_enable after every reconnect (new
  // socket = new vid), and the OLD socket's viewer_gone must not kill the
  // freshly re-claimed mic.
  if (vid) micActiveVid = vid;
  if (micWanted) return;
  micWanted = true;
  micSession++; // any in-flight probe from a previous session goes stale
  console.log("[mic] viewer requested microphone streaming (viewer -> host)");
  const startShared = () => {
    micCableState = "shared";
    tellRelayMicIsolated(false); // shared cable: relay withholds sound from the talker
    try { startMicFfmpeg(); } catch (e) {
      console.error("[mic] start failed:", e.message);
      micWanted = false;
      micActiveVid = null;
    }
  };
  if (isLoopbackAudio()) {
    // The loopback sound capture records the main mix -- and the mic lands
    // in that mix too (ffplay renders to the default device), so a second
    // cable CANNOT keep the talker from hearing themselves here. The shared
    // talk-mute (host sound pauses while talking) is the only setup that
    // can never mirror, so it is always used in loopback mode.
    console.log("[mic] loopback sound capture: using the never-mirror talk-mute (no cable needed)");
    ensureAudioRouting(); // keep the mic on the main mix even if Windows drifted
    startShared();
    return;
  }
  if (micCable) {
    micCableState = "borrowing";
    startMicViaCable();
  } else {
    // No second cable known yet -- maybe the mixer app only came up after
    // the agent started. Look once more before settling for the shared cable.
    detectMicCable(() => {
      if (!micWanted) return;
      if (micCable) startMicViaCable();
      else startShared();
    });
  }
}

function disableMic(reason, vid) {
  // Only the talker who turned it on (or a clean teardown with no vid) may
  // stop it -- otherwise one viewer's mute would cut off another's call.
  if (vid && micActiveVid && vid !== micActiveVid) return;
  if (!micWanted && !micFfmpeg) return;
  micWanted = false;
  micSession++; // stale probe timers/recorders must not fire into the next one
  micActiveVid = null;
  console.log("[mic] stopping microphone streaming" + (reason ? ` (${reason})` : ""));
  try { if (micFfmpeg) micFfmpeg.kill("SIGKILL"); } catch (_) {}
  micFfmpeg = null;
  micCableState = null; // next enable tries the dedicated cable fresh
  micAttempt = 0;
  probePins = null;
  clearMicHold();
  releaseMicBorrow();
  tellRelayMicIsolated(false);
}

// Self-heal the sound routing once at startup. The mic playback and the
// system-audio capture only work when "CABLE Input" is the Windows DEFAULT
// playback device. Windows drifts on its own (monitors, Bluetooth headsets,
// driver updates steal the default), and when it does, the mic blasts out of
// the real speakers and games hear nothing. audio-helper.ps1 checks and
// restores it, logging one line either way.
function ensureAudioRouting() {
  const helper = path.join(__dirname, "audio-helper.ps1");
  if (!fs.existsSync(helper)) return;
  try {
    const proc = spawn("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass",
      "-File", helper, "-EnsureDefaultRender", "CABLE Input",
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const log = (d, err) => {
      String(d).trim().split("\n").forEach((line) => {
        if (!line.trim()) return;
        (err ? console.error : console.log)("[audio] " + line.trim());
      });
    };
    if (proc.stdout) proc.stdout.on("data", (d) => log(d, false));
    if (proc.stderr) proc.stderr.on("data", (d) => log(d, true));
    proc.on("error", (e) => console.error("[audio] routing helper failed:", e.message));
  } catch (e) {
    console.error("[audio] routing helper failed:", e.message);
  }
}

// Look for a SECOND VB-CABLE at startup (see the micCable comment above).
// "micDevice" in config.json (or the MIC_DEVICE env var) forces a choice;
// otherwise the helper scans the playback devices for CABLE-B / CABLE-A.
function detectMicCable(done) {
  // Which device should carry the mic alone? A second VB-CABLE (A+B pack)
  // or the free Voicemeeter virtual cable both work; "micDevice" in
  // config.json (or MIC_DEVICE env) forces a specific playback-device prefix.
  // Also called again when the mic is requested, so a mixer app that came up
  // after the agent start still gets picked up.
  const micInputLabel = (cable) =>
    /^voicemeeter/i.test(cable) ? "Voicemeeter Output" : cable + " Output";
  const finish = () => { if (done) done(!!micCable); };
  const forced = process.env.MIC_DEVICE;
  if (forced) {
    micCable = forced;
    console.log(`[mic] micDevice="${forced}" (from config): the mic gets its own cable. Set your game/Discord mic input to "${micInputLabel(forced)}".`);
    finish();
    return;
  }
  const helper = path.join(__dirname, "audio-helper.ps1");
  if (!fs.existsSync(helper)) { finish(); return; }
  try {
    const proc = spawn("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass",
      "-File", helper, "-DetectMicCable", "1",
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    if (proc.stdout) proc.stdout.on("data", (d) => { out += d; });
    if (proc.stderr) proc.stderr.on("data", (d) => {
      const s = String(d).trim();
      if (s) console.error("[mic] cable scan: " + s);
    });
    proc.on("error", (e) => { console.error("[mic] cable scan failed:", e.message); finish(); });
    proc.on("close", () => {
      const line = out.split("\n").map((s) => s.trim()).filter(Boolean)[0] || "none";
      const found = line !== "none" &&
        (/^CABLE-[AB]/i.test(line) || /^Voicemeeter Input/i.test(line));
      if (found) {
        micCable = line;
        const via = /^voicemeeter/i.test(line) ? "Voicemeeter (free)" : "VB-CABLE " + line;
        console.log(`[mic] second cable found via ${via} (${line}): the mic gets its own cable -- viewers hear host sound while talking, no echo. Set your game/Discord mic input to "${micInputLabel(line)}".`);
      } else {
        console.log("[mic] no second cable found (VB-CABLE A+B pack or free Voicemeeter both work): the mic shares the main cable, so host sound pauses while a viewer talks.");
      }
      finish();
    });
  } catch (e) {
    console.error("[mic] cable scan failed:", e.message);
    finish();
  }
}

// One voice chunk from the viewer: [type:1][samples...] -- mu-law bytes for
// the light stream, int16le PCM for classic sessions. Fed straight into
// ffplay's stdin; the backpressure flag just drops chunks while the pipe is
// full (stale voice is useless -- same policy as streamed audio).
function handleMicData(data) {
  if (!micWanted || !micFfmpeg || micFfmpeg.exitCode !== null) return;
  if (data.length < 3) return;
  const t0 = data[0];
  if (t0 === MIC_ULAW_TYPE) { if (micCodec !== "ulaw8") return; }
  else if (t0 === MIC_PCM_TYPE) { if (micCodec === "ulaw8") return; }
  else return;
  const buf = Buffer.isBuffer(data) ? data.subarray(1) : Buffer.from(data.buffer, data.byteOffset + 1, data.byteLength - 1);
  // While the handoff probe runs, HOLD the voice instead of feeding it: the
  // probe tone must be the first thing ffplay plays, and queued PCM would
  // push it past the recorders' window. Held PCM flushes on confirmation.
  if (micCableState === "borrowing") { holdMicData(Buffer.from(buf)); return; }
  if (micStdinBlocked) return;
  try {
    micStdinBlocked = !micFfmpeg.stdin.write(buf);
  } catch (_) { /* pipe closed mid-kill: ignore */ }
}

// ---------------------------------------------------------------------------
// 3. WebSocket connection to the relay: sends video, receives input JSON
// ---------------------------------------------------------------------------

let ws = null;
let wsOpen = false;
let relayPingTimer = null; // liveness heartbeat so the dashboard can tell a dead agent from a live one
const directClients = new Set(); // authenticated viewers connected straight to this agent (no relay)
const startTimeUs = () => process.hrtime.bigint() / 1000n;
const t0 = startTimeUs();

// The config template that ships in the zip still has the literal placeholder
// where the private key goes. An agent that never had its key pasted connects,
// gets rejected by the relay, and (before this check) just looped silently
// forever -- "Relay disconnected; retrying in 2s" on repeat, with no hint that
// the real problem was the missing key. Catch it before the first connection so
// the person at the PC is told exactly what to do instead.
function looksLikePlaceholderToken(tok) {
  const t = String(tok || "").trim();
  if (!t) return true;                                  // nothing pasted at all
  if (/^PASTE[-_ ]?YOUR/i.test(t)) return true;         // the shipped template
  if (/YOUR[-_ ]?(PRIVATE[-_ ]?)?KEY|PRIVATE[-_ ]?KEY[-_ ]?HERE/i.test(t)) return true;
  if (t.length < 32) return true;                       // a real key is a long hex string
  return false;
}

// The local page's address, or null when the person turned it off
// (viewerPort: 0) -- printing "http://localhost:0" just looks broken.
function localPageUrl() {
  const port = String(process.env.VIEWER_PORT === undefined ? 8000 : process.env.VIEWER_PORT);
  if (!port || port === "0") return null;
  return "http://localhost:" + port;
}

function connectRelay() {
  const url = `${RELAY_URL}${RELAY_URL.includes("?") ? "&" : "?"}role=agent&token=${encodeURIComponent(RELAY_TOKEN)}` +
    `&device=${encodeURIComponent(DEVICE.deviceId)}&name=${encodeURIComponent(DEVICE_NAME)}&pin=${encodeURIComponent(DEVICE.pin)}`;
  console.log("Connecting to relay:", RELAY_URL);
  ws = new WebSocket(url);

  ws.on("open", () => {
    wsOpen = true;
    // Kill Nagle on the relay socket end to end: input events and mic JSON
    // must never sit in a ~40ms coalescing window behind a video frame.
    // (The browser side has no such knob; the relay/CF edge is fine.)
    try { if (ws._socket) ws._socket.setNoDelay(true); } catch (_) {}
    // Don't announce success we don't have yet: with an un-pasted key the
    // handshake opens and the relay rejects us a moment later, so printing
    // "listed in the dashboard" (and a PIN nobody can use) here would
    // contradict the rejection message right underneath it.
    if (!looksLikePlaceholderToken(RELAY_TOKEN)) {
      console.log("Relay connected -- this PC is listed in the dashboard");
      printDeviceBox();
    }
    // Small ping every 15s. The dashboard only shows "online" while these
    // arrive, so even an abrupt kill (no clean close event) flips the PC to
    // offline within ~45 seconds instead of staying "online" forever.
    if (relayPingTimer) clearInterval(relayPingTimer);
    relayPingTimer = setInterval(() => {
      try { if (ws && ws.readyState === 1) ws.send('{"type":"agent_ping"}'); } catch (_) {}
    }, 15000);
  });

  ws.on("close", (code, reason) => {
    wsOpen = false;
    if (relayPingTimer) { clearInterval(relayPingTimer); relayPingTimer = null; }
    if (directClients.size === 0) stopCapture("relay connection lost");
    // The relay explains WHY it hung up (bad key, PC already claimed, wrong
    // PIN...). Retrying forever on a rejection that can never succeed just
    // spams the window, so say what happened and stop.
    const why = reason ? reason.toString().trim() : "";
    if (code === 4003 || looksLikePlaceholderToken(RELAY_TOKEN)) {
      console.error("");
      console.error("  !! THE RELAY REJECTED THIS PC -- it is not listed in the dashboard.");
      console.error("");
      console.error("  Why: " + (why || "your private key is not a real account key."));
      console.error("");
      console.error("  Fix it (takes 20 seconds):");
      console.error("    1. Open the ClankerDesk website and Sign up (or Log in).");
      console.error("    2. Copy YOUR PRIVATE KEY from the account page.");
      console.error("    3. Open config.json in this folder with Notepad.");
      console.error("    4. Replace the text on the \"relayToken\" line with that key.");
      console.error("    5. Save, then close and re-open ClankerDesk.");
      console.error("");
      console.error("  (Relaying is off until then -- this PC still works on its own");
      if (localPageUrl()) console.error("   local page, " + localPageUrl() + " )");
      else console.error("   local page.)");
      console.error("");
      return; // don't hammer the relay with a key that cannot work
    }
    console.log("Relay disconnected" + (why ? ` (${code}: ${why})` : "") + "; retrying in 2s");
    setTimeout(connectRelay, 2000);
  });

  ws.on("error", (err) => console.error("Relay socket error:", err.message));

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      // The agent only ever SENDS binary; anything binary arriving through the
      // relay is microphone PCM from a viewer (the relay forwards it untouched).
      handleMicData(data);
      return;
    }
    console.log("[relay->agent] raw message:", data.toString());
    try {
      const event = JSON.parse(data.toString());
      handleViewerEvent(event);
    } catch (e) {
      console.error("Bad input event:", e.message);
    }
  });
}

// Every binary WS message is now prefixed with 1 type byte so the viewer can
// tell video and audio apart: 0x00 = video, 0x01 = audio, 0x02 = audio config.
const MSG_TYPE_VIDEO = 0x00;
const MSG_TYPE_AUDIO = 0x01;
const MSG_TYPE_AUDIO_CONFIG = 0x02;

function sendAccessUnit(payload, isKey) {
  if (!wsOpen && directClients.size === 0) return;

  const ts = startTimeUs() - t0;

  const header = Buffer.alloc(10);
  header[0] = MSG_TYPE_VIDEO;
  header[1] = isKey ? 0x01 : 0x00;

  header.writeUInt32BE(Number(ts >> 32n), 2);
  header.writeUInt32BE(Number(ts & 0xffffffffn), 6);

  broadcast(Buffer.concat([header, payload]), "video");
}

function sendAudioPacket(payload) {
  if (!wsOpen && directClients.size === 0) return;

  const ts = startTimeUs() - t0;

  const header = Buffer.alloc(9);
  header[0] = MSG_TYPE_AUDIO;

  header.writeUInt32BE(Number(ts >> 32n), 1);
  header.writeUInt32BE(Number(ts & 0xffffffffn), 5);

  broadcast(Buffer.concat([header, payload]), "audio"); // drops stale audio per viewer
}

function sendAudioConfig(opusHeadBytes) {
  if (!wsOpen) return;

  const header = Buffer.from([MSG_TYPE_AUDIO_CONFIG]);
  ws.send(Buffer.concat([header, opusHeadBytes]), { binary: true });
}

// ---------------------------------------------------------------------------
// 4. Input helper: a long-lived PowerShell process that receives one JSON
//    event per line on stdin and translates it into real mouse/keyboard input.
// ---------------------------------------------------------------------------

let inputHelper = null;

// ---------------------------------------------------------------------------
// 4b. Interception virtual mouse: used specifically for relative movement and
//     button clicks while the viewer has pointer-lock engaged (gaming mode),
//     since those are the events that need to look like real hardware to a
//     game. Absolute clicks/moves (desktop/browser use, before lock engages)
//     still go through input-helper.ps1 -- no game needs those to be "real".
// ---------------------------------------------------------------------------

const MOUSE_STATE = {
  LEFT_DOWN: 0x001, LEFT_UP: 0x002,
  RIGHT_DOWN: 0x004, RIGHT_UP: 0x008,
  MIDDLE_DOWN: 0x010, MIDDLE_UP: 0x020,
};

const MOUSE_MOVE_RELATIVE = 0x000;

const BUTTON_DOWN_STATE = {
  0: MOUSE_STATE.LEFT_DOWN,
  1: MOUSE_STATE.MIDDLE_DOWN,
  2: MOUSE_STATE.RIGHT_DOWN
};

const BUTTON_UP_STATE = {
  0: MOUSE_STATE.LEFT_UP,
  1: MOUSE_STATE.MIDDLE_UP,
  2: MOUSE_STATE.RIGHT_UP
};

let interception = null;
let interceptionMouse = null;
let interceptionKeyboard = null;

function initInterception() {
  if (!Interception) return;

  try {
    interception = new Interception();
    const devices = interception.getDevices();

    const mouse = devices.find((d) => d.isMouse());

    if (mouse) {
      interceptionMouse = mouse;
      console.log("[interception] mouse ready, using", mouse.toString());
    } else {
      console.error("[interception] driver loaded but no mouse device found -- did you restart after installing it?");
    }

    const keyboard = devices.find((d) => d.isKeyboard());

    if (keyboard) {
      interceptionKeyboard = keyboard;
      console.log("[interception] keyboard ready, using", keyboard.toString());
    } else {
      console.error("[interception] driver loaded but no keyboard device found -- did you restart after installing it?");
    }

    if (!mouse && !keyboard) interception = null;

  } catch (e) {
    console.error(
      "[interception] init failed (driver likely not installed/PC not restarted yet):",
      e.message
    );
    interception = null;
  }
}

initInterception();

function sendInterceptionMouse(state, dx, dy) {
  if (!interceptionMouse) return false;

  return interceptionMouse.send({
    type: "mouse",
    state,
    flags: MOUSE_MOVE_RELATIVE,
    rolling: 0,
    x: dx || 0,
    y: dy || 0,
    information: 0,
  });
}

// PS/2 Set-1 scancodes (NOT Windows virtual-key codes -- Interception's virtual
// keyboard emulates real hardware, which reports scancodes). "e0: true" marks
// the small set of keys that are sent as an "extended" 0xE0-prefixed code on
// real keyboards (arrow keys, right ctrl/alt, the nav cluster, etc).
const SCANCODES = {
  KeyA: [0x1E],
  KeyB: [0x30],
  KeyC: [0x2E],
  KeyD: [0x20],
  KeyE: [0x12],
  KeyF: [0x21],
  KeyG: [0x22],
  KeyH: [0x23],
  KeyI: [0x17],
  KeyJ: [0x24],
  KeyK: [0x25],
  KeyL: [0x26],
  KeyM: [0x32],
  KeyN: [0x31],
  KeyO: [0x18],
  KeyP: [0x19],
  KeyQ: [0x10],
  KeyR: [0x13],
  KeyS: [0x1F],
  KeyT: [0x14],
  KeyU: [0x16],
  KeyV: [0x2F],
  KeyW: [0x11],
  KeyX: [0x2D],
  KeyY: [0x15],
  KeyZ: [0x2C],

  Digit0: [0x0B],
  Digit1: [0x02],
  Digit2: [0x03],
  Digit3: [0x04],
  Digit4: [0x05],
  Digit5: [0x06],
  Digit6: [0x07],
  Digit7: [0x08],
  Digit8: [0x09],
  Digit9: [0x0A],

  Enter: [0x1C],
  Escape: [0x01],
  Backspace: [0x0E],
  Tab: [0x0F],
  Space: [0x39],

  ShiftLeft: [0x2A],
  ShiftRight: [0x36],

  ControlLeft: [0x1D],
  ControlRight: [0x1D, true],

  AltLeft: [0x38],
  AltRight: [0x38, true],

  ArrowLeft: [0x4B, true],
  ArrowUp: [0x48, true],
  ArrowRight: [0x4D, true],
  ArrowDown: [0x50, true],

  Delete: [0x53, true],
  Home: [0x47, true],
  End: [0x4F, true],
  PageUp: [0x49, true],
  PageDown: [0x51, true],

  F1: [0x3B],
  F2: [0x3C],
  F3: [0x3D],
  F4: [0x3E],
  F5: [0x3F],
  F6: [0x40],
  F7: [0x41],
  F8: [0x42],
  F9: [0x43],
  F10: [0x44],
  F11: [0x57],
  F12: [0x58],

  Minus: [0x0C],
  Equal: [0x0D],
  BracketLeft: [0x1A],
  BracketRight: [0x1B],
  Semicolon: [0x27],
  Quote: [0x28],
  Comma: [0x33],
  Period: [0x34],
  Slash: [0x35],
  Backslash: [0x2B],
  CapsLock: [0x3A],
};

const KEY_STATE_DOWN = 0x00;
const KEY_STATE_UP = 0x01;
const KEY_STATE_E0 = 0x02;

function sendInterceptionKey(code, down) {
  if (!interceptionKeyboard) return false;

  const entry = SCANCODES[code];
  if (!entry) return false;

  const [scancode, extended] = entry;

  let state = down ? KEY_STATE_DOWN : KEY_STATE_UP;

  if (extended) {
    state |= KEY_STATE_E0;
  }

  return interceptionKeyboard.send({
    type: "keyboard",
    code: scancode,
    state,
    information: 0,
  });
}

// Routes each input event to Interception (when it's the right kind of event
// and the driver is available) or falls back to the PowerShell helper.
function handleInputEvent(event) {
  if (interceptionMouse) {
    if (event.type === "mousemove_relative") {
      sendInterceptionMouse(0, event.dx, event.dy);
      return;
    }

    if (
      event.type === "mousedown_relative" &&
      event.button in BUTTON_DOWN_STATE
    ) {
      sendInterceptionMouse(BUTTON_DOWN_STATE[event.button]);
      return;
    }

    if (
      event.type === "mouseup_relative" &&
      event.button in BUTTON_UP_STATE
    ) {
      sendInterceptionMouse(BUTTON_UP_STATE[event.button]);
      return;
    }
  }

  if (
    interceptionKeyboard &&
    (event.type === "keydown" || event.type === "keyup")
  ) {
    if (sendInterceptionKey(event.code, event.type === "keydown")) {
      return;
    }

    // unmapped key (not in SCANCODES) -- fall through to PowerShell
  }

  forwardInputToHelper(event);
}

function startInputHelper() {
  const scriptPath = path.join(__dirname, "input-helper.ps1");

  inputHelper = spawn("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
  ], {
    stdio: ["pipe", "inherit", "inherit"]
  });

  inputHelper.on("exit", (code) => {
    console.error(`input-helper.ps1 exited (code=${code}); restarting in 2s`);
    setTimeout(startInputHelper, 2000);
  });
}

function forwardInputToHelper(event) {
  if (!inputHelper || inputHelper.exitCode !== null) {
    console.log("[agent] input-helper not ready, dropping event:", event.type);
    return;
  }

  console.log("[agent->helper]", JSON.stringify(event));
  inputHelper.stdin.write(JSON.stringify(event) + "\n");
}

// ---------------------------------------------------------------------------
// Wire it all together
// ---------------------------------------------------------------------------

const parser = new AnnexBFrameParser((nals, isKey) => {
  sendAccessUnit(encodeAccessUnit(nals), isKey);
});

// Watchdog: if ffmpeg stops producing frames for a few seconds (a capture
// stall/hang -- the "freezing" symptom), kill and restart it automatically
// instead of staying stuck. This doesn't fix the underlying cause of a stall,
// but turns it from "frozen until you manually restart" into "recovers on
// its own within a few seconds."
const STALL_TIMEOUT_MS = 4000;

let currentFfmpeg = null;
let lastFrameAt = Date.now();
let watchdogTimer = null;

// ---------------------------------------------------------------------------
// Idle mode: the agent stays connected to the relay (nearly free), but only runs
// the capture/encode processes -- the part that sends ~all the data -- while a
// viewer is actually there. The viewer sends a small "viewer_ping" every 2s; if
// nothing is heard for VIEWER_TIMEOUT_MS the capture (video + audio) stops, and
// the next message from a viewer starts it again.
// ---------------------------------------------------------------------------
let captureWanted = false;
let lastViewerSeenAt = 0;
const VIEWER_TIMEOUT_MS = 8000;

function markViewerActive() {
  lastViewerSeenAt = Date.now();
  if (!captureWanted) {
    captureWanted = true;
    console.log("[idle] viewer connected -- starting capture");
    lastFrameAt = Date.now();
    launchFfmpeg();
  }
}

function stopCapture(reason) {
  if (!captureWanted) return;
  captureWanted = false;
  console.log(`[idle] ${reason} -- stopping capture to save bandwidth and relay quota`);
  try { currentFfmpeg.kill("SIGKILL"); } catch (_) {}
  audioWanted = false;
  try { currentFfmpegAudio.kill("SIGKILL"); } catch (_) {}
  disableMic("no viewer activity");
}

setInterval(() => {
  if (captureWanted && Date.now() - lastViewerSeenAt > VIEWER_TIMEOUT_MS) {
    stopCapture("no viewer activity");
  }
}, 1000);

function armWatchdog() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
  }

  watchdogTimer = setInterval(() => {
    if (captureWanted && Date.now() - lastFrameAt > STALL_TIMEOUT_MS) {
      console.error(
        `[watchdog] no frames for over ${STALL_TIMEOUT_MS}ms -- capture appears stalled, restarting ffmpeg`
      );

      lastFrameAt = Date.now();

      try {
        currentFfmpeg.kill("SIGKILL");
      } catch (_) {}

      // startFfmpeg's own "exit" handler will spawn a replacement in 2s.
    }
  }, 1000);
}

function launchFfmpeg() {
  if (!captureWanted) return; // idle: no viewer connected
  // Never run two captures at once (e.g. a quick disconnect/reconnect while the old one is still shutting down).
  if (currentFfmpeg && currentFfmpeg.exitCode === null && currentFfmpeg.signalCode === null) return;

  // Drop leftover bytes from any previous stream so a fresh stream starts clean.
  parser.buffer = Buffer.alloc(0);
  parser.pendingNals = [];
  lastFrameAt = Date.now();

  const proc = startFfmpeg();
  currentFfmpeg = proc;
  proc.stdout.on("data", (chunk) => {
    if (proc !== currentFfmpeg) return; // stale data from an old process
    lastFrameAt = Date.now();
    parser.push(chunk);
  });
}

armWatchdog();
console.log("[idle] waiting for a viewer to connect (capture starts automatically)");

// Audio is opt-in: it only starts when a viewer asks for it ({"type":"audio_enable"}).
// Old viewers never ask, so nothing changes for them. Audio runs in its own
// ffmpeg process, so a failure here can never affect video or input.
let audioWanted = false;
function enableAudio() {
  if (audioWanted) return;
  audioWanted = true;
  console.log("[audio] viewer requested audio, starting capture");
  try { launchFfmpegAudio(); } catch (e) { console.error("[audio] start failed:", e.message); }
}

// launchFfmpegAudio(); // DISABLED -- testing whether running audio+video
// simultaneously was the cause of the severe video delay. Re-enable this
// line once video is confirmed smooth without it.

// ---------------------------------------------------------------------------
// 5. Local viewer page: serves index.html at http://localhost:8000 so the viewer
//    can be opened straight from this PC, without the Cloudflare page.
//    - It serves exactly one file (index.html). No other path ever touches disk.
//    - The token is never put in the page (only the public relay address is
//      pre-filled), so there is nothing secret to leak.
//    - Any failure here is logged and ignored: video, audio and input are unaffected.
//    Settings (all optional environment variables):
//      VIEWER_PORT  default 8000 (use 0 to turn the local page off)
//      VIEWER_HOST  default 127.0.0.1 (this PC only). 0.0.0.0 = whole network.
//      OPEN_VIEWER  set to 1 to open the page in your browser automatically
// ---------------------------------------------------------------------------

const VIEWER_PORT = process.env.VIEWER_PORT === undefined ? 8000 : parseInt(process.env.VIEWER_PORT, 10);
const VIEWER_HOST = process.env.VIEWER_HOST || "127.0.0.1";
const OPEN_VIEWER = process.env.OPEN_VIEWER === "1";
// Embedding is allowed BY DEFAULT: other pages (including about:blank tabs)
// can show the viewer inside an <iframe>. Set ALLOW_EMBED=0 (or
// "allowEmbed": false in config.json) to turn that protection back on.
const ALLOW_EMBED = process.env.ALLOW_EMBED !== "0";

function findViewerFile() {
  const candidates = [
    path.join(__dirname, "index.html"),
    path.join(__dirname, "public", "index.html"),
    path.join(__dirname, "..", "public", "index.html"),
  ];
  for (const p of candidates) {
    try { if (fs.statSync(p).isFile()) return p; } catch (_) {}
  }
  return null;
}

function escapeHtmlAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Insert right before the LAST occurrence of `needle`. The real markup tag is
// always the last one; earlier matches are usually inside comments or example
// text and must not be touched (a past bug: a comment containing the literal
// head-closing tag swallowed the AGENT_DIRECT script and broke all logins).
function injectBeforeLast(html, needle, injection) {
  const idx = html.lastIndexOf(needle);
  return idx === -1 ? html : html.slice(0, idx) + injection + html.slice(idx);
}

function renderViewerHtml(raw, remoteAddr) {
  let html = raw;
  // Pre-fill the relay address (NOT the token). Falls back to the page as-is.
  if (RELAY_URL.startsWith("wss://") && !RELAY_URL.includes("your-worker")) {
    html = injectBeforeLast(html, '<input id="relayUrl"', `<input id="relayUrl" value="${escapeHtmlAttr(RELAY_URL)}"`);
  }
  // Tell the page it is served by the agent itself, so it connects straight back to it (/ws).
  if (DIRECT_OK) {
    html = injectBeforeLast(html, "</head>", "<script>window.AGENT_DIRECT = true;</script>\n");
    // Token pre-fill -- ONLY for requests coming from this very PC (loopback).
    // The viewer server binds to 127.0.0.1 and is unreachable from other
    // machines, so on this PC the page can log in with zero typing. Visitors
    // arriving through a tunnel never get this (their requests don't look
    // like loopback), so the token never leaves this machine.
    const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddr);
    if (loopback) {
      html = injectBeforeLast(html, '<input id="token"', `<input id="token" value="${escapeHtmlAttr(RELAY_TOKEN)}"`);
      // The Info panel shows the host their own device name + PIN (loopback only),
      // and the Devices dashboard needs the relay's address to list PCs.
      html = injectBeforeLast(html, "</head>", `<script>window.AGENT_DEVICE = ${JSON.stringify({ name: DEVICE_NAME, pin: DEVICE.pin })};window.AGENT_RELAY = ${JSON.stringify(USE_RELAY ? RELAY_URL : "")};</script>\n`);
    }
  }
  return html;
}

function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if ((n.family === "IPv4" || n.family === 4) && !n.internal) out.push(n.address);
    }
  }
  return out;
}

function startViewerServer() {
  if (!(VIEWER_PORT > 0 && VIEWER_PORT < 65536)) {
    console.log("[viewer] local viewer page is turned off (VIEWER_PORT=" + process.env.VIEWER_PORT + ")");
    return;
  }

  const server = http.createServer((req, res) => {
    try {
      const urlPath = (req.url || "/").split("?")[0];
      // The "Stop agent" button in the ClankerDesk window. Handled before the
      // GET/HEAD guard: POST only, loopback only -- a browser prefetch hitting
      // a GET link must never stop the agent.
      if (urlPath === "/host-stop" && req.method === "POST" &&
          ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)) {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Connection": "close" });
        res.end("stopping");
        console.log("[ui] stop requested from the ClankerDesk window -- shutting down");
        // Let the response flush first; the "exit" handler then kills ffmpeg,
        // the input helper and the tunnel before the process really quits.
        setTimeout(() => { try { process.exit(0); } catch (_) {} }, 250);
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
        res.end("Method not allowed");
        return;
      }
      // Current public tunnel link (or null) -- the Info panel reads this so
      // the page can always show the address to share.
      if (urlPath === "/public-link") {
        const body = Buffer.from(JSON.stringify({ url: PUBLIC_URL || null }), "utf8");
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": body.length,
          "Cache-Control": "no-store",
        });
        res.end(req.method === "HEAD" ? undefined : body);
        return;
      }
      // The agent's own UI: a host panel (status, PIN, links). Local only --
      // it hands out this device's PIN, so never answer it off this PC.
      const panelLocal = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
      if (urlPath === "/host-status" && panelLocal) {
        const body = Buffer.from(JSON.stringify({
          deviceName: DEVICE_NAME,
          pin: DEVICE.pin,
          relayUrl: USE_RELAY ? RELAY_URL : "",
          relayConnected: wsOpen,
          tunnelUrl: PUBLIC_URL || null,
          directViewers: directClients.size,
          captureWanted,
          uptimeSec: Math.floor(process.uptime()),
        }), "utf8");
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": body.length,
          "Cache-Control": "no-store",
        });
        res.end(req.method === "HEAD" ? undefined : body);
        return;
      }
      // The download bundles for new users (built by make-download.ps1):
      // /download/clankerdesk.zip, /download/clankerdesk-v1.0.zip, ...
      if (urlPath.startsWith("/download/") && urlPath.endsWith(".zip")) {
        const rootFile = findViewerFile();
        const zipName = path.basename(urlPath); // strips any path tricks
        const zipPath = rootFile ? path.join(path.dirname(rootFile), "download", zipName) : null;
        if (!zipPath || !fs.existsSync(zipPath)) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("That download is not available (run make-download.ps1 to build it).");
          return;
        }
        fs.readFile(zipPath, (zipErr, buf) => {
          if (zipErr || !buf) { try { res.writeHead(404); res.end(); } catch (_) {} return; }
          try {
            res.writeHead(200, {
              "Content-Type": "application/zip",
              "Content-Length": buf.length,
              "Content-Disposition": 'attachment; filename="clankerdesk.zip"',
              "Cache-Control": "no-store",
            });
            res.end(req.method === "HEAD" ? undefined : buf);
          } catch (_) { try { res.destroy(); } catch (__) {} }
        });
        return;
      }
      // Strict whitelist: the page itself (rendered) plus its stylesheet and
      // script. No other path ever touches disk.
      const isPage = urlPath === "/" || urlPath === "/index.html";
      const staticFile = urlPath === "/theme.css" ? "theme.css" : urlPath === "/app.js" ? "app.js" : null;
      if (!isPage && !staticFile) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      const file = findViewerFile();
      if (!file) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("index.html was not found next to agent.js (or in a 'public' folder).");
        return;
      }
      const staticPath = staticFile ? path.join(path.dirname(file), staticFile) : file;
      fs.readFile(staticPath, "utf8", (err, raw) => {
        try {
          if (err) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("File not found.");
            return;
          }
          const body = Buffer.from(staticFile ? raw : renderViewerHtml(raw, req.socket.remoteAddress), "utf8");
          const headers = {
            "Content-Type": staticFile === "theme.css" ? "text/css; charset=utf-8" : staticFile === "app.js" ? "application/javascript; charset=utf-8" : "text/html; charset=utf-8",
            "Content-Length": body.length,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
          };
          if (!ALLOW_EMBED) headers["X-Frame-Options"] = "DENY"; // blocks other sites from framing the page
          res.writeHead(200, headers);
          res.end(req.method === "HEAD" ? undefined : body);
        } catch (_) { try { res.destroy(); } catch (__) {} }
      });
    } catch (e) {
      try { res.writeHead(500); res.end(); } catch (_) {}
    }
  });

  server.on("clientError", (err, socket) => {
    try { socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); } catch (_) {}
  });

  // Direct viewer connections (page <-> agent, no relay). Only /ws, only with the token.
  let wss = null;
  try {
    wss = new WebSocket.Server({ noServer: true, maxPayload: 64 * 1024 });
  } catch (e) {
    console.error("[direct] could not enable direct viewer connections: " + e.message);
  }
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {}); // a reset during the handshake must never crash the agent
    try {
      const urlPath = (req.url || "").split("?")[0];
      let refuse = null;
      if (urlPath !== "/ws") refuse = "404 Not Found";
      else if (!wss || !DIRECT_OK) refuse = "403 Forbidden";
      else if (pendingAuth >= MAX_PENDING_AUTH) refuse = "503 Service Unavailable";
      if (refuse) {
        socket.write("HTTP/1.1 " + refuse + "\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (client) => acceptDirectClient(client));
    } catch (e) {
      try { socket.destroy(); } catch (_) {}
    }
  });

  let port = VIEWER_PORT;
  let retries = 0;
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE" && retries < 10) {
      retries++;
      port++;
      console.log(`[viewer] port ${port - 1} is in use, trying ${port}`);
      server.listen(port, VIEWER_HOST);
      return;
    }
    console.error("[viewer] could not start the local viewer page: " + e.message + " (streaming is unaffected)");
  });

  server.on("listening", () => {
    const p = server.address().port;
    const url = `http://localhost:${p}`;
    console.log("");
    console.log(`[viewer] Viewer page ready:  ${url}`);
    console.log(`[ui] Host control window opens automatically (or run: powershell -ExecutionPolicy Bypass -File agent\\host-window.ps1 -Port ${p})`);
    console.log("[viewer] (works on THIS PC only; on this PC it opens in view-only mode -- add ?control=1 to the address to enable input)");
    if (VIEWER_HOST === "0.0.0.0" || VIEWER_HOST === "::") {
      for (const ip of lanAddresses()) console.log(`[viewer] Also reachable on your network: http://${ip}:${p}`);
      console.log("[viewer] NOTE: other devices need HTTPS for video decoding, or a browser flag -- see the notes.");
    }
    console.log(DIRECT_OK
      ? "[direct] Direct viewer connections: ON (everyone must enter your token)"
      : "[direct] Direct viewer connections: OFF (set a RELAY_TOKEN of at least 16 characters to turn them on)");
    console.log(ALLOW_EMBED
      ? "[viewer] Embedding in other pages (iframe / about:blank tab): ON"
      : "[viewer] Embedding in other pages: off (set ALLOW_EMBED=1 to allow)");
    console.log("");
    startPublicLink(p);
    // The built-in host window (the agent's own UI -- no browser tab).
    // NOTE: do NOT pass detached:true here -- Windows PowerShell exits
    // instantly (code 0) when started as a DETACHED_PROCESS, so the window
    // never appears. stdio is piped so any script error shows up as [ui] logs.
    if (OPEN_VIEWER && process.platform === "win32") {
      try {
        const ui = spawn("powershell.exe", [
          "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass",
          "-File", path.join(__dirname, "host-window.ps1"),
          "-Port", String(p),
        ], { windowsHide: false });
        const uiLog = (d) => {
          const s = String(d).trim();
          if (s) console.log("[ui] " + s.replace(/\s*\n\s*/g, "\n[ui] "));
        };
        if (ui.stdout) ui.stdout.on("data", uiLog);
        if (ui.stderr) ui.stderr.on("data", uiLog);
        ui.on("error", (e) => console.log("[ui] could not open the host window: " + e.message));
        ui.on("exit", (code) => {
          if (code === 0) console.log("[ui] host window closed");
          else console.log("[ui] host window quit unexpectedly (code " + code + ")");
        });
        ui.unref();
      } catch (_) {}
    }
  });

  server.listen(port, VIEWER_HOST);
}

// ---------------------------------------------------------------------------
// 6. Direct viewers + optional public link
//
//  Direct viewers: a browser opened on the agent's own page connects to
//  ws(s)://<that same address>/ws. Its FIRST message must be
//  {"type":"auth","token":"..."}; until the token matches, nothing is sent to
//  it and its messages are ignored. Wrong tokens are answered slowly and a cap
//  on half-open connections stops floods. One direct viewer at a time: a new
//  one replaces the old one.
//
//  Public link (PUBLIC_LINK=1): runs `cloudflared tunnel --url ...` (a free
//  Cloudflare "quick tunnel") and prints the https://....trycloudflare.com
//  address. The page is public but harmless; control needs the token.
// ---------------------------------------------------------------------------

const MAX_PENDING_AUTH = 10;
const AUTH_TIMEOUT_MS = 5000;
const MAX_DIRECT_VIDEO_BUFFER = 16 * 1024 * 1024; // viewer hopelessly behind -> disconnect it
let pendingAuth = 0;

function tokensMatch(given) {
  if (typeof given !== "string" || given.length === 0 || given.length > 512) return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(RELAY_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

// One place that understands everything a viewer can say (used by relay + direct viewers).
function handleViewerEvent(event) {
  markViewerActive();
  if (event.type === "viewer_ping") { if (event.audio) enableAudio(); return; }
  if (event.type === "audio_enable") { enableAudio(); return; }
  // The relay tags every viewer event with a stable per-socket `vid` and sends
  // {type:"viewer_gone", vid} when a viewer drops, so we can keep the sound
  // stream from echoing a talker back to themself (the relay does the actual
  // per-viewer filtering) and reconcile mic state when a talker vanishes
  // without a clean mic_disable.
  if (event.type === "viewer_gone") { onViewerGone(event.vid); return; }
  if (event.type === "mic_enable") { enableMic(event.vid, event.rate, event.codec); return; }
  if (event.type === "mic_disable") { disableMic("viewer turned it off", event.vid); return; }
  if (event.type === "set_quality") { setCaptureQuality(event.quality); return; }

  if (event.type === "restart_capture") {
    console.log("[control] manual capture restart requested");
    try { currentFfmpeg.kill("SIGKILL"); } catch (_) {}
    return;
  }

  handleInputEvent(event);
}

// A newly connected viewer can only start decoding at a keyframe. If capture is
// already running, restart it so the new viewer gets one right away.
function needFreshKeyframe() {
  if (captureWanted) {
    lastViewerSeenAt = Date.now();
    try { currentFfmpeg.kill("SIGKILL"); } catch (_) {} // the exit handler relaunches it (captureWanted stays true)
  } else {
    markViewerActive();
  }
}

function acceptDirectClient(client) {
  // Same as the relay socket: no Nagle stall for input on the local direct
  // connection either.
  try { if (client._socket) client._socket.setNoDelay(true); } catch (_) {}
  pendingAuth++;
  let counted = true;
  let authed = false;
  let failed = false;
  const release = () => { if (counted) { counted = false; pendingAuth--; } };

  const timer = setTimeout(() => {
    if (!authed) { try { client.close(1008, "auth timeout"); } catch (_) {} }
  }, AUTH_TIMEOUT_MS);

  client.on("error", () => {});
  client.on("close", () => {
    clearTimeout(timer);
    release();
    if (directClients.delete(client)) console.log("[direct] viewer disconnected");
  });

  client.on("message", (data, isBinary) => {
    if (isBinary) { // the only binary a viewer ever sends is microphone PCM
      if (authed) handleMicData(data);
      return;
    }
    if (failed) return;
    const text = data.toString();

    if (!authed) {
      let msg = null;
      try { msg = JSON.parse(text); } catch (_) {}
      if (msg && msg.type === "auth" && tokensMatch(msg.token)) {
        authed = true;
        release();
        clearTimeout(timer);
        for (const old of directClients) { // single viewer: the newest replaces the previous one
          directClients.delete(old);
          try { old.close(4000, "replaced by a new viewer"); } catch (_) {}
        }
        directClients.add(client);
        try { client.send(JSON.stringify({ type: "auth_ok" })); } catch (_) {}
        console.log("[direct] viewer connected");
        needFreshKeyframe();
      } else if (msg && msg.type === "auth") {
        // An actual auth attempt with the wrong token: reject right away.
        failed = true;
        const got = typeof msg.token === "string" && msg.token.length
          ? `"${msg.token.slice(0, 4)}…${msg.token.slice(-4)}" (length ${msg.token.length})`
          : "none";
        console.log(`[direct] rejected auth (page sent ${got}); raw: ${text.slice(0, 120)}`);
        try { client.send(JSON.stringify({ type: "auth_failed" })); } catch (_) {}
        setTimeout(() => { try { client.close(1008, "unauthorized"); } catch (_) {} }, 500);
      }
      // Anything else before auth (heartbeats from a page that never
      // authenticates, e.g. opened as a local file) is simply ignored --
      // the 5s auth timeout closes it quietly.
      return;
    }

    try { handleViewerEvent(JSON.parse(text)); } catch (_) { /* ignore a malformed message */ }
  });
}

// Sends one binary message to the relay and to every authenticated direct viewer.
// Audio is dropped for a viewer that is falling behind (never queue up stale sound).
function broadcast(buf, kind) {
  if (wsOpen && (kind !== "audio" || ws.bufferedAmount <= 64 * 1024)) {
    try { ws.send(buf, { binary: true }); } catch (_) {}
  }
  for (const c of directClients) {
    if (c.readyState !== 1) continue;
    if (kind === "audio") {
      if (c.bufferedAmount > 64 * 1024) continue;
    } else if (c.bufferedAmount > MAX_DIRECT_VIDEO_BUFFER) {
      console.log("[direct] viewer is too far behind, disconnecting it (it will reconnect)");
      directClients.delete(c);
      try { c.terminate(); } catch (_) {}
      continue;
    }
    try { c.send(buf, { binary: true }); } catch (_) {}
  }
}

// ---- public link (Cloudflare quick tunnel) ----
const PUBLIC_LINK = process.env.PUBLIC_LINK === "1";
const PUBLIC_LINK_FILE = path.join(__dirname, "..", "PUBLIC-LINK.txt"); // always the latest link, in one predictable place
let PUBLIC_URL = null; // current https link (null while the tunnel is down)
let tunnelProc = null;
let tunnelStopping = false;
let tunnelMissing = false;
let tunnelFailures = 0;

function startPublicLink(port) {
  if (!PUBLIC_LINK || tunnelProc || tunnelStopping || tunnelMissing) return;
  if (!DIRECT_OK) {
    console.error("[public] NOT starting the public link: it needs a RELAY_TOKEN of at least 16 characters, so that only people who know the token can connect.");
    return;
  }
  if (tunnelFailures >= 5) {
    console.error("[public] giving up after 5 failed attempts. Check your internet connection, then restart the agent.");
    return;
  }

  console.log("[public] starting a Cloudflare quick tunnel (cloudflared)...");
  let announced = false;
  let acc = "";
  let proc;
  try {
    proc = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (e) {
    console.error("[public] could not start cloudflared: " + e.message);
    return;
  }
  tunnelProc = proc;

  const onData = (chunk) => {
    if (announced) return;
    acc = (acc + chunk.toString()).slice(-4000);
    const found = acc.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi) || [];
    const link = found.find((u) => !/^https:\/\/api\./i.test(u)); // api.trycloudflare.com is cloudflared's own server, not your link
    if (link) {
      announced = true;
      tunnelFailures = 0;
      PUBLIC_URL = link;
      try { fs.writeFileSync(PUBLIC_LINK_FILE, link + "\n", "utf8"); } catch (_) {}
      console.log("");
      console.log("============================================================");
      console.log("  PUBLIC LINK - open this on any computer:");
      console.log("");
      console.log("      " + link);
      console.log("");
      console.log("  Enter your token when asked. It is also saved to the file");
      console.log("  PUBLIC-LINK.txt (next to Start-Agent.bat). The link changes");
      console.log("  every time the agent (or the tunnel) restarts.");
      console.log("  Don't open it on this PC.");
      console.log("============================================================");
      console.log("");
    }
  };
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData);

  proc.on("error", (e) => {
    if (tunnelProc === proc) tunnelProc = null;
    if (e.code === "ENOENT") {
      tunnelMissing = true;
      console.error("[public] cloudflared is not installed. Install it with:  winget install --id Cloudflare.cloudflared");
      console.error("[public] then open a NEW PowerShell window and start the agent again. (Streaming works without it.)");
    } else {
      console.error("[public] tunnel error: " + e.message);
    }
  });

  proc.on("exit", (code, sig) => {
    if (tunnelProc === proc) tunnelProc = null;
    PUBLIC_URL = null;
    try { fs.unlinkSync(PUBLIC_LINK_FILE); } catch (_) {}
    if (tunnelStopping || tunnelMissing) return;
    if (!announced) tunnelFailures++;
    console.error(`[public] the tunnel stopped (code=${code}, signal=${sig}); restarting in 5s -- the link will change`);
    setTimeout(() => startPublicLink(port), 5000);
  });
}

function killTunnel() {
  tunnelStopping = true;
  try { if (tunnelProc) tunnelProc.kill(); } catch (_) {}
}

// Make sure child programs never outlive the agent (closing the window, Task Manager "End task", etc.).
function killChildren() {
  killTunnel();
  try { currentFfmpeg.kill(); } catch (_) {}
  try { currentFfmpegAudio.kill(); } catch (_) {}
  try { inputHelper.kill(); } catch (_) {}
}
process.on("exit", killChildren);
process.on("SIGHUP", () => { killChildren(); process.exit(0); });
process.on("SIGTERM", () => { killChildren(); process.exit(0); });

try { startViewerServer(); } catch (e) { console.error("[viewer] failed to start:", e.message, "(streaming is unaffected)"); }

ensureAudioRouting();
// In loopback mode the mic always uses the never-mirror talk-mute (its
// voice lands in the captured main mix no matter which cable carries it),
// so the second-cable scan has nothing to decide -- skip it there.
if (!isLoopbackAudio()) detectMicCable();
startInputHelper();
if (USE_RELAY) {
  // Async IIFE, not top-level await: this file is CommonJS. It waits for the
  // username/password below before connecting, so nothing can throw at
  // require() time and a cancelled setup still connects the relay normally.
  (async () => {
    const forceSetup = process.argv.includes("--setup") || process.argv.includes("-s");
    if (forceSetup || looksLikePlaceholderToken(RELAY_TOKEN)) {
      // Fresh install: make the account right here. A username and a password
      // is the whole setup -- no website, no copy-pasting a key into Notepad.
      // Falls back to printed instructions when there's no terminal to type
      // into (started as a service, output piped somewhere).
      let linked = false;
      if (forceSetup || process.stdin.isTTY) {
        try {
          if (forceSetup && !looksLikePlaceholderToken(RELAY_TOKEN)) {
            console.error("  This PC is already linked. Type the account you want to use:");
          }
          linked = await provisionAccount();
        } catch (e) {
          console.error("[setup] could not finish setup: " + e.message);
        }
      }
      if (!linked) {
        console.error("");
        console.error("  ============== ONE THING TO DO FIRST ==============");
        console.error("");
        console.error("  This PC is not linked to your account yet, so it will NOT");
        console.error("  appear in your dashboard and nobody can connect to it.");
        console.error("");
        console.error("  Easiest: close this and re-open ClankerDesk, then type a");
        console.error("  username and password when it asks.");
        console.error("");
        console.error("  Or do it by hand:");
        console.error("    1. Open the ClankerDesk website and Sign up (or Log in).");
        console.error("    2. Copy YOUR PRIVATE KEY from the account page.");
        console.error("    3. Open config.json in this folder with Notepad.");
        console.error("    4. Replace the text on the \"relayToken\" line with that key.");
        console.error("    5. Save, then close and re-open ClankerDesk.");
        console.error("");
        const local = localPageUrl();
        if (local) {
          console.error("  Everything else works without this: the local page at");
          console.error("  " + local + " is live now.");
        } else {
          console.error("  Everything else works without this -- relaying is the only");
          console.error("  thing that needs the key.");
        }
        console.error("  ====================================================");
        console.error("");
      }
    }
    connectRelay();
  })();
} else console.log("[relay] relay connection is off (USE_RELAY=0 or no RELAY_URL set) -- direct viewers only");

process.on("SIGINT", () => {
  console.log("Shutting down");

  if (watchdogTimer) {
    clearInterval(watchdogTimer);
  }

  try { currentFfmpeg.kill(); } catch (_) {}
  try { currentFfmpegAudio.kill(); } catch (_) {}
  try { inputHelper.kill(); } catch (_) {}
  killTunnel();
  try { ws.close(); } catch (_) {}

  process.exit(0);
});