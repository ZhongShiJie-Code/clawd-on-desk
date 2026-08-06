"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "release-manifest.json"), "utf8"));

if (pkg.version !== manifest.version) {
  throw new Error(`package version ${pkg.version} does not match manifest ${manifest.version}`);
}

const required = [
  "src/claude-desktop-cowork-bridge.js",
  "src/deepseek-balance.js",
  "src/deepseek-export.js",
  "src/deepseek-usage.js",
  "src/quota-ring-renderer.js",
  "src/session-hud.js",
  "src/session-hud-renderer.js",
  "assets/icons/agents/claude-desktop.png",
  "assets/icons/agents/claude-desktop-mcp.png",
];
for (const relative of required) {
  if (!fs.existsSync(path.join(root, relative))) throw new Error(`missing custom release file: ${relative}`);
}

const forbidden = /(?:^|\/)(?:node_modules|dist|staging|backups?|credentials)(?:\/|$)|\.asar$|(?:^|\/)\.env$/i;
const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
for (const relative of tracked.split(/\r?\n/).filter(Boolean)) {
  if (forbidden.test(relative)) throw new Error(`forbidden release path is tracked: ${relative}`);
}

const credentialPattern = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|cookie)\s*[:=]\s*["'][^"']{12,}/i;
for (const relative of ["release-manifest.json", "docs/releases/release-custom-v0.14.0.md", "docs/project/custom-release-workflow.md"]) {
  const text = fs.readFileSync(path.join(root, relative), "utf8");
  if (credentialPattern.test(text)) throw new Error(`possible credential in ${relative}`);
}

console.log(`Custom release contract OK: v${pkg.version}`);
