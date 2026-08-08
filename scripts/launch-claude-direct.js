"use strict";

const { execFileSync, spawn } = require("child_process");
const http = require("http");

const CLAUDE_EXECUTABLE = "/Applications/Claude.app/Contents/MacOS/Claude";
const port = Number(process.env.CLAWD_CLAUDE_CDP_PORT || 19222);

function isClaudeRunning() {
  try {
    const output = execFileSync("pgrep", ["-f", `^${CLAUDE_EXECUTABLE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return Boolean(output.trim());
  } catch {
    return false;
  }
}

function waitForEndpoint(timeoutMs = 8000) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const probe = () => {
      const request = http.get({
        hostname: "127.0.0.1",
        port,
        path: "/json/list",
        timeout: 700,
      }, (response) => {
        response.resume();
        if (response.statusCode === 200) {
          resolve(true);
          return;
        }
        retry();
      });
      request.on("error", retry);
      request.on("timeout", () => request.destroy());
    };
    const retry = () => {
      if (Date.now() - startedAt >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(probe, 250);
    };
    probe();
  });
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid CLAWD_CLAUDE_CDP_PORT: ${port}`);
  process.exit(1);
}

if (isClaudeRunning()) {
  console.error("Claude Desktop is already running. Quit Claude Desktop, then run this command again.");
  console.error(`The direct permission endpoint will be http://127.0.0.1:${port}/json/list`);
  process.exit(2);
}

const child = spawn(CLAUDE_EXECUTABLE, [`--remote-debugging-port=${port}`], {
  detached: true,
  stdio: "ignore",
  env: process.env,
});
child.unref();
waitForEndpoint().then((ready) => {
  if (!ready) {
    console.error("Claude Desktop rejected the remote debugging argument or did not expose the direct endpoint.");
    console.error("The installed Claude Desktop build requires an Anthropic-signed CLAUDE_CDP_AUTH token for CDP.");
    process.exitCode = 3;
    return;
  }
  console.log(`Claude Desktop launched with loopback direct permission protocol on port ${port}.`);
});
