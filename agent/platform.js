// ---------------------------------------------------------------------------
// Platform layer
// ---------------------------------------------------------------------------
// Everything Windows-shaped used to be hardcoded in agent.js: the gfxcapture
// filter graph, the NVENC options, the WASAPI loopback listener and the two
// PowerShell helpers. Those all moved behind this one file so the same relay,
// wire format and viewer run on macOS and Linux too.
//
// SAFETY: platform-windows.js reproduces the previous Windows argv EXACTLY,
// character for character. There is a test (platform-selftest.js) that diffs
// its output against a recorded copy of the old hardcoded array -- if anyone
// edits one side and not the other, the test fails instead of silently
// changing the working Windows build.
//
// What is deliberately NOT here: the Annex-B parsing, the relay protocol, the
// Opus framing, the mic/talk-mute logic. Those were always platform-neutral,
// which is the whole reason this file is small.
// ---------------------------------------------------------------------------

const PLATFORM = process.platform;

let impl;
if (PLATFORM === "win32") {
  impl = require("./platform-windows");
} else if (PLATFORM === "darwin") {
  impl = require("./platform-macos");
} else if (PLATFORM === "linux") {
  impl = require("./platform-linux");
} else {
  // Rather than crash with a stack trace on an unsupported OS, say exactly
  // what's wrong and what we do support.
  console.error(
    `\n[platform] ClankerDesk does not have an agent for "${PLATFORM}".\n` +
    `          Windows, macOS and Linux are supported.\n`
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Shared helpers live in platform-util.js and are re-exported here, so callers
// have one place to import. (The platform files must NOT require this file:
// that would be circular, and the destructure would come back undefined.)
// ---------------------------------------------------------------------------

module.exports = Object.assign({}, impl, {
  platform: PLATFORM,
  ...require("./platform-util"),
});
