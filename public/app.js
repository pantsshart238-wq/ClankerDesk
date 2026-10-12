/* =========================================================================
   Remote Desktop viewer logic.
   Split out of index.html so the page itself stays easy to read/theme.
   ========================================================================= */

const REMOTE_WIDTH = 1920;
const REMOTE_HEIGHT = 1080;
const CODEC = "avc1.640033"; // High profile, level 5.1 - must match the ffmpeg encoder settings

const canvas = document.getElementById("screen");
const ctx = canvas.getContext("2d");
const hud = document.getElementById("hud");

// ---- View-only mode ---------------------------------------------------------
// If this page is opened on the SAME PC that is being controlled (localhost /
// 127.0.0.1), sending mouse/keyboard to it would feed back on itself: every key
// we send would be typed into this very page, which would send it again...
// So on localhost the page is view-only unless the address ends in ?control=1.
// ?viewonly=1 forces view-only anywhere.
const _qs = new URLSearchParams(location.search);
const IS_LOCAL_HOST = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(location.hostname);
const VIEW_ONLY = _qs.has("viewonly") || (IS_LOCAL_HOST && !_qs.has("control"));

// ---- "Run your own relay" card ---------------------------------------------
// The Worker injects window.CD_DEPLOY_REPO (the public GitHub repo holding this
// source). With no repo configured the card stays hidden, so a deployment that
// hasn't been wired up never shows a button that leads nowhere.
(function showSelfHostCard() {
  const repo = String((window.CD_DEPLOY_REPO || "")).trim();
  if (!repo) return;
  const href = "https://deploy.workers.cloudflare.com/?url=" + encodeURIComponent(repo);
  const card = document.getElementById("selfHostCard");
  const btn = document.getElementById("selfHostBtn");
  const nav = document.getElementById("selfHostNav");
  if (btn) btn.href = href;
  if (nav) { nav.href = href; nav.hidden = false; }
  if (card) card.hidden = false;
})();
const VIEW_ONLY_ALLOWED = new Set(["viewer_ping", "audio_enable", "restart_capture", "mic_enable", "mic_disable", "set_quality"]);

function showBanner(text, cls, top) {
  const b = document.createElement("div");
  b.className = "banner" + (cls ? " " + cls : "");
  b.textContent = text;
  b.style.top = top + "px";
  const wrap = document.getElementById("wrap");
  // #wrap only exists on the viewer screen. Hints that can fire before a
  // connection (install app, pop-ups blocked...) must still be readable on
  // the landing page, so attach to the surface that is actually visible.
  if (wrap && wrap.offsetParent !== null) {
    wrap.appendChild(b);
  } else {
    b.style.position = "fixed";
    (document.getElementById("landing") || document.body).appendChild(b);
  }
  return b;
}
if (VIEW_ONLY) {
  showBanner("VIEW ONLY — input disabled" +
    (IS_LOCAL_HOST ? " (this is the host PC; add ?control=1 to the address to enable input)" : ""), null, 46);
}

// ---- Login screen -----------------------------------------------------------

const landing = document.getElementById("landing");
const loginOpenBtn = document.getElementById("loginOpenBtn");
const connStatus = document.getElementById("connStatus");
const viewerScreen = document.getElementById("viewerScreen");

// Landing <-> viewer. The landing (the Figma design page) shows first; once
// video flows it slides away and the viewer takes over.
function hideLanding() { landing.classList.add("gone"); }
function setConnStatus(text, working) {
  connStatus.textContent = text || "";
  connStatus.classList.toggle("working", !!working);
}

// ---- Direct connect card (wss URL + token) ----------------------------------
// The classic card: paste an address + token and connect straight to a PC.
// It also serves as the settings card and as the target the PIN prompt fills
// in, so its form ids stay stable.

const directScreen = document.getElementById("directScreen");
const loginForm = document.getElementById("loginForm");
const relayUrlInput = document.getElementById("relayUrl");
const tokenInput = document.getElementById("token");
const connectBtn = document.getElementById("connectBtn");
const loginError = document.getElementById("loginError");
const loginStatus = document.getElementById("loginStatus");
const loginBadge = document.getElementById("loginBadge");

let loginShown = false;
let videoEverFlowed = false;
let loginPinned = false; // true = the user opened the card on purpose (gear) -- don't auto-hide it

function showLogin(msg) {
  loginShown = true;
  closeAccountScreens();
  directScreen.classList.remove("hidden");
  if (msg !== undefined) setStatus(msg, false);
}
function hideLogin() {
  loginShown = false;
  directScreen.classList.add("hidden");
}
function setStatus(text, working) {
  loginStatus.textContent = text || "";
  loginStatus.classList.toggle("working", !!working);
}
function showLoginError(text) {
  loginError.textContent = text;
  loginError.classList.add("show");
  setTimeout(() => loginError.classList.remove("show"), 6000);
}

// Pre-fill from last time so returning here doesn't require retyping.
try {
  const savedUrl = localStorage.getItem("rdr_url");
  const savedToken = localStorage.getItem("rdr_token");
  if (savedUrl) relayUrlInput.value = savedUrl;
  if (savedToken) tokenInput.value = savedToken;
} catch (e) { /* localStorage unavailable, ignore */ }

// Served by the agent itself (localhost or the public link): connect straight back
// to it at the same address (/ws) -- no relay needed. The token is still required.
if (window.AGENT_DIRECT) {
  relayUrlInput.value = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws";
  loginBadge.textContent = "Direct connection to this PC";
  loginBadge.classList.add("show");
} else if (window.AGENT_RELAY_URL) {
  // Page served by the Cloudflare Worker: it injects its own websocket address.
  relayUrlInput.value = window.AGENT_RELAY_URL;
  loginBadge.textContent = "Cloudflare relay";
  loginBadge.classList.add("show");
}

// Opened by our own "Floating Window" button (see openFloatingWindow): this
// window shares the site's origin, so the saved PIN connects it like a normal
// tab. Without a saved PIN for this PC, the PIN card opens instead -- once
// entered, it is remembered and the next floating window connects itself.
if (_qs.has("floating")) {
  const floatingDev = _qs.get("device") || "";
  const floatingName = _qs.get("name") || "your PC";
  const savedFloatingDev = (function () {
    try { return new URL(localStorage.getItem("rdr_url") || "", location.href).searchParams.get("device"); }
    catch (_) { return null; }
  })();
  if ((!floatingDev || savedFloatingDev === floatingDev) && tokenInput.value) {
    // Always build the device address explicitly: the badge code above reset
    // relayUrlInput to the bare relay address (no ?device=...), and a bare
    // address would connect to "device=default" instead of this PC.
    if (floatingDev) relayUrlInput.value = deviceWsBase(floatingDev);
    setTimeout(() => { try { loginForm.requestSubmit(); } catch (_) {} }, 0);
  } else if (floatingDev) {
    setTimeout(() => { try { openPin({ id: floatingDev, name: floatingName }); } catch (_) {} }, 0);
  }
}

// ---- Account screens (login / sign up / private key) -------------------------
// Accounts live on the relay (the Worker handles /api/signup, /api/login,
// /api/me, /api/devices). The dashboard is PRIVATE: /api/devices only ever
// returns the PCs registered with the logged-in account's private key.

const loginScreen = document.getElementById("loginScreen");
const signupScreen = document.getElementById("signupScreen");
const keyScreen = document.getElementById("keyScreen");
const accForm = document.getElementById("accForm");
const accUser = document.getElementById("accUser");
const accPass = document.getElementById("accPass");
const accSubmit = document.getElementById("accSubmit");
const accError = document.getElementById("accError");
const accHint = document.getElementById("accHint");
const signForm = document.getElementById("signForm");
const signUser = document.getElementById("signUser");
const signPass = document.getElementById("signPass");
const signPass2 = document.getElementById("signPass2");
const signSubmit = document.getElementById("signSubmit");
const signError = document.getElementById("signError");
const keyTokenInput = document.getElementById("keyToken");
const keyUserEl = document.getElementById("keyUser");
const keyRelayEl = document.getElementById("keyRelay");
const dashSub = document.getElementById("dashSub");
const dashLogoutBtn = document.getElementById("dashLogoutBtn");

let accountUser = null; // username while logged in, else null

function refreshAccountUi() {
  loginOpenBtn.textContent = accountUser ? "@" + accountUser : "Login";
  dashLogoutBtn.classList.toggle("hidden", !accountUser);
}

function closeAccountScreens() {
  loginScreen.classList.add("hidden");
  signupScreen.classList.add("hidden");
  keyScreen.classList.add("hidden");
}

function showAccError(el, text) {
  el.textContent = text;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 6000);
}

