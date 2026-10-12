# ClankerDesk

60 fps, 1080p desktop streaming from a Windows PC to any browser:
FFmpeg + NVENC capture → WebSocket → WebCodecs video, with audio,
keyboard/mouse control and gaming pointer-lock.

## Host your own relay (one click)

The public relay at `clankerdesk.remote-me-braeden.workers.dev` is shared by
everyone who uses the standard download. If you'd rather run your **own** —
your own Cloudflare account, your own Durable Object, your own free-tier
allowance — deploy your own copy:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=REPLACE_WITH_YOUR_GITHUB_REPO_URL)

Cloudflare asks you to sign in, names the Worker, sets `ACCOUNT_SECRET` (a
random string it stores encrypted — generate your own, don't reuse anyone
else's), provisions the Durable Object, and deploys. You end up with an address
like `https://clankerdesk-YOUR-NAME.workers.dev`.

Then point your agent at it: open `config.json` and set

```json
"relayUrl": "wss://clankerdesk-YOUR-NAME.workers.dev/ws"
```

Your data (accounts, device list) lives only in your own instance. Nothing is
shared with anyone else's.

## Run it

**Double-click `Start-Agent.bat`.** That's it.

- First run installs dependencies automatically.
- The **ClankerDesk window** opens by itself — the agent's built-in control
  panel. It shows live online status, this PC's **PIN**, the permanent link,
  and buttons to copy the PIN, open the dashboard, or watch this PC.
  Press **Stop agent** in it to shut everything down (closing the window
  alone does not stop the agent).
- Open `http://localhost:8000` in a browser — click **Login**, then
  **Connect** (both fields are already filled in on this PC).
- Other ways to stop: Ctrl+C in the agent's console window, or just close
  that console (capture also stops by itself ~8 seconds after the last
  viewer leaves).

## Settings — `config.json`

Edit it with Notepad, then restart the agent. Notes (`//` lines) are allowed.

| Setting | What it does |
|---|---|
| `relayToken` | Your account's **private key** (from **Sign up** on the website — copy it from the key card, or from a logged-in session via `GET /api/me`). It links this PC to your account: only your login sees it in **Devices** |
| `publicLink` | `true` = agent prints a shareable `https://....trycloudflare.com` link (also saved to `PUBLIC-LINK.txt` next to this README, and shown in the page's **Info** panel) |
| `viewerPort` | Local viewer page port (`8000`; `0` = off) |
| `relayUrl` | Cloudflare Worker relay address (already set to the permanent link) |
| `deviceName` | Name shown in the dashboard (`""` = Windows user + PC name) |
| `openViewer` | `true` = the ClankerDesk window (the agent's built-in UI) opens on start |
| `audioDevice` | `""` (default) = listen to whatever this PC plays (no cable needed); or a capture device name like `"CABLE Output (VB-Audio Virtual Cable)"` for explicit capture |
| `micDevice` | `""` = auto-detect a second virtual cable for the viewer mic (`"CABLE-B"`, `"CABLE-A"` or `"Voicemeeter Input"` forces one) |
| `quality` | Default stream quality: `1080p60` (default), `720p60`, `1080p30` — viewers can switch any time with the quality button |
| `allowEmbed` | iframe/about:blank embedding of the viewer page (on by default; `false` blocks it) |

## Accounts & other devices (phone, laptop)

The website has **Sign up** (free): pick a username + password, and you get a
**private key**. Put that key into a PC's `config.json` (`relayToken`) and the
PC belongs to **your account** — the **Devices** dashboard only ever lists PCs
registered with *your* key, so nobody sees anyone else's machines. Viewing a PC
additionally needs that device's **PIN** (printed in the agent window at
startup, shown on `http://localhost:8000` → **Info**; delete `device.json` for
a fresh one), which is remembered per device after the first connect.

So from another device: open the **permanent link** —
`https://clankerdesk.remote-me-braeden.workers.dev` — **Log in**, pick your PC
from the list, enter its PIN. Or use a shared link with `?device=<id>` plus the
PIN. Sessions last 30 days (cookie), and **Log out** is in the dashboard.

Alternative: the direct **public link** (turn on `publicLink` in
`config.json` — printed in the agent window, saved to
`PUBLIC-LINK.txt`, shown in the page's **Info** panel). Its address
changes on every restart; the permanent link above does not. The dashboard's
**Connect manually (wss URL + token)** card also connects anywhere without an
account.

## Giving ClankerDesk to someone else (public download)

Everything a new Windows PC needs is in one small zip:

**`https://clankerdesk.remote-me-braeden.workers.dev/download/clankerdesk.zip`**

1. Send them that link.
2. They unzip it and double-click **Setup.bat** once — it installs
   Node.js if the PC doesn't have it (Windows may ask permission),
   installs the pieces, and starts ClankerDesk.
3. On the website they click **Sign up**, copy their **private key**, paste
   it into that PC's `config.json` (`relayToken`), and restart ClankerDesk.
   Their PC now appears in **their** dashboard — and only theirs.
4. They share that PC's **PIN** with the people they want to let in; those
   people log in (or use a `?device=` link), pick the PC, type the PIN.

To rebuild the zips AND deploy in one step (always do both — the zips live
on the site, so deploying without rebuilding serves stale downloads):

```powershell
powershell -File publish.ps1
```

How the security works: a viewer can only reach a stream with that
device's **PIN**. The private key only registers the agent under an
account — it is never enough to watch someone, and `/api/devices` returns
only the logged-in account's own PCs.

## Design your own page

The viewer page is three plain files — edit in any text editor, save,
reload with Ctrl+F5:

| File | Contains |
|---|---|
| `public/index.html` | Layout & text |
| `public/theme.css` | All colors/fonts — starts with a `:root` variable block |
| `public/app.js` | Connection & video logic (usually doesn't need touching) |

Two rules for `index.html`: keep the element **ids** listed in the
comment at the top of that file, and never write the head-closing tag
inside comments or strings.

## Making clicks work in games (Interception driver)

Many games ignore synthetic input. One-time setup, from an
**Administrator** prompt in this folder:

```
npx.cmd node-interception /install
```

…then restart the PC. `agent.js` uses it automatically afterwards.
Uninstall: `npx.cmd node-interception /uninstall`.

## Requirements

- Node.js (v20+; written against v24.20.0)
- FFmpeg on PATH with NVENC (`h264_nvenc`), an NVIDIA GPU
- **No audio hardware needed**: viewers hear whatever this PC plays — the
  agent listens to the Windows default output (WASAPI loopback) and walks to
  the first output that actually carries sound. A [VB-CABLE](https://vb-audio.com/Cable/)
  is OPTIONAL and only matters for the viewer **mic**: with one, host apps
  hear viewers as a microphone (set the app's mic input to **CABLE Output**).
  A SECOND cable — free [Voicemeeter](https://vb-audio.com/Voicemeeter.htm) or
  the [VB-CABLE A+B pack](https://vb-audio.com/Cable/) — is auto-detected and
  gives the mic its own path (`micDevice` in config.json forces a choice)
- Optional: `cloudflared` on PATH (`winget install Cloudflare.cloudflared`)
  for the public link

## Controls (in the viewer)

- **Ctrl+L** — lock the cursor for gaming (relative mouse movement); Esc releases
- **Ctrl+M** — viewer mic on/off: the viewer's mic plays into the host's
  default output, so host apps hear them (with a cable: set the app's mic
  input to **CABLE Output** — or **Voicemeeter Output** / **CABLE-B Output**
  with a second cable). The host sound pauses while a viewer talks so their
  own voice never echoes back at them
- Corner buttons — sound, mic, quality (**1080p60** / **720p60** /
  **1080p30**; lighter stream for weak viewers), settings, fullscreen,
  restart capture
- On the host PC itself the page is view-only unless you add `?control=1`

## Keeping it open: Floating Window and Install App

- **Floating Window** (button in the top bar of the home page — it reopens
  your last PC — or next to Connect on a device in the dashboard, for a
  specific one) opens the viewer in its own little window: the same idea as
  the about:blank "link embedder" pages, but built in and done right. Enter
  the PIN once in that window and later ones connect themselves.
- **Install App** (top bar of the home page) installs ClankerDesk as a real
  app through Chrome's install prompt: its own window with no address bar,
  its own icon (on a Chromebook: the app launcher / shelf; on Windows: the
  taskbar). It is a genuine app install — the browser downloads and sets up
  the app — not a shortcut to a browser tab. If your browser doesn't offer
  installs (managed school profile, non-Chrome browsers), the button says so.

## Embedding the viewer in another page

The viewer page may be shown inside an `<iframe>` (or an `about:blank`
tab) by default — no header blocks framing. Add `?viewonly=1` to the
embedded address if the embed shouldn't capture input, and set
`"allowEmbed": false` in `config.json` to block embedding entirely.

## The permanent link (Cloudflare Worker)

**`https://clankerdesk.remote-me-braeden.workers.dev`** — this URL never
changes. The agent reaches the Worker by connecting out, so it works
behind any router/NAT with no port forwarding. This is already set up;
to understand or redo it:

```powershell
npx.cmd wrangler login            # one-time: authorize your Cloudflare account
powershell -File publish.ps1      # rebuilds the download zips, then deploys
```

`wrangler.jsonc` holds the config, including the `ACCOUNT_SECRET` var that
signs login session cookies (rotating it logs everyone out; passwords and
private keys are unaffected). There is no shared relay token to manage —
agents authenticate with their account's private key, viewers with the
per-device PIN.

Then `relayUrl` in `config.json` holds `wss://<name>.<subdomain>.workers.dev/ws`
and `"useRelay": true`. The Worker serves its own copy of the viewer page
(WSS URL pre-filled; **Login** opens the account login, **Sign up** creates an
account and hands you the private key), keeps the account + device registry
(`GET /api/signup|login|logout|me|devices`), relays each device's stream
behind its PIN, and serves the download zips at `/download/clankerdesk.zip`.

**Important:** after ANY change (agent, page, styles), publish with:

```powershell
powershell -File publish.ps1
```

That rebuilds the download zips first, then deploys — the site's download
links always serve the latest build. Never run `wrangler deploy` alone.

The local page (`http://localhost:8000`) always reflects edits
immediately; the workers.dev link shows what was last deployed.

## Notes & limitations

- Capture uses FFmpeg's `gfxcapture` filter (Windows Graphics Capture) —
  handles busy 3D scenes without the freezing gdigrab showed.
- The Annex-B frame parser assumes one H264 slice per frame.
- Relative mouse movement, clicks and keys made while pointer-locked go
  through Interception; everything else through `input-helper.ps1`.
