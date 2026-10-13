// ---------------------------------------------------------------------------
// Finding ffmpeg and ffplay
// ---------------------------------------------------------------------------
// The agent used to spawn "ffmpeg" and "ffplay" by bare name, which means it
// only worked if the user's PATH happened to contain them. That is true on the
// machine it was built on and false on plenty of others -- winget in particular
// installs Gyan's build here:
//
//   %LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.2-full_build\bin\ffmpeg.exe
//
// ...which is four directories deep and is NOT on PATH unless the user adds it
// by hand. The result on such a machine is a perfect install followed by no
// picture at all, reported as "spawn ffmpeg ENOENT" and a watchdog complaining
// that capture had stalled -- neither of which names the real problem.
//
// So: resolve the binaries here, once, by looking in the places people
// actually put them. PATH is still tried first because that is the normal
// case and it is instant.
// ---------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const cache = new Map();

function isRunnable(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function which(name) {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(cmd, [name], { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] });
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    return first && isRunnable(first) ? first : null;
  } catch (_) {
    return null;
  }
}

// Where ffmpeg ends up, by installer, most-likely first.
function searchDirs(binary) {
  const exe = process.platform === "win32" ? binary + ".exe" : binary;
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");

  // ClankerDesk's own folder comes FIRST on purpose. setup-ffmpeg.ps1 unpacks
  // ffmpeg to <app>\tools\ffmpeg when winget is unavailable, and that copy
  // needs no PATH change and no admin rights, so it cannot be lost to a
  // restart or a new user account. Preferring it makes the install durable.
  //
  // Both tools\ffmpeg and tools\ffmpeg\bin are searched: the script writes the
  // former, but the error message in Setup.bat tells people who installed by
  // hand to use the latter, and it would be a poor joke for the agent to then
  // fail to see the copy it just told them to put there.
  const appTools = path.join(__dirname, "..", "tools", "ffmpeg");
  const appLocal = [appTools, path.join(appTools, "bin")];

  if (process.platform === "win32") {
    return [
      ...appLocal,
      path.join(local, "Microsoft", "WinGet", "Links"),                 // winget shims
      path.join(local, "Microsoft", "WinGet", "Packages", "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe"),
      path.join(local, "Microsoft", "WinGet", "Packages", "Gyan.FFmpeg.Shared_Microsoft.Winget.Source_8wekyb3d8bbwe"),
      path.join(local, "Programs", "ffmpeg", "bin"),
      path.join(home, "scoop", "shims"),
      path.join(home, "scoop", "apps", "ffmpeg", "current", "bin"),
      "C:\\ffmpeg\\bin",
      "C:\\Program Files\\ffmpeg\\bin",
      "C:\\ProgramData\\chocolatey\\bin",
    ];
  }
  if (process.platform === "darwin") {
    return [
      ...appLocal, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin",
      path.join(home, ".local", "bin"),
    ];
  }
  return [
    ...appLocal, "/usr/bin", "/usr/local/bin", "/snap/bin",
    path.join(home, ".local", "bin"), "/var/lib/flatpak/exports/bin",
  ];
}

// Resolve a binary to an absolute path, or null. Cached: the answer cannot
// change while the agent runs, and this is called on every capture start.
function findBinary(name) {
  if (cache.has(name)) return cache.get(name);

  let found = which(name);

  if (!found) {
    const exe = process.platform === "win32" ? name + ".exe" : name;
    outer:
    for (const dir of searchDirs(name)) {
      // Direct hit first -- the common case, and avoids a directory walk.
      const direct = path.join(dir, exe);
      if (isRunnable(direct)) { found = direct; break; }
      // Then one level down, because winget's real layout is
      //   Packages\<pkg>\ffmpeg-<version>-<variant>\bin\ffmpeg.exe
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const sub = path.join(dir, e.name);
        let sub2;
        try { sub2 = fs.readdirSync(sub, { withFileTypes: true }); } catch (_) { continue; }
        for (const e2 of sub2) {
          if (!e2.isDirectory()) continue;
          const bin = path.join(sub, e2.name, "bin", exe);
          if (isRunnable(bin)) { found = bin; break outer; }
        }
      }
    }
  }

  cache.set(name, found);
  return found;
}

// Clear the memo, so a freshly installed ffmpeg is picked up without a
// restart of the whole machine. Only used by tests and the setup check.
function resetCache() { cache.clear(); }

// One sentence a person can act on, or null when everything needed is present.
function missingReason() {
  const ff = findBinary("ffmpeg");
  if (!ff) {
    return process.platform === "win32"
      ? "ffmpeg was not found. It is not installed, or it is installed somewhere not on your PATH.\n" +
        "             Run Setup.bat in the ClankerDesk folder, which installs it for you --\n" +
        "             it downloads a copy into this folder and needs no admin rights."
      : "ffmpeg was not found. Run ./Setup.sh in the ClankerDesk folder, which installs it for you.";
  }
  const fp = findBinary("ffplay");
  if (!fp) {
    return "ffmpeg was found (" + ff + ") but ffplay is not, so a viewer's microphone\n" +
           "             will not play on this PC. Reinstall ffmpeg -- ffplay ships in the\n" +
           "             same package.";
  }
  return null;
}

module.exports = { findBinary, missingReason, resetCache };