function openAccLogin(hint) {
  closeInfo();
  closeDownloads();
  closeDash();
  closePin();
  hideLogin();
  accHint.innerHTML = hint || "Your account shows only <b>your</b> PCs — nobody else's.";
  accError.classList.remove("show");
  closeAccountScreens();
  loginScreen.classList.remove("hidden");
  accUser.focus();
}

function openSignup() {
  closeAccountScreens();
  signError.classList.remove("show");
  signupScreen.classList.remove("hidden");
  signUser.focus();
}

function openKeyScreen(user, token) {
  keyUserEl.textContent = "@" + user;
  keyTokenInput.value = token;
  try { keyRelayEl.textContent = location.origin + "/ws"; }
  catch (_) { keyRelayEl.textContent = "wss://clankerdesk.remote-me-braeden.workers.dev/ws"; }
  closeAccountScreens();
  keyScreen.classList.remove("hidden");
}

async function fetchMe() {
  try {
    const r = await fetch("/api/me", { cache: "no-store" });
    const d = await r.json();
    accountUser = (d && d.user) || null;
  } catch (e) { accountUser = null; }
  refreshAccountUi();
}

accForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  accError.classList.remove("show");
  const user = accUser.value.trim();
  const pass = accPass.value;
  if (!user || !pass) return showAccError(accError, "type your username and password");
  accSubmit.disabled = true;
  accSubmit.textContent = "Logging in…";
  try {
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: user, password: pass }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) {
      showAccError(accError, d.error || "could not log in — try again");
      return;
    }
    accountUser = d.user;
    accPass.value = "";
    refreshAccountUi();
    closeAccountScreens();
    openDash();
  } catch (err) {
    showAccError(accError, "network problem — try again");
  } finally {
    accSubmit.disabled = false;
    accSubmit.textContent = "Log in";
  }
});

signForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  signError.classList.remove("show");
  const user = signUser.value.trim();
  const pass = signPass.value;
  if (pass !== signPass2.value) return showAccError(signError, "the two passwords don't match");
  signSubmit.disabled = true;
  signSubmit.textContent = "Creating…";
  try {
    const r = await fetch("/api/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: user, password: pass }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) {
      showAccError(signError, d.error || "could not sign up — try again");
      return;
    }
    accountUser = d.user;
    signPass.value = signPass2.value = "";
    refreshAccountUi();
    openKeyScreen(d.user, d.token);
  } catch (err) {
    showAccError(signError, "network problem — try again");
  } finally {
    signSubmit.disabled = false;
    signSubmit.textContent = "Create account";
  }
});

document.getElementById("accToSignupBtn").addEventListener("click", openSignup);
document.getElementById("signBackBtn").addEventListener("click", () => openAccLogin());
document.getElementById("accDirectBtn").addEventListener("click", () => {
  closeAccountScreens();
  showLogin();
  relayUrlInput.focus();
});
document.getElementById("directBackBtn").addEventListener("click", () => {
  hideLogin();
  openAccLogin();
});
document.getElementById("keyDoneBtn").addEventListener("click", () => openAccLogin());
document.getElementById("keyXBtn").addEventListener("click", () => openAccLogin());
document.getElementById("keyCopyBtn").addEventListener("click", async () => {
  const btn = document.getElementById("keyCopyBtn");
  try {
    await navigator.clipboard.writeText(keyTokenInput.value);
    btn.textContent = "copied!";
    setTimeout(() => { btn.textContent = "copy key"; }, 1500);
  } catch (e) { keyTokenInput.select(); } // clipboard blocked: the key is selected to copy by hand
});

dashLogoutBtn.addEventListener("click", async () => {
  try { await fetch("/api/logout", { method: "POST" }); } catch (e) { /* ignore */ }
  accountUser = null;
  refreshAccountUi();
  closeDash();
  openAccLogin("Logged out.");
});

// Who are we, if anyone? (session cookie from a previous visit)
fetchMe();

// People frequently paste the server ADDRESS into the token box (or paste a
// whole line like "token: 1121...7454 matches: True"). Clean that up before
// connecting so a copy-paste mix-up can never look like a "wrong token".
function looksLikeUrl(s) { return /^(wss?|https?):\/\//i.test(s); }
function extractToken(raw) {
  // Longest run of token-ish characters (digits/letters/dashes/underscores).
  const runs = raw.match(/[0-9A-Za-z_-]{16,}/g) || [];
  return runs.sort((a, b) => b.length - a.length)[0] || null;
}

loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  let url = relayUrlInput.value.trim();
  let token = tokenInput.value.trim(); // trim: stray spaces/newlines from copy-paste cause "wrong token"

  // Address in the token box (and the token in the address box)? Swap them.
  if (looksLikeUrl(token) && url && !looksLikeUrl(url)) {
    const t = url; url = token; token = t;
    relayUrlInput.value = url;
    tokenInput.value = token;
    setStatus("Those two fields were swapped — fixed automatically.", false);
  } else if (looksLikeUrl(token)) {
    // Address pasted into the token box, address box already has the address.
    token = "";
  }

  // Pasted a whole line? Pull the most token-like part out of it.
  if (token && !/^[0-9A-Za-z_-]+$/.test(token)) {
    const cand = extractToken(token);
    if (cand) { token = cand; tokenInput.value = token; }
  }

  if (!url) return;
  try {
    localStorage.setItem("rdr_url", url);
    localStorage.setItem("rdr_token", token);
  } catch (_) { /* ignore */ }
  connect(url, token);
});

// ---- Video ------------------------------------------------------------------

let ws = null;
let decoder = null;
let framesDecoded = 0;
let lastFpsTime = performance.now();
let fps = 0;
let lastFrameOutputAt = performance.now();
let lastDataReceivedAt = performance.now();

// A "locked" message (wrong token / replaced by another viewer) stays on screen until the
// next Connect, so a late decoder callback can't overwrite the reason for the disconnect.
let hudLocked = false;
function setHud(text, lock) {
  if (hudLocked && !lock) return;
  hudLocked = !!lock;
  hud.textContent = text;
}

// Latency guard state. A slow decoder (weak Chromebook, throttled embed,
// backgrounded tab) must drop video and stay LIVE, never queue it and fall
// further behind every second -- that ratchet is exactly how a stream
// starts crisp and ends up seconds delayed.
const VIDEO_MAX_DECODE_QUEUE = 4;
let decoderConfig = null;
let awaitingKey = false; // true = drop deltas until the next keyframe starts us clean

function initDecoder() {
  decoder = new VideoDecoder({
    output(frame) {
      ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
      frame.close();
      framesDecoded++;
      lastFrameOutputAt = performance.now();
      if (!videoEverFlowed) {
        videoEverFlowed = true;
        hideLanding();            // their design page is done -- show the stream
        viewerScreen.classList.remove("hidden");
        setConnStatus("");
        if (!loginPinned) hideLogin(); // first frame: the session is really up
      }
      const now = performance.now();
      if (now - lastFpsTime >= 1000) {
        fps = framesDecoded;
        framesDecoded = 0;
        lastFpsTime = now;
        setHud(`connected — ${fps} fps — ` + (pointerLocked ? "🔒 locked (Ctrl+L to release)" : "Ctrl+L to lock cursor"));
      }
    },
    error(e) {
      console.error("decoder error", e);
      setHud("decoder error: " + e.message);
    },
  });

  // No `description` is provided on purpose: the agent sends Annex-B (start-code
  // delimited) NAL units, which Chrome's WebCodecs H264 decoder accepts directly
  // without an avcC extradata box.
  decoderConfig = {
    codec: CODEC,
    codedWidth: REMOTE_WIDTH,
    codedHeight: REMOTE_HEIGHT,
    optimizeForLatency: true,
  };
  decoder.configure(decoderConfig);
  awaitingKey = true; // a fresh decoder starts clean on the next keyframe
  lastFrameOutputAt = performance.now();
}

if (typeof VideoDecoder === "undefined") {
  // WebCodecs only exists on secure pages: https://, http://localhost or file://.
  showBanner("Video decoding is unavailable on this address. Open the page via https:// or http://localhost.", "error", 8);
}

// Watchdog: the decoder can silently stop producing frames (no thrown error,
// output() just stops firing) if it gets fed a malformed access unit -- this
// looks exactly like the video "freezing." If we're still receiving data from
// the agent but haven't successfully decoded a frame in a while, force a
// decoder reset. The agent sends a fresh keyframe at least every 2 seconds,
// so a reset decoder recovers on its own shortly after.
//
// NOTE: lastDataReceivedAt is only updated by VIDEO messages (see onmessage).
// Audio packets must not count here: with audio flowing, a static screen
// (no new video frames) would look like a "stalled decoder" and trigger a
// pointless reset every few seconds.
setInterval(() => {
  const now = performance.now();
  const receivingData = now - lastDataReceivedAt < 2000;
  const stalled = now - lastFrameOutputAt > 3000;
  if (receivingData && stalled && decoder && decoder.state !== "closed") {
    console.error("[watchdog] receiving data but no decoded frames for 3s+ -- resetting decoder");
    try { decoder.close(); } catch (_) {}
    initDecoder();
  }
}, 1000);

