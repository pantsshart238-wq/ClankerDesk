// Small helpers shared by the platform implementations.
//
// These live here rather than in platform.js because platform.js requires the
// platform implementations, so a platform file requiring platform.js back
// would be a circular import -- and the destructure would silently be
// undefined. platform.js re-exports these so callers have one place to import.

// Run a command and hand back trimmed stdout, or null if it is missing/fails.
// Deliberately swallows errors: every caller has a sensible fallback, and a
// missing xrandr should never take the agent down.
function tryRun(cmd, args, timeoutMs = 4000) {
  try {
    return require("child_process").execFileSync(cmd, args, {
      timeout: timeoutMs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (_) {
    return null;
  }
}

// Is this command available? Used for dependency checks and encoder choice.
function hasCommand(cmd) {
  try {
    if (process.platform === "win32") {
      // `where` returns non-zero when it finds nothing; that is the answer we want.
      require("child_process").execFileSync("where", [cmd], { stdio: "ignore", timeout: 4000 });
      return true;
    }
    return !!tryRun("which", [cmd]);
  } catch (_) {
    return false;
  }
}

// Ask ffmpeg which encoders it actually has, instead of inferring that from
// what hardware happens to be installed.
//
// The reason this exists: `nvidia-smi -L` printing a GPU says nothing about
// whether THIS ffmpeg can open NVENC with THAT driver. The two versions move
// independently -- ffmpeg 7 wants NVENC API 12, ffmpeg 9 wants 13.1 -- so a
// machine can have a perfectly good card and still fail with "Driver does not
// support the required nvenc API version", then restart ffmpeg forever. That is
// exactly the bug Windows had, and Linux had the same check.
//
// `-encoders` is a static list, so this costs one fast process start and is
// cached. It answers "compiled in, and is the hardware present", which is what
// nvidia-smi was being used (unsuccessfully) to approximate.
let cachedEncoders = null;
function availableEncoders() {
  if (cachedEncoders) return cachedEncoders;
  try {
    const ff = require("./binaries").findBinary("ffmpeg");
    if (!ff) return (cachedEncoders = new Set());
    const out = require("child_process").execFileSync(ff, ["-hide_banner", "-encoders"],
      { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] });
    const set = new Set();
    for (const line of out.split(/\r?\n/)) {
      // Lines look like: " V....D h264_nvenc    NVIDIA NVENC H.264 encoder"
      const m = line.match(/^\s*[A-Z.]{6}\s+(\S+)/);
      if (m) set.add(m[1]);
    }
    cachedEncoders = set;
  } catch (_) {
    cachedEncoders = new Set();
  }
  return cachedEncoders;
}

// Forget the cached list, so a freshly installed ffmpeg is picked up.
function resetEncoders() { cachedEncoders = null; }

// Can ffmpeg actually OPEN this encoder with these exact options right now?
//
// This is not the same question as "is it in `ffmpeg -encoders`". That list is
// compile-time only: Gyan's full Windows build advertises h264_nvenc even on a
// laptop whose driver is three years too old, so a list check would happily
// choose NVENC and then fail at encode time, forever. The only honest test is
// to encode two frames and see if it works.
//
// `size` must be full-size for the same reason the Windows probe is: NVENC
// rejects frames below a minimum dimension, so a tiny test clip reports a
// working encoder as broken.
function encoderWorks(enc, opts, size = "1920x1080") {
  try {
    const ff = require("./binaries").findBinary("ffmpeg");
    if (!ff) return false;
    require("child_process").execFileSync(ff, [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `color=c=black:s=${size}:r=30:d=0.2`,
      "-c:v", enc, ...opts,
      "-frames:v", "2", "-f", "null", "-",
    ], { timeout: 25000, stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch (_) {
    return false;
  }
}

// First candidate that really opens, honouring an ENCODER override.
// config.json can set "encoder" (agent.js maps it to ENCODER); without this the
// setting would be silently ignored on the platforms that never looked at it.
function pickAvailableEncoder(candidates, optsFor, size) {
  const forced = String(process.env.ENCODER || "").trim().toLowerCase();
  if (forced) return forced;
  // Cheap pass first: skip anything not even compiled in, so the expensive
  // encode probe only runs for plausible candidates.
  const have = availableEncoders();
  const plausible = candidates.filter((c) => have.size === 0 || have.has(c));
  const list = plausible.length ? plausible : candidates;
  for (const c of list) {
    if (encoderWorks(c, optsFor(c), size)) return c;
  }
  return list[list.length - 1];
}

module.exports = { tryRun, hasCommand, availableEncoders, resetEncoders, encoderWorks, pickAvailableEncoder };
