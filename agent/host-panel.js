// ---------------------------------------------------------------------------
// Host control panel -- the Linux/macOS equivalent of the Windows
// host-window.ps1 (a WinForms window).
//
// It is GENERATED here rather than served from public/ on purpose:
//   * the Unix bundles deliberately do not ship public/ (the viewer page is
//     large and a headless/agent-only machine has no use for it), so a file
//     based panel would simply 404 on Linux;
//   * it then works identically on every OS, needs no extra files, and is one
//     self-contained string that cannot drift out of sync with the agent.
//
// Local requests only -- it hands out this PC's PIN, so it must never answer
// anyone arriving through the tunnel (see isLocalViewerRequest in agent.js).
// ---------------------------------------------------------------------------

function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const STYLE = `
  :root {
    --blue: #2f6fe4; --blue-dark: #245fce;
    --ink: #0b0f14; --muted: rgba(11,15,20,.55);
    --glass: rgba(255,255,255,.72);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; padding: 28px 20px;
    font-family: Montserrat, "Segoe UI", system-ui, -apple-system, sans-serif;
    color: var(--ink);
    background:
      radial-gradient(1100px 620px at 12% -8%, rgba(47,111,228,.20), transparent 60%),
      radial-gradient(900px 560px at 108% 8%, rgba(120,190,255,.22), transparent 60%),
      linear-gradient(168deg, #eef3fb 0%, #dde6f5 100%);
    background-attachment: fixed;
    display: flex; justify-content: center; align-items: flex-start;
  }
  .wrap { width: min(680px, 100%); display: flex; flex-direction: column; gap: 18px; }
  .card {
    border-radius: 22px; padding: 22px 24px;
    background: var(--glass);
    -webkit-backdrop-filter: blur(18px) saturate(1.5);
    backdrop-filter: blur(18px) saturate(1.5);
    border: 1px solid rgba(255,255,255,.6);
    box-shadow: 0 18px 44px rgba(23,44,92,.14);
  }
  h1 { margin: 0; font-size: 25px; font-weight: 800; letter-spacing: -.01em; }
  h2 { margin: 0 0 3px; font-size: 12px; font-weight: 800; letter-spacing: .08em;
       text-transform: uppercase; color: var(--muted); }
  .sub { margin: 4px 0 0; font-size: 13.5px; color: var(--muted); line-height: 1.5; }
  .row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .spacer { flex: 1 1 auto; }

  .pill {
    display: inline-flex; align-items: center; gap: 7px;
    padding: 6px 13px; border-radius: 999px;
    background: rgba(150,171,194,.26);
    border: 1px solid rgba(255,255,255,.55);
    font: 700 11.5px Montserrat, sans-serif; letter-spacing: .02em;
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #9aa5b1; }
  .pill.on .dot { background: #2fb872; box-shadow: 0 0 0 3px rgba(47,184,114,.20); }
  .pill.off .dot { background: #c2534f; box-shadow: 0 0 0 3px rgba(194,83,79,.18); }

  .pin {
    display: flex; align-items: center; justify-content: center; gap: 16px;
    margin: 6px 0 4px; padding: 18px 20px;
    border-radius: 16px;
    background: rgba(255,255,255,.55);
    border: 1px solid rgba(255,255,255,.7);
  }
  .pin .code {
    font: 800 46px/1 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    letter-spacing: .16em; color: var(--ink);
  }
  .btn {
    padding: 10px 18px; border-radius: 11px; border: 1px solid transparent;
    background: var(--blue); color: #fff;
    font: 700 13px Montserrat, sans-serif; cursor: pointer;
    transition: background .15s, transform .1s;
  }
  .btn:hover { background: var(--blue-dark); transform: translateY(-1px); }
  .btn:active { transform: scale(.97); }
  .btn.ghost { background: rgba(255,255,255,.55); color: var(--ink); border-color: rgba(255,255,255,.7); }
  .btn.ghost:hover { background: #fff; }
  .btn.danger { background: #b0413d; }
  .btn.danger:hover { background: #96342f; }

  .kv { display: flex; align-items: center; gap: 10px; padding: 11px 0;
        border-top: 1px solid rgba(11,15,20,.08); font-size: 13px; }
  .kv:first-of-type { border-top: none; }
  .kv .k { flex: 0 0 132px; font-weight: 700; color: var(--muted); font-size: 11.5px;
           letter-spacing: .05em; text-transform: uppercase; }
  .kv .v { flex: 1 1 auto; min-width: 0; font-weight: 600; word-break: break-all; }

  .steps { margin: 0; padding-left: 20px; font-size: 13px; line-height: 1.75; color: rgba(11,15,20,.72); }
  .steps code { background: rgba(150,171,194,.24); padding: 1px 6px; border-radius: 6px;
                font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
  .hint { font-size: 12px; color: var(--muted); line-height: 1.6; margin: 12px 0 0; }
  .toast {
    position: fixed; left: 50%; bottom: 26px; transform: translate(-50%, 20px);
    padding: 11px 20px; border-radius: 12px; background: rgba(11,15,20,.92); color: #fff;
    font: 700 13px Montserrat, sans-serif; opacity: 0; pointer-events: none;
    transition: opacity .18s, transform .18s;
  }
  .toast.show { opacity: 1; transform: translate(-50%, 0); }

  /* Link form */
  .field { display: block; margin-bottom: 13px; }
  .field span {
    display: block; margin-bottom: 5px;
    font: 700 11px Montserrat, sans-serif; letter-spacing: .06em;
    text-transform: uppercase; color: var(--muted);
  }
  .field input {
    width: 100%; padding: 11px 13px;
    border: 1.5px solid rgba(11,15,20,.14); border-radius: 11px;
    background: rgba(255,255,255,.72); color: var(--ink);
    font: 600 14px Montserrat, sans-serif;
    transition: border-color .15s, background .15s;
  }
  .field input:focus {
    outline: none; border-color: var(--blue); background: #fff;
  }
  .msg {
    min-height: 0; margin: 0 0 12px; font-size: 13px; font-weight: 700;
    color: #a13a35; display: none;
  }
  .msg.show { display: block; }
  .msg.good { color: #1c7a4c; }
`;