let lastConnectUrl = null;
let lastConnectToken = null;
let authFailed = false;

// ---- Audio ------------------------------------------------------------------
// Fully independent of the video decoder above. Every audio step is wrapped in
// try/catch: if anything here fails, video and input are unaffected.
//
// Flow: the viewer asks the agent to start audio ({"type":"audio_enable"}),
// the agent sends raw 10 ms Opus packets as binary messages (type byte 0x01),
// and we decode + schedule them on a small (~50 ms) jitter buffer. Audio that
// arrives too far ahead of the playback clock is dropped, so delay never
// accumulates.

const AUDIO_TARGET_BUFFER = 0.05; // seconds of audio we try to keep queued
const AUDIO_MAX_BUFFER = 0.20;    // further ahead than this -> drop packets to catch up
const AUDIO_MAX_DECODE_QUEUE = 20; // decoder backed up -> drop packets

let audioContext = null;
let audioGain = null;
let audioDecoder = null;
let nextAudioPlayTime = 0;
let audioUnlocked = false;
let audioMuted = false;
let loggedFirstAudioPacket = false;
let loggedFirstAudioOutput = false;

// Standard 19-byte OpusHead (stereo, 48 kHz, pre-skip 120, mapping family 0),
// built locally so audio works no matter when the viewer connects -- the
// agent's one-time config message is not needed (and is ignored).
const OPUS_HEAD = new Uint8Array([
  0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, // "OpusHead"
  1,            // version
  2,            // channels
  0x78, 0x00,   // pre-skip = 120 (LE) -- what ffmpeg's libopus writes
  0x80, 0xbb, 0x00, 0x00, // input sample rate = 48000 (LE)
  0, 0,         // output gain
  0,            // channel mapping family 0
]);

function initAudioContext() {
  if (audioContext) return;
  audioContext = new (window.AudioContext || window.webkitAudioContext)({
    latencyHint: "interactive",
    sampleRate: 48000,
  });
  audioGain = audioContext.createGain();
  audioGain.gain.value = audioMuted ? 0 : 1;
  audioGain.connect(audioContext.destination);
  nextAudioPlayTime = 0;
}

function initAudioDecoder() {
  try { if (audioDecoder && audioDecoder.state !== "closed") audioDecoder.close(); } catch (_) {}
  audioDecoder = new AudioDecoder({
    output(audioData) { playAudioData(audioData); },
    error(e) {
      // Decoder entered a broken state: drop it; a fresh one is created on the next packet.
      console.warn("[audio] decoder error, will reset:", e && e.message);
      audioDecoder = null;
    },
  });
  audioDecoder.configure({
    codec: "opus",
    sampleRate: 48000,
    numberOfChannels: 2,
    description: OPUS_HEAD,
  });
}

function playAudioData(audioData) {
  try {
    if (!audioContext || audioMuted || audioContext.state !== "running") return;
    const numChannels = audioData.numberOfChannels;
    const numFrames = audioData.numberOfFrames;
    const audioBuffer = audioContext.createBuffer(numChannels, numFrames, audioData.sampleRate);
    for (let ch = 0; ch < numChannels; ch++) {
      const channelData = new Float32Array(numFrames);
      // format must be explicit: the decoder may hand us interleaved samples,
      // and asking for a plane that doesn't exist throws.
      audioData.copyTo(channelData, { planeIndex: ch, format: "f32-planar" });
      audioBuffer.copyToChannel(channelData, ch);
    }

    const now = audioContext.currentTime;
    if (nextAudioPlayTime < now) nextAudioPlayTime = now + AUDIO_TARGET_BUFFER; // underrun: re-buffer
    else if (nextAudioPlayTime > now + AUDIO_MAX_BUFFER) return;                // too far ahead: drop

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioGain);
    source.start(nextAudioPlayTime);
    nextAudioPlayTime += audioBuffer.duration;

    if (!loggedFirstAudioOutput) {
      loggedFirstAudioOutput = true;
      console.info("[audio] first audio buffer scheduled -- playback is working");
    }
  } catch (e) {
    console.warn("[audio] playback error:", e && e.message);
  } finally {
    audioData.close();
  }
}

function handleAudioMessage(buf) {
  // Audio header: [type:1][timestampMicros:8 BE][opusPacket...]
  try {
    if (!loggedFirstAudioPacket) {
      loggedFirstAudioPacket = true;
      console.info("[audio] receiving audio packets from the agent");
    }
    if (!audioUnlocked || audioMuted || !audioContext || audioContext.state !== "running") return;
    if (buf.length <= 9) return;
    if (!audioDecoder || audioDecoder.state === "closed") initAudioDecoder();
    if (audioDecoder.decodeQueueSize > AUDIO_MAX_DECODE_QUEUE) return;

    let tsHigh = 0, tsLow = 0;
    for (let i = 0; i < 4; i++) tsHigh = tsHigh * 256 + buf[1 + i];
    for (let i = 0; i < 4; i++) tsLow = tsLow * 256 + buf[5 + i];
    const timestamp = tsHigh * 4294967296 + tsLow;

    audioDecoder.decode(new EncodedAudioChunk({ type: "key", timestamp, data: buf.subarray(9) }));
  } catch (e) {
    console.warn("[audio] packet error, resetting audio decoder:", e && e.message);
    try { if (audioDecoder) audioDecoder.close(); } catch (_) {}
    audioDecoder = null;
  }
}

// Browsers only allow audio after a user gesture, so the first click / key
// press anywhere on the page unlocks it and asks the agent to start sending.
function unlockAudio() {
  try {
    if (typeof AudioDecoder === "undefined") {
      console.warn("[audio] this browser has no WebCodecs AudioDecoder");
      return;
    }
    if (!audioContext) initAudioContext();
    if (audioContext.state !== "running") audioContext.resume();
    if (!audioUnlocked) {
      audioUnlocked = true;
      sendInput({ type: "audio_enable" });
      updateSoundButton();
    }
  } catch (e) {
    console.warn("[audio] unlock failed:", e && e.message);
  }
}

for (const evt of ["pointerdown", "keydown"]) {
  document.addEventListener(evt, (e) => {
    // The sound button handles its own click (so the first click on it turns
    // sound ON instead of unlocking and then immediately muting).
    if (e.target && e.target.closest && e.target.closest("#soundBtn")) return;
    unlockAudio();
  }, true);
}

const soundBtn = document.getElementById("soundBtn");
function updateSoundButton() {
  // The button holds two SVG icons; the .off class tells CSS which to show.
  if (!audioUnlocked) {
    soundBtn.classList.add("off");
    soundBtn.title = "Click to enable sound";
  } else if (audioMuted) {
    soundBtn.classList.add("off");
    soundBtn.title = "Sound off (click to turn on)";
  } else {
    soundBtn.classList.remove("off");
    soundBtn.title = "Sound on (click to mute)";
  }
}
soundBtn.addEventListener("click", () => {
  if (!audioUnlocked) {
    unlockAudio();
  } else {
    audioMuted = !audioMuted;
    if (audioGain) audioGain.gain.value = audioMuted ? 0 : 1;
    nextAudioPlayTime = 0; // re-buffer cleanly when un-muting
    updateSoundButton();
  }
  soundBtn.blur();   // so Space/Enter aren't also forwarded to the PC from the button
  canvas.focus();
});

// ---- Microphone (viewer -> host): the browser captures this device's mic and
// streams raw PCM to the agent, which plays it into VB-CABLE so games / Discord
// on the big machine hear you like you were sitting there.
// Format: 8 kHz mono mu-law, one WebSocket binary message per ~64 ms chunk:
//   [0x12][8-bit mu-law samples...]   (the agent drops anything else)
// That is ~8 KB/s while talking and nothing while silent -- tiny enough for
// a Chromebook on school wifi or behind a web proxy.
// Muting = stop the stream and tell the agent (mic_disable), so the mic is
// fully released -- nothing is sent while muted.

const micBtn = document.getElementById("micBtn");
let micOn = false;
let micStream = null;
let micContext = null;
let micNode = null;
// The mic turns ON automatically when a viewer connects. These two flags keep
// that polite: one automatic attempt per page load (so a denied permission
// prompt never re-spams on reconnects) and never again after the viewer has
// clicked mute themselves. A fresh (click-the-button) Connect re-arms the
// automatic attempt -- reconnecting on purpose should bring the mic back.
let micAutoTried = false;
let micUserMuted = false;

