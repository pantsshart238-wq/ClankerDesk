// Cloudflare Worker + Durable Object relay for ClankerDesk.
//
// Routes:
//   POST /api/signup {username,password}
//        -> creates a private account. Responds with the account's private
//           key (the token an agent puts in config.json) and sets a session
//           cookie, so the browser is logged in right away.
//   POST /api/login  {username,password} -> session cookie
//   POST /api/logout                      -> clears the session cookie
//   GET  /api/me                          -> { user, token } for whoever is
//                                            logged in ({ user: null } if not)
//   GET  /api/devices
//        -> the DEVICES OF THE LOGGED-IN ACCOUNT ONLY ({ id, name, online,
//           lastSeen }). Nobody can ever see another account's PCs: the list
//           is filtered by the private key each agent registered with.
//   GET  /ws?role=agent&token=KEY&device=ID&name=NAME&pin=PIN
//        -> a ClankerDesk agent registers this PC under the account that owns
//           KEY (KEY = the account's private key from signup). Agents with an
//           unknown key are rejected -- sign up first.
//   GET  /ws?role=viewer&device=ID&token=PIN
//        -> a browser viewer connects to ONE device (receives its binary
//           video, sends JSON input events). Only that device's PIN works;
//           the account key alone is NOT enough to watch.
//   everything else   -> static assets from ./public (the viewer webpage)
//
// Accounts live in this Durable Object's storage (the DO is a singleton --
// idFromName("default") -- so there is exactly one account database).
// Passwords are stored as PBKDF2-SHA256 hashes. Sessions are signed cookies
// (no server-side session table needed).

const SESSION_COOKIE = "cd_session";
const SESSION_DAYS = 30;
// Cloudflare Workers' WebCrypto caps PBKDF2 at 100000 iterations, so use the
// maximum it allows.
const PBKDF2_ITERATIONS = 100000;
const enc = new TextEncoder();