// "3h 4m" style uptime. Needed in BOTH places: once here to render the value
// the page loads with, and again in the page's own script so the live counter
// can keep it fresh without a reload.
function formatUptime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600),
        m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (d) return d + "d " + h + "h";
  if (h) return h + "h " + m + "m";
  if (m) return m + "m " + s + "s";
  return s + "s";
}

function hostPanelHtml(s) {
  const name = esc(s.deviceName);
  const pin = esc(s.pin);
  const relayOk = !!s.relayConnected;
  const tunnel = s.tunnelUrl ? esc(s.tunnelUrl) : "";
  // Built out here rather than inline: a double-quoted string inside a ${}
  // expression needs escaping, and the escaped quotes are not valid inside a
  // template literal -- it throws "Missing } in template expression".
  const publicLinkCell = tunnel
    ? tunnel
    : "<em>off</em> &mdash; set &quot;publicLink&quot;: true in config.json";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ClankerDesk &middot; ${name}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%232f6fe4'/><rect x='7' y='9' width='18' height='12' rx='2' fill='white'/></svg>">
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">

  <div class="card">
    <div class="row">
      <div>
        <h1>ClankerDesk</h1>
        <p class="sub">${name} &mdash; this window is your control panel. It closes when you close it; the agent keeps running.</p>
      </div>
      <span class="spacer"></span>
      <a class="btn ghost" href="/" target="_blank" rel="noopener">Open viewer page</a>
    </div>
    <div class="row" style="margin-top:16px">
      <span class="pill ${relayOk ? "on" : "off"}"><span class="dot"></span>${relayOk ? "Connected to the relay" : "Relay offline"}</span>
      <span class="pill ${s.directViewers ? "on" : ""}"><span class="dot"></span>${s.directViewers ? s.directViewers + " viewer(s) connected" : "No viewers connected"}</span>
      <span class="pill"><span class="dot"></span>${s.captureWanted ? "Streaming" : "Idle"}</span>
      <span class="spacer"></span>
      <button class="btn ghost" type="button" onclick="location.reload()">Refresh</button>
    </div>
  </div>

  <div class="card">
    <h2>Your PIN</h2>
    <p class="sub" style="margin:0 0 14px">Friends type this to connect to this PC. Nothing else to install &mdash; no account needed.</p>
    <div class="pin">
      <span class="code" id="pincode">${pin}</span>
      <button class="btn" type="button" onclick="copy(document.getElementById('pincode').textContent, 'PIN copied')">Copy PIN</button>
    </div>
    <p class="hint">This PIN changes if you delete <code>device.json</code>, and the agent prints a fresh one on every start until then.</p>
  </div>

${s.linked ? `
  <div class="card">
    <h2>Your account</h2>
    <p class="sub" style="margin:0 0 4px">This PC is linked to your account, so it shows up in <b>Devices</b> when you log in on the website.</p>
    <div class="row" style="margin-top:14px">
      <span class="pill on"><span class="dot"></span>Linked</span>
      <span class="spacer"></span>
      <a class="btn ghost" href="${esc(s.relayOrigin || "")}" target="_blank" rel="noopener">Open the website</a>
      <button class="btn ghost" type="button" onclick="switchAccount()">Use a different account</button>
    </div>
    <p class="hint">Only your login can see this PC. Nobody else's account will.</p>
  </div>
` : `
  <div class="card" id="linkcard">
    <h2>Set this PC up</h2>
    <p class="sub" style="margin:0 0 14px">
      Make a free account, or log in if you already have one. That is the whole setup &mdash;
      no website, no copying a key into a text file. Your password is sent straight to
      ClankerDesk and is never written to this PC.
    </p>
    <form id="linkform" onsubmit="return doLink(event)">
      <label class="field">
        <span>Username</span>
        <input id="linkuser" type="text" autocomplete="username" spellcheck="false"
               placeholder="letters, numbers, _ or -" required>
      </label>
      <label class="field">
        <span>Password</span>
        <input id="linkpass" type="password" autocomplete="current-password"
               placeholder="at least 8 characters" required minlength="8">
      </label>
      <div id="linkmsg" class="msg" role="alert"></div>
      <div class="row">
        <span class="spacer"></span>
        <button class="btn" type="submit" id="linksubmit">Link this PC</button>
      </div>
    </form>
    <p class="hint">Already have an account? Use the same username and password &mdash; ClankerDesk will log you in instead of making a second one.</p>
  </div>
`}

  <div class="card">
    <h2>Connection</h2>
    <div class="kv"><span class="k">Relay</span><span class="v">${esc(s.relayUrl) || "not configured"}</span></div>
    <div class="kv"><span class="k">Public link</span><span class="v">${publicLinkCell}</span>
      ${tunnel ? `<button class="btn ghost" type="button" onclick="copy('${tunnel}', 'Link copied')">Copy</button>` : ""}</div>
    <div class="kv"><span class="k">Running for</span><span class="v" id="uptime">${formatUptime(s.uptimeSec)}</span></div>
    <div class="row" style="margin-top:16px">
      <span class="spacer"></span>
      <button class="btn danger" type="button" onclick="stopAgent()">Stop ClankerDesk</button>
    </div>
  </div>

  <div class="card">
    <h2>Share this PC</h2>
    <ol class="steps">
      <li>Open the ClankerDesk website and click <b>Log in</b>.</li>
      <li>This PC appears under <b>Devices</b>.</li>
      <li>Click it, type the PIN above, and you are in.</li>
    </ol>
    <p class="hint">Not near a browser? Friends can also go straight to the website's <b>Connect manually</b> and enter the relay address above plus the PIN.</p>
  </div>

</div>
<div class="toast" id="toast"></div>
<script>
// Duplicated from the server-side copy on purpose: the live uptime counter
// below runs in the page and cannot reach Node's scope.
function formatUptime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600),
      m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (d) return d + "d " + h + "h";
  if (h) return h + "h " + m + "m";
  if (m) return m + "m " + s + "s";
  return s + "s";
}
function say(msg, good) {
  var el = document.getElementById("linkmsg");
  if (!el) return;
  el.textContent = msg;
  el.className = "msg show" + (good ? " good" : "");
}
function doLink(ev) {
  ev.preventDefault();
  var u = document.getElementById("linkuser").value.trim();
  var pw = document.getElementById("linkpass").value;
  var btn = document.getElementById("linksubmit");
  btn.disabled = true; btn.textContent = "Linking...";
  say("Talking to the relay...");
  fetch("/host-link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: u, password: pw })
  }).then(function (r) {
    return r.json().then(function (j) { return { status: r.status, j: j }; });
  }).then(function (res) {
    if (res.j && res.j.ok) {
      // Never leave the password sitting in the DOM once it has been used.
      document.getElementById("linkpass").value = "";
      say("Linked to @" + res.j.user + " -- this PC is ready.", true);
      toast("All set");
      setTimeout(function () { location.reload(); }, 900);
    } else {
      say((res.j && res.j.error) || "Could not link this PC (HTTP " + res.status + ")");
      btn.disabled = false; btn.textContent = "Link this PC";
    }
  }).catch(function () {
    say("Could not reach ClankerDesk. Is the agent still running?");
    btn.disabled = false; btn.textContent = "Link this PC";
  });
  return false;
}
function switchAccount() {
  if (!confirm("Link this PC to a different account? The new account will see it; the old one will not.")) return;
  fetch("/host-unlink", { method: "POST" }).then(function () { location.reload(); });
}
function toast(msg) {
  var t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  setTimeout(function () { t.classList.remove("show"); }, 1800);
}
function copy(text, msg) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () { toast(msg); },
      function () { fallback(text, msg); });
  } else { fallback(text, msg); }
}
function fallback(text, msg) {
  var ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); toast(msg); } catch (e) { toast("Press Ctrl+C to copy"); }
  document.body.removeChild(ta);
}
function stopAgent() {
  if (!confirm("Stop ClankerDesk on this PC? Streaming stops and the panel closes.")) return;
  fetch("/host-stop", { method: "POST" }).then(function () {
    document.body.innerHTML =
      '<div class="wrap"><div class="card"><h1>Stopped</h1>' +
      '<p class="sub">ClankerDesk is not running on this PC. Start it again from your launcher ' +
      'or by running <code>./Start-Agent.sh</code> in this folder.</p></div></div>';
  }).catch(function () { toast("Could not reach the agent"); });
}
// Keep "running for" honest without the user pressing Refresh.
setInterval(function () {
  fetch("/host-status", { cache: "no-store" })
    .then(function (r) { return r.json(); })
    .then(function (d) { document.getElementById("uptime").textContent = formatUptime(d.uptimeSec); })
    .catch(function () {});
}, 5000);
</script>
</body>
</html>`;
}

module.exports = { hostPanelHtml, esc };