// The mic stream is tuned for the WORST connection: a school Chromebook on
// school wifi, a web proxy, a hotspot. It goes out as 8 kHz mu-law (the
// telephone codec) -- about 8 KB/s while actually talking and ZERO in
// silence, roughly a tenth of what raw PCM needed -- and the browser-side
// noise processing is off so the Chromebook's CPU stays free for video.
// Echo cancellation stays ON: it is what stops the host's sound from
// looping back through this device's speakers into the game.
const MIC_RATE = 8000;        // Hz (mu-law's fixed rate)
const MIC_ULAW_TYPE = 0x12;   // wire format: [0x12][8-bit mu-law samples]
const MIC_CHUNK = 512;        // samples per send (~64 ms at 8 kHz)
const MIC_SILENCE_DB = -50;   // below this a chunk counts as silence
const MIC_SILENCE_HANG_MS = 500; // keep sending this long after real voice
const MIC_QUEUE_MAX = 8 * 1024;  // drop chunks when the uplink falls behind
let micLastVoice = 0;

// 16-bit PCM -> G.711 mu-law (one byte per sample, standard BIAS/segment
// math; ffplay decodes it with -f mulaw). Verified against the known
// vectors: 0 -> 0xFF, 32767 -> 0x7F, -32768 -> 0xFF.
function pcmToUlaw(v) {
  let p = v >> 2;
  const mask = p < 0 ? (p = -p, 0x7f) : 0xff;
  if (p > 8159) p = 8159;
  p += 33;
  let t = p >> 5, seg = 0;
  while (t > 1) { t >>= 1; seg++; }
  return (((seg << 4) | ((p >> (seg + 1)) & 0xf)) ^ mask) & 0xff;
}

// A mic the browser won't hand over is the number one "why is this off"
// moment -- especially inside embeds, where the page framing us decides
// whether microphones are allowed at all. Say it out loud instead of only
// flipping a tooltip.
let micBlockedShown = false;
function micBlockedNotice(msg) {
  if (micBlockedShown) return;
  micBlockedShown = true;
  showBanner(msg, "error", 80);
}
function inEmbedFrame() {
  try { return window.top !== window.self; } catch (_) { return true; } // cross-origin frame throws on the comparison
}
const MIC_EMBED_FIX = "This embed can't use your microphone — open the ClankerDesk link in its own tab to talk.";

function updateMicButton() {
  // Icon swap (mic on/off) happens through the .off class in CSS.
  micBtn.classList.toggle("off", !micOn);
  micBtn.title = micOn
    ? "Your mic is live on the other PC (click to mute)"
    : "Click to talk through your mic on the other PC";
}

function sendMicChunk(ulaw) {
  if (!micOn || !ws || ws.readyState !== WebSocket.OPEN) return;
  // Upstream backpressure: if the connection can't keep up, DROP this voice
  // chunk instead of queueing it. A growing send queue delays every input
  // event stuck behind it -- that backlog is what makes the whole viewer
  // feel slow, and voice tolerates a dropped chunk trivially.
  if (ws.bufferedAmount > MIC_QUEUE_MAX) return;
  const msg = new Uint8Array(1 + ulaw.length);
  msg[0] = MIC_ULAW_TYPE;
  msg.set(ulaw, 1);
  try { ws.send(msg); } catch (_) {}
}

async function startMic(auto) {
  if (auto) {
    if (micOn || micAutoTried || micUserMuted) return;
    micAutoTried = true;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    micBtn.title = "This browser can't capture a microphone here (needs https or localhost)";
    if (inEmbedFrame()) micBlockedNotice(MIC_EMBED_FIX);
    return;
  }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      // Noise suppression + auto gain off: they are pure CPU on a weak
      // Chromebook and the stream is tiny enough not to need them. Echo
      // cancellation stays: without it the host's sound would loop from
      // this device's speakers back into the mic and into the game.
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
    });
  } catch (e) {
    console.warn("[mic] microphone access denied or unavailable:", e && e.name);
    micBtn.title = "No microphone permission (click again to retry)";
    // Inside an embed a permissions-policy block looks exactly like a deny:
    // the embedding page simply never offered the microphone feature.
    if (inEmbedFrame() && e && e.name === "NotAllowedError") micBlockedNotice(MIC_EMBED_FIX);
    return;
  }
  try {
    if (!micContext) {
      // A dedicated context pinned to the mic's rate: no resampling maths
      // here (the browser resamples the mic into it natively).
      micContext = new AudioContext({ sampleRate: MIC_RATE });
    }
    if (micContext.state !== "running") {
      // Without a prior page gesture this can hang until the first click, so
      // never let it stall the mic handshake: race it and move on.
      await Promise.race([
        micContext.resume().catch(() => {}),
        new Promise((r) => setTimeout(r, 1200)),
      ]);
    }
    const source = micContext.createMediaStreamSource(micStream);
    // 512 frames @8k = ~64 ms per chunk.
    micNode = micContext.createScriptProcessor(MIC_CHUNK, 1, 1);
    micNode.onaudioprocess = (e) => {
      const f32 = e.inputBuffer.getChannelData(0);
      const int16 = new Int16Array(f32.length);
      const ulaw = new Uint8Array(f32.length);
      let sum = 0;
      for (let i = 0; i < f32.length; i++) {
        const s = Math.max(-1, Math.min(1, f32[i]));
        const v = s < 0 ? s * 0x8000 : s * 0x7fff;
        int16[i] = v;
        ulaw[i] = pcmToUlaw(v);
        if ((i & 3) === 0) sum += v * v; // loudness from every 4th sample
      }
      // Silence gate: an idle mic has no business touching the uplink at
      // all. Send nothing; the agent's player simply waits and the voice
      // resumes mid-conversation as if nothing happened.
      const rms = Math.sqrt(sum / (f32.length >> 2)) / 32768;
      const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
      const now = performance.now();
      if (db > MIC_SILENCE_DB) micLastVoice = now;
      else if (now - micLastVoice > MIC_SILENCE_HANG_MS) return;
      sendMicChunk(ulaw);
    };
    source.connect(micNode);
    micNode.connect(micContext.destination); // no audible loop: the node itself produces no output
    micOn = true;
    sendInput({ type: "mic_enable", codec: "ulaw8", rate: MIC_RATE }); // agent: start playing into VB-CABLE
    updateMicButton();
    if (micContext.state !== "running") {
      // Started with no page gesture yet: the mic is enabled but silent until
      // the first click/tap, which starts the audio flow for real.
      const kick = () => { try { if (micContext) micContext.resume(); } catch (_) {} };
      document.addEventListener("pointerdown", kick, { once: true });
      document.addEventListener("keydown", kick, { once: true });
    }
  } catch (e) {
    console.warn("[mic] failed to start capture:", e && e.message);
    stopMicTracks();
  }
}

function stopMicTracks() {
  try { if (micNode) micNode.disconnect(); } catch (_) {}
  micNode = null;
  try { if (micStream) micStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
  micStream = null;
}

function stopMic() {
  micOn = false;
  micUserMuted = true; // their choice: never auto-start again this page load
  stopMicTracks();
  sendInput({ type: "mic_disable" }); // agent: stop playing + release the cable
  updateMicButton();
}

micBtn.addEventListener("click", () => {
  if (micOn) stopMic();
  else startMic();
  micBtn.blur();
  canvas.focus();
});
updateMicButton();

// ---- Heartbeat: tells the agent a viewer is here. The agent only captures and
// streams while it keeps hearing from us, and goes idle (saving relay quota)
// when we disconnect or close the tab. It also re-requests audio if needed.
let heartbeatTimer = null;
function sendHeartbeat() { sendInput({ type: "viewer_ping", audio: audioUnlocked }); }
function stopHeartbeat() { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } }
function startHeartbeat() {
  stopHeartbeat();
  sendHeartbeat();
  heartbeatTimer = setInterval(sendHeartbeat, 2000);
}

// ---- Connect ----------------------------------------------------------------