function b64u(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64u(s) {
  const bin = atob(String(s).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

// Compare without early exit, so response time can't leak a "close" password.
function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacSha256(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

async function hashPassword(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256
  );
  return new Uint8Array(bits);
}

export class RelaySession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.devices = new Map(); // id -> { agent, viewers:Set, name, pin, acct }
  }

  clean(s, max) {
    return String(s || "").replace(/[\x00-\x1f<>]/g, "").trim().slice(0, max);
  }

  slot(id) {
    let d = this.devices.get(id);
    if (!d) {
      d = { agent: null, viewers: new Set(), name: id, pin: "", lastSeen: 0, acct: "" };
      this.devices.set(id, d);
    }
    return d;
  }

  async remember(id, info) {
    try {
      const all = (await this.state.storage.get("devices")) || {};
      all[id] = Object.assign(all[id] || {}, info, { lastSeen: Date.now() });
      await this.state.storage.put("devices", all);
    } catch (e) {
      /* storage hiccup: the dashboard just shows stale info */
    }
  }

  // ---- accounts -------------------------------------------------------------

  get secret() {
    return this.env.ACCOUNT_SECRET || "";
  }

  async getAccounts() {
    try { return (await this.state.storage.get("accounts")) || {}; } catch (e) { return {}; }
  }

  async accountForToken(token) {
    if (!token) return null;
    const all = await this.getAccounts();
    for (const [user, rec] of Object.entries(all)) {
      if (rec.token === token) return { user, rec };
    }
    return null;
  }

  async sessionUser(request) {
    // Reads the session cookie; returns { user } or null.
    if (!this.secret) return null;
    const cookie = request.headers.get("Cookie") || "";
    const m = cookie.match(/(?:^|;\s*)cd_session=([^;]+)/);
    if (!m) return null;
    const parts = m[1].split(".");
    if (parts.length !== 3) return null;
    const [userB64, expStr, sig] = parts;
    const expect = b64u(await hmacSha256(this.secret, userB64 + "." + expStr));
    if (!timingSafeEqualStr(sig, expect)) return null;
    if (Number(expStr) < Date.now()) return null;
    let user = "";
    try { user = new TextDecoder().decode(unb64u(userB64)); } catch (e) { return null; }
    const all = await this.getAccounts();
    if (!all[user]) return null;
    return { user };
  }

  async sessionCookie(user) {
    const exp = Date.now() + SESSION_DAYS * 86400000;
    const payload = b64u(enc.encode(user)) + "." + exp;
    const sig = b64u(await hmacSha256(this.secret, payload));
    return `${SESSION_COOKIE}=${payload}.${sig}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`;
  }

  json(obj, status, headers) {
    return new Response(JSON.stringify(obj), {
      status: status || 200,
      headers: Object.assign(
        { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
        headers || {}
      ),
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    // ---- sign up -------------------------------------------------------------
    if (url.pathname === "/api/signup" && request.method === "POST") {
      if (!this.secret) return this.json({ error: "accounts are not configured on this relay" }, 503);
      let body = {};
      try { body = await request.json(); } catch (e) {}
      const user = String(body.username || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (!/^[a-z0-9_-]{3,32}$/.test(user)) {
        return this.json({ error: "username: 3-32 characters (letters, numbers, _ or -)" }, 400);
      }
      if (password.length < 8 || password.length > 200) {
        return this.json({ error: "password: 8-200 characters" }, 400);
      }

      // Light per-IP throttle so nobody can mass-create accounts.
      try {
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        const now = Date.now();
        const signups = (await this.state.storage.get("signups")) || {};
        const rec = signups[ip];
        if (rec && rec.resetAt > now && rec.n >= 5) {
          return this.json({ error: "too many signups from this network -- try again later" }, 429);
        }
        signups[ip] = rec && rec.resetAt > now
          ? { n: rec.n + 1, resetAt: rec.resetAt }
          : { n: 1, resetAt: now + 3600000 };
        await this.state.storage.put("signups", signups);
      } catch (e) { /* throttle is best-effort */ }

      const all = await this.getAccounts();
      if (all[user]) return this.json({ error: "that username is already taken" }, 409);

      const salt = crypto.getRandomValues(new Uint8Array(16));
      const hash = await hashPassword(password, salt, PBKDF2_ITERATIONS);
      const key = hex(crypto.getRandomValues(new Uint8Array(32))); // the private key agents use
      all[user] = { salt: b64u(salt), hash: b64u(hash), token: key, created: Date.now() };
      await this.state.storage.put("accounts", all);
      console.log("[accounts] new account: " + user);

      const cookie = await this.sessionCookie(user);
      return this.json({ ok: true, user, token: key }, 200, { "Set-Cookie": cookie });
    }

    // ---- log in --------------------------------------------------------------
    if (url.pathname === "/api/login" && request.method === "POST") {
      if (!this.secret) return this.json({ error: "accounts are not configured on this relay" }, 503);
      let body = {};
      try { body = await request.json(); } catch (e) {}
      const user = String(body.username || "").trim().toLowerCase();
      const password = String(body.password || "");
      const all = await this.getAccounts();
      const rec = all[user];

      // Per-username throttle: 5 wrong tries lock this name for a minute.
      let fails = {};
      try { fails = (await this.state.storage.get("fails")) || {}; } catch (e) {}
      const f = fails[user] || { n: 0, until: 0 };
      if (f.until > Date.now()) return this.json({ error: "too many tries -- wait a minute" }, 429);

      // Always run the KDF (even for unknown usernames) so the response time
      // can't be used to guess which usernames exist.
      const salt = rec ? unb64u(rec.salt) : crypto.getRandomValues(new Uint8Array(16));
      const hash = await hashPassword(password, salt, PBKDF2_ITERATIONS);
      const ok = !!rec && timingSafeEqualStr(b64u(hash), rec.hash);
      if (!ok) {
        fails[user] = { n: (f.n || 0) + 1, until: (f.n || 0) >= 4 ? Date.now() + 60000 : 0 };
        try { await this.state.storage.put("fails", fails); } catch (e) {}
        return this.json({ error: "wrong username or password" }, 401);
      }
      delete fails[user];
      try { await this.state.storage.put("fails", fails); } catch (e) {}
      const cookie = await this.sessionCookie(user);
      return this.json({ ok: true, user, token: rec.token }, 200, { "Set-Cookie": cookie });
    }

    // ---- log out -------------------------------------------------------------
    if (url.pathname === "/api/logout" && request.method === "POST") {
      return this.json({ ok: true }, 200, {
        "Set-Cookie": `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
      });
    }

    // ---- who am I ------------------------------------------------------------
    // The token is included so a logged-in owner can copy their private key
    // again (to add a second PC) without signing up twice.
    if (url.pathname === "/api/me") {
      const sess = await this.sessionUser(request);
      if (!sess) return this.json({ user: null });
      const all = await this.getAccounts();
      return this.json({ user: sess.user, token: (all[sess.user] || {}).token || null });
    }

    // ---- device list (what the dashboard shows) ------------------------------
    if (url.pathname === "/api/devices") {
      const sess = await this.sessionUser(request);
      if (!sess) return this.json({ error: "login required" }, 401);
      const all = await this.getAccounts();
      const myToken = (all[sess.user] || {}).token;
      if (!myToken) return this.json({ error: "login required" }, 401);

      let stored = {};
      try { stored = (await this.state.storage.get("devices")) || {}; } catch (e) {}
      const list = new Map();
      // ONLY devices that registered with this account's private key.
      for (const [id, rec] of Object.entries(stored)) {
        if (rec.acct !== myToken) continue;
        list.set(id, { id, name: rec.name || id, online: false, lastSeen: rec.lastSeen || 0 });
      }
      for (const [id, d] of this.devices) {
        if (d.acct !== myToken) continue;
        const e = list.get(id) || { id, name: id, online: false, lastSeen: 0 };
        e.name = d.name || e.name;
        // "online" = agent socket present AND recently alive. Agents ping
        // every 15s, so a dead agent (even one killed with no close event)
        // flips to offline within 45s instead of staying online forever.
        e.online = !!d.agent && (Date.now() - (d.lastSeen || 0) < 45000);
        e.lastSeen = Math.max(e.lastSeen || 0, d.lastSeen || 0);
        list.set(id, e);
      }
      const out = [...list.values()].sort((a, b) => (b.online - a.online) || (b.lastSeen - a.lastSeen));
      return this.json({ devices: out, user: sess.user });
    }

    // ---- anything else is not a relay route (the Worker's default export
    // serves the webpage; this only exists as a safety net) ----
    if (url.pathname !== "/ws") {
      return this.env.ASSETS.fetch(request);
    }

    // ---- websockets ----
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }

    const token = url.searchParams.get("token") || "";
    const role = url.searchParams.get("role");
    const id = this.clean(url.searchParams.get("device"), 64) || "default";
    const d = this.slot(id);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    if (role === "agent") {
      // Agents must present a real account's private key: that is what ties
      // this PC to the right account's dashboard (and keeps strangers out).
      const account = await this.accountForToken(token);
      if (!account) {
        server.close(4003, "unknown key - sign up on the ClankerDesk page and put your account token in config.json");
        return new Response(null, { status: 101, webSocket: client });
      }
      // Only one agent per device. A reconnect replaces the previous one.
      if (d.agent) {
        try { d.agent.close(1000, "replaced by new agent connection"); } catch (e) { /* ignore */ }
      }
      d.agent = server;
      d.lastSeen = Date.now();
      d.acct = token;
      d.name = this.clean(url.searchParams.get("name"), 40) || id;
      d.pin = this.clean(url.searchParams.get("pin"), 16) || d.pin;
      this.remember(id, { name: d.name, pin: d.pin, acct: token, user: account.user });

      server.addEventListener("message", (evt) => {
        // Any frame proves the agent is alive; the 15s ping below is what
        // keeps an idle agent marked online.
        d.lastSeen = Date.now();
        if (typeof evt.data === "string" && evt.data.indexOf("agent_ping") !== -1) return;
        // The mic runs on its own dedicated cable (two-cable setup): the
        // agent tells us so, and then even the talker keeps receiving the
        // sound stream -- their voice never reaches the capture, so there is
        // no echo to suppress. On a single cable the talker's own audio
        // frames are withheld instead (see below).
        if (typeof evt.data === "string" && evt.data.indexOf("mic_audio_isolated") !== -1) {
          try {
            const o = JSON.parse(evt.data);
            d.micIsolated = !!(o && o.on);
            console.log("[relay] mic isolation: " + (d.micIsolated ? "on (dedicated mic cable)" : "off (shared cable)"));
          } catch (e) { /* ignore malformed */ }
          return;
        }
        // Binary frames (video/audio) + text (status) fan out to this
        // device's viewers only. Audio frames carry a 0x01 type byte: on a
        // SHARED cable a viewer who is currently talking never gets back the
        // audio their own mic just rode into the cable (that would be a
        // delayed echo of themself). Video and audio-config pass for everyone.
        let firstByte = -1;
        if (typeof evt.data !== "string") {
          try {
            firstByte = (evt.data instanceof ArrayBuffer)
              ? new Uint8Array(evt.data)[0]
              : (ArrayBuffer.isView(evt.data) ? evt.data[0] : -1);
          } catch (e) { firstByte = -1; }
        }
        for (const viewer of d.viewers) {
          if (firstByte === 0x01 && viewer.talking && !d.micIsolated) continue;
          try {
            viewer.send(evt.data);
          } catch (e) {
            d.viewers.delete(viewer);
          }
        }
      });
      const agentGone = () => {
        if (d.agent === server) d.agent = null;
        d.micIsolated = false;
        this.remember(id, {});
      };
      server.addEventListener("close", agentGone);
      server.addEventListener("error", agentGone);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (role === "viewer") {
      // PIN-only connect: the direct card (and any hand-typed link) sends just
      // the PIN, with no device id in the address. Look the PIN up so it still
      // reaches the right PC -- but only a device that is online right now
      // counts, so a stale/guessed PIN can never attach to a silent slot.
      let target = d;
      if (!url.searchParams.get("device") && token) {
        for (const rec of this.devices.values()) {
          if (rec.agent && rec.pin && rec.pin === token) { target = rec; break; }
        }
      }
      // Viewers need the DEVICE's PIN (shared by the person at that PC).
      // The account key alone must never be enough to watch someone.
      if (!target.pin || token !== target.pin) {
        server.close(4001, "wrong PIN for this device");
        return new Response(null, { status: 101, webSocket: client });
      }
      const dv = target;
      dv.viewers.add(server);
      // Stable per-socket id so the agent can tell which viewer is talking.
      // Used to keep a talker's own voice out of the sound stream THEY
      // receive while the mic shares the capture cable.
      const vid = Math.random().toString(36).slice(2, 10);
      server.addEventListener("message", (evt) => {
        if (typeof evt.data === "string") {
          // Tag every text event from this viewer with its id. The agent keys
          // mic tracking off vid; binary (mic PCM) needs no tag.
          let tagged = evt.data;
          try {
            const obj = JSON.parse(evt.data);
            if (obj && typeof obj === "object") {
              if (!obj.vid) { obj.vid = vid; tagged = JSON.stringify(obj); }
              // Track whether THIS viewer is the one talking, so the fan-out
              // can keep their own voice out of the sound stream they receive
              // (only matters while the mic shares the capture cable).
              if (obj.type === "mic_enable") server.talking = true;
              else if (obj.type === "mic_disable") server.talking = false;
            }
          } catch (e) { /* not JSON: forward as-is */ }
          if (dv.agent) {
            try { dv.agent.send(tagged); } catch (e) { /* agent gone, drop it */ }
          }
          return;
        }
        if (dv.agent) {
          try { dv.agent.send(evt.data); } catch (e) { /* agent gone, drop it */ }
        }
      });
      const cleanup = () => {
        dv.viewers.delete(server);
        if (dv.agent) {
          try { dv.agent.send(JSON.stringify({ type: "viewer_gone", vid })); } catch (e) { /* agent gone */ }
        }
      };
      server.addEventListener("close", cleanup);
      server.addEventListener("error", cleanup);
      return new Response(null, { status: 101, webSocket: client });
    }

    server.close(1008, "role must be 'agent' or 'viewer'");
    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/ws" || url.pathname.startsWith("/api/")) {
      const id = env.RELAY.idFromName("default");
      const stub = env.RELAY.get(id);
      return stub.fetch(request);
    }

    // Everything else is the static viewer page (public/ via the ASSETS
    // binding). On HTML responses, pre-fill the websocket address with this
    // Worker's own URL, so visitors only have to pick a device / paste a PIN.
    const resp = await env.ASSETS.fetch(request);
    const ct = resp.headers.get("Content-Type") || "";
    if (resp.status === 200 && ct.includes("text/html")) {
      const html = await resp.text();
      // The "host your own relay" card only exists when this Worker was given a
      // DEPLOY_REPO_URL (the public GitHub repo holding this source). Until
      // then the page shows nothing at all, so a half-configured deployment can
      // never put a dead button in front of anyone.
      const repo = String((env && env.DEPLOY_REPO_URL) || "").trim();
      const tag =
        `<script>window.AGENT_RELAY_URL=${JSON.stringify("wss://" + url.host + "/ws")};` +
        `window.CD_DEPLOY_REPO=${JSON.stringify(repo)};</script>`;
      const idx = html.lastIndexOf("</head>");
      const out = idx === -1 ? html : html.slice(0, idx) + tag + html.slice(idx);
      return new Response(out, { status: resp.status, headers: resp.headers });
    }
    return resp;
  },
};
