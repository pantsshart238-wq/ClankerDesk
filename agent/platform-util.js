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

module.exports = { tryRun, hasCommand };