function connect(url, token, isRetry) {
  lastConnectUrl = url;
  lastConnectToken = token;
  authFailed = false;
  hudLocked = false;
  // Deliberate Connect (form / PIN / takeover card): the mic may auto-try
  // again even if an earlier automatic attempt was already spent.
  if (!isRetry) micAutoTried = false;
  setStatus("Connecting…", true);

  // Direct mode: this page was served by the agent itself and we are connecting back to
  // that same address. The token is then sent as the first message (never in the address).
  let isDirect = false;
  try { isDirect = !!window.AGENT_DIRECT && new URL(url).host === location.host; } catch (_) {}
  const full = isDirect
    ? url
    : url + (url.includes("?") ? "&" : "?") + "role=viewer&token=" + encodeURIComponent(token);

  if (ws) { try { ws.onclose = null; ws.close(); } catch (_) {} }
  ws = new WebSocket(full);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    setHud("connected — waiting for video");
    setStatus("Connected — waiting for video…", true);
    setConnStatus("waiting for video…", true);
    if (isDirect) {
      try { ws.send(JSON.stringify({ type: "auth", token })); } catch (_) {}
    }
    startHeartbeat();
    // After a reconnect the agent needs to be told again that we want audio.
    if (audioUnlocked) sendInput({ type: "audio_enable" });
    if (micOn) sendInput({ type: "mic_enable", codec: "ulaw8", rate: MIC_RATE });
    else startMic(true); // the mic comes on automatically when connecting
    sendQuality(); // our saved quality choice applies to every session
  };
  ws.onclose = (evt) => {
    stopHeartbeat();
    if (authFailed) return; // wrong token: stop here instead of retrying forever
    if (evt && evt.code === 4000) {
      // another viewer took over; don't fight it by reconnecting
      lastConnectUrl = null;
      setHud("another viewer connected to this PC — click Connect to take over again", true);
      showLogin("Another viewer took over this PC");
      return;
    }
    if (evt && evt.code === 4001) {
      // the relay rejected this device's PIN: stop retrying, ask again
      authFailed = true;
      lastConnectUrl = null;
      setHud("wrong PIN for that device", true);
      if (lastPinDevice) openPin(lastPinDevice, "Wrong PIN — try again.");
      return;
    }
    setHud("disconnected — reconnecting…");
    setStatus("Disconnected — reconnecting…", true);
    if (!videoEverFlowed) setConnStatus("reconnecting…", true);
    // Bring the login card back so the user can see/fix what's happening, but
    // keep retrying on our own the same way the agent does.
    if (videoEverFlowed) showLogin("Connection lost — retrying…");
    setTimeout(() => {
      if (lastConnectUrl) connect(lastConnectUrl, lastConnectToken, true);
    }, 2000);
  };
  ws.onerror = () => {
    setHud("connection error");
    setStatus("Connection error — is the address right?", false);
  };

  ws.onmessage = (evt) => {
    if (typeof evt.data === "string") {
      try {
        const m = JSON.parse(evt.data);
        if (m.type === "auth_ok") {
          setHud("connected — waiting for video");
          setStatus("Authorized — waiting for video…", true);
          // Reconnected after a drop: take the "connection lost" card away again.
          if (videoEverFlowed && !loginPinned) { hideLogin(); setStatus("", false); }
        } else if (m.type === "auth_failed") {
          authFailed = true;
          lastConnectUrl = null; // stop auto-reconnect
          stopHeartbeat();
          // The token we sent was rejected. Clear the SAVED one right away --
          // otherwise the page keeps auto-connecting with the same bad value on
          // every load and the real error hides behind a retry loop.
          try { localStorage.removeItem("rdr_token"); } catch (_) {}
          const sent = tokenInput.value.trim();
          const looksAddr = /^(wss?|https?):\/\//i.test(sent);
          const shown = sent ? `${sent.slice(0, 4)}…${sent.slice(-4)} (length ${sent.length})` : "(empty)";
          // Unmask the field for a few seconds so it's obvious what was sent.
          tokenInput.type = "text";
          setTimeout(() => { tokenInput.type = "password"; }, 4000);
          tokenInput.focus();
          setHud("wrong token — check it and click Connect again", true);
          setConnStatus("wrong token — fix it in the card", false);
          showLogin(looksAddr
            ? `That's a server ADDRESS, not a token — it belongs in the top field. The token is the secret number (get it from the control panel's Copy button).`
            : `Token rejected — the page sent ${shown}. The saved token was cleared; check the field and click Connect.`);
        }
      } catch (_) { /* not JSON: ignore */ }
      return;
    }
    const buf = new Uint8Array(evt.data);

    const msgType = buf[0]; // 0x00 = video, 0x01 = audio, 0x02 = audio config

    if (msgType === 0x02) return; // audio config: not needed, viewer builds its own
    if (msgType === 0x01) {
      handleAudioMessage(buf);
      return;
    }
    if (msgType !== 0x00) return; // unknown message type: never feed it to the video decoder

    const nowT = performance.now();
    // First video after an idle gap = a fresh stream: don't let the quiet gap look like a stalled decoder.
    if (nowT - lastDataReceivedAt > 2000) lastFrameOutputAt = nowT;
    lastDataReceivedAt = nowT; // video only (see watchdog note above)

    // Video header: [type:1][flags:1][timestampMicros:8 BE][payload...]
    const flags = buf[1];
    const isKey = (flags & 0x01) !== 0;
    let tsHigh = 0, tsLow = 0;
    for (let i = 0; i < 4; i++) tsHigh = tsHigh * 256 + buf[2 + i];
    for (let i = 0; i < 4; i++) tsLow = tsLow * 256 + buf[6 + i];
    const timestamp = tsHigh * 4294967296 + tsLow;
    const payload = buf.subarray(10);

    if (!decoder || decoder.state === "closed") initDecoder();
    // Latency guard: when the decoder's backlog fills (decode can't quite
    // keep the frame rate), drop the deltas and resync on the next keyframe
    // -- a reset decoder catches up to real time immediately. The agent
    // sends a keyframe at least once a second, so the worst case is a
    // ~1s freeze instead of a delay that grows forever.
    if (awaitingKey) {
      if (!isKey) return; // drop deltas until a keyframe starts us clean
    } else if (decoder.decodeQueueSize > VIDEO_MAX_DECODE_QUEUE) {
      if (!isKey) return; // backlog full: skip deltas, wait for a keyframe
      try {
        decoder.reset(); // flush the stale backlog
        decoder.configure(decoderConfig);
      } catch (_) {
        try { decoder.close(); } catch (_) {}
        initDecoder();
      }
      awaitingKey = false;
      lastFrameOutputAt = performance.now(); // don't trip the stall watchdog mid-resync
    }
    try {
      decoder.decode(new EncodedVideoChunk({
        type: isKey ? "key" : "delta",
        timestamp,
        data: payload,
      }));
      if (isKey) awaitingKey = false;
    } catch (e) {
      console.error("decode() threw, resetting decoder", e);
      try { decoder.close(); } catch (_) {}
      initDecoder(); // awaitingKey = true: we resume on the next keyframe
    }
  };
}

// ---- Input capture: mouse + keyboard + wheel -> JSON events sent to the agent ----

function sendInput(obj) {
  if (VIEW_ONLY && !VIEW_ONLY_ALLOWED.has(obj.type)) return; // never send mouse/keyboard in view-only mode
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function toRemoteCoords(evt) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.round(((evt.clientX - rect.left) / rect.width) * REMOTE_WIDTH);
  const y = Math.round(((evt.clientY - rect.top) / rect.height) * REMOTE_HEIGHT);
  return { x: Math.max(0, Math.min(REMOTE_WIDTH - 1, x)), y: Math.max(0, Math.min(REMOTE_HEIGHT - 1, y)) };
}

// ---- Pointer lock: press Ctrl+L to toggle "gaming style" cursor grab.
// While locked, trackpad/mouse movement sends relative deltas (e.movementX/Y)
// instead of absolute coordinates, which is what most games/remote-control
// use for smooth, unclamped aiming. Clicking the video does NOT lock anymore --
// that made the cursor vanish every time you clicked on the plain desktop.
// Ctrl+L toggles it on/off; Esc (browser-enforced) also releases it.

let pointerLocked = false;

function togglePointerLock() {
  if (VIEW_ONLY) return;
  if (document.pointerLockElement === canvas) {
    document.exitPointerLock();
  } else {
    canvas.requestPointerLock();
  }
}

canvas.addEventListener("click", () => {
  canvas.focus();
  // Browsers block audio playback until a user gesture happens on the page;
  // unlockAudio() is also triggered by the document-level pointerdown above.
  unlockAudio();
});

document.addEventListener("pointerlockchange", () => {
  pointerLocked = document.pointerLockElement === canvas;
  setHud(pointerLocked ? "connected — locked (Ctrl+L or Esc to release)" : "connected — Ctrl+L to lock cursor");
});

canvas.addEventListener("mousemove", (e) => {
  if (pointerLocked) {
    // Relative deltas: how far the trackpad/mouse moved since the last event.
    sendInput({ type: "mousemove_relative", dx: e.movementX, dy: e.movementY });
  } else {
    const { x, y } = toRemoteCoords(e);
    sendInput({ type: "mousemove", x, y });
  }
});
canvas.addEventListener("mousedown", (e) => {
  if (!pointerLocked) {
    const { x, y } = toRemoteCoords(e);
    sendInput({ type: "mousedown", x, y, button: e.button });
  } else {
    sendInput({ type: "mousedown_relative", button: e.button });
  }
  e.preventDefault();
});
canvas.addEventListener("mouseup", (e) => {
  if (!pointerLocked) {
    const { x, y } = toRemoteCoords(e);
    sendInput({ type: "mouseup", x, y, button: e.button });
  } else {
    sendInput({ type: "mouseup_relative", button: e.button });
  }
  e.preventDefault();
});
canvas.addEventListener("wheel", (e) => {
  sendInput({ type: "wheel", deltaY: e.deltaY });
  e.preventDefault();
}, { passive: false });
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

// Tracks whether we swallowed the last Ctrl+L / Ctrl+M keydown, so its
// matching keyup is also swallowed instead of being forwarded to the PC as a
// stray key-up.
let swallowedLKeyDown = false;
let swallowedMKeyDown = false;

window.addEventListener("keydown", (e) => {
  // Ctrl+M = mic on/off, exactly like clicking the mic button. Handled
  // before the view-only check (talking is allowed there too) and never
  // forwarded to the PC (the remote machine would otherwise see an "M"
  // keypress). preventDefault keeps it away from any browser binding.
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyM") {
    e.preventDefault();
    if (!e.repeat) {
      if (micOn) stopMic();
      else startMic();
    }
    swallowedMKeyDown = true;
    return;
  }
  if (VIEW_ONLY) return; // let the browser handle keys normally
  // Ctrl+L = our lock toggle. Handled locally and NOT forwarded to the PC
  // (otherwise the remote machine would also see Ctrl+L, e.g. focusing a
  // browser address bar there). preventDefault also stops this browser's
  // own address-bar jump.
  if (e.ctrlKey && e.code === "KeyL") {
    e.preventDefault();
    if (!e.repeat) togglePointerLock();
    swallowedLKeyDown = true;
    return;
  }
  sendInput({ type: "keydown", key: e.key, code: e.code });
  if (document.activeElement === canvas || document.activeElement === document.body) e.preventDefault();
});
window.addEventListener("keyup", (e) => {
  if (VIEW_ONLY) return;
  if (e.code === "KeyL" && swallowedLKeyDown) {
    swallowedLKeyDown = false;
    return;
  }
  if (e.code === "KeyM" && swallowedMKeyDown) {
    swallowedMKeyDown = false;
    return;
  }
  sendInput({ type: "keyup", key: e.key, code: e.code });
});

canvas.tabIndex = 0;
canvas.addEventListener("click", () => canvas.focus());

// ---- Corner buttons ----------------------------------------------------------

document.getElementById("settingsBtn").addEventListener("click", () => {
  if (loginShown) {
    // Only allowed to dismiss if we actually have a session; otherwise the
    // card is the only way to connect.
    if (ws && ws.readyState === WebSocket.OPEN) { hideLogin(); loginPinned = false; }
  } else {
    setStatus("", false);
    showLogin();
    loginPinned = true; // opened on purpose -- keep it up over the video
    tokenInput.focus();
  }
});

// Inside an embedding page (iframe) fullscreen is blocked unless that page allows it
// (allow="fullscreen"). Hide the button instead of leaving a dead one.
if (document.fullscreenEnabled === false) document.getElementById("fullscreenBtn").style.display = "none";

document.getElementById("fullscreenBtn").addEventListener("click", () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
});

document.getElementById("restartCaptureBtn").addEventListener("click", () => {
  sendInput({ type: "restart_capture" });
  setHud("restarting capture…");
});

// ---- Quality picker ----------------------------------------------------------
// The agent switches capture presets on request. 1080p60 is the headline
// feature; 720p60 and 1080p30 exist for weak viewers (Chromebooks) and tight
// networks -- a smooth lighter stream beats a freezing sharp one every time.
// Clicking 🎞️ opens this list (same glassy blue as the home page card) and the
// picked resolution is sent exactly like the old cycle button did.
const QUALITIES = ["1080p60", "720p60", "1080p30"];
const qualityBtn = document.getElementById("qualityBtn");
const qualityLabel = document.getElementById("qualityLabel");
const qualityMenu = document.getElementById("qualityMenu");
let quality = "1080p60";
try {
  const savedQuality = localStorage.getItem("rdr_quality");
  if (QUALITIES.includes(savedQuality)) quality = savedQuality;
} catch (_) { /* localStorage unavailable, ignore */ }

function updateQualityButton() {
  if (!qualityBtn || !qualityLabel) return;
  qualityLabel.textContent = quality.startsWith("720") ? "720" : "1080";
  qualityBtn.title = "Quality: " + quality + (quality === "1080p60" ? " (full quality)" : " (lighter stream)") + " — click to pick a resolution";
  markQualityMenu();
}

// Tick the resolution that is actually streaming.
function markQualityMenu() {
  if (!qualityMenu) return;
  const items = qualityMenu.querySelectorAll(".q-item");
  for (const item of items) {
    const on = item.getAttribute("data-quality") === quality;
    item.classList.toggle("on", on);
    item.setAttribute("aria-checked", on ? "true" : "false");
  }
}

function openQualityMenu() {
  if (!qualityMenu || !qualityBtn) return;
  markQualityMenu();
  qualityMenu.hidden = false;
  qualityBtn.setAttribute("aria-expanded", "true");
}

function closeQualityMenu() {
  if (!qualityMenu || !qualityBtn || qualityMenu.hidden) return;
  qualityMenu.hidden = true;
  qualityBtn.setAttribute("aria-expanded", "false");
}

function sendQuality() {
  sendInput({ type: "set_quality", quality });
  updateQualityButton();
}

// Choosing a resolution does exactly what the old cycle button did: remember it,
// ask the agent to switch, and resume on the NEW stream's first keyframe (it
// may be a different resolution -- clean start beats mid-GOP guessing).
function pickQuality(key) {
  if (!QUALITIES.includes(key)) return;
  quality = key;
  try { localStorage.setItem("rdr_quality", quality); } catch (_) {}
  closeQualityMenu();
  sendQuality();
  awaitingKey = true;
  setHud("switching to " + quality + "…");
  canvas.focus();
}

if (qualityBtn && qualityLabel) {
  qualityBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!qualityMenu) return;
    if (qualityMenu.hidden) openQualityMenu();
    else closeQualityMenu();
  });
  updateQualityButton();
} else {
  console.error("[quality] qualityBtn or qualityLabel not found in DOM");
  console.log("[quality] qualityBtn:", qualityBtn, "qualityLabel:", qualityLabel);
}

if (qualityMenu) {
  qualityMenu.addEventListener("click", (e) => {
    const item = e.target.closest(".q-item");
    if (!item) return;
    e.stopPropagation();
    pickQuality(item.getAttribute("data-quality"));
  });

  // A click anywhere else (the video, another toolbar button) dismisses the
  // list. Inside .q-wrap is excluded so the 🎞️ button can toggle it closed.
  document.addEventListener("pointerdown", (e) => {
    if (qualityMenu.hidden) return;
    if (e.target && e.target.closest && e.target.closest(".q-wrap")) return;
    closeQualityMenu();
  });

  // Escape closes it. Left to travel on to the PC like every other key while
  // the menu is shut, so remote fullscreen/mouse-lock keeps working.
  window.addEventListener("keydown", (e) => {
    if (qualityMenu.hidden || e.key !== "Escape") return;
    closeQualityMenu();
  });
}

// ---- Disconnect: leave the session and come back to the landing page -------

document.getElementById("disconnectBtn").addEventListener("click", () => {
  lastConnectUrl = null; // we left on purpose: never auto-reconnect
  stopHeartbeat();
  try { stopMic(); updateMicButton(); } catch (_) {}
  if (ws) {
    try { ws.onclose = null; ws.onmessage = null; ws.close(); } catch (_) {}
    ws = null;
  }
  videoEverFlowed = false;
  hudLocked = false;
  viewerScreen.classList.add("hidden");
  landing.classList.remove("gone");
  hideLogin();
  closePin();
  closeDash();
  closeDownloads();
  closeInfo();
  setStatus("", false);
  setHud("disconnected");
  setConnStatus("disconnected");
});

// ---- Landing "Features…" dropdown --------------------------------------------
// The heading is a button; clicking it slides the feature list up/down.

const featuresToggle = document.getElementById("featuresToggle");
const featuresBody = document.getElementById("featuresBody");

function setFeaturesHeight() {
  featuresBody.style.maxHeight = featuresBody.scrollHeight + "px";
}
setFeaturesHeight();
// Re-measure once fonts/layout settle, and again after every slide -- a stale
// height would clip the bottom of the text.
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => {
    if (featuresToggle.getAttribute("aria-expanded") === "true") setFeaturesHeight();
  });
}
featuresBody.addEventListener("transitionend", (e) => {
  if (e.propertyName === "max-height" && featuresToggle.getAttribute("aria-expanded") === "true") setFeaturesHeight();
});

featuresToggle.addEventListener("click", () => {
  const open = featuresToggle.getAttribute("aria-expanded") === "true";
  featuresToggle.setAttribute("aria-expanded", String(!open));
  featuresBody.style.maxHeight = open ? "0px" : featuresBody.scrollHeight + "px";
});
window.addEventListener("resize", () => {
  if (featuresToggle.getAttribute("aria-expanded") === "true") setFeaturesHeight();
});

// ---- Landing "Login" button --------------------------------------------------
// On the permanent (relay) page, "logging in" means picking a device from the
// dashboard. On this PC's own page it opens the manual card (WSS URL + token),
// both fields already filled in, so it's: click Login, click Connect.

updateSoundButton();

loginOpenBtn.addEventListener("click", () => {
  setConnStatus("");
  setStatus("", false);
  closeInfo();
  closeDownloads();
  if (window.AGENT_RELAY_URL && !window.AGENT_DIRECT) {
    // Relay page: the dashboard is PRIVATE -- it needs a logged-in account.
    if (accountUser) openDash();
    else openAccLogin();
  } else {
    // This PC's own page: straight to the direct connect card.
    showLogin();
    relayUrlInput.focus();
  }
});

// ---- Devices dashboard -------------------------------------------------------
// Lists every ClankerDesk PC the relay knows about. Picking one asks for that
// device's PIN, then connects through the relay to that device's agent.

const dashScreen = document.getElementById("dashScreen");
const deviceList = document.getElementById("deviceList");
const pinScreen = document.getElementById("pinScreen");
const pinForm = document.getElementById("pinForm");
const pinInput = document.getElementById("pinInput");
const pinError = document.getElementById("pinError");
const pinTitle = document.getElementById("pinTitle");

let dashTimer = null;
let pendingDevice = null; // { id, name } while the PIN prompt is up
let lastPinDevice = null; // remembered so a wrong PIN can reopen the prompt

// The relay's websocket address: injected by the Worker on the permanent
// page, injected by the agent on its own localhost page, else this host.
function relayWsBase() {
  if (window.AGENT_RELAY_URL) return window.AGENT_RELAY_URL;
  if (window.AGENT_RELAY) return window.AGENT_RELAY;
  return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws";
}

function relayOrigin() {
  try {
    const u = new URL(relayWsBase());
    if (u.protocol === "wss:") return u.origin.replace(/^ws/, "http");
  } catch (_) {}
  return "";
}

function deviceWsBase(id) {
  // Rebuild the address from scratch so a previously saved ?device=...
  // can never pile up on top of the new one.
  try {
    const u = new URL(relayWsBase());
    u.searchParams.delete("device");
    u.searchParams.set("device", id);
    return u.toString();
  } catch (_) {
    const base = relayWsBase();
    return base + (base.includes("?") ? "&" : "?") + "device=" + encodeURIComponent(id);
  }
}

function agoText(ts) {
  if (!ts) return "";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.round(m / 60);
  return h < 24 ? h + "h ago" : Math.round(h / 24) + "d ago";
}

async function loadDevices() {
  const origin = relayOrigin();
  if (!origin) {
    deviceList.innerHTML = '<div class="dash-empty err">The device list needs the Cloudflare relay page — open this site from its permanent link.</div>';
    return;
  }
  try {
    const r = await fetch(origin + "/api/devices", { cache: "no-store" });
    if (r.status === 401) {
      // Not logged in (or the session expired): the device list is private.
      closeDash();
      openAccLogin("Log in to see your own PCs.");
      return;
    }
    if (!r.ok) {
      deviceList.innerHTML = '<div class="dash-empty err">This page is not the permanent link — open <b>https://clankerdesk.remote-me-braeden.workers.dev</b> for the device list.</div>';
      return;
    }
    const d = await r.json();
    const devices = (d && d.devices) || [];
    if (!devices.length) {
      deviceList.innerHTML = '<div class="dash-empty">No PCs under this account yet. Run ClankerDesk on a PC and put this account\'s <b>private key</b> into its <b>config.json</b> (relayToken) — it shows up here right after a restart.</div>';
      return;
    }
    deviceList.innerHTML = "";
    for (const dev of devices) {
      const row = document.createElement("div");
      row.className = "device-row " + (dev.online ? "online" : "offline");
      const dot = document.createElement("span");
      dot.className = "dot";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = dev.name;
      const seen = document.createElement("span");
      seen.className = "seen";
      seen.textContent = dev.online ? "online" : "last seen " + agoText(dev.lastSeen);
      row.append(dot, name, seen);
      if (dev.online) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = "Connect";
        btn.addEventListener("click", () => openPin(dev));
        row.appendChild(btn);
        const floatBtn = document.createElement("button");
        floatBtn.type = "button";
        floatBtn.className = "float-btn";
        floatBtn.textContent = "Floating Window";
        floatBtn.title = "Open this PC in its own window — the mic works in here too";
        floatBtn.addEventListener("click", () => openFloatingWindow(dev));
        row.appendChild(floatBtn);
      } else {
        const spacer = document.createElement("span");
        spacer.className = "seen";
        row.appendChild(spacer);
      }
      deviceList.appendChild(row);
    }
  } catch (e) {
    deviceList.innerHTML = '<div class="dash-empty err">Could not reach the relay.</div>';
  }
}

function openDash() {
  // The dashboard replaces any card that might be behind it (account login,
  // direct connect) -- one surface at a time.
  closeAccountScreens();
  hideLogin();
  dashSub.textContent = accountUser
    ? `Your ClankerDesk PCs — logged in as @${accountUser}. Click one, enter its PIN, and you're in.`
    : "Your ClankerDesk PCs. Click one, enter its PIN, and you're in.";
  dashScreen.classList.remove("hidden");
  loadDevices();
  clearInterval(dashTimer);
  dashTimer = setInterval(loadDevices, 5000);
}

function closeDash() {
  dashScreen.classList.add("hidden");
  clearInterval(dashTimer);
  dashTimer = null;
}

function openPin(dev, msg) {
  pendingDevice = dev;
  lastPinDevice = dev;
  closeDash();
  pinTitle.textContent = "Connect to \u201C" + dev.name + "\u201D";
  try { pinInput.value = localStorage.getItem("rdr_pin_" + dev.id) || ""; } catch (_) { pinInput.value = ""; }
  pinError.textContent = msg || "";
  pinError.classList.toggle("show", !!msg);
  pinScreen.classList.remove("hidden");
  pinInput.focus();
}

function closePin() {
  pinScreen.classList.add("hidden");
  pendingDevice = null;
}

function connectWithPin(pin) {
  if (!pendingDevice) return;
  try { localStorage.setItem("rdr_pin_" + pendingDevice.id, pin); } catch (_) {}
  relayUrlInput.value = deviceWsBase(pendingDevice.id);
  tokenInput.value = pin;
  closePin();
  loginForm.requestSubmit();
}

// ---- Floating window (our own embedder) --------------------------------------
// Same idea as the about:blank "link embedder" pages people paste this site
// into -- its own little window that survives navigating around -- EXCEPT the
// mic works in this one: only the page doing the embedding can grant the
// microphone to what it frames, and this page does (allow="microphone").
// The window inherits this site's origin, so a saved PIN connects it by
// itself; without one, it asks for the PIN once (saved for next time).
function openFloatingWindow(dev) {
  const w = window.open("about:blank", "_blank");
  if (!w) {
    showBanner("Your browser blocked the floating window — allow pop-ups for this site and click it again.", "error", 80);
    return;
  }
  const d = w.document;
  d.title = (dev.name || "ClankerDesk") + " — ClankerDesk";
  d.documentElement.style.height = "100%";
  d.body.style.cssText = "margin:0;height:100%;background:#0d1420;overflow:hidden";
  const frame = d.createElement("iframe");
  frame.setAttribute("allow", "microphone"); // the whole point: the mic works in here
  frame.style.cssText = "border:0;width:100%;height:100%";
  // With a device id: open that specific PC. Without: reconnect whatever the
  // last saved connection was (the auto-connect block keys off the saved PIN).
  frame.src = (dev && dev.id)
    ? "/?floating=1&device=" + encodeURIComponent(dev.id) + "&name=" + encodeURIComponent(dev.name || "")
    : "/?floating=1";
  d.body.appendChild(frame);
}

pinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const pin = pinInput.value.trim().toUpperCase();
  if (!pin) return;
  connectWithPin(pin);
});

document.getElementById("pinBackBtn").addEventListener("click", () => { closePin(); openDash(); });
document.getElementById("pinXBtn").addEventListener("click", closePin);
document.getElementById("dashXBtn").addEventListener("click", closeDash);
document.getElementById("dashCloseBtn").addEventListener("click", closeDash);
document.getElementById("dashRefreshBtn").addEventListener("click", loadDevices);
document.getElementById("dashManualBtn").addEventListener("click", () => {
  closeDash();
  showLogin();
  relayUrlInput.focus();
});
// ---- Install as an app (ChromeOS launcher, taskbar, dock) --------------------
// A real app install, not a shortcut: Chrome downloads the app bits and gives
// ClankerDesk its own window, its own icon in the launcher (on a Chromebook:
// the app launcher / shelf) and a taskbar entry. The manifest + sw.js make
// the page installable; the button captures Chrome's install prompt the
// moment it is offered. If this browser never offers (not Chrome/Edge, or a
// managed profile), clicking says exactly what to do instead.
const installBtn = document.getElementById("installBtn");
// The early inline snippet in the page head catches the prompt even when it
// fires before this script finishes loading; the listener below catches
// prompts that arrive later (Chrome often needs a few seconds -- it waits
// for the service worker before deciding the page is installable).
let deferredInstallPrompt = window.__cdInstall || null;
let installHintShown = false; // one hint banner per page load, no matter how often it is clicked
let installWaiting = false;
if (window.matchMedia("(display-mode: standalone)").matches || navigator.standalone) {
  installBtn.classList.add("hidden"); // already running as the app
} else {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // Chrome's mini-bar stays quiet; our button is the UI
    window.__cdInstall = e;
    deferredInstallPrompt = e;
  });
  const fireInstall = () => {
    const prompt = deferredInstallPrompt;
    deferredInstallPrompt = null;
    window.__cdInstall = null;
    try { prompt.prompt(); } catch (_) {}
    try { prompt.userChoice.then(() => installBtn.classList.add("hidden")); } catch (_) { installBtn.classList.add("hidden"); }
  };
  installBtn.addEventListener("click", async () => {
    if (installWaiting) return;
    if (deferredInstallPrompt) return fireInstall();
    // Chrome may still be deciding whether the page is installable. Wait for
    // the offer instead of shrugging immediately -- the button says so.
    installWaiting = true;
    const restLabel = installBtn.textContent;
    installBtn.textContent = "Preparing\u2026";
    const started = Date.now();
    while (!deferredInstallPrompt && Date.now() - started < 6000) {
      await new Promise((r) => setTimeout(r, 250));
      deferredInstallPrompt = window.__cdInstall || deferredInstallPrompt;
    }
    installWaiting = false;
    installBtn.textContent = restLabel;
    if (deferredInstallPrompt) return fireInstall();
    if (!installHintShown) {
      installHintShown = true;
      showBanner(inEmbedFrame()
        ? "This page is inside an embed, and Chrome only offers app installs from a page in its own tab. Open the ClankerDesk link directly (its own tab) and click Install App there."
        : "Chrome isn't offering the install right now. Reload the page once and click Install App again — on a Chromebook you can also use the ⋮ menu -> Install ClankerDesk. (School/work profiles can block app installs.)", null, 80);
    }
  });
  window.addEventListener("appinstalled", () => installBtn.classList.add("hidden"));
}

// Top-bar shortcut to the floating window: reconnects the last PC you used
// in its own mic-friendly window (the per-device button in the dashboard
// opens a specific PC).
document.getElementById("floatingWindowBtn").addEventListener("click", () => openFloatingWindow({ id: "", name: "" }));

// Service worker: required for the app install, and keeps a cached shell for
// flaky connections. It never caches downloads or live data (see sw.js).
// Registered immediately (not on "load"): Chrome's installability check -- and
// with it the Install App prompt -- waits for the worker to be ready.
if ("serviceWorker" in navigator && location.protocol === "https:") {
  try { navigator.serviceWorker.register("sw.js").catch(() => {}); } catch (_) {}
}

document.getElementById("devicesBtn").addEventListener("click", () => {
  setConnStatus("");
  setStatus("", false);
  closeInfo();
  closeDownloads();
  if (window.AGENT_DIRECT) { showLogin(); relayUrlInput.focus(); return; }
  if (accountUser) openDash();
  else openAccLogin("Log in to see your own PCs.");
});

// ---- Download button: pick a version, it downloads to this PC ---------------
const downloadScreen = document.getElementById("downloadScreen");

function openDownloads() {
  closeInfo();
  hideLogin();
  closeDash();
  closePin();
  downloadScreen.classList.remove("hidden");
}

function closeDownloads() { downloadScreen.classList.add("hidden"); }

document.getElementById("downloadBtn").addEventListener("click", openDownloads);
document.getElementById("downXBtn").addEventListener("click", closeDownloads);
document.getElementById("downCloseBtn").addEventListener("click", closeDownloads);

// ---- Landing "Info" button ---------------------------------------------------
// Real content: your device's name + PIN (from this PC's agent), the permanent
// link to share, the temporary tunnel link (if one is up), and the download.

const infoBtn = document.getElementById("infoBtn");
const infoScreen = document.getElementById("infoScreen");
const publicLinkRow = document.getElementById("publicLinkRow");
const publicLinkEl = document.getElementById("publicLink");
const relayLinkRow = document.getElementById("relayLinkRow");
const relayLinkEl = document.getElementById("relayLink");
const deviceRow = document.getElementById("deviceRow");
const deviceNameEl = document.getElementById("deviceName");
const devicePinEl = document.getElementById("devicePin");
const pinCopyBtn = document.getElementById("pinCopyBtn");

infoBtn.addEventListener("click", async () => {
  // One popup at a time: whatever else is open gets out of the way.
  hideLogin();
  closeDash();
  closePin();
  closeDownloads();
  infoScreen.classList.remove("hidden");

  // Permanent relay link (on the relay page it is simply this page's home).
  const origin = relayOrigin();
  if (origin) {
    relayLinkEl.href = origin;
    relayLinkEl.textContent = origin;
    relayLinkRow.classList.remove("hidden");
  } else {
    relayLinkRow.classList.add("hidden");
  }

  // This PC's device name + PIN (the agent injects it into the loopback page).
  if (window.AGENT_DEVICE) {
    deviceNameEl.textContent = window.AGENT_DEVICE.name;
    devicePinEl.textContent = window.AGENT_DEVICE.pin;
    deviceRow.classList.remove("hidden");
  } else {
    deviceRow.classList.add("hidden");
  }

  // Temporary tunnel link, straight from the running agent (if any). Only
  // pages the agent itself serves have this endpoint — the relay page
  // doesn't, and asking it there just logs a 404 in the console.
  publicLinkRow.classList.add("hidden");
  if (window.AGENT_DIRECT) {
    try {
      const r = await fetch("/public-link", { cache: "no-store" });
      if (r.ok) {
        const d = await r.json();
        if (d && d.url) {
          publicLinkEl.href = d.url;
          publicLinkEl.textContent = d.url;
          publicLinkRow.classList.remove("hidden");
        }
      }
    } catch (e) { /* tunnel not up: nothing to show */ }
  }
});

pinCopyBtn.addEventListener("click", async () => {
  if (!window.AGENT_DEVICE) return;
  try {
    await navigator.clipboard.writeText(window.AGENT_DEVICE.pin);
    pinCopyBtn.textContent = "copied!";
    setTimeout(() => { pinCopyBtn.textContent = "copy"; }, 1500);
  } catch (e) { /* clipboard blocked: the PIN is right there to type */ }
});

function closeInfo() { infoScreen.classList.add("hidden"); }
document.getElementById("infoCloseBtn").addEventListener("click", closeInfo);
document.getElementById("infoXBtn").addEventListener("click", closeInfo);
infoScreen.addEventListener("click", (e) => { if (e.target === infoScreen) closeInfo(); });

// X on the direct connect card: back to the landing page (Login is always in
// the navbar, so nothing is lost and no refresh is ever needed).
document.getElementById("directCloseBtn").addEventListener("click", () => {
  hideLogin();
  loginPinned = false;
});

// X on the account login card: back to the landing page.
document.getElementById("loginCloseBtn").addEventListener("click", closeAccountScreens);
